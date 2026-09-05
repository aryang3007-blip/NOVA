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
.fk-hint.warn { color: #ffc43c; }
.fk-check { display: flex; align-items: center; gap: .5rem; font-size: .8rem; margin: .5rem 0; }
.fk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: .5rem; }
.fk-theme { border: 1px solid var(--panel-brd, rgba(148,175,205,.16)); border-radius: 10px;
  padding: .5rem; cursor: pointer; background: var(--bg-3, #0a0e16); text-align: center; }
.fk-theme.sel { outline: 2px solid var(--accent, #38bdf8); }
.fk-theme .nm { font-size: .62rem; color: var(--dim, #7d8da3); margin-top: .35rem; }
/* mini card = the ACTUAL slide the builder paints with that theme's palette */
.fk-mini { aspect-ratio: 16 / 9.5; border-radius: 6px; padding: 7px 8px; text-align: left;
  overflow: hidden; box-shadow: inset 0 0 0 1px rgba(255,255,255,.07); }
.fk-mini-accent { height: 4px; width: 28px; border-radius: 2px; margin-bottom: 6px; }
.fk-mini-title { font-size: .6rem; font-weight: 700; letter-spacing: .01em; line-height: 1.2;
  margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fk-mini-chip { font-size: .5rem; line-height: 1.3; padding: 2.5px 6px; border-radius: 4px;
  margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* outline model — the real model, explicitly, never a vague dropdown */
.fk-model { margin: .35rem 0; border: 1px solid var(--panel-brd, rgba(148,175,205,.16));
  border-radius: 10px; background: var(--bg-3, #0a0e16); padding: .55rem .65rem; }
.fk-model-head { display: flex; align-items: center; gap: .45rem; font-size: .62rem;
  letter-spacing: .12em; color: var(--dim, #7d8da3); margin-bottom: .4rem; }
.fk-model-head .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok, #34d399);
  box-shadow: 0 0 8px rgba(52,211,153,.7); flex: none; }
.fk-model-body { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.fk-model-body b { color: var(--text, #e8eef5); font-weight: 700; font-size: .9rem; }
.fk-desc { font-size: .66rem; color: var(--dim, #7d8da3); margin-top: .4rem; line-height: 1.55; }
.fk-desc b { color: var(--text, #e8eef5); }
.fk-prov-chip { font-size: .66rem; padding: .15rem .5rem; border-radius: 20px;
  background: rgba(var(--accent-rgb), .12); border: 1px solid rgba(var(--accent-rgb), .35);
  color: var(--accent, #38bdf8); }
.fk-tag { font-size: .56rem; letter-spacing: .06em; padding: .14rem .45rem; border-radius: 20px;
  font-weight: 700; }
.fk-tag.ok { background: rgba(52,211,153,.12); color: var(--ok, #34d399);
  border: 1px solid rgba(52,211,153,.4); }
.fk-tag.warn { background: rgba(255,196,60,.1); color: #ffc43c;
  border: 1px solid rgba(255,196,60,.4); }
/* image provider + model picker */
.fk-img-row { display: flex; gap: .6rem; flex-wrap: wrap; }
.fk-img-row > * { flex: 1; min-width: 120px; }
.fk-provs { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: .5rem; margin: .2rem 0 .55rem; }
.fk-prov { border: 1px solid var(--panel-brd, rgba(148,175,205,.16)); border-radius: 10px;
  background: var(--bg-3, #0a0e16); padding: .55rem .6rem; cursor: pointer; }
.fk-prov.sel { outline: 2px solid var(--accent, #38bdf8); }
.fk-prov.nokey { opacity: .78; }
.fk-prov-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.fk-prov-head b { font-size: .72rem; color: var(--text, #e8eef5); }
.fk-prov-sub { font-size: .62rem; color: var(--dim, #7d8da3); margin-top: .3rem; line-height: 1.5; }
.fk-prov-models { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .4rem; }
.fk-prov-model { font-size: .56rem; padding: .12rem .4rem; border-radius: 5px;
  background: rgba(148,175,205,.1); color: var(--dim, #7d8da3); }
/* the IMAGES-ONLY key entry — strict: separate from the outline/chat key */
.fk-imgkey { display: flex; gap: .45rem; align-items: center; flex-wrap: wrap; }
.fk-imgkey input { flex: 1; min-width: 140px; }
.fk-imgkey .fk-tag { white-space: nowrap; }
/* visual-source mode radio group (search-first resolution engine) */
.fk-mode { display: grid; gap: .2rem; }
.fk-mode-row { display: flex; align-items: center; gap: .45rem; font-size: .78rem;
  color: var(--text, #e8eef5); cursor: pointer; }
.fk-mode-row input { accent-color: var(--accent, #38bdf8); }
.fk-srcpref { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.fk-srcpref select { max-width: 260px; }
.fk-mode-note { font-size: .62rem; color: var(--dim, #7d8da3); }
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
