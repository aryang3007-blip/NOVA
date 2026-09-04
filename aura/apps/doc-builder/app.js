/**
 * AURA :: Word / Spreadsheet Builder (popup)
 * ===========================================
 * Same subsystem as the PPT builder, param classes for docx + xlsx:
 * topic, audience, extra points, length. Uses the CANONICAL
 * services.docgen.service for output, so terminal and app agree.
 *
 * @module apps/doc-builder
 */
import { field, textInput, select, slider, btn, statusBox, statusLine }
  from '../../js/features/kit.js';

export async function mount({ root, meta, prefill, ctx, close }) {
  const engine = ctx.engine, actions = ctx.actions, config = ctx.config;
  const d = meta.defaults || {};
  const p = prefill || {};
  const isSpreadsheet = meta.kind === 'xlsx';

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

  const topic = textInput(p.topic || '', 'e.g. Monthly budget, Science fair report…');
  card.append(field({ label: isSpreadsheet ? 'What is this about' : 'Topic', input: topic }));
  const audience = textInput(p.audience || '', 'e.g. class 10, teacher, manager');
  card.append(field({ label: 'Audience / purpose', input: audience }));

  const numWrap = document.createElement('div');
  numWrap.style.display = 'flex';
  numWrap.style.gap = '.6rem';
  numWrap.style.alignItems = 'center';
  const numNum = textInput(String(p.slides || p.sections || d.sections ||
    d.sheets || (isSpreadsheet ? 1 : 6)), '');
  numNum.type = 'number';
  numNum.min = isSpreadsheet ? 1 : 3;
  numNum.max = isSpreadsheet ? 8 : 80;
  numNum.style.width = '72px';
  const range = slider(isSpreadsheet ? 1 : 3,
                       isSpreadsheet ? 8 : 16, Number(numNum.value),
    (v) => { numNum.value = v; });
  numNum.addEventListener('input', () => {
    const lo = isSpreadsheet ? 1 : 3;
    const hi = isSpreadsheet ? 8 : 80;
    const v = Math.max(lo, Math.min(hi, Number(numNum.value) || lo));
    range.value = Math.min(range.max, v);
  });
  numWrap.append(range, numNum);
  card.append(field({ label: isSpreadsheet ? 'Sheets' : 'Sections', input: numWrap }));

  const details = textInput(p.details || '', 'columns/points to include — auto when blank');
  card.append(field({ label: 'Extra instructions', input: details }));

  const box = statusBox();
  card.append(box);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'feature-actions';
  const genBtn = btn(isSpreadsheet ? '⚡ GENERATE WORKBOOK' : '⚡ GENERATE REPORT', 'btn');
  actionsRow.append(genBtn);
  card.append(actionsRow);

  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    box.innerHTML = '';
    const topicText = topic.value.trim() || 'Untitled';
    try {
      const docAgent = await import('../../js/ai/doc-agent.js');
      const n = Math.max(isSpreadsheet ? 1 : 3, Number(numNum.value) ||
        d.sections || d.sheets || (isSpreadsheet ? 1 : 6));
      statusLine(box, `▸ Outlining "${topicText}"…`);
      const o = await docAgent.outline({
        kind: meta.kind, topic: topicText, engine,
        slides: isSpreadsheet ? 0 : n,
        audience: audience.value.trim() || '',
        details: details.value.trim() || '',
      });
      if (!o?.ok) throw new Error(o?.message || 'Outline failed.');
      statusLine(box, `▸ Rendering ${meta.kind}…`);
      const r = await actions.docBuild(meta.kind, o.spec, config.get('docFolder') || undefined);
      if (!r?.ok) throw new Error(r?.message || 'Build failed.');
      statusLine(box, `✓ ${r.message}`, 'ok');
      statusLine(box, `  ${r.path}  ·  ${(r.bytes / 1024).toFixed(1)} KB`, 'ok');
      ctx.toast?.('success', `${meta.label}: done (${(r.bytes / 1024).toFixed(1)} KB)`);
    } catch (e) {
      statusLine(box, `✗ ${e?.message || e}`, 'err');
    } finally {
      genBtn.disabled = false;
    }
  });
}
