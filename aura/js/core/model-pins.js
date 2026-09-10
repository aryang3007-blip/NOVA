/**
 * NOVA :: Model Pins (core)
 * ==========================
 * Hardcoded model pins — the DELIBERATE exceptions to auto-routing.
 *
 * Lives at L1 (core) on purpose: both the AI layer (L4, js/ai/...) and the
 * feature layer (L6, js/features/...) import these, and the architecture
 * test forbids L4 -> L6 imports. A pin in core keeps one owner with no
 * layer violation in either direction.
 *
 * @module core/model-pins
 */

/**
 * ONE preconfigured outline model for document generation (the user's
 * decision): deck/word/spreadsheet outlines are mechanical JSON and
 * gemini-3.8-flash is the newest stable model the machine is configured
 * with. Pinned for docgen ONLY; chat stays on the Settings selection.
 *
 * Referenced by js/features/registry.js (pptx defaults) and
 * js/ai/doc-agent.js (outline calls). Mirror:
 * services/manifest.json features.pptx.defaults.model (parity test in
 * tests/test-feature-registry.mjs).
 */
export const PPT_OUTLINE_MODEL = 'gemini-3.8-flash';

export default { PPT_OUTLINE_MODEL };
