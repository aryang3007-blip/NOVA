/**
 * AURA :: Holographic Avatar (Three.js)
 * -------------------------------------
 * A procedurally generated holographic head — no external model files, so it
 * always loads. Real animation systems:
 *
 *  • BLINK    — stochastic timer, eyelid scale animation with easing
 *  • IDLE     — Perlin-ish layered sine breathing, head sway, pupil saccades
 *  • LIP-SYNC — consumes TTS viseme events, drives jaw/mouth morph in real time
 *  • EMOTION  — brow/eye/mouth pose targets, smoothly interpolated
 *  • REACT    — gesture-triggered animation impulses (nod, tilt, pulse)
 *
 * Everything is driven from a single update(dt) call in the render loop.
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';

let THREE = null;

const EMOTIONS = {
  neutral:   { brow: 0.0,  browTilt: 0.0,  eye: 1.0,  mouthCurve: 0.0,  mouthOpen: 0.0, hue: 0.0 },
  happy:     { brow: 0.14, browTilt: 0.0,  eye: 0.86, mouthCurve: 0.75, mouthOpen: 0.1, hue: 0.05 },
  excited:   { brow: 0.26, browTilt: 0.0,  eye: 1.14, mouthCurve: 0.85, mouthOpen: 0.25, hue: 0.09 },
  confident: { brow: 0.06, browTilt: 0.1,  eye: 0.94, mouthCurve: 0.35, mouthOpen: 0.0, hue: 0.02 },
  focused:   { brow: -0.16, browTilt: 0.0, eye: 0.8,  mouthCurve: -0.1, mouthOpen: 0.0, hue: -0.03 },
  confused:  { brow: 0.1,  browTilt: 0.34, eye: 1.05, mouthCurve: -0.2, mouthOpen: 0.08, hue: -0.05 },
  sad:       { brow: 0.2,  browTilt: -0.3, eye: 0.9,  mouthCurve: -0.6, mouthOpen: 0.0, hue: -0.08 },
  angry:     { brow: -0.3, browTilt: 0.4,  eye: 0.86, mouthCurve: -0.4, mouthOpen: 0.05, hue: -0.14 },
  surprised: { brow: 0.34, browTilt: 0.0,  eye: 1.3,  mouthCurve: 0.1,  mouthOpen: 0.55, hue: 0.06 },
  listening: { brow: 0.12, browTilt: 0.06, eye: 1.08, mouthCurve: 0.12, mouthOpen: 0.0, hue: 0.04 },
};

/** Mouth shape per viseme: [width, height, curve] */
const VISEME_SHAPE = {
  sil: [1.0, 0.06, 0],
  MBP: [0.94, 0.05, 0],
  FV:  [1.06, 0.2, 0.05],
  S:   [0.9,  0.24, 0.05],
  L:   [1.0,  0.35, 0],
  K:   [1.02, 0.42, 0],
  E:   [1.18, 0.5, 0.1],
  AI:  [1.1,  0.9, 0],
  O:   [0.74, 0.78, 0],
  U:   [0.62, 0.5, 0],
};

const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export class Avatar3D {
  constructor(container) {
    this.container = container;
    this.ok = false;
    this.enabled = true;
    this.time = 0;
    this.dtClamp = 0.05;

    // animation state
    this.blink = { closed: 0, next: 1.6, phase: 'open', t: 0 };
    this.emotion = 'neutral';
    this.emoCur = { ...EMOTIONS.neutral };
    this.emoTarget = { ...EMOTIONS.neutral };
    this.mouth = { w: 1, h: 0.06, curve: 0, targetW: 1, targetH: 0.06, targetCurve: 0 };
    this.visemeQueue = [];
    this.speaking = false;
    this.gaze = { x: 0, y: 0, tx: 0, ty: 0, next: 2 };
    this._mouseGaze = { x: 0, y: 0, active: false };
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', (e) => {
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const nx = (e.clientX - cx) / cx;
        const ny = (e.clientY - cy) / cy;
        this._mouseGaze.x = Math.max(-1, Math.min(1, nx));
        this._mouseGaze.y = Math.max(-1, Math.min(1, ny));
        this._mouseGaze.active = true;
      });
    }
    this.head = { rx: 0, ry: 0, rz: 0, trx: 0, try_: 0, trz: 0 };
    this.impulse = { nod: 0, tilt: 0, pulse: 0, shake: 0 };
    this.energy = 0.35;
    this._raf = null;
    this._fpsSamples = [];
    this._listeners = [];
  }

  async init() {
    try {
      THREE = await import('../../vendor/three.module.js');
    } catch (e) {
      console.warn('[avatar] local three failed, trying CDN', e);
      try {
        THREE = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js');
      } catch (e2) {
        console.error('[avatar] three.js unavailable', e2);
        return false;
      }
    }

    const w = this.container.clientWidth || 480;
    const h = this.container.clientHeight || 480;

    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (e) {
      console.error('[avatar] WebGL unavailable', e);
      return false;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0);
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;';

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 100);
    this.camera.position.set(0, 0.05, 8);
    this.frameRadius = 2.45;      // world-space sphere the camera must fit

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this._buildLights();
    this._buildHead();
    this._buildRings();
    this._buildParticles();

    this._frameCamera();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._wireEvents();

    this.ok = true;
    this.lastT = performance.now();
    this._loop();
    return true;
  }

  _buildLights() {
    this.scene.add(new THREE.AmbientLight(0x1a3a5c, 1.1));
    const key = new THREE.PointLight(0x22d3ee, 2.6, 24);
    key.position.set(2.4, 2.2, 3.4);
    this.scene.add(key);
    const rim = new THREE.PointLight(0xa855f7, 1.8, 24);
    rim.position.set(-2.8, -0.6, -2.2);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0x66e0ff, 0.7);
    fill.position.set(0, 1, 2);
    this.scene.add(fill);
    this.keyLight = key;
    this.rimLight = rim;
  }

  _buildHead() {
    const g = new THREE.Group();
    this.headGroup = g;

    // ── skull: faceted wireframe over a translucent shell
    // slightly narrower + deeper than a sphere so it reads as a head, not a ball
    const headGeo = new THREE.IcosahedronGeometry(1.16, 3);
    headGeo.scale(0.86, 1.14, 0.9);

    this.headMat = new THREE.MeshPhongMaterial({
      color: 0x0a2a44,
      emissive: 0x0d5f80,
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.4,
      shininess: 90,
      specular: 0x66e5ff,
      flatShading: true,
    });
    this.headMesh = new THREE.Mesh(headGeo, this.headMat);
    g.add(this.headMesh);

    this.wireMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, wireframe: true, transparent: true, opacity: 0.28 });
    this.wireMesh = new THREE.Mesh(headGeo.clone(), this.wireMat);
    this.wireMesh.scale.setScalar(1.012);
    g.add(this.wireMesh);

    // outer glow shell (backface) — cheap fresnel look
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x1ea8d0, transparent: true, opacity: 0.09, side: THREE.BackSide });
    const glow = new THREE.Mesh(headGeo.clone(), glowMat);
    glow.scale.setScalar(1.16);
    g.add(glow);
    this.glowMesh = glow;

    // ── eyes
    this.eyes = [];
    this.pupils = [];
    this.lids = [];
    for (const side of [-1, 1]) {
      const eyeGroup = new THREE.Group();
      eyeGroup.position.set(side * 0.42, 0.2, 0.88);
      // splay the eyes outward so they sit on the curve of the face
      eyeGroup.rotation.y = side * 0.22;

      // Round socket. A sphere here produced a boxy silhouette against the
      // faceted head; a flat disc reads cleanly at every angle.
      const socket = new THREE.Mesh(
        new THREE.CircleGeometry(0.2, 32),
        new THREE.MeshBasicMaterial({ color: 0x031825, transparent: true, opacity: 0.95 })
      );
      socket.position.z = 0.02;
      eyeGroup.add(socket);

      const iris = new THREE.Mesh(
        new THREE.CircleGeometry(0.15, 32),
        new THREE.MeshBasicMaterial({ color: 0x2ee6ff, transparent: true, opacity: 0.95 })
      );
      iris.position.z = 0.05;
      eyeGroup.add(iris);

      const pupil = new THREE.Mesh(
        new THREE.CircleGeometry(0.072, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      pupil.position.z = 0.08;
      eyeGroup.add(pupil);

      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.2, 0.245, 40),
        new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
      );
      halo.position.z = 0.03;
      eyeGroup.add(halo);

      // Eyelids: two half-discs that slide together from top and bottom.
      // (A scaled sphere never reads as "closed" — it just shrinks.)
      const lidPair = [];
      for (const dir of [1, -1]) {
        // dir=+1 → UPPER lid = top half-disc (theta 0..PI), slides upward.
        // dir=-1 → LOWER lid = bottom half-disc (theta PI..2PI), slides down.
        // Getting these backwards makes the lids cover the eye when open.
        const lid = new THREE.Mesh(
          new THREE.CircleGeometry(0.23, 32, dir > 0 ? 0 : Math.PI, Math.PI),
          new THREE.MeshBasicMaterial({ color: 0x0a2a44, transparent: true, opacity: 1 })
        );
        lid.position.z = 0.21;
        eyeGroup.add(lid);
        lidPair.push({ mesh: lid, dir });
      }

      g.add(eyeGroup);
      this.eyes.push({ group: eyeGroup, iris, halo, side });
      this.pupils.push(pupil);
      this.lids.push(lidPair);
    }

    // ── brows
    this.brows = [];
    for (const side of [-1, 1]) {
      // a shallow arc reads far better than a floating bar
      const brow = new THREE.Mesh(
        new THREE.TorusGeometry(0.2, 0.028, 8, 24, Math.PI * 0.72),
        new THREE.MeshBasicMaterial({ color: 0x5ceaff, transparent: true, opacity: 0.9 })
      );
      brow.position.set(side * 0.42, 0.52, 0.86);
      brow.rotation.y = side * 0.22;
      g.add(brow);
      this.brows.push({ mesh: brow, side, baseY: 0.52 });
    }

    // ── mouth: a lathe-free plane we scale/curve
    const mouthGroup = new THREE.Group();
    mouthGroup.position.set(0, -0.44, 0.94);
    this.mouthGroup = mouthGroup;

    // Mouth = a unit circle we scale on X/Y. A circle scales to a clean
    // ellipse (open) or a thin slit (closed) without the seam artefacts a
    // rotated capsule produced.
    this.mouthMesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 48),
      new THREE.MeshBasicMaterial({ color: 0x2ee6ff, transparent: true, opacity: 0.95 })
    );
    mouthGroup.add(this.mouthMesh);

    // dark cavity behind the lips, revealed as the jaw opens
    this.mouthInner = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 48),
      new THREE.MeshBasicMaterial({ color: 0x001622, transparent: true, opacity: 0 })
    );
    this.mouthInner.position.z = 0.008;
    mouthGroup.add(this.mouthInner);

    // upper/lower lip highlights that arc with emotion
    this.lips = [];
    for (const side of [1, -1]) {
      const lip = new THREE.Mesh(
        new THREE.TorusGeometry(0.3, 0.022, 6, 32, Math.PI),
        new THREE.MeshBasicMaterial({ color: 0x66f0ff, transparent: true, opacity: 0.8 })
      );
      lip.rotation.z = side > 0 ? 0 : Math.PI;
      lip.position.z = 0.02;
      mouthGroup.add(lip);
      this.lips.push({ mesh: lip, side });
    }
    g.add(mouthGroup);

    // ── scan line sweeping the face (width tracks the head silhouette so it
    //    never juts out past the skull)
    this.scanLine = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 0.03),
      new THREE.MeshBasicMaterial({ color: 0x7ef0ff, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    );
    this.scanLine.position.z = 1.1;
    // Head x-radius is ~1.0, but the scan plane sits at z=1.1 so perspective
    // magnifies it (~1.17x). Pre-shrink so it never overhangs the silhouette.
    this.scanHalfW = 0.86;
    this.scanHalfH = 1.32;  // head y-radius after the 1.14 scale
    g.add(this.scanLine);

    this.root.add(g);
  }

  _buildRings() {
    this.rings = [];
    const defs = [
      { r: 1.62, tube: 0.012, color: 0x22d3ee, op: 0.55, rx: Math.PI / 2.1, speed: 0.32 },
      { r: 1.88, tube: 0.008, color: 0xa855f7, op: 0.4, rx: Math.PI / 2.6, speed: -0.22 },
      { r: 2.12, tube: 0.006, color: 0x22d3ee, op: 0.26, rx: Math.PI / 1.8, speed: 0.16 },
    ];
    for (const d of defs) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(d.r, d.tube, 8, 128),
        new THREE.MeshBasicMaterial({ color: d.color, transparent: true, opacity: d.op })
      );
      ring.rotation.x = d.rx;
      this.root.add(ring);
      this.rings.push({ mesh: ring, speed: d.speed, baseOp: d.op });
    }

    // orbiting data nodes
    this.nodes = [];
    for (let i = 0; i < 14; i++) {
      const n = new THREE.Mesh(
        new THREE.SphereGeometry(0.028, 8, 8),
        new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? 0xa855f7 : 0x66f0ff, transparent: true, opacity: 0.8 })
      );
      const a = (i / 14) * Math.PI * 2;
      this.nodes.push({ mesh: n, angle: a, radius: 1.7 + (i % 3) * 0.22, speed: 0.24 + (i % 4) * 0.09, yAmp: 0.5 + (i % 5) * 0.2, phase: i });
      this.root.add(n);
    }
  }

  _buildParticles() {
    const COUNT = 420;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const r = 2.1 + Math.random() * 2.6;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.75;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      seeds[i] = Math.random();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.particleSeeds = seeds;
    this.particleBase = pos.slice();
    this.particles = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0x4fd9f5, size: 0.031, transparent: true, opacity: 0.62, sizeAttenuation: true,
    }));
    this.scene.add(this.particles);
  }

  /* ── event wiring ────────────────────────────────────────────────── */

  _wireEvents() {
    const add = (ev, fn) => this._listeners.push(bus.on(ev, fn));

    add(EV.TTS_START, () => { this.speaking = true; this.energy = 1; });
    add(EV.TTS_END, () => { this.speaking = false; this.visemeQueue.length = 0; this.setMouthTarget('sil'); });
    add(EV.TTS_INTERRUPT, () => { this.speaking = false; this.visemeQueue.length = 0; this.setMouthTarget('sil'); this.impulse.shake = 0.6; });
    add(EV.TTS_VISEME, ({ visemes }) => this.pushVisemes(visemes));

    add(EV.AVATAR_EMOTION, ({ emotion }) => this.setEmotion(emotion));
    add(EV.AI_STREAM_START, () => { this.energy = 0.9; this.setEmotion('focused', 900); });
    add(EV.AI_STREAM_END, () => { this.energy = 0.5; });

    add(EV.STT_START, () => { this.setEmotion('listening'); this.energy = 0.8; });
    add(EV.STT_END, () => { if (this.emotion === 'listening') this.setEmotion('neutral'); });

    add(EV.GESTURE, ({ gesture }) => this.reactToGesture(gesture));
    add(EV.FACES, () => { /* presence keeps gaze centered */ this.userPresent = true; });

    add(EV.AVATAR_REACT, ({ type }) => this.impulse[type] = 1);
  }

  /* ── public animation API ────────────────────────────────────────── */

  setEmotion(name, holdMs = 0) {
    const e = EMOTIONS[name] ? name : 'neutral';
    this.emotion = e;
    this.emoTarget = { ...EMOTIONS[e] };
    state.set({ avatarEmotion: e });
    if (holdMs > 0) {
      clearTimeout(this._emoTimer);
      this._emoTimer = setTimeout(() => {
        if (this.emotion === e) { this.emotion = 'neutral'; this.emoTarget = { ...EMOTIONS.neutral }; state.set({ avatarEmotion: 'neutral' }); }
      }, holdMs);
    }
  }

  reactToGesture(gesture) {
    switch (gesture) {
      case 'wave': this.impulse.nod = 1; this.setEmotion('happy', 3200); break;
      case 'thumbs_up': this.impulse.nod = 1; this.setEmotion('confident', 2600); break;
      case 'thumbs_down': this.impulse.shake = 1; this.setEmotion('sad', 2600); break;
      case 'peace': this.impulse.tilt = 1; this.setEmotion('excited', 2600); break;
      case 'open_palm': this.impulse.pulse = 1; this.setEmotion('listening', 3200); break;
      case 'pointing': this.impulse.tilt = 0.6; this.setEmotion('focused', 2200); break;
      case 'fist': this.impulse.pulse = 0.8; this.setEmotion('confident', 2000); break;
      case 'ok': this.impulse.nod = 0.8; this.setEmotion('happy', 2400); break;
      case 'rock': this.impulse.tilt = 1; this.setEmotion('excited', 2600); break;
      default: this.impulse.pulse = 0.4;
    }
  }

  pushVisemes(visemes) {
    if (!visemes?.length) return;
    const now = performance.now();
    for (const v of visemes) {
      this.visemeQueue.push({ at: now + v.t, viseme: v.viseme, open: v.open });
    }
    // keep the queue bounded
    if (this.visemeQueue.length > 90) this.visemeQueue.splice(0, this.visemeQueue.length - 90);
  }

  setMouthTarget(viseme, openScale = 1) {
    const s = VISEME_SHAPE[viseme] || VISEME_SHAPE.sil;
    this.mouth.targetW = s[0];
    this.mouth.targetH = Math.max(0.05, s[1] * openScale);
    this.mouth.targetCurve = s[2];
  }

  /* ── frame update ────────────────────────────────────────────────── */

  update(dt) {
    this.time += dt;
    const t = this.time;

    // ── emotion interpolation
    for (const k of Object.keys(this.emoTarget)) {
      this.emoCur[k] = damp(this.emoCur[k], this.emoTarget[k], 6, dt);
    }

    // ── blink FSM
    const bl = this.blink;
    bl.t += dt;
    if (bl.phase === 'open' && bl.t >= bl.next) {
      bl.phase = 'closing'; bl.t = 0;
    } else if (bl.phase === 'closing') {
      bl.closed = Math.min(1, bl.closed + dt * 16);
      if (bl.closed >= 1) { bl.phase = 'opening'; }
    } else if (bl.phase === 'opening') {
      bl.closed = Math.max(0, bl.closed - dt * 9);
      if (bl.closed <= 0) {
        bl.phase = 'open'; bl.t = 0;
        // natural blink interval 2–7s, occasional double blink
        bl.next = Math.random() < 0.13 ? 0.22 : 2 + Math.random() * 5;
      }
    }

    // ── lip-sync from the viseme queue
    const now = performance.now();
    let applied = null;
    while (this.visemeQueue.length && this.visemeQueue[0].at <= now) {
      applied = this.visemeQueue.shift();
    }
    if (applied) this.setMouthTarget(applied.viseme, 1);
    if (!this.speaking && !this.visemeQueue.length) {
      const e = this.emoCur;
      this.mouth.targetH = Math.max(0.05, e.mouthOpen * 0.6 + 0.06);
      this.mouth.targetW = 1 + e.mouthCurve * 0.12;
      this.mouth.targetCurve = e.mouthCurve;
    }
    const lipLambda = this.speaking ? 22 : 8;
    this.mouth.w = damp(this.mouth.w, this.mouth.targetW, lipLambda, dt);
    this.mouth.h = damp(this.mouth.h, this.mouth.targetH, lipLambda, dt);
    this.mouth.curve = damp(this.mouth.curve, this.mouth.targetCurve, 8, dt);

    // ── gaze tracking: follow mouse pointer or natural saccades
    if (this._mouseGaze?.active) {
      this.gaze.tx = this._mouseGaze.x * 0.45;
      this.gaze.ty = this._mouseGaze.y * 0.35;
    } else {
      this.gaze.next -= dt;
      if (this.gaze.next <= 0) {
        this.gaze.tx = (Math.random() - 0.5) * 0.09;
        this.gaze.ty = (Math.random() - 0.5) * 0.055;
        this.gaze.next = 0.8 + Math.random() * 2.6;
      }
    }
    this.gaze.x = damp(this.gaze.x, this.gaze.tx, 14, dt);
    this.gaze.y = damp(this.gaze.y, this.gaze.ty, 14, dt);

    // ── impulses decay
    for (const k of Object.keys(this.impulse)) {
      this.impulse[k] = Math.max(0, this.impulse[k] - dt * 1.7);
    }
    this.energy = damp(this.energy, this.speaking ? 1 : 0.35, 2.2, dt);

    this._applyToMeshes(dt, t);
  }

  _applyToMeshes(dt, t) {
    const e = this.emoCur;
    const g = this.headGroup;

    // ── idle: layered breathing + sway
    const breathe = Math.sin(t * 1.15) * 0.016 + Math.sin(t * 2.7) * 0.005;
    const swayY = Math.sin(t * 0.42) * 0.075 + Math.sin(t * 0.93) * 0.028;
    const swayX = Math.cos(t * 0.35) * 0.045 + Math.sin(t * 1.31) * 0.016;

    const nod = Math.sin(this.impulse.nod * Math.PI * 2.6) * 0.34 * this.impulse.nod;
    const tilt = this.impulse.tilt * Math.sin(this.impulse.tilt * Math.PI * 2) * 0.4;
    const shake = Math.sin(this.impulse.shake * Math.PI * 6) * 0.22 * this.impulse.shake;

    g.rotation.x = swayX + nod + this.gaze.y * 0.5;
    g.rotation.y = swayY + shake + this.gaze.x * 1.4;
    g.rotation.z = tilt * 0.6 + Math.sin(t * 0.6) * 0.012;
    g.position.y = breathe;
    const pulseScale = 1 + this.impulse.pulse * 0.055 + (this.speaking ? Math.sin(t * 15) * 0.006 : 0);
    g.scale.setScalar(pulseScale);

    // ── eyes: blink + emotion openness
    const openness = Math.max(0.02, Math.min(1.35, (1 - this.blink.closed) * e.eye));
    for (let i = 0; i < this.lids.length; i++) {
      // Lids slide apart as the eye opens and fade out completely at rest —
      // otherwise the parked half-discs read as dark patches above/below the
      // eye (they are darker than the emissive head shell).
      const shut = 1 - Math.min(1, openness);
      for (const { mesh, dir } of this.lids[i]) {
        mesh.position.y = dir * 0.23 * Math.min(1, openness);
        mesh.material.opacity = Math.min(1, shut * 2.2);
        mesh.visible = shut > 0.02;
      }
      const eye = this.eyes[i];
      eye.iris.scale.setScalar(lerp(0.6, 1.06, Math.min(1, openness)));
      eye.halo.material.opacity = 0.2 + this.energy * 0.4;
      eye.halo.scale.setScalar(1 + Math.sin(t * 2.4 + i) * 0.05 + this.impulse.pulse * 0.25);
      this.pupils[i].position.x = this.gaze.x * 1.5;
      this.pupils[i].position.y = this.gaze.y * 1.5;
      this.pupils[i].scale.setScalar(lerp(0.7, 1.25, this.energy));
    }

    // ── brows: raise/lower + inner-edge tilt for expression
    for (let i = 0; i < this.brows.length; i++) {
      const b = this.brows[i];
      b.mesh.position.y = b.baseY + e.brow * 0.3 + Math.sin(t * 0.9 + i) * 0.006;
      b.mesh.rotation.z = Math.PI * 0.14 + e.browTilt * 0.55 * b.side;
    }

    // ── mouth: width from viseme, height from jaw opening
    const mW = 0.62 * this.mouth.w;
    const mH = Math.max(0.055, this.mouth.h * 0.62);
    this.mouthMesh.scale.set(mW, mH, 1);
    this.mouthInner.scale.set(mW * 0.88, mH * 0.82, 1);
    this.mouthInner.material.opacity = Math.min(0.95, this.mouth.h * 1.6);
    this.mouthGroup.position.y = -0.44 - this.mouth.h * 0.05;
    // smile/frown: arc the whole mouth group
    this.mouthGroup.rotation.z = 0;
    this.mouthGroup.rotation.x = -this.mouth.curve * 0.22;
    // lips hug the mouth shape and bow with emotion
    for (const l of this.lips) {
      l.mesh.scale.set(mW * 2.05, (mH * 2.05) + Math.abs(this.mouth.curve) * 0.12, 1);
      l.mesh.position.y = l.side * mH * 0.06 + this.mouth.curve * 0.055 * l.side;
      l.mesh.material.opacity = 0.45 + this.energy * 0.4;
    }

    // ── scan line sweep: chord width follows the head's elliptical outline
    const scanY = ((t * 0.42) % (this.scanHalfH * 2)) - this.scanHalfH;
    this.scanLine.position.y = scanY;
    const kk = 1 - Math.pow(scanY / this.scanHalfH, 2);
    const chord = kk > 0 ? Math.sqrt(kk) * this.scanHalfW * 2 : 0;
    this.scanLine.scale.x = Math.max(0.001, chord);
    this.scanLine.material.opacity = (0.1 + this.energy * 0.26) * (chord > 0.05 ? 1 : 0);

    // ── head material reacts to energy + emotion hue
    const emissive = 0.42 + this.energy * 0.5 + this.impulse.pulse * 0.3;
    this.headMat.emissiveIntensity = emissive;
    this.wireMat.opacity = 0.2 + this.energy * 0.22;
    this.glowMesh.material.opacity = 0.06 + this.energy * 0.1;

    if (this.hueShift === undefined) this.hueShift = 0;
    this.hueShift = damp(this.hueShift, e.hue, 4, dt);
    const baseHue = 0.52 + this.hueShift;
    this.headMat.emissive.setHSL(clamp01(baseHue), 0.85, 0.28);
    this.wireMat.color.setHSL(clamp01(baseHue), 0.9, 0.55);
    for (const eye of this.eyes) eye.iris.material.color.setHSL(clamp01(baseHue), 0.95, 0.6);
    this.mouthMesh.material.color.setHSL(clamp01(baseHue), 0.9, 0.58);

    // ── rings
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      r.mesh.rotation.z += r.speed * dt;
      r.mesh.rotation.y = Math.sin(t * 0.28 + i) * 0.28;
      r.mesh.material.opacity = r.baseOp * (0.6 + this.energy * 0.7);
      r.mesh.scale.setScalar(1 + this.impulse.pulse * 0.09 + Math.sin(t * 1.4 + i) * 0.012);
    }

    // ── orbiting nodes
    for (const n of this.nodes) {
      n.angle += n.speed * dt * (0.6 + this.energy * 0.9);
      n.mesh.position.set(
        Math.cos(n.angle) * n.radius,
        Math.sin(t * 0.7 + n.phase) * n.yAmp * 0.5,
        Math.sin(n.angle) * n.radius
      );
      n.mesh.material.opacity = 0.35 + Math.abs(Math.sin(t * 2 + n.phase)) * 0.5;
    }

    // ── particles drift
    if (this.particles) {
      const pos = this.particles.geometry.attributes.position;
      const arr = pos.array;
      for (let i = 0; i < this.particleSeeds.length; i++) {
        const s = this.particleSeeds[i];
        arr[i * 3 + 1] = this.particleBase[i * 3 + 1] + Math.sin(t * (0.3 + s * 0.5) + s * 9) * 0.16;
      }
      pos.needsUpdate = true;
      this.particles.rotation.y += dt * 0.035;
      this.particles.material.opacity = 0.4 + this.energy * 0.3;
    }

    // ── lights pulse with speech
    this.keyLight.intensity = 2.2 + this.energy * 1.4 + (this.speaking ? Math.sin(this.time * 18) * 0.35 : 0);
    this.rimLight.intensity = 1.4 + this.energy * 0.9;
  }

  _loop() {
    const step = () => {
      this._raf = requestAnimationFrame(step);
      const now = performance.now();
      let dt = (now - this.lastT) / 1000;
      this.lastT = now;
      if (dt > this.dtClamp) dt = this.dtClamp;

      this._fpsSamples.push(now);
      while (this._fpsSamples.length && now - this._fpsSamples[0] > 1000) this._fpsSamples.shift();
      state.set({ fps: this._fpsSamples.length });

      if (this.enabled && this.ok) {
        this.update(dt);
        this.renderer.render(this.scene, this.camera);
      }
    };
    this._raf = requestAnimationFrame(step);
  }

  /**
   * Pull the camera back far enough that the whole hologram (head + orbit
   * rings) fits, accounting for BOTH vertical and horizontal FOV. Without the
   * horizontal term the rings get cropped on narrow/portrait viewports.
   */
  _frameCamera() {
    if (!this.camera) return;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.1, this.camera.aspect);
    const distV = this.frameRadius / Math.sin(vFov / 2);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const distH = this.frameRadius / Math.sin(hFov / 2);
    this.camera.position.z = Math.max(distV, distH) * 1.02;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    if (!this.ok) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this._frameCamera();
    this.renderer.setSize(w, h);
  }

  setQuality(level) {
    if (!this.ok) return;
    const dpr = level === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    if (this.particles) this.particles.visible = level !== 'low';
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    for (const off of this._listeners) off();
    window.removeEventListener('resize', this._onResize);
    try { this.renderer?.dispose(); } catch {}
    if (this.renderer?.domElement?.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    this.ok = false;
  }
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

export default Avatar3D;
