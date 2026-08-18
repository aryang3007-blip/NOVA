/**
 * Model routing + built-in guide.
 * Uses the USER'S REAL installed models to prove the size ceiling holds.
 */
import { ModelRegistry, TASK, profileModel, parseParams, speedTier } from '../js/ai/model-registry.js';
import { matchGuide, GUIDE_TOPICS } from '../js/ai/guide.js';
import { IntentRouter, ROUTE } from '../js/ai/intent-router.js';

let p=0,f=0; const fails=[];
const ok=(n,c,x='')=>{c?(p++,console.log(`  \x1b[32m✓\x1b[0m ${n}`)):(f++,fails.push(n),console.log(`  \x1b[31m✗ ${n}\x1b[0m ${x}`));};
const eq=(n,a,b)=>ok(n,a===b,`got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
const sec=t=>console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);
class Mem{constructor(){this.m=new Map()}getItem(k){return this.m.get(k)??null}setItem(k,v){this.m.set(k,String(v))}removeItem(k){this.m.delete(k)}}

// EXACTLY the models the user reported pulling.
const USER_MODELS = [
  { name:'gemma2:2b',            size:1.6e9,  details:{parameter_size:'2.6B', family:'gemma2'} },
  { name:'qwen2.5-coder:7b',     size:4.7e9,  details:{parameter_size:'7.6B', family:'qwen2'} },
  { name:'qwen2.5-coder:14b',    size:9.0e9,  details:{parameter_size:'14.8B',family:'qwen2'} },
  { name:'gemma3:12b',           size:8.1e9,  details:{parameter_size:'12.2B',family:'gemma3'} },
  { name:'deepseek-r1:8b',       size:4.9e9,  details:{parameter_size:'8.0B', family:'qwen2'} },
  { name:'gpt-oss:20b',          size:13e9,   details:{parameter_size:'20.9B',family:'gptoss'} },
  { name:'qwen3:30b-a3b',        size:18e9,   details:{parameter_size:'30.5B',family:'qwen3'} },
];

sec('Parameter parsing');
eq('"2.6B" → 2.6', parseParams('2.6B'), 2.6);
eq('"30.5B" → 30.5', parseParams('30.5B'), 30.5);
eq('"500M" → 0.5', parseParams('500M'), 0.5);
ok('estimates from file size when absent', parseParams(null, 4.7e9) > 5);
eq('2.6B is instant', speedTier(2.6), 'instant');
eq('7.6B is fast', speedTier(7.6), 'fast');
eq('14.8B is moderate', speedTier(14.8), 'moderate');
eq('30.5B is slow', speedTier(30.5), 'slow');

sec('Capability inference (no hardcoded model list)');
{
  const g = profileModel(USER_MODELS[0]);
  ok('gemma2:2b → chat', g.capabilities.includes('chat'));
  const c7 = profileModel(USER_MODELS[1]);
  ok('qwen2.5-coder:7b → code', c7.capabilities.includes('code'));
  ok('  ↳ also tool-capable', c7.capabilities.includes('tools'));
  const r1 = profileModel(USER_MODELS[4]);
  ok('deepseek-r1:8b → reasoning', r1.capabilities.includes('reasoning'));
  const big = profileModel(USER_MODELS[6]);
  eq('qwen3:30b tier', big.tier, 'slow');
  ok('unknown future model still profiles', profileModel({name:'somenewmodel:4b',details:{parameter_size:'4B'}}).capabilities.includes('chat'));
}

sec('THE CEILING — big models must never auto-route');
{
  const r = new ModelRegistry({ storage: new Mem(), maxAutoParams: 9, strategy: 'speed' });
  r.ingest(USER_MODELS);
  eq('all 7 ingested', r.size, 7);

  const eligible = r.autoEligible().map(m=>m.name);
  ok('20B excluded', !eligible.includes('gpt-oss:20b'), eligible.join(','));
  ok('30B excluded', !eligible.includes('qwen3:30b-a3b'));
  ok('14B excluded (over 9B ceiling)', !eligible.includes('qwen2.5-coder:14b'));
  ok('12B excluded', !eligible.includes('gemma3:12b'));
  ok('2b eligible', eligible.includes('gemma2:2b'));
  ok('7b eligible', eligible.includes('qwen2.5-coder:7b'));
  ok('8b eligible', eligible.includes('deepseek-r1:8b'));

  const exc = r.excluded();
  ok('exclusions carry reasons', exc.every(e=>!!e.reason));
  ok('reason names the ceiling', exc.find(e=>e.name==='qwen3:30b-a3b').reason.includes('9B'));

  // The core guarantee, checked across every task.
  for (const task of Object.values(TASK)) {
    const sel = r.select(task);
    const m = r.get(sel.name);
    ok(`${task} never picks >9B`, m.params <= 9, `${sel.name} = ${m.params}B`);
  }
}

sec('Task routing — speed-first (user preference)');
{
  const r = new ModelRegistry({ storage: new Mem(), maxAutoParams: 9, strategy: 'speed' });
  r.ingest(USER_MODELS);
  eq('chat → gemma2:2b (fastest)', r.select(TASK.CHAT).name, 'gemma2:2b');
  eq('code → qwen2.5-coder:7b', r.select(TASK.CODE).name, 'qwen2.5-coder:7b');
  eq('reasoning → deepseek-r1:8b', r.select(TASK.REASONING).name, 'deepseek-r1:8b');
  ok('selection explains itself', r.select(TASK.CHAT).reason.length > 5, r.select(TASK.CHAT).reason);
}

sec('Task classification');
{
  const r = new ModelRegistry({ storage: new Mem() });
  r.ingest(USER_MODELS);
  eq('greeting → chat', r.classify('hello there'), TASK.CHAT);
  eq('short question → chat', r.classify('what time is it'), TASK.CHAT);
  eq('write code → code', r.classify('write a python function to sort a list'), TASK.CODE);
  eq('debug → code', r.classify('fix this bug in my javascript code'), TASK.CODE);
  eq('code fence → code', r.classify('what does ```const x=1``` do'), TASK.CODE);
  eq('analyse → reasoning', r.classify('analyse the trade-offs between these approaches'), TASK.REASONING);
  eq('long input → reasoning', r.classify('word '.repeat(60)), TASK.REASONING);
  eq('open app → tools', r.classify('open whatsapp', {hasToolContext:true}), TASK.TOOLS);
}

sec('Pinning overrides the ceiling — deliberately');
{
  const r = new ModelRegistry({ storage: new Mem(), maxAutoParams: 9 });
  r.ingest(USER_MODELS);
  r.pin(TASK.CODE, 'qwen2.5-coder:14b');
  const sel = r.select(TASK.CODE);
  eq('pin respected', sel.name, 'qwen2.5-coder:14b');
  ok('pin flagged as pinned', sel.pinned === true);
  ok('warns it is above the ceiling', /above the auto ceiling/i.test(sel.reason), sel.reason);
  r.pin(TASK.CODE, null);
  eq('unpin restores auto', r.select(TASK.CODE).name, 'qwen2.5-coder:7b');
}

sec('Measured latency demotes slow models');
{
  const r = new ModelRegistry({ storage: new Mem(), maxAutoParams: 9, strategy: 'speed' });
  r.ingest(USER_MODELS);
  eq('initially picks 2b for chat', r.select(TASK.CHAT).name, 'gemma2:2b');
  // Simulate gemma2:2b performing terribly on this machine.
  r.recordPerformance('gemma2:2b', 400, 200000);
  r.recordPerformance('gemma2:2b', 400, 200000);
  ok('slow model demoted from eligibility',
     !r.autoEligible().map(m=>m.name).includes('gemma2:2b'),
     r.autoEligible().map(m=>m.name).join(','));
  ok('a different model is chosen', r.select(TASK.CHAT).name !== 'gemma2:2b', r.select(TASK.CHAT).name);
  ok('measurement is persisted', r.perf['gemma2:2b'].samples === 2);
}

sec('Degenerate cases');
{
  const only30 = new ModelRegistry({ storage: new Mem(), maxAutoParams: 9 });
  only30.ingest([USER_MODELS[6]]);
  const s = only30.select(TASK.CHAT);
  eq('only-big-model still returns something', s.name, 'qwen3:30b-a3b');
  ok('  ↳ and explains why', /no model under/i.test(s.reason), s.reason);

  const empty = new ModelRegistry({ storage: new Mem() });
  empty.ingest([]);
  eq('no models → null', empty.select(TASK.CHAT), null);

  const emb = new ModelRegistry({ storage: new Mem() });
  emb.ingest([{name:'nomic-embed-text',size:3e8,details:{parameter_size:'137M'}}, USER_MODELS[0]]);
  ok('embedding model never selected', emb.select(TASK.CHAT).name === 'gemma2:2b');
  ok('  ↳ excluded with reason', emb.excluded().some(e=>/embedding/i.test(e.reason)));
}

sec('Persistence');
{
  const st = new Mem();
  const a = new ModelRegistry({ storage: st, maxAutoParams: 9 });
  a.ingest(USER_MODELS); a.pin(TASK.CODE,'qwen2.5-coder:14b'); a.recordPerformance('gemma2:2b',1000,2000);
  const b = new ModelRegistry({ storage: st });
  b.ingest(USER_MODELS);
  eq('pins persist', b.pins[TASK.CODE], 'qwen2.5-coder:14b');
  ok('perf persists', !!b.perf['gemma2:2b']);
}

sec('Built-in guide — works with NO model');
{
  const ctx = { provider:'Local Core', model:null, ollamaReady:false, sttSupported:true,
                cameraActive:false, desktopSimulated:true, permsGranted:0, permsTotal:13,
                commandCount:55, pluginCount:18, wakeWord:'aura', ttsEnabled:true,
                hands:0, faces:0, objects:0 };
  const q = (t)=>matchGuide(t, ctx);
  ok('"how do i use this app"', !!q('how do i use this app'));
  ok('"how does this work"', !!q('how does this work'));
  ok('"getting started"', !!q('getting started'));
  eq('  ↳ topic', q('how do i use this app').topic, 'overview');
  eq('ollama setup', q('how do i set up ollama').topic, 'ollama');
  eq('ollama not working', q('ollama is not working').topic, 'ollama');
  eq('gestures', q('how do gestures work').topic, 'gestures');
  eq('voice', q('how do i use voice').topic, 'voice');
  eq('desktop', q('how do i open apps').topic, 'desktop');
  eq('camera', q('how do i enable the camera').topic, 'vision');
  eq('privacy', q('is my data private').topic, 'privacy');
  eq('commands', q('what commands are there').topic, 'commands');
  eq('troubleshooting', q('nothing is working').topic, 'troubleshooting');
  eq('shortcuts', q('keyboard shortcuts').topic, 'shortcuts');
  eq('model routing', q('which model are you using').topic, 'models');
  eq('slow', q('why is it so slow').topic, 'models');

  ok('answers are substantial', q('how do i use this app').text.length > 300);
  ok('reflects LIVE state (offline core)', /offline core/i.test(q('how do i use this app').text));
  ok('reflects camera being off', /camera is off/i.test(q('how do i enable the camera').text));
  ok('reflects permission count', q('how do i open apps').text.includes('0/13'));

  const live = { ...ctx, provider:'Ollama (local)', model:'gemma2:2b', ollamaReady:true,
                 ollamaModel:'gemma2:2b', cameraActive:true, hands:2, faces:1,
                 desktopSimulated:false, platform:'Windows', permsGranted:5 };
  ok('adapts when Ollama IS connected', /already connected/i.test(matchGuide('how do i set up ollama', live).text));
  ok('adapts when camera IS on', /Camera is live/i.test(matchGuide('how do i enable the camera', live).text));
  ok('adapts when desktop IS live', /\*\*Live\*\* on Windows/i.test(matchGuide('how do i open apps', live).text));

  ok('normal chat is NOT captured', q('hello how are you') === null);
  ok('maths is NOT captured', q('what is 47*89') === null);
  ok('general question NOT captured', q('what is quantum computing') === null);
  eq('all topics reachable', GUIDE_TOPICS.length, 11);
}

sec('Router integration — GUIDE outranks WEB');
{
  const r = new IntentRouter();
  const C = { desktopReady:true, liveDataEnabled:true, guideContext:{ provider:'Local Core', permsGranted:0, permsTotal:13, commandCount:55, pluginCount:18 } };
  eq('"how do i use this app" → GUIDE', r.route('how do i use this app', C).route, ROUTE.GUIDE);
  eq('"how do i set up ollama" → GUIDE', r.route('how do i set up ollama', C).route, ROUTE.GUIDE);
  eq('"is my data private" → GUIDE', r.route('is my data private', C).route, ROUTE.GUIDE);
  eq('maths still MATH', r.route('what is 47*89', C).route, ROUTE.MATH);
  eq('open app still TOOL', r.route('open whatsapp', C).route, ROUTE.TOOL);
  eq('external topic still WEB', r.route('what is quantum computing', C).route, ROUTE.WEB);
  ok('GUIDE outranks WEB',
     r.route('how do i use this app', C).priority < r.route('what is quantum computing', C).priority);
  ok('MATH still outranks GUIDE',
     r.route('what is 47*89', C).priority < r.route('how do i use this app', C).priority);
}

sec('Questions must never trigger actions');
{
  const r = new IntentRouter();
  const C = { desktopReady:true, liveDataEnabled:true,
              guideContext:{ provider:'Local Core', permsGranted:0, permsTotal:13, commandCount:55, pluginCount:18 } };
  const asks = ['how do i enable the camera','how do i open apps','how do i open whatsapp',
                'how do i use voice','how do i take a screenshot','how do i clear the chat',
                'what is the camera','how to open spotify'];
  for (const q of asks) {
    const rt = r.route(q, C).route;
    ok(`ASK "${q}" does not act`, !['system','tool'].includes(rt), `→ ${rt}`);
  }
  const cmds = ['open the camera','turn off the camera','clear the chat','change theme',
                'open whatsapp','volume 40','take a screenshot'];
  for (const q of cmds) {
    const rt = r.route(q, C).route;
    ok(`CMD "${q}" acts`, ['system','tool'].includes(rt), `→ ${rt}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * CAPABILITIES REPORTED BY OLLAMA OVERRIDE NAME GUESSES
 *
 * Regression guard for the gemma4 bug: profileModel() used to infer
 * "vision" purely from the model name. /api/show now supplies the truth
 * and the profile must defer to it, in both directions.
 * ══════════════════════════════════════════════════════════════════════ */
{
  console.log('\n\x1b[36m▸ REAL CAPABILITIES BEAT NAME GUESSES\x1b[0m');

  const g4 = profileModel({ name:'gemma4:12b', size:7e9,
    details:{ parameter_size:'12.0B' }, caps:['completion','vision','tools'] });
  ok('gemma4 gains vision from Ollama', g4.capabilities.includes('vision'));
  ok('gemma4 gains tools from Ollama', g4.capabilities.includes('tools'));
  ok('gemma4 flagged as verified', g4.capsAreReal === true);

  // A name that LOOKS multimodal but is reported text-only.
  const g3 = profileModel({ name:'gemma3:12b', size:8e9,
    details:{ parameter_size:'12.2B' }, caps:['completion'] });
  ok('reported text-only strips a guessed vision cap', !g3.capabilities.includes('vision'));

  // No caps field (older Ollama) → heuristics still apply, flagged unverified.
  const legacy = profileModel({ name:'llava:7b', size:4.7e9,
    details:{ parameter_size:'7.0B' } });
  ok('no caps field → falls back to the name', legacy.capabilities.includes('vision'));
  ok('fallback is marked unverified', legacy.capsAreReal === false);

  // An embedding model reported as such must never be offered for chat.
  const emb = profileModel({ name:'some-retriever:1b', size:3e8,
    details:{ parameter_size:'0.3B' }, caps:['embedding'] });
  ok('reported embedding model is excluded from chat', emb.isEmbedding === true);

  // Thinking capability maps onto the reasoning task.
  const r1 = profileModel({ name:'deepseek-r1:8b', size:5e9,
    details:{ parameter_size:'8.0B' }, caps:['completion','thinking'] });
  ok('reported thinking → reasoning capability', r1.capabilities.includes('reasoning'));

  // VISION routing must prefer the cheapest model that can actually see.
  const reg = new ModelRegistry({ storage: new Mem(), maxAutoParams: 9, strategy: 'speed' });
  reg.ingest([
    { name:'gemma2:2b',    size:1.6e9, details:{parameter_size:'2.6B'},  caps:['completion'] },
    { name:'gemma3:12b',   size:8.1e9, details:{parameter_size:'12.2B'}, caps:['completion','vision'] },
    { name:'gemma4:12b',   size:7.0e9, details:{parameter_size:'12.0B'}, caps:['completion','vision','tools'] },
    { name:'qwen2.5vl:7b', size:6.0e9, details:{parameter_size:'7.6B'},  caps:['completion','vision'] },
  ]);
  const v = reg.select(TASK.VISION);
  ok('vision task picks a model that can see',
     reg.get(v.name).capabilities.includes('vision'), v.name);
  ok('vision task prefers the 7B over either 12B', v.name === 'qwen2.5vl:7b', v.name);
  ok('chat is untouched by vision routing', reg.select(TASK.CHAT).name === 'gemma2:2b');
}

/* ══════════════════════════════════════════════════════════════════════
 * REGRESSION: a caption-only model must never become the CHAT model.
 *
 * The user pulled moondream (1.7B). Being the smallest installed model, the
 * speed-first router promoted it to CHAT for everything — including /do's
 * planner, which then returned an empty string four times in a row.
 * ══════════════════════════════════════════════════════════════════════ */
{
  console.log('\n\x1b[36m▸ CAPTION-ONLY MODELS ARE NOT CHAT MODELS\x1b[0m');
  const r = new ModelRegistry({ storage: new Mem(), maxAutoParams: 9, strategy: 'speed' });
  r.ingest([
    { name:'moondream:latest', size:1.7e9, details:{parameter_size:'1.7B'},  caps:['completion','vision'] },
    { name:'gemma2:2b',        size:1.6e9, details:{parameter_size:'2.6B'},  caps:['completion'] },
    { name:'qwen2.5vl:7b',     size:6.0e9, details:{parameter_size:'7.6B'},  caps:['completion','vision'] },
    { name:'qwen2.5-coder:7b', size:4.7e9, details:{parameter_size:'7.6B'},  caps:['completion','tools'] },
  ]);
  ok('chat does NOT route to moondream', r.select(TASK.CHAT).name !== 'moondream:latest',
     r.select(TASK.CHAT).name);
  ok('chat routes to the 2B text model', r.select(TASK.CHAT).name === 'gemma2:2b');
  ok('moondream is excluded from auto-routing',
     !r.autoEligible().map(m => m.name).includes('moondream:latest'));
  ok('the exclusion reason is honest',
     /captioner/i.test(r.excluded().find(m => m.name === 'moondream:latest')?.reason || ''),
     r.excluded().find(m => m.name === 'moondream:latest')?.reason);
  ok('vision still routes to a real multimodal model',
     r.select(TASK.VISION).name === 'qwen2.5vl:7b', r.select(TASK.VISION).name);
  ok('a 7B multimodal model is NOT treated as caption-only',
     r.autoEligible().map(m => m.name).includes('qwen2.5vl:7b'));

  // Even when a captioner is the only thing installed, chat must prefer
  // anything else that can talk.
  const r2 = new ModelRegistry({ storage: new Mem(), maxAutoParams: 9 });
  r2.ingest([
    { name:'moondream', size:1.7e9, details:{parameter_size:'1.7B'}, caps:['completion','vision'] },
    { name:'gemma2:2b', size:1.6e9, details:{parameter_size:'2.6B'}, caps:['completion'] },
  ]);
  ok('with only a captioner + 2B, chat picks the 2B',
     r2.select(TASK.CHAT).name === 'gemma2:2b', r2.select(TASK.CHAT).name);

  // Truly nothing else — must still return something rather than null.
  const r3 = new ModelRegistry({ storage: new Mem(), maxAutoParams: 9 });
  r3.ingest([{ name:'moondream', size:1.7e9, details:{parameter_size:'1.7B'}, caps:['completion','vision'] }]);
  ok('a lone captioner is still returned rather than nothing',
     r3.select(TASK.CHAT)?.name === 'moondream', String(r3.select(TASK.CHAT)?.name));
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`  \x1b[32mPASS ${p}\x1b[0m   ${f?`\x1b[31mFAIL ${f}\x1b[0m`:'FAIL 0'}`);
if(f){console.log('  Failed: '+fails.join(', '));process.exit(1);}
console.log('  MODEL ROUTING + GUIDE VERIFIED');
