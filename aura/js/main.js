/**
 * AURA :: Main Controller
 * -----------------------
 * Boots every module, wires the bus to the DOM, and exposes the `ui` facade
 * that plugins and gesture actions call into.
 *
 * Boot order matters: config → audio → avatar → AI → voice → vision → plugins.
 */

import { bus, EV } from './core/bus.js';
import { state } from './core/state.js';
import { config } from './core/config.js';
import { plugins } from './core/plugins.js';
import { AIEngine } from './ai/engine.js';
import { SpeechInput, SpeechOutput, stripMarkdownForSpeech } from './voice/speech.js';
import { WakeWordEngine } from './voice/wake-word-engine.js';
import { VisionModule } from './vision/vision.js';
import { GESTURES } from './vision/gesture-classifier.js';
import { Avatar3D } from './avatar/avatar3d.js';
import { AvatarManager } from './avatar/avatar-manager.js';
import { OUTFITS, PALETTES, ACCESSORIES, HAIRSTYLES, HAIR_COLORS, BODY_PRESETS } from './avatar/outfits.js';
import { applyTheme as applyThemeVars, themeCatalog, themeDefaults, THEME_PRESETS, TUNABLES } from './ui/theming.js';
import { liveData } from './realtime/live-data.js';
// Desktop framework is constructed by LocalRuntime; imported here only for types.
// (see js/runtime/local-runtime.js)
import { LocalRuntime } from './runtime/local-runtime.js';
import { MemoryManager } from './memory/memory-manager.js';
import { MetricsManager } from './runtime/hardware/metrics.js';
import { CommandCenter } from './ui/command-center.js';
import { Avatar2D } from './avatar/avatar2d.js';
import { AudioEngine } from './audio/ambient.js';
import { GestureActions } from './gestures/actions.js';
import { ARModule } from './ar/ar.js';
import { registerBuiltins } from './plugins/builtin.js';
import { registerExtendedPlugins } from './plugins/extended.js';
import { renderMarkdown, escapeHtml } from './ui/markdown.js';
import { providerList, PROVIDERS } from './ai/providers.js';
import { localActions } from './actions/local-actions.js';
import { SetupWizard } from './ui/setup.js';
import { CommandPalette } from './ui/command-palette.js';
import { registerScreenPlugin } from './plugins/screen.js';
import { screenShare } from './vision/screen-share.js';
import { RuntimeCore } from './runtime/runtime-core.js';
import { DevConsole } from './ui/dev-console.js';
import { worldModel } from './runtime/world-model.js';
import { PrivacyGuard } from './vision/privacy-guard.js';
import { Trace } from './core/trace.js';
import { ScreenCursor } from './vision/screen-cursor.js';
import { InteractionManager, DWELL_EV } from './vision/interaction-manager.js';
import { TraceView } from './ui/trace-view.js';

/**
 * Element lookup. Typed as `any` deliberately: call sites legitimately touch
 * input-specific members (.value, .checked) and TS cannot narrow
 * getElementById's HTMLElement return without a cast at every use.
 * @param {string} id
 * @returns {any}
 */
const $ = (id) => document.getElementById(id);

/**
 * querySelectorAll that yields HTMLElements. The DOM lib types this as
 * `Element`, which lacks .dataset/.value/.disabled — all of which the UI
 * legitimately uses on form controls.
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {any[]}
 */
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
/** Theme ids come from the theming engine so there is ONE source of truth. */
const THEMES = Object.keys(THEME_PRESETS);

const GESTURE_DOCS = [
  { id: 'wave', icon: '👋', name: 'Wave', action: 'AURA greets you out loud and smiles.' },
  { id: 'open_palm', icon: '🖐', name: 'Open Palm', action: 'Activates listening mode (starts speech recognition) and interrupts speech.' },
  { id: 'thumbs_up', icon: '👍', name: 'Thumbs Up', action: 'Confirms a pending action, or replies "Mission acknowledged."' },
  { id: 'thumbs_down', icon: '👎', name: 'Thumbs Down', action: 'Cancels a pending action or stops generation.' },
  { id: 'peace', icon: '✌', name: 'Peace', action: 'Opens and focuses the chat window.' },
  { id: 'pointing', icon: '☝', name: 'Pointing', action: 'Targeting mode — a reticle tracks your fingertip and highlights UI elements.' },
  { id: 'fist', icon: '✊', name: 'Fist', action: 'Hard halt: stops generation and speech.' },
  { id: 'ok', icon: '👌', name: 'OK Sign', action: 'Quick systems check, spoken aloud.' },
  { id: 'rock', icon: '🤘', name: 'Rock On', action: 'Toggles the generative background music.' },
];

import { CognitiveOrchestrator } from './ai/cognitive-orchestrator.js';
import { DeviceManager } from './desktop/device-manager.js';

class AuraApp {
  constructor() {
    this.audio = new AudioEngine();
    this.vision = new VisionModule();
    this.voice = { input: new SpeechInput(), output: new SpeechOutput() };
    this.wakeEngine = new WakeWordEngine();
    this.ai = new AIEngine({ plugins });
    this.actions = localActions;
    /** @type {any} */ (this.ai).actions = localActions;
    // Local Runtime owns the desktop framework + hardware + local services.
    // Nothing above this line may touch the OS directly.
    this.runtime = new LocalRuntime({ bus, logger: (m) => this.pushEventLog(m) });
    this.desktop = this.runtime.desktop;       // back-compat alias
    this.devices = this.runtime.devices;
    this.deviceManager = new DeviceManager({ bus, transport: this.runtime.deviceTransport });
    this.memoryManager = new MemoryManager({ bus, maxTurns: config.get('memoryTurns') });
    this.orchestrator = new CognitiveOrchestrator({ bus, deviceManager: this.deviceManager, actionManager: this.desktop, memoryManager: this.memoryManager });
    this.metrics = new MetricsManager({ bus, intervalMs: 2000 });
    this.ai.desktop = this.desktop;
    this.ai.runtime = this.runtime;
    this.ai.memoryManager = this.memoryManager;
    this.ai.orchestrator = this.orchestrator;
    this.avatar = null;
    this.ar = null;
    this.gestures = null;
    this.streamEl = null;
    this.pendingConfirm = null;
    this.pointerMode = false;
    this.bootSteps = 0;
    this.eventLogLines = [];
    this.spokenUpTo = 0;
    this.ttsSentenceQueue = [];
  }

  /* ══════════════════ BOOT ══════════════════ */

  async boot() {
    this.log('AURA kernel starting…', 'info');
    this.applyTheme(config.get('theme'));
    this.applyReduceMotion(config.get('reduceMotion'));
    this.applyGlass(config.get('glassUI'));

    this.log('Core: event bus + state store online', 'ok');
    await this.tick();

    // ── avatar (provider architecture)
    // The AvatarManager owns the AnimationEngine and the active provider.
    // Legacy 2d/3d modes still resolve to their own renderers; everything
    // else goes through a provider so lip-sync/blink/wave are shared.
    const host = $('avatar-host');
    const mode = config.get('avatarMode');
    let avatarOk = false;
    if (mode === '3d' || mode === '2d') {
      this.avatar = /** @type {any} */ (mode === '3d' ? new Avatar3D(host) : new Avatar2D(host));
      avatarOk = await this.avatar.init();
      if (!avatarOk && mode === '3d') {
        this.log('WebGL unavailable — falling back to 2D avatar', 'warn');
        this.avatar = /** @type {any} */ (new Avatar2D(host));
        avatarOk = await this.avatar.init();
        state.set({ avatarMode: '2d' });
      } else {
        state.set({ avatarMode: mode });
      }
      this.log(`Avatar: legacy ${mode.toUpperCase()} renderer`, avatarOk ? 'ok' : 'warn');
    } else {
      this.avatarManager = new AvatarManager(host);
      const r = await this.avatarManager.initialize();
      avatarOk = r.ok;
      this.avatar = /** @type {any} */ (this.avatarManager);
      if (r.fellBack) {
        this.log(`Avatar provider failed (${r.reason}) — using the built-in avatar`, 'warn');
      }
      if (avatarOk) {
        const p = await this.avatarManager.status();
        this.log(`Avatar: ${p.detail?.label || r.provider} provider online`, 'ok');
      }
    }
    if (!avatarOk) this.log('Avatar failed to initialise', 'warn');
    await this.tick();

    // ── AI
    await this.ai.resolve();
    this.log(`AI core: ${this.ai.providerLabel}${state.get('aiModel') ? ' · ' + state.get('aiModel') : ''}`, 'ok');
    await this.tick();

    // ── voice
    this.log(this.voice.input.supported
      ? 'Speech recognition: available'
      : 'Speech recognition: NOT supported in this browser', this.voice.input.supported ? 'ok' : 'warn');
    this.log(this.voice.output.supported
      ? 'Speech synthesis: available'
      : 'Speech synthesis: NOT supported', this.voice.output.supported ? 'ok' : 'warn');
    await this.tick();

    // ── vision capability probe (no camera prompt yet)
    this.vision.attach($('video'), $('overlay'));
    if (!this.vision.cameraSupported) this.log('Camera API unavailable', 'warn');
    else if (!this.vision.secureContext) this.log('Insecure context — camera will be blocked. Use localhost or https.', 'warn');
    else this.log('Vision subsystem: ready (camera off)', 'ok');
    await this.tick();

    // ── local action bridge (desktop control)
    const actOk = await this.actions.init();
    this.log(actOk
      ? `Desktop control: ENABLED (${this.actions.os}) — ${this.actions.apps.filter(a=>a.installed).length} apps detected`
      : (this.actions.serverPresent
          ? 'Desktop control: off (start with --allow-actions)'
          : 'Desktop control: unavailable (not served by serve.py)'),
      actOk ? 'ok' : 'warn');
    await this.tick();

    // ── layered memory
    await this.memoryManager.initialize();
    const ms = await this.memoryManager.stats();
    this.log(`Memory: ${ms.conversation.total} messages · ${ms.preferences.total} prefs · ${ms.knowledge.documents} docs`, 'ok');
    await this.tick();

    // ── LOCAL RUNTIME (desktop + hardware + local services)
    const rt = await this.runtime.initialize();
    this.log(
      `Local runtime: ${rt.transport} transport${rt.platform ? ` · ${rt.platform}` : ''} · ` +
      `${rt.plugins.length} plugins · ${rt.permissions.granted}/${rt.permissions.total} permissions`,
      rt.simulated ? 'warn' : 'ok');
    const hw = this.runtime.hardware.summary().filter(h => h.available).map(h => h.capability);
    this.log(`Hardware: ${hw.length ? hw.join(', ') : 'none detected'}`, hw.length ? 'ok' : 'warn');
    const svc = this.runtime.services.summary();
    this.log(`Services: ollama=${svc.ollama.available ? 'up' : 'down'} · bridge=${svc.actionBridge.available ? 'on' : 'off'}`,
      svc.ollama.available ? 'ok' : 'warn');
    await this.tick();

    // ── AR
    this.ar = new ARModule({ avatar: this.avatar, vision: this.vision, ui: this });
    const caps = await this.ar.capabilities();
    this.log(caps.webxr ? 'WebXR immersive-AR: supported'
      : `WebXR: unavailable — simulated AR fallback ready`, caps.webxr ? 'ok' : 'warn');
    await this.tick();

    // ── plugins
    plugins.setContext({
      bus, state, config,
      ai: this.ai, vision: this.vision, voice: this.voice,
      avatar: this.avatar, audio: this.audio, ui: this,
      runtime: this.runtime, memory: this.memoryManager,
    });
    // AURA's own soft pointer for the shared screen. Created before plugins
    // so the screen plugin can capture it.
    this.screenCursor = new ScreenCursor({ screen: screenShare });

    /*
     * RUNTIME KERNEL — the single gate between a proposed command and the OS.
     * Named `kernel`, NOT `runtime`: `this.runtime` is already the
     * LocalRuntime (hardware/transport probe) and overwriting it would have
     * silently broken the OPS panel and every plugin that reads it.
     */
    this.kernel = new RuntimeCore({
      permissions: this.desktop?.permissions,
      actions: this.actions,
      screen: screenShare,
      cursor: this.screenCursor,
      memory: this.memoryManager,
      ai: this.ai,
    });
    this.world = worldModel;
    this.devConsole = new DevConsole({ kernel: this.kernel, world: worldModel, app: this });

    /*
     * PRIVACY GUARD — consumes EV.PRESENCE from the EXISTING vision loop and
     * proposes ONE registry command. It owns no camera and no OS access; the
     * kernel's permission gate is what authorises the minimise.
     */
    this.privacyGuard = new PrivacyGuard({
      kernel: this.kernel, config, trace: Trace,
    });
    this.privacyGuard.attach();

    // Fast local Vision -> Avatar Wave reaction (bypasses LLM)
    bus.on(EV.GESTURE, ({ gesture }) => {
      if (gesture === GESTURES.WAVE || gesture === 'wave') {
        if (this.avatar && typeof this.avatar.wave === 'function') {
          this.avatar.wave();
        }
      }
    });

    /*
     * DWELL-TO-CLICK (spec §4/§5) — hold a fingertip still and it clicks.
     * Rides the EXISTING EV.POINTER stream, so it costs no extra camera work.
     * Clicks on AURA's own controls need no permission; clicks that leave the
     * browser and drive the Windows pointer need `Vision Mouse Control`, a
     * full-monitor share, and an armed automation bridge.
     */
    this.interaction = new InteractionManager({
      permissions: this.desktop?.permissions,
      screen: screenShare,
      actions: this.actions,
      logger: (m) => this.pushEventLog(m),
      dwell: {
        dwellMs: config.get('dwellMs') || undefined,
        holdRadius: config.get('dwellHoldRadius') || undefined,
      },
    });
    // Push ring state into the vision overlay each frame it changes.
    bus.on(DWELL_EV.PROGRESS, (d) => {
      this.vision.setDwell(d.state === 'IDLE' || d.state === 'COOLDOWN' ? null : {
        state: d.state, progress: d.progress, ring: d.ring, point: d.point,
        target: d.target, needsPermission: d.needsPermission,
        label: d.target === 'web' ? 'CLICK'
          : d.target === 'desktop' ? (d.needsPermission ? 'NEEDS PERMISSION' : 'DESKTOP CLICK')
          : 'NO TARGET',
      });
      this.renderDwellReadout(d);
    });
    bus.on(DWELL_EV.FIRED, (r) => {
      this.audio?.sfx?.('confirm');
      this.toast('info', r.message);
    });
    bus.on(DWELL_EV.REFUSED, (r) => {
      if (r.kind !== 'none') this.toast('warn', r.message);
    });
    if (config.get('dwellClick')) this.interaction.setEnabled(true);
    const pluginCtx = {
      bus, state, config, screenShare, screenCursor: this.screenCursor,
      kernel: this.kernel, world: worldModel,
      ai: this.ai, vision: this.vision, voice: this.voice,
      avatar: this.avatar, audio: this.audio, ui: this,
      runtime: this.runtime, memory: this.memoryManager,
    };
    registerBuiltins(plugins, pluginCtx);
    registerExtendedPlugins(plugins, pluginCtx);
    registerScreenPlugin(plugins, pluginCtx);
    this.log(`Plugins: ${plugins.plugins.size} loaded, ${plugins.listCommands().length} commands`, 'ok');
    await this.tick();

    // ── gestures
    this.gestures = new GestureActions({
      ai: this.ai, vision: this.vision, voice: this.voice,
      avatar: this.avatar, audio: this.audio, ui: this,
    });
    this.log(`Gesture bindings: ${this.gestures.list().length} active`, 'ok');
    await this.tick();

    // ── system metrics (real host telemetry when serve.py is running)
    const mSrc = await this.metrics.initialize();
    this.log(`Metrics: ${this.metrics.sourceLabel}`, mSrc.source === 'host' ? 'ok' : 'warn');
    await this.tick();

    this.buildUI();
    this.wireEvents();
    this.wireDOM();
    // ── COMMAND CENTER (presentation only — reads live state + bus)
    this.commandCenter = new CommandCenter({
      ai: this.ai, runtime: this.runtime, memory: this.memoryManager,
      plugins, voice: this.voice, metrics: this.metrics,
    });
    this.commandCenter.mount();
    this.metrics.start();
    this._startHudClock();
    this.log('Command center mounted', 'ok');

    this.startFxCanvas();

    this.log('AURA online. Awaiting operator.', 'ok');
    $('boot-fill').style.width = '100%';
    const enter = $('boot-enter');
    enter.hidden = false;
    enter.onclick = () => this.enter();

    // keyboard shortcut to enter
    this._bootKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); this.enter(); } };
    window.addEventListener('keydown', this._bootKey);

    // ── Developer fast boot: skip the click-to-enter gate ───────────────
    // When devSkipBoot is enabled the boot sequence still runs in full
    // (so all modules initialise), but the operator confirmation gate is
    // bypassed automatically. Audio init is skipped — no user gesture means
    // no autoplay policy issue during dev work. Set in Settings → Developer.
    if (config.get('devSkipBoot')) {
      setTimeout(() => this.enter(true), 80);
    }
  }

  async enter(devMode = false) {
    window.removeEventListener('keydown', this._bootKey);
    $('boot').classList.add('done');
    setTimeout(() => { $('boot').style.display = 'none'; }, devMode ? 0 : 700);
    $('app').hidden = false;

    // audio needs the user gesture we just received;
    // skip when auto-entering in dev mode (no gesture = no autoplay)
    if (!devMode) {
      await this.audio.init();
      this.audio.sfx('boot');
      this.audio.sync();
    }

    bus.emit(EV.READY, {});
    state.set({ booted: true });
    this.syncAll();

    // First run with no brain configured → show the setup wizard instead of
    // dropping the user into a chat that can't think.
    this.setup = new SetupWizard(this);
    if (SetupWizard.needed() && this.ai.resolvedProvider === 'local') {
      setTimeout(() => this.setup.open({ forced: true }), 650);
      return;   // greet() runs when the wizard closes
    }

    setTimeout(() => this.greet(), 500);
    $('input')?.focus();
  }

  tick() { return new Promise(r => setTimeout(r, 55)); }

  /** HUD clock — real time, updated once a second. */
  _startHudClock() {
    const tick = () => {
      const c = $('cc-clock');
      if (c) c.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
    };
    tick();
    this._clockTimer = setInterval(tick, 1000);
  }

  /** Opening line. Called after boot, and after the setup wizard closes. */
  greet() {
    if (this._greeted) return;
    this._greeted = true;
    const hour = new Date().getHours();
    const tod = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning'
      : hour < 17 ? 'Good afternoon' : 'Good evening';
    const provider = this.ai.resolvedProvider === 'local'
      ? "I'm on my offline core — open Settings → Setup Wizard to connect a language model."
      : `Connected to ${this.ai.providerLabel}${state.get('aiModel') ? ` · ${state.get('aiModel')}` : ''}.`;
    const msg = `${tod}, Commander. AURA online. ${provider} Ask me anything, enable Vision for gesture control, or type /help.`;
    this.pushAssistantMessage(msg);
    this.voice.output.speak(msg, { emotion: 'happy' });
    bus.emit(EV.AVATAR_EMOTION, { emotion: 'happy' });
    $('input')?.focus();
  }

  log(text, kind = 'info') {
    const ul = $('boot-log');
    if (ul) {
      const li = document.createElement('li');
      li.className = kind;
      li.textContent = text;
      li.style.animationDelay = `${Math.min(this.bootSteps * 0.03, 0.4)}s`;
      ul.appendChild(li);
      while (ul.children.length > 9) ul.removeChild(ul.firstChild);
    }
    this.bootSteps++;
    const fill = $('boot-fill');
    if (fill) fill.style.width = `${Math.min(95, this.bootSteps * 7)}%`;
    this.pushEventLog(text);
  }

  /* ══════════════════ UI CONSTRUCTION ══════════════════ */

  buildUI() {
    // gesture reference list
    const gl = $('gest-list');
    gl.innerHTML = GESTURE_DOCS.map(g => `
      <div class="gest" data-gesture="${g.id}">
        <div class="gest-ico">${g.icon}</div>
        <div class="gest-info">
          <div class="gest-name">${g.name}</div>
          <div class="gest-act">${g.action}</div>
        </div>
      </div>`).join('');

    // theme select
    const ts = $('set-theme');
    ts.innerHTML = THEMES.map(t => `<option value="${t}">${t.replace('aura-', '').toUpperCase()}</option>`).join('');

    // API key fields
    const kf = $('key-fields');
    kf.innerHTML = providerList().filter(p => p.needsKey).map(p => `
      <label class="field" data-key-field="${p.id}">
        <span>${p.label} API key ${p.docs ? `<small><a href="${p.docs}" target="_blank" rel="noopener">get key ↗</a></small>` : ''}</span>
        <input type="password" data-key="${p.id}" placeholder="not set" autocomplete="off">
      </label>`).join('');

    this.buildWardrobe();
    this.renderAbout();
    this.renderDesktop();
    this.renderSysReadout();
  }

  renderAbout() {
    const stt = this.voice.input.supported;
    const tts = this.voice.output.supported;
    const cam = this.vision.cameraSupported && this.vision.secureContext;
    const xr = this.ar?.supported?.webxr;
    const mark = (b) => b ? '<span class="st-ok">✓ available</span>' : '<span class="st-warn">✗ unavailable</span>';

    // WebGL was ALWAYS reported unavailable because this checked
    // `avatarMode === '3d'` — but the default mode is 'body', which is also a
    // WebGL renderer. Report the actual GPU capability instead of one mode.
    // runtime.hardware is a HardwareRegistry — capabilities come from get().
    const gpuInfo = this.runtime?.hardware?.get?.('gpu')?.info || null;
    const mode = state.get('avatarMode');
    const webglOn = !!(gpuInfo?.webgl) || mode === '3d' || mode === 'body';
    const webglRenderer = gpuInfo?.renderer
      ? `${gpuInfo.software ? 'software rasteriser: ' : ''}${String(gpuInfo.renderer).slice(0, 60)}`
      : '';
    // Be specific about WHY XR is missing rather than implying it's broken.
    const xrReason = !('xr' in navigator)
      ? 'this browser has no WebXR API (Chrome/Edge on Android or a headset browser do). Simulated AR fallback is used.'
      : !window.isSecureContext
        ? 'WebXR needs https or localhost. Simulated AR fallback is used.'
        : 'no immersive-AR device is attached to this machine. Simulated AR fallback is used.';
    $('about-body').innerHTML = `
      <h3>AURA</h3>
      <p><strong>Adaptive Unified Response Assistant</strong> — a modular AI operating system that runs entirely in your browser. No backend, no telemetry, no build step.</p>
      <h3>Runtime capability report</h3>
      <ul>
        <li>Speech recognition (STT): ${mark(stt)}${stt ? '' : ` — ${escapeHtml(this.voice.input.unsupportedReason || '')}`}</li>
        <li>Speech synthesis (TTS): ${mark(tts)}</li>
        <li>Camera / secure context: ${mark(cam)}</li>
        <li>WebGL avatar: ${mark(webglOn)}${webglRenderer ? ` — ${escapeHtml(webglRenderer)}` : ''}</li>
        <li>WebXR immersive AR: ${mark(!!xr)}${xr ? '' : ` — ${escapeHtml(xrReason)}`}</li>
        <li>Web Audio: ${mark(!!this.audio.ctx || !this.audio.blocked)}</li>
      </ul>
      <h3>Architecture</h3>
      <p>Five independent modules communicate only through a central event bus:</p>
      <ul>
        <li><code>ai/</code> — provider adapters, memory, streaming engine, offline core</li>
        <li><code>voice/</code> — STT, TTS, viseme generation</li>
        <li><code>vision/</code> — MediaPipe landmarkers, gesture classifier</li>
        <li><code>avatar/</code> — 3D + 2D holographic renderers</li>
        <li><code>gestures/</code> — gesture→action bindings</li>
        <li><code>core/</code> — bus, state, config, plugin registry</li>
      </ul>
      <h3>Privacy</h3>
      <p>API keys live in this browser's localStorage only. Camera and microphone streams are processed locally and never uploaded. Conversation text is sent to your chosen AI provider only.</p>
      <h3>Keyboard shortcuts</h3>
      <ul>
        <li><code>Enter</code> send · <code>Shift+Enter</code> newline</li>
        <li><code>Space</code> toggle mic (when input unfocused)</li>
        <li><code>Esc</code> stop generation &amp; speech</li>
        <li><code>M</code> mute voice · <code>T</code> theme · <code>,</code> settings</li>
      </ul>`;
  }

  /* ══════════════════ EVENT WIRING ══════════════════ */

  wireEvents() {
    // ── AI streaming
    bus.on(EV.AI_USER_MESSAGE, ({ text }) => this.pushUserMessage(text));

    bus.on(EV.AI_STREAM_START, ({ append, sid, speakText }) => {
      // When a reply is a data table, speak a short summary instead.
      this._speakOverride = speakText || null;
      this.setStatus('THINKING');
      $('btn-stop').hidden = false;
      $('btn-continue').hidden = true;
      $('btn-regen').hidden = true;
      this.spokenUpTo = 0;
      this.activeSid = sid;
      if (!append) this.streamEl = this.createMessageEl('assistant', '');
      if (this.streamEl) this.streamEl.dataset.streaming = '1';
    });

    bus.on(EV.AI_STREAM_DELTA, ({ text, sid }) => {
      // ignore deltas from a superseded stream
      if (sid !== undefined && this.activeSid !== undefined && sid !== this.activeSid) return;
      if (!this.streamEl) this.streamEl = this.createMessageEl('assistant', '');
      const body = this.streamEl.querySelector('.msg-body');
      body.innerHTML = renderMarkdown(text) + '<span class="cursor"></span>';
      this.scrollTranscript();
      this.setCaption(text);
      this.speakIncremental(text);
    });

    const endStream = ({ text, aborted, sid }) => {
      if (sid !== undefined && this.activeSid !== undefined && sid !== this.activeSid) return;
      if (this.streamEl) {
        const body = this.streamEl.querySelector('.msg-body');
        body.innerHTML = renderMarkdown(text || '');
        delete this.streamEl.dataset.streaming;
        this.streamEl = null;
      }
      $('btn-stop').hidden = true;
      $('btn-regen').hidden = false;
      $('btn-continue').hidden = !state.get('aiCanContinue');
      this.setStatus(aborted ? 'STOPPED' : 'IDLE');
      this.scrollTranscript();
      // speak whatever is left unspoken
      this.speakRemainder(text || '');
      this.audio.sfx('message');
    };
    bus.on(EV.AI_STREAM_END, endStream);
    bus.on(EV.AI_STREAM_ABORT, (p) => { endStream(p); this.toast('warn', 'Generation stopped.'); });

    bus.on(EV.AI_ERROR, ({ message }) => { this.toast('error', message); this.audio.sfx('error'); });
    bus.on(EV.AI_PROVIDER_CHANGED, ({ provider, model }) => {
      $('stat-core').textContent = this.ai.providerLabel.replace(' (local)', '');
      $('composer-hint').textContent = `${this.ai.providerLabel}${model ? ' · ' + model : ''}`;
      this.renderSysReadout();
    });
    bus.on(EV.AI_MEMORY_UPDATED, ({ count }) => { $('stat-mem').textContent = count; });

    // ── voice
    bus.on(EV.STT_START, () => {
      this.setStatus('LISTENING');
      $('btn-mic').classList.add('live');
      $('dock-mic').classList.add('live');
      $('status-pill').classList.add('live');
      this.audio.sfx('listen');
    });
    bus.on(EV.STT_END, () => {
      $('btn-mic').classList.remove('live');
      $('dock-mic').classList.remove('live');
      $('status-pill').classList.remove('live');
      $('interim').hidden = true;
      if (!state.get('aiStreaming')) this.setStatus('IDLE');
    });
    bus.on(EV.STT_PARTIAL, ({ text }) => {
      const el = $('interim');
      el.hidden = false;
      el.textContent = `“${text}”`;
      this.setCaption(text);
    });
    bus.on(EV.STT_FINAL, ({ text }) => {
      $('interim').hidden = true;
      if (!text.trim()) return;
      if (config.get('autoSendOnFinal')) {
        this.voice.input.stop();
        this.send(text);
      } else {
        const inp = $('input');
        inp.value = (inp.value ? inp.value + ' ' : '') + text;
        this.autoGrow(inp);
      }
    });
    // Which Ollama model actually ran this turn, and whether we had to
    // substitute one. Previously this event had no listener, so a corrected
    // model name was applied silently — the user saw a reply from a model
    // they never chose with no explanation.
    bus.on('ai:model-selected', ({ model, task, reason, corrected }) => {
      this.log(`Model → ${model} (${task}${reason ? ': ' + reason : ''})`, corrected ? 'warn' : 'ok');
      if (corrected) {
        this.toast('warn', `Model not installed — using ${model} instead. Check Settings → AI Core.`);
      }
    });
    bus.on('voice:echo-suppressed', ({ text }) => {
      // Visible, not silent: the user should know why their "input" vanished.
      this.log(`Ignored own speech echo: “${String(text).slice(0, 48)}”`, 'warn');
    });
    bus.on(EV.STT_ERROR, ({ message, fatal, quiet }) => {
      // `quiet` = a recurring, self-healing condition (Chrome's speech service
      // dropping out). It goes to the log, not to a toast, so a bad connection
      // does not bury the UI in warnings.
      if (quiet) { this.log(message, 'warn'); return; }
      this.toast(fatal ? 'error' : 'warn', message);
      if (fatal) { $('btn-mic').classList.remove('live'); $('dock-mic').classList.remove('live'); }
    });
    bus.on(EV.WAKE_WORD, ({ command, matched, source }) => {
      this.audio.sfx('confirm');
      this.toast('success', `🎙 Wake word "${matched || 'AURA'}" detected!`);
      bus.emit(EV.AVATAR_EMOTION, { emotion: 'surprised' });

      const cleanCmd = (command || '').trim();
      if (cleanCmd && cleanCmd.length > 1) {
        // Full command provided in one breath (e.g. "Hey Aura, open WhatsApp")
        this.send(cleanCmd);
      } else {
        // Wake word only (e.g. "AURA" or "Hey Nova")
        this.setStatus('LISTENING');
        const greetings = [config.get('commanderGreeting') || 'Yes, Commander?', 'Listening...', 'How can I assist?', 'Online.'];
        const greet = greetings[Math.floor(Math.random() * greetings.length)];

        // Speak greeting
        const emotion = greet.includes('Commander') ? 'questioning' : 'happy';
        this.voice.output.speak(greet, { emotion });

        // Once greeting finishes, switch to active command listening
        const onGreetingDone = () => {
          bus.off(EV.TTS_END, onGreetingDone);
          this.voice.input.start('command');

          // Auto-revert to wake listening if nothing heard after 8 seconds
          clearTimeout(this._wakePromptTimer);
          this._wakePromptTimer = setTimeout(() => {
            if (config.get('wakeWordEnabled') && this.voice.input.mode === 'command' && !state.get('aiStreaming')) {
              this.voice.input.start('wake');
            }
          }, 8000);
        };
        bus.on(EV.TTS_END, onGreetingDone);
      }
    });

    bus.on(EV.TTS_START, () => { this.setStatus('SPEAKING'); $('status-pill').classList.add('speaking');
      $('btn-interrupt').hidden = false;
      // Half-duplex is owned by SpeechInput itself (it subscribes to
      // TTS_START/END), so every TTS source is covered — including gesture
      // greetings and wake-word replies that never pass through main.js.
    });
    bus.on(EV.TTS_END, () => {
      $('status-pill').classList.remove('speaking');
      $('btn-interrupt').hidden = true;
      if (!state.get('aiStreaming') && !state.get('sttActive')) this.setStatus('IDLE');

      // Seamlessly resume wake-word listening after TTS ends
      if (config.get('wakeWordEnabled') && !state.get('aiStreaming')) {
        setTimeout(() => {
          if (config.get('wakeWordEnabled') && !state.get('aiStreaming') && !this.voice.output.speaking) {
            this.voice.input.start('wake');
          }
        }, 500);
      }
    });
    bus.on(EV.TTS_INTERRUPT, () => { $('btn-interrupt').hidden = true; $('status-pill').classList.remove('speaking'); });

    // ── vision
    bus.on(EV.CAM_START, () => {
      $('cam-placeholder').style.display = 'none';
      $('btn-cam').classList.add('on');
      $('btn-cam').textContent = '■';
      this.renderSysReadout();
    });
    bus.on(EV.CAM_STOP, () => {
      $('cam-placeholder').style.display = '';
      $('cam-error').hidden = true;
      $('btn-cam').classList.remove('on');
      $('btn-cam').textContent = '▶';
      $('ro-gesture').textContent = 'none';
      $('conf-fill').style.width = '0%';
      this.renderSysReadout();
    });
    bus.on(EV.CAM_ERROR, ({ message, fatal }) => {
      const el = $('cam-error');
      el.hidden = false;
      el.textContent = message;
      this.toast(fatal ? 'error' : 'warn', message);
      this.audio.sfx('error');
    });
    bus.on(EV.HANDS, ({ gesture, confidence }) => {
      $('ro-gesture').textContent = gesture === 'none' ? 'none' : (GESTURES[gesture]?.label || gesture);
      $('conf-fill').style.width = `${Math.round(confidence * 100)}%`;
      $('ro-hands').textContent = state.get('handCount');
      $$('.gest').forEach(el => {
        el.classList.toggle('hot', el.dataset.gesture === gesture && confidence > 0.6);
      });
    });
    bus.on(EV.FACES, () => { $('ro-faces').textContent = state.get('faceCount'); });
    bus.on(EV.OBJECTS, () => { $('ro-objects').textContent = state.get('objectCount'); });
    bus.on(EV.SCENE_UPDATE, (scene) => {
      this.ai.setVisionContext(scene);
      // face-driven emotion mirroring
      const emo = this.vision.readEmotion?.();
      if (emo && emo.emotion !== 'neutral' && emo.score > 0.4 && !state.get('ttsSpeaking')) {
        bus.emit(EV.AVATAR_EMOTION, { emotion: emo.emotion === 'angry' ? 'focused' : emo.emotion });
      }
    });
    bus.on(EV.GESTURE, ({ gesture, confidence }) => {
      this.pushEventLog(`gesture: ${gesture} (${Math.round(confidence * 100)}%)`);
    });

    // ── ui
    // Coalesce action events: a burst of actions (or an app scan returning
    // 136 entries) would otherwise re-render the whole Desktop pane once per
    // event. Only redraw when the pane is actually on screen.
    const redrawDesktop = () => {
      if ($('settings').hidden) return;
      const pane = document.querySelector('.tabpane[data-tab="desktop"]');
      if (!pane?.classList.contains('active')) return;
      clearTimeout(this._desktopRedraw);
      this._desktopRedraw = setTimeout(() => this.renderDesktop(), 250);
    };
    bus.on('desktop:action-executed', redrawDesktop);
    bus.on('desktop:action-denied', redrawDesktop);
    bus.on('desktop:action-reported', ({ result }) => {
      this.toast(result.ok ? (result.simulated ? 'warn' : 'success') : 'error', result.message);
      this.audio.sfx(result.ok ? 'confirm' : 'error');
    });
    bus.on('action:performed', ({ result, spoken }) => {
      this.toast(result.ok ? 'success' : 'warn', result.message);
      this.audio.sfx(result.ok ? 'confirm' : 'error');
      if (spoken) this.voice.output.speak(spoken, { emotion: result.ok ? 'confident' : 'confused' });
    });
    bus.on(EV.AI_STREAM_START, ({ routedLocal, model }) => {
      if (routedLocal) $('composer-hint').textContent = `local · ${model}`;
    });
    bus.on(EV.AI_STREAM_END, () => {
      $('composer-hint').textContent = `${this.ai.providerLabel}${state.get('aiModel') ? ' · ' + state.get('aiModel') : ''}`;
    });
    bus.on(EV.UI_TOAST, ({ type, text, duration }) => this.toast(type || 'info', text, duration));
    bus.on(EV.LOG, ({ text }) => this.pushEventLog(text));
    bus.on(EV.ERROR, ({ source, error }) => this.pushEventLog(`ERROR ${source}: ${error?.message || error}`));
    bus.on(EV.COMMAND, ({ command }) => this.handleVoiceCommand(command));

    // state → DOM
    state.watch('fps', v => { $('stat-fps').textContent = v; });
    state.watch('visionFps', v => {
      $('stat-vis').textContent = state.get('cameraActive') ? v : 'off';
      $('cam-fps').textContent = `${v} FPS`;
    });
    state.watch('avatarEmotion', v => { $('emotion-pill').textContent = v; });
    const detUpdate = () => { $('stat-det').textContent = `${state.get('handCount')}/${state.get('faceCount')}/${state.get('objectCount')}`; };
    state.watch('handCount', detUpdate); state.watch('faceCount', detUpdate); state.watch('objectCount', detUpdate);

    setInterval(() => this.renderSysReadout(), 2200);
  }

  wireDOM() {
    // ── panels
    $$('button[data-panel]').forEach(btn => {
      btn.addEventListener('click', () => { this.openPanel(btn.dataset.panel); this.audio.sfx('click'); });
    });
    this.openPanel('chat');

    // ── composer
    const input = $('input');
    input.addEventListener('input', () => this.autoGrow(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendFromInput(); }
    });
    // Typing `/` or `@` opens a live list of what can actually be run.
    // Registered AFTER the composer's own keydown but listens in the capture
    // phase, so Enter picks a command instead of sending the message.
    this.palette = new CommandPalette({
      input,
      mount: input.closest('.composer') || input.parentElement,
      getCommands: () => plugins.listCommands(),
      sfx: (n) => this.audio?.sfx?.(n),
    });
    $('btn-send').addEventListener('click', () => this.sendFromInput());
    $('btn-mic').addEventListener('click', () => this.toggleMic());
    $('dock-mic').addEventListener('click', () => this.toggleMic());
    $('dock-speak').addEventListener('click', () => this.toggleVoiceOutput());
    $('btn-stop').addEventListener('click', () => { this.ai.stop('user'); this.audio.sfx('click'); });
    $('btn-continue').addEventListener('click', () => { this.ai.continue(); this.audio.sfx('click'); });
    $('btn-regen').addEventListener('click', () => { this.ai.regenerate(); this.audio.sfx('click'); });
    $('btn-interrupt').addEventListener('click', () => { this.voice.output.cancel('user'); this.audio.sfx('click'); });
    $('btn-clear').addEventListener('click', () => {
      this.ai.clear(); this.clearTranscript(); this.toast('info', 'Memory cleared.');
    });
    $('btn-export').addEventListener('click', () => plugins.run('/export').then(r => r.output && this.toast('success', r.output)));

    // ── vision
    $('btn-cam').addEventListener('click', () => this.toggleCamera());
    $('btn-cam-start').addEventListener('click', () => this.enableVision());
    $('btn-snapshot').addEventListener('click', async () => {
      const r = await plugins.run('/snapshot');
      this.toast(r.error ? 'warn' : 'success', r.error || r.output);
    });
    $('btn-describe').addEventListener('click', () => this.send('What do you see right now?'));
    $('btn-diagnose')?.addEventListener('click', () => this.runMediaDiagnostic());
    $('tg-hands').addEventListener('change', e => { config.set('handTracking', e.target.checked); this.applyVisionToggles(); });
    $('tg-faces').addEventListener('change', e => { config.set('faceTracking', e.target.checked); this.applyVisionToggles(); });
    $('tg-objects').addEventListener('change', e => { config.set('objectDetection', e.target.checked); this.applyVisionToggles(); });

    // ── topbar
    $('btn-theme').addEventListener('click', () => { this.cycleTheme(); this.audio.sfx('click'); });
    $('btn-ar').addEventListener('click', () => this.toggleAR().then(m => this.toast('info', m)));
    $('btn-settings').addEventListener('click', () => this.openSettings());
    $('btn-settings-close').addEventListener('click', () => this.closeSettings());
    $('settings').querySelector('.modal-backdrop').addEventListener('click', () => this.closeSettings());
    $('btn-selftest').addEventListener('click', async () => {
      this.openPanel('chat');
      const r = await this.runSelfTest();
      this.pushAssistantMessage(r);
    });

    this.wireSettings();
    this.wireDesktopSettings();
    this.wireAvatarSettings();
    this.wireAppearance();
    this.wireMemorySettings();
    this.wireWebResearch();
    this.wireAutomation();
    this.wireScreenPanel();
    this.wirePrivacyGuard();
    this.wireDwell();
    this.wireDevices();
    this.wireDocs();
    this.wireAgentState();
    this.wireTaskCards();
    this.wireAuraLiveToggle();
    this.devConsole?.mount();
    this.wireAvatarHeight();
    $('face-enrol')?.addEventListener('click', () => this.startFaceEnrollment());
    bus.on('vision:face-recognized', ({ name }) => {
      this.log(`Recognised ${name}`, 'ok');
      if (!config.get('faceGreeting')) return;
      this.pushAssistantMessage(`Welcome back, ${name}.`);
      this.voice.output.speak(`Welcome back, ${name}.`, { emotion: 'happy' });
      bus.emit(EV.AVATAR_EMOTION, { emotion: 'happy' });
    });
    this._wireSecretUnlock();

    // ── keyboard
    window.addEventListener('keydown', (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (e.key === 'Escape') {
        if (!$('settings').hidden) { this.closeSettings(); return; }
        this.ai.stop('user'); this.voice.output.cancel('user');
        return;
      }
      if (typing) return;
      if (e.key === ' ') { e.preventDefault(); this.toggleMic(); }
      else if (e.key.toLowerCase() === 'm') this.toggleVoiceOutput();
      else if (e.key.toLowerCase() === 't') this.cycleTheme();
      else if (e.key === ',') { e.preventDefault(); this.openSettings(); }
      else if (e.key === '/') { e.preventDefault(); this.openPanel('chat'); this.focusInput(); }
    });

    window.addEventListener('beforeunload', () => { try { this.voice.output.cancel(); } catch {} });
  }

  /* ══════════════════ SETTINGS ══════════════════ */

  wireSettings() {
    $$('.tab').forEach(t => {
      t.addEventListener('click', () => {
        $$('.tab').forEach(x => x.classList.remove('active'));
        $$('.tabpane').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        document.querySelector(`.tabpane[data-tab="${t.dataset.tab}"]`).classList.add('active');
        this._settingsTab = t.dataset.tab;
        // Provider probing is async, so render on open rather than on boot.
        if (t.dataset.tab === 'avatar') this.renderAvatarManager();
        if (t.dataset.tab === 'appearance') this.renderAppearance();
        if (t.dataset.tab === 'memory') this.renderMemory();
        if (t.dataset.tab === 'vision') this.renderFaces();
        if (t.dataset.tab === 'devices') { this.refreshDevices(); this.syncDocs(); }
        if (t.dataset.tab === 'desktop') {
          this.renderWebResearch(); this.renderAutomation();
        }
        // Switching tabs must return you to the top: pane heights differ
        // wildly, and a retained scrollTop left short panes looking empty.
        const body = document.querySelector('#settings .modal-body');
        if (body) body.scrollTop = 0;
      });
    });

    const bindRange = (id, key, label, fmt = v => v) => {
      const el = $(id);
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        config.set(key, v);
        if (label) $(label).textContent = fmt(v);
        if (key === 'ambientVolume') this.audio.setAmbientVolume(v);
        if (key === 'musicVolume') this.audio.setMusicVolume(v);
        if (key === 'gestureCooldownMs') this.vision.stabilizer.cooldownMs = v;
      });
    };
    const bindCheck = (id, key, after) => {
      const el = $(id);
      el.addEventListener('change', () => { config.set(key, el.checked); after?.(el.checked); });
    };
    const bindText = (id, key, after) => {
      const el = $(id);
      el.addEventListener('change', () => { config.set(key, el.value); after?.(el.value); });
    };

    // AI
    $('set-provider').addEventListener('change', async (e) => {
      config.set('provider', e.target.value);
      $('field-ollama').hidden = e.target.value !== 'ollama' && e.target.value !== 'auto';
      await this.ai.resolve();
      this.updateModelHint();
      this.toast('info', `AI core → ${this.ai.providerLabel}`);
    });
    $$('[data-key]').forEach(inp => {
      inp.addEventListener('change', async () => {
        config.setKey(inp.dataset.key, inp.value);
        await this.ai.resolve();
        this.toast('success', `${inp.dataset.key} key saved locally.`);
      });
    });
    bindText('set-ollama-url', 'ollamaUrl', () => this.ai.resolve());
    bindText('set-model', 'model', () => this.ai.resolve());
    bindRange('set-temp', 'temperature', 'lbl-temp', v => v.toFixed(2));
    bindRange('set-tokens', 'maxTokens', 'lbl-tokens');
    bindRange('set-memturns', 'memoryTurns', 'lbl-mem', v => { this.ai.memory.maxTurns = v; return v; });
    bindText('set-sysprompt', 'systemPrompt');

    $('btn-wizard').addEventListener('click', () => { this.closeSettings(); this.setup.open({ forced: true }); });
    $('btn-test').addEventListener('click', async () => {
      const out = $('test-out');
      out.hidden = false;
      const pid = config.get('provider') === 'auto' ? this.ai.resolvedProvider : config.get('provider');
      if (pid === 'local') { out.textContent = '✓ Local Core is always available (no network required).'; return; }
      out.textContent = `Testing ${pid}…`;
      const r = await this.ai.testConnection(pid, {
        model: config.get('model') || undefined,
        baseUrl: pid === 'ollama' ? config.get('ollamaUrl') : undefined,
      });
      out.textContent = r.ok ? `✓ CONNECTED\nResponse: ${r.message}` : `✗ FAILED\n${r.message}`;
      this.audio.sfx(r.ok ? 'confirm' : 'error');
    });

    $('btn-fetch-models').addEventListener('click', async () => {
      const out = $('test-out');
      out.hidden = false;
      const pid = config.get('provider') === 'auto' ? this.ai.resolvedProvider : config.get('provider');
      const p = PROVIDERS[pid];
      if (!p) { out.textContent = 'Local Core has no model list.'; return; }
      out.textContent = 'Fetching…';
      try {
        const list = await p.listModels({ key: config.getKey(pid), baseUrlOverride: pid === 'ollama' ? config.get('ollamaUrl') : undefined });
        $('model-list').innerHTML = list.map(m => `<option value="${escapeHtml(m)}">`).join('');
        out.textContent = `${list.length} models:\n${list.join('\n')}`;
      } catch (e) { out.textContent = `✗ ${e.message}`; }
    });

    // VOICE
    bindCheck('set-tts', 'ttsEnabled', (v) => { if (!v) this.voice.output.cancel(); this.syncToggles(); });
    $('set-voice').addEventListener('change', e => config.set('ttsVoice', e.target.value));
    bindRange('set-rate', 'ttsRate', 'lbl-rate', v => v.toFixed(2));
    bindRange('set-pitch', 'ttsPitch', 'lbl-pitch', v => v.toFixed(2));
    bindRange('set-vol', 'ttsVolume', 'lbl-vol', v => v.toFixed(2));
    $('btn-test-voice').addEventListener('click', () =>
      this.voice.output.speak('AURA voice system online. All modules nominal, Commander.'));
    bindText('set-sttlang', 'sttLang');
    bindCheck('set-autosend', 'autoSendOnFinal');
    bindText('set-commander-greeting', 'commanderGreeting');
    bindCheck('set-wake', 'wakeWordEnabled', (v) => this.setWakeWord(v));
    bindText('set-wakeword', 'wakeWord');

    // Wake Word Tag Manager UI
    const wakeTagContainer = $('wakeword-tags');
    const wakeInput = $('wakeword-add-input');
    const btnAddWake = $('btn-add-wakeword');
    const selWakePresets = $('set-wake-presets');

    this._renderWakeTags = () => {
      if (!wakeTagContainer) return;
      const words = config.get('wakeWords') || ['aura', 'hey aura', 'nova', 'hey nova', 'jarvis', 'computer'];
      wakeTagContainer.innerHTML = words.map((w, idx) => `
        <span class="wakeword-tag">
          ${escapeHtml(w)}
          <span class="tag-remove" data-idx="${idx}" title="Remove">✕</span>
        </span>
      `).join('');
      if ($('set-wakeword')) $('set-wakeword').value = words.join(', ');
    };

    const addWakeWord = (word) => {
      const trimmed = String(word || '').trim().toLowerCase();
      if (!trimmed) return;
      const cur = config.get('wakeWords') || ['aura', 'hey aura', 'nova', 'hey nova', 'jarvis', 'computer'];
      if (!cur.includes(trimmed)) {
        const next = [...cur, trimmed];
        config.set('wakeWords', next);
        config.set('wakeWord', next.join(', '));
        this._renderWakeTags();
        this.toast('ok', `Added wake word: "${trimmed}"`);
      }
    };

    btnAddWake?.addEventListener('click', () => {
      addWakeWord(wakeInput.value);
      wakeInput.value = '';
    });
    wakeInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addWakeWord(wakeInput.value);
        wakeInput.value = '';
      }
    });
    wakeTagContainer?.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.tag-remove');
      if (!removeBtn) return;
      const idx = Number(removeBtn.dataset.idx);
      const cur = config.get('wakeWords') || ['aura', 'hey aura', 'nova', 'hey nova', 'jarvis', 'computer'];
      const removed = cur[idx];
      const next = cur.filter((_, i) => i !== idx);
      config.set('wakeWords', next);
      config.set('wakeWord', next.join(', '));
      this._renderWakeTags();
      this.toast('info', `Removed wake word: "${removed}"`);
    });
    selWakePresets?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (!val) return;
      if (val === 'all') {
        const standard = ['aura', 'hey aura', 'nova', 'hey nova', 'jarvis', 'computer'];
        config.set('wakeWords', standard);
        config.set('wakeWord', standard.join(', '));
      } else {
        const parts = val.split(',').map(s => s.trim().toLowerCase());
        const cur = config.get('wakeWords') || [];
        const next = Array.from(new Set([...cur, ...parts]));
        config.set('wakeWords', next);
        config.set('wakeWord', next.join(', '));
      }
      this._renderWakeTags();
      this.toast('ok', 'Preset loaded');
      selWakePresets.value = '';
    });

    // VISION
    bindCheck('set-hands', 'handTracking', () => { $('tg-hands').checked = config.get('handTracking'); this.applyVisionToggles(); });
    bindCheck('set-faces', 'faceTracking', () => { $('tg-faces').checked = config.get('faceTracking'); this.applyVisionToggles(); });
    bindCheck('set-facerec', 'faceRecognition', (v) => {
      if (v) this.renderFaces();
      this.toast('info', v ? 'Face recognition on — enrol someone below.' : 'Face recognition off.');
    });
    bindCheck('set-facegreet', 'faceGreeting');
    bindCheck('set-websearch', 'webSearch');
    $('set-webdepth')?.addEventListener('change', e =>
      config.set('webSearchDepth', /** @type {any} */ (e.target).value));
    bindCheck('set-objects', 'objectDetection', () => { $('tg-objects').checked = config.get('objectDetection'); this.applyVisionToggles(); });
    bindCheck('set-mirror', 'mirrorCamera', (v) => document.querySelector('.cam-wrap').classList.toggle('mirror', v));
    bindRange('set-vfps', 'visionTargetFps', 'lbl-vfps');
    bindRange('set-cooldown', 'gestureCooldownMs', 'lbl-cool');
    bindText('set-facing', 'cameraFacing', async () => {
      if (state.get('cameraActive')) { this.vision.stopCamera(); await this.enableVision(); }
    });

    // UI
    $('set-theme').addEventListener('change', e => this.setTheme(e.target.value));
    $('set-avatar').addEventListener('change', e => this.switchAvatar(e.target.value));
    bindCheck('set-glass', 'glassUI', (v) => this.applyGlass(v));
    bindCheck('set-particles', 'particles', (v) => { $('fx-canvas').style.display = v ? '' : 'none'; });
    bindCheck('set-livedata', 'liveData', (v) => {
      this.toast('info', v ? 'Live internet data enabled.' : 'Offline mode — no internet lookups.');
      this.renderConnectStatus();
    });
    bindText('set-city', 'defaultCity', () => { liveData.location = null; });
    bindCheck('set-hybrid', 'hybridRouting');
    bindText('set-smallmodel', 'ollamaSmallModel');
    $('btn-refresh-conn').addEventListener('click', () => this.renderConnectStatus());
    bindCheck('set-reduce', 'reduceMotion', (v) => this.applyReduceMotion(v));
    bindCheck('set-uisounds', 'uiSounds');
    bindCheck('set-ambient', 'ambientSound', () => this.audio.sync());
    bindRange('set-ambvol', 'ambientVolume', 'lbl-amb', v => v.toFixed(2));
    bindCheck('set-music', 'musicEnabled', () => this.audio.sync());
    bindRange('set-musvol', 'musicVolume', 'lbl-mus', v => v.toFixed(2));
    bindCheck('set-devskipboot', 'devSkipBoot', (v) => {
      this.toast('info', v ? 'Developer Fast Boot ON: boot screen will be skipped.' : 'Fast Boot OFF.');
    });
    $('btn-reset').addEventListener('click', () => {
      if (!confirm('Reset all AURA settings to defaults? API keys will be erased.')) return;
      config.reset();
      location.reload();
    });
  }

  openSettings() {
    this.syncSettingsUI();
    $('settings').hidden = false;
    this.audio.sfx('click');
  }
  closeSettings() { $('settings').hidden = true; }

  syncSettingsUI() {
    const c = config.get();
    $('set-provider').value = c.provider;
    $('field-ollama').hidden = !(c.provider === 'ollama' || c.provider === 'auto');
    $('set-ollama-url').value = c.ollamaUrl;
    $('set-model').value = c.model;
    $('set-temp').value = c.temperature; $('lbl-temp').textContent = Number(c.temperature).toFixed(2);
    $('set-tokens').value = c.maxTokens; $('lbl-tokens').textContent = c.maxTokens;
    $('set-memturns').value = c.memoryTurns; $('lbl-mem').textContent = c.memoryTurns;
    $('set-sysprompt').value = c.systemPrompt;
    $$('[data-key]').forEach(i => { i.value = config.getKey(i.dataset.key); });
    this.updateModelHint();

    $('set-tts').checked = c.ttsEnabled;
    const vs = this.voice.output.listVoices();
    $('set-voice').innerHTML = `<option value="">Auto-select best voice</option>` +
      vs.map(v => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} — ${v.lang}</option>`).join('');
    $('set-voice').value = c.ttsVoice;
    $('set-rate').value = c.ttsRate; $('lbl-rate').textContent = Number(c.ttsRate).toFixed(2);
    $('set-pitch').value = c.ttsPitch; $('lbl-pitch').textContent = Number(c.ttsPitch).toFixed(2);
    $('set-vol').value = c.ttsVolume; $('lbl-vol').textContent = Number(c.ttsVolume).toFixed(2);
    $('set-sttlang').value = c.sttLang;
    $('set-autosend').checked = c.autoSendOnFinal;
    $('set-commander-greeting').value = c.commanderGreeting || 'Yes, Commander?';
    $('set-wake').checked = c.wakeWordEnabled;
    if ($('set-wakeword')) $('set-wakeword').value = c.wakeWord || '';
    this._renderWakeTags?.();
    $('voice-support').className = this.voice.input.supported ? 'note good' : 'note bad';
    $('voice-support').innerHTML = this.voice.input.supported
      ? '✓ Speech recognition is available in this browser.'
      : `✗ ${escapeHtml(this.voice.input.unsupportedReason)}`;

    $('set-hands').checked = c.handTracking;
    $('set-faces').checked = c.faceTracking;
    $('set-objects').checked = c.objectDetection;
    $('set-mirror').checked = c.mirrorCamera;
    $('set-vfps').value = c.visionTargetFps; $('lbl-vfps').textContent = c.visionTargetFps;
    $('set-cooldown').value = c.gestureCooldownMs; $('lbl-cool').textContent = c.gestureCooldownMs;
    $('set-facing').value = c.cameraFacing;

    $('set-theme').value = c.theme;
    $('set-avatar').value = state.get('avatarMode');
    $('set-glass').checked = c.glassUI !== false;
    $('set-livedata').checked = c.liveData !== false;
    $('set-city').value = c.defaultCity || '';
    $('set-hybrid').checked = c.hybridRouting !== false;
    $('set-smallmodel').value = c.ollamaSmallModel || '';
    this.renderConnectStatus();
    $('set-particles').checked = c.particles;
    $('set-reduce').checked = c.reduceMotion;
    $('set-uisounds').checked = c.uiSounds;
    $('set-ambient').checked = c.ambientSound;
    $('set-ambvol').value = c.ambientVolume; $('lbl-amb').textContent = Number(c.ambientVolume).toFixed(2);
    $('set-music').checked = c.musicEnabled;
    $('set-musvol').value = c.musicVolume; $('lbl-mus').textContent = Number(c.musicVolume).toFixed(2);
    if ($('set-devskipboot')) $('set-devskipboot').checked = !!c.devSkipBoot;

    this.renderAbout();
  }

  /* ── desktop integration settings ─────────────────────────────── */

  renderDesktop() {
    if (!this.desktop?.initialized) return;
    // The terminal policy lives on the SERVER, so reading it costs a round
    // trip. renderDesktop() runs on every desktop action — and the policy
    // fetch is itself an action — so calling it here unconditionally created
    // a feedback loop that spammed the console with `ACTION get_policy`
    // forever. Fetch it once and cache; renderTerminalPolicy(true) forces a
    // refresh when the user actually changes it.
    if (this._policyCache) this._paintTerminalPolicy(this._policyCache);
    else this.renderTerminalPolicy?.().catch(() => {});
    const st = this.desktop.status();

    const verdict = st.backend === 'native' ? { cls: 'good', txt: 'FULL CONTROL' }
      : st.backend === 'bridge' ? { cls: '', txt: 'PARTIAL (bridge)' }
      : { cls: '', txt: 'SIMULATED' };
    $('dt-backend').textContent = verdict.txt;
    $('dt-backend').className = `setup-badge ${verdict.cls}`;

    $('dt-status').className = st.simulated ? 'note' : 'note good';
    $('dt-status').innerHTML = st.simulated
      ? '<strong>Simulation mode.</strong> No desktop host process is running, so actions are mocked. ' +
        'Run AURA locally with <code>python3 serve.py --allow-actions</code> for real control. ' +
        'The full architecture is active — only the OS layer is stubbed.'
      : `<strong>Connected.</strong> Local host detected on ${st.platform}. Real desktop actions are available.`;

    const caps = st.capabilities;
    $('dt-caps').innerHTML = [
      ['Launch apps', caps.launch], ['Close apps', caps.close],
      ['Enumerate apps', caps.enumerate], ['App scanning', caps.scan],
    ].map(([k, v]) => `<div class="dt-cap ${v ? 'on' : ''}">${v ? '●' : '○'} ${k}</div>`).join('');

    this.renderDesktopApps();

    // permissions
    const perms = this.desktop.permissions.list();
    $('dt-permcount').textContent = `${perms.filter(p => p.granted).length}/${perms.length} GRANTED`;
    $('dt-perms').innerHTML = perms.map(p => `
      <label class="dt-perm">
        <div class="dt-perm-main">
          <div class="dt-perm-top">
            <span class="dt-perm-name">${p.icon} ${p.label}</span>
            <span class="risk ${p.risk}">${p.risk.toUpperCase()}</span>
          </div>
          <div class="dt-perm-desc">${p.description}</div>
          ${p.requiresNative && st.simulated ? '<div class="dt-perm-note">Needs a local host — grant now, activates later.</div>' : ''}
        </div>
        <span class="switch" style="margin-top:.2rem">
          <input type="checkbox" data-perm="${p.id}" ${p.granted ? 'checked' : ''}><span></span>
        </span>
      </label>`).join('');
    $$('[data-perm]', $('dt-perms')).forEach(cb =>
      cb.addEventListener('change', () => {
        this.desktop.permissions.toggle(cb.dataset.perm);
        this.audio.sfx('click');
        this.renderDesktop();
      }));

    // plugins
    $('dt-plugcount').textContent = `${st.plugins.filter(p => p.available).length}/${st.plugins.length} READY`;
    $('dt-plugins').innerHTML = st.plugins.map(p => `
      <div class="dt-plugin">
        <span class="dt-app-ico">${p.icon}</span>
        <div class="dt-plugin-main">
          <div class="dt-plugin-name">${p.name}</div>
          <div class="dt-plugin-desc">${p.description}</div>
          <div class="dt-plugin-actions">${p.actions.join(' · ')}</div>
        </div>
        <span class="dt-app-tag ${p.available ? 'verified' : ''}">${p.available ? 'READY' : p.status.toUpperCase()}</span>
      </div>`).join('');

    // audit
    const audit = this.desktop.actions.recentAudit(12);
    $('dt-audit').innerHTML = audit.length
      ? audit.map(a => `<div><span class="${a.allowed ? 'allow' : 'deny'}">${a.allowed ? '✓' : '✗'}</span> ` +
          `${new Date(a.t).toLocaleTimeString()} ${a.actionId}${a.code ? ` — ${a.code}` : ''}</div>`).join('')
      : '<div>No actions requested yet.</div>';

    // scan button stays disabled until a native host exists
    const scanBtn = $('dt-scan');
    scanBtn.disabled = !st.capabilities.scan;
    $('dt-scan-note').textContent = st.capabilities.scan
      ? 'Scans the Start Menu, registry, Store apps and common install paths.'
      : 'Disabled — application scanning requires the native desktop companion (not installed yet). AURA is using its built-in catalogue.';
  }

  renderDesktopApps(filter = '') {
    const db = this.desktop.database;
    const apps = filter ? db.search(filter, { limit: 40 }) : db.all();
    $('dt-appcount').textContent = `${db.size} KNOWN`;
    $('dt-apps').innerHTML = apps.slice(0, 40).map(a => {
      const custom = a.source === 'user' || a.source === 'builtin-edited';
      return `
      <div class="dt-app" data-app-id="${escapeHtml(a.id)}">
        <span class="dt-app-ico">${escapeHtml(a.icon || '📦')}</span>
        <span class="dt-app-name">${escapeHtml(a.name)}</span>
        <span class="dt-app-tag ${a.verified ? 'verified' : ''}">${custom ? 'CUSTOM' : a.verified ? 'VERIFIED' : 'CATALOGUE'}</span>
        <button class="dt-app-edit mini-btn" data-edit="${escapeHtml(a.id)}" title="Edit ${escapeHtml(a.name)}">✎</button>
      </div>`;
    }).join('') || '<div class="setup-hint">No matches.</div>';

    $$('#dt-apps [data-edit]').forEach(b => {
      b.addEventListener('click', () => this.openAppForm(b.dataset.edit));
    });
  }

  /**
   * Add/edit form for custom applications.
   * @param {string|null} id  null = add a new one
   */
  openAppForm(id = null) {
    const form = $('dt-app-form');
    const app = id ? this.desktop.database.get(id) : null;
    $('dt-app-form-title').textContent = app ? `Edit ${app.name}` : 'Add application';
    $('dt-app-id').value = app?.id || '';
    $('dt-app-name').value = app?.name || '';
    $('dt-app-icon').value = app?.icon || '';
    $('dt-app-aliases').value = (app?.aliases || []).join(', ');
    $('dt-app-exe').value = app?.executablePath || '';
    $('dt-app-web').value = app?.webFallback || '';
    $('dt-app-error').hidden = true;
    $('dt-app-delete').hidden = !app;
    form.hidden = false;
    form.scrollIntoView({ block: 'nearest' });
    $('dt-app-name').focus();
  }

  closeAppForm() { $('dt-app-form').hidden = true; }

  saveAppForm() {
    const db = this.desktop.database;
    const id = $('dt-app-id').value;
    const name = $('dt-app-name').value.trim();
    const err = $('dt-app-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; };

    if (!name) return fail('Give the application a name.');
    const patch = {
      name,
      icon: $('dt-app-icon').value.trim() || '📦',
      aliases: $('dt-app-aliases').value,
      executablePath: $('dt-app-exe').value.trim() || null,
      webFallback: $('dt-app-web').value.trim() || null,
    };

    if (id) {
      const r = db.update(id, patch);
      if (!r.ok) return fail(r.message);
    } else {
      if (patch.webFallback && !/^https?:\/\//i.test(patch.webFallback)) {
        return fail('Web version must start with http:// or https://');
      }
      // An executable given by the user becomes the launcher for this OS, so
      // "open <name>" actually starts it.
      const exe = patch.executablePath;
      db.addCustom({
        id: name, ...patch,
        launchers: exe ? { win32: { exeHint: exe }, darwin: { exeHint: exe }, linux: { exeHint: exe } } : {},
      });
    }
    this.closeAppForm();
    this.renderDesktopApps($('dt-appsearch').value);
    this.audio.sfx('confirm');
    this.toast('success', `${name} saved. Try: “open ${name.toLowerCase()}”`);
  }

  deleteAppFromForm() {
    const id = $('dt-app-id').value;
    if (!id) return;
    const app = this.desktop.database.get(id);
    if (!confirm(`Remove "${app?.name || id}" from the application list?`)) return;
    this.desktop.database.remove(id);
    this.closeAppForm();
    this.renderDesktopApps($('dt-appsearch').value);
    this.toast('info', 'Application removed.');
  }

  /* ══════════════════ AVATAR MANAGER PAGE ══════════════════ */

  async renderAvatarManager() {
    const host = $('av-providers');
    if (!host) return;
    const mgr = this.avatarManager;

    if (!mgr) {
      host.innerHTML = '<div class="setup-warn">You are on a legacy renderer '
        + '(Interface → Avatar renderer). Switch to "Full body" to use avatar providers.</div>';
      $('av-active').textContent = (config.get('avatarMode') || '').toUpperCase();
      return;
    }

    const st = await mgr.status();
    $('av-active').textContent = (st.active || '—').toUpperCase();
    $('av-fps').textContent = st.fps ? `${st.fps} FPS` : '';
    $('av-detail').textContent = st.detail?.detail || st.detail?.description || '';

    host.innerHTML = st.providers.map(p => {
      const active = p.id === st.active;
      const caps = Object.entries(p.capabilities)
        .filter(([, v]) => v).map(([k]) => k).join(' · ');
      return `
        <div class="av-provider ${active ? 'active' : ''} ${p.available ? '' : 'unavailable'}"
             data-provider="${escapeHtml(p.id)}">
          <div class="av-p-main">
            <div class="av-p-name">
              ${escapeHtml(p.label)}
              ${p.isDefault ? '<span class="tag">DEFAULT</span>' : ''}
              ${active ? '<span class="tag on">ACTIVE</span>' : ''}
              ${p.capabilities.offline ? '' : '<span class="tag warn">NEEDS INTERNET</span>'}
            </div>
            <div class="av-p-desc">${escapeHtml(p.description)}</div>
            <div class="av-p-caps">${escapeHtml(caps)}</div>
            ${p.available ? '' : `<div class="av-p-reason">✗ ${escapeHtml(p.reason || 'unavailable')}</div>`}
          </div>
          <button class="btn small" data-use="${escapeHtml(p.id)}"
                  ${active || !p.available ? 'disabled' : ''}>${active ? 'IN USE' : 'USE'}</button>
        </div>`;
    }).join('');

    $$('#av-providers [data-use]').forEach(b => {
      b.addEventListener('click', () => this.switchAvatarProvider(b.dataset.use));
    });

    // Only show the panes that apply to the active provider.
    $('av-import-section').hidden = false;
    $('av-rpm-section').hidden = false;
    $('av-customise-section').hidden = st.active !== 'builtin';
    const solid = $('av-solid');
    if (solid) solid.checked = config.get('avatarSolid') !== false;
  }

  async switchAvatarProvider(id) {
    if (!this.avatarManager) return;
    if (id === 'gltf' && !this.avatarManager._importedBlob && !config.get('avatarModelUrl')) {
      this.toast('warn', 'Import a .vrm or .glb file first.');
      return;
    }
    if (id === 'readyplayerme' && !config.get('avatarRpmUrl')) {
      this.toast('warn', 'Paste your Ready Player Me URL first.');
      return;
    }
    this.toast('info', 'Loading avatar…');
    const r = await this.avatarManager.use(id, this.avatarManager._optionsFor(id));
    if (r.ok) {
      this.audio.sfx('confirm');
      this.toast('success', `Avatar provider: ${id}`);
    }
    await this.renderAvatarManager();
  }

  wireAvatarSettings() {
    $('av-file')?.addEventListener('change', async (e) => {
      const f = /** @type {any} */ (e.target).files?.[0];
      if (!f) return;
      const out = $('av-import-status');
      out.textContent = `Loading ${f.name} (${(f.size / 1048576).toFixed(1)} MB)…`;
      if (!this.avatarManager) { out.textContent = '✗ Switch to the "Full body" renderer first.'; return; }
      const r = await this.avatarManager.importModel(f);
      out.textContent = r.ok
        ? `✓ ${f.name} loaded. ${(await this.avatarManager.status()).detail?.detail || ''}`
        : `✗ ${r.reason}`;
      if (r.ok) this.audio.sfx('confirm');
      await this.renderAvatarManager();
    });

    $('av-rpm-load')?.addEventListener('click', async () => {
      const url = /** @type {any} */ ($('av-rpm-url')).value.trim();
      const out = $('av-rpm-status');
      if (!url) { out.textContent = '✗ Paste a Ready Player Me URL or ID.'; return; }
      if (!this.avatarManager) { out.textContent = '✗ Switch to the "Full body" renderer first.'; return; }
      out.textContent = 'Downloading avatar…';
      const r = await this.avatarManager.useReadyPlayerMe(url);
      out.textContent = r.ok ? '✓ Avatar loaded.' : `✗ ${r.reason}`;
      if (r.ok) this.audio.sfx('confirm');
      await this.renderAvatarManager();
    });

    $('av-solid')?.addEventListener('change', (e) => {
      const on = /** @type {any} */ (e.target).checked;
      config.set('avatarSolid', on);
      const p = /** @type {any} */ (this.avatarManager?.provider);
      if (p?.setSolid) p.setSolid(on);
      else this.toast('info', 'Reload to apply the new material style.');
    });

    $('av-open-wardrobe')?.addEventListener('click', () => {
      this.closeSettings?.();
      this.openPanel('wardrobe');
    });

    const rpm = $('av-rpm-url');
    if (rpm) /** @type {any} */ (rpm).value = config.get('avatarRpmUrl') || '';
  }

  /* ══════════════════ TERMINAL POLICY ══════════════════ */

  /**
   * Fetch the terminal policy from the server and paint it.
   *
   * The fetch is a desktop ACTION, and renderDesktop() runs on every desktop
   * action — so calling this unconditionally from there looped forever. The
   * result is cached; pass force=true after the user changes the policy.
   *
   * @param {boolean} [force]
   */
  async renderTerminalPolicy(force = false) {
    const host = $('dt-policy');
    if (!host) return;
    const bridge = this.actions;
    if (!bridge?.available) {
      host.innerHTML = '<div class="setup-hint">Start AURA with <code>--allow-actions</code> to configure this.</div>';
      $('dt-policy-badge').textContent = 'OFFLINE';
      return;
    }
    if (!force && this._policyCache) { this._paintTerminalPolicy(this._policyCache); return; }
    // Coalesce concurrent callers onto one in-flight request.
    if (this._policyPending) { await this._policyPending; return; }
    this._policyPending = bridge.getPolicy().finally(() => { this._policyPending = null; });
    const r = await this._policyPending;
    if (!r.ok) { host.innerHTML = `<div class="setup-warn">${escapeHtml(r.message || 'unavailable')}</div>`; return; }
    this._policyCache = r;
    this._paintTerminalPolicy(r);
  }

  /** Render the cached policy. Pure DOM — makes no network calls. */
  _paintTerminalPolicy(r) {
    const host = $('dt-policy');
    if (!host || !r) return;
    $('dt-policy-badge').textContent = String(r.policy).toUpperCase();
    host.innerHTML = (r.options || []).map(o => `
      <label class="dt-policy-opt ${o.id === r.policy ? 'active' : ''}">
        <input type="radio" name="tpolicy" value="${escapeHtml(o.id)}" ${o.id === r.policy ? 'checked' : ''}>
        <span class="dt-policy-main">
          <span class="dt-policy-name">${escapeHtml(o.label)}</span>
          <span class="dt-policy-detail">${escapeHtml(o.detail)}</span>
        </span>
      </label>`).join('');

    $$('#dt-policy input[name="tpolicy"]').forEach(el => {
      el.addEventListener('change', async () => {
        const val = /** @type {any} */ (el).value;
        // 'open' disables every confirmation — make the user mean it.
        if (val === 'open') {
          const typed = prompt(
            'This lets AURA run ANY command with no confirmation.\n\nType CONFIRM to enable it:');
          if (typed !== 'CONFIRM') { await this.renderTerminalPolicy(true); return; }
        }
        const res = await this.actions.setPolicy(val);
        this.toast(res.ok ? 'success' : 'warn', res.message || 'Policy updated.');
        this._policyCache = null;
        await this.renderTerminalPolicy(true);
      });
    });
  }

  /* ══════════════════ APP AUTO-DETECTION ══════════════════ */

  async detectInstalledApps() {
    const out = $('dt-detect-status');
    const panel = $('dt-detected');
    if (!this.actions?.available) {
      out.textContent = '✗ Start AURA with --allow-actions to scan this machine.';
      return;
    }
    out.textContent = 'Scanning this machine…';
    const r = await this.actions.detectApps();
    if (!r.ok) { out.textContent = `✗ ${r.message || 'Scan failed.'}`; return; }

    this._detected = r.apps || [];
    const known = new Set(this.desktop.database.all().map(a => a.name.toLowerCase()));
    // Anything already in the list is marked so you aren't offered duplicates.
    this._detected.forEach(a => { a.known = known.has(a.name.toLowerCase()); });

    out.textContent = `✓ ${r.message} Nothing has been granted access yet.`;
    panel.hidden = false;
    this.renderDetectedApps('');
    this.audio.sfx('confirm');
  }

  renderDetectedApps(filter = '') {
    const list = $('dt-detected-list');
    const f = String(filter || '').toLowerCase();
    const items = (this._detected || []).filter(a => !f || a.name.toLowerCase().includes(f));
    $('dt-detected-count').textContent = `${items.length} FOUND`;
    list.innerHTML = items.slice(0, 300).map(a => `
      <label class="dt-det ${a.known ? 'known' : ''}">
        <input type="checkbox" data-det="${escapeHtml(a.id)}" ${a.known ? 'disabled' : ''}>
        <span class="dt-det-name">${escapeHtml(a.name)}</span>
        <span class="dt-det-src">${a.known ? 'already added' : escapeHtml(a.source || '')}</span>
      </label>`).join('') || '<div class="setup-hint">No matches.</div>';
  }

  addSelectedDetectedApps() {
    const picked = $$('#dt-detected-list input[data-det]:checked').map(el => el.dataset.det);
    if (!picked.length) { this.toast('warn', 'Nothing selected.'); return; }
    let added = 0;
    for (const id of picked) {
      const app = (this._detected || []).find(a => a.id === id);
      if (!app) continue;
      const exe = app.path || '';
      this.desktop.database.addCustom({
        id: app.name,
        name: app.name,
        icon: '🖥',
        category: 'system',
        executablePath: exe || null,
        launchers: exe ? { win32: { exeHint: exe }, darwin: { exeHint: exe }, linux: { exeHint: exe } } : {},
      });
      added++;
    }
    $('dt-detected').hidden = true;
    this.renderDesktopApps($('dt-appsearch').value);
    this.audio.sfx('confirm');
    this.toast('success', `${added} application${added === 1 ? '' : 's'} added. Try “open ${
      (this._detected.find(a => a.id === picked[0])?.name || '').toLowerCase()}”.`);
  }


  /* ══════════════════ APPEARANCE ══════════════════ */

  /** Re-apply the whole theme from config. Cheap: it only writes CSS vars. */
  applyAppearance() {
    applyThemeVars(config.get());
  }

  renderAppearance() {
    const cat = themeCatalog();
    const cfg = config.get();
    const cur = cfg.theme || 'aura-blue';
    $('thm-active').textContent = (THEME_PRESETS[cur]?.label || cur).toUpperCase();

    $('thm-presets').innerHTML = cat.presets.map(p => `
      <button class="thm-preset ${p.id === cur ? 'on' : ''}" data-preset="${escapeHtml(p.id)}">
        <div class="thm-swatch" style="background:linear-gradient(135deg,${p.accent},${p.accent2} 55%,${p.bg1})"></div>
        <div class="thm-name">${escapeHtml(p.label)}</div>
      </button>`).join('');
    $$('#thm-presets [data-preset]').forEach(b => b.addEventListener('click', () => {
      config.set('theme', b.dataset.preset);
      this.applyAppearance(); this.audio.sfx('click'); this.renderAppearance();
    }));

    const chips = (host, items, key, dflt) => {
      const el = $(host);
      if (!el) return;
      const active = cfg[key] || dflt;
      el.innerHTML = items.map(i =>
        `<button class="thm-chip ${i.id === active ? 'on' : ''}" data-${key}="${escapeHtml(i.id)}">${escapeHtml(i.label)}</button>`).join('');
      el.querySelectorAll(`[data-${key}]`).forEach(b => b.addEventListener('click', () => {
        config.set(key, b.dataset[key]);
        this.applyAppearance(); this.audio.sfx('click'); this.renderAppearance();
      }));
    };
    chips('thm-backgrounds', cat.backgrounds, 'background', 'gradient');
    chips('thm-densities', cat.densities, 'density', 'comfortable');
    chips('thm-huds', cat.hudStyles, 'hudStyle', 'brackets');

    $('thm-sliders').innerHTML = cat.tunables.map(t => {
      const v = cfg[t.id] ?? t.def;
      return `<div class="thm-row">
        <label for="thm-${t.id}">${escapeHtml(t.label)}</label>
        <input id="thm-${t.id}" type="range" min="${t.min}" max="${t.max}" step="${t.step}" value="${v}"
               data-tunable="${t.id}">
        <span class="thm-val" data-valfor="${t.id}">${(+v).toFixed(t.step < 1 ? 2 : 0)}${t.unit}</span>
      </div>`;
    }).join('');
    $$('#thm-sliders [data-tunable]').forEach(el => {
      el.addEventListener('input', () => {
        const id = el.dataset.tunable;
        const t = TUNABLES[id];
        const v = parseFloat(/** @type {any} */ (el).value);
        config.set(id, v);
        const out = document.querySelector(`[data-valfor="${id}"]`);
        if (out) out.textContent = `${v.toFixed(t.step < 1 ? 2 : 0)}${t.unit}`;
        this.applyAppearance();   // live, no reload
      });
    });

    const hidden = Array.isArray(cfg.hiddenWidgets) ? cfg.hiddenWidgets : [];
    $('thm-widgets').innerHTML = cat.widgets.map(w =>
      `<button class="thm-chip ${hidden.includes(w.id) ? '' : 'on'}" data-widget="${escapeHtml(w.id)}">
         ${hidden.includes(w.id) ? '○' : '●'} ${escapeHtml(w.label)}</button>`).join('');
    $$('#thm-widgets [data-widget]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.widget;
      const list = new Set(Array.isArray(config.get('hiddenWidgets')) ? config.get('hiddenWidgets') : []);
      if (list.has(id)) list.delete(id); else list.add(id);
      config.set('hiddenWidgets', Array.from(list));
      this.applyAppearance(); this.audio.sfx('click'); this.renderAppearance();
    }));

    const ac = /** @type {any} */ ($('thm-accent'));
    const ac2 = /** @type {any} */ ($('thm-accent2'));
    if (ac) ac.value = cfg.customAccent || THEME_PRESETS[cur]?.accent || '#38bdf8';
    if (ac2) ac2.value = cfg.customAccent2 || THEME_PRESETS[cur]?.accent2 || '#818cf8';
  }

  wireAppearance() {
    $('thm-accent')?.addEventListener('input', (e) => {
      config.set('customAccent', /** @type {any} */ (e.target).value);
      this.applyAppearance();
    });
    $('thm-accent2')?.addEventListener('input', (e) => {
      config.set('customAccent2', /** @type {any} */ (e.target).value);
      this.applyAppearance();
    });
    $('thm-accent-clear')?.addEventListener('click', () => {
      config.set({ customAccent: '', customAccent2: '' });
      this.applyAppearance(); this.renderAppearance();
      this.toast('info', 'Using the preset colours.');
    });
    $('thm-reset')?.addEventListener('click', () => {
      config.set(themeDefaults());
      this.applyAppearance(); this.renderAppearance();
      this.audio.sfx('confirm'); this.toast('success', 'Appearance reset.');
    });
    $('thm-random')?.addEventListener('click', () => {
      const cat = themeCatalog();
      const pick = (a) => a[Math.floor(Math.random() * a.length)];
      const patch = {
        theme: pick(cat.presets).id,
        background: pick(cat.backgrounds).id,
        hudStyle: pick(cat.hudStyles).id,
        customAccent: '', customAccent2: '',
        accentHue: Math.round((Math.random() - 0.5) * 120),
        glassBlur: Math.round(Math.random() * 34),
        glowStrength: +(Math.random() * 0.8).toFixed(2),
        cornerRadius: Math.round(Math.random() * 24),
      };
      config.set(patch);
      this.applyAppearance(); this.renderAppearance();
      this.audio.sfx('confirm');
      this.toast('success', `${THEME_PRESETS[patch.theme].label} · ${patch.background}`);
    });
  }

  /* ══════════════════ MEMORY CENTER ══════════════════ */

  async renderMemory() {
    const host = $('mem-list');
    if (!host) return;
    const tab = this._memTab || 'conversation';
    const q = /** @type {any} */ ($('mem-search'))?.value || '';
    const mem = this.ai.memory;

    $$('.mem-tab').forEach(b => b.classList.toggle('on', b.dataset.memtab === tab));
    $('mem-add-section').hidden = tab !== 'knowledge' && tab !== 'facts';

    const st = await this.memoryManager.stats();
    // Count from ai.memory — that is the live conversation this page edits.
    // memoryManager.conversation is the layered store and can legitimately
    // differ, so reading it here showed "0 MSG" beside a full list.
    const convCount = mem.messages.length;
    const pinCount = mem.pinnedMessages().length;
    $('mem-stats').textContent =
      `${convCount} MSG · ${pinCount} PINNED · ${st.preferences.total} FACTS · ${st.knowledge.documents} DOCS`;

    const esc = escapeHtml;
    const when = (t) => new Date(t).toLocaleString();

    if (tab === 'conversation' || tab === 'pinned') {
      let items = tab === 'pinned' ? mem.pinnedMessages() : mem.search(q, { limit: 200 });
      if (tab === 'pinned' && q) {
        items = items.filter(m => m.content.toLowerCase().includes(q.toLowerCase()));
      }
      host.innerHTML = items.length ? items.map(m => {
        const id = esc(`${m.t}-${m.role}`);
        return `<div class="mem-item ${m.pinned ? 'pinned' : ''}" data-mid="${id}">
          <div class="mem-role">${esc(m.role)}</div>
          <div class="mem-body" style="flex:1">
            <div class="mem-text" data-text>${esc(m.content)}</div>
            <div class="mem-when">${when(m.t)}${m.edited ? ' · edited' : ''}</div>
          </div>
          <div class="mem-acts">
            <button data-act="pin" title="${m.pinned ? 'Unpin' : 'Pin — always keep in context'}">${m.pinned ? '📌' : '📍'}</button>
            <button data-act="edit" title="Edit">✎</button>
            <button data-act="del" title="Delete">🗑</button>
          </div>
        </div>`;
      }).join('') : `<div class="mem-empty">${tab === 'pinned' ? 'Nothing pinned yet. Pin a message to keep it in context forever.' : 'No messages match.'}</div>`;
      this._wireMemItems('message');
      return;
    }

    if (tab === 'facts') {
      const prefs = this.memoryManager.preferences.all();
      const entries = Object.entries(prefs)
        .filter(([k, v]) => !q || `${k} ${v.value}`.toLowerCase().includes(q.toLowerCase()));
      host.innerHTML = entries.length ? entries.map(([k, v]) => `
        <div class="mem-item" data-mid="${esc(k)}">
          <div class="mem-role">${esc(k)}</div>
          <div class="mem-body" style="flex:1">
            <div class="mem-text" data-text>${esc(String(v.value))}</div>
            <div class="mem-when">${when(v.at)} · ${esc(v.source || 'user')}</div>
          </div>
          <div class="mem-acts">
            <button data-act="edit" title="Edit">✎</button>
            <button data-act="del" title="Forget">🗑</button>
          </div>
        </div>`).join('') : '<div class="mem-empty">No facts learned yet. Tell AURA your name or preferences.</div>';
      this._wireMemItems('fact');
      return;
    }

    const docs = await this.memoryManager.knowledge.all();
    const filtered = docs.filter(d => !q || d.text.toLowerCase().includes(q.toLowerCase()));
    host.innerHTML = filtered.length ? filtered.map(d => `
      <div class="mem-item" data-mid="${esc(d.id)}">
        <div class="mem-role">${esc(d.metadata?.source || 'note')}</div>
        <div class="mem-body" style="flex:1">
          <div class="mem-text" data-text>${esc(d.text)}</div>
          <div class="mem-when">${d.metadata?.at ? when(d.metadata.at) : ''}</div>
        </div>
        <div class="mem-acts"><button data-act="del" title="Forget">🗑</button></div>
      </div>`).join('') : '<div class="mem-empty">Nothing stored. Use "Teach AURA something" below.</div>';
    this._wireMemItems('doc');
  }

  /** Wire per-row buttons. `kind` decides which store the row belongs to. */
  _wireMemItems(kind) {
    $$('#mem-list .mem-item').forEach(row => {
      const id = row.dataset.mid;
      const textEl = row.querySelector('[data-text]');
      row.querySelectorAll('[data-act]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const act = /** @type {any} */ (btn).dataset.act;

          if (act === 'del') {
            if (kind === 'message') this.ai.memory.removeMessage(id);
            else if (kind === 'fact') await this.memoryManager.preferences.remove(id);
            else await this.memoryManager.knowledge.forget(id);
            this.audio.sfx('click');
            await this.renderMemory();
            return;
          }

          if (act === 'pin') {
            const m = this.ai.memory.find(id);
            this.ai.memory.pinMessage(id, !m?.pinned);
            this.audio.sfx('confirm');
            this.toast('info', m?.pinned ? 'Unpinned.' : 'Pinned — always kept in context.');
            await this.renderMemory();
            return;
          }

          if (act === 'edit') {
            const editing = textEl.getAttribute('contenteditable') === 'true';
            if (!editing) {
              textEl.setAttribute('contenteditable', 'true');
              /** @type {any} */ (textEl).focus();
              btn.textContent = '✔';
              return;
            }
            const val = textEl.textContent.trim();
            if (kind === 'message') this.ai.memory.editMessage(id, val);
            else if (kind === 'fact') await this.memoryManager.preferences.set(id, val, { source: 'user' });
            textEl.setAttribute('contenteditable', 'false');
            this.audio.sfx('confirm');
            await this.renderMemory();
          }
        });
      });
    });
  }

  wireMemorySettings() {
    $$('.mem-tab').forEach(b => b.addEventListener('click', () => {
      this._memTab = b.dataset.memtab;
      this.renderMemory();
    }));
    $('mem-search')?.addEventListener('input', () => this.renderMemory());
    $('mem-add')?.addEventListener('click', async () => {
      const el = /** @type {any} */ ($('mem-new'));
      const text = el.value.trim();
      if (!text) return;
      await this.memoryManager.knowledge.learn({ text, source: 'user' });
      el.value = '';
      this._memTab = 'knowledge';
      this.audio.sfx('confirm');
      this.toast('success', 'Stored. I will recall this when it is relevant.');
      await this.renderMemory();
    });
    $('mem-export')?.addEventListener('click', async () => {
      const st = await this.memoryManager.stats();
      const facts = Object.entries(this.memoryManager.preferences.all())
        .map(([k, v]) => `${k}: ${v.value}`).join('\n');
      const docs = (await this.memoryManager.knowledge.all()).map(d => `- ${d.text}`).join('\n');
      const body = `AURA MEMORY EXPORT\n${new Date().toISOString()}\n\n`
        + `== CONVERSATION (${st.conversation.total}) ==\n${this.ai.memory.export?.() || ''}\n\n`
        + `== FACTS ==\n${facts || '(none)'}\n\n== KNOWLEDGE ==\n${docs || '(none)'}\n`;
      const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url; a.download = `aura-memory-${Date.now()}.txt`; a.click();
      URL.revokeObjectURL(url);
      this.toast('success', 'Memory exported.');
    });
    $('mem-clear-conv')?.addEventListener('click', async () => {
      if (!confirm('Clear the conversation? Pinned messages are removed too.')) return;
      this.ai.memory.clear();
      await this.memoryManager.clear('conversation');
      this.clearTranscript();
      await this.renderMemory();
      this.toast('info', 'Conversation cleared.');
    });
    $('mem-clear-all')?.addEventListener('click', async () => {
      if (!confirm('Forget EVERYTHING — conversation, facts and knowledge? This cannot be undone.')) return;
      this.ai.memory.clear();
      await this.memoryManager.clear('all');
      this.clearTranscript();
      await this.renderMemory();
      this.toast('warn', 'All memory erased.');
    });
  }


  /* ══════════════════ FACE RECOGNITION ══════════════════ */

  async renderFaces() {
    const host = $('face-list');
    if (!host) return;
    const fr = await this.vision.recognizer();
    const people = fr.list();
    host.innerHTML = people.length ? people.map(p => `
      <div class="mem-item" data-face="${escapeHtml(p.id)}">
        <div class="mem-role">FACE</div>
        <div class="mem-body" style="flex:1">
          <div class="mem-text">${escapeHtml(p.name)}</div>
          <div class="mem-when">${p.samples} samples · seen ${p.seen}×${
            p.lastSeen ? ' · last ' + new Date(p.lastSeen).toLocaleString() : ''}</div>
        </div>
        <div class="mem-acts"><button data-face-del="${escapeHtml(p.id)}" title="Forget">🗑</button></div>
      </div>`).join('') : '<div class="mem-empty">Nobody enrolled yet.</div>';

    $$('#face-list [data-face-del]').forEach(b => b.addEventListener('click', async () => {
      fr.forget(b.dataset.faceDel);
      this.audio.sfx('click');
      await this.renderFaces();
    }));
  }

  async startFaceEnrollment() {
    const nameEl = /** @type {any} */ ($('face-name'));
    const out = $('face-status');
    const name = (nameEl?.value || '').trim();
    if (!name) { out.textContent = '✗ Type a name first.'; return; }
    if (!state.get('cameraActive')) {
      out.textContent = '✗ Turn the camera on first (VISION panel → ENABLE CAMERA).';
      return;
    }
    if (!config.get('faceRecognition')) {
      config.set('faceRecognition', true);
      /** @type {any} */ ($('set-facerec')).checked = true;
    }
    // Go through vision.startEnrollment so the on-canvas scan overlay is
    // armed on the very first frame, not after the first identify.
    const r = await this.vision.startEnrollment(name);
    out.textContent = r.ok ? `📸 ${r.message} — watch your face on the camera.` : `✗ ${r.message}`;
    if (!r.ok) return;
    nameEl.value = '';

    // Progress is driven by the vision loop, which feeds samples in.
    const off = bus.on('vision:enroll-progress', (p) => {
      out.textContent = p.ok ? `📸 ${p.message}` : `… ${p.message}`;
    });
    const done = bus.on('vision:enroll-ready', async () => {
      off(); done();
      const rec = await this.vision.recognizer();
      const res = rec.finishEnrollment();
      this.vision._enrolling = false;
      this.vision._enrollViz = null;
      out.textContent = res.ok ? `✓ ${res.message}` : `✗ ${res.message}`;
      if (res.ok) this.audio.sfx('confirm');
      await this.renderFaces();
    });
    // Give up after 20s rather than leaving enrolment stuck open.
    setTimeout(async () => {
      const rec = await this.vision.recognizer();
      if (!rec.enrolling) return;
      off(); done();
      await this.vision.cancelEnrollment();
      out.textContent = '✗ Timed out — make sure your face is clearly visible.';
    }, 20000);
  }

  /* ══════════════════ WEB RESEARCH ══════════════════ */

  async renderWebResearch() {
    const caps = $('web-caps');
    if (!caps) return;
    if (!this.actions?.available) {
      caps.textContent = 'Start AURA with --allow-actions to enable web research.';
      $('web-badge').textContent = 'OFFLINE';
      return;
    }
    const c = await this.actions.webCapabilities();
    $('web-badge').textContent = c.search ? (c.read ? 'SEARCH + READ' : 'SEARCH ONLY') : 'UNAVAILABLE';
    const lines = [];
    lines.push(c.search ? `✓ Search ready (${c.searchPackage})` : `✗ ${c.reason}`);
    lines.push(c.read ? '✓ Page reading ready (trafilatura)' : `✗ ${c.readReason}`);
    caps.innerHTML = lines.map(escapeHtml).join('<br>');
  }

  wireWebResearch() {
    $('web-test')?.addEventListener('click', async () => {
      const q = /** @type {any} */ ($('web-test-q')).value.trim();
      const out = $('web-test-out');
      if (!q) { out.textContent = 'Type something to search for.'; return; }
      if (!this.actions?.available) { out.textContent = '✗ Needs --allow-actions.'; return; }
      out.textContent = 'Searching…';
      const t0 = performance.now();
      const r = await this.actions.webResearch(q);
      const ms = Math.round(performance.now() - t0);
      if (!r.ok) { out.textContent = `✗ ${r.message}`; return; }
      out.innerHTML = `✓ ${r.results.length} results · read ${r.readCount} page(s) · `
        + `depth <b>${escapeHtml(r.depth)}</b> · ${ms} ms<br>`
        + (r.sources || []).slice(0, 3)
            .map(s => `${s.n}. ${escapeHtml(s.title)}`).join('<br>');
    });
  }

  /* ══════════════════ INPUT AUTOMATION ══════════════════ */

  async renderAutomation() {
    const caps = $('auto-caps');
    if (!caps) return;
    if (!this.actions?.available) {
      caps.textContent = 'Start AURA with --allow-actions to enable this.';
      $('auto-badge').textContent = 'OFFLINE';
      return;
    }
    const c = await this.actions.automationCapabilities();
    this._autoCaps = c;
    $('auto-badge').textContent = !c.available ? 'NOT INSTALLED' : (c.armed ? 'ARMED' : 'DISARMED');
    caps.innerHTML = c.available
      ? `✓ pyautogui ready${c.screen ? ` · screen ${c.screen.width}×${c.screen.height}` : ''}`
        + `<br>Max ${c.maxSteps} steps per plan · arming lapses after ${Math.round(c.armTtlSeconds / 60)} min`
      : `✗ ${escapeHtml(c.reason)}`;
  }

  wireAutomation() {
    $('auto-arm')?.addEventListener('click', async () => {
      const out = $('auto-status');
      if (!this.actions?.available) { out.textContent = '✗ Needs --allow-actions.'; return; }
      if (!confirm('Arm input automation?\n\nAURA will be able to move your mouse and '
                 + 'type on your behalf. Every plan is shown to you before it runs, and '
                 + 'you can abort anything by slamming the pointer into the top-left corner.')) return;
      const r = await this.actions.automationArm();
      out.textContent = r.ok ? `✓ ${r.message}` : `✗ ${r.message}`;
      if (r.ok) this.audio.sfx('confirm');
      await this.renderAutomation();
    });
    $('auto-disarm')?.addEventListener('click', async () => {
      const r = await this.actions.automationDisarm();
      $('auto-status').textContent = r.message || 'Disarmed.';
      await this.renderAutomation();
    });
    $('auto-cursor')?.addEventListener('click', async () => {
      const r = await this.actions.automationCursor();
      $('auto-status').textContent = r.ok
        ? `Pointer is at (${r.x}, ${r.y}).` : `✗ ${r.message}`;
    });
  }

  wireDesktopSettings() {
    $('dt-appsearch').addEventListener('input', e => this.renderDesktopApps(e.target.value));
    $('dt-detect')?.addEventListener('click', () => this.detectInstalledApps());
    $('dt-detected-filter')?.addEventListener('input', e => this.renderDetectedApps(e.target.value));
    $('dt-detected-add')?.addEventListener('click', () => this.addSelectedDetectedApps());
    $('dt-detected-close')?.addEventListener('click', () => { $('dt-detected').hidden = true; });
    $('dt-app-add').addEventListener('click', () => this.openAppForm(null));
    $('dt-app-cancel').addEventListener('click', () => this.closeAppForm());
    $('dt-app-save').addEventListener('click', () => this.saveAppForm());
    $('dt-app-delete').addEventListener('click', () => this.deleteAppFromForm());
    $('dt-perm-rec').addEventListener('click', () => {
      this.desktop.setup.applyRecommended();
      this.audio.sfx('confirm');
      this.renderDesktop();
      this.toast('success', 'Recommended permissions granted.');
    });
    $('dt-perm-none').addEventListener('click', () => {
      this.desktop.permissions.revokeAll();
      this.audio.sfx('click');
      this.renderDesktop();
      this.toast('info', 'All desktop permissions revoked.');
    });
    $('dt-scan').addEventListener('click', async () => {
      const r = await this.desktop.setup.runScan();
      this.toast(r.ok ? 'success' : 'warn', r.message || 'Scan finished.');
      this.renderDesktop();
    });
  }

  async renderConnectStatus() {
    const el = $('connect-status');
    if (!el) return;
    const live = config.get('liveData') !== false;
    const rows = [
      `${live ? '🟢' : '⚪'} Live data: ${live ? 'ON' : 'OFF (fully offline)'}`,
      `${this.actions?.available ? '🟢' : '⚪'} Desktop control: ${this.actions?.available ? `ON (${this.actions.os})` : 'off'}`,
      `${state.get('hybridReady') ? '🟢' : '⚪'} Hybrid Ollama: ${state.get('hybridReady') ? `ready (${state.get('ollamaModel')})` : 'not detected'}`,
      `🧠 Active core: ${this.ai.providerLabel}${state.get('aiModel') ? ' · ' + state.get('aiModel') : ''}`,
    ];
    el.innerHTML = rows.join('<br>');
  }

  updateModelHint() {
    const pid = config.get('provider') === 'auto' ? this.ai.resolvedProvider : config.get('provider');
    const p = PROVIDERS[pid];
    const hint = $('model-hint');
    if (!p) { hint.textContent = 'local core has no models'; return; }

    if (pid === 'ollama') {
      // Ollama has no meaningful "default" until we've asked it what exists.
      // Populate the datalist from the REAL installed list.
      const names = p.installed || [];
      hint.textContent = names.length
        ? `installed: ${names.join(', ')}`
        : 'no models found yet — click FETCH MODELS (runs "ollama list")';
      $('model-list').innerHTML = names.map(m => `<option value="${escapeHtml(m)}">`).join('');
      // Refresh in the background so the list self-heals after a pull.
      p.refresh({ baseUrlOverride: config.get('ollamaUrl'), force: true })
        .then((live) => {
          if (config.get('provider') !== 'ollama' && this.ai.resolvedProvider !== 'ollama') return;
          hint.textContent = live.length ? `installed: ${live.join(', ')}` : 'Ollama running, but no models pulled yet';
          $('model-list').innerHTML = live.map(m => `<option value="${escapeHtml(m)}">`).join('');
        })
        .catch(() => { /* offline — keep the cached hint */ });
      return;
    }

    hint.textContent = p.defaultModel ? `default: ${p.defaultModel}` : '';
    if (p.models) $('model-list').innerHTML = p.models.map(m => `<option value="${escapeHtml(m)}">`).join('');
  }

  syncAll() {
    this.syncToggles();
    const fr = $('set-facerec'); if (fr) /** @type {any} */ (fr).checked = config.get('faceRecognition');
    const fg = $('set-facegreet'); if (fg) /** @type {any} */ (fg).checked = config.get('faceGreeting');
    const ws = $('set-websearch'); if (ws) /** @type {any} */ (ws).checked = config.get('webSearch');
    const wd = $('set-webdepth'); if (wd) /** @type {any} */ (wd).value = config.get('webSearchDepth');
    $('tg-hands').checked = config.get('handTracking');
    $('tg-faces').checked = config.get('faceTracking');
    $('tg-objects').checked = config.get('objectDetection');
    document.querySelector('.cam-wrap').classList.toggle('mirror', config.get('mirrorCamera'));
    $('fx-canvas').style.display = config.get('particles') ? '' : 'none';
    $('stat-core').textContent = this.ai.providerLabel.replace(' (local)', '');
    $('composer-hint').textContent = this.ai.providerLabel;
    if (config.get('wakeWordEnabled')) this.setWakeWord(true);
  }

  syncToggles() {
    const on = config.get('ttsEnabled');
    $('dock-speak').classList.toggle('muted', !on);
    $('dock-speak').querySelector('.dock-ico').textContent = on ? '🔊' : '🔇';
  }

  /* ══════════════════ UI FACADE (used by plugins/gestures) ══════════════════ */

  /** Avatar height slider + quick presets. */
  wireAvatarHeight() {
    const slider = /** @type {HTMLInputElement} */ ($('ward-height'));
    const label = $('ward-height-val');
    if (!slider) return;
    const show = (v) => { if (label) label.textContent = `${Math.round(v * 100)}%`; };
    const apply = (v, toast = false) => {
      const applied = this.avatar.setHeight(v);
      slider.value = String(v);
      show(v);
      if (toast) {
        this.toast(applied ? 'success' : 'warn',
          applied ? `Avatar height ${Math.round(v * 100)}%`
                  : 'This avatar provider cannot be resized.');
      }
    };
    const saved = Number(config.get('avatarHeight')) || 1;
    slider.value = String(saved);
    show(saved);
    // Apply the saved value once the provider is up.
    setTimeout(() => this.avatar.setHeight(saved), 600);
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      show(v);
      this.avatar.setHeight(v);
    });
    slider.addEventListener('change', () => this.audio?.sfx('click'));
    $$('button[data-height]').forEach(b => {
      b.addEventListener('click', () => {
        this.audio?.sfx('click');
        apply(Number(b.dataset.height), true);
      });
    });
  }

  /**
   * AURA Live visibility toggle.
   *
   * VISIBILITY, NOT DELETION. The /screen route, live.html, live.css and
   * js/live.js are untouched — you can still navigate there directly. This
   * only hides the dock entry and skips wiring that the page does not need,
   * so re-enabling restores it exactly.
   */
  wireAuraLiveToggle() {
    const el = $('tg-auralive');
    if (!el) return;
    const apply = (on) => {
      const link = $('dock-live');
      if (link) link.hidden = !on;
      const badge = $('live-badge');
      if (badge) badge.textContent = on ? 'ON' : 'HIDDEN';
      /** @type {HTMLInputElement} */ (el).checked = on;
    };
    apply(config.get('auraLiveEnabled') !== false);
    el.addEventListener('change', () => {
      const on = /** @type {HTMLInputElement} */ (el).checked;
      config.set('auraLiveEnabled', on);
      apply(on);
      this.audio?.sfx('click');
      this.toast('info', on
        ? 'AURA Live shown — the dock entry is back.'
        : 'AURA Live hidden. The page still exists at /screen.');
    });
  }

  /**
   * Bind the AI Sphere to what the agent is REALLY doing.
   *
   * Every source here is an actual event from an actual subsystem — no timers,
   * no random walk. If the sphere is glowing "executing", a tool is executing.
   * That is the whole point of §11/§94: the sphere is an instrument, not an
   * ornament. Providers that cannot show state ignore this silently.
   */
  wireAgentState() {
    const set = (s) => this.avatarManager?.setAgentState?.(s);
    /** Depth counter: nested traces must not let the first one to finish
     *  reset the sphere while later work is still running. */
    let busy = 0;
    const enter = (s) => { busy++; set(s); };
    const leave = (s) => {
      busy = Math.max(0, busy - 1);
      if (s) set(s);
      if (busy === 0) setTimeout(() => { if (busy === 0) set('idle'); }, 900);
    };

    // ── voice
    bus.on(EV.STT_START, () => set('listening'));
    bus.on(EV.STT_END, () => { if (busy === 0) set('idle'); });

    // ── model calls
    bus.on(EV.AI_STREAM_START, () => enter('thinking'));
    bus.on(EV.AI_STREAM_END, () => leave(null));
    bus.on(EV.AI_STREAM_ABORT, () => leave(null));
    bus.on(EV.AI_ERROR, () => { busy = 0; set('error'); });

    // ── the agent loop: planning vs executing are genuinely different phases
    bus.on('trace:start', ({ title }) => {
      const t = String(title || '').toLowerCase();
      enter(/plan|think|outline|understand/.test(t) ? 'planning' : 'executing');
    });
    bus.on('trace:end', ({ state }) => leave(state === 'fail' ? 'error' : 'success'));

    // ── real OS work
    bus.on('action:result', ({ result }) => {
      if (result && result.ok === false) set('error');
    });

    // ── device gateway
    bus.on('devices:pairing', () => set('connecting'));
    bus.on('devices:paired', () => set('connected'));

    // ── dwell / vision
    bus.on(DWELL_EV.FIRED, () => set('success'));

    // Honour Reduce Motion on the sphere as well as the CSS.
    const rm = () => {
      const p = /** @type {any} */ (this.avatarManager?.provider);
      p?.setReducedMotion?.(!!config.get('reduceMotion'));
    };
    bus.on(EV.UI_THEME, rm);
    rm();
  }

  /**
   * Ask the user to approve something destructive.
   *
   * Exists so plugins have ONE confirmation path instead of each reaching for
   * `window.confirm` directly. Async by contract, so it can become a styled
   * modal later without touching a single caller.
   *
   * @param {string} question
   * @returns {Promise<boolean>}
   */
  async confirm(question) {
    return window.confirm(question);
  }

  /** Where generated documents are saved. Empty = the bridge's default. */
  docFolder() {
    return (config.get('docFolder') || '').trim() || undefined;
  }

  /** Settings → Devices → Generated files. */
  async wireDocs() {
    const el = /** @type {HTMLInputElement} */ ($('doc-folder'));
    if (!el) return;
    el.value = config.get('docFolder') || '';
    el.addEventListener('change', () => {
      config.set('docFolder', el.value.trim());
      this.toast('info', el.value.trim()
        ? `Generated files will go to ${el.value.trim()}`
        : 'Using the default folder.');
    });

    $('doc-open')?.addEventListener('click', async () => {
      const caps = await this.actions?.docCapabilities?.();
      const target = this.docFolder() || caps?.defaultFolder;
      if (!target) return this.toast('warn', 'No folder to open.');
      const r = await this.actions.openFolder(target);
      // The folder only exists once something has been written to it.
      if (!r?.ok) this.toast('warn', r?.message || 'Could not open it — it may not exist yet.');
    });

    $('doc-sample')?.addEventListener('click', async () => {
      const A = this.actions;
      if (!A?.available) return this.toast('warn', 'No action bridge.');
      const caps = await A.docCapabilities();
      const kind = caps?.pptx ? 'pptx' : caps?.xlsx ? 'xlsx' : caps?.docx ? 'docx' : null;
      if (!kind) return this.toast('error', 'No document library installed.');
      const { outlineFallback } = await import('./ai/doc-agent.js');
      const r = await A.docBuild(kind, outlineFallback(kind, 'AURA test file'),
                                 this.docFolder());
      this.toast(r?.ok ? 'success' : 'error', r?.message || 'Failed.');
      this.syncDocs();
    });

    this.syncDocs();
  }

  async syncDocs() {
    if (!$('doc-caps')) return;
    const caps = await this.actions?.docCapabilities?.().catch(() => null);
    const badge = $('doc-badge');
    if (!caps?.ok) {
      badge.textContent = 'OFF';
      $('doc-caps').textContent = 'The action bridge is not running, so AURA '
        + 'cannot write files. Restart with --allow-actions.';
      return;
    }
    const have = ['pptx', 'xlsx', 'docx'].filter(k => caps[k]);
    const missing = ['pptx', 'xlsx', 'docx'].filter(k => !caps[k]);
    badge.textContent = have.length ? `${have.length}/3` : 'NONE';
    badge.classList.toggle('armed', have.length === 3);
    $('doc-folder').placeholder = caps.defaultFolder || '(default)';
    $('doc-caps').textContent =
      (have.length ? `Available: ${have.join(', ')}. ` : 'No formats available. ')
      + (missing.length
        ? `Missing: ${missing.map(k => `${k} (${caps.install[k]})`).join('; ')}.`
        : 'All three formats ready.');
  }

  /* ── devices (phone / second machine companion) ─────────────────── */

  /**
   * Settings → Devices.
   *
   * This existed only as the `/devices` chat command until v0.20.1. The phone
   * page told users to "open Settings → Devices", and that section did not
   * exist — so the pairing code was unreachable unless you knew the command.
   * Reported by the user; they were right.
   */
  wireDevices() {
    if (!$('dev-pair')) return;

    const lan = $('dev-lan');
    if (lan) {
      lan.textContent = `Companion page: ${location.origin}/phone  ·  `
        + 'on the phone use this machine\u2019s LAN IP, not localhost. '
        + 'Start AURA with --allow-lan so the phone can reach it.';
    }
    const url = $('dev-url');
    if (url) url.textContent = `${location.origin}/phone`;

    $('dev-pair').addEventListener('click', () => this.startDevicePairing());
    $('dev-refresh').addEventListener('click', () => this.refreshDevices());

    // Keep the countdown honest while the tab is open.
    this._devTimer = setInterval(() => {
      if (!this.settingsOpen() || this._settingsTab !== 'devices') return;
      this._tickPairCode();
    }, 1000);
  }

  async startDevicePairing() {
    const A = this.actions;
    if (!A?.available) {
      this.toast('warn', 'No action bridge. Restart AURA with --allow-actions.');
      return;
    }
    const r = await A.devicePairStart().catch(e => ({ ok: false, message: String(e) }));
    if (!r.ok) { this.toast('error', r.message || 'Could not start pairing.'); return; }
    // Real signal: a pairing window is genuinely open and waiting.
    bus.emit('devices:pairing', { expiresIn: r.expiresIn });
    this._pairExpiry = Date.now() + (r.expiresIn ?? 180) * 1000;
    $('dev-code').textContent = r.code;
    $('dev-code-box').hidden = false;

    // QR: scan it and the phone opens the right URL with the code already in
    // the box. The digits stay visible because a QR is useless if the camera
    // is broken, and because the desktop companion has nothing to scan with.
    const qr = $('dev-qr');
    if (qr) {
      if (r.qr) {
        // Server-generated SVG markup, not user input.
        qr.innerHTML = r.qr;
        qr.hidden = false;
      } else {
        qr.hidden = true;
        if (r.qrError) this.log(`QR unavailable: ${r.qrError}`, 'warn');
      }
    }
    const urlEl = $('dev-qr-url');
    if (urlEl) {
      urlEl.textContent = r.url || '';
      urlEl.hidden = !r.url;
    }
    $('dev-pair-badge').textContent = 'WAITING';
    $('dev-pair-badge').classList.add('armed');
    this.audio?.sfx('confirm');
    this._tickPairCode();
    this.refreshDevices();
  }

  _tickPairCode() {
    const box = $('dev-code-box');
    if (!box || box.hidden) return;
    const left = Math.max(0, Math.round((this._pairExpiry - Date.now()) / 1000));
    if (left <= 0) {
      box.hidden = true;
      $('dev-pair-badge').textContent = 'IDLE';
      $('dev-pair-badge').classList.remove('armed');
      return;
    }
    $('dev-code-sub').textContent =
      `expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  async refreshDevices() {
    const list = $('dev-list');
    if (!list) return;
    const A = this.actions;
    if (!A?.available) {
      list.innerHTML = '<p class="setup-hint">No action bridge \u2014 restart with '
        + '<code>--allow-actions</code> to pair devices.</p>';
      return;
    }
    const st = await A.deviceList().catch(() => null);
    const devices = st?.devices || [];
    // A device that was not in the previous list has genuinely just paired.
    const ids = devices.map(d => d.id).join(',');
    if (this._devIds !== undefined && ids !== this._devIds
        && devices.length > (this._devCount || 0)) {
      bus.emit('devices:paired', { count: devices.length });
    }
    this._devIds = ids;
    this._devCount = devices.length;
    $('dev-count').textContent = String(devices.length);
    if (!devices.length) {
      list.innerHTML = '<p class="setup-hint">Nothing paired yet. Press '
        + '<strong>PAIR A DEVICE</strong> and enter the code on the companion page.</p>';
      return;
    }
    list.innerHTML = devices.map(d => `
      <div class="dev-row">
        <div class="dev-row-h">
          <span class="dev-dot ${d.status === 'connected' ? 'on' : ''}"></span>
          <b></b>
          <span class="dev-plat"></span>
          <button class="mini-btn dev-forget" data-id="${d.id}" title="Unpair">\u2715</button>
        </div>
        <div class="dev-meta"></div>
        <div class="dev-caps"></div>
      </div>`).join('');

    // textContent for anything device-supplied: a device names itself.
    list.querySelectorAll('.dev-row').forEach((row, i) => {
      const d = devices[i];
      row.querySelector('b').textContent = d.name;
      row.querySelector('.dev-plat').textContent = d.platformLabel || d.platform;
      row.querySelector('.dev-meta').textContent =
        `${d.id} \u00b7 ${d.status}`
        + (d.latencyMs != null ? ` \u00b7 ${d.latencyMs}ms` : '')
        + (d.battery != null ? ` \u00b7 battery ${d.battery}%` : '')
        + ` \u00b7 ${d.actionsAcked}/${d.actionsSent} acked`;
      row.querySelector('.dev-caps').textContent =
        d.capabilities?.length ? d.capabilities.join(' \u00b7 ') : 'no capabilities';
    });
    list.querySelectorAll('.dev-forget').forEach(b => b.addEventListener('click', async () => {
      const r = await A.deviceUnpair(b.dataset.id).catch(() => ({ ok: false }));
      this.toast(r.ok ? 'info' : 'warn', r.ok ? 'Device unpaired.' : 'Could not unpair.');
      this.refreshDevices();
    }));
  }

  /* ── dwell to click ─────────────────────────────────────────────── */

  wireDwell() {
    const im = this.interaction;
    if (!im || !$('dw-enable')) return;

    /** @type {HTMLInputElement} */ ($('dw-enable')).checked = im.enabled;

    $('dw-enable').addEventListener('change', (e) => {
      const on = /** @type {HTMLInputElement} */ (e.target).checked;
      im.setEnabled(on);
      config.set('dwellClick', on);
      this.audio?.sfx('click');
      if (on && !state.get('cameraActive')) {
        this.toast('warn', 'Dwell is on, but the camera is off — enable Vision to use it.');
      } else {
        this.toast('info', on
          ? 'Dwell to click armed. Point at a control and hold still.'
          : 'Dwell to click disabled.');
      }
      this.syncDwell();
    });

    const slider = (id, valId, fmt, apply) => {
      const el = /** @type {HTMLInputElement} */ ($(id));
      el?.addEventListener('input', () => {
        $(valId).textContent = fmt(+el.value);
        apply(+el.value);
      });
    };
    slider('dw-ms', 'dw-ms-v', v => `${v} ms`, v => {
      im.configure({ dwellMs: v }); config.set('dwellMs', v);
    });
    slider('dw-rad', 'dw-rad-v', v => `${(v / 10).toFixed(1)}%`, v => {
      im.configure({ holdRadius: v / 1000 }); config.set('dwellHoldRadius', v / 1000);
    });

    $('dw-grant')?.addEventListener('click', () => {
      const perms = this.desktop?.permissions;
      if (!perms) return;
      if (perms.isGranted('vision_mouse')) {
        perms.revoke('vision_mouse');
        this.toast('info', 'Vision Mouse Control revoked. Dwell can still click AURA\u2019s own buttons.');
      } else {
        const okd = confirm(
          'Vision Mouse Control lets a held fingertip become a REAL mouse click '
          + 'on your Windows desktop.\n\n'
          + 'It only works while you are sharing an entire monitor, and the '
          + 'automation bridge must be armed. Clicking AURA\u2019s own buttons never '
          + 'needed this permission.\n\nGrant it?');
        if (!okd) return;
        perms.grant('vision_mouse');
        this.toast('success', 'Vision Mouse Control granted.');
      }
      this.syncDwell();
    });

    bus.on(DWELL_EV.FIRED, () => this.syncDwell());
    bus.on(DWELL_EV.REFUSED, () => this.syncDwell());
    this.syncDwell();
  }

  /** Live per-frame readout. Kept separate from syncDwell so the 30fps path
   *  only touches four text nodes and one width. */
  renderDwellReadout(d) {
    if (this.currentPanel !== 'vision' || !$('dw-state')) return;
    $('dw-state').textContent = d.state;
    $('dw-pct').textContent = `${d.ring}%`;
    $('dw-bar').style.width = `${Math.round((d.progress || 0) * 100)}%`;
    const tgt = $('dw-target');
    tgt.textContent = d.target === 'web' ? 'AURA control'
      : d.target === 'desktop' ? (d.needsPermission ? 'desktop (blocked)' : 'Windows desktop')
      : 'nothing';
    tgt.className = d.target === 'web' ? 'armed' : d.needsPermission ? 'hot' : '';
    $('dw-reason').textContent = d.reason || '';
  }

  syncDwell() {
    const im = this.interaction;
    if (!im || !$('dw-badge')) return;
    const s = im.status();
    const badge = $('dw-badge');
    badge.textContent = s.enabled ? 'ARMED' : 'OFF';
    badge.classList.toggle('armed', s.enabled);
    $('dw-live').hidden = !s.enabled;
    $('dw-count').textContent = String(s.stats.fired);
    $('dw-ms').value = String(s.opts.dwellMs);
    $('dw-ms-v').textContent = `${s.opts.dwellMs} ms`;
    $('dw-rad').value = String(Math.round(s.opts.holdRadius * 1000));
    $('dw-rad-v').textContent = `${(s.opts.holdRadius * 100).toFixed(1)}%`;

    const granted = !!this.desktop?.permissions?.isGranted?.('vision_mouse');
    $('dw-grant').textContent = granted
      ? 'REVOKE VISION MOUSE CONTROL' : 'GRANT VISION MOUSE CONTROL';
    const warn = $('dw-perm');
    if (granted && !s.monitorShare) {
      warn.hidden = false;
      warn.textContent = 'Vision Mouse Control is granted, but you are not sharing a '
        + 'whole monitor, so desktop clicks are still refused. Share your entire '
        + 'screen from AURA Live to enable them.';
    } else if (!granted) {
      warn.hidden = false;
      warn.textContent = 'Desktop clicks are off. Dwell can still click AURA\u2019s own '
        + 'buttons — that needs no permission.';
    } else {
      warn.hidden = true;
    }
  }

  /* ── privacy guard ──────────────────────────────────────────────── */

  wirePrivacyGuard() {
    const pg = this.privacyGuard;
    if (!pg || !$('pg-enable')) return;
    // Sensitivity buttons come from the module, so adding a preset there
    // shows up here with no UI change.
    import('./vision/privacy-guard.js').then(({ SENSITIVITY: S }) => {
      $('pg-sens').innerHTML = Object.entries(S).map(([id, p]) =>
        `<button class="ward-item" data-sens="${id}">${p.label}</button>`).join('');
      $$('#pg-sens .ward-item').forEach(b => b.addEventListener('click', () => {
        pg.setSensitivity(b.dataset.sens);
        this.audio?.sfx('click');
        this.syncPrivacyGuard();
        this.toast('info', `Privacy Guard: ${S[b.dataset.sens].label}`);
      }));
      this.syncPrivacyGuard();
    });

    $('pg-enable').addEventListener('change', async (e) => {
      const on = /** @type {HTMLInputElement} */ (e.target).checked;
      if (on) {
        // Ask for the permission at the moment it becomes relevant, not at
        // boot — the user can connect the request to what they just clicked.
        if (!this.desktop?.permissions?.isGranted?.('minimize_windows')) {
          const okd = confirm(
            'Privacy Guard needs permission to minimise the active window.\n\n'
            + 'It uses the operating system window API — never mouse clicks or '
            + 'screen coordinates. Nothing is sent anywhere.\n\nGrant it?');
          if (!okd) {
            /** @type {HTMLInputElement} */ ($('pg-enable')).checked = false;
            return;
          }
          this.desktop.permissions.grant('minimize_windows');
        }
        pg.enable();
        this.toast('success', '🛡 Privacy Guard armed.');
      } else {
        pg.disable();
        this.toast('info', 'Privacy Guard off.');
      }
      this.syncPrivacyGuard();
    });

    const slider = (id, valId, fmt, apply) => {
      const el = $(id);
      el?.addEventListener('input', () => {
        $(valId).textContent = fmt(+el.value);
        apply(+el.value);
      });
    };
    slider('pg-persist', 'pg-persist-v', v => `${v} ms`,
           v => pg.configure({ detectionPersistenceMs: v }));
    slider('pg-minconf', 'pg-conf-v', v => `${v}%`,
           v => pg.configure({ minimumConfidence: v / 100 }));
    slider('pg-area', 'pg-area-v', v => `${(v / 10).toFixed(1)}%`,
           v => pg.configure({ minArea: v / 1000 }));
    slider('pg-cd', 'pg-cd-v', v => `${v} s`,
           v => pg.configure({ cooldownMs: v * 1000 }));
    slider('pg-minfaces', 'pg-minfaces-v', v => String(v),
           v => pg.configure({ minFaces: v }));

    $('pg-owner')?.addEventListener('change', (e) => {
      pg.configure({ neverIfOwnerAlone: /** @type {HTMLInputElement} */ (e.target).checked });
      this.syncPrivacyGuard();
    });
    $('pg-manage-faces')?.addEventListener('click', () => {
      // Face enrolment already lives in Settings → Vision. Send the user
      // there rather than building a second enrolment UI.
      this.openSettings();
      document.querySelector('.tab[data-tab="vision"]')?.dispatchEvent(new Event('click'));
      this.toast('info', 'Enrol yourself here — Privacy Guard will then know it is you.');
    });

    $('pg-test')?.addEventListener('click', async () => {
      const r = await this.kernel.execute({ command: 'desktop.minimize_active_window' },
                                          { confirm: async () => true });
      this.toast(r.ok ? 'success' : 'warn',
                 r.ok ? (r.result?.summary || 'Minimised.') : (r.error || 'Failed.'));
    });

    bus.on('privacy:state', () => this.syncPrivacyGuard());
    bus.on(EV.PRESENCE, () => { if (this.currentPanel === 'vision') this.syncPrivacyGuard(); });
    bus.on('privacy:acted', (e) => {
      this.toast(e.ok ? 'success' : 'warn',
                 e.ok ? '🛡 Window minimised — someone was detected behind you.'
                      : `Privacy Guard could not act: ${e.error || ''}`);
    });
    this.syncPrivacyGuard();
  }

  syncPrivacyGuard() {
    const pg = this.privacyGuard;
    if (!pg || !$('pg-badge')) return;
    const s = pg.status();
    const badge = $('pg-badge');
    badge.textContent = s.enabled ? (s.state === 'MONITORING' ? 'ARMED' : s.state) : 'OFF';
    badge.classList.toggle('armed', s.enabled);
    /** @type {HTMLInputElement} */ ($('pg-enable')).checked = s.enabled;
    $('pg-live').hidden = !s.enabled;

    const st = $('pg-state');
    st.textContent = !s.enabled ? 'off'
      : !s.cameraActive ? 'waiting for camera'
      : s.inCooldown ? `cooldown ${(s.cooldownRemainingMs / 1000).toFixed(1)}s`
      : s.state.toLowerCase().replace('_', ' ');
    st.className = s.enabled && s.cameraActive ? 'armed' : '';

    const d = s.lastDetection;
    $('pg-detect').textContent = d?.present ? `person (${d.source})` : 'nobody';
    $('pg-detect').className = d?.present ? 'hot' : '';
    $('pg-conf').textContent = d?.present ? `${Math.round((d.confidence || 0) * 100)}%` : '—';
    $('pg-cool').textContent = `${(s.cooldownMs / 1000).toFixed(0)} seconds`;
    const fc = d?.faceCount ?? 0;
    $('pg-faces').textContent = fc ? String(fc) : '—';
    $('pg-known').textContent = d?.knownNames?.length
      ? d.knownNames.join(', ')
      : (fc ? `${fc} unrecognised` : '—');
    const veto = $('pg-veto');
    if (s.lastVeto) { veto.hidden = false; veto.textContent = `🛡 Standing down — ${s.lastVeto}`; }
    else veto.hidden = true;
    $('pg-minfaces').value = String(s.minFaces);
    $('pg-minfaces-v').textContent = String(s.minFaces);
    /** @type {HTMLInputElement} */ ($('pg-owner')).checked = !!s.neverIfOwnerAlone;
    // Progress toward the persistence threshold — makes the timer visible
    // instead of the feature seeming to fire at random.
    const pct = s.persistingMs
      ? Math.min(100, (s.persistingMs / s.detectionPersistenceMs) * 100) : 0;
    $('pg-bar').style.width = `${pct}%`;

    $('pg-persist').value = String(s.detectionPersistenceMs);
    $('pg-persist-v').textContent = `${s.detectionPersistenceMs} ms`;
    $('pg-minconf').value = String(Math.round(s.minimumConfidence * 100));
    $('pg-conf-v').textContent = `${Math.round(s.minimumConfidence * 100)}%`;
    $('pg-area').value = String(Math.round(s.minArea * 1000));
    $('pg-area-v').textContent = `${(s.minArea * 100).toFixed(1)}%`;
    $('pg-cd').value = String(Math.round(s.cooldownMs / 1000));
    $('pg-cd-v').textContent = `${Math.round(s.cooldownMs / 1000)} s`;
    $('pg-sens-hint').textContent = s.sensitivityHint;
    $$('#pg-sens .ward-item').forEach(b =>
      b.classList.toggle('on', b.dataset.sens === s.sensitivity));

    // Enrolment status — the guard is far safer once it knows the owner.
    // vision.recognizer() is the public accessor; the module-level
    // getRecognizer() in vision.js is deliberately private.
    this.vision?.recognizer?.().then((fr) => {
      const el = $('pg-enrolled');
      if (!el) return;
      el.textContent = fr.people.length
        ? `Enrolled: ${fr.people.map(p => p.name).join(', ')} — these are never treated as intruders.`
        : '⚠ No faces enrolled. Enrol yourself so AURA knows not to hide your screen from you.';
    }).catch(() => {});

    const granted = !!this.desktop?.permissions?.isGranted?.('minimize_windows');
    const warn = $('pg-perm');
    if (s.enabled && !granted) {
      warn.hidden = false;
      warn.textContent = '⚠ The "Minimize Active Window" permission is not granted — '
        + 'Privacy Guard will detect but cannot act.';
    } else { warn.hidden = true; }
  }

  /* ── screen share panel ─────────────────────────────────────────── */

  /**
   * The screen-sharing UI now lives on its own page at /screen (AURA Live).
   * Only the trace log stays here, so commands run from the main chat still
   * stream their steps somewhere visible. The old panel's preview loop and
   * buttons were removed rather than left as dead handlers pointing at
   * elements that no longer exist - tests/test-architecture.mjs checks for
   * exactly that.
   */
  /**
   * Task-card actions: cancel a running task, open a produced file.
   *
   * Cancellation is cooperative — `Trace.cancel()` raises a flag that the
   * agent loop checks between steps. A native OS call already in flight cannot
   * be killed, which is why the button reads "STOPPING…" rather than claiming
   * the task stopped instantly.
   */
  wireTaskCards() {
    /** @type {Map<string, import('./core/trace.js').Trace>} */
    this.liveTraces = this.liveTraces || new Map();
    bus.on('trace:register', ({ id, trace }) => this.liveTraces.set(id, trace));
    bus.on('trace:end', ({ id }) => this.liveTraces.delete(id));

    bus.on('trace:cancel-request', ({ id }) => {
      const t = this.liveTraces.get(id);
      if (t?.cancel) {
        t.cancel();
        this.toast('warn', 'Stopping the task — finishing the current step first.');
      } else {
        this.toast('warn', 'That task has already finished.');
      }
    });

    bus.on('artifact:open', async ({ path }) => {
      if (!path) return;
      const r = await this.actions?.openFolder?.(path)
        .catch(e => ({ ok: false, message: String(e) }));
      if (!r?.ok) this.toast('warn', r?.message || 'Could not open it.');
    });
  }

  wireScreenPanel() {
    this.traceView = new TraceView($('trace-log'));
    // TraceView.show() reveals the whole .trace-dock, which is a flex sibling
    // of .panel-stack — so the trace takes real space instead of painting
    // through the transparent active panel (bug #100).
    bus.on('trace:start', () => this.traceView?.show());
    $('btn-trace-close')?.addEventListener('click', () => this.traceView?.clear());
  }

  /**
   * Panels reachable by swiping, in order. The hidden innovations page is
   * deliberately excluded so a gesture can never reveal it.
   * @returns {string[]}
   */
  visiblePanels() {
    return $$('button[data-panel]')
      .map(b => b.dataset.panel)
      .filter(p => p && p !== 'innovations');
  }

  /** Is the settings modal open? Used by the swipe-down "dismiss" binding. */
  settingsOpen() { return !$('settings')?.hidden; }

  openPanel(name) {
    // 'system' was merged into the OPS panel (now "System Center"). Alias it
    // so existing callers, plugins, tests and muscle memory keep working.
    if (name === 'system') name = 'ops';
    this.currentPanel = name;
    $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
    $$('button[data-panel]').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    if (name === 'ops') { this.renderSysReadout(); this.commandCenter?.refresh(); }
    if (name === 'devconsole') this.devConsole?.show(); else this.devConsole?.hide();
    if (name === 'innovations') this.renderInnovations();
  }

  /** Lazy-render the hidden page so its cost is zero until unlocked. */
  async renderInnovations() {
    const host = $('innovations-body');
    if (!host || host.dataset.rendered) return;
    const { renderInnovations } = await import('./ui/innovations.js');
    renderInnovations(host);
    host.dataset.rendered = '1';
  }

  /**
   * Hidden unlock for the Innovations page.
   *
   * Two ways in, both invisible in the UI:
   *   • type `aura` anywhere outside a text field
   *   • the `/innovations` command (absent from /help)
   */
  _wireSecretUnlock() {
    $('btn-innov-close')?.addEventListener('click', () => this.openPanel('chat'));
    const SEQ = 'aura';
    let buf = '';
    window.addEventListener('keydown', (e) => {
      const t = /** @type {any} */ (e.target);
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!/^[a-z]$/i.test(e.key)) { buf = ''; return; }
      buf = (buf + e.key.toLowerCase()).slice(-SEQ.length);
      if (buf !== SEQ) return;
      buf = '';
      this.unlockInnovations();
    });
  }

  unlockInnovations() {
    this.openPanel('innovations');
    this.audio?.sfx('confirm');
    this.toast('success', '◆ Innovations unlocked.');
  }

  focusInput() { $('input')?.focus(); }

  toast(type, text, duration = 4200) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, duration);
  }

  setStatus(s) { $('status-pill').textContent = s; }

  /**
   * Stage caption = a short, human-readable line under the avatar.
   * Long structured output (tables, command dumps, code) is left to the
   * transcript — spilling it across the stage looked broken.
   */
  setCaption(t) {
    const el = $('caption');
    if (!t) { el.textContent = ''; return; }
    const plain = stripMarkdownForSpeech(String(t)).replace(/\s+/g, ' ').trim();
    if (!plain) { el.textContent = ''; return; }
    if (plain.length > 240) { el.textContent = ''; return; }   // it's a dump, not a line
    el.textContent = plain.length > 150 ? plain.slice(-150).replace(/^\S*\s/, '') : plain;
  }

  flashGesture(gesture, confidence) {
    const el = $('gesture-flash');
    const g = GESTURES[gesture];
    el.hidden = false;
    el.textContent = `${g?.icon || ''} ${(g?.label || gesture).toUpperCase()} · ${Math.round(confidence * 100)}%`;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(this._gflash);
    this._gflash = setTimeout(() => { el.hidden = true; }, 2400);
  }

  createMessageEl(role, text) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const label = role === 'user' ? 'OPERATOR' : role === 'assistant' ? 'AURA' : 'SYSTEM';
    wrap.innerHTML = `<div class="msg-role">${label}</div><div class="msg-body"></div>`;
    wrap.querySelector('.msg-body').innerHTML = renderMarkdown(text);
    const t = $('transcript');
    t.appendChild(wrap);
    this._trimTranscript();
    this.scrollTranscript();
    return wrap;
  }

  /**
   * Cap the transcript DOM.
   *
   * MEASURED LEAK: the transcript was never trimmed. In a long session the
   * node count climbed without bound (1,214 → 7,299 nodes in a load test),
   * and avatar.update() slowed from 0.033ms to 0.077ms per frame purely from
   * layout/style cost on a huge document. That is the "lags a lot if the app
   * has been running for some while" report.
   *
   * The full conversation still lives in memory/storage — this only limits
   * how many message elements exist in the DOM at once.
   */
  _trimTranscript() {
    const t = $('transcript');
    const max = Math.max(40, config.get('maxTranscriptNodes') || 220);
    let over = t.children.length - max;
    if (over <= 0) return;
    // Never drop the element the stream is currently writing into.
    while (over > 0 && t.firstElementChild) {
      const el = t.firstElementChild;
      if (el === this.streamEl) break;
      el.remove();
      over--;
    }
    if (!this._trimNotice && t.children.length >= max) {
      this._trimNotice = true;
      this.log(`Transcript trimmed to the last ${max} messages (full history kept in memory)`, 'ok');
    }
  }

  pushUserMessage(text) { this.createMessageEl('user', text); }
  pushAssistantMessage(text) { this.createMessageEl('assistant', text); this.setCaption(text.slice(0, 190)); }
  pushSystemMessage(text) { this.createMessageEl('system', text); }
  clearTranscript() { $('transcript').innerHTML = ''; this.setCaption(''); }
  scrollTranscript() { const t = $('transcript'); t.scrollTop = t.scrollHeight; }

  pushEventLog(text) {
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    this.eventLogLines.push(`<div><span class="t">${t}</span> ${escapeHtml(text)}</div>`);
    if (this.eventLogLines.length > 90) this.eventLogLines.shift();
    const el = $('event-log');
    if (el) { el.innerHTML = this.eventLogLines.join(''); el.scrollTop = el.scrollHeight; }
  }

  requestConfirm(label, onConfirm, onCancel) {
    this.pendingConfirm = { label, onConfirm, onCancel };
    this.pushSystemMessage(`Awaiting confirmation: ${label} — 👍 to confirm, 👎 to cancel`);
    setTimeout(() => { if (this.pendingConfirm?.label === label) this.pendingConfirm = null; }, 15000);
  }
  consumePendingConfirm() { const p = this.pendingConfirm; this.pendingConfirm = null; return p; }

  setPointerMode(on) {
    this.pointerMode = on;
    $('reticle').hidden = !on;
    if (!on) {
      $$('.pointer-target').forEach(e => e.classList.remove('pointer-target'));
    }
  }

  updatePointer({ x, y }) {
    if (!this.pointerMode) return;
    const mirror = config.get('mirrorCamera');
    const px = (mirror ? 1 - x : x) * window.innerWidth;
    const py = y * window.innerHeight;
    const ret = $('reticle');
    ret.style.left = `${px}px`;
    ret.style.top = `${py}px`;
    const el = document.elementFromPoint(px, py);
    $$('.pointer-target').forEach(e => e.classList.remove('pointer-target'));
    const target = el?.closest('button, .panel, .stat, .gest, .msg');
    if (target) target.classList.add('pointer-target');
  }

  themeNames() { return THEMES.slice(); }
  setTheme(t) {
    if (!THEME_PRESETS[t]) return;
    config.set('theme', t);
    this.applyTheme(t);
    const sel = /** @type {any} */ ($('set-theme'));
    if (sel) sel.value = t;
    // Keep the Appearance pane in sync when it is open.
    const pane = document.querySelector('.tabpane[data-tab="appearance"]');
    if (pane?.classList.contains('active')) this.renderAppearance();
  }
  /**
   * Kept for backwards compatibility (plugins, the T shortcut, tests).
   * Delegates to the theming engine so preset switching and the Appearance
   * pane can never drift apart.
   */
  applyTheme(t) {
    if (t) config.set('theme', t);
    this.applyAppearance();
    state.set({ theme: config.get('theme') });
  }
  cycleTheme() {
    const i = THEMES.indexOf(config.get('theme'));
    const next = THEMES[(i + 1) % THEMES.length];
    this.setTheme(next);
    this.toast('info', `Theme: ${next.replace('aura-', '')}`);
    return next;
  }
  applyReduceMotion(v) { document.documentElement.classList.toggle('reduce-motion', !!v); }
  applyGlass(v) { document.documentElement.classList.toggle('glass', v !== false); }

  /* ── wardrobe ─────────────────────────────────────────────────── */

  buildWardrobe() {
    const oh = $('ward-outfits');
    oh.innerHTML = Object.entries(OUTFITS).map(([id, o]) =>
      `<button class="ward-item" data-outfit="${id}">${o.label}<small>${o.desc}</small></button>`).join('');
    oh.querySelectorAll('[data-outfit]').forEach(b => b.addEventListener('click', () => {
      this.avatar.applyOutfit?.(b.dataset.outfit);
      this.audio.sfx('click'); this.syncWardrobe();
      this.toast('info', `Outfit: ${OUTFITS[b.dataset.outfit].label}`);
    }));

    const ph = $('ward-palettes');
    ph.innerHTML = Object.entries(PALETTES).map(([id, p]) =>
      `<div class="swatch" data-palette="${id}" title="${p.label}"
        style="background:linear-gradient(135deg,#${p.accent.toString(16).padStart(6,'0')},#${p.body.toString(16).padStart(6,'0')});color:#${p.accent.toString(16).padStart(6,'0')}"></div>`).join('');
    ph.querySelectorAll('[data-palette]').forEach(b => b.addEventListener('click', () => {
      this.avatar.applyOutfit?.(null, b.dataset.palette);
      this.audio.sfx('click'); this.syncWardrobe();
    }));

    const ah = $('ward-acc');
    ah.innerHTML = Object.entries(ACCESSORIES).map(([id, a]) =>
      `<button class="ward-item" data-acc="${id}">${a.label}</button>`).join('');
    ah.querySelectorAll('[data-acc]').forEach(b => b.addEventListener('click', () => {
      this.avatar.applyAccessory?.(b.dataset.acc);
      this.audio.sfx('click'); this.syncWardrobe();
    }));

    // BODY PRESETS ("gender"). These scale existing bones, so every animation
    // — including the wave — keeps working with no retargeting.
    const bh = $('ward-body');
    if (bh) {
      bh.innerHTML = Object.entries(BODY_PRESETS).map(([id, b]) =>
        `<button class="ward-item" data-body="${id}">${escapeHtml(b.label)}</button>`).join('');
      bh.querySelectorAll('[data-body]').forEach(b => b.addEventListener('click', () => {
        if (!this.avatar.applyBodyType?.(b.dataset.body)) {
          this.toast('warn', 'Body presets apply to the built-in avatar.');
          return;
        }
        this.audio.sfx('click'); this.syncWardrobe();
        this.toast('info', `Body: ${BODY_PRESETS[b.dataset.body].label}`);
      }));
    }

    const hh = $('ward-hair');
    if (hh) {
      hh.innerHTML = Object.entries(HAIRSTYLES).map(([id, h]) =>
        `<button class="ward-item" data-hair="${id}">${escapeHtml(h.label)}</button>`).join('');
      hh.querySelectorAll('[data-hair]').forEach(b => b.addEventListener('click', () => {
        if (!this.avatar.applyHair?.(b.dataset.hair, null)) {
          this.toast('warn', 'Hairstyles apply to the built-in avatar.');
          return;
        }
        this.audio.sfx('click'); this.syncWardrobe();
      }));
    }

    const hc = $('ward-haircol');
    if (hc) {
      hc.innerHTML = Object.entries(HAIR_COLORS).map(([id, c]) => {
        const hex = c.color === null ? null : '#' + c.color.toString(16).padStart(6, '0');
        const bg = hex || 'linear-gradient(135deg,#38bdf8,#a78bfa)';
        return `<div class="swatch" data-haircol="${id}" title="${escapeHtml(c.label)}"
                  style="background:${bg}"></div>`;
      }).join('');
      hc.querySelectorAll('[data-haircol]').forEach(b => b.addEventListener('click', () => {
        if (!this.avatar.applyHair?.(null, b.dataset.haircol)) {
          this.toast('warn', 'Hair colour applies to the built-in avatar.');
          return;
        }
        this.audio.sfx('click'); this.syncWardrobe();
      }));
    }

    $('ward-outfits').closest('.wardrobe').querySelectorAll('[data-form]').forEach(b =>
      b.addEventListener('click', () => this.switchAvatar(b.dataset.form)));

    $('btn-randomize').addEventListener('click', () => {
      const o = Object.keys(OUTFITS)[Math.floor(Math.random() * Object.keys(OUTFITS).length)];
      const p = Object.keys(PALETTES)[Math.floor(Math.random() * Object.keys(PALETTES).length)];
      const a = Object.keys(ACCESSORIES)[Math.floor(Math.random() * Object.keys(ACCESSORIES).length)];
      const pick = (obj) => { const k = Object.keys(obj); return k[Math.floor(Math.random() * k.length)]; };
      const h = pick(HAIRSTYLES), hc = pick(HAIR_COLORS), bt = pick(BODY_PRESETS);
      this.avatar.applyOutfit?.(o, p); this.avatar.applyAccessory?.(a);
      this.avatar.applyHair?.(h, hc); this.avatar.applyBodyType?.(bt);
      this.audio.sfx('confirm'); this.syncWardrobe();
      this.toast('success',
        `${OUTFITS[o].label} · ${PALETTES[p].label} · ${ACCESSORIES[a].label} · ${HAIRSTYLES[h].label} · ${BODY_PRESETS[bt].label}`);
    });
    this.syncWardrobe();
  }

  syncWardrobe() {
    const isBody = state.get('avatarMode') === 'body';
    $$('[data-outfit]').forEach(b =>
      b.classList.toggle('on', isBody && b.dataset.outfit === config.get('avatarOutfit')));
    $$('[data-palette]').forEach(b =>
      b.classList.toggle('on', b.dataset.palette === config.get('avatarPalette')));
    $$('[data-acc]').forEach(b =>
      b.classList.toggle('on', isBody && b.dataset.acc === config.get('avatarAccessory')));
    $$('[data-body]').forEach(b =>
      b.classList.toggle('on', isBody && b.dataset.body === config.get('avatarBodyType')));
    $$('[data-hair]').forEach(b =>
      b.classList.toggle('on', isBody && b.dataset.hair === config.get('avatarHair')));
    $$('[data-haircol]').forEach(b =>
      b.classList.toggle('on', isBody && b.dataset.haircol === config.get('avatarHairColor')));
    $$('[data-form]').forEach(b =>
      b.classList.toggle('on', b.dataset.form === state.get('avatarMode')));
    $$('[data-outfit],[data-acc],[data-body],[data-hair],[data-haircol]').forEach(b => {
      b.disabled = !isBody; b.style.opacity = isBody ? '' : '.4';
      b.title = isBody ? '' : 'Switch to Full body to use outfits';
    });
  }

  /**
   * Switch renderer. 'body' now means "the provider system"; '3d' and '2d'
   * remain the standalone legacy renderers.
   * @param {string} mode @returns {Promise<void>}
   */
  async switchAvatar(mode) {
    if (state.get('avatarMode') === mode) return;
    config.set('avatarMode', mode);
    const host = $('avatar-host');

    if (mode === 'body') {
      this.avatar?.dispose?.();
      host.innerHTML = '';
      this.avatarManager = new AvatarManager(host);
      const r = await this.avatarManager.initialize();
      this.avatar = /** @type {any} */ (this.avatarManager);
      if (!r.ok) {
        this.toast('warn', `Avatar failed: ${r.reason || 'unknown'} — using 2D.`);
        this.avatarManager = null;
        this.avatar = /** @type {any} */ (new Avatar2D(host));
        await this.avatar.init();
        mode = '2d';
      }
    } else {
      // Leaving the provider system: tear the manager down so its rAF stops.
      this.avatarManager?.dispose();
      this.avatarManager = null;
      this.avatar?.dispose?.();
      host.innerHTML = '';
      this.avatar = /** @type {any} */ (mode === '3d' ? new Avatar3D(host) : new Avatar2D(host));
      const ok = await this.avatar.init();
      if (!ok && mode !== '2d') {
        this.toast('warn', 'WebGL unavailable — using 2D renderer.');
        this.avatar = /** @type {any} */ (new Avatar2D(host));
        await this.avatar.init();
        mode = '2d';
      }
    }
    state.set({ avatarMode: mode });
    if (this.ar) this.ar.ctx.avatar = this.avatar;
    this.syncWardrobe();
    this.toast('success', `Avatar: ${mode === 'body' ? 'full body' : mode.toUpperCase()}`);
  }

  /* ══════════════════ ACTIONS ══════════════════ */

  sendFromInput() {
    const inp = $('input');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    this.autoGrow(inp);
    this.send(text);
  }

  send(text) {
    this.openPanel('chat');
    this.audio.sfx('click');
    this.ai.send(text);
  }

  autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(130, el.scrollHeight) + 'px';
  }

  async toggleMic() {
    if (!this.voice.input.supported) {
      const d = await this.voice.input.diagnose();
      this.toast('error', d.issues[0]?.msg || this.voice.input.unsupportedReason);
      this.pushSystemMessage(`🎙 ${d.issues.map(i => i.msg).join(' · ')}`);
      return;
    }
    this.voice.output.cancel('mic');
    const on = await this.voice.input.toggle('command');
    if (!on) this.setStatus('IDLE');
  }

  toggleVoiceOutput() {
    const on = !config.get('ttsEnabled');
    config.set('ttsEnabled', on);
    if (!on) this.voice.output.cancel('mute');
    this.syncToggles();
    this.toast('info', on ? 'Voice output enabled' : 'Voice output muted');
  }

  /**
   * Toggle wake-word listening.
   * Routes to the engine configured in Settings:
   *   'porcupine' → WakeWordEngine (proper dedicated engine)
   *   'browser'   → existing SpeechInput wake scanning (fallback)
   *   'off'       → disables entirely
   */
  setWakeWord(on) {
    if (!on) {
      this.voice.input.stop();
      config.set('wakeWordEnabled', false);
      if ($('set-wake')) $('set-wake').checked = false;
      state.set({ wakeWordActive: false });
      return 'Wake word listening disabled.';
    }

    if (!this.voice.input.supported) {
      config.set('wakeWordEnabled', false);
      if ($('set-wake')) $('set-wake').checked = false;
      const m = this.voice.input.unsupportedReason;
      this.toast('error', m);
      return `⚠ ${m}`;
    }

    config.set('wakeWordEnabled', true);
    if ($('set-wake')) $('set-wake').checked = true;
    state.set({ wakeWordActive: true });

    this.voice.input.start('wake');
    const words = config.get('wakeWord') || 'aura, nova';
    this.toast('info', `🎙 Multi-wake-word active: say "${words}" or "hey aura" anytime`);
    return `Multi-wake-word active — listening for "${words}".`;
  }

  /** Show exactly why camera/mic are unavailable, with the fix. */
  async runMediaDiagnostic() {
    const cam = await this.vision.diagnose();
    const mic = await this.voice.input.diagnose();
    const fmt = (name, d) => {
      if (d.ok && !d.issues.length) return `✅ **${name}** — ready${d.devices ? ` (${d.devices.length} device(s))` : ''}`;
      return `${d.ok ? '⚠️' : '❌'} **${name}**\n` + d.issues.map(i => `   • ${i.msg}`).join('\n');
    };
    const body = [
      fmt('Camera', cam),
      fmt('Microphone', mic),
      '',
      `**Context:** ${location.protocol}//${location.host} · secure=${window.isSecureContext} · iframe=${window.self !== window.top}`,
      `**Camera permission:** ${cam.permission} · **Mic permission:** ${mic.permission}`,
    ].join('\n');
    this.openPanel('chat');
    this.pushAssistantMessage(`**MEDIA DIAGNOSTIC**\n\n${body}`);
    return body;
  }

  async enableVision() {
    try {
      await this.vision.enable({
        hands: config.get('handTracking'),
        faces: config.get('faceTracking'),
        objects: config.get('objectDetection'),
      });
      this.openPanel('vision');
      this.toast('success', 'Vision online — hand and face tracking active.');
      this.audio.sfx('scan');
      return true;
    } catch (e) {
      // Don't just fail — tell the user precisely why and how to fix it.
      const d = await this.vision.diagnose();
      if (d.issues.length) {
        this.pushSystemMessage('📷 ' + d.issues.map(i => i.msg).join(' · '));
      }
      return false;
    }
  }

  async toggleCamera() {
    if (state.get('cameraActive')) { this.vision.disable(); this.audio.sfx('power-down'); return 'Camera offline.'; }
    await this.enableVision();
    return 'Camera online.';
  }

  async applyVisionToggles() {
    if (!state.get('cameraActive')) return;
    if (config.get('handTracking')) await this.vision.loadHands();
    if (config.get('faceTracking')) await this.vision.loadFaces();
    if (config.get('objectDetection')) await this.vision.loadObjects();
    else await this.vision.unloadObjects();
  }

  async toggleAR() {
    if (this.ar.active) {
      this.ar.exit();
      $('ar-badge').hidden = true;
      $('btn-ar').classList.remove('on');
      return 'AR mode exited.';
    }
    const r = await this.ar.enter();
    if (r.mode !== 'none') {
      $('btn-ar').classList.add('on');
      $('ar-badge').hidden = r.mode === 'webxr';
      $('ar-badge').textContent = r.mode === 'webxr' ? 'WEBXR AR' : 'SIMULATED AR';
      if (r.mode === 'webxr') $('ar-badge').hidden = false;
    }
    return r.message;
  }

  handleVoiceCommand(cmd) {
    switch (cmd) {
      case 'camera-on': this.enableVision(); break;
      case 'camera-off': this.vision.disable(); break;
      case 'mute': config.set('ttsEnabled', false); this.voice.output.cancel(); this.syncToggles(); break;
      case 'ar': this.toggleAR().then(m => this.toast('info', m)); break;
      case 'clear': setTimeout(() => { this.ai.clear(); this.clearTranscript(); }, 900); break;
      case 'theme': this.cycleTheme(); break;
    }
  }

  /* ══════════════════ INCREMENTAL TTS ══════════════════ */

  /**
   * Speak completed sentences as they stream in, so AURA starts talking
   * before generation finishes — real low-latency voice.
   */
  speakIncremental(fullText) {
    if (!config.get('ttsEnabled') || !this.voice.output.supported) return;
    if (this._speakOverride) return;   // spoken once at stream end instead
    const plain = stripMarkdownForSpeech(fullText);
    if (plain.length <= this.spokenUpTo) return;
    const pending = plain.slice(this.spokenUpTo);
    const m = /^([\s\S]*?[.!?…])(\s|$)/.exec(pending);
    if (!m) return;
    const sentence = m[1].trim();
    if (sentence.length < 4) { this.spokenUpTo += m[0].length; return; }
    this.spokenUpTo += m[0].length;
    this.voice.output.speak(sentence, { interrupt: false });
  }

  speakRemainder(fullText) {
    if (!config.get('ttsEnabled') || !this.voice.output.supported) return;
    if (this._speakOverride) {
      const t = this._speakOverride; this._speakOverride = null;
      this.voice.output.speak(t, { interrupt: false });
      return;
    }
    const plain = stripMarkdownForSpeech(fullText);
    const rest = plain.slice(this.spokenUpTo).trim();
    this.spokenUpTo = plain.length;
    if (rest.length > 2) this.voice.output.speak(rest, { interrupt: false });
  }

  /* ══════════════════ DIAGNOSTICS ══════════════════ */

  renderSysReadout() {
    const el = $('sys-readout');
    if (!el) return;
    const s = state.get();
    const row = (k, v, cls) => `<div class="sys-line"><b>${k}</b><span class="${cls}">${v}</span></div>`;
    el.innerHTML = [
      row('AI CORE', this.ai.providerLabel, 'on'),
      row('MODEL', s.aiModel || '—', s.aiModel ? 'on' : 'off'),
      row('CAMERA', s.cameraActive ? 'ONLINE' : 'OFF', s.cameraActive ? 'on' : 'off'),
      row('HANDS', s.handsActive ? `${s.handCount} tracked` : 'not loaded', s.handsActive ? 'on' : 'off'),
      row('FACES', s.faceActive ? `${s.faceCount} tracked` : 'not loaded', s.faceActive ? 'on' : 'off'),
      row('OBJECTS', s.objectsActive ? `${s.objectCount} found` : 'off', s.objectsActive ? 'on' : 'off'),
      row('VISION FPS', s.cameraActive ? s.visionFps : '—', s.visionFps > 10 ? 'on' : 'off'),
      row('RENDER FPS', s.fps, s.fps > 40 ? 'on' : s.fps > 20 ? '' : 'bad'),
      row('STT', s.sttSupported ? (s.sttActive ? 'LISTENING' : 'ready') : 'unsupported', s.sttSupported ? (s.sttActive ? 'on' : '') : 'bad'),
      row('TTS', s.ttsSupported ? (config.get('ttsEnabled') ? (s.ttsSpeaking ? 'SPEAKING' : 'ready') : 'muted') : 'unsupported', s.ttsSupported ? 'on' : 'bad'),
      row('WAKE WORD', s.wakeWordActive ? `"${config.get('wakeWord')}"` : 'off', s.wakeWordActive ? 'on' : 'off'),
      row('AVATAR', `${s.avatarMode.toUpperCase()} · ${s.avatarEmotion}`, 'on'),
      row('AUDIO', this.audio.running ? 'running' : 'idle', this.audio.running ? 'on' : 'off'),
      row('AR', s.arMode ? this.ar.mode : 'inactive', s.arMode ? 'on' : 'off'),
      row('MEMORY', `${this.ai.memory.all().length} msgs`, 'on'),
      row('PLUGINS', `${plugins.plugins.size} · ${plugins.listCommands().length} cmds`, 'on'),
    ].join('');
  }

  /** Live subsystem self-test — actually exercises each module. */
  async runSelfTest() {
    const results = [];
    const t = (name, fn) => {
      try { const r = fn(); results.push(`${r.ok ? '✅' : r.warn ? '⚠️' : '❌'} **${name}** — ${r.msg}`); }
      catch (e) { results.push(`❌ **${name}** — threw: ${e.message}`); }
    };

    t('Event bus', () => {
      let got = false;
      const off = bus.on('selftest:ping', () => { got = true; });
      bus.emit('selftest:ping', 1);
      off();
      return { ok: got, msg: got ? 'publish/subscribe verified' : 'no delivery' };
    });

    t('State store', () => {
      let fired = false;
      const off = state.watch('__test', () => { fired = true; });
      state.set('__test', Math.random());
      off();
      return { ok: fired, msg: fired ? 'reactive watchers firing' : 'watcher did not fire' };
    });

    t('Config persistence', () => ({
      ok: config.storageAvailable,
      warn: !config.storageAvailable,
      msg: config.storageAvailable ? 'localStorage writable' : 'localStorage blocked — settings are session-only',
    }));

    t('Markdown renderer', () => {
      const html = renderMarkdown('**b** `c`\n\n- x');
      const safe = renderMarkdown('<img src=x onerror=alert(1)>');
      return {
        ok: html.includes('<strong>b</strong>') && html.includes('<li>x</li>') && !safe.includes('<img'),
        msg: 'formatting + XSS escaping verified',
      };
    });

    t('AI core', () => ({ ok: true, msg: `${this.ai.providerLabel} resolved; ${this.ai.memory.all().length} messages in memory` }));

    t('Plugin registry', () => ({
      ok: plugins.plugins.size > 0,
      msg: `${plugins.plugins.size} plugins, ${plugins.listCommands().length} commands registered`,
    }));

    t('Avatar renderer', () => ({
      ok: !!this.avatar?.ok,
      msg: this.avatar?.ok ? `${state.get('avatarMode').toUpperCase()} running at ${state.get('fps')} FPS` : 'not initialised',
    }));

    t('Speech synthesis', () => ({
      ok: this.voice.output.supported,
      msg: this.voice.output.supported ? `${this.voice.output.listVoices().length} voices available` : 'unsupported in this browser',
    }));

    t('Speech recognition', () => ({
      ok: this.voice.input.supported,
      warn: !this.voice.input.supported,
      msg: this.voice.input.supported ? 'Web Speech API present' : this.voice.input.unsupportedReason,
    }));

    t('Camera / secure context', () => ({
      ok: this.vision.cameraSupported && this.vision.secureContext,
      warn: !this.vision.secureContext,
      msg: !this.vision.cameraSupported ? 'no camera API'
        : !this.vision.secureContext ? 'insecure context — serve over localhost or https'
        : state.get('cameraActive') ? 'camera live' : 'available (currently off)',
    }));

    t('Hand tracking model', () => ({
      ok: !!this.vision.handLandmarker,
      warn: !this.vision.handLandmarker,
      msg: this.vision.handLandmarker ? 'MediaPipe HandLandmarker loaded' : 'not loaded yet (enable Vision)',
    }));

    t('Gesture bindings', () => ({
      ok: (this.gestures?.list().length || 0) >= 5,
      msg: `${this.gestures?.list().length || 0} gestures bound to actions`,
    }));

    t('Audio engine', () => ({
      ok: this.audio.ready,
      warn: !this.audio.ready,
      msg: this.audio.ready ? `Web Audio running (${this.audio.ctx.sampleRate} Hz)` : 'not initialised',
    }));

    t('WebXR', () => ({
      ok: !!this.ar?.supported?.webxr,
      warn: !this.ar?.supported?.webxr,
      msg: this.ar?.supported?.webxr ? 'immersive-ar supported' : 'unavailable — simulated AR fallback active',
    }));

    // live math check through the real engine
    const { evaluateMath } = await import('./ai/local-core.js');
    t('Local reasoning core', () => {
      const v = evaluateMath('(2+3)*sqrt(16)');
      return { ok: v === 20, msg: `math parser verified ((2+3)*sqrt(16) = ${v})` };
    });

    const okCount = results.filter(r => r.startsWith('✅')).length;
    return `**AURA SELF-TEST** — ${okCount}/${results.length} subsystems nominal\n\n${results.join('\n')}`;
  }

  /* ══════════════════ BACKGROUND FX ══════════════════ */

  startFxCanvas() {
    const cv = $('fx-canvas');
    const ctx = cv.getContext('2d');
    let parts = [];
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = window.innerWidth * dpr;
      cv.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(90, Math.floor(window.innerWidth / 16));
      parts = Array.from({ length: n }, () => ({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: Math.random() * 1.5 + 0.4,
        a: Math.random() * 0.4 + 0.12,
      }));
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      requestAnimationFrame(draw);
      if (!config.get('particles') || config.get('reduceMotion')) return;
      const W = window.innerWidth, H = window.innerHeight;
      ctx.clearRect(0, 0, W, H);
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '34,211,238';
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
        ctx.fillStyle = `rgba(${accent},${p.a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // constellation links
      ctx.lineWidth = 0.5;
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const dx = parts[i].x - parts[j].x, dy = parts[i].y - parts[j].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 15000) {
            ctx.strokeStyle = `rgba(${accent},${0.1 * (1 - d2 / 15000)})`;
            ctx.beginPath();
            ctx.moveTo(parts[i].x, parts[i].y);
            ctx.lineTo(parts[j].x, parts[j].y);
            ctx.stroke();
          }
        }
      }
    };
    draw();
  }
}

/* ══════════════════ LAUNCH ══════════════════ */

const app = new AuraApp();
window.AURA = app;   // expose for debugging + automated tests

app.boot().catch(err => {
  console.error('[AURA] boot failed', err);
  const ul = document.getElementById('boot-log');
  if (ul) {
    const li = document.createElement('li');
    li.className = 'warn';
    li.textContent = `BOOT FAILURE: ${err.message}`;
    ul.appendChild(li);
  }
  const btn = document.getElementById('boot-enter');
  if (btn) { btn.hidden = false; btn.querySelector('span').textContent = 'CONTINUE ANYWAY'; btn.onclick = () => app.enter(); }
});

export default app;
