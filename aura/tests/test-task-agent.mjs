/**
 * AURA :: multi-step task agent
 * =============================
 * The escalation the user asked for: "/do open whatsapp and message Fiona
 * Harris" cannot work single-shot, because WhatsApp is not on screen when you
 * ask. The agent must open it, look again, and continue.
 *
 * These assertions cover the loop's contract, the safety ceilings, and — most
 * importantly — that a MISBEHAVING model cannot make it run away.
 */

import { TaskAgent, normaliseAction, describeAction,
         AGENT_ACTIONS, HARD_MAX_STEPS } from '../js/ai/task-agent.js';

let p = 0, f = 0; const fails = [];
const ok = (n, c, d = '') => { c ? (p++, console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`))
  : (f++, fails.push(n), console.log(`  \x1b[31m✗\x1b[0m ${n}  \x1b[90m${d}\x1b[0m`)); };
const sec = t => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

/* ══════════════ ACTION NORMALISATION ══════════════ */
sec('ACTION PARSING — small models phrase things every possible way');

ok('canonical action', normaliseAction({ action: 'open_app', app: 'whatsapp' })?.app === 'whatsapp');
ok('`do` key instead of `action`',
   normaliseAction({ do: 'click', target: 'X', cell: 'C4' })?.action === 'click');
ok('`type` key', normaliseAction({ type: 'wait', seconds: 2 })?.action === 'wait');
ok('wrapped in steps[]',
   normaliseAction({ steps: [{ action: 'press', key: 'enter' }] })?.key === 'enter');
ok('wrapped in actions[]',
   normaliseAction({ actions: [{ action: 'done', reason: 'sent' }] })?.action === 'done');

ok('alias: open → open_app', normaliseAction({ action: 'open', app: 'spotify' })?.action === 'open_app');
ok('alias: launch → open_app', normaliseAction({ action: 'launch', app: 'slack' })?.action === 'open_app');
ok('alias: tap → click', normaliseAction({ action: 'tap', cell: 'A1' })?.action === 'click');
ok('alias: write → type', normaliseAction({ action: 'write', text: 'hi' })?.action === 'type');
ok('alias: shortcut → hotkey', normaliseAction({ action: 'shortcut', keys: 'ctrl+s' })?.action === 'hotkey');
ok('alias: finish → done', normaliseAction({ action: 'finish' })?.action === 'done');
ok('alias: give_up → fail', normaliseAction({ action: 'give_up', reason: 'x' })?.action === 'fail');

ok('cell is upper-cased and de-spaced',
   normaliseAction({ action: 'click', cell: 'c 4' })?.cell === 'C4');

sec('ACTION PARSING REJECTS THE DANGEROUS AND THE USELESS');
ok('a click with NO cell is rejected (unclickable)',
   normaliseAction({ action: 'click', target: 'Send' }) === null);
ok('open_app with no app is rejected', normaliseAction({ action: 'open_app' }) === null);
ok('type with no text is rejected', normaliseAction({ action: 'type' }) === null);
ok('hotkey with no keys is rejected', normaliseAction({ action: 'hotkey' }) === null);
ok('an invented action is rejected',
   normaliseAction({ action: 'format_disk', target: 'C:' }) === null);
ok('run_command is not an available action', !AGENT_ACTIONS.includes('run_command'));
ok('delete is not an available action', !AGENT_ACTIONS.includes('delete'));
ok('null input', normaliseAction(null) === null);
ok('garbage input', normaliseAction('hello') === null);
ok('empty object', normaliseAction({}) === null);

ok('describeAction is human readable',
   describeAction({ action: 'click', target: 'Send', cell: 'C4' }) === 'Click "Send" (cell C4)',
   describeAction({ action: 'click', target: 'Send', cell: 'C4' }));
ok('describeAction handles open_app',
   describeAction({ action: 'open_app', app: 'whatsapp' }) === 'Open whatsapp');

/* ══════════════ APP RESOLUTION ══════════════ */
sec('APP RESOLUTION');

const ta = Object.create(TaskAgent.prototype);
const INSTALLED = [{ id: 'whatsapp' }, { id: 'spotify' }, { id: 'browser' }];
ok('finds whatsapp in a sentence',
   ta.resolveApp('open whatsapp and message Fiona', INSTALLED)?.id === 'whatsapp');
ok('handles "whats app"',
   ta.resolveApp('open whats app please', INSTALLED)?.id === 'whatsapp');
ok('finds spotify', ta.resolveApp('play music on spotify', INSTALLED)?.id === 'spotify');
ok('no app mentioned → null', ta.resolveApp('what is on my screen', INSTALLED) === null);
ok('flags an app that is not installed',
   ta.resolveApp('open telegram', INSTALLED)?.installed === false);
ok('word-boundary: "roadmaps" is not "maps"',
   ta.resolveApp('show me the roadmaps', [{ id: 'maps' }]) === null);

/* ══════════════ THE LOOP ══════════════ */
sec('THE LOOP — WhatsApp scenario, end to end');

/** Build an agent whose model returns a scripted sequence. */
function scripted(sequence, { screenActive = true } = {}) {
  const calls = [];
  const agent = new TaskAgent({
    screen: {
      active: screenActive,
      grab: () => 'data:image/jpeg;base64,AAAA',
      geometry: () => ({ capturedWidth: 1280, capturedHeight: 720, scale: 0.66 }),
    },
    agent: {
      pickPlannerModel: () => ({ name: 'qwen2.5vl:7b' }),
      cellToPoint: (c) => ({ ok: true, x: 400, y: 300, frameX: 267, frameY: 200,
                             cell: c, clickable: true }),
    },
    actions: {
      installedApps: () => INSTALLED,
      run: async () => ({ ok: true, running: [] }),
      openApp: async (app) => { calls.push(['open', app]); return { ok: true, message: `Opened ${app}` }; },
      automationRun: async (plan) => { calls.push(['auto', plan[0].op, plan[0].text || plan[0].keys || '']);
                                       return { ok: true, message: 'Completed 1 step(s).' }; },
    },
    ai: { pickOllamaModel: () => ({ name: 'gemma2:2b' }) },
    cursor: { moveTo: () => {} },
  });
  let i = 0;
  agent._decide = async () => {
    const a = sequence[Math.min(i++, sequence.length - 1)];
    return { ok: true, action: a, narration: describeAction(a) };
  };
  return { agent, calls, decisions: () => i };
}

{
  // The exact task the user described.
  const seq = [
    { action: 'open_app', app: 'whatsapp', why: 'not open yet' },
    { action: 'click', target: 'search box', cell: 'B2' },
    { action: 'type', text: 'Fiona Harris' },
    { action: 'click', target: 'Fiona Harris result', cell: 'B4' },
    { action: 'click', target: 'message field', cell: 'F8' },
    { action: 'type', text: 'Hi' },
    { action: 'press', key: 'enter' },
    { action: 'done', reason: 'message sent' },
  ];
  const { agent, calls } = scripted(seq);
  const r = await agent.run('open whatsapp and message Fiona Harris saying Hi',
                            { trace: null, maxSteps: 12, confirm: async () => true });
  ok('the task completes', r.ok, r.message);
  ok('it declared done', /sent/i.test(r.message), r.message);
  ok('it ran 7 real actions', r.steps === 7, String(r.steps));
  ok('WhatsApp was opened FIRST',
     calls[0][0] === 'open' && calls[0][1] === 'whatsapp', JSON.stringify(calls[0]));
  ok('the contact name was typed',
     calls.some(c => c[0] === 'auto' && c[1] === 'type' && c[2] === 'Fiona Harris'),
     JSON.stringify(calls));
  ok('the message body was typed',
     calls.some(c => c[0] === 'auto' && c[1] === 'type' && c[2] === 'Hi'));
  ok('enter was pressed last',
     calls[calls.length - 1][1] === 'press', JSON.stringify(calls[calls.length - 1]));
  ok('the log explains every step', r.log.length === 7 && r.log[0].result.includes('whatsapp'),
     r.log[0]?.result);
}

sec('SAFETY — a misbehaving model cannot run away');

{
  // A model that NEVER says done.
  const { agent } = scripted([{ action: 'scroll', amount: 3 }]);
  const r = await agent.run('spin forever', { trace: null, maxSteps: 5, confirm: async () => true });
  ok('a never-ending model is stopped by the budget', !r.ok, r.message);
  ok('it stopped at exactly the budget', r.steps === 5, String(r.steps));
  ok('and says why', /ran out of steps/i.test(r.message), r.message);
}
{
  const { agent } = scripted([{ action: 'scroll', amount: 3 }]);
  const r = await agent.run('x', { trace: null, maxSteps: 9999, confirm: async () => true });
  ok('the hard ceiling overrides a silly caller budget',
     r.steps === HARD_MAX_STEPS, `${r.steps} vs ${HARD_MAX_STEPS}`);
}
{
  // The user says no on the first action.
  const { agent, calls } = scripted([{ action: 'open_app', app: 'whatsapp' }]);
  const r = await agent.run('open whatsapp', { trace: null, maxSteps: 6, confirm: async () => false });
  ok('declining an action aborts the whole task', !r.ok, r.message);
  ok('and NOTHING was executed', calls.length === 0, JSON.stringify(calls));
  ok('the refusal is explained', /cancel/i.test(r.message), r.message);
}
{
  const { agent } = scripted([{ action: 'fail', reason: 'cannot find the contact' }]);
  const r = await agent.run('message nobody', { trace: null, maxSteps: 6, confirm: async () => true });
  ok('the agent may give up honestly', !r.ok && /cannot find/i.test(r.message), r.message);
}
{
  // Clicking with no screen share must be refused, not guessed.
  const { agent, calls } = scripted([{ action: 'click', target: 'X', cell: 'C4' }],
                                    { screenActive: false });
  const r = await agent.run('click something', { trace: null, maxSteps: 4, confirm: async () => true });
  ok('clicking without a shared screen is fatal', !r.ok, r.message);
  ok('and no click was dispatched',
     !calls.some(c => c[1] === 'click'), JSON.stringify(calls));
}
{
  // A failing step must NOT kill the task — that is the point of a loop.
  let n = 0;
  const { agent } = scripted([
    { action: 'click', target: 'missing', cell: 'C4' },
    { action: 'done', reason: 'recovered' },
  ]);
  agent.actions.automationRun = async () => { n++; return { ok: false, message: 'element gone' }; };
  const r = await agent.run('try', { trace: null, maxSteps: 6, confirm: async () => true });
  ok('a non-fatal failure is fed back, not fatal', r.ok, r.message);
  ok('and the failure is recorded in the log',
     r.log.some(h => /element gone/.test(h.result)), JSON.stringify(r.log.map(h => h.result)));
}
{
  const { agent } = scripted([{ action: 'scroll', amount: 3 }]);
  const p = agent.run('x', { trace: null, maxSteps: 10, confirm: async () => true });
  agent.cancel();
  const r = await p;
  ok('cancel() stops the loop', !r.ok && /cancel/i.test(r.message), r.message);
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`  \x1b[32mPASS ${p}\x1b[0m   ${f ? `\x1b[31mFAIL ${f}\x1b[0m` : 'FAIL 0'}`);
if (f) { console.log('  Failed: ' + fails.join(', ')); process.exit(1); }
console.log('  TASK AGENT VERIFIED');
