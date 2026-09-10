/**
 * NOVA :: proactive engine tests
 * ===============================
 *   node tests/test-proactive.mjs
 */
import { ProactiveEngine, fmtDur, truncate } from '../js/proactive/engine.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}  \x1b[90m${d}\x1b[0m`); }
};
const sec = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

const EV = { AGENT_STATE: 'agent:state', PROACTIVE_NOTIFY: 'assistant:proactive' };
const fakeBus = () => {
  const subs = {};
  const fired = [];
  return {
    subs, fired,
    on: (e, h) => { (subs[e] = subs[e] || []).push(h); },
    off: (e, h) => { subs[e] = (subs[e] || []).filter((f) => f !== h); },
    emit: (e, p) => { fired.push([e, p]); (subs[e] || []).forEach((h) => h(p)); },
  };
};
const fakeConfig = (over = {}) => {
  const d = {
    proactiveEnabled: true, proactiveVoice: true,
    proactiveRules: { longTask: true, taskFailed: true, backOnline: true, lowBattery: true },
    proactiveLongTaskSec: 60, proactiveBatteryPct: 20, proactiveCooldownSec: 300,
    ...over,
  };
  return { get: (k) => d[k] };
};
const clock = () => { let t = 1_000_000; return { now: () => t, adv: (ms) => { t += ms; } }; };
const mk = (over = {}, batt = null) => {
  const c = clock();
  const bus = fakeBus();
  const eng = new ProactiveEngine({
    bus, EV, config: fakeConfig(over), clock: c.now,
    battery: batt || (async () => null),
  }).start();
  return { eng, bus, c };
};
const notifies = (bus) => bus.fired.filter(([e]) => e === EV.PROACTIVE_NOTIFY).map(([, p]) => p);

sec('long tasks');
{
  const { eng, bus, c } = mk();
  eng.handleAgentState({ state: 'executing', taskId: 't1' });
  c.adv(90_000);
  eng.handleAgentState({ state: 'succeeded', taskId: 't1', steps: 4, message: 'Deck written.' });
  const n = notifies(bus);
  ok('long task fires', n.length === 1 && n[0].rule === 'longTask', JSON.stringify(n));
  ok('duration + steps in text', /1m 30s/.test(n[0].title) && /4 steps/.test(n[0].text),
    `${n[0].title} / ${n[0].text}`);
  ok('long task is toast-only', n[0].speak === false);
}
{
  const { eng, bus, c } = mk();
  eng.handleAgentState({ state: 'executing', taskId: 't2' });
  c.adv(10_000);
  eng.handleAgentState({ state: 'succeeded', taskId: 't2', steps: 1, message: 'ok' });
  ok('short task stays silent', notifies(bus).length === 0);
}

sec('failures');
{
  const { eng, bus, c } = mk();
  eng.handleAgentState({ state: 'executing', taskId: 't3' });
  c.adv(5_000);
  eng.handleAgentState({ state: 'failed', taskId: 't3', steps: 2, message: 'Chrome vanished.' });
  const n = notifies(bus);
  ok('failed task fires regardless of duration', n.length === 1 && n[0].rule === 'taskFailed');
  ok('failure carries the reason', /Chrome vanished/.test(n[0].text), n[0].text);
  ok('failure is spoken', n[0].speak === true);
}
{
  const { eng, bus } = mk();
  eng.handleAgentState({ state: 'executing', taskId: 't4' });
  eng.handleAgentState({ state: 'cancelled', taskId: 't4' });
  eng.handleAgentState({ state: 'idle', taskId: 't4' });
  ok('cancelled/idle stays silent', notifies(bus).length === 0);
}

sec('gating: master, rules, cooldown');
{
  const { eng, bus, c } = mk({ proactiveEnabled: false });
  eng.handleAgentState({ state: 'executing', taskId: 't5' });
  c.adv(120_000);
  eng.handleAgentState({ state: 'succeeded', taskId: 't5', steps: 3, message: 'x' });
  eng.handleOnlineStatus(false); eng.handleOnlineStatus(true);
  ok('master off silences everything', notifies(bus).length === 0);
}
{
  const { eng, bus, c } = mk({ proactiveRules: { longTask: false } });
  eng.handleAgentState({ state: 'executing', taskId: 't6' });
  c.adv(120_000);
  eng.handleAgentState({ state: 'succeeded', taskId: 't6', steps: 3, message: 'x' });
  ok('single rule off silences that rule', notifies(bus).length === 0);
}
{
  const { eng, bus } = mk({ proactiveCooldownSec: 300 });
  eng.handleOnlineStatus(true);   // baseline
  eng.handleOnlineStatus(false);
  eng.handleOnlineStatus(true);   // fires #1
  eng.handleOnlineStatus(false);
  eng.handleOnlineStatus(true);   // cooldown: silent
  ok('cooldown suppresses repeats', notifies(bus).length === 1, String(notifies(bus).length));
}

sec('connectivity + battery');
{
  const { eng, bus } = mk();
  eng.handleOnlineStatus(true);
  eng.handleOnlineStatus(true);
  ok('stable online stays silent', notifies(bus).length === 0);
  eng.handleOnlineStatus(false);
  ok('going offline stays silent (nothing to act on yet)', notifies(bus).length === 0);
  eng.handleOnlineStatus(true);
  const n = notifies(bus);
  ok('offline->online fires once', n.length === 1 && n[0].rule === 'backOnline');
}
{
  const { eng, bus } = mk({}, async () => ({ level: 0.15, charging: false }));
  await eng.pollBattery();
  const n = notifies(bus);
  ok('15% battery fires', n.length === 1 && n[0].rule === 'lowBattery', JSON.stringify(n));
  ok('battery text names the level', /15%/.test(n[0].title), n[0].title);
  await eng.pollBattery();
  ok('repeat poll stays silent until recharged', notifies(bus).length === 1);
}
{
  const { eng, bus } = mk({}, async () => ({ level: 0.9, charging: true }));
  await eng.pollBattery();
  ok('charging stays silent', notifies(bus).length === 0);
}
{
  const { eng, bus } = mk({}, async () => { throw new Error('no api'); });
  await eng.pollBattery();
  ok('missing battery API never crashes', notifies(bus).length === 0);
}

sec('helpers + lifecycle');
{
  ok('fmtDur 90s', fmtDur(90) === '1m 30s', fmtDur(90));
  ok('fmtDur 45s', fmtDur(45) === '45s', fmtDur(45));
  ok('truncate cuts with ellipsis', truncate('abcdef', 4) === 'abc…', truncate('abcdef', 4));
  const { eng, bus } = mk();
  ok('start subscribes AGENT_STATE', (bus.subs[EV.AGENT_STATE] || []).length === 1);
  eng.stop();
  ok('stop unsubscribes', (bus.subs[EV.AGENT_STATE] || []).length === 0);
}

console.log(`\n  PASS ${P}  FAIL ${F}\n`);
process.exit(F ? 1 : 0);
