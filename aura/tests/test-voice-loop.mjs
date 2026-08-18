/**
 * AURA :: Voice feedback-loop regression tests
 * --------------------------------------------
 * Guards the "the app listens to what it says and gets stuck in a loop" bug.
 *
 * Failure mode being prevented:
 *   TTS speaks → speakers emit audio → the still-open microphone hears it →
 *   SpeechRecognition transcribes it → autoSendOnFinal fires → AURA answers →
 *   ...forever.
 *
 * Three independent defences are tested here:
 *   1. Hard gate     — transcripts arriving while ttsSpeaking are dropped.
 *   2. Tail window   — plus a short window after speech ends (audio in flight).
 *   3. Echo matching — text that closely matches what AURA just said is
 *                      rejected even outside the window.
 * Plus the restart-storm guard that stopped the mic hot-looping.
 *
 * Runs headless: jsdom-free, we stub only what speech.js touches.
 */

let pass = 0, fail = 0;
const chk = (n, c, d = '') => {
  c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
    : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n} ${d}`));
};

/* ── minimal browser surface ─────────────────────────────────────────── */
class FakeRecognition {
  constructor() { FakeRecognition.instances.push(this); this.started = 0; }
  start() { this.started++; this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() {}
}
FakeRecognition.instances = [];

globalThis.window = /** @type {any} */ ({
  SpeechRecognition: FakeRecognition,
  speechSynthesis: { getVoices: () => [], cancel() {}, speak() {} },
  isSecureContext: true,
});
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node', mediaDevices: {} },
    writable: true, configurable: true,
  });
} catch {}
try {
  Object.defineProperty(globalThis, 'location', {
    value: { hostname: 'localhost' },
    writable: true, configurable: true,
  });
} catch {}
globalThis.SpeechSynthesisUtterance = class {};

const { SpeechInput, phraseOverlap } = await import('../js/voice/speech.js');
const { bus, EV } = await import('../js/core/bus.js');
const { state } = await import('../js/core/state.js');

/* ── helper: drive a final transcript through the recogniser ─────────── */
function emitFinal(rec, text) {
  rec.onresult?.({
    resultIndex: 0,
    results: Object.assign([[{ transcript: text, confidence: 0.9 }]], {
      length: 1, 0: Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: true }),
    }),
  });
}

console.log('\n  VOICE FEEDBACK-LOOP GUARDS\n');

/* 1 ── word-overlap maths ------------------------------------------------ */
chk('identical phrases overlap 1.0', phraseOverlap('hello there', 'hello there') === 1);
chk('unrelated phrases overlap 0',   phraseOverlap('what is the weather', 'xyz abc') === 0);
chk('punctuation/case ignored',      phraseOverlap('Hello, THERE!', 'hello there') === 1);
chk('partial echo scores high',
    phraseOverlap('all systems nominal commander', 'all systems nominal, commander.') >= 0.9);

/* 2 ── hard gate while speaking ------------------------------------------ */
const si = new SpeechInput();
si.mode = 'command';
const rec = si._create();

let finals = [];
bus.on(EV.STT_FINAL, ({ text }) => finals.push(text));
let suppressed = [];
bus.on('voice:echo-suppressed', ({ text }) => suppressed.push(text));

state.set({ ttsSpeaking: false });
si._spokeUntil = 0;
finals = [];
emitFinal(rec, 'what is the weather');
chk('normal speech passes through when silent', finals.length === 1 && finals[0] === 'what is the weather');

state.set({ ttsSpeaking: true });
finals = [];
emitFinal(rec, 'all systems nominal commander');
chk('transcript DROPPED while AURA is speaking', finals.length === 0);

/* 3 ── tail window after speech ends -------------------------------------- */
state.set({ ttsSpeaking: false });
si._spokeUntil = Date.now() + 500;          // audio still leaving the speakers
finals = [];
emitFinal(rec, 'residual speaker audio');
chk('transcript DROPPED in the post-speech tail window', finals.length === 0);

/* 4 ── echo matching outside the window ----------------------------------- */
si._spokeUntil = Date.now();                 // window closed
si._selfSpoken = 'All systems nominal, Commander.';
finals = []; suppressed = [];
emitFinal(rec, 'all systems nominal commander');
chk('echo of our own speech rejected after the window', finals.length === 0);
chk('rejection is reported, not silent', suppressed.length === 1);

// A genuine new question in the same period must still get through.
finals = [];
emitFinal(rec, 'open spotify please');
chk('genuine user speech still passes during echo-guard', finals.length === 1);

// Very short utterances are not judged as echoes (too little signal).
si._selfSpoken = 'yes';
finals = [];
emitFinal(rec, 'yes');
chk('one-word replies are not misjudged as echo', finals.length === 1);

/* 5 ── restart-storm guard ------------------------------------------------ */
const si2 = new SpeechInput();
si2.mode = 'command';
const rec2 = si2._create();
si2.wantListening = true;
state.set({ ttsSpeaking: false });

let fatal = null;
bus.on(EV.STT_ERROR, (e) => { if (e.error === 'restart-loop') fatal = e; });

for (let i = 0; i < 8; i++) rec2.onend?.();   // 8 immediate end events
chk('rapid restart storm is stopped', fatal !== null);
chk('storm stop disables listening', si2.wantListening === false);
chk('storm error is fatal + explains itself',
    !!fatal?.fatal && /microphone/i.test(fatal.message));

/* 6 ── does not restart the mic while speaking ---------------------------- */
const si3 = new SpeechInput();
si3.mode = 'command';
const rec3 = si3._create();
si3.wantListening = true;
state.set({ ttsSpeaking: true });
const before = rec3.started;
rec3.onend?.();
await new Promise(r => setTimeout(r, 400));
chk('mic is NOT reopened while TTS is speaking', rec3.started === before);
state.set({ ttsSpeaking: false });
await new Promise(r => setTimeout(r, 900));
chk('mic resumes once speech has finished', rec3.started > before);
si3.wantListening = false;

/* 7 ── HARD MUTE: the fix for "it hears its own Hello Commander" ───────── */
console.log('\n  HALF-DUPLEX HARD MUTE\n');
{
  const si4 = new SpeechInput();
  si4.mode = 'command';
  const rec4 = si4._create();
  si4.wantListening = true;
  si4.listening = true;
  si4.recognition = rec4;
  state.set({ ttsSpeaking: false });
  si4._spokeUntil = 0;
  si4._selfSpoken = '';

  finals = [];
  emitFinal(rec4, 'a genuine question');
  chk('speech passes before muting', finals.length === 1);

  // TTS_START fires -> speech.js mutes ITSELF (not main.js).
  bus.emit(EV.TTS_START, { text: 'Hello there, Commander. Good to see you.' });
  chk('TTS_START mutes the microphone', si4.muted === true);
  chk('mute remembers to resume afterwards', si4._resumeAfterSpeech === true);

  // THE ACTUAL BUG: SpeechRecognition.stop() is async, so Chrome still
  // delivers results it had already buffered. Those must be dropped.
  state.set({ ttsSpeaking: false });        // state flag alone would NOT catch it
  finals = [];
  emitFinal(rec4, 'hello there commander good to see you');
  chk('late buffered result is dropped while muted', finals.length === 0);

  // Even a completely unrelated phrase is ignored while muted — during
  // playback we cannot tell speaker bleed from the user.
  finals = [];
  emitFinal(rec4, 'what is the weather in delhi');
  chk('nothing at all gets through while muted', finals.length === 0);

  // Speech ends -> tail window, then unmute.
  bus.emit(EV.TTS_END, {});
  chk('still muted during the acoustic tail', si4.muted === true);
  finals = [];
  emitFinal(rec4, 'still echoing');
  chk('tail window still suppresses', finals.length === 0);

  await new Promise(r => setTimeout(r, 1100));
  chk('unmutes after the tail', si4.muted === false);
  finals = [];
  state.set({ ttsSpeaking: false });
  si4._spokeUntil = 0;
  si4._selfSpoken = '';
  emitFinal(rec4, 'a brand new question');
  chk('user speech works again after unmute', finals.length === 1);
  si4.wantListening = false;
}

/* 8 ── interrupt path unmutes quickly ----------------------------------- */
{
  const si5 = new SpeechInput();
  si5.mode = 'command';
  si5.recognition = si5._create();
  si5.wantListening = true;
  bus.emit(EV.TTS_START, { text: 'a long sentence being spoken' });
  chk('muted on speak', si5.muted === true);
  bus.emit(EV.TTS_INTERRUPT, { reason: 'user' });
  await new Promise(r => setTimeout(r, 600));
  chk('interrupt unmutes faster than a normal end', si5.muted === false);
  si5.wantListening = false;
}

/* 9 ── network errors are quiet after the first ------------------------- */
{
  const si6 = new SpeechInput();
  si6.mode = 'command';
  const rec6 = si6._create();
  const errs = [];
  bus.on(EV.STT_ERROR, (e) => { if (e.error === 'network') errs.push(e); });
  rec6.onerror?.({ error: 'network' });
  rec6.onerror?.({ error: 'network' });
  rec6.onerror?.({ error: 'network' });
  chk('first network error is loud', errs[0] && errs[0].quiet !== true);
  chk('repeats are marked quiet', errs.slice(1).every(e => e.quiet === true), `${errs.length} errors`);
  chk('network errors are never fatal', errs.every(e => e.fatal === false));
}

/* 10 ── BUG #106: the restart-storm guard must actually fire ------------- */
{
  // The user's report: "the mic keeps on infinitly turning on and off" on
  // first login. The OLD guard counted a rapid end as a gap < 900ms between
  // ends, but its own backoff grew that gap past 900ms on the third retry, so
  // the counter reset and it looped forever. These lock the fix down.

  /** Run `n` sessions that each died after `ranMs`, return when it gave up. */
  const runDeadMic = (ranMs, limit = 60) => {
    const si = new SpeechInput();
    for (let i = 0; i < limit; i++) {
      si._startedAt = Date.now() - ranMs;
      si._sawResultThisSession = false;
      const d = si.decideRestart(Date.now());
      if (d.giveUp) return { gaveUpAfter: i, streak: d.streak };
    }
    return { gaveUpAfter: null };
  };

  const instant = runDeadMic(5);
  chk('#106 a mic that dies instantly stops retrying',
      instant.gaveUpAfter !== null, `gave up after ${instant.gaveUpAfter}`);
  chk('#106 it stops within a handful of tries',
      instant.gaveUpAfter !== null && instant.gaveUpAfter <= 6,
      String(instant.gaveUpAfter));

  const slowish = runDeadMic(699);
  chk('#106 a session just under the healthy threshold still counts as failure',
      slowish.gaveUpAfter !== null, String(slowish.gaveUpAfter));

  // The regression itself: with the old rule the growing backoff reset the
  // counter. Prove the streak now increases monotonically regardless of delay.
  {
    const si = new SpeechInput();
    const streaks = [];
    for (let i = 0; i < 5; i++) {
      si._startedAt = Date.now() - 5;
      si._sawResultThisSession = false;
      streaks.push(si.decideRestart(Date.now()).streak);
    }
    chk('#106 the failure streak never resets on its own',
        JSON.stringify(streaks) === JSON.stringify([1, 2, 3, 4, 5]), JSON.stringify(streaks));
  }

  // A working mic must never be shut off, no matter how long it runs.
  {
    const si = new SpeechInput();
    let gaveUp = false;
    for (let i = 0; i < 500; i++) {
      si._startedAt = Date.now() - 2000;      // healthy 2s session
      si._sawResultThisSession = false;
      if (si.decideRestart(Date.now()).giveUp) { gaveUp = true; break; }
    }
    chk('#106 a healthy mic is never shut off', !gaveUp);
  }

  // One good session in the middle must clear the streak.
  {
    const si = new SpeechInput();
    for (let i = 0; i < 4; i++) {
      si._startedAt = Date.now() - 5; si._sawResultThisSession = false;
      si.decideRestart(Date.now());
    }
    si._startedAt = Date.now() - 50;
    si._sawResultThisSession = true;          // heard something: it works
    const good = si.decideRestart(Date.now());
    chk('#106 a session that heard speech resets the streak', good.streak === 0,
        String(good.streak));
  }

  // Backoff must be bounded, or the UI just looks dead.
  {
    const si = new SpeechInput();
    let max = 0;
    for (let i = 0; i < 5; i++) {
      si._startedAt = Date.now() - 5; si._sawResultThisSession = false;
      const d = si.decideRestart(Date.now());
      if (!d.giveUp) max = Math.max(max, d.delay);
    }
    chk('#106 the retry delay is capped at 2s', max <= 2000, `${max}ms`);
  }
}

console.log(`\n  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
