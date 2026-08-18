/**
 * AURA :: Priority Intent Router
 * ------------------------------
 * The old routing bug ("what is 47*89" → the AK-47 Wikipedia article) was
 * structural: independent matchers each grabbed input, and whichever ran
 * first won. This replaces that with one ordered pipeline where every stage
 * is explicit and testable.
 *
 * PRIORITY ORDER (first match wins):
 *   1. SAFETY        — refuse/deflect before anything else acts
 *   2. SYSTEM        — AURA's own UI controls (stop, clear, theme, camera)
 *   3. TOOL/ACTION   — desktop actions: launch app, volume, screenshot
 *   4. MATH          — arithmetic, unit conversion  ← BEFORE knowledge
 *   5. LOCAL         — time, memory recall, vision, self-description
 *   6. WEB           — weather, news, markets, Wikipedia
 *   7. CONVERSATION  — everything else → the language model
 *
 * Pure functions, no side effects: the router only *decides*. Execution stays
 * in the engine. That makes the whole thing unit-testable in Node.
 *
 * @module ai/intent-router
 */

import { intentToAction } from './action-parser.js';
import { parseLiveIntent } from '../realtime/live-data.js';
import { detectIntent as detectLocalIntent, evaluateMath } from './local-core.js';
import { matchGuide } from './guide.js';

export const PRIORITY = {
  SAFETY: 1, SYSTEM: 2, TOOL: 3, MATH: 4, GUIDE: 5, LOCAL: 6, WEB: 7, CONVERSATION: 8,
};

export const ROUTE = {
  SAFETY: 'safety', SYSTEM: 'system', TOOL: 'tool', MATH: 'math',
  GUIDE: 'guide', LOCAL: 'local', WEB: 'web', CONVERSATION: 'conversation',
};

/**
 * @typedef {Object} RoutingDecision
 * @property {string}  route     one of ROUTE
 * @property {number}  priority
 * @property {string}  reason    why this stage claimed it (for debugging)
 * @property {object} [payload]     stage-specific data
 * @property {number}  confidence
 * @property {object[]} [considered] per-stage trace, used by /why
 */

/**
 * Phrasings that ASK ABOUT a capability rather than invoking it.
 * "how do I enable the camera" must be explained, not executed — otherwise
 * asking a question silently performs an action. Caught in browser testing.
 */
const IS_QUESTION_ABOUT = /^\s*(how (do|can|would) (i|you|we)|how to|what (is|are|does)|why (is|does|can'?t)|where (is|do)|can (i|you) explain|tell me (how|about)|explain)\b/i;

/* ── stage 1: safety ─────────────────────────────────────────────────── */

const DESTRUCTIVE = [
  // "delete/wipe/format ... everything | my files | c: | system32"
  /\b(delete|wipe|erase|format|rm\s+-rf)\b.*\b(everything|all (my )?(files|data)|my (files|drive|disk|data)|c:|system32)\b/i,
  // "format the c: drive" / "format my hard drive" — the optional c:/my
  // between the verb and the noun was previously required to be adjacent.
  /\bformat\b.*\b(drive|disk|hard\s?drive|partition|ssd)\b/i,
  /\b(disable|turn off|switch off)\b.*\b(antivirus|firewall|defender|security|protection)\b/i,
  // destructive registry / boot edits
  /\b(delete|remove|clear)\b.*\b(registry|boot|bios|mbr|partition table)\b/i,
];

/**
 * Safety is a *refusal* stage, not a filter on ordinary words. It only fires
 * on unambiguous destructive instructions so normal conversation is never
 * blocked.
 */
export function checkSafety(text) {
  const t = String(text || '');
  for (const rx of DESTRUCTIVE) {
    if (rx.test(t)) {
      return {
        route: ROUTE.SAFETY, priority: PRIORITY.SAFETY, confidence: 1,
        reason: 'destructive-request',
        payload: {
          refusal: "I won't do that — it could irreversibly destroy data or disable your security. " +
                   'If you genuinely need this, do it yourself through the operating system so the intent is unambiguous.',
        },
      };
    }
  }
  return null;
}

/* ── stage 2: AURA's own UI ──────────────────────────────────────────── */

const SYSTEM_PATTERNS = [
  { rx: /\b(stop|shut ?up|be quiet|silence)\b/i, cmd: 'stop-speaking', guard: /\b(computer|pc|system|machine)\b/i },
  { rx: /\b(clear|reset|wipe)\b.*\b(chat|conversation|memory|history)\b/i, cmd: 'clear-chat' },
  { rx: /\b(change|switch|cycle|set)\b.*\btheme\b/i, cmd: 'theme' },
  { rx: /\b(open|show|start|enable|turn on)\b.*\b(camera|webcam|vision)\b/i, cmd: 'camera-on' },
  { rx: /\b(close|stop|disable|turn off)\b.*\b(camera|webcam|vision)\b/i, cmd: 'camera-off' },
  { rx: /\b(ar mode|augmented reality|enter ar)\b/i, cmd: 'ar' },
  { rx: /\b(system )?(status|diagnostics|self.?test|health check)\b/i, cmd: 'status' },
  { rx: /\b(what can you do|your capabilities|help me|show commands)\b/i, cmd: 'help' },
];

export function checkSystem(text) {
  const t = String(text || '');

  // Questions belong to the GUIDE stage, not the action stage.
  if (IS_QUESTION_ABOUT.test(t)) return null;

  for (const p of SYSTEM_PATTERNS) {
    if (p.rx.test(t)) {
      // A guard prevents e.g. "shut down the computer" (a power action)
      // being mistaken for "stop talking".
      if (p.guard && p.guard.test(t)) continue;
      return {
        route: ROUTE.SYSTEM, priority: PRIORITY.SYSTEM, confidence: 0.9,
        reason: `system:${p.cmd}`, payload: { command: p.cmd },
      };
    }
  }
  return null;
}

/* ── stage 3: tools / desktop actions ────────────────────────────────── */

export function checkTool(text, { desktopReady = false } = {}) {
  if (!desktopReady) return null;
  // "how do I open WhatsApp" is a question about the feature — it must not
  // launch WhatsApp. Same guard as the system stage.
  if (IS_QUESTION_ABOUT.test(String(text || ''))) return null;
  const action = intentToAction(text);
  if (!action) return null;
  return {
    route: ROUTE.TOOL, priority: PRIORITY.TOOL, confidence: 0.88,
    reason: `tool:${action.action}`, payload: { action },
  };
}

/* ── stage 4: math (before knowledge — this is the AK-47 fix) ────────── */

const MATH_STRIP = /\b(what(?:'s| is)|whats|calculate|compute|solve|how much is|equals?|tell me)\b/gi;

/**
 * Claim anything that is genuinely an arithmetic expression.
 * Runs BEFORE web/knowledge so "what is 47*89" can never reach Wikipedia.
 */
export function checkMath(text) {
  const t = String(text || '').trim();
  if (!/\d/.test(t)) return null;

  // Unit conversion first — "10 km to miles" is maths, not a web lookup.
  const conv = /(?:convert\s+)?(-?[\d.,]+)\s*(?:degrees?\s*)?([a-z°/²³0-9]+)\s+(?:to|in|into|as)\s+(?:degrees?\s*)?([a-z°/²³0-9]+)/i.exec(t);
  if (conv) {
    const local = detectLocalIntent(t);
    if (local.intent === 'convert') {
      return { route: ROUTE.MATH, priority: PRIORITY.MATH, confidence: 0.95,
               reason: 'unit-conversion', payload: { kind: 'convert', localIntent: local } };
    }
  }

  const expr = t.replace(MATH_STRIP, '').replace(/[?!]+$/, '').trim();
  if (!expr || !/\d/.test(expr)) return null;

  const hasOperator = /[+\-*/^%]|\bx\b/.test(expr) ||
    /\b(sqrt|sin|cos|tan|log|ln|exp|abs|floor|ceil|round|factorial)\s*\(/i.test(expr) ||
    /\d\s*!/.test(expr) || /\bsquared|cubed|to the power\b/i.test(expr);
  if (!hasOperator) return null;

  // Reject prose that merely contains a number and a hyphen, e.g.
  // "tell me about the F-16" — only claim it if it actually evaluates.
  const wordy = expr.replace(/[\d\s+\-*/^%().,!x]/gi, '');
  if (wordy.length > 12) return null;

  try {
    const value = evaluateMath(expr);
    if (!Number.isFinite(value)) return null;
    return { route: ROUTE.MATH, priority: PRIORITY.MATH, confidence: 0.98,
             reason: 'arithmetic', payload: { kind: 'math', expr, value } };
  } catch {
    return null;   // not evaluable → let a later stage try
  }
}

/* ── stage 5: built-in guide (self-documentation, no model needed) ───── */

/**
 * "How do I use this?" is documentation about AURA itself — deterministic,
 * and it must work with no model connected. Sits above WEB so it never gets
 * answered by a Wikipedia lookup.
 */
export function checkGuide(text, ctx = {}) {
  const hit = matchGuide(text, ctx.guideContext || {});
  if (!hit) return null;
  return {
    route: ROUTE.GUIDE, priority: PRIORITY.GUIDE, confidence: 0.92,
    reason: `guide:${hit.topic}`, payload: { guide: hit },
  };
}

/* ── stage 6: local knowledge & state ────────────────────────────────── */

const LOCAL_INTENTS = new Set([
  'time', 'date', 'weekday', 'memory-recall', 'set-name', 'get-name',
  'vision-describe', 'vision-count', 'status', 'greeting', 'howareyou',
  'thanks', 'bye', 'cmd', 'knowledge', 'code',
]);

export function checkLocal(text) {
  const local = detectLocalIntent(text);
  if (!LOCAL_INTENTS.has(local.intent)) return null;

  // "knowledge" is the offline KB. It's genuinely useful, but a live web
  // lookup is better when available — so give it lower confidence and let
  // the caller prefer WEB if the topic is also web-answerable.
  const soft = local.intent === 'knowledge';
  return {
    route: ROUTE.LOCAL, priority: PRIORITY.LOCAL,
    confidence: soft ? 0.6 : 0.85,
    reason: `local:${local.intent}`,
    payload: { localIntent: local, soft },
  };
}

/* ── stage 6: web / live data ────────────────────────────────────────── */

export function checkWeb(text, { liveDataEnabled = true } = {}) {
  if (!liveDataEnabled) return null;
  const live = parseLiveIntent(text);
  if (!live) return null;
  return {
    route: ROUTE.WEB, priority: PRIORITY.WEB, confidence: 0.8,
    reason: `web:${live.type}`, payload: { liveIntent: live },
  };
}

/* ── the router ──────────────────────────────────────────────────────── */

export class IntentRouter {
  /** @param {{logger?:Function}} opts */
  constructor({ logger = null } = {}) {
    this.log = logger || (() => {});
    /** @type {Array<{name:string, priority:number, fn:Function}>} Ordered pipeline. */
    this.stages = [
      { name: 'safety', priority: PRIORITY.SAFETY, fn: (t) => checkSafety(t) },
      { name: 'system', priority: PRIORITY.SYSTEM, fn: (t) => checkSystem(t) },
      { name: 'tool', priority: PRIORITY.TOOL, fn: (t, c) => checkTool(t, c) },
      { name: 'math', priority: PRIORITY.MATH, fn: (t) => checkMath(t) },
      { name: 'guide', priority: PRIORITY.GUIDE, fn: (t, c) => checkGuide(t, c) },
      { name: 'local', priority: PRIORITY.LOCAL, fn: (t) => checkLocal(t) },
      { name: 'web', priority: PRIORITY.WEB, fn: (t, c) => checkWeb(t, c) },
    ];
    this.history = [];
    this.historyLimit = 60;
  }

  /**
   * Add a custom stage; the pipeline re-sorts by priority.
   * @param {{name:string, priority:number, fn:Function}} stage
   */
  use(stage) {
    this.stages.push(stage);
    this.stages.sort((a, b) => a.priority - b.priority);
    return this;
  }

  /**
   * Decide how to handle an input.
   * @param {string} text
   * @param {{desktopReady?:boolean, liveDataEnabled?:boolean, guideContext?:object}} [ctx]
   * @returns {RoutingDecision}
   */
  route(text, ctx = {}) {
    const input = String(text || '').trim();
    if (!input) {
      return { route: ROUTE.CONVERSATION, priority: PRIORITY.CONVERSATION, confidence: 0, reason: 'empty' };
    }

    // Slash commands bypass routing entirely — they're explicit.
    if (input.startsWith('/')) {
      return { route: ROUTE.SYSTEM, priority: PRIORITY.SYSTEM, confidence: 1,
               reason: 'slash-command', payload: { command: 'slash', raw: input } };
    }

    const considered = [];
    let softMatch = null;

    for (const stage of this.stages) {
      let d = null;
      try { d = stage.fn(input, ctx); }
      catch (e) { this.log(`[router] stage "${stage.name}" threw: ${e.message}`); }
      if (!d) { considered.push({ stage: stage.name, matched: false }); continue; }
      considered.push({ stage: stage.name, matched: true, reason: d.reason });

      // A "soft" match (offline KB) is held back in case a stronger,
      // fresher source (the web stage) also matches.
      if (d.payload?.soft) { softMatch = softMatch || d; continue; }

      return this._record(input, { ...d, considered });
    }

    if (softMatch) return this._record(input, { ...softMatch, considered });

    return this._record(input, {
      route: ROUTE.CONVERSATION, priority: PRIORITY.CONVERSATION,
      confidence: 0.5, reason: 'fallthrough', considered,
    });
  }

  _record(input, decision) {
    this.history.push({ t: Date.now(), input: input.slice(0, 80), route: decision.route, reason: decision.reason });
    if (this.history.length > this.historyLimit) this.history.shift();
    return decision;
  }

  /** Explain a routing decision — used by `/why` for debugging. */
  explain(text, ctx = {}) {
    const d = this.route(text, ctx);
    const lines = [`Input: "${text}"`, `→ Route: **${d.route.toUpperCase()}** (priority ${d.priority}, ${Math.round(d.confidence * 100)}% confidence)`, `→ Reason: ${d.reason}`, '', 'Pipeline:'];
    for (const c of d.considered || []) {
      lines.push(`  ${c.matched ? '✓' : '·'} ${c.stage}${c.reason ? ` — ${c.reason}` : ''}`);
    }
    return lines.join('\n');
  }

  recent(n = 10) { return this.history.slice(-n).reverse(); }
}

export const intentRouter = new IntentRouter();
export default intentRouter;
