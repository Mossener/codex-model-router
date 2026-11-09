import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDashboard } from './dashboard.mjs';
import { publicRequestRecords, queryRequests, summarizeRequests } from './usage-metrics.mjs';

const now = Date.parse('2026-11-03T08:00:00Z');
const knownModels = new Set(['model-a-ar', 'model-a', 'model-b']);
const options = { knownModels };
const entry = (minutes, extra = {}) => ({ at: new Date(now - minutes * 60000).toISOString(), route: 'agentrouter', model: 'model-a-ar', accountId: 'account_a', status: 200, ms: 10, ...extra });

test('usage aggregates by requested model and account without double counting cached or reasoning tokens', () => {
  const events = [
    entry(3, { upstreamModel: 'model-a', usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, cachedTokens: 60, reasoningTokens: 12 } }),
    entry(2, { accountId: 'account_b', usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 } }),
    entry(1, { model: 'model-b', route: 'original', accountId: null, usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 } }),
  ];
  const data = summarizeRequests(events, 4, now, options);
  assert.equal(data.totalTokens, 160);
  assert.equal(data.cachedTokens, 60);
  assert.equal(data.reasoningTokens, 12);
  assert.equal(data.byModel[0].key, 'model-a-ar');
  assert.equal(data.byModel[0].totalTokens, 150);
  assert.deepEqual(data.byModel[0].upstreamModels, ['model-a']);
  assert.equal(data.byModel[1].totalTokens, 10);
  assert.deepEqual(new Set(data.byAccount.map(group => group.key)), new Set(['account_a', 'account_b', 'route:original']));
  assert.equal(data.byAccount.reduce((total, group) => total + group.totalTokens, 0), data.totalTokens);
});

test('cache hit rate divides reported cached input by reported input and stays unknown otherwise', () => {
  const events = [
    entry(3, { usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, cachedTokens: 60 } }),
    entry(2, { usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 } }),
    entry(1, { model: 'model-b', usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10, cachedTokens: 5 } }),
  ];
  const data = summarizeRequests(events, 4, now, options);
  assert.equal(data.inputTokens, 130);
  assert.equal(data.cachedTokens, 65);
  assert.equal(data.cacheRate, 65 / 130 * 100);
  assert.equal(data.uncachedInputTokens, 65);
  assert.equal(data.byModel[0].cacheRate, 60 / 120 * 100);
  assert.equal(data.byModel[1].cacheRate, 50);
  assert.ok(data.series.filter(bucket => bucket.requests).every(bucket => bucket.cacheRate === null || Number.isFinite(bucket.cacheRate)));
  // 只有输入没有缓存上报、缓存没有输入、以及纯空数据都必须给 null，不能退化成 0%。
  assert.equal(summarizeRequests([entry(1, { usage: { inputTokens: 10 } })], 4, now, options).cacheRate, null);
  assert.equal(summarizeRequests([entry(1, { usage: { cachedTokens: 9 } })], 4, now, options).cacheRate, null);
  assert.equal(summarizeRequests([entry(1)], 4, now, options).cacheRate, null);
  assert.equal(summarizeRequests([], 4, now, options).cacheRate, null);
  assert.equal(summarizeRequests([entry(1, { usage: { inputTokens: 0, cachedTokens: 0 } })], 4, now, options).cacheRate, null);
});

test('zero token reports remain known while partial and missing reports expose incomplete coverage', () => {
  const events = [entry(4), entry(3, { usage: {} }), entry(2, { usage: { inputTokens: 7 } }), entry(1, { usage: { totalTokens: 0 } })];
  const data = summarizeRequests(events, 4, now, options);
  assert.equal(data.totalTokens, 0);
  assert.equal(data.inputTokens, 7);
  assert.equal(data.outputTokens, null);
  assert.equal(data.tokensReportedCount, 2);
  assert.equal(data.totalTokensReportedCount, 1);
  assert.equal(data.tokensMissingCount, 3);
  assert.equal(data.byModel[0].tokensMissingCount, 3);
  assert.equal(queryRequests(events, new URLSearchParams('usage=reported'), now, options).total, 1);
  assert.equal(queryRequests(events, new URLSearchParams('usage=missing'), now, options).total, 3);
});

test('HTTP 200 with a failed SSE result or interrupted stream counts as failed', () => {
  const events = [entry(3, { failed: 'rate_limit' }), entry(2, { aborted: true }), entry(1), entry(0, { status: 503 })];
  const data = summarizeRequests(events, 4, now, options);
  assert.equal(data.success, 1);
  assert.equal(data.failed, 3);
  assert.equal(data.byModel[0].failed, 3);
  assert.equal(queryRequests(events, new URLSearchParams('status=failed'), now, options).total, 3);
  assert.equal(queryRequests(events, new URLSearchParams('status=success'), now, options).total, 1);
});

test('accounts seen within five minutes are active and every account keeps its last sighting', () => {
  const events = [entry(2, { accountId: 'fresh' }), entry(9, { accountId: 'stale' }), entry(1, { accountId: 'fresh' })];
  const data = summarizeRequests(events, 4, now, options);
  assert.equal(data.activeWindowMinutes, 5);
  assert.deepEqual(data.activeAccounts.map(group => group.accountId), ['fresh']);
  const fresh = data.byAccount.find(group => group.accountId === 'fresh');
  assert.equal(fresh.active, true);
  assert.equal(fresh.lastSeenAt, new Date(now - 60000).toISOString());
  const stale = data.byAccount.find(group => group.accountId === 'stale');
  assert.equal(stale.active, false);
  assert.equal(stale.lastSeenAt, new Date(now - 9 * 60000).toISOString());
  assert.equal(data.byAccount.every(group => typeof group.active === 'boolean'), true);
});

test('series fills empty time buckets but keeps unreported usage distinct from zero', () => {
  const data = summarizeRequests([entry(60), entry(0, { usage: { totalTokens: 0 } })], 4, now, options);
  assert.equal(data.series.length, 9);
  assert.equal(data.series[0].at, '2026-11-03T04:00:00.000Z');
  assert.equal(data.series.at(-1).at, '2026-11-03T08:00:00.000Z');
  assert.equal(data.series[0].tokens, 0);
  const unknown = data.series.find(point => point.requests && point.tokensMissingCount);
  assert.equal(unknown.tokens, null);
  assert.equal(unknown.requests, 1);
  assert.equal(data.series.at(-1).tokens, 0);
  assert.equal(data.series.at(-1).totalTokensReportedCount, 1);
  assert.equal(data.series.reduce((sum, point) => sum + point.requests, 0), data.total);
});

test('only selected-window timestamps are included and order is stable for equal timestamps', () => {
  const events = [entry(-1), entry(241), entry(240, { ms: 1 }), entry(0, { ms: 2 }), entry(0, { ms: 3 }), { at: 'bad' }];
  const data = summarizeRequests(events, 4, now, options);
  assert.equal(data.total, 3);
  assert.deepEqual(data.timeline.map(record => record.ms), [1, 2, 3]);
  assert.deepEqual(queryRequests(events, new URLSearchParams(), now, options).records.map(record => record.ms), [3, 2, 1]);
});

test('coverage names the real span behind a window so equal totals stay explainable', () => {
  const recent = [entry(10), entry(600)];
  const day = summarizeRequests(recent, 24, now, options);
  const week = summarizeRequests(recent, 168, now, options);
  assert.equal(day.total, week.total, 'a week holding nothing older is the same records');
  assert.equal(day.firstSeenAt, week.firstSeenAt);
  assert.equal(day.lastSeenAt, week.lastSeenAt);
  assert.equal(day.firstSeenAt, new Date(now - 600 * 60000).toISOString());
  assert.equal(day.lastSeenAt, new Date(now - 10 * 60000).toISOString());
  const older = [...recent, entry(4000)];
  assert.equal(summarizeRequests(older, 24, now, options).firstSeenAt, day.firstSeenAt, 'the day window ignores it');
  assert.equal(summarizeRequests(older, 168, now, options).firstSeenAt, new Date(now - 4000 * 60000).toISOString(), 'the week window sees it');
  const empty = summarizeRequests([], 24, now, options);
  assert.deepEqual([empty.firstSeenAt, empty.lastSeenAt], [null, null]);
  const bad = summarizeRequests([entry(-1, { at: 'bad' })], 24, now, options);
  assert.deepEqual([bad.firstSeenAt, bad.lastSeenAt], [null, null]);
});

test('the month window is accepted, buckets by day and falls back for unknown spans', () => {
  const events = [entry(10), entry(4000), entry(29 * 24 * 60)];
  const month = summarizeRequests(events, 720, now, options);
  assert.equal(month.hours, 720);
  assert.equal(month.total, 3);
  assert.equal(month.series.length, 31, '30 days plus the partial day behind now');
  assert.equal(month.series[1].at.endsWith('T00:00:00.000Z'), true, 'buckets are whole UTC days');
  assert.equal(month.firstSeenAt, new Date(now - 29 * 24 * 60 * 60000).toISOString());
  assert.equal(month.series.reduce((total, bucket) => total + bucket.requests, 0), 3);
  assert.equal(summarizeRequests(events, 999, now, options).hours, 4, 'an unknown span stays on four hours');
});

test('calendar-day windows cut at local midnight, keep the fractional span and bucket by two hours', () => {
  // now = 2026-11-03T08:00:00Z，本机（Asia/Shanghai）就是 11-03 16:00；本地零点 = 11-02T16:00Z。
  const midnight = Date.parse('2026-11-02T16:00:00Z');
  const events = [entry(0), entry(60), entry(600), entry(2000)];
  const today = summarizeRequests(events, 24, now, { ...options, range: 'today', start: midnight, end: now });
  assert.equal(today.range, 'today');
  assert.equal(today.hours, 16, 'the span is midnight to now, not a 24 hour offset');
  assert.equal(today.total, 3, 'the 11-02 record stays out of today');
  assert.equal(today.series.length, 9);
  assert.equal(today.series[0].at, '2026-11-02T16:00:00.000Z');
  const yesterday = summarizeRequests(events, 24, now, { ...options, range: 'yesterday', start: midnight - 86400000, end: midnight });
  assert.equal(yesterday.range, 'yesterday');
  assert.equal(yesterday.hours, 24);
  assert.equal(yesterday.total, 1);
  assert.equal(yesterday.series.length, 13);
  // 显式窗口压过 hours：同一段自然日即使传 4 也不会被截成 4 小时。
  const forced = summarizeRequests(events, 4, now, { ...options, start: midnight, end: now });
  assert.equal(forced.hours, 16);
  assert.equal(forced.total, 3);
  assert.equal(summarizeRequests(events, 4, now, options).range, null);
});

test('the detail list accepts an absolute window so calendar days keep their midnight edges', () => {
  const midnight = Date.parse('2026-11-02T16:00:00Z');
  const events = [entry(0), entry(600), entry(2000)];
  const today = queryRequests(events, new URLSearchParams(`from=${midnight}&to=${now}`), now, options);
  assert.equal(today.total, 2);
  assert.equal(today.hours, 16);
  const yesterday = queryRequests(events, new URLSearchParams(`from=${midnight - 86400000}&to=${midnight}`), now, options);
  assert.equal(yesterday.total, 1);
  assert.equal(yesterday.hours, 24);
  // 只有 from 没有 to 的残缺参数不能悄悄变成 1970 年窗口。
  assert.equal(queryRequests(events, new URLSearchParams('from=0&hours=4'), now, options).hours, 4);
});

test('request pagination combines exact model, account, status and usage filters', () => {
  const events = Array.from({ length: 8 }, (_, index) => entry(index, { accountId: index % 2 ? 'account_b' : 'account_a', usage: { totalTokens: index } }));
  events.push(entry(2, { model: 'model-b', accountId: 'account_a', status: 503 }));
  const result = queryRequests(events, new URLSearchParams('model=model-a-ar&account=account_a&status=success&usage=reported&page=2&pageSize=2'), now, options);
  assert.equal(result.total, 4);
  assert.equal(result.pageCount, 2);
  assert.equal(result.page, 2);
  assert.deepEqual(result.records.map(record => record.usage.totalTokens), [4, 6]);
  assert.equal(queryRequests(events, new URLSearchParams('page=999&pageSize=1000'), now, options).pageSize, 100);
  assert.equal(queryRequests(events, new URLSearchParams('page=0&pageSize=-2'), now, options).page, 1);
  assert.equal(queryRequests(events, new URLSearchParams('model=does-not-exist'), now, options).records.length, 0);
});

test('historical arbitrary strings, credentials and request bodies cannot enter public usage metadata', () => {
  const events = [entry(0, {
    model: 'sk-synthetic-secret', upstreamModel: 'unknown injected model', accountId: 'sk-synthetic-account-secret',
    headers: { Authorization: 'synthetic bearer secret' }, body: 'synthetic prompt secret', responseText: 'synthetic reply secret',
    failed: 'untrusted detailed failure text', usage: { totalTokens: 42, secret: 'synthetic usage secret', outputTokens: -1 },
  })];
  const records = publicRequestRecords(events, 4, now, options);
  assert.equal(records[0].model, 'unknown');
  assert.equal(records[0].upstreamModel, null);
  assert.equal(records[0].accountId, null);
  assert.equal(records[0].failed, 'upstream_error');
  assert.equal(records[0].usage.totalTokens, 42);
  assert.equal(records[0].usage.outputTokens, null);
  const exposed = JSON.stringify({ records, summary: summarizeRequests(events, 4, now, options) });
  assert.doesNotMatch(exposed, /synthetic|untrusted|Authorization|responseText|body/);
});

test('the requests endpoint uses safe metadata with bounded pagination and preserves local-origin checks', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-usage-test-'));
  const current = Date.now();
  const events = [entry(0, { at: new Date(current).toISOString(), usage: { totalTokens: 9 }, body: 'synthetic private input' })];
  const handle = createDashboard({ root, knownModels, getPoolStatus: () => ({ accounts: [] }), getService: () => ({}), readEvents: () => events, runner: { status: () => ({ running: false }) } });
  const server = http.createServer(async (req, res) => { if (!await handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\')); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${url}/dashboard/api/requests?model=model-a-ar&pageSize=2`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.total, 1);
  assert.equal(data.records[0].usage.totalTokens, 9);
  assert.ok(!JSON.stringify(data).includes('synthetic private input'));
  assert.equal((await fetch(`${url}/dashboard/api/requests`, { headers: { Origin: 'https://outside.example' } })).status, 403);
});
