/**
 * AURA :: screen agent + command palette logic
 * ============================================
 * Pure-logic assertions that need no browser: model selection, mode routing,
 * JSON extraction from a messy model reply, grid maths, coordinate mapping,
 * and the palette's filter/insert behaviour.
 *
 * The dangerous parts (clicking) are asserted to REFUSE in every case where
 * the mapping is not trustworthy.
 */

import { ScreenAgent, extractJson, repairJson, salvageFromProse, parseGridRefs,
         OCR_CANDIDATES, GRID_COLS, GRID_ROWS } from '../js/ai/screen-agent.js';
import { ollama } from '../js/ai/providers.js';
import { MENTIONS } from '../js/ui/command-palette.js';

let p = 0, f = 0; const fails = [];
const ok = (n, c, d = '') => { c ? (p++, console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`))
  : (f++, fails.push(n), console.log(`  \x1b[31m✗\x1b[0m ${n}  \x1b[90m${d}\x1b[0m`)); };
const sec = t => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

/* A fake ScreenShare with controllable surface + geometry. */
function fakeScreen({ active = true, surface = 'monitor', w = 1920, h = 1080 } = {}) {
  const scale = Math.min(1, 1280 / Math.max(w, h));
  return {
    active, surface,
    label: 'Screen 1',
    describeSurface() { return surface === 'monitor' ? 'an entire screen' : 'an application window'; },
    geometry() {
      return active ? { width: w, height: h, capturedWidth: Math.round(w * scale),
                        capturedHeight: Math.round(h * scale), scale } : null;
    },
    grab() { return active ? 'data:image/jpeg;base64,AAAA' : null; },
    toScreenPoint(x, y) {
      const g = this.geometry();
      if (!g) return { ok: false, message: 'Nothing is being shared.' };
      if (surface !== 'monitor') {
        return { ok: false, message: 'You are sharing an application window. Coordinates do not map. Re-share and choose "Entire Screen" to enable clicking.' };
      }
      return { ok: true, x: Math.round(x / g.scale), y: Math.round(y / g.scale) };
    },
    status() { return { active, surface, clickable: active && surface === 'monitor' }; },
  };
}

const mkAgent = (opts = {}, cfg = {}) => new ScreenAgent({
  screen: fakeScreen(opts),
  ai: { models: { get: (n) => ({ params: /12b/.test(n) ? 12 : /7b/.test(n) ? 7 : 2 }) } },
  actions: null,
  config: { get: (k) => cfg[k], set: () => {} },
});

/* ══════════════════ OCR MODEL SELECTION ══════════════════ */
sec('OCR MODEL SELECTION — smallest capable, never invented');

ollama.caps = {};
// CHANGED (round 12): smallest-first was wrong. moondream is 1.7B and fast
// to load, but on real hardware it returned 23 chars in 28s then 0 chars in
// 40s. A fast answer that says nothing is worthless, so OCR-grade quality
// now outranks size.
ollama.installed = ['gemma2:2b', 'gemma4:12b', 'qwen2.5vl:7b', 'moondream'];
ok('prefers a real OCR model over the tiny captioner',
   mkAgent().pickOcrModel()?.name === 'qwen2.5vl:7b', mkAgent().pickOcrModel()?.name);

ollama.installed = ['gemma2:2b', 'gemma4:12b', 'qwen2.5vl:7b'];
ok('without a tiny captioner, picks the 7B over the 12B',
   mkAgent().pickOcrModel()?.name === 'qwen2.5vl:7b', mkAgent().pickOcrModel()?.name);

ollama.installed = ['gemma2:2b', 'gemma4:12b'];
ok('falls back to the only vision model there is',
   mkAgent().pickOcrModel()?.name === 'gemma4:12b', mkAgent().pickOcrModel()?.name);

ollama.installed = ['gemma2:2b', 'qwen2.5-coder:7b'];
ok('returns null when nothing can read an image',
   mkAgent().pickOcrModel() === null);

ok('candidate list is regex, not a hardcoded name list',
   OCR_CANDIDATES.every(r => r instanceof RegExp));

ollama.installed = ['smolvlm:2b', 'gemma4:12b'];
ok('gemma4 outranks smolvlm for reading',
   mkAgent().pickOcrModel()?.name === 'gemma4:12b', mkAgent().pickOcrModel()?.name);
ollama.installed = ['smolvlm:2b', 'gemma2:2b'];
ok('smolvlm is still used when it is the only reader',
   mkAgent().pickOcrModel()?.name === 'smolvlm:2b', mkAgent().pickOcrModel()?.name);

/* ══════════════════ MODE ROUTING ══════════════════ */
sec('MODE ROUTING — cheap path for text, vision for pixels');

const auto = mkAgent({}, { screenMode: 'auto' });
ok('"what does this error say" → ocr', auto.chooseMode('what does this error say?') === 'ocr');
ok('"summarise this page" → ocr', auto.chooseMode('summarise this page') === 'ocr');
ok('"what is the total" → ocr', auto.chooseMode('what is the total') === 'ocr');
ok('"what colour is the button" → vision', auto.chooseMode('what colour is the button') === 'vision');
ok('"describe the layout" → vision', auto.chooseMode('describe the layout') === 'vision');
ok('"what does this icon mean" → vision', auto.chooseMode('what does this icon mean') === 'vision');
ok('"where is the save button" → vision', auto.chooseMode('where is the save button') === 'vision');

ok('explicit ocr override wins',
   mkAgent({}, { screenMode: 'ocr' }).chooseMode('what colour is this') === 'ocr');
ok('explicit vision override wins',
   mkAgent({}, { screenMode: 'vision' }).chooseMode('read the text') === 'vision');

/* ══════════════════ COORDINATE SAFETY ══════════════════ */
sec('COORDINATE SAFETY — refuse rather than click blind');

const mon = fakeScreen({ surface: 'monitor', w: 1920, h: 1080 });
const g = mon.geometry();
ok('captured frame is downscaled to <=1280', Math.max(g.capturedWidth, g.capturedHeight) <= 1280,
   `${g.capturedWidth}x${g.capturedHeight}`);
const mapped = mon.toScreenPoint(g.capturedWidth / 2, g.capturedHeight / 2);
ok('centre of frame maps to centre of screen',
   mapped.ok && Math.abs(mapped.x - 960) <= 2 && Math.abs(mapped.y - 540) <= 2,
   JSON.stringify(mapped));
const corner = mon.toScreenPoint(0, 0);
ok('origin maps to origin', corner.ok && corner.x === 0 && corner.y === 0);

const win = fakeScreen({ surface: 'window' });
const refused = win.toScreenPoint(100, 100);
ok('a shared WINDOW refuses coordinate mapping', !refused.ok);
ok('and explains how to fix it', /entire screen/i.test(refused.message), refused.message?.slice(0, 60));

const off = fakeScreen({ active: false });
ok('nothing shared → refuses', !off.toScreenPoint(1, 1).ok);

/*
 * locate() no longer refuses on a window share — it finds the target and
 * places AURA's own cursor, then reports clickable:false. Only the DESKTOP
 * MAPPING is monitor-only. Exercising the full path needs a canvas, so the
 * browser suite (tests/test-screen-ui.py) covers the success case; here we
 * assert the guards that must fire before any rendering happens.
 */
{
  const a = mkAgent({ active: false });
  const r = await a.locate('Save');
  ok('locate() refuses when nothing is shared', !r.ok, r.message);
}
{
  // No image-capable model → must say so, not crash.
  const saved = ollama.installed;
  ollama.installed = ['gemma2:2b'];
  const a = mkAgent({ surface: 'window' });
  const r = await a.locate('Save');
  ok('locate() refuses with no vision model', !r.ok, r.message?.slice(0, 60));
  ok('and names the fix', /moondream|image-capable/i.test(r.message || ''));
  ollama.installed = saved;
}
{
  // resolve() must refuse to click a target that was found but unmappable.
  const a = mkAgent({ surface: 'window' });
  a.locate = async () => ({ ok: true, cell: 'C4', clickable: false,
                            reason: 'window share — no desktop mapping' });
  const r = await a.resolve([{ do: 'click', target: 'Save' }]);
  ok('resolve() refuses to click an unmappable target', !r.ok, r.message);
  ok('and explains why', /window share/.test(r.message || ''));
}

/* ══════════════════ GRID MATHS ══════════════════ */
sec('GRID REFERENCE MATHS');

ok('grid is 12x8', GRID_COLS === 12 && GRID_ROWS === 8);
// A1 centre, C4 centre — computed the same way locate() does.
function cellCentre(col, row, cw, chh) {
  return { x: (col + 0.5) * (cw / GRID_COLS), y: (row + 0.5) * (chh / GRID_ROWS) };
}
const a1 = cellCentre(0, 0, 1280, 720);
ok('A1 centre is in the top-left cell', a1.x < 1280 / GRID_COLS && a1.y < 720 / GRID_ROWS,
   `${a1.x.toFixed(0)},${a1.y.toFixed(0)}`);
const l8 = cellCentre(11, 7, 1280, 720);
ok('L8 centre is in the bottom-right cell',
   l8.x > 1280 * 11 / GRID_COLS && l8.y > 720 * 7 / GRID_ROWS,
   `${l8.x.toFixed(0)},${l8.y.toFixed(0)}`);

const refs = parseGridRefs('Save [C4]\nCancel [D4]\nnot a ref\nFile menu [A1]');
ok('parses 3 grid refs', refs.length === 3, JSON.stringify(refs.map(r => r.text)));
ok('C4 → col 2 row 3', refs[0].col === 2 && refs[0].row === 3, JSON.stringify(refs[0]));
ok('A1 → col 0 row 0', refs[2].col === 0 && refs[2].row === 0);
ok('ignores lines with no reference', !refs.some(r => r.text === 'not a ref'));

/* ══════════════════ PLAN JSON EXTRACTION ══════════════════ */
sec('PLAN PARSING — models are messy');

ok('plain JSON', extractJson('{"steps":[{"do":"click"}]}')?.steps.length === 1);
ok('fenced JSON', extractJson('```json\n{"steps":[{"do":"type","text":"hi"}]}\n```')?.steps[0].text === 'hi');
ok('JSON with prose around it',
   extractJson('Sure! Here you go:\n{"steps":[{"do":"press","key":"enter"}]}\nHope that helps.')?.steps[0].key === 'enter');
ok('nested braces survive',
   extractJson('{"steps":[{"do":"type","text":"{a:1}"}],"why":""}')?.steps[0].text === '{a:1}');
ok('garbage returns null', extractJson('I cannot do that') === null);
ok('empty returns null', extractJson('') === null);
ok('truncated JSON returns null rather than throwing',
   extractJson('{"steps":[{"do":"click"') === null);

/* resolve() maps intents to real automation ops */
sec('INTENT → AUTOMATION STEPS');
{
  const a = mkAgent();
  // Stub locate so we test the mapping, not the model.
  a.locate = async (t) => ({ ok: true, x: 100, y: 200, cell: 'C4', clickable: true, message: `found ${t}` });
  const r = await a.resolve([
    { do: 'click', target: 'Save' },
    { do: 'type', text: 'report.txt' },
    { do: 'hotkey', keys: 'ctrl+s' },
    { do: 'wait', seconds: 1 },
  ]);
  ok('resolves a 4-step plan', r.ok && r.plan.length === 4, JSON.stringify(r.plan));
  ok('click became x/y coordinates', r.plan[0].op === 'click' && r.plan[0].x === 100);
  ok('type carries the text', r.plan[1].op === 'type' && r.plan[1].text === 'report.txt');
  ok('hotkey carries the combo', r.plan[2].op === 'hotkey' && r.plan[2].keys === 'ctrl+s');
  ok('narration explains every step in order',
     r.narration.length === 4 && r.narration[0].startsWith('1.'), r.narration[0]);

  const bad = await a.resolve([{ do: 'launch_nukes' }]);
  ok('unknown intent is rejected', !bad.ok, bad.message);

  a.locate = async () => ({ ok: false, message: 'Could not find "Ghost".' });
  const miss = await a.resolve([{ do: 'click', target: 'Ghost' }]);
  ok('a target that cannot be found aborts the whole plan', !miss.ok, miss.message);
  ok('and says which step failed', /Step 1/.test(miss.message));
}

/* ══════════════════ COMMAND PALETTE ══════════════════ */
sec('COMMAND PALETTE DATA');

ok('mentions exist', MENTIONS.length >= 6, String(MENTIONS.length));
ok('every mention expands to a slash command',
   MENTIONS.every(m => m.expands.startsWith('/')),
   MENTIONS.filter(m => !m.expands.startsWith('/')).map(m => m.name).join(','));
ok('every mention has help text', MENTIONS.every(m => m.help && m.help.length > 4));
ok('@screen maps to the watch command',
   MENTIONS.find(m => m.name === 'screen')?.expands.startsWith('/watch'));
ok('@camera maps to /look',
   MENTIONS.find(m => m.name === 'camera')?.expands.startsWith('/look'));

// The trigger regex must only fire at the start of the input.
const trigger = (v) => /^([/@])([a-z0-9_-]*)$/i.exec(v);
ok('"/" opens the palette', !!trigger('/'));
ok('"/cl" opens the palette', !!trigger('/cl'));
ok('"@" opens the palette', !!trigger('@'));
ok('"3 / 4" does NOT open it', !trigger('3 / 4'));
ok('an email does NOT open it', !trigger('me@example.com'));
ok('"/click 100 200" does NOT keep it open', !trigger('/click 100 200'));
ok('text before a slash does NOT open it', !trigger('what about /look'));

/* ══════════════════════════════════════════════════════════════════════
 * REGRESSION: the moondream disaster (user logs, round 12)
 *
 * The user pulled moondream on my recommendation. Two things then broke:
 *   1. It was the smallest model installed, so the speed-first router made
 *      it the CHAT model. A 1.7B captioner cannot plan or emit JSON.
 *   2. /do asked it for a plan and got "" back — four times, ~7s each.
 *      Real measurement: 28.8s for 23 chars, then 40.0s for 0 chars.
 * ══════════════════════════════════════════════════════════════════════ */
sec('MOONDREAM REGRESSION');

ollama.caps = {};
ollama.installed = ['moondream:latest', 'gemma2:2b', 'qwen2.5vl:7b', 'qwen2.5-coder:7b'];
const userAgent = new ScreenAgent({
  screen: fakeScreen(),
  ai: { models: { get: (n) => ({ params: /vl:7b|coder:7b/.test(n) ? 7.6 : /2b/.test(n) ? 2.6 : 1.7 }) } },
  actions: null, config: { get: () => 'auto' },
});

const reader = userAgent.pickOcrModel();
ok('OCR no longer prefers moondream', reader.name !== 'moondream:latest', reader.name);
ok('it picks the real OCR model', reader.name === 'qwen2.5vl:7b', reader.name);
ok('and does not flag it weak', !reader.weak);

const planner = userAgent.pickPlannerModel();
ok('planner exists', !!planner, JSON.stringify(planner));
ok('planner is never moondream', planner.name !== 'moondream:latest', planner.name);
ok('planner can see AND plan', planner.name === 'qwen2.5vl:7b', planner.name);

// Only moondream installed → still usable, but flagged honestly.
ollama.installed = ['moondream:latest', 'gemma2:2b'];
const only = new ScreenAgent({
  screen: fakeScreen(),
  ai: { models: { get: () => ({ params: 1.7 }) } }, actions: null, config: null });
ok('with only moondream it is still offered', only.pickOcrModel()?.name === 'moondream:latest');
ok('but flagged as weak', only.pickOcrModel()?.weak === true);
ok('and refused as a PLANNER', only.pickPlannerModel() === null,
   JSON.stringify(only.pickPlannerModel()));

// plan() now FALLS BACK to describe-then-plan instead of refusing, which is
// what the user asked for. That path renders a canvas, so it is exercised in
// the browser suite (tests/test-do-pipeline.py). Here we assert the routing
// decision only.
ok('a captioner-only machine is routed to two-stage',
   typeof only.planTwoStage === 'function' && only.pickPlannerModel() === null);
ok('shortcuts still work with no usable model at all',
   only.matchShortcut('close the window')?.steps?.[0]?.keys === 'ctrl+w');

/* Cell → coordinates without a second model call. */
sec('PLANNER CELL IS REUSED (no second model pass per click)');
ollama.installed = ['qwen2.5vl:7b', 'gemma2:2b'];
const ag = new ScreenAgent({
  screen: fakeScreen({ surface: 'monitor', w: 1920, h: 1080 }),
  ai: { models: { get: () => ({ params: 7.6 }) } }, actions: null, config: null });

const c4 = ag.cellToPoint('C4');
ok('C4 resolves without a model', c4.ok && c4.clickable, JSON.stringify(c4));
ok('C4 gives desktop pixels', c4.x > 0 && c4.y > 0, `${c4.x},${c4.y}`);
ok('bad cell rejected', !ag.cellToPoint('Z9').ok);
ok('garbage rejected', !ag.cellToPoint('nope').ok);

let locateCalls = 0;
ag.locate = async () => { locateCalls++; return { ok: false, message: 'should not be called' }; };
const resolved = await ag.resolve([
  { do: 'click', target: 'Send', cell: 'C4' },
  { do: 'type', text: 'hello' },
]);
ok('resolve() used the planner cell', resolved.ok, resolved.message);
ok('locate() was NOT called again', locateCalls === 0, `${locateCalls} calls`);
ok('produced real coordinates', resolved.plan[0].x > 0 && resolved.plan[0].y > 0,
   JSON.stringify(resolved.plan[0]));

// A window share must still refuse to click, even with a planner cell.
const winAg = new ScreenAgent({
  screen: fakeScreen({ surface: 'window' }),
  ai: { models: { get: () => ({ params: 7.6 }) } }, actions: null, config: null });
winAg.locate = async () => ({ ok: true, clickable: false, reason: 'window share' });
const winRes = await winAg.resolve([{ do: 'click', target: 'Send', cell: 'C4' }]);
ok('window share still refuses to click', !winRes.ok, winRes.message);

/* ══════════════════════════════════════════════════════════════════════
 * REGRESSION: /do never worked, because real models do not emit clean JSON.
 *
 * Measured against realistic 7B replies the original parser handled 2 of 5.
 * The user reported "/do just doesn't work" four times in a row.
 * ══════════════════════════════════════════════════════════════════════ */
sec('MESSY MODEL OUTPUT (this is what actually broke /do)');

const REAL_REPLIES = [
  ['markdown fence + prose',
   'Sure! Here you go:\n```json\n{"steps":[{"do":"click","target":"Close","cell":"L1"}]}\n```\nHope that helps.'],
  ['single quotes (python style)',
   "{'steps': [{'do': 'click', 'target': 'X', 'cell': 'L1'}]}"],
  ['trailing comma',
   '{"steps":[{"do":"click","target":"Close","cell":"L1"},]}'],
  ['unquoted keys',
   '{steps: [{do: "click", target: "OK", cell: "F5"}]}'],
  ['True/False/None',
   '{"steps":[{"do":"click","target":"OK","cell":"F5","confirm":True}]}'],
  ['plain English, no JSON at all',
   'I can see a window. To close it, click the X in the top right corner (cell L1).'],
  ['plain English hotkey',
   'To close the window press ctrl+w'],
  ['fenced, no language tag',
   '```\n{"steps":[{"do":"hotkey","keys":"ctrl+w"}]}\n```'],
  ['smart quotes',
   '{\u201csteps\u201d:[{\u201cdo\u201d:\u201chotkey\u201d,\u201ckeys\u201d:\u201cctrl+s\u201d}]}'],
];
for (const [label, reply] of REAL_REPLIES) {
  const r = extractJson(reply);
  ok(`parses: ${label}`, !!r?.steps?.length, JSON.stringify(r?.steps) || 'null');
}

ok('genuine refusal still returns null',
   extractJson('I cannot see any window on the screen.') === null);
ok('empty string returns null', extractJson('') === null);
ok('truncated JSON does not throw', extractJson('{"steps":[{"do":"click"') === null
   || Array.isArray(extractJson('{"steps":[{"do":"click"')?.steps));

ok('repairJson fixes single quotes',
   JSON.parse(repairJson("{'a': 1}")).a === 1);
ok('repairJson fixes trailing commas',
   JSON.parse(repairJson('{"a":[1,2,],}')).a.length === 2);
ok('repairJson fixes unquoted keys',
   JSON.parse(repairJson('{do: "click"}')).do === 'click');
ok('repairJson leaves valid JSON alone',
   JSON.parse(repairJson('{"a":"it\'s fine"}')).a === "it's fine");

const salv = salvageFromProse('Click the Save button in cell C4 to continue.');
ok('salvage reads a click + cell from prose',
   salv?.steps?.[0]?.do === 'click' && salv.steps[0].cell === 'C4', JSON.stringify(salv));
ok('salvage marks itself as salvaged', salv?.salvaged === true);
ok('salvage returns null for genuine prose',
   salvageFromProse('The weather is nice today.') === null);

/* ── Deterministic shortcuts ─────────────────────────────────────────── */
sec('SHORTCUTS — "close the window" must not need a model');

const sa = Object.create(ScreenAgent.prototype);
const SHORTCUT_CASES = [
  ['close the open window', 'ctrl+w'],
  ['close this', 'ctrl+w'],
  ['close the tab', 'ctrl+w'],
  ['save the file', 'ctrl+s'],
  ['save', 'ctrl+s'],
  ['undo that', 'ctrl+z'],
  ['paste', 'ctrl+v'],
  ['select all', 'ctrl+a'],
  ['switch window', 'alt+tab'],
  ['refresh', 'ctrl+r'],
];
for (const [instr, keys] of SHORTCUT_CASES) {
  const m = sa.matchShortcut(instr);
  ok(`"${instr}" → ${keys}`, m?.steps?.[0]?.keys === keys, JSON.stringify(m?.steps));
}
ok('"click the Send button" is NOT a shortcut', sa.matchShortcut('click the Send button') === null);
ok('"what is on my screen" is NOT a shortcut', sa.matchShortcut('what is on my screen') === null);
ok('alt+f4 is never used (it is blocklisted)',
   !ScreenAgent.SHORTCUTS.some(s => s.steps.some(x => /alt\+f4/i.test(x.keys || ''))));

console.log(`\n${'─'.repeat(56)}`);
console.log(`  \x1b[32mPASS ${p}\x1b[0m   ${f ? `\x1b[31mFAIL ${f}\x1b[0m` : 'FAIL 0'}`);
if (f) { console.log('  Failed: ' + fails.join(', ')); process.exit(1); }
console.log('  SCREEN AGENT + PALETTE VERIFIED');

