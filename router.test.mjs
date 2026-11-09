import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

// Keep the learned replay levels of a test run out of the live router's cache,
// both so the tests start from level 0 and so they never pollute real traffic.
const hintsPath = join(mkdtempSync(join(tmpdir(), 'gateway-hints-')), 'level-hints.json');
process.env.CODEX_MODEL_GATEWAY_HINTS = hintsPath;

let createRouter;
let retryableTransportError;
let dropOlderImages;
let truncateToolOutputs;
let isForeignItemError;
let stripServerSideRefs;
let classifyStreamHead;
let isRetryableStreamFailure;
let isRepairableStreamFailure;
let threadFingerprint;
let compressImages;
try { ({ createRouter, retryableTransportError, dropOlderImages, truncateToolOutputs, isForeignItemError, stripServerSideRefs, classifyStreamHead, isRetryableStreamFailure, isRepairableStreamFailure, threadFingerprint, compressImages } = await import('./router.mjs')); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

test('the router implementation is available', () => {
  assert.equal(typeof createRouter, 'function');
});

test('a thread fingerprint ignores the parts of a replay that grow with every turn', () => {
  if (typeof threadFingerprint !== 'function') return;
  const first = {
    instructions: 'You are Codex.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Fix the failing test.' }] }],
  };
  const later = {
    instructions: 'You are Codex.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Fix the failing test.' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Which one?' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'The parser one.' }] },
    ],
    model: 'gpt-6.1-astra',
  };
  assert.equal(threadFingerprint(first), threadFingerprint(later));
  assert.equal(threadFingerprint({ ...later, model: 'another-model' }), threadFingerprint(first));
  assert.notEqual(threadFingerprint({ ...first, instructions: 'You are a different agent.' }), threadFingerprint(first));
  assert.notEqual(threadFingerprint({ ...first, input: [{ role: 'user', content: 'Another task.' }] }), threadFingerprint(first));
  assert.equal(threadFingerprint({ input: [{ role: 'assistant', content: 'no user turn' }] }), null);
  assert.equal(threadFingerprint(undefined), null);
  assert.match(threadFingerprint(first), /^[a-f0-9]{32}$/);
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t, handler, overrides = {}) {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    calls.push(call);
    if (handler) return handler(call, res);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ received: true, model: JSON.parse(call.body).model }));
  });
  const upstreamUrl = await listen(upstream);
  const server = createRouter({
    defaultBaseUrl: `${upstreamUrl}/original/v1`,
    opencodeBaseUrl: `${upstreamUrl}/opencode/v1`,
    agentrouterBaseUrl: `${upstreamUrl}/agentrouter/v1`,
    agentrouterModels: { 'gpt-6-astra-ar': 'gpt-6-astra', 'gpt-6.1-sol-ar': 'gpt-6.1-sol' },
    getClientToken: () => 'original-secret',
    getOpencodeToken: () => 'oc-secret',
    getAgentrouterToken: () => 'ar-secret',
    catalog: { models: [{ slug: 'gpt-6.1-sol' }] },
    diagnosticsDirectory: mkdtempSync(join(tmpdir(), 'gateway-refusal-test-')),
    ...overrides,
  });
  const url = await listen(server);
  t.after(() => {
    server.closeAllConnections(); server.close();
    upstream.closeAllConnections(); upstream.close();
  });
  const send = (body, headers = {}, path = '/v1/responses') => fetch(`${url}${path}`, {
    method: 'POST', headers: { Authorization: 'Bearer original-secret', 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { calls, send, url };
}

if (createRouter) {
  test('existing models retain their original request bytes and credentials', async t => {
    const { send, calls } = await setup(t);
    const body = '{ "model": "gpt-6.1-sol", "input": "Synthetic", "service_tier": "priority" }';
    const response = await send(body, { 'ChatGPT-Account-ID': 'original-account' });
    assert.equal(response.status, 200); await response.text();
    assert.equal(calls[0].path, '/original/v1/responses');
    assert.equal(calls[0].headers.authorization, 'Bearer original-secret');
    assert.equal(calls[0].headers['chatgpt-account-id'], 'original-account');
    assert.equal(calls[0].body, body);
  });

  // A passthrough request is forwarded byte for byte, so the one thing it cannot
  // answer is a history whose reasoning blobs only the other resource can read.
  // That thread used to be stuck for good: the refusal came back to the client.
  test('a passthrough request refused for a foreign blob is resent without the handles', async t => {
    const refusal = { error: { message: "Missing required parameter: 'input[199].content[1].encrypted_content'.", type: 'invalid_request_error', code: 'missing_required_parameter' } };
    const { send, calls } = await setup(t, (call, res) => {
      if (calls.length === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(refusal));
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ received: true }));
    });
    const response = await send({
      model: 'gpt-6.1-sol',
      input: [
        { type: 'reasoning', id: 'rs_foreign', summary: [], encrypted_content: 'gAAAA-foreign' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic' }] },
      ],
    }, { 'ChatGPT-Account-ID': 'original-account' });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].path, '/original/v1/responses');
    assert.equal(calls[1].headers['chatgpt-account-id'], 'original-account');
    const resent = JSON.parse(calls[1].body);
    assert.equal(resent.input.some(item => item.encrypted_content || item.id), false);
    assert.equal(resent.input.at(-1).content[0].text, 'Synthetic');
  });

  test('the removed a6api ids no longer reach a6api', async t => {
    const { send, calls } = await setup(t);
    // The plain DeepSeek id used to be an a6api entry; opencode now serves it.
    await (await send({ model: 'deepseek-v4.1-flash', input: 'Synthetic' })).text();
    assert.equal(calls.at(-1).path, '/opencode/v1/responses');
    assert.equal(calls.at(-1).headers.authorization, 'Bearer oc-secret');
    // The -a6 aliases and the -1017 snapshot are gone, so they fall back to the
    // original gateway instead of a retired provider.
    for (const model of ['deepseek-v4.1-flash-1017', 'gpt-6-astra-a6', 'gpt-6.1-sol-a6']) {
      const response = await send({ model, input: 'Synthetic' }); await response.text();
      assert.equal(calls.at(-1).path, '/original/v1/responses', model);
      assert.equal(calls.at(-1).headers.authorization, 'Bearer original-secret', model);
      assert.equal(JSON.parse(calls.at(-1).body).model, model);
    }
  });

  test('opencode models remap their id, add a session header and drop gateway identity', async t => {
    const { send, calls } = await setup(t);
    const response = await send({ model: 'deepseek-v4.1-flash-oc', input: 'Synthetic', prompt_cache_key: 'thread-abc', reasoning: { effort: 'low' }, service_tier: 'fast', tools: [{ type: 'function', name: 'exec_command' }] }, {
      'ChatGPT-Account-ID': 'original-account', Cookie: 'session=original',
      'OpenAI-Organization': 'original-org', 'X-API-Key': 'original-key',
    });
    assert.equal(response.status, 200); await response.text();
    assert.equal(calls[0].path, '/opencode/v1/responses');
    assert.equal(calls[0].headers.authorization, 'Bearer oc-secret');
    for (const header of ['chatgpt-account-id', 'cookie', 'openai-organization', 'x-api-key']) {
      assert.equal(calls[0].headers[header], undefined);
    }
    assert.equal(calls[0].headers['x-opencode-session'], 'thread-abc');
    const sent = JSON.parse(calls[0].body);
    assert.equal(sent.model, 'deepseek-v4.1-flash');
    assert.equal(sent.prompt_cache_key, 'thread-abc');
    assert.deepEqual(sent.reasoning, { effort: 'low' });
    assert.equal(sent.service_tier, undefined);
    assert.equal(sent.tools.length, 1);
  });

  test('an opencode request without a conversation key still gets a session header', async t => {
    const { send, calls } = await setup(t);
    await (await send({ model: 'deepseek-v4.1-flash-oc', input: 'Synthetic' })).text();
    assert.match(calls[0].headers['x-opencode-session'], /^[0-9a-f-]{36}$/);
    assert.equal(JSON.parse(calls[0].body).model, 'deepseek-v4.1-flash');
  });

  test('the model mapping can be overridden from settings', async t => {
    const { send, calls } = await setup(t, undefined, { opencodeModels: { 'custom-oc': 'deepseek-v4.1-flash' } });
    await (await send({ model: 'custom-oc', input: 'Synthetic' })).text();
    assert.equal(calls[0].path, '/opencode/v1/responses');
    assert.equal(JSON.parse(calls[0].body).model, 'deepseek-v4.1-flash');
    await (await send({ model: 'deepseek-v4.1-flash-oc', input: 'Synthetic' })).text();
    assert.equal(calls[1].path, '/original/v1/responses');
  });

  test('a missing opencode key fails locally without touching any gateway', async t => {
    const { send, calls } = await setup(t, undefined, { getOpencodeToken: () => '' });
    const response = await send({ model: 'deepseek-v4.1-flash-oc', input: 'Synthetic' });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /opencode/);
    assert.equal(calls.length, 0);
  });

  test('unauthenticated and browser-origin requests cannot reach either gateway', async t => {
    const { send, calls } = await setup(t);
    assert.equal((await send({ model: 'gpt-6.1-sol' }, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await send({ model: 'gpt-6.1-sol' }, { Origin: 'https://example.com' })).status, 403);
    assert.equal(calls.length, 0);
  });

  test('invalid JSON, missing model and unsupported paths are rejected locally', async t => {
    const { send, calls } = await setup(t);
    assert.equal((await send('{')).status, 400);
    assert.equal((await send({ input: 'no model' })).status, 400);
    assert.equal((await send({ model: 'gpt-6.1-sol' }, {}, '/v1/other')).status, 404);
    assert.equal(calls.length, 0);
  });

  test('streamed Responses data arrives before the upstream stream finishes', async t => {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const { send } = await setup(t, async (_call, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: response.output_text.delta\ndata: {"delta":"OK"}\n\n');
      await wait;
      res.end('event: response.completed\ndata: {}\n\n');
    });
    const response = await send({ model: 'deepseek-v4.1-flash-oc', stream: true });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(Buffer.from(first.value).toString(), /output_text.delta/);
    release();
    let remaining = '';
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; remaining += Buffer.from(chunk.value).toString(); }
    assert.match(remaining, /response.completed/);
  });

  test('gateway error status and body survive forwarding without exposing other credentials', async t => {
    const { send } = await setup(t, (_call, res) => { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' }); res.end('{"error":{"message":"rate limit"}}'); });
    const response = await send({ model: 'gpt-6.1-sol' });
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '1');
    assert.equal(await response.text(), '{"error":{"message":"rate limit"}}');
  });

  test('models endpoint requires auth and returns the configured catalog', async t => {
    const { url, calls } = await setup(t);
    assert.equal((await fetch(`${url}/v1/models`)).status, 401);
    const response = await fetch(`${url}/v1/models`, { headers: { Authorization: 'Bearer original-secret' } });
    assert.deepEqual(await response.json(), { models: [{ slug: 'gpt-6.1-sol' }] });
    assert.equal(calls.length, 0);
  });

  test('the health report lists every live route', async t => {
    const { url } = await setup(t);
    const health = await (await fetch(`${url}/health`)).json();
    assert.deepEqual(health.routes, ['original', 'opencode', 'agentrouter', 'gemini', 'antigravity']);
  });

  test('agentrouter models are remapped, re-authenticated and carry the allowlisted user agent', async t => {
    const { send, calls } = await setup(t);
    const response = await send({ model: 'gpt-6-astra-ar', input: 'Synthetic test', service_tier: 'auto', text: { verbosity: 'high' } }, {
      'User-Agent': 'codex_cli_rs/9.9.9', 'ChatGPT-Account-ID': 'original-account', 'X-API-Key': 'original-key',
    });
    assert.equal(response.status, 200); await response.text();
    assert.equal(calls[0].path, '/agentrouter/v1/responses');
    assert.equal(calls[0].headers.authorization, 'Bearer ar-secret');
    assert.equal(calls[0].headers['user-agent'], 'codex_cli_rs/0.61.2');
    assert.equal(calls[0].headers['chatgpt-account-id'], undefined);
    assert.equal(calls[0].headers['x-api-key'], undefined);
    const sent = JSON.parse(calls[0].body);
    assert.equal(sent.model, 'gpt-6-astra');
    assert.equal(sent.service_tier, undefined);
    assert.equal(sent.text, undefined);
  });

  test('a missing agentrouter key fails locally without touching any gateway', async t => {
    const { send, calls } = await setup(t, undefined, { getAgentrouterToken: () => '' });
    const response = await send({ model: 'gpt-6-astra-ar', input: 'Synthetic' });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /agentrouter credential/);
    assert.equal(calls.length, 0);
  });

  test('an unreachable agentrouter proxy fails with a clear error instead of hanging', async t => {
    const { send, calls } = await setup(t, undefined, { agentrouterProxy: 'http://127.0.0.1:1' });
    const response = await send({ model: 'gpt-6-astra-ar', input: 'Synthetic' });
    // A dead tunnel is not the model's fault and cannot be fixed by an immediate
    // retry, so the client is told to wait instead of hammering the same path.
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '30');
    assert.match((await response.json()).error.message, /proxy/);
    assert.equal(calls.length, 0);
  });

  test('a dropped connection answers 503 with a retry hint and records why', async t => {
    const events = [];
    const accounts = [{ id: 'first', label: 'First', token: 'first-token', enabled: true }];
    const { send } = await setup(t, (_call, res) => { res.destroy(); },
      { getAgentrouterAccounts: () => accounts, log: event => events.push(event) });
    const response = await send({ model: 'gpt-6.1-sol-ar', input: [], prompt_cache_key: 'thread-tcp-reset' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '30');
    await response.text();
    await new Promise(resolve => setTimeout(resolve, 100));
    const record = events.at(-1);
    assert.equal(record.status, 503);
    assert.equal(typeof record.error, 'string', 'the log keeps the failing layer');
    assert.match(record.error, /transport_error|connect_timeout|tls_handshake|proxy_unreachable/);
  });

  test('agentrouter ids only match exactly, leaving the original route intact', async t => {
    const { send, calls } = await setup(t);
    await (await send({ model: 'gpt-6-astra', input: 'Synthetic' })).text();
    assert.equal(calls[0].path, '/original/v1/responses');
    assert.equal(calls[0].headers.authorization, 'Bearer original-secret');
    await (await send({ model: 'gpt-6.1-sol', input: 'Synthetic' })).text();
    assert.equal(calls[1].path, '/original/v1/responses');
  });

  test('the request log records shape and the upstream refusal text', async t => {
    const events = [];
    const { send } = await setup(t, (_call, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"Your requests to gpt-6-astra for gpt-6-astra in eastus2 have exceeded token rate limit."}}');
    }, { log: event => events.push(event) });
    const response = await send({ model: 'gpt-6-astra-ar', store: true, previous_response_id: 'resp_1', input: [{ role: 'user', content: 'hi' }] });
    await response.text();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(events.length, 1);
    assert.equal(events[0].route, 'agentrouter');
    assert.equal(events[0].model, 'gpt-6-astra-ar');
    assert.equal(events[0].status, 500);
    assert.equal(events[0].store, true);
    assert.equal(events[0].chain, true);
    assert.equal(events[0].items, 1);
    assert.equal(events[0].failover, undefined);
    assert.equal(events[0].error, 'rate_limit');
  });

  test('the gpt-6.1-sol agentrouter variant remaps to the upstream id', async t => {
    const { send, calls } = await setup(t);
    const response = await send({ model: 'gpt-6.1-sol-ar', input: 'Synthetic' });
    assert.equal(response.status, 200); await response.text();
    assert.equal(calls[0].path, '/agentrouter/v1/responses');
    assert.equal(calls[0].headers.authorization, 'Bearer ar-secret');
    assert.equal(JSON.parse(calls[0].body).model, 'gpt-6.1-sol');
  });

  test('a foreign encrypted reasoning blob is dropped and the request retried once', async t => {
    const events = [];
    let first = true;
    const { send, calls } = await setup(t, (_call, res) => {
      if (first) {
        first = false;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end('{"error":{"message":"The encrypted content for item rs_0f85ab316299d821016ae72147050c819bb2d079e16da24154 could not be verified. Reason: Encrypted content could not be decrypted or parsed. [trace_id=ff44ed4982a1520a24da0676100e4696]","type":"invalid_request_error"}}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"completed"}');
    }, { log: event => events.push(event) });
    const response = await send({
      model: 'gpt-6.1-sol-ar',
      include: ['reasoning.encrypted_content'],
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'reasoning', id: 'rs_foreign', encrypted_content: 'gAAAA-foreign-blob', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      ],
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"status":"completed"}');
    assert.equal(calls.length, 2);
    // Same route, same credentials: only the blob is dropped.
    assert.equal(calls[1].path, '/agentrouter/v1/responses');
    assert.equal(calls[1].headers.authorization, 'Bearer ar-secret');
    assert.equal(JSON.parse(calls[1].body).input.length, 2);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 200);
    assert.equal(events[0].sanitized, true);
    assert.equal(events[0].error, 'encrypted_context');
  });

  test('a reasoning item from another upstream resource is dropped while screenshots stay', async t => {
    let first = true;
    const { send, calls } = await setup(t, (_call, res) => {
      if (first) {
        first = false;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end('{"error":{"message":"OpenAI Responses bad request: The requested item was created under a different *** OpenAI resource. Use the same resource that created the item to access it. [trace_id=5511ea3b5b8d888661336fb0f5555e56]","type":"invalid_request_error"}}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"completed"}');
    });
    const response = await send({
      model: 'gpt-6.1-sol-ar',
      include: ['reasoning.encrypted_content'],
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'reasoning', id: 'rs_foreign', encrypted_content: 'gAAAA-foreign-blob', summary: [] },
        { type: 'custom_tool_call', call_id: 'call_1', name: 'computer', input: 'screenshot' },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'shot' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      ],
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    const retried = JSON.parse(calls[1].body);
    assert.equal(retried.input.some(item => item.type === 'reasoning'), false);
    assert.equal(retried.input.some(item => item.type === 'custom_tool_call_output'), true);
    assert.match(calls[1].body, /data:image\/png;base64,AAAA/);
  });

  test('the refusal wording of a foreign reasoning item is recognised', () => {
    assert.equal(isForeignItemError('The requested item was created under a different *** OpenAI resource.'), true);
    assert.equal(isForeignItemError('Use the same resource that created the item to access it.'), true);
    assert.equal(isForeignItemError('The encrypted content for item rs_0 could not be verified.'), true);
    assert.equal(isForeignItemError("Item 'fc_0' of type 'function_call' was provided without its required 'reasoning' item: 'rs_0'."), true);
    assert.equal(isForeignItemError("Item with id 'rs_0' not found."), true);
    assert.equal(isForeignItemError('No tool call found for custom tool call output with call_id call_1.'), false);
    assert.equal(isForeignItemError('Invalid value for input[0].content.'), false);
  });

  test('a failed stream event is reported with its reason', async () => {
    const { createResponseObserver } = await import('./response-observer.mjs');
    const failures = [];
    const observer = createResponseObserver('text/event-stream', () => {}, 1024 * 1024, undefined, value => failures.push(value));
    observer.write(Buffer.from('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
    observer.write(Buffer.from('data: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"code":"context_length_exceeded","message":"Your input exceeds the context window."}}}\n\n'));
    observer.end();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'context_length_exceeded');
    assert.match(failures[0].message, /context window/);
    const errorEvent = createResponseObserver('text/event-stream', () => {}, 1024 * 1024, undefined, value => failures.push(value));
    errorEvent.write(Buffer.from('data: {"type":"error","code":"rate_limit_exceeded","message":"slow down"}\n\n'));
    errorEvent.end();
    assert.equal(failures.at(-1).code, 'rate_limit_exceeded');
  });

  test('a foreign-context refusal is repaired by one replay without any handle', async t => {
    let attempt = 0;
    const { send, calls } = await setup(t, (_call, res) => {
      attempt += 1;
      if (attempt === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end('{"error":{"message":"The requested item was created under a different *** OpenAI resource.","type":"invalid_request_error"}}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"completed"}');
    });
    const response = await send({
      model: 'gpt-6.1-sol-ar',
      include: ['reasoning.encrypted_content'],
      input: [
        { type: 'message', id: 'msg_foreign', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'reasoning', id: 'rs_foreign', encrypted_content: 'gAAAA-foreign-blob', summary: [] },
        { type: 'message', id: 'msg_foreign_two', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      ],
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    const last = JSON.parse(calls[1].body);
    assert.equal(last.include, undefined);
    assert.deepEqual(last.input.map(item => item.id), [undefined, undefined]);
    assert.equal(last.input.some(item => item.type === 'reasoning'), false);
  });

  test('an id-only reasoning item from another resource is repaired in one retry', async t => {
    let attempt = 0;
    const { send, calls } = await setup(t, (_call, res) => {
      attempt += 1;
      if (attempt === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end('{"error":{"message":"The requested item was created under a different *** OpenAI resource.","type":"invalid_request_error"}}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"completed"}');
    });
    const response = await send({
      model: 'gpt-6.1-sol-ar',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'id only reasoning' }] },
        { type: 'reasoning', id: 'rs_foreign', summary: [] },
      ],
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    const last = JSON.parse(calls[1].body);
    assert.equal(last.input.some(item => item.id), false);
    assert.equal(last.input.length, 2);
  });

  test('a conversation that needed a rebuilt replay starts from that level again', async t => {
    let attempt = 0;
    const { send, calls } = await setup(t, (_call, res) => {
      attempt += 1;
      if (attempt === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end('{"error":{"message":"The requested item was created under a different *** OpenAI resource.","type":"invalid_request_error"}}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"completed"}');
    });
    const payload = {
      model: 'gpt-6.1-sol-ar',
      prompt_cache_key: 'thread-that-moved-accounts',
      include: ['reasoning.encrypted_content'],
      input: [
        { type: 'message', id: 'msg_foreign', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'reasoning', id: 'rs_foreign', encrypted_content: 'gAAAA-foreign-blob', summary: [] },
      ],
    };
    const first = await send(payload);
    assert.equal(first.status, 200);
    assert.equal(calls.length, 2);
    const second = await send(payload);
    assert.equal(second.status, 200);
    // The second turn skips the refusal and goes straight to the level that worked.
    assert.equal(calls.length, 3);
    assert.equal(JSON.parse(calls[2].body).input.some(item => 'id' in item), false);
  });

  test('server-side references are stripped from the replay that gives up everything', () => {
    const payload = {
      include: ['reasoning.encrypted_content'],
      input: [
        { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'item_reference', id: 'rs_1' },
        { type: 'reasoning', id: 'rs_2', encrypted_content: 'blob', summary: [] },
      ],
    };
    assert.equal(stripServerSideRefs(payload), true);
    assert.equal(payload.include, undefined);
    assert.equal(payload.input.length, 2);
    assert.deepEqual(payload.input.map(item => item.type), ['message', 'reasoning']);
    assert.equal(payload.input.some(item => 'id' in item), false);
    assert.equal(payload.input.some(item => 'encrypted_content' in item), false);
  });

  test('a 400 that the router cannot repair is forwarded to the client unchanged', async t => {
    const { send, calls } = await setup(t, (_call, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"The requested item was created under a different Azure OpenAI resource."}}');
    });
    const response = await send({ model: 'gpt-6.1-sol-ar', input: 'Synthetic' });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /different Azure OpenAI resource/);
    assert.equal(calls.length, 1);
  });

  test('dropping a reasoning blob also drops the ids that pointed at it', async t => {
    let attempt = 0;
    const { send, calls } = await setup(t, (_call, res) => {
      attempt += 1;
      if (attempt === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end('{"error":{"message":"The encrypted content for item rs_a could not be verified.","type":"invalid_request_error"}}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"completed"}');
    });
    const response = await send({
      model: 'gpt-6.1-sol-ar',
      include: ['reasoning.encrypted_content'],
      input: [
        { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
        { type: 'reasoning', id: 'rs_a', encrypted_content: 'gAAAA-blob', summary: [] },
        { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'shell', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'ok' },
      ],
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    const retried = JSON.parse(calls[1].body);
    // No reasoning item left, so no id may survive: an id here would name a
    // reasoning item this resource cannot read.
    assert.equal(retried.input.some(item => item.type === 'reasoning'), false);
    assert.equal(retried.input.some(item => 'id' in item), false);
    assert.deepEqual(retried.input.find(item => item.type === 'function_call').call_id, 'call_a');
  });

  test('a function call whose reasoning item vanished is repaired in one retry', async t => {
    let attempt = 0;
    const { send, calls } = await setup(t, (_call, res) => {
      attempt += 1;
      if (attempt === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: "Item 'fc_a' of type 'function_call' was provided without its required 'reasoning' item: 'rs_a'.", type: 'invalid_request_error' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"completed"}');
    });
    const response = await send({
      model: 'gpt-6.1-sol-ar',
      include: ['reasoning.encrypted_content'],
      input: [
        { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
        { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'shell', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'ok' },
      ],
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1].body).input.some(item => 'id' in item), false);
  });

  test('a 413 is answered by resending a replay with the old screenshots dropped', async t => {
    const events = [];
    let first = true;
    const { send, calls } = await setup(t, (_call, res) => {
      if (first) {
        first = false;
        res.writeHead(413, { 'Content-Type': 'text/html' });
        return res.end('<html><head><title>413 Request Entity Too Large</title></head><body><center><h1>413 Request Entity Too Large</h1></center><hr><center>nginx</center></body></html>');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"completed"}');
    }, { log: event => events.push(event) });
    const png = `data:image/png;base64,${'A'.repeat(200000)}`;
    const shot = index => ({ type: 'custom_tool_call_output', call_id: `call_${index}`, output: [{ type: 'input_text', text: `shot ${index}` }, { type: 'input_image', image_url: png }] });
    const response = await send({ model: 'gpt-6.1-sol-ar', input: [shot(1), shot(2), shot(3)] });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"status":"completed"}');
    assert.equal(calls.length, 2);
    assert.ok(Buffer.byteLength(calls[1].body) < Buffer.byteLength(calls[0].body));
    assert.equal(calls[1].headers.authorization, 'Bearer ar-secret');
    assert.equal((JSON.stringify(JSON.parse(calls[1].body)).match(/data:image\/png/g) ?? []).length, 2);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(events[0].status, 200);
    assert.equal(events[0].sanitized, true);
    assert.ok(events[0].shrunk >= 1);
    assert.ok(events[0].bytes > 0);
  });

  test('a replay already over the edge limit is shrunk before the first upload', async t => {
    const { send, calls } = await setup(t, null, { upstreamBodyLimitBytes: 4096 });
    const png = `data:image/png;base64,${'A'.repeat(2048)}`;
    const shot = index => ({ type: 'custom_tool_call_output', call_id: `call_${index}`, output: [{ type: 'input_text', text: `shot ${index}` }, { type: 'input_image', image_url: png }] });
    const response = await send({ model: 'gpt-6.1-sol-ar', input: [shot(1), shot(2), shot(3)] });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls.length, 1);
    assert.ok(Buffer.byteLength(calls[0].body) < 4096);
    assert.equal((calls[0].body.match(/data:image\/png/g) ?? []).length, 1);
  });

  test('a 413 the router cannot shrink further is forwarded unchanged', async t => {
    const { send, calls } = await setup(t, (_call, res) => {
      res.writeHead(413, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>413 Request Entity Too Large</title></head><body><center><h1>413 Request Entity Too Large</h1></center></body></html>');
    });
    const response = await send({ model: 'gpt-6.1-sol-ar', input: 'Synthetic' });
    assert.equal(response.status, 413);
    assert.match(await response.text(), /413 Request Entity Too Large/);
    assert.equal(calls.length, 1);
  });

  test('only the newest screenshots survive shrinking', () => {
    const payload = {
      input: [
        { type: 'message', content: [{ type: 'input_image', image_url: 'oldest' }] },
        { type: 'message', content: [{ type: 'input_image', image_url: 'newest' }] },
      ],
    };
    assert.equal(dropOlderImages(payload, 1), true);
    assert.equal(JSON.stringify(payload).includes('"image_url":"oldest"'), false);
    assert.equal(JSON.stringify(payload).includes('"image_url":"newest"'), true);
    assert.equal(dropOlderImages(payload, 5), false);
  });

  // The same screenshot arrives as an object on the Responses API, and a thread of
  // those could not be shrunk at all while only the string shape was matched.
  test('screenshots held in the object shape are dropped too', () => {
    const payload = {
      input: [
        { type: 'message', content: [{ type: 'input_image', image_url: { url: 'data:image/png;base64,oldest' } }] },
        { type: 'message', content: [{ type: 'input_image', image_url: { url: 'data:image/png;base64,middle' } }] },
        { type: 'message', content: [{ type: 'input_image', image_url: { url: 'data:image/png;base64,newest' } }] },
      ],
    };
    assert.equal(dropOlderImages(payload, 1), true);
    const kept = JSON.stringify(payload);
    assert.equal(kept.includes('base64,oldest'), false);
    assert.equal(kept.includes('base64,middle'), false);
    assert.equal(kept.includes('base64,newest'), true);
    // The dropped ones stay readable as a note instead of vanishing as an empty part.
    assert.match(payload.input[0].content[0].text, /image omitted/);
  });

  // A screenshot that would otherwise be dropped is re-encoded smaller first: the
  // model can still read a half-size screen, which beats no screen at all.
  test('screenshots are re-encoded smaller before any of them is dropped', async () => {
    const { encodePng } = await import('./image-shrink.mjs');
    const width = 320;
    const height = 240;
    const data = Buffer.alloc(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = (index * 7) & 0xff;
      data[index + 1] = (index * 13) & 0xff;
      data[index + 2] = (index * 29) & 0xff;
      data[index + 3] = 255;
    }
    const url = `data:image/png;base64,${encodePng({ width, height, data, opaque: true }).toString('base64')}`;
    const payload = {
      input: [
        { type: 'message', content: [{ type: 'input_image', image_url: { url } }] },
        { type: 'message', content: [{ type: 'input_image', image_url: url }] },
      ],
    };
    const before = Buffer.byteLength(JSON.stringify(payload));
    assert.equal(compressImages(payload, 2), 2, 'both shapes are rewritten');
    const after = Buffer.byteLength(JSON.stringify(payload));
    assert.ok(after < before, `the replay got smaller: ${before} -> ${after}`);
    // The parts stay image parts: nothing was dropped, only re-encoded.
    assert.equal(payload.input[0].content[0].type, 'input_image');
    assert.ok(payload.input[0].content[0].image_url.url.length < url.length);
    assert.equal(payload.input[1].content[0].type, 'input_image');
    assert.ok(payload.input[1].content[0].image_url.length < url.length);
  });

  test('old tool output is truncated while the recent turn is preserved', () => {
    const payload = {
      input: [
        { type: 'function_call_output', call_id: 'old', output: 'o'.repeat(9000) },
        { type: 'function_call_output', call_id: 'new', output: 'n'.repeat(9000) },
      ],
    };
    assert.equal(truncateToolOutputs(payload, 100, 1), true);
    assert.match(payload.input[0].output, /^o{100}\n\[truncated/);
    assert.equal(payload.input[1].output, 'n'.repeat(9000));
  });

  test('transport errors worth a retry are told apart from real upstream answers', () => {
    assert.equal(retryableTransportError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), true);
    assert.equal(retryableTransportError(new Error('F0600000:error:0A000119:SSL routines:tls_get_more_records:decryption failed or bad record mac')), true);
    assert.equal(retryableTransportError(Object.assign(new Error('getaddrinfo ENOTFOUND opencode.ai'), { code: 'ENOTFOUND' })), false);
    assert.equal(retryableTransportError(new Error('proxy CONNECT 502')), false);
  });
}


test('a stream head is classified before it is forwarded', () => {
  const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n';
  const inProgress = 'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_1"}}\n\n';
  const itemAdded = 'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0}\n\n';
  const partAdded = 'event: response.content_part.added\ndata: {"type":"response.content_part.added","content_index":0}\n\n';
  assert.equal(classifyStreamHead('').decision, 'wait');
  assert.equal(classifyStreamHead(created).decision, 'wait');
  assert.equal(classifyStreamHead(created + inProgress).decision, 'wait');
  // A real refusal follows exactly this preamble, so it must still be retryable.
  assert.equal(classifyStreamHead(created + inProgress + itemAdded + partAdded).decision, 'wait');
  assert.equal(classifyStreamHead(`${created}event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n`).decision, 'content');
  const verdict = classifyStreamHead(`${created}event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"Your requests exceeded  token rate limit."}}}\n\n`);
  assert.equal(verdict.decision, 'failure');
  assert.equal(verdict.code, 'rate_limit_exceeded');
  assert.equal(isRetryableStreamFailure(verdict), true);
  assert.equal(isRetryableStreamFailure({ code: 'invalid_prompt', message: 'The prompt was blocked.' }), false);
  const late = classifyStreamHead(`${created}${inProgress}${itemAdded}${partAdded}event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"exceeded token rate limit"}}}\n\n`);
  assert.equal(late.decision, 'failure');
});

test('a rate limit inside the stream is retried on another account', async t => {
  const accounts = [
    { id: 'first', label: 'First', token: 'first-token', enabled: true },
    { id: 'second', label: 'Second', token: 'second-token', enabled: true },
  ];
  const { calls, send } = await setup(t, (call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (call.headers.authorization === 'Bearer first-token') {
      res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
      res.write('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"exceeded token rate limit"}}}\n\n');
      return res.end();
    }
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_2"}}\n\n');
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n');
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","status":"completed"}}\n\n');
    res.end();
  }, { getAgentrouterAccounts: () => accounts });
  const response = await send({
    model: 'gpt-6.1-sol-ar',
    prompt_cache_key: 'thread-rate-limited',
    input: [
      { type: 'reasoning', id: 'rs_from_first_resource', summary: [], encrypted_content: 'blob' },
      { type: 'message', id: 'msg_from_first_resource', role: 'user', content: [{ type: 'input_text', text: 'carry on' }] },
    ],
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /response\.completed/);
  assert.doesNotMatch(body, /rate_limit_exceeded/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.authorization, 'Bearer first-token');
  assert.equal(calls[1].headers.authorization, 'Bearer second-token');
  // The second resource cannot read the first one's reasoning item, so the
  // retried replay drops it before the upload instead of earning a 400.
  const replay = JSON.parse(calls[1].body);
  assert.equal(replay.input.length, 1);
  assert.equal(replay.input[0].role, 'user');
  assert.equal(replay.input[0].id, undefined);
  assert.equal(JSON.stringify(replay).includes('rs_from_first_resource'), false);
  assert.equal(JSON.stringify(replay).includes('msg_from_first_resource'), false);
});

test('a rate limit that no account can absorb becomes a retryable 429', async t => {
  const accounts = [
    { id: 'first', label: 'First', token: 'first-token', enabled: true },
    { id: 'second', label: 'Second', token: 'second-token', enabled: true },
  ];
  const { calls, send } = await setup(t, (call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
    res.write('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"exceeded token rate limit"}}}\n\n');
    res.end();
  }, { getAgentrouterAccounts: () => accounts, throttleWindowMs: 60000, throttleWaitMs: 10 });
  const response = await send({ model: 'gpt-6.1-sol-ar', input: [], prompt_cache_key: 'thread-every-account-limited' });
  // Waiting cannot help within the turn's budget, so the turn is refused as an
  // ordinary HTTP error: Codex backs off and retries instead of reporting a dead
  // stream, and Retry-After tells it when the wait is worth another attempt.
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '30');
  const body = await response.text();
  assert.match(body, /rate limiting/);
  assert.equal(body.includes('response.failed'), false);
  assert.equal(calls.length, 2);
});

test('a cooldown shorter than the turn budget is waited out instead of failing', async t => {
  const accounts = [
    { id: 'first', label: 'First', token: 'first-token', enabled: true },
    { id: 'second', label: 'Second', token: 'second-token', enabled: true },
  ];
  const seen = new Map();
  const { calls, send } = await setup(t, (call, res) => {
    const token = call.headers.authorization;
    const attempts = (seen.get(token) ?? 0) + 1;
    seen.set(token, attempts);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
    if (attempts === 1) {
      res.write('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"exceeded token rate limit"}}}\n\n');
      return res.end();
    }
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"recovered"}\n\n');
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","status":"completed"}}\n\n');
    res.end();
  }, { getAgentrouterAccounts: () => accounts, throttleWindowMs: 150, throttleWaitMs: 5000 });
  const started = Date.now();
  const response = await send({ model: 'gpt-6.1-sol-ar', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go on' }] }], prompt_cache_key: 'thread-waits-out-cooldown' });
  // Both resources hit the limit, but only for a moment: the router sleeps until
  // one reopens and delivers the turn, so no 429 ever reaches the client.
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /recovered/);
  assert.match(body, /response\.completed/);
  assert.doesNotMatch(body, /rate_limit_exceeded/);
  assert.equal(calls.length, 3);
  assert.ok(Date.now() - started >= 500, 'the cooldown really was waited out');
});

test('a permanent rate limit stops after a bounded number of attempts', async t => {
  const accounts = [
    { id: 'first', label: 'First', token: 'first-token', enabled: true },
    { id: 'second', label: 'Second', token: 'second-token', enabled: true },
  ];
  // A cooldown this short always looks over by the time the pause between
  // attempts ends, so the pool keeps offering an account and rotation alone
  // would never stop. The upload count has to end it.
  const { calls, send } = await setup(t, (call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
    res.write('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"exceeded token rate limit"}}}\n\n');
    res.end();
  }, { getAgentrouterAccounts: () => accounts, throttleWindowMs: 200, throttlePauseMs: 20, throttleWaitMs: 20000 });
  const started = Date.now();
  const response = await send({ model: 'gpt-6.1-sol-ar', input: [], prompt_cache_key: 'thread-permanent-rate-limit' });
  assert.equal(response.status, 429);
  assert.ok(Date.now() - started < 5000, 'the turn ends instead of rotating forever');
  assert.ok(calls.length <= 7, `only a handful of uploads were spent, saw ${calls.length}`);
  const body = await response.text();
  assert.match(body, /tried \d+ times/);
  assert.equal(body.includes('response.failed'), false);
});

test('a plain 429 from the upstream is retried on another account', async t => {
  const accounts = [
    { id: 'first', label: 'First', token: 'first-token', enabled: true },
    { id: 'second', label: 'Second', token: 'second-token', enabled: true },
  ];
  const { calls, send } = await setup(t, (call, res) => {
    if (call.headers.authorization === 'Bearer first-token') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'rate limit reached', code: 'rate_limit_exceeded' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_2"}}\n\n');
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n');
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","status":"completed"}}\n\n');
    res.end();
  }, { getAgentrouterAccounts: () => accounts });
  const response = await send({ model: 'gpt-6.1-sol-ar', input: [], prompt_cache_key: 'thread-http-429' });
  // The 429 belonged to one resource, not to the turn, so it must not surface as
  // the client's "exceeded retry limit, last status: 429".
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /response\.completed/);
  assert.equal(body.includes('rate limit reached'), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.authorization, 'Bearer second-token');
});

test('a rotation drops handles but never rewrites the history it replays', async t => {
  const events = [];
  const accounts = [
    { id: 'first', label: 'First', token: 'first-token', enabled: true },
    { id: 'second', label: 'Second', token: 'second-token', enabled: true },
  ];
  const { calls, send } = await setup(t, (call, res) => {
    if (call.headers.authorization === 'Bearer first-token') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'rate limit reached', code: 'rate_limit_exceeded' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_2"}}\n\n');
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n');
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","status":"completed"}}\n\n');
    res.end();
  }, { getAgentrouterAccounts: () => accounts, log: event => events.push(event) });
  const png = `data:image/png;base64,${'A'.repeat(2048)}`;
  const dump = 'd'.repeat(9000);
  const response = await send({
    model: 'gpt-6.1-sol-ar',
    prompt_cache_key: 'thread-rotation-keeps-history',
    include: ['reasoning.encrypted_content'],
    input: [
      { type: 'reasoning', id: 'rs_home', encrypted_content: 'gAAAA-home', summary: [] },
      { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'read the page' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: dump },
      { type: 'custom_tool_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'shot' }, { type: 'input_image', image_url: png }, { type: 'input_image', image_url: png }] },
    ],
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.authorization, 'Bearer second-token');
  const replay = JSON.parse(calls[1].body);
  // Handles the new resource cannot resolve are gone.
  assert.equal(JSON.stringify(replay).includes('gAAAA'), false);
  assert.equal(replay.input.some(item => item && typeof item === 'object' && 'id' in item), false);
  assert.equal(replay.include, undefined);
  // The history itself is untouched: a rate limit says nothing about the old tool
  // output or the screenshots, and trimming either would move the prompt prefix
  // the upstream had already cached for this thread.
  const output = replay.input.find(item => item.type === 'function_call_output');
  assert.equal(output.output, dump, 'old tool output is not truncated by a rotation');
  assert.equal((JSON.stringify(replay).match(/data:image\/png/g) ?? []).length, 2, 'screenshots survive a rotation');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(events[0].status, 200);
  assert.equal(events[0].sanitized, true);
  assert.equal(events[0].shrunk, 1, 'a rotation only needs the stripping level');
});

test('the log records how much of a replay the thread already sent', async t => {
  const events = [];
  const accounts = [{ id: 'first', label: 'First', token: 'first-token', enabled: true }];
  const { calls, send } = await setup(t, (_call, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"completed"}');
  }, { getAgentrouterAccounts: () => accounts, log: event => events.push(event) });
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  const first = {
    model: 'gpt-6.1-sol-ar',
    prompt_cache_key: 'thread-reuse',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first turn' }] }],
  };
  await (await send(first)).text();
  await settle();
  assert.equal(events[0].reuse, undefined, 'a first turn has nothing to compare against');
  const grown = {
    ...first,
    input: [
      ...first.input,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next turn' }] },
    ],
  };
  await (await send(grown)).text();
  await settle();
  const [before, after] = [calls[0].body, calls[1].body];
  const reuse = events[1].reuse;
  assert.ok(reuse > 0, 'a grown thread shares its opening bytes');
  assert.equal(after.slice(0, reuse), before.slice(0, reuse), 'the recorded count is the matching head');
  assert.notEqual(after[reuse], before[reuse], 'and it stops at the first byte that differs');
  // Rewriting the opening turn moves the prefix, and the log says how far.
  const rewritten = { ...first, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a different first turn' }] }] };
  await (await send(rewritten)).text();
  await settle();
  assert.ok(events[2].reuse < reuse, 'a rewritten prefix scores lower than an extended one');
});

test('a content refusal inside the stream is forwarded unchanged', async t => {
  const accounts = [
    { id: 'first', label: 'First', token: 'first-token', enabled: true },
    { id: 'second', label: 'Second', token: 'second-token', enabled: true },
  ];
  const { calls, send } = await setup(t, (call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
    res.write('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"invalid_prompt","message":"The prompt was blocked."}}}\n\n');
    res.end();
  }, { getAgentrouterAccounts: () => accounts });
  const response = await send({ model: 'gpt-6.1-sol-ar', input: [], prompt_cache_key: 'thread-blocked' });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /invalid_prompt/);
  assert.equal(calls.length, 1);
});

test('stripping server-side references also drops a nested encrypted blob', () => {
  const payload = {
    input: [
      {
        type: 'agent_message',
        id: 'msg_foreign',
        author: 'worker',
        content: [
          { type: 'input_text', text: 'keep this' },
          { type: 'encrypted_content', encrypted_content: 'gAAAAABforeign' },
        ],
      },
      {
        type: 'agent_message',
        content: [{ type: 'encrypted_content', encrypted_content: 'gAAAAABonlyblob' }],
      },
    ],
  };
  assert.equal(stripServerSideRefs(payload), true);
  // The readable part survives; the blob part and the item that held nothing else
  // go away, because only the minting resource could ever decrypt them.
  assert.equal(payload.input.length, 1);
  assert.deepEqual(payload.input[0].content, [{ type: 'input_text', text: 'keep this' }]);
  assert.equal(payload.input[0].id, undefined);
  assert.equal(JSON.stringify(payload).includes('gAAAA'), false);
  // A payload with nothing to strip is reported as unchanged.
  assert.equal(stripServerSideRefs({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }), false);
});

test('a foreign blob inside the stream is rebuilt instead of failing the turn', async t => {
  const accounts = [
    { id: 'first', label: 'First', token: 'first-token', enabled: true },
    { id: 'second', label: 'Second', token: 'second-token', enabled: true },
  ];
  const { calls, send } = await setup(t, (call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
    if (calls.length === 1) {
      res.write('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"invalid_encrypted_content","message":"Encrypted function output content could not be decrypted or decoded."}}}\n\n');
      return res.end();
    }
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n');
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","status":"completed"}}\n\n');
    res.end();
  }, { getAgentrouterAccounts: () => accounts });
  const response = await send({
    model: 'gpt-6.1-sol-ar',
    prompt_cache_key: 'thread-foreign-blob-in-stream',
    input: [
      { type: 'reasoning', id: 'rs_foreign', summary: [], encrypted_content: 'gAAAAABreasoning' },
      { type: 'message', id: 'msg_foreign', role: 'user', content: [{ type: 'input_text', text: 'carry on' }] },
      {
        type: 'agent_message',
        id: 'msg_agent',
        author: 'worker',
        content: [
          { type: 'input_text', text: 'report from the worker' },
          { type: 'encrypted_content', encrypted_content: 'gAAAAABnested' },
        ],
      },
    ],
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /response\.completed/);
  assert.equal(body.includes('invalid_encrypted_content'), false);
  assert.equal(calls.length, 2);
  // A blob is not an account problem, so the turn stays on the same resource and
  // is simply made self-contained.
  assert.equal(calls[1].headers.authorization, 'Bearer first-token');
  const replay = JSON.parse(calls[1].body);
  assert.equal(JSON.stringify(replay).includes('gAAAA'), false);
  assert.equal(replay.input.length, 2);
  assert.equal(replay.input[1].content[0].text, 'report from the worker');
  // The level survives a worker restart, so the next turn does not pay for the
  // same rejected upload again, and it is the stripping level rather than the
  // last resort: nothing but the handles had to go.
  const hints = JSON.parse(readFileSync(hintsPath, 'utf8'));
  const hint = Object.values(hints).find(entry => entry && entry.level === 1);
  assert.ok(hint, 'the repaired level is persisted');
  assert.ok(Date.now() - hint.at < 60000, 'and stamped with the time it was learned');
});

test('reasoning deltas are held so a later rate limit can still rotate', async t => {
  const accounts = [
    { id: 'first', label: 'First', token: 'first-token', enabled: true },
    { id: 'second', label: 'Second', token: 'second-token', enabled: true },
  ];
  const { calls, send } = await setup(t, (call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
    if (call.headers.authorization === 'Bearer first-token') {
      res.write('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}\n\n');
      res.write('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"exceeded token rate limit"}}}\n\n');
      return res.end();
    }
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n');
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","status":"completed"}}\n\n');
    res.end();
  }, { getAgentrouterAccounts: () => accounts });
  const response = await send({ model: 'gpt-6.1-sol-ar', input: [], prompt_cache_key: 'thread-limit-after-thinking' });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /response\.completed/);
  assert.equal(body.includes('rate_limit_exceeded'), false);
  // The reasoning the client never saw must not leak into the answer either.
  assert.equal(body.includes('thinking'), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.authorization, 'Bearer second-token');
});

test('held reasoning reaches the client in order once content starts', async t => {
  const accounts = [{ id: 'first', label: 'First', token: 'first-token', enabled: true }];
  const { send } = await setup(t, (call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
    res.write('event: response.reasoning_summary_part.added\ndata: {"type":"response.reasoning_summary_part.added"}\n\n');
    res.write('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"plan"}\n\n');
    res.write('event: response.reasoning_summary_text.done\ndata: {"type":"response.reasoning_summary_text.done","text":"plan"}\n\n');
    res.write('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1"}}\n\n');
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"answer"}\n\n');
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n');
    res.end();
  }, { getAgentrouterAccounts: () => accounts });
  const response = await send({ model: 'gpt-6.1-sol-ar', input: [], prompt_cache_key: 'thread-thinking-released' });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /response\.completed/);
  assert.ok(body.indexOf('"delta":"plan"') > -1, 'the held reasoning delta is delivered');
  assert.ok(body.indexOf('"delta":"plan"') < body.indexOf('"delta":"answer"'), 'reasoning stays before the answer');
  assert.match(body, /response\.reasoning_summary_text\.done/);
  assert.match(body, /response\.output_item\.done/);
});

test('a rate limit after content cannot be replayed and is forwarded', async t => {
  const accounts = [
    { id: 'first', label: 'First', token: 'first-token', enabled: true },
    { id: 'second', label: 'Second', token: 'second-token', enabled: true },
  ];
  const { calls, send } = await setup(t, (call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    res.write('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"exceeded token rate limit"}}}\n\n');
    res.end();
  }, { getAgentrouterAccounts: () => accounts });
  const response = await send({ model: 'gpt-6.1-sol-ar', input: [], prompt_cache_key: 'thread-limit-after-text' });
  assert.equal(response.status, 200);
  const body = await response.text();
  // The partial answer cannot be un-sent, so the refusal is passed through and the
  // account is remembered as throttled for the next turn.
  assert.match(body, /rate_limit_exceeded/);
  assert.match(body, /partial/);
  assert.equal(calls.length, 1);
});

test('a client that hangs up after the terminal event is not a broken stream', async t => {
  const events = [];
  const accounts = [{ id: 'first', label: 'First', token: 'first-token', enabled: true }];
  const { send } = await setup(t, (_call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n');
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1200,"output_tokens":7,"total_tokens":1207}}}\n\n');
    // The edge withholds the chunk terminator for a moment, so the client that
    // already read response.completed hangs up first, exactly as Codex does.
    setTimeout(() => { try { res.end(); } catch { /* the socket may be gone */ } }, 300);
  }, { getAgentrouterAccounts: () => accounts, log: event => events.push(event) });
  const response = await send({ model: 'gpt-6.1-sol-ar', input: [], prompt_cache_key: 'thread-client-hangup' });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes('response.completed')) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  await new Promise(resolve => setTimeout(resolve, 400));
  const record = events.at(-1);
  assert.equal(record.status, 200);
  assert.notEqual(record.aborted, true);
  assert.equal(record.usage.inputTokens, 1200);
  assert.equal(record.usage.outputTokens, 7);
});

test('the repairable and retryable stream failures are told apart', () => {
  const blob = { code: 'invalid_encrypted_content', message: 'Encrypted function output content could not be decrypted or decoded.' };
  const limit = { code: 'rate_limit_exceeded', message: 'exceeded token rate limit' };
  assert.equal(isRepairableStreamFailure(blob), true);
  assert.equal(isRetryableStreamFailure(blob), false);
  assert.equal(isRetryableStreamFailure(limit), true);
  assert.equal(isRepairableStreamFailure(limit), false);
  assert.equal(isRepairableStreamFailure({ code: 'invalid_prompt', message: 'blocked' }), false);
  assert.equal(isForeignItemError('Encrypted function output content could not be decrypted or decoded.'), true);
});
