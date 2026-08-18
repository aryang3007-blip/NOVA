/**
 * AURA :: Tool Calling System
 * ---------------------------
 * Formalises the AI ⇄ system contract.
 *
 * The model emits:
 *   { "type": "tool_call", "tool": "launch_application",
 *     "parameters": { "application": "WhatsApp" } }
 *
 * The Action Manager returns:
 *   { "success": true, "tool": "launch_application",
 *     "message": "Application launched successfully", "data": {...} }
 *
 * Tool names are stable, human-readable, and mapped onto the existing
 * registered actions — so this layers on top of the desktop framework
 * without altering it.
 *
 * @module ai/tools
 */

/**
 * @typedef {Object} ToolCall
 * @property {'tool_call'} type
 * @property {string} tool
 * @property {Object<string,*>} parameters
 * @property {string} [id]
 * @property {boolean} [raw]  true when it maps to a raw action id, not a tool
 */

/**
 * @typedef {Object} ToolResult
 * @property {boolean} success
 * @property {string}  tool
 * @property {string}  message
 * @property {*}       [data]
 * @property {string}  [error]      machine-readable failure code
 * @property {boolean} [simulated]
 * @property {boolean} [needsConfirmation]
 * @property {string}  [confirmToken]
 * @property {string}  [permissionLabel]
 */

export const TOOL_ERROR = {
  UNKNOWN_TOOL: 'unknown_tool',
  INVALID_PARAMS: 'invalid_parameters',
  PERMISSION_DENIED: 'permission_denied',
  NOT_AVAILABLE: 'not_available',
  EXECUTION_FAILED: 'execution_failed',
  NEEDS_CONFIRMATION: 'needs_confirmation',
  RATE_LIMITED: 'rate_limited',
};

/**
 * Tool definitions. `action` maps to an id registered on the ActionManager;
 * `map` converts friendly parameter names to that action's payload.
 */
export const TOOLS = {
  launch_application: {
    name: 'launch_application',
    description: 'Open an installed desktop application by name.',
    action: 'launch_app',
    parameters: {
      application: { type: 'string', required: true, description: 'Application name, e.g. "WhatsApp"' },
    },
    map: p => ({ target: p.application }),
    examples: ['{"type":"tool_call","tool":"launch_application","parameters":{"application":"WhatsApp"}}'],
  },
  close_application: {
    name: 'close_application',
    description: 'Close a running application. Asks the user to confirm first.',
    action: 'close_app',
    parameters: {
      application: { type: 'string', required: true, description: 'Application name' },
      force: { type: 'boolean', required: false, description: 'Force-terminate if it will not close' },
    },
    map: p => ({ target: p.application, force: p.force }),
  },
  search_applications: {
    name: 'search_applications',
    description: 'Search which applications AURA knows about.',
    action: 'search_apps',
    parameters: { query: { type: 'string', required: true, description: 'Search text' } },
    map: p => ({ target: p.query }),
  },
  list_applications: {
    name: 'list_applications',
    description: 'List known applications, optionally filtered by category.',
    action: 'list_apps',
    parameters: { category: { type: 'string', required: false, description: 'e.g. communication, media, dev' } },
    map: p => ({ category: p.category }),
  },
  open_website: {
    name: 'open_website',
    description: 'Open a URL in the default browser.',
    action: 'open_url',
    parameters: { url: { type: 'string', required: true, description: 'Website address' } },
    map: p => ({ target: p.url }),
  },
  search_web: {
    name: 'search_web',
    description: 'Run a web search in the browser.',
    action: 'web_search',
    parameters: {
      query: { type: 'string', required: true, description: 'What to search for' },
      engine: { type: 'string', required: false, description: 'duckduckgo | google | youtube' },
    },
    map: p => ({ target: p.query, engine: p.engine }),
  },
  control_media: {
    name: 'control_media',
    description: 'Control media playback.',
    action: 'media_control',
    parameters: { command: { type: 'string', required: true, description: 'play | pause | next | previous | stop' } },
    map: p => ({ target: p.command }),
  },
  set_volume: {
    name: 'set_volume',
    description: 'Set or adjust system volume.',
    action: 'set_volume',
    parameters: { level: { type: 'string', required: true, description: '0-100, or up | down | mute' } },
    map: p => ({ target: String(p.level) }),
  },
  take_screenshot: {
    name: 'take_screenshot',
    description: 'Capture the desktop screen.',
    action: 'screenshot',
    parameters: {},
    map: () => ({}),
  },
  read_clipboard: {
    name: 'read_clipboard',
    description: 'Read the current clipboard contents.',
    action: 'clipboard_read',
    parameters: {},
    map: () => ({}),
  },
  write_clipboard: {
    name: 'write_clipboard',
    description: 'Copy text to the clipboard.',
    action: 'clipboard_write',
    parameters: { text: { type: 'string', required: true, description: 'Text to copy' } },
    map: p => ({ target: p.text }),
  },
  power_control: {
    name: 'power_control',
    description: 'Lock, sleep, restart or shut down the machine. Always confirms.',
    action: 'power_control',
    parameters: { command: { type: 'string', required: true, description: 'lock | sleep | restart | shutdown | logoff' } },
    map: p => ({ target: p.command }),
  },
  get_weather: {
    name: 'get_weather',
    description: 'Current weather and a 3-day forecast for a place.',
    action: null,                        // handled by the live-data service
    service: 'weather',
    parameters: { location: { type: 'string', required: false, description: 'City name; omit for current location' } },
    map: p => ({ place: p.location || null }),
  },
  get_news: {
    name: 'get_news',
    description: 'Latest news headlines.',
    action: null,
    service: 'news',
    parameters: { topic: { type: 'string', required: false, description: 'tech | world | india | business | science' } },
    map: p => ({ topic: p.topic || 'top' }),
  },
  lookup_knowledge: {
    name: 'lookup_knowledge',
    description: 'Look a topic up on Wikipedia.',
    action: null,
    service: 'wiki',
    parameters: { topic: { type: 'string', required: true, description: 'Subject to look up' } },
    map: p => ({ query: p.topic }),
  },
  remember: {
    name: 'remember',
    description: 'Store a durable fact or preference about the user.',
    action: null,
    service: 'memory_store',
    parameters: {
      key: { type: 'string', required: true, description: 'Short identifier, e.g. "favouriteApp"' },
      value: { type: 'string', required: true, description: 'Value to remember' },
    },
    map: p => ({ key: p.key, value: p.value }),
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

/**
 * Validate a tool call's parameters against its declared schema.
 * @param {string} toolName
 * @param {object} params
 * @returns {{ok:boolean, value?:object, error?:string}}
 */
export function validateToolCall(toolName, params) {
  const tool = TOOLS[toolName];
  if (!tool) return { ok: false, error: `Unknown tool "${toolName}".` };

  const out = {};
  const src = params || {};
  for (const [key, spec] of Object.entries(tool.parameters)) {
    const v = src[key];
    if (v === undefined || v === null || v === '') {
      if (spec.required) return { ok: false, error: `Tool "${toolName}" requires parameter "${key}".` };
      continue;
    }
    if (spec.type === 'string' && typeof v !== 'string' && typeof v !== 'number') {
      return { ok: false, error: `Parameter "${key}" must be a string.` };
    }
    if (spec.type === 'boolean') { out[key] = Boolean(v); continue; }
    out[key] = typeof v === 'string' ? v.trim() : v;
  }
  return { ok: true, value: out };
}

/**
 * Normalise anything action-shaped into a canonical ToolCall.
 * Accepts the spec form, the older {action,target} form, and bare strings.
 * @returns {ToolCall|null}
 */
export function normalizeToolCall(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return TOOLS[raw] ? { type: 'tool_call', tool: raw, parameters: {} } : null;
  }
  // canonical
  if (raw.type === 'tool_call' && typeof raw.tool === 'string') {
    return { type: 'tool_call', tool: raw.tool, parameters: raw.parameters || {}, id: raw.id };
  }
  // legacy { action, target, params }
  if (typeof raw.action === 'string') {
    const tool = TOOL_NAMES.find(n => TOOLS[n].action === raw.action);
    if (tool) {
      const spec = TOOLS[tool];
      const firstParam = Object.keys(spec.parameters)[0];
      const parameters = { ...(raw.params || {}) };
      if (raw.target !== undefined && firstParam) parameters[firstParam] = raw.target;
      return { type: 'tool_call', tool, parameters };
    }
    // No friendly tool wraps it — pass through as a raw action.
    return { type: 'tool_call', tool: raw.action, parameters: { ...(raw.params || {}), target: raw.target }, raw: true };
  }
  return null;
}

/** Build a ToolResult from an ActionManager result. */
export function toToolResult(toolName, actionResult) {
  const codeMap = {
    no_permission: TOOL_ERROR.PERMISSION_DENIED,
    unknown_action: TOOL_ERROR.UNKNOWN_TOOL,
    bad_payload: TOOL_ERROR.INVALID_PARAMS,
    rate_limited: TOOL_ERROR.RATE_LIMITED,
    needs_confirmation: TOOL_ERROR.NEEDS_CONFIRMATION,
    handler_error: TOOL_ERROR.EXECUTION_FAILED,
    disabled: TOOL_ERROR.NOT_AVAILABLE,
  };
  /** @type {ToolResult} */
  const r = {
    success: !!actionResult?.ok,
    tool: toolName,
    message: actionResult?.message || (actionResult?.ok ? 'Done.' : 'Action failed.'),
  };
  if (actionResult?.simulated) r.simulated = true;
  if (actionResult?.needsConfirmation) { r.needsConfirmation = true; r.confirmToken = actionResult.confirmToken; }
  if (actionResult?.code) r.error = codeMap[actionResult.code] || actionResult.code;
  if (actionResult?.permissionLabel) r.permissionLabel = actionResult.permissionLabel;
  const data = {};
  for (const k of ['app', 'apps', 'results', 'stats', 'text', 'path']) {
    if (actionResult?.[k] !== undefined) data[k] = actionResult[k];
  }
  if (Object.keys(data).length) r.data = data;
  return r;
}

/**
 * The tool manifest injected into the system prompt.
 * @param {(toolName:string)=>boolean} [isAvailable] filter by permission
 */
export function buildToolManifest(isAvailable = null) {
  const lines = [];
  for (const name of TOOL_NAMES) {
    const t = TOOLS[name];
    const avail = isAvailable ? isAvailable(name) : true;
    const params = Object.entries(t.parameters)
      .map(([k, s]) => `${k}${s.required ? '' : '?'}: ${s.type}`).join(', ');
    lines.push(`- ${name}(${params}) — ${t.description}${avail ? '' : '  [UNAVAILABLE: permission not granted]'}`);
  }
  return lines.join('\n');
}

/** Full protocol instructions for the model. */
export function toolProtocolPrompt(manifest) {
  return [
    'TOOL CALLING PROTOCOL',
    '',
    'You can either reply normally, OR request a tool. Never do both for the same intent.',
    '',
    '1) NORMAL RESPONSE — for questions, explanations, chat:',
    '   Quantum computing uses quantum mechanics to...',
    '',
    '2) TOOL CALL — when the user asks you to DO something on their computer.',
    '   Emit one short sentence, then exactly one fenced block:',
    '',
    '```tool',
    '{"type":"tool_call","tool":"launch_application","parameters":{"application":"WhatsApp"}}',
    '```',
    '',
    'AVAILABLE TOOLS:',
    manifest,
    '',
    'Rules:',
    '- Never output shell commands, PowerShell, registry keys or file paths to run.',
    '- Use only the tool names listed. Never invent one.',
    '- One tool call per reply.',
    '- If a tool is marked UNAVAILABLE, explain which permission is needed instead of calling it.',
    '- For pure questions ("what is X?"), answer normally — do NOT call a tool.',
  ].join('\n');
}

const TOOL_FENCE = /```(?:tool|tool_call|action|json:action)\s*\n([\s\S]*?)```/gi;

/**
 * Extract tool calls from a model reply.
 * @returns {{calls:ToolCall[], cleanText:string, hadCall:boolean}}
 */
export function extractToolCalls(text) {
  const src = String(text || '');
  const calls = [];
  TOOL_FENCE.lastIndex = 0;
  let m;
  while ((m = TOOL_FENCE.exec(src)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        const norm = normalizeToolCall(item);
        if (norm) calls.push(norm);
      }
    } catch { /* malformed block: ignore, keep the prose */ }
  }
  const cleanText = calls.length
    ? src.replace(TOOL_FENCE, '').replace(/\n{3,}/g, '\n\n').trim()
    : src;
  return { calls, cleanText, hadCall: calls.length > 0 };
}

export default { TOOLS, TOOL_NAMES, TOOL_ERROR, validateToolCall, normalizeToolCall, toToolResult, buildToolManifest, toolProtocolPrompt, extractToolCalls };
