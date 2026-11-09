import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createDashboard } from './dashboard.mjs';

const NOW = Date.parse('2026-11-03T03:00:00Z');
const origin = 'https://agentrouter.org';
async function fixture(t, policy, options = {}) {
  const parent = resolve('work', 'site-policy-test'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-'));
  const directory = join(root, 'checkin'); mkdirSync(directory);
  const policyPath = join(directory, 'site-request-policy.json');
  if (policy !== undefined) writeFileSync(policyPath, typeof policy === 'string' ? policy : JSON.stringify(policy));
  let checkins = 0; let queries = 0;
  const runner = { status: () => ({ running: false, finishedAt: null }), start: () => { checkins++; return true; } };
  const balanceQueryRunner = { status: () => ({ running: false, finishedAt: null }), start: () => { queries++; return true; } };
  const handle = createDashboard({ root, checkInDirectory: directory, now: () => NOW, runner, balanceQueryRunner,
    getPoolStatus: () => ({ accounts: [] }), getService: () => ({}), readEvents: () => [], ...options });
  const server = http.createServer(async (req, res) => { if (!await handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); assert.equal(dirname(resolve(root)), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, policyPath, starts: () => ({ checkins, queries }),
    get: () => fetch(url + '/dashboard/api/overview').then(r => r.json()),
    post: (path, headers = { 'X-Gateway-Local': '1', Origin: url }) => fetch(url + '/dashboard/api/' + path, { method: 'POST', headers }) };
}

test('shared upstream cooldown blocks query and sign-in but leaves local overview readable', async t => {
  const f = await fixture(t, { version: 1, providers: { [origin]: { cooldownUntil: NOW / 1000 + 900, nextQueryAt: NOW / 1000 + 20 } } });
  const data = await f.get();
  assert.equal(data.requestPolicy.available, true);
  assert.equal(data.requestPolicy.retryAfterSeconds, 900);
  assert.equal(data.requestPolicy.queryRetryAfterSeconds, 900);
  assert.equal(data.requestPolicy.reason, 'rate_limited');
  for (const action of ['check-in', 'query-balances']) {
    const response = await f.post(action); assert.equal(response.status, 429);
    assert.equal((await response.json()).requestPolicy.retryAfterSeconds, 900);
  }
  assert.deepEqual(f.starts(), { checkins: 0, queries: 0 });
});

test('recent operation interval blocks redundant query or sign-in clicks', async t => {
  const f = await fixture(t, { version: 1, providers: { [origin]: { nextQueryAt: NOW / 1000 + 300 } } });
  assert.equal((await f.get()).balanceQuery.retryAfterSeconds, 300);
  assert.equal((await f.post('query-balances')).status, 429);
  assert.equal((await f.post('check-in')).status, 429);
  assert.deepEqual(f.starts(), { checkins: 0, queries: 0 });
});

test('reads the Python policy ISO schema including nullable deadlines without exposing account state', async t => {
  const f = await fixture(t, { version: 1, providers: { [origin]: { cooldownUntil: new Date(NOW + 900000).toISOString(), nextQueryAt: null, nextLoginAt: null, reason: 'rate_limited', loginSuccess: { synthetic: { lastSuccessAt: new Date(NOW).toISOString() } } } } });
  const data = await f.get();
  assert.equal(data.requestPolicy.available, true);
  assert.equal(data.requestPolicy.retryAfterSeconds, 900);
  assert.equal(JSON.stringify(data.requestPolicy).includes('synthetic'), false);
});

test('missing and expired policy state do not block a user-requested task', async t => {
  const missing = await fixture(t, undefined);
  assert.equal((await missing.get()).requestPolicy.available, true);
  assert.equal((await missing.post('query-balances')).status, 202);
  const expired = await fixture(t, { version: 1, providers: { [origin]: { cooldownUntil: NOW / 1000 - 1, nextQueryAt: NOW / 1000 - 1 } } });
  assert.equal((await expired.get()).requestPolicy.retryAfterSeconds, 0);
  assert.equal((await expired.post('check-in')).status, 202);
});

test('malformed existing policy fails closed without exposing contents', async t => {
  for (const policy of ['{synthetic-private', { version: 3, providers: {} }, { version: 1, providers: { [origin]: { cooldownUntil: 'tomorrow synthetic-private' } } }]) {
    const f = await fixture(t, policy);
    const data = await f.get();
    assert.equal(data.requestPolicy.available, false);
    assert.equal(data.requestPolicy.reason, 'policy_state_unavailable');
    assert.equal(JSON.stringify(data).includes('synthetic-private'), false);
    for (const action of ['check-in', 'query-balances']) assert.equal((await f.post(action)).status, 503);
    assert.deepEqual(f.starts(), { checkins: 0, queries: 0 });
  }
});

test('the one-minute minimum survives reload via the last query report', async t => {
  const f = await fixture(t, undefined);
  const run = { id: 'query', startedAt: new Date(NOW - 20000).toISOString(), status: 'success', accounts: [] };
  writeFileSync(join(f.root, 'balance-query-history.json'), JSON.stringify({ latestRun: run, runs: [run] }));
  assert.equal((await f.get()).balanceQuery.retryAfterSeconds, 40);
  assert.equal((await f.post('query-balances')).status, 429);
});

test('cross-origin requests remain rejected before policy checks', async t => {
  const f = await fixture(t, undefined);
  assert.equal((await f.post('query-balances', { Origin: 'https://outside.invalid', 'X-Gateway-Local': '1' })).status, 403);
  assert.deepEqual(f.starts(), { checkins: 0, queries: 0 });
});
