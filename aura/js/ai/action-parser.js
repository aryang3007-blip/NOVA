/**
 * AURA :: Structured Action Extraction
 * ------------------------------------
 * Lets the AI answer in two modes:
 *
 *   CONVERSATION →  plain prose, streamed as normal
 *   ACTION       →  a structured request the Action Manager validates
 *
 * Two independent extraction paths, deliberately:
 *
 *   1. `extractActions(text)` — pulls ```action fenced JSON out of an LLM
 *      reply. Model-driven, works with any provider, no function-calling API
 *      required (so it works with Ollama, Groq, everything).
 *
 *   2. `intentToAction(text)` — deterministic local mapping for common
 *      phrasings. Runs BEFORE the model, so "open whatsapp" is instant and
 *      free rather than a round-trip.
 *
 * Both emit the same shape: { action, target?, params? }
 */

/** Instruction appended to the system prompt when desktop actions exist. */
export function actionProtocolPrompt(capabilityList) {
  return [
    'DESKTOP ACTION PROTOCOL',
    'You may control this computer, but ONLY by emitting a structured action block.',
    'You must never output shell commands, PowerShell, file paths, or code intended to be executed.',
    '',
    'When the user asks you to DO something on their machine, reply with a short',
    'sentence and then exactly one action block:',
    '',
    '```action',
    '{"action": "launch_app", "target": "WhatsApp"}',
    '```',
    '',
    'For anything conversational, just answer normally with no action block.',
    '',
    capabilityList,
    '',
    'Rules:',
    '- One action block per reply.',
    '- Use only the action ids listed above; never invent one.',
    '- If an action is marked [PERMISSION NOT GRANTED], do NOT emit it. Instead tell',
    '  the user which permission to enable in Settings → Desktop → Permissions.',
    '- If you are unsure whether the user wants an action, ask first.',
  ].join('\n');
}

const FENCE = /```(?:action|json:action)\s*\n([\s\S]*?)```/gi;

/**
 * Pull structured actions out of an LLM reply.
 * @param {string} text
 * @returns {{actions:Array<object>, cleanText:string, hadAction:boolean}}
 */
export function extractActions(text) {
  const src = String(text || '');
  const actions = [];
  let cleanText = src;

  FENCE.lastIndex = 0;
  let m;
  while ((m = FENCE.exec(src)) !== null) {
    const raw = m[1].trim();
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const a of list) {
        if (a && typeof a.action === 'string') {
          actions.push({
            action: a.action.trim(),
            target: typeof a.target === 'string' ? a.target.trim() : undefined,
            params: (a.params && typeof a.params === 'object') ? a.params : undefined,
          });
        }
      }
    } catch {
      // Malformed JSON: ignore the block rather than guessing. The prose
      // still reaches the user.
    }
  }

  if (actions.length) cleanText = src.replace(FENCE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { actions, cleanText, hadAction: actions.length > 0 };
}

/**
 * Deterministic phrase → action mapping. Conservative on purpose: only fires
 * on clear imperatives so ordinary conversation is never hijacked.
 *
 * @param {string} text
 * @returns {{action:string, target?:string, params?:object}|null}
 */
export function intentToAction(text) {
  const t = String(text || '').trim();
  // Strip explicit device clauses ("on my phone", "on the computer") so app target is pure
  const tClean = t.replace(/\b(?:on|to|for|with)\s+(?:my\s+|the\s+)?(?:phone|mobile|android|iphone|computer|pc|laptop|desktop|windows)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  const low = tClean.toLowerCase();
  if (!low) return null;

  // Never capture questions about capability ("can you open X?") — those are
  // conversational, and the model should explain rather than act.
  if (/^(can|could|will|would|do|does|are|is|should)\b/i.test(low) && /\?$/.test(tClean)) return null;

  // ── close (check BEFORE launch: "close whatsapp" contains no launch verb,
  //    but "quit" / "exit" overlap with other phrasing)
  const close = /\b(?:close|quit|exit|kill|terminate|shut down)\s+(?:the\s+|my\s+)?([a-z0-9 .+-]{2,40}?)(?:\s+app|\s+application|\s+window)?$/i
    .exec(tClean.replace(/[?!.]+$/, ''));
  if (close && !/\b(computer|pc|laptop|system|machine)\b/i.test(close[1])) {
    return { action: 'close_app', target: close[1].trim() };
  }

  // ── power (must beat close_app for "shut down the computer")
  const power = /\b(lock|sleep|restart|reboot|shut ?down|log ?off|sign out)\b.*\b(computer|pc|laptop|system|machine|windows)\b/i.exec(low)
    || /\b(lock|sleep)\s+(the\s+)?(screen|computer|pc)\b/i.exec(low);
  if (power) {
    const verb = power[1].toLowerCase().replace(/\s/g, '');
    const map = { lock: 'lock', sleep: 'sleep', restart: 'restart', reboot: 'restart',
                  shutdown: 'shutdown', logoff: 'logoff', signout: 'logoff' };
    return { action: 'power_control', target: map[verb] || 'lock' };
  }

  // ── launch
  const launch = /\b(?:open|launch|start|run|fire up|bring up)\s+(?:the\s+|my\s+|an?\s+)?([a-z0-9 .+-]{2,40}?)(?:\s+app|\s+application)?$/i
    .exec(t.replace(/[?!.]+$/, ''));
  if (launch) {
    const target = launch[1].trim();
    // Ignore AURA's own UI nouns — those are handled by the UI layer.
    if (/^(camera|webcam|vision|chat|settings|panel|wardrobe|ar mode|the app|aura)$/i.test(target)) return null;
    // Looks like a domain → treat as a URL.
    if (/^[\w-]+(\.[\w-]+)+$/.test(target)) return { action: 'open_url', target };
    return { action: 'launch_app', target };
  }

  // ── media
  if (/^(play|resume)( the)?( music| song| track| it)?$/i.test(low)) return { action: 'media_control', target: 'playpause' };
  if (/^(pause|stop)( the)?( music| song| track| playback| it)?$/i.test(low)) return { action: 'media_control', target: 'playpause' };
  if (/\b(next|skip)( the)?( song| track)\b/i.test(low) && low.length < 26) return { action: 'media_control', target: 'next' };
  if (/\b(previous|last)( the)?( song| track)\b/i.test(low)) return { action: 'media_control', target: 'previous' };

  // ── volume
  const vol = /\b(?:set |turn )?volume (?:to |at )?(\d{1,3})\s*%?/i.exec(low);
  if (vol) return { action: 'set_volume', target: String(Math.min(100, parseInt(vol[1], 10))) };
  if (/\b(volume up|louder|turn it up)\b/i.test(low)) return { action: 'set_volume', target: 'up' };
  if (/\b(volume down|quieter|turn it down)\b/i.test(low)) return { action: 'set_volume', target: 'down' };
  if (/\b(mute|unmute)\b/i.test(low) && !/\byour|voice|speech|yourself\b/i.test(low)) {
    return { action: 'set_volume', target: 'mute' };
  }

  // ── screenshot
  if (/\b(take|grab|capture)\s+(a|the)?\s*screen ?(shot|capture)\b/i.test(low) || /^screenshot$/i.test(low)) {
    return { action: 'screenshot' };
  }

  // ── clipboard
  if (/\b(copy (this|that|it) to (the )?clipboard)\b/i.test(low)) return null; // needs content; let the model decide
  if (/\b(what'?s (in|on) (my |the )?clipboard|read (my |the )?clipboard)\b/i.test(low)) {
    return { action: 'clipboard_read' };
  }

  // ── app search
  const search = /\b(?:what apps|which apps|list (?:my )?apps|show (?:me )?(?:my )?apps)\b/i.exec(low);
  if (search) return { action: 'list_apps' };

  return null;
}

/**
 * Render an action result into a line worth speaking aloud.
 * Keeps voice output short even when the panel shows detail.
 */
export function describeResult(request, result) {
  if (result.needsConfirmation) return result.message;
  if (!result.ok) {
    if (result.code === 'no_permission') {
      return `I need the "${result.permissionLabel}" permission for that. You can enable it in Settings, under Desktop.`;
    }
    return result.message;
  }
  const t = request.target ? ` ${request.target}` : '';
  const sim = result.simulated ? ' This was simulated, since no desktop host is running.' : '';
  switch (request.action) {
    case 'launch_app':    return `Opening${t}.${sim}`;
    case 'close_app':     return `Closing${t}.${sim}`;
    case 'open_url':      return `Opening${t}.${sim}`;
    case 'media_control': return `Done.${sim}`;
    case 'set_volume':    return `Volume set.${sim}`;
    case 'screenshot':    return `Screenshot captured.${sim}`;
    default:              return result.message;
  }
}

export default { extractActions, intentToAction, actionProtocolPrompt, describeResult };
