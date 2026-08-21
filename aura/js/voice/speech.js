/**
 * AURA :: Speech System
 * ---------------------
 * STT  : Web Speech API (SpeechRecognition) — Chrome/Edge/Safari.
 * TTS  : SpeechSynthesis + a real-time viseme generator driving lip-sync.
 * Wake : continuous recognition scanning for the wake word.
 *
 * HONEST LIMITATIONS (documented, not hidden):
 *  • SpeechRecognition is unsupported in Firefox — AURA detects this and
 *    disables the mic button with an explanatory tooltip.
 *  • Browsers give no phoneme timing callbacks for TTS. AURA therefore
 *    derives visemes from the `boundary` event (real word timings) plus
 *    grapheme→viseme mapping, and interpolates between them. That is a
 *    genuine text-driven lip-sync, not a random mouth flap.
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';
import { config } from '../core/config.js';

const SR = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

/* ─────────────────────── grapheme → viseme mapping ──────────────────── */
/**
 * Viseme set (Preston Blair-ish, reduced):
 *   sil  closed/rest
 *   AI   open wide       (a, i)
 *   E    mid spread      (e)
 *   O    rounded         (o)
 *   U    tight round     (u, w)
 *   MBP  lips together   (m, b, p)
 *   FV   lip-teeth       (f, v)
 *   L    tongue up       (l, n, t, d)
 *   S    narrow          (s, z, c, ch, j)
 *   K    back            (k, g, r, h)
 */
export const VISEMES = ['sil', 'AI', 'E', 'O', 'U', 'MBP', 'FV', 'L', 'S', 'K'];

const CHAR_VISEME = {
  a: 'AI', i: 'AI', y: 'AI',
  e: 'E',
  o: 'O',
  u: 'U', w: 'U',
  m: 'MBP', b: 'MBP', p: 'MBP',
  f: 'FV', v: 'FV',
  l: 'L', n: 'L', t: 'L', d: 'L',
  s: 'S', z: 'S', c: 'S', j: 'S', x: 'S',
  k: 'K', g: 'K', r: 'K', h: 'K', q: 'K',
};

/**
 * Convert a word into a timed viseme sequence.
 * @param {string} word
 * @param {number} durationMs estimated duration of the word
 * @returns {Array<{viseme:string, t:number, dur:number, open:number}>}
 */
export function wordToVisemes(word, durationMs) {
  const clean = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!clean) return [{ viseme: 'sil', t: 0, dur: durationMs, open: 0 }];

  // collapse consecutive identical visemes
  const seq = [];
  for (const ch of clean) {
    const v = CHAR_VISEME[ch] || 'E';
    if (seq.length && seq[seq.length - 1] === v) continue;
    seq.push(v);
  }
  if (!seq.length) seq.push('E');

  const step = durationMs / seq.length;
  const OPEN = { sil: 0, MBP: 0.02, FV: 0.16, S: 0.2, L: 0.3, K: 0.36, U: 0.34, E: 0.5, O: 0.66, AI: 0.85 };
  return seq.map((v, i) => ({ viseme: v, t: i * step, dur: step, open: OPEN[v] ?? 0.4 }));
}

/** Estimate ms per word for a given speech rate. */
export function estimateWordDuration(word, rate = 1) {
  const base = 90 + String(word).replace(/[^a-z]/gi, '').length * 52;
  return Math.max(110, base / Math.max(0.4, rate));
}

/* ───────────────────────── Speech Recognition ───────────────────────── */

/** Normalise a phrase for echo comparison: lowercase, letters+digits only. */
function normalisePhrase(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Word-overlap ratio between two phrases (0..1).
 * Used to recognise AURA's own speech coming back through the microphone,
 * where the transcript is close to — but rarely identical to — the TTS text.
 */
export function phraseOverlap(a, b) {
  const A = normalisePhrase(a).split(' ').filter(Boolean);
  const B = new Set(normalisePhrase(b).split(' ').filter(Boolean));
  if (!A.length || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / A.length;
}

/** Phonetic similarity score between two words (0..1) using normalized edit distance */
export function phoneticSimilarity(a, b) {
  const s1 = String(a || '').toLowerCase();
  const s2 = String(b || '').toLowerCase();
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0;

  const len1 = s1.length;
  const len2 = s2.length;
  const matrix = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  const dist = matrix[len1][len2];
  const maxLen = Math.max(len1, len2);
  return 1 - (dist / maxLen);
}

export class SpeechInput {
  /** A session shorter than this produced nothing useful — treat as a failure. */
  static MIN_HEALTHY_MS = 700;
  /** Consecutive failures before we stop retrying and tell the user. */
  static MAX_FAILED_RESTARTS = 6;

  constructor() {
    this.supported = !!SR;
    /** When the current recognition session started (0 = not running). */
    this._startedAt = 0;
    /** Did this session yield any result at all? */
    this._sawResultThisSession = false;
    /** Consecutive failed restarts. */
    this._rapidEnds = 0;
    this.recognition = null;
    this.listening = false;
    this.wantListening = false;
    this.mode = 'command';           // 'command' | 'wake'
    this.finalBuffer = '';
    this.lastError = null;
    this._restartTimer = null;
    /** Text AURA most recently spoke — compared against transcripts. */
    this._selfSpoken = '';
    this._spokeUntil = 0;
    this._rapidEnds = 0;
    this._lastEndAt = 0;
    /** Set when the mic was closed for TTS and should reopen afterwards. */
    this._resumeAfterSpeech = false;
    /** Hard half-duplex gate — true = ignore everything the mic hears. */
    this.muted = false;
    this._muteReason = null;
    this._unmuteTimer = null;
    state.set({ sttSupported: this.supported });

    // Track our own speech so we can recognise it if the mic picks it up.
    if (typeof bus?.on === 'function') {
      // The speech system mutes ITSELF. Previously main.js did this, which
      // meant any TTS triggered from elsewhere (gesture greeting, wake-word
      // reply, plugin) bypassed the guard entirely — which is exactly how
      // "Hello Commander" got heard and answered.
      bus.on(EV.TTS_START, ({ text }) => {
        this._selfSpoken = text || '';
        this.mute('tts');
      });
      bus.on(EV.TTS_END, () => {
        this._spokeUntil = Date.now() + 900;
        this.unmute(900);
        setTimeout(() => { this._selfSpoken = ''; }, 4000);
      });
      bus.on(EV.TTS_INTERRUPT, () => {
        this._spokeUntil = Date.now() + 400;
        this.unmute(400);
      });
    }
  }

  /**
   * Is this transcript just AURA hearing itself?
   * True when most of the words appear in what we only just said.
   */
  _isEchoOfSelf(text) {
    if (!this._selfSpoken) return false;
    if (Date.now() > this._spokeUntil + 3500) return false;
    const t = normalisePhrase(text);
    if (t.split(' ').length < 2) return false;      // too short to judge
    return phraseOverlap(text, this._selfSpoken) >= 0.6;
  }

  get unsupportedReason() {
    if (this.supported) return null;
    const ua = navigator.userAgent;
    if (/Firefox/i.test(ua)) return 'Firefox does not implement the Web Speech Recognition API. Use Chrome, Edge or Safari for voice input — text input works everywhere.';
    return 'This browser does not support the Web Speech Recognition API. Chrome, Edge and Safari do.';
  }

  get isBrave() {
    return typeof navigator !== 'undefined' && (!!(navigator.brave && typeof navigator.brave.isBrave === 'function') || /Brave/i.test(navigator.userAgent));
  }

  /** Why might the mic fail? Checked before we start, so errors are explainable. */
  async diagnose() {
    const d = { ok: true, issues: [], permission: 'unknown', mics: 0 };
    if (!this.supported) {
      d.ok = false;
      d.issues.push({ code: 'unsupported', msg: this.unsupportedReason });
    }
    if (this.isBrave) {
      d.issues.push({
        code: 'brave',
        msg: 'Brave Browser blocks Google Speech Recognition by default. To use voice in Brave: open brave://settings/privacy and enable "Use Google speech services for speech recognition", or use text input.'
      });
    }
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      d.ok = false;
      d.issues.push({ code: 'insecure', msg: 'Speech recognition needs https:// or localhost. Run: python3 serve.py' });
    }
    if (window.self !== window.top) {
      d.issues.push({ code: 'iframe', msg: 'Inside an iframe the parent must set allow="microphone". Open AURA in its own tab.' });
    }
    try {
      if (navigator.permissions?.query) {
        const st = await navigator.permissions.query(/** @type {any} */ ({ name: 'microphone' }));
        d.permission = st.state;
        if (st.state === 'denied') {
          d.ok = false;
          d.issues.push({ code: 'denied', msg: 'Microphone permission is DENIED. Address-bar icon → Allow → reload.' });
        }
      }
      const devs = await navigator.mediaDevices?.enumerateDevices?.() || [];
      d.mics = devs.filter(x => x.kind === 'audioinput').length;
      if (navigator.mediaDevices && d.mics === 0) {
        d.ok = false;
        d.issues.push({ code: 'nodevice', msg: 'No microphone detected on this machine.' });
      }
    } catch { /* best effort */ }
    return d;
  }

  /**
   * Chrome's SpeechRecognition does NOT itself trigger the mic permission
   * prompt reliably; calling getUserMedia first makes the prompt appear and
   * lets us surface a real error instead of a silent no-op.
   */
  async ensurePermission() {
    if (!navigator.mediaDevices?.getUserMedia) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      state.set({ micPermission: 'granted' });
      return true;
    } catch (e) {
      state.set({ micPermission: 'denied' });
      bus.emit(EV.STT_ERROR, {
        error: e.name, fatal: true,
        message: e.name === 'NotAllowedError'
          ? 'Microphone permission denied. Click the mic/lock icon in the address bar → Allow → reload.'
          : e.name === 'NotFoundError' ? 'No microphone found on this machine.'
          : `Microphone unavailable: ${e.message}`,
      });
      return false;
    }
  }

  _create() {
    if (!this.supported) return null;
    const r = new SR();
    r.lang = config.get('sttLang') || 'en-US';
    r.continuous = this.mode === 'wake' ? true : !!config.get('sttContinuous');
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => {
      this.listening = true;
      // When this session began, so onend can tell "ran and heard nothing"
      // from "died instantly" — see the restart-storm guard (bug #106).
      this._startedAt = Date.now();
      this._sawResultThisSession = false;
      state.set({ sttActive: true, micPermission: 'granted' });
      this._armListeningTimeout();
      bus.emit(EV.STT_START, { mode: this.mode });
    };

    r.onresult = (event) => {
      // ── BARGE-IN INTERRUPTION ──
      if (window.speechSynthesis && window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        bus.emit(EV.TTS_INTERRUPT, { reason: 'barge-in' });
      }

      if (this._commandTimeout) {
        clearTimeout(this._commandTimeout);
        this._commandTimeout = null;
      }

      this._sawResultThisSession = true;
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0].transcript;
        if (res.isFinal) final += txt;
        else interim += txt;
      }
      const confidence = event.results[event.results.length - 1]?.[0]?.confidence ?? 0;

      // Stop command during playback or listening
      if (/\b(stop|cancel|shut up|be quiet)\b/i.test(interim || final)) {
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        bus.emit(EV.TTS_INTERRUPT, { reason: 'stop-command' });
      }

      const echoWindow = this.muted
        || state.get('ttsSpeaking')
        || Date.now() < (this._spokeUntil || 0);
      if (echoWindow) {
        if (final.trim()) {
          this._lastSuppressed = final.trim();
          bus.emit('voice:echo-suppressed', { text: final.trim(), reason: 'while-speaking' });
        }
        return;
      }

      if (interim) {
        bus.emit(EV.STT_PARTIAL, { text: interim.trim(), confidence });
        if (this.mode === 'wake') {
          this._checkWakeWord(interim, true);
        }
      }

      if (final.trim()) {
        const text = final.trim();
        if (this._isEchoOfSelf(text)) {
          bus.emit('voice:echo-suppressed', { text });
          return;
        }
        if (this.mode === 'wake') {
          this._checkWakeWord(text, false);
        } else {
          this.finalBuffer = text;
          bus.emit(EV.STT_FINAL, { text, confidence });
        }
      }
    };

    r.onerror = (e) => {
      this.lastError = e.error;
      const isBrave = this.isBrave;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        state.set({ micPermission: 'denied' });
        this.wantListening = false;
        const msg = isBrave
          ? 'Brave browser blocked Speech Recognition. Enable "Use Google speech services for speech recognition" in brave://settings/privacy or use text input.'
          : 'Microphone permission denied. Allow mic access in your browser\'s site settings, then try again.';
        bus.emit(EV.STT_ERROR, { error: e.error, fatal: true, message: msg });
      } else if (e.error === 'no-speech') {
        bus.emit(EV.STT_ERROR, { error: e.error, fatal: false, message: 'No speech detected.' });
      } else if (e.error === 'aborted') {
        // normal on stop()
      } else if (e.error === 'network') {
        this._netErrors = (this._netErrors || 0) + 1;
        const msg = isBrave
          ? 'Speech service blocked by Brave settings. Enable "Use Google speech services" in brave://settings/privacy or use text input.'
          : (this._netErrors === 1
            ? 'Speech service lost connection — Chrome\'s recogniser needs internet. Retrying automatically.'
            : `Speech service reconnecting (${this._netErrors})…`);
        bus.emit(EV.STT_ERROR, {
          error: e.error, fatal: false, quiet: isBrave || this._netErrors > 1,
          message: msg,
        });
      } else {
        bus.emit(EV.STT_ERROR, { error: e.error, fatal: false, message: `Speech recognition error: ${e.error}` });
      }
    };

    r.onend = () => this._handleEnd(r);

    return r;
  }

  /**
   * Recognition ended. Decide whether to restart, and stop a storm.
   *
   * Extracted from the `onend` closure so it is reachable without a live
   * browser recogniser — `decideRestart()` below is the pure part, unit-tested
   * in tests/test-voice-loop.mjs.
   *
   * @param {any} r the recogniser to restart
   */
  _handleEnd(r) {
    this.listening = false;
    state.set({ sttActive: false });
    bus.emit(EV.STT_END, { mode: this.mode });
    if (!this.wantListening) return;
    clearTimeout(this._restartTimer);

    const d = this.decideRestart(Date.now());
    if (d.giveUp) {
      this.wantListening = false;
      this._rapidEnds = 0;
      state.set({ micOn: false, sttActive: false });
      const isBrave = this.isBrave;
      const msg = isBrave
        ? 'Brave browser blocked Speech Recognition. To fix: open brave://settings/privacy and enable "Use Google speech services for speech recognition", or use text input.'
        : 'The microphone kept dropping immediately, so listening was '
        + 'stopped instead of retrying forever. Usually this means no mic '
        + 'is connected, another app has it, or the browser has not been '
        + 'granted access. Fix that and press the mic again.';
      bus.emit(EV.STT_ERROR, {
        error: 'restart-loop', fatal: true,
        message: msg,
      });
      return;
    }
    this._restartTimer = setTimeout(() => {
      // Never re-open the mic while AURA is talking — that is what made it
      // transcribe its own TTS and reply to itself in a loop.
      if (!this.wantListening) return;
      if (state.get('ttsSpeaking')) {
        this._restartTimer = setTimeout(() => this._resume(r), 400);
        return;
      }
      try { r.start(); } catch {}
    }, d.delay);
  }

  /**
   * RESTART-STORM GUARD — pure decision, no timers, no DOM.
   *
   * BUG #106. The previous guard DEFEATED ITSELF, and the user hit it on first
   * login: "the mic keeps on infinitly turning on and off". It counted a
   * "rapid" end as a gap < 900ms between ends — but its own backoff grew that
   * gap to 260, 660, 1060ms, and 1060 > 900, so the counter RESET on the third
   * retry. It oscillated 0→1→2→0→1→2 forever and never reached its limit of 6.
   *
   * Two independent fixes, because either alone still leaves a hole:
   *   1. Judge an attempt by how long recognition actually RAN (onstart →
   *      onend), not by the gap between ends. A session that produced nothing
   *      and died in <700ms is a failure however long we waited to start it.
   *   2. Count consecutive failures. Only a session that really listened —
   *      produced a result, or survived 700ms — resets the streak.
   *
   * @param {number} now
   * @returns {{giveUp:boolean, delay:number, ranFor:number, streak:number}}
   */
  decideRestart(now = Date.now()) {
    const ranFor = this._startedAt ? now - this._startedAt : 0;
    const productive = this._sawResultThisSession || ranFor >= SpeechInput.MIN_HEALTHY_MS;
    this._rapidEnds = productive ? 0 : (this._rapidEnds || 0) + 1;
    this._lastEndAt = now;
    this._startedAt = 0;
    this._sawResultThisSession = false;

    if (this._rapidEnds >= SpeechInput.MAX_FAILED_RESTARTS) {
      return { giveUp: true, delay: 0, ranFor, streak: this._rapidEnds };
    }
    // Cap the backoff: past ~2s the user just thinks it is broken, and the
    // failure COUNT (not the delay) is what ends the loop now.
    return {
      giveUp: false,
      delay: Math.min(260 + this._rapidEnds * 400, 2000),
      ranFor, streak: this._rapidEnds,
    };
  }

  /**
   * HALF-DUPLEX CONTROL.
   *
   * mute() is called synchronously from the TTS start handler. It sets a flag
   * *before* stopping recognition, which matters because SpeechRecognition
   * .stop() is asynchronous: Chrome still fires onresult for audio it had
   * already buffered. Without the flag those late results slipped through and
   * AURA answered its own greeting.
   */
  mute(reason = 'tts') {
    this.muted = true;
    this._muteReason = reason;
    if (this.listening && this.recognition) {
      this._resumeAfterSpeech = this.wantListening;
      try { this.recognition.abort(); } catch {}   // abort > stop: discards buffer
    }
  }

  /**
   * Reopen the mic after speech. `delayMs` covers the acoustic tail — audio
   * that has left the synthesiser but is still coming out of the speakers.
   */
  unmute(delayMs = 900) {
    clearTimeout(this._unmuteTimer);
    this._unmuteTimer = setTimeout(() => {
      this.muted = false;
      this._muteReason = null;
      if (this._resumeAfterSpeech && this.wantListening && !this.listening) {
        this._resumeAfterSpeech = false;
        this._resume(this.recognition);
      }
    }, delayMs);
  }

  /** Resume a paused recogniser once TTS has finished speaking. */
  _resume(r) {
    if (!this.wantListening) return;
    if (this.muted || state.get('ttsSpeaking')) {
      this._restartTimer = setTimeout(() => this._resume(r), 400);
      return;
    }
    try { r.start(); } catch {}
  }

  /**
   * Multi-Wake-Word Parser & Matcher
   * Supports multiple wake words simultaneously (e.g. "aura, hey aura, nova, hey nova, jarvis, computer").
   * Evaluates both exact matches, word-boundary regexes, prefix commands, and phonetic fuzzy similarity.
   */
  _getWakePhrases() {
    const raw = String(config.get('wakeWord') || 'aura, nova').toLowerCase();
    const userPhrases = raw
      .split(/[,;|]+/)
      .map(s => s.trim().replace(/[^a-z0-9 ]/g, ''))
      .filter(Boolean);

    // Standard built-in default aliases that always work out of the box
    const defaults = [
      'aura', 'hey aura', 'ok aura', 'hi aura', 'yo aura',
      'nova', 'hey nova', 'ok nova', 'hi nova', 'yo nova',
      'jarvis', 'hey jarvis',
      'computer',
      'assistant'
    ];

    // Combine unique phrases, sorted longest first so multi-word phrases match before single-word
    const all = Array.from(new Set([...userPhrases, ...defaults]))
      .filter(s => s.length >= 2)
      .sort((a, b) => b.length - a.length);

    return all;
  }

  _checkWakeWord(rawText, isInterim = false) {
    if (!rawText) return false;
    const now = Date.now();
    // Cooldown prevents multiple triggers on the same utterance stream
    if (this._lastWakeTrigger && (now - this._lastWakeTrigger < 2200)) {
      return false;
    }

    // Normalise text: lowercase, remove punctuation
    const text = String(rawText).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return false;

    const phrases = this._getWakePhrases();

    // 1. Direct phrase / word-boundary matching (longest phrases first)
    for (const phrase of phrases) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match phrase as a whole word / boundary
      const regex = new RegExp(`(^|\\s)${escaped}(\\s|$|[?!.,])`, 'i');
      const match = text.match(regex);

      if (match) {
        // Extract whatever user said after the wake phrase as the command
        const idx = text.indexOf(phrase);
        let after = '';
        if (idx !== -1) {
          after = text.slice(idx + phrase.length).trim();
          // Remove leading filler words like "can you", "please", ","
          after = after.replace(/^(can you|could you|please|tell me|hey|yo)\s+/i, '').trim();
        }

        this._lastWakeTrigger = now;
        this._lastSuppressed = text;
        bus.emit(EV.WAKE_WORD, {
          text: rawText,
          command: after,
          matched: phrase,
          isInterim,
          source: 'native-multi'
        });
        return true;
      }
    }

    // 2. Common acoustic/phonetic misrecognitions for core wake words
    const PHONETIC_ALIASES = {
      aura: ['ora', 'ahra', 'awra', 'aurora', 'aroma', 'hora', 'laura', 'our a'],
      nova: ['nora', 'noah', 'novah', 'noda', 'novak', 'dora'],
      jarvis: ['service', 'harvest', 'travis', 'tarvis']
    };

    const words = text.split(/\s+/).filter(w => w.length >= 3);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];

      // Check alias dictionaries
      for (const [target, aliases] of Object.entries(PHONETIC_ALIASES)) {
        if (aliases.includes(w) || phoneticSimilarity(w, target) >= 0.76) {
          const afterWords = words.slice(i + 1).join(' ').trim();
          this._lastWakeTrigger = now;
          this._lastSuppressed = text;
          bus.emit(EV.WAKE_WORD, {
            text: rawText,
            command: afterWords,
            matched: target,
            fuzzy: true,
            isInterim,
            source: 'native-multi'
          });
          return true;
        }
      }
    }

    return false;
  }

  /** @param {'command'|'wake'} mode */
  async start(mode = 'command') {
    if (!this.supported) {
      bus.emit(EV.STT_ERROR, { error: 'unsupported', fatal: true, message: this.unsupportedReason });
      return false;
    }
    // Ask for the mic explicitly — otherwise Chrome can fail silently.
    if (state.get('micPermission') !== 'granted') {
      const okPerm = await this.ensurePermission();
      if (!okPerm) return false;
    }
    this.mode = mode;
    this.wantListening = true;
    if (this.recognition) { try { this.recognition.abort(); } catch {} }
    this.recognition = this._create();
    try {
      this.recognition.start();
      return true;
    } catch (e) {
      // "already started" is benign
      if (!/already/i.test(e.message)) {
        bus.emit(EV.STT_ERROR, { error: 'start-failed', fatal: false, message: e.message });
        return false;
      }
      return true;
    }
  }

  stop() {
    this.wantListening = false;
    clearTimeout(this._restartTimer);
    if (this.recognition) { try { this.recognition.stop(); } catch {} }
    this.listening = false;
    state.set({ sttActive: false });
  }

  /** @param {'command'|'wake'} [mode] */
  async toggle(mode = 'command') {
    if (this.wantListening) { this.stop(); return false; }
    return this.start(mode);
  }
}

/* ───────────────────────── Speech Synthesis ─────────────────────────── */

export class SpeechOutput {
  constructor() {
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.synth = this.supported ? window.speechSynthesis : null;
    this.voices = [];
    this.current = null;
    this.speaking = false;
    this._visemeTimer = null;
    this._queue = [];
    state.set({ ttsSupported: this.supported });
    if (this.supported) {
      this._loadVoices();
      this.synth.onvoiceschanged = () => this._loadVoices();
      // Chrome bug workaround: long utterances get cut off ~15s unless resumed
      this._keepAlive = setInterval(() => {
        if (this.speaking && this.synth.paused) this.synth.resume();
      }, 9000);
    }
  }

  _loadVoices() {
    this.voices = this.synth.getVoices() || [];
    bus.emit('voice:voices-loaded', { count: this.voices.length });
  }

  listVoices() { return this.voices.map(v => ({ name: v.name, lang: v.lang, default: v.default, local: v.localService })); }

  /** Pick the most "AI assistant"-sounding voice available. */
  pickVoice() {
    const want = config.get('ttsVoice');
    if (want) {
      const exact = this.voices.find(v => v.name === want);
      if (exact) return exact;
    }
    const lang = (config.get('sttLang') || 'en-US').split('-')[0];
    const pool = this.voices.filter(v => v.lang.toLowerCase().startsWith(lang));
    const preferred = [
      /Google UK English Female/i, /Google US English/i, /Microsoft Aria/i, /Microsoft Zira/i,
      /Microsoft Sonia/i, /Samantha/i, /Karen/i, /Serena/i, /Moira/i, /female/i,
    ];
    for (const rx of preferred) {
      const hit = pool.find(v => rx.test(v.name));
      if (hit) return hit;
    }
    return pool[0] || this.voices[0] || null;
  }

  /**
   * Speak text. Strips markdown so the voice doesn't read asterisks.
   * Emits timed viseme events for the avatar.
   * @returns {Promise<void>} resolves when finished or interrupted
   */
  speak(text, { interrupt = true, emotion = 'neutral' } = {}) {
    if (!this.supported || !config.get('ttsEnabled')) return Promise.resolve();
    const clean = stripMarkdownForSpeech(text);
    if (!clean.trim()) return Promise.resolve();

    if (interrupt) this.cancel('interrupt');

    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(clean);
      const voice = this.pickVoice();
      if (voice) u.voice = voice;
      u.rate = clampNum(config.get('ttsRate'), 0.5, 2, 1.03);
      u.pitch = clampNum(config.get('ttsPitch'), 0, 2, 0.95);
      u.volume = clampNum(config.get('ttsVolume'), 0, 1, 1);
      if (emotion === 'excited') { u.rate *= 1.08; u.pitch *= 1.06; }
      if (emotion === 'sad') { u.rate *= 0.92; u.pitch *= 0.94; }

      const words = clean.split(/\s+/).filter(Boolean);
      let wordIndex = 0;
      const startTime = () => performance.now();
      let t0 = 0;

      u.onstart = () => {
        this.speaking = true;
        this.current = u;
        state.set({ ttsSpeaking: true });
        t0 = startTime();
        bus.emit(EV.TTS_START, { text: clean, emotion, words: words.length });
        // Drive visemes from an estimated schedule; `boundary` re-syncs it.
        this._scheduleVisemes(words, u.rate, () => wordIndex);
      };

      u.onboundary = (ev) => {
        if (ev.name === 'word' || ev.charIndex != null) {
          // Recompute which word we're on from charIndex — real timing data.
          const upto = clean.slice(0, ev.charIndex);
          wordIndex = upto.split(/\s+/).filter(Boolean).length;
          const w = words[wordIndex] || '';
          const dur = estimateWordDuration(w, u.rate);
          const vs = wordToVisemes(w, dur);
          bus.emit(EV.TTS_VISEME, { visemes: vs, word: w, index: wordIndex, total: words.length, resync: true });
        }
      };

      const finish = (interrupted) => {
        this._clearVisemes();
        this.speaking = false;
        this.current = null;
        state.set({ ttsSpeaking: false });
        bus.emit(EV.TTS_VISEME, { visemes: [{ viseme: 'sil', t: 0, dur: 120, open: 0 }], word: '', index: -1 });
        bus.emit(EV.TTS_END, { interrupted });
        resolve();
      };

      u.onend = () => finish(false);
      u.onerror = (e) => {
        if (e.error !== 'interrupted' && e.error !== 'canceled') {
          console.warn('[tts] error', e.error);
        }
        finish(true);
      };

      // Chrome sometimes needs a tick after cancel() before speak()
      setTimeout(() => {
        try { this.synth.speak(u); }
        catch (err) { console.error('[tts] speak failed', err); finish(true); }
      }, interrupt ? 60 : 0);
    });
  }

  /**
   * Estimated viseme schedule. `boundary` events override it when the
   * browser provides them (Chrome/Edge do; Safari is spotty).
   */
  _scheduleVisemes(words, rate, getIndex) {
    this._clearVisemes();
    let i = 0;
    const tick = () => {
      if (!this.speaking) return;
      const w = words[i];
      if (w === undefined) { this._clearVisemes(); return; }
      const dur = estimateWordDuration(w, rate);
      bus.emit(EV.TTS_VISEME, { visemes: wordToVisemes(w, dur), word: w, index: i, total: words.length });
      i++;
      this._visemeTimer = setTimeout(tick, dur);
    };
    tick();
  }

  _clearVisemes() {
    if (this._visemeTimer) { clearTimeout(this._visemeTimer); this._visemeTimer = null; }
  }

  /** Hard interrupt — this is what the "Interrupt" button and open-palm use. */
  cancel(reason = 'user') {
    if (!this.supported) return false;
    const wasSpeaking = this.speaking || this.synth.speaking;
    this._clearVisemes();
    try { this.synth.cancel(); } catch {}
    this.speaking = false;
    this.current = null;
    state.set({ ttsSpeaking: false });
    if (wasSpeaking) {
      bus.emit(EV.TTS_INTERRUPT, { reason });
      bus.emit(EV.TTS_VISEME, { visemes: [{ viseme: 'sil', t: 0, dur: 100, open: 0 }], word: '', index: -1 });
    }
    return wasSpeaking;
  }

  pause() { if (this.supported && this.synth.speaking) this.synth.pause(); }
  resume() { if (this.supported && this.synth.paused) this.synth.resume(); }
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** Remove markdown so TTS reads prose, not syntax. Exported for tests. */
export function stripMarkdownForSpeech(md) {
  return String(md)
    .replace(/```[\s\S]*?```/g, ' … code block … ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1$2')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^[-–—=]{3,}$/gm, '')
    .replace(/\u2014/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export default { SpeechInput, SpeechOutput, wordToVisemes, stripMarkdownForSpeech, VISEMES };
