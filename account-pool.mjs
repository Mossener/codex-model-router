// Keep complete identifiers: sanitizing or truncating them can merge unrelated chats.
export function stableSessionKey(payload) {
  const candidates = [
    ['prompt_cache_key', payload?.prompt_cache_key],
    ['client_metadata.session_id', payload?.client_metadata?.session_id],
    ['client_metadata.conversation_id', payload?.client_metadata?.conversation_id],
    ['conversation.id', payload?.conversation?.id],
  ];
  for (const [field, value] of candidates) {
    if (typeof value === 'string' && value.trim()) return JSON.stringify([field, value]);
  }
  return null;
}

// Codex sends none of the fields above, so without a fallback every turn of every
// thread lands on the same account and each rotation throws the upstream prompt
// cache away. The router hashes the parts of the request that cannot change while
// a thread grows and passes that digest in; keeping it in its own namespace means
// a client-provided key is never confused with a derived one.
export function derivedSessionKey(value) {
  return typeof value === 'string' && value ? JSON.stringify(['thread', value]) : null;
}

function boundedAffinity(ttlMs, maxEntries) {
  const entries = new Map();
  return {
    get(key, time) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.expiresAt <= time) return undefined;
      // Sliding expiry and LRU retain active conversations when the pool is busy.
      entries.set(key, { accountId: entry.accountId, expiresAt: time + ttlMs });
      return entry.accountId;
    },
    set(key, accountId, time) {
      for (const [id, entry] of entries) {
        if (entry.expiresAt <= time) entries.delete(id);
      }
      entries.delete(key);
      entries.set(key, { accountId, expiresAt: time + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    delete(key) {
      entries.delete(key);
    },
  };
}

function conversationReference(payload) {
  const value = typeof payload?.conversation === 'string' ? payload.conversation : payload?.conversation?.id;
  return typeof value === 'string' && value.trim() ? value : null;
}

function poolError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function failureReason(status, text) {
  const code = Number(status);
  const message = typeof text === 'string' ? text : '';
  // These describe client eligibility or shared supply, rather than one API key.
  if (code === 429 || /unauthorized[ _-]+client|unsupported[ _-]+client|budget[ _-]+pool[ _-]+quota|token rate limit|rate limit|too many requests|upstream|上游|站点.*(?:余额|额度|配额)/i.test(message)) return null;

  const invalidKey = /(?:api[- _]?key|access[- _]?token|\btoken\b)[^.\n]{0,80}(?:invalid|expired|revoked|incorrect)|(?:invalid|expired|revoked|incorrect)[^.\n]{0,80}(?:api[- _]?key|access[- _]?token|\btoken\b)|(?:无效|失效|过期|撤销)的?(?:API\s*Key|密钥|令牌)|(?:API\s*Key|密钥|令牌).{0,12}(?:无效|失效|过期|撤销)/i;
  if ([401, 403].includes(code) && invalidKey.test(message)) return 'invalid_key';

  const insufficientBalance = /(?:your|user|account)[^.\n]{0,40}(?:balance|quota|credits?)[^.\n]{0,40}(?:insufficient|exhausted|not enough|depleted)|(?:user|account)[^.\n]{0,40}(?:insufficient|exhausted|not enough|depleted)[^.\n]{0,40}(?:balance|quota|credits?)|insufficient\s+(?:user|account)\s+(?:balance|quota|credits?)|(?:用户|账户|账号).{0,12}(?:余额|额度|配额).{0,12}(?:不足|耗尽|用尽)/i;
  if ((code === 200 || code >= 400) && insufficientBalance.test(message.replace(/[_-]/g, ' '))) return 'insufficient_balance';
  return null;
}

// Server-side and transport failures say nothing about the key, but they do say
// the account is a poor choice for the next few seconds: a 502 usually costs a
// full prompt upload before it is refused. Text that describes a site-wide limit
// is excluded, because those answers are identical on every account and rotating
// away from one would only add a second refusal.
function transportFailure(status, text) {
  const code = Number(status) || 0;
  const message = typeof text === 'string' ? text : '';
  if (code === 429 || /budget[ _-]+pool|unauthorized[ _-]+client|unsupported[ _-]+client|token rate limit|rate limit|too many requests/i.test(message)) return false;
  // 502/504 are answered by the shared edge in front of every account, and the
  // measured failure rate for them is flat across the whole pool. Backing one
  // account off would only move the next turn onto a cold prompt cache, so the
  // router resends those on the same account instead.
  if (code === 502 || code === 504) return false;
  return code >= 500 || code === 0 || /timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|socket hang|aborted|disconnect|server[ _-]?error|overloaded/i.test(message);
}

export function createAccountPool({
  ttlMs = 24 * 60 * 60 * 1000,
  maxEntries = 10000,
  cooldownMs = 30 * 60 * 1000,
  now = Date.now,
  onAutoDisable,
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be positive.');
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer.');
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new RangeError('cooldownMs must be nonnegative.');
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  const sessions = boundedAffinity(ttlMs, maxEntries);
  const responses = boundedAffinity(ttlMs, maxEntries);
  const conversations = boundedAffinity(ttlMs, maxEntries);
  const cooldowns = new Map();
  const balanceDisabled = new Map();
  const sourceEnabled = new Map();
  // A 5xx or a dropped stream is rarely permanent, but repeating it costs a
  // full prompt upload every time. Back the failing account off instead of
  // handing it the next turn: 15s, 30s, 60s, 120s, then 240s. Unlike a
  // cooldown this never empties the pool, because selection only uses it to
  // reorder candidates (see select).
  const failures = new Map();
  const breakerBaseMs = 15 * 1000;
  const breakerMaxMs = 240 * 1000;
  const breakerBackoff = count => Math.min(breakerBaseMs * 2 ** Math.max(0, count - 1), breakerMaxMs);
  let nextAccount = 0;

  function breakerOpen(id, time) {
    const streak = failures.get(id);
    return Boolean(streak) && time < streak.at + breakerBackoff(streak.count);
  }

  function configuredAccounts(accounts, time) {
    for (const [id, cooldown] of cooldowns) {
      if (cooldown.until <= time) cooldowns.delete(id);
    }
    for (const [id, streak] of failures) {
      if (time - streak.at > breakerMaxMs * 2) failures.delete(id);
    }
    const tokens = new Set();
    const ids = new Set();
    return (Array.isArray(accounts) ? accounts : []).map(source => {
      const id = typeof source?.id === 'string' ? source.id : '';
      const label = typeof source?.label === 'string' ? source.label : id;
      const token = typeof source?.token === 'string' ? source.token.trim() : '';
      const sourceIsEnabled = source?.enabled !== false;
      // A user may also re-enable an account by editing the manifest. Observe
      // that transition so the in-memory refusal does not overrule their choice.
      if (sourceIsEnabled && sourceEnabled.get(id) === false) balanceDisabled.delete(id);
      sourceEnabled.set(id, sourceIsEnabled);
      const autoDisabled = balanceDisabled.get(id);
      const enabled = sourceIsEnabled && !autoDisabled;
      const keyConfigured = Boolean(token);
      const duplicate = enabled && keyConfigured && Boolean(id) && (tokens.has(token) || ids.has(id));
      const configured = enabled && keyConfigured && Boolean(id) && !duplicate;
      if (configured) { tokens.add(token); ids.add(id); }
      const cooldown = cooldowns.get(id);
      const reason = autoDisabled ? 'insufficient_balance' : !enabled ? 'disabled' : !keyConfigured ? 'missing_key' : !id ? 'missing_id' : duplicate ? 'duplicate_key' : cooldown?.reason ?? null;
      const disabledReason = !enabled && ['low_balance', 'insufficient_balance'].includes(source?.disabledReason) ? source.disabledReason : autoDisabled ? 'insufficient_balance' : null;
      const disabledAt = typeof source?.disabledAt === 'string' && Number.isFinite(Date.parse(source.disabledAt)) ? source.disabledAt : autoDisabled?.at ?? null;
      return {
        account: { id, label, token, enabled },
        configured,
        public: {
          id, label, enabled, keyConfigured, duplicate,
          available: configured && !cooldown,
          cooldownUntil: cooldown?.until ?? null,
          reason, disabledReason, disabledAt,
        },
      };
    });
  }

  // Only a later self-contained request can discard unavailable session affinity.
  // Server-stored history keeps its owner even when that account is unavailable.
  function pinnedAccount(records, id, canRebind = false, exclude = null) {
    const record = records.find(item => item.account.id === id);
    const blocked = !record?.public.available || Boolean(exclude?.has(id));
    if (blocked) {
      if (canRebind) return null;
      throw poolError(503, 'The account that owns this server-stored conversation is unavailable. Restore it or wait for its cooldown; server-stored history cannot switch accounts.');
    }
    return record.account;
  }

  return {
    select(accounts, payload, { exclude, affinity } = {}) {
      const time = now();
      const skipped = exclude instanceof Set ? exclude : new Set(Array.isArray(exclude) ? exclude : []);
      const records = configuredAccounts(accounts, time);
      const configured = records.filter(record => record.configured);
      // An account inside its failure backoff is only avoided, never refused:
      // the avoid set feeds the same borrowing path as a throttle window.
      const avoided = new Set([...skipped, ...records.filter(record => record.configured && breakerOpen(record.account.id, time)).map(record => record.account.id)]);
      // A client key always wins; a derived thread key only fills the gap, and only
      // when the request carries no server-stored history that pins it already.
      const sessionKey = stableSessionKey(payload) ?? derivedSessionKey(affinity);
      const previousId = typeof payload?.previous_response_id === 'string' && payload.previous_response_id.trim() ? payload.previous_response_id : null;
      const conversationId = conversationReference(payload);
      const canRebind = !previousId && !conversationId;
      const bind = account => {
        if (sessionKey) sessions.set(sessionKey, account.id, time);
        if (conversationId) conversations.set(conversationId, account.id, time);
      };
      if (previousId) {
        const accountId = responses.get(previousId, time);
        if (accountId !== undefined) {
          const account = pinnedAccount(records, accountId);
          bind(account);
          return { account, sessionKey, pinned: true };
        }
        // Cooling keys still count: the unknown response may belong to one of them.
        else if (configured.length >= 2) {
          throw poolError(409, 'The previous response belongs to an unknown account. Start a new conversation instead of continuing it on a different account.');
        }
      }
      if (conversationId) {
        const accountId = conversations.get(conversationId, time);
        if (accountId !== undefined) {
          const account = pinnedAccount(records, accountId);
          bind(account);
          return { account, sessionKey, pinned: true };
        }
      }
      let homeId;
      if (sessionKey) {
        homeId = sessions.get(sessionKey, time);
        if (homeId !== undefined) {
          const account = pinnedAccount(records, homeId, canRebind, avoided);
          if (account) {
            bind(account);
            return { account, sessionKey, pinned: true, aff: 'home' };
          }
          // The home account is only cooling down or throttled for this attempt.
          // Keep it as the thread's home so the following turn returns to the
          // account that still holds this conversation's upstream prompt cache,
          // and borrow a different account for this single request instead.
          const home = records.find(item => item.account.id === homeId);
          if (!home?.configured) homeId = undefined;
          if (homeId === undefined) sessions.delete(sessionKey);
        }
      }
      let available = configured.filter(record => record.public.available && !avoided.has(record.account.id));
      // Trying a backing-off account beats failing the turn outright, so the
      // breaker only ever steers a request that has somewhere else to go.
      if (!available.length) available = configured.filter(record => record.public.available && !skipped.has(record.account.id));
      if (!available.length) {
        if (skipped.size && configured.some(record => record.public.available)) {
          throw poolError(429, 'Every other AgentRouter account is being rate limited right now.');
        }
        throw poolError(503, 'No configured AgentRouter account is currently available.');
      }
      // No session identity means no evidence that rotating requests is safe.
      const record = sessionKey ? available[nextAccount++ % available.length] : available[0];
      // A borrowed account is never promoted to home: the thread goes back to its
      // own account as soon as that one is usable again, cache included.
      if (sessionKey && homeId === undefined) sessions.set(sessionKey, record.account.id, time);
      if (conversationId) conversations.set(conversationId, record.account.id, time);
      return { account: record.account, sessionKey, pinned: false, aff: homeId === undefined ? 'new' : 'away' };
    },
    rememberResponse(id, accountId) {
      if (typeof id !== 'string' || !id.trim() || typeof accountId !== 'string' || !accountId.trim()) return;
      responses.set(id, accountId, now());
    },
    observeFailure(accountId, status, text) {
      if (typeof accountId !== 'string' || !accountId.trim()) return;
      const reason = failureReason(status, text);
      if (reason === 'insufficient_balance') {
        if (!balanceDisabled.has(accountId)) {
          balanceDisabled.set(accountId, { at: new Date(now()).toISOString() });
          cooldowns.delete(accountId);
        }
        const blocked = balanceDisabled.get(accountId);
        if (!blocked.persisted) {
          try { onAutoDisable?.(accountId, reason); blocked.persisted = true; }
          catch { /* Keep blocked and retry persistence on a later refusal. */ }
        }
      } else if (reason) {
        cooldowns.set(accountId, { until: now() + cooldownMs, reason });
        failures.delete(accountId);
        return reason;
      } else if (transportFailure(status, text)) {
        const streak = failures.get(accountId);
        failures.set(accountId, { count: Math.min((streak?.count ?? 0) + 1, 5), at: now() });
        return 'upstream_error';
      }
      return reason;
    },
    clearFailure(accountId) {
      balanceDisabled.delete(accountId);
      cooldowns.delete(accountId);
      failures.delete(accountId);
    },
    status(accounts) {
      const records = configuredAccounts(accounts, now());
      return {
        accounts: records.map(record => record.public),
        configuredCount: records.filter(record => record.configured).length,
        availableCount: records.filter(record => record.public.available).length,
      };
    },
  };
}
