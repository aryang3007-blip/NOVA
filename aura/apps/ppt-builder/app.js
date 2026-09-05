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

  // ── Images & Visuals: SEARCH FIRST, generate when needed ──
  const imgBox = checkbox('Automatically find or generate visuals for your slides',
                          d.images?.enabled !== false);
  const imgMode = d.images?.mode || 'smart';
  const MODE_PICKS = [
    ['smart', 'Smart — search first, generate when needed'],
    ['web', 'Web / image library only'],
    ['ai', 'AI generation only'],
    ['none', 'No external images'],
  ];
  const modeWrap = document.createElement('div');
  modeWrap.className = 'fk-mode';
  for (const [val, lab] of MODE_PICKS) {
    const id = `vmode-${val}`;
    const row = document.createElement('label');
    row.className = 'fk-mode-row';
    const r = document.createElement('input');
    r.type = 'radio'; r.name = 'vmode'; r.value = val; r.id = id;
    if (val === imgMode) r.checked = true;
    const sp = document.createElement('span');
    sp.textContent = lab;
    row.append(r, sp);
    modeWrap.append(row);
  }
  const srcPrefWrap = document.createElement('div');
  srcPrefWrap.className = 'fk-srcpref';
  const srcPref = select(
    [{ value: 'auto', label: 'Source preference: Auto (authoritative first)' },
     { value: 'nasa', label: 'NASA first (authoritative)' },
     { value: 'wikimedia', label: 'Wikimedia Commons first' },
     { value: 'openverse', label: 'Openverse (CC) first' },
     { value: 'general', label: 'General web search first' }],
    d.images?.sourcePreference || 'auto');
  const srcHint = document.createElement('span');
  srcHint.className = 'fk-mode-note';
  srcHint.textContent = 'Photo/reference visuals are searched first; AI generation is only a fallback.';
  srcPrefWrap.append(srcPref, srcHint);
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
  const keyOf = (ip) => ip.keyId || ip.id;
  const hasImageKey = (ip) =>
    !!(config?.getKey?.(keyOf(ip)) || config?.data?.apiKeys?.[keyOf(ip)]);
  for (const ip of providers) {
    const has = hasImageKey(ip);
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
      refreshKeyUI();
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
  card.append(field({ label: 'Images & Visuals — visual source', input: imgBox.wrap }));
  card.append(field({ label: 'Visual source', input: modeWrap }));
  const srcPrefField = field({ label: 'Image search', input: srcPrefWrap });
  card.append(srcPrefField);
  const imgRow = document.createElement('div');
  imgRow.className = 'fk-img-row';
  imgRow.append(field({ label: 'Visuals to find/generate', input: imgCount }),
                field({ label: 'Style (AI fallback)', input: imgStyle }));
  card.append(imgRow);
  const imgModelField = field({ label: 'Image model', input: imgModel });
  imgModelField.append(imgModelNote);
  card.append(imgModelField);
  // ── spend visibility: what is allowed TODAY, checked before every call ──
  const quotaLine = document.createElement('div');
  quotaLine.className = 'fk-hint';
  card.append(quotaLine);
  const refreshQuota = async () => {
    try {
      const { usageGuard, usageSnapshot } = await import('../../js/ai/doc-agent.js');
      const [g, snap] = await Promise.all([usageGuard('image'), usageSnapshot()]);
      if (!snap?.budget) return;
      const pace = Number(snap.budget.imageIntervalSec) || 0;
      quotaLine.textContent = g.allowed
        ? `Spend: ${g.used} image(s) used today of ${g.cap || 'unlimited'}`
          + (pace > 0 ? ` · ${pace}s between images (RPM guard)` : '')
          + ' — images use their OWN key, never the chat key.'
        : `⚠ ${g.message}`;
      quotaLine.classList.toggle('warn', !g.allowed);
    } catch {}
  };
  refreshQuota();
  renderImageModels();

  // ── IMAGES-ONLY KEY: strictly separate from the outline/chat key ──
  //    (the 3.8-flash key keeps its own RPM budget; images burn their own)
  let refreshKeyUI = () => {};
  const imgKeyBox = document.createElement('div');
  imgKeyBox.className = 'fk-imgkey';
  const imgKeyInput = document.createElement('input');
  imgKeyInput.type = 'password';
  imgKeyInput.className = 'fk-input';
  imgKeyInput.autocomplete = 'off';
  imgKeyInput.placeholder = 'paste the IMAGE key…';
  const imgKeySave = btn('SAVE', 'btn');
  const imgKeyState = document.createElement('span');
  imgKeyState.className = 'fk-tag warn';
  imgKeyState.textContent = '⚠ no image key';
  imgKeyBox.append(imgKeyInput, imgKeySave, imgKeyState);
  refreshKeyUI = () => {
    const ip = currentProvider();
    const kId = keyOf(ip);
    const has = hasImageKey(ip);
    imgKeyState.textContent = has ? `✓ ${kId} key set` : `⚠ no ${kId} key`;
    imgKeyState.className = `fk-tag ${has ? 'ok' : 'warn'}`;
    imgKeyInput.placeholder = has ? `replace the ${kId} key…` : `paste the ${kId} key…`;
  };
  imgKeySave.addEventListener('click', () => {
    const v = imgKeyInput.value.trim();
    if (!v) { ctx.toast?.('info', 'Paste the image key first — no empty saves.'); return; }
    config.setKey(keyOf(currentProvider()), v);
    imgKeyInput.value = '';
    refreshKeyUI();
    provCards.forEach(pc => {
      const tag = pc.querySelector('.fk-tag');
      if (tag) {
        tag.textContent = '✓ KEY FOUND';
        tag.className = 'fk-tag ok';
      }
    });
    ctx.toast?.('success', 'Image-only key saved — used ONLY for image creation.');
  });
  const imgKeyField = field({ label: 'Image-only API key — used ONLY for images',
                              input: imgKeyBox });
  imgKeyField.querySelector('.fk-hint')?.remove();
  card.append(imgKeyField);
  imgKeyField.style.display = imgBox.cb.checked ? '' : 'none';

  const modeNow = () => modeWrap.querySelector('input:checked')?.value || 'smart';
  if (!imgBox.cb.checked) selfHide();
  imgBox.cb.addEventListener('change', () => selfHide());
  modeWrap.addEventListener('change', () => selfHide());
  function selfHide() {
    const on = imgBox.cb.checked;
    const m = modeNow();
    imgRow.style.display = on ? '' : 'none';
    imgModelField.style.display = on && m === 'ai' ? '' : 'none';
    provWrap.style.display = on && m === 'ai' ? '' : 'none';
    imgKeyField.style.display = on && m === 'ai' ? '' : 'none';
    srcPrefField.style.display = on && (m === 'smart' || m === 'web') ? '' : 'none';
    srcHint.textContent = m === 'web'
      ? 'Only web/image-library search is used — AI generation is never called.'
      : 'Photo/reference visuals are searched first; AI generation is only a fallback.';
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
      const vMode = modeNow();
      if (imgOn) {
        statusLine(box, `▸ Resolving ${imgCountN} visual(s) — search first, generate when needed…`);
        const fillable = spec.slides.filter(s =>
          String(s.kind || '').toLowerCase() === 'image' && !s.image);
        let placed = 0;
        if (vMode === 'ai') {
          // explicit generation: the ONLY mode that writes @gen markers
          const marker = `@gen:${imgStyle.value}`;
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
        } else if (vMode !== 'none') {
          // smart/web: describe WHAT is needed; the engine decides HOW.
          // The outline usually supplies the structured `visual` — only add
          // the required flag when the outline left an image slide bare.
          for (const s of fillable) {
            if (placed >= imgCountN) break;
            s.visual = { required: true, type: 'photo',
                         search_query: s.purpose || `${topicText} ${s.title || ''}` };
            placed++;
          }
          for (let i = placed; i < imgCountN; i++) {
            const title = ['Visual highlight', 'Visual', 'Key visual'][i - placed] || 'Visual';
            spec.slides.splice(Math.min(1 + i, spec.slides.length), 0,
              { kind: 'image', title, purpose: `visual for ${topicText}`,
                visual: { required: true, type: 'photo',
                          search_query: `${topicText} ${title}` },
                notes: '' });
          }
        }
        // mode 'none': no external visuals are added at all.
      }

      const options = {
        theme: chosenTheme,
        transition: transition.value,
        speed: speed.value,
        animation: animation.value,
        images: imgOn
          ? { enabled: true, count: imgCountN, style: imgStyle.value,
              provider: chosenProv, model: imgModelId,
              mode: vMode, sourcePreference: srcPref.value }
          : { enabled: false },
      };
      statusLine(box, `▸ Rendering ${spec.slides.length} slides (design: ${chosenTheme})…`);
      const r = await actions.docBuild('pptx', spec, config.get('docFolder') || undefined, options);
      if (!r?.ok) throw new Error(r?.message || 'Build failed.');
      statusLine(box, `✓ ${r.message}`, 'ok');
      statusLine(box, `  ${r.path}  ·  ${(r.bytes / 1024).toFixed(1)} KB`, 'ok');
      const im = r.images || {};
      const vsrc = im.sources || {};
      if (vsrc.web) statusLine(box, `  • ${vsrc.web} visual(s) found by image search`, 'ok');
      if (vsrc.ai) statusLine(box, `  • ${vsrc.ai} AI image(s) generated (${imgModelId})`, 'ok');
      if (im.native?.length) statusLine(box, `  • ${im.native.length} native visual(s) drawn (no API call)`, 'ok');
      if (im.count) statusLine(box, `  • ${im.count} visual(s) embedded`, 'ok');
      if (im.failed?.length) statusLine(box, `  • visual skip: ${im.failed[0]}`, 'err');
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
