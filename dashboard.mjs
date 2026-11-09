import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { summarizeRequests, queryRequests } from './usage-metrics.mjs';
import { summarizeBalanceSpend } from './balance-spend.mjs';
export { summarizeRequests } from './usage-metrics.mjs';

// 本站查询额度：手动查询、签到、每小时余额快照共用同一个窗口。
// 2026-11-03 由 5 分钟收紧前的 300 秒改为 60 秒（用户要求）。
export const QUERY_WINDOW_MS = 60000;
const QUERY_WINDOW_MINUTES = QUERY_WINDOW_MS / 60000;

// 请求日志分片：requests.jsonl 是正在写的那个，超过 1 MB 就被 router 改名成
// requests-YYYY-MM-DD_HH-mm-ss.jsonl。旧版本只有一个 requests.previous.jsonl，
// 每次轮转都会把它覆盖掉，7 天视图因此只剩最近一两天；现在保留 30 天分片。
const REQUEST_LOG_PATTERN = /^requests(-[\w.-]+)?\.jsonl$/;
const REQUEST_LOG_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const eventCache = new Map();

export function requestLogNames(root) {
  let names;
  try { names = readdirSync(root); } catch { return []; }
  return names.filter(name => REQUEST_LOG_PATTERN.test(name))
    .sort((a, b) => (a === 'requests.jsonl') - (b === 'requests.jsonl') || a.localeCompare(b));
}

function readEventsFile(path) {
  let stat;
  try { stat = statSync(path); } catch { eventCache.delete(path); return []; }
  const cached = eventCache.get(path);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.events;
  const events = [];
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      try { const event = JSON.parse(line); if (event && typeof event === 'object') events.push(event); } catch {}
    }
  } catch { return []; }
  eventCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, events });
  return events;
}

// 只解析窗口（外加上一天余量）内写过东西的分片；解析结果按 大小+修改时间 缓存，面板轮询不会反复读盘。
export function readEvents(root, hours = 168, now = Date.now()) {
  const cutoff = now - Math.max(Number(hours) || 0, 24) * 3600000 - 24 * 3600000;
  const result = [];
  const alive = new Set();
  for (const name of requestLogNames(root)) {
    const path = join(root, name);
    alive.add(path);
    try { if (statSync(path).mtimeMs < cutoff) continue; } catch { continue; }
    for (const event of readEventsFile(path)) result.push(event);
  }
  for (const path of eventCache.keys()) if (!alive.has(path)) eventCache.delete(path);
  return result;
}

// 今日/昨日按本机时区的自然日切分：0 点起算，不是“往前推 24 小时”，所以单独走 range 参数。
const localMidnight = ms => { const date = new Date(ms); date.setHours(0, 0, 0, 0); return date.getTime(); };
const RANGE_KEYS = ['today', 'yesterday'];
function resolveWindow(params, now = Date.now()) {
  const range = params.get('range');
  if (RANGE_KEYS.includes(range)) {
    const end = range === 'today' ? now : localMidnight(now);
    const start = localMidnight(end - (range === 'today' ? 0 : 1));
    return { range, start, end, hours: (end - start) / 3600000 };
  }
  const asked = Number(params.get('hours') ?? 4);
  const hours = [4, 24, 168, 720].includes(asked) ? asked : 4;
  return { range: null, start: now - hours * 3600000, end: now, hours };
}

// 号池只包含 AgentRouter 账号。original（Axon 独立线路）和 opencode 是另外的上游，
// 请求照常写进日志（router.mjs 的 route 字段），但不进池子、不进计量，否则它们的
// Token 和成功率会混进号池的账里，看起来像号池自己跑出来的量。
const POOL_ROUTES = new Set(['agentrouter']);
const poolEvents = events => events.filter(event => POOL_ROUTES.has(event.route));

// 30 天窗口要过 100 MB 量级的分片，页面每 30 秒轮询一次不值得反复重建同一份汇总。
// 事件总数和最新一条记录都没变就复用上次结果（最多 2 分钟，窗口滑动的误差有界）。
// 今日/昨日窗口的终点一直在动，缓存会掩盖新请求，所以每次都重算（成本只是内存里的事件）。
const wideSummary = { key: '', at: 0, value: null };
function summarizeWide(window, events, options, now = Date.now()) {
  const params = { knownModels: options.knownModels, range: window.range, start: window.start, end: window.end };
  if (window.range || window.hours !== 720) return summarizeRequests(events, window.hours, now, params);
  const key = `${events.length}|${events.length ? events[events.length - 1]?.at ?? '' : ''}`;
  if (wideSummary.value && wideSummary.key === key && now - wideSummary.at < 120000) return wideSummary.value;
  const value = summarizeRequests(events, window.hours, now, params);
  wideSummary.key = key; wideSummary.at = now; wideSummary.value = value;
  return value;
}

function readSwitchBody(req) {
  const error = (statusCode, publicMessage) => Object.assign(new Error(publicMessage), { statusCode, publicMessage });
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
    req.resume();
    return Promise.reject(error(415, '请使用 JSON 提交账号状态'));
  }
  if (Number(req.headers['content-length'] ?? 0) > 1024) {
    req.resume();
    return Promise.reject(error(413, '账号状态请求过大'));
  }
  return new Promise((resolve, reject) => {
    let bytes = 0; let finished = false; let chunks = [];
    const fail = value => { if (!finished) { finished = true; chunks = []; reject(value); } };
    req.on('data', chunk => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > 1024) { fail(error(413, '账号状态请求过大')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') throw new Error();
        finished = true; resolve(body);
      } catch { fail(error(400, '启用状态必须是布尔值')); }
      chunks = [];
    });
    req.on('error', () => fail(error(400, '无法读取账号状态请求')));
    req.on('aborted', () => fail(error(400, '账号状态请求已中断')));
  });
}

function readAccountTarget(req) {
  const error = (statusCode, publicMessage) => Object.assign(new Error(publicMessage), { statusCode, publicMessage });
  const length = Number(req.headers['content-length'] ?? 0);
  if (!length) { req.resume(); return Promise.resolve(null); }
  if (length > 1024) { req.resume(); return Promise.reject(error(413, '账号查询请求过大')); }
  return new Promise((resolve, reject) => {
    let bytes = 0; let settled = false; const chunks = [];
    const fail = value => { if (!settled) { settled = true; reject(value); } };
    req.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 1024) { fail(error(413, '账号查询请求过大')); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) { settled = true; resolve(null); return; }
        const body = JSON.parse(text);
        const id = typeof body?.accountId === 'string' ? body.accountId.trim() : '';
        if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(id)) throw new Error();
        settled = true; resolve(id);
      } catch { fail(error(400, '账号 ID 不合法')); }
    });
    req.on('error', () => fail(error(400, '无法读取账号查询请求')));
    req.on('aborted', () => fail(error(400, '账号查询请求已中断')));
  });
}

function createTaskRunner(directory, launch, operation) {
  const isQuery = operation === 'balance_query';
  const label = isQuery ? '余额查询' : '签到';
  const script = isQuery ? 'query-balances.py' : 'main.py';
  const state = { running: false, phase: `等待${label}`, lastExitCode: null, startedAt: null, finishedAt: null, target: null };
  return {
    status: () => ({ ...state }),
    start(accounts = []) {
      if (state.running) return false;
      const targets = (Array.isArray(accounts) ? accounts : [])
        .filter(account => typeof account === 'string' && /^[A-Za-z0-9_.@-]{1,64}$/.test(account));
      const python = join(directory, '.venv', 'Scripts', 'python.exe');
      if (!existsSync(python) || !existsSync(join(directory, script))) throw new Error(`${label}程序未安装完整`);
      Object.assign(state, { running: true, phase: targets.length ? `启动${label}（单账号）` : `启动${label}`, startedAt: new Date().toISOString(), finishedAt: null, lastExitCode: null, target: targets.length ? targets.join(',') : null });
      let child;
      try {
        child = launch(python, ['-u', script, ...targets], { cwd: directory, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NEWAPI_HEADLESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { Object.assign(state, { running: false, phase: `${label}程序无法启动`, lastExitCode: -1, finishedAt: new Date().toISOString() }); throw error; }
      child.stdout?.on('data', chunk => {
        const text = chunk.toString();
        if (isQuery) { state.phase = '正在查询余额'; return; }
        if (/OAuth state HTTP 429/.test(text)) state.phase = '上游限流，正在等待重试';
        else if (/Trying GitHub authentication|GitHub account/.test(text)) state.phase = '正在验证 GitHub 账号';
        else if (/OAuth state/.test(text)) state.phase = '正在连接 AgentRouter';
        else if (/Current balance|Current balance hash/.test(text)) state.phase = '正在汇总账号额度';
        else if (/Processing AgentRouter/.test(text)) state.phase = '正在处理 AgentRouter';
      });
      child.stderr?.on('data', () => {});
      child.once('error', () => Object.assign(state, { running: false, phase: `${label}程序无法启动`, lastExitCode: -1, finishedAt: new Date().toISOString() }));
      child.once('close', code => Object.assign(state, { running: false, phase: `${label}结束，请查看账号结果`, lastExitCode: code, finishedAt: new Date().toISOString() }));
      return true;
    },
  };
}

export const createCheckInRunner = (directory, launch = spawn) => createTaskRunner(directory, launch, 'check_in');
export const createBalanceQueryRunner = (directory, launch = spawn) => createTaskRunner(directory, launch, 'balance_query');

function readBalanceReport(path) {
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(report.runs)) {
      const latestRun = report.latestRun ?? report.runs[0] ?? null;
      if (['running', 'in_progress'].includes(latestRun?.status) && Number.isSafeInteger(latestRun.processId) && latestRun.processId > 0) {
        try { process.kill(latestRun.processId, 0); }
        catch (error) {
          if (error.code === 'ESRCH') {
            latestRun.status = latestRun.confirmedCount > 0 ? 'partial' : 'failed';
            latestRun.interrupted = true;
            latestRun.accounts = (latestRun.accounts ?? []).map(account => account.status === 'pending' ? { ...account, status: 'failed', error: 'not_completed' } : account);
          }
        }
      }
      return { latestRun, runs: report.runs.slice(0, 200) };
    }
  } catch {}
  return { latestRun: null, runs: [] };
}

const runTime = run => Date.parse(run?.startedAt) || 0;

// 每个账号最近一次成功查询的余额之和。单账号查询或签到只刷新一个账号，
// 合计不能因此回落成“这一轮覆盖到的账号”，否则每次单账号操作都会让总额缩水。
export function knownBalances(runs, poolSize = 0) {
  const latest = new Map();
  for (const run of runs ?? []) {
    for (const row of run?.accounts ?? []) {
      // 负数余额是欠费账号的真实读数，要计入合计，不能当成异常丢掉。
      if (row?.status !== 'success' || !Number.isFinite(row?.balance)) continue;
      const key = String(row.username || row.id || '').trim().toLowerCase();
      if (!key) continue;
      const at = Date.parse(row.updatedAt || run.finishedAt || run.startedAt) || 0;
      const prior = latest.get(key);
      if (!prior || at > prior.at) latest.set(key, { balance: row.balance, at });
    }
  }
  const values = [...latest.values()];
  const freshest = values.length ? Math.max(...values.map(entry => entry.at)) : 0;
  return {
    count: values.length,
    poolSize,
    total: values.length ? values.reduce((sum, entry) => sum + entry.balance, 0) : null,
    freshestAt: freshest > 0 ? new Date(freshest).toISOString() : null,
  };
}

function taskStatus(runner, report, label) {
  const state = runner.status();
  const latest = report.latestRun;
  const reportRunning = ['running', 'in_progress'].includes(latest?.status) && (!state.finishedAt || runTime(latest) > Date.parse(state.finishedAt));
  return reportRunning && !state.running ? { ...state, running: true, startedAt: latest.startedAt, phase: `正在${label}` } : state;
}

function readRequestPolicy(directory, now) {
  const base = { available: true, reason: null, cooldownUntil: null, nextQueryAt: null, retryAfterSeconds: 0, queryRetryAfterSeconds: 0 };
  if (!directory) return base;
  try {
    const path = join(directory, 'site-request-policy.json');
    if (statSync(path).size > 1024 * 1024) throw new Error();
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || Array.isArray(data) || (data.version ?? data.schemaVersion) !== 1 || !data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)) throw new Error();
    const entry = data.providers['https://agentrouter.org'];
    if (entry === undefined) return base;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error();
    const timestamp = key => {
      const value = entry[key] ?? 0;
      const millis = typeof value === 'number' ? value * 1000 : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
      if (!Number.isFinite(millis) || millis < 0 || millis > 8640000000000000) throw new Error();
      return millis;
    };
    const cooldown = timestamp('cooldownUntil');
    const nextQuery = Math.max(cooldown, timestamp('nextQueryAt'));
    const retryAfterSeconds = Math.max(0, Math.ceil((cooldown - now) / 1000));
    return { ...base, reason: retryAfterSeconds ? 'rate_limited' : null,
      cooldownUntil: cooldown > now ? new Date(cooldown).toISOString() : null,
      nextQueryAt: nextQuery > now ? new Date(nextQuery).toISOString() : null,
      retryAfterSeconds, queryRetryAfterSeconds: Math.max(0, Math.ceil((nextQuery - now) / 1000)) };
  } catch (error) {
    if (error.code === 'ENOENT') return base;
    return { ...base, available: false, reason: 'policy_state_unavailable' };
  }
}

export function createDashboard(options) {
  const { root, getPoolStatus, getService } = options;
  const now = options.now ?? Date.now;
  const runner = options.runner ?? createCheckInRunner(options.checkInDirectory);
  const balanceQueryRunner = options.balanceQueryRunner ?? createBalanceQueryRunner(options.checkInDirectory);
  const readReports = () => {
    const checkInBalances = readBalanceReport(options.balanceHistoryPath ?? join(root, 'balance-history.json'));
    const queriedBalances = readBalanceReport(options.balanceQueryHistoryPath ?? join(root, 'balance-query-history.json'));
    const latestRun = [checkInBalances.latestRun, queriedBalances.latestRun].filter(Boolean).sort((a, b) => runTime(b) - runTime(a))[0] ?? null;
    const runs = [...checkInBalances.runs, ...queriedBalances.runs].sort((a, b) => runTime(b) - runTime(a)).slice(0, 200);
    return { balances: { latestRun, runs }, checkInBalances, queriedBalances };
  };
  const statuses = reports => {
    const checkIn = taskStatus(runner, reports.checkInBalances, '签到');
    const balanceQuery = taskStatus(balanceQueryRunner, reports.queriedBalances, '查询余额');
    const lastQueryStart = Math.max(runTime(reports.queriedBalances.latestRun), Date.parse(balanceQuery.startedAt) || 0);
    const timestamp = now();
    const requestPolicy = readRequestPolicy(options.checkInDirectory, timestamp);
    const nextQueryAt = Math.max(lastQueryStart ? lastQueryStart + QUERY_WINDOW_MS : 0, Date.parse(requestPolicy.nextQueryAt) || 0);
    balanceQuery.retryAfterSeconds = Math.max(0, Math.ceil((nextQueryAt - timestamp) / 1000));
    requestPolicy.queryRetryAfterSeconds = balanceQuery.retryAfterSeconds;
    requestPolicy.nextQueryAt = nextQueryAt > timestamp ? new Date(nextQueryAt).toISOString() : null;
    // 脚本用退出码 2 表示“冷却中，一个请求都没发”。面板若把它当成功就会静默无回应，
    // 所以把这类“没做事”的结果单独翻译成一句人话，退出码也一并保留。
    const outcome = (task, label) => {
      if (task.running) return null;
      if (task.lastExitCode === 2) return `${label}没有发出任何请求：站点仍在 ${QUERY_WINDOW_MINUTES} 分钟冷却中（脚本退出码 2），等倒计时结束再点即可。`;
      // 退出码 1 表示“跑完了但部分账号没取到余额”，其余账号的记录仍然是新的，
      // 所以不能说“本机记录没有更新”。
      if (task.lastExitCode === 1) return `${label}有账号没取到余额（脚本退出码 1），失败账号沿用上一次记录；细节见签到项目的 logs 目录。`;
      if (Number.isSafeInteger(task.lastExitCode) && task.lastExitCode > 0) return `${label}以退出码 ${task.lastExitCode} 结束，本机记录没有更新；细节见签到项目的 logs 目录。`;
      return null;
    };
    balanceQuery.message = outcome(balanceQuery, '余额查询');
    checkIn.message = outcome(checkIn, '签到');
    return { checkIn, balanceQuery, requestPolicy };
  };
  const modernRoot = join(root, 'web-axonhub');
  const serveAsset = (name, mime, res) => {
    try {
      const body = readFileSync(join(modernRoot, name));
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(body); return true;
    } catch { res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: '网页资源不存在' })); return true; }
  };
  const assets = new Map([['/dashboard', ['index.html', 'text/html; charset=utf-8']], ['/dashboard/', ['index.html', 'text/html; charset=utf-8']], ['/dashboard/index.html', ['index.html', 'text/html; charset=utf-8']], ['/dashboard/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/dashboard/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/dashboard/usage.js', ['usage.js', 'text/javascript; charset=utf-8']]]);
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/dashboard')) return false;
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); return true; };
    const port = req.socket.localPort;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return json(403, { error: '只允许本机访问' });
    const host = String(req.headers.host ?? '').toLowerCase();
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return json(403, { error: '只允许本机访问' });
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    const localHeader = req.headers['x-gateway-local'] === '1';
    // Fetch Metadata cannot be set by page JavaScript. A foreign page also
    // cannot send our custom header without a CORS preflight, which is denied.
    const opaqueLocalOrigin = origin === 'null' && fetchSite === 'same-origin' && localHeader;
    if (origin && origin !== `http://${host}` && !opaqueLocalOrigin) return json(403, { error: '拒绝跨站访问' });
    if (fetchSite && !['none', 'same-origin'].includes(fetchSite)) return json(403, { error: '拒绝跨站访问' });
    if (req.method === 'GET' && existsSync(join(modernRoot, 'index.html'))) {
      if (['/dashboard', '/dashboard/', '/dashboard/index.html'].includes(url.pathname)) return serveAsset('index.html', 'text/html; charset=utf-8', res);
      const modernAsset = /^\/dashboard\/assets\/([A-Za-z0-9_-]+\.(?:js|css))$/.exec(url.pathname);
      if (modernAsset) return serveAsset(`assets/${modernAsset[1]}`, modernAsset[1].endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', res);
    }
    if (assets.has(url.pathname) && req.method === 'GET') {
      const [name, mime] = assets.get(url.pathname);
      try {
        const body = readFileSync(join(root, 'web', name));
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
        res.end(body); return true;
      } catch { return json(404, { error: '网页资源不存在' }); }
    }
    // A custom header cannot be submitted by an external form. Cross-origin
    // fetches require a preflight, which this server rejects without CORS.
    if (req.method !== 'GET' && !localHeader) return json(403, { error: '请从本机额度面板执行此操作' });
    if (req.method === 'GET' && url.pathname === '/dashboard/api/overview') {
      const window = resolveWindow(url.searchParams);
      const reports = readReports();
      const pool = getPoolStatus();
      const spend = summarizeBalanceSpend([reports.checkInBalances.latestRun, reports.queriedBalances.latestRun, ...reports.checkInBalances.runs, ...reports.queriedBalances.runs], window.hours, Date.now(), { range: window.range, start: window.start, end: window.end });
      const events = poolEvents(options.readEvents ? options.readEvents() : readEvents(root, window.hours + 24));
      return json(200, { service: getService(), pool, ...statuses(reports), balances: { ...reports.balances, known: knownBalances(reports.balances.runs, pool.accounts?.length ?? 0) }, checkInBalances: reports.checkInBalances, queriedBalances: reports.queriedBalances, spend, metrics: summarizeWide(window, events, options) });
    }
    if (req.method === 'GET' && url.pathname === '/dashboard/api/requests') {
      const window = resolveWindow(url.searchParams);
      // 明细页最多 7 天：30 天窗口只给汇总，逐条记录留在 1 MB 分片里按需读。
      // 今日/昨日是自然日，用绝对起止时间传下去，避免 hours 丢掉零点边界。
      const listHours = window.range ? window.hours : window.hours === 720 ? 168 : window.hours;
      const listParams = new URLSearchParams(url.searchParams);
      listParams.delete('range');
      listParams.set('hours', String(listHours));
      if (window.range) { listParams.set('from', String(window.start)); listParams.set('to', String(window.end)); }
      return json(200, queryRequests(poolEvents(options.readEvents ? options.readEvents() : readEvents(root, listHours + 24)), listParams, Date.now(), { knownModels: options.knownModels }));
    }
    if (req.method === 'POST' && url.pathname === '/dashboard/api/check-in') {
      try {
        const current = statuses(readReports());
        if (current.checkIn.running || current.balanceQuery.running) return json(409, { error: current.balanceQuery.running ? '余额查询正在运行，请稍后签到' : '签到正在运行', ...current });
        if (!current.requestPolicy.available) return json(503, { error: '限流状态读取失败，暂不启动登录或余额查询；本机记录仍可刷新', ...current });
        if (current.requestPolicy.retryAfterSeconds > 0) return json(429, { error: `上游限流，登录与余额查询暂停 ${current.requestPolicy.retryAfterSeconds} 秒`, ...current });
        if (current.requestPolicy.queryRetryAfterSeconds > 0) return json(429, { error: `刚执行过余额操作，请等待 ${current.requestPolicy.queryRetryAfterSeconds} 秒后再签到`, ...current });
        if (!runner.start()) return json(409, { error: '签到正在运行', checkIn: runner.status() });
        return json(202, { checkIn: runner.status() });
      } catch { return json(503, { error: '无法启动签到，请检查本机签到程序', checkIn: runner.status() }); }
    }
    if (req.method === 'POST' && url.pathname === '/dashboard/api/query-balances') {
      try {
        const target = await readAccountTarget(req);
        const current = statuses(readReports());
        if (current.checkIn.running || current.balanceQuery.running) return json(409, { error: current.checkIn.running ? '签到正在运行，请稍后查询余额' : '余额查询正在运行', ...current });
        if (!current.requestPolicy.available) return json(503, { error: '限流状态读取失败，暂不启动登录或余额查询；本机记录仍可刷新', ...current });
        if (current.requestPolicy.retryAfterSeconds > 0) return json(429, { error: `上游限流，登录与余额查询暂停 ${current.requestPolicy.retryAfterSeconds} 秒`, ...current });
        if (current.balanceQuery.retryAfterSeconds > 0) return json(429, { error: `站点限制 ${QUERY_WINDOW_MINUTES} 分钟内只查询一次余额，请等待 ${current.balanceQuery.retryAfterSeconds} 秒`, ...current });
        if (!balanceQueryRunner.start(target ? [target] : [])) return json(409, { error: '余额查询正在运行', balanceQuery: balanceQueryRunner.status() });
        return json(202, { balanceQuery: balanceQueryRunner.status(), target });
      } catch (error) {
        const status = [400, 413, 415].includes(error?.statusCode) ? error.statusCode : 503;
        const balanceQuery = balanceQueryRunner.status();
        if (status === 503) return json(503, { error: '无法启动余额查询，请检查本机查询程序', balanceQuery });
        return json(status, { error: typeof error?.publicMessage === 'string' ? error.publicMessage : '无法启动余额查询', balanceQuery });
      }
    }
    const accountSwitch = /^\/dashboard\/api\/accounts\/([A-Za-z0-9_-]{1,64})\/enabled$/.exec(url.pathname);
    if (req.method === 'POST' && accountSwitch) {
      if (typeof options.setAccountEnabled !== 'function') return json(503, { error: '号池状态管理未配置' });
      try {
        const body = await readSwitchBody(req);
        await options.setAccountEnabled(accountSwitch[1], body.enabled);
        return json(200, { pool: getPoolStatus() });
      } catch (error) {
        const status = [400, 404, 413, 415, 503].includes(error?.statusCode) ? error.statusCode : 503;
        return json(status, { error: typeof error?.publicMessage === 'string' ? error.publicMessage : '无法更新账号状态，请检查本机号池配置' });
      }
    }
    return json(404, { error: '未知的网页接口' });
  };
}
