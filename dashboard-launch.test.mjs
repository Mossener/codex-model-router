import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./web/app.js', import.meta.url), 'utf8');
const action = source.slice(source.indexOf('async function startCheckIn()'), source.indexOf('function serviceBadge('));

function launchFixture(api, refresh = async () => {}) {
  const notices = [];
  const state = { token: 'test-token', triggering: false, data: { checkIn: { running: false } } };
  const context = vm.createContext({ state, api, refresh, AbortController, setTimeout, clearTimeout, Date,
    setCheckInButton() {}, checkInView: data => data.checkIn, notify: message => notices.push(message) });
  vm.runInContext(action, context);
  return { run: () => vm.runInContext('startCheckIn()', context), state, notices };
}

test('an accepted check-in is not reported as a launch failure when overview refresh fails', async () => {
  const fixture = launchFixture(async () => ({ checkIn: { running: true } }), async () => { throw new Error('overview disconnected'); });
  await fixture.run();
  assert.equal(fixture.notices.some(message => /启动未完成|无法启动/.test(message)), false);
  assert.match(fixture.notices.join(' '), /已开始/);
  assert.equal(fixture.state.triggering, false);
});

test('a timed-out POST reconciles an already running job without retrying the POST', async () => {
  let posts = 0;
  const fixture = launchFixture(async () => { posts++; throw Object.assign(new Error('timeout'), { name: 'AbortError' }); }, async () => {
    fixture.state.data.checkIn = { running: true, startedAt: new Date().toISOString() };
  });
  await fixture.run();
  assert.equal(posts, 1);
  assert.match(fixture.notices.join(' '), /已开始|已经在执行/);
  assert.doesNotMatch(fixture.notices.join(' '), /程序可用|无法启动/);
});

test('authorization errors are identified separately from missing Python', async () => {
  const fixture = launchFixture(async () => { throw Object.assign(new Error('管理凭据失效'), { status: 401 }); });
  await fixture.run();
  assert.match(fixture.notices.join(' '), /授权|凭据/);
  assert.doesNotMatch(fixture.notices.join(' '), /程序可用/);
});

test('the API exposes the safe backend error to the launch handler', async () => {
  const apiSource = source.slice(source.indexOf('async function api('), source.indexOf('function checkInView('));
  const context = vm.createContext({ state: { token: 'test-token' }, fetch: async () => ({
    ok: false, status: 503, json: async () => ({ error: '签到程序未安装完整' }),
  }) });
  vm.runInContext(apiSource, context);
  await assert.rejects(vm.runInContext("api('/dashboard/api/check-in', 'POST')", context), /签到程序未安装完整/);
});

test('the frontend submits local writes without a user-managed credential', async () => {
  const apiSource = source.slice(source.indexOf('async function api('), source.indexOf('function checkInView('));
  let request;
  const context = vm.createContext({ state: {}, fetch: async (_url, options) => {
    request = options;
    return { ok: true, json: async () => ({}) };
  } });
  vm.runInContext(apiSource, context);
  await vm.runInContext("api('/dashboard/api/check-in', 'POST')", context);
  assert.equal(request.headers['X-Gateway-Local'], '1');
  assert.equal(request.headers['X-Dashboard-Token'], undefined);
  assert.equal(request.referrerPolicy, 'same-origin');
});
