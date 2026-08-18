/**
 * AURA :: dwell-to-click unit tests
 * =================================
 * Pure logic, no browser. Time is injected, so every timing behaviour is
 * deterministic — no sleeps, no flakiness.
 *
 *   node tests/test-dwell.mjs
 */
import { DwellController, DWELL_DEFAULTS, classifyTarget, WEB_TARGET_SELECTOR }
  from '../js/vision/dwell.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); }
};
const S = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

/** Feed a still fingertip for `ms`, stepping `step` ms at a time. */
function hold(d, pt, ms, t0, step = 33) {
  let fired = null, t = t0, last = null;
  for (; t <= t0 + ms; t += step) {
    last = d.update(pt, t);
    if (last.fired) fired = { at: t, res: last };
  }
  return { fired, t, last };
}

/* ─────────────────────────────────────────────────────────────────── */
S('DEFAULTS ARE SANE');
ok('dwellMs is 1000', DWELL_DEFAULTS.dwellMs === 1000, String(DWELL_DEFAULTS.dwellMs));
ok('armMs shorter than dwellMs', DWELL_DEFAULTS.armMs < DWELL_DEFAULTS.dwellMs);
ok('holdRadius < cancelRadius', DWELL_DEFAULTS.holdRadius < DWELL_DEFAULTS.cancelRadius);
ok('graceMs is positive', DWELL_DEFAULTS.graceMs > 0);

/* ─────────────────────────────────────────────────────────────────── */
S('DISABLED BY DEFAULT — NOTHING HAPPENS');
{
  const d = new DwellController();
  ok('starts disabled', d.enabled === false);
  ok('starts IDLE', d.state === 'IDLE');
  const { fired } = hold(d, { x: 0.5, y: 0.5 }, 5000, 0);
  ok('never fires while disabled', fired === null);
  ok('progress stays 0', d.progress === 0);
  ok('state never leaves IDLE', d.state === 'IDLE');
}

/* ─────────────────────────────────────────────────────────────────── */
S('A STEADY HOLD FIRES EXACTLY ONCE');
{
  const d = new DwellController(); d.setEnabled(true);
  const { fired } = hold(d, { x: 0.4, y: 0.6 }, 1400, 1000);
  ok('fired', !!fired);
  ok('fired at roughly dwellMs', fired && Math.abs((fired.at - 1000) - 1000) <= 40,
     fired ? `${fired.at - 1000}ms` : 'never');
  ok('fired flag true exactly once', d.stats.fired === 1, `fired=${d.stats.fired}`);
  ok('anchor reported with the click', fired && typeof fired.res.anchor.x === 'number');
  ok('enters COOLDOWN right after', d.state === 'COOLDOWN', d.state);
}

/* ─────────────────────────────────────────────────────────────────── */
S('PROGRESS RING: 0 → 25 → 50 → 75 → 100');
{
  const d = new DwellController(); d.setEnabled(true);
  const pt = { x: 0.3, y: 0.3 };
  const seen = [];
  for (let t = 0; t <= 1000; t += 20) {
    const r = d.update(pt, t);
    const ring = r.fired ? 100 : d.ringPercent();
    if (!seen.includes(ring)) seen.push(ring);
  }
  ok('ring passes through all five stops',
     [0, 25, 50, 75, 100].every(v => seen.includes(v)), JSON.stringify(seen));
  ok('ring stops are in ascending order',
     JSON.stringify(seen.filter(v => [0,25,50,75,100].includes(v)))
       === JSON.stringify([0,25,50,75,100]), JSON.stringify(seen));
}
{
  const d = new DwellController(); d.setEnabled(true);
  d.update({ x: .5, y: .5 }, 0);
  d.update({ x: .5, y: .5 }, 180 + (1000 - 180) * 0.5);   // exactly half way
  ok('ring reads 50 at the midpoint', d.ringPercent() === 50, String(d.ringPercent()));
  ok('progress ~0.5', Math.abs(d.progress - 0.5) < 0.02, d.progress.toFixed(3));
}

{
  // BUG #103 REGRESSION. On the firing tick update() zeroes progress for the
  // cooldown, so ringPercent() reads 0 at the exact moment the ring should
  // show a satisfying 100%. Anything rendering that tick must quantise the
  // RESULT, not the live controller state.
  const d = new DwellController(); d.setEnabled(true);
  let onFire = null;
  for (let t = 0; t <= 1200; t += 33) {
    const r = d.update({ x: .5, y: .5 }, t);
    if (r.fired) onFire = { fromResult: DwellController.ringOf(r.progress),
                            fromState: d.ringPercent(), progress: r.progress };
  }
  ok('#103: result progress is 1 on the firing tick', onFire && onFire.progress === 1,
     JSON.stringify(onFire));
  ok('#103: ringOf(result) reads 100', onFire && onFire.fromResult === 100,
     String(onFire && onFire.fromResult));
  ok('#103: live ringPercent() is 0 there — the trap this guards',
     onFire && onFire.fromState === 0, String(onFire && onFire.fromState));
}
{
  ok('ringOf quantises to the five stops',
     [DwellController.ringOf(0), DwellController.ringOf(0.3), DwellController.ringOf(0.6),
      DwellController.ringOf(0.8), DwellController.ringOf(1)].join(',') === '0,25,50,75,100');
}

/* ─────────────────────────────────────────────────────────────────── */
S('ARMING SUPPRESSES THE RING FOR A PASSING HAND');
{
  const d = new DwellController(); d.setEnabled(true);
  d.update({ x: .5, y: .5 }, 0);
  const r = d.update({ x: .5, y: .5 }, 100);           // still inside armMs
  ok('state is ARMING', d.state === 'ARMING', d.state);
  ok('progress still 0 during arming', r.progress === 0, String(r.progress));
  ok('ring reads 0 during arming', d.ringPercent() === 0);
  d.update({ x: .5, y: .5 }, 300);
  ok('becomes DWELLING after armMs', d.state === 'DWELLING', d.state);
}
{
  // A hand sweeping across the frame must not leave a trail of progress rings.
  const d = new DwellController(); d.setEnabled(true);
  let maxProgress = 0;
  for (let i = 0; i <= 30; i++) {
    const r = d.update({ x: 0.1 + i * 0.028, y: 0.5 }, i * 33);
    maxProgress = Math.max(maxProgress, r.progress);
  }
  ok('a sweeping hand never accumulates progress', maxProgress === 0, String(maxProgress));
  ok('a sweeping hand never fires', d.stats.fired === 0);
}

/* ─────────────────────────────────────────────────────────────────── */
S('JITTER IS FORGIVEN, REAL MOVEMENT IS NOT');
{
  // ±1.5% jitter — well inside holdRadius. Must still fire.
  const d = new DwellController(); d.setEnabled(true);
  let fired = null;
  for (let t = 0; t <= 1400; t += 33) {
    const j = () => (Math.sin(t * 0.7) * 0.012);
    const r = d.update({ x: 0.5 + j(), y: 0.5 - j() }, t);
    if (r.fired) fired = t;
  }
  ok('fires despite realistic jitter', fired !== null, String(fired));
}
{
  // Move clearly away mid-dwell: must cancel and restart, never fire early.
  const d = new DwellController(); d.setEnabled(true);
  for (let t = 0; t <= 600; t += 33) d.update({ x: 0.5, y: 0.5 }, t);
  const mid = d.progress;
  const r = d.update({ x: 0.75, y: 0.5 }, 633);          // jumped 25%
  ok('had real progress before the move', mid > 0.4, mid.toFixed(2));
  ok('progress resets after a decisive move', r.progress === 0, String(r.progress));
  ok('re-arms on the new spot', d.state === 'ARMING', d.state);
  ok('did not fire', d.stats.fired === 0);
  ok('counted as cancelled', d.stats.cancelled >= 1, String(d.stats.cancelled));
}
{
  // Wobble between holdRadius and cancelRadius: hold progress, do not cancel.
  const d = new DwellController(); d.setEnabled(true);
  for (let t = 0; t <= 600; t += 33) d.update({ x: 0.5, y: 0.5 }, t);
  const before = d.progress;
  const r = d.update({ x: 0.5 + 0.05, y: 0.5 }, 633);    // between the radii
  ok('wobble does not cancel', d.state === 'DWELLING', d.state);
  ok('wobble freezes progress rather than losing it',
     Math.abs(r.progress - before) < 0.001, `${before.toFixed(3)} -> ${r.progress.toFixed(3)}`);
}

/* ─────────────────────────────────────────────────────────────────── */
S('DROPPED FRAMES DO NOT KILL A DWELL (grace window)');
{
  const d = new DwellController(); d.setEnabled(true);
  let t = 0;
  for (; t <= 500; t += 33) d.update({ x: .5, y: .5 }, t);
  const before = d.progress;
  // MediaPipe drops 5 frames (~165ms) — inside graceMs.
  for (let k = 0; k < 5; k++) { d.update(null, t); t += 33; }
  ok('survives a 165ms dropout', d.state === 'DWELLING', d.state);
  ok('kept accumulating through the gap', d.progress > before,
     `${before.toFixed(2)} -> ${d.progress.toFixed(2)}`);
  let fired = null;
  for (; t <= 1400; t += 33) if (d.update({ x: .5, y: .5 }, t).fired) fired = t;
  ok('still fires afterwards', fired !== null);
}
{
  const d = new DwellController(); d.setEnabled(true);
  let t = 0;
  for (; t <= 500; t += 33) d.update({ x: .5, y: .5 }, t);
  // Hand truly leaves: 400ms with no sample, well past graceMs.
  for (let k = 0; k < 12; k++) { d.update(null, t); t += 33; }
  ok('a real dropout cancels', d.state === 'IDLE', d.state);
  ok('cancel reason recorded', d.lastCancelReason === 'pointer-lost', String(d.lastCancelReason));
  ok('progress cleared', d.progress === 0);
}

/* ─────────────────────────────────────────────────────────────────── */
S('LOW CONFIDENCE SAMPLES ARE IGNORED');
{
  const d = new DwellController(); d.setEnabled(true);
  const { fired } = hold(d, { x: .5, y: .5, confidence: 0.2 }, 2000, 0);
  ok('never fires on low-confidence samples', fired === null);
  ok('stays IDLE', d.state === 'IDLE', d.state);
}
{
  const d = new DwellController(); d.setEnabled(true);
  const { fired } = hold(d, { x: .5, y: .5, confidence: 0.9 }, 1400, 0);
  ok('fires on confident samples', fired !== null);
}

/* ─────────────────────────────────────────────────────────────────── */
S('NO MACHINE-GUN CLICKS (refractory period)');
{
  const d = new DwellController(); d.setEnabled(true);
  let fires = 0;
  for (let t = 0; t <= 3000; t += 33) if (d.update({ x: .5, y: .5 }, t).fired) fires++;
  ok('a hand resting for 3s fires once, not repeatedly', fires === 1, `${fires} fires`);
}
{
  const d = new DwellController({ cooldownMs: 250 }); d.setEnabled(true);
  let fires = [];
  for (let t = 0; t <= 5000; t += 33) if (d.update({ x: .5, y: .5 }, t).fired) fires.push(t);
  ok('still only one fire over 5 seconds', fires.length === 1, JSON.stringify(fires));
}
{
  // Moving to a genuinely different target should be allowed to fire again.
  const d = new DwellController(); d.setEnabled(true);
  let fires = [];
  for (let t = 0; t <= 1200; t += 33) if (d.update({ x: .3, y: .3 }, t).fired) fires.push(t);
  for (let t = 1233; t <= 2600; t += 33) if (d.update({ x: .7, y: .7 }, t).fired) fires.push(t);
  ok('a second, different target does fire', fires.length === 2, JSON.stringify(fires));
}
{
  // BUG #102 REGRESSION. The cooldown check was `time || distance`; a
  // motionless hand escaped it on time alone and fired 3x in 5 seconds.
  // Cooldown must require time AND distance.
  const d = new DwellController(); d.setEnabled(true);
  let fires = 0;
  for (let t = 0; t <= 20000; t += 33) if (d.update({ x: .42, y: .58 }, t).fired) fires++;
  ok('#102: 20 seconds of a motionless hand = exactly one click', fires === 1, `${fires} fires`);
  ok('#102: still parked in COOLDOWN', d.state === 'COOLDOWN', d.state);
}
{
  // Leaving the target and coming back IS a second deliberate click.
  const d = new DwellController(); d.setEnabled(true);
  const fires = [];
  for (let t = 0; t <= 1100; t += 33) if (d.update({ x: .5, y: .5 }, t).fired) fires.push(t);
  for (let t = 1133; t <= 1400; t += 33) d.update(null, t);            // hand drops out
  for (let t = 1433; t <= 2700; t += 33) if (d.update({ x: .5, y: .5 }, t).fired) fires.push(t);
  ok('leave and return re-arms the same target', fires.length === 2, JSON.stringify(fires));
}
{
  // A nudge smaller than reFireRadius must NOT re-arm.
  const d = new DwellController(); d.setEnabled(true);
  let fires = 0;
  for (let t = 0; t <= 1100; t += 33) if (d.update({ x: .5, y: .5 }, t).fired) fires++;
  for (let t = 1133; t <= 4000; t += 33)
    if (d.update({ x: .5 + 0.03, y: .5 }, t).fired) fires++;           // inside reFireRadius
  ok('a small nudge does not re-arm the fired target', fires === 1, `${fires} fires`);
}

/* ─────────────────────────────────────────────────────────────────── */
S('FRAME RATE DOES NOT CHANGE THE TIMING');
{
  const at = (fps) => {
    const d = new DwellController(); d.setEnabled(true);
    const step = 1000 / fps;
    for (let t = 0; t <= 2000; t += step)
      if (d.update({ x: .5, y: .5 }, t).fired) return t;
    return null;
  };
  const slow = at(8), fast = at(30), veryFast = at(60);
  ok('fires at ~1000ms at 8 fps', slow !== null && Math.abs(slow - 1000) < 130, String(slow));
  ok('fires at ~1000ms at 30 fps', fast !== null && Math.abs(fast - 1000) < 40, String(fast));
  ok('fires at ~1000ms at 60 fps', veryFast !== null && Math.abs(veryFast - 1000) < 25, String(veryFast));
  ok('8fps and 60fps agree within one slow frame',
     Math.abs(slow - veryFast) <= 125, `${slow} vs ${veryFast}`);
}

/* ─────────────────────────────────────────────────────────────────── */
S('SLOW DRIFT ACROSS A BIG BUTTON IS FORGIVEN');
{
  // 0.00035/ms drift ≈ 0.35 frame-widths over a second — a real, slow slide.
  const d = new DwellController(); d.setEnabled(true);
  let fired = null;
  for (let t = 0; t <= 1500; t += 33) {
    const r = d.update({ x: 0.4 + t * 0.00002, y: 0.5 }, t);
    if (r.fired) fired = t;
  }
  ok('anchor easing lets a slow drift complete', fired !== null, String(fired));
}

/* ─────────────────────────────────────────────────────────────────── */
S('CONTROL SURFACE');
{
  const d = new DwellController(); d.setEnabled(true);
  for (let t = 0; t <= 500; t += 33) d.update({ x: .5, y: .5 }, t);
  d.setEnabled(false);
  ok('disabling mid-dwell resets', d.state === 'IDLE' && d.progress === 0);
  const st = new DwellController().status();
  ok('status() reports enabled', st.enabled === false);
  ok('status() reports state', st.state === 'IDLE');
  ok('status() reports ring', st.ring === 0);
  ok('status() exposes opts', st.opts.dwellMs === 1000);
  ok('status() exposes stats', typeof st.stats.fired === 'number');
  const d2 = new DwellController();
  d2.configure({ dwellMs: 1600 });
  ok('configure() applies at runtime', d2.opts.dwellMs === 1600);
  ok('configure() keeps untouched defaults', d2.opts.armMs === DWELL_DEFAULTS.armMs);
}
{
  const d = new DwellController({ dwellMs: 500 }); d.setEnabled(true);
  let fired = null;
  for (let t = 0; t <= 900; t += 20) if (d.update({ x: .5, y: .5 }, t).fired) fired = t;
  ok('a custom 500ms dwell fires at ~500ms', fired !== null && Math.abs(fired - 500) < 40,
     String(fired));
}

/* ═════════════════════ TARGET CLASSIFIER ═════════════════════ */
S('CLASSIFIER: NOTHING TO CLICK');
{
  const r = classifyTarget({ point: { x: .5, y: .5 } });
  ok('no share, no hit -> none', r.kind === 'none', r.kind);
  ok('explains itself', /share your entire screen/i.test(r.reason), r.reason);
  ok('null point -> none', classifyTarget({ point: null }).kind === 'none');
  ok('NaN point -> none', classifyTarget({ point: { x: NaN, y: 0.5 } }).kind === 'none');
}

S("CLASSIFIER: AURA'S OWN UI");
{
  const fakeBtn = { tag: 'BUTTON', closest: (s) => (s === WEB_TARGET_SELECTOR ? fakeBtn : null) };
  const hit = () => fakeBtn;
  const r = classifyTarget({
    point: { x: .5, y: .5 }, hit, viewport: { width: 1440, height: 900 },
  });
  ok('a button under the finger -> web', r.kind === 'web', r.kind);
  ok('returns the element', r.element === fakeBtn);
  ok('reports viewport pixels', r.viewportPoint.x === 720 && r.viewportPoint.y === 450,
     JSON.stringify(r.viewportPoint));
  ok('web needs no permission', !r.needsPermission);
}
{
  // Mirroring: the preview is mirrored, so landmark x=0.2 is screen x=0.8.
  const seen = [];
  const hit = (x) => { seen.push(Math.round(x)); return null; };
  classifyTarget({ point: { x: 0.2, y: 0.5 }, hit, viewport: { width: 1000, height: 800 },
                   mirrored: true });
  ok('mirrored x is flipped', seen[0] === 800, String(seen[0]));
  seen.length = 0;
  classifyTarget({ point: { x: 0.2, y: 0.5 }, hit, viewport: { width: 1000, height: 800 },
                   mirrored: false });
  ok('unmirrored x is passed through', seen[0] === 200, String(seen[0]));
}
{
  const empty = { closest: () => null };
  const r = classifyTarget({ point: { x: .5, y: .5 }, hit: () => empty,
                             viewport: { width: 800, height: 600 } });
  ok('empty background -> none', r.kind === 'none', r.kind);
}

S('CLASSIFIER: THE WINDOWS DESKTOP');
{
  const r = classifyTarget({ point: { x: .5, y: .5 }, screenShared: true,
                             monitorShare: false, mousePermission: true });
  ok('a window/tab share cannot be clicked', r.kind === 'none', r.kind);
  ok('says why', /entire screen/i.test(r.reason), r.reason);
}
{
  const r = classifyTarget({ point: { x: .5, y: .5 }, screenShared: true,
                             monitorShare: true, mousePermission: false });
  ok('monitor share without permission -> desktop+needsPermission',
     r.kind === 'desktop' && r.needsPermission === true, `${r.kind}/${r.needsPermission}`);
  ok('names the permission', /Vision Mouse Control/.test(r.reason), r.reason);
  ok('points at Settings', /Settings/.test(r.reason));
}
{
  const r = classifyTarget({ point: { x: .5, y: .5 }, screenShared: true,
                             monitorShare: true, mousePermission: true });
  ok('monitor share with permission -> desktop', r.kind === 'desktop', r.kind);
  ok('no permission flag when granted', !r.needsPermission);
}
{
  // AURA's own UI wins over the desktop when both could match.
  const btn = { closest: () => btn };
  const r = classifyTarget({ point: { x: .5, y: .5 }, hit: () => btn,
                             viewport: { width: 800, height: 600 },
                             screenShared: true, monitorShare: true, mousePermission: true });
  ok("AURA's own control wins the tie", r.kind === 'web', r.kind);
}

S('CLASSIFIER: SELECTOR COVERAGE');
{
  ok('matches buttons', WEB_TARGET_SELECTOR.includes('button:not([disabled])'));
  ok('matches links', WEB_TARGET_SELECTOR.includes('a[href]'));
  ok('matches checkboxes', WEB_TARGET_SELECTOR.includes('input[type="checkbox"]'));
  ok('matches role=button', WEB_TARGET_SELECTOR.includes('[role="button"]'));
  ok('matches dock buttons', WEB_TARGET_SELECTOR.includes('.dock-btn'));
  ok('excludes disabled buttons', WEB_TARGET_SELECTOR.includes(':not([disabled])'));
}

console.log(`\n  \x1b[32mPASS ${P}\x1b[0m  FAIL ${F}`);
process.exit(F ? 1 : 0);
