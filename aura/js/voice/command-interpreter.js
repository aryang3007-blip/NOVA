/**
 * AURA :: Voice Command Interpreter
 * =================================
 * Maps natural speech onto the SAME canonical slash commands the user could
 * type. This is what makes "wake word → message → it does what I say" work
 * even on the offline core: no model call, no round trip, one source of
 * truth (`plugins.run('/timer 300 …')` is identical to typing it).
 *
 * RULES (the reason it can ship):
 *   • CONSERVATIVE — only high-precision patterns match. Questions that are
 *     not code answers ("what is my name", "explain recursion", greetings)
 *     return null and go to the AI as conversation.
 *   • DEVICE-GUARDED — anything mentioning phone/mobile/device is left to
 *     js/ai/device-router.js (`open youtube on my phone` → /devices open).
 *     The interpreter never calls those phrases its own.
 *   • PURE — no imports, no DOM, no config. Fully unit-testable headless.
 *
 * @module voice/command-interpreter
 */

/** Words that mean "back off, this is a device command". */
const DEVICE_WORDS = /\b(phone|mobile|device|android|iphone|cell|handset)\b/i;

/**
 * Detect a request to OPEN AURA Live itself (`/screen`), optionally with a
 * follow-up prompt ("open the live screen and find the Save button").
 * Navigation is a page-level act, not a slash command, so it gets its own
 * tiny parser (still pure + deterministic; main.js does the redirect).
 * @param {string} text
 * @returns {{prompt?: string} | null}
 */
export function parseLiveNav(text) {
  const raw = String(text || '').replace(/[.!?]+$/, '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  // Device phrases never navigate — device-router owns them.
  if (DEVICE_WORDS.test(t)) return null;
  // Match on the ORIGINAL text so the carried prompt keeps its casing.
  const m = /^(?:open|go to|take me to|show me|launch)\s+(?:the\s+)?(?:aura\s+)?live(?:\s+(?:screen|view|page|panel))?(?:\s+(?:for|to|and)\s+(.+))?$/i.exec(raw);
  if (!m) return null;
  const prompt = (m[1] || '').trim();
  return prompt ? { prompt } : {};
}

/**
 * Interpret a natural-language utterance as a slash command.
 * @param {string} text
 * @returns {string|null} a slash command (`/timer 300 tea`) or null
 */
export function interpretSpokenCommand(text) {
  const raw = String(text || '').replace(/[.!?]+$/, '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  // ── guards ──────────────────────────────────────────────────────────
  if (DEVICE_WORDS.test(t)) return null;          // device-router owns it
  if (/^(hey|ok|hi|yo|please)\s+(aura|nova|jarvis|computer)\b/.test(t)) {
    return null;                                   // stray wake word, no command
  }

  // ── help ────────────────────────────────────────────────────────────
  if (/^(help|\?|commands|list commands|what can you do)\b/.test(t)
      || t === 'help me') return '/help';

  // ── time / date ─────────────────────────────────────────────────────
  if (/\b(what time is it|current time|what's? the time|time now)\b/.test(t)
      || /\b(what day is it|what's? the date|todays? date|current date)\b/.test(t)
      || t === 'time' || t === 'date') return '/time';

  // ── timer (duration + optional label) ───────────────────────────────
  {
    const timerWord = /\b(timer|countdown|remind me|set (?:a |an )?timer|alert me)\b/.test(t);
    const dur = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(t);
    if (timerWord && dur) {
      const n = parseFloat(dur[1]);
      const unit = dur[2].toLowerCase();
      const secs = Math.round(n * (/^s/.test(unit) ? 1 : /^m/.test(unit) ? 60 : 3600));
      if (secs >= 1 && secs <= 86400) {
        // Label = the utterance with the timing words stripped away.
        let label = raw
          .replace(/^(please\s+|hey\s+|ok\s+)?(i want you to\s+)?/i, '')
          .replace(/\b(set|start|arm|begin)\s+(a|an|the)?\s*/gi, '')
          .replace(/\b(remind me|alert me|timer|countdown|reminder)\b/gi, '')
          .replace(/\b(?:for|in)\s+\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/gi, '')
          .replace(/\b\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/gi, '')
          .replace(/^\s*(to|so (?:that|i)|that i|and)\s+/i, '')
          .replace(/\s+/g, ' ').trim();
        if (!label || label.toLowerCase() === raw.toLowerCase()) label = 'Timer';
        return `/timer ${secs} ${label}`.trim();
      }
    }
  }

  // ── theme ───────────────────────────────────────────────────────────
  {
    const THEME_NAMES = {
      blue: 'blue', default: 'blue', cyan: 'blue',
      amber: 'amber', orange: 'amber', gold: 'amber', yellow: 'amber',
      crimson: 'crimson', red: 'crimson', rose: 'crimson',
      emerald: 'emerald', green: 'emerald', teal: 'emerald',
      violet: 'violet', purple: 'violet', indigo: 'violet', pink: 'violet',
    };
    if (/\b(theme|colour|color)\b/.test(t)) {
      const m = /\b(theme|colour|color)\s+(?:to\s+)?([a-z]+)\b/.exec(t)
             || /\b(?:change|switch|set)\s+(?:the\s+)?(?:theme\s+)?(?:to\s+)?(blue|amber|crimson|emerald|violet|purple|green|red|cyan|orange|pink|teal|gold|yellow|indigo|default)\b/.exec(t);
      if (m) {
        const name = THEME_NAMES[m[2] || m[1]];
        if (name) return `/theme ${name}`;
      }
      return '/theme';
    }
  }

  // ── camera (desktop webcam; phone camera is device-router's job) ─────
  if (/\b(?:turn on|enable|start|open)\s+(?:the\s+)?camera\b/.test(t)
      || t === 'camera on' || t === 'start camera') return '/camera on';
  if (/\b(?:turn off|disable|stop|close)\s+(?:the\s+)?camera\b/.test(t)
      || t === 'camera off' || t === 'stop camera') return '/camera off';

  // ── voice output ────────────────────────────────────────────────────
  if (/\b(mute yourself|mute your voice|stop talking|go silent)\b/.test(t)
      || t === 'mute yourself') return '/mute';
  if (/\b(unmute|speak again|talk again|start talking)\b/.test(t)
      || t === 'unmute') return '/unmute';
  if (t === 'listen' || t === 'start listening' || t === 'ok listen') return '/listen';

  // ── wake word toggle ────────────────────────────────────────────────
  if (/\bwake words?\b/.test(t) && /\b(?:off|disable|stop)\b/.test(t)) return '/wake off';
  if (/\bwake words?\b/.test(t) && /\b(?:on|enable|start)\b/.test(t)) return '/wake on';

  // ── memory / chat housekeeping ──────────────────────────────────────
  if (/\b(clear|wipe|reset)\s+(?:the\s+)?(?:chat|conversation|memory)\b/.test(t)
      || /\b(forget this conversation)\b/.test(t)) return '/clear';
  if (/\b(what do you remember|show (?:my )?memory|memory status)\b/.test(t)
      || t === 'memory') return '/memory';
  if (/\b(export|download)\s+(?:the\s+)?(?:conversation|chat|transcript)\b/.test(t)
      || t === 'export chat') return '/export';

  // ── diagnostics ─────────────────────────────────────────────────────
  if (/\b(self[- ]?test|run diagnostics|system check|check the system)\b/.test(t)
      || t === 'selftest') return '/selftest';
  if (t === 'status' || /\b(system status|full status|run status)\b/.test(t)) return '/status';

  // ── search / live data ──────────────────────────────────────────────
  {
    const m = /\b(?:search(?: for)?|google|look up|lookup|find out about)\s+(.+)$/i.exec(t);
    if (m) return `/search ${m[1].trim()}`;
  }
  {
    const m = /\bweather\b(?:\s+(?:in|for)\s+(.+))?$/i.exec(raw);
    if (m) return `/weather ${(m[1] || '').trim()}`.trim();
  }
  if (/\btech news\b/.test(t)) return '/news tech';
  if (/\b(?:show me|what's|whats|get|read)\s+the\s+news\b/.test(t) || t === 'news' || t === 'news now') return '/news';

  // ── media ───────────────────────────────────────────────────────────
  if (/\b(play|pause|resume)\s+(?:the\s+)?music\b/.test(t)) return '/media play';
  if (/\b(next song|next track|skip)\b/.test(t)) return '/media next';
  if (/\b(previous song|previous track|back a song)\b/.test(t)) return '/media prev';
  if (/\bpause the (?:music|song|video)\b/.test(t)) return '/media pause';

  // ── volume ──────────────────────────────────────────────────────────
  {
    const m = /\bvolume\s+(?:to\s+)?(up|down|mute|max|\d{1,3})\b/i.exec(t);
    if (m) {
      const v = m[1].toLowerCase();
      if (v === 'max') return '/volume 100';
      if (/^\d+$/.test(v)) return `/volume ${Math.min(100, parseInt(v, 10))}`;
      return `/volume ${v}`;
    }
    const m2 = /\b(?:set|turn|put|change)\s+(?:the\s+)?volume\s+(?:to\s+)?(\d{1,3})\b/i.exec(t);
    if (m2) return `/volume ${Math.min(100, parseInt(m2[1], 10))}`;
  }

  // ── screenshot / capture ────────────────────────────────────────────
  if (/\b(take\s+)?(a\s+)?screenshot\b/.test(t) || t === 'capture the screen') return '/screen';

  // ── apps ────────────────────────────────────────────────────────────
  if (/\b(list|show|what)\b.*\b(apps|applications)\b/.test(t) || t === 'apps') return '/apps';

  // ── demo deck ───────────────────────────────────────────────────────
  if (/\b(demo deck|showcase deck|run the demo|make the demo|create the demo)\b/.test(t)
      || t === 'demo') return '/demo';

  // ── say ─────────────────────────────────────────────────────────────
  {
    const m = /^(?:say|speak|read out loud|read aloud)\s+(.+)$/i.exec(t);
    if (m) return `/say ${m[1].trim()}`;
  }

  // ── open an app / URL (desktop — device words already guarded) ──────
  {
    const m = /^(?:open|launch|start)\s+(?:the\s+|an?\s+)?(.+)$/i.exec(t);
    if (m) {
      const target = m[1].trim();
      // Never hijack: asking about something ≠ opening it.
      if (/^(what|why|how|tell|explain)\b/.test(target)) return null;
      return `/open ${target}`;
    }
  }

  // ── screen actions ──────────────────────────────────────────────────
  {
    const m = /^(?:do|execute|run)\s+(?:this\s+)?(.+)$/i.exec(t);
    if (m) return `/do ${m[1].trim()}`;
  }

  return null;
}

/* ─────────────────────────────────────────────────────────────────────
 * /screen (AURA Live) prompt classifier
 *
 * Says what a prompt should DO on the live page, automatically:
 *   • questions about the screen  → ASK view (vision answer)
 *   • "find X" / "locate X"       → FIND view (grid + reticle)
 *   • share / stop                → LIVE view buttons
 *   • action requests             → ACT view, **agent loop by default** —
 *                                   the prompt is given straight to TaskAgent
 *                                   (arm + per-step confirm still required)
 * Returned shape: {kind, query?, mode?, action?}
 * ──────────────────────────────────────────────────────────────────── */
const VOICE_VERBS = /\b(?:open|launch|start|close|save|click|type|press|scroll|send|message|create|make|build|minimi[sz]e|switch|cancel|delete|rename|copy|paste|select|drag|double[ -]?click|right[ -]?click|go (?:to|back)|refresh|maximi[sz]e)\b/i;
const QUESTION_STARTERS = /^(?:what|why|how|who|where|when|which|is|are|am|does|do you|can you see|should i|explain|summari[sz]e|describe|tell me about|what'?s|whats)\b/i;

/**
 * @param {string} text
 * @returns {{kind:string, query?:string, mode?:string, action?:string} | null}
 */
export function classifyLivePrompt(text) {
  const raw = String(text || '').replace(/[.!?]+$/, '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  // Explicit slash commands are routed by the existing omni map.
  if (t.startsWith('/')) return { kind: 'command', query: raw };

  // Device phrases (phone/device...) belong to the main app's device-router,
  // never to desktop automation. Return null → the caller's default (ASK).
  if (DEVICE_WORDS.test(t)) return null;

  // Share / stop — the two most spoken things on this page.
  if (/\b(?:share|start sharing|begin sharing)\b/.test(t)) return { kind: 'live', action: 'start' };
  if (/\b(?:stop sharing|stop the share|end the share)\b/.test(t)) return { kind: 'live', action: 'stop' };

  // Arm / disarm automation by voice.
  if (/\b(?:arm|enable)\s+(?:the\s+)?automation\b/.test(t)) return { kind: 'command', query: '/automation arm' };
  if (/\b(?:disarm|disable)\s+(?:the\s+)?automation\b/.test(t)) return { kind: 'command', query: '/automation disarm' };

  // Find / locate a UI element (matched on the ORIGINAL casing).
  {
    const m = /\b(?:find|locate|look for|where'?s|where is)\s+(?:the\s+)?(.+)$/i.exec(raw);
    if (m) {
      const q = m[1].trim();
      // "where is my phone" is a device command — device-router wins.
      if (DEVICE_WORDS.test(q)) return null;
      return { kind: 'find', query: q };
    }
  }

  // Question about the screen → ASK.
  if (QUESTION_STARTERS.test(t) && /\b(screen|page|window|tab|error|text|button|app|what is this|what am i looking at|i see|shows?)\b/.test(t)) {
    return { kind: 'ask', query: raw };
  }
  if (/\b(?:explain|summari[sz]e|describe|what (?:does|is) this|tell me about)\b/.test(t)) {
    return { kind: 'ask', query: raw };
  }

  // Action request → ACT. The agent LOOP is the default (that's the point:
  // "just do what I say"); one-shot stays available for single verbs.
  if (VOICE_VERBS.test(t)) {
    const single = /\b(?:click|type|press|scroll|double[ -]?click|right[ -]?click)\b/.test(t)
      && !/\b(?:and|then|open .* then|message|create|make)\b/.test(t);
    return { kind: 'act', query: raw, mode: single ? 'do' : 'task' };
  }

  // Everything else goes to ASK (the live page's chat).
  return { kind: 'ask', query: raw };
}

export default { interpretSpokenCommand, classifyLivePrompt, parseLiveNav };
