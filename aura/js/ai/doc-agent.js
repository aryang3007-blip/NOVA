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
 * WORKS WITH WHATEVER YOU HAVE
 * ----------------------------
 * Ollama, Gemini, OpenRouter, or nothing at all. The provider is whatever the
 * engine already resolved, so a free Gemini key and a local gemma both work
 * without a second configuration.
 *
 * AND IF THERE IS NO MODEL
 * ------------------------
 * `outlineFallback()` builds a real, honestly-labelled skeleton from the
 * prompt itself. It does not pretend a model wrote it — the deck says so on
 * the title slide. A user with no key and no Ollama still gets a usable file
 * instead of an error, which is the difference between a tool and a demo.
 *
 * @module ai/doc-agent
 */

import { extractJson } from './screen-agent.js';
import { config } from '../core/config.js';
import { PROVIDERS, ollama } from './providers.js';

/** Document kinds and how to ask a model for each. */
export const DOC_KINDS = {
  pptx: {
    label: 'Presentation', ext: '.pptx', icon: '📊',
    schema: '{"title":"…","subtitle":"…","slides":[{"title":"…","bullets":["…","…"],"notes":"…"}]}',
    rules: '6–10 slides. 3–5 short bullets per slide, each under 14 words. '
         + 'No sentences that run past one line. Include a closing slide.',
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
    rules: '4–8 sections. Each has a heading and 1–3 paragraphs. '
         + 'Use bullets only where a list genuinely helps.',
  },
};

/**
 * Words that mean "build me a document", mapped to the kind.
 * @type {Array<[RegExp, string]>}
 */
const TRIGGERS = [
  [/\b(ppt|pptx|power\s*point|powerpoint|slide\s*deck|presentation|deck)\b/i, 'pptx'],
  [/\b(xlsx|excel|spread\s*sheet|spreadsheet|workbook|csv\s*sheet)\b/i, 'xlsx'],
  [/\b(docx|word\s*doc|word\s*document|write\s*(?:me\s*)?an?\s*(?:report|essay|doc)|report|essay|letter)\b/i, 'docx'],
];

/**
 * Does this message ask for a document? Pure, so it unit-tests trivially.
 * @param {string} text
 * @returns {{kind:string, topic:string}|null}
 */
export function detectDocRequest(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // Must look like an instruction, not a question ABOUT presentations.
  if (!/\b(make|create|build|generate|write|prepare|draft|do)\b/i.test(t)) return null;

  for (const [re, kind] of TRIGGERS) {
    const m = re.exec(t);
    if (!m) continue;
    // Everything after "on/about/for" is the topic.
    let topic = '';
    const on = /\b(?:on|about|for|regarding|covering)\s+(.+)$/i.exec(t);
    if (on) topic = on[1];
    else {
      topic = t.replace(re, ' ')
               .replace(/\b(make|create|build|generate|write|prepare|draft|do|me|a|an|the|please)\b/gi, ' ')
               .replace(/\s+/g, ' ').trim();
    }
    topic = topic.replace(/[.!?]+$/, '').trim();
    return { kind, topic: topic || 'Untitled' };
  }
  return null;
}

const SYS = (kind) => {
  const k = DOC_KINDS[kind];
  return 'You are a document outliner. Reply with ONE JSON object and nothing '
    + 'else — no prose, no markdown fence, no explanation.\n\n'
    + `Shape: ${k.schema}\n\n`
    + `Rules: ${k.rules}\n`
    + 'Every string must be plain text. Do not invent statistics, dates or '
    + 'quotes you are not sure of; prefer general statements over false '
    + 'precision.';
};

/**
 * Ask the configured provider for an outline.
 *
 * @param {object} opts
 * @param {string} opts.kind  'pptx' | 'xlsx' | 'docx'
 * @param {string} opts.topic
 * @param {object} opts.ai    the AIEngine, for its resolved provider
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, spec?:object, source:string, message?:string, raw?:string}>}
 */
export async function outline({ kind, topic, ai, timeoutMs = 90000 }) {
  if (!DOC_KINDS[kind]) return { ok: false, source: 'none', message: `Unknown type '${kind}'.` };
  const usr = `Topic: ${topic}\n\nProduce the JSON now.`;
  const messages = [{ role: 'system', content: SYS(kind) }, { role: 'user', content: usr }];

  const providerId = ai?.resolvedProvider?.id || 'local';
  let raw = '';

  if (providerId === 'local' || !providerId) {
    return { ok: true, spec: outlineFallback(kind, topic), source: 'offline-template' };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    if (providerId === 'ollama') {
      const model = ai?.resolvedProvider?.model
        || ai?.pickOllamaModel?.(topic)?.name
        || ollama.installed?.[0];
      if (!model) throw new Error('No Ollama model installed.');
      for await (const d of ollama.stream({
        messages, model, temperature: 0.4, signal: ctl.signal,
      })) raw += d;
    } else {
      const p = PROVIDERS[providerId];
      if (!p) throw new Error(`Unknown provider '${providerId}'.`);
      for await (const d of p.stream({
        messages,
        model: ai?.resolvedProvider?.model || p.defaultModel,
        key: config.getKey(providerId),
        temperature: 0.4, maxTokens: 2048, signal: ctl.signal,
      })) raw += d;
    }
  } catch (e) {
    clearTimeout(timer);
    // A failed model is not a failed feature: fall back and say so.
    return {
      ok: true, spec: outlineFallback(kind, topic), source: 'offline-template',
      message: `${providerId} failed (${e?.message || e}) — built a skeleton instead.`,
    };
  }
  clearTimeout(timer);

  const parsed = extractJson(raw);
  const spec = validateSpec(kind, parsed, topic);
  if (!spec) {
    return {
      ok: true, spec: outlineFallback(kind, topic), source: 'offline-template',
      raw: raw.slice(0, 400),
      message: 'The model did not return a usable outline, so AURA built a '
             + 'skeleton you can edit.',
    };
  }
  return { ok: true, spec, source: providerId };
}

/**
 * Coerce whatever the model returned into a spec the builder accepts, or null.
 *
 * Written defensively on purpose: models return `slides` as an object, bullets
 * as a single string, numbers as strings. Repairing those is cheap; failing on
 * them makes the feature feel broken.
 */
export function validateSpec(kind, obj, topic = '') {
  if (!obj || typeof obj !== 'object') return null;
  const str = (v, n = 400) => (v == null ? '' : String(v)).slice(0, n).trim();
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const title = str(obj.title, 160) || str(topic, 160) || 'Untitled';

  if (kind === 'pptx') {
    const src = arr(obj.slides).filter(s => s && typeof s === 'object');
    const slides = src.map((s, i) => ({
      title: str(s.title || s.heading || s.name, 160) || `Slide ${i + 1}`,
      bullets: arr(s.bullets ?? s.points ?? s.content)
        .map(b => str(typeof b === 'object' ? (b.text ?? b.title ?? '') : b, 400))
        .filter(Boolean).slice(0, 12),
      notes: str(s.notes, 2000),
    })).filter(s => s.title || s.bullets.length);
    if (!slides.length) return null;
    return { title, subtitle: str(obj.subtitle, 200), slides };
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
        { title: 'Overview', bullets: [`What ${t} is`, 'Why it matters', 'Who it affects'] },
        { title: 'Background', bullets: ['Context', 'How we got here'] },
        { title: 'Key points', bullets: ['Point one', 'Point two', 'Point three'] },
        { title: 'Detail', bullets: ['Evidence', 'Examples'] },
        { title: 'Challenges', bullets: ['Open problems', 'Trade-offs'] },
        { title: 'Summary', bullets: ['What to remember', 'Next steps'] },
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

export default { detectDocRequest, outline, validateSpec, outlineFallback, describeSpec, DOC_KINDS };
