import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createResponseObserver } from './response-observer.mjs';
import { safeRequestEvent } from './security-metadata.mjs';

function observe(events, streaming = true) {
  const usages = [];
  const failures = [];
  const ids = [];
  const observer = createResponseObserver(streaming ? 'text/event-stream' : 'application/json', id => ids.push(id), 1024 * 1024, usage => usages.push(usage), failure => failures.push(failure));
  const source = Buffer.from(streaming ? events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') : JSON.stringify(events[0]));
  // Split UTF-8 and SSE lines at arbitrary byte boundaries.
  for (let index = 0; index < source.length; index += 7) observer.write(source.subarray(index, index + 7));
  observer.end();
  return { usages, failures, ids };
}

test('Responses usage keeps zero and derives total from input plus output only', () => {
  const { usages } = observe([{ response: { id: 'resp_zero', usage: { input_tokens: 10, output_tokens: 0, input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 0 } } } }], false);
  assert.deepEqual(usages.at(-1), { inputTokens: 10, outputTokens: 0, totalTokens: 10, cachedTokens: 8, reasoningTokens: 0 });
});

test('compatible prompt/completion usage preserves cached and reasoning subcounts', () => {
  const { usages } = observe([{ usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 9 }, completion_tokens_details: { reasoning_tokens: 3 } } }], false);
  assert.deepEqual(usages.at(-1), { inputTokens: 12, outputTokens: 5, totalTokens: 17, cachedTokens: 9, reasoningTokens: 3 });
});

test('stream usage snapshots replace counts rather than accumulating the same tokens', () => {
  const { usages, ids } = observe([
    { type: 'response.created', response: { id: 'resp_cumulative', usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'response.completed', response: { id: 'resp_cumulative', usage: { input_tokens: 20, output_tokens: 7 } } },
  ]);
  assert.equal(usages[0].totalTokens, 20);
  assert.equal(usages.at(-1).totalTokens, 27);
  assert.ok(ids.includes('resp_cumulative'));
});

test('partial stream usage preserves earlier input and explicit total without inventing a breakdown', () => {
  const { usages } = observe([
    { usage: { input_tokens: 30, total_tokens: 40, input_tokens_details: { cached_tokens: 21 } } },
    { usage: { output_tokens: 4, output_tokens_details: { reasoning_tokens: 2 } } },
    { usage: { total_tokens: 36 } },
  ]);
  assert.deepEqual(usages.at(-1), { inputTokens: 30, outputTokens: 4, totalTokens: 36, cachedTokens: 21, reasoningTokens: 2 });
  assert.equal(usages[1].totalTokens, 40);
});

test('invalid or missing usage is unknown while a total-only zero is valid', () => {
  assert.deepEqual(observe([{ usage: { input_tokens: '5', output_tokens: -1, total_tokens: null } }], false).usages, []);
  assert.deepEqual(observe([{ usage: { total_tokens: 0 } }], false).usages.at(-1), { inputTokens: null, outputTokens: null, totalTokens: 0, cachedTokens: null, reasoningTokens: null });
});

test('failed SSE retains numeric usage while persisted failure is a fixed category', () => {
  const { failures, usages } = observe([{ type: 'response.failed', response: { id: 'resp_failed', status: 'failed', error: { code: 'unsafe-custom-code', message: '错误文本不应保存: unrelated private sample' }, usage: { input_tokens: 9, output_tokens: 1 } } }]);
  const event = safeRequestEvent({ at: '2026-11-03T00:00:00Z', route: 'agentrouter', model: 'requested', upstreamModel: 'upstream', status: 200, failed: failures[0].message, usage: usages.at(-1) }, new Set(['requested', 'upstream']));
  assert.equal(event.failed, 'upstream_error');
  assert.equal(event.usage.totalTokens, 10);
  assert.equal(event.upstreamModel, 'upstream');
  assert.ok(!JSON.stringify(event).includes('private sample'));
});

test('requested and upstream model fields both require the local allowlist', () => {
  const event = safeRequestEvent({ route: 'original', model: 'allowed', upstreamModel: 'untrusted-string' }, new Set(['allowed']));
  assert.deepEqual(event, { route: 'original', model: 'allowed', upstreamModel: 'unknown' });
  assert.equal(safeRequestEvent({ route: 'original', model: 'allowed', upstreamModel: 'sk-synthetic-test-secret' }, new Set(['allowed', 'sk-synthetic-test-secret'])).upstreamModel, 'unknown');
});

const temporaryRoot = mkdtempSync(join(tmpdir(), 'gateway-usage-recording-'));
process.env.CODEX_MODEL_GATEWAY_HINTS = join(temporaryRoot, 'hints.json');
const { createRouter } = await import('./router.mjs');

async function fixture(t, failure = false) {
  const records = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (failure) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'response.failed', response: { id: 'resp_failure_test', status: 'failed', error: { code: 'content_blocked', message: 'Synthetic content failure includes private sample text' }, usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_success_test', model: `untrusted-${body.model}`, usage: { input_tokens: 11, output_tokens: 4, input_tokens_details: { cached_tokens: 6 }, output_tokens_details: { reasoning_tokens: 2 } } }));
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const router = createRouter({
    defaultBaseUrl: `${upstreamUrl}/original/v1`, opencodeBaseUrl: `${upstreamUrl}/opencode/v1`, agentrouterBaseUrl: `${upstreamUrl}/agentrouter/v1`,
    opencodeModels: { 'oc-requested': 'oc-upstream' }, agentrouterModels: { 'ar-requested': 'ar-upstream' },
    catalog: { models: [{ slug: 'original-model' }] },
    getClientToken: () => 'local-test-secret', getOpencodeToken: () => 'oc-test-secret',
    getAgentrouterAccounts: () => [{ id: 'test-account', enabled: true, token: 'ar-test-secret' }],
    diagnosticsDirectory: temporaryRoot, log: event => records.push(event), maxStreamHeadMs: 200,
  });
  router.listen(0, '127.0.0.1');
  await once(router, 'listening');
  t.after(() => { router.closeAllConnections(); router.close(); upstream.closeAllConnections(); upstream.close(); });
  const url = `http://127.0.0.1:${router.address().port}`;
  return { records, send: async model => {
    const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { Authorization: 'Bearer local-test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: failure, input: 'Synthetic private prompt must never be in the log', prompt_cache_key: `test-${model}` }) });
    await response.text();
    await new Promise(resolve => setImmediate(resolve));
    return response.status;
  } };
}

test('all gateway routes log requested and selected upstream model with numeric usage only', async t => {
  const { records, send } = await fixture(t);
  for (const model of ['original-model', 'oc-requested', 'ar-requested']) assert.equal(await send(model), 200);
  assert.deepEqual(records.map(event => [event.route, event.model, event.upstreamModel, event.usage.totalTokens]), [
    ['original', 'original-model', 'original-model', 15],
    ['opencode', 'oc-requested', 'oc-upstream', 15],
    ['agentrouter', 'ar-requested', 'ar-upstream', 15],
  ]);
  assert.equal(records[2].accountId, 'test-account');
  const text = JSON.stringify(records);
  for (const unwanted of ['Synthetic private prompt', 'test-secret', 'untrusted-']) assert.ok(!text.includes(unwanted));
});

test('HTTP 200 with response.failed logs a fixed failure and the reported usage', async t => {
  const { records, send } = await fixture(t, true);
  assert.equal(await send('ar-requested'), 200);
  assert.equal(records.length, 1);
  assert.equal(records[0].failed, 'upstream_error');
  assert.equal(records[0].usage.totalTokens, 3);
  assert.equal(records[0].upstreamModel, 'ar-upstream');
  assert.ok(!JSON.stringify(records).includes('private sample'));
});

test.after(() => {
  const destination = resolve(temporaryRoot);
  assert.ok(destination.startsWith(resolve(tmpdir()) + '\\'));
  rmSync(destination, { recursive: true, force: true });
});
