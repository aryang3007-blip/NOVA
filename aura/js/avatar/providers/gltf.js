/**
 * AURA :: VRM / GLB Avatar Provider
 * =================================
 * Loads a user-supplied .glb / .gltf / .vrm model and drives it with the same
 * AnimationEngine that powers the built-in avatar — so an imported character
 * blinks, lip-syncs, emotes and waves back without any extra work.
 *
 * HOW RETARGETING WORKS
 * ---------------------
 * VRM files follow the VRM Humanoid bone naming convention; most GLB rigs
 * follow Mixamo or a close variant. We search the loaded skeleton for each
 * logical bone using a list of aliases, case- and separator-insensitive.
 * Whatever we find gets driven; whatever we don't is simply skipped, so a
 * partial rig still animates as far as it can.
 *
 * Facial animation prefers morph targets (blendshapes) when the model has
 * them — VRM exposes `Fcl_*` / `blink` / `A,I,U,E,O`, Ready Player Me exposes
 * ARKit names like `mouthOpen`, `eyeBlinkLeft`. We probe for both.
 *
 * SPRING BONES: hair, skirts and tails get real secondary motion via
 * `avatar/spring-bones.js`. It reads the VRM extension when present
 * (`VRMC_springBone` for 1.0, `VRM.secondaryAnimation` for 0.x) and falls
 * back to name-based detection so plain GLB rigs are animated too.
 *
 * MTOON: VRM avatars are authored with the MToon cel shader. Loading them
 * with a stock glTF loader gives smooth PBR shading, which is wrong for the
 * flat anime look. `avatar/mtoon.js` converts the materials to real toon
 * shading (banded diffuse, shade colour, rim light, inverted-hull outline)
 * using the model's own VRM parameters.
 *
 * HONEST LIMITATION: MToon UV-animation, matcap spheres and multiply-blend
 * shading textures are not implemented, and VRM first-person flags are
 * ignored. The visible essentials — banding, shade colour, rim, outlines —
 * are covered.
 *
 * @module avatar/providers/gltf
 */

import { AvatarProvider } from './base.js';
import { SpringBoneSystem } from '../spring-bones.js';
import { applyMToon, removeMToon, setMToonLight } from '../mtoon.js';

let THREE = null;
let GLTFLoader = null;

/** Logical bone → candidate names across VRM, Mixamo and common exports. */
const BONE_ALIASES = {
  hips:        ['hips', 'j_bip_c_hips', 'mixamorighips', 'pelvis', 'root'],
  spine:       ['spine', 'j_bip_c_spine', 'mixamorigspine'],
  chest:       ['chest', 'upperchest', 'j_bip_c_chest', 'mixamorigspine1', 'mixamorigspine2'],
  neck:        ['neck', 'j_bip_c_neck', 'mixamorigneck'],
  head:        ['head', 'j_bip_c_head', 'mixamorighead'],
  shoulderL:   ['leftshoulder', 'j_bip_l_shoulder', 'mixamorigleftshoulder'],
  shoulderR:   ['rightshoulder', 'j_bip_r_shoulder', 'mixamorigrightshoulder'],
  upperArmL:   ['leftupperarm', 'leftarm', 'j_bip_l_upperarm', 'mixamorigleftarm'],
  upperArmR:   ['rightupperarm', 'rightarm', 'j_bip_r_upperarm', 'mixamorigrightarm'],
  foreArmL:    ['leftlowerarm', 'leftforearm', 'j_bip_l_lowerarm', 'mixamorigleftforearm'],
  foreArmR:    ['rightlowerarm', 'rightforearm', 'j_bip_r_lowerarm', 'mixamorigrightforearm'],
  handL:       ['lefthand', 'j_bip_l_hand', 'mixamoriglefthand'],
  handR:       ['righthand', 'j_bip_r_hand', 'mixamorigrighthand'],
  upperLegL:   ['leftupperleg', 'leftupleg', 'j_bip_l_upperleg', 'mixamorigleftupleg'],
  upperLegR:   ['rightupperleg', 'rightupleg', 'j_bip_r_upperleg', 'mixamorigrightupleg'],
  lowerLegL:   ['leftlowerleg', 'leftleg', 'j_bip_l_lowerleg', 'mixamorigleftleg'],
  lowerLegR:   ['rightlowerleg', 'rightleg', 'j_bip_r_lowerleg', 'mixamorigrightleg'],
};

/** Morph-target candidates for each expression channel. */
const MORPHS = {
  blink:     ['blink', 'eyeblink', 'eyesclosed', 'fcl_eye_close', 'eyeblinkleft', 'eyeblink_l', 'blink_l'],
  blinkR:    ['eyeblinkright', 'eyeblink_r', 'blink_r', 'fcl_eye_close_r'],
  mouthOpen: ['mouthopen', 'jawopen', 'fcl_mth_a', 'a', 'aa', 'viseme_aa', 'vrc.v_aa'],
  smile:     ['mouthsmile', 'smile', 'fcl_mth_joy', 'happy', 'mouthsmileleft'],
  frown:     ['mouthfrown', 'sad', 'fcl_mth_sorrow', 'mouthfrownleft'],
  browUp:    ['browinnerup', 'browup', 'fcl_brw_surprised', 'surprised'],
  browDown:  ['browdown', 'angry', 'fcl_brw_angry', 'browdownleft'],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_.:-]/g, '');
const lerp = (a, b, t) => a + (b - a) * t;

export class GLTFAvatarProvider extends AvatarProvider {
  static get id() { return 'gltf'; }
  static get label() { return 'VRM / GLB Import'; }
  static get description() {
    return 'Load your own .vrm or .glb character. Keeps AURA\'s lip-sync, blinking, emotions and gestures.';
  }
  static get capabilities() {
    return { lipSync: true, blink: true, emotions: true, gestures: true, customise: false, offline: true };
  }

  static async isAvailable() {
    if (typeof document === 'undefined') return { ok: false, reason: 'No DOM' };
    try {
      const c = document.createElement('canvas');
      if (!(c.getContext('webgl2') || c.getContext('webgl'))) {
        return { ok: false, reason: 'WebGL is not available' };
      }
    } catch { return { ok: false, reason: 'WebGL check failed' }; }
    return { ok: true };
  }

  /**
   * @param {HTMLElement} container
   * @param {{url?:string, blob?:Blob, name?:string}} [options]
   */
  constructor(container, options = {}) {
    super(container, options);
    this.bones = {};
    this.morphMeshes = [];
    this.rest = new Map();     // bone → rest quaternion, so we pose relatively
    this._raf = null;
    this.modelName = options.name || 'imported model';
    /** @type {SpringBoneSystem|null} */
    this.springs = null;
  }

  async _loadDeps() {
    if (!THREE) {
      try { THREE = await import('../../../vendor/three.module.js'); }
      catch (e) { throw new Error(`three.js unavailable: ${e.message}`); }
    }
    if (!GLTFLoader) {
      try {
        ({ GLTFLoader } = await import('../../../vendor/loaders/GLTFLoader.js'));
      } catch (e) {
        throw new Error(`GLTFLoader unavailable: ${e.message}`);
      }
    }
  }

  async init() {
    try {
      await this._loadDeps();

      const src = this.options.blob || this.options.url;
      if (!src) {
        this.failureReason = 'No model selected. Import a .vrm or .glb file first.';
        return false;
      }

      const w = this.container.clientWidth || 480;
      const h = this.container.clientHeight || 480;

      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setSize(w, h);
      this.renderer.setClearColor(0x000000, 0);
      this.container.appendChild(this.renderer.domElement);
      this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;';

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 100);
      this._lights();

      const gltf = await this._parse(src);
      this._gltf = gltf;
      this.root = gltf.scene || gltf.scenes?.[0];
      if (!this.root) throw new Error('The file contains no scene.');
      this.scene.add(this.root);

      this._mapBones();
      this._mapMorphs();
      this._frameModel();

      // Secondary motion. Built AFTER _frameModel() so the model scale is
      // final — gravity is scale-dependent and would be wrong otherwise.
      try {
        this.springs = new SpringBoneSystem(THREE, {
          enabled: this.options.springBones !== false,
          scale: this.root.scale?.x || 1,
        });
        const info = this.springs.build(gltf, this.root);
        this.springInfo = info;
      } catch (e) {
        console.warn('[gltf] spring bones unavailable', e);
        this.springs = null;
      }

      // MToon cel-shading. Only applied to actual VRM files unless forced,
      // so a plain GLB keeps the materials its author intended.
      try {
        this.mtoonInfo = applyMToon(THREE, this.root, gltf, {
          force: this.options.forceToon === true,
        });
        if (this.mtoonInfo.applied) {
          setMToonLight(this.root, new THREE.Vector3(0.4, 0.9, 0.6));
        }
      } catch (e) {
        // Cel-shading is cosmetic — never let it stop the avatar loading.
        // The model simply keeps its original PBR materials.
        console.warn('[gltf] MToon conversion failed, keeping PBR materials', e);
        this.mtoonInfo = { converted: 0, outlines: 0, source: 'error', applied: false };
      }

      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);
      this.initialized = true;
      return true;
    } catch (e) {
      this.failureReason = e.message || String(e);
      // Leave no half-built canvas behind.
      try { this.dispose(); } catch {}
      this.initialized = false;
      return false;
    }
  }

  /** Parse from a Blob (file import) or a URL (Ready Player Me). */
  async _parse(src) {
    const loader = new GLTFLoader();
    if (src instanceof Blob) {
      const buf = await src.arrayBuffer();
      return new Promise((res, rej) => loader.parse(buf, '', res, rej));
    }
    return new Promise((res, rej) => loader.load(String(src), res, undefined, rej));
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x101826, 1.6));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(2, 3, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7dd3fc, 1.4);
    rim.position.set(-2, 2, -3);
    this.scene.add(rim);
  }

  /** Find each logical bone in the imported skeleton. */
  _mapBones() {
    /** @type {Record<string, any>} */
    const found = {};
    const byName = new Map();
    this.root.traverse((o) => {
      if (o.isBone || o.type === 'Bone') byName.set(norm(o.name), o);
    });
    // Some exporters use plain Object3D instead of Bone.
    if (!byName.size) {
      this.root.traverse((o) => byName.set(norm(o.name), o));
    }
    for (const [logical, aliases] of Object.entries(BONE_ALIASES)) {
      for (const a of aliases) {
        const hit = byName.get(norm(a));
        if (hit) { found[logical] = hit; break; }
      }
      // Fall back to a contains-match ("Armature_LeftArm_03").
      if (!found[logical]) {
        for (const a of aliases) {
          for (const [k, v] of byName) {
            if (k.includes(norm(a))) { found[logical] = v; break; }
          }
          if (found[logical]) break;
        }
      }
    }
    this.bones = found;
    for (const b of Object.values(found)) this.rest.set(b, b.quaternion.clone());
    this.boneCount = Object.keys(found).length;
  }

  /** Collect meshes that expose blendshapes we can drive. */
  _mapMorphs() {
    this.morphMeshes = [];
    this.root.traverse((o) => {
      if (!o.isMesh || !o.morphTargetDictionary) return;
      const dict = {};
      for (const [channel, names] of Object.entries(MORPHS)) {
        for (const n of names) {
          for (const key of Object.keys(o.morphTargetDictionary)) {
            if (norm(key) === norm(n) || norm(key).includes(norm(n))) {
              dict[channel] = o.morphTargetDictionary[key];
              break;
            }
          }
          if (dict[channel] !== undefined) break;
        }
      }
      if (Object.keys(dict).length) this.morphMeshes.push({ mesh: o, dict });
    });
    this.morphCount = this.morphMeshes.length;
  }

  /** Fit the camera to the model, whatever scale it was authored at. */
  _frameModel() {
    const box = new THREE.Box3().setFromObject(this.root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const height = size.y || 1.6;

    // Normalise very large/small models to roughly 1.7 units tall.
    const scale = 1.7 / height;
    if (scale < 0.25 || scale > 4) {
      this.root.scale.setScalar(scale);
      box.setFromObject(this.root);
      box.getSize(size);
      box.getCenter(center);
    }
    this.root.position.y -= box.min.y;          // stand on the floor
    const fitH = (size.y * 1.25) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const fitW = fitH / this.camera.aspect;
    this.camera.position.set(0, size.y * 0.58, Math.max(fitH, fitW) * 1.05);
    this.camera.lookAt(0, size.y * 0.52, 0);
    this.modelHeight = size.y;
  }

  /* ── the shared performance, applied to an arbitrary rig ───────────── */

  applyPose(pose) {
    if (!this.initialized) return;
    const B = this.bones;
    const e = pose.emotion;
    const imp = pose.impulse;
    const t = pose.t;

    const setEuler = (bone, x, y, z) => {
      if (!bone) return;
      const rest = this.rest.get(bone);
      if (rest) bone.quaternion.copy(rest);
      bone.rotation.x += x;
      bone.rotation.y += y;
      bone.rotation.z += z;
    };

    // idle: breathing + sway
    const breath = pose.breath * 0.02 * (0.6 + pose.energy * 0.6);
    setEuler(B.spine, breath, pose.sway * 0.05, 0);
    setEuler(B.chest, breath * 0.6, 0, 0);
    if (B.hips) B.hips.position.y = (B.hips.userData._baseY ??= B.hips.position.y) + breath * 0.4;

    // head: gaze + emotion posture + nod/shake impulses
    setEuler(
      B.head,
      -pose.gaze.y * 0.25 - e.posture * 0.06 + imp.nod * 0.5,
      pose.gaze.x * 0.42 + imp.shake * Math.sin(t * 22) * 0.35,
      imp.tilt * 0.3 + pose.sway * 0.03,
    );
    setEuler(B.neck, -pose.gaze.y * 0.12, pose.gaze.x * 0.18, 0);

    // arms: rest pose, then gesture overlays. THE WAVE lives here.
    for (const side of ['L', 'R']) {
      const sign = side === 'L' ? 1 : -1;
      const ua = B[`upperArm${side}`], fa = B[`foreArm${side}`], hd = B[`hand${side}`];
      let ax = 0, az = sign * -0.06, fx = 0, hz = 0;

      // Arms hang down in the T-pose most rigs ship with.
      az += sign * 1.15;

      if (imp.wave > 0.02 && side === 'R') {
        const k = Math.min(1, imp.wave * 1.6);
        az = lerp(az, sign * 0.35, k);
        ax = lerp(ax, -0.35, k);
        fx = lerp(fx, -0.9, k);
        hz = Math.sin(t * 13) * 0.6 * k;          // the actual waving motion
      }
      if (imp.thumb > 0.02 && side === 'R') {
        const k = Math.min(1, imp.thumb * 1.6);
        az = lerp(az, sign * 0.6, k);
        fx = lerp(fx, -1.6, k);
      }
      if (imp.point > 0.02 && side === 'R') {
        const k = Math.min(1, imp.point * 1.6);
        az = lerp(az, sign * 0.75, k);
        ax = lerp(ax, -1.2, k);
      }
      if (imp.cheer > 0.02) {
        const k = Math.min(1, imp.cheer * 1.6);
        az = lerp(az, sign * 0.15, k);
        ax = lerp(ax, -2.2, k);
      }
      // speaking gesticulation
      if (pose.speaking) {
        ax += Math.sin(t * 3.1 + sign) * 0.05;
        fx += Math.sin(t * 4.2 + sign) * 0.06;
      }
      setEuler(ua, ax, 0, az);
      setEuler(fa, fx, 0, 0);
      setEuler(hd, 0, 0, hz);
    }

    this._applyMorphs(pose);
    // Spring bones run AFTER the pose so they react to the motion we just
    // applied — waving actually swings the hair.
    if (this.springs) this.springs.update(pose.dt);
    this.renderer.render(this.scene, this.camera);
  }

  _applyMorphs(pose) {
    if (!this.morphMeshes.length) return;
    const e = pose.emotion;
    const vals = {
      blink: pose.blink,
      blinkR: pose.blink,
      mouthOpen: pose.mouthOpen,
      smile: Math.max(0, e.mouthCurve),
      frown: Math.max(0, -e.mouthCurve),
      browUp: Math.max(0, e.brow),
      browDown: Math.max(0, -e.brow),
    };
    for (const { mesh, dict } of this.morphMeshes) {
      const infl = mesh.morphTargetInfluences;
      if (!infl) continue;
      for (const [channel, idx] of Object.entries(dict)) {
        const v = vals[channel];
        if (v === undefined) continue;
        infl[idx] = Math.max(0, Math.min(1, v));
      }
    }
  }

  /**
   * Height scaling for an imported GLB/VRM. `this.root` is the loaded scene
   * node, so scaling it moves the whole rig — bones, skinning and spring
   * bones all follow, because they are children of it.
   */
  setHeight(v) {
    if (!this.root) return false;
    const lateral = 1 + (v - 1) * 0.35;
    const base = this._baseScale || (this._baseScale = this.root.scale.clone());
    this.root.scale.set(base.x * lateral, base.y * v, base.z * lateral);
    return true;
  }

  resize() {
    if (!this.initialized) return;
    const w = this.container.clientWidth || 480;
    const h = this.container.clientHeight || 480;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** What did we actually manage to drive? Shown in the Avatar Manager. */
  describe() {
    const base = super.describe();
    return {
      ...base,
      detail: this.initialized
        ? `${this.modelName} · ${this.boneCount || 0} bones mapped · ${this.morphCount || 0} morph meshes`
          + (this.springInfo?.count
              ? ` · ${this.springInfo.count} spring bones (${this.springInfo.source})`
              : ' · no spring bones')
          + (this.mtoonInfo?.applied
              ? ` · MToon cel-shading (${this.mtoonInfo.converted} materials)`
              : '')
        : undefined,
    };
  }

  /** Toggle hair/cloth physics at runtime. */
  setSpringBones(on) { return this.springs?.setEnabled(on) ?? false; }

  /**
   * Toggle MToon cel-shading. Turning it off restores the original PBR
   * materials rather than approximating them, so the switch is lossless.
   */
  setToonShading(on) {
    if (!this.root || !THREE) return false;
    if (on) {
      this.mtoonInfo = applyMToon(THREE, this.root, this._gltf, { force: true });
      if (this.mtoonInfo.applied) setMToonLight(this.root, new THREE.Vector3(0.4, 0.9, 0.6));
      return this.mtoonInfo.applied;
    }
    removeMToon(this.root);
    this.mtoonInfo = { converted: 0, outlines: 0, source: 'off', applied: false };
    return true;
  }

  dispose() {
    try { this.springs?.dispose(); } catch {}
    this.springs = null;
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    try {
      this.root?.traverse?.((o) => {
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach(x => x?.dispose?.());
        else m?.dispose?.();
      });
      this.renderer?.dispose?.();
      if (this.renderer?.domElement?.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    } catch {}
    this.bones = {};
    this.morphMeshes = [];
    this.rest.clear();
    this.root = null;
    this.initialized = false;
  }
}

export default GLTFAvatarProvider;
