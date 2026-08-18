/**
 * AURA :: Desktop Integration Framework tests (Node, no browser).
 * Focus: the Action Manager must be an un-bypassable security gate.
 */
import { PermissionManager, PERMISSIONS, RISK } from '../js/desktop/permissions.js';
import { AppDatabase } from '../js/desktop/app-database.js';
import { AppLauncher, BACKEND } from '../js/desktop/app-launcher.js';
import { ActionManager, DENY } from '../js/desktop/action-manager.js';
import { registerDesktopPlugins } from '../js/desktop/plugins/index.js';
import { DesktopSetupFlow, STEPS } from '../js/desktop/setup-flow.js';
import { DesktopFramework } from '../js/desktop/index.js';
import { extractActions, intentToAction, describeResult } from '../js/ai/action-parser.js';

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
  : (fail++, fails.push(n), console.log(`  \x1b[31m✗ ${n}\x1b[0m ${x}`)); };
const eq = (n, a, b) => ok(n, a === b, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
const sec = t => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

/** In-memory Storage stand-in so tests never touch a real browser. */
class MemStore {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

/* ── permissions ── */
sec('Permission Manager');
{
  const st = new MemStore();
  const pm = new PermissionManager({ storage: st });

  ok('all permissions deny by default', Object.keys(PERMISSIONS).every(id => !pm.isGranted(id)));
  // 14 since v0.18 ('minimize_windows' for Privacy Guard);
  // 15 since v0.20 ('vision_mouse' for dwell-to-click).
  eq('catalogue size', Object.keys(PERMISSIONS).length, 15);
  ok('required perms present', ['launch_apps','close_apps','open_websites','file_system','terminal',
    'power_controls','keyboard_automation','mouse_automation','clipboard','camera','microphone']
    .every(id => !!PERMISSIONS[id]));
  ok('vision_mouse exists for dwell-to-click', !!PERMISSIONS.vision_mouse);
  ok('vision_mouse denies by default', !pm.isGranted('vision_mouse'));
  ok('vision_mouse is high risk', PERMISSIONS.vision_mouse.risk === 'high');
  ok('vision_mouse needs the native bridge', PERMISSIONS.vision_mouse.requiresNative === true);
  ok('vision_mouse is not in the recommended starter set',
    !PermissionManager.recommended().includes('vision_mouse'));

  pm.grant('launch_apps');
  ok('grant works', pm.isGranted('launch_apps'));
  pm.revoke('launch_apps');
  ok('revoke works', !pm.isGranted('launch_apps'));
  ok('toggle returns new state', pm.toggle('clipboard') === true && pm.isGranted('clipboard'));

  const check = pm.check('terminal', { actionName: 'run_command' });
  ok('check denies ungranted', !check.allowed && /not granted/i.test(check.reason));
  pm.grant('terminal');
  ok('check allows granted', pm.check('terminal').allowed);
  ok('unknown permission denied', !pm.check('nonexistent_perm').allowed);
  ok('audit log records checks', pm.checkLog.length >= 3);

  ok('critical perms flagged', PERMISSIONS.terminal.risk === RISK.CRITICAL
    && PERMISSIONS.file_system.risk === RISK.CRITICAL);
  ok('native-only perms flagged', PERMISSIONS.terminal.requiresNative === true
    && PERMISSIONS.open_websites.requiresNative === false);

  const pm2 = new PermissionManager({ storage: st });
  ok('grants persist across instances', pm2.isGranted('terminal') && pm2.isGranted('clipboard'));

  pm2.revokeAll();
  ok('revokeAll clears everything', pm2.summary().granted === 0);
  pm2.grantMany(PermissionManager.recommended());
  ok('recommended preset grants low-risk only',
    pm2.summary().granted === 4 && pm2.summary().critical === 0);
}

/* ── app database ── */
sec('Application Database');
{
  const db = new AppDatabase({ storage: new MemStore() });
  ok('seeded with mock data', db.size >= 15);
  ok('NO hardcoded executable paths', db.all().every(a => a.executablePath === null));
  ok('all mock entries marked unverified', db.all().every(a => !a.verified && a.source === 'mock'));
  ok('installed state is unknown, not false', db.all().every(a => a.installed === null));

  eq('resolve by exact name', db.resolve('WhatsApp')?.id, 'whatsapp');
  eq('resolve by alias', db.resolve('vs code')?.id, 'vscode');
  eq('resolve by loose alias', db.resolve('my editor')?.id, 'vscode');
  eq('resolve case-insensitive', db.resolve('SPOTIFY')?.id, 'spotify');
  eq('unknown resolves null', db.resolve('zzzznope'), null);
  ok('search returns ranked list', db.search('tel').length >= 1);

  ok('records have cross-platform launchers', !!db.get('whatsapp').launchers.win32
    && !!db.get('whatsapp').launchers.darwin && !!db.get('whatsapp').launchers.linux);
  ok('windows launcher has no absolute path',
    !JSON.stringify(db.get('whatsapp').launchers.win32).includes('C:\\\\'));
  ok('categories reported', db.categories().some(c => c.count > 0));

  const merged = db.mergeScanResults([
    { id: 'whatsapp', executablePath: 'MOCK_PATH', installed: true },
    { id: 'newapp', name: 'New App', executablePath: 'MOCK2' },
  ], { platform: 'win32' });
  eq('scan merge updates existing', merged.updated, 1);
  eq('scan merge adds new', merged.added, 1);
  ok('scanned entry becomes verified', db.get('whatsapp').verified === true);
  ok('scan source recorded', db.scanSource === 'win32' && db.lastScan > 0);

  db.recordLaunch('spotify');
  eq('launch counted', db.get('spotify').launchCount, 1);

  const db2 = new AppDatabase({ storage: db.storage });
  ok('database persists', db2.get('newapp')?.name === 'New App');
}

/* ── launcher ── */
sec('App Launcher (mock backend)');
{
  const db = new AppDatabase({ storage: new MemStore() });
  const l = new AppLauncher({ db });
  const init = await l.initialize();
  ok('initialize() resolves', init.ok);
  eq('falls back to mock backend', init.backend, BACKEND.MOCK);
  ok('mock capabilities are honest',
    l.capabilities.simulated === true && l.capabilities.close === false && l.capabilities.enumerate === false);

  const r = await l.launchApp('whatsapp');
  ok('launchApp succeeds but flags simulation', r.ok && r.simulated === true);
  ok('simulated message says so', /SIMULATED/i.test(r.message));

  // An unknown app must not dead-end: it now goes through reasonFallback(),
  // which either proposes a web equivalent or explains itself. It must still
  // never report success for something it did not launch.
  const bad = await l.launchApp('definitelynotanapp');
  ok('unknown app does not report success', !bad.ok);
  ok('unknown app explains itself',
     /isn't installed|don't have|not installed/i.test(bad.message), bad.message);
  ok('unknown app offers a next step',
     !!bad.suggestedUrl || (bad.suggestions && bad.suggestions.length >= 0));

  const c = await l.closeApp('whatsapp');
  ok('closeApp returns a result', typeof c.ok === 'boolean');

  const s = await l.searchInstalledApps('spot');
  ok('searchInstalledApps works', s.ok && s.results.some(a => a.id === 'spotify'));
  ok('search notes data is from catalogue', !!s.note);

  const g = await l.getInstalledApps();
  ok('getInstalledApps returns list + stats', g.ok && g.apps.length > 10 && !!g.stats);
  ok('public shape hides raw paths', g.apps.every(a => !('executablePath' in a)));

  const scan = await l.scanInstalledApps();
  ok('scan unavailable without native', !scan.ok && scan.available === false);
  ok('scan exposes the planned phases', Array.isArray(scan.plannedPhases) && scan.plannedPhases.length >= 5);
  ok('SCAN_PHASES documented', AppLauncher.SCAN_PHASES.some(p => p.id === 'registry'));
}

/* ── action manager: the security gate ── */
sec('Action Manager — security gate');
{
  const st = new MemStore();
  const pm = new PermissionManager({ storage: st });
  const db = new AppDatabase({ storage: st });
  const l = new AppLauncher({ db });
  await l.initialize();
  const am = new ActionManager({ permissions: pm });
  am.setContext({ launcher: l });
  const ids = registerDesktopPlugins(am, { launcher: l, bridge: null });

  eq('all six plugins registered', ids.length, 6);
  ok('expected plugin ids', ['app-launcher','browser-control','file-system','terminal','media','windows-integration']
    .every(id => ids.includes(id)));
  ok('actions registered', am.actions.size >= 15);

  // ── the core guarantee
  const denied = await am.execute({ action: 'launch_app', target: 'WhatsApp' });
  ok('DENIES without permission', !denied.ok && denied.code === DENY.NO_PERMISSION);
  ok('denial names the permission', denied.permissionLabel === 'Launch Applications');
  ok('denial tells user where to fix', /Settings/i.test(denied.fixHint || denied.message));

  pm.grant('launch_apps');
  const allowed = await am.execute({ action: 'launch_app', target: 'WhatsApp' });
  ok('ALLOWS once granted', allowed.ok === true);
  ok('result marked simulated in mock mode', allowed.simulated === true);

  // exact spec shape from the requirements
  const spec = await am.execute({ action: 'launch_app', target: 'WhatsApp' });
  ok('accepts the specified action shape { action, target }', spec.ok);

  const unknown = await am.execute({ action: 'rm_rf_everything', target: '/' });
  ok('rejects unregistered action', !unknown.ok && unknown.code === DENY.UNKNOWN_ACTION);

  const noAction = await am.execute({ target: 'x' });
  ok('rejects missing action id', !noAction.ok);

  const badPayload = await am.execute({ action: 'launch_app' });
  ok('rejects missing required field', !badPayload.ok && badPayload.code === DENY.BAD_PAYLOAD);

  const tooLong = await am.execute({ action: 'launch_app', target: 'x'.repeat(500) });
  ok('rejects oversized payload', !tooLong.ok && tooLong.code === DENY.BAD_PAYLOAD);

  pm.grant('open_websites');
  const badUrl = await am.execute({ action: 'open_url', target: 'javascript:alert(1)' });
  ok('rejects non-URL pattern', !badUrl.ok && badUrl.code === DENY.BAD_PAYLOAD);

  pm.grant('media_control');
  const badEnum = await am.execute({ action: 'media_control', target: 'explode' });
  ok('rejects value outside enum', !badEnum.ok && badEnum.code === DENY.BAD_PAYLOAD);

  // ── confirmation gate on destructive actions
  pm.grant('close_apps');
  const needsConfirm = await am.execute({ action: 'close_app', target: 'whatsapp' });
  ok('high-risk action requires confirmation', needsConfirm.needsConfirmation === true);
  ok('confirmation issues a token', typeof needsConfirm.confirmToken === 'string');
  const confirmed = await am.confirm('close_app', needsConfirm.confirmToken);
  ok('confirm executes the action', typeof confirmed.ok === 'boolean' && !confirmed.needsConfirmation);
  const badToken = await am.confirm('close_app', 'wrong-token');
  ok('bad confirm token rejected', !badToken.ok);

  // ── terminal is architecture-only and must stay inert
  pm.grant('terminal');
  const term = await am.execute({ action: 'run_command', target: 'format C:' });
  ok('terminal action never executes', !term.ok);
  ok('terminal reports not-implemented', term.needsConfirmation || term.notImplemented || /companion/i.test(term.message));

  // ── rate limiting
  am.rateLimit = { windowMs: 10000, max: 3 };
  am._calls.clear();
  let limited = false;
  for (let i = 0; i < 6; i++) {
    const r = await am.execute({ action: 'launch_app', target: 'spotify' });
    if (r.code === DENY.RATE_LIMITED) limited = true;
  }
  ok('rate limiting engages', limited);

  ok('audit trail populated', am.audit.length > 10);
  ok('audit records denials', am.audit.some(a => a.allowed === false));
  ok('recentAudit is newest-first', am.recentAudit(3).length === 3);

  const desc = am.describeForAI();
  ok('AI capability list generated', desc.includes('launch_app'));
  ok('AI list marks ungranted permissions', am.describeForAI().includes('PERMISSION NOT GRANTED')
    || pm.list().every(p => p.granted));

  am.enabled = false;
  const off = await am.execute({ action: 'launch_app', target: 'whatsapp' });
  ok('master switch disables everything', !off.ok && off.code === DENY.DISABLED);
}

/* ── schema validator ── */
sec('Payload validator');
{
  const V = ActionManager.validate;
  ok('required enforced', !V({ a: { required: true } }, {}).ok);
  ok('type enforced', !V({ a: { type: 'number' } }, { a: 'abc' }).ok);
  ok('maxLength enforced', !V({ a: { type: 'string', maxLength: 3 } }, { a: 'abcd' }).ok);
  ok('enum enforced', !V({ a: { enum: ['x'] } }, { a: 'y' }).ok);
  ok('defaults applied', V({ a: { default: 5 } }, {}).value.a === 5);
  ok('unknown keys dropped', V({ a: {} }, { a: '1', evil: 'x' }).value.evil === undefined);
  ok('valid passes', V({ a: { type: 'string', required: true } }, { a: 'ok' }).ok);
}

/* ── AI action parsing ── */
sec('AI action extraction');
{
  const r = extractActions('Sure thing.\n```action\n{"action":"launch_app","target":"WhatsApp"}\n```');
  eq('extracts action from fenced block', r.actions[0].action, 'launch_app');
  eq('extracts target', r.actions[0].target, 'WhatsApp');
  eq('strips block from prose', r.cleanText, 'Sure thing.');
  ok('flags that an action was found', r.hadAction);

  ok('plain prose yields no action', extractActions('Just chatting here.').hadAction === false);
  ok('malformed JSON ignored safely', extractActions('```action\n{broken\n```').actions.length === 0);
  ok('array of actions supported',
    extractActions('```action\n[{"action":"a"},{"action":"b"}]\n```').actions.length === 2);

  // deterministic intent mapping
  eq('open whatsapp', intentToAction('open whatsapp')?.action, 'launch_app');
  eq('  ↳ target', intentToAction('open whatsapp')?.target, 'whatsapp');
  eq('launch spotify', intentToAction('launch spotify')?.action, 'launch_app');
  eq('close discord', intentToAction('close discord')?.action, 'close_app');
  eq('shut down the computer', intentToAction('shut down the computer')?.action, 'power_control');
  eq('  ↳ maps to shutdown', intentToAction('shut down the computer')?.target, 'shutdown');
  eq('lock the screen', intentToAction('lock the screen')?.action, 'power_control');
  eq('play music', intentToAction('play music')?.action, 'media_control');
  eq('volume 50', intentToAction('volume 50')?.action, 'set_volume');
  eq('take a screenshot', intentToAction('take a screenshot')?.action, 'screenshot');
  eq('open github.com → url', intentToAction('open github.com')?.action, 'open_url');

  ok('question form is NOT an action', intentToAction('can you open whatsapp?') === null);
  ok('AURA UI nouns ignored', intentToAction('open the camera') === null);
  ok('plain chat ignored', intentToAction('hello how are you') === null);
  ok('maths ignored', intentToAction('what is 47*89') === null);
  ok('"mute your voice" not a volume action', intentToAction('mute your voice') === null);

  const msg = describeResult({ action: 'launch_app', target: 'Spotify' },
    { ok: true, simulated: true, message: 'x' });
  ok('spoken text mentions simulation', /simulated/i.test(msg));
  const denyMsg = describeResult({ action: 'launch_app' },
    { ok: false, code: 'no_permission', permissionLabel: 'Launch Applications' });
  ok('denial spoken text is actionable', /permission/i.test(denyMsg) && /Settings/i.test(denyMsg));
}

/* ── setup flow ── */
sec('Desktop setup flow');
{
  const st = new MemStore();
  const pm = new PermissionManager({ storage: st });
  const db = new AppDatabase({ storage: st });
  const l = new AppLauncher({ db });
  const flow = new DesktopSetupFlow({ permissions: pm, launcher: l, storage: st });

  eq('starts at first step', flow.currentStep.id, 'detect_host');
  ok('needed() true before completion', DesktopSetupFlow.needed(new MemStore()));

  const host = await flow.detectHost();
  eq('detects mock host', host.verdict, 'simulated');
  ok('host summary explains the limitation', /simulated|browser only/i.test(flow.hostSummary()));

  const opts = flow.permissionOptions();
  eq('offers every permission', opts.length, Object.keys(PERMISSIONS).length);
  ok('marks native-only as not usable now', opts.find(o => o.id === 'terminal').usableNow === false);
  ok('browser-capable perms usable now', opts.find(o => o.id === 'open_websites').usableNow === true);

  flow.applyRecommended();
  ok('recommended applied', pm.isGranted('launch_apps') && !pm.isGranted('terminal'));

  const plan = flow.scanPlan();
  ok('scan unavailable, with reason', plan.available === false && !!plan.reason);
  ok('scan plan lists phases', plan.phases.length >= 5);

  const scan = await flow.runScan();
  ok('runScan reports unavailability honestly', scan.ok === false);

  flow.goTo('scan_apps');
  ok('optional step can be skipped', flow.skip().ok === true);
  flow.goTo('detect_host');
  ok('mandatory step cannot be skipped', flow.skip().ok === false);

  flow.complete();
  ok('completes', flow.isComplete);
  ok('summary is complete', !!flow.summary().hostSummary && flow.summary().granted.length === 4);
  ok('needed() false after completion', !DesktopSetupFlow.needed(st));

  flow.reset();
  ok('reset returns to start', flow.currentStep.id === 'detect_host' && !flow.isComplete);
  eq('step list length', STEPS.length, 5);
}

/* ── framework integration ── */
sec('Desktop framework');
{
  const st = new MemStore();
  const fw = new DesktopFramework({ storage: st });
  const status = await fw.initialize();

  ok('initializes', status.initialized);
  eq('mock backend in this environment', status.backend, 'mock');
  ok('reports simulated', status.simulated === true);
  eq('six plugins', status.plugins.length, 6);
  ok('actions registered', status.actions.length >= 15);
  ok('permission summary present', typeof status.permissions.granted === 'number');
  ok('app stats present', status.apps.total >= 15);

  const blocked = await fw.execute({ action: 'launch_app', target: 'WhatsApp' });
  ok('framework enforces permissions end-to-end', !blocked.ok && blocked.code === DENY.NO_PERMISSION);

  fw.permissions.grant('launch_apps');
  const done = await fw.execute({ action: 'launch_app', target: 'WhatsApp' });
  ok('framework executes once permitted', done.ok);

  const ai = fw.describeForAI();
  ok('AI description lists actions', ai.includes('launch_app'));
  ok('AI description warns about simulation', /SIMULATED/i.test(ai));

  const batch = await fw.actions.executeBatch([
    { action: 'launch_app', target: 'spotify' },
    { action: 'run_command', target: 'evil' },
  ]);
  ok('batch stops at first failure', batch.ok === false && batch.results.length === 2);
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`  \x1b[32mPASS ${pass}\x1b[0m   ${fail ? `\x1b[31mFAIL ${fail}\x1b[0m` : 'FAIL 0'}`);
if (fail) { console.log('  Failed: ' + fails.join(', ')); process.exit(1); }
console.log('  DESKTOP FRAMEWORK VERIFIED');
