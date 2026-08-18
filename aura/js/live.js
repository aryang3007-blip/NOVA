/**
 * AURA Live — the screen page
 * ===========================
 * A standalone page at `/screen` that gives every screen-related command a
 * real control instead of a slash string. It is NOT a reimplementation: it
 * imports the same modules the main app uses (`screenShare`, `ScreenAgent`,
 * `TaskAgent`, `RuntimeCore`, `localActions`), so behaviour and safety are
 * identical and there is exactly one source of truth.
 *
 * Equivalences, so nothing is lost:
 *   /watch        → SHARE SCREEN button
 *   /watch ask    → ASK view
 *   /screenmode   → reading-mode picker
 *   /find         → FIND view (+ live grid map)
 *   /here         → CLICK THE MARKER
 *   /do, /task    → ACT view (segmented control)
 *   /reticle      → desktop-marker card, with colour + style
 *   /desktop      → DESKTOPS view
 *   /automation   → arm/disarm card
 *
 * @module live
 */

import { screenShare } from './vision/screen-share.js';
import { ScreenCursor } from './vision/screen-cursor.js';
import { ScreenAgent } from './ai/screen-agent.js';
import { TaskAgent } from './ai/task-agent.js';
import { AIEngine } from './ai/engine.js';
import { localActions } from './actions/local-actions.js';
import { Trace } from './core/trace.js';
import { TraceView } from './ui/trace-view.js';
import { config } from './core/config.js';
import { listVisionModels } from './ai/providers.js';
import { validate } from './runtime/command-registry.js';
import { knowledgeFor, guessApp } from './runtime/desktop-knowledge.js';

const $ = (id) => /** @type {any} */ (document.getElementById(id));
/** @returns {any[]} */
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s) => esc(s).replace(/`([^`]+)`/g, (_, m) => `<code>${m}</code>`)
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

const RETICLE_COLORS = ['#00FF88', '#4FD6FF', '#FF7AC6', '#FFC46B', '#FF6B81', '#FFFFFF'];

const app = {
  ai: null, agent: null, cursor: null, traceView: null,
  actMode: 'do', previewTimer: null, frames: 0, spark: [],
  reticleColor: RETICLE_COLORS[0], reticleStyle: 'reticle',
};

/* ── boot ───────────────────────────────────────────────────────────── */
init().catch(err => {
  console.error('[live] boot failed', err);
  toast('bad', `Boot failed: ${err.message}`);
});

async function init() {
  buildStatic();
  wireNav();
  wireParallax();
  wireRipples();

  await localActions.init?.().catch(() => {});
  /*
   * THE BUG THAT MADE AURA LIVE "NOT WORK".
   *
   * This called `app.ai.resolveProvider?.()`. The method is `resolve()` —
   * there is no `resolveProvider`. Optional chaining meant it silently did
   * nothing, so the engine never picked a provider and every model-backed
   * feature on the page (ASK, FIND, ACT) reported "no image-capable model
   * installed" even when Ollama was running fine in the main app.
   *
   * Failing loudly here is deliberate: a page whose whole purpose is talking
   * to a model should say so when it cannot.
   */
  app.ai = new AIEngine({});
  try {
    await app.ai.resolve();
    await app.ai.refreshModelRegistry();
  } catch (e) {
    console.warn('[live] model discovery failed', e);
    toast('warn', `Could not reach a model: ${e.message}`);
  }

  app.cursor = new ScreenCursor({ screen: screenShare });
  app.agent = new ScreenAgent({
    screen: screenShare, ai: app.ai, actions: localActions,
    config, cursor: app.cursor,
  });
  app.traceView = new TraceView($('trace-log'));

  wireLive(); wireAsk(); wireFind(); wireAct(); wireDesktops(); wireSettings(); wireOmni();
  await refreshAll();
  setInterval(refreshStatus, 4000);
}

/* ── static UI ──────────────────────────────────────────────────────── */
function buildStatic() {
  $('ret-colors').innerHTML = RETICLE_COLORS.map((c, i) =>
    `<button class="sw${i ? '' : ' on'}" data-c="${c}" style="background:${c};color:${c}"
             aria-label="Marker colour ${c}"></button>`).join('');

  $('gridmap').innerHTML = Array.from({ length: 96 }, (_, i) =>
    `<span class="gcell" data-i="${i}"></span>`).join('');

  $('spark').innerHTML = Array.from({ length: 28 }, () =>
    '<span style="height:2px"></span>').join('');

  $('ask-presets').innerHTML = [
    'What is on this screen?', 'What does this error say?',
    'Summarise this page', 'What should I click next?',
  ].map(t => `<button class="chip" data-q="${esc(t)}">${esc(t)}</button>`).join('');

  $('act-presets').innerHTML = [
    'close the open window', 'save the file',
    'click the Send button', 'open whatsapp',
  ].map(t => `<button class="chip" data-q="${esc(t)}">${esc(t)}</button>`).join('');

  $('mode-picker').innerHTML = [
    ['auto', 'Automatic', 'Text questions take the fast path; visual ones use full vision.'],
    ['ocr', 'Fast read', 'Always transcribe with a small model, then answer. Lowest latency.'],
    ['vision', 'Full vision', 'Always send the picture to a multimodal model. Most accurate.'],
  ].map(([id, t, d]) =>
    `<button class="mode" data-mode="${id}"><b>${t}</b><span>${d}</span></button>`).join('');
}

/* ── navigation ─────────────────────────────────────────────────────── */
function wireNav() {
  $$('.rail-btn[data-view]').forEach(b => {
    b.addEventListener('click', () => show(b.dataset.view));
  });
  const android = () => modal('📱', 'Android support',
    'Under development. The plan is to mirror an Android screen over ADB or scrcpy and '
    + 'drive it with the same grid-and-plan pipeline AURA already uses for the desktop. '
    + 'Nothing about it works yet — this button exists so the roadmap is visible, not to '
    + 'imply a hidden feature.');
  $('btn-android').addEventListener('click', android);
  $('btn-android-2').addEventListener('click', android);
  $('modal-x').addEventListener('click', () => { $('modal').hidden = true; });
  $('modal').querySelector('.modal-bg').addEventListener('click', () => { $('modal').hidden = true; });
}

function show(view) {
  $$('.rail-btn[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  const subs = {
    live: 'Screen awareness & desktop control', ask: 'Ask about what is on screen',
    find: 'Locate an element and mark it', act: 'Run tasks on your machine',
    desktop: 'Give AURA its own workspace', trace: 'Everything AURA is doing',
    settings: 'Capture and marker preferences',
  };
  $('hero-sub').textContent = subs[view] || '';
  if (view === 'desktop') refreshDesktops();
}

/* Cursor-tracked specular highlight on every glass surface. */
function wireParallax() {
  document.addEventListener('pointermove', (e) => {
    if (document.body.classList.contains('no-motion')) return;
    for (const el of $$('.glass')) {
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left - 90 || e.clientX > r.right + 90 ||
          e.clientY < r.top - 90 || e.clientY > r.bottom + 90) continue;
      el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
      el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
    }
  }, { passive: true });
}

function wireRipples() {
  document.addEventListener('click', (e) => {
    const btn = /** @type {any} */ (e.target).closest?.('.gbtn');
    if (!btn || document.body.classList.contains('no-motion')) return;
    const r = btn.getBoundingClientRect();
    const s = document.createElement('span');
    s.className = 'ripple';
    const d = Math.max(r.width, r.height);
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    btn.appendChild(s);
    setTimeout(() => s.remove(), 640);
  });
}

/* ── LIVE view ──────────────────────────────────────────────────────── */
function wireLive() {
  const start = async () => {
    const r = await screenShare.start();
    toast(r.ok ? 'ok' : 'warn', r.message);
    if (r.ok) { startPreview(); }
    await refreshStatus();
  };
  $('btn-share').addEventListener('click', start);
  $('btn-share-2').addEventListener('click', start);
  $('btn-stop').addEventListener('click', async () => {
    screenShare.stop(); stopPreview(); await refreshStatus();
    toast('ok', 'Sharing stopped.');
  });

  $('ret-colors').addEventListener('click', (e) => {
    const b = /** @type {any} */ (e.target).closest('.sw');
    if (!b) return;
    $$('#ret-colors .sw').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    app.reticleColor = b.dataset.c;
    localActions.overlayConfig?.({ color: app.reticleColor });
  });

  $('btn-ret-test').addEventListener('click', async () => {
    const st = await localActions.overlayStatus();
    if (!st.available) {
      $('ret-note').textContent = st.reason || 'Unavailable.';
      return toast('warn', st.reason || 'Desktop marker unavailable.');
    }
    const cur = await localActions.automationCursor();
    const x = cur.ok ? cur.x : 600, y = cur.ok ? cur.y : 400;
    const r = await localActions.overlayShow(x, y, {
      label: 'AURA', color: app.reticleColor, style: app.reticleStyle });
    $('ret-state').textContent = r.ok ? 'visible' : 'error';
    $('ret-state').classList.toggle('on', !!r.ok);
    $('ret-note').textContent = r.ok
      ? `At (${x}, ${y}) on your desktop. ${st.clickThrough
          ? 'Clicks pass through it.' : st.clickThroughNote}`
      : r.message;
    toast(r.ok ? 'ok' : 'bad', r.ok ? 'Marker is on your desktop — look away from the browser.' : r.message);
  });

  $('btn-ret-off').addEventListener('click', async () => {
    await localActions.overlayHide();
    app.cursor.hide();
    $('ret-state').textContent = 'idle';
    $('ret-state').classList.remove('on');
    toast('ok', 'Marker hidden.');
  });
}

function startPreview() {
  stopPreview();
  const cv = $('preview');
  const ctx = cv.getContext('2d');
  $('preview-empty').classList.add('gone');
  cv.parentElement.classList.add('live');
  const draw = () => {
    if (!screenShare.active || !screenShare.video) return;
    const g = screenShare.geometry();
    if (!g) return;
    if (cv.width !== g.capturedWidth) { cv.width = g.capturedWidth; cv.height = g.capturedHeight; }
    try { ctx.drawImage(screenShare.video, 0, 0, cv.width, cv.height); } catch {}
    app.cursor.draw(ctx, cv.width, cv.height);
    app.frames++;
    $('st-frames').textContent = String(app.frames);
  };
  draw();
  // 4 fps: the capture itself is 1 fps, so anything faster is wasted work.
  app.previewTimer = setInterval(() => {
    if ($('tg-preview')?.checked !== false) draw();
    pushSpark(screenShare.changeScore?.() ?? 0);
  }, 250);
}

function stopPreview() {
  clearInterval(app.previewTimer);
  app.previewTimer = null;
  $('preview-empty')?.classList.remove('gone');
  $('preview')?.parentElement?.classList.remove('live');
}

function pushSpark(v) {
  app.spark.push(Math.min(1, v));
  if (app.spark.length > 28) app.spark.shift();
  const bars = $$('#spark span');
  bars.forEach((b, i) => { b.style.height = `${2 + (app.spark[i] ?? 0) * 36}px`; });
}

/* ── ASK ────────────────────────────────────────────────────────────── */
function wireAsk() {
  $('ask-presets').addEventListener('click', (e) => {
    const c = /** @type {any} */ (e.target).closest('.chip');
    if (c) { $('ask-q').value = c.dataset.q; }
  });
  $('btn-ask').addEventListener('click', runAsk);
  $('mode-picker').addEventListener('click', (e) => {
    const m = /** @type {any} */ (e.target).closest('.mode');
    if (!m) return;
    config.set('screenMode', m.dataset.mode);
    syncModes();
    toast('ok', `Reading mode: ${m.dataset.mode}`);
  });
}

async function runAsk() {
  const q = $('ask-q').value.trim();
  if (!q) return toast('warn', 'Type a question first.');
  if (!screenShare.active) return toast('warn', 'Share a screen first.');
  const out = $('ask-out');
  out.innerHTML = '<div class="skel" style="width:82%"></div><div class="skel" style="width:64%"></div>';
  const t = new Trace(`ask · ${q.slice(0, 40)}`);
  let text = '';
  const onDelta = (d) => { text += d.delta ?? ''; out.innerHTML = md(text); };
  const { bus, EV } = await import('./core/bus.js');
  bus.on(EV.AI_STREAM_DELTA, onDelta);
  try {
    const r = await app.agent.ask(q, { trace: t });
    t.end(r.ok ? 'ok' : 'fail', r.ok ? `${r.mode} · ${r.ms}ms` : r.message);
    if (!r.ok) out.innerHTML = md(`⚠ ${r.message}`);
    else if (!text) out.innerHTML = '<span class="muted">Answered — see the trace.</span>';
  } catch (e) {
    t.end('fail', e.message); out.innerHTML = md(`⚠ ${e.message}`);
  } finally { bus.off(EV.AI_STREAM_DELTA, onDelta); }
}

function syncModes() {
  const cur = config.get('screenMode') || 'auto';
  $$('.mode').forEach(m => m.classList.toggle('on', m.dataset.mode === cur));
}

/* ── FIND ───────────────────────────────────────────────────────────── */
function wireFind() {
  $('btn-find').addEventListener('click', runFind);
  $('find-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runFind(); });
  $('btn-here').addEventListener('click', async () => {
    const pt = app.cursor.toScreenPoint();
    if (!pt.ok) return toast('warn', pt.message);
    const cap = await localActions.automationCapabilities();
    if (!cap.available) return toast('bad', cap.reason);
    if (!cap.armed) return toast('warn', 'Not armed — arm it in ACT.');
    if (!confirm(`Click at (${pt.x}, ${pt.y}) where the marker is?`)) return;
    const r = await localActions.automationRun([{ op: 'click', x: pt.x, y: pt.y }], true);
    toast(r.ok ? 'ok' : 'bad', r.ok ? `Clicked (${pt.x}, ${pt.y}).` : r.message);
  });
}

async function runFind() {
  const q = $('find-q').value.trim();
  if (!q) return toast('warn', 'What should I look for?');
  if (!screenShare.active) return toast('warn', 'Share a screen first.');
  const out = $('find-out');
  out.innerHTML = '<div class="skel" style="width:70%"></div>';
  const t = new Trace(`find · ${q}`);
  const r = await app.agent.locate(q, { trace: t });
  t.end(r.ok ? 'ok' : 'fail', r.ok ? `cell ${r.cell}` : r.message);
  if (!r.ok) { out.innerHTML = md(`⚠ ${r.message}`); paintGrid(null); return; }

  paintGrid(r.cell);
  $('grid-cell').textContent = r.cell;
  let extra = '';
  if (r.clickable) {
    const ov = await localActions.overlayShow(r.x, r.y, {
      label: q, color: app.reticleColor, style: app.reticleStyle });
    extra = ov.ok
      ? `\n\n**The marker is on your real desktop** at (${r.x}, ${r.y}).`
      : `\n\n_Desktop marker unavailable: ${ov.message}_`;
    $('btn-here').disabled = false;
  } else {
    extra = `\n\n_${r.reason}_`;
    $('btn-here').disabled = true;
  }
  out.innerHTML = md(`${r.message}${extra}`);
}

function paintGrid(cell) {
  for (const c of $$('#gridmap .gcell')) c.classList.remove('hit');
  if (!cell) return;
  const m = /^([A-L])(\d+)$/i.exec(cell);
  if (!m) return;
  const col = m[1].toUpperCase().charCodeAt(0) - 65;
  const row = parseInt(m[2], 10) - 1;
  const idx = row * 12 + col;
  $$('#gridmap .gcell')[idx]?.classList.add('hit');
}

/* ── ACT ────────────────────────────────────────────────────────────── */
function wireAct() {
  $('act-seg').addEventListener('click', (e) => {
    const b = /** @type {any} */ (e.target).closest('button');
    if (!b) return;
    app.actMode = b.dataset.act;
    $$('#act-seg button').forEach(x => x.classList.toggle('on', x === b));
    $('act-mode').textContent = app.actMode === 'task' ? 'agent loop' : 'single step';
  });
  $('act-presets').addEventListener('click', (e) => {
    const c = /** @type {any} */ (e.target).closest('.chip');
    if (c) $('act-q').value = c.dataset.q;
  });
  $('btn-act').addEventListener('click', runAct);
  $('btn-arm').addEventListener('click', async () => {
    const r = await localActions.automationArm();
    toast(r.ok ? 'ok' : 'bad', r.message);
    refreshStatus();
  });
  $('btn-disarm').addEventListener('click', async () => {
    const r = await localActions.automationDisarm();
    toast('ok', r.message || 'Disarmed.');
    refreshStatus();
  });
}

async function runAct() {
  const goal = $('act-q').value.trim();
  if (!goal) return toast('warn', 'Describe what to do.');
  const cap = await localActions.automationCapabilities();
  if (!cap.available) return toast('bad', cap.reason);
  if (!cap.armed) return toast('warn', 'Arm automation first.');

  const out = $('act-out');
  out.innerHTML = '<div class="skel" style="width:76%"></div><div class="skel" style="width:52%"></div>';
  const t = new Trace(`${app.actMode} · ${goal.slice(0, 40)}`);

  try {
    if (app.actMode === 'task') {
      const agent = new TaskAgent({
        screen: screenShare, agent: app.agent, actions: localActions,
        ai: app.ai, cursor: app.cursor,
        knowledge: { validate, knowledgeFor, guessApp },
      });
      const r = await agent.run(goal, {
        trace: t, maxSteps: Number(config.get('taskMaxSteps')) || 10,
        confirm: async (act, narration) =>
          confirm(`AURA wants to:\n\n${narration}\n\nOK to proceed?\n\n`
                + 'Kill switch: pointer into the TOP-LEFT corner.'),
      });
      t.end(r.ok ? 'ok' : 'warn', r.message);
      out.innerHTML = md(`${r.ok ? '✅' : '⚠'} **${r.message}**\n\n`
        + r.log.map(h => `${h.step}. ${h.result}`).join('\n'));
    } else {
      const p = await app.agent.plan(goal, { trace: t });
      if (!p.ok) { t.end('fail', p.message); out.innerHTML = md(`⚠ ${p.message}`); return; }
      const res = await app.agent.resolve(p.intents, { trace: t });
      if (!res.ok) { t.end('fail', res.message); out.innerHTML = md(`⚠ ${res.message}`); return; }
      if (!confirm(`AURA plans to:\n\n${res.narration.join('\n')}\n\nProceed?`)) {
        t.end('warn', 'cancelled'); out.innerHTML = md('⚪ Cancelled.'); return;
      }
      const run = await localActions.automationRun(res.plan, true);
      t.end(run.ok ? 'ok' : 'fail', run.message || '');
      out.innerHTML = md(`${run.ok ? '✅' : '⚠'} ${run.message}\n\n${res.narration.join('\n')}`);
    }
  } catch (e) {
    t.end('fail', e.message); out.innerHTML = md(`⚠ ${e.message}`);
  }
}

/* ── DESKTOPS & WINDOWS ─────────────────────────────────────────────── */
let _prevWindowIds = new Set();
let _hasInitialWindows = false;

function wireDesktops() {
  const act = async (fn, label) => {
    const r = await fn();
    toast(r.ok ? 'ok' : 'warn', r.message || label);
    refreshDesktops();
    refreshWindows();
  };
  $('btn-vd-setup')?.addEventListener('click', () => act(() => localActions.vdeskSetup(), 'setup'));
  $('btn-vd-aura')?.addEventListener('click', () => act(() => localActions.vdeskGoAura(), 'aura'));
  $('btn-vd-home')?.addEventListener('click', () => act(() => localActions.vdeskGoHome(), 'home'));
  $('btn-win-refresh')?.addEventListener('click', () => refreshWindows());

  // Window action delegation
  $('win-list')?.addEventListener('click', async (e) => {
    const btn = /** @type {any} */ (e.target).closest('.win-btn');
    if (!btn) return;
    const wid = btn.dataset.id;
    if (!wid) return;

    if (btn.classList.contains('btn-focus')) {
      const r = await localActions.focusWindow(wid);
      toast(r.ok ? 'ok' : 'warn', r.message || 'Focused window.');
    } else if (btn.classList.contains('btn-min')) {
      const r = await localActions.minimizeWindow(wid);
      toast(r.ok ? 'ok' : 'warn', r.message || 'Minimised window.');
    } else if (btn.classList.contains('btn-max')) {
      const r = await localActions.maximizeWindow(wid);
      toast(r.ok ? 'ok' : 'warn', r.message || 'Maximised window.');
    } else if (btn.classList.contains('btn-close')) {
      const r = await localActions.closeWindow(wid);
      toast(r.ok ? 'ok' : 'warn', r.message || 'Closed window.');
    }
    setTimeout(refreshWindows, 400);
  });
}

async function refreshWindows() {
  const listEl = $('win-list');
  if (!listEl) return;
  try {
    const res = await localActions.listWindows();
    if (!res.ok) {
      listEl.innerHTML = `<span class="muted">${res.message || 'Window manager unavailable.'}</span>`;
      return;
    }
    const wins = res.windows || [];
    if ($('win-count')) $('win-count').textContent = `${wins.length} windows`;
    const curIds = new Set(wins.map(w => w.id));

    // Detect live additions & deletions
    if (_hasInitialWindows) {
      for (const w of wins) {
        if (!_prevWindowIds.has(w.id)) {
          toast('ok', `Window opened: ${w.title.slice(0, 30)}`);
        }
      }
      for (const id of _prevWindowIds) {
        if (!curIds.has(id)) {
          toast('info', 'Window closed');
        }
      }
    }
    _prevWindowIds = curIds;
    _hasInitialWindows = true;

    if (!wins.length) {
      listEl.innerHTML = '<span class="muted">No active visible windows found.</span>';
      return;
    }

    listEl.innerHTML = wins.map(w => `
      <div class="win-item${w.focused ? ' focused' : ''}" data-id="${w.id}">
        <div class="win-meta">
          <div class="win-title" title="${esc(w.title)}">${w.focused ? '⚡ ' : ''}${esc(w.title)}</div>
          <div class="win-sub">${esc(w.process || 'app')} · PID ${w.pid} ${w.minimised ? '· [MIN]' : (w.maximised ? '· [MAX]' : '')}</div>
        </div>
        <div class="win-actions">
          <button class="win-btn btn-focus" title="Focus window" data-id="${w.id}">FOCUS</button>
          <button class="win-btn btn-min" title="Minimize" data-id="${w.id}">MIN</button>
          <button class="win-btn btn-max" title="Maximize" data-id="${w.id}">MAX</button>
          <button class="win-btn btn-close danger" title="Close window" data-id="${w.id}">✕</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = `<span class="muted">Scan error: ${e.message}</span>`;
  }
}

async function refreshDesktops() {
  const st = await localActions.vdeskStatus().catch(() => ({ available: false, reason: 'bridge offline' }));
  if ($('vd-os')) $('vd-os').textContent = st.system || '—';
  if ($('vd-note')) $('vd-note').textContent = st.available
    ? `${st.limitation}  ${st.sharedCursor}` : (st.reason || '');
  const n = Math.max(st.count || 1, (st.auraDesktop ?? 0) + 1);
  if ($('desks')) {
    $('desks').innerHTML = Array.from({ length: Math.min(n, 6) }, (_, i) => {
      const cur = i === st.index, aura = i === st.auraDesktop;
      return `<div class="desk${cur ? ' cur' : ''}${aura ? ' aura' : ''}">
        <b>${i + 1}</b><span>${aura ? 'AURA' : cur ? 'HERE' : 'desktop'}</span></div>`;
    }).join('');
  }
  ['btn-vd-setup', 'btn-vd-aura', 'btn-vd-home'].forEach(id => { if ($(id)) $(id).disabled = !st.available; });
}

/* ── SETTINGS & VISION MODEL SELECTOR ────────────────────────────────── */
function wireSettings() {
  $('tg-ambient')?.addEventListener('change', (/** @type {any} */ e) =>
    document.body.classList.toggle('no-ambient', !e.target.checked));
  $('tg-motion')?.addEventListener('change', (/** @type {any} */ e) =>
    document.body.classList.toggle('no-motion', !e.target.checked));
  $('tg-watch')?.addEventListener('change', async (/** @type {any} */ e) => {
    const on = e.target.checked;
    if (on && screenShare.active) screenShare.startWatching();
    else screenShare.stopWatching();
    toast('ok', on ? 'Watching for changes.' : 'Watch off.');
  });
  $('style-seg')?.addEventListener('click', (e) => {
    const b = /** @type {any} */ (e.target).closest('button');
    if (!b) return;
    $$('#style-seg button').forEach(x => x.classList.toggle('on', x === b));
    app.reticleStyle = b.dataset.style;
    $('set-style').textContent = app.reticleStyle;
    localActions.overlayConfig?.({ style: app.reticleStyle });
  });
  $('btn-trace-clear')?.addEventListener('click', () => app.traceView.clear());

  wireVisionSettings();
}

function wireVisionSettings() {
  const selProv = $('sel-vision-provider');
  const selModel = $('sel-vision-model');
  const btnFetch = $('btn-fetch-vision-models');
  if (!selProv || !selModel) return;

  const curProv = config.get('visionProvider') || 'auto';
  const curModel = config.get('visionModel') || '';
  selProv.value = curProv;
  if ($('vision-engine-tag')) $('vision-engine-tag').textContent = curProv;

  const populateModels = async (prov) => {
    if (!prov || prov === 'auto') {
      selModel.innerHTML = '<option value="">Auto-detect (Best Vision Model)</option>';
      return;
    }
    const key = config.getKey(prov);
    const models = await listVisionModels(prov, { key, baseUrl: config.get('ollamaUrl') });
    if (!models || !models.length) {
      selModel.innerHTML = '<option value="">No vision models found</option>';
      return;
    }
    selModel.innerHTML = models.map(m =>
      `<option value="${esc(m)}">${esc(m)}</option>`
    ).join('');
    if (curModel && models.includes(curModel)) {
      selModel.value = curModel;
    }
  };

  selProv.addEventListener('change', async (e) => {
    const p = e.target.value;
    config.set('visionProvider', p);
    if ($('vision-engine-tag')) $('vision-engine-tag').textContent = p;
    await populateModels(p);
    config.set('visionModel', selModel.value);
    toast('info', `Vision provider → ${p}`);
  });

  selModel.addEventListener('change', (e) => {
    config.set('visionModel', e.target.value);
    toast('ok', `Vision model → ${e.target.value || 'default'}`);
  });

  btnFetch?.addEventListener('click', async () => {
    btnFetch.disabled = true;
    btnFetch.textContent = 'FETCHING…';
    try {
      const p = selProv.value;
      await populateModels(p);
      config.set('visionModel', selModel.value);
      toast('ok', `Fetched vision models for ${p}`);
      if ($('vision-model-status')) {
        $('vision-model-status').textContent = `Loaded ${selModel.options.length} model options for ${p}.`;
      }
    } catch (err) {
      toast('bad', `Failed to fetch: ${err.message}`);
    } finally {
      btnFetch.disabled = false;
      btnFetch.textContent = 'FETCH VISION MODELS';
    }
  });

  populateModels(curProv);
}

/* ── omni bar ───────────────────────────────────────────────────────── */
function wireOmni() {
  $('omni')?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const v = $('omni').value.trim();
    if (!v) return;
    $('omni').value = '';
    const map = { '/watch': 'live', '/find': 'find', '/do': 'act', '/task': 'act',
                  '/reticle': 'live', '/desktop': 'desktop', '/screenmode': 'ask' };
    const cmd = v.split(/\s+/)[0].toLowerCase();
    if (map[cmd]) {
      show(map[cmd]);
      const rest = v.slice(cmd.length).trim();
      if (rest && map[cmd] === 'find') { $('find-q').value = rest; runFind(); }
      else if (rest && map[cmd] === 'act') { $('act-q').value = rest; }
      return;
    }
    show('ask');
    $('ask-q').value = v;
    runAsk();
  });
}

/* ── status ─────────────────────────────────────────────────────────── */
async function refreshAll() {
  syncModes();
  await refreshStatus();
  await refreshDesktops();
  await refreshWindows();
  const st = await localActions.overlayStatus().catch(() => ({ available: false }));
  if ($('set-ct')) $('set-ct').textContent = st.clickThrough ? 'yes' : 'no';
  if ($('set-note')) $('set-note').textContent = st.available ? (st.clickThroughNote || '') : (st.reason || '');
  if ($('reach-ret')) {
    $('reach-ret').textContent = st.available ? 'ready' : 'unavailable';
    $('reach-ret').className = st.available ? 'ok' : 'no';
  }
}

async function refreshStatus() {
  const s = screenShare.status();
  const sharing = !!s.active;
  if ($('pill-share')) {
    $('pill-share').classList.toggle('on', sharing);
    $('pill-share').lastChild.textContent = sharing ? 'SHARING' : 'OFF';
  }
  if ($('btn-stop')) $('btn-stop').disabled = !sharing;
  if ($('surface-line')) $('surface-line').textContent = sharing ? s.description : 'No surface selected.';
  if ($('st-size')) $('st-size').textContent = s.geometry ? `${s.geometry.width}×${s.geometry.height}` : '—';
  if ($('st-click')) $('st-click').textContent = sharing ? (s.clickable ? 'yes' : 'view only') : '—';

  const vProv = config.get('visionProvider') || 'auto';
  const vMod = config.get('visionModel') || '';
  const ocr = app.agent?.pickOcrModel?.();
  if ($('st-reader')) $('st-reader').textContent = vMod || (ocr ? ocr.name : 'none');
  if ($('mode-reader')) $('mode-reader').textContent = vMod ? `${vProv}:${vMod}` : (ocr ? `${ocr.name}${ocr.weak ? ' (weak)' : ''}` : 'none installed');
  if ($('pill-model')) $('pill-model').textContent = vMod ? `${vMod}` : (ocr ? ocr.name : 'no vision model');
  const { ollama } = await import('./ai/providers.js');
  if ($('mode-vision')) $('mode-vision').textContent = vMod ? `${vProv} (${vMod})` : ((ollama.visionModels?.() || []).join(', ') || 'none');

  const cap = await localActions.automationCapabilities().catch(() => ({ available: false }));
  const armed = !!cap.armed;
  if ($('pill-arm')) {
    $('pill-arm').classList.toggle('on', armed);
    $('pill-arm').lastChild.textContent = armed ? 'ARMED' : 'DISARMED';
  }
  if ($('auto-state')) {
    $('auto-state').textContent = armed ? 'armed' : 'disarmed';
    $('auto-state').classList.toggle('on', armed);
  }
  if ($('auto-avail')) $('auto-avail').textContent = cap.available ? 'ready' : (cap.reason || 'unavailable');
  if ($('auto-screen')) $('auto-screen').textContent = cap.screen ? `${cap.screen.width}×${cap.screen.height}` : '—';
  if ($('auto-exp')) {
    $('auto-exp').textContent = cap.expiresInSeconds > 0
      ? `${Math.round(cap.expiresInSeconds / 60)} min` : (armed ? 'no expiry' : '—');
  }
  if ($('reach-input')) {
    $('reach-input').textContent = cap.available ? (armed ? 'armed' : 'ready') : 'unavailable';
    $('reach-input').className = cap.available ? 'ok' : 'no';
  }
  if ($('reach-win')) $('reach-win').textContent = localActions.os || 'unknown';

  await refreshWindows();
}

/* ── chrome ─────────────────────────────────────────────────────────── */
function toast(kind, text) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toasts')?.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 380); }, 4200);
}

function modal(ico, title, body) {
  $('modal-ico').textContent = ico;
  $('modal-t').textContent = title;
  $('modal-b').textContent = body;
  $('modal').hidden = false;
}
