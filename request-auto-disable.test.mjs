import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountPool } from './account-pool.mjs';

const fixtures = mkdtempSync(join(tmpdir(), 'request-auto-disable-'));
process.env.CODEX_MODEL_GATEWAY_HINTS = join(fixtures, 'level-hints.json');
const { createRouter } = await import('./router.mjs');
const accountRows = () => [
  { id: 'a', token: 'synthetic-alpha-key', enabled: true },
  { id: 'b', token: 'synthetic-beta-key', enabled: true },
];

test('explicit insufficient balance stays disabled after the old cooldown deadline', () => {
  let clock = 1000;
  const calls = [];
  const rows = accountRows();
  const pool = createAccountPool({ now: () => clock, cooldownMs: 500, onAutoDisable: (id, reason) => calls.push([id, reason]) });
  pool.observeFailure('a', 403, '用户余额不足 synthetic-private-detail');
  clock = 999999999;
  const status = pool.status(rows);
  assert.equal(status.accounts[0].enabled, false);
  assert.equal(status.accounts[0].reason, 'insufficient_balance');
  assert.equal(status.accounts[0].disabledReason, 'insufficient_balance');
  assert.equal(status.accounts[0].cooldownUntil, null);
  assert.equal(status.availableCount, 1);
  assert.equal(pool.select(rows, {}).account.id, 'b');
  assert.deepEqual(calls, [['a', 'insufficient_balance']]);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-private-detail/);
});

test('persistence errors still block the account and manual recovery clears the latch', () => {
  const rows = accountRows();
  const pool = createAccountPool({ onAutoDisable: () => { throw new Error('synthetic persistence failure'); } });
  assert.doesNotThrow(() => pool.observeFailure('a', 402, 'Your account balance is insufficient'));
  assert.equal(pool.status(rows).accounts[0].available, false);
  pool.clearFailure('a');
  assert.equal(pool.status(rows).accounts[0].available, true);
});

test('a later refusal retries a failed persistence write', () => {
  let calls = 0;
  const pool = createAccountPool({ onAutoDisable: () => { calls++; if (calls === 1) throw new Error('Temporary file lock'); } });
  pool.observeFailure('a', 403, 'User quota is insufficient');
  pool.observeFailure('a', 403, 'User quota is insufficient');
  assert.equal(calls, 2);
});

test('a saved disable survives a new pool and an observed manual enable recovers', () => {
  const rows = accountRows();
  const pool = createAccountPool({ onAutoDisable: (id, reason) => {
    Object.assign(rows.find(row => row.id === id), { enabled: false, disabledReason: reason, disabledAt: '2026-01-01T00:00:00Z' });
  } });
  pool.status(rows);
  pool.observeFailure('a', 403, 'insufficient_user_quota');
  assert.equal(pool.status(rows).accounts[0].available, false);
  assert.equal(createAccountPool().status(rows).accounts[0].disabledReason, 'insufficient_balance');
  rows[0].enabled = true;
  delete rows[0].disabledReason;
  delete rows[0].disabledAt;
  assert.equal(pool.status(rows).accounts[0].available, true);
});

test('shared supply and token limits never permanently disable an account', () => {
  for (const [status, text] of [
    [429, 'Your account balance is insufficient'],
    [402, 'Budget pool quota has been exhausted'],
    [403, 'Budget pool quota exhausted; user balance insufficient'],
    [200, 'rate_limit_exceeded Your requests exceeded token rate limit'],
    [403, 'Upstream account balance is insufficient'],
    [403, '上游账户余额不足'],
    [403, 'quota exceeded'],
  ]) {
    const calls = [];
    const pool = createAccountPool({ onAutoDisable: (...args) => calls.push(args) });
    pool.observeFailure('a', status, text);
    assert.deepEqual(calls, [], `${status}: ${text}`);
    assert.equal(pool.status(accountRows()).availableCount, 2);
  }
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

for (const stream of [false, true]) {
  test(`${stream ? 'HTTP 200 SSE' : 'HTTP 403'} account balance failure calls persistent disable and permits manual enable`, async t => {
    const rows = accountRows();
    const disabled = [];
    let reject = true;
    const requests = [];
    const upstream = http.createServer(async (req, res) => {
      for await (const _ of req) {}
      requests.push(req.headers.authorization);
      if (reject && req.headers.authorization === 'Bearer synthetic-alpha-key') {
        if (stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const event = { type: 'response.failed', response: { id: 'resp_failure', status: 'failed', error: { code: 'insufficient_user_quota', message: '用户余额不足' } } };
          res.end(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`);
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'insufficient_user_quota', message: '用户余额不足' } }));
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'resp_ok', status: 'completed', output: [] }));
      }
    });
    const upstreamUrl = await listen(upstream);
    const router = createRouter({
      agentrouterBaseUrl: upstreamUrl + '/v1', defaultBaseUrl: upstreamUrl + '/v1',
      agentrouterModels: { 'synthetic-model-ar': 'synthetic-model' },
      getClientToken: () => 'synthetic-client-token',
      getAgentrouterAccounts: () => rows.map(row => ({ ...row })),
      onAccountAutoDisable: (id, reason) => { disabled.push([id, reason]); Object.assign(rows.find(row => row.id === id), { enabled: false, disabledReason: reason }); },
      diagnosticsDirectory: mkdtempSync(join(fixtures, 'diagnostics-')),
      dashboard: { root: fixtures, runner: { status: () => ({ running: false }) },
        balanceQueryRunner: { status: () => ({ running: false }) },
        setAccountEnabled: (id, enabled) => { rows.find(row => row.id === id).enabled = enabled; } },
    });
    const url = await listen(router);
    t.after(() => { router.closeAllConnections(); router.close(); upstream.closeAllConnections(); upstream.close(); });
    const request = key => fetch(url + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer synthetic-client-token', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'synthetic-model-ar', stream, prompt_cache_key: key, input: 'synthetic' }) });
    const failed = await request('first');
    await failed.text();
    assert.deepEqual(disabled, [['a', 'insufficient_balance']]);
    assert.equal(rows[0].enabled, false);
    await (await request('second')).text();
    assert.equal(requests[1], 'Bearer synthetic-beta-key');
    const enable = await fetch(url + '/dashboard/api/accounts/a/enabled', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Gateway-Local': '1', origin: url }, body: JSON.stringify({ enabled: true }) });
    assert.equal(enable.status, 200);
    assert.equal((await enable.json()).pool.accounts.find(row => row.id === 'a').available, true);
    reject = false;
    await (await request('third')).text();
    await (await request('fourth')).text();
    assert.ok(requests.slice(2).includes('Bearer synthetic-alpha-key'));
  });
}
