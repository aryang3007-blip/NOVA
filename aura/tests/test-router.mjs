/** Priority intent router + memory + hardware + tools. */
import { IntentRouter, ROUTE, checkMath, checkSafety } from '../js/ai/intent-router.js';
import { MemoryManager, ConversationMemory, PreferenceMemory, SystemStateMemory, KnowledgeMemory } from '../js/memory/memory-manager.js';
import { InMemoryStorage, VectorStore, tokenize } from '../js/memory/storage.js';
import { HardwareRegistry, DeviceManager } from '../js/runtime/hardware/registry.js';
import { validateToolCall, normalizeToolCall, extractToolCalls, toToolResult, buildToolManifest, TOOLS } from '../js/ai/tools.js';

let p=0,f=0; const fails=[];
const ok=(n,c,x='')=>{c?(p++,console.log(`  \x1b[32m✓\x1b[0m ${n}`)):(f++,fails.push(n),console.log(`  \x1b[31m✗ ${n}\x1b[0m ${x}`));};
const eq=(n,a,b)=>ok(n,a===b,`got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
const sec=t=>console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);
const mem=(ns)=>new InMemoryStorage({namespace:ns});

sec('Intent Router — priority order');
{
  const r = new IntentRouter();
  const C = { desktopReady: true, liveDataEnabled: true };
  const route = (t) => r.route(t, C).route;

  // THE regression: math must beat web/knowledge
  eq('"what is 47*89" → MATH', route('what is 47*89'), ROUTE.MATH);
  eq('"what is 2+2" → MATH', route('what is 2 + 2'), ROUTE.MATH);
  eq('"sqrt(144)" → MATH', route('what is sqrt(144)'), ROUTE.MATH);
  eq('"15% of 200" style → MATH', route('what is 200 * 0.15'), ROUTE.MATH);
  eq('unit conversion → MATH', route('convert 10 km to miles'), ROUTE.MATH);
  const d = r.route('what is 47*89', C);
  eq('  ↳ math actually evaluated', d.payload.value, 4183);

  eq('"open whatsapp" → TOOL', route('open whatsapp'), ROUTE.TOOL);
  eq('"launch spotify" → TOOL', route('launch spotify'), ROUTE.TOOL);
  eq('"volume 40" → TOOL', route('volume 40'), ROUTE.TOOL);
  eq('"take a screenshot" → TOOL', route('take a screenshot'), ROUTE.TOOL);

  eq('"what is quantum computing" → WEB', route('what is quantum computing'), ROUTE.WEB);
  eq('"weather in Delhi" → WEB', route("what's the weather in Delhi"), ROUTE.WEB);
  eq('"bitcoin price" → WEB', route('bitcoin price'), ROUTE.WEB);

  eq('"what time is it" → LOCAL', route('what time is it'), ROUTE.LOCAL);
  eq('"what did i just say" → LOCAL', route('what did i just say'), ROUTE.LOCAL);
  eq('greeting → LOCAL', route('hello'), ROUTE.LOCAL);

  eq('open camera → SYSTEM', route('open the camera'), ROUTE.SYSTEM);
  eq('clear chat → SYSTEM', route('clear the conversation'), ROUTE.SYSTEM);
  eq('slash command → SYSTEM', route('/help'), ROUTE.SYSTEM);

  eq('destructive → SAFETY', route('delete everything on my c: drive'), ROUTE.SAFETY);
  eq('disable antivirus → SAFETY', route('turn off my antivirus'), ROUTE.SAFETY);
  ok('safety returns a refusal', !!r.route('format the c: drive', C).payload.refusal);

  eq('open-ended → CONVERSATION', route('write me a poem about the sea'), ROUTE.CONVERSATION);
  eq('opinion → CONVERSATION', route('do you think AI will change art'), ROUTE.CONVERSATION);

  // ordering guarantees
  ok('MATH outranks WEB', r.route('what is 47*89',C).priority < r.route('what is quantum computing',C).priority);
  ok('TOOL outranks MATH', r.route('open whatsapp',C).priority < r.route('what is 2+2',C).priority);
  ok('SAFETY outranks all', r.route('delete everything on my c: drive',C).priority === 1);

  ok('desktop off → no TOOL route', r.route('open whatsapp',{desktopReady:false}).route !== ROUTE.TOOL);
  ok('live data off → no WEB route', r.route('bitcoin price',{liveDataEnabled:false,desktopReady:true}).route !== ROUTE.WEB);
  ok('explain() traces the pipeline', r.explain('what is 47*89',C).includes('MATH'));
  ok('history recorded', r.recent(5).length > 0);
}

sec('Math guard — must not over-claim');
{
  ok('"F-16 fighter jet" is not math', checkMath('tell me about the F-16 fighter jet') === null);
  ok('"top 10 movies" is not math', checkMath('what are the top 10 movies') === null);
  ok('plain number is not math', checkMath('42') === null);
  ok('"3 idiots movie" is not math', checkMath('tell me about 3 idiots the movie') === null);
  ok('real expression is math', checkMath('what is 12 * 12') !== null);
}

sec('Conversation memory');
{
  const c = new ConversationMemory({ storage: mem('t.conv'), maxTurns: 3 });
  await c.load();
  c.addUser('one'); c.addAssistant('1'); c.addUser('two'); c.addAssistant('2');
  eq('messages stored', c.all().length, 4);
  ok('window respects maxTurns', c.window().length <= 6);
  eq('lastUser', c.lastUser().content, 'two');
  c.updateLastAssistant('2-edited');
  eq('update last assistant', c.lastAssistant().content, '2-edited');
  for (let i=0;i<10;i++){c.addUser('x'+i);c.addAssistant('y'+i);}
  ok('dropped topics surfaced', c.droppedTopics().length > 0);
  await c.clear();
  eq('cleared', c.all().length, 0);
}

sec('Preference memory');
{
  const s = mem('t.pref');
  const pm = new PreferenceMemory({ storage: s });
  await pm.load();
  await pm.set('userName','Commander Stark');
  await pm.set('favouriteApp','Spotify',{confidence:0.9});
  await pm.set('guess','maybe',{confidence:0.3});
  eq('get', pm.get('userName'), 'Commander Stark');
  ok('summary includes high confidence', pm.summary().includes('Stark'));
  ok('summary excludes low confidence', !pm.summary().includes('maybe'));
  const pm2 = new PreferenceMemory({ storage: s });
  await pm2.load();
  eq('persists across instances', pm2.get('userName'), 'Commander Stark');
}

sec('System state memory');
{
  const sm = new SystemStateMemory();
  sm.set({ runtime:{backend:'mock',platform:'win32',simulated:true} });
  sm.noteAppLaunched({id:'spotify',name:'Spotify'});
  sm.noteAppLaunched({id:'vscode',name:'VS Code'});
  eq('tracks running apps', sm.get('runningApps').length, 2);
  sm.noteAppClosed('spotify');
  eq('removes closed app', sm.get('runningApps').length, 1);
  ok('summary mentions runtime', sm.summary().includes('mock'));
  ok('summary lists apps', sm.summary().includes('VS Code'));
  ok('events recorded', sm.recentEvents().length >= 3);
  ok('not persisted (volatile by design)', typeof sm.storage === 'undefined');
}

sec('Knowledge memory + vector store');
{
  const k = new KnowledgeMemory({ storage: mem('t.know'), vectorStore: new VectorStore({storage: mem('t.vec')}) });
  await k.learn({ text:'The Eiffel Tower is 330 metres tall and located in Paris, France.', title:'Eiffel Tower' });
  await k.learn({ text:'Quantum computers use superposition and entanglement to process information.', title:'Quantum' });
  await k.learn({ text:'AURA is a holographic AI operating system with voice and gesture control.', title:'AURA' });
  eq('documents stored', (await k.stats()).documents, 3);
  const hits = await k.recall('how tall is the eiffel tower');
  ok('semantic-ish recall finds the right doc', hits[0]?.doc.metadata.title === 'Eiffel Tower', JSON.stringify(hits[0]?.doc?.metadata));
  const ctx = await k.contextFor('quantum entanglement');
  ok('context block generated', ctx.includes('Quantum'));
  ok('irrelevant query returns nothing', (await k.contextFor('zzzz unrelated xyzzy')) === '');
  ok('tokenizer strips stopwords', !tokenize('the a is of quantum').includes('the'));
}

sec('Memory manager');
{
  const m = new MemoryManager({ storageFactory: (ns)=>mem(ns) });
  await m.initialize();
  ok('all four categories present', !!m.conversation && !!m.preferences && !!m.system && !!m.knowledge);
  m.conversation.addUser('hello');
  await m.preferences.set('userName','Ada');
  m.system.noteAppLaunched({id:'code',name:'VS Code'});
  await m.knowledge.learn({ text:'Ada Lovelace wrote the first algorithm.', title:'Ada' });
  const ctx = await m.buildContext('who was Ada Lovelace');
  ok('context includes preferences', ctx.includes('Ada'));
  ok('context includes system state', ctx.includes('VS Code'));
  const st = await m.stats();
  ok('stats cover all categories', !!st.conversation && !!st.preferences && !!st.system && !!st.knowledge);
  await m.clear('conversation');
  eq('scoped clear only hits conversation', m.conversation.all().length, 0);
  eq('  ↳ preferences survive', m.preferences.get('userName'), 'Ada');
}

sec('Hardware abstraction');
{
  const reg = new HardwareRegistry();
  await reg.initialize();
  const s = reg.summary();
  eq('all six capabilities registered', s.length, 6);
  ok('every capability has a provider', s.every(x => !!x.provider));
  ok('never throws without hardware', s.every(x => typeof x.available === 'boolean'));
  ok('falls back to mock in Node', s.some(x => x.implementation === 'mock'));
  const dm = new DeviceManager({ registry: reg });
  ok('DeviceManager exposes camera', !!dm.camera);
  ok('DeviceManager exposes audio', !!dm.audio);
  const q = await dm.recommendedQuality();
  ok('quality recommendation valid', ['low','medium','high'].includes(q), q);
  const cam = await dm.startCamera();
  ok('startCamera never throws', typeof cam.ok === 'boolean');
}

sec('Hardware permission gate');
{
  const { PermissionManager } = await import('../js/desktop/permissions.js');
  const pm = new PermissionManager({ storage: mem('t.perm') });
  const reg = new HardwareRegistry(); await reg.initialize();
  const dm = new DeviceManager({ registry: reg, permissions: pm });
  const denied = await dm.startCamera();
  ok('camera denied without permission', denied.ok === false && /not granted/i.test(denied.reason||''));
  pm.grant('camera');
  const allowed = await dm.startCamera();
  ok('camera allowed after grant', allowed.ok === true || !/not granted/i.test(allowed.reason||''));
}

sec('Tool calling');
{
  ok('tool count >= 15', Object.keys(TOOLS).length >= 15, String(Object.keys(TOOLS).length) + ' tools');
  const v = validateToolCall('launch_application', { application:'WhatsApp' });
  ok('valid params pass', v.ok && v.value.application === 'WhatsApp');
  ok('missing required rejected', !validateToolCall('launch_application', {}).ok);
  ok('unknown tool rejected', !validateToolCall('nope', {}).ok);

  const n = normalizeToolCall({ type:'tool_call', tool:'launch_application', parameters:{application:'Spotify'} });
  eq('canonical form normalises', n.tool, 'launch_application');
  const legacy = normalizeToolCall({ action:'launch_app', target:'Spotify' });
  eq('legacy {action,target} maps to tool', legacy.tool, 'launch_application');
  eq('  ↳ param mapped', legacy.parameters.application, 'Spotify');

  const ex = extractToolCalls('Opening it now.\n```tool\n{"type":"tool_call","tool":"launch_application","parameters":{"application":"WhatsApp"}}\n```');
  eq('extracts from fenced block', ex.calls[0].tool, 'launch_application');
  eq('cleans prose', ex.cleanText, 'Opening it now.');
  ok('plain prose has no calls', !extractToolCalls('Quantum computing uses qubits.').hadCall);
  ok('malformed JSON ignored', extractToolCalls('```tool\n{bad\n```').calls.length === 0);

  const res = toToolResult('launch_application', { ok:true, message:'Application launched successfully', simulated:true });
  ok('result shape matches spec', res.success===true && res.tool==='launch_application' && !!res.message);
  const denied = toToolResult('launch_application', { ok:false, code:'no_permission', message:'x', permissionLabel:'Launch Applications' });
  eq('permission denial mapped', denied.error, 'permission_denied');

  const man = buildToolManifest(() => true);
  ok('manifest lists tools', man.includes('launch_application') && man.includes('get_weather'));
  const filtered = buildToolManifest((t) => t !== 'power_control');
  ok('manifest marks unavailable', filtered.includes('UNAVAILABLE'));
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`  \x1b[32mPASS ${p}\x1b[0m   ${f?`\x1b[31mFAIL ${f}\x1b[0m`:'FAIL 0'}`);
if(f){console.log('  Failed: '+fails.join(', '));process.exit(1);}
console.log('  ARCHITECTURE LAYER VERIFIED');
