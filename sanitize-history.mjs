import { readFileSync, existsSync, writeFileSync, renameSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeRequestEvent, safeDiagnostic } from './security-metadata.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
const knownModels = new Set([settings.defaultModel, 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-oc', 'gpt-6-astra-ar', 'gpt-5.6-sol-ar', 'gpt-6.1-sol-ar']);
const result = { logEntriesSanitized: 0, diagnosticsSanitized: 0 };
function replace(name, contents) {
  const target = join(root, name);
  if (lstatSync(target).isSymbolicLink()) throw new Error('Refusing a linked diagnostics file');
  const temporary = `${target}.sanitizing.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, target);
}
const requestLogs = readdirSync(root).filter(name => /^requests(-[\w.-]+)?\.jsonl$/.test(name)).sort();
for (const name of requestLogs) {
  const target = join(root, name);
  if (!existsSync(target)) continue;
  const events = [];
  for (const line of readFileSync(target, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(safeRequestEvent(JSON.parse(line), knownModels)); } catch { /* Discard malformed lines instead of retaining unknown text. */ }
  }
  replace(name, events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
  result.logEntriesSanitized += events.length;
}
for (const name of ['work/last-failed.json', 'work/last-rejected.json']) {
  const target = join(root, name);
  if (!existsSync(target)) continue;
  let old = {};
  try { old = JSON.parse(readFileSync(target, 'utf8')); } catch {}
  replace(name, JSON.stringify(safeDiagnostic({ ...old, error: old.error || old.responseText || `${old.failure?.code ?? ''} ${old.failure?.message ?? ''}` })));
  result.diagnosticsSanitized++;
}
console.log(JSON.stringify(result));
