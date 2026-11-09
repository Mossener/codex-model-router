import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBalanceSpend } from './balance-spend.mjs';

const now = Date.parse('2026-11-03T04:00:00Z');
const at = hoursAgo => new Date(now - hoursAgo * 3600000).toISOString();
const row = (used, hoursAgo, extra = {}) => ({
  id: 'account-a', username: 'alice@example.test', provider: 'agentrouter',
  status: 'success', used, balance: 100, updatedAt: at(hoursAgo), ...extra,
});
const report = (...accounts) => ({ accounts });
const summarize = (reports, hours = 4) => summarizeBalanceSpend(reports, hours, now);

test('sums observed cumulative usage within the selected period, independently of rewards', () => {
  const result = summarize([report(row(10, 3, { balance: 90 })), report(row(14.5, 1, { balance: 110.5 }))]);
  assert.equal(result.amount, 4.5);
  assert.equal(result.currency, 'USD');
  assert.equal(result.source, 'agentrouter-used-quota');
  assert.equal(result.accountsReported, 1);
  assert.equal(result.coverageHours, 2);
  assert.equal(result.partial, true);
});

test('does not count a pair straddling the boundary or extrapolate from outside the window', () => {
  const result = summarize([report(row(0, 5)), report(row(20, 3)), report(row(25, 1)), report(row(50, -1))]);
  assert.equal(result.amount, 5);
  assert.equal(result.firstObservedAt, at(3));
  assert.equal(result.lastObservedAt, at(1));
  assert.equal(result.byAccount[0].samples, 2);
  assert.equal(summarize([report(row(0, 5)), report(row(20, 3))]).amount, null);
});

test('exact boundary samples are included and support complete coverage', () => {
  const result = summarize([report(row(1, 4)), report(row(11, 0))]);
  assert.equal(result.amount, 10);
  assert.equal(result.coverageHours, 4);
  assert.equal(result.partial, false);
});

test('deduplicates repeated history samples and normalizes account identity', () => {
  const old = report(row(10, 3));
  const fresh = report(row(13, 1, { username: ' Alice@Example.Test ', id: 'changed-id' }));
  const result = summarize([old, fresh, fresh, old]);
  assert.equal(result.amount, 3);
  assert.equal(result.accountsObserved, 1);
  assert.equal(result.byAccount[0].samples, 2);
});

test('conflicting same-time samples are not counted as a spending interval', () => {
  const result = summarize([report(row(10, 3)), report(row(20, 3)), report(row(25, 1))]);
  assert.equal(result.amount, null);
  assert.equal(result.byAccount[0].samples, 1);
});

test('differing account sets report only accounts with two valid samples', () => {
  const result = summarize([
    report(row(10, 3), row(20, 3, { username: 'bob', id: 'b' })),
    report(row(15, 1), row(5, 1, { username: 'carol', id: 'c' })),
  ]);
  assert.equal(result.amount, 5);
  assert.equal(result.accountsObserved, 3);
  assert.equal(result.accountsReported, 1);
  assert.equal(result.byAccount.find(account => account.username === 'carol').amount, null);
});

test('missing, failed, invalid and non-AgentRouter samples cannot create spend', () => {
  const invalid = [null, undefined, -1, NaN, Infinity, '10'];
  const reports = invalid.map(used => report(row(used, 2)));
  reports.push(report(row(10, 3, { provider: 'axon' }), row(20, 1, { provider: 'axon' })));
  reports.push(report(row(10, 3, { status: 'failed' }), row(20, 1, { status: 'pending' })));
  const result = summarize(reports);
  assert.equal(result.amount, null);
  assert.equal(result.accountsObserved, 0);
  assert.equal(result.firstObservedAt, null);
});

test('counter resets are excluded while subsequent verified increments remain visible', () => {
  const result = summarize([report(row(100, 3)), report(row(104, 2)), report(row(2, 1)), report(row(5, 0))]);
  assert.equal(result.amount, 7);
  assert.equal(result.resets, 1);
  assert.equal(result.partial, true);
  assert.equal(result.byAccount[0].coveredHours, 2);
});

test('two unchanged valid samples produce real zero, one sample remains unknown', () => {
  assert.equal(summarize([report(row(10, 3)), report(row(10, 1))]).amount, 0);
  assert.equal(summarize([report(row(10, 1))]).amount, null);
});

test('supports requested windows and preserves decimal amounts without floating artifacts', () => {
  const reports = [report(row(0.1, 20)), report(row(0.2, 10)), report(row(0.3, 1))];
  assert.equal(summarize(reports, 24).amount, 0.2);
  assert.equal(summarize(reports, 4).amount, null);
  assert.equal(summarize(reports, 168).amount, 0.2);
  assert.equal(summarize(reports, 720).amount, 0.2);
  assert.equal(summarize(reports, 720).hours, 720);
  assert.equal(summarize(reports, 99).hours, 4);
});

test('stable id fallback is supported and report time substitutes only missing row time', () => {
  const result = summarize([
    { finishedAt: at(2), accounts: [row(1, 2, { username: null, updatedAt: null })] },
    { finishedAt: at(0), accounts: [row(4, 0, { username: null, updatedAt: null })] },
  ]);
  assert.equal(result.amount, 3);
  assert.equal(result.byAccount[0].id, 'account-a');
  assert.equal(result.lastObservedAt, at(0));
});

test('a merged row from an earlier run is not re-dated as a fresh observation', () => {
  // 09:19 的签到报告里带着 02:58 那次的旧行：它没有被重新查询，不能算 09:19 的样本。
  const carried = row(152.91, 7);
  const signIn = {
    id: 'run-signin', startedAt: at(1.2), finishedAt: at(1),
    accounts: [{ ...carried }, row(40, 0.6, { username: 'bob@example.test', id: 'account-b' })],
  };
  const result = summarize([signIn]);
  assert.deepEqual(result.byAccount.map(account => account.username), ['bob@example.test']);
  assert.equal(result.byAccount[0].samples, 1);
  assert.equal(result.amount, null);
  assert.equal(result.partial, true);
});

test('the same run listed twice still counts one observation per run', () => {
  const fresh = (used, observedAt) => ({ ...row(used, 0), updatedAt: observedAt });
  const runA = { id: 'run-a', startedAt: at(3.4), finishedAt: at(3), accounts: [fresh(10, at(3.1))] };
  const runB = { id: 'run-b', startedAt: at(1.4), finishedAt: at(1), accounts: [fresh(14.5, at(1.1))] };
  const result = summarize([runA, runB, runA, runB]);
  assert.equal(result.byAccount[0].samples, 2);
  assert.equal(result.amount, 4.5);
  assert.equal(result.byAccount[0].from, at(3));
  assert.equal(result.byAccount[0].to, at(1));
});

test('fresh rows are dated by the run, so a lagging site timestamp cannot move them out of the window', () => {
  // 站点写回的时间比本轮开始早 6 分钟，仍在同一次观测里：按运行时间取点。
  const lagging = { id: 'run-lag', startedAt: at(3.2), finishedAt: at(3), accounts: [row(10, 3.3)] };
  const fresh = { id: 'run-now', startedAt: at(1.2), finishedAt: at(1), accounts: [row(14.5, 0.9)] };
  const result = summarize([lagging, fresh]);
  assert.equal(result.byAccount[0].samples, 2);
  assert.equal(result.amount, 4.5);
  assert.equal(result.byAccount[0].from, at(3));
  assert.equal(result.byAccount[0].to, at(1));
});