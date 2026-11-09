// Upstream prompt caching only answers with the leading bytes it has already
// seen, so the question a cache metric has to answer per request is how much of
// this replay the thread already sent. Keeping the head of the last replay makes
// that a number in the request log, which separates a prefix the router moved
// from a branch that never had a warm prefix to begin with.
const defaultTtlMs = 15 * 60 * 1000;
const defaultHeadBytes = 512 * 1024;
const defaultMaxEntries = 64;
const blockBytes = 64 * 1024;

export function sharedPrefixLength(left, right) {
  if (!left || !right) return 0;
  const limit = Math.min(left.length, right.length);
  let offset = 0;
  while (offset < limit) {
    const end = Math.min(offset + blockBytes, limit);
    if (left.compare(right, offset, end, offset, end) !== 0) break;
    offset = end;
  }
  // Only the first differing block is walked byte by byte; everything before it
  // matched a whole 64 KiB at a time.
  if (offset >= limit) return limit;
  let exact = offset;
  const end = Math.min(offset + blockBytes, limit);
  while (exact < end && left[exact] === right[exact]) exact += 1;
  return exact;
}

export function createPrefixTracker({ ttlMs = defaultTtlMs, headBytes = defaultHeadBytes, maxEntries = defaultMaxEntries } = {}) {
  const heads = new Map();
  return {
    // Returns the bytes shared with this key's previous replay, or null when the
    // thread has none on record (first turn, or the record aged out). Null and 0
    // are different answers: 0 means the prefix moved.
    measure(key, body, now = Date.now()) {
      if (typeof key !== 'string' || !key || !body || !body.length) return null;
      for (const [id, entry] of heads) if (entry.expiresAt <= now) heads.delete(id);
      const previous = heads.get(key);
      const head = Buffer.from(body.subarray(0, headBytes));
      heads.delete(key);
      heads.set(key, { head, expiresAt: now + ttlMs });
      while (heads.size > maxEntries) heads.delete(heads.keys().next().value);
      return previous ? sharedPrefixLength(previous.head, head) : null;
    },
    get size() {
      return heads.size;
    },
  };
}
