/**
 * AURA :: Plugin Registry
 * -----------------------
 * A plugin is a plain object:
 *   {
 *     id: 'weather',
 *     name: 'Weather',
 *     description: 'Reports conditions',
 *     // optional slash/voice command
 *     commands: [{ name:'weather', usage:'/weather <city>', run: async (args, ctx) => 'string' }],
 *     // optional: called at boot with the full context
 *     setup: (ctx) => {},
 *     // optional: contribute live context to the AI prompt
 *     context: () => 'note injected into system prompt',
 *   }
 *
 * Everything AURA itself ships (clock, memory, diagnostics, vision-describe…)
 * is registered through this exact API — proving the extension path works.
 */

import { bus, EV } from './bus.js';

export class PluginRegistry {
  constructor(ctx = {}) {
    this.ctx = ctx;                 // { bus, state, config, ai, voice, vision, avatar }
    this.plugins = new Map();
    this.commands = new Map();      // name -> {plugin, cmd}
  }

  setContext(ctx) { this.ctx = { ...this.ctx, ...ctx }; }

  register(plugin) {
    if (!plugin || !plugin.id) throw new Error('Plugin requires an id');
    if (this.plugins.has(plugin.id)) {
      console.warn(`[plugins] "${plugin.id}" already registered — replacing`);
    }
    this.plugins.set(plugin.id, plugin);
    for (const cmd of plugin.commands || []) {
      this.commands.set(cmd.name.toLowerCase(), { plugin, cmd });
      for (const a of cmd.aliases || []) this.commands.set(a.toLowerCase(), { plugin, cmd });
    }
    try { plugin.setup?.(this.ctx); }
    catch (e) { console.error(`[plugins] setup failed for ${plugin.id}`, e); }
    bus.emit(EV.PLUGIN_REGISTERED, { id: plugin.id, name: plugin.name });
    return this;
  }

  unregister(id) {
    const p = this.plugins.get(id);
    if (!p) return false;
    for (const cmd of p.commands || []) {
      this.commands.delete(cmd.name.toLowerCase());
      for (const a of cmd.aliases || []) this.commands.delete(a.toLowerCase());
    }
    try { p.teardown?.(this.ctx); } catch {}
    this.plugins.delete(id);
    return true;
  }

  list() {
    return Array.from(this.plugins.values()).map(p => ({
      id: p.id, name: p.name, description: p.description,
      commands: (p.commands || []).map(c => ({ name: c.name, usage: c.usage, help: c.help })),
    }));
  }

  /**
   * @param {{includeHidden?:boolean}} [opts]
   * Commands flagged `hidden` are runnable but never listed — used for the
   * secret Innovations page, which must not appear in /help.
   */
  listCommands({ includeHidden = false } = {}) {
    const seen = new Set(); const out = [];
    for (const { plugin, cmd } of this.commands.values()) {
      const k = plugin.id + ':' + cmd.name;
      if (seen.has(k)) continue;
      seen.add(k);
      if (cmd.hidden && !includeHidden) continue;
      out.push({ plugin: plugin.id, name: cmd.name, usage: cmd.usage || `/${cmd.name}`, help: cmd.help || '' });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name) { return this.commands.has(String(name).toLowerCase()); }

  /**
   * Execute a slash command string, e.g. "/weather Delhi".
   * @returns {Promise<{handled:boolean, output?:string, error?:string}>}
   */
  async run(input) {
    const text = String(input || '').trim();
    if (!text.startsWith('/')) return { handled: false };
    const [rawName, ...rest] = text.slice(1).split(/\s+/);
    const entry = this.commands.get((rawName || '').toLowerCase());
    if (!entry) {
      return { handled: true, error: `Unknown command "/${rawName}". Type /help for the list.` };
    }
    try {
      const output = await entry.cmd.run(rest.join(' ').trim(), this.ctx);
      // null/undefined means "I already produced the reply myself" — /look and
      // /search stream their answer through the model. JSON.stringify would
      // turn that into the literal string "null" and print it in the chat.
      if (output === null || output === undefined) return { handled: true, output: null };
      return { handled: true, output: typeof output === 'string' ? output : JSON.stringify(output, null, 2) };
    } catch (e) {
      console.error('[plugins] command error', e);
      return { handled: true, error: `Command failed: ${e.message}` };
    }
  }

  /** Aggregate live context strings from all plugins for the AI prompt. */
  collectContext() {
    const notes = [];
    for (const p of this.plugins.values()) {
      try {
        const n = p.context?.(this.ctx);
        if (n) notes.push(`- ${n}`);
      } catch (e) { /* a bad plugin must not break the prompt */ }
    }
    return notes.join('\n');
  }
}

export const plugins = new PluginRegistry();
export default plugins;
