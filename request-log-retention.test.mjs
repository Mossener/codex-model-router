import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateRequestLog, pruneRequestLogs, REQUEST_LOG_LIMIT_BYTES, REQUEST_LOG_KEEP_MS } from './router.mjs';
import { readEvents, requestLogNames } from './dashboard.mjs';

const now = Date.parse('2026-11-04T10:00:00Z');
const event = at => JSON.stringify({ at, route: 'agentrouter', model: 'model-a-ar', accountId: 'account_a', status: 200, ms: 10 });

function workspace() {
  return mkdtempSync(join(tmpdir(), 'gateway-log-'));
}

const oversized = () => 'x'.repeat(REQUEST_LOG_LIMIT_BYTES + 1) + '\n';

test('rotation keeps the old file as a timestamped shard instead of overwriting history', () => {
  const root = workspace();
  try {
    // 上一次轮转留下的分片，旧实现会把它覆盖掉。
    writeFileSync(join(root, 'requests-2026-11-03_08-00-00.jsonl'), event('2026-11-03T08:00:00Z') + '\n');
    writeFileSync(join(root, 'requests.jsonl'), oversized());
    rotateRequestLog(root, now);

    const names = readdirSync(root).sort();
    assert.deepEqual(names, ['requests-2026-11-03_08-00-00.jsonl', 'requests-2026-11-04_10-00-00.jsonl']);
    assert.equal(existsSync(join(root, 'requests.jsonl')), false);
    assert.equal(statSync(join(root, 'requests-2026-11-04_10-00-00.jsonl')).size, REQUEST_LOG_LIMIT_BYTES + 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two rotations inside the same second keep both shards', () => {
  const root = workspace();
  try {
    writeFileSync(join(root, 'requests.jsonl'), oversized());
    rotateRequestLog(root, now);
    writeFileSync(join(root, 'requests.jsonl'), oversized());
    rotateRequestLog(root, now + 5);
    assert.deepEqual(readdirSync(root).sort(), ['requests-2026-11-04_10-00-00-2.jsonl', 'requests-2026-11-04_10-00-00.jsonl']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shards older than the retention window are pruned and recent ones stay', () => {
  const root = workspace();
  try {
    const stale = join(root, 'requests-2026-10-20_09-00-00.jsonl');
    const fresh = join(root, 'requests-2026-11-03_09-00-00.jsonl');
    writeFileSync(stale, event('2026-10-20T09:00:00Z') + '\n');
    writeFileSync(fresh, event('2026-11-03T09:00:00Z') + '\n');
    writeFileSync(join(root, 'requests.jsonl'), event('2026-11-04T09:59:00Z') + '\n');
    const old = new Date(now - REQUEST_LOG_KEEP_MS - 3600000);
    utimesSync(stale, old, old);

    assert.equal(pruneRequestLogs(root, now), 1);
    assert.deepEqual(readdirSync(root).sort(), ['requests-2026-11-03_09-00-00.jsonl', 'requests.jsonl']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retention is a month, so an eight day old shard now survives', () => {
  const root = workspace();
  try {
    assert.equal(REQUEST_LOG_KEEP_MS, 30 * 24 * 60 * 60 * 1000);
    const week = join(root, 'requests-2026-10-27_09-00-00.jsonl');
    writeFileSync(week, event('2026-10-27T09:00:00Z') + '\n');
    const eightDays = new Date(now - 8 * 24 * 3600000);
    utimesSync(week, eightDays, eightDays);
    assert.equal(pruneRequestLogs(root, now), 0);
    assert.equal(existsSync(week), true);

    const monthOld = new Date(now - 31 * 24 * 3600000);
    utimesSync(week, monthOld, monthOld);
    assert.equal(pruneRequestLogs(root, now), 1);
    assert.equal(existsSync(week), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a small active log is left in place so appends stay cheap', () => {
  const root = workspace();
  try {
    writeFileSync(join(root, 'requests.jsonl'), event('2026-11-04T09:59:00Z') + '\n');
    rotateRequestLog(root, now);
    assert.deepEqual(readdirSync(root), ['requests.jsonl']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a legacy requests.previous.jsonl is migrated into a normal shard', () => {
  const root = workspace();
  try {
    const legacy = join(root, 'requests.previous.jsonl');
    writeFileSync(legacy, event('2026-11-04T08:00:00Z') + '\n');
    const mtime = new Date(now - 3600000);
    utimesSync(legacy, mtime, mtime);
    rotateRequestLog(root, now);
    assert.deepEqual(readdirSync(root), ['requests-2026-11-04_09-00-00.jsonl']);
    assert.equal(existsSync(legacy), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the dashboard merges every shard plus the active log, active file last', () => {
  const root = workspace();
  try {
    writeFileSync(join(root, 'requests.jsonl'), event('2026-11-04T09:59:00Z') + '\n');
    writeFileSync(join(root, 'requests-2026-11-02_07-00-00.jsonl'), event('2026-11-02T07:00:00Z') + '\n');
    writeFileSync(join(root, 'requests-2026-11-03_08-00-00.jsonl'), event('2026-11-03T08:00:00Z') + '\n');
    writeFileSync(join(root, 'notes.txt'), 'ignored');

    assert.deepEqual(requestLogNames(root), [
      'requests-2026-11-02_07-00-00.jsonl',
      'requests-2026-11-03_08-00-00.jsonl',
      'requests.jsonl',
    ]);
    const events = readEvents(root, 168, now);
    assert.deepEqual(events.map(entry => entry.at).sort(), [
      '2026-11-02T07:00:00Z', '2026-11-03T08:00:00Z', '2026-11-04T09:59:00Z',
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shards last written outside the window are skipped instead of parsed', () => {
  const root = workspace();
  try {
    const stale = join(root, 'requests-2026-10-20_09-00-00.jsonl');
    writeFileSync(stale, event('2026-10-20T09:00:00Z') + '\n');
    const old = new Date(now - 10 * 24 * 3600000);
    utimesSync(stale, old, old);
    writeFileSync(join(root, 'requests.jsonl'), event('2026-11-04T09:59:00Z') + '\n');

    assert.deepEqual(readEvents(root, 168, now).map(entry => entry.at), ['2026-11-04T09:59:00Z']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the parse cache follows the active file as it grows', () => {
  const root = workspace();
  try {
    const active = join(root, 'requests.jsonl');
    writeFileSync(active, event('2026-11-04T09:58:00Z') + '\n');
    assert.equal(readEvents(root, 4, now).length, 1);

    writeFileSync(active, event('2026-11-04T09:58:00Z') + '\n' + event('2026-11-04T09:59:30Z') + '\n');
    const events = readEvents(root, 4, now);
    assert.equal(events.length, 2);
    assert.ok(statSync(active).size > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
