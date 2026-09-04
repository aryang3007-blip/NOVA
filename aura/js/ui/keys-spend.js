/**
 * AURA :: Keys & Spend panel
 * ==========================
 * Functionality first, credits second: ONE page that owns
 *   • API keys (add / change / remove — mirrored into the OS vault)
 *   • daily spend budget (requests + images, 0 = unlimited)
 *   • usage ledger (what was called, when, and whether it worked)
 *   • database (path, size, schema version, backup, clear log)
 *
 * The ledger + budget live in the local SQLite DB (persistence/usage_repo).
 * All writes go through the same /api/db/* routes the rest of AURA uses.
 */

import { config } from '../core/config.js';
import { providerList } from '../ai/providers.js';
import { FEATURE_MANIFEST } from '../features/registry.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function redact(k) {
  if (!k) return '';
  if (k.length <= 10) return '••••';
  return `${k.slice(0, 4)}••••••••${k.slice(-4)}`;
}

export async function renderKeysSpend(host, { toast = () => {} } = {}) {
  if (!host) return;
  host.textContent = '';
  let pc = null;
  try {
    ({ persistenceClient: pc } = await import('../core/persistence-client.js'));
  } catch {}

  /* ── 1. API KEYS ─────────────────────────────────────────────────── */
  const keysCard = el('section', 'ks-card');
  keysCard.append(el('h3', 'ks-h', '🔑 API KEYS'));
  keysCard.append(el('p', 'ks-sub',
    'Keys are stored in this browser and mirrored into the encrypted OS vault. '
    + 'Chat + outlines use the provider keys; each IMAGES-ONLY row below is a '
    + 'SECOND key used strictly for image creation — two keys, two RPM budgets.'));

  const aiProviders = providerList().filter(p => p.needsKey);
  const imageProviders = FEATURE_MANIFEST.imageProviders || [];
  const keyRows = [];
  const addKeyRow = (prov, theme = 'ai', keyId = null) => {
    // keyId is the VAULT slot: image providers get their own slot so the
    // images-only key is STRICTLY separate from the chat/outline key.
    const slot = keyId || prov.id;
    const has = !!config.getKey(slot);
    const row = el('div', 'ks-row');
    const meta = el('div', 'ks-kmeta');
    meta.append(el('b', '', prov.label));
    const pos = el('span', `ks-kstatus ${has ? 'ok' : 'warn'}`, has ? '✓ SET' : '✗ NO KEY');
    meta.append(pos);
    if (theme === 'image') meta.append(el('span', 'ks-ktag', 'IMAGES ONLY'));
    row.append(meta);

    const inputs = el('div', 'ks-kinputs');
    const input = el('input', 'ks-input');
    input.type = 'password';
    input.placeholder = has ? redact(config.getKey(slot)) : `paste ${prov.label} key…`;
    input.autocomplete = 'off';
    const save = el('button', 'btn ks-btn', 'SAVE');
    const rm = el('button', 'btn ghost ks-btn', 'REMOVE');
    save.addEventListener('click', () => {
      const v = input.value.trim();
      if (!v) { toast('info', `${prov.label}: paste a key first — no empty saves.`); return; }
      config.setKey(slot, v);
      input.value = '';
      input.placeholder = redact(v);
      input.type = 'password';
      input.setAttribute('data-has', '1');
      pos.textContent = '✓ SET'; pos.className = 'ks-kstatus ok';
      toast('success', `${prov.label} key saved under '${slot}' (browser + vault).`);
    });
    rm.addEventListener('click', () => {
      config.setKey(slot, '');
      input.value = '';
      input.placeholder = `paste ${prov.label} key…`;
      pos.textContent = '✗ NO KEY'; pos.className = 'ks-kstatus warn';
      toast('info', `${prov.label} key removed.`);
    });
    inputs.append(input, save, rm);
    row.append(inputs);
    keyRows.push(row);
    return row;
  };
  for (const p of aiProviders) keysCard.append(addKeyRow(p));
  // Images always get their OWN row — even when the chat row exists for the
  // same provider (openai): strict separation is the whole point.
  for (const p of imageProviders) {
    keysCard.append(addKeyRow(
      { label: `${p.label} (image key)` },
      'image', p.keyId || p.id));
  }
  host.append(keysCard);

  /* ── 2. SPEND BUDGET ─────────────────────────────────────────────── */
  const budgetCard = el('section', 'ks-card');
  budgetCard.append(el('h3', 'ks-h', '🪙 DAILY SPEND BUDGET'));
  budgetCard.append(el('p', 'ks-sub',
    'Hard cap per day, checked BEFORE any call goes out — a quota error can '
    + 'never cost a request. 0 = unlimited. Keep it low: images cost the most.'));

  const budgetForm = el('div', 'ks-budget');
  const enabledRow = el('label', 'ks-check');
  const enabled = el('input');
  enabled.type = 'checkbox';
  enabledRow.append(enabled, el('span', '', 'Enforce budget'));
  const reqRow = el('label', 'ks-field');
  reqRow.append(el('span', '', 'API calls / day'));
  const reqInput = el('input', 'ks-input');
  reqInput.type = 'number'; reqInput.min = '0';
  reqRow.append(reqInput);
  const imgRow = el('label', 'ks-field');
  imgRow.append(el('span', '', 'AI images / day'));
  const imgInput = el('input', 'ks-input');
  imgInput.type = 'number'; imgInput.min = '0';
  imgRow.append(imgInput);
  const paceRow = el('label', 'ks-field');
  paceRow.append(el('span', '', 'Sec between images (RPM)'));
  const paceInput = el('input', 'ks-input');
  paceInput.type = 'number'; paceInput.min = '0'; paceInput.step = '1';
  paceRow.append(paceInput);
  const saveBudget = el('button', 'btn', 'SAVE BUDGET');
  const status = el('span', 'ks-status');
  budgetForm.append(enabledRow, reqRow, imgRow, paceRow, saveBudget, status);
  budgetCard.append(budgetForm);
  host.append(budgetCard);

  /* ── 3. USAGE ────────────────────────────────────────────────────── */
  const usageCard = el('section', 'ks-card');
  usageCard.append(el('h3', 'ks-h', '📊 USAGE TODAY'));
  const usageBody = el('div', 'ks-usage');
  usageCard.append(usageBody);
  host.append(usageCard);

  /* ── 4. DATABASE ─────────────────────────────────────────────────── */
  const dbCard = el('section', 'ks-card');
  dbCard.append(el('h3', 'ks-h', '🗄 DATABASE'));
  const dbBody = el('div', 'ks-db');
  const backupBtn = el('button', 'btn ghost', 'BACKUP NOW');
  const clearBtn = el('button', 'btn ghost ks-danger', 'CLEAR USAGE LOG');
  dbBody.append(backupBtn, clearBtn);
  dbCard.append(dbBody);
  host.append(dbCard);

  /* ── data + wiring ───────────────────────────────────────────────── */
  const fmt = (t) => {
    const d = new Date(t * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  async function refresh() {
    const summary = await pc?.getUsageSummary?.();
    const b = summary?.budget;
    if (b) {
      enabled.checked = !!b.enabled;
      reqInput.value = b.requestsPerDay ?? 0;
      imgInput.value = b.imagesPerDay ?? 0;
      paceInput.value = b.imageIntervalSec ?? 5;
    }
    const today = summary?.today || { total: 0, images: 0, errors: 0, providers: {} };
    const provs = Object.entries(today.providers || {});
    usageBody.textContent = '';
    usageBody.append(el('div', 'ks-stats', [
      `requests: ${today.total}`,
      `images: ${today.images}`,
      `errors: ${today.errors}`,
      `cap: ${b?.enabled ? `${b.requestsPerDay ?? 0}/${b.imagesPerDay ?? 0}` : 'off'}`,
    ].join('  ·  ')));
    if (provs.length) {
      const grid = el('div', 'ks-grid-stats');
      for (const [p, s] of provs) {
        grid.append(el('span', 'ks-kstatus ok', `${p}: ${s.requests} req · ${s.images} img`));
      }
      usageBody.append(grid);
    } else {
      usageBody.append(el('p', 'ks-sub', 'No calls recorded yet.'));
    }
    const recent = summary?.recent || [];
    if (recent.length) {
      const table = el('table', 'ks-table');
      const tr = el('tr');
      for (const h of ['time', 'provider', 'model', 'kind', 'status']) tr.append(el('th', '', h));
      table.append(tr);
      for (const r of recent) {
        const row = el('tr');
        row.append(el('td', '', fmt(r.ts)), el('td', '', r.provider),
                   el('td', 'ks-mono', r.model || '—'), el('td', '', r.kind),
                   el('td', `ks-kstatus ${r.status === 'ok' ? 'ok' : 'warn'}`, r.status));
        table.append(row);
      }
      usageBody.append(table);
    }
    // ── DB info (from the status route)
    try {
      const db = await pc?.isAvailable?.();
      const s = await fetch('/api/db/status', { cache: 'no-store' }).then(r => r.json()).catch(() => null);
      if (s?.ok) {
        dbBody.querySelectorAll('.ks-dbline').forEach(n => n.remove());
        const line = el('div', 'ks-dbline',
          `path: ${s.db?.path}  ·  schema v${s.db?.version}  ·  local DB`);
        dbBody.prepend(line);
      }
    } catch {}
  }

  saveBudget.addEventListener('click', async () => {
    const budget = {
      enabled: enabled.checked,
      requestsPerDay: Math.max(0, parseInt(reqInput.value, 10) || 0),
      imagesPerDay: Math.max(0, parseInt(imgInput.value, 10) || 0),
      imageIntervalSec: Math.max(0, parseInt(paceInput.value, 10) || 0),
    };
    const ok = await pc?.setBudget?.(budget);
    status.textContent = ok ? '✓ saved — enforced from the next call' : '✗ could not save (DB offline?)';
    status.className = 'ks-status ' + (ok ? 'ok' : 'warn');
    if (ok) toast('success', `Budget set: ${budget.requestsPerDay} requests / ${budget.imagesPerDay} images, ${budget.imageIntervalSec}s between images.`);
    refresh();
  });
  backupBtn.addEventListener('click', async () => {
    const path = await pc?.backupDb?.();
    toast(path ? 'success' : 'error', path ? `Backup saved: ${path}` : 'Backup failed (DB offline?)');
  });
  clearBtn.addEventListener('click', async () => {
    const ok = await pc?.clearUsage?.();
    toast(ok ? 'success' : 'error', ok ? 'Usage log cleared.' : 'Clear failed (DB offline?)');
    refresh();
  });

  await refresh();
  return host;
}
