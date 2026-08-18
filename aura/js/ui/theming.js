/**
 * AURA :: Theming Engine
 * ======================
 * Everything visual, driven by CSS custom properties on `<html>`.
 *
 * WHY CSS VARIABLES
 * -----------------
 * The whole UI — including canvas overlays, the avatar's ground ring and the
 * particle field — already reads `--accent` / `--accent-rgb`. Writing one
 * variable therefore restyles the app *and* the WebGL scene in the same frame,
 * with no re-render and no component knowing a theme system exists.
 *
 * A preset is just a bundle of these variables. A custom look is the same
 * bundle with user overrides layered on top, so "preset" and "custom" are the
 * same code path — there is no second implementation to keep in sync.
 *
 * @module ui/theming
 */

/** Built-in colour presets. `null` background means "keep the preset's own". */
export const THEME_PRESETS = {
  // Near-black + warm gold: the command-centre identity. Backgrounds are
  // deliberately NEUTRAL black rather than brown-tinted — a warm background
  // plus a warm accent muddies both, so the gold only appears in the accent,
  // borders and glow, exactly where it carries meaning.
  'aura-gold':    { label: 'Command Gold', accent: '#f5b23c', accent2: '#ff8a3c', bg0: '#050505', bg1: '#0b0b0c', bg2: '#131314', text: '#f4f1ea', textDim: '#8d8a82' },
  'aura-blue':    { label: 'Aura Blue',   accent: '#38bdf8', accent2: '#818cf8', bg0: '#06080d', bg1: '#0a0e16', bg2: '#0f1420', text: '#e8eef5', textDim: '#7d8da3' },
  'aura-amber':   { label: 'Amber',       accent: '#ffa726', accent2: '#ff5722', bg0: '#140a03', bg1: '#26160a', bg2: '#361f0a', text: '#ffe8c9', textDim: '#c39a6b' },
  'aura-crimson': { label: 'Crimson',     accent: '#ff4d6d', accent2: '#c026d3', bg0: '#14030a', bg1: '#260a16', bg2: '#360a1f', text: '#ffd9e2', textDim: '#c37f92' },
  'aura-emerald': { label: 'Emerald',     accent: '#34d399', accent2: '#06b6d4', bg0: '#03140d', bg1: '#0a261a', bg2: '#0a3624', text: '#ccffe9', textDim: '#6bc39c' },
  'aura-violet':  { label: 'Violet',      accent: '#a78bfa', accent2: '#f472b6', bg0: '#0a0314', bg1: '#160a26', bg2: '#1f0a36', text: '#e6dbff', textDim: '#9d8bc3' },
  'aura-mono':    { label: 'Mono',        accent: '#e2e8f0', accent2: '#94a3b8', bg0: '#08090b', bg1: '#121417', bg2: '#1b1e23', text: '#e6eaf0', textDim: '#8c96a3' },
  'aura-sunset':  { label: 'Sunset',      accent: '#fb7185', accent2: '#fbbf24', bg0: '#140507', bg1: '#260d12', bg2: '#36141c', text: '#ffe4e6', textDim: '#c78e93' },
  'aura-ice':     { label: 'Ice',         accent: '#7dd3fc', accent2: '#c4b5fd', bg0: '#04090f', bg1: '#0a1620', bg2: '#0f2130', text: '#e0f2fe', textDim: '#7a9bb3' },
  'aura-matrix':  { label: 'Matrix',      accent: '#4ade80', accent2: '#a3e635', bg0: '#020604', bg1: '#04120a', bg2: '#061c0e', text: '#d9ffe4', textDim: '#5f9c73' },
  'aura-light':   { label: 'Daylight',    accent: '#0284c7', accent2: '#7c3aed', bg0: '#eef2f7', bg1: '#f7f9fc', bg2: '#ffffff', text: '#0f172a', textDim: '#5b6b80', light: true },
};

/** Background treatments for the app shell. */
export const BACKGROUNDS = {
  gradient: { label: 'Gradient',   css: 'radial-gradient(ellipse at 50% -20%, var(--bg-2) 0%, var(--bg-0) 70%)' },
  flat:     { label: 'Flat',       css: 'var(--bg-0)' },
  aurora:   { label: 'Aurora',     css: 'radial-gradient(60% 50% at 20% 0%, rgba(var(--accent-rgb),.18) 0%, transparent 60%), radial-gradient(50% 50% at 85% 15%, rgba(var(--accent-2-rgb),.16) 0%, transparent 60%), var(--bg-0)' },
  grid:     { label: 'Grid',       css: 'linear-gradient(rgba(var(--accent-rgb),.05) 1px, transparent 1px) 0 0/40px 40px, linear-gradient(90deg, rgba(var(--accent-rgb),.05) 1px, transparent 1px) 0 0/40px 40px, var(--bg-0)' },
  vignette: { label: 'Vignette',   css: 'radial-gradient(ellipse at 50% 50%, var(--bg-1) 0%, var(--bg-0) 55%, #000 130%)' },
  scanline: { label: 'Scanlines',  css: 'repeating-linear-gradient(0deg, rgba(var(--accent-rgb),.035) 0 1px, transparent 1px 3px), var(--bg-0)' },
};

/** HUD corner-bracket styles. */
export const HUD_STYLES = {
  brackets: { label: 'Corner brackets' },
  frame:    { label: 'Full frame' },
  minimal:  { label: 'Minimal' },
  none:     { label: 'None' },
};

/** Density presets — drive spacing and the panel/dock widths. */
export const DENSITIES = {
  comfortable: { label: 'Comfortable', scale: 1.00, panelW: 400, dockW: 66, topH: 52 },
  compact:     { label: 'Compact',     scale: 0.92, panelW: 340, dockW: 58, topH: 46 },
  spacious:    { label: 'Spacious',    scale: 1.10, panelW: 460, dockW: 76, topH: 60 },
};

/** Every tunable, with its bounds and the CSS variable it writes. */
export const TUNABLES = {
  accentHue:     { label: 'Accent hue shift', min: -180, max: 180, step: 1,    unit: '°', def: 0 },
  glassBlur:     { label: 'Glass blur',       min: 0,   max: 40,   step: 1,    unit: 'px', def: 18, css: '--glass-blur', suffix: 'px' },
  panelOpacity:  { label: 'Panel opacity',    min: 0.2, max: 1,    step: 0.02, unit: '',   def: 0.78 },
  glowStrength:  { label: 'Glow strength',    min: 0,   max: 1,    step: 0.02, unit: '',   def: 0.22 },
  cornerRadius:  { label: 'Corner radius',    min: 0,   max: 28,   step: 1,    unit: 'px', def: 14, css: '--r', suffix: 'px' },
  fontScale:     { label: 'Text size',        min: 0.8, max: 1.3,  step: 0.02, unit: '×',  def: 1 },
  animSpeed:     { label: 'Animation speed',  min: 0.2, max: 2,    step: 0.05, unit: '×',  def: 1 },
  bgIntensity:   { label: 'Background depth', min: 0,   max: 1.6,  step: 0.05, unit: '',   def: 1 },
};

/** Widgets the user can hide. Keys map to DOM ids or selectors. */
export const WIDGETS = {
  clock:     { label: 'Clock',           sel: '#cc-clock, #stat-clock' },
  stats:     { label: 'Top stat strip',  sel: '.tb-stats' },
  caption:   { label: 'Avatar caption',  sel: '#caption' },
  hud:       { label: 'HUD brackets',    sel: '.hud-corner' },
  particles: { label: 'Particle field',  sel: '#fx-canvas' },
  activity:  { label: 'Live activity',   sel: '#live-activity' },
  dockLabels:{ label: 'Dock labels',     sel: '.dock-lbl' },
};

/* ── colour helpers ──────────────────────────────────────────────────── */

/** '#38bdf8' → [56,189,248] */
export function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n) || full.length !== 6) return [56, 189, 248];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Rotate a colour's hue. Used by the accentHue slider. */
export function shiftHue(hex, deg) {
  if (!deg) return hex;
  let [r, g, b] = hexToRgb(hex).map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  h = (h + deg / 360 + 1) % 1;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return rgbToHex(hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255);
}

/* ── the engine ──────────────────────────────────────────────────────── */

/**
 * Resolve a full appearance config into CSS variables + attributes.
 * Pure: takes config, returns what to apply. That makes it testable without
 * a DOM, which is how the test suite verifies every preset.
 *
 * @param {object} cfg values from config.get()
 * @returns {{vars:Record<string,string>, attrs:Record<string,string>, bg:string}}
 */
export function resolveTheme(cfg = {}) {
  const presetId = cfg.theme && THEME_PRESETS[cfg.theme] ? cfg.theme : 'aura-blue';
  const preset = THEME_PRESETS[presetId];
  const num = (k) => {
    const t = TUNABLES[k];
    const v = cfg[k];
    if (v === undefined || v === null || Number.isNaN(Number(v))) return t.def;
    return Math.max(t.min, Math.min(t.max, Number(v)));
  };

  // Custom accent overrides the preset entirely; the hue slider then shifts it.
  const baseAccent = cfg.customAccent || preset.accent;
  const baseAccent2 = cfg.customAccent2 || preset.accent2;
  const hue = num('accentHue');
  const accent = shiftHue(baseAccent, hue);
  const accent2 = shiftHue(baseAccent2, hue);
  const [ar, ag, ab] = hexToRgb(accent);
  const [br, bg_, bb] = hexToRgb(accent2);

  const panelOpacity = num('panelOpacity');
  const glow = num('glowStrength');
  const blur = num('glassBlur');
  const radius = num('cornerRadius');
  const fontScale = num('fontScale');
  const anim = num('animSpeed');
  const bgI = num('bgIntensity');

  const density = DENSITIES[cfg.density] || DENSITIES.comfortable;
  const [p0r, p0g, p0b] = hexToRgb(preset.bg1);

  const vars = {
    '--accent': accent,
    '--accent-2': accent2,
    '--accent-rgb': `${ar}, ${ag}, ${ab}`,
    '--accent-2-rgb': `${br}, ${bg_}, ${bb}`,
    '--bg-0': preset.bg0,
    '--bg-1': preset.bg1,
    '--bg-2': preset.bg2,
    '--text': preset.text,
    '--text-dim': preset.textDim,
    '--panel': `rgba(${p0r}, ${p0g}, ${p0b}, ${panelOpacity.toFixed(3)})`,
    '--glass-blur': `${blur}px`,
    '--glow': `0 0 ${Math.round(12 + glow * 40)}px rgba(${ar}, ${ag}, ${ab}, ${glow.toFixed(3)})`,
    '--glow-strength': String(glow),
    '--r': `${radius}px`,
    '--font-scale': String(fontScale),
    '--anim-scale': String(anim === 0 ? 0.001 : 1 / anim),
    '--bg-intensity': String(bgI),
    '--panel-w': `${Math.round(density.panelW * fontScale)}px`,
    '--dock-w': `${Math.round(density.dockW * fontScale)}px`,
    '--top-h': `${Math.round(density.topH * fontScale)}px`,
    '--density': String(density.scale),
  };

  const bgKey = BACKGROUNDS[cfg.background] ? cfg.background : 'gradient';
  const attrs = {
    'data-theme': presetId,
    'data-bg': bgKey,
    'data-hud': HUD_STYLES[cfg.hudStyle] ? cfg.hudStyle : 'brackets',
    'data-density': DENSITIES[cfg.density] ? cfg.density : 'comfortable',
    'data-light': preset.light ? 'true' : 'false',
  };

  return { vars, attrs, bg: BACKGROUNDS[bgKey].css };
}

/**
 * Apply a resolved theme to the document.
 * @param {object} cfg
 * @param {Document} [doc]
 */
export function applyTheme(cfg, doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return null;
  const resolved = resolveTheme(cfg);
  const root = doc.documentElement;
  for (const [k, v] of Object.entries(resolved.vars)) root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(resolved.attrs)) root.setAttribute(k, v);
  root.style.setProperty('--app-bg', resolved.bg);

  // Widget visibility, driven by data attributes so CSS does the hiding.
  const hidden = Array.isArray(cfg.hiddenWidgets) ? cfg.hiddenWidgets : [];
  for (const key of Object.keys(WIDGETS)) {
    root.setAttribute(`data-hide-${key.toLowerCase()}`, hidden.includes(key) ? 'true' : 'false');
  }
  return resolved;
}

/** Everything the settings page needs to build its controls. */
export function themeCatalog() {
  return {
    presets: Object.entries(THEME_PRESETS).map(([id, p]) => ({ id, ...p })),
    backgrounds: Object.entries(BACKGROUNDS).map(([id, b]) => ({ id, label: b.label })),
    hudStyles: Object.entries(HUD_STYLES).map(([id, h]) => ({ id, label: h.label })),
    densities: Object.entries(DENSITIES).map(([id, d]) => ({ id, label: d.label })),
    tunables: Object.entries(TUNABLES).map(([id, t]) => ({ id, ...t })),
    widgets: Object.entries(WIDGETS).map(([id, w]) => ({ id, label: w.label })),
  };
}

/** Defaults for every tunable — used by the Reset button. */
export function themeDefaults() {
  const out = { theme: 'aura-blue', background: 'gradient', hudStyle: 'brackets',
                density: 'comfortable', customAccent: '', customAccent2: '', hiddenWidgets: [] };
  for (const [id, t] of Object.entries(TUNABLES)) out[id] = t.def;
  return out;
}

export default { THEME_PRESETS, BACKGROUNDS, HUD_STYLES, DENSITIES, TUNABLES, WIDGETS,
                 resolveTheme, applyTheme, themeCatalog, themeDefaults, shiftHue, hexToRgb, rgbToHex };
