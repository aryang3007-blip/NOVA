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
eqList('transitions identical', py.transitions, FEATURE_MANIFEST.transitions);
eqList('entrance animations identical', py.animations, FEATURE_MANIFEST.animations);
eqList('image providers identical (id/kind/model)',
       py.imageProviders.map(p => [p.id, p.kind, p.model]),
       FEATURE_MANIFEST.imageProviders.map(p => [p.id, p.kind, p.model]));

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
