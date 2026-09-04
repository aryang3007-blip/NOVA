/**
 * AURA :: ESM parse gate (Node, no browser)
 * ==========================================
 * `node --check` silently accepts some broken modules (it does not catch a
 * stray backtick inside a string, e.g. the screen.js:373 bug that froze the
 * boot screen). This gate parses every frontend module EXACTLY the way a
 * browser does — vm.SourceTextModule parses and does not execute — so any
 * syntax error fails the suite before a user ever sees a frozen boot page.
 *
 * Run: node --experimental-vm-modules tests/test-module-parse.mjs
 */
import { SourceTextModule } from 'node:vm';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; fails.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`); }
}
function section(t) { console.log(`\n\x1b[36m▸ ${t}\x1b[0m`); }

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

section('Every frontend module parses as real ESM (browser-identical)');
const files = [...walk(path.join(root, 'js')), ...walk(path.join(root, 'apps')),
               ...walk(path.join(root, 'vendor'))];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  try {
    new SourceTextModule(src, { identifier: path.relative(root, f) });
    pass++;
  } catch (e) {
    fail++;
    fails.push(path.relative(root, f));
    console.log(`  \x1b[31m✗ ${path.relative(root, f)}\x1b[0m ${e.message}`);
  }
}
ok(`${files.length} modules parsed`, pass === files.length, `${pass}/${files.length}`);

section('Inline <script> blocks in the pages parse too');
for (const page of ['index.html', 'dev.html', 'live.html', 'phone.html']) {
  const p = path.join(root, page);
  if (!statSync(p).isFile?.() && !require) { /* keep simple */ }
  try {
    const html = readFileSync(p, 'utf8');
    const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(m => m[1]).filter(s => s.trim());
    let parsed = 0;
    for (const src of blocks) {
      try { new SourceTextModule(src, { identifier: `${page}:inline` }); parsed++; }
      catch (e) { console.log(`  \x31[31m✗ ${page} inline\x1b[0m ${e.message}`); }
    }
    ok(`${page}: ${blocks.length} inline script(s) parse`, parsed === blocks.length,
       `${parsed}/${blocks.length}`);
  } catch (e) {
    ok(`${page}: readable`, false, String(e));
  }
}

console.log(`\n\x1b[36mPASS ${pass}\x1b[0m \x1b[31mFAIL ${fail}\x1b[0m`);
if (fail) { console.log('FAILED:', fails); process.exit(1); }
