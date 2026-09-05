/**
 * AURA :: Feature registry parity (Node, no browser)
 * ====================================================
 * services/manifest.json (Python truth) and js/features/registry.js (the
 * popup layer) MUST never drift. `python3 services/registry.py` prints the
 * python view; this test compares it field by field with the JS mirror.
 *
 * Run: node tests/test-feature-registry.mjs
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import FEATURE_MANIFEST, { feature, defaultsFor } from '../js/features/registry.js';
import * as router from '../js/ai/router.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; fails.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`); }
}
function section(t) { console.log(`\n\x1b[36m▸ ${t}\x1b[0m`); }

const py = JSON.parse(execFileSync('python3', ['services/registry.py'],
  { cwd: root, encoding: 'utf-8' }));

section('Manifest parity (python services/registry.py ↔ js/features/registry.js)');
const pyFeats = new Set(py.features);
const jsFeats = new Set(Object.keys(FEATURE_MANIFEST.features));
ok('feature ids identical',
   pyFeats.size === jsFeats.size && [...pyFeats].every(f => jsFeats.has(f)),
   `py=[${py.features}] js=[${[...jsFeats]}]`);
ok('exactly the four features', pyFeats.size === 4, String(pyFeats.size));

const eqList = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b),
                                  `py=${JSON.stringify(a)} js=${JSON.stringify(b)}`);
eqList('themes identical', py.themes, FEATURE_MANIFEST.themes);
eqList('theme previews identical (real builder palettes)',
       py.themePreviews, FEATURE_MANIFEST.themePreviews);
eqList('transitions identical', py.transitions, FEATURE_MANIFEST.transitions);
eqList('entrance animations identical', py.animations, FEATURE_MANIFEST.animations);
eqList('image providers identical (incl. model lists)',
       py.imageProviders, FEATURE_MANIFEST.imageProviders);
ok('gemini image provider ships the live Nano Banana model list',
   py.imageProviders?.[0]?.kind === 'gemini-image' &&
   py.imageProviders?.[0]?.model === 'gemini-3.1-flash-image' &&
   JSON.stringify(py.imageProviders?.[0]?.models?.map(m => m.id)) ===
     JSON.stringify(['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image',
                     'gemini-3-pro-image', 'gemini-2.5-flash-image']),
   JSON.stringify(py.imageProviders?.[0]?.models));
ok('OpenRouter carries the same Gemini image models with its own key slot',
   py.imageProviders?.[2]?.id === 'openrouter' &&
   py.imageProviders?.[2]?.keyId === 'openrouter-image' &&
   py.imageProviders?.[2]?.kind === 'openrouter-images' &&
   py.imageProviders?.[2]?.models?.[0]?.id === 'google/gemini-3.1-flash-image',
   JSON.stringify(py.imageProviders?.[2]?.models?.[0]));
ok('every default set identical (incl. preconfigured model)',
   Object.keys(FEATURE_MANIFEST.features).every(id =>
     JSON.stringify(py.defaults[id]) === JSON.stringify(defaultsFor(id))),
   `py=${JSON.stringify(py.defaults.pptx?.model)} js=${defaultsFor('pptx').model}`);

section('The ONE preconfigured outline model');
ok('manifest model === router pin (variablized: one value)',
   defaultsFor('pptx').model === router.DOCGEN_OUTLINE_MODEL &&
   defaultsFor('pptx').model === 'gemini-3.8-flash',
   `${defaultsFor('pptx').model} / ${router.DOCGEN_OUTLINE_MODEL}`);
ok('pin is discoverable by the terminal through the same manifest',
   typeof py.defaults?.pptx?.model === 'string' && py.defaults.pptx.model.length > 5);

section('JS helper surface used by the popups');
for (const id of ['pptx', 'docx', 'xlsx', 'research']) {
  ok(`feature('${id}') resolves`, feature(id)?.id === id);
  ok(`defaultsFor('${id}') is an object`, typeof defaultsFor(id) === 'object');
}
ok(`pptx ui app path is apps/ppt-builder`, feature('pptx')?.ui === 'ppt-builder');
ok(`pptx image defaults are the manifest's`, defaultsFor('pptx').images.provider === 'gemini'
   && defaultsFor('pptx').animation === 'none');
ok(`unknown feature returns null`, feature('nope') === null);

console.log(`\n\x1b[36mPASS ${pass}\x1b[0m \x1b[31mFAIL ${fail}\x1b[0m`);
if (fail) { console.log('FAILED:', fails); process.exit(1); }
