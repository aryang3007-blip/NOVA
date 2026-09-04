/**
 * AURA :: Document Agent
 * ======================
 * "make a ppt on quantum computing" → a validated outline → a real .pptx.
 *
 * THE SPLIT, AND WHY IT MATTERS
 * -----------------------------
 * This module turns a prompt into a **structured outline** and nothing else.
 * `docbuilder.py` turns that outline into a file. The AI never chooses a path,
 * never names a file on disk, and never touches the filesystem — it only fills
 * in content. So a model that hallucinates cannot write `C:\Windows\evil.exe`;
 * the worst it can do is produce a badly-worded slide.
 *
 * PROVIDER TRUTH (spec §13)
 * -------------------------
 * Generation goes through `router.completeJSON` — the ONE place that reads
 * the UI's selected provider/model (Gemini → Gemini, Groq → Groq, Ollama only
 * when Ollama is what the UI says). The old implementation read
 * `resolvedProvider.id` off a plain string, always got `undefined`, and
 * silently used the offline template. That is why decks came out as empty
 * skeletons "somehow never using the API model".
 *
 * QUALITY PIPELINE (spec §10)
 * ---------------------------
 *   understand topic (count, audience, purpose)
 *   → optional research digest (only when the topic needs current facts)
 *   → model writes a STRUCTURED deck spec (narrative arc, per-slide layout)
 *   → validateDeck: slide count, content on every slide, arc completeness
 *   → repairDeck: weak slides regenerated once via the model
 *   → docbuilder renders + re-validates the FILE itself
 *
 * AND IF THERE IS NO MODEL
 * ------------------------
 * `outlineFallback()` builds a real, honestly-labelled skeleton from the
 * prompt itself. It does not pretend a model wrote it — the deck says so on
 * the title slide.
 *
 * @module ai/doc-agent
 */

import * as router from './router.js';
import { config } from '../core/config.js';

/** Document kinds and how to ask a model for each. */
export const DOC_KINDS = {
  pptx: {
    label: 'Presentation', ext: '.pptx', icon: '📊',
    schema:
      '{"title":"…","subtitle":"…","theme":"professional-dark|professional-light|academic|minimal",'
      + '"audience":"…","slides":[{"kind":"title|section|bullets|two-column|process|timeline|stats|'
      + 'comparison|quote|conclusion|references","title":"…","purpose":"…",'
      + '"bullets":["…"],"columns":{"left":{"title":"…","bullets":["…"]},"right":{"title":"…","bullets":["…"]}},'
      + '"steps":["…"],"timeline":[{"label":"…","text":"…"}],"stats":[{"value":"…","label":"…"}],'
      + '"table":{"columns":["…"],"rows":[["…"]]},"quote":"…","attribution":"…",'
      + '"visual":"what imagery/diagram would support this slide","notes":"speaker notes"}]}',
    rules:
      'Tell a coherent STORY, not a list of headings. Default 8–12 content slides unless a count '
      + 'was requested — honor a requested count within ±1. Slide 1 is kind "title" (include a '
      + 'subtitle with audience/purpose), the LAST two are "conclusion" then "references". '
      + 'Every slide needs a "purpose" (why this slide exists), pick the "kind" that FITS the '
      + 'content: comparisons → two-column/comparison with "columns" or "table", sequences → '
      + '"process" with 3–6 "steps", chronology → "timeline", numbers → "stats" with 2–4 entries. '
      + 'Every content slide: 3–5 bullets of 8–18 words each with REAL information — no filler, '
      + 'no restating the title, no empty sections. Every slide gets speaker "notes" (2–4 '
      + 'sentences the presenter would SAY, adding context beyond the bullets). Vary the kinds: '
      + 'at least 3 different content layouts across the deck. No invented statistics, dates or '
      + 'quotes — prefer true general statements over false precision.',
  },
  xlsx: {
    label: 'Spreadsheet', ext: '.xlsx', icon: '📈',
    schema: '{"title":"…","sheets":[{"name":"…","columns":["…"],"rows":[["…",1]]}]}',
    rules: 'One sheet unless clearly more are needed. 3–6 columns. 8–20 rows. '
         + 'Numbers must be JSON numbers, not strings, so they can be summed.',
  },
  docx: {
    label: 'Document', ext: '.docx', icon: '📝',
    schema: '{"title":"…","subtitle":"…","sections":[{"heading":"…","level":1,'
          + '"paragraphs":["…"],"bullets":["…"]}]}',
    rules: '4–8 sections. Each has a heading and 1–3 paragraphs of real content. '
         + 'Use bullets only where a list genuinely helps.',
  },
};

/**
 * Words that mean "build me a document", mapped to the kind.
 * @type {Array<[RegExp, string]>}
 */
const TRIGGERS = [
  [/\b(ppt|pptx|power\s*point|powerpoint|slide\s*deck|presentation|deck|slides?)\b/i, 'pptx'],
  [/\b(xlsx|excel|spread\s*sheet|spreadsheet|workbook|csv\s*sheet)\b/i, 'xlsx'],
  [/\b(docx|word\s*doc|word\s*document|write\s*(?:me\s*)?an?\s*(?:report|essay|doc)|report|essay|letter)\b/i, 'docx'],
];

/** Extra-instruction clauses, e.g. "…with: history + timeline" or "…must include a comparison". */
const DETAIL_PATTERNS = [
  /,\s*(?:with|including|covering|mentioning)\s+([^.!?\n]+)$/i,
  /\b(?:with|including)\s*:\s*([^.!?\n]+)$/i,
  /\bmust\s+(?:include|cover|have|contain|mention)\s+([^.!?\n]+)$/i,
  /\binclud(?:e|es|ing)\s+([^.!?\n]+)$/i,
];

/**
 * Does this message ask for a document? Pure, so it unit-tests trivially.
 * Also extracts extra-instructions ("with: …", "must include …") so the
 * model can honour them instead of the user restating them in chat.
 * @param {string} text
 * @returns {{kind:string, topic:string, slides?:number, audience?:string, details?:string}|null}
 */
export function detectDocRequest(text) {
  const t0 = String(text || '').trim();
  if (!t0) return null;
  // Must look like an instruction, not a question ABOUT presentations.
  if (!/\b(make|create|build|generate|write|prepare|draft|do|give|design)\b/i.test(t0)) return null;

  for (const [re, kind] of TRIGGERS) {
    const m = re.exec(t0);
    if (!m) continue;

    // Extra instructions come FIRST so they can be removed from the topic
    // (else "create ppt on history with: timeline" would become the topic).
    let details = '';
    let t = t0;
    for (const dp of DETAIL_PATTERNS) {
      const dm = dp.exec(t);
      if (dm && dm[1].trim()) {
        details = dm[1].replace(/\s+/g, ' ').trim().slice(0, 400);
        t = t.slice(0, dm.index).replace(/[,;:]\s*$/, '').replace(/\b(that|which|and|with)\s*$/i, '');
        break;
      }
    }

    // Everything after "on/about/for" is the topic.
    let topic = '';
    const on = /\b(?:on|about|for|regarding|covering)\s+(.+)$/i.exec(t);
    if (on) topic = on[1];
    else {
      topic = t.replace(re, ' ')
               .replace(/\b(make|create|build|generate|write|prepare|draft|do|give|design|me|a|an|the|please)\b/gi, ' ')
               .replace(/\s+/g, ' ').trim();
    }
    // "for Class 10" / "for Class 10 students" at the END is the audience,
    // not the topic. Anchored, and the label must OPEN the clause — this is
    // why "for my thesis" is still a topic but "for class 7" is an audience.
    let audience = '';
    const aud = /\bfor\s+((?:class\s*\d+|students?|beginners?|kids|investors?|executives?|college|school|teachers?|professionals?|experts?|audience)[^,.]*)$/i.exec(topic);
    if (aud) {
      audience = aud[1].trim();
      topic = topic.slice(0, aud.index).trim().replace(/\b(for|to)\s*$/i, '');
    }
    topic = topic.replace(/[.!?]+$/, '').trim();

    // "a 10-slide presentation" / "10 slides on X"
    const num = /\b(\d{1,2})\s*[- ]\s*(?:slides?|pages?)\b/i.exec(t0);
    return { kind, topic: topic || 'Untitled',
             ...(num ? { slides: Math.min(30, Math.max(3, parseInt(num[1], 10))) } : {}),
             ...(audience ? { audience } : {}),
             ...(details ? { details } : {}) };
  }
  return null;
}

/**
 * Pull image sources out of a request. Pure — "create ppt on Mars with
 * /home/user/mars.png: climate, moons" must end up with the picture embedded,
 * not mentioned in a caption. Only real sources survive: http(s) URLs with an
 * image extension, or local paths ending in an image extension.
 * @param {string} text
 * @returns {string[]} max 3
 */
export function extractImageSources(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const out = [];
  const seen = new Set();
  const URL_RX = /https?:\/\/[^\s"'<>)]+\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s"'<>)]*)?/gi;
  const PATH_RX = /(?<![:/\w])(?:~\/|\/|\.{1,2}\/|\.\.\/|[A-Za-z]:\\|[A-Za-z]:\/)[^\s,;:"']+\.(?:png|jpe?g|gif|webp|bmp)(?![\w])/gi;
  for (const rx of [URL_RX, PATH_RX]) {
    let m;
    while ((m = rx.exec(t)) && out.length < 3) {
      const src = m[0].replace(/[.,;:]+$/, '').trim();
      const key = src.toLowerCase();
      if (src.length > 8 && !seen.has(key)) { seen.add(key); out.push(src); }
    }
  }
  return out;
}

/**
 * Attach resolved image sources to a validated deck: an existing `image`
 * slide gets its picture, otherwise dedicated image slides are appended
 * (max 3). Returns the new spec + how many sources were placed.
 */
export function attachImages(spec, sources) {
  const list = (sources || []).slice(0, 3);
  if (!list.length || !spec || !Array.isArray(spec.slides)) return { spec, placed: 0 };
  const slides = spec.slides.map(s => ({ ...s }));
  let placed = 0;
  // 1) fill image slides the model already made
  for (const s of slides) {
    if (placed >= list.length) break;
    if ((s.kind === 'image' || s.kind === 'media') && !s.image) {
      s.image = list[placed]; placed++;
    }
  }
  // 2) anything left becomes a dedicated visual slide after the hero/section
  for (let i = placed; i < list.length; i++) {
    const at = Math.min(1, slides.length);
    slides.splice(at, 0, { kind: 'image', title: 'Visual', image: list[i],
                            purpose: 'Image attached from request' });
    placed++;
  }
  return { spec: { ...spec, slides }, placed };
}

/**
 * Does this topic need live research first? (spec §15) Static/general topics
 * must NOT trigger a search — quantum computing basics are knowable; "today's
 * AI news" is not.
 */
export function needsResearch(text) {
  const t = String(text || '');
  return /\b(today|tonight|this (week|month|year)|latest|recent|current|currently|news|update[ds]?|202[4-9]|price|stock|market|score|weather|who won|announce[ds]?|release[d]?)\b/i.test(t);
}

/**
 * The ONE prompt builder — the popup's "Prompt preview" shows EXACTLY this,
 * and outline() sends EXACTLY this. Never build the system/user messages
 * anywhere else (variablized: app, engine, tests all see the same prompt).
 *
 * @param {{kind:string, topic:string, slides?:number, audience?:string,
 *          details?:string, digest?:string}} o
 * @returns {{system:string, user:string, messages:Array}}
 */
export function buildPrompt({ kind, topic, slides = 0, audience = '', details = '', digest = '' } = {}) {
  const k = DOC_KINDS[kind] || {};
  const system = (kind === 'pptx'
    ? 'You are a world-class presentation designer (think Gamma/McKinsey decks). '
    : 'You are a document outliner. ')
    + 'Reply with ONE JSON object and nothing else — no prose, no markdown fence, no explanation.\n\n'
    + `Shape: ${k.schema || '{}'}\n\n`
    + `Rules: ${k.rules || ''}\n`
    + (slides
        ? `The user asked for ${slides} ${kind === 'pptx' ? 'slides' : 'sections'}. ` +
          `Deliver as close to that as the content allows.\n`
        : '')
    + (audience ? `Audience: ${audience}. Pitch vocabulary, depth and examples to them.\n` : '')
    + 'Every string must be plain text.';
  const user = [
    `Topic: ${topic}`,
    audience ? `Audience: ${audience}` : '',
    slides ? `Requested ${kind === 'pptx' ? 'slide' : 'section'} count: ${slides}` : '',
    details ? `Extra instructions from the user — honour every one of them: ${details}` : '',
    digest ? `\nResearch digest (ground the content in this; cite sources on the references slide):\n${digest}` : '',
    '\nProduce the JSON now.',
  ].filter(Boolean).join('\n');
  return { system, user, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
}

/**
 * Ask the CONFIGURED provider for an outline. Provider truth: router reads
 * the UI selection; `ai`/`engine` is only consulted for its resolved pair.
 *
 * @param {object} opts
 * @param {string} opts.kind  'pptx' | 'xlsx' | 'docx'
 * @param {string} opts.topic
 * @param {object} [opts.ai]      the AIEngine (legacy name, still honored)
 * @param {object} [opts.engine]  same thing, explicit name
 * @param {number} [opts.slides]  requested slide count
 * @param {string} [opts.audience]
 * @param {string} [opts.details] extra instructions ("with: history + timeline")
 * @param {Function} [opts.research] async (topic) => digest string | null
 * @param {Function} [opts.streamFn] test seam (router)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, spec?:object, source:string, message?:string,
 *          raw?:string, deckReport?:object, researched?:boolean}>}
 */
export async function outline({ kind, topic, ai = null, engine = null, slides = 0,
                                audience = '', details = '', imageSources = [],
                                research = null, streamFn = null,
                                timeoutMs = 90000 }) {
  if (!DOC_KINDS[kind]) return { ok: false, source: 'none', message: `Unknown type '${kind}'.` };
  const eng = engine || ai;

  // Optional research digest — only when the topic actually needs it (§15).
  let digest = '';
  let researched = false;
  if (research && needsResearch(topic)) {
    try {
      const d = await research(topic);
      if (d && typeof d === 'string' && d.trim()) {
        digest = d.trim().slice(0, 2200);
        researched = true;
      }
    } catch { /* research is a bonus, never a blocker */ }
  }

  const sel = router.resolveChat(eng);
  // Offline chat brain is honoured — UNLESS the preconfigured docgen pin has
  // a key: document generation still asks the pinned model (user's decision).
  const hasPinKey = !!(config.getKey?.('gemini') || config.data?.apiKeys?.gemini);
  if (sel.provider === 'local' && !hasPinKey) {
    return { ok: true, spec: outlineFallback(kind, topic), source: 'offline-template' };
  }
  // Only a local model is available. Remember that so a failure can say the
  // TRUE cause and tell the user exactly how to enable a backend.
  const noApiKey = !router.FALLBACK_ORDER.some(id => config.getKey?.(id) || config.data?.apiKeys?.[id]);
  const behind = router.usableBackend(eng);
  const guidance = noApiKey && behind.reason
    ? ` ${behind.reason}`
    : '';

  const prompt = buildPrompt({
    kind, topic, slides, audience, details, digest,
  });
  const messages = prompt.messages;

  // ONE preconfigured outline model (user's decision): docgen always asks
  // gemini-3.8-flash first, no matter what chat model is set. It is the
  // newest stable model; it writes json, text and image prompts. If that
  // key is missing the ladder falls back honestly (via reports it).
  const r = await router.completeJSON({
    messages, engine: eng, streamFn, temperature: 0.45,
    maxTokens: kind === 'pptx' ? 8192 : 4096, timeoutMs, retries: 1,
    provider: 'gemini', model: router.DOCGEN_OUTLINE_MODEL,
  });

  const attach = (s) => {
    if (kind !== 'pptx') return s;
    const a = attachImages(s, imageSources);
    return a.placed ? a.spec : s;
  };
  if (!r.ok || !r.json) {
    return {
      ok: true, spec: attach(outlineFallback(kind, topic)), source: 'offline-template',
      raw: (r.raw || '').slice(0, 400),
      message: (r.message || 'The model did not return a usable outline')
        + ' — built a skeleton instead.' + guidance,
    };
  }

  let spec = validateSpec(kind, r.json, topic);
  if (!spec) {
    return {
      ok: true, spec: attach(outlineFallback(kind, topic)), source: 'offline-template',
      raw: (r.raw || '').slice(0, 400),
      message: 'The model outline was unusable, so AURA built a skeleton you can edit.' + guidance,
    };
  }

  // ── deck validation + repair (§16): never ship empty slides silently ──
  let deckReport = null;
  if (kind === 'pptx') {
    deckReport = validateDeck(spec, { requested: slides });
    if (!deckReport.ok && deckReport.weak.length) {
      const repaired = await repairDeck(spec, deckReport, { topic, audience, eng, streamFn, timeoutMs });
      if (repaired) {
        spec = validateSpec(kind, repaired, topic) || spec;
        deckReport = validateDeck(spec, { requested: slides });
        deckReport.repaired = true;
      }
    }
    // ── media: user-supplied images (paths/URLs from details) get embedded
    const attached = attachImages(spec, imageSources);
    if (attached.placed) spec = attached.spec;
  }

  // 'doc-pin' is the preconfigured outline model, not a fallback: it is the
  // intended first choice and gets NO fallback: prefix.
  return { ok: true, spec, source: `${['selected', 'doc-pin'].includes(r.via) ? '' : 'fallback:'}${r.provider}`,
           model: r.model, deckReport, researched,
           imagesPlaced: kind === 'pptx' ? (imageSources || []).slice(0, 3).length : 0 };
}

/** Regex-free proxy for "does this slide carry real content". */
function contentUnits(s) {
  let n = 0;
  n += (s.bullets || []).filter(b => b && b.trim().length > 2).length;
  n += (s.steps || []).filter(Boolean).length;
  n += (s.timeline || []).filter(t => t && (t.label || t.text)).length;
  n += (s.stats || []).filter(t => t && (t.value || t.label)).length;
  n += (s.table?.rows || []).filter(r => Array.isArray(r) && r.some(c => String(c).trim())).length;
  n += (s.quote && s.quote.trim().length > 4) ? 1 : 0;
  if (s.columns) {
    n += (s.columns.left?.bullets || []).filter(Boolean).length;
    n += (s.columns.right?.bullets || []).filter(Boolean).length;
  }
  return n;
}

/**
 * Score a finished deck spec against the professional requirements (§11/§16).
 * @returns {{ok:boolean, issues:Array<{slide:number|string, problem:string}>,
 *          weak:number[], slideCount:number, requested:number}}
 */
export function validateDeck(spec, { requested = 0 } = {}) {
  const issues = [];
  const weak = [];
  const slides = spec?.slides || [];
  const CONTENT_KINDS = new Set(['bullets', 'two-column', 'process', 'timeline', 'stats', 'comparison', 'quote', 'conclusion', 'references']);

  if (!slides.length) issues.push({ slide: 'all', problem: 'no slides at all' });
  slides.forEach((s, i) => {
    const units = contentUnits(s);
    if (!s.title?.trim()) issues.push({ slide: i + 1, problem: 'missing title' });
    if (CONTENT_KINDS.has(s.kind || 'bullets') && units === 0) {
      issues.push({ slide: i + 1, problem: `empty content (${s.kind || 'bullets'})` });
      weak.push(i);
    } else if ((s.kind === 'bullets' || s.kind === 'conclusion') && units < 2) {
      issues.push({ slide: i + 1, problem: 'thin content (<2 points)' });
      weak.push(i);
    }
    if ((s.bullets || []).some(b => b.split(/\s+/).length > 30)) {
      issues.push({ slide: i + 1, problem: 'wall-of-text bullet (>30 words)' });
    }
  });
  const kinds = new Set(slides.map(s => s.kind || 'bullets'));
  if (slides.length >= 6 && kinds.size < 3) {
    issues.push({ slide: 'all', problem: 'monotonous layouts — every slide is the same kind' });
  }
  const last = slides[slides.length - 1], secondLast = slides[slides.length - 2];
  if (slides.length >= 5 && ![last?.kind, secondLast?.kind].includes('conclusion')) {
    issues.push({ slide: slides.length, problem: 'no conclusion slide' });
  }
  if (requested > 0 && Math.abs(slides.length - requested) > Math.max(1, Math.round(requested * 0.3))) {
    issues.push({ slide: 'all', problem: `slide count ${slides.length} vs requested ${requested}` });
  }
  const hardFail = weak.length > 0;
  return { ok: !hardFail, issues, weak, slideCount: slides.length, requested };
}

/**
 * Regenerate the weak slides via the configured model and splice them back.
 * One round — good enough in practice, bounded in cost.
 */
export async function repairDeck(spec, report, { topic, audience = '', eng = null, streamFn = null, timeoutMs = 60000 } = {}) {
  const bad = report.weak.map(i => `Slide ${i + 1} ("${spec.slides[i]?.title}")`).join(', ');
  const sys = 'You are fixing specific slides in a presentation. Reply with ONE JSON object: '
    + '{"slides":[{"index":<number>,"title":"…","kind":"…","bullets":["…"],"notes":"…"}]} '
    + 'where index is 1-based. Fill each with real, specific content (3–5 bullets, 8–18 words '
    + 'each, plus speaker notes). Match this deck spec: ' + DOC_KINDS.pptx.schema.slice(0, 400);
  const usr = `Topic: ${topic}${audience ? `\nAudience: ${audience}` : ''}\n`
    + `Weak slides: ${bad}\n`
    + `Deck outline for context: ${JSON.stringify(spec.slides.map(s => s.title)).slice(0, 500)}\n`
    + 'Produce the replacement slides JSON now.';
  const r = await router.completeJSON({
    messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
    engine: eng, streamFn, temperature: 0.45, maxTokens: 2048, timeoutMs, retries: 0,
    provider: 'gemini', model: router.DOCGEN_OUTLINE_MODEL,  // same preconfigured pin
  });
  if (!r.ok || !r.json || !Array.isArray(r.json.slides)) return null;
  try {
    const next = JSON.parse(JSON.stringify(spec));
    for (const fix of r.json.slides) {
      const i = Number(fix.index) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= next.slides.length) continue;
      next.slides[i] = { ...next.slides[i], ...fix };
      delete next.slides[i].index;
    }
    return next;
  } catch { return null; }
}

/**
 * Coerce whatever the model returned into a spec the builder accepts, or null.
 *
 * Written defensively on purpose: models return `slides` as an object, bullets
 * as a single string, numbers as strings. Repairing those is cheap; failing on
 * them makes the feature feel broken. Unknown slide fields are PRESERVED —
 * layouts, steps, stats… — the renderer decides what to do with them.
 */
export function validateSpec(kind, obj, topic = '') {
  if (!obj || typeof obj !== 'object') return null;
  const str = (v, n = 400) => (v == null ? '' : String(v)).slice(0, n).trim();
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const title = str(obj.title, 160) || str(topic, 160) || 'Untitled';

  if (kind === 'pptx') {
    const src = arr(obj.slides).filter(s => s && typeof s === 'object');
    const KINDS = new Set(['title', 'section', 'bullets', 'two-column', 'process', 'timeline',
                           'stats', 'comparison', 'quote', 'conclusion', 'references', 'image']);
    const slides = src.map((s, i) => {
      const out = { ...s };   // preserve rich layout fields verbatim
      out.kind = KINDS.has(String(s.kind || '').toLowerCase())
        ? String(s.kind).toLowerCase()
        : (i === 0 ? 'title' : 'bullets');
      out.title = str(s.title || s.heading || s.name, 160) || `Slide ${i + 1}`;
      out.purpose = str(s.purpose, 200);
      out.bullets = arr(s.bullets ?? s.points ?? (Array.isArray(s.content) ? s.content : null))
        .map(b => str(typeof b === 'object' ? (b.text ?? b.title ?? '') : b, 400))
        .filter(Boolean).slice(0, 12);
      if (s.columns && typeof s.columns === 'object') {
        out.columns = {
          left: { title: str(s.columns.left?.title, 80),
                  bullets: arr(s.columns.left?.bullets).map(b => str(b, 300)).filter(Boolean).slice(0, 8) },
          right: { title: str(s.columns.right?.title, 80),
                   bullets: arr(s.columns.right?.bullets).map(b => str(b, 300)).filter(Boolean).slice(0, 8) },
        };
      }
      if (s.image) out.image = str(s.image, 400);
      if (s.imageCaption) out.imageCaption = str(s.imageCaption, 200);
      if (s.steps) out.steps = arr(s.steps).map(x => str(x, 300)).filter(Boolean).slice(0, 8);
      if (s.timeline) out.timeline = arr(s.timeline)
        .map(t => ({ label: str(t?.label, 60), text: str(t?.text ?? t, 300) }))
        .filter(t => t.label || t.text).slice(0, 8);
      if (s.stats) out.stats = arr(s.stats)
        .map(t => ({ value: str(t?.value, 40), label: str(t?.label ?? t, 160) }))
        .filter(t => t.value || t.label).slice(0, 5);
      if (s.table && typeof s.table === 'object') {
        out.table = {
          columns: arr(s.table.columns).map(c => str(c, 80)).slice(0, 8),
          rows: arr(s.table.rows).map(rw => arr(rw).map(c => coerceCell(c)).slice(0, 8))
            .filter(rw => rw.length).slice(0, 12),
        };
      }
      if (s.quote) { out.quote = str(s.quote, 500); out.attribution = str(s.attribution, 120); }
      out.visual = str(s.visual, 300);
      out.notes = str(s.notes, 2000);
      return out;
    }).filter(s => s.title || contentUnits(s) > 0);
    if (!slides.length) return null;
    return { title, subtitle: str(obj.subtitle, 200),
             theme: str(obj.theme, 60) || '', slides };
  }

  if (kind === 'xlsx') {
    let sheets = arr(obj.sheets).filter(s => s && typeof s === 'object');
    if (!sheets.length && (obj.rows || obj.columns)) {
      sheets = [{ name: title, columns: obj.columns, rows: obj.rows }];
    }
    const out = sheets.map((sh, i) => ({
      name: str(sh.name, 31) || `Sheet${i + 1}`,
      columns: arr(sh.columns ?? sh.headers).map(c => str(c, 200)).slice(0, 60),
      rows: arr(sh.rows).map((r) => {
        // Row may be an array, or an object keyed by column name.
        if (Array.isArray(r)) return r.slice(0, 60).map(coerceCell);
        if (r && typeof r === 'object') {
          const cols = arr(sh.columns ?? sh.headers).map(c => str(c, 200));
          return cols.length ? cols.map(c => coerceCell(r[c]))
                             : Object.values(r).slice(0, 60).map(coerceCell);
        }
        return [coerceCell(r)];
      }).filter(r => r.length).slice(0, 5000),
    })).filter(s => s.rows.length || s.columns.length);
    if (!out.length) return null;
    return { title, sheets: out };
  }

  if (kind === 'docx') {
    let src = arr(obj.sections).filter(s => s && typeof s === 'object');
    if (!src.length && obj.paragraphs) src = [{ heading: title, paragraphs: obj.paragraphs }];
    const sections = src.map(s => ({
      heading: str(s.heading || s.title, 200),
      level: Number.isInteger(s.level) && s.level >= 1 && s.level <= 4 ? s.level : 1,
      paragraphs: arr(s.paragraphs ?? s.body ?? s.text).map(p => str(p, 4000)).filter(Boolean),
      bullets: arr(s.bullets ?? s.points).map(b => str(b, 1000)).filter(Boolean),
    })).filter(s => s.heading || s.paragraphs.length || s.bullets.length);
    if (!sections.length) return null;
    return { title, subtitle: str(obj.subtitle, 400), sections };
  }
  return null;
}

/** Numbers stay numbers so Excel can sum them; everything else is text. */
function coerceCell(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return String(v);
  const s = v == null ? '' : String(v).trim();
  if (s && /^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s.slice(0, 2000);
}

/**
 * A real file when no model is available.
 *
 * This is a SKELETON and says so on the page — AURA does not pretend a model
 * wrote it. It is genuinely useful: correct structure, correct formatting,
 * headings in place, ready to type into.
 */
export function outlineFallback(kind, topic) {
  const t = String(topic || 'Untitled').trim().replace(/^./, c => c.toUpperCase());
  const note = 'Outline created offline by AURA — no language model was '
             + 'available, so the structure is here for you to fill in.';

  if (kind === 'pptx') {
    return {
      title: t, subtitle: note,
      slides: [
        { kind: 'title', title: t, purpose: 'Cover', bullets: [] },
        { kind: 'bullets', title: 'Overview', purpose: 'Frame the topic',
          bullets: [`What ${t} is`, 'Why it matters', 'Who it affects'] },
        { kind: 'bullets', title: 'Background', purpose: 'Give context',
          bullets: ['Context', 'How we got here'] },
        { kind: 'bullets', title: 'Key points', purpose: 'Core content',
          bullets: ['Point one', 'Point two', 'Point three'] },
        { kind: 'bullets', title: 'Detail', purpose: 'Depth',
          bullets: ['Evidence', 'Examples'] },
        { kind: 'bullets', title: 'Challenges', purpose: 'Balance',
          bullets: ['Open problems', 'Trade-offs'] },
        { kind: 'conclusion', title: 'Summary', purpose: 'Close',
          bullets: ['What to remember', 'Next steps'] },
      ],
    };
  }
  if (kind === 'xlsx') {
    return {
      title: t,
      sheets: [{
        name: t.slice(0, 31) || 'Sheet1',
        columns: ['Item', 'Category', 'Value', 'Notes'],
        rows: [['Example row', 'Category A', 0, note],
               ['', '', 0, ''], ['', '', 0, '']],
      }],
    };
  }
  return {
    title: t, subtitle: note,
    sections: [
      { heading: 'Introduction', level: 1, paragraphs: [`This document covers ${t}.`] },
      { heading: 'Background', level: 1, paragraphs: [''] },
      { heading: 'Discussion', level: 1, paragraphs: [''], bullets: ['First point', 'Second point'] },
      { heading: 'Conclusion', level: 1, paragraphs: [''] },
    ],
  };
}

/** Short human summary of a spec, for the confirm dialog. */
export function describeSpec(kind, spec) {
  if (!spec) return '';
  if (kind === 'pptx') {
    const n = spec.slides?.length || 0;
    return `${n + 1} slides — ${(spec.slides || []).map(s => s.title).slice(0, 4).join(', ')}`
      + (n > 4 ? '…' : '');
  }
  if (kind === 'xlsx') {
    const sh = spec.sheets || [];
    const rows = sh.reduce((a, s) => a + (s.rows?.length || 0), 0);
    return `${sh.length} sheet(s), ${rows} rows — ${sh.map(s => s.name).join(', ')}`;
  }
  const s = spec.sections || [];
  return `${s.length} sections — ${s.map(x => x.heading).filter(Boolean).slice(0, 4).join(', ')}`;
}

export default { detectDocRequest, extractImageSources, attachImages,
                 outline, validateSpec, validateDeck, repairDeck,
                 outlineFallback, describeSpec, needsResearch, DOC_KINDS };
