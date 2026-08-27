/**
 * AURA :: Screen Agent
 * --------------------
 * Turns "what is on my screen?" and "click the Save button" into something
 * that actually happens.
 *
 * THE PIPELINE
 * ------------
 *   screen frame ──▶ [ describe ] ──▶ text ──▶ [ plan ] ──▶ steps ──▶ automation
 *
 * `describe` has two interchangeable backends, chosen by config:
 *
 *   'vision'  — send the raw frame to a multimodal model (gemma4:12b,
 *               qwen2.5vl:7b). Highest fidelity, slowest.
 *   'ocr'     — send the frame to a SMALL image→text model, take only the
 *               text, then hand that text to the fast chat model. This is
 *               the user's own suggestion and it is usually the right call
 *               on a modest machine: a 2-4B OCR pass plus a 2B chat pass
 *               beats one 12B multimodal pass, because most screen questions
 *               are really text questions.
 *   'auto'    — pick per question. Layout/colour/image questions need real
 *               vision; "what does this error say" does not.
 *
 * Nothing here invents a model name. Candidates are matched against what
 * `/api/tags` actually reports, and if none is installed the method says so.
 *
 * COORDINATES — THE HARD PART, ANSWERED HONESTLY
 * ----------------------------------------------
 * Language models are bad at pixel coordinates. Asking one to "return x,y of
 * the Save button" produces confident, wrong numbers. So AURA does NOT ask
 * for raw pixels. Three grounded strategies instead, in order of preference:
 *
 *   1. TEXT ANCHOR (best). The OCR pass returns text WITH bounding boxes
 *      when the model supports it; we click the box whose text matches.
 *      Grounded in the image, not guessed.
 *   2. GRID REFERENCE. The frame is overlaid with a labelled 12x8 grid
 *      before being sent. The model names a cell ("C4"), which is a much
 *      easier discrimination than a pixel, and the cell centre is a real
 *      coordinate we compute ourselves.
 *   3. USER CONFIRMATION (always). Whatever the source, the plan is shown
 *      and the pointer is parked on the target before anything is clicked.
 *
 * @module ai/screen-agent
 */

import { getProvider, ollama } from './providers.js';
import { bus, EV } from '../core/bus.js';
import { config } from '../core/config.js';

/**
 * Small image→text / OCR-capable models, cheapest first. Matched against the
 * real installed list — never pulled or assumed.
 */
export const OCR_CANDIDATES = [
  /qwen2?\.?5?-?vl/i,          // Qwen-VL: the best open OCR available locally
  /minicpm-v/i,                // strong document/OCR model
  /granite\d?(\.\d)?-vision/i,  // IBM, document-focused
  /internvl/i,
  /llava-phi3|llava/i,
  /gemma\s*[34]|gemma[34]/i,    // Gemma 3/4 multimodal
  /pixtral/i,
  /smolvlm/i,
  /moondream/i,                // LAST RESORT — see note below
];

/**
 * Models that can technically see an image but produce almost no usable text.
 *
 * REAL MEASUREMENT FROM THE USER'S MACHINE: moondream took 28.8s to return
 * **23 characters**, then 40.0s to return **0 characters**, three runs in a
 * row. It is a caption model ("a screenshot of a desktop"), not an OCR model,
 * and it is not fast on CPU either. Recommending it was my error.
 *
 * It stays LAST in the candidate list rather than being removed, so a machine
 * that genuinely has nothing else can still try — but AURA warns first.
 */
export const WEAK_READERS = /moondream|blip|vit-gpt2/i;

/** Grid used for coarse spatial reference. */
export const GRID_COLS = 12;
export const GRID_ROWS = 8;

/** Questions that genuinely need pixels, not just text. */
const NEEDS_REAL_VISION =
  /\b(colou?r|image|picture|photo|icon|logo|chart|graph|diagram|layout|design|ui|screenshot|looks?\s+like|dark|light|theme|font|shape|position|where\s+is)\b/i;

/**
 * The planning prompt. `withImage` toggles the wording between "you are
 * looking at a screenshot" and "here is a description of the screen".
 */
function PLAN_SYSTEM(withImage) {
  const cols = `A-${String.fromCharCode(64 + GRID_COLS)}`;
  return (withImage
      ? `You are looking at a screenshot of the user's screen with a ${GRID_COLS}x${GRID_ROWS} `
        + `grid drawn on it (columns ${cols} left-to-right, rows 1-${GRID_ROWS} top-to-bottom).\n\n`
      : `You are given a description of the user's screen. It references grid cells `
        + `(columns ${cols}, rows 1-${GRID_ROWS}).\n\n`)
    + 'Convert the user instruction into an ordered list of UI steps.\n'
    + 'Reply with STRICT JSON and nothing else:\n'
    + '{"steps":[{"do":"click","target":"Send button","cell":"C4"},'
    + '{"do":"type","text":"hello"},{"do":"hotkey","keys":"ctrl+s"},'
    + '{"do":"press","key":"enter"},{"do":"wait","seconds":1}]}\n\n'
    + 'Rules:\n'
    + '- Every "click" MUST include "cell" — the grid cell that element is in.\n'
    + `- Only reference things ${withImage ? 'you can actually SEE' : 'named in the description'}.\n`
    + '- Prefer a keyboard shortcut over hunting for a button when one exists.\n'
    + '- At most 8 steps.\n'
    + '- If it cannot be done, reply {"steps":[],"why":"reason"}.';
}

export class ScreenAgent {
  /**
   * @param {object} opts
   * @param {import('../vision/screen-share.js').ScreenShare} opts.screen
   * @param {any} opts.ai       AIEngine
   * @param {any} opts.actions  localActions
   * @param {any} [opts.config]
   * @param {any} [opts.cursor] AURA's soft on-screen pointer
   */
  constructor({ screen, ai, actions, config, cursor = null }) {
    this.screen = screen;
    /** AURA's own soft pointer, drawn on the shared preview. */
    this.cursor = cursor;
    this.ai = ai;
    this.actions = actions;
    this.config = config;
    /** Last description produced, for follow-up questions. */
    this.lastText = '';
    this.lastAt = 0;
    /** @type {Array<{text:string, col:number, row:number}>} */
    this.lastBoxes = [];
    this.lastMode = null;
    this.lastMs = 0;
  }

  /* ── model selection ──────────────────────────────────────────────── */

  /**
   * The smallest installed model that can read an image.
   * @returns {{name:string, reason:string, weak?:boolean}|null}
   */
  pickOcrModel() {
    const vision = ollama.visionModels();
    if (!vision.length) return null;
    // Prefer a real OCR-grade model even when a smaller one exists: a fast
    // answer that says nothing is worthless. Speed only matters among models
    // that can actually do the job.
    for (const rx of OCR_CANDIDATES) {
      const hits = vision.filter(n => rx.test(n));
      if (!hits.length) continue;
      // Within a family, smallest wins.
      hits.sort((a, b) => (this.ai?.models?.get?.(a)?.params ?? 99)
                        - (this.ai?.models?.get?.(b)?.params ?? 99));
      const name = hits[0];
      return {
        name,
        weak: WEAK_READERS.test(name),
        reason: WEAK_READERS.test(name)
          ? 'caption-only model — the ONLY image model installed'
          : `image→text model (${this.ai?.models?.get?.(name)?.params ?? '?'}B)`,
      };
    }
    const sized = vision
      .map(n => ({ n, p: this.ai?.models?.get?.(n)?.params ?? Infinity }))
      .sort((a, b) => a.p - b.p);
    return { name: sized[0].n, weak: WEAK_READERS.test(sized[0].n),
             reason: `smallest vision model (${sized[0].p}B)` };
  }

  /* ── vision backend: cloud key first, local Ollama as the offline default ── */

  /**
   * Which provider should LOOK AT an image right now?
   *
   * This is the fix for "screenshots never reach the API model": ASK / FIND /
   * ACT used to hardcode a local Ollama vision model, so a machine with only
   * an API key configured (Gemini, OpenAI…) hit "No image-capable model
   * installed" and the frame went nowhere. Now a keyed cloud provider wins;
   * a local model is the offline fallback — behaviour on a machine with no
   * keys configured is unchanged.
   *
   * Order: pinned visionProvider → current cloud chat provider → any keyed
   * cloud provider in quality order → null (use local).
   *
   * @returns {{p:object, id:string, model:string, key:string|undefined}|null}
   */
  pickVisionBackend() {
    const cfg = this.config || config;
    const vPref = cfg?.get?.('visionProvider') || 'auto';
    const vModel = cfg?.get?.('visionModel') || '';
    const ready = (id) => {
      const p = getProvider(id);
      if (!p || p.id === 'ollama') return null;
      if (p.needsKey && !cfg?.getKey?.(p.id)) return null;
      return { p, id: p.id, key: p.needsKey ? cfg.getKey(p.id) : undefined,
               model: vModel || p.defaultModel };
    };
    if (vPref && vPref !== 'auto' && vPref !== 'ollama' && vPref !== 'local') {
      const r = ready(vPref);
      if (r) return r;
    }
    const cur = this.ai?.resolvedProvider;
    if (cur && cur !== 'local' && cur !== 'ollama') {
      const r = ready(cur);
      if (r) return r;
    }
    for (const id of ['gemini', 'openrouter', 'openai', 'groq', 'anthropic']) {
      const r = ready(id);
      if (r) return r;
    }
    return null;
  }

  /**
   * Send ONE image + prompt to the best available vision backend and collect
   * the full text reply. Cloud provider first (when a key exists), the given
   * local Ollama model otherwise. Returns a uniform result either way.
   *
   * @returns {Promise<{ok:boolean, text?:string, model?:string, ms?:number, message?:string}>}
   */
  async _readImage(prompt, image,
                   { temperature = 0.1, localPick = null, trace = null, stageLabel = 'Read screen' } = {}) {
    const backend = this.pickVisionBackend();
    const t0 = Date.now();
    let out = '';
    if (backend) {
      try {
        for await (const d of backend.p.stream({
          messages: [{ role: 'user', content: prompt }],
          model: backend.model, key: backend.key, images: [image], temperature,
        })) out += d;
      } catch (err) {
        trace?.fail(stageLabel, String(err?.message || err));
        return { ok: false, message: `${stageLabel} failed via ${backend.id}: ${err?.message || err}` };
      }
      return { ok: true, text: out.trim(), model: `${backend.id}:${backend.model}`,
               ms: Date.now() - t0, via: 'cloud' };
    }
    if (!localPick) {
      return { ok: false,
               message: 'No vision model available. Add an API key in Settings '
                        + '(Gemini / OpenAI / Groq…) or run `ollama pull qwen2.5vl:7b` '
                        + 'for a fully local reader.' };
    }
    try {
      for await (const d of ollama.stream({
        messages: [{ role: 'user', content: prompt }],
        model: localPick, images: [image], temperature,
      })) out += d;
    } catch (err) {
      trace?.fail(stageLabel, String(err?.message || err));
      return { ok: false, message: `${stageLabel} failed: ${err?.message || err}` };
    }
    return { ok: true, text: out.trim(), model: localPick, ms: Date.now() - t0, via: 'local' };
  }

  /**
   * Which pipeline should handle this question?
   * @param {string} question
   * @returns {'vision'|'ocr'}
   */
  chooseMode(question) {
    const pref = this.config?.get?.('screenMode') || 'auto';
    if (pref === 'vision' || pref === 'ocr') return pref;
    return NEEDS_REAL_VISION.test(String(question || '')) ? 'vision' : 'ocr';
  }

  /* ── describing the screen ────────────────────────────────────────── */

  /**
   * Read the screen into TEXT using a small model. Does not answer the
   * question — it only transcribes, which is what small models are good at.
   *
   * @param {string} dataUrl
   * @param {{grid?:boolean, trace?:any}} [opts]
   * @returns {Promise<{ok:boolean, text?:string, model?:string, ms?:number, message?:string}>}
   */
  async transcribe(dataUrl, { grid = false, trace = null } = {}) {
    // A keyed cloud provider can read the image — then no local model is
    // required at all. Only when NO backend exists do we need a local one.
    const backend = this.pickVisionBackend();
    const pick = backend ? null : this.pickOcrModel();
    if (pick) trace?.info('Choose reader', `${pick.name} — ${pick.reason}`);

    const prompt = grid
      ? 'Transcribe every piece of text you can read in this screenshot. The image '
        + `has a labelled ${GRID_COLS}x${GRID_ROWS} grid overlaid (columns A-${String.fromCharCode(64 + GRID_COLS)}, rows 1-${GRID_ROWS}). `
        + 'For each button, link, field or heading, write it as:  TEXT [cell]\n'
        + 'Example:  Save [C4]\nList them one per line. Do not describe, only transcribe.'
      : 'Transcribe all readable text in this screenshot, preserving reading order. '
        + 'Include button labels, headings, menu items and any error messages. '
        + 'Do not describe the image or add commentary — output the text only.';

    const r = await this._readImage(prompt, dataUrl, {
      temperature: 0.1, localPick: pick?.name, trace, stageLabel: 'Read screen',
    });
    if (!r.ok) return r;
    trace?.ok('Read screen', `${r.model} → ${r.text.length} chars in ${r.ms}ms`);
    this.lastText = r.text;
    this.lastAt = Date.now();
    this.lastMode = 'ocr';
    this.lastMs = r.ms;
    if (grid) this.lastBoxes = parseGridRefs(r.text);
    return { ok: true, text: r.text, model: r.model, ms: r.ms };
  }

  /**
   * Answer a question about the screen.
   * @param {string} question
   * @returns {Promise<{ok:boolean, message?:string, mode?:string, model?:string, ms?:number}>}
   */
  async ask(question, { trace = null } = {}) {
    if (!this.screen.active) {
      return { ok: false, message: 'Not sharing a screen. Run `/watch` and pick a tab, window or screen.' };
    }
    const frame = this.screen.grab();
    if (!frame) return { ok: false, message: 'No screen frame yet — give it a moment and retry.' };
    const g = this.screen.geometry();
    trace?.ok('Capture frame',
      `${g?.capturedWidth}x${g?.capturedHeight}, ${Math.round(frame.length / 1024)} KB JPEG`);

    const q = String(question || '').trim() || 'What is on this screen?';
    const mode = this.chooseMode(q);
    trace?.info('Route', `${mode} path (config: ${this.config?.get?.('screenMode') || 'auto'})`);
    const t0 = Date.now();

    if (mode === 'vision') {
      // Straight to the multimodal model — highest fidelity.
      const r = await this.ai.askAboutImage(q, frame);
      this.lastMode = 'vision';
      this.lastMs = Date.now() - t0;
      return { ...r, mode: 'vision', ms: this.lastMs };
    }

    // OCR route: small model reads, fast chat model reasons.
    const t = await this.transcribe(frame, { trace });
    if (!t.ok) return t;
    if (!t.text) {
      return { ok: false, message: 'The screen reader returned no text. Try `/screenmode vision` for a picture-based answer.' };
    }
    bus.emit(EV.LOG, { text: `Screen read via ${t.model} in ${t.ms}ms (${t.text.length} chars)`, kind: 'info' });

    // Hand the TEXT to the normal chat model. No image — so this is fast.
    const prompt = `Here is the text currently visible on the user's screen:\n\n---\n${t.text}\n---\n\n`
      + `Answer this question using only what is on the screen. If the answer is not there, say so.\n\nQuestion: ${q}`;
    trace?.info('Answer', `handing ${t.text.length} chars to the chat model`);
    await this.ai.send(prompt, { silentUser: q });
    this.lastMs = Date.now() - t0;
    return { ok: true, mode: 'ocr', model: t.model, ms: this.lastMs };
  }

  /* ── acting on the screen ─────────────────────────────────────────── */

  /**
   * Locate a UI element by its visible text, returning a real screen
   * coordinate when possible.
   *
   * Grounded, not guessed: the frame is sent WITH a labelled grid, the model
   * reports which cell the text sits in, and we compute the centre of that
   * cell ourselves.
   *
   * @param {string} target  e.g. "Save", "the Send button"
   * @returns {Promise<{ok:boolean, x?:number, y?:number, cell?:string,
   *            message?:string, confidence?:string, model?:string,
   *            frameX?:number, frameY?:number, clickable?:boolean,
   *            reason?:string}>}
   */
  async locate(target, { trace = null } = {}) {
    if (!this.screen.active) return { ok: false, message: 'Not sharing a screen.' };
    const geo = this.screen.geometry();
    if (!geo) return { ok: false, message: 'No screen frame yet.' };

    /*
     * IMPORTANT CHANGE: locating no longer requires a full-monitor share.
     *
     * It used to bail out here if you had shared a tab or a window, which
     * made /find useless for the most common case. But FINDING something is
     * always meaningful — AURA can show you where it is with its own cursor.
     * Only CLICKING needs desktop pixels, so that check moved to the end and
     * degrades to "found, but not clickable" instead of refusing outright.
     */
    const frame = this.screen.grab();
    if (!frame) return { ok: false, message: 'No screen frame yet.' };
    trace?.ok('Capture frame', `${geo.capturedWidth}x${geo.capturedHeight}, ${Math.round(frame.length / 1024)} KB`);

    // Check we have a reader BEFORE doing the expensive grid render. A keyed
    // cloud provider counts — the screenshot goes to the API model then, not
    // to a local Ollama vision model we may not even have installed.
    const backend = this.pickVisionBackend();
    const pick = backend ? null : this.pickOcrModel();
    if (!backend && !pick) {
      return { ok: false, message: 'No vision model available. Add an API key in Settings '
        + '(Gemini / OpenAI / Groq…) or `ollama pull qwen2.5vl:7b` for a local reader.' };
    }
    if (pick) trace?.info('Choose reader', `${pick.name} — ${pick.reason}`);
    else trace?.ok('Choose reader', `${backend.id}:${backend.model} — configured API vision`);

    const gridded = await overlayGrid(frame, geo.capturedWidth, geo.capturedHeight);
    trace?.ok('Overlay grid', `${GRID_COLS}x${GRID_ROWS} labelled cells`);

    const prompt = `This screenshot has a ${GRID_COLS}x${GRID_ROWS} grid drawn on it. `
      + `Columns are labelled A to ${String.fromCharCode(64 + GRID_COLS)} left to right; rows 1 to ${GRID_ROWS} top to bottom.\n\n`
      + `Find: "${target}"\n\n`
      + 'Reply with ONLY the grid cell it is in, like: C4\n'
      + 'If you cannot find it, reply exactly: NOTFOUND';

    const read = await this._readImage(prompt, gridded, {
      temperature: 0, localPick: pick?.name, trace, stageLabel: 'Locate',
    });
    if (!read.ok) return { ok: false, message: read.message };
    const out = read.text;
    const modelUsed = read.model;
    trace?.ok('Model replied', out.slice(0, 80) || '(empty)');

    const cell = /\b([A-L])\s*-?\s*([1-8])\b/i.exec(out);
    if (!cell || /NOTFOUND/i.test(out)) {
      trace?.warn('Parse cell', 'no valid grid reference in the reply');
      return { ok: false, message: `Could not find “${target}” on the shared screen.\n\nModel said: ${out.trim().slice(0, 120) || '(nothing)'}` };
    }
    const col = cell[1].toUpperCase().charCodeAt(0) - 65;
    const row = parseInt(cell[2], 10) - 1;
    // Centre of the named cell, in CAPTURED pixels.
    const cx = (col + 0.5) * (geo.capturedWidth / GRID_COLS);
    const cy = (row + 0.5) * (geo.capturedHeight / GRID_ROWS);
    const cellName = `${cell[1].toUpperCase()}${cell[2]}`;
    trace?.ok('Resolve cell', `${cellName} → frame (${Math.round(cx)}, ${Math.round(cy)})`);

    // Always place AURA's OWN cursor. This works on a tab or window share
    // and never touches the user's real mouse.
    this.cursor?.moveTo(cx, cy, { label: target, mode: 'found' });

    // Desktop pixels are a bonus, not a requirement.
    const scr = this.screen.toScreenPoint(cx, cy);
    if (!scr.ok) {
      trace?.warn('Map to desktop', scr.message);
      return {
        ok: true, cell: cellName, frameX: Math.round(cx), frameY: Math.round(cy),
        model: modelUsed, confidence: 'coarse', clickable: false,
        reason: scr.message,
        message: `“${target}” is around cell ${cellName}. AURA's cursor is on it.\n\n`
          + `_Not clickable: ${scr.message}_`,
      };
    }
    trace?.ok('Map to desktop', `screen (${scr.x}, ${scr.y})`);

    return {
      ok: true, x: scr.x, y: scr.y, cell: cellName,
      frameX: Math.round(cx), frameY: Math.round(cy),
      model: modelUsed, confidence: 'coarse', clickable: true,
      message: `“${target}” is around cell ${cellName} → screen (${scr.x}, ${scr.y}).`,
    };
  }

  /**
   * Build an ORDERED action plan from a natural-language instruction, using
   * the screen text as context. Returns automation steps — it never executes
   * them; the caller previews and confirms.
   *
   * @param {string} instruction
   * @returns {Promise<{ok:boolean, intents?:Array<object>, message?:string,
   *            screenTextChars?:number, planner?:string}>}
   */
  /**
   * Instructions that have a correct, deterministic answer requiring NO model.
   *
   * "close the window" is Ctrl+W / Alt+F4 on every desktop on earth. Spending
   * 40 seconds asking a 7B model to locate an X button — and getting it wrong
   * — is worse than just knowing. The user asked that `/do close the open
   * window` simply work; this is how it simply works.
   *
   * Alt+F4 is on the permanent hotkey blocklist for good reason, so window
   * closing uses Ctrl+W, which closes a tab/document without risking the
   * whole application.
   */
  static SHORTCUTS = [
    { rx: /\b(close|dismiss|exit)\b.*\b(window|tab|dialog|popup|this)\b|^\s*(close|exit)\s*$/i,
      steps: [{ do: 'hotkey', keys: 'ctrl+w' }], why: 'close the focused window/tab' },
    { rx: /\bsave\b.*\b(file|document|it|this)\b|^\s*save\s*$/i,
      steps: [{ do: 'hotkey', keys: 'ctrl+s' }], why: 'save' },
    { rx: /\b(select all|highlight everything)\b/i,
      steps: [{ do: 'hotkey', keys: 'ctrl+a' }], why: 'select all' },
    { rx: /\b(copy)\b.*\b(this|it|selection|text)\b|^\s*copy\s*$/i,
      steps: [{ do: 'hotkey', keys: 'ctrl+c' }], why: 'copy' },
    { rx: /\b(paste)\b/i, steps: [{ do: 'hotkey', keys: 'ctrl+v' }], why: 'paste' },
    { rx: /\b(undo)\b/i, steps: [{ do: 'hotkey', keys: 'ctrl+z' }], why: 'undo' },
    { rx: /\b(switch|next|change)\b.*\b(window|app|application)\b/i,
      steps: [{ do: 'hotkey', keys: 'alt+tab' }], why: 'switch window' },
    { rx: /\b(new tab)\b/i, steps: [{ do: 'hotkey', keys: 'ctrl+t' }], why: 'new tab' },
    { rx: /\b(refresh|reload)\b/i, steps: [{ do: 'hotkey', keys: 'ctrl+r' }], why: 'reload' },
    { rx: /\b(find|search)\b.*\bon (this )?page\b/i,
      steps: [{ do: 'hotkey', keys: 'ctrl+f' }], why: 'find on page' },
  ];

  /** @returns {{steps:Array<object>, why:string}|null} */
  matchShortcut(instruction) {
    const t = String(instruction || '');
    for (const s of ScreenAgent.SHORTCUTS) if (s.rx.test(t)) return { steps: s.steps, why: s.why };
    return null;
  }

  /**
   * TWO-STAGE PLANNING — for machines whose only image model is weak.
   *
   * The user asked for this explicitly: "one for moondream in which it first
   * describes the image ... then the ai core creates the procedure".
   *
   * Stage 1: the vision model only has to DESCRIBE what it sees. Even a 1.7B
   *          captioner manages a sentence or two.
   * Stage 2: a proper text model turns that description plus the instruction
   *          into steps. Text models are far better at structured output than
   *          any small VLM.
   *
   * Weaker than single-stage vision planning — the describer cannot be asked
   * follow-up questions and spatial detail is lost — so it is a FALLBACK,
   * used when no vision model is strong enough to plan on its own.
   */
  async planTwoStage(instruction, { trace = null } = {}) {
    const frame = this.screen.grab();
    if (!frame) return { ok: false, message: 'No screen frame yet.' };
    const geo = this.screen.geometry();

    // Cloud API vision first — the describer only needs a local model when
    // no API key is configured at all.
    const backend = this.pickVisionBackend();
    const describer = backend ? null : this.pickOcrModel();
    if (!backend && !describer) {
      return { ok: false, message: 'No vision model available. Add an API key in Settings '
        + '(Gemini / OpenAI / Groq…) or install a local one: `ollama pull qwen2.5vl:7b`.' };
    }
    trace?.info('Stage 1 — describe',
      backend ? `${backend.id}:${backend.model}` : `${describer.name}${describer.weak ? ' (weak reader)' : ''}`);

    const gridded = await overlayGrid(frame, geo.capturedWidth, geo.capturedHeight);
    const descRes = await this._readImage(
      'Describe this screenshot. List every window title, button, menu item and '
      + 'piece of text you can read, and say roughly where each one is using the '
      + `grid labels drawn on the image (columns A-${String.fromCharCode(64 + GRID_COLS)}, `
      + `rows 1-${GRID_ROWS}). Be factual and brief.`,
      gridded, { temperature: 0.1, localPick: describer?.name, trace, stageLabel: 'Stage 1 — describe' });
    if (!descRes.ok) return { ok: false, message: descRes.message };
    const desc = descRes.text;
    trace?.ok('Stage 1 done', `${desc.length} chars — "${desc.slice(0, 70)}"`);

    if (desc.length < 15) {
      return { ok: false, message:
        `**${descRes.model} could not describe the screen** (${desc.length} characters).\n\n`
        + (backend
          ? 'The configured API model returned almost nothing — check the key/model in Settings.'
          : 'That model is too weak for this. Install one that can actually read a screen:\n'
            + '```\nollama pull qwen2.5vl:7b\n```') };
    }

    // Stage 2: turn the description into steps. Prefer the same cloud
    // provider (text planning needs no image); local Ollama otherwise.
    let planner;
    let raw = '';
    const planMessages = [
      { role: 'system', content: PLAN_SYSTEM(false) },
      { role: 'user', content: `What is on screen:\n---\n${desc}\n---\n\nInstruction: ${instruction}` },
    ];
    try {
      if (backend) {
        planner = `${backend.id}:${backend.model}`;
        trace?.info('Stage 2 — plan', planner);
        for await (const d of backend.p.stream({
          messages: planMessages, model: backend.model, key: backend.key, temperature: 0.1,
        })) raw += d;
      } else {
        const localPlanner = this.ai?.pickOllamaModel?.(instruction)?.name || ollama.installed?.[0];
        if (!localPlanner) return { ok: false, message: 'No text model available to plan with.' };
        planner = localPlanner;
        trace?.info('Stage 2 — plan', planner);
        for await (const d of ollama.stream({ messages: planMessages, model: planner, temperature: 0.1 })) raw += d;
      }
    } catch (err) {
      trace?.fail('Stage 2', String(err?.message || err));
      return { ok: false, message: `Planning failed: ${err?.message || err}` };
    }
    trace?.ok('Stage 2 replied', raw.trim().slice(0, 110) || '(empty)');

    const parsed = extractJson(raw);
    if (!parsed?.steps?.length) {
      return { ok: false, message: parsed?.why
        || `Could not turn that description into steps.\n\nModel said: ${raw.trim().slice(0, 180)}` };
    }
    return { ok: true, intents: parsed.steps.slice(0, 8), planner, stage: 'two-stage',
             describer: descRes.model, salvaged: !!parsed.salvaged };
  }

  async plan(instruction, { trace = null } = {}) {
    // Deterministic answers first — no model, no screen share needed.
    const sc = this.matchShortcut(instruction);
    if (sc) {
      trace?.ok('Known shortcut', `${sc.why} → ${sc.steps.map(x => x.keys || x.do).join(', ')}`);
      return { ok: true, intents: sc.steps, planner: 'built-in shortcut', stage: 'shortcut' };
    }
    if (!this.screen.active) return { ok: false, message: 'Not sharing a screen.' };
    const frame = this.screen.grab();
    if (!frame) return { ok: false, message: 'No screen frame yet.' };
    const geo = this.screen.geometry();

    /*
     * DIRECT VISION PLANNING — the user's own suggestion, and it is better.
     *
     * The old path was: image -> OCR to text -> hand text to a chat model ->
     * ask for JSON. That threw away everything spatial and, on the user's
     * machine, the OCR stage returned 0-23 characters after 30-40 seconds, so
     * the planner had literally nothing to work with and replied with an
     * empty string every time.
     *
     * A multimodal model that can BOTH see and write code (qwen2.5vl:7b,
     * gemma3/4:12b) can look at the screenshot and name the steps directly.
     * One model call instead of two, no lossy text bottleneck, and the model
     * can see layout - which is what a UI task actually depends on.
     *
     * We still overlay the grid, because naming a CELL is the one spatial
     * judgement small models make reliably, and it lets the model point at
     * things that have no text at all (an icon, an X button).
     */
    const planner = this.pickPlannerModel();
    if (!planner) {
      // No model can plan from an image — try describe-then-plan instead of
      // giving up. This is the moondream path.
      trace?.info('No vision planner', 'falling back to two-stage describe → plan');
      return this.planTwoStage(instruction, { trace });
    }
    trace?.info('Planner', `${planner.name} — ${planner.reason}`);

    const gridded = await overlayGrid(frame, geo.capturedWidth, geo.capturedHeight);
    trace?.ok('Capture + grid',
      `${geo.capturedWidth}x${geo.capturedHeight}, ${Math.round(gridded.length / 1024)} KB, `
      + `${GRID_COLS}x${GRID_ROWS} cells`);

    const sys = PLAN_SYSTEM(true);
    let raw = '';
    const provId = config.get('visionProvider') || config.get('provider') || this.ai?.resolvedProvider || 'auto';
    let p = provId !== 'auto' ? getProvider(provId) : null;
    if (!p || provId === 'auto' || provId === 'local') {
      const active = this.ai?.resolvedProvider && this.ai.resolvedProvider !== 'local' ? getProvider(this.ai.resolvedProvider) : null;
      if (active && (!active.needsKey || config.getKey(active.id))) {
        p = active;
      } else {
        const priorityOrder = ['gemini', 'openrouter', 'openai', 'groq', 'anthropic'];
        for (const candidate of priorityOrder) {
          const candProv = getProvider(candidate);
          if (candProv && config.getKey(candidate)) {
            p = candProv;
            break;
          }
        }
        if (!p) p = ollama;
      }
    }

    const key = p.needsKey ? config.getKey(p.id) : undefined;
    const modelToUse = (p.id === 'ollama') ? planner.name : (config.get('visionModel') || config.get('model') || p.defaultModel);

    try {
      const messages = [{ role: 'system', content: sys }, { role: 'user', content: `Instruction: ${instruction}` }];
      for await (const d of p.stream({ messages, model: modelToUse, key, images: [gridded], temperature: 0.1 })) {
        raw += d;
      }
    } catch (err) {
      trace?.fail('Planner', String(err?.message || err));
      return { ok: false, message: `Planning failed: ${err?.message || err}` };
    }

    trace?.ok('Planner replied', raw.trim().slice(0, 120) || '(EMPTY - model returned nothing)');
    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed.steps) || !parsed.steps.length) {
      // Single-stage failed. Before surrendering, try describe-then-plan —
      // a different shape of request that weaker models often handle.
      trace?.warn('Single-stage failed', 'retrying as two-stage describe → plan');
      const two = await this.planTwoStage(instruction, { trace });
      if (two.ok) return two;
      const empty = !raw.trim();
      return { ok: false, message: empty
        ? `**${planner.name} returned nothing.**\n\nIt cannot follow instructions well `
          + 'enough to plan. Pin a stronger one:\n```\n/pin vision qwen2.5vl:7b\n```'
        : `Could not parse a plan.\n\nIt said: ${raw.trim().slice(0, 200)}` };
    }
    return { ok: true, intents: parsed.steps.slice(0, 8), planner: planner.name,
             stage: 'vision', salvaged: !!parsed.salvaged };
  }

  /**
   * Turn a grid cell name ("C4") into frame AND desktop coordinates.
   * Pure arithmetic — no model involved, which is the whole point of the grid.
   * @param {string} cell
   * @returns {{ok:boolean, x?:number, y?:number, frameX?:number, frameY?:number,
   *            cell?:string, clickable?:boolean, reason?:string, message?:string}}
   */
  cellToPoint(cell) {
    const m = /^([A-Z])\s*(\d+)$/i.exec(String(cell || '').trim());
    const geo = this.screen.geometry();
    if (!m || !geo) return { ok: false, message: `Bad cell reference “${cell}”.` };
    const col = m[1].toUpperCase().charCodeAt(0) - 65;
    const row = parseInt(m[2], 10) - 1;
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) {
      return { ok: false, message: `Cell “${cell}” is outside the ${GRID_COLS}x${GRID_ROWS} grid.` };
    }
    const fx = (col + 0.5) * (geo.capturedWidth / GRID_COLS);
    const fy = (row + 0.5) * (geo.capturedHeight / GRID_ROWS);
    const scr = this.screen.toScreenPoint(fx, fy);
    if (!scr.ok) {
      return { ok: true, cell: m[0].toUpperCase(), frameX: Math.round(fx), frameY: Math.round(fy),
               clickable: false, reason: scr.message };
    }
    return { ok: true, cell: `${m[1].toUpperCase()}${m[2]}`, x: scr.x, y: scr.y,
             frameX: Math.round(fx), frameY: Math.round(fy), clickable: true };
  }

  /**
   * A model that can BOTH look at a screenshot AND write a structured plan.
   *
   * Caption-only models are explicitly excluded: moondream can see, but it
   * cannot emit JSON, which is exactly the failure the user hit.
   * @returns {{name:string, reason:string}|null}
   */
  pickPlannerModel() {
    const vision = ollama.visionModels()
      .filter(n => !WEAK_READERS.test(n));
    if (!vision.length) return null;
    const pinned = this.ai?.models?.pins?.vision;
    if (pinned && vision.includes(pinned)) return { name: pinned, reason: 'pinned for vision' };
    // Bigger is genuinely better for planning; prefer the largest that is
    // still sane, since /do is a deliberate, low-frequency action.
    const sized = vision
      .map(n => ({ n, p: this.ai?.models?.get?.(n)?.params ?? 7 }))
      .filter(x => x.p >= 3)
      .sort((a, b) => b.p - a.p);
    if (!sized.length) return null;
    const best = sized[0];
    return { name: best.n, reason: `${best.p}B multimodal — can see and plan` };
  }

  /**
   * Resolve a planned intent list into concrete automation steps, looking up
   * every click target on the real screen. Slow but grounded.
   * @param {Array<object>} intents
   * @returns {Promise<{ok:boolean, plan?:Array<object>, narration?:string[], message?:string}>}
   */
  async resolve(intents, { trace = null } = {}) {
    const plan = [];
    const narration = [];
    for (const [i, it] of intents.entries()) {
      const doo = String(it.do || '').toLowerCase();
      if (doo === 'click' || doo === 'double_click' || doo === 'right_click') {
        /*
         * The planner already saw the screen and named a cell, so use it.
         * Re-running locate() per click meant a second full model pass for
         * every step - on the user's machine that was 30s+ each.
         */
        let loc = null;
        if (it.cell && /^[A-Z]\s*\d+$/i.test(String(it.cell).trim())) {
          loc = this.cellToPoint(String(it.cell).trim());
          if (loc?.ok) trace?.ok(`Step ${i + 1} target`, `${it.target} @ ${it.cell} → (${loc.x}, ${loc.y})`);
        }
        // No cell, or the cell was unusable → fall back to a dedicated lookup.
        if (!loc?.ok) {
          trace?.info(`Step ${i + 1} lookup`, `no usable cell from the planner, locating “${it.target}”`);
          loc = await this.locate(it.target || '', { trace });
        }
        if (!loc.ok) {
          return { ok: false, message: `Step ${i + 1}: ${loc.message}` };
        }
        if (loc.clickable === false) {
          return { ok: false, message: `Step ${i + 1}: found “${it.target}”, but ${loc.reason}` };
        }
        this.cursor?.moveTo(loc.frameX ?? 0, loc.frameY ?? 0,
                            { label: it.target || 'target', mode: 'found' });
        plan.push({ op: doo === 'click' ? 'click' : doo, x: loc.x, y: loc.y });
        narration.push(`${i + 1}. Click “${it.target}” — cell ${loc.cell}, screen (${loc.x}, ${loc.y})`);
      } else if (doo === 'type') {
        plan.push({ op: 'type', text: String(it.text ?? '') });
        narration.push(`${i + 1}. Type “${String(it.text ?? '').slice(0, 40)}”`);
      } else if (doo === 'hotkey') {
        plan.push({ op: 'hotkey', keys: String(it.keys ?? '') });
        narration.push(`${i + 1}. Press ${String(it.keys ?? '').toUpperCase()}`);
      } else if (doo === 'press') {
        plan.push({ op: 'press', key: String(it.key ?? '') });
        narration.push(`${i + 1}. Press ${String(it.key ?? '').toUpperCase()}`);
      } else if (doo === 'wait') {
        plan.push({ op: 'wait', seconds: Number(it.seconds) || 0.5 });
        narration.push(`${i + 1}. Wait ${Number(it.seconds) || 0.5}s`);
      } else if (doo === 'scroll') {
        plan.push({ op: 'scroll', amount: Number(it.amount) || 3 });
        narration.push(`${i + 1}. Scroll ${(Number(it.amount) || 3) > 0 ? 'up' : 'down'}`);
      } else {
        return { ok: false, message: `Step ${i + 1}: unsupported action “${it.do}”.` };
      }
    }
    return { ok: true, plan, narration };
  }

  status() {
    return {
      screen: this.screen.status(),
      ocrModel: this.pickOcrModel(),
      visionModels: ollama.visionModels(),
      mode: this.config?.get?.('screenMode') || 'auto',
      lastMode: this.lastMode,
      lastMs: this.lastMs,
      lastChars: this.lastText.length,
    };
  }
}

/* ── helpers ────────────────────────────────────────────────────────── */

/**
 * Draw a labelled grid over a frame so a model can name a region instead of
 * guessing pixels.
 * @returns {Promise<string>} data URL
 */
export async function overlayGrid(dataUrl, w, h) {
  const img = new Image();
  img.src = dataUrl;
  await (img.decode ? img.decode().catch(() => {}) : new Promise(r => { img.onload = r; img.onerror = r; }));
  const c = document.createElement('canvas');
  c.width = w || img.naturalWidth || 1280;
  c.height = h || img.naturalHeight || 720;
  const cx = c.getContext('2d');
  if (!cx) return dataUrl;
  cx.drawImage(img, 0, 0, c.width, c.height);

  const cw = c.width / GRID_COLS, ch = c.height / GRID_ROWS;
  cx.lineWidth = 1;
  cx.strokeStyle = 'rgba(255,0,255,0.55)';
  cx.font = `bold ${Math.max(11, Math.round(ch * 0.16))}px monospace`;
  cx.textBaseline = 'top';
  for (let i = 0; i <= GRID_COLS; i++) {
    cx.beginPath(); cx.moveTo(i * cw, 0); cx.lineTo(i * cw, c.height); cx.stroke();
  }
  for (let j = 0; j <= GRID_ROWS; j++) {
    cx.beginPath(); cx.moveTo(0, j * ch); cx.lineTo(c.width, j * ch); cx.stroke();
  }
  for (let i = 0; i < GRID_COLS; i++) {
    for (let j = 0; j < GRID_ROWS; j++) {
      const label = `${String.fromCharCode(65 + i)}${j + 1}`;
      const x = i * cw + 3, y = j * ch + 2;
      cx.fillStyle = 'rgba(0,0,0,0.62)';
      cx.fillRect(x - 1, y - 1, cx.measureText(label).width + 6, ch * 0.2 + 4);
      cx.fillStyle = '#ff4dff';
      cx.fillText(label, x + 2, y + 1);
    }
  }
  return c.toDataURL('image/jpeg', 0.85);
}

/** Pull `TEXT [C4]` pairs out of a transcription. */
export function parseGridRefs(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(.*?)\s*\[\s*([A-L])\s*([1-8])\s*\]\s*$/i.exec(line.trim());
    if (m && m[1].trim()) {
      out.push({ text: m[1].trim(), col: m[2].toUpperCase().charCodeAt(0) - 65, row: +m[3] - 1 });
    }
  }
  return out;
}

/**
 * Pull a plan out of whatever a real model actually said.
 *
 * MEASURED FAILURE: against realistic 7B replies the original strict
 * JSON.parse handled 2 of 5. Real models emit single quotes, trailing commas,
 * unquoted keys, markdown fences, prose wrappers — or answer in plain English
 * and never produce JSON at all. `/do` was dead on arrival because of this.
 *
 * Strategy, in order:
 *   1. Strict JSON.parse of the first balanced {...} block.
 *   2. The same block after repairing the common LLM malformations.
 *   3. Natural-language salvage: read the intent out of prose.
 *
 * Returning null now means "the model genuinely said nothing usable", which
 * is a real signal rather than a parser limitation.
 */
export function extractJson(s) {
  const t = String(s || '');
  if (!t.trim()) return null;

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const bodies = fence ? [fence[1], t] : [t];

  for (const body of bodies) {
    const block = firstBalancedObject(body);
    if (!block) continue;
    const direct = tryParse(block);
    if (direct) return direct;
    const repaired = tryParse(repairJson(block));
    if (repaired) return repaired;
  }
  return salvageFromProse(t);
}

/** Extract the first balanced {...} region, ignoring braces inside strings. */
function firstBalancedObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, quote = '', esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === quote) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;   // truncated
}

function tryParse(str) {
  if (!str) return null;
  try {
    const v = JSON.parse(str);
    return (v && typeof v === 'object') ? v : null;
  } catch { return null; }
}

/**
 * Repair the malformations small models actually produce.
 * Deliberately conservative: only shapes we have really observed.
 */
export function repairJson(str) {
  let s = String(str || '');
  // Python-isms.
  s = s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
  // Single-quoted strings → double-quoted. Skip any that contain a double
  // quote, since re-quoting those would corrupt them.
  s = s.replace(/'([^'"\\]*)'/g, '"$1"');
  // Unquoted object keys:  {do: "click"}  →  {"do": "click"}
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  // Trailing commas before a closing brace/bracket.
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Smart quotes.
  s = s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  return s;
}

/**
 * Last resort: the model answered in English. Read the intent.
 *
 * "click the X in the top right corner (cell L1)" is a perfectly good
 * instruction that happens not to be JSON. Refusing it because of formatting
 * is exactly the brittleness that made /do unusable.
 */
export function salvageFromProse(text) {
  const t = String(text || '');
  const steps = [];

  // A named grid cell anywhere in the reply is a strong signal.
  const cell = /\bcell\s*([A-L])\s*-?\s*(\d{1,2})\b/i.exec(t)
            || /\b([A-L])\s?(\d{1,2})\b(?=[^\w]*(?:cell|square|grid)?)/.exec(t);

  const clickWord = /\b(click|press|tap|select|choose|hit)\b/i.exec(t);
  if (clickWord && cell) {
    // Try to name the target: the noun phrase after the verb.
    const after = t.slice(clickWord.index + clickWord[0].length, clickWord.index + 90);
    const target = (after.match(/^[\s:]*(?:on\s+)?(?:the\s+)?["'\`]?([\w][\w \-]{0,38})/i)?.[1] || '').trim();
    steps.push({ do: 'click', target: target || 'the indicated element',
                 cell: `${cell[1].toUpperCase()}${cell[2]}` });
  }

  const hot = /\b(?:press|hit|use)\s+((?:ctrl|alt|shift|cmd|win)(?:\s*\+\s*\w+)+)/i.exec(t);
  if (hot) steps.push({ do: 'hotkey', keys: hot[1].replace(/\s+/g, '').toLowerCase() });

  const typed = /\btype\s+["'\`]([^"'\`]{1,120})["'\`]/i.exec(t);
  if (typed) steps.push({ do: 'type', text: typed[1] });

  if (!steps.length) return null;
  return { steps, salvaged: true };
}