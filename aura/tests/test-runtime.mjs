/**
 * AURA :: Runtime kernel, command registry, world model, desktop knowledge
 * ========================================================================
 * The architectural claim being tested is: **the AI cannot touch the OS
 * directly.** Every one of these assertions exists to make that enforceable
 * rather than aspirational.
 */

import { COMMANDS, COMMAND_NAMES, RISK, validate, resolveName, byDomain,
         describeForModel, getCommand } from '../js/runtime/command-registry.js';
import { RuntimeCore } from '../js/runtime/runtime-core.js';
import { WorldModel } from '../js/runtime/world-model.js';
import { knowledgeFor, guessApp, APP_KNOWLEDGE, OS_KNOWLEDGE }
  from '../js/runtime/desktop-knowledge.js';

let p = 0, f = 0; const fails = [];
const ok = (n, c, d = '') => { c ? (p++, console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`))
  : (f++, fails.push(n), console.log(`  \x1b[31m✗\x1b[0m ${n}  \x1b[90m${d}\x1b[0m`)); };
const sec = t => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

/* ══════════════ COMMAND REGISTRY ══════════════ */
sec('COMMAND REGISTRY — the AI may only pick from this list');

ok('registry is populated', COMMAND_NAMES.length >= 25, `${COMMAND_NAMES.length} commands`);
ok('every command is namespaced domain.verb',
   COMMAND_NAMES.every(n => /^[a-z]+\.[a-z_]+$/.test(n)),
   COMMAND_NAMES.filter(n => !/^[a-z]+\.[a-z_]+$/.test(n)).join(','));
ok('every command has a summary', Object.values(COMMANDS).every(c => c.summary?.length > 4));
ok('every command has a risk level',
   Object.values(COMMANDS).every(c => Object.values(RISK).includes(c.risk)));

const domains = Object.keys(byDomain());
for (const d of ['desktop', 'input', 'vision', 'filesystem', 'memory', 'flow']) {
  ok(`domain "${d}" exists`, domains.includes(d), domains.join(','));
}

sec('HIGH-RISK COMMANDS REQUIRE A PERMISSION');
const HIGH = Object.values(COMMANDS).filter(c => c.risk === RISK.HIGH);
ok('there are high-risk commands', HIGH.length >= 5, String(HIGH.length));
ok('every high-risk command names a permission',
   HIGH.every(c => !!c.permission),
   HIGH.filter(c => !c.permission).map(c => c.name).join(','));
ok('input.type needs keyboard_automation',
   getCommand('input.type').permission === 'keyboard_automation');
ok('terminal.run needs terminal', getCommand('terminal.run').permission === 'terminal');
ok('power.shutdown needs power_controls',
   getCommand('power.shutdown').permission === 'power_controls');
ok('flow.* commands are all read-only',
   Object.values(COMMANDS).filter(c => c.name.startsWith('flow.')).every(c => c.readOnly));

sec('VALIDATION — invented commands are impossible');
ok('rejects an invented command', !validate({ action: 'format_disk' }).ok);
ok('rejects rm -rf dressed as a command', !validate({ command: 'shell.exec', cmd: 'rm -rf /' }).ok);
ok('rejects a missing required param', !validate({ command: 'input.type' }).ok);
ok('names the missing param',
   /needs "text"/.test(validate({ command: 'input.type' }).error || ''),
   validate({ command: 'input.type' }).error);
ok('rejects non-objects', !validate('input.type').ok);
ok('rejects null', !validate(null).ok);

sec('VALIDATION — accepts what models really emit');
const ACCEPT = [
  [{ action: 'open_app', app: 'whatsapp' }, 'desktop.launch_app'],
  [{ do: 'click', cell: 'C4' }, 'input.click'],
  [{ command: 'input.type', params: { text: 'hi' } }, 'input.type'],
  [{ name: 'hotkey', keys: 'ctrl+s' }, 'input.hotkey'],
  [{ action: 'launch', app: 'spotify' }, 'desktop.launch_app'],
  [{ action: 'finish', reason: 'ok' }, 'flow.done'],
  [{ action: 'desktop_launch_app', app: 'slack' }, 'desktop.launch_app'],
];
for (const [input, expected] of ACCEPT) {
  const r = validate(input);
  ok(`${JSON.stringify(input).slice(0, 42)} → ${expected}`, r.ok && r.command === expected,
     r.ok ? r.command : r.error);
}
ok('flattened params are picked up',
   validate({ command: 'input.click', cell: 'B2', target: 'Search' }).params.cell === 'B2');
ok('nested params are picked up',
   validate({ command: 'input.click', params: { cell: 'B2' } }).params.cell === 'B2');
ok('numbers are coerced', validate({ command: 'media.volume', level: '40' }).params.level === 40);
ok('a non-numeric number is rejected', !validate({ command: 'media.volume', level: 'loud' }).ok);
ok('the model reason is carried through',
   validate({ action: 'flow.wait', why: 'loading' }).why === 'loading');

ok('describeForModel lists commands',
   describeForModel().split('\n').length === COMMAND_NAMES.length);
ok('resolveName is case-insensitive', resolveName('INPUT.CLICK') === 'input.click');
ok('resolveName returns null for nonsense', resolveName('wibble') === null);

/* ══════════════ RUNTIME GATES ══════════════ */
sec('RUNTIME — every gate, in order');

const mkPerms = (granted = []) => ({ isGranted: (id) => granted.includes(id) });
function mkKernel({ granted = [], screenActive = true, exec = null } = {}) {
  const calls = [];
  const k = new RuntimeCore({
    permissions: mkPerms(granted),
    actions: {
      openApp: async (app) => { calls.push(['openApp', app]); return { ok: true, message: `Opened ${app}` }; },
      automationRun: async (steps) => { calls.push(['auto', steps[0].op]); return { ok: true }; },
      run: async (a) => { calls.push(['run', a]); return { ok: true, running: [] }; },
      installedApps: () => [{ id: 'whatsapp' }],
    },
    screen: { active: screenActive, grab: () => 'data:image/jpeg;base64,AA' },
    agent: { cellToPoint: () => ({ ok: true, x: 10, y: 20, frameX: 5, frameY: 8, clickable: true }) },
    cursor: { moveTo: () => {} },
  });
  if (exec) Object.assign(k.executors, exec);
  return { k, calls };
}

{
  const { k, calls } = mkKernel();
  const r = await k.execute({ action: 'format_disk' });
  ok('stage 1: an invented command dies at the registry', !r.ok && r.stage === 'registry', r.stage);
  ok('and nothing was called', calls.length === 0);
}
{
  const { k, calls } = mkKernel({ granted: [] });
  const r = await k.execute({ action: 'open_app', app: 'whatsapp' });
  ok('stage 2: missing permission blocks execution', !r.ok && r.stage === 'permission', r.stage);
  ok('the error names the permission', /launch_apps/.test(r.error || ''), r.error);
  ok('and nothing was called', calls.length === 0);
}
{
  const { k, calls } = mkKernel({ granted: ['mouse_automation'], screenActive: false });
  const r = await k.execute({ action: 'click', cell: 'C4' });
  ok('stage 3: no shared screen blocks a click', !r.ok && r.stage === 'precondition', r.stage);
  ok('and nothing was clicked', calls.length === 0);
}
{
  const { k, calls } = mkKernel({ granted: ['launch_apps'] });
  const r = await k.execute({ action: 'open_app', app: 'whatsapp' },
                            { confirm: async () => false });
  ok('stage 4: declining blocks execution', !r.ok && r.stage === 'confirm', r.stage);
  ok('and nothing was launched', calls.length === 0);
}
{
  const { k, calls } = mkKernel({ granted: ['launch_apps'] });
  const r = await k.execute({ action: 'open_app', app: 'whatsapp' },
                            { confirm: async () => true });
  ok('stage 5: a fully-approved command executes', r.ok && r.stage === 'execute', JSON.stringify(r));
  ok('the real bridge was called', calls[0][0] === 'openApp' && calls[0][1] === 'whatsapp');
}
{
  // Read-only commands need no confirmation — asking would be noise.
  let asked = false;
  const { k } = mkKernel({ granted: [] });
  const r = await k.execute({ command: 'desktop.list_apps' },
                            { confirm: async () => { asked = true; return true; } });
  ok('a read-only command does not prompt', r.ok && !asked, JSON.stringify(r));
}
{
  const { k, calls } = mkKernel({ granted: ['launch_apps'] });
  const r = await k.execute({ action: 'open_app', app: 'whatsapp' }, { dryRun: true });
  ok('dryRun validates without executing', r.ok && r.dryRun === true, JSON.stringify(r));
  ok('dryRun really did nothing', calls.length === 0);
}
{
  const { k } = mkKernel({ granted: ['launch_apps'] });
  await k.execute({ action: 'format_disk' });
  await k.execute({ action: 'open_app', app: 'whatsapp' }, { confirm: async () => true });
  ok('stats count proposals', k.stats.proposed === 2, String(k.stats.proposed));
  ok('stats count rejections', k.stats.rejected === 1, String(k.stats.rejected));
  ok('stats count executions', k.stats.executed === 1, String(k.stats.executed));
  ok('the journal records both', k.journal.length === 2, String(k.journal.length));
  ok('availability reports readiness',
     k.availability().some(c => c.name === 'desktop.launch_app' && c.ready));
  ok('availability explains what is not ready',
     k.availability().some(c => !c.ready && c.reasons.length > 0));
}
{
  // An executor that throws must not take the app down.
  const { k } = mkKernel({ granted: ['launch_apps'],
    exec: { 'desktop.launch_app': async () => { throw new Error('boom'); } } });
  const r = await k.execute({ action: 'open_app', app: 'x' }, { confirm: async () => true });
  ok('a throwing executor is contained', !r.ok && /boom/.test(r.error || ''), r.error);
  ok('and counted as a failure', k.stats.failed === 1);
}

/* ══════════════ WORLD MODEL ══════════════ */
sec('WORLD MODEL — state that persists between steps');

const w = new WorldModel();
ok('starts empty', w.actions.length === 0 && !w.isFresh('screen'));
w.setApps([{ id: 'whatsapp' }, { id: 'spotify' }]);
ok('records apps', w.apps.apps.length === 2 && w.isFresh('apps'));
w.setRunning(['spotify']);
ok('records running processes', w.isRunning('spotify') === true);
ok('knows what is NOT running', w.isRunning('whatsapp') === false);
w.processes.available = false;
ok('returns null when it genuinely cannot know', w.isRunning('spotify') === null);
w.processes.available = true;

w.setScreen({ text: 'File Edit View', activeApp: 'notepad' });
ok('records screen text', w.screen.text.includes('File'));
ok('screen is fresh right after observing', w.isFresh('screen'));

w.recordAction('desktop.launch_app', { app: 'whatsapp' }, { ok: true, summary: 'Opened' });
ok('launching updates the running list optimistically',
   w.processes.running.includes('whatsapp'), JSON.stringify(w.processes.running));
w.recordAction('input.click', { cell: 'C4' }, { ok: true });
ok('an input action invalidates the screen', !w.isFresh('screen'));

const desc = w.describe();
ok('describe() mentions running apps', /whatsapp/.test(desc), desc.slice(0, 90));
ok('describe() is time-stamped, not presented as now', /ago/.test(desc));
ok('describe() is bounded', w.describe({ maxChars: 100 }).length <= 100);
ok('snapshot exposes freshness',
   typeof w.snapshot().screen.fresh === 'boolean');
for (let i = 0; i < 80; i++) w.recordAction('flow.wait', {}, { ok: true });
ok('action history is bounded', w.actions.length <= 60, String(w.actions.length));

/* ══════════════ DESKTOP KNOWLEDGE ══════════════ */
sec('DESKTOP KNOWLEDGE — stop rediscovering Windows every step');

ok('whatsapp is known', !!APP_KNOWLEDGE.whatsapp);
ok('whatsapp search shortcut is recorded', APP_KNOWLEDGE.whatsapp.search.keys === 'ctrl+f');
ok('slack uses ctrl+k', APP_KNOWLEDGE.slack.search.keys === 'ctrl+k');
ok('Windows is known', !!OS_KNOWLEDGE.Windows);
ok('macOS close-button difference is captured',
   /top-LEFT/i.test(OS_KNOWLEDGE.Darwin.closeWindow), OS_KNOWLEDGE.Darwin.closeWindow);

ok('guessApp finds whatsapp', guessApp('open whatsapp and message Fiona') === 'whatsapp');
ok('guessApp handles "whats app"', guessApp('open whats app') === 'whatsapp');
ok('guessApp finds the browser from "chrome"', guessApp('open chrome') === 'browser');
ok('guessApp returns null when unsure', guessApp('do something vague') === null);

const kb = knowledgeFor({ app: 'whatsapp', os: 'Windows', task: 'message someone' });
ok('knowledge block mentions the search shortcut', /ctrl\+f/i.test(kb), kb.slice(0, 80));
ok('knowledge block mentions the usual sequence', /Usual sequence/.test(kb));
ok('knowledge block includes OS layout', /Taskbar/i.test(kb));
ok('knowledge is empty when nothing is known — no filler',
   knowledgeFor({ app: 'nonexistent-app' }) === '');
const closeKb = knowledgeFor({ os: 'Darwin', task: 'close the window' });
ok('a close task on macOS gets the top-left hint', /top-LEFT/i.test(closeKb), closeKb.slice(0, 70));

console.log(`\n${'─'.repeat(56)}`);
console.log(`  \x1b[32mPASS ${p}\x1b[0m   ${f ? `\x1b[31mFAIL ${f}\x1b[0m` : 'FAIL 0'}`);
if (f) { console.log('  Failed: ' + fails.join(', ')); process.exit(1); }
console.log('  RUNTIME ARCHITECTURE VERIFIED');
