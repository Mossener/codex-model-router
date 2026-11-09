// Confirms a Codex catalog no longer lists the retired a6api ids. PowerShell's
// ConvertFrom-Json cannot parse these catalogs (they embed multi-megabyte
// instruction blobs), so the check lives here.
import { readFileSync } from 'node:fs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node check-catalog.mjs <catalog.json>');
  process.exit(2);
}

const catalog = JSON.parse(readFileSync(target, 'utf8'));
const retired = new Set(['deepseek-v4.1-flash-1017']);
const bad = catalog.models
  .filter(model => String(model.slug).endsWith('-a6') || retired.has(model.slug))
  .map(model => model.slug);
console.log(JSON.stringify({ file: target, models: catalog.models.length, bad }));
if (bad.length) process.exit(1);
