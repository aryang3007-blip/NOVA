/**
 * AURA :: new gestures, soft cursor, trace
 * ========================================
 * Covers the three failures the user reported:
 *
 *   1. `/watch` never moved a cursor      → ScreenCursor, works on ANY surface
 *   2. automation expired after 15 min    → rolling TTL (asserted in python)
 *   3. no way to see what AURA is doing   → Trace
 *
 * Plus the new swipe + three-finger gestures, with explicit assertions that a
 * WAVE is never misread as a SWIPE — the two share an open hand and the same
 * wrist signal, so separating them is the whole design problem.
 */

import { classifyGesture, SwipeDetector, WaveDetector, GESTURES }
  from '../js/vision/gesture-classifier.js';
import { ScreenCursor } from '../js/vision/screen-cursor.js';
import { Trace } from '../js/core/trace.js';

let p = 0, f = 0; const fails = [];
const ok = (n, c, d = '') => { c ? (p++, console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`))
  : (f++, fails.push(n), console.log(`  \x1b[31m✗\x1b[0m ${n}  \x1b[90m${d}\x1b[0m`)); };
const sec = t => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

/* Build a 21-landmark hand with chosen fingers extended. */
function hand({ thumb = false, index = false, middle = false, ring = false, pinky = false,
                thumbUp = true } = {}) {
  const L = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  L[0] = { x: 0.5, y: 0.9, z: 0 };                 // wrist
  L[9] = { x: 0.5, y: 0.6, z: 0 };                 // middle MCP → palm scale 0.3
  const col = { 1: 0.34, 5: 0.42, 9: 0.5, 13: 0.58, 17: 0.66 };
  for (const mcp of [1, 5, 9, 13, 17]) {
    const x = col[mcp];
    L[mcp] = { x, y: 0.62, z: 0 };
    L[mcp + 1] = { x, y: 0.56, z: 0 };
    L[mcp + 2] = { x, y: 0.52, z: 0 };
    L[mcp + 3] = { x, y: 0.50, z: 0 };
  }
  const ext = (mcp, on) => {
    const x = col[mcp];
    if (on) {
      L[mcp + 1] = { x, y: 0.46, z: 0 };
      L[mcp + 2] = { x, y: 0.36, z: 0 };
      L[mcp + 3] = { x, y: 0.26, z: 0 };
    } else {
      L[mcp + 1] = { x, y: 0.58, z: 0 };
      L[mcp + 2] = { x, y: 0.63, z: 0 };
      L[mcp + 3] = { x, y: 0.66, z: 0 };
    }
  };
  ext(5, index); ext(9, middle); ext(13, ring); ext(17, pinky);
  if (thumb) {
    const ty = thumbUp ? 0.40 : 0.99;
    L[2] = { x: 0.26, y: 0.60, z: 0 };
    L[3] = { x: 0.20, y: 0.55, z: 0 };
    L[4] = { x: 0.14, y: ty, z: 0 };
  } else {
    L[2] = { x: 0.38, y: 0.62, z: 0 };
    L[3] = { x: 0.40, y: 0.60, z: 0 };
    L[4] = { x: 0.43, y: 0.60, z: 0 };
  }
  return L;
}

/* ══════════════ THREE-FINGER GESTURE ══════════════ */
sec('THREE FINGERS → settings');

ok('gesture is registered', !!GESTURES.three, JSON.stringify(GESTURES.three));
const three = classifyGesture(hand({ index: true, middle: true, ring: true }));
ok('index+middle+ring classifies as three', three.gesture === 'three',
   `${three.gesture} @ ${three.confidence.toFixed(2)}`);
ok('confidence is usable', three.confidence > 0.7, String(three.confidence));

// Must not collide with the poses the user already relies on.
const peace = classifyGesture(hand({ index: true, middle: true }));
ok('peace is still peace', peace.gesture === 'peace', peace.gesture);
const rock = classifyGesture(hand({ index: true, pinky: true }));
ok('rock is still rock (user uses this daily)', rock.gesture === 'rock', rock.gesture);
const palm = classifyGesture(hand({ thumb: true, index: true, middle: true, ring: true, pinky: true }));
ok('open palm is still open palm', palm.gesture === 'open_palm', palm.gesture);
const point = classifyGesture(hand({ index: true }));
ok('pointing is still pointing', point.gesture === 'pointing', point.gesture);
const fist = classifyGesture(hand({}));
ok('fist is still fist', fist.gesture === 'fist', fist.gesture);
ok('four fingers is NOT three',
   classifyGesture(hand({ index: true, middle: true, ring: true, pinky: true })).gesture !== 'three');

/* ══════════════ SWIPES ══════════════ */
sec('SWIPE DETECTION — fast, straight, one-way');

for (const g of ['swipe_left', 'swipe_right', 'swipe_up', 'swipe_down']) {
  ok(`${g} is registered`, !!GESTURES[g]);
}

/**
 * Feed a straight movement across `ms` and return the FIRST frame that fired.
 *
 * The detector deliberately fires mid-gesture — as soon as distance, speed and
 * straightness all clear their thresholds — and then resets so the tail of the
 * same motion cannot fire again. Only inspecting the final sample would miss
 * the event entirely, which is a bug in the test, not the detector.
 */
function swipeRun(det, from, to, ms = 260, n = 9, t0 = 1000) {
  let fired = null, last = { swipe: null, distance: 0, speed: 0, straightness: 0 };
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    const r = det.push(from.x + (to.x - from.x) * k,
                       from.y + (to.y - from.y) * k,
                       t0 + k * ms, true);
    if (r.swipe && !fired) fired = r;
    if (r.distance) last = r;
  }
  return fired || last;
}

// Mirrored preview: decreasing x is perceived as moving RIGHT.
let d = new SwipeDetector();
let r = swipeRun(d, { x: 0.75, y: 0.5 }, { x: 0.25, y: 0.5 });
ok('leftward pixel motion → swipe_right (mirrored)', r.swipe === 'swipe_right',
   `${r.swipe} d=${r.distance?.toFixed(2)} s=${r.speed?.toFixed(2)}`);

d = new SwipeDetector();
r = swipeRun(d, { x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 });
ok('rightward pixel motion → swipe_left (mirrored)', r.swipe === 'swipe_left', String(r.swipe));

d = new SwipeDetector();
r = swipeRun(d, { x: 0.5, y: 0.8 }, { x: 0.5, y: 0.25 });
ok('upward motion → swipe_up', r.swipe === 'swipe_up', String(r.swipe));

d = new SwipeDetector();
r = swipeRun(d, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.78 });
ok('downward motion → swipe_down', r.swipe === 'swipe_down', String(r.swipe));

sec('SWIPE REJECTS WHAT IT SHOULD');

d = new SwipeDetector();
r = swipeRun(d, { x: 0.5, y: 0.5 }, { x: 0.58, y: 0.5 });
ok('a short nudge is not a swipe', !r.swipe, `d=${r.distance?.toFixed(3)}`);

d = new SwipeDetector();
r = swipeRun(d, { x: 0.75, y: 0.5 }, { x: 0.25, y: 0.5 }, 3000, 20);
ok('a slow drift is not a swipe', !r.swipe, `speed=${r.speed?.toFixed(2)}`);

d = new SwipeDetector();
r = swipeRun(d, { x: 0.2, y: 0.2 }, { x: 0.7, y: 0.7 });
ok('a 45° diagonal fires nothing (ambiguous)', !r.swipe, String(r.swipe));

d = new SwipeDetector();
r = d.push(0.5, 0.5, 1000, false);
ok('a closed hand never swipes', !r.swipe);

// THE IMPORTANT ONE: a wave must not read as a swipe.
d = new SwipeDetector();
const w = new WaveDetector();
let swipeFired = null, waveFired = false;
for (let i = 0; i < 40; i++) {
  const t = 1000 + i * 40;
  const x = 0.5 + Math.sin(i * 0.9) * 0.13;    // oscillating = a wave
  const sr = d.push(x, 0.5, t, true);
  if (sr.swipe) swipeFired = sr.swipe;
  if (w.push(x, t, true).isWave) waveFired = true;
}
ok('a WAVE is detected as a wave', waveFired);
ok('a WAVE never fires a swipe', !swipeFired, `fired ${swipeFired}`);

d = new SwipeDetector();
r = swipeRun(d, { x: 0.78, y: 0.5 }, { x: 0.22, y: 0.5 });
ok('a real swipe has high straightness', r.straightness > 0.95, String(r.straightness?.toFixed(2)));

// Cooldown stops one flick becoming a burst.
d = new SwipeDetector();
swipeRun(d, { x: 0.78, y: 0.5 }, { x: 0.22, y: 0.5 });
const second = swipeRun(d, { x: 0.78, y: 0.5 }, { x: 0.22, y: 0.5 }, 260, 9, 1300);
ok('cooldown blocks an immediate repeat', !second.swipe, String(second.swipe));
// ...but a later, separate flick still works.
const third = swipeRun(d, { x: 0.78, y: 0.5 }, { x: 0.22, y: 0.5 }, 260, 9, 4000);
ok('a genuinely separate swipe fires again', third.swipe === 'swipe_right', String(third.swipe));

/* ══════════════ SCREEN CURSOR ══════════════ */
sec("AURA'S OWN CURSOR — the missing piece in /watch");

const mkScreen = (surface = 'monitor', active = true) => ({
  active, surface,
  geometry: () => active ? { width: 1920, height: 1080, capturedWidth: 1280,
                             capturedHeight: 720, scale: 1280 / 1920 } : null,
  toScreenPoint(x, y) {
    if (!active) return { ok: false, message: 'Nothing is being shared.' };
    if (surface !== 'monitor') return { ok: false, message: 'Re-share and choose "Entire Screen" to enable clicking.' };
    const g = this.geometry();
    return { ok: true, x: Math.round(x / g.scale), y: Math.round(y / g.scale) };
  },
});

let cur = new ScreenCursor({ screen: mkScreen('monitor') });
ok('starts hidden', !cur.visible);
let mv = cur.moveTo(640, 360, { label: 'Save' });
ok('moves to a frame coordinate', mv.ok && cur.x === 640 && cur.y === 360, JSON.stringify(mv));
ok('becomes visible', cur.visible);
ok('carries a label', cur.label === 'Save');
ok('maps to real desktop pixels', (() => {
  const s = cur.toScreenPoint();
  return s.ok && Math.abs(s.x - 960) <= 2 && Math.abs(s.y - 540) <= 2;
})(), JSON.stringify(cur.toScreenPoint()));

// THE FIX: a window share still gets a cursor. It just is not clickable.
cur = new ScreenCursor({ screen: mkScreen('window') });
mv = cur.moveTo(320, 180, { label: 'Send' });
ok('a WINDOW share still gets AURA\'s cursor', mv.ok && cur.visible, JSON.stringify(mv));
ok('but it refuses to produce desktop pixels', !cur.toScreenPoint().ok);
ok('and explains why', /entire screen/i.test(cur.toScreenPoint().message || ''));

cur = new ScreenCursor({ screen: mkScreen('monitor') });
ok('clamps beyond the right edge', cur.moveTo(99999, 10).x === 1280);
ok('clamps beyond the bottom edge', cur.moveTo(10, 99999).y === 720);
ok('clamps negatives', cur.moveTo(-500, -500).x === 0);

cur.moveToCell('C4', 12, 8);
ok('C4 lands in the third column', cur.x > 1280 * 2 / 12 && cur.x < 1280 * 3 / 12, String(cur.x));
ok('C4 lands in the fourth row', cur.y > 720 * 3 / 8 && cur.y < 720 * 4 / 8, String(cur.y));
ok('A1 lands top-left', (() => { cur.moveToCell('A1', 12, 8); return cur.x < 110 && cur.y < 60; })());
ok('rejects a cell outside the grid', !cur.moveToCell('Z9', 12, 8).ok);
ok('rejects nonsense', !cur.moveToCell('banana', 12, 8).ok);

cur.moveTo(1, 1); cur.moveTo(2, 2); cur.moveTo(3, 3);
ok('keeps a trail for multi-step plans', cur.trail.length >= 3, String(cur.trail.length));
for (let i = 0; i < 30; i++) cur.moveTo(i, i);
ok('trail is bounded', cur.trail.length <= 12, String(cur.trail.length));
cur.hide();
ok('hides on demand', !cur.visible);
ok('hidden cursor has no screen point', !cur.toScreenPoint().ok);

const off = new ScreenCursor({ screen: mkScreen('monitor', false) });
ok('cannot move when nothing is shared', !off.moveTo(10, 10).ok);

/* ══════════════ TRACE ══════════════ */
sec('TRACE — see exactly what AURA did');

const t = new Trace('/do save the file');
t.ok('Capture frame', '1280x720, 13 KB');
t.info('Route', 'ocr path');
t.warn('Map to desktop', 'window share');
t.fail('Click', 'refused');
ok('records every step', t.steps.length === 4);
ok('preserves order', t.steps.map(s => s.label)[0] === 'Capture frame');
ok('records states', t.steps.map(s => s.state).join(',') === 'ok,info,warn,fail');
ok('captures the evidence, not just a label',
   t.steps[0].detail.includes('13 KB'), t.steps[0].detail);
ok('times each step', t.steps.every(s => typeof s.ms === 'number'));
const md = t.toMarkdown();
ok('renders to markdown', md.includes('Capture frame') && md.includes('❌'));
ok('markdown names the operation', md.includes('/do save the file'));
const done = t.end('ok', 'finished');
ok('end() summarises', done.steps === 4 && done.state === 'ok', JSON.stringify(done));
ok('total time is tracked', t.totalMs >= 0);

let threw = null;
try {
  await new Trace('x').stage('boom', async () => { throw new Error('kaboom'); });
} catch (e) { threw = e; }
ok('stage() re-throws after logging', threw?.message === 'kaboom');

console.log(`\n${'─'.repeat(56)}`);
console.log(`  \x1b[32mPASS ${p}\x1b[0m   ${f ? `\x1b[31mFAIL ${f}\x1b[0m` : 'FAIL 0'}`);
if (f) { console.log('  Failed: ' + fails.join(', ')); process.exit(1); }
console.log('  GESTURES + CURSOR + TRACE VERIFIED');
