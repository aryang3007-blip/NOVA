/**
 * AURA :: PPT Builder — the whole deck in a popup
 * ================================================
 * "Hey AURA, create a PPT on Mars for my holiday homework" → this card opens
 * with topic + audience prefilled. You pick: design (6 themes), length
 * (slider or exact number), outline model (any configured API key), AI
 * images (count/style/provider), slide transition + entrance animation.
 * AURA's subsystem builds it through the CANONICAL services.docgen.service —
 * the same code the terminal and tests call.
 *
 * @module apps/ppt-builder
 */
import { field, textInput, select, checkbox, slider, btn, statusBox, statusLine }
  from '../../js/features/kit.js';
import { FEATURE_MANIFEST } from '../../js/features/registry.js';

const THEME_SWATCHES = {
  'professional-dark': ['#0B101A', '#F2F5F9', '#E8B74A'],
  'professional-light': ['#FFFFFF', '#101824', '#B8861F'],
  academic: ['#FAF9F6', '#1B2A4A', '#1F4E9C'],
  minimal: ['#FFFFFF', '#161616', '#444444'],
  holiday: ['#102B1C', '#FFF7E6', '#F2B13D'],
  neon: ['#070A12', '#EDF3FF', '#38BDF8'],
};
const IMAGE_STYLES = ['flat illustration', 'photorealistic', '3d render',
                      'watercolor', 'line art', 'holiday'];

export async function mount({ root, meta, prefill, ctx, close }) {
  const engine = ctx.engine, actions = ctx.actions, config = ctx.config;
  const d = meta.defaults || {};
  const p = prefill || {};

  const card = document.createElement('div');
  card.className = 'feature-card';
  root.append(card);

  const head = document.createElement('div');
  head.className = 'feature-head';
  head.innerHTML = `<h3>${meta.icon} ${meta.label}</h3>`;
  const x = btn('✕', 'feature-close');
  x.addEventListener('click', close);
  head.append(x);
  card.append(head);

  const topic = textInput(p.topic || '', 'e.g. Solar System, Fats & Nutrition, My School…');
  card.append(field({ label: 'Topic', input: topic }));

  const audience = textInput(p.audience || '', 'e.g. holiday homework, class 10, investors');
  card.append(field({ label: 'Audience / purpose', input: audience }));

  const details = textInput(p.details || '', 'extra points to include — leave blank for auto');
  card.append(field({ label: 'Extra instructions', input: details }));

  // ── design ──
  const themes = FEATURE_MANIFEST.themes;
  const themeGrid = document.createElement('div');
  themeGrid.className = 'fk-grid';
  let chosenTheme = d.theme || 'professional-dark';
  for (const t of themes) {
    const c = document.createElement('div');
    c.className = `fk-theme${t === chosenTheme ? ' sel' : ''}`;
    const sw = document.createElement('div');
    sw.className = 'sw';
    sw.style.background = `linear-gradient(90deg, ${(THEME_SWATCHES[t] || ['#333', '#eee', '#38bdf8']).join(',')})`;
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = t.replace(/-/g, ' ');
    c.append(sw, nm);
    c.addEventListener('click', () => {
      chosenTheme = t;
      themeGrid.querySelectorAll('.fk-theme').forEach(x => x.classList.remove('sel'));
      c.classList.add('sel');
    });
    themeGrid.append(c);
  }
  card.append(field({ label: 'Design', input: themeGrid }));

  // ── length ──
  const countWrap = document.createElement('div');
  countWrap.style.display = 'flex';
  countWrap.style.gap = '.6rem';
  countWrap.style.alignItems = 'center';
  const countNum = textInput(String(p.slides || d.slides || 10), '');
  countNum.type = 'number';
  countNum.min = 3; countNum.max = 30;
  countNum.style.width = '72px';
  const range = slider(3, 30, Number(p.slides || d.slides || 10), (v) => { countNum.value = v; });
  countNum.addEventListener('input', () => {
    const v = Math.max(3, Math.min(30, Number(countNum.value) || 3));
    range.value = v;
  });
  countWrap.append(range, countNum);
  card.append(field({ label: 'Length (slides)', input: countWrap }));

  // ── outline model: ONE preconfigured model (manifest defaults.model) ──
  const pinModel = d.model || 'gemini-3.8-flash';
  const pinLine = document.createElement('div');
  pinLine.className = 'fk-pin';
  pinLine.innerHTML = `<span class="dot"></span> Outline model: <b>Google Gemini — ${pinModel}</b>
    <span class="fk-note">(preconfigured for documents · add the Gemini key in Settings → API Keys)</span>`;
  card.append(pinLine);

  // ── AI images ──
  const imgBox = checkbox('Generate AI images and embed them on visual slides',
                          d.images?.enabled !== false);
  const imgCount = select([1, 2, 3].map(n => ({ value: n, label: `${n} image${n > 1 ? 's' : ''}` })),
                          d.images?.count || 1);
  const imgStyle = select(IMAGE_STYLES.map(s => ({ value: s, label: s })),
                          d.images?.style || 'flat illustration');
  const imgProvOpts = FEATURE_MANIFEST.imageProviders.map(ip => {
    const has = !!config?.getKey?.(ip.id);
    return { value: ip.id, label: has ? ip.label : `${ip.label} (no key — add in Settings)` };
  });
  const imgProv = select(imgProvOpts, d.images?.provider || 'gemini');
  card.append(field({ label: 'Images', input: imgBox.wrap }));
  const imgRow = document.createElement('div');
  imgRow.style.display = 'flex';
  imgRow.style.gap = '.6rem';
  imgRow.style.flexWrap = 'wrap';
  imgRow.append(field({ label: 'Count', input: imgCount }),
                field({ label: 'Style', input: imgStyle }),
                field({ label: 'Provider', input: imgProv }));
  if (!imgBox.cb.checked) imgRow.style.display = 'none';
  imgBox.cb.addEventListener('change', () => { imgRow.style.display = imgBox.cb.checked ? '' : 'none'; });
  card.append(imgRow);

  // ── motion ──
  const transition = select(FEATURE_MANIFEST.transitions.map(t => ({ value: t, label: t })),
                            d.transition || 'fade');
  const speed = select([{ value: 'fast', label: 'fast' }, { value: 'med', label: 'medium' },
                        { value: 'slow', label: 'slow' }], d.speed || 'med');
  const animation = select(FEATURE_MANIFEST.animations.map(t => ({ value: t, label: t })),
                           d.animation || 'bounce');
  const motionRow = document.createElement('div');
  motionRow.style.display = 'flex';
  motionRow.style.gap = '.6rem';
  motionRow.style.flexWrap = 'wrap';
  motionRow.append(field({ label: 'Slide transition', input: transition }),
                   field({ label: 'Speed', input: speed }),
                   field({ label: 'Entrance animation', input: animation }));
  card.append(field({ label: 'Motion', input: motionRow }));

  // ── LIVE PROMPT PREVIEW: exactly what outline() sends (one builder) ──
  const promptBox = document.createElement('details');
  promptBox.className = 'fk-prompt';
  const pSum = document.createElement('summary');
  pSum.textContent = '👁 VIEW THE PROMPT AURA WILL SEND TO THE MODEL';
  const pPre = document.createElement('pre');
  pPre.className = 'fk-prompt-pre';
  const renderPrompt = async () => {
    const da = await import('../../js/ai/doc-agent.js');
    const p = da.buildPrompt({
      kind: 'pptx',
      topic: topic.value.trim() || 'Untitled',
      slides: Math.max(3, Math.min(30, Number(countNum.value) || d.slides || 10)),
      audience: audience.value.trim(),
      details: details.value.trim(),
    });
    pPre.textContent =
      `MODEL: gemini — ${pinModel} (preconfigured · thinking disabled · budget escalates on truncation)\n\n`
      + `──── SYSTEM ────\n${p.system}\n\n──── USER ────\n${p.user}`;
  };
  const refreshPrompt = () => { if (promptBox.open) renderPrompt(); };
  for (const el of [topic, audience, details, countNum]) {
    el.addEventListener('input', refreshPrompt);
  }
  promptBox.addEventListener('toggle', refreshPrompt);
  promptBox.append(pSum, pPre);
  card.append(promptBox);

  const box = statusBox();
  card.append(box);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'feature-actions';
  const genBtn = btn('⚡ GENERATE DECK', 'btn');
  const note = document.createElement('span');
  note.className = 'fk-note';
  note.textContent = 'Outline → design → AI images → motion, then saved to your Documents folder.';
  actionsRow.append(genBtn, note);
  card.append(actionsRow);

  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    box.innerHTML = '';
    const slides = Math.max(3, Math.min(30, Number(countNum.value) || d.slides || 10));
    const topicText = topic.value.trim() || 'Untitled';
    try {
      const docAgent = await import('../../js/ai/doc-agent.js');
      statusLine(box, `▸ Outlining "${topicText}" (${slides} slides, model: ${pinModel} preconfigured)…`);
      const o = await docAgent.outline({
        kind: 'pptx', topic: topicText, engine,
        slides, audience: audience.value.trim() || '',
        details: details.value.trim() || '',
      });
      if (!o?.ok) throw new Error(o?.message || 'Outline failed.');

      const spec = o.spec;
      const imgOn = imgBox.cb.checked;
      const imgCountN = Number(imgCount.value) || 1;
      if (imgOn) {
        statusLine(box, `▸ Preparing ${imgCountN} AI image slide(s) (${imgStyle.value}, ${imgProv.value})…`);
        const marker = `@gen:${imgStyle.value}`;
        const fillable = spec.slides.filter(s =>
          String(s.kind || '').toLowerCase() === 'image' && !s.image);
        let placed = 0;
        for (const s of fillable) {
          if (placed >= imgCountN) break;
          s.image = marker;
          placed++;
        }
        for (let i = placed; i < imgCountN; i++) {
          const title = ['Visual highlight', 'Visual', 'Key visual'][i - placed] || 'Visual';
          spec.slides.splice(Math.min(1 + i, spec.slides.length), 0,
            { kind: 'image', title, purpose: 'AI-generated visual',
              image: marker, notes: '' });
        }
      }

      const options = {
        theme: chosenTheme,
        transition: transition.value,
        speed: speed.value,
        animation: animation.value,
        images: imgOn
          ? { enabled: true, count: imgCountN, style: imgStyle.value, provider: imgProv.value }
          : { enabled: false },
      };
      statusLine(box, `▸ Rendering ${spec.slides.length} slides (design: ${chosenTheme})…`);
      const r = await actions.docBuild('pptx', spec, config.get('docFolder') || undefined, options);
      if (!r?.ok) throw new Error(r?.message || 'Build failed.');
      statusLine(box, `✓ ${r.message}`, 'ok');
      statusLine(box, `  ${r.path}  ·  ${(r.bytes / 1024).toFixed(1)} KB`, 'ok');
      const im = r.images || {};
      if (im.count) statusLine(box, `  • ${im.count} AI image(s) embedded`, 'ok');
      if (im.failed?.length) statusLine(box, `  • image skip: ${im.failed[0]}`, 'err');
      const mo = r.motion || {};
      if (mo.transitions?.applied) statusLine(box, `  • ${mo.transitions.applied} slide transitions (${mo.transitions.style})`, 'ok');
      if (mo.animation?.applied) statusLine(box, `  • entrance animation: ${mo.animation.effect}`, 'ok');
      ctx.toast?.('success', `PPT created — ${(r.bytes / 1024).toFixed(1)} KB`);
      ctx.audio?.sfx?.('confirm');
    } catch (e) {
      statusLine(box, `✗ ${e?.message || e}`, 'err');
      ctx.audio?.sfx?.('error');
    } finally {
      genBtn.disabled = false;
    }
  });
}
