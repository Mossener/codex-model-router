import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createAccountSettings } from './account-settings.mjs';

function fixture(t) {
  const parent = resolve('work', 'account-settings-fixtures');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-'));
  const manifestPath = join(root, 'account-pool.json');
  const initial = { version: 7, accounts: [
    { id: 'one', label: 'Account one', keyPath: 'keys/one.key', enabled: true, extra: 'retained' },
    { id: 'two', label: 'Account two', keyPath: 'keys/two.key', enabled: false },
    { id: 'missing', label: 'No key yet', keyPath: 'keys/missing.key', enabled: false },
  ] };
  writeFileSync(manifestPath, JSON.stringify(initial));
  const store = createAccountSettings({ root, manifestPath: 'account-pool.json', getPoolStatus: () => ({ accounts: [
    { id: 'one', keyConfigured: true }, { id: 'two', keyConfigured: true }, { id: 'missing', keyConfigured: false },
  ] }) });
  t.after(() => { const target = resolve(root); assert.equal(dirname(target), parent); assert.match(target.split(/[\\/]/).at(-1), /^fixture-/); rmSync(target, { recursive: true, force: true }); });
  return { root, manifestPath, initial, store, read: () => JSON.parse(readFileSync(manifestPath, 'utf8')) };
}

test('account switches preserve labels, key paths and unrelated manifest settings', t => {
  const f = fixture(t);
  f.store.setEnabled('one', false);
  const data = f.read();
  assert.ok(Number.isFinite(Date.parse(data.accounts[0].stateChangedAt)));
  assert.deepEqual(data, { ...f.initial, accounts: [{ ...f.initial.accounts[0], enabled: false, stateChangedAt: data.accounts[0].stateChangedAt }, ...f.initial.accounts.slice(1)] });
  f.store.setEnabled('two', true);
  assert.equal(f.read().accounts[1].enabled, true);
  assert.equal(f.read().accounts[0].enabled, false);
  assert.deepEqual(readdirSync(f.root), ['account-pool.json']);
});

test('each switch reads the latest disk state and preserves other updates', t => {
  const f = fixture(t);
  f.store.setEnabled('one', false);
  const data = f.read(); data.note = 'external change';
  writeFileSync(f.manifestPath, JSON.stringify(data));
  f.store.setEnabled('two', true);
  assert.equal(f.read().note, 'external change');
  assert.equal(f.read().accounts[0].enabled, false);
});

test('switches reject nonboolean flags and unknown account IDs without mutation', t => {
  const f = fixture(t); const before = readFileSync(f.manifestPath, 'utf8');
  for (const value of ['false', 1, null, undefined]) assert.throws(() => f.store.setEnabled('one', value), error => error.statusCode === 400);
  assert.throws(() => f.store.setEnabled('absent', true), error => error.statusCode === 404);
  assert.throws(() => f.store.setEnabled('../dashboard', true), error => error.statusCode === 400);
  assert.equal(readFileSync(f.manifestPath, 'utf8'), before);
});

test('accounts without a key cannot be enabled but can be kept disabled', t => {
  const f = fixture(t);
  assert.throws(() => f.store.setEnabled('missing', true), error => error.statusCode === 400);
  f.store.setEnabled('missing', false);
  assert.equal(f.read().accounts[2].enabled, false);
});

test('duplicate or malformed manifests fail safely without overwriting the source', t => {
  const f = fixture(t);
  const duplicate = { accounts: [f.initial.accounts[0], f.initial.accounts[0]] };
  writeFileSync(f.manifestPath, JSON.stringify(duplicate));
  assert.throws(() => f.store.setEnabled('one', false), error => error.statusCode === 503);
  assert.deepEqual(f.read(), duplicate);
  writeFileSync(f.manifestPath, '{invalid');
  assert.throws(() => f.store.setEnabled('one', false), error => error.statusCode === 503);
  assert.equal(readFileSync(f.manifestPath, 'utf8'), '{invalid');
});

test('manifest paths outside the installation cannot be used for a switch', t => {
  const f = fixture(t);
  const store = createAccountSettings({ root: f.root, manifestPath: '../outside.json', getPoolStatus: () => ({ accounts: [] }) });
  assert.throws(() => store.setEnabled('one', false), error => error.statusCode === 503);
});
