import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const testRoot = mkdtempSync(join(tmpdir(), 'gateway-pool-tests-'));
process.env.CODEX_MODEL_GATEWAY_HINTS = join(testRoot, 'level-hints.json');
const { createRouter } = await import('./router.mjs');

// These credentials are intentionally synthetic. Every configured upstream in
// this file is an HTTP server bound to a random loopback port.
const clientToken = 'synthetic-client-token-for-pool-tests';
const alphaToken = 'synthetic-agentrouter-token-alpha';
const betaToken = 'synthetic-agentrouter-token-beta';
const legacyToken = 'synthetic-legacy-agentrouter-token';
const accounts = [
  { id: 'alpha', label: 'Test account Alpha', token: alphaToken, enabled: true },
  { id: 'beta', label: 'Test account Beta', token: betaToken, enabled: true },
];
const models = {
  'gpt-5.6-sol-ar': 'gpt-5.6-sol',
  'gpt-6-astra-ar': 'gpt-6-astra',
  'gpt-6.1-sol-ar': 'gpt-6.1-sol',
};
const bearer = token => `Bearer ${token}`;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function jsonResponse(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function responseBody(id, output = []) {
  return { id, object: 'response', status: 'completed', output };
}

async function setup(t, { accountRows = accounts, handler, routerOptions = {} } = {}) {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      const call = {
        path: req.url,
        headers: { ...req.headers },
        rawBody,
        data: JSON.parse(rawBody.toString('utf8')),
      };
      calls.push(call);
      if (handler) return await handler(call, res, calls.length);
      jsonResponse(res, 200, responseBody(`resp_mock_${calls.length}`));
    } catch (error) {
      if (!res.headersSent) jsonResponse(res, 500, { error: { message: `Local mock failed: ${error.message}` } });
      else res.destroy(error);
    }
  });
  const upstreamUrl = await listen(upstream);
  const router = createRouter({
    defaultBaseUrl: `${upstreamUrl}/original/v1`,
    opencodeBaseUrl: `${upstreamUrl}/opencode/v1`,
    agentrouterBaseUrl: `${upstreamUrl}/agentrouter/v1`,
    agentrouterModels: models,
    getClientToken: () => clientToken,
    getOpencodeToken: () => 'synthetic-opencode-token',
    getAgentrouterToken: () => '',
    getAgentrouterAccounts: () => accountRows.map(row => ({ ...row })),
    catalog: { models: Object.keys(models).map(slug => ({ slug })) },
    diagnosticsDirectory: mkdtempSync(join(testRoot, 'diagnostics-')),
    ...routerOptions,
  });
  const url = await listen(router);
  t.after(() => {
    router.closeAllConnections();
    router.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const send = (payload, headers = {}) => fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: bearer(clientToken), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  const get = (path, headers = {}) => fetch(`${url}${path}`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  return { calls, send, get, url };
}

async function completed(send, payload) {
  const response = await send(payload);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

function request(session, extra = {}) {
  return { model: 'gpt-6-astra-ar', prompt_cache_key: session, input: 'Synthetic test input', ...extra };
}

function sseFrame(event, data, ending = '\r\n') {
  return Buffer.from(`event: ${event}${ending}data: ${JSON.stringify(data)}${ending}${ending}`);
}

test('independent prompt_cache_key sessions rotate across enabled accounts', async t => {
  const { send, calls } = await setup(t);
  for (const id of ['independent-one', 'independent-two', 'independent-three', 'independent-four']) {
    await completed(send, request(id));
  }
  assert.deepEqual(calls.map(call => call.headers.authorization), [
    bearer(alphaToken), bearer(betaToken), bearer(alphaToken), bearer(betaToken),
  ]);
});

test('one session remains on the same account across all -ar models', async t => {
  const { send, calls } = await setup(t);
  for (const model of Object.keys(models)) await completed(send, request('one-thread', { model }));
  assert.equal(new Set(calls.map(call => call.headers.authorization)).size, 1);
  assert.deepEqual(calls.map(call => call.data.model), Object.values(models));
  assert.ok(calls.every(call => call.path === '/agentrouter/v1/responses'));
  assert.ok(calls.every(call => call.data.prompt_cache_key === 'one-thread'));
  await completed(send, request('a-second-thread'));
  assert.notEqual(calls.at(-1).headers.authorization, calls[0].headers.authorization);
});

test('concurrent requests for a new session allocate its account only once', async t => {
  const { send, calls } = await setup(t, {
    handler: async (_call, res, number) => {
      await pause(20);
      jsonResponse(res, 200, responseBody(`resp_concurrent_${number}`));
    },
  });
  await Promise.all(Array.from({ length: 12 }, (_, index) => completed(
    send, request('concurrent-session', { model: Object.keys(models)[index % 3] }),
  )));
  assert.equal(calls.length, 12);
  assert.equal(new Set(calls.map(call => call.headers.authorization)).size, 1);
  await completed(send, request('after-the-concurrent-session'));
  assert.notEqual(calls.at(-1).headers.authorization, calls[0].headers.authorization);
});

test('a JSON response id takes precedence over a conflicting prompt_cache_key', async t => {
  const { send, calls } = await setup(t);
  const first = await completed(send, request('json-owner'));
  await completed(send, request('json-other-owner'));
  assert.notEqual(calls[0].headers.authorization, calls[1].headers.authorization);
  await completed(send, request('json-other-owner', {
    model: 'gpt-6.1-sol-ar', previous_response_id: first.id,
  }));
  assert.equal(calls[2].headers.authorization, calls[0].headers.authorization);
  assert.equal(calls[2].data.previous_response_id, first.id);
  assert.equal(calls[2].data.prompt_cache_key, 'json-other-owner');
});

test('SSE response.created ids are remembered even when an event spans chunks', async t => {
  const created = sseFrame('response.created', {
    type: 'response.created', response: { id: 'resp_chunked_created', object: 'response' },
  });
  const delta = sseFrame('response.output_text.delta', { type: 'response.output_text.delta', delta: '你好，分块响应' });
  const tail = sseFrame('response.completed', { type: 'response.completed', response: responseBody('resp_chunked_created') });
  const streamBytes = Buffer.concat([created, delta, tail, Buffer.from('data: [DONE]\r\n\r\n')]);
  const { send, calls } = await setup(t, {
    handler: async (call, res, number) => {
      if (!call.data.stream) return jsonResponse(res, 200, responseBody(`resp_sse_json_${number}`));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const cuts = [7, 52, 101, created.length + 13, streamBytes.length - 17, streamBytes.length];
      let offset = 0;
      for (const cut of cuts) {
        res.write(streamBytes.subarray(offset, cut));
        offset = cut;
        await pause(3);
      }
      res.end();
    },
  });
  const response = await send(request('sse-owner', { stream: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), streamBytes);
  await completed(send, request('sse-conflicting-owner'));
  assert.notEqual(calls[1].headers.authorization, calls[0].headers.authorization);
  await completed(send, request('sse-conflicting-owner', {
    previous_response_id: 'resp_chunked_created', model: 'gpt-5.6-sol-ar',
  }));
  assert.equal(calls[2].headers.authorization, calls[0].headers.authorization);
});

test('unknown previous_response_id fails with 409 before contacting a multi-account upstream', async t => {
  const { send, calls } = await setup(t);
  await completed(send, request('known-prompt-key'));
  for (const payload of [
    request('known-prompt-key', { previous_response_id: 'resp_unknown_local_chain' }),
    { model: 'gpt-6.1-sol-ar', previous_response_id: 'resp_unknown_other_chain', input: 'Synthetic' },
  ]) {
    const response = await send(payload);
    assert.equal(response.status, 409, await response.text());
    assert.equal(calls.length, 1);
  }
});

test('empty or unavailable pool credentials fail locally without a legacy fallback', async t => {
  const { send, calls } = await setup(t, {
    accountRows: [
      { id: 'empty', label: 'Empty token account', token: '   ', enabled: true },
      { id: 'disabled', label: 'Disabled account', token: betaToken, enabled: false },
    ],
    routerOptions: { getAgentrouterToken: () => legacyToken },
  });
  const response = await send(request('empty-pool'));
  assert.equal(response.status, 503, await response.text());
  assert.equal(calls.length, 0);
});

test('disabled and empty accounts are skipped when a valid pool account exists', async t => {
  const { send, calls } = await setup(t, {
    accountRows: [
      { id: 'disabled-alpha', label: 'Disabled alpha', token: alphaToken, enabled: false },
      { id: 'empty', label: 'Empty', token: '', enabled: true },
      accounts[1],
    ],
  });
  await completed(send, request('valid-only-one'));
  await completed(send, request('valid-only-two'));
  assert.deepEqual(calls.map(call => call.headers.authorization), [bearer(betaToken), bearer(betaToken)]);
});

test('disabling a cached account rebinds the next self-contained request without restarting the router', async t => {
  const rows = [{ ...accounts[0] }, { ...accounts[1] }];
  const { send, calls } = await setup(t, { accountRows: rows });
  await completed(send, request('rebind-disabled-session'));
  rows[0].enabled = false;
  await completed(send, request('rebind-disabled-session', { model: 'gpt-6.1-sol-ar' }));
  await completed(send, request('rebind-disabled-session', { model: 'gpt-5.6-sol-ar' }));
  assert.deepEqual(calls.map(call => call.headers.authorization),
    [bearer(alphaToken), bearer(betaToken), bearer(betaToken)]);
});

test('removing a pinned account from the manifest rebinds the session as well', async t => {
  const rows = [{ ...accounts[0] }, { ...accounts[1] }];
  const { send, calls } = await setup(t, { accountRows: rows });
  await completed(send, request('rebind-removed-session'));
  rows.splice(0, 1);
  await completed(send, request('rebind-removed-session'));
  assert.deepEqual(calls.map(call => call.headers.authorization), [bearer(alphaToken), bearer(betaToken)]);
});

test('a response chain keeps its disabled owner after the self-contained session moves', async t => {
  const rows = [{ ...accounts[0] }, { ...accounts[1] }];
  const { send, calls } = await setup(t, { accountRows: rows });
  const first = await completed(send, request('rebind-chain', { model: 'gpt-6.1-sol-ar' }));
  assert.equal(calls[0].headers.authorization, bearer(alphaToken));
  rows[0].enabled = false;
  const stateful = request('rebind-chain', { model: 'gpt-6.1-sol-ar', previous_response_id: first.id });
  const blocked = await send(stateful);
  assert.equal(blocked.status, 503, await blocked.text());
  assert.equal(calls.length, 1, 'a disabled response owner must fail before forwarding');
  await completed(send, request('rebind-chain'));
  const stillBlocked = await send(stateful);
  assert.equal(stillBlocked.status, 503, await stillBlocked.text());
  assert.deepEqual(calls.map(call => call.headers.authorization), [bearer(alphaToken), bearer(betaToken)]);
});

test('service conversation references retain ownership across prompt keys and fail after disabling the owner', async t => {
  const rows = [{ ...accounts[0] }, { ...accounts[1] }];
  const { send, calls } = await setup(t, { accountRows: rows });
  await completed(send, request('service-original', { conversation: 'conv_local_service' }));
  await completed(send, request('service-other'));
  await completed(send, request('service-other', { conversation: { id: 'conv_local_service' }, model: 'gpt-6.1-sol-ar' }));
  assert.deepEqual(calls.map(call => call.headers.authorization), [bearer(alphaToken), bearer(betaToken), bearer(alphaToken)]);
  rows[0].enabled = false;
  for (const conversation of ['conv_local_service', { id: 'conv_local_service' }]) {
    const blocked = await send(request('service-changed', { conversation }));
    assert.equal(blocked.status, 503, await blocked.text());
  }
  assert.equal(calls.length, 3);
  await completed(send, request('service-original'));
  assert.equal(calls[3].headers.authorization, bearer(betaToken));
});

test('the legacy single-token getter still forwards existing response chains', async t => {
  const { send, calls } = await setup(t, {
    routerOptions: { getAgentrouterAccounts: undefined, getAgentrouterToken: () => legacyToken },
  });
  await completed(send, request('legacy-session', { previous_response_id: 'resp_created_before_router_start' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, bearer(legacyToken));
  assert.equal(calls[0].data.previous_response_id, 'resp_created_before_router_start');
});

for (const failure of [
  { name: '401 invalid account key', status: 401, type: 'invalid_api_key', message: 'Invalid API key' },
  { name: 'explicit user balance exhaustion', status: 403, type: 'insufficient_quota', message: '用户余额不足' },
]) {
  test(`${failure.name} is not replayed and the next self-contained request can rebind`, async t => {
    const failureBody = { error: { type: failure.type, message: failure.message } };
    const { send, calls } = await setup(t, {
      handler: (call, res, number) => {
        if (call.headers.authorization === bearer(alphaToken)) return jsonResponse(res, failure.status, failureBody);
        jsonResponse(res, 200, responseBody(`resp_healthy_${number}`));
      },
    });
    const failed = await send(request('failed-current-session'));
    assert.equal(failed.status, failure.status);
    assert.deepEqual(await failed.json(), failureBody);
    assert.equal(calls.length, 1, 'an upstream rejection must not replay on another account');
    for (let index = 0; index < 4; index++) await completed(send, request(`new-after-failure-${index}`));
    assert.ok(calls.slice(1).every(call => call.headers.authorization === bearer(betaToken)));
    await completed(send, request('failed-current-session', { model: 'gpt-6.1-sol-ar' }));
    assert.equal(calls.length, 6, 'a later client request can choose the healthy account');
    assert.equal(calls[5].headers.authorization, bearer(betaToken));
    await completed(send, request('failed-current-session', { model: 'gpt-5.6-sol-ar' }));
    assert.equal(calls[6].headers.authorization, bearer(betaToken));
  });
}

test('cooling an account does not migrate its service conversation on the next request', async t => {
  const failureBody = { error: { type: 'invalid_api_key', message: 'Invalid API key' } };
  const { send, calls } = await setup(t, {
    handler: (call, res, number) => {
      if (call.headers.authorization === bearer(alphaToken)) return jsonResponse(res, 401, failureBody);
      jsonResponse(res, 200, responseBody(`resp_available_${number}`));
    },
  });
  const failed = await send(request('stateful-failure', { conversation: { id: 'conv_failure' } }));
  assert.equal(failed.status, 401);
  assert.deepEqual(await failed.json(), failureBody);
  const blocked = await send(request('stateful-changed', { conversation: 'conv_failure' }));
  assert.equal(blocked.status, 503, await blocked.text());
  assert.equal(calls.length, 1, 'server history must neither replay nor move on a later request');
  await completed(send, request('stateful-failure'));
  assert.equal(calls[1].headers.authorization, bearer(betaToken));
});

test('site Budget pool failure is forwarded without rotating or cooling an account', async t => {
  const failureBody = { error: { type: 'server_error', message: 'Budget pool exhausted: upstream channels have insufficient quota.' } };
  const { send, calls } = await setup(t, {
    handler: (call, res, number) => {
      if (call.data.prompt_cache_key === 'transient-current') return jsonResponse(res, 500, failureBody, { 'Retry-After': '2' });
      jsonResponse(res, 200, responseBody(`resp_after_transient_${number}`));
    },
  });
  for (let index = 0; index < 2; index++) {
    const response = await send(request('transient-current'));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('retry-after'), '2');
    assert.deepEqual(await response.json(), failureBody);
    assert.equal(calls.length, index + 1, 'one client request must yield one upstream request');
  }
  assert.equal(calls[0].headers.authorization, calls[1].headers.authorization);
  await completed(send, request('after-transient-one'));
  await completed(send, request('after-transient-two'));
  assert.equal(calls[2].headers.authorization, bearer(betaToken));
  assert.equal(calls[3].headers.authorization, bearer(alphaToken), 'a site error must not remove this account from new-session rotation');
});

// An edge 502/504 answers before a model ever sees the turn. Resending it on the
// same account is free cache-wise, so the client should see a normal result.
test('an edge 502 is resent on the same account instead of reaching the client', async t => {
  const edgeBody = '<html><body><h1>502 Bad Gateway</h1></body></html>';
  const { send, calls } = await setup(t, {
    handler: (call, res, number) => {
      if (number === 1) {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        res.end(edgeBody);
        return;
      }
      jsonResponse(res, 200, responseBody(`resp_after_edge_${number}`));
    },
  });
  const response = await completed(send, request('edge-retry-one'));
  assert.equal(response.id, 'resp_after_edge_2');
  assert.equal(calls.length, 2, 'one client request yields one resend on the edge failure');
  assert.equal(calls[0].headers.authorization, calls[1].headers.authorization, 'the resend costs no cache and no rotation');
  assert.deepEqual(calls[0].rawBody, calls[1].rawBody, 'the resend replays the identical body');
});

test('a second edge 502 is forwarded to the client as it arrived', async t => {
  const edgeBody = '<html><body><h1>502 Bad Gateway</h1></body></html>';
  const { send, calls } = await setup(t, {
    handler: (call, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end(edgeBody);
    },
  });
  const response = await send(request('edge-retry-two'));
  assert.equal(response.status, 502);
  assert.equal(await response.text(), edgeBody);
  assert.equal(calls.length, 2, 'the resend is bounded: one retry, never a loop');
  assert.equal(calls[0].headers.authorization, calls[1].headers.authorization);
});

// An upstream 429 is a throttle, not an answer: the documented contract is to
// keep the turn inside the gateway (rotate, then wait out the cooling window)
// until either another account answers or the per-turn budget is spent.
test('an upstream 429 moves the turn to another account instead of reaching the client', async t => {
  const limited = { error: { type: 'rate_limit_error', message: 'Too many requests' } };
  const { send, calls } = await setup(t, {
    routerOptions: { throttleWaitMs: 4000, throttlePauseMs: 100, maxThrottleAttempts: 3 },
    handler: (call, res, number) => {
      if (call.headers.authorization === bearer(alphaToken)) return jsonResponse(res, 429, limited, { 'Retry-After': '2' });
      jsonResponse(res, 200, responseBody(`resp_after_throttle_${number}`));
    },
  });
  const response = await send(request('throttle-current'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('retry-after'), null, 'the client must never see the upstream 429');
  assert.deepEqual(await response.json(), responseBody('resp_after_throttle_2'));
  assert.deepEqual(calls.map(call => call.headers.authorization), [bearer(alphaToken), bearer(betaToken)]);
});

test('when every account is throttled the router waits out its budget and then answers 429 with retry-after', async t => {
  const limited = { error: { type: 'rate_limit_error', message: 'Too many requests' } };
  const { send, calls } = await setup(t, {
    routerOptions: { throttleWaitMs: 1200, throttlePauseMs: 100, maxThrottleAttempts: 3 },
    handler: (_call, res) => jsonResponse(res, 429, limited, { 'Retry-After': '2' }),
  });
  const response = await send(request('throttle-everywhere'));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '30');
  const body = await response.json();
  assert.equal(body.error.type, 'local_router_error');
  assert.match(body.error.message, /held this turn \d+s and tried \d+ times/);
  assert.ok(calls.length >= 2 && calls.length <= 5, `expected a bounded number of attempts, saw ${calls.length}`);
});

test('an error event after SSE starts is forwarded verbatim and never replays on another key', async t => {
  const bytes = Buffer.concat([
    sseFrame('response.created', { type: 'response.created', response: { id: 'resp_stream_failure' } }),
    sseFrame('response.failed', {
      type: 'response.failed',
      response: { id: 'resp_stream_failure', status: 'failed', error: { code: 'invalid_api_key', message: 'Invalid API key after stream began' } },
    }),
  ]);
  const { send, calls } = await setup(t, {
    handler: (_call, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(bytes);
    },
  });
  const response = await send(request('sse-failing-session', { stream: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(calls.length, 1);
});

test('a stream that dies before any content ends cleanly without reconnecting or switching accounts', async t => {
  const prefix = sseFrame('response.created', { type: 'response.created', response: { id: 'resp_disconnected' } });
  const { send, calls } = await setup(t, {
    handler: async (_call, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(prefix);
      await pause(50);
      res.destroy();
    },
  });
  // The router holds the preamble until the first payload arrives, so a stream
  // that dies inside the preamble is flushed as the answer head and then ends.
  // The turn must not be replayed on another account: the client already has a
  // 200 and a partial body.
  const response = await send(request('sse-disconnect-session', { stream: true }));
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const chunks = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(Buffer.from(chunk.value));
  }
  assert.deepEqual(Buffer.concat(chunks), prefix);
  assert.equal(calls.length, 1);
});

test('Responses function calls and function_call_output survive a multi-turn chain on one account', async t => {
  const functionCall = {
    type: 'function_call', id: 'fc_mock_1', call_id: 'call_mock_1', name: 'exec_command',
    arguments: JSON.stringify({ cmd: 'Get-Location', note: '中文与换行\n必须保留' }), status: 'completed',
  };
  const toolOutput = {
    type: 'function_call_output', call_id: 'call_mock_1',
    output: JSON.stringify({ exit_code: 0, output: 'C:\\Synthetic Workspace\n第一行\n第二行', details: [{ value: 'tool output' }] }),
  };
  const secondCall = { ...functionCall, id: 'fc_mock_2', call_id: 'call_mock_2', arguments: '{"cmd":"Write-Output test"}' };
  const { send, calls } = await setup(t, {
    handler: (call, res, number) => {
      if (call.data.prompt_cache_key === 'unrelated-tool-session') return jsonResponse(res, 200, responseBody(`resp_unrelated_${number}`));
      const id = call.data.previous_response_id ? `resp_tool_turn_${number}` : 'resp_tool_start';
      jsonResponse(res, 200, responseBody(id, [call.data.previous_response_id ? secondCall : functionCall]));
    },
  });
  const firstPayload = request('tool-session', {
    model: 'gpt-6.1-sol-ar', store: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '运行命令并解释结果' }] }],
    tools: [{ type: 'function', name: 'exec_command', description: 'Execute a synthetic command', strict: true,
      parameters: { type: 'object', properties: { cmd: { type: 'string' }, note: { type: 'string' } }, required: ['cmd', 'note'], additionalProperties: false } }],
    tool_choice: 'auto', parallel_tool_calls: true,
  });
  const firstResponse = await completed(send, firstPayload);
  assert.deepEqual(firstResponse.output, [functionCall]);
  await completed(send, request('unrelated-tool-session'));
  const secondPayload = {
    ...firstPayload, model: 'gpt-5.6-sol-ar', prompt_cache_key: 'conflicting-tool-session',
    previous_response_id: firstResponse.id,
    input: [functionCall, toolOutput, { role: 'user', content: '继续处理工具结果' }],
  };
  const secondResponse = await completed(send, secondPayload);
  const thirdPayload = {
    ...firstPayload, model: 'gpt-6-astra-ar', prompt_cache_key: 'another-tool-session',
    previous_response_id: secondResponse.id,
    input: [secondCall, { type: 'function_call_output', call_id: 'call_mock_2', output: '完整输出\n{"ok":true}' }],
  };
  await completed(send, thirdPayload);
  for (const [index, payload] of [[0, firstPayload], [2, secondPayload], [3, thirdPayload]]) {
    assert.deepEqual(calls[index].data, { ...payload, model: models[payload.model] });
    assert.equal(calls[index].headers.authorization, calls[0].headers.authorization);
  }
  assert.notEqual(calls[1].headers.authorization, calls[0].headers.authorization);
});

test('streamed tool-call deltas arrive before completion and preserve every byte', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const first = sseFrame('response.created', { type: 'response.created', response: { id: 'resp_stream_tool' } }, '\n');
  const rest = Buffer.concat([
    sseFrame('response.output_item.added', { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_stream', call_id: 'call_stream', name: 'exec_command', arguments: '' } }, '\n'),
    sseFrame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_stream', delta: '{"cmd":"输出中文"}' }, '\n'),
    sseFrame('response.output_item.done', { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_stream', call_id: 'call_stream', name: 'exec_command', arguments: '{"cmd":"输出中文"}' } }, '\n'),
    sseFrame('response.completed', { type: 'response.completed', response: responseBody('resp_stream_tool') }, '\n'),
    Buffer.from('data: [DONE]\n\n'),
  ]);
  // The router holds the preamble (created/added) until the first event that
  // carries payload. Cut the stream on that event boundary and block before the
  // closing events, so the test proves the deltas reached the client while the
  // response was still incomplete.
  const cut = rest.indexOf(Buffer.from('event: response.output_item.done'));
  assert.ok(cut > 0, 'fixture must contain the closing frame');
  const expectedHead = Buffer.concat([first, rest.subarray(0, cut)]);
  const { send, calls } = await setup(t, {
    handler: async (_call, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(expectedHead);
      await gate;
      res.end(rest.subarray(cut));
    },
  });
  const response = await send(request('stream-tool-session', {
    stream: true, tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
  }));
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const head = [];
  let headBytes = 0;
  while (headBytes < expectedHead.length) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, 'the stream ended before the tool-call deltas arrived');
    head.push(Buffer.from(chunk.value));
    headBytes += chunk.value.length;
  }
  assert.deepEqual(Buffer.concat(head), expectedHead, 'every held byte must arrive in order before completion');
  release();
  const tail = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    tail.push(Buffer.from(chunk.value));
  }
  assert.deepEqual(Buffer.concat(tail), rest.subarray(cut));
  assert.equal(calls.length, 1);
});

test('pool status requires the client bearer and exposes no tokens or token hashes', async t => {
  const { get, calls } = await setup(t);
  for (const headers of [{}, { authorization: bearer('wrong-synthetic-client') }]) {
    const unauthorized = await get('/v1/pool/status', headers);
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
  }
  const response = await get('/v1/pool/status', { authorization: bearer(clientToken) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(response.headers.get('content-type'), /application\/json/i);
  const status = JSON.parse(text);
  assert.ok(status && typeof status === 'object');
  for (const row of accounts) {
    assert.ok(text.includes(row.id), `status should identify ${row.id} without its credential`);
    assert.ok(text.includes(row.label), `status should retain the label of ${row.id}`);
  }
  for (const secret of [clientToken, alphaToken, betaToken, legacyToken, 'synthetic-opencode-token']) {
    const digest = createHash('sha256').update(secret).digest('hex');
    assert.ok(!text.includes(secret), 'raw credentials must not appear in pool status');
    assert.ok(!text.includes(digest.slice(0, 8)), 'credential hashes must not appear in pool status');
  }
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, /^(token|api_key|secret|credential|token_hash|key_hash)$/i);
      inspect(child);
    }
  };
  inspect(status);
  assert.equal(calls.length, 0);
});

test('health reports gateway version 3', async t => {
  const { get, calls } = await setup(t);
  const response = await get('/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, 3);
  assert.equal(calls.length, 0);
});
