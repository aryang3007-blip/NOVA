/**
 * AURA :: feature popup apps (Node, DOM stub — no browser needed)
 * ================================================================
 * Every feature app (apps/<ui>/app.js) must mount through the launcher with
 * the shared ctx. This stub DOM is deliberately dumb: if an app touches a
 * browser API it doesn't need, the mount fails loudly here first.
 *
 * Run: node tests/test-feature-apps.mjs
 */
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; fails.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`); }
}
function section(t) { console.log(`\n\x1b[36m▸ ${t}\x1b[0m`); }

/* ── minimal DOM stub ──────────────────────────────────────────────── */
function elem(tag) {
  const el = {
    tag, children: [], value: '', checked: false, hidden: false,
    innerHTML: '', textContent: '', placeholder: '', type: '', min: 0, max: 0,
    className: '', style: {}, scrollTop: 0, scrollHeight: 0,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
    },
    append(...n) { this.children.push(...n); return this; },
    addEventListener() {},
    dispatchEvent() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
  };
  return el;
}
globalThis.document = {
  createElement: (t) => elem(t),
  getElementById: (id) => (globalThis._hosts[id] ||= elem(id)),
  head: elem('head'),
  body: elem('body'),
};
globalThis._hosts = {};

/* ── the modules under test ────────────────────────────────────────── */
const { openFeature } = await import('../js/features/launcher.js');
const { feature } = await import('../js/features/registry.js');
const { splitAudience } = await import('../js/features/kit.js');
const { parseFeatureIntent } = await import('../js/features/intent.js');

section('Launcher → manifest → app.mount contract');
for (const id of ['pptx', 'docx', 'xlsx', 'research']) {
  const meta = feature(id);
  const host = document.getElementById('feature-modal'); // mirrors launcher
  const before = host.children.length;
  const r = await openFeature(id, { topic: 'Test' + id }, {
    engine: {}, actions: {}, config: { get: () => undefined, getKey: () => '' },
    bus: {}, toast() {}, audio: { sfx() {} },
  });
  const mounted = host.children.length > before;
  ok(`openFeature('${id}') mounts ${meta?.ui}/app.js`, r.ok && mounted,
     `${JSON.stringify(r)} mounted=${mounted}`);
  const mod = await import(`../apps/${meta.ui}/app.js`);
  ok(`apps/${meta.ui}/app.js exports mount()`, typeof mod.mount === 'function');
}
ok('unknown feature is refused, not silently mounted',
   !(await openFeature('nope')).ok);

section('Prefill + audience parsing (the "for holiday homework" path)');
const a = splitAudience('create ppt on solar system for holiday homework');
ok("splitAudience extracts the audience", a.audience === 'holiday homework', a.audience);
ok("splitAudience leaves the rest intact", /solar system/.test(a.rest), a.rest);
const b = splitAudience('make a report about the water cycle');
ok("no audience → empty, no damage", b.audience === '' && /water cycle/.test(b.rest));

section('Intent parser — one function for typed, wake-word and STT');
const cases = [
  ['create a ppt on solar system for my holiday homework',
   'pptx', { topic: 'solar system', audience: 'holiday homework', details: '' }],
  ['hey aura make a presentation about Mars with images and transitions',
   'pptx', { topic: 'Mars', audience: '', details: 'images and transitions' }],
  ['please create a ppt on fats and nutrition for class 10 with a timeline',
   'pptx', { topic: 'fats and nutrition', audience: 'class 10', details: 'a timeline' }],
  ['write a report on the water cycle for my science homework',
   'docx', { topic: 'water cycle', audience: 'science homework', details: '' }],
  ['make an excel sheet for monthly budget',
   'xlsx', { topic: 'monthly budget', audience: '', details: '' }],
  ['create a spreadsheet for my school project',
   'xlsx', { topic: 'school project', audience: '', details: '' }],
  ['research the latest AI news', 'research', { topic: 'latest AI news', audience: '', details: '' }],
  ['can you look up black holes for my class project',
   'research', { topic: 'black holes', audience: 'class project', details: '' }],
];
for (const [text, kind, pre] of cases) {
  const f = parseFeatureIntent(text);
  ok(`"${text.slice(0, 42)}…" → ${kind}`,
     f?.kind === kind && JSON.stringify(f.prefill) === JSON.stringify(pre),
     JSON.stringify(f));
}
const no = ['what is the weather on Mars', 'how do I make pasta', 'can you tell me a joke',
            '/doc ppt on Mars', '', 'open notepad'];
for (const text of no) {
  ok(`stays chat: "${text.slice(0, 34)}"`, parseFeatureIntent(text) === null);
}

section('Feature apps share the canonical registry, not their own lists');
for (const app of ['ppt-builder', 'doc-builder', 'research']) {
  const js = await import(`../apps/${app}/app.js`);
  ok(`${app} is the ONLY entry in its folder (no duplicated logic)`,
     typeof js.mount === 'function' && Object.keys(js).length === 1,
     Object.keys(js).join(','));
}

console.log(`\n\x1b[36mPASS ${pass}\x1b[0m \x1b[31mFAIL ${fail}\x1b[0m`);
if (fail) { console.log('FAILED:', fails); process.exit(1); }
