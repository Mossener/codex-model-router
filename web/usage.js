'use strict';

(() => {
  const get = id => document.getElementById(id);
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const integer = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const short = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
  const datetime = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const ui = { data: null, hours: 4, rank: 'tokens', page: 1, result: null, controller: null, revision: 0, filters: { model: '', account: '', status: 'all', usage: 'all' } };
  const tokens = value => numeric(value) ? integer.format(value) : '未上报';
  const compact = value => numeric(value) ? short.format(value) : '未上报';
  const routeName = route => ({ original: 'Axon', agentrouter: 'AgentRouter', opencode: 'OpenCode' })[route] || '未知线路';
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const write = (id, value) => { get(id).textContent = value; };
  const formatTime = value => Number.isFinite(Date.parse(value)) ? datetime.format(new Date(value)) : '时间未知';
  const accountLabel = group => {
    const id = group.accountId;
    return ui.data?.pool?.accounts?.find(account => account.id === id)?.label || (id ? id : `${routeName(group.route)} · 独立线路`);
  };
  const failed = record => Boolean(record.aborted || record.failed || !numeric(record.status) || record.status >= 400 || record.status < 200);
  const outcome = record => record.aborted ? '流中断' : record.failed ? '上游回复失败' : failed(record) ? '请求失败' : '成功';
  const dot = index => make('i', `usage-dot palette-${index % 6}`);
  const empty = (body, span, message) => {
    const row = make('tr'); const cell = make('td', 'empty-cell', message);
    cell.colSpan = span; row.append(cell); body.replaceChildren(row);
  };

  function updateSelect(id, entries, allLabel, filter) {
    const select = get(id);
    const options = [{ value: '', label: allLabel }, ...entries];
    if (ui.filters[filter] && !entries.some(entry => entry.value === ui.filters[filter])) options.push({ value: ui.filters[filter], label: `${ui.filters[filter]}（当前范围无记录）` });
    const signature = JSON.stringify(options);
    if (select.dataset.signature !== signature) {
      select.replaceChildren(...options.map(entry => { const option = make('option', '', entry.label); option.value = entry.value; return option; }));
      select.dataset.signature = signature;
    }
    select.value = ui.filters[filter];
  }

  function renderModels() {
    const metrics = ui.data?.metrics ?? {};
    const groups = [...(metrics.byModel ?? [])].sort((a, b) => ui.rank === 'requests' ? b.requests - a.requests : (b.totalTokens ?? -1) - (a.totalTokens ?? -1));
    const reported = metrics.totalTokensReportedCount ?? 0;
    write('usageTotal', compact(metrics.totalTokens));
    get('usageTotal').title = tokens(metrics.totalTokens);
    write('usageModelCount', integer.format(groups.length));
    write('usageCoverageRate', metrics.total ? `${(reported / metrics.total * 100).toFixed(1)}%` : '—');
    write('usageCoverage', `${integer.format(metrics.total ?? 0)} 次请求 · ${integer.format(reported)} 次上报总 Token · ${integer.format(metrics.tokensMissingCount ?? 0)} 次未上报`);
    const body = get('modelUsageRows');
    if (!groups.length) return empty(body, 5, '当前范围暂无模型调用。请求完成后会显示在这里。');
    const denominator = groups.reduce((sum, group) => sum + (ui.rank === 'requests' ? group.requests : group.totalTokens ?? 0), 0);
    const fragment = document.createDocumentFragment();
    for (const [index, group] of groups.entries()) {
      const row = make('tr'); const identity = make('td');
      const model = make('button', 'usage-model-link', group.model === 'unknown' ? '历史模型未知' : group.model);
      model.type = 'button'; model.title = '筛选这个模型的请求';
      model.addEventListener('click', () => applyFilter('model', group.model));
      const upstream = group.upstreamModels?.length ? group.upstreamModels.join(' / ') : '实际上游 · 历史未记录';
      identity.append(model, make('span', 'cell-detail', upstream));
      const track = make('div', 'usage-meter');
      const image = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); image.setAttribute('viewBox', '0 0 100 4'); image.setAttribute('preserveAspectRatio', 'none'); image.setAttribute('aria-hidden', 'true');
      const rect = document.createElementNS(image.namespaceURI, 'rect'); rect.setAttribute('width', String(denominator ? (ui.rank === 'requests' ? group.requests : group.totalTokens ?? 0) / denominator * 100 : 0)); rect.setAttribute('height', '4'); rect.setAttribute('class', `usage-fill palette-${index % 6}`); image.append(rect); track.append(image); identity.append(track);
      const total = make('td', 'numeric usage-total-column'); total.append(make('strong', '', tokens(group.totalTokens)));
      total.append(make('span', 'cell-detail', group.tokensMissingCount ? `${integer.format(group.tokensMissingCount)} 次未上报` : '用量完整'));
      row.append(identity, make('td', 'numeric', integer.format(group.requests)), make('td', 'numeric', tokens(group.inputTokens)), make('td', 'numeric', tokens(group.outputTokens)), total); fragment.append(row);
    }
    body.replaceChildren(fragment);
  }

  function renderDistribution() {
    const groups = ui.data?.metrics?.byAccount ?? [];
    const total = groups.reduce((sum, group) => sum + (group.totalTokens ?? 0), 0);
    const chart = get('usageDonut'); chart.replaceChildren();
    write('distributionRange', ui.hours === 168 ? '7 天' : `${ui.hours} 小时`);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 120 120'); svg.setAttribute('aria-hidden', 'true');
    const circle = (className, length = 100, offset = 0) => {
      const node = document.createElementNS(svg.namespaceURI, 'circle');
      for (const [key, value] of Object.entries({ cx: 60, cy: 60, r: 47, fill: 'none', 'stroke-width': 13, pathLength: 100, 'stroke-dasharray': `${length} ${100 - length}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 60 60)' })) node.setAttribute(key, value);
      node.setAttribute('class', className); return node;
    };
    svg.append(circle('usage-ring-background'));
    let offset = 0;
    for (const [index, group] of groups.entries()) {
      const percent = total ? (group.totalTokens ?? 0) / total * 100 : 0;
      if (percent > 0) svg.append(circle(`usage-ring palette-${index % 6}`, percent, offset));
      offset += percent;
    }
    chart.append(svg, make('span', 'donut-center', total ? compact(total) : '暂无用量'));
    chart.setAttribute('aria-label', total ? groups.map(group => `${accountLabel(group)}：${tokens(group.totalTokens)} Token`).join('；') : '当前范围暂无上报用量');
    const rows = get('accountUsageRows');
    if (!groups.length) return rows.replaceChildren(make('p', 'empty-inline', '当前范围暂无线路与账号记录'));
    rows.replaceChildren(...groups.map((group, index) => {
      const button = make('button', 'distribution-row'); button.type = 'button';
      const identity = make('span', 'distribution-identity'); identity.append(dot(index), make('strong', '', accountLabel(group)), make('span', 'cell-detail', `${routeName(group.route)} · ${integer.format(group.requests)} 次请求`));
      const value = make('span', 'distribution-value'); value.append(make('strong', '', compact(group.totalTokens)), make('span', 'cell-detail', total && numeric(group.totalTokens) ? `${(group.totalTokens / total * 100).toFixed(1)}%` : '总 Token 未上报'));
      button.title = `查看 ${accountLabel(group)} 的请求`; button.append(identity, value); button.addEventListener('click', () => applyFilter('account', group.key)); return button;
    }));
  }

  function renderTrend() {
    const points = ui.data?.metrics?.series ?? [];
    const chart = get('tokenTrendChart');
    write('trendRangeLabel', ui.hours === 168 ? '7 天' : `${ui.hours} 小时`);
    if (!points.some(point => numeric(point.tokens) && point.requests > 0)) return chart.replaceChildren(make('p', 'chart-empty', '当前范围没有上报的 Token 用量；请求记录中的未上报项仍会保留。'));
    const width = Math.max(300, chart.clientWidth || 960), left = 70, right = width - 28, top = 16, bottom = 205;
    const high = Math.max(1, ...points.map(point => point.tokens ?? 0)) * 1.12;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', `0 0 ${width} 240`); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', '按时间分组的 Token 趋势，每个时间段可用 Tab 查看');
    const shape = (tag, attributes, content) => {
      const node = document.createElementNS(svg.namespaceURI, tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      if (content !== undefined) node.textContent = content; return node;
    };
    const y = value => bottom - value / high * (bottom - top);
    for (let tick = 0; tick <= 4; tick++) {
      const value = high * tick / 4;
      svg.append(shape('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'chart-grid' }), shape('text', { x: left - 10, y: y(value) + 4, 'text-anchor': 'end', class: 'chart-label' }, compact(value)));
    }
    const slot = (right - left) / points.length;
    for (const [index, point] of points.entries()) {
      const group = shape('g', { tabindex: 0, role: 'img' });
      const readout = `${formatTime(point.at)} · ${integer.format(point.requests)} 次请求 · 总 Token ${tokens(point.tokens)} · 输入 ${tokens(point.inputTokens)} · 输出 ${tokens(point.outputTokens)} · 其中缓存 ${tokens(point.cachedTokens)} · ${point.tokensMissingCount ?? 0} 次总 Token 未上报`;
      group.setAttribute('aria-label', readout); group.append(shape('title', {}, readout));
      group.append(shape('rect', { x: left + slot * index, y: top, width: slot, height: bottom - top, fill: 'transparent', class: 'trend-hit' }));
      const complete = numeric(point.inputTokens) && numeric(point.outputTokens) && point.inputTokens + point.outputTokens === point.tokens;
      const cached = complete && numeric(point.cachedTokens) ? Math.min(point.cachedTokens, point.inputTokens) : 0;
      const pieces = complete ? [[point.inputTokens - cached, 0], [cached, 1], [point.outputTokens, 2]] : [[point.tokens ?? 0, 3]];
      let cumulative = 0;
      for (const [value, color] of pieces) {
        if (value > 0) group.append(shape('rect', { x: left + slot * index + slot * .17, y: y(cumulative + value), width: Math.max(1, slot * .66), height: value / high * (bottom - top), class: `usage-fill palette-${color}` }));
        cumulative += value;
      }
      if (point.tokensMissingCount) group.append(shape('circle', { cx: left + slot * (index + .5), cy: bottom - 3, r: 3, class: 'trend-missing' }));
      for (const type of ['mouseenter', 'focus']) group.addEventListener(type, () => write('tokenTrendReadout', readout));
      svg.append(group);
    }
    const labelTime = value => formatTime(value).slice(0, -3);
    svg.append(shape('text', { x: left, y: 231, class: 'chart-label' }, labelTime(points[0].at)), shape('text', { x: right, y: 231, 'text-anchor': 'end', class: 'chart-label' }, labelTime(points.at(-1).at)));
    chart.replaceChildren(svg);
  }

  function applyFilter(key, value) {
    ui.filters[key] = value; ui.page = 1;
    get(key === 'model' ? 'requestModel' : 'requestAccount').value = value;
    loadRequests(); get('requestHistoryHeading').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function renderRecords(result) {
    ui.result = result; ui.page = result.page;
    write('requestHistoryCount', `${integer.format(result.total)} 条记录`);
    write('requestPageLabel', `${result.total ? (result.page - 1) * result.pageSize + 1 : 0}–${Math.min(result.page * result.pageSize, result.total)} / ${integer.format(result.total)} 条 · 第 ${result.page} / ${result.pageCount} 页`);
    get('requestPreviousPage').disabled = result.page <= 1; get('requestNextPage').disabled = result.page >= result.pageCount;
    const body = get('requestHistoryRows');
    if (!result.records.length) return empty(body, 8, '当前筛选没有请求记录。可以扩大时间范围或清除筛选。');
    const fragment = document.createDocumentFragment();
    for (const [index, record] of result.records.entries()) {
      const row = make('tr'); const when = make('td');
      when.append(make('span', 'request-time', formatTime(record.at)), make('span', `badge ${failed(record) ? 'danger' : 'success'}`, `${outcome(record)} · ${record.status ?? '—'}`));
      const model = make('td'); model.append(make('strong', 'request-model', record.model === 'unknown' ? '历史模型未知' : record.model));
      if (record.upstreamModel && record.upstreamModel !== record.model) model.append(make('span', 'cell-detail', `上游 ${record.upstreamModel}`));
      const account = make('td'); account.append(make('span', '', accountLabel(record)), make('span', 'cell-detail', routeName(record.route)));
      const toggleCell = make('td'); const toggle = make('button', 'button quiet details-toggle', '详情'); toggle.type = 'button';
      const detail = make('tr', 'request-detail-row'); detail.hidden = true; detail.id = `request-detail-${index}`; const cell = make('td'); cell.colSpan = 8;
      const fields = make('dl', 'request-details');
      for (const [label, value] of [['请求模型', record.model], ['实际上游', record.upstreamModel || '历史未记录'], ['缓存 Token（输入子项）', tokens(record.usage?.cachedTokens)], ['推理 Token（输出子项）', tokens(record.usage?.reasoningTokens)], ['换账号次数', record.rotated ?? 0], ['上下文重建次数', record.rebuilt ?? 0], ['限速等待', `${record.waited ?? 0} 秒`], ['失败类别', record.failed || (record.aborted ? '流中断' : failed(record) ? 'HTTP / 连接失败' : '无')]]) {
        const item = make('div'); item.append(make('dt', '', label), make('dd', '', value)); fields.append(item);
      }
      cell.append(fields); detail.append(cell); toggle.setAttribute('aria-controls', detail.id); toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => { detail.hidden = !detail.hidden; toggle.setAttribute('aria-expanded', String(!detail.hidden)); toggle.textContent = detail.hidden ? '详情' : '收起'; }); toggleCell.append(toggle);
      row.append(when, model, account, make('td', 'numeric', tokens(record.usage?.inputTokens)), make('td', 'numeric', tokens(record.usage?.outputTokens)), make('td', 'numeric token-total', tokens(record.usage?.totalTokens)), make('td', 'numeric', numeric(record.ms) ? `${(record.ms / 1000).toFixed(2)} s` : '—'), toggleCell); fragment.append(row, detail);
    }
    body.replaceChildren(fragment);
  }

  async function loadRequests() {
    ui.controller?.abort(); const controller = new AbortController(); ui.controller = controller; const revision = ++ui.revision;
    const timeout = setTimeout(() => controller.abort('timeout'), 20000);
    const params = new URLSearchParams({ hours: ui.hours, page: ui.page, pageSize: 25 });
    for (const [key, value] of Object.entries(ui.filters)) if (value && value !== 'all') params.set(key, value);
    get('requestHistoryRows').setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(`/dashboard/api/requests?${params}`, { signal: controller.signal, mode: 'same-origin', credentials: 'omit', referrerPolicy: 'same-origin', redirect: 'error', cache: 'no-store', headers: { 'X-Gateway-Local': '1', Accept: 'application/json' } });
      if (!response.ok) throw new Error(`请求记录读取失败（HTTP ${response.status}）`);
      const result = await response.json();
      if (revision !== ui.revision) return;
      if (!Array.isArray(result.records) || !numeric(result.total) || !Number.isInteger(result.page) || !Number.isInteger(result.pageCount)) throw new Error('本机服务返回的请求记录不完整');
      renderRecords(result); get('requestHistoryError').hidden = true;
    } catch (error) {
      if (revision !== ui.revision || controller.signal.aborted && controller.signal.reason !== 'timeout') return;
      write('requestHistoryError', controller.signal.reason === 'timeout' ? '读取超时，请刷新重试。保留上次记录。' : error.message); get('requestHistoryError').hidden = false;
    } finally {
      clearTimeout(timeout); if (revision === ui.revision) get('requestHistoryRows').setAttribute('aria-busy', 'false');
    }
  }

  window.gatewayUsageRender = (data, hours) => {
    if (ui.hours !== hours) { ui.hours = hours; ui.page = 1; }
    ui.data = data; renderModels(); renderDistribution(); renderTrend();
    updateSelect('requestModel', (data.metrics.byModel ?? []).map(group => ({ value: group.model, label: group.model })), '全部模型', 'model');
    updateSelect('requestAccount', (data.metrics.byAccount ?? []).map(group => ({ value: group.key, label: accountLabel(group) })), '全部线路与账号', 'account');
    loadRequests();
  };
  for (const button of document.querySelectorAll('[data-usage-rank]')) button.addEventListener('click', () => {
    ui.rank = button.dataset.usageRank;
    for (const item of document.querySelectorAll('[data-usage-rank]')) { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); }
    renderModels();
  });
  for (const [id, filter] of [['requestModel', 'model'], ['requestAccount', 'account'], ['requestStatus', 'status'], ['requestUsage', 'usage']]) get(id).addEventListener('change', () => { ui.filters[filter] = get(id).value; ui.page = 1; loadRequests(); });
  get('resetRequestFilters').addEventListener('click', () => { ui.filters = { model: '', account: '', status: 'all', usage: 'all' }; for (const [id, value] of [['requestModel', ''], ['requestAccount', ''], ['requestStatus', 'all'], ['requestUsage', 'all']]) get(id).value = value; ui.page = 1; loadRequests(); });
  get('requestPreviousPage').addEventListener('click', () => { if (ui.page > 1) { ui.page--; loadRequests(); } });
  get('requestNextPage').addEventListener('click', () => { if (ui.result && ui.page < ui.result.pageCount) { ui.page++; loadRequests(); } });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (ui.data) renderTrend(); }, 100); });
  if (typeof state !== 'undefined' && state.data) window.gatewayUsageRender(state.data, state.hours);
})();
