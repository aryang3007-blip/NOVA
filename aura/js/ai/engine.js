/**
 * AURA :: AI Engine
 * -----------------
 * Owns conversation flow, provider selection, streaming, stop/continue,
 * and context injection. Publishes everything to the bus so the UI, avatar
 * and voice modules can react without being coupled to this file.
 *
 * Guarantees:
 *  • Stop is a real AbortController abort, not a UI trick.
 *  • Continue re-prompts with an explicit instruction to resume verbatim.
 *  • Local core streams chunk-by-chunk through the identical code path,
 *    so the UI behaves the same with or without an API key.
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';
import { config } from '../core/config.js';
import { Memory } from './memory.js';
import { getProvider, PROVIDERS, ollama } from './providers.js';
import { localRespond, chunkText } from './local-core.js';
import { liveData } from '../realtime/live-data.js';
import { extractActions, describeResult } from './action-parser.js';
import { intentRouter, ROUTE } from './intent-router.js';
import * as docAgent from './doc-agent.js';
import * as router from './router.js';
import { buildContextPacket } from './context-packet.js';
import { looksActionable, semanticToolSelect, verifyAndNarrate } from './semantic-tools.js';
import { ModelRegistry, TASK } from './model-registry.js';
import { extractToolCalls, normalizeToolCall, validateToolCall, toToolResult,
         buildToolManifest, toolProtocolPrompt, TOOLS } from './tools.js';

export class AIEngine {
  constructor({ plugins = null } = {}) {
    this.memory = new Memory({
      maxTurns: config.get('memoryTurns'),
      persist: config.get('persistConversation'),
    });
    this.plugins = plugins;
    this.controller = null;
    this.streaming = false;
    this.currentText = '';
    this.lastFinishReason = null;
    this.visionContext = null;
    this.resolvedProvider = 'local';
    this.resolvedModel = '';
    this._ollamaAvailable = false;
    this.streamId = 0;              // monotonic id so the UI can ignore stale streams
    this.desktop = null;            // DesktopFramework, attached at boot
    this.runtime = null;            // LocalRuntime, attached at boot
    this.memoryManager = null;      // MemoryManager (4 categories)
    this.router = intentRouter;     // priority intent router
    this.models = new ModelRegistry({ strategy: config.get('modelStrategy') || 'speed',
                                      maxAutoParams: config.get('maxAutoParams') || 9 });
  }

  /**
   * Resolve once the in-flight stream has fully torn down.
   * Without this, calling stop() then immediately starting a new stream lets
   * the old stream's `finally` block clobber the new message element —
   * producing interleaved text. (Caught by the browser integration test.)
   */
  _settled(timeoutMs = 3000) {
    if (!this.streaming) return Promise.resolve();
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        if (!this.streaming || Date.now() - t0 > timeoutMs) resolve();
        else setTimeout(check, 12);
      };
      check();
    });
  }

  /* ── provider resolution ─────────────────────────────────────────── */

  /** Detect the best available backend. Called at boot and after settings change. */
  async resolve() {
    const want = config.get('provider');
    if (want !== 'auto') {
      const p = getProvider(want);
      if (want === 'local' || !p) {
        this._setResolved('local', '');
        return this.resolvedProvider;
      }
      if (p.needsKey && !config.getKey(want)) {
        // configured but unusable — be honest, fall back
        this._setResolved('local', '');
        bus.emit(EV.UI_TOAST, { type: 'warn', text: `${p.label} selected but no API key set — using local core.` });
        return this.resolvedProvider;
      }
      if (want === 'ollama') {
        const up = await ollama.ping(config.get('ollamaUrl'));
        this._ollamaAvailable = up;
        if (!up) {
          this._setResolved('local', '');
          bus.emit(EV.UI_TOAST, { type: 'warn', text: `Ollama not reachable at ${config.get('ollamaUrl')} — using local core.` });
          return this.resolvedProvider;
        }
      }
      this._setResolved(want, config.get('model') || p.defaultModel);
      return this.resolvedProvider;
    }

    // AUTO: first provider with a key wins, then Ollama, then local.
    for (const id of ['openai', 'anthropic', 'gemini', 'groq', 'openrouter']) {
      if (config.getKey(id)) {
        this._setResolved(id, config.get('model') || PROVIDERS[id].defaultModel);
        // Probe Ollama anyway so hybrid routing can use it for small tasks.
        ollama.ping(config.get('ollamaUrl')).then(async (up) => {
          this._ollamaAvailable = up;
          if (up) {
            try {
              await this.refreshModelRegistry();
              const sel = this.models.select(TASK.CHAT);
              this._ollamaFirstModel = sel?.name || ollama.defaultModel;
              state.set({ hybridReady: true, ollamaModel: this._ollamaFirstModel });
              bus.emit(EV.LOG, { text: `Hybrid routing ready — chat → ${this._ollamaFirstModel}` });
            } catch {}
          }
        });
        return this.resolvedProvider;
      }
    }
    const up = await ollama.ping(config.get('ollamaUrl'));
    this._ollamaAvailable = up;
    if (up) {
      let model = config.get('model');
      try {
        await this.refreshModelRegistry();
        const sel = this.models.select(TASK.CHAT);
        if (sel) {
          this._ollamaFirstModel = sel.name;
          // A configured model that isn't actually installed must never be
          // used — that produced the "wrong model / 404" the user reported.
          if (!this.models.get(model)) model = sel.name;
        }
      } catch {}
      // ollama.defaultModel is now the first REAL installed model (or null),
      // never an invented tag.
      this._setResolved('ollama', model || ollama.defaultModel || '');
      return this.resolvedProvider;
    }
    this._setResolved('local', '');
    return this.resolvedProvider;
  }

  /**
   * Hybrid routing — should this turn go to the local Ollama model instead of
   * the cloud provider?
   *
   * Small talk, quick lookups and short commands are handled locally: free,
   * private, and usually faster than a round-trip. Anything long, code-shaped
   * or explicitly reasoning-heavy escalates to the configured cloud model.
   */
  shouldUseLocalModel(text) {
    if (!config.get('hybridRouting')) return false;
    if (!this._ollamaAvailable) return false;
    if (this.resolvedProvider === 'ollama' || this.resolvedProvider === 'local') return false;

    const t = String(text || '').trim();
    const words = t.split(/\s+/).filter(Boolean).length;

    // Escalate: explicitly hard, long, or code-related
    const hard = /\b(write|refactor|debug|implement|design|architect|analyse|analyze|essay|research|prove|derive|optimi[sz]e|step by step|in detail|thoroughly|compare)\b/i.test(t)
      || /```|\bfunction\b|\bclass\b|\balgorithm\b/i.test(t)
      || words > config.get('hybridMaxWords');
    if (hard) return false;

    // Keep locally: greetings, short questions, quick facts
    return true;
  }

  _setResolved(provider, model) {
    this.resolvedProvider = provider;
    this.resolvedModel = model;
    state.set({ aiProvider: provider, aiModel: model });
    bus.emit(EV.AI_PROVIDER_CHANGED, { provider, model });
  }

  get providerLabel() {
    if (this.resolvedProvider === 'local') return 'Local Core';
    return getProvider(this.resolvedProvider)?.label || this.resolvedProvider;
  }

  /* ── context assembly ────────────────────────────────────────────── */

  setVisionContext(ctx) { this.visionContext = ctx; }

  buildSystemPrompt() {
    const parts = [config.get('systemPrompt')];
    const mem = this.memory.summary();
    if (mem) parts.push(`Session memory: ${mem}`);

    const now = new Date();
    parts.push(`Current local date and time: ${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`);

    if (this.visionContext?.cameraActive && this.visionContext.description) {
      parts.push(`LIVE CAMERA FEED: ${this.visionContext.description} Treat this as what you are seeing right now through your webcam.`);
    } else {
      parts.push('Your camera is currently OFF. If asked what you see, say your vision is offline and offer to enable it. Do not invent visual details.');
    }

    parts.push(liveData.contextNote());

    if (this.desktop?.initialized) {
      // Tool manifest reflects live permission state, so the model is told
      // which tools it may actually use.
      const manifest = buildToolManifest((toolName) => {
        const spec = TOOLS[toolName];
        if (!spec) return false;
        if (spec.service) return true;
        const def = this.desktop.actions.actions.get(spec.action);
        if (!def) return false;
        return !def.permission || this.desktop.permissions.isGranted(def.permission);
      });
      parts.push(toolProtocolPrompt(manifest));
      if (this.runtime) {
        const cap = this.runtime.describeCapabilities();
        parts.push(`Runtime: ${cap.transport} transport${cap.platform ? ` on ${cap.platform}` : ''}` +
          `${cap.simulated ? ' — desktop actions are SIMULATED; say so if asked to do something real' : ''}.`);
      }
    }

    if (this._memoryContext) parts.push(this._memoryContext);

    // Structured context packet (devices, usable tools, relevant prefs).
    if (this._contextPacket?.systemNote) parts.push(this._contextPacket.systemNote);

    const pluginCtx = this.plugins?.collectContext?.();
    if (pluginCtx) parts.push(`Plugin context:\n${pluginCtx}`);

    const cmds = this.plugins?.listCommands?.() || [];
    if (cmds.length) parts.push(`Available slash commands the user can type: ${cmds.map(c => '/' + c.name).join(', ')}.`);

    return parts.join('\n\n');
  }

  buildMessages(extra = []) {
    return [
      { role: 'system', content: this.buildSystemPrompt() },
      ...this.memory.window(),
      ...extra,
    ];
  }

  /* ── main entry ──────────────────────────────────────────────────── */

  /**
   * Send a user message and stream the reply.
   * @param {string} text
   * @param {{silent?:boolean, skipMemory?:boolean, silentUser?:string}} opts
   *   `silentUser` shows this text in the transcript instead of `text` — for
   *   machine-built prompts (a screen transcription) where the human only
   *   typed a short question.
   */
  async send(text, opts = {}) {
    const input = String(text || '').trim();
    if (!input) return;
    // Abort any in-flight stream AND wait for its teardown, otherwise the old
    // stream's finally-block races the new one and the two replies interleave.
    if (this.streaming) { this.stop('superseded'); await this._settled(); }

    // slash commands bypass the model entirely
    if (input.startsWith('/') && this.plugins) {
      bus.emit(EV.AI_USER_MESSAGE, { text: input });
      this.memory.addUser(input);
      const res = await this.plugins.run(input);
      if (res.handled) {
        // A command may return null/undefined to mean "I have already
        // produced the reply myself" — /look and /search stream their answer
        // through the model. Rendering that as text printed a literal "null".
        if (!res.error && (res.output === null || res.output === undefined)) return;
        const out = res.error ? `⚠ ${res.error}` : res.output;
        await this._streamLocalText(out, { emotion: res.error ? 'confused' : 'neutral' });
        return;
      }
    }

    // `silentUser` lets a caller send a long machine-built prompt (e.g. a
    // screen transcription) while the transcript shows the short question
    // the human actually typed. The model still receives the full prompt.
    const shown = opts.silentUser ? String(opts.silentUser) : input;
    bus.emit(EV.AI_USER_MESSAGE, { text: shown });
    this.memory.addUser(input);
    bus.emit(EV.AI_MEMORY_UPDATED, { count: this.memory.all().length });

    // A pending high-risk action is awaiting yes/no.
    if (this._pendingAction && await this._resolvePendingConfirm(input)) return;
    if (this._pendingTool && await this._resolvePendingTool(input)) return;

    // Mirror the turn into the layered memory system and assemble context.
    if (this.memoryManager) {
      try {
        this.memoryManager.conversation.addUser(input);
        this._memoryContext = await this.memoryManager.buildContext(input);
      } catch (e) { console.warn('[memory] context build failed', e); }
    }

    // ── CONTEXT PACKET (spec §7): bounded, RELEVANT context — devices,
    //    actually-usable tools, preferences/memory matching this request,
    //    runtime state. Never a database dump.
    try {
      this._contextPacket = await buildContextPacket({
        userText: input,
        engine: this,
        devices: this.deviceManager || this.orchestrator?.deviceManager || this.runtime?.devices,
        conversationHints: (this.memory.window?.() || []).slice(-2).map(m => m.content || ''),
      });
    } catch { this._contextPacket = null; }

    // ── PRIORITY INTENT ROUTER
    //    One ordered pipeline replaces the old first-match-wins matchers.
    //    Math now outranks web lookup, which is why "what is 47*89" can no
    //    longer be answered with the AK-47 Wikipedia article.
    const decision = this.router.route(input, {
      desktopReady: !!this.desktop?.initialized,
      liveDataEnabled: liveData.enabled,
      guideContext: this.guideContext(),
    });
    this._lastRoute = decision;
    bus.emit('ai:routed', { input, decision });

    if (decision.route === ROUTE.SAFETY) {
      await this._streamLocalText(decision.payload.refusal, { emotion: 'focused' });
      return;
    }

    // Self-documentation: answered from the built-in guide, no model needed.
    if (decision.route === ROUTE.GUIDE) {
      await this._streamLocalText(decision.payload.guide.text, { emotion: 'confident' });
      return;
    }

    if (decision.route === ROUTE.TOOL && this.desktop?.initialized) {
      const handled = await this._runDesktopAction(decision.payload.action, 'router');
      if (handled) return;
    }

    if (decision.route === ROUTE.WEB && liveData.enabled) {
      const handled = await this._runLiveIntent(decision.payload.liveIntent);
      if (handled) return;
    }

    // ── SEMANTIC ACTION FALLBACK — the end of hardcoded voice commands.
    //    Deterministic stages passed, but the message still reads like a
    //    request to ACT ("can you open YouTube?", "put YouTube on my phone",
    //    "make me a deck on X"). The CONFIGURED model maps it onto the
    //    capability registry; we then execute through the real pipeline and
    //    report the REAL result. Questions are untouched: looksActionable()
    //    refuses them before any model call is spent.
    if (decision.route === ROUTE.CONVERSATION || decision.route === ROUTE.TOOL) {
      try {
        if (await this._runSemanticAction(input)) return;
      } catch (e) {
        bus.emit(EV.LOG, { text: `[semantic] ${e?.message || e}`, kind: 'warn' });
      }
    }

    // MATH and LOCAL fall through to the offline core below, which already
    // handles them correctly — the router just guarantees they get there
    // before any web lookup can intercept.

    if (this.resolvedProvider === 'local') {
      await this._respondLocal(input);
    } else {
      await this._respondRemote();
    }
  }

  /**
   * Model-driven action fallback (spec §5/§9). Returns true iff a tool was
   * selected, executed AND narrated — otherwise the caller continues to
   * normal conversation.
   * @param {string} input
   */
  async _runSemanticAction(input) {
    if (!looksActionable(input)) return false;
    const sel = await semanticToolSelect(input, {
      engine: this, deviceSummary: this._deviceSummaryText(),
    });
    if (!sel?.ok || !sel.call) return false;

    bus.emit('ai:semantic-action', { input, call: sel.call, provider: sel.provider, model: sel.model });

    let res;
    if (sel.call.device) {
      // A device clause was extracted ("open YouTube ON MY PHONE"): the
      // action runs on the companion device, never on this machine.
      const targetArg = sel.call.parameters?.application || sel.call.parameters?.url
        || sel.call.parameters?.query || '';
      res = await this._runNovaService({
        tool: 'device_action',
        parameters: {
          device: sel.call.device,
          action: sel.call.tool === 'launch_application' ? 'open_app' : sel.call.tool,
          params: targetArg ? { app: targetArg } : (sel.call.parameters || {}),
        },
      }, input);
    } else if (sel.call.service || sel.call.tool === 'device_action') {
      res = await this._runNovaService(sel.call, input);
    } else {
      res = await this.executeToolCall(sel.call, 'semantic');
    }

    const narr = verifyAndNarrate(sel.call.tool, res);

    // Global task log: every agent action becomes an episode with its
    // outcome, viewable via /api/db/memory/episodes and the dev trace.
    try {
      await this.memoryManager?.episodic?.record(
        `${sel.call.tool}: ${(narr.text || '').slice(0, 140)}`,
        { why: `natural request "${input.slice(0, 90)}" → ${narr.ok ? 'completed' : 'failed'}`,
          source: 'semantic-router' });
    } catch {}

    const text = (sel.say && narr.ok ? `${sel.say}\n\n` : '') + narr.text;
    await this._streamLocalText(text, { emotion: narr.ok ? 'confident' : 'confused' });
    return true;
  }

  /**
   * Execute a NOVA service capability (documents, research, screen, devices,
   * tasks). Honest results only — each branch says plainly when the backing
   * capability is unavailable rather than pretending.
   */
  async _runNovaService(call, rawInput) {
    const p = call.parameters || {};
    switch (call.service || call.tool) {

      case 'docgen': {
        const A = this.actions;
        if (!A?.available) {
          return { success: false, message: 'The desktop bridge is off — restart with `--allow-actions` and I can create the file.' };
        }
        const kind = ['pptx', 'docx', 'xlsx'].includes(String(p.kind || '').toLowerCase())
          ? String(p.kind).toLowerCase() : 'pptx';
        const caps = await A.docCapabilities().catch(() => null);
        if (!caps?.[kind]) {
          return { success: false, message: `${kind} generation needs its Python library (${caps?.install?.[kind] || 'see requirements.txt'}).` };
        }
        const o = await docAgent.outline({
          kind, topic: String(p.topic || rawInput), engine: this,
          slides: Number(p.slides) || 0, audience: String(p.audience || ''),
          research: (t) => this._researchDigest(t),
        });
        if (!o.ok) return { success: false, message: o.message || 'Outline failed.' };
        const r = await A.docBuild(kind, o.spec, config.get('docFolder') || undefined);
        if (!r?.ok) return { success: false, message: r?.message || 'Could not build the file.' };
        const extras = [];
        if (o.source === 'offline-template') extras.push('built from the offline template — no model was available');
        if (o.researched) extras.push('grounded in live web research');
        if (o.deckReport && !o.deckReport.ok && o.deckReport.repaired) extras.push('weak slides were auto-repaired');
        if (r.validation && !r.validation.ok) extras.push(`validation notes: ${r.validation.issues.slice(0, 2).join('; ')}`);
        return { success: true,
                 message: `Created ${docAgent.describeSpec(kind, o.spec)} → \`${r.path}\``
                          + (extras.length ? `\n\n_${extras.join('. ')}._` : '') };
      }

      case 'research': {
        const digest = await this._researchDigest(String(p.topic || rawInput));
        if (!digest) {
          return { success: false, message: 'Web research is unavailable (needs the bridge with `--allow-actions` and ddgs/trafilatura installed).' };
        }
        // Summarise through the configured model — a second honest step, so
        // the spoken answer is synthesis, not a raw link dump.
        const sum = await router.complete({
          messages: [
            { role: 'system', content: 'You are NOVA. Summarise research into a tight spoken answer (3-6 sentences), naming sources by site. No filler.' },
            { role: 'user', content: `Question: ${String(p.topic || rawInput)}\n\nResearch:\n${digest}` },
          ],
          engine: this, temperature: 0.4, maxTokens: 700, timeoutMs: 60000,
        });
        return { success: true, message: (sum.ok && sum.text) || digest.slice(0, 1200) };
      }

      case 'screen': {
        const agent = this.screenAgent;
        if (!agent?.screen?.active) {
          return { success: false, message: 'No screen is being shared. Start one in AURA Live (`/screen`) and ask again.' };
        }
        const r = await agent.ask(String(p.question || 'What is on my screen?'));
        return { success: !!r.ok, message: r.message || (r.ok ? '' : 'Could not read the screen.') };
      }

      case 'device_action': {
        const dm = this.deviceManager || this.orchestrator?.deviceManager || this.runtime?.devices;
        if (!dm) return { success: false, message: 'No device gateway on this machine.' };
        const ref = String(p.device || '').toLowerCase();
        const list = (dm.listDevices?.() || []);
        const dev = list.find(d =>
          [d.id, d.name, d.kind, d.platform].filter(Boolean)
            .some(v => String(v).toLowerCase().includes(ref)))
          || (['phone', 'mobile', 'android', 'iphone'].includes(ref)
              && list.find(d => String(d.kind || '').toLowerCase() === 'phone'));
        if (!dev) {
          return { success: false,
                   message: list.length
                     ? `Device "${p.device}" isn't paired. I can see: ${list.map(d => d.name || d.id).join(', ')}.`
                     : `No devices are paired, so I can't reach "${p.device}". Pair your phone from the Devices page first.` };
        }
        const r = await dm.dispatchToDevice(dev.id, { action: p.action, params: p.params || {} }).catch(e => ({ ok: false, message: e?.message || String(e) }));
        if (r?.ok === false) return { success: false, message: r.message || `Couldn't run "${p.action}" on ${dev.name || dev.id}.` };
        return { success: true, message: `Sent "${p.action}" to ${dev.name || dev.id}.` };
      }

      case 'tasks': {
        const epi = this.memoryManager?.episodic;
        if (!epi) return { success: false, message: 'Task memory is not initialised.' };
        if (String(p.op || '').includes('create') && p.title) {
          await epi.record(String(p.title).slice(0, 140), { why: 'user-created task', source: 'semantic-router' });
          return { success: true, message: `Task noted: ${p.title}` };
        }
        const all = (epi.all?.() || []).slice(-8);
        if (!all.length) return { success: true, message: 'No tasks recorded yet.' };
        return { success: true, message: 'Recent activity:\n' + all.map((e, i) => `${i + 1}. ${e.event}`).join('\n') };
      }

      default:
        return { success: false, message: `I don't know how to run "${call.tool}" yet.` };
    }
  }

  /** Web research through the bridge; returns a digest string or null. */
  async _researchDigest(topic) {
    try {
      const A = this.actions;
      if (!A?.available) return null;
      const r = await A.run('web_research', { query: String(topic), depth: 'adaptive', maxResults: 5, readCount: 3 });
      return (r?.ok && r?.context) ? String(r.context).slice(0, 2200) : null;
    } catch { return null; }
  }

  /** One-line prompt-side summary of paired devices for the selector. */
  _deviceSummaryText() {
    try {
      const dm = this.deviceManager || this.orchestrator?.deviceManager || this.runtime?.devices;
      const list = dm?.listDevices?.() || [];
      if (!list.length) return 'none paired';
      return list.slice(0, 6)
        .map(d => `${d.name || d.id}${d.kind ? ` (${d.kind})` : ''}${d.status === 'connected' ? '' : ' offline'}`)
        .join(', ');
    } catch { return ''; }
  }

  /**
   * Execute a canonical tool call: validate → map → Action Manager → result.
   * This is the spec-shaped entry point:
   *   { type:'tool_call', tool:'launch_application', parameters:{...} }
   * @param {object} call
   * @returns {Promise<import('./tools.js').ToolResult>}
   */
  async executeToolCall(call, source = 'ai') {
    const norm = normalizeToolCall(call);
    if (!norm) {
      return { success: false, tool: String(call?.tool || 'unknown'),
               message: 'Malformed tool call.', error: 'invalid_parameters' };
    }
    const spec = TOOLS[norm.tool];

    // Not a friendly tool → treat as a raw action id (kept for compatibility).
    if (!spec) {
      const res = await this.desktop.execute({ action: norm.tool, ...norm.parameters }, { source });
      return toToolResult(norm.tool, res);
    }

    const v = validateToolCall(norm.tool, norm.parameters);
    if (!v.ok) return { success: false, tool: norm.tool, message: v.error, error: 'invalid_parameters' };

    // Service-backed tools bypass the OS entirely (weather, news, memory).
    if (spec.service) return this._runServiceTool(spec, v.value);

    const payload = spec.map(v.value);
    const res = await this.desktop.execute(
      { action: spec.action, target: payload.target, params: payload }, { source });
    return toToolResult(norm.tool, res);
  }

  /** Tools served by live-data or memory rather than the OS. */
  async _runServiceTool(spec, params) {
    const p = spec.map(params);
    try {
      switch (spec.service) {
        case 'weather': {
          const r = await liveData.weather(p.place);
          return { success: r.ok, tool: spec.name, message: r.ok ? r.markdown : r.message,
                   data: r.ok ? { summary: r.summary } : undefined };
        }
        case 'news': {
          const r = await liveData.news(p.topic);
          return { success: r.ok, tool: spec.name, message: r.ok ? r.markdown : r.message };
        }
        case 'wiki': {
          const r = await liveData.wiki(p.query);
          return { success: r.ok, tool: spec.name, message: r.ok ? r.markdown : r.message };
        }
        case 'memory_store': {
          if (!this.memoryManager) return { success: false, tool: spec.name, message: 'Memory manager unavailable.', error: 'not_available' };
          await this.memoryManager.preferences.set(p.key, p.value, { source: 'ai', confidence: 0.9 });
          return { success: true, tool: spec.name, message: `Remembered ${p.key}: ${p.value}` };
        }
        default:
          return { success: false, tool: spec.name, message: `Unknown service "${spec.service}".`, error: 'not_available' };
      }
    } catch (e) {
      return { success: false, tool: spec.name, message: e.message, error: 'execution_failed' };
    }
  }

  /**
   * Fetch real-world data and answer from it.
   * @returns {Promise<boolean>} handled?
   */
  async _runLiveIntent(intent) {
    let r;
    switch (intent.type) {
      case 'weather':  r = await liveData.weather(intent.place); break;
      case 'news':     r = await liveData.news(intent.topic); break;
      case 'crypto':   r = await liveData.crypto(intent.coins); break;
      case 'currency': r = await liveData.currency(intent.from, intent.to, intent.amount); break;
      case 'wiki':     r = await liveData.wiki(intent.query); break;
      default: return false;
    }
    if (!r.ok) {
      // Wiki misses are common; let the model try instead of dead-ending.
      if (intent.type === 'wiki' && !r.disabled) return false;
      await this._streamLocalText(`⚠ ${r.message}`, { emotion: 'confused' });
      return true;
    }
    bus.emit('live:data', { intent, result: r });
    await this._streamLocalText(r.markdown, { emotion: 'confident', speakText: r.summary });
    return true;
  }

  /** Render a ToolResult into the transcript + voice. */
  async _reportToolResult(call, result) {
    if (result.needsConfirmation) {
      this._pendingTool = { call, token: result.confirmToken };
      await this._streamLocalText(
        `⚠ ${result.message}\n\nReply **yes** to confirm, or **no** to cancel.`,
        { emotion: 'focused' });
      return;
    }
    const icon = result.success ? (result.simulated ? '🟡' : '✅') : '⚠';
    let body = `${icon} ${result.message}`;
    if (!result.success && result.error === 'permission_denied' && result.permissionLabel) {
      body += `\n\n_Enable **${result.permissionLabel}** in Settings → Desktop → Permissions._`;
    }
    bus.emit('desktop:action-reported', { request: call, result: { ...result, ok: result.success } });
    await this._streamLocalText(body, {
      emotion: result.success ? 'confident' : 'confused',
      speakText: result.success
        ? (result.simulated ? `${result.message.replace(/^\[SIMULATED\]\s*/i, '')} This was simulated.` : 'Done.')
        : result.message,
    });
  }

  /**
   * Route a structured action through the Action Manager and report back.
   * @returns {Promise<boolean>} handled?
   */
  async _runDesktopAction(request, source = 'ai') {
    const result = await this.desktop.execute(request, { source });

    if (result.needsConfirmation) {
      this._pendingAction = { request, token: result.confirmToken };
      await this._streamLocalText(
        `⚠ ${result.message}\n\nReply **yes** to confirm, or **no** to cancel.`,
        { emotion: 'focused' });
      return true;
    }

    const spoken = describeResult(request, result);
    const icon = result.ok ? (result.simulated ? '🟡' : '✅') : '⚠';
    let body = `${icon} ${result.message}`;
    if (!result.ok && result.code === 'no_permission') {
      body += `\n\n_Enable **${result.permissionLabel}** in Settings → Desktop → Permissions._`;
    }
    if (result.suggestions?.length) body += `\n\nDid you mean: ${result.suggestions.join(', ')}?`;

    bus.emit('desktop:action-reported', { request, result });
    await this._streamLocalText(body, {
      emotion: result.ok ? 'confident' : 'confused',
      speakText: spoken,
    });
    return true;
  }

  /** Yes/no reply to a pending TOOL confirmation. */
  async _resolvePendingTool(input) {
    const yes = /^(yes|y|yeah|yep|confirm|do it|go ahead|ok|okay)\b/i.test(input.trim());
    const no = /^(no|n|nope|cancel|stop|don'?t|abort)\b/i.test(input.trim());
    if (!yes && !no) return false;
    const { call, token } = this._pendingTool;
    this._pendingTool = null;
    if (no) {
      const spec = TOOLS[call.tool];
      if (spec?.action) this.desktop?.actions.cancelConfirm(spec.action);
      await this._streamLocalText('Cancelled.', { emotion: 'neutral' });
      return true;
    }
    const spec = TOOLS[call.tool];
    const res = spec?.action
      ? toToolResult(call.tool, await this.desktop.actions.confirm(spec.action, token))
      : { success: false, tool: call.tool, message: 'Confirmation expired.', error: 'execution_failed' };
    await this._reportToolResult(call, res);
    return true;
  }

  /** Handle a yes/no reply to a pending confirmation. */
  async _resolvePendingConfirm(input) {
    if (!this._pendingAction) return false;
    const yes = /^(yes|y|yeah|yep|confirm|do it|go ahead|ok|okay)\b/i.test(input.trim());
    const no = /^(no|n|nope|cancel|stop|don'?t|abort)\b/i.test(input.trim());
    if (!yes && !no) return false;

    const { request, token } = this._pendingAction;
    this._pendingAction = null;
    if (no) {
      await this._streamLocalText('Cancelled.', { emotion: 'neutral' });
      this.desktop?.actions.cancelConfirm(request.action);
      return true;
    }
    const result = await this.desktop.actions.confirm(request.action, token);
    const icon = result.ok ? (result.simulated ? '🟡' : '✅') : '⚠';
    await this._streamLocalText(`${icon} ${result.message}`, {
      emotion: result.ok ? 'confident' : 'confused',
      speakText: describeResult(request, result),
    });
    return true;
  }

  /**
   * Live state snapshot for the built-in guide, so its answers reflect
   * reality rather than generic documentation.
   */
  guideContext() {
    const s = state.get();
    const perms = this.desktop?.permissions?.summary?.() || { granted: 0, total: 0 };
    const rt = this.runtime?.status?.() || {};
    return {
      provider: this.providerLabel, model: s.aiModel,
      ollamaReady: !!s.hybridReady || this.resolvedProvider === 'ollama',
      ollamaModel: s.ollamaModel || (this.resolvedProvider === 'ollama' ? s.aiModel : null),
      sttSupported: s.sttSupported, sttActive: s.sttActive,
      ttsEnabled: config.get('ttsEnabled'), wakeWord: config.get('wakeWord'),
      cameraActive: s.cameraActive, hands: s.handCount, faces: s.faceCount, objects: s.objectCount,
      desktopSimulated: rt.simulated !== false, platform: rt.platform,
      permsGranted: perms.granted, permsTotal: perms.total,
      commandCount: this.plugins?.listCommands?.().length || 0,
      pluginCount: this.plugins?.plugins?.size || 0,
    };
  }

  /** Regenerate the last assistant reply. */
  async regenerate() {
    if (this.streaming) { this.stop('superseded'); await this._settled(); }
    const last = this.memory.lastUser();
    if (!last) return;
    // drop trailing assistant message
    for (let i = this.memory.messages.length - 1; i >= 0; i--) {
      if (this.memory.messages[i].role === 'assistant') { this.memory.messages.splice(i, 1); break; }
    }
    if (this.resolvedProvider === 'local') await this._respondLocal(last.content);
    else await this._respondRemote();
  }

  /**
   * Continue a reply that was stopped or truncated.
   * Real implementation: re-sends the conversation with an explicit
   * continuation instruction and appends the new text to the same message.
   */
  async continue() {
    const lastAsst = this.memory.lastAssistant();
    if (!lastAsst) { bus.emit(EV.UI_TOAST, { type: 'warn', text: 'Nothing to continue.' }); return; }
    if (this.streaming) return;

    if (this.resolvedProvider === 'local') {
      const rest = this._localRemainder;
      if (!rest) { bus.emit(EV.UI_TOAST, { type: 'warn', text: 'Local core reply was already complete.' }); return; }
      this._localRemainder = '';
      await this._streamLocalText(rest, { append: true });
      return;
    }

    const messages = this.buildMessages([
      { role: 'user', content: 'Continue your previous message from exactly where it stopped. Do not repeat any text you already sent, do not re-introduce the answer, and do not apologise — just continue seamlessly.' },
    ]);
    await this._runRemoteStream(messages, { append: true });
  }

  /** Abort the in-flight stream. Keeps whatever text arrived. */
  stop(reason = 'user') {
    if (!this.streaming) return false;
    this._stopReason = reason;
    try { this.controller?.abort(); } catch {}
    return true;
  }

  clear() {
    this.stop('clear');
    this.memory.clear();
    this._localRemainder = '';
    bus.emit(EV.AI_MEMORY_UPDATED, { count: 0, cleared: true });
  }

  /* ── local core path ─────────────────────────────────────────────── */

  async _respondLocal(input) {
    const ctx = {
      history: this.memory.all(),
      memory: this.memory.facts,
      vision: this.visionContext || {},
      status: state.get(),
      plugins: this.plugins?.list?.() || [],
    };
    const res = localRespond(input, ctx);

    if (res.action === 'set-name' && res.name) this.memory.setFact('userName', res.name);
    if (res.action) bus.emit(EV.COMMAND, { command: res.action, source: 'local-core', payload: res });

    await this._streamLocalText(res.text, { emotion: res.emotion });
  }

  /**
   * Stream a known string through the same pipeline as a network stream,
   * so every consumer (UI, TTS, avatar) sees identical events.
   */
  async _streamLocalText(text, { emotion = 'neutral', append = false, speakText = null } = {}) {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.streaming = true;
    this._stopReason = null;
    state.set({ aiStreaming: true });

    const sid = ++this.streamId;
    const startText = append ? (this.memory.lastAssistant()?.content || '') : '';
    this.currentText = startText;
    if (!append) this.memory.addAssistant('');

    bus.emit(EV.AI_STREAM_START, { provider: 'local', model: 'aura-core', append, emotion, sid, speakText });
    if (emotion) bus.emit(EV.AVATAR_EMOTION, { emotion });

    const chunks = chunkText(text, 2);
    let delivered = '';
    try {
      for (const c of chunks) {
        if (signal.aborted) break;
        await new Promise(r => setTimeout(r, 14 + Math.random() * 22));
        if (signal.aborted) break;
        delivered += c;
        this.currentText += c;
        bus.emit(EV.AI_STREAM_DELTA, { delta: c, text: this.currentText, sid });
      }
    } finally {
      const aborted = signal.aborted;
      this._localRemainder = aborted ? text.slice(delivered.length) : '';
      this.memory.updateLastAssistant(this.currentText);
      this.streaming = false;
      this.controller = null;
      state.set({ aiStreaming: false, aiCanContinue: aborted && !!this._localRemainder });
      bus.emit(aborted ? EV.AI_STREAM_ABORT : EV.AI_STREAM_END, {
        text: this.currentText, aborted, reason: this._stopReason, sid,
        canContinue: aborted && !!this._localRemainder,
      });
      bus.emit(EV.AI_MEMORY_UPDATED, { count: this.memory.all().length });
    }
  }

  /* ── remote path ─────────────────────────────────────────────────── */

  async _respondRemote() {
    const lastUser = this.memory.lastUser()?.content || '';
    const useLocal = this.shouldUseLocalModel(lastUser);
    await this._runRemoteStream(this.buildMessages(), { append: false, viaOllama: useLocal });
  }

  /**
   * Ask a multimodal model about an actual image.
   *
   * THIS IS THE DIFFERENCE between AURA *describing* what the camera sees in
   * text (landmark counts, detected objects) and the model genuinely LOOKING
   * at the frame. The textual description stays as context; the raw pixels
   * now go with it.
   *
   * Requires a vision-capable model in Ollama. Which models qualify is NOT
   * a hardcoded list — it comes from Ollama's own `/api/show` capabilities
   * (see providers.isVisionModel). Says so plainly if none is installed,
   * rather than sending an image to a text model that will ignore it.
   *
   * @param {string} question
   * @param {string} dataUrl  a `data:image/...;base64,...` frame
   * @returns {Promise<{ok:boolean, message?:string, model?:string}>}
   */
  async askAboutImage(question, dataUrl) {
    if (!dataUrl) return { ok: false, message: 'No image to look at.' };

    const q = String(question || '').trim() || 'Describe what you see in this image.';
    this.memory.addUser(q);
    bus.emit(EV.AI_USER_MESSAGE, { text: q });

    const scene = this.visionContext?.description
      ? `\n\n(AURA's own detectors report: ${this.visionContext.description})` : '';
    const messages = [
      { role: 'system', content: 'You are AURA Desktop Vision assistant. '
        + 'Describe and analyze only what is actually visible on screen. Be concise, concrete, and accurate.' },
      { role: 'user', content: q + scene },
    ];

    const vProviderPref = config.get('visionProvider') || 'auto';
    const vModelPref = config.get('visionModel') || '';

    // Check if cloud vision provider is configured
    let targetProvider = null;
    let targetModel = null;

    if (vProviderPref !== 'auto' && vProviderPref !== 'ollama') {
      const p = getProvider(vProviderPref);
      if (p && config.getKey(vProviderPref)) {
        targetProvider = vProviderPref;
        targetModel = vModelPref || p.defaultModel;
      }
    } else if (vProviderPref === 'auto') {
      // If current provider is cloud and has key, use it
      const curP = this.resolvedProvider;
      if (curP && curP !== 'ollama' && curP !== 'local' && config.getKey(curP)) {
        targetProvider = curP;
        targetModel = vModelPref || this.resolvedModel || getProvider(curP)?.defaultModel;
      }
      // Chat is running locally but another provider HAS a key — use that.
      // (Otherwise a screenshot went to a local model even though the user
      // configured cloud vision, which read as "not sending screenshots to
      // the API model".)
      if (!targetProvider) {
        for (const id of ['gemini', 'openrouter', 'openai', 'groq', 'anthropic']) {
          if (!config.getKey(id)) continue;
          targetProvider = id;
          targetModel = vModelPref || getProvider(id)?.defaultModel;
          break;
        }
      }
    }

    if (targetProvider) {
      const prevResolvedProvider = this.resolvedProvider;
      const prevResolvedModel = this.resolvedModel;
      this.resolvedProvider = targetProvider;
      this.resolvedModel = targetModel;
      try {
        await this._runRemoteStream(messages, {
          append: false, viaOllama: false,
          images: [dataUrl],
        });
        return { ok: true, model: `${targetProvider}:${targetModel}` };
      } finally {
        this.resolvedProvider = prevResolvedProvider;
        this.resolvedModel = prevResolvedModel;
      }
    }

    // Fallback to local Ollama
    try { await this.refreshModelRegistry(); } catch {}
    const vm = ollama.visionModels();
    if (!vm.length) {
      const installed = ollama.installed || [];
      if (!installed.length) {
        return { ok: false, message: 'No vision-capable AI provider configured. Add an API key in Settings (Gemini / OpenAI / Anthropic / OpenRouter) or run `ollama pull moondream`.' };
      }
    }

    const pickModel = vModelPref || this.pickVisionModel()?.name || vm[0] || ollama.installed?.[0];
    await this._runRemoteStream(messages, {
      append: false, viaOllama: true,
      images: [String(dataUrl).replace(/^data:image\/\w+;base64,/, '')],
    });
    return { ok: true, model: pickModel };
  }

  /**
   * Choose which model looks at an image.
   *
   * WHY THIS IS NOT `visionModels()[0]`: that returned the first name
   * ALPHABETICALLY. On a machine holding gemma3:12b, gemma4:12b and
   * qwen2.5vl:7b it always picked gemma3:12b — the joint-heaviest option —
   * even though a 7B model was sitting right there. Slowest-by-accident.
   *
   * Order of preference:
   *   1. An explicit vision pin (Settings / `/pin vision <model>`).
   *   2. The registry's VISION task selection — honours the speed-first
   *      strategy and measured throughput.
   *   3. Smallest vision model by parameter count.
   *   4. Whatever vision model exists.
   *
   * The size ceiling is deliberately NOT applied here: if the only model
   * that can see is a 12B, refusing to use it would mean refusing to answer
   * at all. Better to be slow than to lie about the capability.
   *
   * @returns {{name:string, reason:string, pinned:boolean}|null}
   */
  pickVisionModel() {
    const vm = ollama.visionModels();
    if (!vm.length) return null;

    // 1. Explicit pin wins, if it can actually see.
    const pinned = this.models?.pins?.[TASK.VISION];
    if (pinned && vm.includes(pinned)) {
      return { name: pinned, reason: 'pinned for vision', pinned: true };
    }

    // 2. Ask the registry, but only accept a vision-capable answer.
    const sel = this.models?.size ? this.models.select(TASK.VISION) : null;
    if (sel && vm.includes(sel.name)) {
      return { name: sel.name, reason: `sees images · ${sel.reason}`, pinned: !!sel.pinned };
    }

    // 3. Fall back to the smallest one we know the size of.
    const sized = vm
      .map(n => ({ n, p: this.models?.get?.(n)?.params || Infinity }))
      .sort((a, b) => a.p - b.p);
    const best = sized[0];
    const detail = Number.isFinite(best.p) && best.p > 0 ? ` · ${best.p}B, fastest that can see` : '';
    return {
      name: best.n,
      reason: `only vision-capable choice${detail}`.replace('only vision-capable choice ·', 'vision model ·'),
      pinned: false,
    };
  }

  /**
   * Choose which Ollama model handles this turn, based on the task.
   * Never auto-selects a model above the size ceiling.
   * @param {string} text
   * @returns {{name:string, reason:string, pinned:boolean, model?:object,
   *            task?:string, corrected?:boolean}}
   */
  pickOllamaModel(text) {
    const installed = ollama.installed || [];

    // An explicitly configured model is honoured ONLY if it is really
    // installed. Previously a typo'd/stale value here was sent to Ollama
    // verbatim, which 404'd and looked like "Ollama is down".
    const explicit = config.get('ollamaSmallModel');
    if (explicit) {
      if (!installed.length || installed.includes(explicit)) {
        return { name: explicit, reason: 'set in Settings', pinned: true };
      }
      const { name, note } = ollama.resolveModel(explicit);
      return { name, reason: note || 'settings value not installed', pinned: false, corrected: true };
    }

    if (!this.models.size) {
      const fallback = this._ollamaFirstModel || installed[0] || ollama.defaultModel;
      return { name: fallback, reason: 'no registry data', pinned: false };
    }
    const task = this.models.classify(text, { hasToolContext: !!this.desktop?.initialized });
    const sel = this.models.select(task);
    if (sel) { sel.task = task; return sel; }
    return {
      name: this._ollamaFirstModel || installed[0] || ollama.defaultModel,
      reason: 'fallback', pinned: false,
    };
  }

  /**
   * @param {Array} messages
   * @param {{append:boolean, viaOllama?:boolean, images?:string[]}} opts
   *   `images` = base64 frames for a multimodal model (see askAboutImage).
   */
  async _runRemoteStream(messages, { append, viaOllama = false, images = null }) {
    // Hybrid routing sends this turn to the local Ollama model instead.
    const providerId = viaOllama ? 'ollama' : this.resolvedProvider;
    const provider = getProvider(providerId);
    if (!provider) { await this._respondLocal(this.memory.lastUser()?.content || ''); return; }
    let modelForTurn = this.resolvedModel;
    let modelChoice = null;
    if ((viaOllama || providerId === 'ollama') && images && images.length) {
      // Images only work on a multimodal model. Route to one explicitly
      // rather than letting the speed-first router pick a text-only model
      // that would silently ignore the picture.
      const pick = this.pickVisionModel();
      if (pick) {
        modelForTurn = pick.name;
        modelChoice = { name: pick.name, reason: pick.reason, pinned: pick.pinned };
        bus.emit('ai:model-selected', {
          model: pick.name, task: 'vision', reason: pick.reason, pinned: pick.pinned,
        });
      }
    } else if (viaOllama || providerId === 'ollama') {
      modelChoice = this.pickOllamaModel(this.memory.lastUser()?.content || '');
      modelForTurn = modelChoice.name;
      bus.emit('ai:model-selected', {
        model: modelForTurn, task: modelChoice.task || 'chat',
        reason: modelChoice.reason, pinned: modelChoice.pinned,
      });
    }

    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.streaming = true;
    this._stopReason = null;
    state.set({ aiStreaming: true });

    const sid = ++this.streamId;
    const startText = append ? (this.memory.lastAssistant()?.content || '') : '';
    this.currentText = startText;
    if (!append) this.memory.addAssistant('');

    bus.emit(EV.AI_STREAM_START, {
      provider: providerId, model: modelForTurn, append, sid, routedLocal: viaOllama,
    });

    let errored = null;
    let received = 0;
    this._genStart = Date.now();
    try {
      const iter = provider.stream({
        messages,
        model: modelForTurn,
        key: config.getKey(providerId),
        signal,
        temperature: config.get('temperature'),
        maxTokens: config.get('maxTokens'),
        baseUrlOverride: providerId === 'ollama' ? config.get('ollamaUrl') : undefined,
        images: images || undefined,
      });
      for await (const delta of iter) {
        if (signal.aborted) break;
        received++;
        this.currentText += delta;
        bus.emit(EV.AI_STREAM_DELTA, { delta, text: this.currentText, sid });
      }
    } catch (err) {
      if (err.name === 'AbortError' || signal.aborted) {
        // expected on Stop
      } else {
        errored = err;
      }
    } finally {
      const aborted = signal.aborted;
      this.memory.updateLastAssistant(this.currentText);
      this.streaming = false;
      this.controller = null;
      state.set({ aiStreaming: false, aiCanContinue: aborted || (!!this.currentText && !errored) });

      if (errored) {
        console.error('[ai] stream failed', errored);
        // Hybrid routing: if the LOCAL model failed, retry on the cloud
        // provider before giving up — the user shouldn't feel the difference.
        if (viaOllama) {
          bus.emit(EV.LOG, { text: `Local model failed (${errored.message}) — escalating to ${this.providerLabel}` });
          this.memory.updateLastAssistant('');
          return this._runRemoteStream(messages, { append, viaOllama: false });
        }
        bus.emit(EV.AI_ERROR, { error: errored, message: errored.message, provider: providerId });
        // Honest fallback: tell the user, then answer with the local core.
        const note = `⚠ **${this.providerLabel} failed:** ${errored.message}\n\nFalling back to my offline core for this reply.`;
        this.currentText = this.currentText ? `${this.currentText}\n\n${note}` : note;
        this.memory.updateLastAssistant(this.currentText);
        bus.emit(EV.AI_STREAM_DELTA, { delta: note, text: this.currentText });
        bus.emit(EV.AI_STREAM_END, { text: this.currentText, aborted: false, error: true });

        const q = this.memory.lastUser()?.content;
        if (q) {
          const res = localRespond(q, {
            history: this.memory.all(), memory: this.memory.facts,
            vision: this.visionContext || {}, status: state.get(),
          });
          await this._streamLocalText(res.text, { emotion: res.emotion });
        }
        return;
      }

      // Measured throughput beats parameter-count guesses — feed it back.
      if (providerId === 'ollama' && modelForTurn && this._genStart && this.currentText) {
        this.models.recordPerformance(modelForTurn,
          this.currentText.length - startText.length, Date.now() - this._genStart);
      }

      bus.emit(aborted ? EV.AI_STREAM_ABORT : EV.AI_STREAM_END, {
        text: this.currentText, aborted, reason: this._stopReason, chunks: received, sid, canContinue: true,
      });
      bus.emit(EV.AI_MEMORY_UPDATED, { count: this.memory.all().length });

      // The model may have asked for a desktop action. Strip the block from
      // the visible transcript, then dispatch it through the Action Manager.
      if (!aborted && this.desktop?.initialized) {
        // Prefer the canonical ```tool protocol; fall back to the older
        // ```action blocks so existing prompts keep working.
        const t = extractToolCalls(this.currentText);
        if (t.hadCall) {
          this.memory.updateLastAssistant(t.cleanText);
          bus.emit('ai:tool-call', { calls: t.calls, cleanText: t.cleanText });
          for (const call of t.calls) {
            const result = await this.executeToolCall(call, 'ai');
            await this._reportToolResult(call, result);
          }
        } else {
          const { actions, cleanText, hadAction } = extractActions(this.currentText);
          if (hadAction) {
            this.memory.updateLastAssistant(cleanText);
            bus.emit('ai:action-block', { actions, cleanText });
            for (const a of actions) await this._runDesktopAction(a, 'ai');
          }
        }
      }
    }
  }

  /**
   * Pull the installed-model list from Ollama and profile each one.
   * Uses /api/ollama/status (proxied) so no CORS configuration is needed.
   */
  async refreshModelRegistry() {
    try {
      const r = await fetch('/api/ollama/status', { cache: 'no-store' });
      const j = await r.json();
      if (!j.running) { ollama.installed = []; ollama.models = []; ollama.defaultModel = null; return 0; }
      const raw = (j.models || []).map(m => ({
        name: m.name, size: m.size_gb ? m.size_gb * 1e9 : null,
        details: { parameter_size: m.params, family: m.family },
        // Ollama's own capability report (/api/show). Ground truth — the
        // registry trusts it over any name-based inference.
        caps: Array.isArray(m.caps) ? m.caps : [],
      }));
      // Keep the provider adapter's view of reality in sync with the
      // registry's, so resolveModel() always has the true installed list.
      ollama.installed = raw.map(m => m.name);
      ollama.caps = Object.fromEntries(raw.filter(m => m.caps.length).map(m => [m.name, m.caps]));
      ollama.models = ollama.installed;
      ollama.defaultModel = ollama.installed[0] || null;
      ollama._discoveredAt = Date.now();
      const n = this.models.ingest(raw);
      bus.emit('ai:models-discovered', this.models.report());
      return n;
    } catch { return 0; }
  }

  /** Connectivity self-test used by Settings → Test Connection. */
  /**
   * @param {string} providerId
   * @param {{model?:string, key?:string, baseUrl?:string}} [opts]
   */
  async testConnection(providerId, { model, key, baseUrl } = {}) {
    const p = getProvider(providerId);
    if (!p) return { ok: false, message: 'Unknown provider' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      let text = '';
      const iter = p.stream({
        messages: [
          { role: 'system', content: 'Reply with exactly: AURA ONLINE' },
          { role: 'user', content: 'Connectivity test.' },
        ],
        model: model || p.defaultModel,
        key: key ?? config.getKey(providerId),
        signal: ctrl.signal,
        temperature: 0,
        maxTokens: 24,
        baseUrlOverride: baseUrl,
      });
      for await (const d of iter) { text += d; if (text.length > 80) break; }
      clearTimeout(timer);
      return { ok: true, message: text.trim() || '(empty response)' };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, message: e.message };
    }
  }
}

export default AIEngine;
