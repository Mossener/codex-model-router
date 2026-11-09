import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import http from 'node:http';
import net from 'node:net';

const directory = dirname(fileURLToPath(import.meta.url));
const supervisor = join(directory, 'CodexModelRouter.exe');
const tokenHelper = join(directory, 'RouterToken.exe');
const fixturesRoot = resolve(directory, 'work', 'supervisor-fixtures');
const runFile = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, timeout = 14000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await callback(); if (result) return result; } catch {}
    await pause(150);
  }
  assert.fail('Router did not become healthy before the deadline');
}

function removeFixture(fixture) {
  const target = resolve(fixture);
  assert.equal(dirname(target), fixturesRoot, 'Only a direct child of the dedicated fixture directory may be removed');
  assert.match(basename(target), /^fixture-[A-Za-z0-9_-]+$/);
  assert.equal(realpathSync(dirname(target)), realpathSync(fixturesRoot));
  assert.equal(realpathSync(target), target, 'Fixture cleanup must not follow a junction or symlink');
  rmSync(target, { recursive: true, force: true });
}

function copyModule(source, fixture, visited = new Set()) {
  const from = resolve(source);
  const modulePath = relative(directory, from);
  assert.ok(!isAbsolute(modulePath) && modulePath !== '..' && !modulePath.startsWith('..\\') && !modulePath.startsWith('../'));
  if (visited.has(from)) return;
  visited.add(from);
  const target = resolve(fixture, modulePath);
  assert.ok(target.startsWith(resolve(fixture) + '\\'), 'Copied modules must stay within the fixture');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(from, target);
  for (const match of readFileSync(from, 'utf8').matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+\.mjs)['"]/g)) {
    copyModule(resolve(dirname(from), match[1]), fixture, visited);
  }
}

function stopFixtureProcess(pid, fixture) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
  const script = [
    `$taskProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue`,
    `if ($taskProcess) {`,
    `  $taskCommand = [string]$taskProcess.CommandLine`,
    `  $taskImage = [string]$taskProcess.ExecutablePath`,
    `  $taskOwnedHost = ($taskImage -eq ${psQuote(join(fixture, 'CodexModelRouter.exe'))}) -and $taskCommand.Contains(${psQuote(fixture)})`,
    `  $taskOwnedWorker = ($taskImage -eq ${psQuote(process.execPath)}) -and $taskCommand.Contains(${psQuote(join(fixture, 'router.mjs'))})`,
    `  if ($taskOwnedHost -or $taskOwnedWorker) { Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue }`,
    `}`,
  ].join('\n');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
}

test('the version 3 supervisor recovers a crashed router and token lookup can start it without retired credentials', { timeout: 80000, skip: !existsSync(supervisor) || !existsSync(tokenHelper) ? 'run build.ps1 first: this test drives the compiled Windows host' : false }, async t => {
  assert.ok(existsSync(supervisor), 'A real Windows supervisor executable must be built');
  assert.ok(existsSync(tokenHelper), 'A real token helper executable must be built');
  assert.doesNotMatch(readFileSync(join(directory, 'RouterHost.cs'), 'utf8'), /A6API_API_KEY/);
  mkdirSync(fixturesRoot, { recursive: true });
  const fixture = mkdtempSync(join(fixturesRoot, 'fixture-'));
  let guardian;
  let identityServer;
  const workers = new Set();
  t.after(async () => {
    if (identityServer?.listening) await new Promise(resolve => identityServer.close(resolve));
    guardian?.kill();
    for (const file of ['supervisor.pid', 'worker.pid']) {
      try { workers.add(Number(readFileSync(join(fixture, file), 'utf8'))); } catch {}
    }
    for (const pid of workers) stopFixtureProcess(pid, fixture);
    await pause(500);
    removeFixture(fixture);
  });
  const reserve = net.createServer().listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  copyModule(join(directory, 'router.mjs'), fixture);
  for (const name of ['CodexModelRouter.exe', 'RouterToken.exe']) copyFileSync(join(directory, name), join(fixture, name));
  mkdirSync(join(fixture, 'keys'));
  const instanceId = `supervisor-fixture-${randomUUID()}`;
  writeFileSync(join(fixture, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-client-token' }));
  writeFileSync(join(fixture, 'catalog.json'), JSON.stringify({ models: [] }));
  writeFileSync(join(fixture, 'keys', 'fixture.key'), 'sk-fixture-test-only');
  writeFileSync(join(fixture, 'account-pool.json'), JSON.stringify({ accounts: [{ id: 'fixture', label: 'Fixture', keyPath: 'keys/fixture.key', enabled: true }] }));
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
    port, instanceId, taskName: '', defaultBaseUrl: 'https://example.invalid/v1',
    opencodeBaseUrl: 'https://example.invalid/v1', agentrouterBaseUrl: 'https://example.invalid/v1',
    authPath: join(fixture, 'auth.json'), catalogPath: join(fixture, 'catalog.json'), nodePath: process.execPath,
    agentrouterAccountsPath: join(fixture, 'account-pool.json'), agentrouterKeyPath: join(fixture, 'keys', 'fixture.key'),
  }));
  const environment = { ...process.env };
  delete environment.A6API_API_KEY;
  delete environment.AGENTROUTER_API_KEY;
  delete environment.OPENCODE_API_KEY;

  // A healthy listener from another install or a legacy v2 router must be rejected.
  let advertised = { service: 'codex-model-router', version: 3, instanceId: 'different-install', pid: process.pid };
  identityServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(advertised)); });
  identityServer.listen(port, '127.0.0.1');
  await once(identityServer, 'listening');
  async function status() {
    try {
      return await runFile(join(fixture, 'RouterToken.exe'), ['--status', '--home', fixture], { encoding: 'utf8', timeout: 4000, windowsHide: true, env: environment });
    } catch (error) { return error; }
  }
  const foreign = await status();
  assert.equal(foreign.code, 1);
  assert.equal(foreign.stdout.trim(), 'offline');
  advertised = { ...advertised, version: 2, instanceId };
  const legacy = await status();
  assert.equal(legacy.code, 1);
  assert.equal(legacy.stdout.trim(), 'offline');
  advertised = { ...advertised, version: 3 };
  const own = await status();
  assert.equal(JSON.parse(own.stdout).instanceId, instanceId);
  await new Promise(resolve => identityServer.close(resolve));

  const health = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) });
    const value = response.ok && await response.json();
    return value?.version === 3 && value.instanceId === instanceId && value;
  };
  guardian = spawn(join(fixture, 'CodexModelRouter.exe'), ['--watch', '--home', fixture], { windowsHide: true, stdio: 'ignore', env: environment });
  const first = await until(health);
  assert.equal(first.service, 'codex-model-router');
  assert.ok(Number.isInteger(first.pid));
  assert.equal(first.version, 3);
  workers.add(first.pid);
  stopFixtureProcess(first.pid, fixture);
  const second = await until(async () => { const value = await health(); return value.pid !== first.pid && value; });
  workers.add(second.pid);
  assert.notEqual(second.pid, first.pid, 'A crashed router must be replaced without logging in again');

  guardian.kill();
  await until(() => guardian.exitCode !== null || guardian.signalCode !== null, 4000);
  stopFixtureProcess(second.pid, fixture);
  await pause(500);
  const token = await runFile(join(fixture, 'RouterToken.exe'), ['--token', '--home', fixture], { encoding: 'utf8', timeout: 18000, windowsHide: true, env: environment });
  assert.equal(token.stdout.trim(), 'fixture-client-token');
  const third = await until(health);
  workers.add(third.pid);
  assert.notEqual(third.pid, second.pid, 'Token lookup must wake an absent router before returning credentials');
});
