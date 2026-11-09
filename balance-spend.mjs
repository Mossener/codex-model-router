// Observed account spending from successful cumulative-used snapshots.
// No token-price estimate, balance subtraction, interpolation, or Axon billing.
//
// A sample is dated by the run that observed it, never by the row's own
// `updatedAt` alone. The dashboard merges the previous rows into every new run
// so a single-account query keeps the table complete; those carried rows keep
// their old `updatedAt`, and re-dating them would place an observation hours
// before it actually happened — which silently drops real spending from the
// window (a pair that straddles the boundary is not counted).
const finiteAmount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const money = value => Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
// Clock slack between the check-in script and the site; a row stamped this long
// before the run started was carried over instead of being queried again.
const FRESH_SLACK_MS = 600000;

export function summarizeBalanceSpend(reports, hours = 4, now = Date.now(), options = {}) {
  // 今日/昨日按自然日切分，调用方直接给起止时间；固定窗口仍只认 4/24/168/720。
  const windowed = Number.isFinite(options.start) && Number.isFinite(options.end) && options.end > options.start;
  const end = windowed ? options.end : Number.isFinite(now) ? now : Date.now();
  const start = windowed ? options.start : end - ([4, 24, 168, 720].includes(Number(hours)) ? Number(hours) : 4) * 3600000;
  hours = (end - start) / 3600000;
  const accounts = new Map();
  const seenRuns = new Set();
  for (const report of Array.isArray(reports) ? reports : []) {
    if (!report || typeof report !== 'object') continue;
    // latestRun is also the first element of runs: count that observation once.
    if (report.id !== undefined && report.id !== null) {
      const runId = String(report.id);
      if (seenRuns.has(runId)) continue;
      seenRuns.add(runId);
    }
    const startedAt = Date.parse(report.startedAt);
    const finishedAt = Date.parse(report.finishedAt);
    const observedAt = Number.isFinite(finishedAt) ? finishedAt : startedAt;
    for (const row of Array.isArray(report.accounts) ? report.accounts : []) {
      if (normalize(row?.provider) !== 'agentrouter' || row.status !== 'success' || !finiteAmount(row.used)) continue;
      const username = normalize(row.username);
      const id = normalize(row.id);
      if (!username && !id) continue;
      const rowTime = Date.parse(row.updatedAt);
      if (Number.isFinite(startedAt) && Number.isFinite(rowTime) && rowTime < startedAt - FRESH_SLACK_MS) continue;
      const time = Number.isFinite(observedAt) ? observedAt : rowTime;
      if (!Number.isFinite(time) || time < start || time > end) continue;
      const key = `agentrouter:${username ? `username:${username}` : `id:${id}`}`;
      let account = accounts.get(key);
      if (!account) {
        account = { key, username: username || null, id: id || null, points: new Map() };
        accounts.set(key, account);
      }
      // Two different runs can finish in the same millisecond. Contradictory
      // values at one timestamp cannot establish an ordering; discard that point.
      if (!account.points.has(time)) account.points.set(time, row.used);
      else if (account.points.get(time) !== row.used) account.points.set(time, null);
    }
  }

  const byAccount = [];
  let first = Infinity;
  let last = -Infinity;
  for (const account of accounts.values()) {
    const points = [...account.points].filter(([, used]) => used !== null).sort((a, b) => a[0] - b[0]);
    if (!points.length) continue;
    let amount = 0;
    let intervals = 0;
    let coveredMs = 0;
    let resets = 0;
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1];
      const current = points[index];
      if (current[1] < previous[1]) { resets++; continue; }
      amount += current[1] - previous[1];
      intervals++;
      coveredMs += current[0] - previous[0];
    }
    const from = points[0][0];
    const to = points.at(-1)[0];
    first = Math.min(first, from);
    last = Math.max(last, to);
    byAccount.push({
      key: account.key, username: account.username, id: account.id,
      amount: intervals ? money(amount) : null, samples: points.length,
      from: iso(from), to: iso(to), resets,
      coveredHours: coveredMs / 3600000,
      partial: from > start || to < end || resets > 0 || intervals === 0,
    });
  }
  byAccount.sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1) || a.key.localeCompare(b.key));
  const reported = byAccount.filter(account => account.amount !== null);
  return {
    hours, range: options.range ?? null, currency: 'USD', source: 'agentrouter-used-quota',
    amount: reported.length ? money(reported.reduce((sum, account) => sum + account.amount, 0)) : null,
    accountsReported: reported.length, accountsObserved: byAccount.length,
    firstObservedAt: iso(first), lastObservedAt: iso(last),
    // This is the observed span, not a claim of complete coverage for every account.
    coverageHours: byAccount.length ? (last - first) / 3600000 : 0,
    partial: !byAccount.length || byAccount.some(account => account.partial),
    resets: byAccount.reduce((sum, account) => sum + account.resets, 0),
    byAccount,
  };
}
