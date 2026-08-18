import http from 'http';
import { openai, anthropic, gemini, ollama, groq, openrouter } from '../js/ai/providers.js';

const sse = (lines) => lines.map(l => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n';
let lastBody = null, lastHeaders = null, lastUrl = null;

const server = http.createServer((req, res) => {
  let b=''; req.on('data',c=>b+=c);
  req.on('end', () => {
    lastUrl = req.url; lastHeaders = req.headers;
    try { lastBody = JSON.parse(b); } catch { lastBody = null; }
    const u = req.url;
    if (u.includes('/fail')) {
      res.writeHead(401, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({error:{message:'Invalid API key'}}));
    }
    if (u.includes('/api/chat')) {
      res.writeHead(200, {'Content-Type':'application/x-ndjson'});
      return res.end('{"message":{"content":"AURA "}}\n{"message":{"content":"ONLINE"}}\n{"done":true}\n');
    }
    if (u.includes('/v1/messages')) {
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      return res.end('data: {"type":"message_start"}\n\n'+
        'data: {"type":"content_block_delta","delta":{"text":"AURA "}}\n\n'+
        'data: {"type":"content_block_delta","delta":{"text":"ONLINE"}}\n\n'+'data: [DONE]\n\n');
    }
    if (u.includes('streamGenerateContent')) {
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      return res.end(sse([{candidates:[{content:{parts:[{text:'AURA '}]}}]},
                          {candidates:[{content:{parts:[{text:'ONLINE'}]}}]}]));
    }
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    res.end(sse([{choices:[{delta:{content:'AURA '}}]},{choices:[{delta:{content:'ONLINE'}}]}]));
  });
});
await new Promise(r => server.listen(9911, r));
const B='http://127.0.0.1:9911';

// Route the hardcoded-URL providers (Anthropic, Gemini) to the mock,
// preserving path so the handler can tell them apart.
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => {
  const s = String(u);
  if (s.startsWith('http://127.0.0.1')) return realFetch(u, o);
  const path = new URL(s).pathname + new URL(s).search;
  return realFetch(B + path, o);
};

let pass=0, fail=0;
const chk=(n,c,d='')=>{ c?(pass++,console.log(`  \x1b[32m✓\x1b[0m ${n}`)):(fail++,console.log(`  \x1b[31m✗\x1b[0m ${n} ${d}`)); };
async function collect(g){ let s=''; for await (const d of g) s+=d; return s; }
const msgs=[{role:'system',content:'sys'},{role:'user',content:'hi'}];

chk('OpenAI SSE parsing',     await collect(openai.stream({messages:msgs,key:'k',baseUrlOverride:B}))==='AURA ONLINE');
chk('Groq SSE parsing',       await collect(groq.stream({messages:msgs,key:'k',baseUrlOverride:B}))==='AURA ONLINE');
chk('OpenRouter SSE parsing', await collect(openrouter.stream({messages:msgs,key:'k',baseUrlOverride:B}))==='AURA ONLINE');
chk('Ollama NDJSON parsing',
    await collect(ollama.stream({messages:msgs,model:'gemma2:2b',baseUrlOverride:B}))==='AURA ONLINE');

chk('Anthropic SSE parsing',  await collect(anthropic.stream({messages:msgs,key:'k'}))==='AURA ONLINE');
chk('Anthropic hoists system out of messages',
    !!lastBody?.system && !lastBody.messages.some(m=>m.role==='system'),
    JSON.stringify(lastBody?.messages?.map(m=>m.role)));
chk('Anthropic sends browser-access header',
    lastHeaders['anthropic-dangerous-direct-browser-access']==='true' && !!lastHeaders['x-api-key']);

chk('Gemini SSE parsing', await collect(gemini.stream({messages:msgs,key:'k'}))==='AURA ONLINE');
chk('Gemini maps assistant->model role',
    lastBody?.contents?.every(c=>['user','model'].includes(c.role)) && !!lastBody?.systemInstruction,
    JSON.stringify(lastBody?.contents?.map(c=>c.role)));

// abort
const ctrl=new AbortController(); ctrl.abort();
let aborted=false;
try { await collect(openai.stream({messages:msgs,key:'k',baseUrlOverride:B,signal:ctrl.signal})); }
catch(e){ aborted = e.name==='AbortError'; }
chk('AbortSignal aborts immediately', aborted);

let em='';
try { await collect(openai.stream({messages:msgs,key:'bad',baseUrlOverride:B+'/fail'})); } catch(e){ em=e.message; }
chk('HTTP 401 gives actionable message', em.includes('401') && /api key/i.test(em), em.slice(0,60));

chk('maxTokens + temperature forwarded',
    (await (async()=>{ await collect(openai.stream({messages:msgs,key:'k',baseUrlOverride:B,temperature:0.3,maxTokens:99}));
      return lastBody.temperature===0.3 && lastBody.max_tokens===99; })()));
chk('stream:true always set', lastBody.stream===true);

/* ── Ollama: NO HARDCODED MODEL NAMES ──────────────────────────────────
   Regression guard for the bug where AURA shipped invented model names
   (qwen2.5:3b, llama3.2:3b, phi3.5:3.8b…) and requested models the user
   had never pulled. Ollama must be the only source of truth.            */

chk('Ollama ships NO baked-in model list',
    Array.isArray(ollama.models) && ollama.models.every(m => ollama.installed.includes(m)));

const FORBIDDEN = ['qwen2.5:3b','llama3.2:3b','qwen2.5:1.5b','phi3.5:3.8b','llama3.1:8b'];
// Strip comments first: explaining the old bug in prose is fine, shipping the
// names as executable defaults is not.
const srcOllama = ((await import('fs')).readFileSync(new URL('../js/ai/providers.js', import.meta.url), 'utf8')
  .split('export const ollama')[1] || '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
chk('no invented tags hardcoded in the ollama adapter',
    !FORBIDDEN.some(f => srcOllama.includes(f)),
    FORBIDDEN.filter(f => srcOllama.includes(f)).join(','));
chk('ollama defaultModel is not an invented name',
    ollama.defaultModel === null || ollama.installed.includes(ollama.defaultModel),
    String(ollama.defaultModel));

// resolveModel must snap wrong names onto real installed ones.
const savedInstalled = ollama.installed.slice();
ollama.installed = ['gemma2:2b','qwen2.5-coder:7b','deepseek-r1:8b'];
chk('exact name passes through',        ollama.resolveModel('gemma2:2b').name === 'gemma2:2b');
chk('bare name resolves to real tag',   ollama.resolveModel('gemma2').name === 'gemma2:2b');
chk('wrong :latest resolves to family', ollama.resolveModel('qwen2.5-coder:latest').name === 'qwen2.5-coder:7b');
chk('partial name resolves',            ollama.resolveModel('coder').name === 'qwen2.5-coder:7b');
chk('uninstalled model falls back to a real one',
    ollama.installed.includes(ollama.resolveModel('llama3.2:3b').name));
chk('substitution is reported, never silent', !!ollama.resolveModel('llama3.2:3b').note);
chk('empty request picks a real installed model',
    ollama.installed.includes(ollama.resolveModel('').name));
chk('correct name produces no warning note', ollama.resolveModel('deepseek-r1:8b').note === null);
ollama.installed = savedInstalled;

// A model the user never pulled must not reach Ollama.
ollama.__proxy = false;
ollama.installed = ['gemma2:2b']; ollama._discoveredAt = Date.now();
await collect(ollama.stream({messages:msgs, model:'totally-made-up:70b', baseUrlOverride:B}));
chk('never sends an uninstalled model to Ollama', lastBody.model === 'gemma2:2b', String(lastBody.model));

globalThis.fetch = realFetch;
server.close();
console.log(`\n  PASS ${pass}  FAIL ${fail}`);
process.exit(fail?1:0);
