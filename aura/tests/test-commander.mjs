/**
 * NOVA :: wake commander follow-up logic
 * =======================================
 * The decision of WHEN the mic re-arms for a follow-up command is pure and
 * tested: one follow-up per wake, never mid-stream, never while speaking,
 * and the window closes on time.
 *
 *   node tests/test-commander.mjs
 */
import { FOLLOWUP_WINDOW_MS, REARM_DELAY_MS, shouldRearmCommander, followupOpen }
  from '../js/voice/commander.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); }
};
const S = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

S('NORMAL TURN (typed / mic, no wake) — NO follow-up');
ok('typed turn never re-arms', !shouldRearmCommander({ wakeOriginated: false, streaming: false, speaking: false }));

S('WAKE ORIGINATED + ALL QUIET — RE-ARM');
ok('wake turn with idle system re-arms',
   shouldRearmCommander({ wakeOriginated: true, wakeWordEnabled: true, streaming: false, speaking: false }));
ok('explicit followupEnabled=false blocks it',
   !shouldRearmCommander({ wakeOriginated: true, followupEnabled: false }));
ok('wake word disabled blocks it',
   !shouldRearmCommander({ wakeOriginated: true, wakeWordEnabled: false }));

S('NEVER WHILE BUSY');
ok('still streaming → no re-arm', !shouldRearmCommander({ wakeOriginated: true, streaming: true }));
ok('TTS still speaking → no re-arm', !shouldRearmCommander({ wakeOriginated: true, speaking: true }));
ok('streaming beats speaking flag edge', !shouldRearmCommander({ wakeOriginated: true, streaming: true, speaking: false }));

S('WINDOW TIMING');
const t0 = 1_000_000;
ok('window is open right after arming', followupOpen(t0, t0 + FOLLOWUP_WINDOW_MS));
ok('window open just before close', followupOpen(t0 + FOLLOWUP_WINDOW_MS - 1, t0 + FOLLOWUP_WINDOW_MS));
ok('window closed after expiry', !followupOpen(t0 + FOLLOWUP_WINDOW_MS + 1, t0 + FOLLOWUP_WINDOW_MS));
ok('NaN never opens the window', !followupOpen(NaN, t0));
ok('window constant is the documented 12s', FOLLOWUP_WINDOW_MS === 12000);
ok('re-arm delay is short but real (900ms)', REARM_DELAY_MS === 900);

S('EDGE — undefined inputs never throw');
ok('no args → false', shouldRearmCommander() === false);
ok('partial args → false', shouldRearmCommander({ wakeOriginated: true }) === false);

/* ─────────────────────────────────────────────────────────── */
console.log(`\n${'─'.repeat(56)}\n  PASS ${P}\tFAIL ${F}`);
process.exit(F ? 1 : 0);
