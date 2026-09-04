/**
 * AURA :: PPT Builder — the whole deck in a popup
 * ================================================
 * "Hey AURA, create a PPT on Mars for my holiday homework" → this card opens
 * with topic + audience prefilled. You pick: design (6 themes, each tile is a
 * REAL miniature of the card built from the actual palette the builder uses),
 * length (slider or exact number), outline model (preconfigured — shown
 * explicitly, never a vague dropdown), AI images (count/style/provider AND
 * the exact image model), slide transition + entrance animation.
 * AURA's subsystem builds it through the CANONICAL services.docgen.service —
 * the same code the terminal and tests call.
 *
 * @module apps/ppt-builder
 */
import { field, textInput, select, checkbox, slider, btn, statusBox, statusLine }
  from '../../js/features/kit.js';
import { FEATURE_MANIFEST } from '../../js/features/registry.js';

const IMAGE_STYLES = ['flat illustration', 'photorealistic', '3d render',
                      'watercolor', 'line art', 'holiday'];

/** Real theme name → the popup heading, e.g. 'professional-dark'. */
function heading(t) {
  return t.replace(/-/g, ' ');
}

/** A miniature of the actual slide the builder paints for this theme. */
function miniCard(pal) {
  const c = document.createElement('div');
  c.className = 'fk-mini';
  c.style.background = pal.bg;
  c.style.color = pal.ink;
  const accent = document.createElement('div');
  accent.className = 'fk-mini-accent';
  accent.style.background = pal.accent;
  const title = document.createElement('div');
  title.className = 'fk-mini-title';
  title.textContent = 'Your Topic';
  c.append(accent, title);
  for (const line of ['Bullet one', 'Bullet two']) {
    const chip = document.createElement('div');
    chip.className = 'fk-mini-chip';
    chip.style.background = pal.panel;
    chip.style.color = pal.ink;
    chip.textContent = `• ${line}`;
    c.append(chip);
  }
  return c;
}

export async function mount({ root, meta, prefill, ctx, close }) {
  const engine = ctx.engine, actions = ctx.actions, config = ctx.config;
  const d = meta.defaults || {};
  const p = prefill || {};
  const previews = FEATURE_MANIFEST.themePreviews || {};

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

  // ── design: real mini-card previews in the ACTUAL theme palettes ──
  const themes = FEATURE_MANIFEST.themes;
  const themeGrid = document.createElement('div');
  themeGrid.className = 'fk-grid';
  let chosenTheme = d.theme || 'professional-dark';
  for (const t of themes) {
    const pal = previews[t] || { bg: '#101418', ink: '#e8eef5',
                                 accent: '#38bdf8', panel: '#1a2230' };
    const c = document.createElement('div');
    c.className = `fk-theme${t === chosenTheme ? ' sel' : ''}`;
    c.append(miniCard(pal));
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = heading(t);
    c.append(nm);
    c.addEventListener('click', () => {
      chosenTheme = t;
      themeGrid.querySelectorAll('.fk-theme').forEach(x => x.classList.remove('sel'));
      c.classList.add('sel');
    });
    themeGrid.append(c);
  }
  card.append(field({ label: 'Design — how your cards will look', input: themeGrid }));

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

  // ── outline model: the ONE preconfigured model, shown explicitly ──
  const pinModel = d.model || 'gemini-3.8-flash';
  const hasPinKey = !!(config?.getKey?.('gemini') || config?.data?.apiKeys?.gemini);
  const modelBox = document.createElement('div');
  modelBox.className = 'fk-model';
  modelBox.innerHTML = `
    <div class="fk-model-head"><span class="dot"></span> OUTLINE MODEL — PRE-CONFIGURED</div>
    <div class="fk-model-body">
      <span class="fk-prov-chip">Google Gemini</span>
      <b>${pinModel}</b>
      <span class="fk-tag ok">FIXED FOR DECKS</span>
    </div>
    <div class="fk-desc">Every deck outline is generated by this model — writing, slide
      structure and image prompts, in one pass.${hasPinKey
        ? ' <b>Your Gemini key is set</b> — outlines will use it.'
        : ' Add the <b>Gemini API key</b> in Settings → API Keys to enable outlines.'}</div>`;
  card.append(field({ label: 'Outline model (no guessing)', input: modelBox }));

  // ── AI images: pick provider AND the exact image model ──
  const imgBox = checkbox('Generate AI images and embed them on visual slides',
                          d.images?.enabled !== false);
  const imgCount = select([1, 2, 3].map(n => ({ value: n, label: `${n} image${n > 1 ? 's' : ''}` })),
                          d.images?.count || 1);
  const imgStyle = select(IMAGE_STYLES.map(s => ({ value: s, label: s })),
                          d.images?.style || 'flat illustration');
  const providers = FEATURE_MANIFEST.imageProviders || [];
  let chosenProv = d.images?.provider || providers[0]?.id || 'gemini';
  if (!providers.some(pr => pr.id === chosenProv)) chosenProv = providers[0]?.id || 'gemini';
  const provWrap = document.createElement('div');
  provWrap.className = 'fk-provs';
  const provCards = new Map();
  for (const ip of providers) {
    const has = !!(config?.getKey?.(ip.id) || config?.data?.apiKeys?.[ip.id]);
    const pc = document.createElement('div');
    pc.className = `fk-prov${ip.id === chosenProv ? ' sel' : ''}${has ? '' : ' nokey'}`;
    const h = document.createElement('div');
    h.className = 'fk-prov-head';
    const b = document.createElement('b');
    b.textContent = ip.label;
    const tag = document.createElement('span');
    tag.className = `fk-tag ${has ? 'ok' : 'warn'}`;
    tag.textContent = has ? '✓ KEY FOUND' : '⚠ NO KEY — ADD IN SETTINGS';
    h.append(b, tag);
    const sub = document.createElement('div');
    sub.className = 'fk-prov-sub';
    sub.textContent = ip.note || '';
    const models = document.createElement('div');
    models.className = 'fk-prov-models';
    for (const m of (ip.models || [])) {
      const ms = document.createElement('span');
      ms.className = 'fk-prov-model';
      ms.textContent = m.label;
      models.append(ms);
    }
    pc.append(h, sub, models);
    pc.addEventListener('click', () => {
      chosenProv = ip.id;
      provWrap.querySelectorAll('.fk-prov').forEach(x => x.classList.remove('sel'));
      pc.classList.add('sel');
      renderImageModels();
    });
    provCards.set(ip.id, pc);
    provWrap.append(pc);
  }

  const imgModel = select([], '');
  const imgModelNote = document.createElement('div');
  imgModelNote.className = 'fk-hint';
  function currentProvider() {
    return providers.find(pr => pr.id === chosenProv) || { models: [], model: '' };
  }
  function renderImageModels() {
    const ip = currentProvider();
    const opts = ip.models || [];
    imgModel.textContent = '';          // clear previous options (works everywhere)
    const want = (d.images?.provider === ip.id ? d.images?.model : '') ||
                 ip.model || opts[0]?.id || '';
    for (const m of opts) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label;
      if (m.id === want) o.selected = true;
      imgModel.append(o);
    }
    imgModel.style.display = opts.length > 1 ? '' : 'none';
    imgModelNote.textContent = ip.models?.find(m => m.id === imgModel.value)?.note || '';
  }
  imgModel.addEventListener('change', () => {
    imgModelNote.textContent = currentProvider().models
      ?.find(m => m.id === imgModel.value)?.note || '';
  });
  card.append(field({ label: 'Images', input: imgBox.wrap }));
  const imgRow = document.createElement('div');
  imgRow.className = 'fk-img-row';
  imgRow.append(field({ label: 'Count', input: imgCount }),
                field({ label: 'Style', input: imgStyle }));
  card.append(imgRow);
  const imgModelField = field({ label: 'Image model', input: imgModel });
  imgModelField.append(imgModelNote);
  card.append(imgModelField);
  renderImageModels();
  if (!imgBox.cb.checked) selfHide();
  imgBox.cb.addEventListener('change', () => selfHide());
  function selfHide() {
    const on = imgBox.cb.checked;
    imgRow.style.display = on ? '' : 'none';
    imgModelField.style.display = on ? '' : 'none';
    provWrap.style.display = on ? '' : 'none';
  }
  card.append(provWrap);

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
  card.append(field({ label: 'Motion — applied to every bullet', input: motionRow }));

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
      `MODEL: Google Gemini — ${pinModel} (preconfigured · thinking disabled · budget escalates on truncation)\n\n`
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
      const imgModelId = imgModel.value || currentProvider().model;
      const provLabel = currentProvider().label || chosenProv;
      if (imgOn) {
        statusLine(box, `▸ Preparing ${imgCountN} AI image slide(s) (${imgStyle.value}, ${provLabel} → ${imgModelId})…`);
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
          ? { enabled: true, count: imgCountN, style: imgStyle.value,
              provider: chosenProv, model: imgModelId }
          : { enabled: false },
      };
      statusLine(box, `▸ Rendering ${spec.slides.length} slides (design: ${chosenTheme})…`);
      const r = await actions.docBuild('pptx', spec, config.get('docFolder') || undefined, options);
      if (!r?.ok) throw new Error(r?.message || 'Build failed.');
      statusLine(box, `✓ ${r.message}`, 'ok');
      statusLine(box, `  ${r.path}  ·  ${(r.bytes / 1024).toFixed(1)} KB`, 'ok');
      const im = r.images || {};
      if (im.count) statusLine(box, `  • ${im.count} AI image(s) embedded (${imgModelId})`, 'ok');
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
