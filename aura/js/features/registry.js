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
                  provider: 'gemini' },
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
  transitions: ['none', 'fade', 'push', 'wipe', 'split', 'circle', 'cover',
                'uncover', 'zoom', 'comb', 'wheel', 'plus', 'random'],
  animations: ['none', 'bounce', 'float', 'fade-in', 'zoom-in'],
  imageProviders: [
    { id: 'gemini', label: 'Google Gemini · Imagen', kind: 'imagen',
      model: 'imagen-3.0-generate-002',
      note: 'Needs a Gemini API key (Settings → API Keys)' },
    { id: 'openai', label: 'OpenAI · gpt-image-1', kind: 'openai-images',
      model: 'gpt-image-1',
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
