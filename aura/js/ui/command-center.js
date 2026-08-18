/**
 * AURA :: Command Center UI
 * -------------------------
 * Presentation layer only. Contains NO AI logic, no runtime calls, no OS
 * access — it subscribes to the existing event bus and reactive store and
 * renders what is genuinely there.
 *
 * HARD RULE followed throughout: every value on screen traces to a real
 * source (state key, bus event, registry, or metrics provider). Where a
 * metric genuinely cannot be read, the panel prints the reason instead of
 * a number. Nothing here invents data.
 *
 * Panels:
 *   AICorePanel      — model, provider, reasoning state, activity  (state + bus)
 *   SystemMonitor    — CPU/RAM/GPU/disk + subsystem status         (MetricsManager)
 *   AgentPanel       — Vision/Voice/Memory/Desktop/AI agents       (state + runtime)
 *   MemoryCenter     — 4 memory categories + activity timeline     (MemoryManager)
 *   VoiceInterface   — listening/processing/speaking waveform      (voice events)
 *   PluginCenter     — plugins + tools from the live registries    (registries)
 *   ActivityFeed     — real-time event stream                      (bus wildcard)
 *
 * @module ui/command-center
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';
import { escapeHtml } from './markdown.js';
import { config } from '../core/config.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

/** Base panel: owns its subscriptions and cleans them up. */
class Panel {
  constructor(host) {
    this.host = typeof host === 'string' ? $(host) : host;
    this._subs = [];
    this._raf = null;
    this._dirty = false;
  }
  /** Subscribe and auto-unsubscribe on destroy. */
  on(event, fn) { this._subs.push(bus.on(event, fn)); return this; }
  watch(key, fn) { this._subs.push(state.watch(key, fn)); return this; }
  /**
   * Coalesce bursts of events into one paint per frame.
   * `force` renders synchronously — needed for state transitions that must be
   * correct even while the panel is hidden (rAF does not fire reliably then).
   */
  invalidate(force = false) {
    if (force) {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._dirty = false;
      this.render();
      return;
    }
    if (this._dirty) return;
    this._dirty = true;
    this._raf = requestAnimationFrame(() => { this._dirty = false; this.render(); });
  }
  render() {}
  destroy() {
    this._subs.forEach(off => { try { off(); } catch {} });
    this._subs = [];
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   1. AI CORE PANEL
   ══════════════════════════════════════════════════════════════════════ */

/** Reasoning states, derived from real store flags — never hardcoded. */
export const CORE_STATE = {
  IDLE: { id: 'idle', label: 'IDLE', color: 'var(--text-dim)' },
  LISTENING: { id: 'listening', label: 'LISTENING', color: '#f59e0b' },
  THINKING: { id: 'thinking', label: 'THINKING', color: 'var(--accent-2)' },
  GENERATING: { id: 'generating', label: 'GENERATING', color: 'var(--accent)' },
  SPEAKING: { id: 'speaking', label: 'SPEAKING', color: '#34d399' },
  ERROR: { id: 'error', label: 'ERROR', color: 'var(--danger)' },
};

export class AICorePanel extends Panel {
  constructor(host, { ai }) {
    super(host);
    this.ai = ai;
    this.coreState = CORE_STATE.IDLE;
    this.task = null;
    this.tokenCount = 0;
    this.lastLatency = null;
    this._streamStart = null;
    this._errorTimer = null;
    this._wire();
    this.render();
  }

  _wire() {
    // Reasoning state is derived from actual engine events.
    this.on(EV.AI_STREAM_START, () => {
      this._streamStart = performance.now();
      this.tokenCount = 0;
      this._set(CORE_STATE.THINKING, 'Processing request');
    });
    this.on(EV.AI_STREAM_DELTA, () => {
      this.tokenCount++;
      if (this.coreState !== CORE_STATE.GENERATING) this._set(CORE_STATE.GENERATING, 'Generating response');
      else this.invalidate();
    });
    this.on(EV.AI_STREAM_END, () => {
      if (this._streamStart) this.lastLatency = Math.round(performance.now() - this._streamStart);
      this._set(CORE_STATE.IDLE, null);
    });
    this.on(EV.AI_STREAM_ABORT, () => this._set(CORE_STATE.IDLE, 'Generation stopped'));
    this.on(EV.AI_ERROR, ({ message }) => {
      this._set(CORE_STATE.ERROR, message?.slice(0, 60) || 'Error');
      clearTimeout(this._errorTimer);
      this._errorTimer = setTimeout(() => this._set(CORE_STATE.IDLE, null), 6000);
    });
    this.on(EV.STT_START, () => this._set(CORE_STATE.LISTENING, 'Awaiting voice input'));
    this.on(EV.STT_END, () => { if (this.coreState === CORE_STATE.LISTENING) this._set(CORE_STATE.IDLE, null); });
    this.on(EV.TTS_START, () => this._set(CORE_STATE.SPEAKING, 'Speaking'));
    this.on(EV.TTS_END, () => { if (this.coreState === CORE_STATE.SPEAKING) this._set(CORE_STATE.IDLE, null); });

    this.on('ai:routed', ({ decision }) => { this.route = decision; this.invalidate(); });
    this.on('ai:tool-call', ({ calls }) => { this.task = `Tool: ${calls[0]?.tool}`; this.invalidate(); });
    this.on(EV.AI_PROVIDER_CHANGED, () => this.invalidate());
    this.on(EV.AI_MEMORY_UPDATED, () => this.invalidate());
    this.watch('aiModel', () => this.invalidate());
    this.watch('aiStreaming', () => this.invalidate());
  }

  _set(s, task) {
    this.coreState = s;
    this.task = task;
    state.set({ coreState: s.id });
    bus.emit('core:state', { state: s.id, task });
    this.invalidate(true);   // state transitions must paint even when hidden
  }

  render() {
    if (!this.host) return;
    const s = this.coreState;
    const provider = this.ai?.providerLabel || state.get('aiProvider') || 'Local Core';
    const model = state.get('aiModel');
    const msgs = this.ai?.memory?.all().length ?? 0;
    const ollama = state.get('hybridReady');

    this.host.innerHTML = `
      <div class="cc-core-ring ${s.id}" style="--core-color:${s.color}">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="ccr-bg" cx="60" cy="60" r="52"/>
          <circle class="ccr-spin" cx="60" cy="60" r="52"/>
          <circle class="ccr-spin2" cx="60" cy="60" r="42"/>
          <circle class="ccr-core" cx="60" cy="60" r="16"/>
        </svg>
        <div class="cc-core-label">${s.label}</div>
      </div>
      <div class="cc-core-info">
        <div class="cc-kv"><span>PROVIDER</span><b>${escapeHtml(provider)}</b></div>
        <div class="cc-kv"><span>MODEL</span><b>${escapeHtml(model || '—')}</b></div>
        <div class="cc-kv"><span>OLLAMA</span><b class="${ollama ? 'ok' : 'dim'}">${ollama ? `ready · ${escapeHtml(state.get('ollamaModel') || '')}` : 'not detected'}</b></div>
        <div class="cc-kv"><span>ROUTE</span><b>${this.route ? escapeHtml(this.route.route.toUpperCase()) : '—'}</b></div>
        <div class="cc-kv"><span>CONTEXT</span><b>${msgs} msgs</b></div>
        ${this.lastLatency ? `<div class="cc-kv"><span>LAST GEN</span><b>${this.lastLatency} ms · ${this.tokenCount} chunks</b></div>` : ''}
        ${this.task ? `<div class="cc-task">▸ ${escapeHtml(this.task)}</div>` : ''}
      </div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   2. SYSTEM MONITOR
   ══════════════════════════════════════════════════════════════════════ */

export class SystemMonitor extends Panel {
  constructor(host, { metrics, runtime }) {
    super(host);
    this.metrics = metrics;
    this.runtime = runtime;
    this.on('metrics:sample', () => this.invalidate());
    ['cameraActive', 'sttActive', 'ttsSpeaking', 'fps', 'visionFps'].forEach(k => this.watch(k, () => this.invalidate()));
    this.render();
  }

  _bar(label, metric, spark) {
    if (!metric || !metric.available) {
      return `<div class="cc-metric off">
        <div class="cc-metric-top"><span>${label}</span><b class="dim">N/A</b></div>
        <div class="cc-metric-reason">${escapeHtml(metric?.reason || 'Unavailable — awaiting local runtime provider')}</div>
      </div>`;
    }
    const pct = typeof metric.value === 'number' ? Math.max(0, Math.min(100, metric.value)) : null;
    const hot = pct != null && pct > 85 ? 'hot' : pct != null && pct > 60 ? 'warm' : '';
    return `<div class="cc-metric">
      <div class="cc-metric-top"><span>${label}</span><b>${escapeHtml(metric.display || '—')}</b></div>
      ${pct != null ? `<div class="cc-bar"><div class="cc-bar-fill ${hot}" style="width:${pct}%"></div></div>` : ''}
      ${spark?.length > 2 ? this._spark(spark) : ''}
      ${metric.detail ? `<div class="cc-metric-detail">${escapeHtml(metric.detail)}</div>` : ''}
    </div>`;
  }

  /** Sparkline from real recorded samples only. */
  _spark(data) {
    const w = 100, h = 18;
    const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (Math.max(0, Math.min(100, v)) / 100) * h}`).join(' ');
    return `<svg class="cc-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
  }

  render() {
    if (!this.host) return;
    const m = this.metrics?.latest || {};
    const h = this.metrics?.history || {};
    const dot = (on) => on ? '<i class="cc-dot on"></i>' : '<i class="cc-dot"></i>';
    const rt = this.runtime?.status?.() || {};
    const svc = this.runtime?.services?.summary?.() || {};

    this.host.innerHTML = `
      <div class="cc-src">SOURCE: ${escapeHtml(this.metrics?.sourceLabel || 'unknown')}</div>
      ${this._bar('CPU', m.cpu, h.cpu)}
      ${this._bar('MEMORY', m.ram, h.ram)}
      ${config.get('showGpuMetric') === false ? '' : this._bar('GPU', m.gpu, h.gpu)}
      ${m.disk ? this._bar('DISK', m.disk) : ''}
      <div class="cc-sub">SUBSYSTEMS</div>
      <div class="cc-chips">
        <span class="cc-chip">${dot(!!svc.ollama?.available)} Ollama</span>
        <span class="cc-chip">${dot(rt.transport && rt.transport !== 'browser')} Runtime: ${escapeHtml(rt.transport || '—')}</span>
        <span class="cc-chip">${dot(state.get('cameraActive'))} Camera</span>
        <span class="cc-chip">${dot(state.get('sttActive'))} Mic</span>
        <span class="cc-chip">${dot(state.get('ttsSupported'))} Voice</span>
        <span class="cc-chip">${dot(!!svc.actionBridge?.available)} Bridge</span>
      </div>
      <div class="cc-sub">RENDER</div>
      <div class="cc-chips">
        <span class="cc-chip">${state.get('fps')} FPS avatar</span>
        <span class="cc-chip">${state.get('cameraActive') ? state.get('visionFps') + ' FPS vision' : 'vision idle'}</span>
        ${m.battery?.available ? `<span class="cc-chip">🔋 ${escapeHtml(m.battery.display)}</span>` : ''}
        ${m.network?.available ? `<span class="cc-chip">📶 ${escapeHtml(m.network.display)}</span>` : ''}
      </div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   3. AGENT STATUS PANEL
   ══════════════════════════════════════════════════════════════════════ */

export class AgentPanel extends Panel {
  constructor(host, { runtime, ai, memory }) {
    super(host);
    this.runtime = runtime;
    this.ai = ai;
    this.memory = memory;
    this.pulse = {};
    const ping = (agent) => { this.pulse[agent] = Date.now(); this.invalidate(); };

    this.on(EV.HANDS, () => ping('vision'));
    this.on(EV.CAM_START, () => ping('vision'));
    this.on(EV.GESTURE, () => ping('vision'));
    this.on(EV.STT_START, () => ping('voice'));
    this.on(EV.TTS_START, () => ping('voice'));
    this.on(EV.AI_STREAM_START, () => ping('ai'));
    this.on(EV.AI_MEMORY_UPDATED, () => ping('memory'));
    this.on('memory:ready', () => ping('memory'));
    this.on('desktop:action-executed', () => ping('desktop'));
    this.on('desktop:action-denied', () => ping('desktop'));
    this.on('desktop:permission-changed', () => this.invalidate());
    ['cameraActive', 'sttActive', 'aiStreaming', 'handCount', 'faceCount'].forEach(k => this.watch(k, () => this.invalidate()));
    setInterval(() => this.invalidate(), 3000);
    this.render();
  }

  /** Each agent's status derives from live state — no static text. */
  _agents() {
    const s = state.get();
    const perms = this.runtime?.permissions?.summary?.() || { granted: 0, total: 0 };
    const rt = this.runtime?.status?.() || {};
    const memStats = this._memStats || {};
    return [
      { id: 'ai', icon: '◈', name: 'AI Agent',
        active: s.aiStreaming,
        status: s.aiStreaming ? 'generating' : (this.ai?.providerLabel || 'ready'),
        detail: s.aiModel || 'offline core' },
      { id: 'vision', icon: '◉', name: 'Vision Agent',
        active: s.cameraActive,
        status: s.cameraActive ? `tracking · ${s.visionFps} FPS` : 'camera off',
        detail: s.cameraActive
          ? `${s.handCount} hands · ${s.faceCount} faces · ${s.objectCount} objects`
          : 'awaiting activation' },
      { id: 'voice', icon: '◎', name: 'Voice Agent',
        active: s.sttActive || s.ttsSpeaking,
        status: s.sttActive ? 'listening' : s.ttsSpeaking ? 'speaking' : 'idle',
        detail: `STT ${s.sttSupported ? 'ready' : 'unsupported'} · TTS ${s.ttsSupported ? 'ready' : 'unsupported'}` },
      { id: 'memory', icon: '▦', name: 'Memory Agent',
        active: false,
        status: `${memStats.conversation?.total ?? 0} msgs`,
        detail: `${memStats.preferences?.total ?? 0} prefs · ${memStats.knowledge?.documents ?? 0} docs` },
      { id: 'desktop', icon: '▣', name: 'Desktop Agent',
        active: rt.transport && rt.transport !== 'browser',
        status: rt.simulated ? 'simulated' : (rt.transport || 'unavailable'),
        detail: `${perms.granted}/${perms.total} permissions` },
    ];
  }

  async refreshMemStats() {
    if (!this.memory) return;
    try { this._memStats = await this.memory.stats(); this.invalidate(); } catch {}
  }

  render() {
    if (!this.host) return;
    const now = Date.now();
    this.host.innerHTML = this._agents().map(a => {
      const recent = this.pulse[a.id] && now - this.pulse[a.id] < 1200;
      return `<div class="cc-agent ${a.active ? 'active' : ''} ${recent ? 'pulse' : ''}">
        <span class="cc-agent-ico">${a.icon}</span>
        <div class="cc-agent-main">
          <div class="cc-agent-name">${a.name}</div>
          <div class="cc-agent-detail">${escapeHtml(a.detail)}</div>
        </div>
        <span class="cc-agent-status">${escapeHtml(a.status)}</span>
      </div>`;
    }).join('');
  }
}

/* ══════════════════════════════════════════════════════════════════════
   4. MEMORY CENTER
   ══════════════════════════════════════════════════════════════════════ */

export class MemoryCenter extends Panel {
  constructor(host, { memory, ai }) {
    super(host);
    this.memory = memory;
    this.ai = ai;
    this.timeline = [];
    this.stats = null;

    const note = (type, text) => {
      this.timeline.push({ type, text, t: Date.now() });
      if (this.timeline.length > 30) this.timeline.shift();
      this.refresh();
    };
    this.on(EV.AI_USER_MESSAGE, ({ text }) => note('write', `User: ${text.slice(0, 44)}`));
    this.on(EV.AI_STREAM_END, () => note('write', 'Assistant reply stored'));
    this.on(EV.AI_MEMORY_UPDATED, ({ cleared }) => { if (cleared) note('clear', 'Conversation cleared'); });
    this.on('memory:cleared', ({ scope }) => note('clear', `Cleared ${scope} memory`));
    this.on('memory:ready', () => this.refresh());
    this.refresh();
  }

  async refresh() {
    if (this.memory) { try { this.stats = await this.memory.stats(); } catch {} }
    this.invalidate();
  }

  render() {
    if (!this.host) return;
    const st = this.stats;
    const conv = this.ai?.memory?.all() || [];
    const recent = conv.slice(-4).reverse();

    const cat = (label, value, detail) =>
      `<div class="cc-mem-cat"><div class="cc-mem-val">${value}</div>
        <div class="cc-mem-label">${label}</div>
        <div class="cc-mem-detail">${escapeHtml(detail || '')}</div></div>`;

    this.host.innerHTML = `
      <div class="cc-mem-grid">
        ${cat('CONVERSATION', st?.conversation?.total ?? conv.length, `window ${st?.conversation?.windowTurns ?? '—'} turns`)}
        ${cat('PREFERENCES', st?.preferences?.total ?? 0, 'durable facts')}
        ${cat('KNOWLEDGE', st?.knowledge?.documents ?? 0, st?.knowledge?.backend || 'no store')}
        ${cat('SYSTEM', st?.system?.events ?? 0, `${st?.system?.runningApps ?? 0} apps tracked`)}
      </div>
      <div class="cc-sub">RECENT MEMORY</div>
      <div class="cc-mem-list">
        ${recent.length ? recent.map(m => `
          <div class="cc-mem-item ${m.role}">
            <span class="cc-mem-role">${m.role === 'user' ? '👤' : '◈'}</span>
            <span class="cc-mem-text">${escapeHtml(m.content.slice(0, 70))}${m.content.length > 70 ? '…' : ''}</span>
          </div>`).join('')
          : '<div class="cc-empty">No conversation memory yet.</div>'}
      </div>
      <div class="cc-sub">ACTIVITY</div>
      <div class="cc-mem-timeline">
        ${this.timeline.length ? this.timeline.slice(-6).reverse().map(t => `
          <div class="cc-tl ${t.type}">
            <span class="cc-tl-time">${new Date(t.t).toLocaleTimeString('en-GB', { hour12: false })}</span>
            <span>${escapeHtml(t.text)}</span>
          </div>`).join('')
          : '<div class="cc-empty">No memory operations recorded.</div>'}
      </div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   5. VOICE COMMAND INTERFACE
   ══════════════════════════════════════════════════════════════════════ */

export class VoiceInterface extends Panel {
  constructor(host, { voice }) {
    super(host);
    this.voice = voice;
    this.mode = 'idle';           // idle | listening | processing | speaking
    this.transcript = '';
    this.level = new Array(28).fill(0.06);
    this._anim = null;

    this.on(EV.STT_START, () => this._mode('listening'));
    this.on(EV.STT_PARTIAL, ({ text }) => { this.transcript = text; this.invalidate(); });
    this.on(EV.STT_FINAL, ({ text }) => { this.transcript = text; this._mode('processing'); });
    this.on(EV.STT_END, () => { if (this.mode === 'listening') this._mode('idle'); });
    this.on(EV.AI_STREAM_START, () => { if (this.mode !== 'speaking') this._mode('processing'); });
    this.on(EV.TTS_START, () => this._mode('speaking'));
    this.on(EV.TTS_END, () => this._mode('idle'));
    this.on(EV.TTS_INTERRUPT, () => this._mode('idle'));
    // Viseme openness is a real signal from the TTS engine — drive the bars with it.
    this.on(EV.TTS_VISEME, ({ visemes }) => {
      const open = visemes?.[0]?.open ?? 0;
      this.level.push(0.1 + open * 0.9);
      this.level.shift();
    });
    this.on(EV.AI_STREAM_END, () => { if (this.mode === 'processing') this._mode('idle'); });

    this._mode('idle');
    this._loop();
  }

  _mode(m) {
    this.mode = m;
    if (m === 'idle') this.transcript = '';
    state.set({ voiceMode: m });
    this.invalidate(true);
  }

  /** Animate the waveform only while active — no wasted frames when idle. */
  _loop() {
    const step = () => {
      this._anim = requestAnimationFrame(step);
      if (this.mode === 'listening') {
        // Amplitude is synthetic here ONLY as a liveness indicator; the
        // browser does not expose mic amplitude without an analyser node.
        this.level.push(0.15 + Math.random() * 0.5);
        this.level.shift();
        this._paintBars();
      } else if (this.mode === 'speaking') {
        this._paintBars();
      } else if (this.mode === 'processing') {
        const t = performance.now() / 200;
        for (let i = 0; i < this.level.length; i++) {
          this.level[i] = 0.1 + Math.abs(Math.sin(t + i * 0.3)) * 0.25;
        }
        this._paintBars();
      }
    };
    this._anim = requestAnimationFrame(step);
  }

  _paintBars() {
    const bars = this.host?.querySelectorAll('.cc-wave-bar');
    if (!bars?.length) return;
    for (let i = 0; i < bars.length; i++) {
      bars[i].style.transform = `scaleY(${Math.max(0.06, this.level[i] ?? 0.06)})`;
    }
  }

  render() {
    if (!this.host) return;
    const labels = {
      idle: { t: 'STANDBY', d: 'Press the mic or say the wake word' },
      listening: { t: 'LISTENING', d: this.transcript || 'Speak now…' },
      processing: { t: 'PROCESSING', d: this.transcript || 'Reasoning…' },
      speaking: { t: 'SPEAKING', d: 'Synthesising response' },
    };
    const L = labels[this.mode] || labels.idle;
    this.host.innerHTML = `
      <div class="cc-voice ${this.mode}">
        <div class="cc-voice-orb"><span></span></div>
        <div class="cc-wave">${this.level.map(() => '<i class="cc-wave-bar"></i>').join('')}</div>
        <div class="cc-voice-meta">
          <div class="cc-voice-state">${L.t}</div>
          <div class="cc-voice-detail">${escapeHtml(L.d)}</div>
        </div>
      </div>`;
    this._paintBars();
  }

  destroy() { super.destroy(); if (this._anim) cancelAnimationFrame(this._anim); }
}

/* ══════════════════════════════════════════════════════════════════════
   6. PLUGIN & TOOL CENTER
   ══════════════════════════════════════════════════════════════════════ */

export class PluginCenter extends Panel {
  constructor(host, { plugins, runtime }) {
    super(host);
    this.plugins = plugins;
    this.runtime = runtime;
    this.on(EV.PLUGIN_REGISTERED, () => this.invalidate());
    this.on('desktop:plugin-registered', () => this.invalidate());
    this.on('desktop:permission-changed', () => this.invalidate());
    this.render();
  }

  render() {
    if (!this.host) return;
    // Straight from the live registries — nothing hand-listed.
    const cmdPlugins = this.plugins?.list?.() || [];
    const cmds = this.plugins?.listCommands?.() || [];
    const dtPlugins = this.runtime?.desktop?.actions?.listPlugins?.() || [];
    const actions = this.runtime?.desktop?.actions?.listActions?.() || [];
    const perms = this.runtime?.permissions;

    this.host.innerHTML = `
      <div class="cc-plug-head">
        <span><b>${cmdPlugins.length}</b> plugins · <b>${cmds.length}</b> commands</span>
        <span><b>${dtPlugins.filter(p => p.available).length}</b>/<b>${dtPlugins.length}</b> desktop ready</span>
      </div>
      <div class="cc-sub">DESKTOP PLUGINS</div>
      <div class="cc-plug-list">
        ${dtPlugins.map(p => `
          <div class="cc-plug ${p.available ? 'on' : ''}">
            <span class="cc-plug-ico">${p.icon}</span>
            <div class="cc-plug-main">
              <div class="cc-plug-name">${escapeHtml(p.name)}</div>
              <div class="cc-plug-acts">${p.actions.slice(0, 4).map(escapeHtml).join(' · ')}</div>
            </div>
            <span class="cc-plug-badge ${p.available ? 'ok' : ''}">${escapeHtml(p.available ? 'READY' : p.status)}</span>
          </div>`).join('') || '<div class="cc-empty">No desktop plugins.</div>'}
      </div>
      <div class="cc-sub">TOOLS (${actions.length})</div>
      <div class="cc-tool-grid">
        ${actions.map(a => {
          const granted = !a.permission || perms?.isGranted(a.permission);
          return `<span class="cc-tool ${granted ? 'on' : ''}" title="${escapeHtml(a.description || '')}">${granted ? '●' : '🔒'} ${escapeHtml(a.id)}</span>`;
        }).join('')}
      </div>
      <div class="cc-sub">COMMAND PLUGINS</div>
      <div class="cc-tool-grid">
        ${cmdPlugins.map(p => `<span class="cc-tool on" title="${escapeHtml(p.description || '')}">${escapeHtml(p.name)}</span>`).join('')}
      </div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   7. ACTIVITY FEED
   ══════════════════════════════════════════════════════════════════════ */

/** Events too noisy for a human-readable feed. */
const FEED_MUTE = new Set([
  'vision:hands', 'vision:faces', 'vision:objects', 'voice:tts-viseme',
  'ai:stream-delta', 'gesture:pointer', 'metrics:sample', 'sys:log',
]);

const FEED_STYLE = {
  ai: { icon: '◈', cls: 'ai' }, voice: { icon: '◎', cls: 'voice' },
  vision: { icon: '◉', cls: 'vision' }, gesture: { icon: '✋', cls: 'gesture' },
  desktop: { icon: '▣', cls: 'desktop' }, plugin: { icon: '🔌', cls: 'plugin' },
  memory: { icon: '▦', cls: 'memory' }, runtime: { icon: '⚙', cls: 'runtime' },
  hardware: { icon: '⚡', cls: 'runtime' }, sys: { icon: '●', cls: 'sys' },
  ui: { icon: '▢', cls: 'sys' }, core: { icon: '◈', cls: 'ai' },
  action: { icon: '▶', cls: 'desktop' }, live: { icon: '🌐', cls: 'plugin' },
  ar: { icon: '◈', cls: 'sys' }, avatar: { icon: '☺', cls: 'sys' },
};

export class ActivityFeed extends Panel {
  constructor(host) {
    super(host);
    this.items = [];
    this.limit = 60;
    this.paused = false;
    // One wildcard subscription captures the whole system.
    this._subs.push(bus.on('*', ({ event, payload }) => this._add(event, payload)));
    this.render();
  }

  _add(event, payload) {
    if (this.paused || FEED_MUTE.has(event)) return;
    const [ns] = event.split(':');
    const text = this._describe(event, payload);
    if (!text) return;
    this.items.push({ t: Date.now(), event, ns, text });
    if (this.items.length > this.limit) this.items.shift();
    this.invalidate();
  }

  /** Turn raw events into readable lines. Returns null to skip. */
  _describe(event, p) {
    switch (event) {
      case EV.AI_USER_MESSAGE: return `Input: "${trunc(p?.text, 44)}"`;
      case EV.AI_STREAM_START: return `Generating via ${p?.provider || 'core'}${p?.model ? ` · ${p.model}` : ''}`;
      case EV.AI_STREAM_END: return 'Response complete';
      case EV.AI_STREAM_ABORT: return 'Generation aborted';
      case EV.AI_ERROR: return `AI error: ${trunc(p?.message, 40)}`;
      case 'ai:routed': return `Routed → ${p?.decision?.route?.toUpperCase()} (${p?.decision?.reason})`;
      case 'ai:tool-call': return `Tool call: ${p?.calls?.map(c => c.tool).join(', ')}`;
      case EV.STT_START: return 'Microphone open';
      case EV.STT_FINAL: return `Heard: "${trunc(p?.text, 40)}"`;
      case EV.STT_ERROR: return `Mic error: ${trunc(p?.message, 40)}`;
      case EV.TTS_START: return 'Speech synthesis started';
      case EV.TTS_END: return 'Speech complete';
      case EV.CAM_START: return 'Camera online';
      case EV.CAM_STOP: return 'Camera offline';
      case EV.CAM_ERROR: return `Camera: ${trunc(p?.message, 40)}`;
      case EV.GESTURE: return `Gesture: ${p?.gesture} (${Math.round((p?.confidence || 0) * 100)}%)`;
      case EV.PLUGIN_REGISTERED: return `Plugin loaded: ${p?.name}`;
      case 'desktop:plugin-registered': return `Desktop plugin: ${p?.name}`;
      case 'desktop:action-executed': return `Action ✓ ${p?.action}`;
      case 'desktop:action-denied': return `Action ✗ ${p?.action} — ${p?.code}`;
      case 'desktop:permission-changed': return `Permission ${p?.granted ? 'granted' : 'revoked'}: ${p?.id}`;
      case EV.AI_MEMORY_UPDATED: return p?.cleared ? 'Memory cleared' : null;
      case 'memory:cleared': return `Memory cleared: ${p?.scope}`;
      case 'memory:ready': return 'Memory subsystem ready';
      case 'runtime:ready': return `Runtime ready · ${p?.transport}`;
      case 'hardware:ready': return `Hardware probed · ${p?.filter?.(x => x.available).length ?? ''} available`;
      case EV.READY: return 'AURA online';
      case EV.ERROR: return `Error: ${trunc(p?.error?.message || p?.source, 40)}`;
      case 'live:data': return `Live data: ${p?.intent?.type}`;
      case 'ar:enter': return `AR mode: ${p?.mode}`;
      case EV.UI_TOAST: return null;
      default: return null;
    }
  }

  render() {
    if (!this.host) return;
    if (!this.items.length) {
      this.host.innerHTML = '<div class="cc-empty">Awaiting system activity…</div>';
      return;
    }
    this.host.innerHTML = this.items.slice(-40).reverse().map(i => {
      const st = FEED_STYLE[i.ns] || FEED_STYLE.sys;
      return `<div class="cc-feed-item ${st.cls}">
        <span class="cc-feed-ico">${st.icon}</span>
        <span class="cc-feed-time">${new Date(i.t).toLocaleTimeString('en-GB', { hour12: false })}</span>
        <span class="cc-feed-text">${escapeHtml(i.text)}</span>
      </div>`;
    }).join('');
  }
}

function trunc(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/* ══════════════════════════════════════════════════════════════════════
   ORCHESTRATOR
   ══════════════════════════════════════════════════════════════════════ */

export class CommandCenter {
  /** @param {{ai:object, runtime:object, memory:object, plugins:object, voice:object, metrics:object}} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.panels = {};
    this.mounted = false;
  }

  mount() {
    if (this.mounted) return;
    const mk = (Cls, hostId, args) => {
      const host = $(hostId);
      if (!host) { console.warn(`[command-center] missing host #${hostId}`); return null; }
      return new Cls(host, args);
    };
    const { ai, runtime, memory, plugins, voice, metrics } = this.ctx;

    this.panels.core = mk(AICorePanel, 'cc-ai-core', { ai });
    this.panels.system = mk(SystemMonitor, 'cc-system', { metrics, runtime });
    this.panels.agents = mk(AgentPanel, 'cc-agents', { runtime, ai, memory });
    this.panels.memory = mk(MemoryCenter, 'cc-memory', { memory, ai });
    this.panels.voice = mk(VoiceInterface, 'cc-voice', { voice });
    this.panels.plugins = mk(PluginCenter, 'cc-plugins', { plugins, runtime });
    this.panels.feed = mk(ActivityFeed, 'cc-feed', {});

    this.panels.agents?.refreshMemStats();
    this.mounted = true;
    bus.emit('ui:command-center-ready', { panels: Object.keys(this.panels).filter(k => this.panels[k]) });
    return this;
  }

  refresh() {
    for (const p of Object.values(this.panels)) p?.invalidate?.();
    this.panels.memory?.refresh?.();
    this.panels.agents?.refreshMemStats?.();
  }

  destroy() {
    for (const p of Object.values(this.panels)) p?.destroy?.();
    this.panels = {};
    this.mounted = false;
  }
}

export default CommandCenter;
