/**
 * AURA :: image understanding + semantic memory
 * ---------------------------------------------
 * Two capabilities that were previously listed as "not built":
 *
 *   8) Image understanding by the LLM — the camera used to describe the scene
 *      in TEXT and hand that to the model. Now the raw frame goes too, so a
 *      multimodal model genuinely looks at the picture.
 *
 *  10) Persistent semantic memory — the knowledge store matched keywords, so
 *      "make the assistant faster" could not find a note about "reducing
 *      model latency". It now embeds through Ollama and searches by cosine
 *      similarity, falling back to keywords when no embedding model exists.
 *
 * Both are tested against a fake Ollama so the assertions are deterministic
 * and run with no models installed.
 */

import { ollama } from '../js/ai/providers.js';
import { VectorStore, InMemoryStorage } from '../js/memory/storage.js';

let pass = 0, fail = 0;
const chk = (n, c, d = '') => {
  c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`))
    : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n}  \x1b[90m${d}\x1b[0m`));
};

const realFetch = globalThis.fetch;

/* ══════════════ IMAGE UNDERSTANDING ══════════════ */
console.log('\n  VISION MODEL DETECTION\n');

const VISION = ['llava:7b', 'llava-llama3', 'moondream', 'bakllava',
                'minicpm-v', 'llama3.2-vision:11b', 'qwen2.5vl:7b',
                'gemma3:12b', 'pixtral'];
const TEXT = ['gemma2:2b', 'qwen2.5-coder:7b', 'deepseek-r1:8b',
              'mistral:7b', 'phi3.5', 'nomic-embed-text'];

ollama.caps = {};   // force the name-heuristic path for this block

chk('recognises every known vision family',
    VISION.every(m => ollama.isVisionModel(m)),
    VISION.filter(m => !ollama.isVisionModel(m)).join(','));
chk('does not mistake text models for vision models',
    TEXT.every(m => !ollama.isVisionModel(m)),
    TEXT.filter(m => ollama.isVisionModel(m)).join(','));

/* ── REGRESSION: the gemma4 bug ──────────────────────────────────────
 * A user pulled qwen2.5vl:7b because AURA claimed none of their models
 * could see images. gemma4:12b — which they already had — reads images
 * fine, but the name pattern only knew `gemma3`. Two defences now:
 *   1. Ollama's own /api/show capabilities are authoritative.
 *   2. The name fallback is generic, not a fixed family list.
 */
const FUTURE = ['gemma4:12b', 'gemma5:8b', 'qwen3-vl:8b', 'llama4:16x17b',
                'smolvlm:2b', 'internvl2:8b', 'some-model-vl:3b',
                'newthing-vision:7b', 'glm-4v:9b'];
chk('name fallback generalises to families it has never seen',
    FUTURE.every(m => ollama.isVisionModel(m)),
    'missed: ' + FUTURE.filter(m => !ollama.isVisionModel(m)).join(','));
chk('gemma4:12b specifically — the model the user was told to replace',
    ollama.isVisionModel('gemma4:12b'));
chk('gemma2 is still not treated as multimodal',
    !ollama.isVisionModel('gemma2:2b'));
chk('embedding models are never multimodal',
    !ollama.isVisionModel('nomic-embed-text') && !ollama.isVisionModel('mxbai-embed-large'));

/* Ground truth beats the guess, in BOTH directions. */
ollama.caps = {
  'gemma4:12b': ['completion', 'vision', 'tools'],
  'gemma3:12b': ['completion'],                       // hypothetical text-only build
  'mystery:1b': ['completion', 'vision'],
};
chk('Ollama-reported vision is trusted', ollama.isVisionModel('gemma4:12b'));
chk('Ollama-reported NO-vision overrides a vision-looking name',
    !ollama.isVisionModel('gemma3:12b'));
chk('a model with an unguessable name is caught by /api/show',
    ollama.isVisionModel('mystery:1b'));
chk('capsAreReal distinguishes fact from guess',
    ollama.capsAreReal('gemma4:12b') && !ollama.capsAreReal('llava:7b'));
chk('hasCapability reads non-vision capabilities too',
    ollama.hasCapability('gemma4:12b', 'tools')
    && !ollama.hasCapability('gemma3:12b', 'tools'));

ollama.installed = ['gemma2:2b', 'gemma4:12b', 'qwen2.5-coder:7b'];
chk('capabilityReport labels each verdict with its source', (() => {
  const r = ollama.capabilityReport();
  return r.find(x => x.name === 'gemma4:12b').source === 'ollama'
      && r.find(x => x.name === 'gemma2:2b').source === 'name-heuristic';
})());

ollama.caps = {};
ollama.installed = ['gemma2:2b', 'llava:7b', 'qwen2.5-coder:7b'];
chk('filters the installed list to vision models',
    JSON.stringify(ollama.visionModels()) === JSON.stringify(['llava:7b']));
ollama.installed = ['gemma2:2b'];
chk('reports none when no vision model is installed',
    ollama.visionModels().length === 0);

console.log('\n  IMAGES REACH OLLAMA CORRECTLY\n');

let lastBody = null;
function mockOllama() {
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes('/status')) {
      return { ok: true, json: async () => ({ running: true, names: ollama.installed }) };
    }
    lastBody = JSON.parse(o.body);
    return {
      ok: true, headers: { get: () => null },
      body: {
        getReader() {
          let done = false;
          return {
            read: async () => done
              ? { done: true }
              : (done = true, { done: false,
                  value: new TextEncoder().encode(
                    JSON.stringify({ message: { content: 'I see a desk.' } }) + '\n') }),
            cancel() {},
          };
        },
      },
    };
  };
}

ollama.installed = ['llava:7b'];
ollama.__proxy = true;
mockOllama();

const B64 = 'iVBORw0KGgoAAAANSUhEUg==';
let out = '';
for await (const d of ollama.stream({
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'what do you see?' }],
  model: 'llava:7b',
  images: [`data:image/png;base64,${B64}`],
})) out += d;

chk('the stream still yields text', out === 'I see a desk.', out);
chk('images are attached to the request', Array.isArray(lastBody.messages.at(-1).images));
chk('the data-url prefix is stripped',
    lastBody.messages.at(-1).images[0] === B64,
    String(lastBody.messages.at(-1).images[0]).slice(0, 24));
chk('images go on the LAST user message, not the system one',
    !lastBody.messages[0].images && !!lastBody.messages[1].images);

// A request with no images must be byte-identical to the old behaviour.
lastBody = null;
out = '';
for await (const d of ollama.stream({
  messages: [{ role: 'user', content: 'hi' }], model: 'llava:7b',
})) out += d;
chk('no images key when none were supplied',
    lastBody.messages.every(m => m.images === undefined));

// The system message must survive untouched when images ARE present.
lastBody = null;
for await (const d of ollama.stream({
  messages: [{ role: 'system', content: 'keep me' }, { role: 'user', content: 'q' }],
  model: 'llava:7b', images: [B64],
})) { /* drain */ }
chk('other messages are not mutated', lastBody.messages[0].content === 'keep me');

/* ══════════════ SEMANTIC MEMORY ══════════════ */
console.log('\n  SEMANTIC RECALL (real embeddings)\n');

// A tiny deterministic "embedding model": related concepts share dimensions,
// so cosine similarity behaves like a real sentence embedder.
const DIMS = ['speed', 'latency', 'model', 'memory', 'food', 'travel', 'code'];
function fakeEmbed(text) {
  const s = String(text).toLowerCase();
  const v = new Array(DIMS.length).fill(0);
  const bump = (i, w) => { v[i] = Math.max(v[i], w); };
  if (/fast|faster|speed|quick|snappy/.test(s)) { bump(0, 1); bump(1, 0.85); }
  if (/latency|slow|lag|delay/.test(s)) { bump(1, 1); bump(0, 0.85); }
  if (/model|llm|ollama|inference/.test(s)) bump(2, 1);
  if (/memory|ram|recall|remember/.test(s)) bump(3, 1);
  if (/food|cook|recipe|pasta|dinner/.test(s)) bump(4, 1);
  if (/travel|flight|trip|hotel/.test(s)) bump(5, 1);
  if (/code|function|bug|python/.test(s)) bump(6, 1);
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

function mockEmbeddings({ hasModel = true } = {}) {
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes('/status')) {
      return { ok: true, json: async () => ({
        running: true,
        names: hasModel ? ['gemma2:2b', 'nomic-embed-text'] : ['gemma2:2b'],
      }) };
    }
    if (url.includes('/embeddings')) {
      if (!hasModel) return { ok: false };
      return { ok: true, json: async () => ({ embedding: fakeEmbed(JSON.parse(o.body).prompt) }) };
    }
    return { ok: false };
  };
}

mockEmbeddings({ hasModel: true });
const vs = new VectorStore({ storage: new InMemoryStorage({ namespace: 'test.sem' }) });
await vs.add({ id: 'perf', text: 'reducing model latency on weak hardware' });
await vs.add({ id: 'food', text: 'my favourite pasta recipe for dinner' });
await vs.add({ id: 'trip', text: 'notes about booking a flight and hotel' });

chk('detects the embedding model', vs.supportsEmbeddings === true);
chk('reports the real backend', vs.kind === 'ollama-embeddings', vs.kind);

let r = await vs.search('how do I make the assistant faster');
chk('finds a doc with NO shared keywords',
    r[0]?.doc.id === 'perf', `${r[0]?.doc.id} @ ${r[0]?.score?.toFixed(3)}`);
chk('score is a real cosine value', r[0]?.score > 0.5 && r[0]?.score <= 1);

r = await vs.search('what should I cook tonight');
chk('routes an unrelated query elsewhere', r[0]?.doc.id === 'food', r[0]?.doc.id);

r = await vs.search('planning a trip with a hotel booking');
chk('travel query finds the travel note', r[0]?.doc.id === 'trip', r[0]?.doc.id);

r = await vs.search('quantum chromodynamics');
chk('returns nothing for a genuinely unrelated query', r.length === 0, `${r.length} hits`);

chk('cosine of identical vectors is 1',
    Math.abs(VectorStore.cosine([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
chk('cosine of orthogonal vectors is 0', VectorStore.cosine([1, 0], [0, 1]) === 0);
chk('cosine handles length mismatch', VectorStore.cosine([1, 2], [1]) === 0);

console.log('\n  GRACEFUL FALLBACK\n');

mockEmbeddings({ hasModel: false });
const vs2 = new VectorStore({ storage: new InMemoryStorage({ namespace: 'test.kw' }) });
await vs2.add({ id: 'perf', text: 'reducing model latency on weak hardware' });
await vs2.add({ id: 'food', text: 'my favourite pasta recipe' });

chk('does NOT claim embeddings it cannot do', vs2.supportsEmbeddings === false);
chk('reports the fallback backend honestly', vs2.kind === 'keyword-fallback', vs2.kind);
r = await vs2.search('model latency');
chk('keyword search still works', r[0]?.doc.id === 'perf', r[0]?.doc.id);

globalThis.fetch = async () => { throw new Error('offline'); };
const vs3 = new VectorStore({ storage: new InMemoryStorage({ namespace: 'test.off' }) });
await vs3.add({ id: 'a', text: 'hello world notes about aura' });
r = await vs3.search('aura notes');
chk('works with Ollama completely offline', r[0]?.doc.id === 'a');
chk('stays on the keyword backend when offline', vs3.kind === 'keyword-fallback');

chk('embedding models are identified',
    VectorStore.isEmbeddingModel('nomic-embed-text')
    && VectorStore.isEmbeddingModel('mxbai-embed-large')
    && VectorStore.isEmbeddingModel('all-minilm')
    && !VectorStore.isEmbeddingModel('gemma2:2b'));

globalThis.fetch = realFetch;
console.log(`\n  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
