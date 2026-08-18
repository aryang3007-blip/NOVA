/**
 * AURA :: AI Sphere provider unit tests
 * =====================================
 * Pure logic and contract: state table, transitions, quality tiers, and the
 * provider interface. Rendering is verified separately in the browser
 * (tests/test-sphere-ui.py) by measuring real pixels.
 *
 *   node tests/test-sphere.mjs
 */
import { SPHERE_STATES, SphereAvatarProvider } from '../js/avatar/providers/sphere.js';
import { PROVIDERS, DEFAULT_PROVIDER, getProviderClass, listProviders }
  from '../js/avatar/providers/index.js';
import { AvatarProvider } from '../js/avatar/providers/base.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); }
};
const S = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

/* ─────────────────────────────────────────────────────────── */
S('THE SPEC\'S NINE AGENT STATES ALL EXIST (§94)');
const REQUIRED = ['idle', 'listening', 'thinking', 'planning', 'executing',
                  'success', 'error', 'connecting', 'connected'];
for (const s of REQUIRED) {
  ok(`state "${s}" is defined`, !!SPHERE_STATES[s]);
}
ok('no extra undocumented states',
   Object.keys(SPHERE_STATES).length === REQUIRED.length,
   Object.keys(SPHERE_STATES).join(','));

S('EVERY STATE IS VISUALLY DISTINCT');
{
  // If two states share every parameter the user cannot tell them apart, which
  // would make the sphere decorative rather than an instrument.
  const seen = new Map();
  let dupes = 0;
  for (const [name, v] of Object.entries(SPHERE_STATES)) {
    const key = [v.spin, v.coreGlow, v.particleMul, v.waveAmp, v.hueShift, v.jitter, v.scan].join('|');
    if (seen.has(key)) { dupes++; ok(`"${name}" differs from "${seen.get(key)}"`, false, key); }
    seen.set(key, name);
  }
  ok('all nine states have distinct parameters', dupes === 0, `${dupes} duplicates`);

  for (const [name, v] of Object.entries(SPHERE_STATES)) {
    ok(`${name}: numeric params are sane`,
       [v.spin, v.coreGlow, v.particleMul, v.waveAmp, v.jitter, v.scan]
         .every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0),
       JSON.stringify(v));
    ok(`${name}: has a human label`, typeof v.label === 'string' && v.label.length > 1);
  }
}

S('STATE SEMANTICS MATCH THE SPEC\'S DESCRIPTIONS');
{
  const s = SPHERE_STATES;
  ok('listening is brighter than idle (§11)', s.listening.coreGlow > s.idle.coreGlow,
     `${s.listening.coreGlow} vs ${s.idle.coreGlow}`);
  ok('listening has more active waves than idle', s.listening.waveAmp > s.idle.waveAmp);
  ok('thinking spins faster than idle (§11)', s.thinking.spin > s.idle.spin,
     `${s.thinking.spin} vs ${s.idle.spin}`);
  ok('executing spins fastest of the steady states',
     s.executing.spin > s.thinking.spin && s.executing.spin > s.planning.spin,
     String(s.executing.spin));
  ok('executing has the brightest steady core',
     s.executing.coreGlow >= s.thinking.coreGlow && s.executing.coreGlow >= s.idle.coreGlow);
  ok('success pulses brighter than anything steady',
     s.success.coreGlow > s.executing.coreGlow, String(s.success.coreGlow));
  ok('error shifts warm/red (negative hue tilt)', s.error.hueShift < -20,
     String(s.error.hueShift));
  ok('error is unstable (highest jitter)',
     s.error.jitter > Math.max(...Object.entries(s).filter(([k]) => k !== 'error')
       .map(([, v]) => v.jitter)), String(s.error.jitter));
  ok('connecting shows the strongest scan (§11)',
     s.connecting.scan >= Math.max(...Object.values(s).map(v => v.scan)),
     String(s.connecting.scan));
  ok('planning also scans, but less than connecting',
     s.planning.scan > 0 && s.planning.scan < s.connecting.scan);
  ok('connected pulses like success', s.connected.coreGlow > s.executing.coreGlow);
}

/* ─────────────────────────────────────────────────────────── */
S('PROVIDER CONTRACT');
{
  ok('extends AvatarProvider', SphereAvatarProvider.prototype instanceof AvatarProvider);
  ok('has a stable id', SphereAvatarProvider.id === 'sphere');
  ok('has a label', typeof SphereAvatarProvider.label === 'string');
  ok('has a description', SphereAvatarProvider.description.length > 20);
  const c = SphereAvatarProvider.capabilities;
  ok('declares offline capability', c.offline === true);
  ok('declares lipSync (core pulses with speech)', c.lipSync === true);
  ok('declares gestures (impulses become shockwaves)', c.gestures === true);
  ok('honestly declares NO blink (it has no eyes)', c.blink === false);
}

S('REGISTERED AS THE DEFAULT PROVIDER');
{
  ok('appears in the registry', PROVIDERS.includes(SphereAvatarProvider));
  ok('is the default', DEFAULT_PROVIDER === 'sphere', DEFAULT_PROVIDER);
  ok('resolvable by id', getProviderClass('sphere') === SphereAvatarProvider);
  const list = listProviders();
  ok('listed for the settings UI', list.some(p => p.id === 'sphere'));
  ok('marked as the default in the list',
     list.find(p => p.id === 'sphere')?.isDefault === true);
  ok('the humanoid is still available',
     list.some(p => p.id === 'builtin'), list.map(p => p.id).join(','));
  ok('the sphere is listed first', list[0].id === 'sphere');
}

/* ─────────────────────────────────────────────────────────── */
S('STATE MACHINE (no DOM needed)');
{
  // Construct without init(): setAgentState is pure bookkeeping.
  const p = new SphereAvatarProvider(/** @type {any} */ ({}), {});
  ok('starts idle', p.getAgentState() === 'idle');
  ok('accepts a valid state', p.setAgentState('thinking') === true);
  ok('...and stores it', p.getAgentState() === 'thinking');
  ok('rejects an unknown state', p.setAgentState('banana') === false);
  ok('...and does not change', p.getAgentState() === 'thinking');

  // A transient state must remember what to fall back to.
  p.setAgentState('executing');
  p.setAgentState('success');
  ok('transient success is applied', p.getAgentState() === 'success');
  ok('remembers executing as the fallback', p._revertTo === 'executing',
     p._revertTo);
  p.setAgentState('idle');
  ok('a steady state replaces the fallback', p._revertTo === 'idle');

  ok('success queues a shockwave', (() => {
    const q = new SphereAvatarProvider(/** @type {any} */ ({}), {});
    q.setAgentState('success');
    return q.shockwaves.length === 1;
  })());
  ok('connected queues a shockwave', (() => {
    const q = new SphereAvatarProvider(/** @type {any} */ ({}), {});
    q.setAgentState('connected');
    return q.shockwaves.length === 1;
  })());
  ok('thinking does NOT queue a shockwave', (() => {
    const q = new SphereAvatarProvider(/** @type {any} */ ({}), {});
    q.setAgentState('thinking');
    return q.shockwaves.length === 0;
  })());
}

S('QUALITY TIERS AND PARTICLE BUDGET');
{
  const p = new SphereAvatarProvider(/** @type {any} */ ({}), {});
  ok('rejects an unknown quality', p.setQuality('ultra') === false);
  for (const q of ['low', 'medium', 'high']) {
    ok(`accepts "${q}"`, p.setQuality(q) === true);
    ok(`  seeds particles for ${q}`, p.particles.length === p.budget && p.budget > 0,
       `${p.particles.length}`);
  }
  p.setQuality('low');
  const lowN = p.particles.length;
  p.setQuality('high');
  ok('high has more particles than low', p.particles.length > lowN,
     `${p.particles.length} > ${lowN}`);
  ok('an explicit choice disables auto-tuning', p._tuned === true);
}

S('PARTICLE DISTRIBUTION IS EVEN (no polar bunching)');
{
  const p = new SphereAvatarProvider(/** @type {any} */ ({}), {});
  p._seed(2000);
  // acos(2u-1) gives equal-area latitudes. Split into 4 equal-area bands by
  // cos(lat) and check the counts are within ~15% of each other.
  const bands = [0, 0, 0, 0];
  for (const q of p.particles) {
    const z = Math.cos(q.lat);                 // -1..1, uniform if correct
    bands[Math.min(3, Math.floor((z + 1) / 2 * 4))]++;
  }
  const min = Math.min(...bands), max = Math.max(...bands);
  ok('particles spread evenly over the sphere', (max - min) / max < 0.18,
     JSON.stringify(bands));
  ok('every particle has a sane radius',
     p.particles.every(q => q.r > 0.5 && q.r < 1.2));
  ok('every particle has a positive size',
     p.particles.every(q => q.size > 0));
}

S('REDUCED MOTION (§82)');
{
  const p = new SphereAvatarProvider(/** @type {any} */ ({}), {});
  p.setReducedMotion(true);
  ok('reduced motion can be forced on', p.reducedMotion === true);
  p.setReducedMotion(false);
  ok('...and off', p.reducedMotion === false);
}

S('DISPOSE IS SAFE');
{
  const p = new SphereAvatarProvider(/** @type {any} */ ({}), {});
  p._seed(50);
  p.dispose();
  ok('clears particles', p.particles.length === 0);
  ok('marks uninitialised', p.initialized === false);
  let threw = false;
  try { p.dispose(); } catch { threw = true; }
  ok('is safe to call twice', !threw);
}

S('describe() REPORTS REAL STATE');
{
  const p = new SphereAvatarProvider(/** @type {any} */ ({}), {});
  p._seed(120);
  p.setAgentState('executing');
  const d = p.describe();
  ok('reports the id', d.id === 'sphere');
  ok('reports capabilities', !!d.capabilities);
  ok('detail names the live state', /Executing/.test(d.detail), d.detail);
  ok('detail reports the real particle count', /120 particles/.test(d.detail), d.detail);
}

console.log(`\n  \x1b[32mPASS ${P}\x1b[0m  FAIL ${F}`);
process.exit(F ? 1 : 0);
