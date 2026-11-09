import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

const { createRouter } = await import('./router.mjs');
const { clearThoughtSignatures, SKIP_THOUGHT_SIGNATURE } = await import('./gemini.mjs');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

const sse = value => `data: ${JSON.stringify(value)}\n\n`;

// A stand-in for Google's OpenAI-compatible surface: plain HTTP so the router can
// reach it without the tunnel, and scriptable so each test can pick a reply.
async function setup(t, handler, overrides = {}) {
  clearThoughtSignatures();
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    try { call.json = JSON.parse(call.body); } catch { call.json = null; }
    calls.push(call);
    return handler(call, res, calls.length);
  });
  const upstreamUrl = await listen(upstream);
  const server = createRouter({
    defaultBaseUrl: `${upstreamUrl}/original/v1`,
    geminiBaseUrl: `${upstreamUrl}/gemini`,
    geminiModels: { 'gemini-3.5-flash': 'gemini-3.5-flash' },
    geminiEfforts: { 'gemini-3.5-flash': ['low', 'medium', 'high'] },
    getClientToken: () => 'client-secret',
    getGeminiToken: () => 'gemini-secret',
    catalog: { models: [] },
    diagnosticsDirectory: undefined,
    ...overrides,
  });
  const url = await listen(server);
  t.after(() => {
    server.closeAllConnections(); server.close();
    upstream.closeAllConnections(); upstream.close();
  });
  const send = (body, path = '/v1/responses') => fetch(`${url}${path}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer client-secret', 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { calls, send, url };
}

const textHandler = (call, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] }));
  res.write(sse({ choices: [{ index: 0, delta: { content: ' there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }));
  res.end('data: [DONE]\n\n');
};

function parseEvents(text) {
  return text.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n');
    const event = lines.find(line => line.startsWith('event: '))?.slice(7);
    const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
    return { event, data: data ? JSON.parse(data) : null };
  });
}

test('a gemini model is translated and streamed back as Responses events', async t => {
  const { calls, send } = await setup(t, textHandler);
  const response = await send({
    model: 'gemini-3.5-flash',
    instructions: 'be brief',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    reasoning: { effort: 'minimal' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = parseEvents(await response.text());

  assert.equal(calls[0].path, '/gemini/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer gemini-secret');
  assert.equal(calls[0].json.model, 'gemini-3.5-flash');
  assert.equal(calls[0].json.stream, true);
  assert.deepEqual(calls[0].json.stream_options, { include_usage: true });
  assert.equal(calls[0].json.reasoning_effort, 'low');
  assert.deepEqual(calls[0].json.messages[0], { role: 'system', content: 'be brief' });

  const names = events.map(event => event.event);
  assert.equal(names[0], 'response.created');
  assert.ok(names.includes('response.output_text.delta'));
  assert.equal(names.at(-1), 'response.completed');
  assert.deepEqual(events.filter(event => event.event === 'response.output_text.delta').map(event => event.data.delta), ['Hello', ' there']);
  const completed = events.at(-1).data.response;
  assert.equal(completed.object, 'response');
  assert.equal(completed.output[0].content[0].text, 'Hello there');
  assert.equal(completed.usage.input_tokens, 12);
  assert.equal(completed.usage.output_tokens, 3);
});

test('a tool call round-trips and its thought signature is replayed', async t => {
  const first = (call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ choices: [{ index: 0, delta: { extra_content: { google: { thought_signature: 'sig-stub' } } }, finish_reason: null }] }));
    res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_stub', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
    res.end('data: [DONE]\n\n');
  };
  const { calls, send } = await setup(t, (call, res, index) => (index === 1 ? first(call, res) : textHandler(call, res)));
  const body = {
    model: 'gemini-3.5-flash',
    input: [{ type: 'message', role: 'user', content: 'patch it' }],
    tools: [{ type: 'custom', name: 'apply_patch', description: 'patch', format: { type: 'grammar', syntax: 'lark', definition: 'x' } }],
  };
  const events = parseEvents(await (await send(body)).text());
  const done = events.filter(event => event.event === 'response.output_item.done').map(event => event.data.item);
  assert.equal(done.length, 1);
  assert.equal(done[0].type, 'custom_tool_call');
  assert.equal(done[0].call_id, 'call_stub');
  assert.equal(done[0].input, '*** Begin Patch');
  assert.equal(calls[0].json.tools[0].function.name, 'apply_patch');
  assert.deepEqual(calls[0].json.tools[0].function.parameters.required, ['input']);

  // The next turn replays the call the way Codex does, so the upstream sees its own
  // signature instead of the bypass constant.
  await (await send({
    model: 'gemini-3.5-flash',
    input: [
      { type: 'message', role: 'user', content: 'patch it' },
      { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch', call_id: 'call_stub' },
      { type: 'custom_tool_call_output', call_id: 'call_stub', output: 'applied' },
    ],
  })).text();
  const replayed = calls[1].json.messages.find(message => message.role === 'assistant');
  assert.equal(replayed.tool_calls[0].extra_content.google.thought_signature, 'sig-stub');
  assert.equal(replayed.tool_calls[0].function.arguments, JSON.stringify({ input: '*** Begin Patch' }));
  assert.deepEqual(calls[1].json.messages.at(-1), { role: 'tool', tool_call_id: 'call_stub', content: 'applied' });
});

test('an unknown call id falls back to the bypass constant', async t => {
  const { calls, send } = await setup(t, textHandler);
  await (await send({
    model: 'gemini-3.5-flash',
    input: [
      { type: 'message', role: 'user', content: 'go' },
      { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_from_elsewhere' },
      { type: 'function_call_output', call_id: 'call_from_elsewhere', output: 'ok' },
    ],
  })).text();
  const replayed = calls[0].json.messages.find(message => message.role === 'assistant');
  assert.equal(replayed.tool_calls[0].extra_content.google.thought_signature, SKIP_THOUGHT_SIGNATURE);
});

test('a rejected stream_options field is retried once without it', async t => {
  const handler = (call, res, index) => {
    if (index === 1 && call.json.stream_options) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Unsupported field: stream_options' } }));
    }
    return textHandler(call, res);
  };
  const { calls, send } = await setup(t, handler);
  const response = await send({ model: 'gemini-3.5-flash', input: 'hi' });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls.length, 2);
  assert.ok(calls[0].json.stream_options);
  assert.equal(calls[1].json.stream_options, undefined);
});

test('a non-streaming turn comes back as one Responses object', async t => {
  const { send } = await setup(t, (call, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-3.5-flash',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'plain answer' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }));
  });
  const response = await send({ model: 'gemini-3.5-flash', input: 'hi', stream: false });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'response');
  assert.equal(body.output[0].content[0].text, 'plain answer');
  assert.equal(body.usage.total_tokens, 6);
});

test('an upstream failure reaches the client with its own status and no key', async t => {
  const { send } = await setup(t, (call, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Quota exceeded for gemini-3.8-flash (key gemini-secret)' } }));
  });
  const response = await send({ model: 'gemini-3.5-flash', input: 'hi' });
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.match(body.error.message, /Quota exceeded/);
});

test('a missing gemini credential is reported instead of forwarded', async t => {
  const { calls, send } = await setup(t, textHandler, { getGeminiToken: () => '' });
  const response = await send({ model: 'gemini-3.5-flash', input: 'hi' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /gemini credential is unavailable/);
  assert.equal(calls.length, 0);
});

test('a compact request for a gemini slug stays on the original route', async t => {
  const { calls, send } = await setup(t, (call, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [] }));
  });
  await (await send({ model: 'gemini-3.5-flash', input: 'hi' }, '/v1/responses/compact')).text();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/original/v1/responses/compact');
  assert.equal(calls[0].headers.authorization, 'Bearer client-secret');
});
