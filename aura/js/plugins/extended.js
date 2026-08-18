/**
 * AURA :: Extended Plugin Pack
 * ----------------------------
 * Additional capabilities registered through the SAME public PluginRegistry
 * API a third party would use — no core changes, no special-casing.
 *
 * Every network source here was verified to send `Access-Control-Allow-Origin`
 * so it works directly from the browser with no key and no proxy. Sources that
 * failed that check were deliberately left out rather than shipped broken.
 *
 * All of it respects the global offline switch (`config.liveData`).
 *
 * @module plugins/extended
 */

import { config } from '../core/config.js';
import { bus, EV } from '../core/bus.js';

const TIMEOUT = 9000;

async function jget(url, { timeout = TIMEOUT } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Guard used by every network command so offline mode is honoured. */
function offlineGuard(what) {
  if (config.get('liveData') === false) {
    return `🔒 Offline mode is on, so I can't fetch ${what}. Turn on **Settings → Connect → Live internet data**.`;
  }
  return null;
}

export function registerExtendedPlugins(registry, ctx) {
  const { ui, ai } = ctx;

  /* ── dictionary ─────────────────────────────────────────────────── */
  registry.register({
    id: 'dictionary', name: 'Dictionary', description: 'Word definitions, phonetics and synonyms.',
    commands: [{
      name: 'define', aliases: ['dict', 'meaning'], usage: '/define <word>', help: 'Look up a word',
      run: async (args) => {
        const g = offlineGuard('definitions'); if (g) return g;
        const w = (args || '').trim().split(/\s+/)[0];
        if (!w) return 'Usage: `/define serendipity`';
        try {
          const d = await jget(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`);
          const e = d[0];
          if (!e) return `No definition found for "${w}".`;
          const phon = e.phonetic || e.phonetics?.find(p => p.text)?.text || '';
          const out = [`**${e.word}** ${phon ? `_${phon}_` : ''}`];
          for (const m of (e.meanings || []).slice(0, 3)) {
            out.push(`\n**${m.partOfSpeech}**`);
            for (const def of (m.definitions || []).slice(0, 2)) {
              out.push(`• ${def.definition}${def.example ? `\n  _"${def.example}"_` : ''}`);
            }
            if (m.synonyms?.length) out.push(`  Synonyms: ${m.synonyms.slice(0, 6).join(', ')}`);
          }
          return out.join('\n');
        } catch (e) {
          return /404/.test(e.message) ? `No dictionary entry for "${w}".` : `⚠ Dictionary lookup failed: ${e.message}`;
        }
      },
    }],
  });

  /* ── github ─────────────────────────────────────────────────────── */
  registry.register({
    id: 'github', name: 'GitHub', description: 'Repository and user lookups.',
    commands: [
      {
        name: 'repo', usage: '/repo <owner/name>', help: 'GitHub repository info',
        run: async (args) => {
          const g = offlineGuard('repository data'); if (g) return g;
          const q = (args || '').trim().replace(/^https?:\/\/github\.com\//, '');
          if (!/^[\w.-]+\/[\w.-]+$/.test(q)) return 'Usage: `/repo ollama/ollama`';
          try {
            const r = await jget(`https://api.github.com/repos/${q}`);
            return `**[${r.full_name}](${r.html_url})**\n\n${r.description || '_No description_'}\n\n` +
              `⭐ ${r.stargazers_count.toLocaleString()} · 🍴 ${r.forks_count.toLocaleString()} · ` +
              `🐛 ${r.open_issues_count} open\n` +
              `Language: ${r.language || '—'} · License: ${r.license?.spdx_id || '—'}\n` +
              `Updated: ${new Date(r.pushed_at).toLocaleDateString()}`;
          } catch (e) {
            return /404/.test(e.message) ? `Repository "${q}" not found.` : `⚠ GitHub lookup failed: ${e.message}`;
          }
        },
      },
      {
        name: 'ghuser', usage: '/ghuser <username>', help: 'GitHub profile',
        run: async (args) => {
          const g = offlineGuard('GitHub profiles'); if (g) return g;
          const u = (args || '').trim();
          if (!u) return 'Usage: `/ghuser torvalds`';
          try {
            const r = await jget(`https://api.github.com/users/${encodeURIComponent(u)}`);
            return `**[${r.name || r.login}](${r.html_url})**\n\n${r.bio || '_No bio_'}\n\n` +
              `📦 ${r.public_repos} repos · 👥 ${r.followers.toLocaleString()} followers` +
              `${r.location ? ` · 📍 ${r.location}` : ''}`;
          } catch (e) { return `⚠ ${/404/.test(e.message) ? `User "${u}" not found.` : e.message}`; }
        },
      },
    ],
  });

  /* ── space ──────────────────────────────────────────────────────── */
  registry.register({
    id: 'space', name: 'Space', description: 'NASA imagery and sun times.',
    commands: [
      {
        name: 'apod', aliases: ['nasa'], usage: '/apod', help: 'NASA Astronomy Picture of the Day',
        run: async () => {
          const g = offlineGuard('NASA imagery'); if (g) return g;
          try {
            // DEMO_KEY is rate-limited but keyless; users can add their own.
            const key = config.get('nasaApiKey') || 'DEMO_KEY';
            const d = await jget(`https://api.nasa.gov/planetary/apod?api_key=${encodeURIComponent(key)}`);
            return `**${d.title}** _(${d.date})_\n\n${d.explanation.slice(0, 600)}${d.explanation.length > 600 ? '…' : ''}\n\n` +
              `[View image ↗](${d.hdurl || d.url})` +
              (key === 'DEMO_KEY' ? '\n\n_Using NASA\'s shared DEMO_KEY (rate-limited). Add your own in Settings for reliability._' : '');
          } catch (e) { return `⚠ NASA lookup failed: ${e.message}`; }
        },
      },
      {
        name: 'sun', usage: '/sun [lat] [lon]', help: 'Sunrise and sunset times',
        run: async (args) => {
          const g = offlineGuard('sun times'); if (g) return g;
          let lat = 28.6, lon = 77.2, label = 'your default location';
          const parts = (args || '').trim().split(/\s+/).filter(Boolean);
          if (parts.length >= 2 && Number.isFinite(+parts[0])) {
            lat = +parts[0]; lon = +parts[1]; label = `${lat}, ${lon}`;
          } else if (args) {
            const { liveData } = await import('../realtime/live-data.js');
            const geo = await liveData.geocode(args.trim());
            if (geo.ok) { lat = geo.lat; lon = geo.lon; label = geo.name; }
          }
          try {
            const d = await jget(`https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&formatted=0`);
            const f = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return `**Sun times — ${label}**\n\n🌅 Sunrise: ${f(d.results.sunrise)}\n🌇 Sunset: ${f(d.results.sunset)}\n` +
              `☀ Solar noon: ${f(d.results.solar_noon)}\n⏱ Day length: ${Math.floor(d.results.day_length / 3600)}h ${Math.floor((d.results.day_length % 3600) / 60)}m`;
          } catch (e) { return `⚠ Sun times failed: ${e.message}`; }
        },
      },
    ],
  });

  /* ── fun ────────────────────────────────────────────────────────── */
  registry.register({
    id: 'fun', name: 'Fun', description: 'Jokes and trivia.',
    commands: [
      {
        name: 'joke', usage: '/joke', help: 'Tell a joke',
        run: async () => {
          const g = offlineGuard('jokes'); if (g) return g;
          try {
            const d = await jget('https://official-joke-api.appspot.com/random_joke');
            return `${d.setup}\n\n**${d.punchline}**`;
          } catch (e) { return `⚠ Joke fetch failed: ${e.message}`; }
        },
      },
      {
        name: 'catfact', aliases: ['fact'], usage: '/catfact', help: 'A random cat fact',
        run: async () => {
          const g = offlineGuard('facts'); if (g) return g;
          try { return `🐱 ${(await jget('https://catfact.ninja/fact')).fact}`; }
          catch (e) { return `⚠ Fact fetch failed: ${e.message}`; }
        },
      },
    ],
  });

  /* ── memory management ──────────────────────────────────────────── */
  registry.register({
    id: 'memory-cmds', name: 'Memory', description: 'Inspect and manage AURA\'s layered memory.',
    commands: [
      {
        name: 'remember', usage: '/remember <key> = <value>', help: 'Store a durable preference',
        run: async (args) => {
          const mm = ai?.memoryManager;
          if (!mm) return 'Memory manager unavailable.';
          const m = /^(.+?)\s*[=:]\s*(.+)$/.exec((args || '').trim());
          if (!m) return 'Usage: `/remember favouriteApp = Spotify`';
          await mm.preferences.set(m[1].trim(), m[2].trim(), { source: 'user', confidence: 1 });
          return `✅ Remembered **${m[1].trim()}** = ${m[2].trim()}`;
        },
      },
      {
        name: 'recall', usage: '/recall [query]', help: 'Show stored preferences and knowledge',
        run: async (args) => {
          const mm = ai?.memoryManager;
          if (!mm) return 'Memory manager unavailable.';
          if (args?.trim()) {
            const hits = await mm.knowledge.recall(args.trim());
            if (!hits.length) return `Nothing stored about "${args.trim()}".`;
            return `**Recalled ${hits.length}:**\n\n` + hits.map(h =>
              `• ${h.doc.metadata?.title ? `**${h.doc.metadata.title}** — ` : ''}${h.doc.text.slice(0, 160)}`).join('\n');
          }
          const prefs = mm.preferences.all();
          const st = await mm.stats();
          return `**MEMORY**\n\n` +
            `Conversation: ${st.conversation.total} messages (window ${st.conversation.windowTurns} turns)\n` +
            `Preferences: ${st.preferences.total}\n` +
            `Knowledge: ${st.knowledge.documents} documents (${st.knowledge.backend})\n` +
            `System: ${st.system.runningApps} apps · ${st.system.events} events\n\n` +
            (prefs.length ? `**Stored preferences:**\n${prefs.map(p => `• ${p.key}: ${p.value}`).join('\n')}` : '_No preferences stored yet._');
        },
      },
      {
        name: 'learn', usage: '/learn <text>', help: 'Teach AURA a fact it can recall later',
        run: async (args) => {
          const mm = ai?.memoryManager;
          if (!mm) return 'Memory manager unavailable.';
          if (!args?.trim() || args.trim().length < 8) return 'Usage: `/learn The office wifi password is hunter2`';
          const rec = await mm.knowledge.learn({ text: args.trim(), source: 'user' });
          return `📚 Learned. I'll recall this when it's relevant.\n\n_id: ${rec.id}_`;
        },
      },
      {
        name: 'forget', usage: '/forget <scope>', help: 'Clear memory (conversation | preferences | knowledge | all)',
        run: async (args, c) => {
          const mm = ai?.memoryManager;
          if (!mm) return 'Memory manager unavailable.';
          const scope = (args || 'conversation').trim().toLowerCase();
          if (!['conversation', 'preferences', 'knowledge', 'system', 'all'].includes(scope)) {
            return 'Usage: `/forget conversation|preferences|knowledge|system|all`';
          }
          await mm.clear(scope);
          if (scope === 'conversation' || scope === 'all') { ai.memory.clear(); c.ui.clearTranscript(); }
          return `🧹 Cleared **${scope}** memory.`;
        },
      },
    ],
  });

  /* ── model routing ──────────────────────────────────────────────── */
  registry.register({
    id: 'models', name: 'Model Router', description: 'Inspect installed models and per-task routing.',
    commands: [
      {
        name: 'models', aliases: ['model'], usage: '/models', help: 'Installed models and task routing',
        run: async (_a, c) => {
          const eng = c.ai;
          await eng.refreshModelRegistry();
          const r = eng.models.report();
          if (!r.total) {
            return '**No Ollama models detected.**\n\nIs `ollama serve` running, and is AURA started with `python3 serve.py`? Ask me *"how do I set up Ollama"* for the full walkthrough.';
          }
          const tierIcon = { instant: '⚡', fast: '🟢', moderate: '🟡', slow: '🔴' };
          const lines = [`**INSTALLED MODELS** (${r.total})`, ''];
          lines.push('**Available for auto-routing:**');
          for (const m of r.eligible) {
            lines.push(`${tierIcon[m.tier] || '•'} \`${m.name}\` — ${m.params}B · ${m.tier}` +
              `${m.measured ? ` · ~${m.measured} tok/s measured` : ''}` +
              `${m.capabilities.filter(x => x !== 'chat').length ? ` · ${m.capabilities.filter(x => x !== 'chat').join(', ')}` : ''}`);
          }
          if (r.excluded.length) {
            lines.push('', `**Excluded from auto-routing** (still usable if pinned):`);
            for (const m of r.excluded) lines.push(`🔴 \`${m.name}\` — ${m.reason}`);
          }
          lines.push('', '**Task routing:**');
          for (const [task, a] of Object.entries(r.assignments)) {
            if (!a) continue;
            lines.push(`• **${task}** → \`${a.model}\`${a.pinned ? ' 📌' : ''}  _${a.reason}_`);
          }
          // Which models can genuinely read an image — and how sure are we?
          // Surfaced because guessing this from names is exactly how a user
          // ends up pulling a vision model they already had.
          const { ollama } = await import('../ai/providers.js');
          const vm = ollama.visionModels();
          lines.push('', '**Image understanding (`/look`):**');
          if (vm.length) {
            for (const n of vm) {
              lines.push(`👁 \`${n}\` — ${ollama.capsAreReal(n)
                ? 'confirmed by Ollama'
                : '_guessed from the name — unverified_'}`);
            }
            const chosen = eng.pickVisionModel?.();
            if (chosen) lines.push(`  ↳ \`/look\` will use \`${chosen.name}\` _(${chosen.reason})_`);
          } else {
            lines.push('None detected. `/pin vision <model>` forces one if you know better.');
          }
          const unverified = (ollama.installed || []).filter(n => !ollama.capsAreReal(n));
          if (unverified.length === (ollama.installed || []).length && unverified.length) {
            lines.push('', '⚠ _Your Ollama did not report capabilities for any model — these are name-based guesses. Ollama 0.6.0+ reports them exactly._');
          }

          lines.push('', `_Ceiling: ${r.ceiling}B · strategy: ${r.strategy}. Change in Settings → AI Core._`);
          return lines.join('\n');
        },
      },
      {
        name: 'pin', usage: '/pin <task> <model>', help: 'Pin a model to a task (chat|code|reasoning|tools)',
        run: async (args, c) => {
          const eng = c.ai;
          const parts = (args || '').trim().split(/\s+/);
          if (parts.length < 2) {
            return 'Usage: `/pin code qwen2.5-coder:7b`\n\nTasks: chat, code, reasoning, tools, vision.\nUse `/pin <task> none` to unpin.';
          }
          const [task, ...rest] = parts;
          const model = rest.join(' ');
          if (!['chat', 'code', 'reasoning', 'tools', 'vision'].includes(task)) {
            return `Unknown task "${task}". Use: chat, code, reasoning, tools, vision.`;
          }
          if (/^(none|off|auto|clear)$/i.test(model)) {
            eng.models.pin(task, null);
            return `📌 Unpinned **${task}** — back to automatic selection.`;
          }
          await eng.refreshModelRegistry();
          const m = eng.models.get(model);
          if (!m) {
            const near = eng.models.all().map(x => x.name).filter(n => n.includes(model.split(':')[0]));
            return `Model "${model}" is not installed.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`;
          }
          eng.models.pin(task, model);
          const warn = m.params > eng.models.maxAutoParams
            ? `\n\n⚠ At ${m.params}B this is above the ${eng.models.maxAutoParams}B auto ceiling — replies may be slow, but it's your call.`
            : '';
          return `📌 Pinned **${task}** → \`${model}\` (${m.params}B).${warn}`;
        },
      },
      {
        // HIDDEN: deliberately absent from /help. Reached by this command or
        // by typing the unlock sequence. See js/ui/innovations.js.
        name: 'innovations', aliases: ['innovate'], hidden: true,
        usage: '/innovations', help: 'Hidden idea board',
        run: async (_args, c) => {
          c.ui?.unlockInnovations?.();
          const { INNOVATIONS } = await import('../ui/innovations.js');
          return `◆ **Innovations unlocked** — ${INNOVATIONS.length} ideas on the hidden page.\n\n`
               + INNOVATIONS.map((v, i) => `${i + 1}. **${v.title}** — ${v.tag}`).join('\n');
        },
      },
      {
        name: 'guide', aliases: ['howto'], usage: '/guide [topic]', help: 'Built-in usage guide',
        run: async (args, c) => {
          const { matchGuide, GUIDE_TOPICS } = await import('../ai/guide.js');
          const q = (args || '').trim();
          if (!q) {
            const hit = matchGuide('how do i use this app', c.ai.guideContext());
            return hit.text + `\n\n_Topics: ${GUIDE_TOPICS.join(', ')} — try \`/guide gestures\`._`;
          }
          const probes = {
            overview: 'how do i use this app', ollama: 'how do i set up ollama',
            models: 'how do you choose a model', gestures: 'how do gestures work',
            voice: 'how do i use voice', desktop: 'desktop control',
            vision: 'how do i enable the camera', privacy: 'privacy',
            commands: 'what commands are there', troubleshooting: 'nothing is working',
            shortcuts: 'keyboard shortcuts',
          };
          const hit = matchGuide(probes[q.toLowerCase()] || q, c.ai.guideContext());
          return hit ? hit.text : `No guide topic for "${q}".\n\nAvailable: ${GUIDE_TOPICS.join(', ')}`;
        },
      },
    ],
  });

  /* ── runtime diagnostics ────────────────────────────────────────── */
  registry.register({
    id: 'runtime', name: 'Runtime', description: 'Inspect the local runtime, hardware and routing.',
    commands: [
      {
        name: 'runtime', aliases: ['layers'], usage: '/runtime', help: 'Show the layered architecture status',
        run: async (_a, c) => {
          const rt = c.ui.runtime;
          if (!rt?.initialized) return 'Local runtime is not initialised.';
          const s = rt.status();
          const hw = rt.hardware.summary();
          const svc = rt.services.summary();
          const dot = (b) => b ? '🟢' : '⚪';
          return `**LOCAL RUNTIME**\n\n` +
            `Transport: **${s.transport}**${s.platform ? ` · ${s.platform}` : ''}${s.simulated ? ' _(simulated)_' : ''}\n\n` +
            `**Hardware**\n${hw.map(h => `${dot(h.available)} ${h.capability} — ${h.provider}${h.reason ? ` (${h.reason})` : ''}`).join('\n')}\n\n` +
            `**Local services**\n` +
            `${dot(svc.ollama.available)} Ollama — ${svc.ollama.available ? `${svc.ollama.models} models` : svc.ollama.reason}\n` +
            `${dot(svc.actionBridge.available)} Action bridge — ${svc.actionBridge.available ? 'enabled' : svc.actionBridge.reason}\n` +
            `${dot(svc.fetchProxy.available)} Fetch proxy\n\n` +
            `**Permissions:** ${s.permissions.granted}/${s.permissions.total} granted\n` +
            `**Plugins:** ${s.plugins.filter(p => p.available).length}/${s.plugins.length} ready`;
        },
      },
      {
        name: 'why', usage: '/why <text>', help: 'Explain how AURA would route a message',
        run: async (args, c) => {
          if (!args?.trim()) return 'Usage: `/why what is 47*89`';
          const { intentRouter } = await import('../ai/intent-router.js');
          const { liveData } = await import('../realtime/live-data.js');
          return '```\n' + intentRouter.explain(args.trim(), {
            desktopReady: !!c.ui.desktop?.initialized,
            liveDataEnabled: liveData.enabled,
          }) + '\n```';
        },
      },
      {
        name: 'tools', usage: '/tools', help: 'List AI-callable tools',
        run: async (_a, c) => {
          const { TOOLS } = await import('../ai/tools.js');
          const dt = c.ui.desktop;
          return `**AI TOOL REGISTRY** (${Object.keys(TOOLS).length} tools)\n\n` +
            Object.values(TOOLS).map(t => {
              let ok = true;
              if (t.action && dt?.initialized) {
                const def = dt.actions.actions.get(t.action);
                ok = def ? (!def.permission || dt.permissions.isGranted(def.permission)) : false;
              }
              const params = Object.keys(t.parameters).join(', ') || '—';
              return `${ok ? '🟢' : '🔒'} \`${t.name}(${params})\` — ${t.description}`;
            }).join('\n');
        },
      },
    ],
  });

  bus.emit(EV.LOG, { text: 'Extended plugin pack registered' });
}

export default registerExtendedPlugins;
