import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { summarizeRequests, queryRequests } from './usage-metrics.mjs';

// Test the real renderer and event handlers with synthetic metadata; no browser
// profile, account settings, request history or secret is read by these tests.
const html = readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('./web/usage.js', import.meta.url), 'utf8');
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.hidden = false; this.value = ''; this.clientWidth = 1000; this.namespaceURI = 'http://www.w3.org/2000/svg'; this.classList = { toggle() {} }; }
  set textContent(value) { this.content = String(value); this.children = []; }
  get textContent() { return (this.content ?? '') + this.children.map(child => child.textContent ?? '').join(''); }
  append(...nodes) { for (const node of nodes) { if (node.tagName === '#fragment') this.children.push(...node.children); else this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.content = ''; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  scrollIntoView() {}
  click() { this.listeners.click?.(); }
}
const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(events) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Node()]));
  const rankButtons = ['tokens', 'requests'].map(rank => { const node = new Node('button'); node.dataset.usageRank = rank; return node; });
  const models = new Set(['gpt-5.6-sol-ar', 'gpt-5.6-sol', 'gpt-6.1-sol']);
  const now = Date.now(); let calls = 0;
  const context = vm.createContext({
    document: { getElementById: id => { assert.ok(nodes.has(id), `Missing HTML id: ${id}`); return nodes.get(id); }, createElement: tag => new Node(tag), createElementNS: (_ns, tag) => new Node(tag), createDocumentFragment: () => new Node('#fragment'), querySelectorAll: () => rankButtons },
    window: { matchMedia: () => ({ matches: true }), addEventListener() {} },
    Intl, Date, Number, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async url => { calls++; return { ok: true, json: async () => queryRequests(events, new URL(url, 'http://localhost').searchParams, now, { knownModels: models }) }; },
  });
  vm.runInContext(source, context);
  const data = { metrics: summarizeRequests(events, 4, now, { knownModels: models }), pool: { accounts: [{ id: 'test-account', label: '合成账号' }] } };
  context.window.gatewayUsageRender(data, 4);
  return { nodes, data, context, rankButtons, calls: () => calls };
}
const sample = (index, overrides = {}) => ({ at: new Date(Date.now() - index * 60_000).toISOString(), model: 'gpt-5.6-sol-ar', upstreamModel: 'gpt-5.6-sol', route: 'agentrouter', accountId: 'test-account', status: 200, ms: 1234, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedTokens: 30, reasoningTokens: 5 }, ...overrides });

test('usage renderer maps real metadata to model ranking, account distribution and token trend', async () => {
  const fixture = fixtureWithMixed(); await settle();
  assert.match(fixture.nodes.get('modelUsageRows').textContent, /gpt-5\.6-sol-ar/);
  assert.match(fixture.nodes.get('accountUsageRows').textContent, /Axon · 独立线路/);
  assert.equal(fixture.nodes.get('tokenTrendChart').children[0].tagName, 'svg');
  assert.match(fixture.nodes.get('requestHistoryRows').textContent, /未上报/);
  assert.match(fixture.nodes.get('requestHistoryRows').textContent, /上游回复失败/);
  const row = fixture.nodes.get('requestHistoryRows').children[0];
  const detail = fixture.nodes.get('requestHistoryRows').children[1];
  row.children.at(-1).children[0].click(); assert.equal(detail.hidden, false);
  assert.match(detail.textContent, /限速等待0 秒/);
});
function fixtureWithMixed() { return fixture([sample(0, { usage: null }), sample(1, { failed: 'upstream_unavailable' }), sample(2, { route: 'original', accountId: undefined, model: 'gpt-6.1-sol', upstreamModel: 'gpt-6.1-sol' })]); }

test('filters, pagination and clearing operate on the actual requests contract', async () => {
  const f = fixture(Array.from({ length: 31 }, (_, index) => sample(index, index % 2 ? { route: 'original', accountId: undefined, model: 'gpt-6.1-sol', upstreamModel: 'gpt-6.1-sol' } : {}))); await settle();
  assert.match(f.nodes.get('requestPageLabel').textContent, /第 1 \/ 2 页/);
  f.nodes.get('requestNextPage').click(); await settle(); assert.match(f.nodes.get('requestPageLabel').textContent, /第 2 \/ 2 页/);
  f.nodes.get('requestAccount').value = 'route:original'; f.nodes.get('requestAccount').listeners.change(); await settle();
  assert.equal(f.nodes.get('requestHistoryCount').textContent, '15 条记录');
  assert.doesNotMatch(f.nodes.get('requestHistoryRows').textContent, /合成账号/);
  f.nodes.get('resetRequestFilters').click(); await settle(); assert.equal(f.nodes.get('requestHistoryCount').textContent, '31 条记录');
});

test('zero remains reported, missing history is explicit and hostile text is never parsed as HTML', async () => {
  const f = fixture([sample(0, { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, upstreamModel: undefined }), sample(1, { model: '<img onerror=attack()>', accountId: 'sk-synthetic-credential', usage: null })]); await settle();
  assert.match(f.nodes.get('requestHistoryRows').textContent, /历史模型未知/);
  assert.doesNotMatch(f.nodes.get('requestHistoryRows').textContent, /onerror|sk-synthetic/);
  assert.match(f.nodes.get('modelUsageRows').textContent, /历史未记录/);
  f.nodes.get('requestUsage').value = 'reported'; f.nodes.get('requestUsage').listeners.change(); await settle();
  assert.equal(f.nodes.get('requestHistoryCount').textContent, '1 条记录');
  assert.equal(f.nodes.get('requestHistoryRows').children[0].children[5].textContent, '0');
});

test('empty usage has a meaningful display and no NaN', async () => {
  const f = fixture([]); await settle();
  assert.match(f.nodes.get('requestHistoryRows').textContent, /没有请求记录/);
  assert.match(f.nodes.get('tokenTrendChart').textContent, /没有上报/);
  assert.equal(f.nodes.get('usageCoverageRate').textContent, '—');
  assert.doesNotMatch([...f.nodes.values()].map(node => node.textContent).join(''), /NaN|Infinity/);
});
