/**
 * NOVA :: Unified Capability Registry + Semantic Tool Selection
 * -------------------------------------------------------------
 * The replacement for the "transcript == X → do Y" mindset.
 *
 * ONE catalog describes every capability — desktop actions, documents,
 * research, screen inspection, memory, device control — with structured
 * parameters. Deterministic routing still wins for obvious commands (fast,
 * free); this module is the FALLBACK that asks the configured model to map
 * natural language ("can you put YouTube on my phone?", "launch yt") onto
 * exactly one catalog entry, validate the arguments, and hand a real
 * tool_call to the engine.
 *
 * Guarantees:
 *  - never invents tools: the model gets the catalog, output is validated
 *    against it, unknown tool names are rejected;
 *  - never fakes results: selection ≠ execution; the engine executes via the
 *    Action Manager and reports the REAL result (spec §9);
 *  - no arbitrary execution: there is deliberately NO python/sql/shell tool
 *    here (spec §2);
 *  - device arguments are first-class: "on my phone" lands in `device`,
 *    never glued onto the application name (spec §3).
 *
 * @module ai/semantic-tools
 */

import { TOOLS, validateToolCall, normalizeToolCall } from './tools.js';
import { extractJson } from './screen-agent.js';
import * as router from './router.js';

/**
 * Capabilities that are not OS actions but NOVA services. Same descriptor
 * shape as tools.js (`service` marks engine-side handling).
 */
export const NOVA_CAPABILITIES = {
  generate_document: {
    name: 'generate_document',
    description: 'Create a document (.docx), presentation (.pptx) or spreadsheet (.xlsx) about a topic.',
    service: 'docgen',
    parameters: {
      kind: { type: 'string', required: true, description: 'pptx | docx | xlsx' },
      topic: { type: 'string', required: true, description: 'What the document is about' },
      slides: { type: 'number', required: false, description: 'Requested slide count (presentations)' },
      audience: { type: 'string', required: false, description: 'e.g. "Class 10 students", "investors"' },
      details: { type: 'string', required: false,
                 description: 'Extra instructions, e.g. "history + timeline slides", "a comparison table", "5 case studies"' },
      images: { type: 'array', required: false,
                description: 'image URLs or local file paths (max 3) to embed on image slides' },
    },
  },
  research_topic: {
    name: 'research_topic',
    description: 'Research a topic on the web and summarize findings with sources.',
    service: 'research',
    parameters: {
      topic: { type: 'string', required: true, description: 'What to research' },
      depth: { type: 'string', required: false, description: 'quick | deep' },
    },
  },
  inspect_screen: {
    name: 'inspect_screen',
    description: 'Look at the shared screen and answer a question about what is visible.',
    service: 'screen',
    parameters: {
      question: { type: 'string', required: true, description: 'What to find or describe' },
    },
  },
  device_action: {
    name: 'device_action',
    description: 'Run an action on a paired device (phone, tablet, another AURA computer).',
    parameters: {
      device: { type: 'string', required: true, description: 'Target device: "phone", a device name, or id' },
      action: { type: 'string', required: true, description: 'What to do there, e.g. "open YouTube"' },
      params: { type: 'object', required: false, description: 'Extra action parameters' },
    },
  },
  manage_task: {
    name: 'manage_task',
    description: 'Track a multi-step task: create, list, or mark progress.',
    service: 'tasks',
    parameters: {
      op: { type: 'string', required: true, description: 'create | list | update' },
      title: { type: 'string', required: false },
    },
  },
};

/**
 * The full registry the model reasons over. tools.js entries first (OS
 * actions), then NOVA services. Each gets a compact, prompt-ready shape.
 */
export function capabilityRegistry() {
  const reg = [];
  for (const [name, t] of Object.entries(TOOLS)) {
    reg.push({
      name,
      description: t.description || '',
      parameters: Object.fromEntries(Object.entries(t.parameters || {}).map(([k, v]) =>
        [k, `${v.type}${v.required ? ' (required)' : ''} — ${v.description || ''}`])),
      source: 'os',
    });
  }
  for (const [name, t] of Object.entries(NOVA_CAPABILITIES)) {
    reg.push({
      name,
      description: t.description,
      parameters: Object.fromEntries(Object.entries(t.parameters).map(([k, v]) =>
        [k, `${v.type}${v.required ? ' (required)' : ''} — ${v.description}`])),
      source: t.service ? 'service' : 'os',
    });
  }
  return reg;
}

/** Prompt-ready catalog (bounded size — no token dumps). */
export function capabilityCatalogText() {
  return capabilityRegistry()
    .map(c => `- ${c.name}: ${c.description} args: ${JSON.stringify(c.parameters)}`)
    .join('\n');
}

/**
 * Should this input even be ASKED about as an action? Questions and small
 * talk go to conversation instead — semantic selection must never hijack
 * "what is YouTube?" into opening YouTube.
 */
const QUESTIONISH = /^\s*(what|who|when|where|why|how|is|are|was|were|do|does|did|can you explain|tell me about|explain|kya|kaise|kaun|kyun|kab)\b/i;
const ACTIONISH = /\b(open|launch|start|run|close|quit|play|pause|resume|stop|send|message|text|search|find|look ?up|research|create|make|build|generate|write|draft|set|turn|volume|screenshot|remember|note|list|show|put|cast|mirror|download|install|uninstall|delete|remove|rename|move|copy|paste|save|print|share|call|dial|photo|picture|record|enable|disable|activate|deactivate|connect|disconnect|pair|unpair|lock|unlock|khush|kholo|kholna|khol|kholo|chalao|chala|chalana|banao|banai|banana|karo|karna|dikhao|dikhana|bhejo|bhejna|lagao|lagana|sunao|sunana|dhundo|dhundna|kholo)\b/i;

export function looksActionable(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 3) return false;
  if (/^\s*\//.test(t)) return false;                    // slash = deterministic
  if (QUESTIONISH.test(t)) return false;
  return ACTIONISH.test(t);
}

const SELECT_SYS = `You are NOVA's intent resolver. Map the user's request to EXACTLY ONE capability from the catalog, or to conversation.

Rules:
- Reply with ONE JSON object, nothing else.
- If the request maps to a capability: {"tool":"<name>","args":{...},"device":null,"say":"<one short friendly sentence>"}
- If it is conversation, a question, or too ambiguous: {"tool":null,"say":null}
- Fill ONLY arguments that exist in the catalog entry. Required args must be present and non-empty.
- DEVICE EXTRACTION IS CRITICAL: "open YouTube on my phone" → tool launch target "YouTube", device "phone". NEVER glue the device onto the app name.
- If a device is named ("on Aryan's phone", "on the tablet"), pass it as the device argument using device_action when the capability cannot target devices itself.
- If the user only half-specified ("send a message"), choose the closest tool and put the raw remainder in the most sensible argument — do not refuse.
- Weak/telegraphic English is fine. Interpret intent, not grammar.

CATALOG:
`;

/**
 * Ask the CONFIGURED model to resolve natural language → one tool call.
 *
 * @param {string} text
 * @param {object} [o]
 * @param {any}    [o.engine]     AIEngine (for router resolution)
 * @param {string} [o.deviceSummary]  e.g. "paired: Aryan's Phone (android, online)"
 * @param {Function} [o.streamFn] test seam (forwarded to router.completeJSON)
 * @returns {Promise<{ok:boolean, call?:object, say?:string, reason?:string,
 *          provider?:string, model?:string}>}
 */
export async function semanticToolSelect(text, { engine = null, deviceSummary = '', streamFn = null } = {}) {
  if (!looksActionable(text)) return { ok: false, reason: 'not-actionable' };
  const sys = SELECT_SYS + capabilityCatalogText()
    + (deviceSummary ? `\n\nDEVICES:\n${deviceSummary}` : '');
  const r = await router.completeJSON({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: String(text) },
    ],
    engine, streamFn, temperature: 0.1, maxTokens: 400, timeoutMs: 45000, retries: 1,
  });
  if (!r.ok || !r.json || typeof r.json !== 'object') return { ok: false, reason: 'no-selection', provider: r.provider, model: r.model };

  const tool = typeof r.json.tool === 'string' ? r.json.tool.trim() : null;
  if (!tool || tool === 'null') return { ok: false, reason: 'conversation' };

  // Validate against the registry — hallucinated tool names die here.
  const spec = TOOLS[tool] || NOVA_CAPABILITIES[tool];
  if (!spec) return { ok: false, reason: `unknown-tool:${tool}` };

  const args = (r.json.args && typeof r.json.args === 'object') ? r.json.args : {};
  if (r.json.device && typeof r.json.device === 'string' && !args.device) {
    args.device = r.json.device.trim();
  }

  if (TOOLS[tool]) {
    const v = validateToolCall(tool, args);
    if (!v.ok) return { ok: false, reason: `invalid-args:${v.error}` };
    // Validation strips undeclared params (by design); the DEVICE target is
    // metadata, not a tool argument, so it survives on the call itself.
    const call = normalizeToolCall({ type: 'tool_call', tool, parameters: v.value });
    if (args.device) call.device = String(args.device);
    return { ok: true, call,
             say: typeof r.json.say === 'string' ? r.json.say.slice(0, 200) : '',
             provider: r.provider, model: r.model };
  }

  // NOVA service capability: light required-arg check; execution is engine-side.
  const missing = Object.entries(spec.parameters || {})
    .filter(([, p]) => p.required)
    .map(([k]) => k)
    .filter(k => args[k] == null || args[k] === '');
  if (missing.length) return { ok: false, reason: `missing-args:${missing.join(',')}` };
  return { ok: true, call: { type: 'tool_call', tool, parameters: args, service: spec.service || null },
           say: typeof r.json.say === 'string' ? r.json.say.slice(0, 200) : '',
           provider: r.provider, model: r.model };
}

/**
 * Turn a REAL tool result into an honest sentence (spec §9). Never claims
 * success unless the result says so.
 */
export function verifyAndNarrate(tool, res) {
  const r = res || {};
  if (r.success || r.ok) {
    return { ok: true, text: r.message || `Done — ${tool} completed.` };
  }
  const why = r.message || r.error || 'unknown error';
  return { ok: false, text: `I tried, but it didn't work: ${why}` };
}

export default { NOVA_CAPABILITIES, capabilityRegistry, capabilityCatalogText,
                 looksActionable, semanticToolSelect, verifyAndNarrate };
