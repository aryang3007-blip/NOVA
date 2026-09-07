/**
 * AURA :: Master Controls client
 * ==============================
 * Browser-side feature flags with the same safety rule as the server:
 *
 *   FAIL-OPEN — every unknown flag, missing row, failed fetch or corrupt
 *   response resolves to ON. A broken network/setting can never hide the
 *   site. The server also rejects unknown/protected ids, so this module
 *   only ever mirrors valid state.
 *
 * The server owns the source of truth (`aura.featureFlags` via
 * `/api/db/flags`). This module caches it, applies `data-flag` visibility
 * and exposes helpers for JS-level gates (feature launcher, intents).
 *
 * @module features/controls
 */

let _state = null;      // id → boolean (missing = ON)
let _inflight = null;
let _loaded = false;    // true only after a SUCCESSFUL server read

/** id → label, for honest "hidden" toasts (kept tiny; the page is the UI). */
const LABELS = {
  'page.live': 'AURA Live',
  'page.phone': 'Phone companion',
  'page.dev': 'Developer page',
  'page.db': 'Database manager',
  'dev.imageTest': 'Image production test UI',
  'panel.vision': 'Vision panel',
  'panel.dev': 'Developer console',
  'panel.system': 'System center',
  'panel.style': 'Wardrobe',
  'panel.mic': 'Microphone',
  'panel.voice': 'Voice output',
  'apps.pptx': 'PPT Builder',
  'apps.docx': 'Word Builder',
  'apps.xlsx': 'Workbook Builder',
  'apps.research': 'Web Research',
  'pipe.docgen': 'Document generation',
  'pipe.images': 'Image generation',
  'pipe.websearch': 'Web search',
  'pipe.organizer': 'File organizer',
  'pipe.automation': 'Desktop automation',
  'pipe.desktop': 'Desktop actions',
};

const _apply = (list) => {
  const s = {};
  for (const f of (list || [])) s[f.id] = f.on !== false;
  _state = s;
  _loaded = true;
  return s;
};

/**
 * Load (and cache) the flag state. Never throws — on any failure the
 * returned state is empty = everything ON.
 * @returns {Promise<Record<string, boolean>>}
 */
export function loadFlags(force = false) {
  if (_loaded && !force) return Promise.resolve(_state);
  if (_inflight && !force) return _inflight;
  _inflight = (async () => {
    try {
      const r = await fetch('/api/db/flags', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.message || 'bad flags payload');
      _loaded = true;
      return _apply(j.flags);
    } catch {
      /* FAIL-OPEN: empty state = all features available, and the next
         call retries — a transient fetch failure never sticks. */
      _state = _state || {};
      _loaded = false;
      _inflight = null;
      return _state;
    }
  })();
  return _inflight;
}

/** True when the feature is enabled (unknown/missing → true). */
export async function isOn(id) {
  const s = await loadFlags();
  return s[id] !== false;
}

/** Aura-style label for a flag id (for toasts/UI). */
export function label(id) {
  return LABELS[id] || id;
}

/**
 * Apply `hidden` to every `[data-flag]` element whose flag is OFF.
 * Returns the state so callers can chain. Fail-open: a fetch error hides
 * nothing.
 */
export function applyFlagVisibility(root = document) {
  return loadFlags().then((s) => {
    root.querySelectorAll('[data-flag]').forEach((el) => {
      const id = el.getAttribute('data-flag');
      el.hidden = !id || s[id] === false;
    });
    return s;
  });
}

/** POST a flag change; re-syncs cache from the server response. */
export async function setFlag(id, enabled) {
  try {
    const r = await fetch('/api/db/flags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled: !!enabled }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      return { ok: false, message: j.message || `HTTP ${r.status}` };
    }
    _apply(j.flags);
    return j;
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

/**
 * Demo-state summary for the topbar chip: which features are OFF.
 * Fail-open — if the store cannot be read, the summary says "ON" rather
 * than alarming the user; the chip is a mirror, never a gate.
 * @param {boolean} [force]  re-read the store (the chip wants fresh truth)
 * @returns {Promise<{off:Array<{id:string,label:string}>, onCount:number, offCount:number}>}
 */
export async function demoSummary(force = false) {
  const s = await loadFlags(force);
  const off = Object.entries(s)
    .filter(([, v]) => v === false)
    .map(([id]) => ({ id, label: label(id) }));
  const onCount = Object.values(s).filter((v) => v !== false).length;
  return { off, onCount, offCount: off.length };
}

/**
 * Paint the topbar demo-state chip from the live flag state.
 * @param {HTMLElement|null} el  the chip element
 */
export async function renderControlsChip(el) {
  if (!el) return;
  try {
    const d = await demoSummary(true);   // fresh read: the chip mirrors /controls
    el.classList.remove('loading');
    if (!d.offCount) {
      el.classList.add('on');
      el.classList.remove('off');
      el.textContent = `ALL ON · ${d.onCount}`;
      el.title = `Master Controls — all ${d.onCount} features are ON`;
    } else {
      el.classList.add('off');
      el.classList.remove('on');
      el.textContent = `${d.offCount} OFF`;
      el.title = `Master Controls — OFF: ${d.off.map((o) => o.label).join(', ')}`;
    }
  } catch {
    el.classList.add('loading');
    el.textContent = 'CHECKING…';
  }
}

/** Reset every flag to ON; re-syncs cache. */
export async function resetFlags() {
  try {
    const r = await fetch('/api/db/flags/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const j = await r.json();
    if (!r.ok || !j.ok) return { ok: false, message: j.message || `HTTP ${r.status}` };
    _apply(j.flags);
    return j;
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

export default { loadFlags, isOn, label, applyFlagVisibility, setFlag, resetFlags };
