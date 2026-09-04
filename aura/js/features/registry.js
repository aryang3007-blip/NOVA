/**
 * NOVA :: Feature Registry (frontend)
 * ====================================
 * Runtime copy of services/manifest.json — the ONE feature list the terminal
 * (services/registry.py) and the app agree on. tests/test-feature-registry.mjs
 * asserts this file and the manifest can never drift.
 *
 * @module features/registry
 */

export const FEATURE_MANIFEST = {
  version: 1,
  features: {
    pptx: {
      id: 'pptx', label: 'PPT Builder', icon: '📊', service: 'docgen',
      kind: 'pptx', ui: 'ppt-builder',
      params: ['topic', 'audience', 'details', 'slides', 'theme', 'transition',
               'animation', 'images'],
      defaults: {
        slides: 10, theme: 'professional-dark', transition: 'fade',
        speed: 'med', animation: 'none', model: 'gemini-3.8-flash',
        images: { enabled: true, count: 1, style: 'flat illustration',
                  provider: 'gemini', model: 'gemini-3.1-flash-image' },
      },
    },
    docx: {
      id: 'docx', label: 'Word Report Builder', icon: '📝', service: 'docgen',
      kind: 'docx', ui: 'doc-builder',
      params: ['topic', 'audience', 'details', 'sections'],
      defaults: { sections: 6 },
    },
    xlsx: {
      id: 'xlsx', label: 'Spreadsheet Builder', icon: '📈', service: 'docgen',
      kind: 'xlsx', ui: 'doc-builder',
      params: ['topic', 'details', 'sheets'],
      defaults: { sheets: 1 },
    },
    research: {
      id: 'research', label: 'Web Research', icon: '🔎', service: 'research',
      ui: 'research',
      params: ['topic', 'depth', 'results', 'summarize'],
      defaults: { depth: 'adaptive', results: 5, summarize: true },
    },
  },
  themes: ['professional-dark', 'professional-light', 'academic', 'minimal',
           'holiday', 'neon'],
  // Exact palettes used by services/docgen/builder.py THEMES — the popup
  // draws its "how the card actually looks" previews from these.
  themePreviews: {
    'professional-dark':
      { bg: '#0B101A', ink: '#F2F5F9', accent: '#E8B74A', panel: '#141C29' },
    'professional-light':
      { bg: '#FFFFFF', ink: '#101824', accent: '#B8861F', panel: '#F2F4F7' },
    'academic':
      { bg: '#FAF9F6', ink: '#1B2A4A', accent: '#1F4E9C', panel: '#EEECE4' },
    'minimal':
      { bg: '#FFFFFF', ink: '#161616', accent: '#444444', panel: '#F4F4F4' },
    'holiday':
      { bg: '#102B1C', ink: '#FFF7E6', accent: '#F2B13D', panel: '#1B3E2C' },
    'neon':
      { bg: '#070A12', ink: '#EDF3FF', accent: '#38BDF8', panel: '#0F1420' },
  },
  transitions: ['none', 'fade', 'push', 'wipe', 'split', 'circle', 'cover',
                'uncover', 'zoom', 'comb', 'wheel', 'plus', 'random'],
  animations: ['none', 'bounce', 'float', 'fade-in', 'zoom-in'],
  imageProviders: [
    { id: 'gemini', label: 'Google Gemini · Nano Banana', kind: 'gemini-image',
      model: 'gemini-3.1-flash-image',
      models: [
        { id: 'gemini-3.1-flash-image', label: 'Nano Banana 2 · Flash Image',
          note: 'Versatile default · 4K · good text rendering' },
        { id: 'gemini-3.1-flash-lite-image', label: 'Nano Banana 2 Lite',
          note: 'Fastest & cheapest' },
        { id: 'gemini-3-pro-image', label: 'Nano Banana Pro',
          note: 'Premium quality · complex visuals' },
      ],
      note: 'Needs a Gemini API key (Settings → API Keys)' },
    { id: 'openai', label: 'OpenAI · gpt-image-1', kind: 'openai-images',
      model: 'gpt-image-1',
      models: [{ id: 'gpt-image-1', label: 'gpt-image-1',
                 note: 'OpenAI image model' }],
      note: 'Needs an OpenAI API key with image credit' },
  ],
};

export function feature(id) {
  return FEATURE_MANIFEST.features[id] || null;
}

export function defaultsFor(id) {
  return feature(id)?.defaults || {};
}

export default FEATURE_MANIFEST;
