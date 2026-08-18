/**
 * AURA :: Phone Companion
 * -----------------------
 * Runs on the phone. Pairs with the laptop, holds a long-poll open, and
 * executes only the actions it declared it can do.
 *
 * WHAT THIS DELIBERATELY IS NOT
 * -----------------------------
 * It is not a remote control for the laptop. There is no route from here that
 * runs anything on Windows — the gateway exposes pair / heartbeat / poll / ack
 * to a device token and nothing else. The phone RECEIVES work; it never
 * dispatches it.
 *
 * CAMERA HONESTY
 * --------------
 * Over LAN HTTP the browser is in an insecure context and `getUserMedia` does
 * not exist. This reports exactly which of the four causes applies —
 * insecure context, missing API, permission denied, or no device — instead of
 * the generic "no camera API" the user saw. It never claims camera support it
 * cannot deliver.
 *
 * @module phone
 */

const $ = (id) => /** @type {any} */ (document.getElementById(id));
const LS = 'aura.device.v1';

const CAPS = ['open_url', 'show_notification', 'vibrate',
              'request_camera', 'request_microphone', 'device_status'];

/**
 * PLATFORM PROFILES.
 *
 * This page is opened just as often in a second window on the same laptop as
 * it is on a phone — the user did exactly that during testing. Assuming
 * "phone" was wrong: a Windows desktop has no vibration motor and no battery
 * worth reporting, and calling it "Phone" in the Devices list is a lie.
 *
 * `possible` is what the PLATFORM could ever do. It is intersected with what
 * this browser actually exposes, so a profile can never over-claim — the
 * feature test always wins. `never` documents why something is greyed out.
 */
const PLATFORMS = {
  android: {
    label: 'Android', icon: '🤖', kind: 'phone', defaultName: 'Android Phone',
    possible: ['open_url', 'show_notification', 'vibrate',
               'request_camera', 'request_microphone', 'device_status'],
    never: {},
    note: 'Full companion: notifications, vibration, camera and microphone.',
  },
  ios: {
    label: 'iPhone / iPad', icon: '📱', kind: 'phone', defaultName: 'iPhone',
    possible: ['open_url', 'show_notification',
               'request_camera', 'request_microphone', 'device_status'],
    never: { vibrate: 'iOS Safari does not implement the Vibration API.' },
    note: 'Safari has no Vibration API, so vibrate is unavailable on iOS.',
  },
  windows: {
    label: 'Windows', icon: '🪟', kind: 'desktop', defaultName: 'Windows PC',
    possible: ['open_url', 'show_notification',
               'request_camera', 'request_microphone', 'device_status'],
    never: { vibrate: 'Desktops have no vibration motor.' },
    note: 'Paired as a second screen: open links and show notifications on it.',
  },
  macos: {
    label: 'macOS', icon: '🍎', kind: 'desktop', defaultName: 'Mac',
    possible: ['open_url', 'show_notification',
               'request_camera', 'request_microphone', 'device_status'],
    never: { vibrate: 'Desktops have no vibration motor.' },
    note: 'Paired as a second screen: open links and show notifications on it.',
  },
  linux: {
    label: 'Linux', icon: '🐧', kind: 'desktop', defaultName: 'Linux Box',
    possible: ['open_url', 'show_notification',
               'request_camera', 'request_microphone', 'device_status'],
    never: { vibrate: 'Desktops have no vibration motor.' },
    note: 'Paired as a second screen. Notifications depend on your desktop notification daemon.',
  },
};

const app = { id: null, token: null, name: null, polling: false,
              acts: 0, backoff: 1000, alive: false,
              platform: null, platformGuessed: false };

boot();

async function boot() {
  wire();
  // Pre-select a best guess so the page is usable immediately, but mark it as
  // a guess (dashed tile) so it is obvious it can be changed.
  const saved0 = load();
  if (saved0?.platform) setPlatform(saved0.platform, { why: 'Remembered from last time.' });
  else { const g = detectPlatform(); setPlatform(g.id, { guessed: true, why: g.why }); }
  detectCapabilities();
  // A scanned QR carries ?code=123456, so the digits are already filled in and
  // the user only has to confirm. Typing six digits on a phone keyboard was
  // the slowest part of pairing.
  prefillFromUrl();
  await checkMedia();
  const saved = load();
  if (saved?.id && saved?.token) {
    app.id = saved.id; app.token = saved.token; app.name = saved.name;
    showConnected();
    startLoops();
  }
  $('name').value = load()?.name || defaultName();
}

/**
 * Read a pairing code out of the URL a QR scan opened.
 *
 * Only digits are accepted and only six of them — the query string is
 * attacker-supplied in principle, and it is written into the DOM. It is never
 * auto-submitted: the user still presses PAIR, so a malicious link cannot
 * silently pair a device behind their back.
 */
function prefillFromUrl() {
  let code = '';
  try {
    code = new URLSearchParams(location.search).get('code') || '';
  } catch { return false; }
  const digits = String(code).replace(/\D/g, '').slice(0, 6);
  if (digits.length !== 6) return false;
  const el = $('code');
  if (!el) return false;
  el.value = digits;
  log(`Code ${digits} filled in from the QR link — press PAIR to confirm.`, 'ok');
  // Clean the URL so a refresh does not re-fill a code that has been used.
  try { history.replaceState(null, '', location.pathname); } catch {}
  return true;
}

/* ── platform detection ─────────────────────────────────────────────── */

/**
 * Guess the platform from the user agent.
 *
 * Deliberately a GUESS, shown as one: the selected tile is dashed until the
 * user confirms it. UA sniffing is unreliable by nature — iPadOS reports
 * itself as a Mac, and Windows-on-ARM and Chrome OS both muddy the water — so
 * the answer is always overridable with one tap.
 *
 * @returns {{id:string, why:string}}
 */
function detectPlatform() {
  const ua = navigator.userAgent;
  const uaData = /** @type {any} */ (navigator).userAgentData;
  const touch = (navigator.maxTouchPoints || 0) > 1;

  // navigator.userAgentData is the modern, non-spoofed source where available.
  const hinted = uaData?.platform ? String(uaData.platform).toLowerCase() : '';
  if (uaData?.mobile && /android/i.test(ua)) {
    return { id: 'android', why: 'Reported by the browser as Android, mobile.' };
  }
  if (/android/i.test(ua)) return { id: 'android', why: 'User agent contains "Android".' };
  if (/iphone|ipod/i.test(ua)) return { id: 'ios', why: 'User agent contains "iPhone".' };
  if (/ipad/i.test(ua)) return { id: 'ios', why: 'User agent contains "iPad".' };
  // iPadOS 13+ masquerades as desktop Safari; touch points give it away.
  if (/macintosh/i.test(ua) && touch) {
    return { id: 'ios', why: 'Reports as a Mac but has a touchscreen — that is an iPad.' };
  }
  if (hinted.includes('windows') || /windows nt/i.test(ua)) {
    return { id: 'windows', why: 'User agent reports Windows.' };
  }
  if (hinted.includes('macos') || /macintosh|mac os x/i.test(ua)) {
    return { id: 'macos', why: 'User agent reports macOS.' };
  }
  if (/cros/i.test(ua)) return { id: 'linux', why: 'Chrome OS — treated as Linux.' };
  if (hinted.includes('linux') || /linux|x11/i.test(ua)) {
    return { id: 'linux', why: 'User agent reports Linux.' };
  }
  return { id: 'windows', why: 'Could not tell from the user agent — please pick one.' };
}

/**
 * Apply a platform choice: capabilities, default name and explanatory copy.
 * @param {string} id
 * @param {{guessed?:boolean, why?:string, keepName?:boolean}} [opts]
 */
function setPlatform(id, { guessed = false, why = '', keepName = false } = {}) {
  if (!PLATFORMS[id]) id = 'windows';
  app.platform = id;
  app.platformGuessed = guessed;
  const p = PLATFORMS[id];

  document.querySelectorAll('.dtype').forEach((el) => {
    const on = el.getAttribute('data-dtype') === id;
    el.classList.toggle('on', on);
    el.classList.toggle('guess', on && guessed);
    el.setAttribute('aria-checked', String(on));
  });

  const nameEl = $('name');
  if (nameEl && !keepName && !nameEl.dataset.touched) nameEl.value = p.defaultName;

  const why2 = $('dtype-why');
  if (why2) why2.textContent = why ? `${why} ${p.note}` : p.note;

  const sub = $('sub');
  if (sub) {
    sub.textContent = p.kind === 'phone'
      ? 'Pair this phone with your laptop'
      : `Pair this ${p.label} machine with AURA as a second device`;
  }

  detectCapabilities();
}

function defaultName() {
  return PLATFORMS[app.platform]?.defaultName || 'Device';
}

function load() { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } }
function save() {
  localStorage.setItem(LS, JSON.stringify({ id: app.id, token: app.token,
                                            name: app.name, platform: app.platform }));
}

function log(msg, cls = '') {
  const el = $('log');
  if (!el) return;
  const d = document.createElement('div');
  if (cls) d.className = cls;
  const t = new Date().toTimeString().slice(0, 8);
  d.textContent = `${t}  ${msg}`;
  el.prepend(d);
  while (el.children.length > 60) el.lastChild.remove();
}

/* ── capabilities ───────────────────────────────────────────────────── */

/**
 * Only claim what this browser can actually do, ON this platform.
 *
 * Two filters, and the order matters. The platform profile says what the
 * device class could ever support; the feature test says what this browser
 * exposes right now. A capability must pass BOTH — so selecting "Android" on
 * a desktop cannot conjure a vibration motor, and the profile can never
 * over-claim past a failed feature test.
 */
function detectCapabilities() {
  const profile = PLATFORMS[app.platform] || PLATFORMS.windows;
  const browser = ['open_url', 'device_status'];
  if ('Notification' in window) browser.push('show_notification');
  if ('vibrate' in navigator) browser.push('vibrate');
  if (navigator.mediaDevices?.getUserMedia) {
    browser.push('request_camera', 'request_microphone');
  }
  app.browserCaps = browser;
  app.caps = browser.filter(c => profile.possible.includes(c));
  renderCaps();
}

function renderCaps() {
  const el = $('caps');
  if (!el) return;
  const profile = PLATFORMS[app.platform] || PLATFORMS.windows;
  el.innerHTML = CAPS.map((c) => {
    const on = app.caps.includes(c);
    // Say WHY something is off: blocked by the platform, or missing from this
    // browser. A greyed-out chip with no reason is just confusing.
    const reason = on ? ''
      : profile.never?.[c] ? profile.never[c]
      : !profile.possible.includes(c) ? `Not available on ${profile.label}.`
      : 'This browser does not expose it.';
    return `<span class="cap${on ? ' on' : ' na'}"${reason ? ` title="${reason}"` : ''}>${c}</span>`;
  }).join('');
}

/**
 * Why can/can't this browser use the camera? Four distinct causes, reported
 * distinctly — this is the message the user complained about.
 */
async function checkMedia() {
  const secure = window.isSecureContext;
  const api = !!navigator.mediaDevices?.getUserMedia;
  $('cam-sec').textContent = secure ? 'yes' : 'NO';
  $('cam-sec').className = secure ? 'ok' : 'bad';
  $('cam-api').textContent = api ? 'available' : 'missing';
  $('cam-api').className = api ? 'ok' : 'bad';
  $('cam-card').classList.remove('hide');

  if (secure && api) {
    $('cam-why').textContent = 'This browser can use this device\'s camera. '
      + 'Tap below to grant permission and confirm.';
    return;
  }
  if (!secure) {
    $('cam-why').innerHTML = 'Blocked because this page is served over <b>plain HTTP '
      + 'on the LAN</b>, which browsers treat as an insecure context. '
      + 'Camera and microphone are unavailable — this is the browser, not AURA.';
    $('cam-note').classList.remove('hide');
    $('cam-note').innerHTML = '<b>How to fix, honestly:</b><br>'
      + '1. Serve AURA over HTTPS with a self-signed certificate, or<br>'
      + '2. Use a tunnel that terminates TLS, or<br>'
      + '3. In Chrome open <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, '
      + `add <code>${location.origin}</code>, and relaunch.<br><br>`
      + 'AURA cannot work around this from JavaScript, and will not pretend to.';
    $('btn-cam').disabled = true;
    return;
  }
  $('cam-why').textContent = 'This browser does not expose getUserMedia at all.';
  $('btn-cam').disabled = true;
}

/* ── pairing ────────────────────────────────────────────────────────── */

function wire() {
  $('btn-pair').addEventListener('click', doPair);

  // Device type: pick one, or re-run detection.
  document.querySelectorAll('.dtype').forEach((el) => {
    el.addEventListener('click', () => {
      setPlatform(el.getAttribute('data-dtype'),
                  { guessed: false, why: 'You chose this.' });
      log(`Device type set to ${PLATFORMS[app.platform].label}.`);
    });
  });
  $('btn-detect')?.addEventListener('click', () => {
    const g = detectPlatform();
    setPlatform(g.id, { guessed: true, why: g.why });
    log(`Auto-detected: ${PLATFORMS[g.id].label}. ${g.why}`);
  });
  // Once the user types a name, stop overwriting it when the type changes.
  $('name')?.addEventListener('input', (e) => {
    if (e.target.value.trim()) e.target.dataset.touched = '1';
    else delete e.target.dataset.touched;
  });

  $('code').addEventListener('input', (e) => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 6);
    e.target.value = v;
    if (v.length === 6) doPair();
  });
  $('btn-unpair').addEventListener('click', () => {
    localStorage.removeItem(LS);
    app.id = null; app.token = null; app.polling = false;
    $('conn-card').classList.add('hide');
    $('pair-card').classList.remove('hide');
    log('Pairing forgotten.');
  });
  $('btn-cam').addEventListener('click', testCamera);
}

async function doPair() {
  const code = $('code').value.trim();
  const name = $('name').value.trim() || defaultName();
  if (code.length !== 6) return showPairError('Enter the 6-digit code from the laptop.');
  $('btn-pair').disabled = true;
  try {
    const r = await post('/api/device/pair', {
      code, name,
      platform: app.platform || 'windows',
      kind: PLATFORMS[app.platform]?.kind || 'device',
      capabilities: app.caps,
    });
    if (!r.ok) return showPairError(r.message || 'Pairing failed.');
    app.id = r.deviceId; app.token = r.token; app.name = name;
    save();
    showConnected();
    startLoops();
    log(`Paired as ${app.id}`, 'ok');
    if ('vibrate' in navigator) navigator.vibrate(60);
  } catch (e) {
    showPairError(`Could not reach AURA: ${e.message}`);
  } finally {
    $('btn-pair').disabled = false;
  }
}

function showPairError(msg) {
  const el = $('pair-err');
  el.classList.remove('hide');
  el.textContent = msg;
}

function showConnected() {
  $('pair-card').classList.add('hide');
  $('conn-card').classList.remove('hide');
  $('log-card').classList.remove('hide');
  $('d-id').textContent = app.id;
  $('d-name').textContent = app.name || '—';
  $('sub').textContent = 'Paired — keep this page open';
  renderCaps();
}

/* ── transport ──────────────────────────────────────────────────────── */

function startLoops() {
  if (app.polling) return;
  app.polling = true;
  pollLoop();
  heartbeatLoop();
}

/**
 * Long-poll. Every failure just backs off and retries, which is why a Wi-Fi
 * blip recovers on its own with no reconnect logic to get wrong.
 */
async function pollLoop() {
  while (app.polling && app.token) {
    try {
      const r = await post('/api/device/poll',
                           { deviceId: app.id, token: app.token, wait: 20 }, 30000);
      if (!r.ok) {
        if (r.message === 'Not paired.') { forceUnpair(); return; }
        throw new Error(r.message || 'poll failed');
      }
      setAlive(true);
      app.backoff = 1000;
      for (const a of (r.actions || [])) await execute(a);
    } catch (e) {
      setAlive(false);
      log(`Reconnecting… (${e.message})`, 'warn');
      await sleep(app.backoff);
      app.backoff = Math.min(app.backoff * 2, 15000);
    }
  }
}

async function heartbeatLoop() {
  while (app.polling && app.token) {
    const t0 = performance.now();
    try {
      const info = { capabilities: app.caps };
      const b = await battery();
      if (b !== null) info.battery = b;
      info.latencyMs = null;
      const r = await post('/api/device/heartbeat',
                           { deviceId: app.id, token: app.token, info }, 8000);
      if (r.ok) {
        const ms = Math.round(performance.now() - t0);
        $('d-lat').textContent = `${ms} ms`;
        $('d-bat').textContent = b === null ? 'unavailable' : `${b}%`;
        setAlive(true);
      }
    } catch { setAlive(false); }
    await sleep(7000);
  }
}

function setAlive(on) {
  if (app.alive === on) return;
  app.alive = on;
  $('dot').classList.toggle('on', on);
  $('conn-state').textContent = on ? 'Connected' : 'Reconnecting…';
  $('conn-state').className = on ? 'ok' : 'warn';
}

function forceUnpair() {
  localStorage.removeItem(LS);
  app.polling = false; app.token = null;
  $('conn-card').classList.add('hide');
  $('pair-card').classList.remove('hide');
  showPairError('The laptop no longer recognises this device. Pair again.');
}

/* ── executing actions ──────────────────────────────────────────────── */

async function execute(a) {
  let ok = true, detail = '';
  try {
    switch (a.action) {
      case 'open_url': {
        const url = String(a.params?.url || '');
        if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs are allowed');
        log(`Opening ${url}`, 'ok');
        // Popup blockers stop window.open outside a gesture, so use a link
        // click, which mobile browsers honour far more reliably.
        const link = document.createElement('a');
        link.href = url; link.target = '_blank'; link.rel = 'noopener';
        document.body.appendChild(link); link.click(); link.remove();
        detail = url;
        break;
      }
      case 'show_notification': {
        const title = String(a.params?.title || 'AURA');
        const body = String(a.params?.body || '');
        if (!('Notification' in window)) throw new Error('notifications unsupported');
        let perm = Notification.permission;
        if (perm === 'default') perm = await Notification.requestPermission();
        if (perm !== 'granted') throw new Error('notification permission denied');
        new Notification(title, { body });
        log(`Notified: ${title}`);
        break;
      }
      case 'vibrate': {
        if (!('vibrate' in navigator)) throw new Error('no vibration motor');
        navigator.vibrate(Number(a.params?.ms) || 220);
        log('Vibrated');
        break;
      }
      case 'request_camera':
      case 'request_microphone': {
        const wantVideo = a.action === 'request_camera';
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(window.isSecureContext
            ? 'getUserMedia unsupported'
            : 'insecure context (plain HTTP over LAN) — browsers block camera/mic');
        }
        const st = await navigator.mediaDevices.getUserMedia(
          wantVideo ? { video: true } : { audio: true });
        st.getTracks().forEach(t => t.stop());
        log(`${wantVideo ? 'Camera' : 'Microphone'} granted`, 'ok');
        break;
      }
      case 'device_status':
        detail = JSON.stringify({ caps: app.caps, secure: window.isSecureContext });
        break;
      default:
        throw new Error(`unsupported action "${a.action}"`);
    }
  } catch (e) {
    ok = false; detail = e.message;
    log(`Failed ${a.action}: ${e.message}`, 'bad');
  }
  app.acts++;
  $('d-acts').textContent = String(app.acts);
  try {
    await post('/api/device/ack',
               { deviceId: app.id, token: app.token, actionId: a.id, success: ok, detail });
  } catch {}
}

async function testCamera() {
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    st.getTracks().forEach(t => t.stop());
    $('cam-why').textContent = '✅ This phone\'s camera works and permission is granted.';
    $('cam-why').className = 'ok';
    log('Camera test passed', 'ok');
  } catch (e) {
    // Distinguish the causes rather than lumping them together.
    const why = e.name === 'NotAllowedError' ? 'you (or the browser) denied permission'
      : e.name === 'NotFoundError' ? 'no camera was found on this device'
      : e.name === 'NotReadableError' ? 'the camera is in use by another app'
      : e.message;
    $('cam-why').textContent = `❌ Camera unavailable — ${why}.`;
    $('cam-why').className = 'bad';
    log(`Camera test failed: ${e.name}`, 'bad');
  }
}

/* ── helpers ────────────────────────────────────────────────────────── */

async function post(url, body, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await r.json();
  } finally { clearTimeout(t); }
}

async function battery() {
  try {
    if (!navigator.getBattery) return null;
    const b = await navigator.getBattery();
    return Math.round(b.level * 100);
  } catch { return null; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
