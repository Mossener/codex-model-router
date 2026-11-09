import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { readFileSync, appendFileSync, statSync, renameSync, existsSync, realpathSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { createAccountPool } from './account-pool.mjs';
import { createAccountSettings } from './account-settings.mjs';
import { createPrefixTracker } from './prefix-reuse.mjs';
import { createResponseObserver } from './response-observer.mjs';
import { createDashboard } from './dashboard.mjs';
import { safeRequestEvent, safeDiagnostic, classifyError } from './security-metadata.mjs';
import { toChatRequest, fromChatResponse, createStreamTranslator, usageTotals, DEFAULT_GEMINI_EFFORTS } from './gemini.mjs';
import { shrinkPngDataUrl } from './image-shrink.mjs';

// Codex names neither a session nor a conversation, so the pool has nothing to pin
// a thread to and every rotation would throw that thread's upstream prompt cache
// away. The instructions and the first user turn are the only parts of a replay
// that cannot change while a thread grows, so their digest is a thread identity
// that survives later turns, model switches and retries.
export function threadFingerprint(payload) {
  const parts = [];
  if (typeof payload?.instructions === 'string' && payload.instructions) parts.push(payload.instructions);
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const first = input.find(item => item?.role === 'user');
  if (first) {
    if (typeof first.content === 'string') parts.push(first.content);
    else if (Array.isArray(first.content)) {
      for (const part of first.content) if (typeof part?.text === 'string') parts.push(part.text);
    }
  } else if (typeof payload?.input === 'string') {
    parts.push(payload.input);
  }
  if (!parts.length) return null;
  return createHash('sha1').update(parts.join('\u0000').slice(0, 65536)).digest('hex').slice(0, 32);
}

// The request log rotates into requests-YYYY-MM-DD_HH-mm-ss.jsonl past 1 MB and keeps
// 30 days of shards (the dashboard can show a full month). An older build rotated into a
// fixed requests.previous.jsonl, which overwrote the previous copy on every rotation, so
// the 7 day dashboard view only ever saw the last day or two. Shard names sort by time,
// and dashboard.mjs aggregates every requests*.jsonl file in the root.
export const REQUEST_LOG_LIMIT_BYTES = 1024 * 1024;
export const REQUEST_LOG_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_LOG_SHARD = /^requests-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?\.jsonl$/;
let lastPruneAt = 0;

export function pruneRequestLogs(root, now = Date.now()) {
  let removed = 0;
  let names;
  try { names = readdirSync(root); } catch { return 0; }
  for (const name of names) {
    if (!REQUEST_LOG_SHARD.test(name)) continue;
    const target = join(root, name);
    try {
      if (now - statSync(target).mtimeMs > REQUEST_LOG_KEEP_MS) { unlinkSync(target); removed++; }
    } catch {}
  }
  return removed;
}

export function rotateRequestLog(root, now = Date.now()) {
  const active = join(root, 'requests.jsonl');
  const shardName = stamp => {
    let name = `requests-${stamp}.jsonl`;
    for (let n = 2; existsSync(join(root, name)); n++) name = `requests-${stamp}-${n}.jsonl`;
    return name;
  };
  const stampOf = ms => new Date(ms).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  // Older builds kept only requests.previous.jsonl; back-fill it as a normal shard
  // dated by its own write time so it joins the 8 day retention.
  const legacy = join(root, 'requests.previous.jsonl');
  try {
    if (existsSync(legacy)) renameSync(legacy, join(root, shardName(stampOf(statSync(legacy).mtimeMs))));
  } catch {}
  try {
    if (statSync(active).size > REQUEST_LOG_LIMIT_BYTES) renameSync(active, join(root, shardName(stampOf(now))));
  } catch {}
  // Listing the directory on every request is not worth it; prune stale shards at
  // most once every ten minutes.
  if (now - lastPruneAt > 600000) { lastPruneAt = now; pruneRequestLogs(root, now); }
}

const defaultOpencodeModels = {
  // The plain id used to belong to the a6api route; opencode serves the same
  // upstream model, so the historical catalog entry keeps working.
  'deepseek-v4.1-flash': 'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-oc': 'deepseek-v4.1-flash',
};
const defaultAgentrouterModels = {
  'gpt-5.6-sol-ar': 'gpt-5.6-sol',
  'gpt-6-astra-ar': 'gpt-6-astra',
  'gpt-6.1-sol-ar': 'gpt-6.1-sol',
};
// agentrouter.org only answers allowlisted client identities, so the route keeps
// a fixed user agent instead of forwarding Codex's own.
const defaultAgentrouterUserAgent = 'codex_cli_rs/0.61.2';
// Gemini only speaks the Responses API through a translation layer, and the key is
// one project credential rather than an account pool, so the route carries its own
// base URL and model map exactly like the opencode route does.
const defaultGeminiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
const defaultGeminiModels = {};
// Antigravity already serves Responses. Its aliases opt into a separate local
// passthrough instead of sharing Gemini's translation or the account-pool repair.
const defaultAntigravityModels = {};
// agentrouter.org sits behind nginx with client_max_body_size 20m: a 20 MiB body
// is accepted, 24 MiB comes back as the plain-HTML 413 Codex cannot interpret.
// Codex replays the whole thread every turn, so a long computer-use thread that
// keeps multi-megabyte screenshots eventually exceeds the cap, and the
// compaction request that would shrink the thread is refused the same way.
const defaultUpstreamBodyLimitBytes = 20 * 1024 * 1024;
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const thirdPartyHeaders = new Set(['content-type', 'accept', 'user-agent']);
const maxBodyBytes = 64 * 1024 * 1024;
// A replay that is already past maxBodyBytes is not refused on sight any more: it
// is buffered up to this ceiling and then rebuilt by the same ladder that answers
// an upstream 413, because a thread that grew past the cap by a few kilobytes is
// still a thread the model can answer. Only a body past the ceiling is refused
// while it is still arriving, which is where the old immediate refusal belongs.
const maxBufferedBodyBytes = 256 * 1024 * 1024;
const prefixTracker = createPrefixTracker();

function reply(res, status, message, headers = {}) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify({ error: { message, type: 'local_router_error' } }));
}

function authenticates(header, expected) {
  if (!expected || typeof header !== 'string') return false;
  const supplied = Buffer.from(header);
  const wanted = Buffer.from(`Bearer ${expected}`);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

// The opencode gateway rejects requests without a routing session. Reuse the
// conversation key Codex already sends so a thread keeps landing on one backend.
function sessionId(data) {
  const candidates = [data?.prompt_cache_key, data?.client_metadata?.session_id, data?.client_metadata?.conversation_id, data?.conversation?.id];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const clean = candidate.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128);
    if (clean) return clean;
  }
  return randomUUID();
}

// A conversation that needed a rebuilt replay (foreign reasoning blob, foreign
// item id, oversized body) will keep needing it on every later turn, so remember
// the level that worked and stop paying for a rejected upload each turn.
const levelHints = new Map();
const levelHintTtlMs = 6 * 60 * 60 * 1000;
function conversationKey(data) {
  // Only a client-supplied thread identity is safe to key on; guessing one from
  // the content would mix two unrelated threads that open with the same text.
  const raw = [data?.prompt_cache_key, data?.client_metadata?.session_id, data?.client_metadata?.conversation_id, data?.conversation?.id]
    .find(candidate => typeof candidate === 'string' && candidate);
  return raw ? createHash('sha1').update(raw).digest('base64url') : null;
}
function levelHint(key) {
  const hint = levelHints.get(key);
  if (!hint) return 0;
  if (Date.now() - hint.at > levelHintTtlMs) {
    levelHints.delete(key);
    return 0;
  }
  return hint.level;
}
function rememberLevel(key, level) {
  if (levelHints.size > 200) {
    const oldest = [...levelHints.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) levelHints.delete(oldest[0]);
  }
  levelHints.set(key, { level, at: Date.now() });
  saveLevelHints();
}
// The supervisor restarts this worker on every update and after a crash, and a
// forgotten hint costs a full rejected upload of a thread that can be a megabyte
// or two, so the small cache outlives the process. Tests point this at a temp
// file so a test run never teaches the live router about fake conversations.
const levelHintsFile = process.env.CODEX_MODEL_GATEWAY_HINTS
  ? resolve(process.env.CODEX_MODEL_GATEWAY_HINTS)
  : new URL('./work/level-hints.json', import.meta.url);
function loadLevelHints() {
  try {
    for (const [key, hint] of Object.entries(JSON.parse(readFileSync(levelHintsFile, 'utf8')))) {
      if (!hint || !Number.isFinite(hint.level) || !Number.isFinite(hint.at)) continue;
      if (Date.now() - hint.at > levelHintTtlMs) continue;
      levelHints.set(key, { level: hint.level, at: hint.at });
    }
  } catch {
    // Missing or unreadable cache: every conversation just starts at level 0.
  }
}
function saveLevelHints() {
  try {
    mkdirSync(new URL('./work/', import.meta.url), { recursive: true });
    writeFileSync(levelHintsFile, JSON.stringify(Object.fromEntries(levelHints)));
  } catch {
    // The cache is an optimisation; a failed write must never fail a request.
  }
}
loadLevelHints();

function stripUnsupportedOptions(data) {
  delete data.service_tier;
  if (data.text && typeof data.text === 'object') {
    delete data.text.verbosity;
    if (Object.keys(data.text).length === 0) delete data.text;
  }
}

// Reasoning items carry an opaque blob that only the Azure resource which produced
// it can decrypt. Codex replays the whole conversation every turn, so a session
// that moves from one relay to another arrives with a foreign blob and the new
// upstream answers 400 "The encrypted content for item rs_... could not be verified".
// Dropping the blobs (and any reasoning item that held nothing else) makes the
// request self-contained again; the visible transcript is untouched.
export function stripEncryptedReasoning(payload) {
  let changed = false;
  if (Array.isArray(payload.input)) {
    const kept = [];
    for (const item of payload.input) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { kept.push(item); continue; }
      if (item.type !== 'reasoning') { kept.push(item); continue; }
      const carries = typeof item.encrypted_content === 'string'
        || (Array.isArray(item.content) && item.content.some(part => part && typeof part === 'object' && typeof part.encrypted_content === 'string'));
      if (!carries) {
        // An id-only reasoning item carries no blob but its id is still bound to
        // the resource that minted it, so it has to lose that handle as well.
        if (typeof item.id === 'string') {
          const copy = { ...item };
          delete copy.id;
          changed = true;
          kept.push(copy);
          continue;
        }
        kept.push(item);
        continue;
      }
      changed = true;
      const copy = { ...item, content: Array.isArray(item.content) ? item.content.filter(part => !(part && typeof part === 'object' && typeof part.encrypted_content === 'string')) : item.content };
      delete copy.encrypted_content;
      delete copy.id;
      const empty = copy.type === 'reasoning'
        && !(Array.isArray(copy.content) && copy.content.length)
        && !(Array.isArray(copy.summary) && copy.summary.length)
        && !(typeof copy.summary === 'string' && copy.summary);
      if (!empty) kept.push(copy);
    }
    payload.input = kept;
  }
  return changed;
}

// A reasoning item encrypted by one upstream resource cannot be replayed against
// another, and the account pool rotates resources on failover, so a thread that
// moved between accounts has to lose its old reasoning blobs to continue.
export function isForeignItemError(text) {
  return /encrypted content.*(?:could not|decrypt|verif)/i.test(text)
    || /encrypted[ _-]?content/i.test(text)
    || /could not be decrypted or decoded/i.test(text)
    || /created under a different\b/i.test(text)
    || /use the same resource that created the item/i.test(text)
    || /encrypted_content[^.]{0,64}(?:invalid|foreign|mismatch)/i.test(text)
    // The replay kept an id whose reasoning item is gone, which is the same
    // foreign-context refusal expressed from the other side.
    || /provided without its required\s+'?reasoning'?\s+item/i.test(text)
    || /required\s+'?reasoning'?\s+item[^.]{0,32}(?:missing|not provided|absent)/i.test(text)
    // "Item with id 'rs_...' not found." is what an id-only reasoning item minted
    // by another resource looks like: the handle names nothing here.
    || /item with id\s+\S+\s+(?:was\s+)?not found/i.test(text)
    || /item\s+'[\w.:-]+'\s+(?:was\s+)?not found/i.test(text);
}

// An upstream can answer 200 and refuse inside the event stream: a token rate
// limit arrives as response.failed after the response has already started, which
// the client can only report as "stream disconnected before completion". Read the
// head of a stream so that refusal can still be retried or rotated away.
//
// Reasoning events are held too. They are the first thing a reasoning model
// emits and the rate limit is answered within a second or two of them, so
// releasing reasoning would burn the one chance to move the turn. The client
// still gets them, in order, as soon as the first real payload arrives.
const streamPreambleTypes = new Set([
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.output_item.added',
  'response.reasoning_summary_part.added',
  'response.content_part.added',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_summary_part.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
]);

export function classifyStreamHead(text) {
  let from = 0;
  for (;;) {
    const end = text.indexOf('\n\n', from);
    if (end < 0) return { decision: 'wait', from };
    const block = text.slice(from, end);
    from = end + 2;
    const payload = block
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('');
    if (!payload || payload === '[DONE]') continue;
    let value;
    try { value = JSON.parse(payload); } catch { return { decision: 'content', type: 'unparsable' }; }
    const type = typeof value?.type === 'string' ? value.type : '';
    if (type === 'response.failed' || type === 'error') {
      const error = value?.response?.error ?? value?.error ?? {};
      const code = typeof error?.code === 'string' ? error.code : typeof value?.code === 'string' ? value.code : '';
      const message = String(error?.message ?? value?.message ?? '').replace(/\s+/g, ' ').slice(0, 300);
      return { decision: 'failure', type, code, message };
    }
    // A reasoning item's own done event is still only thinking: hold it with the
    // deltas above. Every other done event carries the payload the client renders.
    if (type === 'response.output_item.done' && value?.item?.type === 'reasoning') continue;
    // The head of a real stream is created -> in_progress -> output_item.added ->
    // content_part.added -> delta. The first three carry no payload for the client,
    // so holding them costs nothing and keeps a late refusal retryable. Anything
    // the router does not recognise is content: holding is only safe while the
    // event is known to be a preamble.
    if (!type || !streamPreambleTypes.has(type)) return { decision: 'content', type: type || 'untyped' };
  }
}

// Only refusals that another resource or another minute can answer are worth
// spending the upload again; a content refusal would fail the same way.
export function isRetryableStreamFailure(failure) {
  if (!failure) return false;
  const text = `${failure.code ?? ''} ${failure.message ?? ''}`;
  return /rate[ _-]?limit|too many requests|server_error|overloaded|timed? ?out|unavailable|upstream/i.test(text);
}

// A request the router itself refuses is described in one plain sentence. The
// local limit is far above what the upstream accepts, so the only way to reach
// it is a thread whose items carry megabytes of tool output or base64 images.
// Copying their content into the log is the one thing a log must never do; this
// keeps the shape ("N output items of M bytes") and the model so the refusal can
// be diagnosed from the dashboard.
export function describeOversizedBody(data) {
  const items = Array.isArray(data?.input) ? data.input : [];
  let outputBytes = 0;
  let imageChars = 0;
  let artifactChars = 0;
  walkJson(items, node => {
    const image = node.image_url;
    if (typeof image === 'string') imageChars += image.length;
    else if (image && typeof image === 'object') imageChars += String(image.url ?? '').length;
    // Codex's own tool results use `artifact`, which is not an `output` field, and
    // a result can be the last item of a fragment that was cut inside it, which is
    // why the fragment parser also records a length under `output`.
    if (node.type !== 'input_text') for (const key of ['output', 'artifact']) {
      const value = node[key];
      if (typeof value === 'string') outputBytes += value.length;
      else if (Array.isArray(value)) for (const part of value) if (part && typeof part.text === 'string') outputBytes += part.text.length;
    }
    if (typeof node.text === 'string' && node.type === 'input_text') artifactChars += node.text.length;
  });
  return { items: items.length, outputMB: +(outputBytes / 1048576).toFixed(1), imageMB: +(imageChars / 1048576).toFixed(1), textMB: +(artifactChars / 1048576).toFixed(1) };
}

// A refusal happens at the cap, which is also the point where the body stops
// being complete: the replay is cut mid-string and never parses. The summary is
// still worth having, so this reads the same fields out of the fragment by hand.
// It has to answer without throwing on any input, including a cut escape sequence.
export function parseTruncatedItems(head) {
  const text = typeof head === 'string' ? head : '';
  // The top level is `{"model":...,"input":[...`; everything after the marker is
  // the item list, cut somewhere inside it.
  const start = text.search(/"input"\s*:\s*\[/);
  if (start < 0) return [];
  const items = [];
  let depth = 0;
  let index = text.indexOf('[', start) + 1;
  let itemStart = -1;
  let inString = false;
  let escaped = false;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '{' || character === '[') {
      if (depth === 0) itemStart = index;
      depth += 1;
      continue;
    }
    if (character === '}' || character === ']') {
      if (depth === 0) break;
      depth -= 1;
      if (depth === 0 && itemStart >= 0) {
        try { items.push(JSON.parse(text.slice(itemStart, index + 1))); } catch { /* the fragment is partial */ }
        itemStart = -1;
      }
    }
  }
  // The item the fragment was cut inside still has its type, the length of each
  // string until the cut and any complete `image_url`, which is what a size
  // summary needs.
  if (depth > 0 && itemStart >= 0) {
    const tail = text.slice(itemStart);
    // A cut can land inside a key, and both patterns below need the opening quote.
    const closed = inString && !escaped ? `${tail}"` : tail;
    const sample = {};
    // Only two fields are read out of the fragment, and only as far as the cut:
    // the sample is built from their lengths, never from their text.
    const type = /"type"\s*:\s*"([^"\\"]{1,64})"/.exec(closed)?.[1];
    if (type) sample.type = type;
    for (const match of closed.matchAll(/"(?:output|artifact)"\s*:\s*"((?:[^"\\]|\\.)*)"?/g)) sample.output = 'x'.repeat((sample.output?.length ?? 0) + match[1].length);
    // The image URL is the string that follows the key, whether or not the
    // fragment ended inside it.
    for (const match of closed.matchAll(/"image_url"\s*:\s*"((?:[^"\\]|\\.)*)"?/g)) sample.image_url = { url: match[1] };
    items.push(sample);
  }
  // A replay over the cap is refused, and so is the compaction that would have
  // shrunk it, because compaction replays the same history. `summarize` is the
  // switch that turns /compact into one plain summarise request: that is the only
  // request such a thread can still make, so it is the one case that is let
  // through, and only after the rebuild below drops what a summary cannot need.
  // A head that ends before the top level closes says nothing about `summarize`,
  // so the gate is only trusted from a body that was read to the end.
  const complete = !inString && depth === 0 && /[\}\]]\s*$/.test(text);
  const summarize = complete && /"summarize"\s*:\s*true/.test(text);
  return summarize ? { summarize, items } : items;
}

// Where the bytes of a refused replay actually sit. A Codex thread can be over the
// cap with almost no tool output and no screenshots at all, because the system
// prompt and the message text are resent with every turn: that case has a
// different answer from a session full of images, so it is counted separately.
// `undefined` stands for the fields a fragment never reached.
export function describeBodyBytes(data) {
  const bytes = text => (typeof text === 'string' ? Buffer.byteLength(text) : 0);
  const plain = node => (typeof node === 'string' ? node : node && typeof node.text === 'string' ? node.text : '');
  const visited = new Set();
  let instructionsBytes;
  let developerBytes;
  let messageTextBytes;
  let toolBytes;
  let imageBytes;
  let otherBytes;
  const addText = (node, bucket) => {
    if (!node || typeof node !== 'object') return;
    const text = plain(node.text);
    if (bucket === 'instructions') instructionsBytes = (instructionsBytes ?? 0) + bytes(text);
    else if (bucket === 'developer') developerBytes = (developerBytes ?? 0) + bytes(text);
    else if (bucket === 'message') messageTextBytes = (messageTextBytes ?? 0) + bytes(text);
    const format = node.format;
    // A tool schema is compared across turns, not counted per turn, so it is kept
    // out of the message text and never read twice.
    if (node.type === 'input_text' && !node.format) return;
    if (visited.has(node)) return;
    visited.add(node);
    const schema = format && typeof format === 'object' ? format.schema : undefined;
    otherBytes = (otherBytes ?? 0) + bytes(typeof schema === 'string' ? schema : schema ? JSON.stringify(schema) : '');
  };
  if (!data || typeof data !== 'object') return { instructionsBytes, developerBytes, messageTextBytes, toolBytes, imageBytes, otherBytes };
  if (typeof data.instructions === 'string') instructionsBytes = bytes(data.instructions);
  else if (data.instructions) instructionsBytes = bytes(JSON.stringify(data.instructions));
  else instructionsBytes = 0;
  developerBytes = 0;
  messageTextBytes = 0;
  toolBytes = 0;
  imageBytes = 0;
  otherBytes = 0;
  if (Array.isArray(data.tools)) otherBytes += bytes(JSON.stringify(data.tools));
  walkJson(Array.isArray(data.input) ? data.input : [], node => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.image_url === 'string') { imageBytes += bytes(node.image_url); return; }
    if (node.image_url && typeof node.image_url === 'object') { imageBytes += bytes(node.image_url.url); return; }
    // The parts of a message arrive here before the message that holds them, so
    // only a message decides its bucket; a part is counted by its parent.
    if (node.type === 'message' || node.role) {
      for (const key of ['content', 'text']) {
        const bucket = node.role === 'developer' || node.role === 'system' ? 'developer' : 'message';
        if (typeof node[key] === 'string') addText({ text: node[key] }, bucket);
        else if (Array.isArray(node[key])) for (const part of node[key]) addText(part, bucket);
      }
      return;
    }
    // A tool result is told apart from a message part by the type: `input_text` is
    // text a message dispatched, and a part is never read on its own.
    if (node.type === 'input_text' || typeof node.text === 'string') return;
    if (typeof node.output === 'string') { toolBytes += bytes(node.output); return; }
    if (typeof node.artifact === 'string') { toolBytes += bytes(node.artifact); return; }
    if (typeof node.arguments === 'string') otherBytes += bytes(node.arguments);
  });
  return { instructionsBytes, developerBytes, messageTextBytes, toolBytes, imageBytes, otherBytes };
}

// A compact request that was built by the same route as a turn: every handle the
// earlier turn dropped is dropped again, and every image but the newest is sent as
// a note. A summary does not need the pixels, and keeping them is what makes a
// thread with screenshots unable to compact at all.
// A compaction is asked one question: summarise this thread. Screenshots older
// than the newest one and the server-side handles are not answers to it, and they
// are what makes a long thread too large to compact at all. Only ever called on a
// body that declared `summarize`, so a turn is never touched.
export function shrinkForSummary(payload) {
  dropOlderImages(payload, 1);
  // The summary comes back as one item list for the thread to continue from, so
  // no schema has to travel with the request.
  delete payload.tools;
  delete payload.tool_choice;
  delete payload.parallel_tool_calls;
  delete payload.include;
  for (const item of Array.isArray(payload.input) ? payload.input : []) {
    if (!item || typeof item !== 'object') continue;
    delete item.reasoning;
    delete item.item_reference;
    delete item.encrypted_content;
  }
  return payload;
}

// The last resort for a body the client sends already above the upstream cap: it
// reaches nobody, so nothing to preserve. Text is cut in place (with a marker the
// model can read) and every image is replaced by a note, oldest first, until the
// replay is under the target. A body that drops items instead would break the
// function_call/result pairing the upstream validates.
export function stripToSize(payload, targetBytes) {
  // The size is carried as a running total rather than re-measured after every
  // cut: serialising a 64 MiB replay costs the whole replay, and a body holding a
  // hundred large fields would pay that a hundred times over inside one request.
  // Replacing a field changes the total by exactly that field's serialised length,
  // so every subtraction below is exact.
  const bytesOf = value => Buffer.byteLength(JSON.stringify(value));
  let current = bytesOf(payload);
  if (current <= targetBytes) return false;
  let changed = false;
  const images = [];
  walkJson(payload.input, node => {
    if (isImagePart(node)) images.push(node);
  });
  for (const node of images) {
    if (current <= targetBytes) break;
    const removed = bytesOf(node.image_url) + (node.detail === undefined ? 0 : bytesOf(node.detail));
    delete node.image_url;
    delete node.detail;
    node.type = 'input_text';
    node.text = omittedImageText;
    current -= removed;
    changed = true;
  }
  // Oldest first: the tail of the replay is the turn being answered.
  const items = Array.isArray(payload.input) ? payload.input : [];
  const limit = 16384;
  const marker = '\n[truncated by the local router to fit the upstream body limit]';
  for (const item of items) {
    if (current <= targetBytes) break;
    if (!item || typeof item !== 'object') continue;
    const fields = [];
    for (const key of ['output', 'artifact']) {
      if (typeof item[key] === 'string') fields.push([item, key]);
      else if (Array.isArray(item[key])) for (const part of item[key]) if (part && typeof part.text === 'string') fields.push([part, 'text']);
    }
    for (const [holder, key] of fields) {
      if (current <= targetBytes) break;
      if (holder[key].length <= limit) continue;
      const before = bytesOf(holder[key]);
      holder[key] = holder[key].slice(0, limit) + marker;
      current -= before - bytesOf(holder[key]);
      changed = true;
    }
  }
  return changed;
}

// A turn that the client replays above the local cap gets the same treatment an
// upstream 413 gets, only earlier: the ladder runs in place, cheapest step first,
// and stops as soon as the body fits. Everything it drops is droppable — handles
// another resource minted, old screenshots, old tool dumps — and every cut leaves a
// marker the model can read, so a truncated thread is answered from what is left
// instead of being refused. Returns the rebuilt bytes, or null when even the last
// resort could not get under the target (the caller then refuses as before).
export function shrinkTurnToFit(payload, targetBytes, alreadyOver = false) {
  const serialize = () => Buffer.from(JSON.stringify(payload));
  // The caller that already measured the body skips the first pass: the replay is
  // known to be over the target, and a 64 MiB serialisation is not free.
  let bytes = alreadyOver ? null : serialize();
  if (bytes && bytes.length <= targetBytes) return bytes;
  stripEncryptedReasoning(payload);
  stripServerSideRefs(payload);
  bytes = serialize();
  if (bytes.length <= targetBytes) return bytes;
  if (dropOlderImages(payload, 2)) {
    bytes = serialize();
    if (bytes.length <= targetBytes) return bytes;
  }
  // Halve the screenshots that survived before considering one of them expendable:
  // a legible half-size screen is worth more to the model than no screen at all.
  if (compressImages(payload, 2)) {
    bytes = serialize();
    if (bytes.length <= targetBytes) return bytes;
    if (compressImages(payload, 2)) {
      bytes = serialize();
      if (bytes.length <= targetBytes) return bytes;
    }
  }
  if (dropOlderImages(payload, 1)) {
    bytes = serialize();
    if (bytes.length <= targetBytes) return bytes;
  }
  truncateToolOutputs(payload, 4096, 0);
  bytes = serialize();
  if (bytes.length <= targetBytes) return bytes;
  stripToSize(payload, targetBytes);
  bytes = serialize();
  return bytes.length <= targetBytes ? bytes : null;
}

// A blob minted by another upstream resource is refused inside the stream as
// often as it is refused with a 400, so the same rebuild has to be reachable
// from response.failed: nothing reaches the client, the request can be sent
// again with every server-side handle removed.
export function isRepairableStreamFailure(failure) {
  if (!failure) return false;
  return isForeignItemError(`${failure.code ?? ''} ${failure.message ?? ''}`);
}

function walkJson(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walkJson(child, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) walkJson(value, visit);
}

const omittedImageText = '[image omitted by the local router to keep the request under the upstream body limit]';

// A screenshot reaches the router in either of the two shapes the Responses API
// accepts for `image_url`: the data URL itself, or an object holding it. Matching
// only the string shape silently kept every screenshot, which is why a thread of
// screenshots could not be walked down to any limit at all.
function isImagePart(node) {
  if (!node || typeof node !== 'object' || node.type === 'input_text') return false;
  if (typeof node.image_url === 'string') return true;
  return Boolean(node.image_url && typeof node.image_url === 'object');
}

// Only the screen the model is acting on matters; every earlier screenshot is a
// multi-megabyte base64 PNG that gets replayed forever. Keep the newest ones.
export function dropOlderImages(payload, keepImages = 2) {
  const images = [];
  walkJson(payload.input, node => {
    if (isImagePart(node)) images.push(node);
  });
  if (images.length <= keepImages) return false;
  for (const node of images.slice(0, images.length - keepImages)) {
    delete node.image_url;
    delete node.detail;
    node.type = 'input_text';
    node.text = omittedImageText;
  }
  return true;
}

// Screenshots are replayed on every turn and are usually most of a computer-use
// body. Losing the picture is worse than losing its resolution: the model can still
// see a half-size screen, so every screenshot that would otherwise be dropped is
// first re-encoded smaller. Images this module cannot rewrite are left as they are.
export function compressImages(payload, factor) {
  let changed = 0;
  walkJson(payload.input, node => {
    if (!isImagePart(node)) return;
    const asString = typeof node.image_url === 'string';
    const smaller = shrinkPngDataUrl(asString ? node.image_url : node.image_url.url, factor);
    if (!smaller) return;
    if (asString) node.image_url = smaller;
    else node.image_url = { ...node.image_url, url: smaller };
    changed += 1;
  });
  return changed;
}

// Old tool output is usually a dump the model already read. Trim the oldest
// ones, leaving the recent turn untouched.
export function truncateToolOutputs(payload, limitBytes, keepRecent = 8) {
  const items = Array.isArray(payload.input) ? payload.input : [];
  const cutoff = Math.max(0, items.length - keepRecent);
  let changed = false;
  for (let index = 0; index < cutoff; index += 1) {
    const item = items[index];
    if (!item || typeof item !== 'object') continue;
    if (item.type !== 'custom_tool_call_output' && item.type !== 'function_call_output') continue;
    const marker = '\n[truncated by the local router to fit the upstream body limit]';
    if (Array.isArray(item.output)) {
      for (const part of item.output) {
        if (part && typeof part.text === 'string' && part.text.length > limitBytes) {
          part.text = part.text.slice(0, limitBytes) + marker;
          changed = true;
        }
      }
    } else if (typeof item.output === 'string' && item.output.length > limitBytes) {
      item.output = item.output.slice(0, limitBytes) + marker;
      changed = true;
    }
  }
  return changed;
}

// An item id is a handle into the resource that minted it. Once a replay gives
// up a reasoning blob, the id on the function call that answered it still points
// at a reasoning item the new resource can no longer resolve, and the upstream
// answers 400 "Item 'fc_...' of type 'function_call' was provided without its
// required 'reasoning' item: 'rs_...'". Dropping every item id (and the
// item_reference entries that only carry one) removes the handle, so the replay
// reads as content the client authored itself and the pairing rule never fires.
export function stripItemHandles(payload) {
  let changed = false;
  if (!Array.isArray(payload.input)) return changed;
  for (let index = payload.input.length - 1; index >= 0; index -= 1) {
    const item = payload.input[index];
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'item_reference') {
      payload.input.splice(index, 1);
      changed = true;
      continue;
    }
    if ('id' in item) {
      delete item.id;
      changed = true;
    }
  }
  return changed;
}

// Last resort for the "created under a different ... resource" refusal: drop every handle the
// upstream could try to resolve server-side (item ids, encrypted blobs, item
// references), leaving only content the client authored itself.
export function stripServerSideRefs(payload) {
  let changed = false;
  if (Array.isArray(payload.include)) {
    delete payload.include;
    changed = true;
  }
  if (stripItemHandles(payload)) changed = true;
  if (!Array.isArray(payload.input)) return changed;
  for (let index = payload.input.length - 1; index >= 0; index -= 1) {
    const item = payload.input[index];
    if (!item || typeof item !== 'object') continue;
    if ('encrypted_content' in item) {
      delete item.encrypted_content;
      changed = true;
    }
    // The blob is not always an item field: a multi-agent message carries it as a
    // content part ({"type":"encrypted_content","encrypted_content":"gAAAA..."}),
    // and the upstream answers 200 + response.failed invalid_encrypted_content
    // when the reader is a different resource. The text parts stay, so the
    // message still reads as before.
    if (Array.isArray(item.content)) {
      const kept = item.content.filter(part => !(part && typeof part === 'object'
        && (part.type === 'encrypted_content' || typeof part.encrypted_content === 'string')));
      if (kept.length !== item.content.length) {
        changed = true;
        if (kept.length) item.content = kept;
        else {
          payload.input.splice(index, 1);
          continue;
        }
      }
    }
  }
  return changed;
}

// agentrouter.org is unreachable on this network without the local Clash tunnel,
// so that route opens a CONNECT tunnel and runs TLS inside it.
function openTunnel(proxyUrl, target, timeoutMs = 20000) {
  const proxy = new URL(proxyUrl);
  const port = target.port || '443';
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}` },
      timeout: timeoutMs,
    });
    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${response.statusCode}`));
        return;
      }
      resolve(socket);
    });
    request.on('timeout', () => request.destroy(new Error('proxy timeout')));
    request.on('error', reject);
    request.end();
  });
}

export function retryableTransportError(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT' || code === 'ECONNABORTED'
    || /ERR_SSL|socket hang up|decryption failed|bad record mac/i.test(`${code} ${message}`);
}

function localAntigravityBase(value) {
  const invalid = () => new Error('Antigravity base URL must be an HTTP loopback /v1 endpoint.');
  let base;
  try { base = new URL(value); } catch { throw invalid(); }
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname)
    || !/^\/v1\/?$/.test(base.pathname) || base.username || base.password || base.search || base.hash) throw invalid();
  return base;
}

export function createRouter(options) {
  const opencodeModels = new Map(Object.entries(options.opencodeModels ?? defaultOpencodeModels));
  const agentrouterModels = new Map(Object.entries(options.agentrouterModels ?? defaultAgentrouterModels));
  const geminiModels = new Map(Object.entries(options.geminiModels ?? defaultGeminiModels));
  const antigravityModels = new Map(Object.entries(options.antigravityModels ?? defaultAntigravityModels));
  for (const [alias, target] of antigravityModels) {
    if (!/^[A-Za-z0-9._:/-]{1,93}-ag$/.test(alias) || typeof target !== 'string' || !target.trim()
      || opencodeModels.has(alias) || agentrouterModels.has(alias) || geminiModels.has(alias)) {
      throw new Error('Antigravity models must use separate -ag aliases and nonempty upstream ids.');
    }
  }
  const antigravityBase = antigravityModels.size ? localAntigravityBase(options.antigravityBaseUrl) : null;
  const knownModels = new Set([...opencodeModels.keys(), ...opencodeModels.values(), ...agentrouterModels.keys(), ...agentrouterModels.values(), ...geminiModels.keys(), ...geminiModels.values(), ...antigravityModels.keys(), ...antigravityModels.values(), ...(options.catalog?.models ?? []).map(model => model.slug)]);
  const pool = createAccountPool({ ...options.agentrouterPool,
    onAutoDisable: options.onAccountAutoDisable ?? options.agentrouterPool?.onAutoDisable });
  const accounts = () => options.getAgentrouterAccounts ? options.getAgentrouterAccounts() : [
    { id: 'legacy', label: 'AgentRouter', token: options.getAgentrouterToken?.() ?? '', enabled: true },
  ];
  // A token rate limit is not an account-level failure the pool can cool down
  // (it is shared supply), but for a few minutes another resource usually still
  // answers, so keep the throttle separately and steer selection away from it.
  const throttleWindowMs = options.throttleWindowMs ?? 90 * 1000;
  // Waiting out a cooldown is the router's job, not the client's: Codex stops
  // with "exceeded retry limit, last status: 429" long before a token budget
  // refills, so a turn that only needs another minute is held here instead of
  // being handed back as an error.
  const throttleWaitMs = options.throttleWaitMs ?? 120 * 1000;
  const maxThrottleAttempts = options.maxThrottleAttempts ?? 5;
  // A pause between rate-limited attempts lets a shared budget refill instead of
  // spending the next account on the same second of demand.
  const throttlePauseMs = options.throttlePauseMs ?? 1500;
  // A preamble is not small: response.created echoes the whole request, tools
  // included, so a real thread reaches 70 kB before the first delta. The cap is
  // only a memory guard against an upstream that never sends content, not a
  // budget for the preamble, and the idle deadline is what protects the client.
  const maxStreamHeadBytes = 8 * 1024 * 1024;
  const maxStreamHeadMs = 45 * 1000;
  const throttledAccounts = new Map();
  const throttledUntil = id => throttledAccounts.get(id) ?? 0;
  const throttledIds = () => new Set([...throttledAccounts.keys()].filter(id => throttledUntil(id) > Date.now()));
  const markThrottled = id => { if (id) throttledAccounts.set(id, Date.now() + throttleWindowMs); };
  // Milliseconds until the first cooled-down resource is worth trying again.
  // Infinity when every account stays unavailable for a reason waiting cannot fix.
  const reopenIn = () => {
    const now = Date.now();
    const cooling = [...throttledAccounts.values()].filter(until => until > now);
    return cooling.length ? Math.min(...cooling) - now : Infinity;
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const dashboard = options.dashboard ? createDashboard({
    ...options.dashboard,
    ...(options.dashboard.setAccountEnabled ? { setAccountEnabled: async (id, enabled) => {
      await options.dashboard.setAccountEnabled(id, enabled);
      if (enabled) pool.clearFailure(id);
    } } : {}),
    knownModels,
    getPoolStatus: () => pool.status(accounts()),
    getService: () => ({ name: 'Codex 统一网关', version: 3, defaultModel: options.defaultModel ?? 'gpt-6.1-sol', defaultUpstream: options.defaultBaseUrl, entrypoint: `http://127.0.0.1:${options.port}/v1`, proxy: options.agentrouterProxy ?? null, status: 'online' }),
  }) : null;
  const server = http.createServer(async (req, res) => {
    let upstream;
    // A body over the local cap is judged after the route is known, because the
    // route is what decides whether an upstream limit applies at all: a plain
    // relay would have refused the same 52 MiB thread.
    let localRefusal;
    // The body is read once, judged once, and answered in the same pass.
    const handleBody = async (declaredModel, readBody) => {
    try {
      if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)) {
        return reply(res, 403, 'Only local native clients are accepted.');
      }
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      if (dashboard && await dashboard(req, res, requestUrl)) return;
      if (req.headers.origin) return reply(res, 403, 'Only local native clients are accepted.');
      if (requestUrl.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ service: 'codex-model-router', version: 3, instanceId: options.instanceId, pid: process.pid, routes: ['original', 'opencode', 'agentrouter', 'gemini', 'antigravity'], poolAccountCount: pool.status(accounts()).configuredCount, features: ['account-switches', 'edge-retry', 'failure-backoff', 'self-contained-session-failover', 'in-stream-rebuild', 'reasoning-head-hold', 'throttle-wait'] }));
      }
      if (!authenticates(req.headers.authorization, options.getClientToken())) {
        return reply(res, 401, 'Local router authentication failed.');
      }
      if (requestUrl.pathname === '/v1/pool/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(pool.status(accounts())));
      }
      if (requestUrl.pathname === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(options.catalog));
      }
      if (req.method !== 'POST' || !['/v1/responses', '/v1/responses/compact'].includes(requestUrl.pathname)) {
        return reply(res, 404, 'Unsupported local router endpoint.');
      }
      const chunks = [];
      let size = 0;
      let declaredModel = '';
      // The first few hundred kilobytes of the replay, kept as text so the model
      // can still be named after the body has been dropped.
      let headText = '';
      const refusalStarted = Date.now();
      // A body over the cap is read to the end: the whole replay is what says
      // whether it can be rebuilt, and rebuilding it is what the route then does.
      let overCap = false;
      // The log line names what actually made the request large, so the answer to
      // a refusal is visible in the log rather than guessed at.
      const describeLocalRefusal = buffered => {
        const walk = buffered?.length ? (() => { try { return JSON.parse(Buffer.concat(buffered).toString('utf8')); } catch { return parseTruncatedItems(headText); } })() : null;
        const summarize = Boolean(walk && !Array.isArray(walk) && walk.summarize);
        const shape = describeOversizedBody(Array.isArray(walk) ? { input: walk } : walk);
        const bytes = describeBodyBytes(walk);
        const parts = [];
        const mb = value => (value / 1048576).toFixed(1);
        // The head is all a fragment gives: a replay whose bytes sit past the head
        // in tool output still has to be named, so the fragment's own count is used
        // when the parsed body did not reach that field.
        const tool = Math.max(bytes.toolBytes ?? 0, shape.outputMB * 1048576);
        const text = Math.max((bytes.developerBytes ?? 0) + (bytes.messageTextBytes ?? 0), shape.textMB * 1048576);
        if ((bytes.instructionsBytes ?? 0) >= 1048576) parts.push(`${mb(bytes.instructionsBytes)} MiB of instructions`);
        if ((bytes.developerBytes ?? 0) >= 1048576) parts.push(`${mb(bytes.developerBytes)} MiB of developer messages`);
        if ((bytes.messageTextBytes ?? 0) >= 1048576) parts.push(`${mb(bytes.messageTextBytes)} MiB of message text`);
        if (shape.imageMB >= 0.1) parts.push(`${shape.imageMB.toFixed(1)} MiB of screenshots`);
        if (tool >= 1048576) parts.push(`${mb(tool)} MiB of tool output`);
        if ((bytes.otherBytes ?? 0) >= 1048576) parts.push(`${mb(bytes.otherBytes)} MiB of schemas and arguments`);
        // Nothing above the threshold: say what was measurable rather than nothing.
        if (!parts.length) {
          const readable = [];
          if (text >= 1) readable.push(`${mb(text)} MiB of message text`);
          if (shape.items) readable.push(`${shape.items} item${shape.items === 1 ? '' : 's'} before the cut`);
          parts.push(readable.length ? readable.join(', ') : 'nothing readable before the cut');
        }
        const summarizeNote = summarize
          ? ' This is a compaction, so the router will send it to the summary model with the older screenshots replaced by notes, skip the tool schemas and raise its own body limit to 256 MiB: retry /compact rather than the turn.'
          : ' Run /compact or start a new conversation: the same thread will keep replaying what it holds and be refused again.';
        return {
          // Only ASCII reaches the client: Node measures a header in latin1, and a
          // non-ASCII model id would make the whole refusal fail to send.
          model: /^[\x20-\x7e]{1,120}$/.test(declaredModel) ? declaredModel : 'unknown',
          bytes: size,
          limitMB: Math.round(maxBodyBytes / 1048576),
          shape,
          summarize,
          composition: parts.join(', '),
          message: `This replay is ${(size / 1048576).toFixed(1)} MiB and the local router accepts ${Math.round(maxBodyBytes / 1048576)} MiB per request.`
            + (parts.length ? ` What arrived is ${parts.join(', ')}.` : '')
            + summarizeNote,
        };
      };
      // The refused body reaches the same log as a routed turn: the route is the
      // fact the dashboard is built around, and a row without one is skipped.
      const logLocalRefusal = refusal => {
        // Nothing was sent, so this row describes the body that was refused: no
        // account, no prompt cache reuse, and no content copied out of it.
        try {
          options.log?.(safeRequestEvent({
            route: 'local',
            model: refusal.model,
            upstreamModel: refusal.model,
            status: 413,
            ms: Date.now() - refusalStarted,
            store: false,
            chain: false,
            items: refusal.shape.items,
            bytes: refusal.bytes,
            error: 'payload_too_large',
            oversized: { limitMB: refusal.limitMB, outputMB: refusal.shape.outputMB, imageMB: refusal.shape.imageMB },
            composition: refusal.composition,
          }, knownModels));
        } catch { /* a refusal still has to reach the client */ }
      };
      let body = await (async () => {
        if (readBody) return readBody();
        // Same answer for a body past the ceiling and for one the ladder could not
        // fit: the client is told what the replay weighs and what is in it, and
        // Codex notices the size itself.
        const refuse = () => {
          if (res.headersSent) return;
          const refusal = describeLocalRefusal(chunks);
          localRefusal = refusal;
          logLocalRefusal(refusal);
          reply(res, 413, refusal.message, { 'x-local-router-limit': 'body' });
        };
        for await (const chunk of req) {
          size += chunk.length;
          // A Codex replay names its model in the first field of the top level, so
          // the head is enough to name it in the log and in the refusal. Only the
          // head is turned into text: a transcript can hold anything.
          if (headText.length < 512 * 1024) headText += chunk.toString('utf8', 0, Math.min(chunk.length, 512 * 1024 - headText.length));
          if (!declaredModel) {
            const match = /^\s*\{\s*"model"\s*:\s*"([^"\\]{1,120})"/.exec(headText);
            if (match) declaredModel = match[1];
          }
          // Past the ceiling no rebuild could ever fit the body, so the turn is
          // answered while the client is still uploading instead of after a
          // quarter-gigabyte has been buffered.
          if (size > maxBufferedBodyBytes) {
            overCap = true;
            refuse();
            let drained = 0;
            for await (const rest of req) {
              drained += rest.length;
              if (drained > maxBufferedBodyBytes) { req.destroy(); break; }
            }
            return null;
          }
          chunks.push(chunk);
          // Past the local cap the body is still held to the end: the route decides
          // what to do with a replay this size once it knows where it is going.
          if (size > maxBodyBytes) overCap = true;
        }
        return Buffer.concat(chunks);
      })();
      if (!body) return undefined;
      let data;
      try { data = JSON.parse(body.toString('utf8')); } catch { return reply(res, 400, 'Request must contain valid JSON.'); }
      // A body handed over by the rebuild never crossed a socket, so its model was
      // not read from a head: this is where it is named.
      declaredModel = typeof data?.model === 'string' ? data.model : '';
      if (!data || typeof data.model !== 'string' || !data.model.trim()) {
        return reply(res, 400, 'A nonempty model id is required.');
      }
      const antigravityTarget = antigravityModels.get(data.model);
      if (antigravityTarget) {
        // Manager v0.30.0 does not implement the compact endpoint. Never send
        // this history to another provider or credential as a hidden fallback.
        if (requestUrl.pathname.endsWith('/compact')) return reply(res, 501, 'Antigravity compact is unsupported by the local Manager.');
        return await forwardAntigravity({ req, res, data, upstreamModel: antigravityTarget, requestUrl });
      }
      const agentrouterTarget = agentrouterModels.get(data.model);
      const opencodeTarget = agentrouterTarget ? undefined : opencodeModels.get(data.model);
      const geminiTarget = geminiModels.get(data.model);
      const useAgentrouter = Boolean(agentrouterTarget);
      const useOpencode = Boolean(opencodeTarget);
      // Compaction asks the model to summarise a thread into one item list; the
      // Gemini translation cannot answer that shape, so a compact call keeps the
      // Axon path and only borrows the upstream id from the gemini map.
      const compacting = requestUrl.pathname.endsWith('/compact');
      const useGemini = Boolean(geminiTarget) && !compacting;
      const route = useAgentrouter ? 'agentrouter' : useOpencode ? 'opencode' : useGemini ? 'gemini' : 'original';
      const target = agentrouterTarget ?? opencodeTarget ?? geminiTarget ?? data.model;
      // A replay that arrived over the local cap is rebuilt to a target the chosen
      // route can actually accept. The cap is not that target: an edge that refuses
      // anything past 20 MiB turns a 64 MiB upload into a 413 after the whole
      // upload, so a body the ladder cannot walk down to the route's limit is
      // refused here instead, with the same explanation a refusal always carries.
      if (overCap) {
        const summarizing = data.summarize === true;
        const thirdParty = route !== 'original';
        const routeLimit = thirdParty
          ? Math.min(maxBodyBytes, Math.floor((options.upstreamBodyLimitBytes ?? defaultUpstreamBodyLimitBytes) * 0.8))
          : maxBodyBytes;
        if (summarizing) shrinkForSummary(data);
        const rebuilt = shrinkTurnToFit(data, routeLimit, true);
        if (!rebuilt) {
          const refusal = describeLocalRefusal(chunks);
          localRefusal = refusal;
          logLocalRefusal(refusal);
          return reply(res, 413, refusal.message, { 'x-local-router-limit': 'body' });
        }
        console.log('[%s] rebuilt %s MiB -> %s MiB', summarizing ? 'compact' : 'overshoot', (size / 1048576).toFixed(1), (rebuilt.length / 1048576).toFixed(1));
        body = rebuilt;
      }
      if (route === 'gemini') return await forwardGemini({ req, res, data, upstreamModel: geminiTarget });
      let selectedAccount;
      let affinity;
      let sessionTag;
      const pickAccount = selection => {
        affinity = selection?.aff;
        if (selection?.sessionKey) sessionTag = createHash('sha1').update(String(selection.sessionKey)).digest('hex').slice(0, 8);
        return selection.account;
      };
      // One digest per request: the thread keeps its account for the whole replay.
      const threadKey = useAgentrouter ? threadFingerprint(data) : null;
      if (useAgentrouter) {
        try {
          const skip = throttledIds();
          try {
            selectedAccount = pickAccount(pool.select(accounts(), data, { exclude: skip, affinity: threadKey }));
          } catch (error) {
            // Every account is throttled: a pinned conversation owner is still a
            // better bet than refusing the turn outright.
            if (!skip.size) throw error;
            selectedAccount = pickAccount(pool.select(accounts(), data, { affinity: threadKey }));
          }
        } catch (error) {
          return reply(res, error.statusCode ?? 503, `The agentrouter credential or selected pool account is unavailable. ${error.message}`);
        }
      }
      const started = Date.now();
      let errorText = '';
      // Why the connection itself failed (code plus target), kept across retries
      // so a 502/503 can be explained from the log afterwards.
      let connectionError = '';
      let sanitized = false;
      let reportedUsage;
      let upstreamCompleted = false;
      let streamFailure = null;
      let sentBytes = 0;
      let shrinkLevel = 0;
      let rejected = null;
      let throttleAttempts = 0;
      let throttleStarted = 0;
      let rotations = 0;
      let rebuilds = 0;
      // Time this turn spent asleep waiting for a rate-limited resource to cool
      // down, so a slow answer can be told apart from a slow upstream.
      let waited = 0;
      // Which event ended the held head: a failure that arrives after this one
      // can no longer be retried, so it is worth naming in the log.
      let opened = '';
      // A refusal the router could not repair is worth keeping on disk: the body
      // names the item the upstream disliked, which no error text reveals.
      const dumpRejected = (sent, refusal, name = 'last-rejected.json') => {
        try {
          const work = options.diagnosticsDirectory ? pathToFileURL(resolve(options.diagnosticsDirectory) + '/') : new URL('./work/', import.meta.url);
          mkdirSync(work, { recursive: true });
          writeFileSync(new URL(`./${name}`, work), JSON.stringify(safeDiagnostic({
            at: new Date().toISOString(),
            route,
            accountId: selectedAccount?.id ?? null,
            status: refusal.status,
            level: sent.level,
            bodyBytes: sent.body.length,
            error: refusal.text,
          })));
        } catch { /* diagnostics only */ }
      };
      // Keep the wording of the attempt a repair retry answers: when the ladder
      // ends at the last resort, this file says what the cheaper levels were told.
      const dumpRepair = (sent, refusal) => dumpRejected(sent, refusal, 'last-repair.json');
      // A ladder that climbs every time for the same thread is a ladder that
      // starts too low, so each refused attempt is appended with its level: the
      // appended lines say which step the upstream actually accepted.
      const recordRepair = (sent, status, reason, text) => {
        try {
          const work = options.diagnosticsDirectory ? pathToFileURL(resolve(options.diagnosticsDirectory) + '/') : new URL('./work/', import.meta.url);
          mkdirSync(work, { recursive: true });
          const file = new URL('./repair-log.jsonl', work);
          appendFileSync(file, `${JSON.stringify(safeDiagnostic({
            at: new Date().toISOString(),
            route,
            accountId: selectedAccount?.id ?? null,
            level: sent.level,
            status,
            bodyBytes: sent.body.length,
            reason,
            error: typeof text === 'string' ? text.slice(0, 400) : '',
          }))}\n`);
          // The log only has to explain recent ladders, so it keeps a small tail.
          if (statSync(file).size > 512 * 1024) {
            writeFileSync(file, `${readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-200).join('\n')}\n`);
          }
        } catch { /* diagnostics only */ }
      };
      // A stream can fail after HTTP 200. Keep counts and a fixed error category;
      // prompt text and upstream errors may contain credentials or injected text.
      const dumpFailed = (body, level) => {
        try {
          const work = options.diagnosticsDirectory ? pathToFileURL(resolve(options.diagnosticsDirectory) + '/') : new URL('./work/', import.meta.url);
          mkdirSync(work, { recursive: true });
          writeFileSync(new URL('./last-failed.json', work), JSON.stringify(safeDiagnostic({
            at: new Date().toISOString(),
            route,
            accountId: selectedAccount?.id ?? null,
            level,
            bodyBytes: body.length,
            error: `${streamFailure?.code ?? ''} ${streamFailure?.message ?? ''}`,
          })));
        } catch { /* diagnostics only */ }
      };
      const stateless = !data.previous_response_id;
      // Bytes this replay shares with the thread's previous one. Null means the
      // thread had no replay on record, which is a cold start rather than a loss.
      let sharedHeadBytes = null;
      // Keep only fixed categories from refusals, never the upstream error text.
      let logged = false;
      const logResult = aborted => {
        if (logged) return;
        logged = true;
        if (localRefusal) {
          // Nothing was sent, so the row is a description of the refused body and
          // not a transfer: no account, no byte count, no prompt cache reuse.
          options.log?.(safeRequestEvent({
            route: 'local',
            model: localRefusal.model,
            upstreamModel: localRefusal.model,
            status: 413,
            ms: Date.now() - started,
            store: false,
            chain: false,
            items: localRefusal.shape.items,
            bytes: localRefusal.bytes,
            error: 'payload_too_large',
            oversized: { limitMB: localRefusal.limitMB, outputMB: localRefusal.shape.outputMB, imageMB: localRefusal.shape.imageMB },
          }, knownModels));
          return;
        }
        options.log?.(safeRequestEvent({
        route,
        ...(selectedAccount ? { accountId: selectedAccount.id } : {}),
        model: data.model,
        upstreamModel: target,
        status: aborted ? 502 : res.statusCode,
        ms: Date.now() - started,
        store: data.store === true,
        chain: !stateless,
        ...(sessionTag ? { sess: sessionTag } : {}),
        ...(affinity ? { aff: affinity } : {}),
        items: Array.isArray(data.input) ? data.input.length : 1,
        bytes: sentBytes,
        ...(sharedHeadBytes === null ? {} : { reuse: sharedHeadBytes }),
        ...(sanitized ? { sanitized: true } : {}),
        ...(shrinkLevel ? { shrunk: shrinkLevel } : {}),
        ...(errorText ? { error: errorText } : connectionError ? { error: connectionError } : {}),
        ...(rotations ? { rotated: rotations } : {}),
        ...(rebuilds ? { rebuilt: rebuilds } : {}),
        ...(waited ? { waited: Math.round(waited / 1000) } : {}),
        ...(opened ? { opened } : {}),
        ...(streamFailure ? { failed: `${streamFailure.code ? `${streamFailure.code}: ` : ''}${streamFailure.message}`.slice(0, 320) } : {}),
        ...(reportedUsage ? { usage: reportedUsage } : {}),
        ...(aborted ? { aborted: true } : {}),
      }, knownModels));
      };
      res.on('finish', () => logResult(false));
      // A client that already read response.completed hangs up before the last
      // chunk terminator: the turn was delivered, so it must not be logged as a
      // broken stream. Only a close before the terminal event is a real break.
      res.on('close', () => { if (!res.writableEnded) logResult(!upstreamCompleted); });
      const credentials = {
        original: '',
        opencode: options.getOpencodeToken?.() ?? '',
        agentrouter: selectedAccount?.token ?? '',
      };
      const summarizeError = text => {
        let clean = String(text).replace(/\s+/g, ' ');
        for (const token of [selectedAccount?.token, credentials.agentrouter, credentials.opencode, options.getClientToken()]) {
          if (token) clean = clean.split(token).join('[redacted]');
        }
        return clean.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 240);
      };
      if (useOpencode && !credentials.opencode) return reply(res, 503, 'The opencode credential is unavailable. Check opencode.key and restart Codex Model Router.');
      if (useAgentrouter && !credentials.agentrouter) return reply(res, 503, 'The agentrouter credential is unavailable. Check agentrouter.key and restart Codex Model Router.');
      const clientHeaders = {};
      const extraHopHeaders = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim()));
      for (const [key, value] of Object.entries(req.headers)) {
        if (hopHeaders.has(key) || extraHopHeaders.has(key)) continue;
        clientHeaders[key] = value;
      }
      const suffix = requestUrl.pathname.slice('/v1'.length);
      const bases = {
        original: options.defaultBaseUrl,
        opencode: options.opencodeBaseUrl,
        agentrouter: options.agentrouterBaseUrl,
      };
      const proxies = { agentrouter: options.agentrouterProxy };
      const bodyLimitBytes = options.upstreamBodyLimitBytes ?? defaultUpstreamBodyLimitBytes;
      const shrinkTargetBytes = Math.floor(bodyLimitBytes * 0.8);
      const bodies = new Map();
      // Level 0 is the client payload unchanged. Each further level rebuilds the
      // replay: 1 drops every server-side handle another upstream resource would
      // refuse (reasoning blobs, item ids, item references and the `include` that
      // asks for the blobs back), 2 keeps only the newest two screenshots, 3
      // keeps one and trims old tool output. Levels are ordered by how much
      // context they give up.
      const buildBody = level => {
        if (bodies.has(level)) return bodies.get(level);
        // The passthrough forwards the client's own bytes. Re-serialising them
        // would reorder keys and, on the one route that accepts them, drop
        // options the client asked for, so level 0 is the buffer as it arrived.
        // Everything past it is a deliberate rewrite of the same payload.
        if (level === 0 && route === 'original') {
          bodies.set(0, body);
          return body;
        }
        const payload = JSON.parse(JSON.stringify({ ...data, model: target }));
        stripUnsupportedOptions(payload);
        if (level >= 1) {
          // A function call keeps the id of the reasoning item that produced it,
          // so dropping the blob while keeping the id makes the upstream answer
          // "Item 'fc_...' of type 'function_call' was provided without its
          // required 'reasoning' item". Handles and the blobs behind them go
          // together, and so does the `include` that asks for the blobs back:
          // with ids gone it can no longer be satisfied either.
          stripEncryptedReasoning(payload);
          stripServerSideRefs(payload);
        }
        if (level >= 2) dropOlderImages(payload, level === 2 ? 2 : 1);
        // Every trim below has to be a function of the item's own content, never
        // of its distance from the newest turn. Upstream prompt caching matches
        // leading bytes, so a window that slides as the thread grows rewrites the
        // middle of the prompt on every turn and the cache can only ever answer
        // with the constant preamble. `keepRecent = 0` makes the same item trim
        // the same way whether it arrived one turn ago or fifty.
        if (level >= 3) truncateToolOutputs(payload, 4096, 0);
        // Level 4 keeps only the last resort trims; the strip above already ran,
        // so a rebuild that jumps straight here is self-contained either way.
        const bytes = Buffer.from(JSON.stringify(payload));
        bodies.set(level, bytes);
        return bytes;
      };
      const plan = level => {
        const thirdParty = route !== 'original';
        const payloadBytes = buildBody(level);
        const headers = {};
        for (const [key, value] of Object.entries(clientHeaders)) {
          if (!thirdParty || thirdPartyHeaders.has(key)) headers[key] = value;
        }
        // Read the credential at send time: a rate-limited account is replaced
        // after an in-stream refusal, and the rebuild has to use the new token.
        const token = route === 'agentrouter' ? (selectedAccount?.token ?? '') : credentials[route];
        if (token) headers.authorization = `Bearer ${token}`;
        if (route === 'agentrouter') headers['user-agent'] = options.agentrouterUserAgent ?? defaultAgentrouterUserAgent;
        if (route === 'opencode') headers['x-opencode-session'] = sessionId(data);
        headers['content-length'] = String(payloadBytes.length);
        const base = new URL(bases[route]);
        base.pathname = base.pathname.replace(/\/$/, '') + suffix;
        base.search = requestUrl.search;
        return {
          base,
          proxyUrl: proxies[route] ?? null,
          proxyFailure: 'The agentrouter proxy is unreachable. Start the local Clash client and retry.',
          headers,
          body: payloadBytes,
          level,
        };
      };
      // Do not spend a multi-megabyte upload the edge will refuse anyway, and
      // start from the level this conversation already proved it needs.
      const hintKey = conversationKey(data);
      let level = !hintKey ? 0 : levelHint(hintKey);
      while (level < 3 && buildBody(level).length > shrinkTargetBytes) level += 1;
      let current = plan(level);
      shrinkLevel = level;
      sentBytes = current.body.length;
      // Record how much of this replay the thread already sent, so a low cache
      // rate can be read as "the prefix moved" or "this thread started cold".
      sharedHeadBytes = hintKey ?? threadKey ? prefixTracker.measure(hintKey ?? threadKey, current.body) : 0;
      // 502/504 are the shared edge in front of the pool answering before a turn
      // starts: nothing reached a model, so the same body can go again on the
      // same account with its prompt cache still warm. One resend, then the
      // client sees whatever the second attempt produced.
      const maxEdgeRetries = 1;
      const edgeRetryDelayMs = 400;
      let edgeRetries = 0;
      const run = async () => {
        let tunnel;
        if (current.proxyUrl) {
          try { tunnel = await openTunnel(current.proxyUrl, current.base); }
          catch (error) {
            connectionError = `proxy ${error?.code ?? ''} ${error?.message ?? ''}`.trim();
            return { kind: 'proxy-unreachable' };
          }
        }
        return new Promise(resolve => {
          let settled = false;
          const settle = value => { if (!settled) { settled = true; resolve(value); } };
          const forwardHeaders = response => {
            const outputHeaders = {};
            for (const [key, value] of Object.entries(response.headers)) {
              if (!hopHeaders.has(key) && key !== 'set-cookie') outputHeaders[key] = value;
            }
            return outputHeaders;
          };
          const transport = current.base.protocol === 'https:' ? https : http;
          const request = transport.request(current.base, { method: 'POST', headers: current.headers, ...(tunnel ? { socket: tunnel, agent: false, servername: current.base.hostname } : {}) }, response => {
            const status = response.statusCode ?? 502;
            if (status < 400) {
              const observedAccountId = selectedAccount?.id;
              const observer = createResponseObserver(response.headers['content-type'], id => { if (observedAccountId) pool.rememberResponse(id, observedAccountId); }, 1024 * 1024, usage => { reportedUsage = usage; }, failure => {
                streamFailure = failure;
                if (observedAccountId) pool.observeFailure(observedAccountId, status, `${failure.code} ${failure.message}`);
                dumpFailed(current.body, current.level);
              }, () => { upstreamCompleted = true; });
              response.on('data', chunk => observer.write(chunk));
              response.on('end', () => observer.end());
            }
            // Two refusals the router can answer by rebuilding the request: a
            // reasoning blob created by a different upstream resource (400) and a
            // body the edge considers too large (413, which nginx answers as HTML).
            // Every route is rebuilt, the passthrough one included: a request that
            // only the passthrough carries can hit the same body limit, and its
            // history comes from whichever resource answered earlier, so it can
            // come back with a blob this one will not decrypt.
            const oversized = status === 413;
            const foreignItem = status === 400;
            if (oversized || foreignItem) {
              const chunks = [];
              let kept = 0;
              response.on('data', chunk => {
                if (kept >= 65536) return;
                kept += chunk.length;
                chunks.push(chunk);
              });
              response.on('error', () => settle({ kind: 'transport', error: new Error('Upstream connection reset.') }));
              response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                errorText = summarizeError(text);
                const outputHeaders = forwardHeaders(response);
                outputHeaders['content-length'] = String(Buffer.byteLength(text));
                rejected = { status, text, headers: outputHeaders };
                if (oversized) {
                  dumpRepair(current, rejected);
                  recordRepair(current, status, 'size', text);
                  return settle({ kind: 'repair', reason: 'size' });
                }
                if (isForeignItemError(text)) {
                  dumpRepair(current, rejected);
                  recordRepair(current, status, 'reasoning', text);
                  return settle({ kind: 'repair', reason: 'reasoning' });
                }
                if (selectedAccount) pool.observeFailure(selectedAccount.id, status, text);
                res.writeHead(status, outputHeaders);
                res.end(text);
                settle({ kind: 'streamed' });
              });
              return;
            }
            if (status >= 400) {
              const chunks = [];
              let kept = 0;
              response.on('data', chunk => {
                if (kept >= 4096) return;
                kept += chunk.length;
                chunks.push(chunk);
              });
              response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                errorText = summarizeError(text);
                if (selectedAccount) pool.observeFailure(selectedAccount.id, status, text);
              });
            }
            // A plain 429 is the same supply limit as the in-stream refusal, and
            // forwarding it is what produced "exceeded retry limit, last status:
            // 429" on the client. Read the reason, then treat it as a throttle so
            // another resource gets the turn (or the router waits one out).
            if (status === 429 && route === 'agentrouter') {
              const chunks = [];
              let kept = 0;
              response.on('data', chunk => {
                if (kept >= 4096) return;
                kept += chunk.length;
                chunks.push(chunk);
              });
              response.on('error', () => settle({ kind: 'transport', error: new Error('Upstream connection reset.') }));
              response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                errorText = summarizeError(text) || 'HTTP 429 Too Many Requests';
                settle({ kind: 'throttle' });
              });
              return;
            }
            // A 502/504 is retried once on the same account (see edgeRetries):
            // the refusal is transport-level, so it says nothing about which
            // account is healthy and everything about how expensive a rotation
            // would be, since a different account answers from a cold cache.
            if ((status === 502 || status === 504) && edgeRetries < maxEdgeRetries) {
              const chunks = [];
              let kept = 0;
              response.on('data', chunk => {
                if (kept >= 4096) return;
                kept += chunk.length;
                chunks.push(chunk);
              });
              response.on('error', () => settle({ kind: 'transport', error: new Error('Upstream connection reset.') }));
              response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                // An edge 502 usually carries an HTML page; when the body is empty
                // the status itself is the only fact worth recording.
                errorText = summarizeError(text) || `HTTP ${status} from the edge`;
                const outputHeaders = forwardHeaders(response);
                outputHeaders['content-length'] = String(Buffer.byteLength(text));
                rejected = { status, text, headers: outputHeaders };
                settle({ kind: 'edge' });
              });
              return;
            }
            const outputHeaders = forwardHeaders(response);
            const streamed = status < 400 && /text\/event-stream/i.test(String(response.headers['content-type'] ?? ''));
            // Only the account pool can rotate away from a rate-limited resource,
            // so the original and single-credential routes keep streaming as-is.
            if (!streamed || route !== 'agentrouter') {
              res.writeHead(status, outputHeaders);
              res.flushHeaders();
              response.on('error', () => res.destroy());
              response.pipe(res);
              settle({ kind: 'streamed' });
              return;
            }
            // Hold the head of the stream until a content event proves the turn
            // started. A refusal inside the stream (token rate limit) can then
            // still be rotated to another account instead of surfacing to the
            // client as a disconnected stream.
            const head = [];
            let headBytes = 0;
            let headText = '';
            // Blocks already classified as preamble are not parsed again: the head
            // can be hundreds of kilobytes and every chunk would rescan it.
            let parsed = 0;
            let decided = false;
            let aborted = false;
            let headTimer = null;
            const flush = () => {
              if (decided || aborted) return;
              decided = true;
              if (headTimer) clearTimeout(headTimer);
              if (!res.headersSent) {
                res.writeHead(status, outputHeaders);
                res.flushHeaders();
              }
              for (const part of head) res.write(part);
              head.length = 0;
              settle({ kind: 'streamed' });
            };
            const onData = chunk => {
              if (decided) { res.write(chunk); return; }
              head.push(chunk);
              headBytes += chunk.length;
              headText += chunk.toString('utf8');
              // The deadline guards a silent upstream, not a talking one: a model
              // that thinks for a minute still sends reasoning deltas, and every
              // one of them has to keep the retry option alive.
              if (headTimer) clearTimeout(headTimer);
              headTimer = setTimeout(() => { if (!decided) flush(); }, maxStreamHeadMs);
              const verdict = headBytes > maxStreamHeadBytes ? { decision: 'content', type: 'oversize' } : classifyStreamHead(headText.slice(parsed));
              if (verdict.decision === 'content') {
                opened = `${verdict.type}:${headBytes}`;
                return flush();
              }
              if (verdict.decision !== 'failure') {
                parsed += verdict.from;
                if (parsed > 65536) {
                  headText = headText.slice(parsed);
                  parsed = 0;
                }
                return;
              }
              streamFailure = verdict;
              errorText = `${verdict.code || verdict.type || 'failed'}: ${verdict.message}`.slice(0, 240);
              const limited = isRetryableStreamFailure(verdict);
              const repairable = isRepairableStreamFailure(verdict);
              // Even when this turn can no longer be moved, the account is out of
              // budget for a while: keep the next turn away from it.
              if (limited) markThrottled(selectedAccount?.id);
              // Once content reached the client the answer cannot be replayed from
              // another account; only a failure that nothing leaked from moves.
              if (!decided && (limited || repairable)) {
                aborted = true;
                if (headTimer) clearTimeout(headTimer);
                response.off('data', onData);
                response.destroy();
                settle({ kind: limited ? 'throttle' : 'rebuild' });
                return;
              }
              dumpFailed(current.body, current.level);
              flush();
            };
            response.on('data', onData);
            // A silent upstream must not look like a hang: after this deadline the
            // held head is forwarded and the turn simply loses its retry option.
            if (!decided) headTimer = setTimeout(() => { if (!decided) flush(); }, maxStreamHeadMs);
            const finish = () => {
              if (aborted) return;
              if (!decided) flush();
              if (!res.writableEnded) res.end();
            };
            response.on('end', finish);
            // A body cut before the terminal event already left a 200 and a
            // partial answer with the client, so it still ends cleanly; a cut
            // after response.completed lost nothing and is logged as delivered.
            response.on('error', () => {
              if (aborted) return;
              finish();
              if (upstreamCompleted) logResult(false);
            });
            response.on('close', finish);
          });
          upstream = request;
          request.setTimeout(300000, () => request.destroy(new Error('Upstream idle timeout')));
          request.on('error', error => {
            connectionError = `${error?.code ?? ''} ${error?.message ?? ''} ${current.base.hostname}:${current.base.port}`.trim();
            settle({ kind: 'transport', error });
          });
          request.end(current.body);
        });
      };
      res.on('close', () => { if (!res.writableEnded) upstream?.destroy(); });
      // The local proxy occasionally drops a freshly tunnelled TLS stream, so a
      // proxied route gets one retry as long as the upstream has not answered yet.
      const maxAttempts = current.proxyUrl ? 2 : 1;
      let attempts = 0;
      for (;;) {
        attempts += 1;
        rejected = null;
        // A repaired or rotated attempt has a different final response (and may
        // use a different account). Do not attribute an earlier usage snapshot
        // to the account that eventually serves this request.
        reportedUsage = undefined;
        upstreamCompleted = false;
        const outcome = await run();
        if (outcome.kind === 'streamed') return;
        if (outcome.kind === 'throttle') {
          // The refusal never reached the client, so the same turn can be sent
          // again from a resource that is not rate limited.
          throttleAttempts += 1;
          rotations += 1;
          markThrottled(selectedAccount?.id);
          if (!throttleStarted) throttleStarted = Date.now();
          // Rotating alone cannot outlast a cooldown: with a short window the
          // pool keeps offering an account that reopened a second ago, so the
          // number of uploads and the wall clock are both capped here.
          const remaining = throttleWaitMs - (Date.now() - throttleStarted);
          let next = null;
          try { next = pickAccount(pool.select(accounts(), data, { exclude: throttledIds(), affinity: threadKey })); } catch { next = null; }
          if (!next && remaining > 1000) {
            // Every resource is inside its cooldown. Handing that back as a 429
            // is what makes the client give up, so wait for the first one to
            // reopen and try again here, as long as this turn still has budget.
            const reopen = reopenIn();
            const sleepFor = Math.min(Number.isFinite(reopen) ? reopen + 400 : remaining, remaining);
            if (sleepFor > 1000) {
              waited += sleepFor;
              await delay(sleepFor);
              try { next = pickAccount(pool.select(accounts(), data, { exclude: throttledIds(), affinity: threadKey })); } catch { next = null; }
            }
          }
          if (!next || remaining <= 0 || throttleAttempts > maxThrottleAttempts) {
            return reply(res, 429, `Every upstream resource is rate limiting this model; the router held this turn ${Math.round(waited / 1000)}s and tried ${throttleAttempts} times. ${errorText}`, { 'retry-after': '30' });
          }
          selectedAccount = next;
          // The new resource cannot read this thread's reasoning blobs or item
          // ids, so drop them before the upload instead of spending it on a 400.
          // Only the handles go: level 1 leaves the history itself untouched, and
          // it is deterministic, so the prefix the upstream already cached still
          // matches. Jumping to the last-resort level here used to trim old tool
          // output and screenshots as a side effect of a *rate limit*, which
          // rewrote the middle of every later turn of that thread.
          const rebindLevel = Math.max(current.level, 1);
          const needsRebind = !buildBody(rebindLevel).equals(current.body);
          current = plan(needsRebind ? rebindLevel : current.level);
          shrinkLevel = current.level;
          if (needsRebind) {
            sanitized = true;
            if (hintKey) rememberLevel(hintKey, rebindLevel);
          }
          sentBytes = current.body.length;
          // The refused attempt is already dumped; a retry starts cleanly.
          streamFailure = null;
          errorText = '';
          waited += throttlePauseMs;
          await delay(throttlePauseMs);
          continue;
        }
        if (outcome.kind === 'edge') {
          // Same account, same body, same level: a 502/504 means the edge never
          // reached a model, so a resend costs nothing but a second upload and
          // keeps this thread's prompt cache where it already lives.
          if (edgeRetries < maxEdgeRetries && attempts < maxAttempts + maxEdgeRetries) {
            edgeRetries += 1;
            errorText = '';
            waited += edgeRetryDelayMs;
            await delay(edgeRetryDelayMs);
            continue;
          }
          if (rejected) {
            res.writeHead(rejected.status, rejected.headers);
            res.end(rejected.text);
            return;
          }
          return reply(res, 502, 'The selected upstream connection failed.');
        }
        if (outcome.kind === 'rebuild') {
          // The upstream started the response and then refused a blob it cannot
          // decrypt. That is the same foreign-context refusal a 400 expresses,
          // only later, so send the turn again with every server-side handle
          // removed. Nothing reached the client, and one rebuild is enough: the
          // second attempt would replay byte-identical bytes.
          // Escalate one step, not straight to the last resort: a rebuild from an
          // untouched body only needs the handles gone, and reaching for level 4
          // from there would also trim tool output and screenshots that the
          // upstream never complained about. A thread already at the stripping
          // level has nothing left to give, so that one does jump.
          const target = current.level < 1 ? 1 : 4;
          const nextBody = buildBody(target);
          if (rebuilds < 1 && !nextBody.equals(current.body)) {
            rebuilds += 1;
            recordRepair(current, 200, 'stream', `${streamFailure?.code ?? ''} ${streamFailure?.message ?? ''}`.trim());
            current = plan(target);
            shrinkLevel = target;
            sentBytes = current.body.length;
            sanitized = true;
            if (hintKey) rememberLevel(hintKey, target);
            streamFailure = null;
            errorText = '';
            continue;
          }
          return reply(res, 400, `The upstream cannot read this thread's saved context. ${errorText || streamFailure?.message || ''}`.trim());
        }
        if (outcome.kind === 'repair') {
          // Retry only with a body that actually differs, so an unrepairable
          // refusal is forwarded to the client instead of looping. A reasoning
          // refusal skips straight to the id-stripping level when dropping the
          // blobs alone changed nothing (an id-only reasoning item carries no
          // blob but is still bound to the resource that created it).
          const ladder = outcome.reason === 'reasoning' ? [1, 4] : [2, 3];
          let target = null;
          for (const candidate of ladder) {
            if (candidate <= current.level) continue;
            if (!buildBody(candidate).equals(current.body)) {
              target = candidate;
              break;
            }
          }
          if (target !== null) {
            current = plan(target);
            shrinkLevel = target;
            sentBytes = current.body.length;
            sanitized = true;
            if (outcome.reason === 'reasoning' && hintKey) rememberLevel(hintKey, target);
            continue;
          }
          if (rejected) {
            // Keep the exact bytes the upstream refused so a recurring refusal
            // can be diagnosed from the item that triggered it.
            dumpRejected(current, rejected);
            res.writeHead(rejected.status, rejected.headers);
            res.end(rejected.text);
            return;
          }
          return reply(res, 502, 'The upstream rejected this request.');
        }
        // The connection never reached the model, so the client should back off
        // instead of retrying a dead path every few seconds.
        if (outcome.kind === 'proxy-unreachable') return reply(res, 503, current.proxyFailure, { 'Retry-After': '30' });
        if (attempts < maxAttempts && retryableTransportError(outcome.error)) continue;
        return reply(res, 503, 'The upstream connection failed (proxy or network). Retry after a short wait.', { 'Retry-After': '30' });
      }
    } catch (error) {
      if (process.env.DSH_PROBE) console.error('[probe]', error?.stack ?? error);
      upstream?.destroy();
      reply(res, 500, 'The local router could not process this request.');
    }
    };
    // The whole request is read, judged and answered in one pass. A body that has
    // to be rebuilt is rebuilt in place, before the route sends it: re-entering
    // this handler with the rebuilt bytes meant parsing, serialising and measuring
    // a 64 MiB replay several times over, which is long enough to look like a dead
    // worker to the supervisor watching /health.
    const readRequestBody = () => handleBody('', null);
    return readRequestBody();
  });
  // Preserve Responses history and upstream event bytes. This route deliberately
  // owns no account selection, proxy, retries, request rebuilding or head holding.
  async function forwardAntigravity({ req, res, data, upstreamModel, requestUrl }) {
    const started = Date.now();
    const payload = Buffer.from(JSON.stringify({ ...data, model: upstreamModel }));
    let reportedUsage;
    let completed = false;
    let failed;
    let errorCategory;
    let logged = false;
    let finished = false;
    let managerRequest;
    let managerResponse;
    const logResult = aborted => {
      if (logged) return;
      logged = true;
      try {
        options.log?.(safeRequestEvent({
          route: 'antigravity', model: data.model, upstreamModel,
          status: aborted ? 502 : res.statusCode, ms: Date.now() - started,
          items: Array.isArray(data.input) ? data.input.length : 1,
          bytes: payload.length, store: data.store === true, chain: Boolean(data.previous_response_id),
          ...(reportedUsage ? { usage: reportedUsage } : {}),
          ...(errorCategory ? { error: errorCategory } : {}),
          ...(failed ? { failed } : {}),
          ...(aborted ? { aborted: true } : {}),
        }, knownModels));
      } catch { /* Operational metadata cannot interrupt a delivered response. */ }
    };
    return await new Promise(resolve => {
      const finish = () => { if (!finished) { finished = true; resolve(); } };
      res.on('finish', () => { logResult(false); finish(); });
      res.on('close', () => {
        if (!res.writableEnded) {
          if (!completed) errorCategory ??= 'transport_error';
          logResult(!completed);
          finish();
          managerResponse?.destroy();
          managerRequest?.destroy();
        }
      });
      const fail = () => {
        if (finished) return;
        if (completed) return res.end();
        errorCategory = 'transport_error';
        if (res.headersSent) res.destroy();
        else reply(res, 502, 'The local Antigravity connection failed.');
      };
      let token;
      try { token = options.getAntigravityToken?.() ?? ''; } catch { token = ''; }
      token = typeof token === 'string' ? token.trim() : '';
      if (!token && options.antigravityLocalWithoutKey !== true) {
        errorCategory = 'credential_rejected';
        return reply(res, 503, 'The local Antigravity credential is unavailable.');
      }
      const headers = { 'content-type': 'application/json' };
      const extraHopHeaders = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map(value => value.trim()));
      for (const name of ['accept', 'user-agent']) {
        if (!extraHopHeaders.has(name) && req.headers[name]) headers[name] = req.headers[name];
      }
      if (token) headers.authorization = `Bearer ${token}`;
      headers['content-length'] = String(payload.length);
      const endpoint = new URL(antigravityBase);
      endpoint.pathname = '/v1/responses';
      endpoint.search = requestUrl.search;
      try {
        managerRequest = http.request(endpoint, { method: 'POST', headers }, response => {
          managerResponse = response;
          const status = response.statusCode ?? 502;
          if (status >= 400) {
            errorCategory = status === 401 || status === 403 ? 'credential_rejected'
              : status === 429 ? 'rate_limit' : status === 413 ? 'payload_too_large'
                : status >= 500 ? 'upstream_unavailable' : 'upstream_error';
          }
          const observer = createResponseObserver(response.headers['content-type'], () => {}, 1024 * 1024,
            usage => { reportedUsage = usage; },
            failure => { failed = classifyError(failure.code); },
            () => { completed = true; });
          response.on('data', chunk => observer.write(chunk));
          response.on('end', () => observer.end());
          response.on('error', fail);
          response.on('aborted', fail);
          const outputHeaders = {};
          const extraResponseHopHeaders = new Set(String(response.headers.connection ?? '').toLowerCase().split(',').map(value => value.trim()));
          for (const [name, value] of Object.entries(response.headers)) {
            if (!hopHeaders.has(name) && !extraResponseHopHeaders.has(name) && name !== 'set-cookie' && name !== 'authorization') outputHeaders[name] = value;
          }
          res.writeHead(status, outputHeaders);
          res.flushHeaders();
          response.pipe(res);
        });
        managerRequest.setTimeout(300000, () => managerRequest.destroy(new Error('Antigravity idle timeout')));
        managerRequest.on('error', fail);
        managerRequest.end(payload);
      } catch { fail(); }
    });
  }

  // Gemini's OpenAI-compatible surface only speaks chat completions, while Codex
  // only speaks the Responses API, so this route translates in both directions.
  // It has no account pool: one project key, one upstream, no rotation, and it is
  // deliberately absent from POOL_ROUTES so it never counts as pool traffic.
  async function forwardGemini({ res, data, upstreamModel }) {
    const started = Date.now();
    const key = options.getGeminiToken?.() ?? '';
    if (!key) return reply(res, 503, 'The gemini credential is unavailable. Check gemini.key and restart Codex Model Router.');
    const supported = options.geminiEfforts?.[upstreamModel] ?? DEFAULT_GEMINI_EFFORTS;
    // Nothing from this route may reach the request log carrying the key.
    const scrub = text => String(text).split(key).join('[redacted]').replace(/\bAQ\.[A-Za-z0-9._-]{8,}/g, '[redacted]');
    const { payload, customTools } = toChatRequest(data, upstreamModel, { supportedEfforts: supported });
    const wantsStream = payload.stream === true;
    const endpoint = `${String(options.geminiBaseUrl ?? defaultGeminiBaseUrl).replace(/\/+$/, '')}/chat/completions`;
    const headers = {
      'content-type': 'application/json',
      accept: wantsStream ? 'text/event-stream' : 'application/json',
      authorization: `Bearer ${key}`,
    };
    const post = () => new Promise((resolve, reject) => {
      const target = new URL(endpoint);
      const client = target.protocol === 'http:' ? http : https;
      const send = tunnel => {
        const request = client.request(target, { method: 'POST', headers, timeout: 600000, ...(tunnel ? { socket: tunnel, agent: false, servername: target.hostname } : {}) }, resolve);
        request.on('timeout', () => request.destroy(new Error('The Gemini upstream timed out.')));
        request.on('error', reject);
        request.end(Buffer.from(JSON.stringify(payload)));
      };
      const proxyUrl = options.geminiProxy;
      if (!proxyUrl || client === http) return send(null);
      // Gemini is not reachable from this host without the local proxy, and the
      // tunnel helper already speaks CONNECT for the other proxied route.
      openTunnel(proxyUrl, target).then(send, reject);
    });
    let upstream;
    try {
      upstream = await post();
      // A few shim builds reject the extra usage request instead of ignoring it.
      if (upstream.statusCode === 400 && payload.stream_options) {
        const text = await readAll(upstream);
        if (!/stream_options|include_usage/i.test(text)) {
          options.log?.(safeRequestEvent({ route: 'gemini', model: data.model, upstreamModel, status: 400, ms: Date.now() - started, error: scrub(text) }, knownModels));
          res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          return res.end(text);
        }
        delete payload.stream_options;
        upstream = await post();
      }
    } catch (error) {
      options.log?.(safeRequestEvent({ route: 'gemini', model: data.model, upstreamModel, status: 502, ms: Date.now() - started, error: scrub(error.message) }, knownModels));
      return reply(res, 502, `The Gemini upstream connection failed. ${error.message}`.trim());
    }
    const contentType = upstream.headers['content-type'] ?? 'application/json';
    if (upstream.statusCode !== 200) {
      const text = await readAll(upstream);
      let message = text;
      try { message = JSON.parse(text)?.error?.message ?? text; } catch {}
      options.log?.(safeRequestEvent({ route: 'gemini', model: data.model, upstreamModel, status: upstream.statusCode, ms: Date.now() - started, bytes: Buffer.byteLength(text), error: scrub(message) }, knownModels));
      res.writeHead(upstream.statusCode, { 'content-type': contentType, 'cache-control': 'no-store' });
      return res.end(text);
    }
    if (!wantsStream) {
      const text = await readAll(upstream);
      let chat;
      try { chat = JSON.parse(text); } catch {
        return reply(res, 502, 'The Gemini upstream did not return JSON.');
      }
      const result = fromChatResponse(chat, { model: upstreamModel, customTools });
      options.log?.(safeRequestEvent({ route: 'gemini', model: data.model, upstreamModel, status: 200, ms: Date.now() - started, bytes: Buffer.byteLength(text), items: result.output.length, usage: usageTotals(result.usage) }, knownModels));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders?.();
    let bytes = 0;
    let items = 0;
    let streamError = '';
    let usage;
    const emit = (event, payloadJson) => {
      if (res.writableEnded || res.destroyed) return;
      if (event === 'response.output_item.done') items += 1;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payloadJson)}\n\n`);
    };
    const translator = createStreamTranslator({
      model: upstreamModel,
      customTools,
      emit,
      onUsage: reported => { usage = reported; },
    });
    translator.created();
    upstream.on('data', chunk => {
      bytes += chunk.length;
      translator.push(chunk);
    });
    res.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
    await new Promise(resolve => {
      upstream.on('end', resolve);
      upstream.on('error', error => { streamError = error.message; resolve(); });
      if (upstream.destroyed) resolve();
    });
    if (!translator.isFinished()) {
      if (streamError) translator.fail(streamError);
      else translator.close();
    }
    if (!res.writableEnded) res.end();
    options.log?.(safeRequestEvent({
      route: 'gemini', model: data.model, upstreamModel, status: streamError ? 502 : 200,
      ms: Date.now() - started, bytes, items,
      ...(usage ? { usage: usageTotals(usage) } : {}),
      ...(streamError ? { failed: streamError } : {}),
    }, knownModels));
  }

  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return server;
}

// Reads a small upstream body (a refusal page or one chat completion) as text.
function readAll(stream, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', chunk => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

function readKey(path) {
  if (!path || !existsSync(path)) return '';
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const settings = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'));
    const root = dirname(fileURLToPath(import.meta.url));
    const loadAccounts = () => {
      const result = [];
      if (process.env.AGENTROUTER_API_KEY) result.push({ id: 'environment', label: 'AgentRouter environment', enabled: true, token: process.env.AGENTROUTER_API_KEY });
      if (settings.agentrouterAccountsPath) {
        try {
          const manifest = JSON.parse(readFileSync(resolve(root, settings.agentrouterAccountsPath), 'utf8'));
          for (const account of manifest.accounts ?? []) {
            let token = '';
            const path = typeof account.keyPath === 'string' ? account.keyPath : '';
            const validId = typeof account.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(account.id) && !/^(?:dashboard|opencode|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(account.id);
            if (validId && path && !isAbsolute(path)) {
              const keyRoot = realpathSync(resolve(root, 'keys'));
              const candidate = resolve(root, path);
              if (existsSync(candidate)) {
                const realKey = realpathSync(candidate);
                const fromKeys = relative(keyRoot, realKey);
                if (fromKeys && !fromKeys.startsWith('..') && !isAbsolute(fromKeys) && !/^(?:dashboard|opencode)\.key$/i.test(fromKeys.replace(/\\/g, '/').split('/').at(-1))) token = readKey(realKey);
              }
            }
            result.push({ id: account.id, label: account.label, enabled: account.enabled !== false, token,
              disabledReason: account.disabledReason, disabledAt: account.disabledAt });
          }
        } catch { return result; }
      } else result.push({ id: 'legacy', label: 'AgentRouter', enabled: true, token: readKey(settings.agentrouterKeyPath) });
      return result;
    };
    const accountSettings = createAccountSettings({
      root, manifestPath: settings.agentrouterAccountsPath,
      getPoolStatus: () => ({ accounts: loadAccounts().map(account => ({ id: account.id, keyConfigured: Boolean(account.token?.trim()) })) }),
    });
    const catalog = JSON.parse(readFileSync(settings.catalogPath, 'utf8'));
    const logPath = new URL('./requests.jsonl', import.meta.url);
    const logRoot = dirname(fileURLToPath(import.meta.url));
    rotateRequestLog(logRoot);  // drop request-log shards past the retention window at startup
    const server = createRouter({
      ...settings, catalog,
      getClientToken: () => JSON.parse(readFileSync(settings.authPath, 'utf8')).OPENAI_API_KEY,
      getOpencodeToken: () => process.env.OPENCODE_API_KEY || readKey(settings.opencodeKeyPath),
      getGeminiToken: () => process.env.GEMINI_API_KEY || readKey(settings.geminiKeyPath),
      getAntigravityToken: () => process.env.ANTIGRAVITY_API_KEY || readKey(settings.antigravityKeyPath ? resolve(root, settings.antigravityKeyPath) : null),
      getAgentrouterToken: () => process.env.AGENTROUTER_API_KEY || readKey(settings.agentrouterKeyPath),
      getAgentrouterAccounts: loadAccounts,
      onAccountAutoDisable: (id, reason) => accountSettings.autoDisable(id, reason),
      dashboard: settings.dashboardEnabled ? { root, checkInDirectory: settings.checkInDirectory, balanceHistoryPath: resolve(root, 'balance-history.json'), setAccountEnabled: (id, enabled) => accountSettings.setEnabled(id, enabled) } : null,
      log: event => {
        try {
          rotateRequestLog(logRoot);
          appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
        } catch {}
      },
    });
    server.on('error', () => { process.stderr.write('Local model router listener failed.\n'); process.exitCode = 1; });
    server.listen(settings.port, '127.0.0.1');
  } catch {
    process.stderr.write('Local model router startup failed; check settings, auth and the provider keys.\n');
    process.exitCode = 1;
  }
}
