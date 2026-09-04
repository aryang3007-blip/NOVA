/**
 * NOVA :: feature-app UI kit
 * ===========================
 * Tiny DOM helpers shared by the feature popups (ppt-builder, doc-builder,
 * research). One visual language, zero framework.
 *
 * @module features/kit
 */

/** `<div class="fk-row"><label>…</label><input …></div>` */
export function field({ label = '', input, hint = '', cls = '' } = {}) {
  const row = document.createElement('label');
  row.className = `fk-field ${cls}`.trim();
  const lab = document.createElement('span');
  lab.className = 'fk-label';
  lab.textContent = label;
  row.append(lab, input);
  if (hint) {
    const h = document.createElement('div');
    h.className = 'fk-hint';
    h.textContent = hint;
    row.append(h);
  }
  return row;
}

export function textInput(value = '', placeholder = '') {
  const el = document.createElement('input');
  el.type = 'text';
  el.className = 'fk-input';
  el.value = value || '';
  el.placeholder = placeholder;
  return el;
}

export function select(options, value = '') {
  const el = document.createElement('select');
  el.className = 'fk-select';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === value) opt.selected = true;
    el.append(opt);
  }
  return el;
}

export function checkbox(label, checked = true) {
  const wrap = document.createElement('label');
  wrap.className = 'fk-check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(cb, span);
  return { wrap, cb };
}

export function slider(min, max, value, onChange) {
  const el = document.createElement('input');
  el.type = 'range';
  el.min = min; el.max = max; el.value = value;
  el.className = 'fk-range';
  el.addEventListener('input', () => onChange?.(Number(el.value)));
  return el;
}

export function btn(text, cls = 'btn') {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  return b;
}

export function statusBox() {
  const el = document.createElement('div');
  el.className = 'fk-status';
  return el;
}

export function statusLine(box, text, kind = '') {
  const d = document.createElement('div');
  d.className = `fk-line ${kind}`.trim();
  d.textContent = text;
  box.append(d);
  box.scrollTop = box.scrollHeight;
  return d;
}

/** Parse `for holiday homework` / `for my class 10 project` out of the request. */
export function splitAudience(text) {
  const t = String(text || '');
  const specific = /\bfor\s+(?:(?:my|the|our|your|a|an)\s+)?((?:holiday|summer|winter|diwali|class\s*\d*|school|college|homework|project|office|business|science)[^,.]*)$/i.exec(t.trim());
  // Anyone's the audience: "for monthly budget", "for my science homework",
  // "for class 10 teachers" — but never "for me/us/it/now".
  const generic = /\bfor\s+(?:(?:my|the|our|your|a|an)\s+)?((?!me\b|us\b|it\b|now\b)[^,.]{2,60})$/i.exec(t.trim());
  const m = specific || generic;
  if (!m) return { audience: '', rest: t.trim() };
  const audience = m[1].trim();
  const rest = t.slice(0, m.index).trim();
  return { audience, rest };
}
