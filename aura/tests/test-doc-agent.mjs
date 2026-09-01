/**
 * AURA :: doc-agent unit tests
 * ============================
 * Pure logic: intent detection, spec validation and the offline fallback.
 * No browser, no model, no filesystem.
 *
 *   node tests/test-doc-agent.mjs
 */
import { detectDocRequest, validateSpec, outlineFallback, describeSpec, DOC_KINDS,
         extractImageSources, attachImages }
  from '../js/ai/doc-agent.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); }
};
const S = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

/* ─────────────────────────────────────────────────────────── */
S('INTENT DETECTION');
{
  const cases = [
    ['make a ppt on quantum computing', 'pptx', /quantum/i],
    ['create a powerpoint about the water cycle', 'pptx', /water/i],
    ['build me a slide deck on AURA', 'pptx', /AURA/i],
    ['generate a presentation for my thesis', 'pptx', /thesis/i],
    ['make an excel sheet of my monthly budget', 'xlsx', /budget/i],
    ['create a spreadsheet for expenses', 'xlsx', /expenses/i],
    ['write a report on climate policy', 'docx', /climate/i],
    ['draft a word document about hiring', 'docx', /hiring/i],
  ];
  for (const [text, kind, topicRe] of cases) {
    const r = detectDocRequest(text);
    ok(`"${text.slice(0, 34)}…" -> ${kind}`, r?.kind === kind, JSON.stringify(r));
    ok(`   topic extracted`, !!r && topicRe.test(r.topic), r?.topic);
  }
}
{
  // Must NOT fire on questions or chat that merely mention the words.
  const negatives = [
    'what is a powerpoint',
    'how do spreadsheets work',
    'I hate making presentations',
    'tell me about excel formulas',
    'hello',
    '',
  ];
  for (const n of negatives) {
    ok(`ignores "${n || '(empty)'}"`, detectDocRequest(n) === null,
       JSON.stringify(detectDocRequest(n)));
  }
}

/* ─────────────────────────────────────────────────────────── */
S('SPEC VALIDATION — CLEAN INPUT');
{
  const s = validateSpec('pptx', {
    title: 'T', subtitle: 'S',
    slides: [{ title: 'A', bullets: ['x', 'y'], notes: 'n' }],
  });
  ok('accepts a well-formed deck', !!s && s.slides.length === 1);
  ok('keeps the title', s.title === 'T');
  ok('keeps bullets', s.slides[0].bullets.length === 2);
  ok('keeps notes', s.slides[0].notes === 'n');
}
{
  const s = validateSpec('xlsx', {
    title: 'B', sheets: [{ name: 'Q1', columns: ['a', 'b'], rows: [[1, 2]] }],
  });
  ok('accepts a well-formed workbook', !!s && s.sheets.length === 1);
  ok('numbers stay numbers', s.sheets[0].rows[0][0] === 1);
}
{
  const s = validateSpec('docx', {
    title: 'D', sections: [{ heading: 'H', paragraphs: ['p'], bullets: ['b'] }],
  });
  ok('accepts a well-formed document', !!s && s.sections.length === 1);
  ok('default heading level is 1', s.sections[0].level === 1);
}

/* ─────────────────────────────────────────────────────────── */
S('SPEC VALIDATION — WHAT MODELS ACTUALLY RETURN');
{
  // Bullets as one string instead of an array.
  const s = validateSpec('pptx', { title: 'T', slides: [{ title: 'A', bullets: 'just one' }] });
  ok('a string of bullets becomes an array', s?.slides[0].bullets.length === 1,
     JSON.stringify(s?.slides[0]));
}
{
  // Bullets as objects, which small models love to do.
  const s = validateSpec('pptx', {
    title: 'T', slides: [{ title: 'A', bullets: [{ text: 'from object' }, { title: 'two' }] }],
  });
  ok('object bullets are unwrapped', s?.slides[0].bullets.join('|') === 'from object|two',
     JSON.stringify(s?.slides[0].bullets));
}
{
  // "points"/"content" instead of "bullets"; "heading" instead of "title".
  const s = validateSpec('pptx', { title: 'T', slides: [{ heading: 'H', points: ['p'] }] });
  ok('alternate key names are accepted', s?.slides[0].title === 'H'
     && s?.slides[0].bullets[0] === 'p', JSON.stringify(s?.slides[0]));
}
{
  // Numbers sent as strings — Excel would treat them as text and refuse to sum.
  const s = validateSpec('xlsx', { title: 'B', columns: ['a'], rows: [['42'], ['3.5'], ['abc']] });
  ok('single-sheet shorthand is accepted', s?.sheets.length === 1);
  ok('numeric strings become numbers', s.sheets[0].rows[0][0] === 42,
     JSON.stringify(s.sheets[0].rows[0]));
  ok('decimals too', s.sheets[0].rows[1][0] === 3.5);
  ok('real text is left alone', s.sheets[0].rows[2][0] === 'abc');
}
{
  // Rows as objects keyed by column name.
  const s = validateSpec('xlsx', {
    title: 'B', sheets: [{ name: 'S', columns: ['Item', 'Cost'],
                           rows: [{ Item: 'Pen', Cost: 2 }] }],
  });
  ok('object rows are mapped to the column order',
     JSON.stringify(s?.sheets[0].rows[0]) === '["Pen",2]', JSON.stringify(s?.sheets[0].rows[0]));
}
{
  const s = validateSpec('docx', { title: 'D', paragraphs: ['loose text'] });
  ok('loose paragraphs become one section', s?.sections.length === 1,
     JSON.stringify(s));
}
{
  const s = validateSpec('docx', { title: 'D', sections: [{ heading: 'H', level: 99 }] });
  ok('an out-of-range heading level is clamped', s?.sections[0].level === 1,
     String(s?.sections[0].level));
}
{
  const s = validateSpec('pptx', { slides: [{ title: 'A' }] }, 'Fallback Topic');
  ok('a missing title falls back to the topic', s?.title === 'Fallback Topic', s?.title);
}

/* ─────────────────────────────────────────────────────────── */
S('SPEC VALIDATION — GARBAGE IS REJECTED');
{
  ok('null', validateSpec('pptx', null) === null);
  ok('a string', validateSpec('pptx', 'nope') === null);
  ok('an empty object', validateSpec('pptx', {}) === null);
  ok('empty slides', validateSpec('pptx', { title: 'T', slides: [] }) === null);
  ok('slides of nulls', validateSpec('pptx', { title: 'T', slides: [null, 3] }) === null);
  ok('empty sheets', validateSpec('xlsx', { title: 'T', sheets: [] }) === null);
  ok('empty sections', validateSpec('docx', { title: 'T', sections: [] }) === null);
  ok('an unknown kind', validateSpec('exe', { title: 'T' }) === null);
}
{
  // Enormous strings must be clipped, not passed through to the builder.
  const s = validateSpec('pptx', {
    title: 'x'.repeat(9999),
    slides: [{ title: 'y'.repeat(9999), bullets: ['z'.repeat(9999)] }],
  });
  ok('an absurd title is clipped', s.title.length <= 160, String(s.title.length));
  ok('an absurd bullet is clipped', s.slides[0].bullets[0].length <= 400,
     String(s.slides[0].bullets[0].length));
}

/* ─────────────────────────────────────────────────────────── */
S('OFFLINE FALLBACK IS A REAL, HONEST OUTLINE');
for (const kind of ['pptx', 'xlsx', 'docx']) {
  const f = outlineFallback(kind, 'test topic');
  ok(`${kind}: produces something`, !!f);
  ok(`${kind}: survives validation`, validateSpec(kind, f) !== null);
  const json = JSON.stringify(f).toLowerCase();
  ok(`${kind}: SAYS no model was used`, json.includes('no language model')
     || json.includes('offline'), json.slice(0, 80));
  ok(`${kind}: uses the topic`, json.includes('test topic'));
}
{
  const f = outlineFallback('pptx', 'x');
  ok('the fallback deck has several slides', f.slides.length >= 5, String(f.slides.length));
}

/* ─────────────────────────────────────────────────────────── */
S('DESCRIPTIONS FOR THE CONFIRM DIALOG');
{
  const d = describeSpec('pptx', { slides: [{ title: 'One' }, { title: 'Two' }] });
  ok('describes a deck', /3 slides/.test(d) && /One/.test(d), d);
  const x = describeSpec('xlsx', { sheets: [{ name: 'S', rows: [[1], [2]] }] });
  ok('describes a workbook', /1 sheet/.test(x) && /2 rows/.test(x), x);
  const w = describeSpec('docx', { sections: [{ heading: 'Intro' }] });
  ok('describes a document', /1 sections/.test(w) && /Intro/.test(w), w);
  ok('handles a null spec', describeSpec('pptx', null) === '');
}

S('KIND METADATA');
for (const k of ['pptx', 'xlsx', 'docx']) {
  ok(`${k} has a label`, !!DOC_KINDS[k].label);
  ok(`${k} has an extension`, DOC_KINDS[k].ext === `.${k}`);
  ok(`${k} documents its schema to the model`, DOC_KINDS[k].schema.includes('{'));
  ok(`${k} gives the model rules`, DOC_KINDS[k].rules.length > 20);
}

/* ─────────────────────────────────────────────────────────── */
S('IMAGE SOURCES — extractImageSources (urls + local paths, max 3)');
{
  const urls = extractImageSources(
    'make a ppt on mars with https://example.com/mars.png and https://a.io/photo.jpg?x=1 okay');
  ok('finds two http image urls', urls.length === 2, JSON.stringify(urls));
  ok('strips trailing punctuation', /https:\/\/example\.com\/mars\.png$/.test(urls[0] || ''), urls[0]);

  const local = extractImageSources(
    'deck about food, use /home/user/food.jpg and ./assets/chart.webp');
  ok('finds absolute + relative local paths', local.length === 2, JSON.stringify(local));
  ok('keeps the extension', local.every(s => /\.(jpe?g|webp|png)$/.test(s)));

  const mixed = extractImageSources(
    'use https://x.io/a.png and /tmp/b.gif and C:\\imgs\\c.bmp now',
  );
  ok('max 3 sources', mixed.length === 3, JSON.stringify(mixed));

  ok('no image extension → nothing', extractImageSources('open https://youtube.com/watch?v=1').length === 0);
  ok('empty input → []', extractImageSources('  ').length === 0);
}

/* ─────────────────────────────────────────────────────────── */
S('IMAGE SOURCES — attachImages fills and appends, keeps spec intact');
{
  const deck = { title: 'T', slides: [
    { kind: 'title', title: 'Cover' },
    { kind: 'image', title: 'Model image' },       // no image → gets one
    { kind: 'bullets', title: 'Body', bullets: ['a', 'b'] },
  ] };

  const one = attachImages(deck, ['https://x.io/one.png']);
  ok('existing image slide filled in place', one.placed === 1
     && one.spec.slides[1].image === 'https://x.io/one.png', JSON.stringify(one.spec.slides[1]));

  const two = attachImages(deck, ['https://x.io/one.png', 'https://x.io/two.png']);
  ok('first fills model slide, second joins right after the hero slide',
     two.placed === 2 && two.spec.slides[1].kind === 'image'
     && two.spec.slides[1].image === 'https://x.io/two.png'
     && two.spec.slides[2].image === 'https://x.io/one.png',
     JSON.stringify(two.spec.slides.map(s => `${s.kind}:${s.image || ''}`)));

  const over = attachImages(deck, ['a.png', 'b.png', 'c.png', 'd.png']);
  ok('never embeds more than 3', over.placed === 3
     && over.spec.slides.filter(s => s.kind === 'image').length === 3);

  const none = attachImages(deck, []);
  ok('no sources → untouched spec', none.placed === 0 && none.spec === deck);

  const nope = attachImages({ title: 'T' }, ['https://x.io/a.png']);
  ok('non-deck spec → safe no-op', nope.placed === 0);
}

console.log(`\n  \x1b[32mPASS ${P}\x1b[0m  FAIL ${F}`);
process.exit(F ? 1 : 0);
