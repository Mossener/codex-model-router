'use strict';

const byId = id => document.getElementById(id);
const state = { hours: 4, chartMetric: 'requests', data: null, controller: null, pollTimer: null, noticeTimer: null, requestId: 0, triggering: false, accountUpdate: null, accountErrors: new Map(), poolRevision: 0 };
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const moneyFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const svgNS = 'http://www.w3.org/2000/svg';
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const amount = value => isNumber(value) ? moneyFormat.format(value) : '待查询';
const number = value => isNumber(value) ? numberFormat.format(value) : '—';
const dateValue = value => { const time = value ? new Date(value).getTime() : NaN; return Number.isFinite(time) ? time : null; };
const time = value => dateValue(value) === null ? '—' : timeFormat.format(new Date(value));
const hoursLabel = () => state.hours === 168 ? '7 天' : `${state.hours} 小时`;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function svgElement(tag, attributes = {}, text) {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function badge(text, kind = 'neutral') { return element('span', `badge ${kind}`, text); }
function text(id, value) { byId(id).textContent = value; }
function emptyTable(body, columns, message) {
  const row = element('tr');
  const cell = element('td', 'empty-cell', message);
  cell.colSpan = columns;
  row.append(cell);
  body.replaceChildren(row);
}

function duration(start, finish) {
  const first = dateValue(start);
  const last = dateValue(finish);
  if (first === null || last === null || last < first) return '—';
  const seconds = Math.round((last - first) / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function plainUrl(value) {
  if (typeof value !== 'string' || !value) return '—';
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch { return value; }
}

function setTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  text('themeLabel', dark ? '深色' : '浅色');
  text('themeIcon', dark ? '☾' : '☼');
  byId('themeToggle').setAttribute('aria-pressed', String(dark));
  byId('themeToggle').setAttribute('aria-label', `当前${dark ? '深色' : '浅色'}，切换为${dark ? '浅色' : '深色'}`);
  try { localStorage.setItem('gateway-dashboard-theme', dark ? 'dark' : 'light'); } catch { /* Theme still works without storage. */ }
}

function notify(message) {
  clearTimeout(state.noticeTimer);
  text('notice', message);
  byId('notice').hidden = false;
  state.noticeTimer = setTimeout(() => { byId('notice').hidden = true; }, 8000);
}

async function api(path, method = 'GET', signal, body) {
  const response = await fetch(path, {
    method, signal, cache: 'no-store', mode: 'same-origin', credentials: 'omit', redirect: 'error', referrerPolicy: 'same-origin',
    headers: { 'X-Gateway-Local': '1', Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let failure;
    try { failure = await response.json(); } catch { /* Keep the HTTP status when the response is not JSON. */ }
    throw Object.assign(new Error(typeof failure?.error === 'string' ? failure.error : `本机服务返回 HTTP ${response.status}`), { status: response.status, checkIn: failure?.checkIn });
  }
  try { return await response.json(); } catch { throw new Error('本机服务返回的数据无法读取。'); }
}

function checkInView(data) {
  const runner = data?.checkIn || {};
  const latest = data?.balances?.latestRun || null;
  const runnerStart = dateValue(runner.startedAt);
  const runnerFinish = dateValue(runner.finishedAt);
  const latestStart = dateValue(latest?.startedAt);
  const noRunnerRecord = runnerStart === null && runnerFinish === null;
  const newerExternalReport = latestStart !== null && runnerFinish !== null && latestStart > runnerFinish;
  const external = Boolean(latest && runner.running !== true && (noRunnerRecord || newerExternalReport));
  const record = external ? latest : runner;
  const running = record.running === true || external && ['running', 'in_progress'].includes(String(record.status).toLowerCase());
  const currentReport = latest && runnerStart !== null && latestStart !== null && latestStart >= runnerStart && (runnerFinish === null || latestStart <= runnerFinish) ? latest : null;
  return { record, external, running, report: external ? latest : currentReport };
}

function setCheckInButton() {
  const busy = state.triggering || checkInView(state.data).running;
  byId('checkInButton').disabled = busy;
  byId('checkInButton').setAttribute('aria-busy', String(busy));
  byId('checkInButton').querySelector('span').textContent = busy ? '签到进行中…' : '签到并刷新';
}

async function refresh() {
  if (state.accountUpdate) return;
  clearTimeout(state.pollTimer);
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const requestId = ++state.requestId;
  const poolRevision = state.poolRevision;
  const timeout = setTimeout(() => controller.abort('timeout'), 20000);
  byId('refreshButton').classList.add('is-loading');
  byId('refreshButton').setAttribute('aria-busy', 'true');
  try {
    const data = await api(`/dashboard/api/overview?hours=${state.hours}`, 'GET', controller.signal);
    if (requestId !== state.requestId || poolRevision !== state.poolRevision) return;
    if (!data || typeof data !== 'object' || !data.service || !data.pool || !data.balances || !data.metrics) throw new Error('本机服务返回的数据不完整。');
    state.data = data;
    state.accountErrors.clear();
    render(data);
    byId('errorBanner').hidden = true;
    text('updatedAt', clockFormat.format(new Date()));
    byId('updatedAt').dateTime = new Date().toISOString();
  } catch (error) {
    if (requestId !== state.requestId || poolRevision !== state.poolRevision) return;
    if (controller.signal.aborted && controller.signal.reason !== 'timeout') return;
    text('errorBanner', `${controller.signal.reason === 'timeout' ? '读取本机状态超时。' : error.message} 请确认网关正在运行后重试。${state.data ? '当前保留上次成功读取的数据。' : ''}`);
    byId('errorBanner').hidden = false;
    serviceBadge('连接中断', 'warning');
  } finally {
    clearTimeout(timeout);
    if (requestId === state.requestId) {
      byId('refreshButton').classList.remove('is-loading');
      byId('refreshButton').setAttribute('aria-busy', 'false');
      if (!state.accountUpdate && poolRevision === state.poolRevision) state.pollTimer = setTimeout(refresh, checkInView(state.data).running ? 2000 : 30000);
    }
  }
}

async function setAccountEnabled(id) {
  if (state.accountUpdate) return;
  const account = state.data?.pool?.accounts?.find(candidate => candidate.id === id);
  if (!account?.id) return;
  const enabled = account.enabled === false;
  if (enabled && !account.keyConfigured) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), 20000);
  state.accountUpdate = { id, enabled, controller };
  state.accountErrors.delete(id);
  state.poolRevision++;
  clearTimeout(state.pollTimer);
  state.controller?.abort();
  renderAccounts(state.data);
  try {
    const result = await api(`/dashboard/api/accounts/${encodeURIComponent(id)}/enabled`, 'POST', controller.signal, { enabled });
    if (!Array.isArray(result?.pool?.accounts) || !isNumber(result.pool.availableCount) || !isNumber(result.pool.configuredCount)) throw new Error('invalid_pool');
    state.data = { ...state.data, pool: result.pool };
    text('availableAccounts', `${number(result.pool.availableCount)} / ${number(result.pool.configuredCount)} 个`);
    notify(`${account.label || account.id}已${enabled ? '加入' : '退出'}号池。`);
  } catch (error) {
    const message = error.status === 400 ? '未能保存，请确认账号已添加 API Key 后重试。'
      : error.status === 404 ? '账号记录已变更，请刷新后重试。'
      : error.status === 503 ? '本机未能保存设置，请重试。'
      : controller.signal.aborted ? '保存超时，请刷新确认当前状态后重试。'
      : '未能保存号池设置，请重试。';
    state.accountErrors.set(id, message);
    notify(message);
  } finally {
    clearTimeout(timeout);
    state.accountUpdate = null;
    if (state.data) {
      renderAccounts(state.data);
      clearTimeout(state.pollTimer);
      state.pollTimer = setTimeout(refresh, checkInView(state.data).running ? 2000 : 30000);
    } else {
      refresh();
    }
  }
}

async function startCheckIn() {
  if (state.triggering || checkInView(state.data).running) return;
  state.triggering = true;
  setCheckInButton();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let accepted = false;
  try {
    const result = await api('/dashboard/api/check-in', 'POST', controller.signal);
    accepted = true;
    if (state.data && result.checkIn) state.data.checkIn = result.checkIn;
    clearTimeout(timeout);
    notify('签到已开始。执行期间自动读取进度，完成后更新真实余额。');
  } catch (error) {
    clearTimeout(timeout);
    if (state.data && error.checkIn) state.data.checkIn = error.checkIn;
    try { await refresh(); } catch { /* Reconcile a POST whose response may have been lost. */ }
    if (error.status === 409 || checkInView(state.data).running) {
      notify('签到已经在执行，正在刷新进度。');
    } else if (error.status === 401) {
      notify('本机服务要求额外授权，请刷新页面以加载最新网关版本。');
    } else if (error.status === 403) {
      notify('本机服务拒绝了网页请求，请从本机网关地址重新打开页面。');
    } else if (error.status) {
      notify(`签到未启动：${error.message}（HTTP ${error.status}）。`);
    } else {
      notify('未收到签到启动确认。请确认网关连接恢复后刷新进度，再决定是否重试。');
    }
  } finally {
    clearTimeout(timeout);
    if (accepted) {
      try { await refresh(); } catch { notify('签到已开始，但进度暂时无法读取。连接恢复后会继续刷新。'); }
    }
    state.triggering = false;
    setCheckInButton();
  }
}

function serviceBadge(label, kind) {
  const node = byId('serviceStatus');
  node.className = `status-pill ${kind}`;
  node.replaceChildren(element('span', 'status-dot'), document.createTextNode(label));
}

function renderSummary(data) {
  const service = data.service;
  const latest = data.balances.latestRun;
  const checkIn = data.checkIn || {};
  const view = checkInView(data);
  const externalRun = view.external ? view.record : null;
  const recentRun = view.record;
  const online = ['running', 'online', 'ok', 'healthy'].includes(String(service.status).toLowerCase()) || service.status === true;
  serviceBadge(online ? '本机服务在线' : '服务状态待确认', online ? 'success' : 'neutral');
  text('defaultModel', service.defaultModel || '—');
  text('defaultUpstream', plainUrl(service.defaultUpstream));
  text('proxyStatus', service.proxy ? plainUrl(service.proxy) : '未配置');
  text('entrypoint', plainUrl(service.entrypoint));
  text('serviceVersion', `${service.name || '本机模型网关'}${service.version ? ` · v${service.version}` : ''}`);
  const confirmed = isNumber(latest?.confirmedCount) ? latest.confirmedCount : 0;
  const count = isNumber(latest?.accountCount) ? latest.accountCount : 0;
  const partial = confirmed < count;
  text('balanceTitle', partial ? '已确认余额（部分账号）' : '已确认余额');
  const value = byId('totalBalance');
  value.classList.toggle('pending', !isNumber(latest?.totalBalance));
  if (isNumber(latest?.totalBalance)) value.replaceChildren(element('span', 'currency', '$'), document.createTextNode(amount(latest.totalBalance)));
  else value.textContent = '待查询';
  text('balanceDescription', !latest ? '完成自动签到后，汇总本次查询到的账号实际余额。' : confirmed === 0 ? '本次尚未查询到可确认的余额，请查看下方账号状态。' : partial ? `本次自动签到已确认 ${confirmed} 个账号；其余 ${count - confirmed} 个余额待确认。未查询的手动签到账号不计入总和。` : '本次自动签到账号的实际余额已确认。手动签到账号未查询的余额不计入总和。');
  text('confirmedAccounts', latest ? `${confirmed} / ${count} 个` : '待查询');
  text('availableAccounts', `${number(data.pool.availableCount)} / ${number(data.pool.configuredCount)} 个`);
  text('balanceUpdatedAt', latest?.finishedAt ? time(latest.finishedAt) : '尚无记录');
  text('lastCheckInAt', time(recentRun.finishedAt));
  text('checkInDuration', duration(recentRun.startedAt, view.running ? new Date().toISOString() : recentRun.finishedAt));
  let status = ['尚未签到', 'neutral', '等待首次签到', '点击“签到并刷新”，完成后自动更新账号余额。'];
  if (view.running) {
    const phase = !view.external && typeof checkIn.phase === 'string' ? checkIn.phase.trim() : '';
    status = ['进行中', 'warning', phase || (view.external ? '外部签到尚未完成' : '正在签到与查询余额'), '签到流程尚未完成，面板每 2 秒读取一次进度。请稍候。'];
  }
  else if (externalRun) {
    const [label, kind] = runStatus(externalRun);
    status = [label, kind, externalRun.status === 'running' ? '正在执行外部签到' : `最近签到${kind === 'success' ? '已完成' : kind === 'danger' ? '未完成' : '需查看'}（手动执行）`, '显示最近一次外部签到报告。余额范围以本次报告中的自动签到账号为准。'];
  }
  else if (checkIn.finishedAt) {
    if (view.report?.status === 'partial') status = ['部分完成', 'warning', '最近签到部分完成', `本次已确认 ${number(view.report.confirmedCount)} / ${number(view.report.accountCount)} 个账号。请检查未完成的账号。`];
    else if (view.report?.status === 'failed') status = ['未完成', 'danger', '最近签到未完成', '本次未确认任何账号余额，请检查下方记录。'];
    else if (view.report?.status === 'in_progress' || view.report?.status === 'running') status = ['需查看', 'warning', '签到报告尚未完成', '签到程序已经结束，但未生成最终余额报告。请检查本机签到日志。'];
    else status = checkIn.lastExitCode === 0 ? ['已完成', 'success', '最近签到已完成', '请以下方账号记录为准，未确认的余额不会计入总和。'] : ['需查看', 'warning', '部分流程未完成', '请检查账号状态；邮箱验证或上游异常可能需要手动处理。'];
  }
  byId('checkInBadge').replaceWith(Object.assign(badge(status[0], status[1]), { id: 'checkInBadge' }));
  text('checkInState', status[2]);
  text('checkInDescription', status[3]);
  setCheckInButton();
}

function accountIdentity(value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

function poolAccountIdentifiers(account) {
  // A manifest id and the account name in the balance report are joined by these
  // aliases. Only an association confirmed by the operator belongs here: an
  // unnamed existing Key is deliberately not assigned to an email merely because
  // it is available. Deployments fill this in, the repository ships it empty.
  const knownAliases = window.__POOL_ALIASES__ || {};
  const aliases = Object.hasOwn(knownAliases, account.id) ? knownAliases[account.id] : [];
  const label = typeof account.label === 'string' ? account.label : '';
  const labelIdentifiers = label.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|[a-z0-9][a-z0-9._-]*/gi) || [];
  const genericLabels = new Set(['agentrouter', 'github', 'api', 'key', 'apikey', 'token', 'account', 'existingkey', 'pending']);
  return new Set([...aliases, label, ...labelIdentifiers].map(accountIdentity).filter(identity => identity && !genericLabels.has(identity)));
}

function mergedAccounts(data) {
  const reports = Array.isArray(data.balances.latestRun?.accounts) ? data.balances.latestRun.accounts : [];
  const rows = reports.map(account => ({ id: account.id, label: account.username || account.label || account.id, balance: account }));
  const matchedReports = new Set();
  for (const account of data.pool.accounts || []) {
    const identifiers = poolAccountIdentifiers(account);
    const candidates = rows.map((row, index) => ({ row, index })).filter(({ row, index }) => !matchedReports.has(index) && identifiers.has(accountIdentity(row.balance?.username)));
    if (candidates.length === 1) {
      const { row, index } = candidates[0];
      row.id = account.id;
      row.pool = account;
      matchedReports.add(index);
    } else rows.push({ id: account.id, label: account.label || account.id, pool: account });
  }
  return rows;
}

function balanceStatus(account) {
  if (!account) return ['待查询', 'neutral'];
  const status = String(account.status || '').toLowerCase();
  if (['failed', 'error', 'failure'].includes(status) || account.error) return [isNumber(account.balance) ? '签到异常 · 余额已获取' : '查询未完成', 'warning'];
  if (isNumber(account.balance)) return ['余额已确认', 'success'];
  if (['success', 'ok', 'completed', 'already_checked_in'].includes(status)) return ['签到完成 · 余额待查询', 'neutral'];
  if (status === 'running' || status === 'pending') return ['查询中', 'warning'];
  return ['待查询', 'neutral'];
}

function credentialStatus(account) {
  if (!account) return ['未添加 API Key', 'neutral'];
  if (!account.enabled) return ['已停用', 'neutral'];
  if (!account.keyConfigured) return ['未添加 API Key', 'neutral'];
  if (account.duplicate) return ['重复 Key · 不参与路由', 'warning'];
  if (account.available) return ['可参与路由', 'success'];
  if (account.reason === 'invalid_key') return ['Key 无效 · 冷却中', 'danger'];
  if (account.reason === 'insufficient_balance') return ['余额不足 · 冷却中', 'warning'];
  return ['暂不可用', 'warning'];
}

function accountParticipation(row, index) {
  const cell = element('td', 'participation-cell');
  const account = row.pool;
  const pending = state.accountUpdate?.id === account?.id && Boolean(account);
  const enabled = pending ? state.accountUpdate.enabled : account?.enabled !== false && Boolean(account);
  const missingKey = !account?.keyConfigured;
  const blocked = Boolean(state.accountUpdate) || !account?.id || (!enabled && missingKey);
  const button = element('button', `pool-switch${enabled ? ' is-enabled' : ''}${pending ? ' is-pending' : ''}`);
  button.type = 'button';
  button.dataset.accountSwitch = account?.id || `report:${row.id}`;
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', `${row.label}参与号池`);
  button.setAttribute('aria-checked', String(enabled));
  button.setAttribute('aria-disabled', String(blocked));
  button.setAttribute('aria-busy', String(pending));
  const track = element('span', 'pool-switch-track');
  track.setAttribute('aria-hidden', 'true');
  track.append(element('span', 'pool-switch-thumb'));
  button.append(track, element('span', 'pool-switch-label', pending ? '保存中…' : enabled ? '已启用' : '已停用'));
  button.addEventListener('click', () => { if (!blocked) setAccountEnabled(account.id); });
  cell.append(button);
  const details = [];
  if (missingKey) details.push('添加 API Key 后可启用');
  const error = account && state.accountErrors.get(account.id);
  if (error) details.push(error);
  if (details.length) {
    const description = element('span', `cell-detail${error ? ' error-text' : ''}`, details.join('；'));
    description.id = `pool-switch-help-${index}`;
    button.setAttribute('aria-describedby', description.id);
    cell.append(description);
  }
  return cell;
}

function renderAccounts(data) {
  const all = mergedAccounts(data);
  const search = byId('accountSearch').value.trim().toLocaleLowerCase();
  const rows = all.filter(row => `${row.label} ${row.id} ${row.balance?.username || ''}`.toLocaleLowerCase().includes(search));
  text('accountCount', all.length);
  const body = byId('accountRows');
  const focusId = body.contains(document.activeElement) ? document.activeElement.dataset.accountSwitch : null;
  if (!rows.length) return emptyTable(body, 7, search ? '没有匹配的账号，请更换搜索词。' : '尚无账号记录。完成一次签到后，这里会显示余额与凭据状态。');
  const fragment = document.createDocumentFragment();
  for (const [index, row] of rows.entries()) {
    const tr = element('tr');
    const identity = element('td');
    const accountCell = element('div', 'account-cell');
    const description = element('div');
    description.append(element('div', 'account-name', row.label), element('div', 'account-meta', row.balance ? `${row.balance.provider || 'AgentRouter'} · ${String(row.balance.method || '签到').replace(/^github$/i, 'GitHub')}` : '已配置路由账号'));
    accountCell.append(element('span', 'account-avatar', String(index + 1).padStart(2, '0')), description);
    identity.append(accountCell);
    const check = element('td');
    check.append(badge(...balanceStatus(row.balance)));
    if (row.balance?.error) check.append(element('span', 'cell-detail error-text', '签到或余额查询未完成，请查看本机签到日志。'));
    const balance = element('td', 'numeric');
    balance.append(element('span', 'balance-number', amount(row.balance?.balance)));
    if (isNumber(row.balance?.bonus)) balance.append(element('div', 'bonus-detail', `赠送额度 $${amount(row.balance.bonus)}`));
    const used = element('td', 'numeric', isNumber(row.balance?.used) ? amount(row.balance.used) : '—');
    const credential = element('td');
    credential.append(badge(...credentialStatus(row.pool)));
    if (row.pool?.cooldownUntil) credential.append(element('span', 'cell-detail', `至 ${time(row.pool.cooldownUntil)}`));
    tr.append(identity, check, balance, used, credential, accountParticipation(row, index), element('td', '', time(row.balance?.updatedAt)));
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
  if (focusId) [...body.querySelectorAll('[data-account-switch]')].find(button => button.dataset.accountSwitch === focusId)?.focus({ preventScroll: true });
}

function renderMetrics(metrics) {
  text('metricScope', `最近 ${hoursLabel()} · 统一入口的实际请求记录`);
  text('requestTotal', number(metrics.total));
  text('requestResults', isNumber(metrics.total) ? `${number(metrics.success)} 成功 · ${number(metrics.failed)} 失败` : '暂无请求记录');
  text('successRate', metrics.total > 0 && isNumber(metrics.successRate) ? `${number(metrics.successRate)}%` : '—');
  text('averageLatency', isNumber(metrics.averageLatencyMs) && metrics.total > 0 ? metrics.averageLatencyMs < 1000 ? `${number(metrics.averageLatencyMs)} ms` : `${number(metrics.averageLatencyMs / 1000)} s` : '—');
  const reported = metrics.tokensReportedCount > 0;
  text('tokenTotal', reported ? number(metrics.totalTokens) : '—');
  text('tokenReported', reported ? `${number(metrics.tokensReportedCount)} 条请求报告 usage` : '暂无上游 usage');
  text('rpm', number(metrics.rpm));
  text('tpm', reported ? number(metrics.tpm) : '—');
  text('cacheRatio', reported && metrics.inputTokens > 0 && isNumber(metrics.cachedTokens) ? `缓存率 ${number(metrics.cachedTokens / metrics.inputTokens * 100)}%` : '缓存率 —');
  renderTimeline(metrics.timeline || []);
  renderTokens(metrics, reported);
  document.querySelector('[data-chart-metric="tokens"]').disabled = !reported;
  if (!reported && state.chartMetric === 'tokens') state.chartMetric = 'requests';
  renderRequests(metrics);
}

function renderTimeline(timeline) {
  const node = byId('healthTimeline');
  const capacity = Math.max(1, Math.min(180, Math.floor(node.clientWidth / 5)));
  const entries = timeline.filter(entry => dateValue(entry.at) !== null).sort((a, b) => dateValue(a.at) - dateValue(b.at)).slice(-capacity);
  if (!entries.length) {
    node.replaceChildren(element('p', 'empty-inline', '当前范围暂无请求记录'));
    node.setAttribute('aria-label', '当前范围暂无请求记录');
    text('timelineStart', '—'); text('timelineEnd', '—'); text('timelineCaption', '每格代表一条请求');
    return;
  }
  const fragment = document.createDocumentFragment();
  let failed = 0;
  for (const entry of entries) {
    const failure = entry.aborted === true || Boolean(entry.failed) || isNumber(entry.status) && entry.status >= 400;
    if (failure) failed++;
    const block = element('span', `timeline-block${failure ? ' failed' : !isNumber(entry.status) ? ' unknown' : ''}`);
    block.title = `${time(entry.at)} · HTTP ${entry.status ?? '—'}${entry.aborted ? ' · 流已中断' : ''} · ${entry.route || '未知路由'} · ${entry.model || '未知模型'} · ${number(entry.ms)} ms`;
    block.setAttribute('aria-hidden', 'true');
    fragment.append(block);
  }
  node.replaceChildren(fragment);
  node.setAttribute('aria-label', `最近 ${entries.length} 条请求，${failed} 条失败，${entries.length - failed} 条未标记失败。`);
  text('timelineStart', time(entries[0].at)); text('timelineEnd', time(entries.at(-1).at));
  text('timelineCaption', `最近 ${entries.length} 条 · 每格一条请求`);
}

function renderTokens(metrics, reported) {
  const container = byId('tokenComposition');
  if (!reported) return container.replaceChildren(element('p', 'empty-inline', '暂无上游 usage，无法统计 Token 构成。'));
  const hasComposition = isNumber(metrics.inputTokens) && isNumber(metrics.outputTokens);
  const completeComposition = hasComposition && metrics.totalTokens === metrics.inputTokens + metrics.outputTokens;
  const total = completeComposition ? metrics.totalTokens : 0;
  const bar = element('div', 'token-bar');
  const image = svgElement('svg', { viewBox: '0 0 100 8', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const inputWidth = total > 0 ? metrics.inputTokens / total * 100 : 0;
  image.append(svgElement('rect', { x: 0, y: 0, width: inputWidth, height: 8, class: 'token-segment' }), svgElement('rect', { x: inputWidth, y: 0, width: 100 - inputWidth, height: 8, class: 'token-segment output' }));
  if (total > 0) bar.append(image);
  const details = element('dl', 'token-breakdown');
  for (const [label, value, kind] of [['输入', metrics.inputTokens, 'input'], ['输出', metrics.outputTokens, 'output'], ['其中缓存', metrics.cachedTokens, null], ['其中推理', metrics.reasoningTokens, null]]) {
    const item = element('div'); const title = element('dt');
    if (kind) title.append(element('i', kind));
    title.append(document.createTextNode(label));
    item.append(title, element('dd', '', number(value))); details.append(item);
  }
  container.replaceChildren(bar, details, element('p', 'chart-subnote', completeComposition ? '缓存与推理为子项，不重复加到 Token 总数。' : '部分 usage 未提供完整分项；这里只显示已报告的数据，不补算缺失项。'));
}

function chartFrame(label, low, high, currency = false, containerWidth = 640) {
  const width = Math.max(260, containerWidth || 640);
  const svg = svgElement('svg', { viewBox: `0 0 ${width} 180`, role: 'img', 'aria-label': label });
  const left = 56, right = width - 20, top = 12, bottom = 150;
  const y = value => bottom - (value - low) / (high - low) * (bottom - top);
  for (const ratio of [0, .5, 1]) {
    const value = low + (high - low) * ratio;
    const position = y(value);
    svg.append(svgElement('line', { x1: left, x2: right, y1: position, y2: position, class: 'chart-grid' }), svgElement('text', { x: left - 10, y: position + 3, 'text-anchor': 'end', class: 'chart-label' }, currency ? `$${number(value)}` : number(value)));
  }
  return { svg, left, right, top, bottom, y };
}

function chartTimes(frame, points) {
  frame.svg.append(svgElement('text', { x: frame.left, y: 173, class: 'chart-label' }, time(points[0].at)), svgElement('text', { x: frame.right, y: 173, 'text-anchor': 'end', class: 'chart-label' }, time(points.at(-1).at)));
}

function renderRequests(metrics) {
  for (const button of document.querySelectorAll('[data-chart-metric]')) {
    const active = button.dataset.chartMetric === state.chartMetric;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  }
  const metric = state.chartMetric;
  const points = (metrics.series || []).filter(point => dateValue(point.at) !== null).sort((a, b) => dateValue(a.at) - dateValue(b.at));
  const container = byId('requestsChart');
  if (!points.length || !(metrics.total > 0) || metric === 'tokens' && !isNumber(metrics.totalTokens)) return container.replaceChildren(element('p', 'chart-empty', metric === 'tokens' ? '当前范围暂无上游报告的 Token 记录。' : '当前范围暂无请求记录'));
  const peak = Math.max(...points.map(point => point[metric] ?? 0), 1);
  const frame = chartFrame(`最近 ${hoursLabel()}的${metric === 'tokens' ? 'Token' : '请求'}趋势`, 0, Math.ceil(peak * 1.15), false, container.clientWidth);
  const slot = (frame.right - frame.left) / points.length;
  for (const [index, point] of points.entries()) {
    if (!isNumber(point[metric])) {
      const marker = svgElement('circle', { cx: frame.left + slot * (index + .5), cy: frame.bottom - 3, r: 3, class: 'trend-missing' });
      marker.append(svgElement('title', {}, `${time(point.at)} · 用量未上报`)); frame.svg.append(marker); continue;
    }
    const height = frame.bottom - frame.y(point[metric]);
    const bar = svgElement('rect', { x: frame.left + slot * index + slot * .16, y: frame.y(point[metric]), width: Math.max(1, slot * .68), height, rx: 2, class: 'chart-bar' });
    bar.append(svgElement('title', {}, `${time(point.at)} · ${number(point[metric])} ${metric === 'tokens' ? 'Token' : '次请求'}`));
    frame.svg.append(bar);
  }
  chartTimes(frame, points);
  container.replaceChildren(frame.svg);
}

function runStatus(run) {
  const status = String(run.status || '').toLowerCase();
  if (status === 'running' || status === 'in_progress') return ['执行中', 'warning'];
  if (['failed', 'error', 'failure'].includes(status)) return ['未完成', 'danger'];
  if (status === 'partial' || run.confirmedCount < run.accountCount) return ['部分确认', 'warning'];
  if (['success', 'completed', 'ok'].includes(status)) return ['已完成', 'success'];
  return ['状态待确认', 'neutral'];
}

function renderHistory(balances) {
  const runs = Array.isArray(balances.runs) ? balances.runs : [];
  text('historyCount', runs.length ? `${runs.length} 次签到` : '暂无记录');
  const body = byId('historyRows');
  if (!runs.length) emptyTable(body, 5, '尚无签到历史。完成一次签到后，将保存真实余额快照。');
  else {
    const fragment = document.createDocumentFragment();
    for (const run of runs) {
      const row = element('tr'); const status = element('td'); status.append(badge(...runStatus(run)));
      row.append(element('td', '', time(run.finishedAt || run.startedAt)), status, element('td', '', `${number(run.confirmedCount)} / ${number(run.accountCount)} 个`), element('td', 'numeric balance-number', amount(run.totalBalance)), element('td', 'numeric', duration(run.startedAt, run.finishedAt)));
      fragment.append(row);
    }
    body.replaceChildren(fragment);
  }
  const boundary = Date.now() - state.hours * 3600000;
  const points = runs.filter(run => isNumber(run.totalBalance) && dateValue(run.finishedAt || run.startedAt) !== null && dateValue(run.finishedAt || run.startedAt) >= boundary).map(run => ({ at: run.finishedAt || run.startedAt, value: run.totalBalance, partial: run.confirmedCount < run.accountCount })).sort((a, b) => dateValue(a.at) - dateValue(b.at));
  const container = byId('balanceChart');
  if (!points.length) return container.replaceChildren(element('p', 'chart-empty', `最近 ${hoursLabel()}尚无已确认的余额快照。签到完成后会在这里记录。`));
  const smallest = Math.min(...points.map(point => point.value));
  const largest = Math.max(...points.map(point => point.value));
  const padding = Math.max((largest - smallest) * .2, largest * .03, 1);
  const frame = chartFrame(`最近 ${hoursLabel()}的已确认余额趋势，${points.length} 个真实快照`, smallest < 0 ? smallest - padding : Math.max(0, smallest - padding), largest + padding, true, container.clientWidth);
  const first = dateValue(points[0].at), last = dateValue(points.at(-1).at);
  const coordinates = points.map(point => ({ ...point, x: first === last ? (frame.left + frame.right) / 2 : frame.left + (dateValue(point.at) - first) / (last - first) * (frame.right - frame.left), y: frame.y(point.value) }));
  if (points.length > 1) {
    const path = coordinates.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
    frame.svg.append(svgElement('path', { d: `${path} L${coordinates.at(-1).x},${frame.bottom} L${coordinates[0].x},${frame.bottom} Z`, class: 'chart-area' }), svgElement('path', { d: path, class: 'chart-line' }));
  }
  for (const point of coordinates) {
    const circle = svgElement('circle', { cx: point.x, cy: point.y, r: 4, class: `chart-point${point.partial ? ' partial' : ''}` });
    circle.append(svgElement('title', {}, `${time(point.at)} · $${amount(point.value)}${point.partial ? ' · 部分账号已确认' : ''}`)); frame.svg.append(circle);
  }
  chartTimes(frame, points);
  container.replaceChildren(frame.svg);
  if (points.length === 1) container.append(element('p', 'chart-subnote', '已记录首个真实快照；完成下一次签到后即可对比余额变化。'));
  else if (points.some(point => point.partial)) container.append(element('p', 'chart-subnote', '黄色节点表示仅部分账号余额已确认，比较总额时请同时查看确认账号数。'));
}

function render(data) {
  renderSummary(data);
  renderAccounts(data);
  renderMetrics(data.metrics);
  renderHistory(data.balances);
  window.gatewayUsageRender?.(data, state.hours);
}

byId('themeToggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
byId('refreshButton').addEventListener('click', refresh);
byId('checkInButton').addEventListener('click', startCheckIn);
byId('accountSearch').addEventListener('input', () => { if (state.data) renderAccounts(state.data); });
for (const button of document.querySelectorAll('[data-hours]')) button.addEventListener('click', () => {
  state.hours = Number(button.dataset.hours);
  for (const candidate of document.querySelectorAll('[data-hours]')) { const active = candidate === button; candidate.classList.toggle('active', active); candidate.setAttribute('aria-pressed', String(active)); }
  refresh();
});
for (const button of document.querySelectorAll('[data-chart-metric]')) button.addEventListener('click', () => { state.chartMetric = button.dataset.chartMetric; if (state.data) renderRequests(state.data.metrics); });

let savedTheme;
try { savedTheme = localStorage.getItem('gateway-dashboard-theme'); } catch { /* Use the OS preference. */ }
setTheme(savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) history.replaceState(null, '', location.pathname + location.search);
try { sessionStorage.removeItem('gateway-dashboard-token'); } catch { /* Old versions stored a token here. */ }
refresh();
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.data) { renderTimeline(state.data.metrics.timeline || []); renderRequests(state.data.metrics); renderHistory(state.data.balances); } }, 160); });
