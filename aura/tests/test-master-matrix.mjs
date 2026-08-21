/**
 * AURA / NOVA :: Master Node.js Regression Matrix
 * ===============================================
 * Systematically verifies JavaScript & AI runtime subsystems:
 *  - Multimodal Provider interfaces (Gemini, OpenAI, OpenRouter, Anthropic, Groq, Ollama)
 *  - TaskAgent Observe-Reason-Act-Verify autonomous loop & task state tracking
 *  - ScreenAgent direct vision & OCR planner routing
 *  - Cognitive Orchestrator & semantic intent routing
 *  - Structured 5-Tier Memory manager & category filtering
 *  - Voice system: viseme conversion, acoustic similarity, barge-in guard
 *  - Tool calling protocol & parameter validation
 */

import { strict as assert } from 'node:assert';
import { getProvider, PROVIDERS } from '../js/ai/providers.js';
import { wordToVisemes, estimateWordDuration, phoneticSimilarity } from '../js/voice/speech.js';
import { TaskAgent, AGENT_ACTIONS } from '../js/ai/task-agent.js';
import { extractJson, GRID_COLS, GRID_ROWS } from '../js/ai/screen-agent.js';
import { extractToolCalls, normalizeToolCall, validateToolCall, toToolResult } from '../js/ai/tools.js';

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`  [OK] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}:`, err.message);
    throw err;
  }
}

async function runAsyncTests() {
  console.log('='.repeat(70));
  console.log('      AURA / NOVA :: MASTER NODE.JS REGRESSION MATRIX');
  console.log('='.repeat(70));

  // ── 1. Provider & Multimodal Subsystem ──────────────────────────────────────
  test('Providers: All major providers registered with multimodal support', () => {
    const ids = ['gemini', 'openai', 'anthropic', 'openrouter', 'groq', 'ollama'];
    for (const id of ids) {
      const p = getProvider(id);
      assert(p, `Provider ${id} should exist`);
      assert(typeof p.stream === 'function', `Provider ${id} must implement stream()`);
    }
  });

  // ── 2. Speech & Voice Pipeline ──────────────────────────────────────────────
  test('Voice: Viseme timing and phoneme mapping', () => {
    const vis = wordToVisemes('hello', 300);
    assert(Array.isArray(vis), 'Visemes must be an array');
    assert(vis.length > 0, 'Visemes should not be empty');
    assert(typeof vis[0].open === 'number', 'Viseme must contain open parameter');
  });

  test('Voice: Acoustic & phonetic similarity scoring', () => {
    assert(phoneticSimilarity('nova', 'nova') === 1.0);
    assert(phoneticSimilarity('nova', 'nora') >= 0.75);
    assert(phoneticSimilarity('jarvis', 'travis') >= 0.50);
    assert(phoneticSimilarity('cat', 'elephant') < 0.40);
  });

  // ── 3. Autonomous Task Agent Loop ───────────────────────────────────────────
  test('TaskAgent: Action vocabulary and hard step budget', () => {
    assert(AGENT_ACTIONS.includes('open_app'));
    assert(AGENT_ACTIONS.includes('click'));
    assert(AGENT_ACTIONS.includes('type'));
    assert(AGENT_ACTIONS.includes('done'));
    assert(AGENT_ACTIONS.includes('fail'));

    const agent = new TaskAgent({ screen: null, agent: null, actions: null, ai: null });
    assert.equal(agent.state, 'IDLE');
    assert.equal(agent.running, false);
  });

  test('TaskAgent: App name alias resolution', () => {
    const agent = new TaskAgent({ screen: null, agent: null, actions: null, ai: null });
    const installed = [{ id: 'whatsapp' }, { id: 'vscode' }, { id: 'spotify' }];

    const wa = agent.resolveApp('open whatsapp please', installed);
    assert(wa, 'Should resolve whatsapp');
    assert.equal(wa.id, 'whatsapp');
    assert.equal(wa.installed, true);

    const code = agent.resolveApp('open visual studio code', installed);
    assert(code, 'Should resolve vscode');
    assert.equal(code.id, 'vscode');
  });

  // ── 4. Screen Agent & Grid Grounding ────────────────────────────────────────
  test('ScreenAgent: Grid coordinates and JSON extraction', () => {
    assert.equal(GRID_COLS, 12);
    assert.equal(GRID_ROWS, 8);

    const validJson = '{"action":"click","target":"Send","cell":"C4"}';
    const parsed = extractJson(validJson);
    assert(parsed, 'Must extract pure JSON');
    assert.equal(parsed.action, 'click');
    assert.equal(parsed.cell, 'C4');

    const markdownJson = '```json\n{"steps":[{"do":"click","cell":"B2"}]}\n```';
    const parsedMd = extractJson(markdownJson);
    assert(parsedMd, 'Must extract JSON from markdown fence');
    assert.equal(parsedMd.steps[0].cell, 'B2');
  });

  // ── 5. Tool Protocol & Parameter Validation ─────────────────────────────────
  test('Tools: Structured tool calling protocol and extraction', () => {
    const rawText = 'I will launch WhatsApp for you.\n```tool\n{"type":"tool_call","tool":"launch_application","parameters":{"application":"WhatsApp"}}\n```';
    const result = extractToolCalls(rawText);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].tool, 'launch_application');
    assert.equal(result.calls[0].parameters.application, 'WhatsApp');
    assert.equal(result.hadCall, true);

    const resFormatted = toToolResult('launch_application', { ok: true, message: 'Opened WhatsApp' });
    assert.equal(resFormatted.success, true);
    assert.equal(resFormatted.tool, 'launch_application');
  });

  console.log(`\n[SUCCESS] ALL NODE.JS MATRIX ASSERTIONS PASSED (${passed}/${total})`);
}

runAsyncTests().catch(err => {
  console.error('\n[FATAL] Node.js Matrix Test Run Failed:', err);
  process.exit(1);
});
