// The local body cap is the one refusal the router answers without an upstream.
// Codex resends the whole thread every turn, so a long computer-use session that
// keeps multi-megabyte screenshots is refused here long before the parent process
// sees anything, and a 413 with no explanation leaves the client with a dead end.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouter, describeOversizedBody, parseTruncatedItems, describeBodyBytes } from './router.mjs';

// A replay shaped like the one that triggered the refusal: many turns, each with
// a tool result, and screenshots that are the bulk of the bytes. The screenshots
// come first so they are the reason the body was already over the cap when the
// router stopped reading, which is what a real Codex thread looks like.
function oversizedReplay({ items = 40, toolBytes = 1_000_000, images = 10, imageChars = 3_500_000, model = 'gpt-6.1-sol-ar' } = {}) {
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'keep going' }] }];
  for (let index = 0; index < images; index += 1) {
    input.push({ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(imageChars)}` }] });
  }
  for (let index = 0; index < items; index += 1) {
    input.push({ type: 'function_call', call_id: `c${index}`, name: 'shell', arguments: '{"cmd":"Get-ChildItem"}' });
    input.push({ type: 'function_call_output', call_id: `c${index}`, output: 'x'.repeat(toolBytes) });
  }
  return { model, input, stream: true };
}

// A replay whose bulk is message text: the ladder has nothing it can cut, because
// the router never rewrites what the user typed. This is the shape that still ends
// in a refusal, so the refusal has to explain itself.
function textOversizedReplay(totalChars = 66 * 1024 * 1024) {
  const chunk = 1024 * 1024;
  const input = [];
  for (let written = 0; written < totalChars; written += chunk) {
    input.push({ role: 'user', content: [{ type: 'input_text', text: `${written}:${'t'.repeat(chunk - 12)}` }] });
  }
  return { model: 'gpt-6.1-sol-ar', input, stream: true };
}

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function startGateway(options = {}) {
  const events = [];
  const received = [];
  const upstream = http.createServer((req, res) => {
    // A body this large never reaches a real upstream; answering proves it was not
    // the one that refused and keeps the test independent of the network.
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', () => received.push(bytes));
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const router = createRouter({
    port: 0,
    instanceId: 'local-limit-test',
    defaultModel: 'gpt-5.2-codex',
    defaultBaseUrl: `http://127.0.0.1:${upstreamPort}/original/v1`,
    getClientToken: () => 'test-token',
    agentrouterModels: { 'gpt-6.1-sol-ar': 'gpt-6.1-sol' },
    catalog: { models: [] },
    log: event => events.push(event),
    ...options,
  });
  const port = await listen(router);
  return {
    port,
    events,
    received,
    close: async () => {
      router.closeAllConnections();
      router.close();
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    },
  };
}

function post(port, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/v1/responses', method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('a replay over the local cap is rebuilt and routed instead of refused', async () => {
  const gateway = await startGateway();
  try {
    // Screenshots and old tool dumps are exactly what the ladder may drop, so this
    // thread has to survive: refusing it would leave a working session with no way
    // forward except losing the conversation.
    const payload = oversizedReplay({ model: 'gpt-6.1-sol' });
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024 * 1024, 'the fixture has to exceed the local cap');
    const response = await post(gateway.port, payload);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers['x-local-router-limit'], undefined);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(gateway.received.length, 1, 'the rebuilt turn reached the route');
    assert.ok(gateway.received[0] < 64 * 1024 * 1024, `what was sent fits the cap: ${gateway.received[0]}`);
    const row = gateway.events.at(-1);
    assert.equal(row.status, 200, JSON.stringify(row));
    assert.equal(row.route, 'original');
    assert.ok(row.bytes < 64 * 1024 * 1024, `the row describes the rebuilt body: ${row.bytes}`);
  } finally {
    await gateway.close();
  }
});

test('a replay the rebuild cannot fit is still refused with an explanation and a log row', async () => {
  const gateway = await startGateway();
  try {
    const payload = textOversizedReplay();
    const body = JSON.stringify(payload);
    assert.ok(Buffer.byteLength(body) > 64 * 1024 * 1024, 'the fixture has to exceed the local cap');
    const response = await post(gateway.port, payload);
    assert.equal(response.status, 413);
    assert.equal(response.headers['x-local-router-limit'], 'body');
    const message = JSON.parse(response.text).error.message;
    assert.match(message, /exceeds|accepts/i);
    assert.match(message, /compact|new conversation/i);
    // The refusal has to name the cap and the size of the replay, not the bytes of
    // an attempt the client never finished writing.
    assert.match(message, /accepts 64 MiB per request/);
    assert.match(message, /This replay is 6[4-9]\.\d MiB/);
    // The body is now read whole before it is answered, so the breakdown is the
    // real one: message text is what the router refuses to rewrite.
    assert.match(message, /MiB of message text/);
    await new Promise(resolve => setTimeout(resolve, 50));
    const row = gateway.events.find(event => event.status === 413);
    assert.ok(row, `the refusal is logged: ${JSON.stringify(gateway.events.map(event => [event.route, event.status]))}`);
    assert.equal(row.error, 'payload_too_large');
    assert.equal(row.route, 'local', `row: ${JSON.stringify(row)}`);
    assert.equal(row.model, 'gpt-6.1-sol-ar');
    assert.equal(row.accountId, undefined, 'nothing was sent, so no account answered');
    assert.ok(row.bytes > 64 * 1024 * 1024);
    assert.ok(row.oversized.imageMB < 1, `there are no screenshots: ${JSON.stringify(row)}`);
    assert.ok(row.items >= 60, `the item count is the whole body: ${JSON.stringify(row)}`);
    assert.doesNotMatch(JSON.stringify(gateway.events), /t{200}/, 'no body content is copied into the log');
  } finally {
    await gateway.close();
  }
});

test('a fragment cut at the cap still yields the items that arrived whole', () => {
  const input = [
    { type: 'function_call', call_id: 'c0', name: 'shell', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c0', output: 'o'.repeat(300000) },
    { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"dir \\"C:\\\\tmp\\""}' },
    { type: 'function_call_output', call_id: 'c1', output: 'p'.repeat(400000) },
  ];
  const head = JSON.stringify({ model: 'gpt-6.1-sol-ar', input }).slice(0, 1000000);
  const items = parseTruncatedItems(head);
  assert.equal(items.length, 4, 'three whole items and the cut one');
  assert.equal(items[2].arguments, '{"cmd":"dir \\"C:\\\\tmp\\""}', 'escaped quotes do not end the item early');
  const shape = describeOversizedBody({ input: items });
  assert.ok(shape.outputMB > 0.5, `the cut item contributes the bytes that did arrive: ${JSON.stringify(shape)}`);
  assert.deepEqual(parseTruncatedItems('{"model":"gpt-6.1-sol-ar","input":'), []);
  const cutImage = parseTruncatedItems('{"model":"gpt-6.1-sol-ar","input":[{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,AAA' + 'A'.repeat(2000));
  assert.equal(cutImage.length, 1, 'the cut item is still summarised');
  assert.equal(cutImage[0].type, 'message');
  assert.equal(cutImage[0].image_url.url.length, 2025, 'the cut screenshot is counted as far as it arrived');
  assert.doesNotThrow(() => parseTruncatedItems('{"input":[{"output":"tail\\'), 'a cut escape sequence is still safe');
  assert.doesNotMatch(JSON.stringify(cutImage).replace(/A{2000}/, ''), /A{200}/, 'the sample holds no body text');
});

test('the log-row shape counts tool output and images without their content', () => {
  const shape = describeOversizedBody({ input: [
    { type: 'function_call_output', output: 'y'.repeat(2 * 1024 * 1024) },
    { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'z'.repeat(1024 * 1024) }] },
    { type: 'custom_tool_call_output', artifact: 'w'.repeat(1024 * 1024) },
    { role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${'B'.repeat(4 * 1024 * 1024)}` }] },
  ] });
  assert.equal(shape.items, 4);
  assert.equal(shape.outputMB, 4);
  assert.equal(shape.imageMB, 4);
});

test('the refusal says where the bytes are, not just how many there are', () => {
  // The real refusal of 2026-11-07 was 64 MiB with 108 items, no screenshots and
  // a tenth of a megabyte of tool output: the instructions and the message text
  // were the replay. The breakdown has to name those, not guess at screenshots.
  const data = {
    model: 'gpt-6.1-sol-ar',
    instructions: 's'.repeat(2 * 1024 * 1024),
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'd'.repeat(1024 * 1024) }] },
      { role: 'user', content: [{ type: 'input_text', text: 'm'.repeat(3 * 1024 * 1024) }] },
      { type: 'function_call_output', call_id: 'c0', output: 'o'.repeat(100000) },
    ],
  };
  const bytes = describeBodyBytes(data);
  assert.equal(bytes.instructionsBytes, 2 * 1024 * 1024);
  assert.equal(bytes.developerBytes, 1024 * 1024);
  assert.equal(bytes.messageTextBytes, 3 * 1024 * 1024);
  assert.equal(bytes.toolBytes, 100000);
  assert.equal(bytes.imageBytes, 0);
  // A fragment the cap cut still names what did arrive, whichever bucket it lands in.
  const head = JSON.stringify({ ...data, instructions: 's'.repeat(10) }).slice(0, 1500000);
  const fragment = describeBodyBytes({ input: parseTruncatedItems(head) });
  assert.equal(fragment.instructionsBytes, 0, 'the field was cut before it was read');
  assert.ok(fragment.developerBytes + fragment.messageTextBytes > 100000, `the fragment is still accounted for: ${JSON.stringify(fragment)}`);
  assert.doesNotThrow(() => describeBodyBytes(null), 'a body that never parsed does not throw');
});

test('an over-cap compaction is rebuilt as a summary instead of refused', async () => {
  const gateway = await startGateway();
  try {
    // The compaction that would shrink a 71 MiB thread used to be refused for being
    // 71 MiB: the one request with a way out had no way out.
    const payload = { ...oversizedReplay({ model: 'gpt-6.1-sol' }), summarize: true };
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024 * 1024, 'the fixture has to exceed the local cap');
    const response = await post(gateway.port, payload);
    assert.equal(response.status, 200, response.text);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(gateway.received.length, 1, 'the rebuilt compaction reached the route');
    assert.ok(gateway.received[0] < 64 * 1024 * 1024, `what was sent fits the cap: ${gateway.received[0]}`);
    const row = gateway.events.at(-1);
    assert.equal(row.status, 200, JSON.stringify(row));
  } finally {
    await gateway.close();
  }
});

test('a replay just under the cap still reaches the route', async () => {
  const gateway = await startGateway();
  try {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
    const response = await post(gateway.port, { model: 'gpt-6.1-sol-ar', input, stream: true });
    assert.notEqual(response.status, 413);
    assert.notEqual(response.headers['x-local-router-limit'], 'body');
  } finally {
    await gateway.close();
  }
});
