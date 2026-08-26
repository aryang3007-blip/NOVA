/**
 * NOVA :: Context Packet
 * ----------------------
 * The structured "who/where/what-can-I-use" brief injected ahead of model
 * calls (spec §7). The point is RELEVANCE, not volume: a device list, the
 * tool names available right now, preferences that match the request, the
 * current screen/task state — and nothing else. Database dumps and whole
 * conversations never ride along.
 *
 * @module ai/context-packet
 */

import { config } from '../core/config.js';
import { TOOL_NAMES } from './tools.js';
import { NOVA_CAPABILITIES } from './semantic-tools.js';
import * as router from './router.js';

/** Cheap token-overlap relevance — the same idea memory uses, kept local. */
function relevantItems(items, text, { limit = 6, getText } = {}) {
  const q = new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
  if (!q.size) return [];
  return (items || [])
    .map(it => {
      const s = getText(it).toLowerCase();
      let score = 0;
      for (const w of q) if (s.includes(w)) score++;
      return { it, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.it);
}

/**
 * Build the packet.
 *
 * @param {object} o
 * @param {string} o.userText        the current request (drives relevance)
 * @param {any}    [o.engine]        AIEngine (provider pair, memory, screen)
 * @param {object} [o.devices]       device manager / registry snapshot
 * @param {string[]} [o.conversationHints] last few user lines, truncated
 * @returns {Promise<ContextPacket>}
 *
 * @typedef {Object} ContextPacket
 * @property {string} selectedProvider @property {string} selectedModel
 * @property {string} activeDevice     @property {Array}  availableDevices
 * @property {string[]} availableTools @property {Array}  preferences
 * @property {Array}  knowledge
 * @property {object} runtime          screen/vision/internet/task state
 * @property {string} systemNote       prompt-ready rendering of all of the above
 */
export async function buildContextPacket({ userText = '', engine = null, devices = null, conversationHints = [] } = {}) {
  const target = router.resolveChat(engine);

  // ── devices (best-effort; absence is information, not an error) ──
  let availableDevices = [];
  try {
    const dm = devices || engine?.deviceManager;
    const list = dm?.listDevices?.() || dm?.devices?.() || dm?.list?.() || [];
    availableDevices = (Array.isArray(list) ? list : []).slice(0, 8).map(d => ({
      id: d.id || d.deviceId || '', name: d.name || d.label || d.id || '',
      platform: d.platform || d.type || '', online: d.online !== false,
    }));
  } catch {}

  // ── preferences + knowledge: only rows relevant to THIS request ──
  let preferences = [], knowledge = [], facts = [];
  try {
    const mm = engine?.memoryManager;
    if (mm?.preferences?.all) {
      const all = await mm.preferences.all();
      const rows = Object.entries(all || {}).map(([key, v]) => ({ key, value: v?.value ?? v }));
      preferences = relevantItems(rows, userText, { getText: r => `${r.key} ${r.value}` });
    }
    if (mm?.recall) {
      knowledge = (await mm.recall(userText, { limit: 4 })) || [];
    } else if (mm?.searchKnowledge) {
      knowledge = (await mm.searchKnowledge(userText, { limit: 4 })) || [];
    }
    if (mm?.facts?.recent) facts = (await mm.facts.recent(4)) || [];
  } catch {}

  // ── runtime state ──
  const runtime = {
    internet: config.get('liveData') !== false,
    offlineMode: config.get('offlineMode') === true,
    screenShared: !!engine?.screen?.active,
    visionAvailable: !!engine?.visionContext,
    currentTask: engine?.currentTask?.title || null,
    wakeWord: !!config.get('wakeWordEnabled'),
    currentApp: null, currentWindow: null, // filled by desktop layer when known
  };

  // ── tools actually usable right now ──
  let availableTools = [...TOOL_NAMES, ...Object.keys(NOVA_CAPABILITIES)];
  try {
    const ok = engine?.desktop?.initialized;
    if (!ok) availableTools = availableTools.filter(t => NOVA_CAPABILITIES[t] || t === 'search_web');
  } catch {}

  const packet = {
    userRequest: userText,
    conversationContext: conversationHints.slice(-3).map(s => String(s).slice(0, 160)),
    selectedProvider: target.provider,
    selectedModel: target.model,
    activeDevice: 'this computer',
    availableDevices,
    deviceCapabilities: availableDevices.length ? ['companion_remote'] : [],
    availableTools,
    userPreferences: preferences,
    relevantMemory: knowledge,
    facts,
    currentTask: runtime.currentTask,
    internetAvailable: runtime.internet,
    offlineMode: runtime.offlineMode,
    visionAvailable: runtime.visionAvailable,
    runtime,
  };

  // Prompt-ready rendering — short lines, bounded counts.
  const L = [];
  L.push('[CONTEXT PACKET]');
  L.push(`backend: ${packet.selectedProvider}${packet.selectedModel ? '/' + packet.selectedModel : ''}` +
         `${packet.internetAvailable ? '' : ' | INTERNET OFF'}`);
  if (availableDevices.length) {
    L.push('devices: ' + availableDevices.map(d =>
      `${d.name}${d.online ? '' : ' (offline)'}${d.platform ? ' [' + d.platform + ']' : ''}`).join(', '));
  } else {
    L.push('devices: none paired (this computer only)');
  }
  if (preferences.length) {
    L.push('user preferences: ' + preferences.map(p => `${p.key}=${String(p.value).slice(0, 60)}`).join('; '));
  }
  if (knowledge.length) {
    L.push('relevant memory: ' + knowledge.map(k =>
      String(k?.text || k?.content || k || '').slice(0, 90)).join(' | '));
  }
  if (runtime.screenShared) L.push('screen: shared and inspectable (inspect_screen)');
  if (runtime.currentTask) L.push(`current task: ${runtime.currentTask}`);
  L.push(`capabilities (${availableTools.length}): use structured actions to act; never fake results.`);

  packet.systemNote = L.join('\n');
  return packet;
}

export default { buildContextPacket };
