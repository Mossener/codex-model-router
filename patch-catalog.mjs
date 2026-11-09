// Adds the opencode and agentrouter backed variants to a Codex model catalog,
// cloning an existing entry so every field Codex requires stays intact. Also
// prunes stale -oc / -ar / -a6 entries and the retired a6api-only ids.
import { readFileSync, writeFileSync } from 'node:fs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node patch-catalog.mjs <catalog.json>');
  process.exit(2);
}

const catalog = JSON.parse(readFileSync(target, 'utf8'));
if (!Array.isArray(catalog.models)) throw new Error('catalog has no models array');

const variants = [
  { slug: 'deepseek-v4.1-flash-oc', source: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash (opencode)', description: 'DeepSeek via opencode.ai' },
  { slug: 'gpt-6-astra-ar', source: 'gpt-6.1-sol', label: 'GPT-6-Astra (AgentRouter 账号池)', description: 'GPT-6-Astra via the local AgentRouter account pool' },
  { slug: 'gpt-5.6-sol-ar', source: 'gpt-5.6-sol', label: 'GPT-5.6-Sol (AgentRouter 账号池)', description: 'GPT-5.6-Sol via the local AgentRouter account pool' },
  { slug: 'gpt-6.1-sol-ar', source: 'gpt-6.1-sol', label: 'GPT-6.1-Sol (AgentRouter 账号池)', description: 'GPT-6.1-Sol via the local AgentRouter account pool' },
];
const suffixes = ['-oc', '-ar', '-a6'];
// No provider serves these any more: the -a6 route is gone and the -1017
// snapshot only ever existed on a6api.
const retired = new Set(['deepseek-v4.1-flash-1017']);
const wanted = new Set(variants.map(variant => variant.slug));
catalog.models = catalog.models.filter(model => {
  if (retired.has(model.slug)) return false;
  return !suffixes.some(suffix => String(model.slug).endsWith(suffix)) || wanted.has(model.slug);
});

let highest = catalog.models.reduce((max, model) => Math.max(max, Number(model.priority ?? 0)), 0);
const defaultModel = catalog.models.find(model => model.slug === 'gpt-6.1-sol');
if (defaultModel) defaultModel.display_name = 'GPT-6.1-Sol (axon · 默认)';
// The plain DeepSeek entry was labelled while it belonged to the a6api route; it
// now goes through opencode like its -oc twin.
const plainDeepseek = catalog.models.find(model => model.slug === 'deepseek-v4.1-flash');
if (plainDeepseek) {
  plainDeepseek.display_name = 'deepseek-v4.1-flash';
  if (/a6/i.test(String(plainDeepseek.description ?? ''))) plainDeepseek.description = 'DeepSeek V4.1 Flash via opencode.ai';
}
for (const variant of variants) {
  const template = catalog.models.find(model => model.slug === variant.source);
  if (!template) throw new Error(`missing template entry ${variant.source}`);
  const existing = catalog.models.find(model => model.slug === variant.slug);
  if (existing) {
    existing.display_name = variant.label;
    existing.description = variant.description;
    existing.visibility = 'list';
    existing.supported_in_api = true;
    continue;
  }
  const entry = structuredClone(template);
  entry.slug = variant.slug;
  entry.display_name = variant.label;
  entry.description = variant.description;
  entry.priority = ++highest;
  entry.visibility = 'list';
  entry.supported_in_api = true;
  catalog.models.push(entry);
}

writeFileSync(target, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  file: target,
  models: catalog.models.length,
  variants: catalog.models
    .filter(model => suffixes.some(suffix => String(model.slug).endsWith(suffix)))
    .map(model => ({ slug: model.slug, display_name: model.display_name, priority: model.priority })),
  retired: [...retired].filter(slug => !catalog.models.some(model => model.slug === slug)),
}));
