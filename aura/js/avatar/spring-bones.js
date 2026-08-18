/**
 * AURA :: Spring Bone Physics
 * ===========================
 * Secondary motion for hair, skirts, ties, ears and tails on imported VRM /
 * GLB avatars — the thing that makes a character feel alive rather than
 * rigid when it turns its head or waves.
 *
 * HOW IT WORKS
 * ------------
 * Each spring bone is simulated as a single point (the bone's tail) using
 * **verlet integration**:
 *
 *     next = current + (current - previous) * (1 - drag) + force
 *
 * The point is then constrained back onto the sphere of radius `boneLength`
 * around the bone's head, and the bone is rotated to look at it. Because the
 * constraint is applied after integration, the bone can never stretch — a
 * common failure mode of naive spring implementations.
 *
 * Stiffness pulls the tail back toward its rest direction; gravity and drag
 * do the rest. Collider spheres push the point out so hair does not sink
 * into the head or shoulders.
 *
 * WHERE THE DATA COMES FROM
 * -------------------------
 * VRM files declare their spring bones in a glTF extension:
 *   • VRM 0.x  → `extensions.VRM.secondaryAnimation.boneGroups`
 *   • VRM 1.0  → `extensions.VRMC_springBone.springs`
 * We read whichever is present. For plain GLB files (no extension) we fall
 * back to **name-based detection** — chains called "hair", "skirt", "tail",
 * "ribbon" etc. — so a Mixamo or Blender export still gets secondary motion.
 *
 * FIXED TIMESTEP: the solver runs at a constant 60 Hz internally regardless
 * of render frame rate. A variable dt makes verlet springs explode on a
 * stutter, which would look like the hair detonating.
 *
 * @module avatar/spring-bones
 */

/** Chains matching these names get physics when a VRM extension is absent. */
const AUTO_SPRING_PATTERNS = [
  /hair/i, /skirt/i, /tail/i, /ribbon/i, /cloth/i, /coat/i, /scarf/i,
  /ear[_ ]?(l|r|left|right)?$/i, /bust/i, /breast/i, /sleeve/i, /strand/i,
  /twin/i, /ponytail/i, /braid/i, /antenna/i,
];

/** Bones that must never be simulated even if their name matches. */
const NEVER_SPRING = /hips?$|spine|chest|neck|head$|upperarm|lowerarm|hand$|upperleg|lowerleg|foot$|toe/i;

const FIXED_DT = 1 / 60;
const MAX_STEPS = 4;          // never spiral on a long frame

/**
 * @typedef {Object} SpringSettings
 * @property {number} stiffness  0..1 pull back toward rest
 * @property {number} drag       0..1 velocity damping
 * @property {number} gravity    world units/s^2
 * @property {number} radius     collision radius of the bone tip
 */

const DEFAULTS = { stiffness: 0.55, drag: 0.28, gravity: 0.35, radius: 0.02 };

export class SpringBoneSystem {
  /**
   * @param {any} THREE
   * @param {{enabled?:boolean, scale?:number}} [opts]
   */
  constructor(THREE, opts = {}) {
    this.THREE = THREE;
    this.enabled = opts.enabled !== false;
    /** Model scale, so gravity feels right on a 0.1-unit or 100-unit rig. */
    this.scale = opts.scale || 1;
    /** @type {Array<object>} */
    this.joints = [];
    /** @type {Array<{bone:any, offset:any, radius:number}>} */
    this.colliders = [];
    this._accum = 0;
    this.source = 'none';        // 'vrm1' | 'vrm0' | 'auto' | 'none'

    // Scratch vectors — allocating inside the loop would garbage-collect
    // every frame and cause visible hitching.
    this._v = {
      head: new THREE.Vector3(), tail: new THREE.Vector3(), next: new THREE.Vector3(),
      rest: new THREE.Vector3(), dir: new THREE.Vector3(), tmp: new THREE.Vector3(),
      col: new THREE.Vector3(), q: new THREE.Quaternion(), m: new THREE.Matrix4(),
    };
  }

  /**
   * Build the simulation from a loaded glTF.
   * @param {object} gltf   the object returned by GLTFLoader
   * @param {object} root   the scene root
   * @returns {{count:number, source:string}}
   */
  build(gltf, root) {
    this.joints = [];
    this.colliders = [];
    if (!root) return { count: 0, source: 'none' };

    const byName = new Map();
    root.traverse((o) => { if (o.name) byName.set(o.name, o); });

    const ext = gltf?.parser?.json?.extensions || {};
    let chains = this._fromVrm1(ext, gltf, byName)
              || this._fromVrm0(ext, gltf, byName)
              || this._fromNames(root);

    for (const chain of chains) this._addChain(chain.bones, chain.settings);
    return { count: this.joints.length, source: this.source };
  }

  /** VRM 1.0: extensions.VRMC_springBone */
  _fromVrm1(ext, gltf, byName) {
    const vs = ext.VRMC_springBone;
    if (!vs?.springs?.length) return null;
    const nodes = gltf?.parser?.json?.nodes || [];
    const nodeName = (i) => nodes[i]?.name;
    const out = [];

    // Colliders first so chains can reference them.
    for (const cg of vs.colliderGroups || []) {
      for (const ci of cg.colliders || []) {
        const c = (vs.colliders || [])[ci];
        if (!c?.shape?.sphere) continue;
        const b = byName.get(nodeName(c.node));
        if (!b) continue;
        this.colliders.push({
          bone: b,
          offset: new this.THREE.Vector3().fromArray(c.shape.sphere.offset || [0, 0, 0]),
          radius: c.shape.sphere.radius || 0.05,
        });
      }
    }

    for (const spring of vs.springs) {
      const bones = [];
      let settings = { ...DEFAULTS };
      for (const j of spring.joints || []) {
        const b = byName.get(nodeName(j.node));
        if (!b) continue;
        bones.push(b);
        settings = {
          stiffness: j.stiffness ?? settings.stiffness,
          drag: j.dragForce ?? settings.drag,
          gravity: j.gravityPower ?? settings.gravity,
          radius: j.hitRadius ?? settings.radius,
        };
      }
      if (bones.length) out.push({ bones, settings });
    }
    if (!out.length) return null;
    this.source = 'vrm1';
    return out;
  }

  /** VRM 0.x: extensions.VRM.secondaryAnimation */
  _fromVrm0(ext, gltf, byName) {
    const sa = ext.VRM?.secondaryAnimation;
    if (!sa?.boneGroups?.length) return null;
    const nodes = gltf?.parser?.json?.nodes || [];
    const nodeName = (i) => nodes[i]?.name;
    const out = [];

    for (const cg of sa.colliderGroups || []) {
      const b = byName.get(nodeName(cg.node));
      if (!b) continue;
      for (const c of cg.colliders || []) {
        this.colliders.push({
          bone: b,
          offset: new this.THREE.Vector3().fromArray(c.offset ? [c.offset.x || 0, c.offset.y || 0, c.offset.z || 0] : [0, 0, 0]),
          radius: c.radius || 0.05,
        });
      }
    }

    for (const g of sa.boneGroups) {
      const settings = {
        stiffness: g.stiffiness ?? g.stiffness ?? DEFAULTS.stiffness,  // spec typo is real
        drag: g.dragForce ?? DEFAULTS.drag,
        gravity: g.gravityPower ?? DEFAULTS.gravity,
        radius: g.hitRadius ?? DEFAULTS.radius,
      };
      for (const rootIdx of g.bones || []) {
        const rootBone = byName.get(nodeName(rootIdx));
        if (!rootBone) continue;
        const bones = [];
        // Walk down the first-child chain from this root.
        let cur = rootBone;
        while (cur) { bones.push(cur); cur = cur.children?.[0]; }
        if (bones.length) out.push({ bones, settings });
      }
    }
    if (!out.length) return null;
    this.source = 'vrm0';
    return out;
  }

  /**
   * No VRM extension: infer chains from bone names so a plain GLB still gets
   * hair and cloth motion. Conservative — only obvious secondary bones, and
   * never anything in the main humanoid skeleton.
   */
  _fromNames(root) {
    const out = [];
    const seen = new Set();
    root.traverse((o) => {
      if (seen.has(o)) return;
      const n = o.name || '';
      if (!n || NEVER_SPRING.test(n)) return;
      if (!AUTO_SPRING_PATTERNS.some(rx => rx.test(n))) return;
      // Only take the TOP of a chain; children come along with it.
      let p = o.parent, isChild = false;
      while (p) { if (seen.has(p)) { isChild = true; break; } p = p.parent; }
      if (isChild) return;

      const bones = [];
      let cur = o;
      while (cur && bones.length < 12) {
        bones.push(cur); seen.add(cur);
        cur = (cur.children || []).find(c => c.isBone || c.type === 'Bone' || c.type === 'Object3D');
      }
      if (bones.length >= 2) out.push({ bones, settings: { ...DEFAULTS } });
    });
    this.source = out.length ? 'auto' : 'none';
    return out;
  }

  /** Turn a bone chain into simulated joints. */
  _addChain(bones, settings) {
    const T = this.THREE;
    for (let i = 0; i < bones.length - 1; i++) {
      const bone = bones[i];
      const child = bones[i + 1];
      const length = child.position.length();
      if (!length || !Number.isFinite(length)) continue;

      const worldTail = child.getWorldPosition(new T.Vector3());
      this.joints.push({
        bone,
        child,
        length,
        restLocal: child.position.clone().normalize(),
        restQuat: bone.quaternion.clone(),
        prev: worldTail.clone(),
        cur: worldTail.clone(),
        settings: { ...DEFAULTS, ...settings },
      });
    }
  }

  /**
   * Advance the simulation and pose the bones.
   * @param {number} dt seconds since the last render frame
   */
  update(dt) {
    if (!this.enabled || !this.joints.length) return;
    // Fixed timestep: a variable dt makes verlet springs unstable, and a
    // single long frame (tab restore, GC pause) would fling the hair away.
    this._accum += Math.min(dt || 0, 0.25);
    let steps = 0;
    while (this._accum >= FIXED_DT && steps < MAX_STEPS) {
      this._step(FIXED_DT);
      this._accum -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this._accum = 0;   // drop the backlog
  }

  _step(dt) {
    const T = this.THREE;
    const V = this._v;

    for (const j of this.joints) {
      const { bone, settings, length } = j;

      // Head of the bone in world space.
      bone.updateWorldMatrix(true, false);
      V.head.setFromMatrixPosition(bone.matrixWorld);

      // Rest direction = where the tail would sit with no physics.
      V.rest.copy(j.restLocal).multiplyScalar(length);
      V.rest.applyMatrix4(V.m.copy(bone.matrixWorld).setPosition(0, 0, 0));
      V.rest.add(V.head);

      // Verlet: position + inertia + forces.
      V.next.copy(j.cur)
        .add(V.tmp.copy(j.cur).sub(j.prev).multiplyScalar(1 - settings.drag))
        .add(V.tmp.copy(V.rest).sub(j.cur).multiplyScalar(settings.stiffness * 0.5));
      V.next.y -= settings.gravity * dt * dt * 60 * this.scale;

      // Length constraint — the bone cannot stretch.
      V.dir.copy(V.next).sub(V.head);
      const d = V.dir.length() || 1e-6;
      V.next.copy(V.head).add(V.dir.multiplyScalar(length / d));

      // Push out of colliders (head, shoulders, chest…).
      for (const c of this.colliders) {
        V.col.copy(c.offset).applyMatrix4(c.bone.matrixWorld);
        const push = V.tmp.copy(V.next).sub(V.col);
        const dist = push.length();
        const minDist = c.radius + settings.radius;
        if (dist > 1e-6 && dist < minDist) {
          V.next.copy(V.col).add(push.multiplyScalar(minDist / dist));
          // Re-apply the length constraint after pushing out.
          V.dir.copy(V.next).sub(V.head);
          const d2 = V.dir.length() || 1e-6;
          V.next.copy(V.head).add(V.dir.multiplyScalar(length / d2));
        }
      }

      j.prev.copy(j.cur);
      j.cur.copy(V.next);

      // Rotate the bone so its child points at the simulated tail.
      const parentQ = bone.parent
        ? bone.parent.getWorldQuaternion(V.q.set(0, 0, 0, 1)).clone()
        : new T.Quaternion();
      const localTarget = V.tmp.copy(j.cur).sub(V.head)
        .applyQuaternion(parentQ.clone().invert()).normalize();
      const from = j.restLocal;
      bone.quaternion.copy(j.restQuat)
        .multiply(new T.Quaternion().setFromUnitVectors(from, localTarget));
    }
  }

  /** Snap every joint back to its rest pose (used when switching avatars). */
  reset() {
    for (const j of this.joints) {
      j.bone.quaternion.copy(j.restQuat);
      j.bone.updateWorldMatrix(true, false);
      const w = j.child.getWorldPosition(new this.THREE.Vector3());
      j.prev.copy(w); j.cur.copy(w);
    }
    this._accum = 0;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.reset();
    return this.enabled;
  }

  describe() {
    return { joints: this.joints.length, colliders: this.colliders.length,
             source: this.source, enabled: this.enabled };
  }

  dispose() { this.joints = []; this.colliders = []; }
}

export default SpringBoneSystem;
