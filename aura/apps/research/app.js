/**
 * AURA :: Web Research (popup)
 * =============================
 * Topic → live web research through the action bridge → summarized by the
 * configured model when asked. Same service the semantic router calls.
 *
 * @module apps/research
 */
import { field, textInput, select, checkbox, btn, statusBox, statusLine }
  from '../../js/features/kit.js';

export async function mount({ root, meta, prefill, ctx, close }) {
  const engine = ctx.engine, actions = ctx.actions;
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

  const topic = textInput(p.topic || '', 'e.g. latest AI news, Mars mission 2026…');
  card.append(field({ label: 'Research topic', input: topic }));

  const depth = select([{ value: 'quick', label: 'Quick' },
                        { value: 'adaptive', label: 'Adaptive' },
                        { value: 'deep', label: 'Deep (more sources)' }], d.depth || 'adaptive');
  card.append(field({ label: 'Depth', input: depth }));

  const results = select([3, 5, 8, 10].map(n => ({ value: n, label: `${n} sources` })),
                         d.results || 5);
  card.append(field({ label: 'Sources', input: results }));

  const summaryBox = checkbox('Summarize with the configured model', d.summarize !== false);
  card.append(summaryBox.wrap);

  const box = statusBox();
  card.append(box);

  const row = document.createElement('div');
  row.className = 'feature-actions';
  const go = btn('🔎 RESEARCH', 'btn');
  row.append(go);
  card.append(row);

  go.addEventListener('click', async () => {
    go.disabled = true;
    box.innerHTML = '';
    const t = topic.value.trim();
    if (!t) { statusLine(box, '✗ Give me a topic first.', 'err'); go.disabled = false; return; }
    try {
      statusLine(box, `▸ Researching "${t}" (${depth.value}, ${results.value} sources)…`);
      const r = await engine.runService('research', {
        topic: t, depth: depth.value, results: Number(results.value),
        summarize: summaryBox.cb.checked,
      });
      if (!r?.success) throw new Error(r?.message || 'Research failed.');
      statusLine(box, `✓ ${r.message}`, 'ok');
      ctx.toast?.('success', 'Research complete.');
    } catch (e) {
      statusLine(box, `✗ ${e?.message || e}`, 'err');
    } finally {
      go.disabled = false;
    }
  });
}
