/**
 * NOVA :: AI Router
 * -----------------
 * ONE authoritative answer to "which provider + model runs this request?",
 * shared by chat, vision, tool-selection and document generation.
 *
 * THE RULE: the UI selection wins. If the user pinned Gemini, a background
 * task must not quietly run on Ollama — that was the "fake selector" bug
 * (doc-agent read `resolvedProvider.id` off a STRING, got undefined, and
 * silently used the offline template). This module reads the same
 * engine.resolvedProvider / resolvedModel pair the chat stream uses, so the
 * selector and the backend can never disagree again.
 *
 * Fallbacks are honest: a task only degrades when the selected backend is
 * genuinely unusable (no key, provider down, hard error), and the caller is
 * told which backend actually ran. `candidateTargets()` exposes the full
 * escalation ladder so callers can TRY the next one when the first fails.
 *
 * @module ai/router
 */

import { getProvider, PROVIDERS, ollama } from './providers.js';
import { config } from '../core/config.js';
import { extractJson } from './screen-agent.js';

/** Task classes used for model selection (spec §6). */
export const TASK = {
  CONVERSATION: 'conversation',
  QA: 'question_answering',
  REASONING: 'reasoning',
  RESEARCH: 'web_research',
  VISION: 'vision',
  DESKTOP: 'desktop_control',
  DOC: 'document_generation',
  CODE: 'code_generation',
  TOOL_SELECT: 'tool_selection',
  MEMORY: 'memory_operations',
};

/** Providers tried (in order) when the selection itself is unusable. */
export const FALLBACK_ORDER = ['gemini', 'openrouter', 'openai', 'groq', 'anthropic'];

/** How many candidates to hand back before we stop escalating. */
export const MAX_CANDIDATES = 3;

/**
 * ONE preconfigured outline model for document generation (the user's
 * decision): deck/word/spreadsheet outlines are mechanical JSON and
 * gemini-3.8-flash is the newest stable model the machine is configured
 * with. Pinned for docgen ONLY; chat stays on the Settings selection.
 * Mirror: services/manifest.json features.pptx.defaults.model (parity test).
 */
export const DOCGEN_OUTLINE_MODEL = 'gemini-3.8-flash';

function keyReady(p, cfg) {
  return p && (!p.needsKey || cfg.getKey(p.id));
}

/**
 * Resolve what SHOULD run right now, without contacting anything.
 * Mirrors engine.resolve() — same config keys, same order — so a background
 * task sees exactly what the chat header shows.
 *
 * @param {any} [engine] live AIEngine (preferred — reads its resolved pair)
 * @returns {{provider:string, model:string}}
 */
export function resolveChat(engine = null) {
  if (engine?.resolvedProvider && engine.resolvedProvider !== 'local') {
    return { provider: engine.resolvedProvider, model: engine.resolvedModel || '' };
  }
  const want = config.get('provider') || 'auto';
  if (want !== 'auto' && want !== 'local') {
    const p = getProvider(want);
    if (p && keyReady(p, config)) {
      return { provider: p.id, model: config.get('model') || p.defaultModel || '' };
    }
  }
  if (want === 'auto') {
    for (const id of ['openai', 'anthropic', 'gemini', 'groq', 'openrouter']) {
      if (config.getKey(id)) {
        return { provider: id, model: config.get('model') || PROVIDERS[id]?.defaultModel || '' };
      }
    }
  }
  return { provider: 'ollama', model: config.get('model') || '' };
}

/**
 * Concrete runnable targets in ESCALATION ORDER, ready to hand to a
 * provider's stream. max 3 — beyond that the user's machine is not going to
 * get better, it is going to get slower.
 *
 * Ordering rule: the UI selection leads when it is usable; otherwise the
 * API providers run first (Gemini > OpenRouter > OpenAI > Groq > Anthropic,
 * cost/latency priority) and Ollama — a second machine that may not even be
 * running — is the LAST resort, never the silent default.
 *
 * @param {any} [engine] live AIEngine for its resolved pair
 * @param {{modelOverride?:string}} [opts]
 * @returns {Array<{id:string, p:object, model:string, key:string|undefined, via:string}>}
 */
export function candidateTargets(engine = null, { modelOverride = '' } = {}) {
  const sel = resolveChat(engine);
  const make = (id, via, model) => {
    const p = getProvider(id);
    if (!p) return null;
    if (p.id === 'ollama') {
      return { id: p.id, p, model: modelOverride || model || '', key: undefined, via };
    }
    if (p.needsKey && !config.getKey(p.id)) return null;
    return { id: p.id, p, model: modelOverride || model || p.defaultModel || '', key: config.getKey(p.id), via };
  };
  const push = (out, id, via, model) => {
    const t = make(id, via, model);
    if (t) out.push(t);
  };

  const out = [];
  if (sel.provider && sel.provider !== 'local' && sel.provider !== 'ollama') {
    push(out, sel.provider, 'selected', sel.model);
    for (const id of FALLBACK_ORDER) if (id !== sel.provider) push(out, id, 'fallback', '');
  } else if (sel.provider === 'ollama') {
    // UI pinned local Ollama — it leads, then the API ladder.
    push(out, 'ollama', 'selected', sel.model);
    for (const id of FALLBACK_ORDER) push(out, id, 'fallback', '');
  } else {
    // 'local' / nothing usable: API ladder first, Ollama dead last.
    for (const id of FALLBACK_ORDER) push(out, id, 'fallback', '');
    push(out, 'ollama', 'fallback-local', '');
  }
  return out.slice(0, MAX_CANDIDATES);
}

/**
 * The ONE backend that will run a request right now. Same ladder as
 * candidateTargets(). `ok:false` only when NOTHING can run; otherwise the
 * caller gets an honest `reason` when the only hope is local Ollama with no
 * API key (it may be down — the caller should say so).
 *
 * @returns {{ok:boolean, provider:string, model:string, via:string,
 *            unverified?:boolean, reason?:string}}
 */
export function usableBackend(engine = null, { modelOverride = '' } = {}) {
  const c = candidateTargets(engine, { modelOverride });
  if (!c.length) {
    const sel = resolveChat(engine);
    return {
      ok: false,
      provider: sel.provider || 'none',
      model: '',
      via: sel.provider === 'ollama' ? 'selected' : 'none',
      reason: 'No AI backend is usable: no API key is set and no local model was found. '
        + 'Set a key in Settings → AI Core, or start Ollama ("ollama serve") and pull a model.',
    };
  }
  const first = c[0];
  const noApiKey = !FALLBACK_ORDER.some(id => keyReady(getProvider(id), config));
  if (first.id === 'ollama' && noApiKey) {
    return {
      ok: true, provider: first.id, model: first.model, via: first.via,
      unverified: true,
      reason: 'No API key is configured — the only candidate is local Ollama. '
        + 'If Ollama is not running, generation will not work. '
        + 'Add a key in Settings → AI Core, or start Ollama ("ollama serve").',
    };
  }
  return { ok: true, provider: first.id, model: first.model, via: first.via };
}

/**
 * WHY did the JSON come back unusable? Real cause, never the banned generic
 * "Model returned no usable JSON." — that phrase hid the actual bug (Ollama
 * truncating the stream mid-brace) for weeks.
 *
 * @param {{provider?:string, model?:string, raw?:string, message?:string}} info
 * @returns {string} a message that names the true cause
 */
export function describeJsonFailure({ provider = 'model', model = '', raw = '', message = '' } = {}) {
  const who = `${provider}${model ? ` (${model})` : ''}`;
  if (message && !/no usable json/i.test(message)) return message; // real error already
  const text = String(raw || '');
  if (!text.trim()) {
    return `${who} returned an empty response — no text at all. The request may have been blocked or timed out.`;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end >= 0) {
    const pre = text.slice(0, start).trim();
    const post = text.slice(end + 1).trim();
    if (pre || post) {
      return `${who} wrapped the JSON in extra text (${pre ? pre.length : 0} chars before, `
        + `${post ? post.length : 0} after). Asked for a bare JSON object and got prose around it.`;
    }
    return `${who} returned JSON that parsed, but did not match the shape the task requested.`;
  }
  if (start >= 0 && end < 0) {
    // The exact truncation signature: an opening brace that never closes.
    const tail = text.slice(-40).replace(/\s+/g, ' ');
    return `${who} TRUNCATED the JSON mid-stream — got ${text.length} chars, the object never closes `
      + `(last text: “${tail}…”). Usually the model hit its output cap; a larger output budget (or `
      + `shorter deck) fixes it. AURA retries the SAME model with double the budget first, and only `
      + `then escalates backends…`;
  }
  return `${who} replied with prose instead of the requested JSON `
    + `(first 60 chars: “${text.slice(0, 60).replace(/\s+/g, ' ')}…”). The system prompt asked for a bare object.`;
}

/**
 * Non-streaming completion that RESPECTS THE UI SELECTION. Used by tool
 * selection and document generation — anywhere code used to call a model
 * directly (and usually hardcode Ollama) behind the user's back.
 *
 * Escalates: if the first candidate hard-fails (network, auth, 5xx), the
 * next one in `candidateTargets()` order is tried, up to MAX_CANDIDATES.
 * callers see exactly which one actually ran via `via`.
 *
 * @param {object} o
 * @param {Array<{role:string, content:string}>} o.messages
 * @param {any}    [o.engine]       AIEngine for its resolved pair
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {string} [o.provider]     provider PIN (docgen) — this provider
 *                                  leads with o.model, whatever the chat
 *                                  selection says. Falls through to the
 *                                  normal ladder if its key is missing.
 * @param {string} [o.model]        model for the pinned provider
 * @param {number} [o.timeoutMs]
 * @param {Function} [o.streamFn]   test seam — replaces provider.stream
 * @returns {Promise<{ok:boolean, text:string, provider:string, model:string,
 *          via:string, message?:string}>}
 */
export async function complete({ messages, engine = null, temperature = 0.4,
                                 maxTokens = 2048, timeoutMs = 90000, streamFn = null,
                                 model = '', provider = '' } = {}) {
  const targets = candidateTargets(engine, { modelOverride: '' });
  if (!targets.length) {
    const u = usableBackend(engine);
    return { ok: false, text: '', provider: 'none', model: '', via: 'none', message: u.reason };
  }
  if (provider) {
    // Docgen pin: the ONE preconfigured model leads, then the ladder.
    const p = getProvider(provider);
    if (keyReady(p, config)) {
      const i = targets.findIndex(t => t.id === provider);
      const t = { id: provider, p, model: model || p.defaultModel || '',
                  key: config.getKey(provider), via: 'doc-pin' };
      if (i >= 0) targets.splice(i, 1);
      targets.unshift(t);
      targets.length = Math.min(targets.length, MAX_CANDIDATES);
    }
  } else if (model && targets[0].id === 'gemini' && targets[0].model !== model) {
    // Legacy soft pin: swap the model on the selected gemini candidate only.
    targets[0] = { ...targets[0], model };
  }
  let lastErr = null;
  for (const target of targets) {
    const stream = streamFn || target.p.stream.bind(target.p);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let text = '';
    try {
      for await (const d of stream({
        messages, model: target.model, key: target.key,
        temperature, maxTokens, signal: ctl.signal,
      })) text += d;
      clearTimeout(timer);
      if (text) {
        return { ok: true, text: text.trim(), provider: target.id, model: target.model, via: target.via };
      }
      lastErr = { message: `${target.id} returned an empty stream.` };
    } catch (e) {
      clearTimeout(timer);
      lastErr = { message: `${target.id} failed: ${e?.message || e}` };
    }
  }
  return { ok: false, text: '', provider: targets[0].id, model: targets[0].model,
           via: targets[0].via, message: lastErr?.message || 'All candidate backends failed.' };
}

/**
 * complete() + lenient JSON extraction (repairs the malformations real
 * models produce). Retries are BUDGET ESCALATIONS on the same backend — the
 * variablized "larger num_predict fixes it" fix: attempt n asks for
 * maxTokens * 2^n (capped 65536), so a model that truncates a long deck
 * outline gets a second chance with room to finish before AURA gives up or
 * drops to a fallback. Failures are described by describeJsonFailure — the
 * true cause, never a generic phrase.
 *
 * @returns {Promise<{ok:boolean, json:any, provider:string, model:string,
 *          via:string, raw:string, message?:string}>}
 */
export async function completeJSON({ messages, engine = null, temperature = 0.2,
                                     maxTokens = 2048, timeoutMs = 90000, streamFn = null,
                                     retries = 1, model = '', provider = '' } = {}) {
  const CAP = 65536;
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const budget = Math.min(CAP, Math.round(maxTokens * (2 ** attempt)));
    const r = await complete({ messages, engine, temperature, maxTokens: budget,
                               timeoutMs, streamFn, model, provider });
    last = r;
    if (!r.ok || !r.text) continue;
    const json = extractJson(r.text);
    if (json) return { ok: true, json, provider: r.provider, model: r.model, via: r.via, raw: r.text };
  }
  return { ok: false, json: null, provider: last?.provider || 'unknown', model: last?.model || '',
           via: last?.via || '', raw: last?.text || '',
           message: describeJsonFailure({
             provider: last?.provider, model: last?.model, raw: last?.text, message: last?.message,
           }) };
}

export default { TASK, resolveChat, complete, completeJSON, candidateTargets,
                 usableBackend, describeJsonFailure, FALLBACK_ORDER, MAX_CANDIDATES,
                 DOCGEN_OUTLINE_MODEL };
