/**
 * AURA :: Ollama Model Registry
 * -----------------------------
 * Discovers whatever models you have pulled and routes each task to the most
 * appropriate one — WITHOUT hardcoding any model list. Pull a new model
 * tomorrow and it is picked up automatically.
 *
 * THE GUARDRAIL THAT MATTERS
 * --------------------------
 * A 20B/30B model on a modest machine can take minutes per reply. So:
 *
 *   1. `maxAutoParams` (default 9B) is a hard ceiling. Auto-routing will
 *      NEVER select a model above it, no matter how capable.
 *   2. Above-ceiling models stay usable, but only if you pin them explicitly
 *      in Settings. Deliberate choice, never a surprise.
 *   3. Measured throughput is recorded per model. Anything that actually
 *      performs slowly gets demoted, even if it is under the ceiling —
 *      because real timings beat parameter-count guesses.
 *
 * Capability inference reads the model NAME and SIZE reported by Ollama
 * (`/api/tags` → `details.parameter_size`, `details.family`). It is heuristic
 * and says so; you can always override per task.
 *
 * @module ai/model-registry
 */

/** Task categories AURA routes between. */
export const TASK = {
  CHAT: 'chat',            // greetings, short questions, general conversation
  CODE: 'code',            // writing/explaining/debugging code
  REASONING: 'reasoning',  // multi-step analysis, planning, hard problems
  TOOLS: 'tools',          // emitting structured tool calls
  VISION: 'vision',        // image understanding (if a vision model exists)
};

/** Speed tiers derived from parameter count, refined by measured latency. */
export const SPEED = {
  INSTANT: 'instant',    // <= 3B   — sub-second on most machines
  FAST: 'fast',          // <= 9B
  MODERATE: 'moderate',  // <= 16B
  SLOW: 'slow',          // > 16B   — excluded from auto-routing by default
};

/**
 * Name patterns → capability hints. Matching is on the model name only, so
 * this works for any future model that follows common naming conventions.
 */
const CAPABILITY_HINTS = [
  { rx: /coder|code|codestral|starcoder|deepseek-coder|codellama|codegemma/i,
    caps: ['code'], note: 'code-specialised' },
  { rx: /\br1\b|reason|thinking|think|qwq|marco-o1|o1-/i,
    caps: ['reasoning'], note: 'reasoning / chain-of-thought' },
  { rx: /llava|vision|bakllava|moondream|minicpm-v|llama3\.2-vision/i,
    caps: ['vision'], note: 'multimodal vision' },
  { rx: /embed|nomic-embed|mxbai|bge-/i,
    caps: ['embedding'], note: 'embeddings only — not for chat' },
  { rx: /instruct|chat|it\b/i,
    caps: ['chat'], note: 'instruction-tuned' },
  { rx: /gemma|phi|qwen|llama|mistral|granite|smollm|tinyllama/i,
    caps: ['chat'], note: 'general purpose' },
];

/** Families known to handle tool/function calling well. */
const TOOL_CAPABLE = /qwen2\.5|qwen3|llama3\.[123]|mistral|firefunction|command-r|hermes/i;

/**
 * Parse Ollama's `parameter_size` ("2.6B", "7B", "30.5B") into a number.
 * Falls back to estimating from file size when the field is absent.
 * @returns {number} billions of parameters, 0 if unknown
 */
export function parseParams(paramSize, fileSizeBytes) {
  if (paramSize) {
    const m = /([\d.]+)\s*([BM])/i.exec(String(paramSize));
    if (m) {
      const n = parseFloat(m[1]);
      return m[2].toUpperCase() === 'M' ? n / 1000 : n;
    }
  }
  // Heuristic: a 4-bit quantised model is roughly 0.6 GB per billion params.
  if (fileSizeBytes) return +(fileSizeBytes / 1e9 / 0.6).toFixed(1);
  return 0;
}

/** @returns {string} SPEED tier for a parameter count */
export function speedTier(params) {
  if (!params) return SPEED.MODERATE;
  if (params <= 3.5) return SPEED.INSTANT;
  if (params <= 9) return SPEED.FAST;
  if (params <= 16) return SPEED.MODERATE;
  return SPEED.SLOW;
}

/**
 * Build a capability profile for one installed model.
 * @param {{name?:string, model?:string, size?:number, details?:object,
 *          caps?:string[]}} raw from /api/tags, `caps` from /api/show
 */
export function profileModel(raw) {
  const name = raw.name || raw.model || '';
  const details = raw.details || {};
  const params = parseParams(details.parameter_size, raw.size);
  const tier = speedTier(params);

  const caps = new Set();
  const notes = [];
  for (const h of CAPABILITY_HINTS) {
    if (h.rx.test(name)) {
      h.caps.forEach(c => caps.add(c));
      notes.push(h.note);
    }
  }

  /*
   * GROUND TRUTH OVERRIDE.
   *
   * `raw.caps` is Ollama's own capability list from /api/show, computed from
   * the model's GGUF metadata. When present it beats every guess above —
   * a name regex can never know about a family released after it was
   * written. This is what stops AURA telling you to download a vision model
   * when the one you have already sees perfectly well.
   */
  const reported = Array.isArray(raw.caps) ? raw.caps.map(c => String(c).toLowerCase()) : [];
  const capsAreReal = reported.length > 0;
  if (capsAreReal) {
    if (reported.includes('vision')) { caps.add('vision'); notes.push('vision — confirmed by Ollama'); }
    else caps.delete('vision');
    if (reported.includes('tools')) caps.add('tools');
    if (reported.includes('thinking')) { caps.add('reasoning'); notes.push('thinking — confirmed by Ollama'); }
    if (reported.includes('embedding')) caps.add('embedding');
    else caps.delete('embedding');
  }

  // Everything that is not an embedding model can at least chat.
  if (!caps.has('embedding')) caps.add('chat');
  if (!capsAreReal && TOOL_CAPABLE.test(name)) caps.add('tools');
  // Larger general models are usable for reasoning even without an explicit tag.
  if (params >= 12 && !caps.has('embedding')) caps.add('reasoning');

  return {
    name,
    params,
    tier,
    family: details.family || null,
    quant: details.quantization_level || null,
    sizeGB: raw.size ? +(raw.size / 1e9).toFixed(1) : null,
    capabilities: Array.from(caps),
    /** true = Ollama reported these; false = inferred from the name. */
    capsAreReal,
    notes,
    /** Populated from real measurements as you use it. */
    measured: null,
    isEmbedding: caps.has('embedding'),
  };
}

const LS_KEY = 'aura.models.v1';

export class ModelRegistry {
  /**
   * @param {{storage?:Storage, maxAutoParams?:number, strategy?:string}} opts
   */
  constructor({ storage = null, maxAutoParams = 9, strategy = 'speed' } = {}) {
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    /** Hard ceiling for AUTOMATIC selection. Pinned models bypass it. */
    this.maxAutoParams = maxAutoParams;
    /** 'speed' | 'balanced' | 'quality' */
    this.strategy = strategy;
    /** @type {Map<string, object>} */
    this.models = new Map();
    /** @type {Record<string,string>} task → pinned model name */
    this.pins = {};
    /** @type {Record<string,{tokensPerSec:number, samples:number, lastMs:number}>} */
    this.perf = {};
    this.load();
  }

  /* ── discovery ────────────────────────────────────────────────────── */

  /**
   * Ingest the list from Ollama's /api/tags.
   * @param {Array<object>} rawModels
   */
  ingest(rawModels) {
    this.models.clear();
    for (const raw of rawModels || []) {
      const p = profileModel(raw);
      p.measured = this.perf[p.name] || null;
      this.models.set(p.name, p);
    }
    this.save();
    return this.models.size;
  }

  all() { return Array.from(this.models.values()); }
  get(name) { return this.models.get(name) || null; }
  get size() { return this.models.size; }

  /**
   * Is this model only good for looking at pictures?
   *
   * THE BUG THIS FIXES: a user pulled `moondream` (1.7B) on my advice, and
   * because it was the smallest model installed, the speed-first router
   * promoted it to the CHAT model for everything. moondream is a tiny image
   * captioner — it cannot follow instructions, cannot emit JSON, cannot plan.
   * `/do` then asked it for an action plan and got an empty string back, four
   * times in a row, after ~7s each. The trace read "Planner replied (empty)".
   *
   * A vision-only model is one that reports `vision` but is too small to be a
   * credible general chat model. Real multimodal chat models (gemma3/4:12b,
   * qwen2.5vl:7b, llava:7b) are well above this and stay fully eligible.
   */
  _isCaptionOnly(m) {
    if (!m.capabilities?.includes('vision')) return false;
    if (/moondream|smolvlm|granite\d?(\.\d)?-vision|florence|blip|vit-gpt2/i.test(m.name)) return true;
    // Anything vision-capable under 3B is a captioner, not an assistant.
    return m.params > 0 && m.params < 3;
  }

  /** Models eligible for automatic routing (under the ceiling, not embeddings). */
  autoEligible() {
    return this.all().filter(m =>
      !m.isEmbedding &&
      m.params > 0 &&
      m.params <= this.maxAutoParams &&
      !this._isCaptionOnly(m) &&
      !this._measuredTooSlow(m)
    );
  }

  /** Models excluded from auto-routing, with the reason — shown in Settings. */
  excluded() {
    return this.all()
      .filter(m => m.isEmbedding || m.params > this.maxAutoParams
                || this._isCaptionOnly(m) || this._measuredTooSlow(m))
      .map(m => ({
        ...m,
        reason: m.isEmbedding ? 'embedding model — cannot chat'
          : this._isCaptionOnly(m)
            ? 'image captioner — reads pictures, cannot hold a conversation or plan'
          : m.params > this.maxAutoParams
            ? `${m.params}B exceeds the ${this.maxAutoParams}B auto-routing ceiling`
            : `measured ${Math.round(m.measured.tokensPerSec)} tok/s — too slow for auto-routing`,
      }));
  }

  /** A model is "too slow" only once we have real evidence, not a guess. */
  _measuredTooSlow(m) {
    const p = this.perf[m.name];
    return !!(p && p.samples >= 2 && p.tokensPerSec > 0 && p.tokensPerSec < 3);
  }

  /* ── selection ────────────────────────────────────────────────────── */

  /**
   * Pick the best model for a task.
   * @param {string} task one of TASK
   * @returns {{name:string, reason:string, pinned:boolean, model:object, task?:string}|null}
   */
  select(task = TASK.CHAT) {
    // 1. An explicit pin always wins — including above-ceiling models.
    const pinned = this.pins[task];
    if (pinned && this.models.has(pinned)) {
      const m = this.models.get(pinned);
      const over = m.params > this.maxAutoParams;
      return {
        name: pinned, model: m, pinned: true,
        reason: `pinned for ${task}${over ? ` (${m.params}B — above the auto ceiling, your choice)` : ''}`,
      };
    }

    const pool = this.autoEligible();
    if (!pool.length) {
      // Nothing safe to auto-pick. Fall back to the smallest installed model
      // rather than silently choosing something that will hang.
      const usable = this.all().filter(m => !m.isEmbedding && !this._isCaptionOnly(m));
      const smallest = (usable.length ? usable : this.all().filter(m => !m.isEmbedding))
        .sort((a, b) => a.params - b.params)[0];
      return smallest
        ? { name: smallest.name, model: smallest, pinned: false,
            reason: `no model under the ${this.maxAutoParams}B ceiling — using the smallest available` }
        : null;
    }

    const needs = { [TASK.CODE]: 'code', [TASK.REASONING]: 'reasoning', [TASK.VISION]: 'vision', [TASK.TOOLS]: 'tools' }[task];
    const specialists = needs ? pool.filter(m => m.capabilities.includes(needs)) : [];
    const candidates = specialists.length ? specialists : pool;

    const scored = candidates.map(m => ({ m, score: this._score(m, task, !!specialists.length) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0].m;

    let reason;
    if (specialists.length) reason = `${needs}-capable · ${best.params}B · ${best.tier}`;
    else if (task === TASK.CHAT) reason = `fastest suitable · ${best.params}B · ${best.tier}`;
    else reason = `best available under ceiling · ${best.params}B`;
    if (best.measured?.tokensPerSec) reason += ` · ~${Math.round(best.measured.tokensPerSec)} tok/s measured`;

    return { name: best.name, model: best, pinned: false, reason };
  }

  /**
   * Scoring. Under 'speed' strategy, smaller is strongly preferred — which
   * matches wanting a 2B model for everyday chat.
   */
  _score(m, task, isSpecialist) {
    let s = 0;
    const tierScore = { instant: 40, fast: 28, moderate: 12, slow: 0 }[m.tier] ?? 10;

    if (this.strategy === 'speed') {
      s += tierScore * 1.5;
      // Chat should be as light as possible.
      if (task === TASK.CHAT) s += Math.max(0, 30 - m.params * 4);
    } else if (this.strategy === 'quality') {
      s += m.params * 3;
    } else {
      s += tierScore;
      s += m.params * 1.2;
    }

    // Specialists get a real edge for their task.
    if (isSpecialist) s += 25;
    if (task === TASK.CODE && m.capabilities.includes('code')) s += 20;
    if (task === TASK.REASONING && m.capabilities.includes('reasoning')) s += 20;
    if (task === TASK.TOOLS && m.capabilities.includes('tools')) s += 15;

    // Measured throughput is trusted over parameter-count guesses.
    if (m.measured?.tokensPerSec) {
      s += Math.min(30, m.measured.tokensPerSec * 0.6);
      if (m.measured.tokensPerSec < 8) s -= 25;
    }
    return s;
  }

  /* ── task classification ──────────────────────────────────────────── */

  /**
   * Decide which task category an input belongs to.
   * Deliberately conservative: defaults to CHAT so the fast model handles
   * the common case.
   */
  classify(text, { hasToolContext = false } = {}) {
    const t = String(text || '');
    const low = t.toLowerCase();
    const words = t.trim().split(/\s+/).filter(Boolean).length;

    if (/```|\bfunction\b|\bclass\b|\bdef\b|\bimport\b|\bconst\b|\bSELECT\b/i.test(t) ||
        /\b(write|refactor|debug|fix|implement|optimi[sz]e|review)\b.*\b(code|function|script|program|bug|error|component|api|query)\b/i.test(low) ||
        /\b(python|javascript|typescript|rust|golang|java|c\+\+|sql|regex|bash)\b/i.test(low)) {
      return TASK.CODE;
    }

    if (/\b(analy[sz]e|compare|plan|strategy|step by step|reason|prove|derive|why does|explain in detail|trade-?offs?|architect)\b/i.test(low) ||
        words > 45) {
      return TASK.REASONING;
    }

    if (hasToolContext && /\b(open|launch|close|play|pause|volume|screenshot|shutdown|lock)\b/i.test(low)) {
      return TASK.TOOLS;
    }

    return TASK.CHAT;
  }

  /* ── measurement ──────────────────────────────────────────────────── */

  /**
   * Record real throughput after a generation. This is what lets AURA learn
   * that a model is too slow on YOUR machine regardless of its size.
   * @param {string} name
   * @param {number} chars characters produced
   * @param {number} ms wall-clock duration
   */
  recordPerformance(name, chars, ms) {
    if (!name || !ms || ms < 50) return;
    // ~4 chars per token is a reasonable approximation across tokenizers.
    const tokens = chars / 4;
    const tps = tokens / (ms / 1000);
    const prev = this.perf[name];
    this.perf[name] = prev
      // Exponential moving average — recent runs matter more.
      ? { tokensPerSec: prev.tokensPerSec * 0.6 + tps * 0.4, samples: prev.samples + 1, lastMs: ms }
      : { tokensPerSec: tps, samples: 1, lastMs: ms };
    const m = this.models.get(name);
    if (m) m.measured = this.perf[name];
    this.save();
    return this.perf[name];
  }

  /* ── configuration ────────────────────────────────────────────────── */

  pin(task, modelName) {
    if (!modelName) delete this.pins[task];
    else this.pins[task] = modelName;
    this.save();
    return this.pins;
  }

  setCeiling(params) {
    this.maxAutoParams = Math.max(1, Number(params) || 9);
    this.save();
  }

  setStrategy(s) {
    if (['speed', 'balanced', 'quality'].includes(s)) { this.strategy = s; this.save(); }
  }

  /** Full picture for the Settings UI. */
  report() {
    const eligible = this.autoEligible();
    const excluded = this.excluded();
    const assignments = {};
    for (const task of Object.values(TASK)) {
      const sel = this.select(task);
      assignments[task] = sel ? { model: sel.name, reason: sel.reason, pinned: sel.pinned } : null;
    }
    return {
      total: this.models.size,
      eligible: eligible.map(m => ({
        name: m.name, params: m.params, tier: m.tier, sizeGB: m.sizeGB,
        capabilities: m.capabilities,
        measured: m.measured ? Math.round(m.measured.tokensPerSec) : null,
      })),
      excluded,
      assignments,
      ceiling: this.maxAutoParams,
      strategy: this.strategy,
      pins: { ...this.pins },
    };
  }

  /* ── persistence ──────────────────────────────────────────────────── */

  save() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(LS_KEY, JSON.stringify({
        pins: this.pins, perf: this.perf,
        maxAutoParams: this.maxAutoParams, strategy: this.strategy,
      }));
      return true;
    } catch { return false; }
  }

  load() {
    if (!this.storage) return false;
    try {
      const d = JSON.parse(this.storage.getItem(LS_KEY) || '{}');
      this.pins = d.pins || {};
      this.perf = d.perf || {};
      if (d.maxAutoParams) this.maxAutoParams = d.maxAutoParams;
      if (d.strategy) this.strategy = d.strategy;
      return true;
    } catch { return false; }
  }
}

export default ModelRegistry;
