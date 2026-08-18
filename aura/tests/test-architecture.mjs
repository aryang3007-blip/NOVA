/**
 * AURA :: Architecture Integrity Guard
 * ------------------------------------
 * Static analysis that fails the build if the layering, imports or exports
 * drift. Runs in Node with no browser and no dependencies.
 *
 * Checks:
 *   1. every relative import resolves
 *   2. every named import exists as an export
 *   3. no circular dependencies
 *   4. dependency direction never points "upward" through the layers
 *   5. the runtime layer never imports UI
 *   6. the AI layer never imports platform-specific code
 *   7. no orphaned (defined-but-never-called) private methods
 *   8. no debugger statements or stray console.log in shipped code
 */

import fs from 'fs';
import path from 'path';

let pass = 0, fail = 0;
const fails = [];
const ok = (n, c, x = '') => {
  c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
    : (fail++, fails.push(n), console.log(`  \x1b[31m✗ ${n}\x1b[0m ${x}`));
};
const sec = t => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

/* ── collect modules ─────────────────────────────────────────────────── */

const FILES = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['vendor', 'node_modules', 'tests'].includes(e.name)) walk(p);
    } else if (e.name.endsWith('.js')) FILES.push(p);
  }
})('js');

const read = f => fs.readFileSync(f, 'utf8');
const rel = f => path.relative('.', f);

function importsOf(file) {
  const src = read(file);
  const out = [];
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    out.push({ spec: m[1], target: rel(target), exists: fs.existsSync(target) });
  }
  return out;
}

function exportsOf(file) {
  const src = read(file);
  const set = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g)) set.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/);
      const name = (t[1] || t[0]).trim();
      if (name) set.add(name);
    }
  }
  if (/export\s+default/.test(src)) set.add('default');
  return set;
}

/**
 * Layer map. Lower numbers are more foundational; a module must never import
 * from a HIGHER layer.
 *
 * Note: js/realtime/ is a data SERVICE (it depends only on core/config), so it
 * sits at the service layer — not with plugins, despite the folder name.
 */
function layerOf(f) {
  const p = f.replace(/\\/g, '/');
  if (p.includes('js/core/')) return 1;
  if (p.includes('js/memory/') || p.includes('js/realtime/') ||
      p.includes('js/vision/gesture-classifier')) return 2;
  if (p.includes('js/runtime/') || p.includes('js/desktop/') || p.includes('js/actions/')) return 3;
  if (p.includes('js/ai/')) return 4;
  if (p.includes('js/plugins/') || p.includes('js/gestures/')) return 5;
  if (p.endsWith('js/main.js')) return 7;
  return 6; // ui, avatar, vision, voice, ar, audio
}

/* ── 1. imports resolve ──────────────────────────────────────────────── */
sec('Module resolution');
{
  let broken = 0, total = 0;
  for (const f of FILES) {
    for (const imp of importsOf(f)) {
      total++;
      if (!imp.exists) { console.log(`      ${rel(f)} → ${imp.spec}`); broken++; }
    }
  }
  ok(`all ${total} relative imports resolve`, broken === 0, `${broken} broken`);
  ok(`module count is sane`, FILES.length >= 40, `${FILES.length} modules`);
}

/* ── 2. named imports exist ──────────────────────────────────────────── */
sec('Export contracts');
{
  const cache = new Map();
  let missing = 0;
  for (const f of FILES) {
    const src = read(f);
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/gs)) {
      const target = path.resolve(path.dirname(f), m[2]);
      if (!fs.existsSync(target)) continue;
      if (!cache.has(target)) cache.set(target, exportsOf(target));
      const avail = cache.get(target);
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!avail.has(name)) {
          console.log(`      "${name}" not exported by ${rel(target)} (needed by ${rel(f)})`);
          missing++;
        }
      }
    }
  }
  ok('every named import has a matching export', missing === 0, `${missing} missing`);
}

/* ── 3. no cycles ────────────────────────────────────────────────────── */
sec('Dependency graph');
{
  const graph = new Map();
  for (const f of FILES) graph.set(rel(f), importsOf(f).filter(i => i.exists).map(i => i.target));
  const cycles = [];
  const st = new Map();
  (function run() {
    function dfs(n, stack) {
      if (st.get(n) === 'done') return;
      if (st.get(n) === 'visiting') {
        cycles.push(stack.slice(stack.indexOf(n)).concat(n).join(' → '));
        return;
      }
      st.set(n, 'visiting');
      for (const d of graph.get(n) || []) dfs(d, stack.concat(n));
      st.set(n, 'done');
    }
    for (const n of graph.keys()) dfs(n, []);
  })();
  const uniq = [...new Set(cycles)];
  uniq.forEach(c => console.log(`      ${c}`));
  ok('no circular dependencies', uniq.length === 0, `${uniq.length} cycles`);
}

/* ── 4-6. layering rules ─────────────────────────────────────────────── */
sec('Layer discipline');
{
  let up = 0;
  for (const f of FILES) {
    const L = layerOf(f);
    for (const imp of importsOf(f)) {
      if (!imp.exists) continue;
      const TL = layerOf(imp.target);
      if (TL > L) { console.log(`      L${L} ${rel(f)} → L${TL} ${imp.target}`); up++; }
    }
  }
  ok('dependencies never point upward', up === 0, `${up} violations`);

  const runtimeFiles = FILES.filter(f => /js\/(runtime|desktop|core)\//.test(f.replace(/\\/g, '/')));
  const uiLeaks = runtimeFiles.filter(f =>
    importsOf(f).some(i => /js\/(ui|avatar|voice|ar|audio)\//.test(i.target)));
  ok('runtime/desktop/core never import UI', uiLeaks.length === 0, uiLeaks.map(rel).join(', '));

  const aiFiles = FILES.filter(f => f.replace(/\\/g, '/').includes('js/ai/'));
  const platformLeaks = aiFiles.filter(f =>
    importsOf(f).some(i => /js\/(actions|runtime)\//.test(i.target)));
  ok('AI layer never imports platform code', platformLeaks.length === 0, platformLeaks.map(rel).join(', '));

  const busUsers = FILES.filter(f => read(f).includes("core/bus.js")).length;
  ok('event bus is the shared integration point', busUsers >= 10, `${busUsers} modules use it`);
}

/* ── 7. orphaned private methods ─────────────────────────────────────── */
sec('Dead code');
{
  const orphans = [];
  for (const f of FILES) {
    const src = read(f);
    for (const m of src.matchAll(/^\s{2}(?:async\s+)?(_\w+)\s*\(/gm)) {
      const name = m[1];
      if (name === '_') continue;
      const uses = (src.match(new RegExp(`this\\.${name}\\b`, 'g')) || []).length;
      if (uses === 0) orphans.push(`${rel(f)}::${name}`);
    }
  }
  orphans.forEach(o => console.log(`      ${o}`));
  ok('no orphaned private methods', orphans.length === 0, `${orphans.length} orphans`);
}

/* ── 8. debug residue ────────────────────────────────────────────────── */
sec('Debug residue');
{
  const dbg = [];
  const logs = [];
  for (const f of FILES) {
    const src = read(f);
    src.split('\n').forEach((line, i) => {
      if (/^\s*debugger\b/.test(line)) dbg.push(`${rel(f)}:${i + 1}`);
      // Ignore console.log inside string literals (e.g. code examples).
      if (/console\.(log|debug)\s*\(/.test(line) && !/["'`].*console\.(log|debug)/.test(line)) {
        logs.push(`${rel(f)}:${i + 1}`);
      }
    });
  }
  dbg.forEach(d => console.log(`      ${d}`));
  logs.forEach(l => console.log(`      ${l}`));
  ok('no debugger statements', dbg.length === 0, dbg.join(', '));
  ok('no stray console.log', logs.length === 0, logs.join(', '));
}

/* ── 9. TODOs are intentional ────────────────────────────────────────── */
sec('TODO hygiene');
{
  let tagged = 0, untagged = [];
  for (const f of FILES) {
    read(f).split('\n').forEach((line, i) => {
      // A real marker is "TODO(scope):" or "TODO:" — the bare word appearing
      // in prose ("see the TODO blocks") is documentation, not a marker.
      if (!/TODO\s*[(:]/.test(line)) return;
      if (/TODO\((local|windows)\)/.test(line)) tagged++;
      else untagged.push(`${rel(f)}:${i + 1}`);
    });
  }
  untagged.forEach(u => console.log(`      ${u}`));
  ok('all TODOs scoped to planned platform work', untagged.length === 0, untagged.join(', '));
  ok('platform TODOs documented', tagged >= 20, `${tagged} tagged`);
}

/* ── 10. entry points intact ─────────────────────────────────────────── */
sec('Entry points');
{
  const html = fs.readFileSync('index.html', 'utf8');
  ok('index.html loads main.js as a module', /type="module"\s+src="\.\/js\/main\.js"/.test(html));

  const ids = [...html.matchAll(/id="([\w-]+)"/g)].map(m => m[1]);
  const main = read('js/main.js');
  const cc = read('js/ui/command-center.js');
  const referenced = new Set([
    ...[...main.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]),
    ...[...cc.matchAll(/getElementById\('([\w-]+)'\)/g)].map(m => m[1]),
    ...[...cc.matchAll(/mk\([\w]+,\s*'([\w-]+)'/g)].map(m => m[1]),
  ]);
  const dangling = [...referenced].filter(r => !ids.includes(r));
  dangling.forEach(d => console.log(`      #${d} referenced but not in index.html`));
  ok('no dangling DOM references', dangling.length === 0, dangling.join(', '));

  // Every panel must be reachable from SOME button. Buttons live in the left
  // dock or the top toolbar (the gesture reference sits in the toolbar, since
  // it is a reference sheet rather than a workspace panel), so match on the
  // data-panel hook that main.js actually binds: `button[data-panel]`.
  // `innovations` is intentionally hidden — no button anywhere. It is reached
  // only via the unlock sequence or the hidden /innovations command, so it is
  // excluded here and its reachability is asserted separately below.
  const HIDDEN_PANELS = ['innovations'];
  const panels = [...html.matchAll(/class="panel[^"]*"\s+data-panel="(\w+)"/g)].map(m => m[1]);
  const panelBtns = [...html.matchAll(/<button[^>]*\sdata-panel="(\w+)"/g)].map(m => m[1]);
  const unreachable = panels.filter(p => !panelBtns.includes(p) && !HIDDEN_PANELS.includes(p));
  ok('every visible panel is reachable from a button', unreachable.length === 0, unreachable.join(', '));

  const mainJs = read('js/main.js');
  ok('hidden innovations panel exists', panels.includes('innovations'));
  ok('hidden panel has no button (stays secret)', !panelBtns.includes('innovations'));
  ok('hidden panel has an unlock path',
     /_wireSecretUnlock/.test(mainJs) && /unlockInnovations/.test(mainJs));
  ok('innovations command is flagged hidden',
     /name: 'innovations'[\s\S]{0,120}hidden: true/.test(read('js/plugins/extended.js')));
  ok('panel buttons use the selector main.js binds',
     /\$\$\('button\[data-panel\]'\)/.test(read('js/main.js')),
     'main.js must query button[data-panel]');

  // `class="tab"` must not also match `class="tabpane"` — anchor on the
  // exact class token.
  const tabs = [...html.matchAll(/class="tab(?: active)?"\s+data-tab="(\w+)"/g)].map(m => m[1]);
  const panes = [...html.matchAll(/class="tabpane[^"]*"\s+data-tab="(\w+)"/g)].map(m => m[1]);
  const orphanPanes = panes.filter(p => !tabs.includes(p));
  ok('every settings pane has a tab', orphanPanes.length === 0, orphanPanes.join(', '));
  ok(`tabs and panes match (${tabs.length})`, tabs.length === panes.length, `${tabs.length} vs ${panes.length}`);
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`  \x1b[32mPASS ${pass}\x1b[0m   ${fail ? `\x1b[31mFAIL ${fail}\x1b[0m` : 'FAIL 0'}`);
if (fail) { console.log('  Failed: ' + fails.join(', ')); process.exit(1); }
console.log('  ARCHITECTURE INTEGRITY VERIFIED');
