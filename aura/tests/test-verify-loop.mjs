/**
 * NOVA :: desktop-action verification loop tests
 * ===============================================
 * §9 honesty for launches: AURA only says "Verified — X is open" when the
 * foreground window title (or a live screen re-read) actually matches the
 * requested app. These are the pure matching/decision rules the engine runs.
 *
 *   node tests/test-verify-loop.mjs
 */
import { normalizeAppName, appMatchesTitle, isLaunchAction, shouldVerify,
         verificationNote } from '../js/ai/verify-loop.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); }
};
const S = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

S('NORMALIZE — exe, 64-bit, case and punctuation');
ok('exe suffix stripped', normalizeAppName('WhatsApp.exe') === 'whatsapp');
ok('64-bit marker stripped', normalizeAppName('Visual Studio Code (64-bit)') === 'visual studio code');
ok('case/seps normalized', normalizeAppName('  GOOGLE_CHROME ' ) === 'google chrome');
ok('empty stays empty', normalizeAppName('  ') === '');

S('TITLE MATCH — the App Actually Opened');
ok('exact title', appMatchesTitle('WhatsApp', 'WhatsApp'));
ok('title includes app', appMatchesTitle('WhatsApp', 'WhatsApp - Chat'));
ok('app includes title (window names the app only)', appMatchesTitle('Windows Notepad', 'notepad'));
ok('exe target vs plain title', appMatchesTitle('notepad.exe', 'Notepad - untitled.txt'));
ok('vs code alias matches full name', appMatchesTitle('vs code', 'Visual Studio Code'));
ok('chrome matches tabbed window', appMatchesTitle('Google Chrome', 'YouTube - Google Chrome'));

S('TITLE MISMATCH — wrong app must NOT verify');
ok('chrome ≠ word document', !appMatchesTitle('Chrome', 'Word - Document1'));
ok('whatsapp ≠ browser title', !appMatchesTitle('WhatsApp', 'YouTube - Google Chrome'));
ok('spotify ≠ explorer window', !appMatchesTitle('Spotify', 'File Explorer'));
ok('nothing vs nothing', !appMatchesTitle('', ''));

S('LAUNCH ACTIONS — what gets verified');
ok('launch_app', isLaunchAction('launch_app'));
ok('launch_application tool', isLaunchAction('launch_application'));
ok('open_url', isLaunchAction('open_url'));
ok('close_app is NOT a launch', !isLaunchAction('close_app'));
ok('set_volume is not verified', !isLaunchAction('set_volume'));
ok('shot of something starting', isLaunchAction('start_program'));

S('SHOULD VERIFY — never fake, never on failures');
ok('real launch with target → verify',
   shouldVerify({ ok: true, simulated: false, target: 'WhatsApp', action: 'launch_app' }));
ok('failed action → no verify', !shouldVerify({ ok: false, target: 'X', action: 'launch_app' }));
ok('simulated → no verify (nothing really opened)',
   !shouldVerify({ ok: true, simulated: true, target: 'X', action: 'launch_app' }));
ok('no target → no verify', !shouldVerify({ ok: true, target: '', action: 'launch_app' }));
ok('non-launch action → no verify', !shouldVerify({ ok: true, target: 'X', action: 'close_app' }));
ok('config off → no verify', !shouldVerify({ enabled: false, ok: true, target: 'X', action: 'launch_app' }));

S('NARRATION — the honest line');
ok('verified app is named', verificationNote({ verified: true, app: 'WhatsApp' })
   === 'Verified — WhatsApp is in the foreground.');
ok('screen method disclosed', /screen re-read/.test(
   verificationNote({ verified: true, app: 'Chrome', method: 'screen' })));
ok('unverified admits it', verificationNote({ verified: false, app: 'X', reason: 'still opening' })
   .startsWith('Could not confirm X on screen —'));
ok('no attempt → no line', verificationNote(null) === '');

/* ─────────────────────────────────────────────────────────── */
console.log(`\n${'─'.repeat(56)}\n  PASS ${P}\tFAIL ${F}`);
process.exit(F ? 1 : 0);
