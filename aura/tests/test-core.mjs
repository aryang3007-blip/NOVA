/**
 * AURA :: Core unit tests (Node, no browser).
 * Run: node tests/test-core.mjs
 */
import { evaluateMath, convertUnits, detectIntent, localRespond, chunkText, formatNumber } from '../js/ai/local-core.js';
import { EventBus } from '../js/core/bus.js';
import { Store } from '../js/core/state.js';
import { PluginRegistry } from '../js/core/plugins.js';
import { classifyGesture, fingersUp } from '../js/vision/gesture-classifier.js';
import { Memory } from '../js/ai/memory.js';

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; fails.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`); }
}
function eq(name, actual, expected, tol = 1e-9) {
  const good = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(actual - expected) <= tol
    : actual === expected;
  ok(name, good, `got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}
function section(t) { console.log(`\n\x1b[36m▸ ${t}\x1b[0m`); }

/* ── math ── */
section('Math parser');
eq('2+2', evaluateMath('2+2'), 4);
eq('order of ops', evaluateMath('2+3*4'), 14);
eq('parens', evaluateMath('(2+3)*4'), 20);
eq('power right-assoc', evaluateMath('2^3^2'), 512);
eq('negative', evaluateMath('-5 + 3'), -2);
eq('decimals', evaluateMath('0.1+0.2'), 0.30000000000000004, 1e-15);
eq('sqrt', evaluateMath('sqrt(144)'), 12);
eq('nested fn', evaluateMath('sqrt(abs(-16))'), 4);
eq('pi const', evaluateMath('pi'), Math.PI);
eq('implicit mult 2pi', evaluateMath('2pi'), Math.PI * 2, 1e-12);
eq('implicit paren 2(3+1)', evaluateMath('2(3+1)'), 8);
eq('modulo', evaluateMath('17 % 5'), 2);
eq('factorial', evaluateMath('5!'), 120);
eq('log10', evaluateMath('log(1000)'), 3, 1e-12);
eq('ln e', evaluateMath('ln(e)'), 1, 1e-12);
eq('sin 0', evaluateMath('sin(0)'), 0);
eq('deg', evaluateMath('deg(pi)'), 180, 1e-9);
eq('commas stripped', evaluateMath('1,000 + 500'), 1500);
eq('word times', evaluateMath('7 times 6'), 42);
eq('squared', evaluateMath('9 squared'), 81);
eq('big', evaluateMath('123456 * 654321'), 80779853376);
ok('div by zero throws', (() => { try { evaluateMath('5/0'); return false; } catch { return true; } })());
ok('bad symbol throws', (() => { try { evaluateMath('2 + foo'); return false; } catch { return true; } })());
ok('unbalanced throws', (() => { try { evaluateMath('(2+3'); return false; } catch { return true; } })());
ok('no eval injection', (() => { try { evaluateMath('process.exit(1)'); return false; } catch { return true; } })());

section('Number formatting');
eq('int commas', formatNumber(1234567), '1,234,567');
eq('float', formatNumber(3.14159), '3.14159');

/* ── units ── */
section('Unit conversion');
eq('km→mi', convertUnits(5, 'km', 'miles').value, 3.10686, 1e-4);
eq('kg→lb', convertUnits(70, 'kg', 'lbs').value, 154.324, 1e-2);
eq('c→f', convertUnits(100, 'c', 'f').value, 212, 1e-9);
eq('f→c', convertUnits(32, 'f', 'c').value, 0, 1e-9);
eq('c→k', convertUnits(0, 'celsius', 'kelvin').value, 273.15, 1e-9);
eq('gb→mb', convertUnits(2, 'gb', 'mb').value, 2000, 1e-6);
eq('hours→min', convertUnits(2, 'hours', 'minutes').value, 120, 1e-9);
eq('ft→m', convertUnits(10, 'ft', 'm').value, 3.048, 1e-9);
ok('cross-domain rejected', convertUnits(5, 'kg', 'meters') === null);
ok('unknown unit rejected', convertUnits(5, 'blorp', 'm') === null);

/* ── intents ── */
section('Intent detection');
eq('greeting', detectIntent('hello there').intent, 'greeting');
eq('greeting hey', detectIntent('hey').intent, 'greeting');
eq('time', detectIntent('what time is it').intent, 'time');
eq('date', detectIntent("what's today's date").intent, 'date');
eq('math', detectIntent('what is 15 * 23').intent, 'math');
eq('math bare', detectIntent('2+2').intent, 'math');
eq('convert', detectIntent('convert 10 km to miles').intent, 'convert');
eq('vision', detectIntent('what do you see').intent, 'vision-describe');
eq('vision2', detectIntent('describe what you see').intent, 'vision-describe');
eq('memory', detectIntent('what did i just say').intent, 'memory-recall');
eq('setname', detectIntent('my name is Tony').intent, 'set-name');
eq('setname value', detectIntent('my name is Tony').name, 'Tony');
eq('getname', detectIntent("what's my name").intent, 'get-name');
eq('camera on', detectIntent('open the camera').cmd, 'camera-on');
eq('camera off', detectIntent('turn off the webcam').cmd, 'camera-off');
eq('status', detectIntent('system status').intent, 'status');
eq('knowledge recursion', detectIntent('explain recursion').intent, 'knowledge');
eq('knowledge closure', detectIntent('what is a closure').intent, 'knowledge');
eq('code fizzbuzz', detectIntent('write fizzbuzz').intent, 'code');
eq('code lang py', detectIntent('write fizzbuzz in python').lang, 'python');
eq('command', detectIntent('/help').intent, 'command');
eq('unknown q', detectIntent('who won the 1998 world cup').intent, 'unknown-question');
eq('capabilities', detectIntent('what can you do').intent, 'knowledge');
ok('time complexity is NOT time intent', detectIntent('explain time complexity').intent !== 'time');

/* ── responses ── */
section('Local responses');
const r1 = localRespond('what is 12*12');
ok('math answer contains 144', r1.text.includes('144'), r1.text);
const r2 = localRespond('hello');
ok('greeting non-empty', r2.text.length > 5);
ok('greeting emotion happy', r2.emotion === 'happy');
const r3 = localRespond('what do you see', { vision: { cameraActive: false } });
ok('vision off is honest', /can'?t see|camera is offline/i.test(r3.text), r3.text);
const r4 = localRespond('what do you see', { vision: { cameraActive: true, description: 'I see 1 hand and 1 face.' } });
ok('vision on uses description', r4.text.includes('1 hand'), r4.text);
const r5 = localRespond('what did i just say', { history: [{ role: 'user', content: 'hello world' }] });
ok('recall echoes history', r5.text.includes('hello world'), r5.text);
const r6 = localRespond('who won the 1998 world cup');
ok('unknown admits limits', /outside my offline|won'?t invent/i.test(r6.text), r6.text);
ok('never claims fake ability', !/i (just )?(searched|googled|looked up) (the )?(web|internet)/i.test(r6.text));
const r7 = localRespond('convert 100 c to f');
ok('convert answer 212', r7.text.includes('212'), r7.text);
const r8 = localRespond('explain recursion');
ok('recursion mentions base case', /base case/i.test(r8.text));
const r9 = localRespond('my name is Ada');
eq('set-name action', r9.action, 'set-name');
const r10 = localRespond("what's my name", { memory: { userName: 'Ada' } });
ok('get-name recalls', r10.text.includes('Ada'), r10.text);

section('Chunking');
const chunks = chunkText('The quick brown fox jumps over the lazy dog', 3);
ok('chunks produced', chunks.length >= 3);
eq('chunks rejoin exactly', chunks.join(''), 'The quick brown fox jumps over the lazy dog');

/* ── bus ── */
section('EventBus');
{
  const b = new EventBus();
  let got = null;
  const off = b.on('x', (p) => { got = p; });
  b.emit('x', 42);
  eq('receives payload', got, 42);
  off();
  b.emit('x', 99);
  eq('unsubscribe works', got, 42);

  let onceCount = 0;
  b.once('y', () => onceCount++);
  b.emit('y'); b.emit('y');
  eq('once fires once', onceCount, 1);

  let wild = 0;
  b.on('*', () => wild++);
  b.emit('a'); b.emit('b');
  eq('wildcard sees all', wild, 2);

  let after = false;
  b.on('z', () => { throw new Error('boom'); });
  b.on('z', () => { after = true; });
  b.emit('z');
  ok('error isolation: later handler still runs', after);

  ok('history recorded', b.history.length > 0);
}

/* ── store ── */
section('Store');
{
  const s = new Store({ a: 1 });
  let seen = null;
  s.watch('a', v => { seen = v; });
  s.set('a', 2);
  eq('watcher fired', seen, 2);
  seen = null;
  s.set('a', 2);
  ok('no fire on same value', seen === null);
  s.set({ b: 5, c: 6 });
  eq('multi set b', s.get('b'), 5);
  s.update('b', v => v * 2);
  eq('update fn', s.get('b'), 10);
}

/* ── plugins ── */
section('Plugin registry');
{
  const reg = new PluginRegistry({ test: true });
  let setupCtx = null;
  reg.register({
    id: 'demo', name: 'Demo', description: 'd',
    setup: (ctx) => { setupCtx = ctx; },
    commands: [{ name: 'echo', usage: '/echo <t>', run: async (args) => `echo:${args}` }],
    context: () => 'demo-context',
  });
  ok('setup called with ctx', setupCtx && setupCtx.test === true);
  ok('command registered', reg.has('echo'));
  const res = await reg.run('/echo hi there');
  eq('command output', res.output, 'echo:hi there');
  const bad = await reg.run('/nope');
  ok('unknown command reports', !!bad.error);
  const plain = await reg.run('just text');
  ok('non-command passes through', plain.handled === false);
  ok('context collected', reg.collectContext().includes('demo-context'));
  reg.register({ id: 'thrower', name: 'T', commands: [{ name: 'bad', run: async () => { throw new Error('x'); } }] });
  const t = await reg.run('/bad');
  ok('throwing command is caught', !!t.error);
  reg.unregister('demo');
  ok('unregister removes command', !reg.has('echo'));
}

/* ── memory ── */
section('Memory');
{
  const m = new Memory({ maxTurns: 4, persist: false });
  m.addUser('one'); m.addAssistant('1');
  m.addUser('two'); m.addAssistant('2');
  m.addUser('three'); m.addAssistant('3');
  const win = m.window();
  ok('window respects maxTurns', win.length <= 8, `len=${win.length}`);
  ok('window keeps most recent', win[win.length - 1].content === '3');
  m.setFact('userName', 'Ada');
  eq('fact stored', m.getFact('userName'), 'Ada');
  ok('facts in summary', m.summary().includes('Ada'));
  eq('all length', m.all().length, 6);
  m.clear();
  eq('cleared', m.all().length, 0);
}

/* ── gestures ── */
section('Gesture classifier');
{
  // Build synthetic 21-point hands. MediaPipe order:
  // 0 wrist,1-4 thumb,5-8 index,9-12 middle,13-16 ring,17-20 pinky
  function hand({ thumb = false, index = false, middle = false, ring = false, pinky = false, thumbSide = false } = {}) {
    const L = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    L[0] = { x: 0.5, y: 0.9, z: 0 };                      // wrist bottom
    // MCP row (knuckles) at y=0.62
    [5, 9, 13, 17].forEach((i, k) => { L[i] = { x: 0.40 + k * 0.05, y: 0.62, z: 0 }; });
    L[1] = { x: 0.34, y: 0.78, z: 0 }; L[2] = { x: 0.31, y: 0.72, z: 0 };
    L[3] = { x: 0.29, y: 0.68, z: 0 };
    // thumb tip: up = well above wrist; side/curled = near palm
    L[4] = thumb ? { x: 0.27, y: 0.50, z: 0 } : (thumbSide ? { x: 0.44, y: 0.68, z: 0 } : { x: 0.45, y: 0.66, z: 0 });
    const finger = (mcp, pip, dip, tip, up) => {
      L[pip] = { x: L[mcp].x, y: up ? 0.52 : 0.58, z: 0 };
      L[dip] = { x: L[mcp].x, y: up ? 0.45 : 0.63, z: 0 };
      L[tip] = { x: L[mcp].x, y: up ? 0.36 : 0.67, z: 0 };
    };
    finger(5, 6, 7, 8, index);
    finger(9, 10, 11, 12, middle);
    finger(13, 14, 15, 16, ring);
    finger(17, 18, 19, 20, pinky);
    return L;
  }

  const openPalm = hand({ thumb: true, index: true, middle: true, ring: true, pinky: true });
  const upArr = fingersUp(openPalm);
  ok('fingersUp: open palm = 5', upArr.filter(Boolean).length === 5, JSON.stringify(upArr));
  eq('open palm classified', classifyGesture(openPalm).gesture, 'open_palm');

  const fist = hand({});
  eq('fist classified', classifyGesture(fist).gesture, 'fist');

  const peace = hand({ index: true, middle: true });
  eq('peace classified', classifyGesture(peace).gesture, 'peace');

  const point = hand({ index: true });
  eq('point classified', classifyGesture(point).gesture, 'pointing');

  const thumbsUp = hand({ thumb: true });
  eq('thumbs up classified', classifyGesture(thumbsUp).gesture, 'thumbs_up');

  ok('confidence in range', (() => { const c = classifyGesture(openPalm).confidence; return c > 0 && c <= 1; })());
  eq('null hand safe', classifyGesture(null).gesture, 'none');
  eq('short array safe', classifyGesture([{ x: 0, y: 0 }]).gesture, 'none');
}

console.log(`\n${'─'.repeat(52)}`);
/* ── plugin output coercion (regression) ───────────────────────────────
   A command that streams its own reply returns null. JSON.stringify turned
   that into the literal string "null", which was then printed in the chat —
   seen with /look before the fix. */
{
  const reg = new PluginRegistry();
  reg.setContext({});
  reg.register({
    id: 'nulltest', name: 'Null Test', description: 'x',
    commands: [
      { name: 'streams', run: async () => null },
      { name: 'undef', run: async () => undefined },
      { name: 'text', run: async () => 'hello' },
      { name: 'obj', run: async () => ({ a: 1 }) },
    ],
  });
  const a = await reg.run('/streams');
  ok('null output is preserved, not stringified', a.handled && a.output === null, JSON.stringify(a.output));
  const b = await reg.run('/undef');
  ok('undefined output is preserved', b.handled && b.output === null, JSON.stringify(b.output));
  const c = await reg.run('/text');
  ok('string output passes through', c.output === 'hello');
  const d = await reg.run('/obj');
  ok('object output is still stringified', typeof d.output === 'string' && d.output.includes('"a"'));
}

console.log(`  \x1b[32mPASS ${pass}\x1b[0m   ${fail ? `\x1b[31mFAIL ${fail}\x1b[0m` : 'FAIL 0'}`);
if (fail) { console.log('  Failed: ' + fails.join(', ')); process.exit(1); }

console.log('  ALL CORE TESTS PASSED');
