import assert from 'node:assert/strict';
import test from 'node:test';

let createAccountPool;
let stableSessionKey;
try {
  ({ createAccountPool, stableSessionKey } = await import('./account-pool.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

test('the account-pool implementation is available', () => {
  assert.equal(typeof createAccountPool, 'function');
  assert.equal(typeof stableSessionKey, 'function');
});

const accounts = [
  { id: 'a', label: 'Account A', token: 'synthetic-token-a', enabled: true },
  { id: 'b', label: 'Account B', token: 'synthetic-token-b', enabled: true },
  { id: 'c', label: 'Account C', token: 'synthetic-token-c', enabled: true },
];
const session = id => ({ prompt_cache_key: id });
const throwsStatus = (action, code) => assert.throws(action, error => error.statusCode === code);

if (createAccountPool && stableSessionKey) {
  test('session identifiers retain punctuation, Unicode, whitespace and their complete length', () => {
    const keys = ['thread/a', 'threada', '会话:甲', ' thread/a ', 'x'.repeat(128) + 'a', 'x'.repeat(128) + 'b'];
    assert.equal(new Set(keys.map(key => stableSessionKey(session(key)))).size, 6);
    assert.equal(stableSessionKey(session(keys[4])), stableSessionKey(session(keys[4])));
  });

  test('session fields follow their documented priority and ignore nonstrings or blank values', () => {
    assert.equal(stableSessionKey({ prompt_cache_key: 'first', client_metadata: { session_id: 'second' } }), stableSessionKey(session('first')));
    assert.equal(stableSessionKey({ prompt_cache_key: ' ', client_metadata: { session_id: 'second' } }), stableSessionKey({ client_metadata: { session_id: 'second' } }));
    assert.equal(typeof stableSessionKey({ client_metadata: { conversation_id: 'third' } }), 'string');
    assert.equal(typeof stableSessionKey({ conversation: { id: 'fourth' } }), 'string');
    assert.equal(stableSessionKey({ prompt_cache_key: 7, client_metadata: { session_id: '' } }), null);
    assert.equal(stableSessionKey(null), null);
    assert.notEqual(stableSessionKey(session('same')), stableSessionKey({ client_metadata: { session_id: 'same' } }));
  });

  test('new sessions rotate through accounts and existing sessions stay pinned across models', () => {
    const pool = createAccountPool();
    assert.equal(pool.select(accounts, { ...session('one'), model: 'gpt-first-ar' }).account.id, 'a');
    assert.equal(pool.select(accounts, session('two')).account.id, 'b');
    assert.equal(pool.select(accounts, session('three')).account.id, 'c');
    assert.equal(pool.select(accounts, session('four')).account.id, 'a');
    const repeat = pool.select(accounts, { ...session('one'), model: 'gpt-other-ar' });
    assert.equal(repeat.account.id, 'a');
    assert.equal(repeat.pinned, true);
    assert.equal(repeat.sessionKey, stableSessionKey(session('one')));
  });

  test('each fallback session field binds repeated turns without merging distinct identifiers', () => {
    const fields = [id => ({ client_metadata: { session_id: id } }), id => ({ client_metadata: { conversation_id: id } }), id => ({ conversation: { id } })];
    for (const field of fields) {
      const pool = createAccountPool();
      assert.equal(pool.select(accounts, field('first')).account.id, 'a');
      assert.equal(pool.select(accounts, field('second')).account.id, 'b');
      assert.equal(pool.select(accounts, field('first')).account.id, 'a');
      assert.equal(pool.select(accounts, field('first')).pinned, true);
    }
  });

  test('concurrent requests for a new session reserve only one account synchronously', async () => {
    const pool = createAccountPool();
    const selections = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => pool.select(accounts, session('parallel')))));
    assert.deepEqual(selections.map(selected => selected.account.id), Array(20).fill('a'));
    assert.equal(selections.filter(selected => !selected.pinned).length, 1);
    assert.equal(pool.select(accounts, session('next')).account.id, 'b');
  });

  test('response ownership takes priority and updates the session binding for later turns', () => {
    const pool = createAccountPool();
    pool.select(accounts, session('one'));
    pool.rememberResponse('resp_b', 'b');
    const selected = pool.select(accounts, { ...session('one'), previous_response_id: 'resp_b' });
    assert.equal(selected.account.id, 'b');
    assert.equal(selected.pinned, true);
    assert.equal(pool.select(accounts, session('one')).account.id, 'b');
  });

  test('an unknown response ID fails instead of choosing another configured account', () => {
    const pool = createAccountPool();
    throwsStatus(() => pool.select(accounts, { previous_response_id: 'resp_unknown' }), 409);
    pool.select(accounts, session('bound'));
    throwsStatus(() => pool.select(accounts, { ...session('bound'), previous_response_id: 'resp_unknown' }), 409);
  });

  test('a single configured account accepts an unknown response ID for compatibility', () => {
    const selected = createAccountPool().select(accounts.slice(0, 1), { previous_response_id: 'resp_unknown' });
    assert.equal(selected.account.id, 'a');
  });

  for (const unavailable of ['disabled', 'removed']) {
    test(`${unavailable} session bindings reselect by round robin for a later self-contained request`, () => {
      const pool = createAccountPool();
      assert.equal(pool.select(accounts, { ...session('bound'), model: 'gpt-first-ar' }).account.id, 'a');
      const rows = unavailable === 'removed' ? accounts.slice(1)
        : [{ ...accounts[0], enabled: false }, ...accounts.slice(1)];
      const selected = pool.select(rows, { ...session('bound'), model: 'gpt-other-ar', input: 'Complete history supplied by client' });
      assert.equal(selected.account.id, 'c', 'reselection must use the existing round-robin position');
      assert.equal(selected.pinned, false);
      assert.equal(selected.aff, 'new', 'a lost owner is replaced, not borrowed around');
      assert.equal(pool.select(rows, session('bound')).account.id, 'c');
      assert.equal(pool.select(accounts, session('bound')).account.id, 'c', 'restoring the old account must not move the rebound session');
    });
  }

  test('a derived thread key pins payloads that carry no session identity', () => {
    const pool = createAccountPool();
    const payload = { model: 'gpt-first-ar', input: 'Complete history supplied by client' };
    const first = pool.select(accounts, payload, { affinity: 'thread-digest-a' });
    assert.equal(first.aff, 'new');
    assert.equal(pool.select(accounts, { ...payload, model: 'gpt-other-ar' }, { affinity: 'thread-digest-a' }).account.id, first.account.id, 'a model switch keeps the thread on its account');
    assert.notEqual(pool.select(accounts, payload, { affinity: 'thread-digest-b' }).account.id, first.account.id, 'a different thread must not reuse the same account');
    assert.equal(pool.select(accounts, payload).account.id, first.account.id, 'without a derived key the old selection order still applies');
  });

  test('a client session key takes priority over a derived thread key', () => {
    const pool = createAccountPool();
    const pinned = pool.select(accounts, session('one'), { affinity: 'thread-digest-a' });
    assert.equal(pool.select(accounts, session('one'), { affinity: 'thread-digest-b' }).account.id, pinned.account.id);
  });

  test('a cooling owner is borrowed around and the thread returns home when it reopens', () => {
    let time = 1000000;
    const pool = createAccountPool({ cooldownMs: 60000, now: () => time });
    assert.equal(pool.select(accounts, session('bound')).aff, 'new');
    pool.observeFailure('a', 401, 'Invalid API key');
    const borrowed = pool.select(accounts, session('bound'));
    assert.equal(borrowed.pinned, false);
    assert.notEqual(borrowed.account.id, 'a');
    assert.equal(borrowed.aff, 'away', 'a borrowed account is not a new binding');
    assert.notEqual(pool.select(accounts, session('bound')).account.id, 'a', 'the borrowed account must never be promoted to home');
    time += 61000;
    const home = pool.select(accounts, session('bound'));
    assert.equal(home.account.id, 'a', 'once the owner reopens the thread returns to its warm prompt cache');
    assert.equal(home.pinned, true);
    assert.equal(home.aff, 'home');
  });

  test('a server failure backs the account off without disabling or hiding it', () => {
    let time = 1000000;
    const pool = createAccountPool({ now: () => time });
    pool.observeFailure('a', 500, 'upstream connect error or disconnect/reset before headers');
    assert.equal(pool.status(accounts).availableCount, 3, 'a 5xx must never disable or cool down an account');
    assert.deepEqual([0, 1, 2].map(index => pool.select(accounts, session(`s${index}`)).account.id), ['b', 'c', 'b'], 'the failing account leaves the rotation for its backoff window');
    time += 15000;
    assert.equal(new Set([0, 1, 2].map(index => pool.select(accounts, session(`t${index}`)).account.id)).size, 3, 'the account returns once the window passes');
  });

  test('repeated server failures escalate the backoff up to its cap', () => {
    let time = 1000000;
    const pool = createAccountPool({ now: () => time });
    for (let attempt = 0; attempt < 6; attempt += 1) pool.observeFailure('a', 503, 'server_error');
    time += 239000;
    assert.deepEqual([0, 1, 2].map(index => pool.select(accounts, session(`s${index}`)).account.id), ['b', 'c', 'b'], 'five failures buy the longest window');
    time += 2000;
    assert.equal(new Set([0, 1, 2].map(index => pool.select(accounts, session(`t${index}`)).account.id)).size, 3);
    pool.clearFailure('a');
    assert.equal(pool.select(accounts, session('after')).account.id, 'a', 'a success clears the streak');
  });

  test('a broken home is borrowed around and keeps its thread while backing off', () => {
    let time = 1000000;
    const pool = createAccountPool({ now: () => time });
    assert.equal(pool.select(accounts, session('thread')).account.id, 'a');
    pool.observeFailure('a', 503, 'service unavailable');
    const borrowed = pool.select(accounts, session('thread'));
    assert.notEqual(borrowed.account.id, 'a');
    assert.equal(borrowed.aff, 'away', 'a backing-off home is borrowed around, never replaced');
    time += 15000;
    const home = pool.select(accounts, session('thread'));
    assert.equal(home.account.id, 'a', 'the thread returns to its warm prompt cache once the window passes');
    assert.equal(home.aff, 'home');
  });

  test('an edge 502 never backs an account off', () => {
    let time = 1000000;
    const pool = createAccountPool({ now: () => time });
    // The pool-wide failure rate for these is flat, so the router resends them
    // on the same account rather than moving the thread's cache elsewhere.
    pool.observeFailure('a', 502, 'upstream connect error or disconnect/reset before headers');
    pool.observeFailure('b', 504, 'upstream request timeout');
    assert.equal(pool.select(accounts, session('one')).account.id, 'a');
    assert.equal(pool.select(accounts, session('two')).account.id, 'b');
    assert.equal(pool.status(accounts).availableCount, 3);
  });

  test('a site-wide limit answer never backs an account off', () => {
    let time = 1000000;
    const pool = createAccountPool({ now: () => time });
    pool.observeFailure('a', 500, '{"error":{"message":"Budget pool exhausted: upstream channels have insufficient quota."}}');
    pool.observeFailure('b', 500, 'token rate limit reached');
    assert.equal(pool.select(accounts, session('one')).account.id, 'a', 'a shared supply error is identical on every account');
    assert.equal(pool.select(accounts, session('two')).account.id, 'b');
  });

  for (const unavailable of ['disabled', 'removed', 'cooling']) {
    test(`${unavailable} response owners cannot be rebound even after their session moves`, () => {
      const pool = createAccountPool();
      pool.select(accounts, session('bound'));
      pool.rememberResponse('resp_a', 'a');
      const rows = unavailable === 'removed' ? accounts.slice(1)
        : unavailable === 'disabled' ? [{ ...accounts[0], enabled: false }, ...accounts.slice(1)] : accounts;
      if (unavailable === 'cooling') pool.observeFailure('a', 401, 'Invalid API key');
      throwsStatus(() => pool.select(rows, { ...session('bound'), previous_response_id: 'resp_a' }), 503);
      assert.equal(pool.select(rows, session('bound')).account.id, 'c');
      throwsStatus(() => pool.select(rows, { ...session('bound'), previous_response_id: 'resp_a' }), 503);
    });
  }

  test('blank server-history fields permit self-contained session reselection', () => {
    for (const conversation of [undefined, '', '  ', {}, { id: ' ' }]) {
      const pool = createAccountPool();
      pool.select(accounts, session('bound'));
      pool.observeFailure('a', 401, 'Invalid API key');
      assert.equal(pool.select(accounts, { ...session('bound'), previous_response_id: ' ', conversation }).account.id, 'c');
    }
  });

  test('an all-disabled pool discards the stale self-contained binding and returns 503', () => {
    const pool = createAccountPool();
    pool.select(accounts, session('bound'));
    throwsStatus(() => pool.select(accounts.map(row => ({ ...row, enabled: false })), session('bound')), 503);
    const selected = pool.select(accounts, session('bound'));
    assert.equal(selected.account.id, 'b');
    assert.equal(selected.pinned, false);
  });

  test('service conversation ownership survives session-key changes and both reference forms', () => {
    const pool = createAccountPool();
    pool.select(accounts, { ...session('one'), conversation: 'conv_service' });
    pool.select(accounts, session('two'));
    const selected = pool.select(accounts, { ...session('two'), conversation: { id: 'conv_service' } });
    assert.equal(selected.account.id, 'a');
    assert.equal(selected.pinned, true);
    assert.equal(pool.select(accounts, session('two')).account.id, 'a');
    assert.equal(pool.select(accounts, { conversation: 'conv_service' }).account.id, 'a');
  });

  for (const unavailable of ['disabled', 'removed', 'cooling']) {
    for (const conversation of ['conv_service', { id: 'conv_service' }]) {
      test(`${unavailable} service conversation owners fail without migrating (${typeof conversation})`, () => {
        const pool = createAccountPool();
        pool.select(accounts, { ...session('original'), conversation });
        const rows = unavailable === 'removed' ? accounts.slice(1)
          : unavailable === 'disabled' ? [{ ...accounts[0], enabled: false }, ...accounts.slice(1)] : accounts;
        if (unavailable === 'cooling') pool.observeFailure('a', 401, 'Invalid API key');
        throwsStatus(() => pool.select(rows, { ...session('changed'), conversation }), 503);
        assert.equal(pool.select(rows, session('independent')).account.id, 'c');
      });
    }
  }

  test('blank, disabled and duplicate keys cannot receive new sessions', () => {
    const configured = [
      { id: 'empty', token: '   ', enabled: true },
      { id: 'disabled', token: 'synthetic-token-a', enabled: false },
      accounts[0],
      { id: 'duplicate', token: ' synthetic-token-a ', enabled: true },
      accounts[1],
    ];
    const pool = createAccountPool();
    assert.equal(pool.select(configured, session('one')).account.id, 'a');
    assert.equal(pool.select(configured, session('two')).account.id, 'b');
    const report = pool.status(configured);
    assert.equal(report.configuredCount, 2);
    assert.equal(report.availableCount, 2);
    assert.equal(report.accounts.find(account => account.id === 'empty').keyConfigured, false);
    assert.equal(report.accounts.find(account => account.id === 'disabled').enabled, false);
    assert.equal(report.accounts.find(account => account.id === 'duplicate').duplicate, true);
    assert.equal(report.accounts.find(account => account.id === 'duplicate').available, false);
  });

  test('no configured or available accounts produces a local 503', () => {
    const pool = createAccountPool();
    throwsStatus(() => pool.select([], session('one')), 503);
    throwsStatus(() => pool.select([{ id: 'empty', token: '' }], {}), 503);
    pool.observeFailure('a', 401, 'Invalid API key');
    throwsStatus(() => pool.select(accounts.slice(0, 1), session('one')), 503);
  });

  test('requests without a stable session conservatively use the first available key', () => {
    const pool = createAccountPool();
    for (let i = 0; i < 5; i++) {
      const selected = pool.select(accounts, { input: 'Synthetic input' });
      assert.equal(selected.account.id, 'a');
      assert.equal(selected.sessionKey, null);
    }
    assert.equal(pool.select(accounts, session('new')).account.id, 'a');
    pool.observeFailure('a', 401, 'API key has expired');
    assert.equal(pool.select(accounts, {}).account.id, 'b');
  });

  test('explicit invalid or expired account keys cool down without retaining upstream text', () => {
    for (const [status, text] of [[401, 'Invalid API key'], [403, 'API key has expired'], [401, '无效的令牌'], [401, '{"error":{"message":"Incorrect API key provided: synthetic-secret-value"}}']]) {
      let time = 1000;
      const pool = createAccountPool({ now: () => time });
      pool.observeFailure('a', status, text);
      const report = pool.status(accounts);
      assert.equal(report.availableCount, 2);
      assert.equal(report.accounts[0].reason, 'invalid_key');
      assert.equal(report.accounts[0].cooldownUntil, 1801000);
      assert.equal(JSON.stringify(report).includes('synthetic-secret-value'), false);
      time = 1801000;
      assert.equal(pool.status(accounts).availableCount, 3);
    }
  });

  test('explicit account balance errors permanently disable only that account', () => {
    for (const [status, text] of [[402, 'Your account balance is insufficient'], [403, 'Your account has insufficient balance'], [403, 'insufficient user quota'], [403, '用户余额不足'], [403, '账户额度已用尽']]) {
      const pool = createAccountPool({ now: () => 2000, cooldownMs: 500 });
      pool.observeFailure('a', status, text);
      const report = pool.status(accounts);
      assert.equal(report.accounts[0].reason, 'insufficient_balance');
      assert.equal(report.accounts[0].cooldownUntil, null);
      assert.equal(report.accounts[0].enabled, false);
      assert.equal(report.accounts[0].disabledReason, 'insufficient_balance');
      assert.equal(report.accounts[1].available, true);
    }
  });

  test('client restrictions, shared supply limits and ambiguous errors do not disable accounts', () => {
    for (const [status, text] of [
      [401, 'unauthorized client detected'],
      [401, 'Invalid API key: unauthorized_client_detected'],
      [401, 'Unauthorized'],
      [429, 'Your account balance is insufficient'],
      [429, 'token rate limit exceeded'],
      [402, 'Budget pool quota has been exhausted'],
      [403, 'Budget pool quota has been exhausted; user quota is insufficient'],
      [500, 'Upstream account balance is insufficient'],
      [403, '上游账户余额不足'],
      [403, 'quota exceeded'],
    ]) {
      const pool = createAccountPool();
      pool.observeFailure('a', status, text);
      assert.equal(pool.status(accounts).availableCount, 3, `${status}: ${text}`);
    }
  });

  test('cooling a response owner preserves its response chain while self-contained turns can move', () => {
    const pool = createAccountPool();
    pool.select(accounts, session('bound'));
    pool.rememberResponse('resp_a', 'a');
    pool.observeFailure('a', 403, '用户余额不足');
    assert.equal(pool.select(accounts, session('bound')).account.id, 'c');
    throwsStatus(() => pool.select(accounts, { previous_response_id: 'resp_a' }), 503);
    assert.equal(pool.select(accounts, session('new')).account.id !== 'a', true);
  });

  test('unknown response IDs remain ambiguous when multiple keys exist but only one is available', () => {
    const pool = createAccountPool();
    pool.observeFailure('a', 401, 'Invalid API key');
    throwsStatus(() => pool.select(accounts.slice(0, 2), { previous_response_id: 'resp_unknown' }), 409);
  });

  test('cooldown expires at its deadline and restores the original pinned account', () => {
    let time = 1000;
    const pool = createAccountPool({ now: () => time, cooldownMs: 100 });
    pool.select(accounts, session('bound'));
    pool.rememberResponse('resp_a', 'a');
    pool.observeFailure('a', 401, 'Invalid API key');
    time = 1099;
    throwsStatus(() => pool.select(accounts, { ...session('bound'), previous_response_id: 'resp_a' }), 503);
    time = 1100;
    assert.equal(pool.select(accounts, { ...session('bound'), previous_response_id: 'resp_a' }).account.id, 'a');
    assert.equal(pool.status(accounts).accounts[0].cooldownUntil, null);
  });

  test('session affinity expires after inactivity and active sessions renew their TTL', () => {
    let time = 0;
    const pool = createAccountPool({ now: () => time, ttlMs: 100 });
    pool.select(accounts, session('active'));
    time = 90;
    assert.equal(pool.select(accounts, session('active')).pinned, true);
    time = 150;
    assert.equal(pool.select(accounts, session('active')).pinned, true);
    time = 250;
    const expired = pool.select(accounts, session('active'));
    assert.equal(expired.pinned, false);
    assert.equal(expired.account.id, 'b');
  });

  test('response ownership expires after inactivity and unknown chains then fail', () => {
    let time = 0;
    const pool = createAccountPool({ now: () => time, ttlMs: 100 });
    pool.rememberResponse('resp_b', 'b');
    time = 90;
    assert.equal(pool.select(accounts, { previous_response_id: 'resp_b' }).account.id, 'b');
    time = 190;
    throwsStatus(() => pool.select(accounts, { previous_response_id: 'resp_b' }), 409);
  });

  test('service conversation ownership uses bounded sliding TTL affinity', () => {
    let time = 0;
    const pool = createAccountPool({ now: () => time, ttlMs: 100, maxEntries: 2 });
    pool.select(accounts, { ...session('one'), conversation: 'conv_one' });
    pool.select(accounts, { ...session('two'), conversation: 'conv_two' });
    time = 90;
    assert.equal(pool.select(accounts, { conversation: { id: 'conv_one' } }).account.id, 'a');
    pool.select(accounts, { ...session('three'), conversation: 'conv_three' });
    assert.equal(pool.select(accounts, { conversation: 'conv_one' }).pinned, true);
    assert.equal(pool.select(accounts, { conversation: 'conv_two' }).pinned, false, 'inactive conversation should be evicted');
    time = 190;
    assert.equal(pool.select(accounts, { conversation: 'conv_two' }).pinned, false, 'ownership expires at the sliding deadline');
  });

  test('bounded response ownership evicts the least recently used entry', () => {
    const pool = createAccountPool({ maxEntries: 2 });
    pool.rememberResponse('resp_a', 'a');
    pool.rememberResponse('resp_b', 'b');
    pool.select(accounts, { previous_response_id: 'resp_a' });
    pool.rememberResponse('resp_c', 'c');
    throwsStatus(() => pool.select(accounts, { previous_response_id: 'resp_b' }), 409);
    assert.equal(pool.select(accounts, { previous_response_id: 'resp_a' }).account.id, 'a');
    assert.equal(pool.select(accounts, { previous_response_id: 'resp_c' }).account.id, 'c');
  });

  test('bounded session ownership evicts inactive sessions while retaining recently used ones', () => {
    const pool = createAccountPool({ maxEntries: 2 });
    pool.select(accounts, session('one'));
    pool.select(accounts, session('two'));
    pool.select(accounts, session('one'));
    pool.select(accounts, session('three'));
    assert.equal(pool.select(accounts, session('one')).pinned, true);
    assert.equal(pool.select(accounts, session('two')).pinned, false);
  });

  test('status exposes only approved account metadata and never tokens or token fragments', () => {
    const pool = createAccountPool();
    pool.observeFailure('a', 401, 'Invalid API key synthetic-token-a');
    const report = pool.status(accounts);
    assert.deepEqual(Object.keys(report).sort(), ['accounts', 'availableCount', 'configuredCount']);
    for (const account of report.accounts) {
      assert.deepEqual(Object.keys(account).sort(), ['available', 'cooldownUntil', 'disabledAt', 'disabledReason', 'duplicate', 'enabled', 'id', 'keyConfigured', 'label', 'reason']);
    }
    assert.equal(JSON.stringify(report).includes('synthetic-token'), false);
    assert.equal(JSON.stringify(report).includes('Invalid API key'), false);
  });
}
