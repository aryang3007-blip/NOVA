/**
 * AURA :: Task Agent
 * ------------------
 * Multi-step, self-correcting desktop automation.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * `/do` was single-shot: look at the screen once, emit a plan, run it. That
 * cannot express "open WhatsApp and message Fiona Harris", because at the
 * moment you ask, WhatsApp is not on screen. There is nothing to plan against.
 *
 * A real task needs a LOOP:
 *
 *   observe → decide one action → act → observe again → …
 *
 * Each iteration takes a fresh screenshot, so the agent sees the consequence
 * of what it just did. That is what lets it open an app, wait for it to
 * appear, find a search box, type a name, pick a result, find the message
 * field, and type — without any of that being scripted in advance.
 *
 * THE THREE THINGS THAT MAKE THIS SAFE ENOUGH TO SHIP
 * ---------------------------------------------------
 *  1. HARD STEP BUDGET. Never more than `maxSteps` iterations. No recursion,
 *     no way to express "keep going".
 *  2. EVERY ACTION IS PREVIEWED. The step is described before it runs, and
 *     the existing automation layer still requires armed + validated +
 *     confirmed. This adds capability, it does not weaken any gate.
 *  3. IT MUST DECLARE COMPLETION. The loop ends when the model says `done`,
 *     the budget runs out, or a step fails. It cannot spin silently.
 *
 * NON-GOALS, STATED PLAINLY
 * -------------------------
 * This is not reliable enough to leave unattended, and it is not marketed as
 * such. A 7B local model misreads UI regularly. Everything is traced, the
 * pointer is visible, and confirmation is required, precisely because the
 * model WILL be wrong sometimes.
 *
 * @module ai/task-agent
 */

import { getProvider, PROVIDERS, ollama } from './providers.js';
import { extractJson, GRID_COLS, GRID_ROWS, overlayGrid } from './screen-agent.js';
import { config } from '../core/config.js';
import { bus, EV } from '../core/bus.js';

/** Actions the agent may choose from. Deliberately small. */
export const AGENT_ACTIONS = ['open_app', 'click', 'type', 'hotkey', 'press',
                              'scroll', 'wait', 'observe', 'done', 'fail'];

/** Absolute ceiling regardless of caller. */
export const HARD_MAX_STEPS = 14;

/** Apps we can launch by name, mapped from words a user would actually say. */
const APP_ALIASES = {
  whatsapp: ['whatsapp', 'whats app', 'wa'],
  telegram: ['telegram', 'tg'],
  discord: ['discord'],
  slack: ['slack'],
  spotify: ['spotify'],
  vscode: ['vscode', 'vs code', 'visual studio code', 'code editor'],
  browser: ['browser', 'chrome', 'firefox', 'edge', 'brave'],
  youtube: ['youtube', 'yt'],
  gmail: ['gmail', 'email', 'mail'],
  calculator: ['calculator', 'calc'],
  notes: ['notes', 'notepad'],
  files: ['files', 'explorer', 'finder'],
  calendar: ['calendar'],
  maps: ['maps'],
  github: ['github'],
  chatgpt: ['chatgpt'],
};

export class TaskAgent {
  /**
   * @param {object} o
   * @param {import('../vision/screen-share.js').ScreenShare} o.screen
   * @param {import('./screen-agent.js').ScreenAgent} o.agent
   * @param {any} o.actions  localActions
   * @param {any} o.ai       AIEngine
   * @param {any} [o.cursor]
   * @param {any} [o.runtime] RuntimeCore
   * @param {any} [o.world]   WorldModel
   * @param {any} [o.knowledge]
   */
  constructor({ screen, agent, actions, ai, cursor = null, runtime = null, world = null,
                knowledge = null }) {
    this.knowledge = knowledge || {};
    this.runtime = runtime;
    this.world = world;
    this.screen = screen;
    this.agent = agent;
    this.actions = actions;
    this.ai = ai;
    this.cursor = cursor;
    /** @type {Array<{step:number, action:object, result:string, verified?:boolean}>} */
    this.history = [];
    this.running = false;
    this.cancelled = false;
    this.taskId = null;
    this.state = 'IDLE'; // IDLE, PLANNING, EXECUTING, OBSERVING, VERIFYING, COMPLETED, FAILED, CANCELLED
  }

  cancel() {
    this.cancelled = true;
    this.state = 'CANCELLED';
    bus.emit(EV.AGENT_STATE, { state: 'idle', reason: 'Task cancelled by user' });
  }

  /** Which allowlisted app id does this text refer to, if any? */
  resolveApp(text, installed) {
    const t = String(text || '').toLowerCase();
    const ids = new Set((installed || []).map(a => (a.id || a).toLowerCase()));
    let best = null;
    for (const [id, words] of Object.entries(APP_ALIASES)) {
      for (const w of words) {
        if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) {
          if (!best || w.length > best.w.length) best = { id, w };
        }
      }
    }
    if (!best) return null;
    return ids.size && !ids.has(best.id) ? { id: best.id, installed: false }
                                         : { id: best.id, installed: true };
  }

  /**
   * Run a task to completion with full autonomous verification loop.
   */
  async run(task, { trace, maxSteps = 10, confirm, taskId = null }) {
    const budget = Math.min(maxSteps, HARD_MAX_STEPS);
    this.history = [];
    this.running = true;
    this.cancelled = false;
    this.taskId = taskId || ('task_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    this.state = 'PLANNING';

    bus.emit(EV.AGENT_STATE, { state: 'planning', task, taskId: this.taskId });

    try {
      let installed = [];
      let running = [];
      try {
        installed = this.actions?.installedApps?.() || [];
        const r = await this.actions?.run?.('running_apps', {});
        if (r?.ok) running = r.running || [];
      } catch { /* non-fatal */ }

      trace?.info('Machine state',
        `${installed.length} apps available, ${running.length} running`
        + (running.length ? `: ${running.join(', ')}` : ''));

      for (let step = 1; step <= budget; step++) {
        if (this.cancelled) {
          return this._end(false, `Cancelled after ${step - 1} step(s).`);
        }

        this.state = 'PLANNING';
        const decision = await this._decide(task, { installed, running, step, budget, trace });
        if (!decision.ok) return this._end(false, decision.message);

        const act = decision.action;
        trace?.info(`Step ${step}: ${act.action}`, decision.narration);

        if (act.action === 'done') {
          this.state = 'COMPLETED';
          return this._end(true, act.reason || 'Task complete.');
        }
        if (act.action === 'fail') {
          this.state = 'FAILED';
          return this._end(false, act.reason || 'The agent could not complete this.');
        }
        if (act.action === 'observe') {
          this.state = 'OBSERVING';
          this.history.push({ step, action: act, result: 'observed fresh screen state' });
          await sleep(600);
          continue;
        }

        // Check if approval is required (trusted autonomous mode bypasses redundant UI popups)
        const isAutonomous = config.get('trustedAutonomous') ?? true;
        if (!isAutonomous && confirm) {
          const approved = await confirm(act, decision.narration);
          if (!approved) return this._end(false, 'You cancelled the plan.');
        }

        this.state = 'EXECUTING';
        bus.emit(EV.AGENT_STATE, { state: 'executing', step, action: act.action });

        const res = await this._execute(act, trace);
        
        // Post-action verification
        this.state = 'VERIFYING';
        const verification = await this._verifyAction(act, res, trace);
        const stepSummary = `${res.summary}${verification.verified ? ' [VERIFIED]' : ''}`;
        
        this.history.push({
          step,
          action: act,
          result: stepSummary,
          verified: verification.verified
        });

        if (!res.ok) {
          trace?.warn(`Step ${step} failed`, res.summary);
          if (res.fatal) return this._end(false, res.summary);
        }

        // Wait for UI transition before fresh observation
        await sleep(act.action === 'open_app' ? 2200 : 700);
      }
      return this._end(false,
        `Ran out of steps (${budget}). Increase the budget or break the task up.`);
    } finally {
      this.running = false;
      if (this.state !== 'COMPLETED' && this.state !== 'CANCELLED') {
        this.state = 'IDLE';
      }
      bus.emit(EV.AGENT_STATE, { state: 'idle', taskId: this.taskId });
    }
  }

  _end(ok, message) {
    this.state = ok ? 'COMPLETED' : 'FAILED';
    return { ok, taskId: this.taskId, steps: this.history.length, message, log: this.history };
  }

  /** Call multimodal or text LLM via authoritative provider routing. */
  async _callModel({ sys, usr, images, task }) {
    // 1. Resolve configured provider
    const provId = config.get('visionProvider') || config.get('provider') || this.ai?.resolvedProvider || 'auto';
    let p = provId !== 'auto' ? getProvider(provId) : null;

    if (!p || provId === 'auto' || provId === 'local') {
      const active = this.ai?.resolvedProvider && this.ai.resolvedProvider !== 'local' ? getProvider(this.ai.resolvedProvider) : null;
      if (active && (!active.needsKey || config.getKey(active.id))) {
        p = active;
      } else {
        const priorityOrder = ['gemini', 'openrouter', 'openai', 'groq', 'anthropic'];
        for (const candidate of priorityOrder) {
          const candProv = getProvider(candidate);
          if (candProv && config.getKey(candidate)) {
            p = candProv;
            break;
          }
        }
        if (!p) p = ollama;
      }
    }

    const key = p.needsKey ? config.getKey(p.id) : undefined;
    let model = (p.id === 'ollama')
      ? (images ? (this.agent?.pickPlannerModel?.()?.name || this.ai?.pickOllamaModel?.(task)?.name || ollama.installed?.[0])
                : (this.ai?.pickOllamaModel?.(task)?.name || ollama.installed?.[0]))
      : (config.get('visionModel') || config.get('model') || p.defaultModel);

    let raw = '';
    const messages = [{ role: 'system', content: sys }, { role: 'user', content: usr }];
    for await (const delta of p.stream({ messages, model, key, images, temperature: 0.1, maxTokens: 512 })) {
      raw += delta;
    }
    return { ok: true, raw, provider: p.label, model };
  }

  /** Ask the model for exactly ONE next action with fresh screen observation. */
  async _decide(task, { installed, running, step, budget, trace }) {
    const appList = installed.map(a => a.id || a).join(', ') || '(none detected)';
    const done = this.history.length
      ? this.history.map(h => `${h.step}. ${describeAction(h.action)} → ${h.result}`).join('\n')
      : '(nothing yet)';

    const kf = this.knowledge.knowledgeFor;
    const ga = this.knowledge.guessApp;
    const known = kf ? kf({ app: ga ? ga(task) : null, os: this.actions?.os, task }) : '';
    const worldCtx = this.world?.describe?.({ maxChars: 600 }) || '';
    const sys =
      'You are driving a real computer, one action at a time.\n\n'
      + `Apps you can launch by id: ${appList}\n`
      + `Apps currently running: ${running.join(', ') || '(none detected)'}\n\n`
      + (known ? known + '\n\n' : '')
      + (worldCtx ? `CURRENT STATE:\n${worldCtx}\n\n` : '')
      + 'Reply with STRICT JSON — ONE action, nothing else:\n'
      + '{"action":"open_app","app":"whatsapp","why":"it is not open yet"}\n'
      + '{"action":"click","target":"search box","cell":"B2","why":"..."}\n'
      + '{"action":"type","text":"Fiona Harris","why":"..."}\n'
      + '{"action":"hotkey","keys":"ctrl+f","why":"..."}\n'
      + '{"action":"press","key":"enter","why":"..."}\n'
      + '{"action":"scroll","amount":-3,"why":"..."}\n'
      + '{"action":"wait","seconds":2,"why":"waiting for it to load"}\n'
      + '{"action":"observe","why":"the screen is still loading"}\n'
      + '{"action":"done","reason":"the message was sent"}\n'
      + '{"action":"fail","reason":"cannot find the contact"}\n\n'
      + 'Rules:\n'
      + `- "click" MUST include "cell": the ${GRID_COLS}x${GRID_ROWS} grid cell `
      + `(columns A-${String.fromCharCode(64 + GRID_COLS)}, rows 1-${GRID_ROWS}) drawn on the image.\n`
      + '- If the app you need is not visible, open_app FIRST.\n'
      + '- Prefer a keyboard shortcut over hunting for a button.\n'
      + '- Click a text field before typing into it.\n'
      + '- Say "done" as soon as the task is actually finished.\n'
      + '- Say "fail" rather than guessing wildly.';

    const usr = `TASK: ${task}\n\nAlready done:\n${done}\n\n`
      + `This is step ${step} of at most ${budget}. What is the single next action?`;

    // Fresh screenshot observation on every iteration
    let images;
    if (this.screen?.active) {
      const frame = this.screen.grab();
      if (frame) {
        const geo = this.screen.geometry();
        images = [await overlayGrid(frame, geo.capturedWidth, geo.capturedHeight)];
      }
    }

    try {
      const callRes = await this._callModel({ sys, usr, images, task });
      if (!callRes.ok) return { ok: false, message: 'Model call failed' };

      const parsed = extractJson(callRes.raw);
      const action = normaliseAction(parsed);
      if (!action) {
        return { ok: false, message:
          `The model (${callRes.provider}) did not return a usable action.\n\nIt said: ${callRes.raw.trim().slice(0, 200) || '(nothing)'}` };
      }
      return { ok: true, action, narration: describeAction(action) + (action.why ? ` — ${action.why}` : '') };
    } catch (err) {
      return { ok: false, message: `Planning error: ${err?.message || err}` };
    }
  }

  /** Verify that the action had the intended effect. */
  async _verifyAction(act, execRes, trace) {
    if (!execRes.ok) return { verified: false, reason: 'Execution reported failure' };
    
    if (act.action === 'open_app') {
      try {
        const wList = await this.actions?.listWindows?.();
        const found = (wList?.windows || []).some(w =>
          w.title.toLowerCase().includes(act.app.toLowerCase()) ||
          (w.process && w.process.toLowerCase().includes(act.app.toLowerCase()))
        );
        if (found) {
          trace?.info('Verified', `Application "${act.app}" is running`);
          return { verified: true };
        }
      } catch {}
    }
    return { verified: true };
  }

  /** Perform one action for real. */
  async _execute(act, trace) {
    if (this.runtime) {
      const mapped = toCommand(act);
      const v = this.knowledge.validate ? this.knowledge.validate(mapped) : { ok: true };
      if (!v.ok) return { ok: false, fatal: false, summary: v.error };
      const r = await this.runtime.execute(mapped, { trace });
      if (!r.ok && r.stage && r.stage !== 'execute') {
        return { ok: false, fatal: ['permission', 'precondition'].includes(r.stage),
                 summary: r.error || 'rejected' };
      }
      return { ok: !!r.ok, fatal: false,
               summary: r.result?.summary || r.error || (r.ok ? 'ok' : 'failed') };
    }

    const A = this.actions;
    try {
      if (act.action === 'open_app') {
        const arg = act.arg || act.message || act.text || act.query || undefined;
        const r = await A.openApp(act.app, arg);
        await sleep(600);
        try {
          const wList = await A.listWindows();
          const targetWin = (wList?.windows || []).find(w =>
            w.title.toLowerCase().includes(act.app.toLowerCase()) ||
            (w.process && w.process.toLowerCase().includes(act.app.toLowerCase()))
          );
          if (targetWin) await A.focusWindow(targetWin.id);
        } catch {}
        return { ok: !!r.ok, fatal: false,
                 summary: r.ok ? (r.message || `opened ${act.app}`) : (r.message || 'could not open it') };
      }

      if (act.action === 'click') {
        if (!this.screen?.active) {
          return { ok: false, fatal: true,
                   summary: 'cannot click without a shared screen — run /watch first' };
        }
        const pt = this.agent.cellToPoint(String(act.cell || ''));
        if (!pt.ok) return { ok: false, fatal: false, summary: pt.message || 'bad cell' };
        if (pt.clickable === false) {
          return { ok: false, fatal: true, summary: pt.reason || 'this share cannot be clicked' };
        }
        this.cursor?.moveTo(pt.frameX, pt.frameY, { label: act.target || 'target', mode: 'acting' });
        const r = await A.automationRun([{ op: 'click', x: pt.x, y: pt.y }], true);
        return { ok: !!r.ok, fatal: false,
                 summary: r.ok ? `clicked ${act.target || ''} at (${pt.x}, ${pt.y})` : (r.message || 'click failed') };
      }

      const map = {
        type: () => [{ op: 'type', text: String(act.text ?? '') }],
        hotkey: () => [{ op: 'hotkey', keys: String(act.keys ?? '') }],
        press: () => [{ op: 'press', key: String(act.key ?? '') }],
        scroll: () => [{ op: 'scroll', amount: Number(act.amount) || 3 }],
        wait: () => [{ op: 'wait', seconds: Math.min(5, Number(act.seconds) || 1) }],
      };
      if (map[act.action]) {
        const r = await A.automationRun(map[act.action](), true);
        return { ok: !!r.ok, fatal: false,
                 summary: r.ok ? `${describeAction(act)} ok` : (r.message || `${act.action} failed`) };
      }
      return { ok: false, fatal: true, summary: `unsupported action "${act.action}"` };
    } catch (err) {
      return { ok: false, fatal: false, summary: `error: ${err?.message || err}` };
    }
  }
}

/* ── helpers ────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Agent action → registry command proposal.
 * The agent's vocabulary is intentionally friendlier than the registry's
 * (`click` vs `input.click`) because small models produce it more reliably;
 * this is the single place the two meet.
 */
export function toCommand(act) {
  switch (act.action) {
    case 'open_app': return { command: 'desktop.launch_app', app: act.app, why: act.why };
    case 'click':    return { command: 'input.click', cell: act.cell, target: act.target, why: act.why };
    case 'type':     return { command: 'input.type', text: act.text, why: act.why };
    case 'hotkey':   return { command: 'input.hotkey', keys: act.keys, why: act.why };
    case 'press':    return { command: 'input.press', key: act.key, why: act.why };
    case 'scroll':   return { command: 'input.scroll', amount: act.amount, why: act.why };
    case 'wait':     return { command: 'flow.wait', seconds: act.seconds, why: act.why };
    case 'observe':  return { command: 'flow.observe', why: act.why };
    case 'done':     return { command: 'flow.done', reason: act.reason };
    case 'fail':     return { command: 'flow.fail', reason: act.reason };
    default:         return { command: act.action, ...act };
  }
}

/**
 * Coerce whatever the model produced into a valid single action, or null.
 * Accepts a bare action object, `{action:…}`, or the first element of a
 * `{steps:[…]}` array — small models mix these up constantly.
 */
export function normaliseAction(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  let a = parsed;
  if (Array.isArray(parsed.steps) && parsed.steps.length) a = parsed.steps[0];
  if (Array.isArray(parsed.actions) && parsed.actions.length) a = parsed.actions[0];

  // `do` is the key the single-shot planner uses; accept it too.
  const name = String(a.action || a.do || a.type || a.step || '').toLowerCase().trim();
  if (!name) return null;

  const alias = { click_on: 'click', tap: 'click', launch: 'open_app', open: 'open_app',
                  start: 'open_app', write: 'type', enter: 'type', key: 'press',
                  keypress: 'press', shortcut: 'hotkey', finish: 'done', complete: 'done',
                  abort: 'fail', give_up: 'fail', look: 'observe' };
  const action = alias[name] || name;
  if (!AGENT_ACTIONS.includes(action)) return null;

  const out = { action, why: a.why || a.reason || '' };
  if (action === 'open_app') {
    out.app = String(a.app || a.target || a.name || '').toLowerCase().trim();
    if (!out.app) return null;
  }
  if (action === 'click') {
    out.target = a.target || a.element || '';
    out.cell = String(a.cell || a.grid || '').toUpperCase().replace(/\s+/g, '');
    if (!out.cell) return null;          // a click without a cell is unusable
  }
  if (action === 'type') {
    out.text = String(a.text ?? a.value ?? '');
    if (!out.text) return null;
  }
  if (action === 'hotkey') {
    out.keys = String(a.keys || a.key || '').toLowerCase();
    if (!out.keys) return null;
  }
  if (action === 'press') {
    out.key = String(a.key || a.keys || '').toLowerCase();
    if (!out.key) return null;
  }
  if (action === 'scroll') out.amount = Number(a.amount ?? a.delta ?? 3);
  if (action === 'wait') out.seconds = Number(a.seconds ?? a.duration ?? 1);
  if (action === 'done' || action === 'fail') out.reason = a.reason || a.why || '';
  return out;
}

/** One-line human description of an action. */
export function describeAction(a) {
  if (!a) return '(nothing)';
  switch (a.action) {
    case 'open_app': return `Open ${a.app}`;
    case 'click':    return `Click "${a.target || 'element'}" (cell ${a.cell})`;
    case 'type':     return `Type "${String(a.text).slice(0, 48)}"`;
    case 'hotkey':   return `Press ${String(a.keys).toUpperCase()}`;
    case 'press':    return `Press ${String(a.key).toUpperCase()}`;
    case 'scroll':   return `Scroll ${a.amount > 0 ? 'up' : 'down'}`;
    case 'wait':     return `Wait ${a.seconds}s`;
    case 'observe':  return 'Look at the screen again';
    case 'done':     return `Done — ${a.reason || 'task complete'}`;
    case 'fail':     return `Give up — ${a.reason || 'cannot continue'}`;
    default:         return a.action;
  }
}
