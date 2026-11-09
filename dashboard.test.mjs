import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createDashboard, knownBalances, summarizeRequests } from './dashboard.mjs';
import { createResponseObserver } from './response-observer.mjs';

async function fixture(t, options = {}) {
  const workspace = resolve('work'); mkdirSync(workspace, { recursive: true });
  const root = mkdtempSync(join(workspace, 'dashboard-test-'));
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'web/index.html'), '<h1>Dashboard</h1>');
  const state = { running: false };
  let starts = 0;
  const handle = createDashboard({ root, getToken: () => 'local-console-test-token', getPoolStatus: () => ({ accounts: [], configuredCount: 0, availableCount: 0 }), getService: () => ({ defaultModel: 'gpt-6.1-sol' }), runner: { status: () => state, start: () => { if (state.running) return false; state.running = true; starts++; return true; } }, readEvents: () => [], ...options });
  const server = http.createServer(async (req, res) => { if (!await handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); const target = resolve(root); assert.ok(target.startsWith(workspace + '\\')); rmSync(target, { recursive: true, force: true }); });
  return { root, url: `http://127.0.0.1:${server.address().port}`, starts: () => starts };
}

test('dashboard opens without a management token and cannot be framed', async t => {
  const { url } = await fixture(t, { getToken: () => { throw new Error('No token should be read'); } });
  const response = await fetch(`${url}/dashboard`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.doesNotMatch(await response.text(), /token/i);
});

test('built AxonHub page serves only named static assets with local checks and no inline scripts', async t => {
  const { root, url } = await fixture(t);
  mkdirSync(join(root, 'web-axonhub', 'assets'), { recursive: true });
  writeFileSync(join(root, 'web-axonhub', 'index.html'), '<div id="root"></div><script type="module" src="/dashboard/assets/index-test.js"></script>');
  writeFileSync(join(root, 'web-axonhub', 'assets', 'index-test.js'), 'console.log("synthetic UI");');
  const response = await fetch(`${url}/dashboard`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\/dashboard\/assets\/index-test\.js/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self';/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${url}/dashboard/assets/index-test.js`)).status, 200);
  assert.equal((await fetch(`${url}/dashboard/assets/index-test.js`, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(`${url}/dashboard/assets/NOTICE`)).status, 404);
  assert.equal((await fetch(`${url}/dashboard/assets/missing.js`)).status, 404);
});

test('local browser reads and check-in accept an opaque Origin only with same-origin metadata and the local header', async t => {
  const { url, starts } = await fixture(t);
  const headers = { Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'X-Gateway-Local': '1' };
  assert.equal((await fetch(`${url}/dashboard/api/overview`, { headers })).status, 200);
  const response = await fetch(`${url}/dashboard/api/check-in`, { method: 'POST', headers });
  assert.equal(response.status, 202);
  assert.equal(starts(), 1);
});

test('opaque or foreign origins cannot invoke check-in by supplying the local header', async t => {
  const { url, starts } = await fixture(t);
  const denied = [
    { Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'X-Gateway-Local': '1' },
    { Origin: 'null', 'X-Gateway-Local': '1' },
    { Origin: 'null', 'Sec-Fetch-Site': 'none', 'X-Gateway-Local': '1' },
    { Origin: 'null', 'Sec-Fetch-Site': 'same-site', 'X-Gateway-Local': '1' },
    { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' },
    { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'same-origin', 'X-Gateway-Local': '1' },
  ];
  for (const headers of denied) {
    const response = await fetch(`${url}/dashboard/api/check-in`, { method: 'POST', headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  assert.equal(starts(), 0);
});

test('browser requests must use the exact local host and port of the page', async t => {
  const { url } = await fixture(t);
  const headers = { Origin: url, 'Sec-Fetch-Site': 'same-origin', 'X-Gateway-Local': '1' };
  assert.equal((await fetch(`${url}/dashboard/api/overview`, { headers })).status, 200);
  for (const origin of [url.replace('127.0.0.1', 'localhost'), `${url}0`]) {
    assert.equal((await fetch(`${url}/dashboard/api/overview`, { headers: { ...headers, Origin: origin } })).status, 403);
  }
});

test('dashboard rejects cross-site origins and DNS rebinding Host headers', async t => {
  const { url } = await fixture(t);
  assert.equal((await fetch(`${url}/dashboard`, { headers: { Origin: 'https://example.com' } })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${url}/dashboard`, { headers: { Host: 'attacker.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await fetch(`${url}/dashboard`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('local reads need no token while writes require the same-origin request header', async t => {
  const { url, starts } = await fixture(t);
  assert.equal((await fetch(`${url}/dashboard/api/overview`)).status, 200);
  assert.equal((await fetch(`${url}/dashboard/api/check-in`, { method: 'POST' })).status, 403);
  assert.equal(starts(), 0);
  const response = await fetch(`${url}/dashboard/api/overview`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.balances.latestRun, null);
  assert.equal(data.metrics.inputTokens, null);
  assert.equal(data.metrics.successRate, null);
  assert.ok(!JSON.stringify(data).includes('local-console-test-token'));
});

test('check-in action prevents duplicate concurrent launches', async t => {
  const { url, starts } = await fixture(t);
  const send = () => fetch(`${url}/dashboard/api/check-in`, { method: 'POST', headers: { 'X-Gateway-Local': '1' } });
  assert.equal((await send()).status, 202);
  assert.equal((await send()).status, 409);
  assert.equal(starts(), 1);
});

test('overview reads the latest real balance snapshot without making API calls', async t => {
  const { root, url } = await fixture(t);
  const run = { id: 'run-1', totalBalance: 75, confirmedCount: 3, accountCount: 3, accounts: [] };
  writeFileSync(join(root, 'balance-history.json'), JSON.stringify({ latestRun: run, runs: [run] }));
  const data = await (await fetch(`${url}/dashboard/api/overview`)).json();
  assert.deepEqual(data.balances.latestRun, run);
});

test('account enable switches reject form submissions and cross-site writes', async t => {
  const calls = [];
  const { url } = await fixture(t, { setAccountEnabled: (...args) => calls.push(args) });
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' };
  assert.equal((await fetch(`${url}/dashboard/api/accounts/one/enabled`, request)).status, 403);
  assert.equal((await fetch(`${url}/dashboard/api/accounts/one/enabled`, { ...request, headers: { ...request.headers, 'X-Gateway-Local': '1', Origin: 'https://example.com' } })).status, 403);
  assert.equal(calls.length, 0);
});

test('account enable switches persist only the enabled flag and return public pool state', async t => {
  const calls = [];
  const publicPool = { accounts: [{ id: 'one', enabled: false, keyConfigured: true }], configuredCount: 0, availableCount: 0 };
  const { url } = await fixture(t, { setAccountEnabled: (...args) => calls.push(args), getPoolStatus: () => publicPool });
  const response = await fetch(`${url}/dashboard/api/accounts/one/enabled`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gateway-Local': '1' }, body: '{"enabled":false}' });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [['one', false]]);
  assert.deepEqual(await response.json(), { pool: publicPool });
});

test('account switch bodies must be small JSON objects containing only a boolean enabled flag', async t => {
  const calls = [];
  const { url } = await fixture(t, { setAccountEnabled: (...args) => calls.push(args) });
  for (const body of ['null', '[]', '{invalid', '{"enabled":"false"}', '{"enabled":true,"keyPath":"other"}']) {
    const response = await fetch(`${url}/dashboard/api/accounts/one/enabled`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gateway-Local': '1' }, body });
    assert.equal(response.status, 400);
  }
  const oversized = await fetch(`${url}/dashboard/api/accounts/one/enabled`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gateway-Local': '1' }, body: '{"enabled":true}' + ' '.repeat(2048) });
  assert.equal(oversized.status, 413);
  const wrongType = await fetch(`${url}/dashboard/api/accounts/one/enabled`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Gateway-Local': '1' }, body: '{"enabled":true}' });
  assert.equal(wrongType.status, 415);
  assert.equal(calls.length, 0);
});

test('account switch persistence errors use safe messages and preserve specific status codes', async t => {
  const { url } = await fixture(t, { setAccountEnabled: id => { if (id === 'absent') throw Object.assign(new Error('账号不存在'), { statusCode: 404 }); throw new Error('synthetic-secret-token'); } });
  for (const [id, expected] of [['absent', 404], ['one', 503]]) {
    const response = await fetch(`${url}/dashboard/api/accounts/${id}/enabled`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gateway-Local': '1' }, body: '{"enabled":false}' });
    assert.equal(response.status, expected);
    assert.ok(!(await response.text()).includes('synthetic-secret-token'));
  }
});

test('metrics use actual usage and count interrupted streams as failures', () => {
  const at = '2026-11-02T04:00:00Z';
  const data = summarizeRequests([
    { at, status: 200, ms: 100, route: 'original', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedTokens: 70, reasoningTokens: 5 } },
    { at, status: 200, ms: 200, route: 'agentrouter', aborted: true },
    { at: '2026-10-01T04:00:00Z', status: 500, route: 'original' },
  ], 4, Date.parse(at));
  assert.equal(data.total, 2); assert.equal(data.success, 1); assert.equal(data.failed, 1); assert.equal(data.successRate, 50);
  assert.equal(data.inputTokens, 100); assert.equal(data.tokensReportedCount, 1);
  assert.equal(data.cachedTokens, 70); assert.equal(data.averageLatencyMs, 150);
});

test('reported total tokens include responses without an input/output breakdown', () => {
  const at = '2026-11-02T04:00:00Z';
  const data = summarizeRequests([
    { at, status: 200, route: 'original', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
    { at, status: 200, route: 'agentrouter', usage: { inputTokens: null, outputTokens: null, totalTokens: 70 } },
    { at, status: 502, route: 'agentrouter' },
  ], 4, Date.parse(at));
  assert.equal(data.totalTokens, 190);
  assert.equal(data.inputTokens, 100);
  assert.equal(data.outputTokens, 20);
  assert.equal(data.tokensReportedCount, 2);
  assert.equal(data.tpm, 190 / 240);
  assert.equal(data.series.find(bucket => bucket.requests > 0).tokens, 190);
  assert.equal(summarizeRequests([], 4, Date.parse(at)).totalTokens, null);
  assert.equal(summarizeRequests([{ at, status: 200, usage: { totalTokens: 0 } }], 4, Date.parse(at)).totalTokens, 0);
});

test('UTF-8 split SSE events preserve response affinity and reported usage', () => {
  const ids = []; const usage = [];
  const observer = createResponseObserver('text/event-stream', id => ids.push(id), 1024 * 1024, value => usage.push(value));
  const bytes = Buffer.from('event: response.created\r\ndata: {"response":{"id":"resp_split","metadata":{"label":"中文"}}}\r\n\r\nevent: response.completed\ndata: {"response":{"id":"resp_split","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n');
  for (let i = 0; i < bytes.length; i += 3) observer.write(bytes.subarray(i, i + 3));
  observer.end();
  assert.deepEqual(ids, ['resp_split', 'resp_split']);
  assert.equal(usage[0].totalTokens, 7); assert.equal(usage[0].cachedTokens, null);
});

test('confirmed balance totals the latest success of every account, not just the newest run', () => {
  const earlier = { startedAt: '2026-11-03T09:00:00Z', accounts: [
    { username: 'a@x', status: 'success', balance: 10, updatedAt: '2026-11-03T08:59:00Z' },
    { username: 'b@x', status: 'success', balance: 20, updatedAt: '2026-11-03T08:58:00Z' },
  ] };
  const partial = { startedAt: '2026-11-03T09:10:00Z', accounts: [
    { username: 'a@x', status: 'success', balance: 11, updatedAt: '2026-11-03T09:10:00Z' },
    { username: 'b@x', status: 'failed', balance: null, updatedAt: null },
  ] };
  const known = knownBalances([partial, earlier], 3);
  assert.equal(known.count, 2);
  assert.equal(known.poolSize, 3);
  assert.equal(known.total, 31);
  assert.equal(known.freshestAt, '2026-11-03T09:10:00.000Z');
  // 合并历史行会让同一份旧快照重复出现，重复的 updatedAt 不能被重复计入。
  const duplicated = knownBalances([partial, earlier, earlier, earlier], 3);
  assert.equal(duplicated.count, 2);
  assert.equal(duplicated.total, 31);
  assert.equal(knownBalances([], 16).total, null);
  assert.equal(knownBalances([], 16).freshestAt, null);
});

test('confirmed balance ignores accounts that never succeeded', () => {
  const run = { startedAt: '2026-11-03T09:00:00Z', accounts: [
    { username: 'c@x', status: 'failed', balance: null, error: 'session_required', updatedAt: null },
    { username: 'd@x', status: 'pending', balance: null },
    { username: 'e@x', status: 'success', balance: 0, updatedAt: '2026-11-03T08:00:00Z' },
  ] };
  const known = knownBalances([run], 16);
  assert.equal(known.count, 1);
  assert.equal(known.total, 0);
});

test('an overdrawn account counts with its negative balance', () => {
  // 欠费账号的负余额是真实读数，不能被合计丢掉，否则总额会虚高。
  const run = { startedAt: '2026-11-03T09:00:00Z', accounts: [
    { username: 'f@x', status: 'success', balance: -0.179214, updatedAt: '2026-11-03T08:00:00Z' },
    { username: 'g@x', status: 'success', balance: 10, updatedAt: '2026-11-03T08:00:00Z' },
  ] };
  const known = knownBalances([run], 16);
  assert.equal(known.count, 2);
  assert.equal(known.total, 9.820786);
});
test('overview serves the month window while the detail list stays at seven days', async t => {
  const { url } = await fixture(t, { readEvents: () => [] });
  const month = await (await fetch(`${url}/dashboard/api/overview?hours=720`)).json();
  assert.equal(month.metrics.hours, 720);
  const unknown = await (await fetch(`${url}/dashboard/api/overview?hours=999`)).json();
  assert.equal(unknown.metrics.hours, 4);
  const list = await (await fetch(`${url}/dashboard/api/requests?hours=720`)).json();
  assert.equal(list.hours, 168);
});

test('overview serves today and yesterday as local calendar days and the list gets their absolute edges', async t => {
  const events = [{ at: new Date().toISOString(), route: 'agentrouter', model: 'model-a-ar', accountId: 'account_a', status: 200, ms: 10, usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } }];
  const { url } = await fixture(t, { readEvents: () => events });
  const today = await (await fetch(`${url}/dashboard/api/overview?range=today`)).json();
  assert.equal(today.metrics.range, 'today');
  assert.equal(today.spend.range, 'today');
  assert.equal(today.metrics.total, 1, 'a request from a moment ago belongs to today');
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  assert.ok(Math.abs(today.metrics.hours - (Date.now() - midnight.getTime()) / 3600000) < 0.05, 'the window starts at local midnight, not 24 hours back');
  const yesterday = await (await fetch(`${url}/dashboard/api/overview?range=yesterday`)).json();
  assert.equal(yesterday.metrics.range, 'yesterday');
  assert.equal(yesterday.metrics.hours, 24);
  assert.equal(yesterday.metrics.total, 0, 'yesterday cannot contain a request made today');
  const list = await (await fetch(`${url}/dashboard/api/requests?range=yesterday`)).json();
  assert.equal(list.hours, 24);
  assert.equal(list.total, 0);
  const fixed = await (await fetch(`${url}/dashboard/api/overview?hours=24&range=today`)).json();
  assert.equal(fixed.metrics.range, 'today', 'range wins over hours');
});

test('pool metering ignores Axon direct and OpenCode requests entirely', async t => {
  const at = new Date().toISOString();
  const row = extra => ({ at, model: 'model-a-ar', status: 200, ms: 10, usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }, ...extra });
  const events = [row({ route: 'agentrouter', accountId: 'account_a' }), row({ route: 'original', model: 'gpt-5.6-luna' }), row({ route: 'opencode' })];
  const { url } = await fixture(t, { readEvents: () => events, knownModels: new Set(['model-a-ar', 'gpt-5.6-luna']) });
  const overview = await (await fetch(`${url}/dashboard/api/overview?hours=4`)).json();
  assert.equal(overview.metrics.total, 1);
  assert.equal(overview.metrics.totalTokens, 11);
  assert.deepEqual(overview.metrics.byModel.map(group => group.key), ['model-a-ar']);
  assert.deepEqual(overview.metrics.byAccount.map(group => group.key), ['account_a']);
  assert.deepEqual(overview.metrics.routeCounts, { agentrouter: 1 });
  const list = await (await fetch(`${url}/dashboard/api/requests?hours=4`)).json();
  assert.equal(list.total, 1);
  assert.equal(list.records[0].route, 'agentrouter');
  assert.equal((await (await fetch(`${url}/dashboard/api/requests?hours=4&account=${encodeURIComponent('route:original')}`)).json()).total, 0);
});

test('a query that sent nothing says so instead of looking like a success', async t => {
  const idle = { running: false, phase: '等待余额查询', lastExitCode: null, startedAt: null, finishedAt: null, target: null };
  const skipped = { ...idle, lastExitCode: 2 };
  const failed = { ...idle, lastExitCode: 1 };
  const read = async (status) => {
    const { url } = await fixture(t, { balanceQueryRunner: { status: () => ({ ...status }), start: () => true } });
    const response = await fetch(`${url}/dashboard/api/overview?hours=4`, { headers: { 'X-Gateway-Local': '1' } });
    assert.equal(response.status, 200);
    return (await response.json()).balanceQuery;
  };
  assert.equal((await read(idle)).message, null);
  assert.match((await read(skipped)).message, /没有发出任何请求.*退出码 2/);
  assert.match((await read(failed)).message, /退出码 1/);
});