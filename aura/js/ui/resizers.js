/**
 * AURA :: layout drag-resizers
 * =============================
 * Three live splitters, built on Pointer Events + pointer capture so a drag
 * keeps tracking even when the cursor leaves the strip:
 *
 *   • dock      — right edge of the module dock      (--dock-w)
 *   • panels    — left edge of the right panel stack (--panel-w)
 *   • composer  — top edge of the chat composer       (--composer-h)
 *
 * Rules:
 *   • drag to resize (live CSS variable update, no layout thrash)
 *   • double-click a splitter → that dimension snaps back to default
 *   • sizes persist through config.set('layout', …)
 *   • everything disabled below MIN_WINDOW px (mobile layout is fixed)
 *
 * Pure helpers are exported so the logic is unit-testable without a browser.
 *
 * @module ui/resizers
 */

import { config } from '../core/config.js';

export const MIN_WINDOW = 900;

export const LAYOUT_DEFAULTS = { dockW: 66, panelW: 400, composerH: 148 };
export const LAYOUT_LIMITS = {
  dockW: [48, 140],
  panelW: [280, 760],
  composerH: [96, 420],
};

/** Clamp + round a number to its target limits. Pure. */
export function clamp(v, [min, max]) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.round(Math.min(max, Math.max(min, n)));
}

/** Fresh defaults. Pure (callers may mutate the copy). */
export function defaults() { return { ...LAYOUT_DEFAULTS }; }

/**
 * The new value after a drag gesture.
 *  dock:    drag right edge → +dx   panels: drag left edge → -dx
 *  composer: drag top edge  →  -dy  (up = taller)
 * Pure.
 */
export function valueFromDrag(target, base, dx, dy) {
  if (target === 'dockW') return clamp(base + dx, LAYOUT_LIMITS.dockW);
  if (target === 'panelW') return clamp(base - dx, LAYOUT_LIMITS.panelW);
  if (target === 'composerH') return clamp(base - dy, LAYOUT_LIMITS.composerH);
  return clamp(base, LAYOUT_LIMITS[target] || [0, 10000]);
}

/** Merge a layout object with defaults, clamped, no junk keys. Pure. */
export function normalizeLayout(raw) {
  const out = defaults();
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const k of Object.keys(LAYOUT_DEFAULTS)) {
    const v = Number(src[k]);
    if (Number.isFinite(v)) out[k] = clamp(v, LAYOUT_LIMITS[k]);
  }
  return out;
}

/** Read the stored layout (may be missing/corrupt) with full fallback. Pure-ish. */
export function storedLayout() {
  try {
    const raw = config.get('layout') || null;
    if (raw && typeof raw === 'object') return normalizeLayout(raw);
    if (raw && typeof raw === 'string') {
      try { return normalizeLayout(JSON.parse(raw)); } catch { return defaults(); }
    }
  } catch { /* config unavailable */ }
  return defaults();
}

/** Persist (only when something actually changed). */
export function persistLayout(layout) {
  try { config.set('layout', layout); } catch { /* localStorage blocked — fine */ }
}

/**
 * Wire the splitters into the DOM. No-op (returns null) outside a browser,
 * so node tests can import this module safely.
 *
 * @param {{minWindow?:number}} [opts]
 * @returns {Function|null} dispose()
 */
export function initResizers({ minWindow = MIN_WINDOW } = {}) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;

  const root = document.documentElement;
  const dock = document.querySelector('.dock');
  const panels = document.querySelector('.panels');
  const composer = document.querySelector('.composer');

  if (!dock || !panels || !composer) return null;

  /** live value of a CSS var, parsed as int */
  const cssVar = (name) => {
    const v = getComputedStyle(root).getPropertyValue(name);
    return parseInt(v, 10) || LAYOUT_DEFAULTS.dockW;
  };
  const apply = (target, px) => {
    if (target === 'dockW') root.style.setProperty('--dock-w', `${px}px`);
    else if (target === 'panelW') root.style.setProperty('--panel-w', `${px}px`);
    else root.style.setProperty('--composer-h', `${px}px`);
  };

  const layout = storedLayout();
  const targets = {
    dockW: { el: dock, cls: 'au-splitter au-dock-splitter', label: 'dock-width' },
    panelW: { el: panels, cls: 'au-splitter au-panel-splitter', label: 'panel-width' },
    composerH: { el: composer, cls: 'au-splitter au-composer-splitter', label: 'composer-height' },
  };
  const disposers = [];

  const enabled = () => (window.innerWidth || 0) >= minWindow;
  const syncEnabled = () => {
    const on = enabled();
    for (const t of Object.values(targets)) t.el.classList.toggle('au-resize-off', !on);
  };

  for (const [key, t] of Object.entries(targets)) {
    const strip = document.createElement('div');
    strip.className = t.cls;
    strip.dataset.resizeTarget = key;
    strip.setAttribute('role', 'separator');
    strip.setAttribute('aria-label', `Resize ${t.label}`);
    strip.title = 'Drag to resize · double-click to reset';
    t.el.style.position = 'relative';
    t.el.appendChild(strip);

    let active = false;
    let startX = 0, startY = 0, base = 0;

    const onDown = (e) => {
      if (!enabled() || e.button !== 0) return;
      active = true;
      startX = e.clientX;
      startY = e.clientY;
      base = cssVar(key === 'dockW' ? '--dock-w' : key === 'panelW' ? '--panel-w' : '--composer-h');
      strip.classList.add('au-dragging');
      document.body.classList.add('au-resizing');
      try { strip.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!active) return;
      const next = valueFromDrag(key, base, e.clientX - startX, e.clientY - startY);
      layout[key] = next;
      apply(key, next);
    };
    const onUp = () => {
      if (!active) return;
      active = false;
      strip.classList.remove('au-dragging');
      document.body.classList.remove('au-resizing');
      persistLayout(layout);
    };
    const onDbl = (e) => {
      e.preventDefault();
      layout[key] = LAYOUT_DEFAULTS[key];
      apply(key, LAYOUT_DEFAULTS[key]);
      persistLayout(layout);
    };

    strip.addEventListener('pointerdown', onDown);
    strip.addEventListener('pointermove', onMove);
    strip.addEventListener('pointerup', onUp);
    strip.addEventListener('pointercancel', onUp);
    strip.addEventListener('dblclick', onDbl);
    disposers.push(() => {
      strip.removeEventListener('pointerdown', onDown);
      strip.removeEventListener('pointermove', onMove);
      strip.removeEventListener('pointerup', onUp);
      strip.removeEventListener('pointercancel', onUp);
      strip.removeEventListener('dblclick', onDbl);
      strip.remove();
    });
  }

  // Apply the stored layout on boot, then keep visibility in sync.
  for (const [key, px] of Object.entries(layout)) apply(key, px);
  window.addEventListener('resize', syncEnabled);
  disposers.push(() => window.removeEventListener('resize', syncEnabled));
  syncEnabled();

  return () => { for (const d of disposers) d(); };
}

export default { initResizers, storedLayout, normalizeLayout, valueFromDrag,
                 defaults, clamp, LAYOUT_DEFAULTS, LAYOUT_LIMITS, MIN_WINDOW };
