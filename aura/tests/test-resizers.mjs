/**
 * NOVA :: layout drag-resizer logic tests
 * ========================================
 * Pure math + persistence rules for js/ui/resizers.js. The DOM wiring is
 * browser-only (initResizers returns null here) — the invariants that can
 * be wrong (clamps, drag direction, persistence, mobile disable) are all
 * pure and tested.
 *
 *   node tests/test-resizers.mjs
 */
import { clamp, defaults, normalizeLayout, valueFromDrag, storedLayout,
         persistLayout, LAYOUT_DEFAULTS, LAYOUT_LIMITS, MIN_WINDOW,
         initResizers } from '../js/ui/resizers.js';
import { config } from '../js/core/config.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); }
};
const S = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

S('CLAMP + DEFAULTS');
ok('dock default is 66', LAYOUT_DEFAULTS.dockW === 66);
ok('panel default is 400', LAYOUT_DEFAULTS.panelW === 400);
ok('composer default is a real height', LAYOUT_DEFAULTS.composerH >= 96);
ok('clamp inside range is identity', clamp(300, [280, 760]) === 300);
ok('clamp below floor', clamp(10, [280, 760]) === 280);
ok('clamp above ceiling', clamp(5000, [48, 140]) === 140);
ok('clamp NaN → floor', clamp('abc', [280, 760]) === 280);
ok('defaults() is a fresh copy', defaults() !== LAYOUT_DEFAULTS);

S('valueFromDrag — DIRECTION SEMANTICS');
// dock: dragging the right edge +40px widens the dock
ok('dock drag right widens', valueFromDrag('dockW', 66, 40, 0) === 106);
// panels: dragging the LEFT edge right (+dx) NARROWS the panel
ok('panels drag right narrows', valueFromDrag('panelW', 400, 60, 0) === 340);
ok('panels drag left widens', valueFromDrag('panelW', 400, -60, 0) === 460);
// composer: dragging its TOP edge up (dy negative) makes it taller
ok('composer drag up grows', valueFromDrag('composerH', 148, 0, -60) === 208);
ok('composer drag down shrinks', valueFromDrag('composerH', 148, 0, 30) === 118);

S('LIMITS ENFORCED DURING A DRAG');
ok('dock cannot go below floor', valueFromDrag('dockW', 66, -1000, 0) === LAYOUT_LIMITS.dockW[0]);
ok('dock cannot exceed ceiling', valueFromDrag('dockW', 66, 1000, 0) === LAYOUT_LIMITS.dockW[1]);
ok('panel cannot exceed ceiling', valueFromDrag('panelW', 400, -1000, 0) === LAYOUT_LIMITS.panelW[1]);
ok('composer cannot go below floor', valueFromDrag('composerH', 148, 0, 1000) === LAYOUT_LIMITS.composerH[0]);

S('normalizeLayout — CORRUPT/STALE STORAGE NEVER WINS');
const n1 = normalizeLayout({ dockW: 200, panelW: 9999, composerH: 'x', junk: 1 });
ok('oversized values clamped down', n1.dockW === LAYOUT_LIMITS.dockW[1] && n1.panelW === LAYOUT_LIMITS.panelW[1]);
ok('garbage values fall back to defaults', n1.composerH === LAYOUT_DEFAULTS.composerH);
ok('unknown keys dropped', !('junk' in n1));
ok('null storage → defaults', JSON.stringify(normalizeLayout(null)) === JSON.stringify(defaults()));

S('storedLayout + persistLayout — the ONLY valid JSON survives');
config.data.layout = null;
ok('no stored layout → defaults', JSON.stringify(storedLayout()) === JSON.stringify(defaults()));
const custom = normalizeLayout({ dockW: 90, panelW: 520, composerH: 200 });
persistLayout(custom);
ok('persisted layout round-trips', JSON.stringify(storedLayout()) === JSON.stringify(custom),
   JSON.stringify(storedLayout()));
config.data.layout = '{broken json';
ok('corrupt string → defaults, never crash', JSON.stringify(storedLayout()) === JSON.stringify(defaults()));
config.data.layout = null;

S('MOBILE THRESHOLD + NON-BROWSER');
ok('mobile cut-off is 900px', MIN_WINDOW === 900);
ok('initResizers is a safe no-op outside a browser', initResizers() === null);

/* ─────────────────────────────────────────────────────────── */
console.log(`\n${'─'.repeat(56)}\n  PASS ${P}\tFAIL ${F}`);
process.exit(F ? 1 : 0);
