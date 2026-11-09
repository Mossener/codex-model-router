import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, realpathSync, lstatSync, watch } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode, publicMessage: message });

export function createAccountSettings({ root, manifestPath = 'account-pool.json', getPoolStatus, balanceGuard = true }) {
  const update = (id, enabled, reason = null) => {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof enabled !== 'boolean') {
        throw failure(400, '账号 ID 和启用状态无效');
      }
      let path;
      let manifest;
      try {
        const realRoot = realpathSync(resolve(root));
        path = resolve(realRoot, manifestPath);
        const fromRoot = relative(realRoot, path);
        if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot) || lstatSync(path).isSymbolicLink()) throw new Error();
        const realPath = realpathSync(path);
        const realRelative = relative(realRoot, realPath);
        if (!realRelative || realRelative.startsWith('..') || isAbsolute(realRelative)) throw new Error();
        manifest = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
        if (!manifest || !Array.isArray(manifest.accounts)) throw new Error();
      } catch { throw failure(503, '无法读取本机号池配置'); }
      const entries = manifest.accounts.filter(account => account?.id === id);
      if (!entries.length) throw failure(404, '账号不存在');
      if (entries.length !== 1) throw failure(503, '本机号池存在重复账号 ID');
      if (enabled) {
        let configured;
        try { configured = getPoolStatus().accounts.find(account => account.id === id)?.keyConfigured; }
        catch { throw failure(503, '无法读取账号凭据状态'); }
        if (!configured) throw failure(400, '请先为此账号添加 API Key');
      }
      // Automatic rules never enable an account or relabel a manual stop.
      if (reason && entries[0].enabled === false) return false;
      if (entries[0].enabled === enabled && !enabled) return false;
      entries[0].enabled = enabled;
      entries[0].stateChangedAt = new Date().toISOString();
      if (reason) {
        entries[0].disabledReason = reason;
        entries[0].disabledAt = entries[0].stateChangedAt;
      } else {
        delete entries[0].disabledReason;
        delete entries[0].disabledAt;
      }
      const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(temporary, path);
      } catch { throw failure(503, '无法保存账号状态，请检查本机配置文件权限'); }
      finally { if (existsSync(temporary)) { try { unlinkSync(temporary); } catch {} } }
      return true;
  };
  const settings = {
    setEnabled(id, enabled) { return update(id, enabled); },
    autoDisable(id, reason) {
      if (!['low_balance', 'insufficient_balance'].includes(reason)) throw failure(400, '自动停用原因无效');
      return update(id, false, reason);
    },
    applyBalanceGuard() {
      let manifest;
      try { manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8').replace(/^\uFEFF/, '')); }
      catch { return []; }
      if (!Array.isArray(manifest.accounts)) return [];
      const reports = [];
      for (const file of ['balance-history.json', 'balance-query-history.json']) {
        try {
          const report = JSON.parse(readFileSync(join(root, file), 'utf8'));
          if (report.latestRun) reports.push(report.latestRun);
          if (Array.isArray(report.runs)) reports.push(...report.runs.slice(0, 200));
        } catch {}
      }
      const disabled = [];
      for (const id of lowBalanceAccounts(manifest.accounts, reports)) {
        if (settings.autoDisable(id, 'low_balance')) disabled.push(id);
      }
      // Only an account this guard stopped, only from a report newer than that
      // stop, and only above 25: a top-up becomes visible without any manual
      // toggle, while a manual stop and a stale reading both stay untouched.
      for (const id of recoveredAccounts(manifest.accounts, reports)) {
        try { settings.setEnabled(id, true); } catch {}
      }
      return disabled;
    },
    close() { watcher?.close(); if (poll) clearInterval(poll); },
  };
  let watcher;
  let poll;
  if (balanceGuard) {
    const scan = () => { try { settings.applyBalanceGuard(); } catch {} };
    scan();
    try {
      watcher = watch(root, { persistent: false }, (_event, file) => {
        if (['balance-history.json', 'balance-query-history.json'].includes(String(file))) scan();
      });
      watcher.on('error', () => {});
    } catch {}
    // Atomic report replacement or Windows watcher coalescing can lose an
    // event. The fallback also covers standalone command-line queries.
    poll = setInterval(scan, 5000);
    poll.unref();
  }
  return settings;
}

export function lowBalanceAccounts(accounts, reports) {
  const latest = latestBalances(accounts, reports);
  return accounts.filter(account => account.enabled !== false && latest.has(account.id) && latest.get(account.id).balance < 20).map(account => account.id);
}

// A guard stop must survive a top-up being invisible: a fresh confirmed balance
// above 25 puts the account back without anyone touching the dashboard. 20/25 is
// hysteresis, and the report must be newer than the stop, so a stale reading can
// never reopen an account and the same report can never keep flipping it.
export function recoveredAccounts(accounts, reports, settleMs = 5 * 60 * 1000) {
  const latest = latestBalances(accounts, reports);
  const guardStops = ['low_balance', 'insufficient_balance'];
  return accounts.filter(account => {
    if (account.enabled !== false || !guardStops.includes(account.disabledReason)) return false;
    const reading = latest.get(account.id);
    if (!reading || reading.balance < 25) return false;
    const stop = Date.parse(account.disabledAt || account.stateChangedAt) || 0;
    // A reading taken right on the refusal is not evidence the account healed.
    return reading.time - stop > settleMs;
  }).map(account => account.id);
}

function latestBalances(accounts, reports) {
  const normalized = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
  const matches = (account, row) => {
    const aliases = [account.id, account.label, account.checkInUsername].map(normalized).filter(Boolean);
    return row.provider === 'agentrouter' && aliases.includes(normalized(row.username));
  };
  const latest = new Map();
  for (const report of reports) {
    if (!report || !Array.isArray(report.accounts)) continue;
    for (const row of report.accounts) {
      // 负数余额代表账号已欠费透支，属于“低于阈值”的一种，必须能触发自动停用。
      if (row?.status !== 'success' || typeof row.balance !== 'number' || !Number.isFinite(row.balance)) continue;
      const time = Date.parse(row.updatedAt || report.finishedAt || report.startedAt);
      if (!Number.isFinite(time)) continue;
      const candidates = accounts.filter(account => matches(account, row));
      if (candidates.length !== 1) continue;
      const account = candidates[0];
      if (time <= (Date.parse(account.stateChangedAt) || 0)) continue;
      const current = latest.get(account.id);
      if (!current || time > current.time) latest.set(account.id, { balance: row.balance, time });
    }
  }
  return latest;
}
