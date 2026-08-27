/**
 * AURA :: Screen Awareness plugin
 * -------------------------------
 * Commands for the Copilot-Vision-style workflow: share a surface, ask about
 * it, and act on it.
 *
 *   /watch              start sharing (browser shows the picker)
 *   /watch stop         stop
 *   /watch ask <q>      one question about the current screen
 *   /screenmode         vision | ocr | auto
 *   /find <text>        locate a UI element, park the pointer on it
 *   /do <instruction>   plan an ordered set of UI actions, preview, confirm
 *
 * Every command reports honestly when a prerequisite is missing rather than
 * appearing to work.
 *
 * @module plugins/screen
 */

import { ScreenAgent } from '../ai/screen-agent.js';
import { Trace } from '../core/trace.js';
import { TaskAgent, describeAction } from '../ai/task-agent.js';

/**
 * @param {any} registry
 * @param {any} ctx  plugin context (ai, ui, config, state…)
 */
export function registerScreenPlugin(registry, ctx) {
  // The ScreenShare instance is supplied by the composition root rather than
  // imported here: a plugin (layer 5) must not reach down into the vision
  // layer (layer 6) directly. See tests/test-architecture.mjs.
  const screenShare = ctx.screenShare;
  const screenCursor = ctx.screenCursor;
  /** @type {ScreenAgent|null} */
  let agent = null;
  const getAgent = () => {
    if (!agent) {
      agent = new ScreenAgent({
        screen: screenShare,
        ai: ctx.ai,
        actions: ctx.ui?.actions,
        config: ctx.config,
        cursor: screenCursor,
      });
      if (ctx.ui) ctx.ui.screenAgent = agent;
    }
    return agent;
  };
  if (ctx.ui) ctx.ui.screenShare = screenShare;

  registry.register({
    id: 'screen',
    name: 'Screen Awareness',
    description: 'Share a tab, window or screen with AURA and ask about it.',
    commands: [
      {
        name: 'watch', aliases: ['share', 'screenshare'],
        usage: '/watch [stop|status|ask <question>]',
        help: 'Share a tab/window/screen with AURA and ask about it',
        run: async (args, c) => {
          const a = (args || '').trim();
          const sub = a.split(/\s+/)[0]?.toLowerCase() || '';
          const rest = a.slice(sub.length).trim();

          if (sub === 'stop' || sub === 'off') {
            return `⏹ ${screenShare.stop().message}`;
          }

          if (sub === 'status') {
            const s = getAgent().status();
            if (!s.screen.supported) return '⚠ This browser cannot capture the screen.';
            if (!s.screen.active) {
              return '⚪ **Not sharing.** Run `/watch` and pick a tab, window or entire screen.';
            }
            const ocr = s.ocrModel;
            return `**SCREEN SHARE**\n\n`
              + `• Sharing: ${s.screen.description}\n`
              + `• Size: ${s.screen.geometry?.width}×${s.screen.geometry?.height}\n`
              + `• Clicking: ${s.screen.clickable ? '🟢 available (full screen shared)' : '⚪ unavailable — share an entire screen to enable `/find` and `/do`'}\n`
              + `• Watching: ${s.screen.watching ? `yes, every ${(s.screen.intervalMs / 1000).toFixed(1)}s` : 'no'}\n`
              + `• Frames grabbed: ${s.screen.frames}\n`
              + `• Mode: **${s.mode}** (change with \`/screenmode\`)\n`
              + `• Reader model: ${ocr ? `\`${ocr.name}\` — ${ocr.reason}` : '⚠ none installed'}\n`
              + (ocr?.weak
                ? '\n⚠ **That model reads pictures but barely produces text.** Measured on a real '
                  + 'machine: 28s for 23 characters, then 40s for none at all. Install a real '
                  + 'reader:\n```\nollama pull qwen2.5vl:7b\n```\n' : '')
              + (s.lastMs ? `• Last answer: ${s.lastMode} in ${s.lastMs}ms\n` : '');
          }

          if (sub === 'ask' || sub === 'q') {
            if (!rest) return 'Usage: `/watch ask what does this error mean?`';
            if (!screenShare.active) return '⚠ Not sharing. Run `/watch` first.';
            const t = new Trace(`/watch ask ${rest.slice(0, 40)}`);
            c.ui?.setCaption?.('Reading your screen…');
            const r = await getAgent().ask(rest, { trace: t });
            t.end(r.ok ? 'ok' : 'fail',
                  r.ok ? `${r.mode} path via ${r.model || '?'} in ${r.ms}ms` : r.message);
            return r.ok ? null : `⚠ ${r.message}`;
          }

          // Default: start sharing.
          const r = await screenShare.start();
          if (!r.ok) return `⚠ ${r.message}`;
          const s = getAgent().status();
          return `🖥 **${r.message}**\n\n`
            + `• Ask about it: \`/watch ask <question>\` or \`@screen\`\n`
            + `• ${s.screen.clickable
                ? 'Clicking is available — try `/find Save` or `/do save the file`'
                : '_Clicking is off: you shared a window/tab. Re-share and choose **Entire Screen** to enable `/find` and `/do`._'}\n`
            + `• Reader: ${s.ocrModel ? `\`${s.ocrModel.name}\`` : '⚠ no image model installed'}\n`
            + `• Stop any time from the browser bar, or \`/watch stop\`.`;
        },
      },

      {
        name: 'screenmode', usage: '/screenmode [auto|ocr|vision]',
        help: 'How AURA reads the screen: fast text, full vision, or automatic',
        run: async (args, c) => {
          const m = (args || '').trim().toLowerCase();
          if (!m) {
            const cur = c.config?.get?.('screenMode') || 'auto';
            const s = getAgent().status();
            return `**SCREEN READING MODE: ${cur}**\n\n`
              + '• `auto` — text questions use the fast reader, visual questions use full vision _(default)_\n'
              + '• `ocr` — always transcribe with a small model, then answer with your fast chat model. Lowest latency.\n'
              + '• `vision` — always send the picture to a multimodal model. Highest fidelity, slowest.\n\n'
              + `Reader model: ${s.ocrModel ? `\`${s.ocrModel.name}\` (${s.ocrModel.reason})` : '⚠ none'}\n`
              + `Vision models: ${s.visionModels.length ? s.visionModels.map(x => `\`${x}\``).join(', ') : '⚠ none'}`;
          }
          if (!['auto', 'ocr', 'vision'].includes(m)) {
            return 'Usage: `/screenmode auto` · `/screenmode ocr` · `/screenmode vision`';
          }
          c.config?.set?.('screenMode', m);
          return `✅ Screen reading mode set to **${m}**.`;
        },
      },

      {
        name: 'find', usage: '/find <visible text>',
        help: 'Locate something on the shared screen and park the pointer on it',
        run: async (args, c) => {
          if (!args?.trim()) return 'Usage: `/find Save`  ·  `/find the Send button`';
          if (!screenShare.active) return '⚠ Not sharing a screen. Run `/watch` first.';
          const t = new Trace(`/find ${args.trim()}`);
          c.ui?.setCaption?.('Looking for it…');
          screenCursor?.moveTo(0, 0, { label: 'searching…', mode: 'searching', trail: false });

          const r = await getAgent().locate(args.trim(), { trace: t });
          if (!r.ok) {
            t.end('fail', r.message);
            screenCursor?.hide();
            return `⚠ ${r.message}`;
          }
          t.end('ok', `found at cell ${r.cell}`);

          /*
           * Put the reticle on the REAL DESKTOP, not just the preview canvas.
           * The in-browser marker was the only thing that ever existed before,
           * which is why the user reported never seeing AURA's cursor: it was
           * drawn on a picture of the screen, not on the screen.
           */
          let extra = '';
          if (r.clickable) {
            const ov = await c.ui?.actions?.overlayShow?.(r.x, r.y, { label: args.trim() });
            extra = ov?.ok
              ? `\n\n🟢 **Reticle is on your screen at (${r.x}, ${r.y})** — look at your desktop.`
                + `\n\nClick it with \`/here\`, or \`/click ${r.x} ${r.y}\`.`
              : `\n\nClick it with \`/click ${r.x} ${r.y}\`.`
                + `\n\n_Desktop reticle unavailable: ${ov?.message || 'no action bridge'}_`;
          } else {
            extra = `\n\n_${r.reason}_\nThe marker is on the SCREEN panel preview only.`;
          }
          return `🎯 ${r.message}\n\n_Grid reference is coarse — verify the reticle before clicking._${extra}`;
        },
      },

      {
        name: 'here', usage: '/here [click|doubleclick|rightclick]',
        help: "Click wherever AURA's own cursor is currently pointing",
        run: async (args, c) => {
          const st = screenCursor?.status();
          if (!st?.visible) return "⚠ AURA's cursor is not placed. Run `/find <something>` first.";
          const pt = screenCursor.toScreenPoint();
          if (!pt.ok) return `⚠ ${pt.message}`;
          const A = c.ui?.actions;
          if (!A?.available) return '⚠ No action bridge. Restart with `python serve.py --allow-actions`.';
          const kind = (args || 'click').trim().toLowerCase();
          const op = kind.startsWith('double') ? 'double_click'
            : kind.startsWith('right') ? 'right_click' : 'click';
          const cap = await A.automationCapabilities();
          if (!cap.available) return `⚠ ${cap.reason}`;
          if (!cap.armed) return '🔒 Not armed. Run `/automation arm` first.';
          if (!confirm(`${op.replace('_', ' ')} at (${pt.x}, ${pt.y}) — where AURA's reticle is?`)) {
            return '⚪ Cancelled.';
          }
          const r = await A.automationRun([{ op, x: pt.x, y: pt.y }], true);
          return r.ok ? `✅ ${op.replace('_', ' ')} at (${pt.x}, ${pt.y}).` : `⚠ ${r.message}`;
        },
      },

      {
        name: 'task', aliases: ['agent'], usage: '/task <goal>',
        help: 'Multi-step: opens apps, looks, adapts. e.g. /task open whatsapp and message X',
        run: async (args, c) => {
          const goal = (args || '').trim();
          if (!goal) {
            return 'Usage: `/task open whatsapp and message Fiona Harris saying Hi`\n\n'
              + 'Unlike `/do` (one shot), `/task` runs a loop: it opens apps, takes a fresh '
              + 'screenshot after each action, and adapts. Every step still asks you first.';
          }
          const A = c.ui?.actions;
          if (!A?.available) return '⚠ No action bridge. Restart with `python serve.py --allow-actions`.';
          const cap = await A.automationCapabilities();
          if (!cap.available) return `⚠ ${cap.reason}\n\n\`\`\`\npip install pyautogui\n\`\`\``;
          if (!cap.armed) return '🔒 Not armed. Run `/automation arm` first.';

          const t = new Trace(`/task ${goal.slice(0, 44)}`);
          const [{ validate }, { knowledgeFor, guessApp }] = await Promise.all([
            import('../runtime/command-registry.js'),
            import('../runtime/desktop-knowledge.js'),
          ]);
          const agent = new TaskAgent({
            screen: screenShare, agent: getAgent(), actions: A,
            ai: c.ai, cursor: screenCursor,
            runtime: c.kernel, world: c.world,
            knowledge: { validate, knowledgeFor, guessApp },
          });
          c.ui.taskAgent = agent;

          let autoRest = false;
          const r = await agent.run(goal, {
            trace: t,
            maxSteps: Number(c.config?.get?.('taskMaxSteps')) || 10,
            confirm: async (act, narration) => {
              if (autoRest) return true;
              const ans = confirm(
                `AURA wants to do this:\n\n${narration}\n\n`
                + 'OK = do it   ·   Cancel = stop the whole task\n\n'
                + 'Kill switch: slam the pointer into the TOP-LEFT corner.');
              return ans;
            },
          });
          t.end(r.ok ? 'ok' : 'warn', r.message);

          const log = r.log.map(h => `${h.step}. ${describeAction(h.action)} → ${h.result}`).join('\n');
          return `${r.ok ? '✅' : '⚠'} **${r.message}**\n\n`
            + (log ? `**What it did:**\n${log}` : '_No steps were taken._');
        },
      },

      {
        name: 'reticle', aliases: ['marker'], usage: '/reticle <x> <y> | off | test',
        help: "Show AURA's marker on your real desktop",
        run: async (args, c) => {
          const A = c.ui?.actions;
          if (!A?.available) return '⚠ No action bridge. Restart with `--allow-actions`.';
          const a = (args || '').trim().toLowerCase();
          if (a === 'off' || a === 'hide') {
            const r = await A.overlayHide();
            return r.ok ? '⚪ Reticle hidden.' : `⚠ ${r.message}`;
          }
          const st = await A.overlayStatus();
          if (!st.available) {
            return `⚠ **Desktop reticle unavailable**\n\n${st.reason}\n\n`
              + '_It needs a real display and Python\'s tkinter (bundled with Windows Python)._';
          }
          if (a === 'test' || !a) {
            const cur = await A.automationCursor();
            const x = cur.ok ? cur.x : 400, y = cur.ok ? cur.y : 300;
            const r = await A.overlayShow(x, y, { label: 'AURA' });
            return r.ok
              ? `🟢 **Reticle placed at (${x}, ${y})** — look at your desktop now.\n\n`
                + `${st.clickThrough ? '✅ Click-through: clicks pass through it.'
                                     : '⚠ ' + st.clickThroughNote}\n\n`
                + '`/reticle off` to hide.'
              : `⚠ ${r.message}`;
          }
          const m = /^(-?\d+)[\s,]+(-?\d+)$/.exec(a);
          if (!m) return 'Usage: `/reticle 800 400` · `/reticle test` · `/reticle off`';
          const r = await A.overlayShow(+m[1], +m[2], { label: 'AURA' });
          return r.ok ? `🟢 Reticle at (${m[1]}, ${m[2]}).` : `⚠ ${r.message}`;
        },
      },

      {
        name: 'desktop', aliases: ['vdesk'], usage: '/desktop [setup|aura|home|next|prev|status]',
        help: 'Give AURA its own Windows virtual desktop',
        run: async (args, c) => {
          const A = c.ui?.actions;
          if (!A?.available) return '⚠ No action bridge. Restart with `--allow-actions`.';
          const sub = (args || 'status').trim().toLowerCase();
          const st = await A.vdeskStatus();
          if (!st.available) {
            return `⚠ **Virtual desktop control unavailable**\n\n${st.reason}`;
          }
          const run = {
            setup: () => A.vdeskSetup(), aura: () => A.vdeskGoAura(),
            home: () => A.vdeskGoHome(), next: () => A.vdeskNext(),
            prev: () => A.vdeskPrev(), close: () => A.vdeskClose(),
          }[sub];
          if (run) {
            const r = await run();
            return r.ok ? `🖥 ${r.message}` : `⚠ ${r.message}`;
          }
          return `**VIRTUAL DESKTOPS** (${st.system})\n\n`
            + `• Believed to be on desktop **${st.index + 1}** of ${st.count}\n`
            + `• AURA's desktop: ${st.auraDesktop === null ? 'not created yet'
                                   : `#${st.auraDesktop + 1}`}\n`
            + `• Your desktop: #${st.homeDesktop + 1}\n\n`
            + `**Commands**\n`
            + '`/desktop setup` — create one for AURA\n'
            + '`/desktop aura` · `/desktop home` — switch\n'
            + '`/desktop next` · `/desktop prev` · `/desktop close`\n\n'
            + `⚠ _${st.limitation}_\n\n`
            + `⚠ _${st.sharedCursor}_`;
        },
      },

      {
        name: 'doc', aliases: ['ppt', 'sheet', 'docx', 'slides'],
        usage: '/doc <ppt|sheet|doc> on <topic>',
        help: 'Generate a real PowerPoint, spreadsheet or Word document',
        run: async (args, c) => {
          const A = c.ui?.actions;
          if (!A?.available) return '⚠ No action bridge. Restart with `--allow-actions`.';
          const text = (args || '').trim();
          if (!text) {
            return 'Usage: `/doc ppt on quantum computing` · `/doc sheet of my monthly budget` '
              + '· `/doc report on climate policy`';
          }
          const { detectDocRequest, outline, describeSpec, DOC_KINDS } =
            await import('../ai/doc-agent.js');
          // "/doc ppt on X" has no verb, so give the detector one.
          const req = detectDocRequest(`make ${text}`) || detectDocRequest(text);
          if (!req) {
            return 'Tell me which kind: `/doc **ppt** on …`, `/doc **sheet** of …`, '
              + 'or `/doc **report** on …`.';
          }
          const caps = await A.docCapabilities();
          if (!caps?.[req.kind]) {
            return `⚠ ${DOC_KINDS[req.kind].label} generation needs a Python library.\n\n`
              + `\`${caps?.install?.[req.kind] || 'see docs'}\`\n\n`
              + 'AURA will not write a placeholder file instead.';
          }
          const o = await outline({
            kind: req.kind, topic: req.topic, ai: c.ai,
            slides: req.slides || 0, audience: req.audience || '',
            // §15: research first, but only when the topic needs current facts.
            research: async (t) => {
              try {
                const rr = await A.run('web_research', { query: t, depth: 'adaptive', maxResults: 5, readCount: 3 });
                return (rr?.ok && rr?.context) ? String(rr.context).slice(0, 2200) : null;
              } catch { return null; }
            },
          });
          if (!o.ok) return `⚠ ${o.message}`;
          const folder = c.ui?.docFolder?.() || undefined;
          const r = await A.docBuild(req.kind, o.spec, folder);
          if (!r?.ok) return `⚠ ${r?.message || 'Could not build the file.'}`;
          const notes = [];
          if (o.researched) notes.push('grounded in live web research');
          if (o.deckReport?.repaired) notes.push('weak slides were auto-repaired by the model');
          if (r.validation && !r.validation.ok) notes.push(`validation: ${r.validation.issues.slice(0, 2).join('; ')}`);
          const src = o.source === 'offline-template'
            ? '\n\n_Built from AURA\'s offline template — no model was available._'
            : `\n\n_Outlined by ${o.source}${o.model ? ` (${o.model})` : ''}._`
              + (notes.length ? `\n\n_${notes.join('. ')}._` : '');
          return `${DOC_KINDS[req.kind].icon} **${DOC_KINDS[req.kind].label} created**\n\n`
            + `${describeSpec(req.kind, o.spec)}\n\n`
            + `\`${r.path}\`  ·  ${(r.bytes / 1024).toFixed(1)} KB`
            + (o.message ? `\n\n⚠ ${o.message}` : '') + src;
        },
      },

      {
        name: 'organize', aliases: ['organise', 'tidy'],
        usage: '/organize [folder]  ·  /organize undo [folder]',
        help: 'Sort a folder into Images, Documents, Archives… (preview first)',
        run: async (args, c) => {
          const A = c.ui?.actions;
          if (!A?.available) return '⚠ No action bridge. Restart with `--allow-actions`.';
          let target = (args || '').trim();
          if (/^undo\b/i.test(target)) {
            const t = target.replace(/^undo\s*/i, '').trim() || 'Downloads';
            const u = await A.organizeUndo(t);
            return u?.ok ? `↩ ${u.message}` : `⚠ ${u?.message || 'Undo failed.'}`;
          }
          target = target || 'Downloads';
          const p = await A.organizePlan(target);
          if (!p?.ok) return `⚠ ${p?.message || 'Could not read that folder.'}`;
          if (!p.total) return `**${p.folder}**\n\n${p.message}`;
          const lines = Object.entries(p.counts)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `• **${k}** — ${v} file${v === 1 ? '' : 's'}`).join('\n');
          // Preview, then confirm — nothing has moved yet.
          const okd = await (c.ui?.confirm?.(
            `Move ${p.total} file(s) in ${p.folder} into ${Object.keys(p.counts).length} folders?`)
            ?? Promise.resolve(false));
          if (!okd) return `**Preview only — nothing moved.**\n\n${p.folder}\n\n${lines}`;
          const r = await A.organizeApply(p.folder, p.token);
          return r?.ok
            ? `📁 ${r.message}\n\n${lines}\n\n_Undo with_ \`/organize undo ${p.folder}\``
            : `⚠ ${r?.message || 'Nothing moved.'}`;
        },
      },

      {
        name: 'devices', aliases: ['device'], usage: '/devices [pair|list]',
        help: 'Pair and inspect companion devices (phone)',
        run: async (args, c) => {
          const A = c.ui?.actions;
          if (!A?.available) return '⚠ No action bridge. Restart with `--allow-actions`.';
          const sub = (args || 'list').trim().toLowerCase();
          if (sub === 'pair') {
            const r = await A.devicePairStart();
            return r.ok
              ? `📱 **Pairing code: \`${r.code}\`**\n\nOn the phone open `
                + `\`http://<this-machine-ip>:${location.port || 8000}/phone\` and enter it. `
                + `Valid for 3 minutes.`
              : `⚠ ${r.message}`;
          }
          const st = await A.deviceList();
          if (!st.devices?.length) {
            return '**No devices paired.**\n\nRun `/devices pair`, then open '
              + '`/phone` on the handset over your LAN.\n\n'
              + `_Transport: ${st.transportNote || ''}_`;
          }
          return `**PAIRED DEVICES** (${st.connected}/${st.count} connected)\n\n`
            + st.devices.map(d =>
              `${d.status === 'connected' ? '🟢' : '⚪'} **${d.name}** \`${d.id}\`\n`
              + `   ${d.platform} · ${d.capabilities.join(', ') || 'no capabilities'}\n`
              + `   ${d.latencyMs != null ? `${d.latencyMs}ms · ` : ''}`
              + `${d.battery != null ? `battery ${d.battery}% · ` : ''}`
              + `${d.actionsAcked}/${d.actionsSent} actions acked`).join('\n\n')
            + `\n\n_Try: "open youtube on my phone"_`;
        },
      },

      {
        name: 'do', aliases: ['act'], usage: '/do <instruction>',
        help: 'Plan and run an ordered set of UI actions on the shared screen',
        run: async (args, c) => {
          if (!args?.trim()) return 'Usage: `/do save the file`  ·  `/do click Send then type hello`';
          /*
           * A screen share is only needed to LOCATE something. Instructions
           * with a deterministic keyboard answer ("close the window") do not
           * need one, and refusing them was pure friction — the user asked
           * that `/do close the open window` simply work.
           */
          const isShortcut = !!getAgent().matchShortcut(args.trim());
          if (!isShortcut && !screenShare.active) {
            return '⚠ Not sharing a screen. Run `/watch` first.\n\n'
              + '_(Instructions with a standard keyboard shortcut — close, save, undo, '
              + 'switch window — work without sharing.)_';
          }
          const A = c.ui?.actions;
          if (!A?.available) return '⚠ No action bridge. Restart with `python serve.py --allow-actions`.';

          const cap = await A.automationCapabilities();
          if (!cap.available) return `⚠ ${cap.reason}\n\n\`\`\`\npip install pyautogui\n\`\`\``;

          const t = new Trace(`/do ${args.trim().slice(0, 40)}`);
          t.info('Automation', `armed=${cap.armed}, screen ${cap.screen?.width}x${cap.screen?.height}`);
          c.ui?.setCaption?.('Planning…');
          const p = await getAgent().plan(args.trim(), { trace: t });
          if (!p.ok) { t.end('fail', p.message); return `⚠ ${p.message}`; }
          t.ok('Plan built', p.intents.map(i => i.do).join(' → '));

          c.ui?.setCaption?.('Locating targets…');
          const res = await getAgent().resolve(p.intents, { trace: t });
          if (!res.ok) { t.end('fail', res.message); return `⚠ ${res.message}`; }

          if (!cap.armed) {
            t.end('warn', 'not armed — nothing executed');
            return `🔒 **Not armed.** This plan would:\n\n${res.narration.join('\n')}\n\n`
              + 'Arm it with `/automation arm`, then run `/do` again.';
          }

          const approved = confirm(
            `AURA plans to do this on your screen:\n\n${res.narration.join('\n')}\n\n`
            + 'Targets were located with a coarse grid — verify they look right.\n'
            + 'Kill switch: slam the pointer into the TOP-LEFT corner.\n\nProceed?');
          if (!approved) {
            t.end('warn', 'cancelled by user');
            return '⚪ Cancelled — nothing was clicked or typed.';
          }

          screenCursor?.moveTo(screenCursor.x, screenCursor.y,
                               { label: 'acting', mode: 'acting', trail: false });
          const run = await A.automationRun(res.plan, true);
          t.end(run.ok ? 'ok' : 'fail', run.message || '');
          return run.ok
            ? `✅ ${run.message || 'Plan executed.'}\n\n${res.narration.join('\n')}`
            : `⚠ ${run.message}`;
        },
      },
    ],

    /** Screen state is offered to the model as context. */
    context: () => {
      if (!screenShare.active) return 'Screen sharing is OFF.';
      const s = screenShare.status();
      return `Screen sharing is ON — ${s.description}. `
        + `${s.clickable ? 'Clicking is possible.' : 'Clicking is not possible (window/tab, not a full screen).'}`;
    },
  });
}
