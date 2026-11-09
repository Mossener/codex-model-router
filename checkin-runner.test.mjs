import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckInRunner } from './dashboard.mjs';

test('runner exposes rate-limit waiting and does not equate exit zero with all accounts succeeding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'checkin-runner-test-'));
  mkdirSync(join(directory, '.venv', 'Scripts'), { recursive: true });
  writeFileSync(join(directory, '.venv', 'Scripts', 'python.exe'), '');
  writeFileSync(join(directory, 'main.py'), '');
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const runner = createCheckInRunner(directory, (_program, _args, options) => {
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.NEWAPI_HEADLESS, '1');
    return child;
  });
  assert.equal(runner.start(), true);
  assert.equal(runner.start(), false);
  child.stdout.emit('data', Buffer.from('OAuth state HTTP 429; waiting 30s before retry 1/2'));
  assert.equal(runner.status().phase, '上游限流，正在等待重试');
  child.emit('close', 0);
  assert.equal(runner.status().running, false);
  assert.equal(runner.status().phase, '签到结束，请查看账号结果');
  assert.equal(runner.status().lastExitCode, 0);
});
