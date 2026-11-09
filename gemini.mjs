// Gemini speaks the OpenAI chat-completions dialect, but Codex 0.6x refuses
// `wire_api = "chat"` and only ever talks the Responses API. These helpers are the
// translation layer: a Responses request becomes one chat-completions payload, and
// the chat-completions answer is replayed back as Responses JSON / Responses SSE
// events. Nothing here touches the network, so the mapping stays unit testable.
import { randomUUID } from 'node:crypto';

// Gemini 3.x exposes thinking levels as the OpenAI `reasoning_effort` field (the
// native API calls the same ladder `thinkingLevel`). Probing the live key showed
// `minimal` is refused for most 3.x models ("Thinking level MINIMAL is not
// supported for this model"), while `low`, `medium` and `high` are accepted, so
// that is the set the catalog advertises and the set a lower/upper request is
// clamped into.
export const DEFAULT_GEMINI_EFFORTS = ['low', 'medium', 'high'];

// Gemini 3 refuses a replayed function call that carries no thought signature
// ("Function call is missing a thought_signature in functionCall parts"), and the
// Responses API has nowhere to put that signature. The gateway therefore remembers
// the signature it saw for each call id and hands it back on the next turn; when the
// call predates the gateway (or the cache was evicted) Google's own documented
// bypass constant keeps the turn valid.
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
const thoughtSignatures = new Map();
const MAX_THOUGHT_SIGNATURES = 4096;

export function rememberThoughtSignature(callId, signature) {
  if (typeof callId !== 'string' || !callId || typeof signature !== 'string' || !signature) return;
  thoughtSignatures.delete(callId);
  thoughtSignatures.set(callId, signature);
  while (thoughtSignatures.size > MAX_THOUGHT_SIGNATURES) thoughtSignatures.delete(thoughtSignatures.keys().next().value);
}

export function thoughtSignatureFor(callId) {
  return (typeof callId === 'string' && thoughtSignatures.get(callId)) || SKIP_THOUGHT_SIGNATURE;
}

export function clearThoughtSignatures() {
  thoughtSignatures.clear();
}

const uid = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

export function normalizeEffort(effort, supported = DEFAULT_GEMINI_EFFORTS) {
  const levels = Array.isArray(supported) && supported.length ? supported : DEFAULT_GEMINI_EFFORTS;
  const wanted = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  if (levels.includes(wanted)) return wanted;
  if (wanted === 'none' || wanted === 'minimal' || wanted === 'fast') {
    return levels.includes('minimal') ? 'minimal' : levels[0];
  }
  if (wanted === 'xhigh' || wanted === 'max' || wanted === 'ultra') return levels[levels.length - 1];
  if (levels.includes('medium')) return 'medium';
  return levels[0];
}

// A function_call_output may arrive as a plain string or as the Responses content
// array; both collapse to the text the model has to read.
export function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).filter(Boolean);
    return parts.join('\n');
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.content)) return textOf(value.content);
    if (typeof value.output === 'string') return value.output;
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return value == null ? '' : String(value);
}

function toChatContent(content, role) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') { if (part) parts.push({ type: 'text', text: part }); continue; }
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text' || part.type === undefined)) {
      if (part.text) parts.push({ type: 'text', text: part.text });
      continue;
    }
    const image = part.type === 'input_image' || part.type === 'image_url' ? part : null;
    if (image) {
      const url = typeof image.image_url === 'string' ? image.image_url : image.image_url?.url ?? image.url;
      if (typeof url === 'string' && url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (parts.length && parts.every(part => part.type === 'text')) return parts.map(part => part.text).join('');
  if (!parts.length) return '';
  // Gemini only accepts images from the user; dropping them elsewhere keeps the
  // replay valid instead of failing the whole turn.
  const allowed = role === 'user' ? parts : parts.filter(part => part.type === 'text');
  return allowed.length ? allowed : '';
}

function customArguments(input) {
  return JSON.stringify({ input: typeof input === 'string' ? input : textOf(input) });
}

// Responses tools → chat tools. A `custom` tool (Codex's apply_patch is one) has no
// JSON schema at all, so it becomes a one-string function and the string is turned
// back into a custom_tool_call on the way home.
export function toChatTools(tools) {
  const customTools = new Set();
  const result = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function' && typeof tool.name === 'string') {
      result.push({ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? { type: 'object', properties: {} } } });
      continue;
    }
    if (tool.type === 'custom' && typeof tool.name === 'string') {
      customTools.add(tool.name);
      result.push({ type: 'function', function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: { type: 'object', properties: { input: { type: 'string', description: 'The raw tool input as one string.' } }, required: ['input'] },
      } });
    }
  }
  return { tools: result, customTools };
}

export function toChatRequest(body, model, options = {}) {
  // An empty (but present) list means the model takes no thinking level at all:
  // gemma answers only when the field is absent.
  const supported = Array.isArray(options.supportedEfforts) ? options.supportedEfforts : DEFAULT_GEMINI_EFFORTS;
  const { tools, customTools } = toChatTools(body?.tools);
  const messages = [];
  const push = message => { if (message) messages.push(message); };
  const instructions = typeof body?.instructions === 'string' ? body.instructions.trim() : '';
  if (instructions) push({ role: 'system', content: instructions });

  const input = Array.isArray(body?.input) ? body.input : [{ role: 'user', content: typeof body?.input === 'string' ? body.input : '' }];
  let pendingCalls = null;
  const flushCalls = () => {
    if (pendingCalls && pendingCalls.length) push({ role: 'assistant', content: null, tool_calls: pendingCalls });
    pendingCalls = null;
  };
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const type = typeof item.type === 'string' ? item.type : item.role ? 'message' : '';
    if (type === 'message') {
      const role = item.role === 'developer' || item.role === 'system' ? 'system' : item.role === 'assistant' ? 'assistant' : 'user';
      const content = toChatContent(item.content, role);
      flushCalls();
      if (typeof content === 'string' ? content.trim() : Array.isArray(content) && content.length) push({ role, content });
      continue;
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      if (typeof item.name !== 'string' || !item.name) continue;
      const args = type === 'custom_tool_call' ? customArguments(item.input) : typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : uid('call');
      pendingCalls ??= [];
      pendingCalls.push({
        id: callId,
        type: 'function',
        extra_content: { google: { thought_signature: thoughtSignatureFor(callId) } },
        function: { name: item.name, arguments: args },
      });
      continue;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      flushCalls();
      push({ role: 'tool', tool_call_id: typeof item.call_id === 'string' ? item.call_id : '', content: textOf(item.output ?? item.content) });
    }
    // Reasoning items carry either an encrypted blob or a summary; neither can be
    // replayed to Gemini, so they are simply skipped.
  }
  flushCalls();
  if (!messages.length) messages.push({ role: 'user', content: '' });

  const payload = { model, messages };
  if (body?.stream !== false) {
    payload.stream = true;
    // Ask for the usage block in the final chunk; the handler retries without it if
    // an upstream build rejects the field.
    payload.stream_options = { include_usage: true };
  }
  // `max_output_tokens` is deliberately not forwarded: Gemini counts thinking
  // tokens against it, so a Codex-sized ceiling truncates the visible answer
  // mid-sentence once the model thinks for a while.
  if (Number.isFinite(body?.temperature)) payload.temperature = body.temperature;
  if (Number.isFinite(body?.top_p)) payload.top_p = body.top_p;
  if (tools.length) payload.tools = tools;
  const choice = body?.tool_choice;
  if (choice === 'auto' || choice === 'none' || choice === 'required') payload.tool_choice = choice;
  else if (choice && typeof choice === 'object' && choice.type === 'function' && typeof choice.name === 'string') payload.tool_choice = { type: 'function', function: { name: choice.name } };
  else if (choice && typeof choice === 'object' && choice.type === 'custom' && typeof choice.name === 'string') payload.tool_choice = { type: 'function', function: { name: choice.name } };
  const effort = supported.length ? normalizeEffort(body?.reasoning?.effort, supported) : null;
  if (effort) payload.reasoning_effort = effort;
  return { payload, customTools, effort };
}

export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0;
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    // Gemini bills thinking tokens on top of the visible answer and folds them into
    // its own total, so the upstream number never adds up for a client. Keep the
    // parts consistent instead and let reasoning_tokens carry what it reports.
    total_tokens: input + output,
  };
}

export function usageTotals(usage) {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

function reasoningOf(message) {
  const candidates = [message?.reasoning_content, message?.reasoning, message?.reasoning_details?.map?.(part => part?.text).join?.('\n')];
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  return '';
}

function contentPartsOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content ? [content] : [];
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).filter(Boolean);
  return [];
}

// OpenAI shims disagree about whether a custom tool's raw input arrives as
// `{"input":"..."}` JSON or as the bare string; accept both.
export function customInputOf(raw) {
  if (typeof raw !== 'string') return textOf(raw);
  const text = raw.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      for (const key of ['input', 'patch', 'text']) if (typeof parsed[key] === 'string') return parsed[key];
    }
  } catch {}
  return raw;
}

export function toolCallItem(call, customTools) {
  const name = call?.function?.name ?? call?.name ?? '';
  const raw = call?.function?.arguments ?? call?.arguments ?? '';
  const callId = typeof call?.id === 'string' && call.id ? call.id : uid('call');
  if (customTools?.has?.(name)) {
    return { type: 'custom_tool_call', id: uid('ctc'), call_id: callId, name, input: customInputOf(raw), status: 'completed' };
  }
  return { type: 'function_call', id: uid('fc'), call_id: callId, name, arguments: typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}), status: 'completed' };
}

function messageItem(text, status = 'completed') {
  return { type: 'message', id: uid('msg'), role: 'assistant', status, content: [{ type: 'output_text', text, annotations: [] }] };
}

function reasoningItem(text) {
  return { type: 'reasoning', id: uid('rs'), summary: [{ type: 'summary_text', text }] };
}

export function baseResponse(model, id, status = 'completed') {
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status, output: [] };
}

export function fromChatResponse(chat, options = {}) {
  const id = options.id ?? uid('resp');
  const choice = chat?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output = [];
  const reasoning = reasoningOf(message);
  if (reasoning) output.push(reasoningItem(reasoning));
  const parts = contentPartsOf(message);
  if (parts.length) output.push(messageItem(parts.join('')));
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const name = call?.function?.name ?? call?.name;
    if (typeof name !== 'string' || !name) continue;
    rememberThoughtSignature(call?.id, call?.extra_content?.google?.thought_signature);
    output.push(toolCallItem(call, options.customTools));
  }
  if (!output.length) output.push(messageItem(''));
  const status = choice.finish_reason === 'length' ? 'incomplete' : 'completed';
  return {
    ...baseResponse(options.model, id, status),
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    output,
    parallel_tool_calls: false,
    usage: mapUsage(chat?.usage),
  };
}

// One translator per streamed turn. Gemini emits OpenAI-shaped chunks, so the job
// is bookkeeping: open an output item the first time each kind of delta appears,
// then close everything (and report usage) when the stream ends.
export function createStreamTranslator({ model, responseId, customTools, emit, onUsage }) {
  const id = responseId ?? uid('resp');
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines = [];
  let finished = false;
  let usage = mapUsage(null);
  let text = '';
  let textItem = null;
  let textIndex = -1;
  let reasoning = '';
  let reasoningItemId = null;
  let reasoningIndex = -1;
  let nextIndex = 0;
  const calls = new Map();
  const order = [];
  let pendingSignature = '';
  let stopReason = '';

  const send = (type, payload) => emit(`${type}`, { type, ...payload });

  const ensureText = () => {
    if (textItem) return textItem;
    textIndex = nextIndex++;
    textItem = { id: uid('msg'), index: textIndex };
    send('response.output_item.added', { output_index: textIndex, item: { type: 'message', id: textItem.id, role: 'assistant', status: 'in_progress', content: [] } });
    send('response.content_part.added', { item_id: textItem.id, output_index: textIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    order.push({ kind: 'text' });
    return textItem;
  };

  const ensureReasoning = () => {
    if (reasoningItemId) return;
    reasoningIndex = nextIndex++;
    reasoningItemId = uid('rs');
    send('response.output_item.added', { output_index: reasoningIndex, item: { type: 'reasoning', id: reasoningItemId, summary: [] } });
    send('response.reasoning_summary_part.added', { item_id: reasoningItemId, output_index: reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
    order.push({ kind: 'reasoning' });
  };

  const ensureCall = entry => {
    if (entry.added) return;
    entry.index = nextIndex++;
    entry.added = true;
    const isCustom = Boolean(customTools?.has?.(entry.name));
    entry.itemType = isCustom ? 'custom_tool_call' : 'function_call';
    entry.id = uid(isCustom ? 'ctc' : 'fc');
    send('response.output_item.added', {
      output_index: entry.index,
      item: isCustom
        ? { type: 'custom_tool_call', id: entry.id, call_id: entry.callId, name: entry.name, input: '', status: 'in_progress' }
        : { type: 'function_call', id: entry.id, call_id: entry.callId, name: entry.name, arguments: '', status: 'in_progress' },
    });
    order.push({ kind: 'call', entry });
  };

  const handleChunk = chunk => {
    if (!chunk || typeof chunk !== 'object') return;
    if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? 'upstream error');
    if (chunk.usage) usage = mapUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    // The signature arrives either on the call delta itself or on the delta just
    // before it, so a bare one is held until a call id shows up.
    const signature = delta.extra_content?.google?.thought_signature;
    if (typeof signature === 'string' && signature) {
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      const named = calls.filter(call => typeof call?.id === 'string' && call.id);
      if (named.length) for (const call of named) rememberThoughtSignature(call.id, signature);
      else pendingSignature = signature;
    }
    const think = reasoningOf(delta);
    if (think) {
      ensureReasoning();
      reasoning += think;
      send('response.reasoning_summary_text.delta', { item_id: reasoningItemId, output_index: reasoningIndex, summary_index: 0, delta: think });
    }
    const piece = contentPartsOf(delta).join('');
    if (piece) {
      ensureText();
      text += piece;
      send('response.output_text.delta', { item_id: textItem.id, output_index: textIndex, content_index: 0, delta: piece });
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = Number.isFinite(call?.index) ? call.index : 0;
      let entry = calls.get(key);
      if (!entry) { entry = { callId: '', name: '', args: '', added: false }; calls.set(key, entry); }
      if (typeof call.id === 'string' && call.id) entry.callId ||= call.id;
      if (typeof call.function?.name === 'string' && call.function.name) entry.name ||= call.function.name;
      const fragment = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
      if (!entry.name) continue;
      entry.callId ||= uid('call');
      const own = call?.extra_content?.google?.thought_signature;
      const held = typeof own === 'string' && own ? own : pendingSignature;
      if (held) { rememberThoughtSignature(entry.callId, held); pendingSignature = ''; }
      ensureCall(entry);
      if (fragment) {
        entry.args += fragment;
        send(entry.itemType === 'custom_tool_call' ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', {
          item_id: entry.id, output_index: entry.index, delta: fragment,
        });
      }
    }
    // The finish reason can land one chunk before the usage frame, so the turn is
    // only closed when the stream ends or [DONE] arrives.
    if (choice.finish_reason) stopReason = choice.finish_reason;
  };

  const dispatch = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') return finish(stopReason || 'stop');
    try { handleChunk(JSON.parse(data)); } catch (error) { fail(error?.message ?? 'The Gemini stream could not be parsed.'); }
  };

  const closeItems = () => {
    const output = [];
    const emitDone = entry => {
      if (entry.kind === 'reasoning') {
        const item = reasoningItem(reasoning);
        item.id = reasoningItemId;
        send('response.reasoning_summary_text.done', { item_id: reasoningItemId, output_index: reasoningIndex, summary_index: 0, text: reasoning });
        send('response.reasoning_summary_part.done', { item_id: reasoningItemId, output_index: reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: reasoning } });
        send('response.output_item.done', { output_index: reasoningIndex, item });
        output.push({ index: reasoningIndex, item });
        return;
      }
      if (entry.kind === 'text') {
        const item = messageItem(text);
        item.id = textItem.id;
        send('response.output_text.done', { item_id: textItem.id, output_index: textIndex, content_index: 0, text });
        send('response.content_part.done', { item_id: textItem.id, output_index: textIndex, content_index: 0, part: item.content[0] });
        send('response.output_item.done', { output_index: textIndex, item });
        output.push({ index: textIndex, item });
        return;
      }
      const call = entry.entry;
      if (call.itemType === 'custom_tool_call') {
        const input = customInputOf(call.args);
        send('response.custom_tool_call_input.done', { item_id: call.id, output_index: call.index, input });
        const item = { type: 'custom_tool_call', id: call.id, call_id: call.callId, name: call.name, input, status: 'completed' };
        send('response.output_item.done', { output_index: call.index, item });
        output.push({ index: call.index, item });
        return;
      }
      const item = { type: 'function_call', id: call.id, call_id: call.callId, name: call.name, arguments: call.args, status: 'completed' };
      send('response.function_call_arguments.done', { item_id: call.id, output_index: call.index, arguments: call.args });
      send('response.output_item.done', { output_index: call.index, item });
      output.push({ index: call.index, item });
    };
    for (const entry of order) emitDone(entry);
    return output.sort((a, b) => a.index - b.index).map(entry => entry.item);
  };

  function finish(reason) {
    if (finished) return;
    finished = true;
    const output = closeItems();
    const status = reason === 'length' ? 'incomplete' : 'completed';
    const response = {
      ...baseResponse(model, id, status),
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      output: output.length ? output : [messageItem('')],
      parallel_tool_calls: false,
      usage,
    };
    send('response.completed', { response });
    onUsage?.(usage);
  }

  function fail(message) {
    if (finished) return;
    finished = true;
    send('response.failed', { response: { ...baseResponse(model, id, 'failed'), error: { code: 'upstream_error', message: String(message ?? 'upstream error').slice(0, 320) } } });
  }

  return {
    created() { send('response.created', { response: { ...baseResponse(model, id, 'in_progress'), output: [] } }); },
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) { dispatch(); continue; }
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    },
    close() { if (!finished) finish(stopReason || 'stop'); },
    fail,
    isFinished: () => finished,
  };
}
