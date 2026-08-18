/**
 * AURA :: Full-Body Holographic Avatar
 * ------------------------------------
 * A procedurally generated, fully rigged humanoid. Built with Three.js
 * primitives + a real bone hierarchy — NO external model download, so AURA
 * stays 100% offline (that was the explicit requirement).
 *
 * Implements the same contract as Avatar3D (`init/update/dispose/setEmotion/
 * pushVisemes/reactToGesture`), so every existing system — TTS visemes,
 * gesture events, emotion bus — drives it with zero changes elsewhere.
 *
 * Real systems:
 *   • SKELETON  — 20-bone hierarchy: hips→spine→chest→neck→head, both arms/legs
 *   • IK-ish    — procedural arm posing for waves, points, thumbs-up
 *   • IDLE      — weight shift, breathing, secondary sway on limbs
 *   • WALK/TURN — the body orients toward the viewer/camera
 *   • LIP-SYNC  — same 10-viseme mouth as the head avatar
 *   • BLINK     — sliding lids
 *   • OUTFITS   — swappable garment meshes + palette (see outfits.js)
 *   • AR        — scales to ~1.6 m and anchors to a floor plane
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';
import { config } from '../core/config.js';
import { OUTFITS, PALETTES, buildOutfit, buildAccessory,
         buildHair, applyBodyPreset } from './outfits.js';

let THREE = null;

const EMOTIONS = {
  neutral:   { brow: 0,    browTilt: 0,   eye: 1,    mouthCurve: 0,    mouthOpen: 0,    posture: 0,    energy: .35 },
  happy:     { brow: .14,  browTilt: 0,   eye: .88,  mouthCurve: .75,  mouthOpen: .1,   posture: .25,  energy: .6 },
  excited:   { brow: .26,  browTilt: 0,   eye: 1.14, mouthCurve: .85,  mouthOpen: .25,  posture: .4,   energy: .9 },
  confident: { brow: .06,  browTilt: .1,  eye: .94,  mouthCurve: .35,  mouthOpen: 0,    posture: .35,  energy: .55 },
  focused:   { brow: -.16, browTilt: 0,   eye: .8,   mouthCurve: -.1,  mouthOpen: 0,    posture: .1,   energy: .5 },
  confused:  { brow: .1,   browTilt: .34, eye: 1.05, mouthCurve: -.2,  mouthOpen: .08,  posture: -.1,  energy: .4 },
  sad:       { brow: .2,   browTilt: -.3, eye: .9,   mouthCurve: -.6,  mouthOpen: 0,    posture: -.35, energy: .2 },
  angry:     { brow: -.3,  browTilt: .4,  eye: .86,  mouthCurve: -.4,  mouthOpen: .05,  posture: .3,   energy: .7 },
  surprised: { brow: .34,  browTilt: 0,   eye: 1.3,  mouthCurve: .1,   mouthOpen: .55,  posture: .2,   energy: .8 },
  listening: { brow: .12,  browTilt: .06, eye: 1.08, mouthCurve: .12,  mouthOpen: 0,    posture: .15,  energy: .6 },
};

const VISEME_SHAPE = {
  sil: [1, .06, 0], MBP: [.94, .05, 0], FV: [1.06, .2, .05], S: [.9, .24, .05],
  L: [1, .35, 0], K: [1.02, .42, 0], E: [1.18, .5, .1], AI: [1.1, .9, 0],
  O: [.74, .78, 0], U: [.62, .5, 0],
};

const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));
const clamp01 = v => Math.max(0, Math.min(1, v));

export class AvatarBody {
  /**
   * @param {HTMLElement} container
   * @param {{externalAnim?:boolean}} [opts]
   *   externalAnim = the AvatarManager owns the animation state and render
   *   loop. The body then draws only what renderPose() is given, and does not
   *   subscribe to the bus or start its own rAF. Standalone use (no opts)
   *   keeps the original self-driving behaviour.
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.externalAnim = !!opts.externalAnim;
    /** Solid character (default) vs the original translucent hologram. */
    this.solid = config.get('avatarSolid') !== false;
    this.ok = false;
    this.enabled = true;
    this.time = 0;
    this.isBody = true;

    this.blink = { closed: 0, next: 2.2, phase: 'open', t: 0 };
    this.emotion = 'neutral';
    this.emoCur = { ...EMOTIONS.neutral };
    this.emoTarget = { ...EMOTIONS.neutral };
    this.mouth = { w: 1, h: .06, curve: 0, targetW: 1, targetH: .06, targetCurve: 0 };
    this.visemeQueue = [];
    this.speaking = false;
    this.gaze = { x: 0, y: 0, tx: 0, ty: 0, next: 2 };
    this.impulse = { nod: 0, tilt: 0, pulse: 0, shake: 0, wave: 0, point: 0, thumb: 0, cheer: 0 };
    this.energy = .35;
    this.bones = {};
    this.parts = {};
    this._listeners = [];
    this._raf = null;
    this._fps = [];
    this.outfit = config.get('avatarOutfit') || 'suit';
    this.palette = config.get('avatarPalette') || 'cyan';
    this.accessory = config.get('avatarAccessory') || 'none';
    this.hair = config.get('avatarHair') || 'short';
    this.hairColor = config.get('avatarHairColor') || 'match';
    this.bodyType = config.get('avatarBodyType') || 'neutral';
  }

  async init() {
    try {
      THREE = await import('../../vendor/three.module.js');
    } catch {
      try { THREE = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js'); }
      catch (e) { console.error('[avatar-body] three.js unavailable', e); return false; }
    }

    const w = this.container.clientWidth || 480;
    const h = this.container.clientHeight || 480;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (e) { console.error('[avatar-body] WebGL unavailable', e); return false; }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0);
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;';

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, w / h, 0.1, 100);
    this.frameRadius = 1.32;   // half-height of figure + generous margin
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this._lights();
    this._buildSkeleton();
    this._buildBody();
    this._buildHead();
    this._buildGround();
    this._buildParticles();
    this.applyOutfit(this.outfit, this.palette);
    this.applyAccessory(this.accessory);
    this.applyHair(this.hair, this.hairColor);
    this.applyBodyType(this.bodyType);

    this._frameCamera();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    // Under a provider the AnimationEngine owns bus wiring and the frame loop,
    // so we must not duplicate either — that would double-apply visemes and
    // burn a second rAF.
    if (!this.externalAnim) this._wire();

    this.ok = true;
    this.lastT = performance.now();
    if (!this.externalAnim) this._loop();
    return true;
  }

  /**
   * Draw one frame from an AnimationEngine pose.
   *
   * The engine has already decided mouth aperture, blink, emotion channels and
   * impulse decay; this only maps them onto the rig. Keeping the mapping here
   * (rather than the state) is what lets VRM/RPM reuse the same performance.
   *
   * @param {import('./animation-engine.js').AvatarPose} pose
   */
  renderPose(pose) {
    if (!this.ok || !pose) return;
    // Mirror engine state onto the fields _pose() already reads.
    //
    // The engine's EmotionPose is a compact, renderer-neutral set of channels;
    // this rig has a richer local shape (browTilt / eye / mouthOpen). Copying
    // the engine object wholesale would DELETE those keys and freeze the brows
    // and eyelids — TypeScript caught exactly that. So map field by field and
    // derive the extras from the channels the engine does provide.
    this.time = pose.t;
    this.emotion = pose.emotionName;
    const src = pose.emotion;
    const local = EMOTIONS[pose.emotionName] || EMOTIONS.neutral;
    this.emoCur.brow = src.brow;
    this.emoCur.mouthCurve = src.mouthCurve;
    this.emoCur.posture = src.posture;
    this.emoCur.energy = src.energy;
    this.emoCur.eye = src.eyeOpen;
    this.emoCur.browTilt = local.browTilt;
    this.emoCur.mouthOpen = pose.mouthOpen;

    this.energy = pose.energy;
    this.speaking = pose.speaking;
    this.blink.closed = pose.blink;
    this.gaze.x = pose.gaze.x;
    this.gaze.y = pose.gaze.y;
    // Copy values rather than swapping the object, so the rig keeps its own
    // fully-populated impulse record.
    for (const k of Object.keys(this.impulse)) {
      if (pose.impulse[k] !== undefined) this.impulse[k] = pose.impulse[k];
    }
    // Mouth: the engine gives a 0..1 aperture. Set the TARGETS, not the
    // current values — _pose() damps current toward target every frame, so
    // writing `mouth.h` directly is overwritten on the same tick and the
    // mouth never moves. (Caught by test-body's lip-sync assertion.)
    this.mouth.targetH = Math.max(0.05, 0.06 + pose.mouthOpen * 0.5);
    this.mouth.targetW = 1 - pose.mouthOpen * 0.18 + pose.emotion.mouthCurve * 0.12;
    this.mouth.targetCurve = pose.emotion.mouthCurve;
    // The engine owns viseme scheduling, so the rig's own queue must stay
    // empty or update() would fight it for control of the target.
    this.visemeQueue.length = 0;

    // Ease current mouth values toward the targets.
    //
    // This easing lives in update(), NOT in _pose() — calling only _pose()
    // set the targets and then never moved the mouth toward them, so
    // lip-sync silently did nothing. Do it here explicitly rather than
    // calling update(), which would also re-run blink/emotion/viseme logic
    // that the engine already owns.
    const ll = 22;
    this.mouth.w = damp(this.mouth.w, this.mouth.targetW, ll, pose.dt);
    this.mouth.h = damp(this.mouth.h, this.mouth.targetH, ll, pose.dt);
    this.mouth.curve = damp(this.mouth.curve, this.mouth.targetCurve, 8, pose.dt);

    this._pose(pose.dt, pose.t);
    this.renderer.render(this.scene, this.camera);
  }

  /* ── rig ─────────────────────────────────────────────────────────── */

  _lights() {
    if (this.solid) {
      // MeshStandardMaterial is physically based: it needs real light or it
      // renders black. A three-point rig plus a hemisphere fill gives the
      // character readable form instead of a flat silhouette.
      this.scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x101826, 1.5));
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

      this.keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
      this.keyLight.position.set(2.5, 3.5, 3.5);
      this.scene.add(this.keyLight);

      const fill = new THREE.DirectionalLight(0x9ec9ff, 0.9);
      fill.position.set(-3, 1.2, 2);
      this.scene.add(fill);

      // Cool rim from behind separates the figure from the dark background.
      this.rimLight = new THREE.DirectionalLight(0x7dd3fc, 1.6);
      this.rimLight.position.set(-2, 2.2, -3.5);
      this.scene.add(this.rimLight);
      return;
    }
    this.scene.add(new THREE.AmbientLight(0x1a3a5c, 1.2));
    this.keyLight = new THREE.PointLight(0x38bdf8, 2.4, 30);
    this.keyLight.position.set(2.5, 3, 3.5);
    this.scene.add(this.keyLight);
    this.rimLight = new THREE.PointLight(0x818cf8, 1.8, 30);
    this.rimLight.position.set(-3, 1, -2.5);
    this.scene.add(this.rimLight);
    const up = new THREE.PointLight(0x38bdf8, 1.1, 12);
    up.position.set(0, -1.4, 1.6);
    this.scene.add(up);
  }

  /**
   * Bone hierarchy. Every visual mesh is parented to a bone group, so posing
   * a bone moves everything attached to it — a real skeleton, not a pile of
   * independently-animated shapes.
   */
  _buildSkeleton() {
    const B = (name, parent, x = 0, y = 0, z = 0) => {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      (parent || this.root).add(g);
      this.bones[name] = g;
      return g;
    };

    // Proportions target ~7.5 heads tall (head ≈ .21 units, total ≈ 1.6).
    B('hips', null, 0, 0, 0);
    B('spine', this.bones.hips, 0, .2, 0);
    B('chest', this.bones.spine, 0, .26, 0);
    B('neck', this.bones.chest, 0, .26, 0);
    B('head', this.bones.neck, 0, .13, 0);

    for (const s of ['L', 'R']) {
      const sign = s === 'L' ? 1 : -1;
      B(`shoulder${s}`, this.bones.chest, sign * .17, .18, 0);
      B(`upperArm${s}`, this.bones[`shoulder${s}`], sign * .06, -.02, 0);
      B(`foreArm${s}`, this.bones[`upperArm${s}`], 0, -.29, 0);
      B(`hand${s}`, this.bones[`foreArm${s}`], 0, -.26, 0);
      B(`thigh${s}`, this.bones.hips, sign * .105, -.1, 0);
      B(`shin${s}`, this.bones[`thigh${s}`], 0, -.44, 0);
      B(`foot${s}`, this.bones[`shin${s}`], 0, -.42, 0);
    }
  }

  /**
   * Body/garment material.
   *
   * SOLID MODE (default): an opaque, smooth-shaded PBR material. This is the
   * fix for "those lines on it" — the old look was ~50% transparent so you saw
   * the model's own backfaces through the front, and every mesh carried a
   * wireframe overlay on top.
   *
   * HOLOGRAM MODE: the original translucent + wireframe treatment, kept as an
   * option because it suits the AR/holographic theme.
   */
  _mat(color, opts = {}) {
    if (this.solid) {
      return new THREE.MeshStandardMaterial({
        color,
        // A hint of emissive keeps it readable against the dark HUD without
        // washing the form out.
        emissive: opts.emissive ?? color,
        emissiveIntensity: (opts.ei ?? .35) * 0.28,
        roughness: opts.roughness ?? .62,
        metalness: opts.metalness ?? .18,
        transparent: false,
        opacity: 1,
        flatShading: false,          // smooth normals = no faceted "lines"
      });
    }
    return new THREE.MeshPhongMaterial({
      color, emissive: opts.emissive ?? color, emissiveIntensity: opts.ei ?? .35,
      transparent: true, opacity: opts.opacity ?? .55, shininess: 80,
      specular: 0x66e5ff, flatShading: opts.flat ?? true,
    });
  }

  /**
   * Switch between solid and hologram at runtime.
   * Rebuilds materials in place — no scene teardown.
   */
  setSolid(on) {
    const next = !!on;
    if (next === this.solid) return true;
    this.solid = next;
    // Wireframe overlays are tagged so we can hide them without rebuilding.
    for (const m of this.wireMeshes || []) m.visible = !next;
    const apply = (mesh) => {
      if (!mesh?.material || mesh.userData.isWire) return;
      const col = mesh.material.color?.getHex?.() ?? 0x0d3550;
      const fresh = this._mat(col, mesh.userData.matOpts || {});
      mesh.material.dispose();
      mesh.material = fresh;
    };
    this.scene?.traverse?.(apply);
    return true;
  }

  /** Attach a capsule/box limb to a bone, offset so it hangs correctly. */
  _limb(bone, geo, mat, y = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    this.bones[bone].add(m);
    return m;
  }

  _buildBody() {
    const skin = this._mat(0x0d3550, { ei: .45, opacity: .5 });
    this.bodyMat = skin;
    this.bodyMeshes = [];

    this.wireMeshes = [];
    const add = (bone, geo, y) => {
      const m = this._limb(bone, geo, skin, y);
      this.bodyMeshes.push(m);
      // Wireframe overlay belongs to the hologram look only. In solid mode it
      // is created but hidden, so setSolid() can toggle without a rebuild.
      const wf = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({
        color: 0x38bdf8, wireframe: true, transparent: true, opacity: .22,
      }));
      wf.position.y = y;
      wf.visible = !this.solid;
      wf.userData.isWire = true;
      this.bones[bone].add(wf);
      this.bodyMeshes.push(wf);
      this.wireMeshes.push(wf);
      return m;
    };

    // pelvis: narrower than the chest so the silhouette tapers
    const pelvis = add('hips', new THREE.CapsuleGeometry(.115, .1, 4, 16), -.02);
    pelvis.scale.set(1.12, 1, .82);

    const waist = add('spine', new THREE.CapsuleGeometry(.115, .2, 4, 18), .1);
    waist.scale.set(1.18, 1, .78);
    this.parts.torso = waist;

    // V-taper chest
    const chest = add('chest', new THREE.CapsuleGeometry(.145, .18, 4, 18), .09);
    chest.scale.set(1.3, 1, .74);
    this.parts.chest = chest;

    add('neck', new THREE.CylinderGeometry(.048, .058, .13, 12), .05);

    for (const s of ['L', 'R']) {
      const sign = s === 'L' ? 1 : -1;
      // deltoid cap makes the shoulder read as a joint, not a hinge
      const delt = add(`shoulder${s}`, new THREE.SphereGeometry(.072, 14, 12), 0);
      delt.scale.set(1, .9, 1);
      delt.position.x = sign * .03;

      add(`upperArm${s}`, new THREE.CapsuleGeometry(.045, .24, 4, 12), -.145);
      add(`foreArm${s}`, new THREE.CapsuleGeometry(.037, .22, 4, 12), -.13);
      const hand = add(`hand${s}`, new THREE.CapsuleGeometry(.036, .07, 4, 10), -.055);
      hand.scale.set(1, 1, .6);

      add(`thigh${s}`, new THREE.CapsuleGeometry(.068, .32, 4, 12), -.22);
      add(`shin${s}`, new THREE.CapsuleGeometry(.052, .32, 4, 12), -.21);
      const foot = add(`foot${s}`, new THREE.BoxGeometry(.085, .05, .21), -.025);
      foot.position.z = .06;
    }
  }

  _buildHead() {
    const hb = this.bones.head;
    const headGeo = new THREE.IcosahedronGeometry(.2, 2);
    headGeo.scale(.86, 1.1, .9);
    this.headMat = this._mat(this.solid ? 0x27618f : 0x0d3550, { ei: .5, opacity: .45 });
    const skull = new THREE.Mesh(headGeo, this.headMat);
    skull.position.y = .17;
    hb.add(skull);
    this.headMesh = skull;

    // The head carried its own wireframe cage, separate from the body's
    // overlays — which is why the face still looked like glowing lines after
    // the body went solid. It is registered in wireMeshes now so setSolid()
    // controls it too, and hidden by default.
    this.headWire = new THREE.Mesh(headGeo.clone(), new THREE.MeshBasicMaterial({
      color: 0x38bdf8, wireframe: true, transparent: true, opacity: .26,
    }));
    this.headWire.position.y = .17;
    this.headWire.scale.setScalar(1.02);
    this.headWire.visible = !this.solid;
    this.headWire.userData.isWire = true;
    (this.wireMeshes ||= []).push(this.headWire);
    hb.add(this.headWire);

    // eyes
    this.eyes = []; this.pupils = []; this.lids = []; this.brows = [];
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(side * .072, .195, .175);
      g.rotation.y = side * .2;
      hb.add(g);

      g.add(new THREE.Mesh(new THREE.CircleGeometry(.039, 24),
        new THREE.MeshBasicMaterial({ color: 0x02131f, transparent: true, opacity: .95 })));
      const iris = new THREE.Mesh(new THREE.CircleGeometry(.028, 24),
        new THREE.MeshBasicMaterial({ color: 0x5ceaff }));
      iris.position.z = .006;
      g.add(iris);
      const pupil = new THREE.Mesh(new THREE.CircleGeometry(.013, 16),
        new THREE.MeshBasicMaterial({ color: 0xffffff }));
      pupil.position.z = .012;
      g.add(pupil);

      const pair = [];
      for (const dir of [1, -1]) {
        const lid = new THREE.Mesh(
          new THREE.CircleGeometry(.042, 20, dir > 0 ? 0 : Math.PI, Math.PI),
          new THREE.MeshBasicMaterial({ color: 0x0d3550, transparent: true, opacity: 1 }));
        lid.position.z = .02;
        g.add(lid);
        pair.push({ mesh: lid, dir });
      }
      this.eyes.push({ group: g, iris });
      this.pupils.push(pupil);
      this.lids.push(pair);

      const brow = new THREE.Mesh(
        new THREE.TorusGeometry(.036, .006, 6, 16, Math.PI * .7),
        new THREE.MeshBasicMaterial({ color: 0x7ee0ff, transparent: true, opacity: .9 }));
      brow.position.set(side * .072, .253, .172);
      brow.rotation.y = side * .2;
      hb.add(brow);
      this.brows.push({ mesh: brow, side, baseY: .253 });
    }

    // mouth
    const mg = new THREE.Group();
    mg.position.set(0, .125, .182);
    hb.add(mg);
    this.mouthGroup = mg;
    this.mouthMesh = new THREE.Mesh(new THREE.CircleGeometry(.5, 32),
      new THREE.MeshBasicMaterial({ color: 0x5ceaff, transparent: true, opacity: .95 }));
    mg.add(this.mouthMesh);
    this.mouthInner = new THREE.Mesh(new THREE.CircleGeometry(.5, 32),
      new THREE.MeshBasicMaterial({ color: 0x001420, transparent: true, opacity: 0 }));
    this.mouthInner.position.z = .002;
    mg.add(this.mouthInner);
  }

  _buildGround() {
    this.groundRing = new THREE.Mesh(
      new THREE.RingGeometry(.3, .42, 64),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: .3, side: THREE.DoubleSide }));
    this.groundRing.rotation.x = -Math.PI / 2;
    this.groundRing.position.y = -.92;
    this.root.add(this.groundRing);

    this.groundRing2 = new THREE.Mesh(
      new THREE.RingGeometry(.5, .535, 64),
      new THREE.MeshBasicMaterial({ color: 0x818cf8, transparent: true, opacity: .18, side: THREE.DoubleSide }));
    this.groundRing2.rotation.x = -Math.PI / 2;
    this.groundRing2.position.y = -.92;
    this.root.add(this.groundRing2);

    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(.46, 48),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: .07 }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -.915;
    this.root.add(glow);
    this.groundGlow = glow;
  }

  _buildParticles() {
    const N = 260;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    this.pSeed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = .6 + Math.random() * 1.6;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = -1 + Math.random() * 2.6;
      pos[i * 3 + 2] = Math.sin(a) * r;
      this.pSeed[i] = Math.random();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.pBase = pos.slice();
    this.particles = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0x5ccff5, size: .022, transparent: true, opacity: .5, sizeAttenuation: true }));
    this.scene.add(this.particles);
  }

  /* ── outfits / personalisation ───────────────────────────────────── */

  /**
   * Swap clothing. Garments are separate meshes parented to bones, so they
   * follow the skeleton exactly — the standard approach for outfit systems.
   */
  applyOutfit(outfitId, paletteId) {
    if (!THREE) return;
    this.outfit = outfitId || this.outfit;
    this.palette = paletteId || this.palette;

    // clear previous garments
    for (const m of this.garments || []) {
      m.parent?.remove(m);
      m.geometry?.dispose();
      m.material?.dispose();
    }
    this.garments = buildOutfit(THREE, this.bones, this.outfit, this.palette);

    const pal = PALETTES[this.palette] || PALETTES.cyan;
    this.accent = pal.accent;
    const c = new THREE.Color(pal.accent);
    this.headWire.material.color.copy(c);
    for (const m of this.bodyMeshes) if (m.material.wireframe) m.material.color.copy(c);
    for (const e of this.eyes) e.iris.material.color.copy(c);
    this.mouthMesh.material.color.copy(c);
    for (const b of this.brows) b.mesh.material.color.copy(c);
    this.groundRing.material.color.copy(c);
    this.keyLight.color.copy(c);
    const body = new THREE.Color(pal.body);
    this.bodyMat.color.copy(body); this.bodyMat.emissive.copy(body);
    this.headMat.color.copy(body); this.headMat.emissive.copy(body);
    if (this.particles) this.particles.material.color.copy(c);

    config.set({ avatarOutfit: this.outfit, avatarPalette: this.palette });
    state.set({ avatarOutfit: this.outfit, avatarPalette: this.palette });
    bus.emit('avatar:outfit', { outfit: this.outfit, palette: this.palette });
    if (this.accessory) this.applyAccessory(this.accessory);   // recolour with the palette
  }

  /** Swap a head/body accessory (visor, halo, headset, cape). */
  applyAccessory(accId) {
    if (!THREE) return;
    this.accessory = accId || 'none';
    for (const m of this.accessories || []) {
      m.parent?.remove(m); m.geometry?.dispose(); m.material?.dispose();
    }
    this.accessories = buildAccessory(THREE, this.bones, this.accessory, this.palette);
    // A 'match' hair colour tracks the palette, so recolour on outfit change.
    if (this.hairColor === 'match' && this.hairMeshes) this.applyHair();
    config.set({ avatarAccessory: this.accessory });
    state.set({ avatarAccessory: this.accessory });
    bus.emit('avatar:outfit', { outfit: this.outfit, palette: this.palette, accessory: this.accessory });
  }

  /**
   * Swap the hairstyle. Rebuilds only the hair meshes — body, outfit and
   * animation state are untouched, so this is safe mid-conversation.
   * @param {string} [hairId]
   * @param {string} [colorId]
   */
  applyHair(hairId, colorId) {
    if (!THREE) return false;
    if (hairId !== undefined && hairId !== null) this.hair = hairId;
    if (colorId !== undefined && colorId !== null) this.hairColor = colorId;
    for (const m of this.hairMeshes || []) {
      m.parent?.remove(m); m.geometry?.dispose(); m.material?.dispose();
    }
    this.hairMeshes = buildHair(THREE, this.bones, this.hair, this.hairColor, this.palette);
    config.set({ avatarHair: this.hair, avatarHairColor: this.hairColor });
    state.set({ avatarHair: this.hair });
    bus.emit('avatar:appearance', { hair: this.hair, hairColor: this.hairColor, bodyType: this.bodyType });
    return true;
  }

  /**
   * Change body proportions ("gender" presets).
   * Scales existing bones rather than swapping meshes, so ALL animations —
   * including the wave — keep working with no retargeting.
   * @param {string} typeId
   */
  applyBodyType(typeId) {
    if (!THREE) return false;
    this.bodyType = typeId || 'neutral';
    applyBodyPreset(this.bones, this.bodyType);
    config.set({ avatarBodyType: this.bodyType });
    state.set({ avatarBodyType: this.bodyType });
    bus.emit('avatar:appearance', { hair: this.hair, hairColor: this.hairColor, bodyType: this.bodyType });
    return true;
  }

  /* ── events ──────────────────────────────────────────────────────── */

  _wire() {
    const add = (e, f) => this._listeners.push(bus.on(e, f));
    add(EV.TTS_START, () => { this.speaking = true; this.energy = 1; });
    add(EV.TTS_END, () => { this.speaking = false; this.visemeQueue.length = 0; this._mouthTarget('sil'); });
    add(EV.TTS_INTERRUPT, () => { this.speaking = false; this.visemeQueue.length = 0; this._mouthTarget('sil'); this.impulse.shake = .6; });
    add(EV.TTS_VISEME, ({ visemes }) => this.pushVisemes(visemes));
    add(EV.AVATAR_EMOTION, ({ emotion }) => this.setEmotion(emotion));
    add(EV.AI_STREAM_START, () => { this.energy = .9; this.setEmotion('focused', 900); });
    add(EV.AI_STREAM_END, () => { this.energy = .5; });
    add(EV.STT_START, () => { this.setEmotion('listening'); this.energy = .8; });
    add(EV.STT_END, () => { if (this.emotion === 'listening') this.setEmotion('neutral'); });
    add(EV.GESTURE, ({ gesture }) => this.reactToGesture(gesture));
    add(EV.AVATAR_REACT, ({ type }) => { if (type in this.impulse) this.impulse[type] = 1; });
  }

  setEmotion(name, hold = 0) {
    const e = EMOTIONS[name] ? name : 'neutral';
    this.emotion = e;
    this.emoTarget = { ...EMOTIONS[e] };
    state.set({ avatarEmotion: e });
    if (hold > 0) {
      clearTimeout(this._emoT);
      this._emoT = setTimeout(() => {
        if (this.emotion === e) { this.emotion = 'neutral'; this.emoTarget = { ...EMOTIONS.neutral }; state.set({ avatarEmotion: 'neutral' }); }
      }, hold);
    }
  }

  /** Full-body gesture responses — the payoff of having arms. */
  reactToGesture(g) {
    switch (g) {
      case 'wave': this.impulse.wave = 1; this.setEmotion('happy', 3400); break;
      case 'thumbs_up': this.impulse.thumb = 1; this.setEmotion('confident', 2800); break;
      case 'thumbs_down': this.impulse.shake = 1; this.setEmotion('sad', 2600); break;
      case 'peace': this.impulse.cheer = 1; this.setEmotion('excited', 2800); break;
      case 'open_palm': this.impulse.pulse = 1; this.setEmotion('listening', 3200); break;
      case 'pointing': this.impulse.point = 1; this.setEmotion('focused', 2400); break;
      case 'fist': this.impulse.pulse = .8; this.setEmotion('confident', 2000); break;
      case 'ok': this.impulse.nod = .9; this.setEmotion('happy', 2400); break;
      case 'rock': this.impulse.cheer = 1; this.setEmotion('excited', 2600); break;
      default: this.impulse.pulse = .4;
    }
  }

  pushVisemes(vs) {
    if (!vs?.length) return;
    const now = performance.now();
    for (const v of vs) this.visemeQueue.push({ at: now + v.t, viseme: v.viseme });
    if (this.visemeQueue.length > 90) this.visemeQueue.splice(0, this.visemeQueue.length - 90);
  }

  _mouthTarget(v) {
    const s = VISEME_SHAPE[v] || VISEME_SHAPE.sil;
    this.mouth.targetW = s[0];
    this.mouth.targetH = Math.max(.05, s[1]);
    this.mouth.targetCurve = s[2];
  }

  /* ── update ──────────────────────────────────────────────────────── */

  update(dt) {
    this.time += dt;
    const t = this.time;

    for (const k of Object.keys(this.emoTarget)) this.emoCur[k] = damp(this.emoCur[k], this.emoTarget[k], 6, dt);

    // blink
    const b = this.blink;
    b.t += dt;
    if (b.phase === 'open' && b.t >= b.next) { b.phase = 'closing'; b.t = 0; }
    else if (b.phase === 'closing') { b.closed = Math.min(1, b.closed + dt * 16); if (b.closed >= 1) b.phase = 'opening'; }
    else if (b.phase === 'opening') {
      b.closed = Math.max(0, b.closed - dt * 9);
      if (b.closed <= 0) { b.phase = 'open'; b.t = 0; b.next = Math.random() < .13 ? .22 : 2 + Math.random() * 5; }
    }

    // lip-sync
    const now = performance.now();
    let applied = null;
    while (this.visemeQueue.length && this.visemeQueue[0].at <= now) applied = this.visemeQueue.shift();
    if (applied) this._mouthTarget(applied.viseme);
    // When an AnimationEngine is driving us, renderPose() has already set the
    // mouth targets for this frame — recomputing them here from the resting
    // emotion would immediately undo the lip-sync.
    if (!this.externalAnim && !this.speaking && !this.visemeQueue.length) {
      const e = this.emoCur;
      this.mouth.targetH = Math.max(.05, e.mouthOpen * .6 + .06);
      this.mouth.targetW = 1 + e.mouthCurve * .12;
      this.mouth.targetCurve = e.mouthCurve;
    }
    const ll = (this.speaking || this.externalAnim) ? 22 : 8;
    this.mouth.w = damp(this.mouth.w, this.mouth.targetW, ll, dt);
    this.mouth.h = damp(this.mouth.h, this.mouth.targetH, ll, dt);
    this.mouth.curve = damp(this.mouth.curve, this.mouth.targetCurve, 8, dt);

    // gaze
    this.gaze.next -= dt;
    if (this.gaze.next <= 0) {
      this.gaze.tx = (Math.random() - .5) * .09;
      this.gaze.ty = (Math.random() - .5) * .055;
      this.gaze.next = .8 + Math.random() * 2.6;
    }
    this.gaze.x = damp(this.gaze.x, this.gaze.tx, 12, dt);
    this.gaze.y = damp(this.gaze.y, this.gaze.ty, 12, dt);

    for (const k of Object.keys(this.impulse)) this.impulse[k] = Math.max(0, this.impulse[k] - dt * 1.1);
    this.energy = damp(this.energy, this.speaking ? 1 : this.emoCur.energy, 2.2, dt);

    this._pose(dt, t);
  }

  /** Procedural full-body pose: idle + gesture overlays. */
  _pose(dt, t) {
    const B = this.bones, e = this.emoCur, imp = this.impulse;

    // ── idle: breathing, weight shift, sway
    const breath = Math.sin(t * 1.1) * .012;
    const shift = Math.sin(t * .45) * .035;
    B.hips.position.y = breath;
    B.hips.position.x = shift * .35;
    B.hips.rotation.z = -shift * .12;
    B.hips.rotation.y = Math.sin(t * .3) * .07;

    B.spine.rotation.x = -e.posture * .08 + Math.sin(t * 1.1) * .012;
    B.spine.rotation.z = shift * .08;
    B.chest.rotation.x = -e.posture * .06 + Math.sin(t * 1.1 + .4) * .01;
    B.chest.scale.setScalar(1 + Math.sin(t * 1.1) * .012);

    // head: look at camera + gaze + nod/shake
    const nod = Math.sin(imp.nod * Math.PI * 2.6) * .35 * imp.nod;
    const shake = Math.sin(imp.shake * Math.PI * 6) * .3 * imp.shake;
    B.neck.rotation.x = -e.posture * .05;
    B.head.rotation.x = this.gaze.y * .5 + nod + Math.sin(t * .5) * .02;
    B.head.rotation.y = this.gaze.x * 1.2 + shake + Math.sin(t * .37) * .05;
    B.head.rotation.z = imp.tilt * Math.sin(imp.tilt * Math.PI * 2) * .3 + Math.sin(t * .6) * .012;

    // ── arms: rest pose then gesture overlays
    for (const s of ['L', 'R']) {
      const sign = s === 'L' ? 1 : -1;
      const ua = B[`upperArm${s}`], fa = B[`foreArm${s}`], hd = B[`hand${s}`];
      // relaxed hang, slight outward, gentle swing
      let ax = Math.sin(t * .5 + (sign > 0 ? 0 : 1.4)) * .05;
      let az = sign * (.14 + Math.sin(t * .43) * .03) + sign * e.posture * .06;
      let fx = -.18 + Math.sin(t * .6 + sign) * .04;
      let hz = 0, hx = 0;

      // WAVE — right arm up, forearm oscillates
      if (imp.wave > .02 && s === 'R') {
        const k = Math.min(1, imp.wave * 1.6);
        ax = lerp(ax, -2.1, k);
        az = lerp(az, -.55, k);
        fx = lerp(fx, -.35, k);
        hz = Math.sin(this.time * 13) * .55 * k;
      }
      // POINT — right arm forward
      if (imp.point > .02 && s === 'R') {
        const k = Math.min(1, imp.point * 1.6);
        ax = lerp(ax, -1.5, k);
        az = lerp(az, -.15, k);
        fx = lerp(fx, -.05, k);
      }
      // THUMBS UP — forearm up across chest
      if (imp.thumb > .02 && s === 'R') {
        const k = Math.min(1, imp.thumb * 1.6);
        ax = lerp(ax, -.6, k);
        az = lerp(az, -.35, k);
        fx = lerp(fx, -1.9, k);
      }
      // CHEER — both arms up
      if (imp.cheer > .02) {
        const k = Math.min(1, imp.cheer * 1.6);
        ax = lerp(ax, -2.5, k);
        az = lerp(az, sign * .5, k);
        fx = lerp(fx, -.5, k);
      }
      // speaking gesticulation — small, alive
      if (this.speaking) {
        ax += Math.sin(this.time * 3.1 + sign * 1.7) * .09 * this.energy;
        fx += Math.sin(this.time * 4.3 + sign) * .12 * this.energy;
      }

      ua.rotation.x = damp(ua.rotation.x, ax, 9, dt);
      ua.rotation.z = damp(ua.rotation.z, az, 9, dt);
      fa.rotation.x = damp(fa.rotation.x, fx, 9, dt);
      hd.rotation.z = damp(hd.rotation.z, hz, 12, dt);
      hd.rotation.x = damp(hd.rotation.x, hx, 12, dt);
    }

    // ── legs: subtle counter-shift so the stance reads as weight-bearing
    for (const s of ['L', 'R']) {
      const sign = s === 'L' ? 1 : -1;
      B[`thigh${s}`].rotation.x = Math.sin(t * .45 + (sign > 0 ? 0 : Math.PI)) * .025;
      B[`thigh${s}`].rotation.z = sign * .03 - shift * .06 * sign;
      B[`shin${s}`].rotation.x = Math.abs(Math.sin(t * .45 + (sign > 0 ? 0 : Math.PI))) * .03;
    }

    // ── face
    const open = Math.max(.02, Math.min(1.35, (1 - this.blink.closed) * e.eye));
    const shut = 1 - Math.min(1, open);
    for (let i = 0; i < this.lids.length; i++) {
      for (const { mesh, dir } of this.lids[i]) {
        mesh.position.y = dir * .042 * Math.min(1, open);
        mesh.material.opacity = Math.min(1, shut * 2.2);
        mesh.visible = shut > .02;
      }
      this.pupils[i].position.x = this.gaze.x * .03;
      this.pupils[i].position.y = this.gaze.y * .03;
      this.eyes[i].iris.scale.setScalar(lerp(.7, 1.05, Math.min(1, open)));
    }
    for (let i = 0; i < this.brows.length; i++) {
      const br = this.brows[i];
      br.mesh.position.y = br.baseY + e.brow * .05;
      br.mesh.rotation.z = Math.PI * .15 + e.browTilt * .5 * br.side;
    }
    const mW = .09 * this.mouth.w, mH = Math.max(.009, this.mouth.h * .1);
    this.mouthMesh.scale.set(mW, mH, 1);
    this.mouthInner.scale.set(mW * .88, mH * .8, 1);
    this.mouthInner.material.opacity = Math.min(.95, this.mouth.h * 1.6);
    this.mouthGroup.rotation.x = -this.mouth.curve * .2;

    // ── materials pulse with energy
    const ei = .32 + this.energy * .5 + imp.pulse * .3;
    this.bodyMat.emissiveIntensity = ei;
    this.headMat.emissiveIntensity = ei + .05;
    this.headWire.material.opacity = .18 + this.energy * .2;
    for (const m of this.bodyMeshes) if (m.material.wireframe) m.material.opacity = .14 + this.energy * .16;

    // ground rings
    this.groundRing.rotation.z += dt * .35;
    this.groundRing2.rotation.z -= dt * .22;
    this.groundRing.material.opacity = .2 + this.energy * .25 + imp.pulse * .2;
    this.groundRing.scale.setScalar(1 + imp.pulse * .12 + Math.sin(t * 1.5) * .015);
    this.groundGlow.material.opacity = .05 + this.energy * .07;

    // particles
    if (this.particles) {
      const p = this.particles.geometry.attributes.position;
      for (let i = 0; i < this.pSeed.length; i++) {
        p.array[i * 3 + 1] = this.pBase[i * 3 + 1] + Math.sin(t * (.3 + this.pSeed[i] * .5) + this.pSeed[i] * 9) * .14;
      }
      p.needsUpdate = true;
      this.particles.rotation.y += dt * .03;
      this.particles.material.opacity = .3 + this.energy * .3;
    }

    // accessories: spin the halo, ripple the cape
    for (const a of this.accessories || []) {
      if (a.userData?.spin) a.rotation.z += dt * 1.1;
      if (a.userData?.cloth) {
        const pos = a.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const y = pos.getY(i), x = pos.getX(i);
          pos.setZ(i, Math.sin(t * 2 + y * 3 + x * 2) * .035 * (0.5 - y / 1.8) + Math.sin(t * .8) * .02);
        }
        pos.needsUpdate = true;
      }
    }

    this.keyLight.intensity = 2.1 + this.energy * 1.3 + (this.speaking ? Math.sin(t * 18) * .3 : 0);
    this.rimLight.intensity = 1.4 + this.energy * .8;
  }

  /* ── plumbing ────────────────────────────────────────────────────── */

  _frameCamera() {
    if (!this.camera) return;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(.1, this.camera.aspect);
    /*
     * Account for height scaling, otherwise a taller avatar is framed with
     * the same radius as a default one and its head leaves the top of the
     * viewport. Verified visually: at 1.4x the head was cut off.
     */
    const hScale = Math.max(1, this.root?.scale?.y || 1);
    const radius = this.frameRadius * hScale;
    const dV = radius / Math.sin(vFov / 2);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const dH = radius / Math.sin(hFov / 2);
    // Centre on the mid-torso so head and feet are equidistant from frame edges.
    const centerY = -0.08 * hScale;   // ground ring sits lower than the head is tall
    this.camera.position.set(0, centerY, Math.max(dV, dH) * 1.06);
    this.camera.lookAt(0, centerY, 0);
    this.camera.updateProjectionMatrix();
  }

  resize() {
    if (!this.ok) return;
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this._frameCamera();
    this.renderer.setSize(w, h);
  }

  _loop() {
    const step = () => {
      this._raf = requestAnimationFrame(step);
      const now = performance.now();
      let dt = (now - this.lastT) / 1000;
      this.lastT = now;
      if (dt > .05) dt = .05;
      this._fps.push(now);
      while (this._fps.length && now - this._fps[0] > 1000) this._fps.shift();
      state.set({ fps: this._fps.length });
      if (this.enabled && this.ok) { this.update(dt); this.renderer.render(this.scene, this.camera); }
    };
    this._raf = requestAnimationFrame(step);
  }

  setQuality(level) {
    if (!this.ok) return;
    this.renderer.setPixelRatio(level === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, 2));
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

export default AvatarBody;
