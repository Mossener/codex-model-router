import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrefixTracker, sharedPrefixLength } from './prefix-reuse.mjs';

test('sharedPrefixLength reports the exact byte where two replays diverge', () => {
  assert.equal(sharedPrefixLength(Buffer.from('abcdef'), Buffer.from('abcdef')), 6);
  assert.equal(sharedPrefixLength(Buffer.from('abcdef'), Buffer.from('abcXef')), 3);
  assert.equal(sharedPrefixLength(Buffer.from('abcdef'), Buffer.from('Xbcdef')), 0);
  assert.equal(sharedPrefixLength(Buffer.from('abc'), Buffer.from('abcdef')), 3, 'the shorter replay is the limit');
  assert.equal(sharedPrefixLength(Buffer.alloc(0), Buffer.from('abcdef')), 0);
  assert.equal(sharedPrefixLength(null, Buffer.from('abcdef')), 0);
});

test('a divergence after a whole block is still reported at the byte', () => {
  const block = 64 * 1024;
  const left = Buffer.alloc(block * 3, 7);
  const right = Buffer.from(left);
  right[block + 1234] = 9;
  assert.equal(sharedPrefixLength(left, right), block + 1234);
});

test('a first replay has nothing to share, a repeat shares its whole head', () => {
  const tracker = createPrefixTracker();
  const body = Buffer.from('x'.repeat(5000));
  assert.equal(tracker.measure('thread-a', body, 1000), null, 'cold start is null, not zero');
  assert.equal(tracker.measure('thread-a', body, 1001), 5000);
  // A thread that rewrites its opening bytes moved the prefix and scores zero.
  assert.equal(tracker.measure('thread-a', Buffer.from(`y${'x'.repeat(4999)}`), 1002), 0);
  assert.equal(tracker.measure('thread-b', body, 1003), null, 'threads do not share a head');
});

test('a replay that only grew shares everything up to the previous length', () => {
  const tracker = createPrefixTracker();
  const head = 'grow'.repeat(2000);
  tracker.measure('thread-grow', Buffer.from(head), 10);
  assert.equal(tracker.measure('thread-grow', Buffer.from(`${head}${'tail'.repeat(500)}`), 11), head.length);
});

test('a stale head is forgotten and only the newest are kept', () => {
  const tracker = createPrefixTracker({ ttlMs: 10, maxEntries: 2 });
  const body = Buffer.from('same');
  tracker.measure('thread-ttl', body, 0);
  assert.equal(tracker.measure('thread-ttl', body, 5), 4);
  assert.equal(tracker.measure('thread-ttl', body, 100), null, 'the record aged out');
  tracker.measure('thread-1', body, 200);
  tracker.measure('thread-2', body, 201);
  tracker.measure('thread-3', body, 202);
  assert.equal(tracker.size, 2);
});

test('only a bounded head is retained per thread', () => {
  const tracker = createPrefixTracker({ headBytes: 16 });
  tracker.measure('thread-head', Buffer.from('0123456789abcdefZZZZ'), 0);
  assert.equal(tracker.measure('thread-head', Buffer.from('0123456789abcdefYYYY'), 1), 16, 'the tail is not part of the head');
});

test('a request without a thread identity is not tracked', () => {
  const tracker = createPrefixTracker();
  assert.equal(tracker.measure(undefined, Buffer.from('body')), null);
  assert.equal(tracker.measure('', Buffer.from('body')), null);
  assert.equal(tracker.measure('thread-empty', Buffer.alloc(0)), null);
  assert.equal(tracker.size, 0);
});
