/**
 * AURA :: Privacy Guard
 * =====================
 * Implements the eight scenarios from the specification, plus the
 * architectural guarantees that make this safe:
 *
 *   • Vision alone can never execute a desktop action — everything goes
 *     through the Runtime's permission gate.
 *   • No screen coordinates are ever involved.
 *   • A minimised window is never auto-restored.
 */

import { PrivacyGuard, GUARD_STATE, SENSITIVITY } from '../js/vision/privacy-guard.js';
import { COMMANDS, validate } from '../js/runtime/command-registry.js';
import { bus, EV } from '../js/core/bus.js';
import { state } from '../js/core/state.js';

let p = 0, f = 0; const fails = [];
const ok = (n, c, d = '') => { c ? (p++, console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`))
  : (f++, fails.push(n), console.log(`  \x1b[31m✗\x1b[0m ${n}  \x1b[90m${d}\x1b[0m`)); };
const sec = t => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A kernel stand-in that records what was proposed. */
function mkKernel({ allow = true } = {}) {
  const calls = [];
  return {
    calls,
    execute: async (proposal) => {
      calls.push(proposal);
      // Validate against the REAL registry so a bad command name fails here
      // exactly as it would in production.
      const v = validate(proposal);
      if (!v.ok) return { ok: false, stage: 'registry', error: v.error };
      if (!allow) return { ok: false, stage: 'permission',
                           error: 'needs the "minimize_windows" permission' };
      return { ok: true, stage: 'execute', result: { summary: 'Minimised “Notepad”.' } };
    },
  };
}

function mkGuard(opts = {}, kernelOpts = {}) {
  const kernel = mkKernel(kernelOpts);
  const store = {};
  const g = new PrivacyGuard({
    kernel,
    config: { get: k => store[k], set: (k, v) => { store[k] = v; } },
  });
  g.configure({ detectionPersistenceMs: 200, cooldownMs: 400, ...opts });
  if (opts.minimumConfidence == null) g.configure({ minimumConfidence: 0.7 });
  if (opts.minArea == null) g.configure({ minArea: 0.02 });
  g.opts.ignoreOwnFaceMs = 0;      // no grace period in tests
  return { g, kernel };
}

/**
 * A GENUINE threat: two faces, one of them unrecognised.
 *
 * v0.18 fired on a single face — the owner sitting at their own laptop.
 * Every scenario below therefore models the real situation the feature is
 * for: someone standing behind you. `owner()` and `stranger1()` cover the
 * cases that must NOT fire.
 */
const person = (over = {}) => ({
  type: 'person_detected', present: true, count: 2,
  confidence: 0.9, area: 0.06, source: 'face',
  boundingBox: { x: .4, y: .3, width: .2, height: .3 },
  faceCount: 2, knownNames: ['Owner'], ownerPresent: true,
  timestamp: Date.now(), ...over,
});
/** Just the owner at their desk — the reported false positive. */
const ownerAlone = (over = {}) => person({
  count: 1, faceCount: 1, knownNames: ['Owner'], ...over });
/** One unrecognised face, nobody else — still only one person. */
const strangerAlone = (over = {}) => person({
  count: 1, faceCount: 1, knownNames: [], ownerPresent: false, ...over });
const nobody = (over = {}) => ({
  type: 'person_absent', present: false, count: 0, confidence: 0, area: 0,
  timestamp: Date.now(), ...over,
});

/* ══════════════ THE COMMAND ══════════════ */
sec('THE COMMAND EXISTS AND IS GATED');

const cmd = COMMANDS['desktop.minimize_active_window'];
ok('desktop.minimize_active_window is registered', !!cmd);
ok('it requires a permission', cmd?.permission === 'minimize_windows', String(cmd?.permission));
ok('it is not read-only', cmd?.readOnly === false);
ok('it takes NO coordinate parameters',
   Object.keys(cmd?.params || {}).length === 0, JSON.stringify(Object.keys(cmd?.params || {})));
ok('no registry command mentions x/y for minimising',
   !Object.values(COMMANDS).some(c => /minimi/i.test(c.name) && (c.params?.x || c.params?.y)));

/* ══════════════ SPEC TESTS 1-8 ══════════════ */
sec('TEST 1 — guard OFF, person appears → nothing happens');
{
  const { g, kernel } = mkGuard();
  for (let i = 0; i < 12; i++) g.onPresence(person());
  await sleep(320);
  for (let i = 0; i < 12; i++) g.onPresence(person());
  ok('no action proposed', kernel.calls.length === 0, JSON.stringify(kernel.calls));
  ok('state stays DISABLED', g.state === GUARD_STATE.DISABLED, g.state);
  ok('nothing even counted', g.stats.detections === 0, String(g.stats.detections));
}

sec('TEST 2 — guard ON, nobody detected → nothing happens');
{
  const { g, kernel } = mkGuard();
  g.enable();
  for (let i = 0; i < 20; i++) g.onPresence(nobody());
  await sleep(320);
  for (let i = 0; i < 20; i++) g.onPresence(nobody());
  ok('no action proposed', kernel.calls.length === 0);
  ok('never left monitoring', g.state !== GUARD_STATE.ACTION_EXECUTED, g.state);
  ok('nothing qualified', g.stats.qualified === 0, String(g.stats.qualified));
}

sec('TEST 3 — person present for LESS than persistence → no action');
{
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 500 });
  g.enable();
  const t0 = Date.now();
  g.onPresence(person({ timestamp: t0 }));
  g.onPresence(person({ timestamp: t0 + 120 }));
  g.onPresence(person({ timestamp: t0 + 300 }));
  ok('no action before the threshold', kernel.calls.length === 0, `${g.stats.qualified} qualified`);
  ok('it IS timing the detection', g.state === GUARD_STATE.THREAT_DETECTED, g.state);
  ok('progress is reported', g.status().persistingMs > 0, String(g.status().persistingMs));
  // Person leaves before the threshold — timer must reset, not accumulate.
  g.onPresence(nobody({ timestamp: t0 + 400 }));
  g.onPresence(person({ timestamp: t0 + 700 }));
  ok('the timer restarted rather than accumulating', kernel.calls.length === 0);
}

sec('TEST 4 — person persists beyond threshold → minimise');
{
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 300 });
  g.enable();
  const t0 = Date.now();
  g.onPresence(person({ timestamp: t0 }));
  g.onPresence(person({ timestamp: t0 + 200 }));
  ok('still nothing at 200ms', kernel.calls.length === 0);
  g.onPresence(person({ timestamp: t0 + 350 }));
  await sleep(40);
  ok('action proposed once past the threshold', kernel.calls.length === 1,
     JSON.stringify(kernel.calls));
  ok('it proposed the RIGHT command',
     kernel.calls[0]?.command === 'desktop.minimize_active_window',
     String(kernel.calls[0]?.command));
  ok('the proposal carries no coordinates',
     !('x' in (kernel.calls[0] || {})) && !('y' in (kernel.calls[0] || {})));
  ok('state reached ACTION_EXECUTED or COOLDOWN',
     [GUARD_STATE.ACTION_EXECUTED, GUARD_STATE.COOLDOWN].includes(g.state), g.state);
  ok('the trigger is recorded', g.stats.triggers === 1, String(g.stats.triggers));
  ok('history explains why', g.status().history[0]?.ok === true,
     JSON.stringify(g.status().history[0]));
}

sec('TEST 5 — person still visible after minimising → no repeat');
{
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 150, cooldownMs: 5000 });
  g.enable();
  const t0 = Date.now();
  g.onPresence(person({ timestamp: t0 }));
  g.onPresence(person({ timestamp: t0 + 200 }));
  await sleep(40);
  ok('fired once', kernel.calls.length === 1, String(kernel.calls.length));
  for (let i = 1; i <= 30; i++) g.onPresence(person({ timestamp: t0 + 200 + i * 60 }));
  await sleep(40);
  ok('30 further detections do NOT re-fire', kernel.calls.length === 1,
     `${kernel.calls.length} calls`);
  ok('they were counted as suppressed', g.stats.suppressed >= 25, String(g.stats.suppressed));
  ok('state reports COOLDOWN', g.state === GUARD_STATE.COOLDOWN, g.state);
  ok('remaining cooldown is reported', g.status().cooldownRemainingMs > 0);
}

sec('TEST 6 — person disappears → window stays minimised');
{
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 150, cooldownMs: 200 });
  g.enable();
  const t0 = Date.now();
  g.onPresence(person({ timestamp: t0 }));
  g.onPresence(person({ timestamp: t0 + 200 }));
  await sleep(40);
  const after = kernel.calls.length;
  for (let i = 1; i <= 15; i++) g.onPresence(nobody({ timestamp: t0 + 300 + i * 80 }));
  await sleep(300);
  for (let i = 1; i <= 15; i++) g.onPresence(nobody({ timestamp: Date.now() }));
  ok('exactly one action total', kernel.calls.length === after && after === 1,
     String(kernel.calls.length));
  ok('NO restore was ever proposed',
     !kernel.calls.some(c => /restore/i.test(c.command || '')), JSON.stringify(kernel.calls));
  ok('there is no restore command in the registry at all',
     !Object.keys(COMMANDS).some(n => /restore/i.test(n)),
     Object.keys(COMMANDS).filter(n => /restore/i.test(n)).join(','));
}

sec('TEST 7 — detection flickers → no accidental restore, no double fire');
{
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 300, cooldownMs: 3000 });
  g.enable();
  const t0 = Date.now();
  // Flicker: present / absent / present, never continuous long enough.
  const seq = [0, 100, 'gap', 250, 'gap', 400, 'gap', 550];
  let n = 0;
  for (const step of seq) {
    if (step === 'gap') { g.onPresence(nobody({ timestamp: t0 + (n += 40) })); continue; }
    g.onPresence(person({ timestamp: t0 + step }));
  }
  ok('flickering never triggers', kernel.calls.length === 0, String(kernel.calls.length));
  ok('and never proposes a restore', !kernel.calls.length);
  // The sequence ends on a PRESENT frame, so THREAT_DETECTED (timing a fresh
  // detection) is the correct state — the earlier assertion of MONITORING was
  // simply wrong about the fixture, not about the code.
  ok('it is timing the newest detection, not carrying old progress',
     g.state === GUARD_STATE.THREAT_DETECTED, g.state);
  g.onPresence(nobody({ timestamp: Date.now() }));
  ok('once the person leaves it returns to MONITORING',
     g.state === GUARD_STATE.MONITORING, g.state);
}

sec('TEST 8 — disabled mid-monitor → stops immediately');
{
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 400 });
  g.enable();
  const t0 = Date.now();
  g.onPresence(person({ timestamp: t0 }));
  g.onPresence(person({ timestamp: t0 + 200 }));
  ok('mid-persistence', g.status().persistingMs > 0);
  g.disable();
  ok('state is DISABLED immediately', g.state === GUARD_STATE.DISABLED, g.state);
  // Keep feeding it well past the threshold.
  for (let i = 1; i <= 20; i++) g.onPresence(person({ timestamp: t0 + 200 + i * 100 }));
  await sleep(60);
  ok('no action after disabling', kernel.calls.length === 0, String(kernel.calls.length));
  ok('the persistence timer was cleared', g.status().persistingMs === 0);
}

/* ══════════════ THRESHOLDS ══════════════ */
sec('CONFIDENCE AND PROXIMITY GATES');
{
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 100, minimumConfidence: 0.7, minArea: 0.02 });
  g.enable();
  const t0 = Date.now();
  // Low confidence, plenty of area.
  g.onPresence(person({ confidence: 0.4, timestamp: t0 }));
  g.onPresence(person({ confidence: 0.4, timestamp: t0 + 200 }));
  ok('low confidence never qualifies', kernel.calls.length === 0);
  // High confidence, tiny — someone far across the room.
  g.onPresence(person({ area: 0.002, timestamp: t0 + 300 }));
  g.onPresence(person({ area: 0.002, timestamp: t0 + 500 }));
  ok('a distant person does not trigger', kernel.calls.length === 0, String(kernel.calls.length));
  // Both satisfied.
  g.onPresence(person({ timestamp: t0 + 600 }));
  g.onPresence(person({ timestamp: t0 + 800 }));
  await sleep(40);
  ok('close + confident DOES trigger', kernel.calls.length === 1, String(kernel.calls.length));
}

sec('SENSITIVITY PRESETS');
ok('three presets exist', Object.keys(SENSITIVITY).length === 3, Object.keys(SENSITIVITY).join(','));
ok('sensitive triggers earliest',
   SENSITIVITY.sensitive.minArea < SENSITIVITY.balanced.minArea
   && SENSITIVITY.balanced.minArea < SENSITIVITY.conservative.minArea);
ok('conservative demands the most persistence',
   SENSITIVITY.conservative.detectionPersistenceMs > SENSITIVITY.sensitive.detectionPersistenceMs);
ok('every preset explains itself', Object.values(SENSITIVITY).every(s => s.hint?.length > 20));
{
  const { g } = mkGuard();
  g.setSensitivity('sensitive');
  ok('setSensitivity applies all three values',
     g.opts.minArea === SENSITIVITY.sensitive.minArea
     && g.opts.minimumConfidence === SENSITIVITY.sensitive.minimumConfidence
     && g.opts.detectionPersistenceMs === SENSITIVITY.sensitive.detectionPersistenceMs);
  ok('an unknown preset is rejected', !g.setSensitivity('paranoid').ok);
}

/* ══════════════ SAFETY ══════════════ */
sec('SAFETY — vision alone cannot act');
{
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 100 }, { allow: false });
  g.enable();
  const t0 = Date.now();
  g.onPresence(person({ timestamp: t0 }));
  g.onPresence(person({ timestamp: t0 + 200 }));
  await sleep(40);
  ok('the command was PROPOSED', kernel.calls.length === 1);
  ok('but the permission gate refused it', g.stats.rejected === 1, String(g.stats.rejected));
  ok('and it entered cooldown rather than retrying forever',
     g.state === GUARD_STATE.COOLDOWN, g.state);
  const before = kernel.calls.length;
  for (let i = 0; i < 20; i++) g.onPresence(person({ timestamp: t0 + 400 + i * 50 }));
  ok('a rejected action does not spin', kernel.calls.length === before, String(kernel.calls.length));
}
{
  const g = new PrivacyGuard({ kernel: null });
  g.configure({ detectionPersistenceMs: 50 });
  g.opts.ignoreOwnFaceMs = 0;
  g.enable();
  const t0 = Date.now();
  g.onPresence(person({ timestamp: t0 }));
  g.onPresence(person({ timestamp: t0 + 100 }));
  await sleep(40);
  ok('with no kernel it fails safe instead of throwing',
     g.state === GUARD_STATE.COOLDOWN, g.state);
}

sec('DEFAULTS ARE SAFE');
{
  const g = new PrivacyGuard({});
  ok('OFF by default', g.opts.enabled === false);
  ok('starts DISABLED', g.state === GUARD_STATE.DISABLED);
  ok('conservative by default', g.opts.sensitivity === 'conservative');
  ok('cooldown is 5s by default', g.opts.cooldownMs === 5000, String(g.opts.cooldownMs));
  ok('action is the registry command', g.opts.action === 'desktop.minimize_active_window');
  ok('all six states exist', Object.keys(GUARD_STATE).length === 6,
     Object.keys(GUARD_STATE).join(','));
}

sec('CONFIG CLAMPING');
{
  const { g } = mkGuard();
  g.configure({ detectionPersistenceMs: -500, minimumConfidence: 99, cooldownMs: 999999 });
  ok('persistence is clamped', g.opts.detectionPersistenceMs >= 100, String(g.opts.detectionPersistenceMs));
  ok('confidence is clamped to ≤1', g.opts.minimumConfidence <= 1, String(g.opts.minimumConfidence));
  ok('cooldown is clamped', g.opts.cooldownMs <= 120000, String(g.opts.cooldownMs));
}

sec('BUS INTEGRATION — independent consumer, no interference');
{
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 100 });
  g.attach();
  g.enable();
  // Other vision consumers must be unaffected: fire gesture + face events too.
  let gestureSeen = 0, faceSeen = 0;
  const gh = () => gestureSeen++; const fh = () => faceSeen++;
  bus.on(EV.GESTURE, gh); bus.on(EV.FACES, fh);
  bus.emit(EV.GESTURE, { gesture: 'wave', confidence: 0.9 });
  bus.emit(EV.FACES, { faces: [], blendshapes: [] });
  const t0 = Date.now();
  bus.emit(EV.PRESENCE, person({ timestamp: t0 }));
  bus.emit(EV.PRESENCE, person({ timestamp: t0 + 200 }));
  await sleep(50);
  ok('guard reacts to bus PRESENCE events', kernel.calls.length === 1, String(kernel.calls.length));
  ok('gesture events still delivered', gestureSeen === 1, String(gestureSeen));
  ok('face events still delivered', faceSeen === 1, String(faceSeen));
  bus.off(EV.GESTURE, gh); bus.off(EV.FACES, fh);
  g.detach();
  const n = kernel.calls.length;
  bus.emit(EV.PRESENCE, person({ timestamp: Date.now() }));
  bus.emit(EV.PRESENCE, person({ timestamp: Date.now() + 300 }));
  await sleep(50);
  ok('detach() really unsubscribes', kernel.calls.length === n, String(kernel.calls.length));
}

/* ══════════════════════════════════════════════════════════════════════
 * REGRESSION: "it minimized when I showed it my own face"
 *
 * Reported by the user against v0.18. The guard gated only on face SIZE, so
 * the owner sitting at their own laptop always qualified. Two rules now run
 * BEFORE the confidence/proximity checks.
 * ══════════════════════════════════════════════════════════════════════ */
sec('OWNER IS NEVER A THREAT');

{
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 100 });
  g.enable();
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) g.onPresence(ownerAlone({ timestamp: t0 + i * 120 }));
  await sleep(60);
  ok('THE REPORTED BUG: owner alone never triggers', kernel.calls.length === 0,
     `${kernel.calls.length} calls`);
  ok('and it says why', /only 1 face/.test(g.status().lastVeto || ''), g.status().lastVeto);
  ok('the veto is counted', g.stats.vetoed > 0, String(g.stats.vetoed));
  // ARMED (no camera in Node) or MONITORING (camera live) are both correct;
  // what matters is that it never advanced to THREAT_DETECTED.
  ok('it never advances to THREAT_DETECTED',
     [GUARD_STATE.ARMED, GUARD_STATE.MONITORING].includes(g.state), g.state);
}
{
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 100 });
  g.enable();
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) g.onPresence(strangerAlone({ timestamp: t0 + i * 120 }));
  await sleep(60);
  ok('one UNRECOGNISED face alone also does not trigger', kernel.calls.length === 0,
     `${kernel.calls.length} calls`);
  ok('because one person is not someone standing behind you',
     /need 2/.test(g.status().lastVeto || ''), g.status().lastVeto);
}
{
  // Two faces, both enrolled — you and someone you deliberately added.
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 100 });
  g.enable();
  const t0 = Date.now();
  const pair = ts => person({ faceCount: 2, knownNames: ['Owner', 'Partner'], timestamp: ts });
  for (let i = 0; i < 10; i++) g.onPresence(pair(t0 + i * 120));
  await sleep(60);
  ok('two ENROLLED faces do not trigger', kernel.calls.length === 0, String(kernel.calls.length));
  ok('and it names them', /Owner, Partner/.test(g.status().lastVeto || ''), g.status().lastVeto);
}
{
  // The case the feature exists for.
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 100 });
  g.enable();
  const t0 = Date.now();
  g.onPresence(person({ timestamp: t0 }));
  g.onPresence(person({ timestamp: t0 + 200 }));
  await sleep(60);
  ok('owner + ONE STRANGER does trigger', kernel.calls.length === 1, String(kernel.calls.length));
  ok('no veto was recorded', !g.status().lastVeto, String(g.status().lastVeto));
}
{
  // Two unknown faces — you are away and two strangers are at your desk.
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 100 });
  g.enable();
  const t0 = Date.now();
  const two = ts => person({ faceCount: 2, knownNames: [], ownerPresent: false, timestamp: ts });
  g.onPresence(two(t0));
  g.onPresence(two(t0 + 200));
  await sleep(60);
  ok('two unknown faces trigger', kernel.calls.length === 1, String(kernel.calls.length));
}
{
  // Owner switch OFF: back to pure head-count.
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 100 });
  g.enable();
  g.configure({ neverIfOwnerAlone: false });
  const t0 = Date.now();
  const pair = ts => person({ faceCount: 2, knownNames: ['Owner', 'Partner'], timestamp: ts });
  g.onPresence(pair(t0));
  g.onPresence(pair(t0 + 200));
  await sleep(60);
  ok('disabling the owner rule makes 2 enrolled faces trigger',
     kernel.calls.length === 1, String(kernel.calls.length));
}
{
  // minFaces = 1 restores the old (unsafe) behaviour, deliberately opt-in.
  const { g, kernel } = mkGuard({ detectionPersistenceMs: 100 });
  g.enable();
  g.configure({ minFaces: 1, neverIfOwnerAlone: false });
  const t0 = Date.now();
  g.onPresence(strangerAlone({ timestamp: t0 }));
  g.onPresence(strangerAlone({ timestamp: t0 + 200 }));
  await sleep(60);
  ok('minFaces=1 is available for those who want it',
     kernel.calls.length === 1, String(kernel.calls.length));
  ok('minFaces is clamped to a sane range', (() => {
    g.configure({ minFaces: 99 }); return g.opts.minFaces <= 5;
  })(), String(g.opts.minFaces));
}
sec('SAFE DEFAULTS FOR THE NEW RULES');
{
  const g = new PrivacyGuard({});
  ok('minFaces defaults to 2', g.opts.minFaces === 2, String(g.opts.minFaces));
  ok('owner protection is ON by default', g.opts.neverIfOwnerAlone === true);
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`  \x1b[32mPASS ${p}\x1b[0m   ${f ? `\x1b[31mFAIL ${f}\x1b[0m` : 'FAIL 0'}`);
if (f) { console.log('  Failed: ' + fails.join(', ')); process.exit(1); }
console.log('  PRIVACY GUARD VERIFIED');
