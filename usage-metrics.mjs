import { safeRequestEvent } from './security-metadata.mjs';

const tokenKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens'];
const defaultModels = new Set([
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra',
  'gpt-5.6-sol-ar', 'gpt-6.1-sol-ar', 'gpt-6-astra-ar',
]);
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const finite = value => numeric(value) ? value : null;
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
// 720 小时＝30 天：分片保留 30 天，所以面板最远能看到整月。其余取值一律回落 4 小时。
// 今日/昨日是自然日窗口，起止时间由调用方算好传进来，此时不看 hours。
const hoursValue = value => [4, 24, 168, 720].includes(Number(value)) ? Number(value) : 4;
// 显式窗口（今日/昨日）优先；没有就从 hours 推。返回的跨度用于 rpm/tpm 和桶宽。
function resolveWindow(hours, now, options) {
  const end = Number.isFinite(options?.end) ? options.end : now;
  const start = Number.isFinite(options?.start) ? options.start : end - hoursValue(hours) * 3600000;
  return { start, end, hours: (end - start) / 3600000 };
}

export const requestSucceeded = event => event.status >= 200 && event.status < 400 && !event.aborted && !event.failed;
export const requestAccountKey = event => event.accountId ?? `route:${event.route}`;

// Reapply the allowlist on read so pre-hardening or hand-edited history cannot
// expose bodies, error text or arbitrary identifiers through the dashboard.
export function publicRequestRecords(events, hours = 4, now = Date.now(), { knownModels = defaultModels, start, end } = {}) {
  const allowed = knownModels instanceof Set ? knownModels : defaultModels;
  const window = resolveWindow(hours, now, { start, end });
  return (Array.isArray(events) ? events : []).flatMap((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
    const clean = safeRequestEvent(event, allowed);
    const at = Date.parse(clean.at);
    if (!Number.isFinite(at) || at < window.start || at > window.end) return [];
    const target = safeRequestEvent({ model: event.upstreamModel }, allowed).model;
    const record = {
      at: clean.at, model: clean.model, upstreamModel: target === 'unknown' ? null : target,
      accountId: clean.accountId ?? null, route: clean.route,
      status: finite(clean.status), ms: finite(clean.ms),
      aborted: clean.aborted === true, failed: clean.failed ?? null,
      usage: clean.usage ? Object.fromEntries(tokenKeys.map(key => [key, finite(clean.usage[key])])) : null,
      rotated: finite(clean.rotated), rebuilt: finite(clean.rebuilt), waited: finite(clean.waited),
    };
    return [{ record, index, time: at }];
  }).sort((a, b) => a.time - b.time || a.index - b.index).map(entry => entry.record);
}

function totals(records) {
  const sum = key => {
    const values = records.map(record => finite(record.usage?.[key])).filter(value => value !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const success = records.filter(requestSucceeded).length;
  const tokensReportedCount = records.filter(record => record.usage !== null).length;
  const totalTokensReportedCount = records.filter(record => numeric(record.usage?.totalTokens)).length;
  const inputTokens = sum('inputTokens');
  const cachedTokens = sum('cachedTokens');
  // 缓存命中率：命中的输入 token ÷ 全部输入 token。按 OpenAI 语义 cached 是 input 的子集，
  // 所以分母用 inputTokens 而不是 input+cached。任一侧没有上报就返回 null（面板显示“未上报”），
  // 不拿 0 冒充 0%。
  const cacheKnown = numeric(inputTokens) && numeric(cachedTokens) && inputTokens > 0;
  return {
    requests: records.length, success, failed: records.length - success,
    successRate: records.length ? success / records.length * 100 : null,
    ...Object.fromEntries(tokenKeys.map(key => [key, sum(key)])),
    cacheRate: cacheKnown ? cachedTokens / inputTokens * 100 : null,
    uncachedInputTokens: numeric(inputTokens) && numeric(cachedTokens) ? inputTokens - cachedTokens : null,
    tokensReportedCount, totalTokensReportedCount,
    tokensMissingCount: records.length - totalTokensReportedCount,
    averageLatencyMs: average(records.map(record => record.ms).filter(value => value !== null)),
  };
}

function grouped(records, keyOf, describe) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    const group = groups.get(key) ?? [];
    group.push(record); groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({ key, ...describe(key, group), ...totals(group) }))
    .sort((a, b) => (b.totalTokens ?? -1) - (a.totalTokens ?? -1) || b.requests - a.requests || a.key.localeCompare(b.key));
}

export const ACTIVE_ACCOUNT_WINDOW_MS = 300000;

export function summarizeRequests(events, hours = 4, now = Date.now(), options = {}) {
  const stamp = typeof now === 'function' ? now() : Number(now);
  // 今日/昨日由调用方给出自然日起止；固定窗口仍然只认 4/24/168/720。
  const window = resolveWindow(hours, stamp, options);
  hours = window.hours;
  const records = publicRequestRecords(events, hours, stamp, { ...options, start: window.start, end: window.end });
  const summary = totals(records);
  // 窗口里“真正有记录”的时间跨度：请求日志按 1 MB 分片轮转，保留期内也可能还没有
  // 那么长的历史，24 小时和 7 天看板取到同一批记录时靠这两个字段说清楚原因。
  const stamps = records.map(record => Date.parse(record.at)).filter(Number.isFinite);
  const coverage = stamps.length
    ? { firstSeenAt: new Date(stamps.reduce((min, value) => Math.min(min, value))).toISOString(), lastSeenAt: new Date(stamps.reduce((max, value) => Math.max(max, value))).toISOString() }
    : { firstSeenAt: null, lastSeenAt: null };
  const routeCounts = {};
  const bucketMs = hours <= 4 ? 30 * 60000 : hours <= 24 ? 2 * 3600000 : 24 * 3600000;
  const firstBucket = Math.floor(window.start / bucketMs) * bucketMs;
  const lastBucket = Math.floor(window.end / bucketMs) * bucketMs;
  const buckets = new Map();
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += bucketMs) buckets.set(bucket, []);
  for (const record of records) {
    routeCounts[record.route] = (routeCounts[record.route] ?? 0) + 1;
    buckets.get(Math.floor(Date.parse(record.at) / bucketMs) * bucketMs).push(record);
  }
  const series = [...buckets].map(([at, group]) => {
    const data = totals(group);
    return {
      at: new Date(at).toISOString(), requests: group.length,
      success: data.success, failed: data.failed,
      tokens: group.length ? data.totalTokens : 0,
      ...Object.fromEntries(tokenKeys.map(key => [key, group.length ? data[key] : 0])),
      // 空档期留 null 而不是 0，趋势图才不会画出一条假掉到 0% 的命中率曲线。
      cacheRate: data.cacheRate,
      tokensReportedCount: data.tokensReportedCount,
      totalTokensReportedCount: data.totalTokensReportedCount,
      tokensMissingCount: data.tokensMissingCount,
    };
  });
  const byAccount = grouped(records, requestAccountKey, (key, group) => {
    const lastSeen = Math.max(...group.map(record => Date.parse(record.at)).filter(Number.isFinite));
    return {
      accountId: group[0].accountId, route: group[0].route,
      lastSeenAt: Number.isFinite(lastSeen) ? new Date(lastSeen).toISOString() : null,
      active: Number.isFinite(lastSeen) && stamp - lastSeen <= ACTIVE_ACCOUNT_WINDOW_MS,
    };
  });
  return {
    hours, range: options.range ?? null, total: records.length, ...coverage, ...summary,
    rpm: records.length / (hours * 60),
    tpm: summary.totalTokens === null ? null : summary.totalTokens / (hours * 60),
    routeCounts,
    byModel: grouped(records, record => record.model, (model, group) => {
      const upstreamModels = [...new Set(group.map(record => record.upstreamModel).filter(Boolean))].sort();
      return { model, upstreamModel: upstreamModels.length === 1 ? upstreamModels[0] : null, upstreamModels };
    }),
    byAccount,
    activeWindowMinutes: ACTIVE_ACCOUNT_WINDOW_MS / 60000,
    activeAccounts: byAccount.filter(entry => entry.active),
    timeline: records.slice(-240), series,
  };
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? Math.min(number, maximum) : fallback;
}

export function queryRequests(events, params = new URLSearchParams(), now = Date.now(), options = {}) {
  // 明细页在自然日窗口下收到的是绝对起止时间（from/to），比 hours 精确。
  const from = params.has('from') ? Number(params.get('from')) : NaN;
  const to = params.has('to') ? Number(params.get('to')) : NaN;
  const windowed = Number.isFinite(from) && Number.isFinite(to) && to > from;
  const hours = windowed ? (to - from) / 3600000 : hoursValue(params.get('hours'));
  const windowOptions = windowed ? { ...options, start: from, end: to } : options;
  const model = params.get('model'); const account = params.get('account');
  const status = ['success', 'failed'].includes(params.get('status')) ? params.get('status') : 'all';
  const usage = ['reported', 'missing'].includes(params.get('usage')) ? params.get('usage') : 'all';
  const records = publicRequestRecords(events, hours, now, windowOptions).filter(record => {
    if (model && model !== record.model) return false;
    if (account && account !== requestAccountKey(record)) return false;
    if (status === 'success' && !requestSucceeded(record)) return false;
    if (status === 'failed' && requestSucceeded(record)) return false;
    if (usage === 'reported' && !numeric(record.usage?.totalTokens)) return false;
    if (usage === 'missing' && numeric(record.usage?.totalTokens)) return false;
    return true;
  }).reverse();
  const pageSize = positiveInteger(params.get('pageSize'), 25, 100);
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const page = Math.min(positiveInteger(params.get('page'), 1), pageCount);
  return { hours, range: windowed ? 'custom' : null, total: records.length, page, pageSize, pageCount, records: records.slice((page - 1) * pageSize, page * pageSize) };
}
