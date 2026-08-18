/**
 * AURA :: Built-in Plugins
 * ------------------------
 * Every one of these is registered through the SAME public PluginRegistry API
 * a third-party plugin would use. Nothing here is special-cased in core.
 * This is the proof that the plugin path actually works.
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';
import { config } from '../core/config.js';
import { evaluateMath, convertUnits, formatNumber } from '../ai/local-core.js';
import { liveData } from '../realtime/live-data.js';

export function registerBuiltins(registry, ctx) {
  const { ai, vision, voice, avatar, audio, ui } = ctx;

  /* ── help ──────────────────────────────────────────────────────── */
  registry.register({
    id: 'help', name: 'Help', description: 'Lists every available command.',
    commands: [{
      name: 'help', aliases: ['commands', '?'], usage: '/help',
      help: 'Show all commands',
      run: async (_args, c) => {
        const cmds = registry.listCommands();
        const lines = cmds.map(x => `\`${x.usage}\` — ${x.help}`).join('\n');
        return `**AURA COMMAND REGISTRY** (${cmds.length} commands from ${registry.plugins.size} plugins)\n\n${lines}\n\n_Gestures:_ wave → greeting · open palm → listen · thumbs up → confirm · peace → chat · point → highlight`;
      },
    }],
  });

  /* ── clock ─────────────────────────────────────────────────────── */
  registry.register({
    id: 'clock', name: 'Clock', description: 'Time, date and timers.',
    commands: [
      {
        name: 'time', usage: '/time', help: 'Current time and date',
        run: async () => {
          const n = new Date();
          return `**${n.toLocaleTimeString()}** — ${n.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\nTimezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
        },
      },
      {
        name: 'timer', usage: '/timer <seconds> [label]', help: 'Set a countdown that really fires',
        run: async (args) => {
          const m = /^(\d+)\s*(.*)$/.exec(args.trim());
          if (!m) return 'Usage: `/timer 60 tea`';
          const secs = parseInt(m[1], 10);
          if (secs < 1 || secs > 86400) return 'Pick a duration between 1 second and 24 hours.';
          const label = m[2] || 'Timer';
          setTimeout(() => {
            bus.emit(EV.UI_TOAST, { type: 'success', text: `⏰ ${label} — time's up!`, duration: 8000 });
            audio?.sfx('confirm');
            voice?.output?.speak(`${label} complete.`);
          }, secs * 1000);
          return `⏱ Timer armed: **${secs}s** (${label}). I'll announce it out loud.`;
        },
      },
    ],
    context: () => `Current time is ${new Date().toLocaleTimeString()}.`,
  });

  /* ── calculator ────────────────────────────────────────────────── */
  registry.register({
    id: 'calc', name: 'Calculator', description: 'Real expression evaluator and unit converter.',
    commands: [
      {
        name: 'calc', aliases: ['math', '='], usage: '/calc <expression>', help: 'Evaluate math (sqrt, sin, ^, !, pi…)',
        run: async (args) => {
          if (!args) return 'Usage: `/calc (2+3)*sqrt(16)`';
          try { return `\`${args}\` = **${formatNumber(evaluateMath(args))}**`; }
          catch (e) { return `⚠ ${e.message}`; }
        },
      },
      {
        name: 'convert', usage: '/convert <n> <from> <to>', help: 'Convert units (km, lb, °C, GB, mph…)',
        run: async (args) => {
          const p = args.trim().split(/\s+/);
          if (p.length < 3) return 'Usage: `/convert 10 km miles`';
          const v = parseFloat(p[0]);
          if (!Number.isFinite(v)) return 'First argument must be a number.';
          const r = convertUnits(v, p[1], p.slice(2).join(' ').replace(/^(to|in)\s+/, ''));
          return r ? `**${r.text}**` : `I can't convert ${p[1]} → ${p[2]}. Supported: length, mass, time, data, speed, area, volume, temperature.`;
        },
      },
    ],
  });

  /* ── vision ────────────────────────────────────────────────────── */
  registry.register({
    id: 'vision', name: 'Vision', description: 'Camera control and scene description.',
    commands: [
      {
        name: 'see', aliases: ['look', 'scene'], usage: '/see', help: 'Describe what the camera sees right now',
        run: async () => {
          if (!state.get('cameraActive')) return 'Camera is offline. Run `/camera on` first.';
          const s = vision.publishScene();
          return s.description || 'Nothing detected in the current frame.';
        },
      },
      {
        name: 'camera', usage: '/camera on|off', help: 'Toggle the webcam',
        run: async (args) => {
          const on = /on|start|enable/i.test(args) || (!args && !state.get('cameraActive'));
          if (on) {
            await ui.enableVision();
            return 'Camera online. Hand and face tracking active.';
          }
          vision.disable();
          return 'Camera offline.';
        },
      },
      {
        name: 'objects', usage: '/objects on|off', help: 'Toggle object detection (heavier model)',
        run: async (args) => {
          const on = /on|start|enable/i.test(args) || (!args && !state.get('objectsActive'));
          if (on) {
            if (!state.get('cameraActive')) await ui.enableVision();
            await vision.loadObjects();
            config.set('objectDetection', true);
            return 'Object detection online — EfficientDet-Lite0, 80 COCO classes.';
          }
          await vision.unloadObjects();
          config.set('objectDetection', false);
          return 'Object detection disabled.';
        },
      },
      {
        name: 'look', aliases: ['see', 'whatdoyousee'], usage: '/look [question]',
        help: 'Send the camera frame to a vision model and ask about it',
        run: async (args, c) => {
          if (!state.get('cameraActive')) {
            return 'The camera is off. Turn it on in the VISION panel, then `/look` again.';
          }
          const frame = vision.snapshot();
          if (!frame) return 'No video frame available yet — give the camera a moment.';
          c.ui?.setCaption?.('Looking…');
          const r = await c.ai.askAboutImage(args || '', frame);
          // On success the answer streams in; only report failures here.
          return r.ok ? null : r.message;
        },
      },
      {
        name: 'snapshot', usage: '/snapshot', help: 'Capture the current frame with overlays',
        run: async () => {
          const url = vision.snapshot();
          if (!url) return 'No video frame available — is the camera on?';
          const a = document.createElement('a');
          a.href = url;
          a.download = `aura-snapshot-${Date.now()}.png`;
          a.click();
          return 'Snapshot captured and downloaded.';
        },
      },
    ],
    context: () => {
      if (!state.get('cameraActive')) return 'Camera is currently OFF.';
      const s = vision.describeScene();
      return s.description;
    },
  });

  /* ── voice ─────────────────────────────────────────────────────── */
  registry.register({
    id: 'voice', name: 'Voice', description: 'Speech input/output control.',
    commands: [
      {
        name: 'say', usage: '/say <text>', help: 'Speak text aloud',
        run: async (args) => {
          if (!args) return 'Usage: `/say Hello Commander`';
          voice.output.speak(args);
          return `🔊 Speaking: "${args}"`;
        },
      },
      {
        name: 'mute', usage: '/mute', help: 'Disable speech output',
        run: async () => { config.set('ttsEnabled', false); voice.output.cancel('mute'); ui.syncToggles(); return 'Voice output muted.'; },
      },
      {
        name: 'unmute', usage: '/unmute', help: 'Enable speech output',
        run: async () => { config.set('ttsEnabled', true); ui.syncToggles(); return 'Voice output enabled.'; },
      },
      {
        name: 'listen', usage: '/listen', help: 'Start speech recognition',
        run: async () => {
          if (!voice.input.supported) return `⚠ ${voice.input.unsupportedReason}`;
          const ok = await voice.input.start('command');
          return ok ? 'Listening…' : '⚠ Could not start the microphone — see the toast for why.';
        },
      },
      {
        name: 'voices', usage: '/voices', help: 'List available TTS voices',
        run: async () => {
          const vs = voice.output.listVoices();
          if (!vs.length) return 'No TTS voices reported by this browser yet — try again in a moment.';
          const cur = voice.output.pickVoice();
          return `**${vs.length} voices available** (current: ${cur?.name || 'default'})\n\n` +
            vs.slice(0, 25).map(v => `• ${v.name} — ${v.lang}${v.default ? ' (default)' : ''}`).join('\n');
        },
      },
      {
        name: 'wake', usage: '/wake on|off', help: 'Toggle wake-word listening',
        run: async (args) => {
          const on = /on|enable/i.test(args) || (!args && !state.get('wakeWordActive'));
          return ui.setWakeWord(on);
        },
      },
    ],
  });

  /* ── system ────────────────────────────────────────────────────── */
  registry.register({
    id: 'system', name: 'System', description: 'Diagnostics, memory, theme, AI core.',
    commands: [
      {
        name: 'status', aliases: ['diag', 'sys'], usage: '/status', help: 'Full system diagnostic',
        run: async () => {
          const s = state.get();
          const line = (k, v, ok) => `${ok ? '🟢' : '⚪'} **${k}** — ${v}`;
          return `**AURA SYSTEM DIAGNOSTIC**\n\n` + [
            line('AI Core', `${ai.providerLabel}${s.aiModel ? ` · ${s.aiModel}` : ''}`, true),
            line('Camera', s.cameraActive ? 'online' : 'offline', s.cameraActive),
            line('Hand tracking', s.handsActive ? `online · ${s.handCount} hand(s)` : 'not loaded', s.handsActive),
            line('Face tracking', s.faceActive ? `online · ${s.faceCount} face(s)` : 'not loaded', s.faceActive),
            line('Object detection', s.objectsActive ? `online · ${s.objectCount} object(s)` : 'off', s.objectsActive),
            line('Vision FPS', `${s.visionFps}`, s.visionFps > 0),
            line('Speech input', s.sttSupported ? (s.sttActive ? 'listening' : 'ready') : 'unsupported in this browser', s.sttSupported),
            line('Speech output', s.ttsSupported ? (config.get('ttsEnabled') ? 'enabled' : 'muted') : 'unsupported', s.ttsSupported && config.get('ttsEnabled')),
            line('Wake word', s.wakeWordActive ? `active ("${config.get('wakeWord')}")` : 'off', s.wakeWordActive),
            line('Avatar', `${s.avatarMode.toUpperCase()} · ${s.fps} FPS · ${s.avatarEmotion}`, true),
            line('Audio engine', audio?.running ? 'running' : 'idle', !!audio?.running),
            line('AR', s.arMode ? 'active' : 'inactive', s.arMode),
            line('Memory', `${ai.memory.all().length} messages`, true),
            line('Plugins', `${registry.plugins.size} loaded · ${registry.listCommands().length} commands`, true),
          ].join('\n');
        },
      },
      {
        name: 'clear', aliases: ['reset'], usage: '/clear', help: 'Wipe conversation memory',
        run: async () => { ai.clear(); ui.clearTranscript(); return 'Memory cleared.'; },
      },
      {
        name: 'memory', usage: '/memory', help: 'Show what I remember',
        run: async () => {
          const msgs = ai.memory.all();
          const facts = ai.memory.facts;
          const factStr = Object.keys(facts).length ? Object.entries(facts).map(([k, v]) => `• ${k}: ${v}`).join('\n') : '• (none yet)';
          return `**MEMORY STATE**\n\nRetained messages: ${msgs.length} (rolling window: ${config.get('memoryTurns')} turns)\n\n**Facts:**\n${factStr}\n\n**Recent:**\n${msgs.slice(-6).map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content.slice(0, 80)}${m.content.length > 80 ? '…' : ''}`).join('\n') || '(empty)'}`;
        },
      },
      {
        name: 'export', usage: '/export', help: 'Download the conversation as a text file',
        run: async () => {
          const text = ai.memory.export();
          if (!text) return 'Nothing to export yet.';
          const blob = new Blob([`AURA CONVERSATION LOG\n${new Date().toISOString()}\n\n${text}`], { type: 'text/plain' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `aura-log-${Date.now()}.txt`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          return 'Conversation exported.';
        },
      },
      {
        name: 'theme', usage: '/theme [name]', help: 'Switch theme (blue, amber, crimson, emerald, violet)',
        run: async (args) => {
          const themes = ui.themeNames();
          if (!args) { const t = ui.cycleTheme(); return `Theme → **${t}**. Available: ${themes.join(', ')}`; }
          const want = args.trim().toLowerCase();
          const found = themes.find(t => t.includes(want));
          if (!found) return `Unknown theme. Available: ${themes.join(', ')}`;
          ui.setTheme(found);
          return `Theme → **${found}**`;
        },
      },
      {
        name: 'provider', aliases: ['ai'], usage: '/provider [name]', help: 'Show or switch the AI backend',
        run: async (args) => {
          if (!args) {
            return `**Active AI core:** ${ai.providerLabel}${state.get('aiModel') ? ` · ${state.get('aiModel')}` : ''}\n\n` +
              `Available: local, openai, anthropic, gemini, groq, openrouter, ollama\n` +
              `Set keys in **Settings → AI Core**, or use \`/provider ollama\`.`;
          }
          const want = args.trim().toLowerCase();
          config.set('provider', want);
          await ai.resolve();
          return `AI core → **${ai.providerLabel}**${state.get('aiModel') ? ` · ${state.get('aiModel')}` : ''}`;
        },
      },
      {
        name: 'plugins', usage: '/plugins', help: 'List loaded plugins',
        run: async () => {
          const list = registry.list();
          return `**${list.length} PLUGINS LOADED**\n\n` + list.map(p =>
            `**${p.name}** \`${p.id}\` — ${p.description}${p.commands.length ? `\n   ↳ ${p.commands.map(c => '/' + c.name).join(', ')}` : ''}`
          ).join('\n\n');
        },
      },
      {
        name: 'selftest', usage: '/selftest', help: 'Run live subsystem checks',
        run: async () => ui.runSelfTest(),
      },
    ],
  });

  /* ── web research (real: ddgs + trafilatura via serve.py) ───────── */
  registry.register({
    id: 'search', name: 'Web Search',
    description: 'Searches the web and reads the pages, then reasons over them locally.',
    commands: [{
      name: 'search', aliases: ['google', 'research'], usage: '/search <query>',
      help: 'Search the web and summarise the results',
      run: async (args, c) => {
        const q = (args || '').trim();
        if (!q) return 'Usage: `/search how do transformers work`';
        const bridge = c.ui?.actions;

        // No local server → fall back to opening a tab, and say so.
        if (!bridge?.available) {
          const url = `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
          window.open(url, '_blank', 'noopener');
          return `🔎 Opened a search for **${q}** in a new tab.\n\n`
               + `_Run AURA with \`python serve.py --allow-actions\` and I can search and read the pages myself._`;
        }

        const caps = await bridge.webCapabilities();
        if (!caps.search) {
          const url = `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
          window.open(url, '_blank', 'noopener');
          return `🔎 Opened a tab for **${q}**.\n\n⚠ ${caps.reason}`;
        }

        c.ui?.setCaption?.('Searching…');
        const depth = config.get('webSearchDepth') === 'adaptive'
          ? undefined : config.get('webSearchDepth');
        const r = await bridge.webResearch(q, { depth });
        if (!r.ok) return `✗ ${r.message || 'Search failed.'}`;

        const srcList = (r.sources || []).slice(0, 5)
          .map(s => `${s.n}. [${s.title}](${s.url})`).join('\n');

        // With a model available, let it reason over the retrieved text.
        if (c.ai && c.ai.resolvedProvider !== 'local') {
          c.ai.pendingResearch = { query: q, context: r.context, sources: r.sources };
          await c.ai.send(
            `Using ONLY the search results below, answer: ${q}\n\n`
            + `Cite sources as [1], [2] etc. If the results do not answer it, say so.\n\n`
            + `${r.context}`,
            { silent: true });
          return null;   // the streamed reply is the answer
        }

        // Offline core: present what was found rather than pretending to reason.
        const head = r.readCount
          ? `🔎 Read ${r.readCount} page${r.readCount > 1 ? 's' : ''} for **${q}**`
          : `🔎 Found ${r.results.length} result${r.results.length > 1 ? 's' : ''} for **${q}**`;
        const body = (r.results || []).slice(0, 5)
          .map((x, i) => `**${i + 1}. ${x.title}**\n${x.snippet}\n${x.url}`).join('\n\n');
        return `${head}\n\n${body}\n\n_Connect a language model and I'll summarise these instead of listing them._`;
      },
    }],
  });

  /**
   * Run a one-step automation plan: preview it, ask, then execute.
   *
   * WHY THE CONFIRM STEP SURVIVES EVEN FOR ONE STEP: these commands move a
   * REAL mouse and type into whatever window happens to be focused. A typo
   * in a coordinate is a click somewhere unintended. The server refuses an
   * unconfirmed plan anyway (`confirmed=false` → `needsConfirm`), so this
   * mirrors the rule rather than inventing a client-side one.
   *
   * @param {object} c   plugin context
   * @param {Array<object>} plan
   * @returns {Promise<string>} message for the chat
   */
  async function runPlan(c, plan) {
    const A = c.ui?.actions;
    if (!A?.available) {
      return '⚠ No action bridge. Restart AURA with:\n```\npython serve.py --allow-actions\n```';
    }
    // 1. Validate + describe WITHOUT touching the mouse.
    const dry = await A.automationDryRun(plan);
    if (!dry.ok) {
      return `⚠ ${dry.message || 'Plan rejected.'}`;
    }
    // 2. Is it even armed? Say so before asking the user to approve.
    const cap = await A.automationCapabilities();
    if (!cap.available) {
      return `⚠ **Input automation unavailable**\n\n${cap.reason}\n\n\`\`\`\npip install pyautogui\n\`\`\``;
    }
    if (!cap.armed) {
      return `🔒 **Not armed.** This plan would:\n\n${dry.description.join('\n')}\n\n`
        + 'Arm it first with `/automation arm`, or Settings → Desktop → Input Automation.';
    }
    // 3. Explicit approval, showing exactly what will happen.
    const approved = (typeof confirm === 'function')
      ? confirm(`AURA is about to control your mouse/keyboard:\n\n${dry.description.join('\n')}\n\n`
              + 'Kill switch: slam the pointer into the TOP-LEFT corner.\n\nProceed?')
      : false;
    if (!approved) return '⚪ Cancelled — nothing was clicked or typed.';

    const r = await A.automationRun(plan, true);
    if (!r.ok) return `⚠ ${r.message}`;
    return `✅ ${r.message || 'Done.'}\n\n_${dry.description.join(' · ')}_`;
  }

  /* ── desktop control ───────────────────────────────────────────── */
  registry.register({
    id: 'desktop', name: 'Desktop Control',
    description: 'Opens real apps and controls media on the machine running serve.py.',
    commands: [
      {
        name: 'open', usage: '/open <app|url>', help: 'Launch an app or website',
        run: async (args, c) => {
          const A = c.ui.actions;
          if (!args) {
            const list = A.available
              ? A.installedApps().map(a => `${a.installed ? '🟢' : '🌐'} ${a.id}`).join(' · ')
              : '(bridge offline)';
            return `Usage: \`/open whatsapp\`\n\nAvailable:\n${list}`;
          }
          const q = args.trim().toLowerCase();
          const res = /^[\w-]+(\.[\w-]+)+/.test(q) ? await A.openUrl(q) : await A.openApp(q);
          return res.ok ? `✅ ${res.message}` : `⚠ ${res.message}`;
        },
      },
      {
        name: 'apps', usage: '/apps', help: 'List launchable apps detected on this machine',
        run: async (_a, c) => {
          const A = c.ui.actions;
          if (!A.available) return A.disabledReason;
          await A.refreshApps();
          const inst = A.apps.filter(a => a.installed);
          const web = A.apps.filter(a => !a.installed && a.hasWeb);
          return `**DETECTED ON ${A.os.toUpperCase()}**\n\n` +
            `**Installed (${inst.length}):**\n${inst.map(a => `🟢 \`${a.id}\` — ${a.label}`).join('\n') || '_none detected_'}\n\n` +
            `**Web fallback (${web.length}):**\n${web.map(a => `🌐 \`${a.id}\` — ${a.label}`).join('\n')}`;
        },
      },
      {
        name: 'media', usage: '/media play|next|prev', help: 'Control media playback',
        run: async (args, c) => {
          const map = { play: 'playpause', pause: 'playpause', next: 'next', prev: 'previous', previous: 'previous' };
          const a = map[(args || 'play').trim().toLowerCase()];
          if (!a) return 'Usage: `/media play|pause|next|prev`';
          const r = await c.ui.actions.media(a);
          return r.ok ? `✅ ${r.message}` : `⚠ ${r.message}`;
        },
      },
      {
        name: 'volume', usage: '/volume <0-100|up|down|mute>', help: 'Set system volume',
        run: async (args, c) => {
          const v = (args || '').trim().toLowerCase();
          if (!v) return 'Usage: `/volume 50` or `/volume up`';
          const r = await c.ui.actions.volume(/^\d+$/.test(v) ? parseInt(v, 10) : v);
          return r.ok ? `✅ ${r.message}` : `⚠ ${r.message}`;
        },
      },
      {
        name: 'screen', aliases: ['grab'], usage: '/screen', help: 'Screenshot the desktop',
        run: async (_a, c) => {
          const r = await c.ui.actions.screenshot();
          return r.ok ? `✅ ${r.message}` : `⚠ ${r.message}`;
        },
      },

      /* ── input automation ───────────────────────────────────────────
       * The engine (automation.py) and the Settings panel both existed,
       * but nothing in the chat could reach automation_dry_run /
       * automation_run — so a plan could be armed and never executed.
       * These commands are that missing link. Safety is unchanged and
       * still enforced server-side: armed + validated + confirmed.
       */
      {
        name: 'automation', aliases: ['auto'], usage: '/automation [arm|disarm|status]',
        help: 'Check, arm or disarm mouse + keyboard control',
        run: async (args, c) => {
          const A = c.ui?.actions;
          if (!A?.available) {
            return '⚠ No action bridge. Restart AURA with:\n```\npython serve.py --allow-actions\n```';
          }
          const sub = (args || 'status').trim().toLowerCase();
          if (sub === 'arm') {
            const r = await A.automationArm();
            return r.ok ? `✅ ${r.message}` : `⚠ ${r.message}`;
          }
          if (sub === 'disarm') {
            const r = await A.automationDisarm();
            return `✅ ${r.message || 'Disarmed.'}`;
          }
          const cap = await A.automationCapabilities();
          if (!cap.available) {
            return `⚠ **Input automation unavailable**\n\n${cap.reason}\n\n`
              + 'Install it, then restart AURA:\n```\npip install pyautogui\n```';
          }
          return `**INPUT AUTOMATION**\n\n`
            + `• Status: ${cap.armed ? '🟢 ARMED' : '⚪ disarmed'}\n`
            + (cap.screen ? `• Screen: ${cap.screen.width}×${cap.screen.height}\n` : '')
            + `• Limits: ${cap.maxSteps} steps per plan · arming lapses after ${Math.round(cap.armTtlSeconds / 60)} min\n`
            + `• Plans run: ${cap.runs}\n\n`
            + `🛑 ${cap.failsafe}\n\n`
            + (cap.armed
              ? 'Ready. Try `/click 500 300`, `/type hello`, or `/hotkey ctrl+s`.'
              : 'Arm it with `/automation arm` (or Settings → Desktop → Input Automation).');
        },
      },
      {
        name: 'cursor', usage: '/cursor', help: 'Where is the mouse pointer right now?',
        run: async (_a, c) => {
          const A = c.ui?.actions;
          if (!A?.available) return '⚠ Needs `--allow-actions`.';
          const r = await A.automationCursor();
          return r.ok
            ? `🖱 Pointer is at **(${r.x}, ${r.y})**.`
            : `⚠ ${r.message}`;
        },
      },
      {
        name: 'click', usage: '/click <x> <y> [right|double]',
        help: 'Click a screen coordinate (real mouse)',
        run: async (args, c) => {
          const m = /^\s*(-?\d+)[\s,]+(-?\d+)\s*(right|double)?\s*$/i.exec(args || '');
          if (!m) return 'Usage: `/click 640 480`  ·  `/click 640 480 right`  ·  `/click 640 480 double`\n\nUse `/cursor` to find a coordinate.';
          const op = m[3]?.toLowerCase() === 'right' ? 'right_click'
            : m[3]?.toLowerCase() === 'double' ? 'double_click' : 'click';
          return runPlan(c, [{ op, x: +m[1], y: +m[2] }]);
        },
      },
      {
        name: 'type', usage: '/type <text>', help: 'Type text into the focused window',
        run: async (args, c) => {
          if (!args?.trim()) return 'Usage: `/type Hello Commander`\n\nText is typed literally — it can never contain key combinations. Use `/hotkey` for those.';
          return runPlan(c, [{ op: 'type', text: args }]);
        },
      },
      {
        name: 'hotkey', usage: '/hotkey <combo>', help: 'Press a key combination, e.g. ctrl+s',
        run: async (args, c) => {
          if (!args?.trim()) return 'Usage: `/hotkey ctrl+s`  ·  `/hotkey alt+tab`\n\nDangerous combos (alt+f4, ctrl+alt+del, win+r…) are permanently blocked.';
          return runPlan(c, [{ op: 'hotkey', keys: args.trim() }]);
        },
      },
      {
        name: 'press', usage: '/press <key>', help: 'Press a single key, e.g. enter',
        run: async (args, c) => {
          if (!args?.trim()) return 'Usage: `/press enter`  ·  `/press tab`  ·  `/press esc`';
          return runPlan(c, [{ op: 'press', key: args.trim() }]);
        },
      },
      {
        name: 'scroll', usage: '/scroll <amount>', help: 'Scroll up (+) or down (-)',
        run: async (args, c) => {
          const n = parseInt(args, 10);
          if (Number.isNaN(n)) return 'Usage: `/scroll 3` (up) · `/scroll -3` (down)';
          return runPlan(c, [{ op: 'scroll', amount: n }]);
        },
      },
    ],
    context: (c) => {
      const A = c.ui?.actions;
      if (!A?.available) return 'Desktop control is OFF (no local action bridge).';
      const names = A.apps.filter(a => a.installed).map(a => a.id).slice(0, 12).join(', ');
      return `Desktop control is ON (${A.os}). You can really open apps. Installed: ${names || 'none detected'}. To act, tell the user to say e.g. "open whatsapp" — do not claim you opened anything yourself.`;
    },
  });

  /* ── live data ─────────────────────────────────────────────────── */
  registry.register({
    id: 'live', name: 'Live Data',
    description: 'Real-time weather, news, markets and Wikipedia. Toggle off for full offline.',
    commands: [
      { name: 'weather', aliases: ['w'], usage: '/weather [city]', help: 'Current conditions + 3-day forecast',
        run: async (a) => { const r = await liveData.weather(a || null); return r.ok ? r.markdown : `⚠ ${r.message}`; } },
      { name: 'news', usage: '/news [tech|world|india|business|science]', help: 'Latest headlines',
        run: async (a) => { const r = await liveData.news(a || 'top'); return r.ok ? r.markdown : `⚠ ${r.message}`; } },
      { name: 'crypto', aliases: ['price'], usage: '/crypto [coin...]', help: 'Live crypto prices',
        run: async (a) => { const c = a ? a.split(/[\s,]+/) : ['bitcoin', 'ethereum'];
          const r = await liveData.crypto(c); return r.ok ? r.markdown : `⚠ ${r.message}`; } },
      { name: 'fx', aliases: ['rate'], usage: '/fx <amt> <FROM> <TO>', help: 'Currency conversion at live rates',
        run: async (a) => { const p = (a || '1 USD INR').trim().split(/\s+/);
          const amt = parseFloat(p[0]); const hasAmt = Number.isFinite(amt);
          const r = await liveData.currency(hasAmt ? p[1] : p[0], hasAmt ? p[2] : p[1], hasAmt ? amt : 1);
          return r.ok ? r.markdown : `⚠ ${r.message}`; } },
      { name: 'wiki', usage: '/wiki <topic>', help: 'Wikipedia summary',
        run: async (a) => { if (!a) return 'Usage: `/wiki quantum computing`';
          const r = await liveData.wiki(a); return r.ok ? r.markdown : `⚠ ${r.message}`; } },
      { name: 'offline', usage: '/offline [on|off]', help: 'Toggle full offline mode',
        run: async (a) => {
          const wantOffline = a ? /on|true|yes/i.test(a) : (config.get('liveData') !== false);
          config.set('liveData', !wantOffline);
          ui.syncToggles?.(); ui.renderConnectStatus?.();
          return wantOffline
            ? '🔒 **Offline mode ON.** No internet lookups — local model and offline core only.'
            : '🌐 **Live data ON.** Weather, news, markets and Wikipedia available.';
        } },
    ],
  });

  /* ── wardrobe ──────────────────────────────────────────────────── */
  registry.register({
    id: 'style', name: 'Avatar Style', description: 'Change the avatar outfit, colour and accessories.',
    commands: [
      { name: 'outfit', usage: '/outfit <name>', help: 'Change clothing (suit, jacket, hoodie, armor, labcoat, formal)',
        run: async (a, c) => {
          const av = c.ui.avatar;
          if (!av?.applyOutfit) return 'Switch to the **full body** avatar first (Wardrobe → Form).';
          const { OUTFITS } = await import('../avatar/outfits.js');
          if (!a) return `Outfits: ${Object.keys(OUTFITS).join(', ')}`;
          const id = Object.keys(OUTFITS).find(k => k.includes(a.trim().toLowerCase()));
          if (!id) return `Unknown outfit. Options: ${Object.keys(OUTFITS).join(', ')}`;
          av.applyOutfit(id); c.ui.syncWardrobe();
          return `👕 Outfit → **${OUTFITS[id].label}**`;
        } },
      { name: 'color', aliases: ['colour', 'palette'], usage: '/color <name>', help: 'Change avatar colour',
        run: async (a, c) => {
          const av = c.ui.avatar;
          const { PALETTES } = await import('../avatar/outfits.js');
          if (!a) return `Colours: ${Object.keys(PALETTES).join(', ')}`;
          const id = Object.keys(PALETTES).find(k => k.includes(a.trim().toLowerCase()));
          if (!id) return `Unknown colour. Options: ${Object.keys(PALETTES).join(', ')}`;
          av.applyOutfit?.(null, id); c.ui.syncWardrobe();
          return `🎨 Colour → **${PALETTES[id].label}**`;
        } },
    ],
  });

  /* ── AR ────────────────────────────────────────────────────────── */
  registry.register({
    id: 'ar', name: 'AR Projection', description: 'WebXR augmented reality, with a camera-passthrough fallback.',
    commands: [{
      name: 'ar', usage: '/ar', help: 'Enter AR mode',
      run: async () => ui.toggleAR(),
    }],
  });
}

export default registerBuiltins;
