/**
 * AURA :: AI Provider Adapters
 * ----------------------------
 * Each adapter converts AURA's neutral message format into a provider's
 * wire format and yields text deltas from a real streaming HTTP response.
 *
 * Every adapter is an async generator: `for await (const delta of stream())`.
 * All support AbortSignal, which is what makes the Stop button real.
 *
 * NOTE ON CORS: these are called directly from the browser. OpenAI, Groq,
 * OpenRouter, Google Gemini and Ollama (with OLLAMA_ORIGINS set) allow
 * browser-origin requests. Anthropic requires the
 * `anthropic-dangerous-direct-browser-access` header, which is included.
 */

/** Parse a Server-Sent-Events byte stream into JSON objects. */
export async function* sseJson(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try { yield JSON.parse(data); } catch { /* skip partial */ }
      }
    }
  } finally {
    /*
     * reader.cancel() returns a PROMISE. When the body was already aborted
     * (user pressed Stop, or a new message superseded this one) that promise
     * REJECTS with "AbortError: BodyStreamBuffer was aborted". The old code
     * wrapped it in try/catch, which only catches synchronous throws, so the
     * rejection escaped as an unhandled promise rejection and surfaced in the
     * console as a hard error on every Stop.
     * Swallow it properly - cancelling an already-dead stream is a no-op we
     * do not care about.
     */
    try { const p = reader.cancel(); if (p && typeof p.catch === 'function') p.catch(() => {}); }
    catch { /* already released */ }
  }
}

/** Parse newline-delimited JSON (Ollama native format). */
export async function* ndJson(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try { yield JSON.parse(t); } catch {}
      }
    }
    if (buffer.trim()) { try { yield JSON.parse(buffer.trim()); } catch {} }
  } finally {
    /*
     * reader.cancel() returns a PROMISE. When the body was already aborted
     * (user pressed Stop, or a new message superseded this one) that promise
     * REJECTS with "AbortError: BodyStreamBuffer was aborted". The old code
     * wrapped it in try/catch, which only catches synchronous throws, so the
     * rejection escaped as an unhandled promise rejection and surfaced in the
     * console as a hard error on every Stop.
     * Swallow it properly - cancelling an already-dead stream is a no-op we
     * do not care about.
     */
    try { const p = reader.cancel(); if (p && typeof p.catch === 'function') p.catch(() => {}); }
    catch { /* already released */ }
  }
}

async function ensureOk(res, provider) {
  if (res.ok) return;
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = j.error?.message || j.error || j.message || body.slice(0, 300);
    } catch { detail = body.slice(0, 300); }
  } catch {}
  const hint = res.status === 401 ? ' — check your API key in Settings.'
    : res.status === 429 ? ' — rate limited or out of quota.'
    : res.status === 404 ? ' — model name may be wrong for this provider.'
    : '';
  throw new Error(`${provider} HTTP ${res.status}${hint}${detail ? `\n${detail}` : ''}`);
}

/* ────────────────────────── OpenAI-compatible ───────────────────────── */
// Covers OpenAI, Groq, OpenRouter, LM Studio, llama.cpp server, vLLM…

function openAICompatible({ id, label, defaultModel, baseUrl, models, extraHeaders = {}, keyless = false, docs = '' }) {
  return {
    id, label, defaultModel, models, keyless, docs,
    needsKey: !keyless,
    async *stream({ messages, model, key, signal, temperature = 0.7, maxTokens = 1024, baseUrlOverride, images = [] }) {
      const url = `${(baseUrlOverride || baseUrl).replace(/\/$/, '')}/chat/completions`;
      let payloadMessages = messages;
      if (images && images.length > 0) {
        payloadMessages = messages.map(m => {
          if (m.role !== 'user') return m;
          const textContent = typeof m.content === 'string' ? m.content : (m.content?.[0]?.text || '');
          const imgParts = images.map(img => ({
            type: 'image_url',
            image_url: { url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}` }
          }));
          return {
            role: 'user',
            content: [{ type: 'text', text: textContent }, ...imgParts]
          };
        });
      }
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(keyless ? {} : { Authorization: `Bearer ${key}` }),
          ...extraHeaders,
        },
        body: JSON.stringify({
          model: model || defaultModel,
          messages: payloadMessages,
          stream: true,
          temperature,
          max_tokens: maxTokens,
        }),
      });
      await ensureOk(res, label);
      for await (const evt of sseJson(res, signal)) {
        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) yield delta;
        const err = evt.error;
        if (err) throw new Error(`${label}: ${err.message || JSON.stringify(err)}`);
      }
    },
    /** @param {{key?:string, baseUrlOverride?:string}} [opts] */
    async listModels({ key, baseUrlOverride } = {}) {
      const url = `${(baseUrlOverride || baseUrl).replace(/\/$/, '')}/models`;
      const res = await fetch(url, { headers: keyless ? {} : { Authorization: `Bearer ${key}` } });
      if (!res.ok) return models || [];
      const j = await res.json();
      return (j.data || []).map(m => m.id).sort();
    },
  };
}

export const openai = openAICompatible({
  id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
  docs: 'https://platform.openai.com/api-keys',
});

export const groq = openAICompatible({
  id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.3-70b-versatile',
  models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
  docs: 'https://console.groq.com/keys',
});

export const openrouter = openAICompatible({
  id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'meta-llama/llama-3.3-70b-instruct',
  models: ['meta-llama/llama-3.3-70b-instruct', 'anthropic/claude-3.5-sonnet', 'openai/gpt-4o-mini', 'google/gemini-flash-1.5'],
  extraHeaders: { 'HTTP-Referer': typeof location !== 'undefined' ? location.origin : 'http://localhost', 'X-Title': 'AURA AI' },
  docs: 'https://openrouter.ai/keys',
});

/* ──────────────────────────── Anthropic ─────────────────────────────── */

export const anthropic = {
  id: 'anthropic', label: 'Anthropic', needsKey: true,
  defaultModel: 'claude-3-5-haiku-20241022',
  models: ['claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022', 'claude-sonnet-4-20250514'],
  docs: 'https://console.anthropic.com/settings/keys',
  async *stream({ messages, model, key, signal, temperature = 0.7, maxTokens = 1024, images = [] }) {
    // Anthropic takes `system` separately and rejects system roles in messages
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const convo = messages.filter(m => m.role !== 'system').map(m => {
      if (m.role !== 'user' || !images || images.length === 0) {
        return { role: m.role, content: m.content };
      }
      const textContent = typeof m.content === 'string' ? m.content : '';
      const imgBlocks = images.map(img => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: String(img).replace(/^data:image\/\w+;base64,/, '')
        }
      }));
      return {
        role: 'user',
        content: [{ type: 'text', text: textContent }, ...imgBlocks]
      };
    });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: model || this.defaultModel,
        system: system || undefined,
        messages: convo,
        max_tokens: maxTokens,
        temperature,
        stream: true,
      }),
    });
    await ensureOk(res, 'Anthropic');
    for await (const evt of sseJson(res, signal)) {
      if (evt.type === 'content_block_delta' && evt.delta?.text) yield evt.delta.text;
      if (evt.type === 'error') throw new Error(`Anthropic: ${evt.error?.message || 'stream error'}`);
    }
  },
  /** @param {{key?:string, baseUrlOverride?:string}} [opts] */
  async listModels(opts) { return this.models; },
};

/* ───────────────────────────── Gemini ───────────────────────────────── */

export const gemini = {
  id: 'gemini', label: 'Google Gemini', needsKey: true,
  defaultModel: 'gemini-2.0-flash',
  models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-pro'],
  docs: 'https://aistudio.google.com/apikey',
  async *stream({ messages, model, key, signal, temperature = 0.7, maxTokens = 1024, images = [] }) {
    const m = model || this.defaultModel;
    const system = messages.filter(x => x.role === 'system').map(x => x.content).join('\n\n');
    const contents = messages.filter(x => x.role !== 'system').map(x => {
      const parts = [{ text: x.content }];
      if (x.role === 'user' && images && images.length > 0) {
        for (const img of images) {
          parts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: String(img).replace(/^data:image\/\w+;base64,/, '')
            }
          });
        }
      }
      return {
        role: x.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    });
    await ensureOk(res, 'Gemini');
    for await (const evt of sseJson(res, signal)) {
      const parts = evt.candidates?.[0]?.content?.parts || [];
      for (const p of parts) if (p.text) yield p.text;
    }
  },
  async listModels({ key }) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
      if (!res.ok) return this.models;
      const j = await res.json();
      return (j.models || []).map(x => x.name.replace('models/', '')).filter(n => n.includes('gemini'));
    } catch { return this.models; }
  },
};

/* ───────────────────────────── Ollama ───────────────────────────────── */

export const ollama = {
  id: 'ollama', label: 'Ollama (local)', needsKey: false, keyless: true,

  /**
   * NO HARDCODED MODEL NAMES.
   *
   * This adapter used to declare defaultModel:'qwen2.5:3b' and a models[]
   * list. Both were wrong on any machine that hadn't pulled exactly those
   * tags — AURA would request a model the user did not have, Ollama would
   * 404, and the UI blamed it on "Ollama not running".
   *
   * `defaultModel` is now null and `models` starts empty. Both are populated
   * from a live /api/tags call (the same thing `ollama list` shows) by
   * refresh(). If you want a specific model, pull it and it appears.
   */
  defaultModel: null,
  models: [],
  docs: 'https://ollama.com/download',

  /** Real installed models, cached from the last discovery. */
  installed: [],
  _discoveredAt: 0,

  /**
   * REAL capabilities, straight from Ollama's /api/show, keyed by model name.
   * e.g. { 'gemma4:12b': ['completion','vision','tools'] }
   * Empty object until the first refresh(); an empty ARRAY for a given model
   * means Ollama did not report capabilities (older build) — that is the only
   * case where we fall back to guessing from the name.
   * @type {Record<string, string[]>}
   */
  caps: /** @type {Record<string, string[]>} */ ({}),

  /**
   * We reach Ollama through AURA's own server (/api/ollama/...) instead of
   * hitting :11434 directly.
   *
   * WHY: the page is served from :8000 and Ollama listens on :11434 — a
   * different origin. The browser therefore sends a CORS preflight that a
   * stock Ollama rejects unless OLLAMA_ORIGINS is set. Proxying makes the
   * request same-origin, so it works with a default install and zero config.
   * Falls back to a direct call if AURA's server is not present.
   */
  proxyBase: '/api/ollama',

  async _proxyUp() {
    if (this.__proxy !== undefined) return this.__proxy;
    try {
      const r = await fetch(`${this.proxyBase}/status`, { cache: 'no-store' });
      this.__proxy = r.ok;
    } catch { this.__proxy = false; }
    return this.__proxy;
  },

  /**
   * Discover what is REALLY installed. Always ask Ollama; never assume.
   * @param {{baseUrlOverride?:string, force?:boolean}} [opts]
   * @returns {Promise<string[]>} exact model names, e.g. ['gemma2:2b', ...]
   */
  async refresh({ baseUrlOverride, force = false } = {}) {
    if (!force && this.installed.length && Date.now() - this._discoveredAt < 15000) {
      return this.installed;
    }
    let names = [];
    if (await this._proxyUp()) {
      const j = await (await fetch(`${this.proxyBase}/status`, { cache: 'no-store' })).json();
      if (!j.running) { this.installed = []; throw new Error(j.reason || 'Ollama is not running'); }
      names = j.names || (j.models || []).map(m => m.name);
      // Ground-truth capabilities from /api/show, so we never have to guess
      // whether a model can see. Absent on an old server → stays empty and
      // isVisionModel() falls back to the name heuristic.
      /** @type {Record<string, string[]>} */
      const caps = {};
      for (const m of (j.models || [])) {
        if (m && m.name && Array.isArray(m.caps)) caps[m.name] = m.caps;
      }
      this.caps = caps;
    } else {
      const base = (baseUrlOverride || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${base}/api/tags`);
      if (!res.ok) throw new Error(`Ollama not reachable at ${base}`);
      names = ((await res.json()).models || []).map(m => m.name);
    }
    this.installed = names;
    this.models = names;
    this._discoveredAt = Date.now();
    // The "default" is simply the first real model, never an invented name.
    this.defaultModel = names[0] || null;
    return names;
  },

  /**
   * Snap a requested name onto a real installed one.
   * Prevents sending a misspelled/never-pulled tag to Ollama.
   * @returns {{name:string|null, note:string|null}}
   */
  resolveModel(want) {
    const names = this.installed;
    if (!names.length) return { name: want || null, note: null };
    if (!want) return { name: names[0], note: null };
    if (names.includes(want)) return { name: want, note: null };
    const bare = String(want).split(':')[0].toLowerCase();
    const exactLatest = names.find(n => n.toLowerCase() === `${bare}:latest`);
    if (exactLatest) return { name: exactLatest, note: `“${want}” → “${exactLatest}”` };
    const sameFamily = names.find(n => n.toLowerCase().split(':')[0] === bare);
    if (sameFamily) return { name: sameFamily, note: `“${want}” is not installed — using “${sameFamily}”` };
    const loose = names.find(n => n.toLowerCase().includes(bare));
    if (loose) return { name: loose, note: `“${want}” is not installed — using “${loose}”` };
    return { name: names[0], note: `“${want}” is not installed — using “${names[0]}”` };
  },

  /**
   * Name-based guess at multimodality. LAST RESORT ONLY — see isVisionModel().
   *
   * This is structurally unable to be correct: every new multimodal family
   * ships under a name no existing pattern covers. `gemma4:12b` is the proof
   * — it reads images perfectly well, but the pattern only knew `gemma3`, so
   * AURA declared the user had no vision model and told them to download one
   * they effectively already had. Kept only for Ollama builds older than
   * v0.6.0, which predate the /api/show `capabilities` field.
   *
   * Deliberately generous: `-vl`, `vision`, `multimodal` and `-mm` suffixes
   * are conventions across vendors, so match them generically rather than
   * enumerating families that will always be out of date.
   */
  guessVisionFromName(name) {
    const n = String(name || '');
    if (/embed|reranker/i.test(n)) return false;   // never multimodal
    return /llava|bakllava|moondream|minicpm-v|pixtral|florence|internvl|cogvlm|glm-4v|phi-?[34](\.\d)?-?vision|idefics|fuyu|paligemma|smolvlm|aya-vision|mistral-small3\.[12]|granite\d?(\.\d)?-vision/i.test(n)
      || /[-:._]?v(l|lm)\b|[-:._]vl[-:._\d]|vision|multimodal|[-_.]mm\b/i.test(n)
      || /gemma\s*(\d+)/i.test(n) && Number(/gemma\s*(\d+)/i.exec(n)[1]) >= 3
      || /llama\s*-?3\.2-vision|llama4|llama\s*4/i.test(n);
  },

  /**
   * Can this model actually look at an image?
   *
   * TRUTH FIRST: Ollama's /api/show reports a `capabilities` array derived
   * from the model's own GGUF metadata. If we have it, we use it and stop —
   * no pattern matching, no assumptions, correct for models that do not
   * exist yet.
   *
   * Only when that data is missing (Ollama < 0.6.0, or a model we have not
   * probed) do we fall back to guessVisionFromName().
   *
   * @param {string} name
   * @returns {boolean}
   */
  isVisionModel(name) {
    const reported = this.caps?.[name];
    if (Array.isArray(reported) && reported.length) return reported.includes('vision');
    return this.guessVisionFromName(name);
  },

  /** Did Ollama tell us this model's capabilities, or are we guessing? */
  capsAreReal(name) {
    const r = this.caps?.[name];
    return Array.isArray(r) && r.length > 0;
  },

  /** Generic capability check against Ollama's reported list. */
  hasCapability(name, cap) {
    const r = this.caps?.[name];
    return Array.isArray(r) && r.includes(cap);
  },

  /** Installed models that can actually look at an image. */
  visionModels() { return (this.installed || []).filter(n => this.isVisionModel(n)); },

  /**
   * Which capabilities did Ollama confirm vs. which are we guessing?
   * Used by Settings / `/models` so the UI never presents a guess as a fact.
   */
  capabilityReport() {
    return (this.installed || []).map(name => ({
      name,
      caps: this.caps?.[name] || [],
      source: this.capsAreReal(name) ? 'ollama' : 'name-heuristic',
      vision: this.isVisionModel(name),
    }));
  },

  /**
   * @param {object} opts
   * @param {Array<{role:string, content:string}>} opts.messages
   * @param {string}  [opts.model]
   * @param {AbortSignal} [opts.signal]
   * @param {number}  [opts.temperature]
   * @param {string}  [opts.baseUrlOverride]
   * @param {string[]} [opts.images] base64 PNG/JPEG payloads. The
   *   `data:image/...;base64,` prefix is stripped automatically — Ollama
   *   wants the raw base64.
   */
  async *stream({ messages, model, signal, temperature = 0.7, baseUrlOverride, images }) {
    const viaProxy = await this._proxyUp();

    // Verify the model against the REAL installed list before sending it.
    // If discovery itself fails we still honour an explicitly-supplied name —
    // the guard exists to stop INVENTED names, not to block the caller.
    let chosen = model;
    this.lastModelNote = null;
    try {
      const names = await this.refresh({ baseUrlOverride });
      if (names.length) {
        const r = this.resolveModel(model);
        chosen = r.name;
        if (r.note) this.lastModelNote = r.note;
      }
    } catch {
      /* discovery unavailable — fall back to whatever the caller asked for */
    }
    if (!chosen) {
      throw new Error(
        'No model specified and Ollama reports none installed. '
        + 'Pull one first, e.g.:  ollama pull gemma2:2b');
    }

    const url = viaProxy
      ? `${this.proxyBase}/chat`
      : `${(baseUrlOverride || 'http://localhost:11434').replace(/\/$/, '')}/api/chat`;
    // Attach images to the LAST user message — that is where Ollama expects
    // them, and it means the picture arrives with the question about it.
    /** @type {Array<{role:string, content:string, images?:string[]}>} */
    let payloadMessages = messages;
    if (Array.isArray(images) && images.length) {
      const clean = images
        .map(i => String(i || '').replace(/^data:image\/\w+;base64,/, ''))
        .filter(Boolean);
      if (clean.length) {
        payloadMessages = messages.map(m => ({ ...m }));
        for (let i = payloadMessages.length - 1; i >= 0; i--) {
          if (payloadMessages[i].role === 'user') {
            payloadMessages[i].images = clean;
            break;
          }
        }
      }
    }

    let res;
    try {
      res = await fetch(url, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: chosen, messages: payloadMessages, stream: true, options: { temperature } }),
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(viaProxy
        ? `Cannot reach Ollama. Start it with "ollama serve", then retry. (${e.message})`
        : `Ollama blocked by CORS. Serve AURA with serve.py so it can proxy, or run: OLLAMA_ORIGINS='*' ollama serve`);
    }
    const srvNote = res.headers.get('X-AURA-Model-Note');
    if (srvNote) this.lastModelNote = srvNote;
    await ensureOk(res, 'Ollama');
    for await (const evt of ndJson(res, signal)) {
      if (evt.error) throw new Error(`Ollama: ${evt.error}`);
      if (evt.message?.content) yield evt.message.content;
      if (evt.done) return;
    }
  },

  /** @param {{baseUrlOverride?:string}} [opts] */
  async listModels({ baseUrlOverride } = {}) {
    return this.refresh({ baseUrlOverride, force: true });
  },

  /**
   * Running state + the REAL installed models (+ install suggestions only
   * when nothing is installed).
   * @returns {Promise<{ok:boolean, running:boolean, installed:string[],
   *                    models:object[], suggested?:object[], reason?:string,
   *                    direct?:boolean}>}
   */
  async inspect() {
    if (await this._proxyUp()) {
      try {
        const j = await (await fetch(`${this.proxyBase}/catalog`, { cache: 'no-store' })).json();
        // Keep the adapter's cache in sync with what we just learned.
        this.installed = j.installed || (j.models || []).map(m => m.name);
        this.models = this.installed;
        this.defaultModel = this.installed[0] || null;
        this._discoveredAt = Date.now();
        return j;
      } catch (e) {
        return { ok: false, running: false, models: [], installed: [], suggested: [], reason: e.message };
      }
    }
    try {
      const installed = await this.listModels();
      return { ok: true, running: true, installed, models: [], suggested: [], direct: true };
    } catch (e) {
      return { ok: false, running: false, models: [], installed: [], suggested: [], reason: e.message };
    }
  },

  /** Download a model with real progress callbacks. */
  async pull(model, onProgress, signal) {
    if (!(await this._proxyUp())) throw new Error(`Model install needs AURA's server. Run: ollama pull ${model}`);
    const res = await fetch(`${this.proxyBase}/pull`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) throw new Error(`Pull failed: HTTP ${res.status}`);
    let last = '';
    for await (const evt of ndJson(res, signal)) {
      if (evt.error) throw new Error(evt.error);
      const total = evt.total || 0, done = evt.completed || 0;
      last = evt.status || last;
      onProgress?.({
        percent: total ? Math.min(100, (done / total) * 100) : 0,
        status: last, mb: +(done / 1e6).toFixed(0), totalMb: +(total / 1e6).toFixed(0),
      });
      if (evt.status === 'success') return { ok: true, model };
    }
    return { ok: true, model };
  },

  async ping(baseUrl) {
    try {
      if (await this._proxyUp()) {
        return (await (await fetch(`${this.proxyBase}/status`, { cache: 'no-store' })).json()).running === true;
      }
      const ctrl = new AbortController();
      // 1800ms was too tight: an Ollama busy loading a model into VRAM
      // answers /api/tags slowly, and the timeout was reported to the user
      // as "Ollama not reachable" while it was running perfectly well.
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`${(baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/api/tags`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch { return false; }
  },
};

/* ───────────────────────────── registry ─────────────────────────────── */

export const PROVIDERS = { openai, anthropic, gemini, groq, openrouter, ollama };

export function getProvider(id) { return PROVIDERS[id] || null; }

export function providerList() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id, label: p.label, needsKey: !!p.needsKey,
    defaultModel: p.defaultModel, models: p.models || [], docs: p.docs || '',
  }));
}

/**
 * Returns multimodal / vision-capable models for a given provider.
 * @param {string} providerId
 * @param {{key?:string, baseUrl?:string}} [opts]
 * @returns {Promise<string[]>}
 */
export async function listVisionModels(providerId, { key, baseUrl } = {}) {
  const p = getProvider(providerId);
  if (!p) return [];
  if (providerId === 'ollama') {
    const vm = ollama.visionModels?.() || [];
    return vm.length ? vm : (ollama.installed || ['llava', 'llama3.2-vision', 'minicpm-v', 'qwen2.5vl', 'moondream']);
  }
  if (providerId === 'gemini') {
    try {
      const raw = (await p.listModels?.({ key })) || p.models || [];
      const v = raw.filter(m => /gemini.*(?:flash|pro)/i.test(m));
      return v.length ? v : p.models;
    } catch { return p.models; }
  }
  if (providerId === 'openai') {
    try {
      const raw = (await p.listModels?.({ key, baseUrlOverride: baseUrl })) || p.models || [];
      const v = raw.filter(m => /gpt-4o|gpt-4-turbo|o1|o3|o4/i.test(m));
      return v.length ? v : p.models;
    } catch { return p.models; }
  }
  if (providerId === 'anthropic') {
    try {
      const raw = (await p.listModels?.({ key })) || p.models || [];
      const v = raw.filter(m => /claude-3/i.test(m));
      return v.length ? v : p.models;
    } catch { return p.models; }
  }
  if (providerId === 'openrouter') {
    try {
      const raw = (await p.listModels?.({ key, baseUrlOverride: baseUrl })) || p.models || [];
      const v = raw.filter(m => /vision|gpt-4|claude-3|gemini|pixtral|qwen.*vl/i.test(m));
      return v.length ? v : p.models;
    } catch { return p.models; }
  }
  return p.models || [];
}

export default PROVIDERS;
