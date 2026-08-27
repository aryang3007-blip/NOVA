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
 * told which backend actually ran.
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
const FALLBACK_ORDER = ['gemini', 'openrouter', 'openai', 'groq', 'anthropic'];

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
 * Concrete runnable target for a task. Returned by every complete* call so
 * features can SAY which backend actually did the work.
 * @returns {{id:string, p:object, model:string, key:string|undefined, via:string}|null}
 */
function pickTarget(engine, { modelOverride = '' } = {}) {
  const sel = resolveChat(engine);
  const tryProvider = (id, via, model) => {
    const p = getProvider(id);
    if (!p || p.id === 'ollama') return null;
    if (p.needsKey && !config.getKey(p.id)) return null;
    return { id: p.id, p, model: modelOverride || model || p.defaultModel || '',
             key: p.needsKey ? config.getKey(p.id) : undefined, via };
  };

  if (sel.provider && sel.provider !== 'local' && sel.provider !== 'ollama') {
    const t = tryProvider(sel.provider, 'selected', sel.model);
    if (t) return t;
  }
  if (sel.provider === 'ollama') {
    return { id: 'ollama', p: ollama, model: modelOverride || sel.model || ollama.defaultModel || '',
             key: undefined, via: 'selected' };
  }
  // Selection unusable (usually 'local' = no keys at all): honest degrade,
  // marked as fallback so the caller may disclose it.
  for (const id of FALLBACK_ORDER) {
    const t = tryProvider(id, 'fallback', '');
    if (t) return t;
  }
  return { id: 'ollama', p: ollama, model: modelOverride || ollama.defaultModel || '',
           key: undefined, via: 'fallback-local' };
}

/**
 * Non-streaming completion that RESPECTS THE UI SELECTION. Used by tool
 * selection and document generation — anywhere code used to call a model
 * directly (and usually hardcode Ollama) behind the user's back.
 *
 * @param {object} o
 * @param {Array<{role:string, content:string}>} o.messages
 * @param {any}    [o.engine]       AIEngine for its resolved pair
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {number} [o.timeoutMs]
 * @param {Function} [o.streamFn]   test seam — replaces provider.stream
 * @returns {Promise<{ok:boolean, text:string, provider:string, model:string,
 *          via:string, message?:string}>}
 */
export async function complete({ messages, engine = null, temperature = 0.4,
                                 maxTokens = 2048, timeoutMs = 90000, streamFn = null }) {
  const target = pickTarget(engine);
  const stream = streamFn || target.p.stream.bind(target.p);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let text = '';
  try {
    for await (const d of stream({
      messages, model: target.model, key: target.key,
      temperature, maxTokens, signal: ctl.signal,
    })) text += d;
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, text: '', provider: target.id, model: target.model, via: target.via,
             message: `${target.id} failed: ${e?.message || e}` };
  }
  clearTimeout(timer);
  return { ok: true, text: text.trim(), provider: target.id, model: target.model, via: target.via };
}

/**
 * complete() + lenient JSON extraction (repairs the malformations real
 * models produce). One automatic repair retry on empty parse.
 *
 * @returns {Promise<{ok:boolean, json:any, provider:string, model:string,
 *          via:string, raw:string, message?:string}>}
 */
export async function completeJSON({ messages, engine = null, temperature = 0.2,
                                     maxTokens = 2048, timeoutMs = 90000, streamFn = null,
                                     retries = 1 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await complete({ messages, engine, temperature, maxTokens, timeoutMs, streamFn });
    last = r;
    if (!r.ok || !r.text) continue;
    const json = extractJson(r.text);
    if (json) return { ok: true, json, provider: r.provider, model: r.model, via: r.via, raw: r.text };
  }
  return { ok: false, json: null, provider: last?.provider || 'unknown', model: last?.model || '',
           via: last?.via || '', raw: last?.text || '',
           message: last?.message || 'Model returned no usable JSON.' };
}

export default { TASK, resolveChat, complete, completeJSON };
