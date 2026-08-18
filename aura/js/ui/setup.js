/**
 * AURA :: First-run Setup Wizard
 * ------------------------------
 * Shown when no AI backend is configured. Three explicit choices:
 *
 *   1. Ollama  — auto-detected; if a model is missing AURA installs one
 *                for you with a real progress bar (no terminal needed).
 *   2. API key — paste a key from any supported provider, tested live.
 *   3. Offline — continue on the built-in core.
 *
 * Every path ends with a real connection test, so the user never lands in
 * a chat that silently fails.
 */

import { config } from '../core/config.js';
import { ollama } from '../ai/providers.js';
import { escapeHtml } from './markdown.js';

const KEY_PROVIDERS = [
  { id: 'groq', label: 'Groq', badge: 'FREE · FASTEST', docs: 'https://console.groq.com/keys',
    note: 'Free tier, ~300 tokens/sec. Best pick for snappy replies.' },
  { id: 'gemini', label: 'Google Gemini', badge: 'FREE TIER', docs: 'https://aistudio.google.com/apikey',
    note: 'Generous free quota, strong quality.' },
  { id: 'openai', label: 'OpenAI', badge: 'PAID', docs: 'https://platform.openai.com/api-keys',
    note: 'GPT-4o-mini is cheap and fast.' },
  { id: 'anthropic', label: 'Anthropic', badge: 'PAID', docs: 'https://console.anthropic.com/settings/keys',
    note: 'Claude Haiku is quick; Sonnet is stronger.' },
  { id: 'openrouter', label: 'OpenRouter', badge: 'MANY MODELS', docs: 'https://openrouter.ai/keys',
    note: 'One key, hundreds of models.' },
];

export class SetupWizard {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.pulling = false;
    this.pullAbort = null;
  }

  /** Should the wizard appear? Only when nothing is configured. */
  static needed() {
    if (config.get('setupDone')) return false;
    const hasKey = KEY_PROVIDERS.some(p => config.getKey(p.id));
    return !hasKey;
  }

  async open({ forced = false } = {}) {
    if (this.el) this.close();
    const host = document.createElement('div');
    host.className = 'setup';
    host.innerHTML = this._skeleton(forced);
    document.body.appendChild(host);
    this.el = host;

    host.querySelector('[data-act="skip"]')?.addEventListener('click', () => this.finish('local'));
    host.querySelector('.setup-close')?.addEventListener('click', () => this.close());

    this._wireKeys();
    await this._refreshOllama();
    return host;
  }

  close() {
    try { this.pullAbort?.abort(); } catch {}
    this.el?.remove();
    this.el = null;
    // Never leave the user staring at an empty chat.
    this.app.greet?.();
  }

  finish(provider) {
    config.set({ provider, setupDone: true });
    try { this.pullAbort?.abort(); } catch {}
    this.el?.remove();
    this.el = null;
    this.app.ai.resolve().then(() => {
      this.app.toast('success', `AI core ready: ${this.app.ai.providerLabel}`);
      this.app.syncAll?.();
      this.app.greet?.();      // greet AFTER the provider is known
    });
  }

  _skeleton(forced) {
    return `
    <div class="setup-backdrop"></div>
    <div class="setup-box" role="dialog" aria-modal="true" aria-label="AURA setup">
      ${forced ? '<button class="setup-close icon-btn" aria-label="Close">✕</button>' : ''}
      <header class="setup-h">
        <h2>CONNECT A BRAIN</h2>
        <p>AURA needs a language model to think. Pick one — you can change it any time in Settings.</p>
      </header>

      <div class="setup-grid">
        <!-- OLLAMA -->
        <section class="setup-card" data-card="ollama">
          <div class="setup-card-h">
            <h3>Run locally</h3>
            <span class="setup-badge good">FREE · PRIVATE</span>
          </div>
          <p class="setup-note">Nothing leaves your machine. Best for fast, cheap replies.</p>
          <div id="setup-ollama" class="setup-body"><div class="setup-spin">Checking for Ollama…</div></div>
        </section>

        <!-- API KEY -->
        <section class="setup-card" data-card="key">
          <div class="setup-card-h">
            <h3>Use an API key</h3>
            <span class="setup-badge">CLOUD</span>
          </div>
          <p class="setup-note">Strongest reasoning. Key is stored only in this browser.</p>
          <div class="setup-body">
            <label class="field">
              <span>Provider</span>
              <select id="setup-prov">
                ${KEY_PROVIDERS.map(p => `<option value="${p.id}">${p.label} — ${p.badge}</option>`).join('')}
              </select>
            </label>
            <p class="setup-hint" id="setup-prov-note"></p>
            <label class="field">
              <span>API key <a id="setup-getkey" href="#" target="_blank" rel="noopener">get one ↗</a></span>
              <input id="setup-key" type="password" placeholder="paste key here" autocomplete="off">
            </label>
            <button id="setup-key-go" class="btn wide">CONNECT &amp; TEST</button>
            <pre id="setup-key-out" class="setup-out" hidden></pre>
          </div>
        </section>
      </div>

      <footer class="setup-f">
        <button data-act="skip" class="btn ghost">Skip — use offline core</button>
        <span class="setup-foot-note">The offline core does maths, units, dates, memory and vision, but it is not a language model.</span>
      </footer>
    </div>`;
  }

  /* ── Ollama pane ─────────────────────────────────────────────────── */

  async _refreshOllama() {
    const box = this.el?.querySelector('#setup-ollama');
    if (!box) return;
    box.innerHTML = '<div class="setup-spin">Checking for Ollama…</div>';

    ollama.__proxy = undefined;               // re-probe
    const info = await ollama.inspect();

    if (!info.running) {
      box.innerHTML = `
        <div class="setup-warn">Ollama isn't running.</div>
        <ol class="setup-steps">
          <li>Install from <a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com ↗</a></li>
          <li>Start it — it usually runs automatically after install</li>
          <li>Click retry below</li>
        </ol>
        <button class="btn wide" data-act="retry-ollama">RETRY DETECTION</button>`;
      box.querySelector('[data-act="retry-ollama"]').addEventListener('click', () => this._refreshOllama());
      return;
    }

    // `info.models` is the REAL installed list (from /api/tags).
    // `info.suggested` is only populated when nothing at all is installed.
    const installed = info.installed || (info.models || []).map(m => m.name || m);
    const catalog = info.suggested || [];

    if (installed.length) {
      box.innerHTML = `
        <div class="setup-ok">✓ Ollama running · ${installed.length} model${installed.length > 1 ? 's' : ''} installed</div>
        <label class="field">
          <span>Model</span>
          <select id="setup-omodel">
            ${installed.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')}
          </select>
        </label>
        <button class="btn wide" data-act="use-ollama">USE THIS MODEL</button>
        ${catalog.length ? '<button class="btn ghost wide" data-act="show-more">+ install another model</button>' : ''}
        <div id="setup-catalog" hidden></div>`;
      box.querySelector('[data-act="use-ollama"]').addEventListener('click', () => {
        const chosen = /** @type {any} */ (box.querySelector('#setup-omodel')).value;
        config.set({ model: chosen, ollamaSmallModel: chosen });
        this.finish('ollama');
      });
      box.querySelector('[data-act="show-more"]')?.addEventListener('click', () => {
        const c = /** @type {any} */ (box.querySelector('#setup-catalog'));
        c.hidden = false;
        this._renderCatalog(c, catalog);
      });
      return;
    }

    box.innerHTML = `
      <div class="setup-ok">✓ Ollama running — no models yet</div>
      <p class="setup-hint">Pick one and AURA will install it for you. All of these are tuned for speed.</p>
      <div id="setup-catalog"></div>`;
    this._renderCatalog(box.querySelector('#setup-catalog'), catalog);
  }

  _renderCatalog(host, models) {
    const list = (models || []).filter(m => !m.installed);
    host.innerHTML = list.map(m => `
      <div class="model-row ${m.recommended ? 'rec' : ''} ${m.heavy ? 'heavy' : ''}" data-model="${m.id}">
        <div class="model-main">
          <div class="model-name">${escapeHtml(m.label)}${m.recommended ? ' <span class="tag">RECOMMENDED</span>' : ''}</div>
          <div class="model-meta">${m.size_gb} GB download · ~${m.ram_gb} GB RAM</div>
          <div class="model-why">${escapeHtml(m.why)}</div>
        </div>
        <button class="btn small" data-act="pull" data-model="${m.id}">INSTALL</button>
      </div>`).join('') || '<p class="setup-hint">Nothing to install — use a model you already have.</p>';

    Array.from(host.querySelectorAll('[data-act="pull"]')).forEach(btn => {
      btn.addEventListener('click', () => this._pull(btn.dataset.model, host));
    });
  }

  async _pull(model, host) {
    if (this.pulling) return;
    this.pulling = true;
    this.pullAbort = new AbortController();

    const row = host.querySelector(`.model-row[data-model="${CSS.escape(model)}"]`);
    if (row) {
      row.classList.add('pulling');
      row.querySelector('.model-main').insertAdjacentHTML('beforeend',
        `<div class="pull-wrap"><div class="pull-bar"><div class="pull-fill"></div></div>
         <div class="pull-txt">starting…</div></div>`);
      const b = /** @type {any} */ (row.querySelector('[data-act="pull"]'));
      b.textContent = 'CANCEL';
      b.onclick = () => { try { this.pullAbort.abort(); } catch {} };
    }
    const fill = /** @type {any} */ (row?.querySelector('.pull-fill'));
    const txt = /** @type {any} */ (row?.querySelector('.pull-txt'));

    try {
      await ollama.pull(model, (p) => {
        if (fill) fill.style.width = `${p.percent}%`;
        if (txt) {
          txt.textContent = p.totalMb
            ? `${p.status} — ${p.mb}/${p.totalMb} MB (${p.percent.toFixed(0)}%)`
            : p.status;
        }
      }, this.pullAbort.signal);

      this.app.toast('success', `${model} installed.`);
      config.set({ model, ollamaSmallModel: model });
      this.finish('ollama');
    } catch (e) {
      if (e.name === 'AbortError') {
        if (txt) txt.textContent = 'cancelled';
        this.app.toast('warn', 'Download cancelled.');
      } else {
        if (txt) txt.textContent = `failed: ${e.message}`;
        this.app.toast('error', `Install failed: ${e.message}`);
      }
      const b = /** @type {any} */ (row?.querySelector('[data-act="pull"]'));
      if (b) { b.textContent = 'RETRY'; b.onclick = () => this._pull(model, host); }
    } finally {
      this.pulling = false;
    }
  }

  /* ── API key pane ────────────────────────────────────────────────── */

  _wireKeys() {
    const sel = /** @type {any} */ (this.el.querySelector('#setup-prov'));
    const note = /** @type {any} */ (this.el.querySelector('#setup-prov-note'));
    const link = /** @type {any} */ (this.el.querySelector('#setup-getkey'));
    const input = /** @type {any} */ (this.el.querySelector('#setup-key'));
    const out = /** @type {any} */ (this.el.querySelector('#setup-key-out'));

    const sync = () => {
      const p = KEY_PROVIDERS.find(x => x.id === sel.value);
      note.textContent = p.note;
      link.href = p.docs;
      input.value = config.getKey(p.id) || '';
    };
    sel.addEventListener('change', sync);
    sync();

    this.el.querySelector('#setup-key-go').addEventListener('click', async () => {
      const id = sel.value;
      const key = input.value.trim();
      if (!key) { out.hidden = false; out.textContent = 'Paste a key first.'; return; }
      out.hidden = false;
      out.textContent = `Testing ${id}…`;
      config.setKey(id, key);
      const res = await this.app.ai.testConnection(id, { key });
      if (res.ok) {
        out.textContent = `✓ Connected. Model replied: "${res.message}"`;
        config.set({ model: '' });
        setTimeout(() => this.finish(id), 700);
      } else {
        out.textContent = `✗ ${res.message}`;
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') /** @type {any} */ (this.el.querySelector('#setup-key-go')).click();
    });
  }
}

export default SetupWizard;
