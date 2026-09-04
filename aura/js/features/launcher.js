/**
 * NOVA :: feature popup launcher
 * ===============================
 * `openFeature(id, prefill, ctx)` mounts the feature's own app (apps/<ui>/app.js)
 * inside the AURA modal host. Every feature id resolves through the manifest
 * registry — terminal, tests and UI share the same names.
 *
 * @module features/launcher
 */
import { feature } from './registry.js';

const MODAL_CSS = `
#feature-modal { position: fixed; inset: 0; z-index: 500; display: grid;
  place-items: center; background: rgba(2,6,12,.72); backdrop-filter: blur(6px); }
#feature-modal[hidden] { display: none; }
.feature-card { width: min(680px, 94vw); max-height: 88vh; overflow-y: auto;
  background: var(--bg-2, #0f1420); border: 1px solid var(--panel-brd, rgba(148,175,205,.16));
  border-radius: 16px; padding: 1.1rem 1.3rem 1.3rem; box-shadow: 0 24px 80px rgba(0,0,0,.6); }
.feature-head { display: flex; align-items: center; gap: .7rem; margin-bottom: .4rem; }
.feature-head h3 { margin: 0; font-size: 1.02rem; letter-spacing: .04em; }
.feature-close { margin-left: auto; font-size: 1.1rem; opacity: .7; }
.fk-field { display: block; margin: .55rem 0; }
.fk-label { display: block; font-size: .6rem; letter-spacing: .14em; color: var(--dim, #7d8da3);
  text-transform: uppercase; margin-bottom: .25rem; }
.fk-input, .fk-select, .fk-range { width: 100%; background: var(--bg-3, #0a0e16);
  color: var(--text, #e8eef5); border: 1px solid var(--panel-brd, rgba(148,175,205,.16));
  border-radius: 8px; padding: .5rem .6rem; font-family: var(--font, inherit); font-size: .85rem; }
.fk-hint { font-size: .66rem; color: var(--dim, #7d8da3); margin-top: .2rem; }
.fk-check { display: flex; align-items: center; gap: .5rem; font-size: .8rem; margin: .5rem 0; }
.fk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: .5rem; }
.fk-theme { border: 1px solid var(--panel-brd, rgba(148,175,205,.16)); border-radius: 10px;
  padding: .5rem; cursor: pointer; background: var(--bg-3, #0a0e16); text-align: center; }
.fk-theme.sel { outline: 2px solid var(--accent, #38bdf8); }
.fk-theme .sw { display: flex; height: 26px; border-radius: 6px; overflow: hidden; margin-bottom: .3rem; }
.fk-theme .nm { font-size: .62rem; color: var(--dim, #7d8da3); }
.fk-status { margin-top: .8rem; max-height: 150px; overflow-y: auto;
  font-family: var(--mono, monospace); font-size: .68rem; line-height: 1.7;
  background: rgba(0,0,0,.25); border-radius: 8px; padding: .5rem .6rem; }
.fk-line { color: var(--dim, #7d8da3); }
.fk-line.ok { color: var(--ok, #34d399); }
.fk-line.err { color: var(--danger, #ff5470); }
.feature-actions { display: flex; gap: .6rem; margin-top: .9rem; align-items: center; }
.feature-actions .fk-note { font-size: .66rem; opacity: .7; }
.fk-pin { display: flex; align-items: center; gap: .45rem; margin: .55rem 0; font-size: .8rem;
  background: rgba(var(--accent-rgb), .07); border: 1px solid var(--panel-brd, rgba(148,175,205,.16));
  border-radius: 8px; padding: .5rem .6rem; }
.fk-pin .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok, #34d399);
  box-shadow: 0 0 8px rgba(52,211,153,.7); flex: none; }
.fk-pin b { color: var(--text, #e8eef5); font-weight: 600; }
.fk-pin .fk-note { margin-left: auto; }
.fk-prompt { margin: .55rem 0; border: 1px solid var(--panel-brd, rgba(148,175,205,.16));
  border-radius: 10px; background: var(--bg-3, #0a0e16); }
.fk-prompt summary { cursor: pointer; padding: .5rem .6rem; font-size: .68rem; letter-spacing: .1em;
  color: var(--dim, #7d8da3); user-select: none; }
.fk-prompt summary:hover { color: var(--text, #e8eef5); }
.fk-prompt-pre { margin: 0; padding: .6rem; max-height: 220px; overflow: auto; white-space: pre-wrap;
  word-break: break-word; font-family: var(--mono, monospace); font-size: .62rem; line-height: 1.6;
  color: var(--text, #e8eef5); border-top: 1px solid var(--panel-brd, rgba(148,175,205,.16)); }
`;

let _stylesInjected = false;

function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const st = document.createElement('style');
  st.textContent = MODAL_CSS;
  document.head.append(st);
}

/**
 * @param {string} id             manifest feature id (pptx|docx|xlsx|research)
 * @param {object} [prefill]      {topic, audience, details, slides, …}
 * @param {{engine?:any, actions?:any, config?:any, bus?:any, toast?:Function}} ctx
 */
export async function openFeature(id, prefill = {}, ctx = {}) {
  const meta = feature(id);
  if (!meta) return { ok: false, reason: `unknown feature '${id}'` };
  injectStyles();
  let host = document.getElementById('feature-modal');
  if (!host) {
    host = document.createElement('div');
    host.id = 'feature-modal';
    host.hidden = true;
    document.body.append(host);
  }
  host.innerHTML = '';
  host.hidden = false;
  try {
    // js/features/launcher.js → ../../ = aura/ → apps/<ui>/app.js
    const app = await import(`../../apps/${meta.ui}/app.js`);
    const close = () => { host.hidden = true; host.innerHTML = ''; };
    await app.mount({ root: host, meta, prefill: prefill || {}, ctx, close });
    return { ok: true };
  } catch (e) {
    host.hidden = true;
    return { ok: false, reason: String(e?.message || e) };
  }
}

export default { openFeature };
