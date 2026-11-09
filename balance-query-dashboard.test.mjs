import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard, createBalanceQueryRunner } from './dashboard.mjs';

const headers = { 'X-Gateway-Local': '1' };
function fakeRunner() {
  const state = { running: false, startedAt: null, finishedAt: null, args: null };
  let starts = 0;
  return { state, starts: () => starts, status: () => ({ ...state }), start(...args) { if (state.running) return false; starts++; state.running = true; state.startedAt = new Date().toISOString(); state.args = args; return true; } };
}

async function fixture(t, data = {}) {
  const root = mkdtempSync(join(tmpdir(), 'balance-query-dashboard-'));
  for (const [name, report] of Object.entries(data)) writeFileSync(join(root, name), JSON.stringify(report));
  const runner = fakeRunner(); const balanceQueryRunner = fakeRunner();
  const handler = createDashboard({ root, runner, balanceQueryRunner, getPoolStatus: () => ({ accounts: [] }), getService: () => ({}), readEvents: () => [] });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/dashboard/api`;
  return { root, runner, balanceQueryRunner, get: async () => (await fetch(`${url}/overview`)).json(), post: (path, opts = {}) => fetch(`${url}/${path}`, { method: 'POST', headers, ...opts }) };
}

test('balance query invokes the independent Python program with no windows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'balance-query-runner-'));
  mkdirSync(join(directory, '.venv', 'Scripts'), { recursive: true });
  writeFileSync(join(directory, '.venv', 'Scripts', 'python.exe'), '');
  writeFileSync(join(directory, 'query-balances.py'), '');
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const runner = createBalanceQueryRunner(directory, (_binary, args, options) => {
    assert.deepEqual(args, ['-u', 'query-balances.py']);
    assert.equal(options.windowsHide, true); assert.equal(options.env.NEWAPI_HEADLESS, '1');
    return child;
  });
  assert.equal(runner.start(), true);
  child.stdout.emit('data', Buffer.from('safe progress'));
  assert.equal(runner.status().phase, '正在查询余额');
  child.emit('close', 0);
  assert.equal(runner.status().phase, '余额查询结束，请查看账号结果');
});

test('single-account query forwards the account to the runner and rejects unsafe ids', () => {
  const directory = mkdtempSync(join(tmpdir(), 'balance-query-single-'));
  mkdirSync(join(directory, '.venv', 'Scripts'), { recursive: true });
  writeFileSync(join(directory, '.venv', 'Scripts', 'python.exe'), '');
  writeFileSync(join(directory, 'query-balances.py'), '');
  const seen = [];
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const runner = createBalanceQueryRunner(directory, (_binary, args) => { seen.push(args); return child; });
  assert.equal(runner.start(['sample-account']), true);
  assert.deepEqual(seen[0], ['-u', 'query-balances.py', 'sample-account']);
  assert.equal(runner.status().target, 'sample-account');
  assert.equal(runner.start(['other']), false);
  child.emit('close', 0);
  assert.equal(runner.start(['../../etc/passwd']), true);
  assert.deepEqual(seen[1], ['-u', 'query-balances.py']);
  assert.equal(runner.status().target, null);
});

test('a single-account query validates its body and never launches on a bad id', async t => {
  const f = await fixture(t);
  const json = { ...headers, 'Content-Type': 'application/json' };
  const bad = await f.post('query-balances', { headers: json, body: JSON.stringify({ accountId: '../../etc' }) });
  assert.equal(bad.status, 400);
  assert.equal(f.balanceQueryRunner.starts(), 0);
  const good = await f.post('query-balances', { headers: json, body: JSON.stringify({ accountId: 'sample-account' }) });
  assert.equal(good.status, 202);
  assert.equal((await good.json()).target, 'sample-account');
  assert.deepEqual(f.balanceQueryRunner.state.args, [['sample-account']]);
});

test('query and check-in cannot run together in either direction', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('query-balances')).status, 202);
  assert.equal(f.balanceQueryRunner.starts(), 1); assert.equal(f.runner.starts(), 0);
  assert.equal((await f.post('check-in')).status, 409);
  assert.equal((await f.post('query-balances')).status, 409);
  f.balanceQueryRunner.state.running = false;
  f.balanceQueryRunner.state.finishedAt = new Date().toISOString();
  f.balanceQueryRunner.state.startedAt = new Date(Date.now() - 301000).toISOString();
  assert.equal((await f.post('check-in')).status, 202);
  assert.equal((await f.post('query-balances')).status, 409);
});

test('query cooldown survives service reload through its latest report', async t => {
  const startedAt = new Date(Date.now() - 10000).toISOString();
  const query = { id: 'query1', operation: 'balance_query', startedAt, finishedAt: startedAt, status: 'partial', accounts: [] };
  const f = await fixture(t, { 'balance-query-history.json': { latestRun: query, runs: [query] } });
  const response = await f.post('query-balances');
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.ok(body.balanceQuery.retryAfterSeconds > 40 && body.balanceQuery.retryAfterSeconds <= 50);
  assert.equal(f.balanceQueryRunner.starts(), 0);
  assert.equal((await f.post('check-in')).status, 429);
});

test('overview merges histories and preserves independent task identity', async t => {
  const old = { id: 'check1', startedAt: new Date(Date.now() - 420000).toISOString(), status: 'partial', totalBalance: 4, accounts: [] };
  const recent = { id: 'query1', startedAt: new Date(Date.now() - 360000).toISOString(), operation: 'balance_query', status: 'success', totalBalance: 9, accounts: [] };
  const f = await fixture(t, { 'balance-history.json': { latestRun: old, runs: [old] }, 'balance-query-history.json': { latestRun: recent, runs: [recent] } });
  const data = await f.get();
  assert.equal(data.balances.latestRun.id, 'query1');
  assert.deepEqual(data.balances.runs.map(run => run.id), ['query1', 'check1']);
  assert.equal(data.checkInBalances.latestRun.id, 'check1');
  assert.equal(data.queriedBalances.latestRun.id, 'query1');
  assert.equal(data.checkIn.running, false); assert.equal(data.balanceQuery.running, false);
  assert.equal((await f.post('query-balances')).status, 202);
});

test('unfinished query report blocks both launches after a service reload', async t => {
  const current = { id: 'query1', operation: 'balance_query', startedAt: new Date().toISOString(), status: 'in_progress', accounts: [] };
  const f = await fixture(t, { 'balance-query-history.json': { latestRun: current, runs: [] } });
  const overview = await f.get();
  assert.equal(overview.balanceQuery.running, true); assert.equal(overview.checkIn.running, false);
  assert.equal((await f.post('check-in')).status, 409);
  assert.equal((await f.post('query-balances')).status, 409);
});

test('query writes retain local origin and request-header protections', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('query-balances', { headers: {} })).status, 403);
  assert.equal((await f.post('query-balances', { headers: { ...headers, Origin: 'https://foreign.example' } })).status, 403);
  assert.equal(f.balanceQueryRunner.starts(), 0);
});

test('a dead task process cannot leave the query permanently running', async t => {
  const run = { id: 'aborted', operation: 'balance_query', processId: 2147483647,
    startedAt: new Date(Date.now() - 360000).toISOString(), status: 'in_progress', confirmedCount: 0,
    accounts: [{ username: 'synthetic', status: 'pending', balance: null }] };
  const f = await fixture(t, { 'balance-query-history.json': { latestRun: run, runs: [] } });
  const data = await f.get();
  assert.equal(data.balanceQuery.running, false);
  assert.equal(data.balances.latestRun.interrupted, true);
  assert.equal(data.balances.latestRun.accounts[0].error, 'not_completed');
  assert.equal((await f.post('query-balances')).status, 202);
});
