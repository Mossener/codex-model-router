import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountSettings, lowBalanceAccounts, recoveredAccounts } from './account-settings.mjs';

const accounts = [{ id: 'a', label: 'alice@example.test', enabled: true }, { id: 'b', label: 'bob', enabled: true }];
const stamp = '2026-01-01T00:00:00Z';
const row = (balance, extra = {}) => ({ username: 'alice@example.test', provider: 'agentrouter', status: 'success', balance, updatedAt: stamp, ...extra });
const report = (...rows) => ({ accounts: rows });

test('only confirmed balances strictly below twenty auto-disable', () => {
  // 负数＝欠费透支，和 0 一样属于低于阈值。
  for (const balance of [0, 19.99, -1, -0.179214]) assert.deepEqual(lowBalanceAccounts(accounts, [report(row(balance))]), ['a']);
  for (const balance of [20, 20.01, null, '10', NaN]) assert.deepEqual(lowBalanceAccounts(accounts, [report(row(balance))]), []);
  assert.deepEqual(lowBalanceAccounts(accounts, [report(row(1, { status: 'failed' }))]), []);
  assert.deepEqual(lowBalanceAccounts(accounts, [report(row(1, { provider: 'other' }))]), []);
});

test('newest confirmed result wins and ambiguous identity is ignored', () => {
  assert.deepEqual(lowBalanceAccounts(accounts, [report(row(1)), report(row(25, { updatedAt: '2026-01-02T00:00:00Z' }))]), []);
  assert.deepEqual(lowBalanceAccounts([...accounts, { id:'duplicate', label:accounts[0].label }], [report(row(1))]), []);
});

test('manual enable ignores stale results but a new low result stops it again', () => {
  const manual = [{ ...accounts[0], stateChangedAt: '2026-01-02T00:00:00Z' }];
  assert.deepEqual(lowBalanceAccounts(manual, [report(row(1))]), []);
  assert.deepEqual(lowBalanceAccounts(manual, [report(row(1, { updatedAt:'2026-01-03T00:00:00Z' }))]), ['a']);
});

test('a guard stop never relabels a manual stop and a fresh balance above the threshold restores it', t => {
  const root = mkdtempSync(join(tmpdir(), 'balance-stop-'));
  const path = join(root, 'account-pool.json');
  writeFileSync(path, JSON.stringify({ accounts, retained: 'yes' }));
  writeFileSync(join(root, 'balance-query-history.json'), JSON.stringify({ latestRun: report(row(19)), runs:[] }));
  const options = { root, balanceGuard: false, getPoolStatus: () => ({ accounts: accounts.map(account => ({ ...account, keyConfigured:true })) }) };
  const settings = createAccountSettings(options); t.after(() => settings.close());
  assert.deepEqual(settings.applyBalanceGuard(), ['a']);
  const disk = () => JSON.parse(readFileSync(path,'utf8'));
  assert.equal(disk().accounts[0].enabled, false);
  assert.equal(disk().accounts[0].disabledReason, 'low_balance');
  assert.equal(disk().retained, 'yes');
  // Same stop, but the reading arrives minutes later with a topped-up balance.
  writeFileSync(join(root, 'balance-query-history.json'), JSON.stringify({ latestRun: report(row(200, {updatedAt:'2099-01-01T00:00:00Z'})), runs:[] }));
  const reloaded = createAccountSettings(options); t.after(() => reloaded.close());
  reloaded.applyBalanceGuard();
  assert.equal(disk().accounts[0].enabled, true, 'a topped-up account comes back without a manual toggle');
  assert.equal(disk().accounts[0].disabledReason, undefined);
  assert.equal(disk().accounts[0].disabledAt, undefined);
  // A manual stop carries no reason, so the guard must leave it alone.
  reloaded.setEnabled('b', false);
  writeFileSync(join(root, 'balance-query-history.json'), JSON.stringify({ latestRun: report(row(200, {updatedAt:'2099-06-01T00:00:00Z'})), runs:[] }));
  reloaded.applyBalanceGuard();
  assert.equal(disk().accounts[1].enabled, false, 'the guard only undoes its own stops');
});

test('recovery needs a confirmed balance above the threshold taken after the stop settles', () => {
  const stop = { id: 'a', label: 'alice@example.test', enabled: false, disabledReason: 'low_balance', disabledAt: stamp };
  const at = updatedAt => [report(row(200, { updatedAt }))];
  const late = new Date(Date.parse(stamp) + 6 * 60 * 1000).toISOString();
  assert.deepEqual(recoveredAccounts([stop], at(late)), ['a']);
  assert.deepEqual(recoveredAccounts([stop], at(stamp)), [], 'the reading that triggered the stop is not a recovery');
  assert.deepEqual(recoveredAccounts([stop], at(new Date(Date.parse(stamp) + 60 * 1000).toISOString())), [], 'a reading a minute later cannot prove anything');
  assert.deepEqual(recoveredAccounts([{ ...stop, disabledReason: undefined }], at(late)), [], 'a manual stop never comes back');
  assert.deepEqual(recoveredAccounts([{ ...stop, enabled: true }], at(late)), []);
  assert.deepEqual(recoveredAccounts([stop], [report(row(24.99, { updatedAt: late }))]), [], 'the 20/25 window is hysteresis');
  assert.deepEqual(recoveredAccounts([stop], [report(row(25, { updatedAt: late }))]), ['a']);
});

test('request balance failure records a fixed reason and preserves a manual stop', t => {
  const root = mkdtempSync(join(tmpdir(), 'request-stop-'));
  const path = join(root, 'account-pool.json');
  writeFileSync(path, JSON.stringify({accounts}));
  const settings = createAccountSettings({root,balanceGuard:false,getPoolStatus:()=>({accounts:accounts.map(account=>({...account,keyConfigured:true}))})});
  t.after(()=>settings.close());
  assert.equal(settings.autoDisable('a','insufficient_balance'),true);
  assert.equal(JSON.parse(readFileSync(path)).accounts[0].disabledReason,'insufficient_balance');
  settings.setEnabled('b',false);
  assert.equal(settings.autoDisable('b','low_balance'),false);
  assert.equal(JSON.parse(readFileSync(path)).accounts[1].disabledReason,undefined);
});

test('a standalone balance report automatically triggers the persisted guard', async t => {
  const root = mkdtempSync(join(tmpdir(), 'watch-balance-stop-'));
  const path = join(root, 'account-pool.json');
  writeFileSync(path, JSON.stringify({accounts}));
  const settings = createAccountSettings({root,getPoolStatus:()=>({accounts:[]})});
  t.after(()=>settings.close());
  writeFileSync(join(root,'balance-query-history.json'),JSON.stringify({latestRun:report(row(10)),runs:[]}));
  const deadline=Date.now()+6500;
  while(JSON.parse(readFileSync(path)).accounts[0].enabled && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,30));
  const saved=JSON.parse(readFileSync(path)).accounts[0];
  assert.equal(saved.enabled,false);
  assert.equal(saved.disabledReason,'low_balance');
});
