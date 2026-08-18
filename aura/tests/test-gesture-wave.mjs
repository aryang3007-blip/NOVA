/**
 * AURA :: wave-back + performance regression tests
 * ------------------------------------------------
 * Guards two measured bugs reported from real use.
 *
 * BUG A — "the hologram doesn't wave back".
 *   The avatar was never at fault: firing EV.GESTURE {gesture:'wave'} always
 *   moved the arm. The break was upstream in GestureStabilizer, which required
 *   `holdFrames` (5) CONSECUTIVE frames of the same gesture before emitting.
 *   That rule is right for a held pose (thumbs-up) but wrong for a wave, which
 *   is inherently temporal: WaveDetector reports isWave for a burst of frames
 *   and is then reset after firing. With a 2200ms cooldown on top, a 5-second
 *   wave produced ONE event, and often zero.
 *   Fix: waves are 'transient' — 1 frame to fire, 1200ms cooldown, and the
 *   "already active" suppression does not apply.
 *
 * BUG B — "it lags a lot if the app has been running for some while".
 *   ConversationMemory.messages grew without bound; only the SAVED copy was
 *   capped. Measured in-browser: DOM 1214 -> 7299 nodes and avatar.update()
 *   0.033ms -> 0.077ms per frame after a load test.
 */

import { WaveDetector, GestureStabilizer } from '../js/vision/gesture-classifier.js';
import { Memory } from '../js/ai/memory.js';

let pass = 0, fail = 0;
const chk = (n, c, d = '') => {
  c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
    : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n} ${d}`));
};

/** Simulate a hand waving in front of the camera. */
function simulateWave({ frames = 120, fps = 24, freq = 0.85, amplitude = 0.09 } = {}) {
  const det = new WaveDetector();
  const stab = new GestureStabilizer();
  const dt = 1000 / fps;
  let now = 0, fired = 0, waveFrames = 0;
  for (let f = 0; f < frames; f++) {
    now += dt;
    const x = 0.5 + Math.sin(f * freq) * amplitude;
    const w = det.push(x, now, true);
    if (w.isWave) waveFrames++;
    const gesture = w.isWave ? 'wave' : 'open_palm';
    const conf = w.isWave ? w.confidence : 0.8;
    const st = stab.update(gesture, conf, now);
    if (st.fire && st.gesture === 'wave') fired++;
  }
  return { fired, waveFrames };
}

console.log('\n  WAVE-BACK PIPELINE\n');

const normal = simulateWave({ freq: 0.85 });
chk('a 5s wave fires more than once', normal.fired >= 2, `fired=${normal.fired}`);
chk('wave is detected across many frames', normal.waveFrames > 30, `${normal.waveFrames} frames`);

for (const [label, freq] of [['slow', 0.55], ['normal', 0.85], ['fast', 1.2]]) {
  const r = simulateWave({ freq });
  chk(`${label} wave is answered`, r.fired >= 2, `fired=${r.fired}`);
}

// A held pose must NOT machine-gun — the old rule still applies to it.
{
  const stab = new GestureStabilizer();
  let now = 0, fired = 0;
  for (let f = 0; f < 120; f++) { now += 42; if (stab.update('thumbs_up', 0.9, now).fire) fired++; }
  chk('a held pose still fires once, not repeatedly', fired === 1, `fired=${fired}`);
}

// A single spurious wave frame should not fire while confidence is low.
{
  const stab = new GestureStabilizer();
  chk('low-confidence wave is rejected', !stab.update('wave', 0.2, 1000).fire);
}

// Waves must be spaced by the transient cooldown, not fire every frame.
{
  const stab = new GestureStabilizer();
  let now = 0, fired = 0;
  for (let f = 0; f < 60; f++) { now += 42; if (stab.update('wave', 0.95, now).fire) fired++; }
  chk('waves are rate-limited by cooldown', fired >= 2 && fired <= 4, `fired=${fired} in 2.5s`);
}

console.log('\n  MEMORY GROWTH (the "lags after a while" bug)\n');

{
  const m = new Memory({ maxTurns: 20, persist: false });
  for (let i = 0; i < 5000; i++) { m.addUser(`u${i}`); m.addAssistant(`a${i}`); }
  chk('in-RAM history is capped', m.messages.length <= 400, `${m.messages.length} messages`);
  chk('recent messages are kept',
      m.messages[m.messages.length - 1].content === 'a4999');
  chk('context window still works', m.window().length === m.maxTurns * 2);
  const s = m.summary();
  chk('summary still reports earlier topics', /Earlier in this session/.test(s), s.slice(0, 60));
  chk('older-topic trace is bounded', m.olderTopics.length <= 12, String(m.olderTopics.length));
}

{
  // Trimming must never corrupt the last-assistant update used while streaming.
  const m = new Memory({ maxTurns: 5, persist: false });
  for (let i = 0; i < 800; i++) { m.addUser(`u${i}`); m.addAssistant(`a${i}`); }
  m.updateLastAssistant('FINAL');
  chk('updateLastAssistant still targets the newest reply',
      m.messages[m.messages.length - 1].content === 'FINAL');
  chk('lastUser survives trimming', m.lastUser()?.content === 'u799');
}

console.log(`\n  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
