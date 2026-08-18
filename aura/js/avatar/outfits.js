/**
 * AURA :: Outfit & Personalisation System
 * ---------------------------------------
 * Garments are separate meshes parented to skeleton bones, so they follow
 * the rig exactly. Swapping an outfit rebuilds only the garment meshes —
 * the body and animation state are untouched.
 *
 * Everything is procedural geometry: zero downloads, works fully offline.
 */

export const PALETTES = {
  cyan:    { label: 'Cyan',    accent: 0x38bdf8, body: 0x0d3550, cloth: 0x123a55, trim: 0x7ee0ff },
  violet:  { label: 'Violet',  accent: 0xa78bfa, body: 0x241a45, cloth: 0x2e2160, trim: 0xd6c6ff },
  emerald: { label: 'Emerald', accent: 0x34d399, body: 0x0c3a2c, cloth: 0x11463a, trim: 0x9df5d4 },
  amber:   { label: 'Amber',   accent: 0xffa726, body: 0x40270c, cloth: 0x543313, trim: 0xffd79a },
  crimson: { label: 'Crimson', accent: 0xff4d6d, body: 0x40121f, cloth: 0x551a2a, trim: 0xffb3c1 },
  mono:    { label: 'Mono',    accent: 0xe2e8f0, body: 0x22262d, cloth: 0x2f343d, trim: 0xffffff },
  gold:    { label: 'Gold',    accent: 0xf59e0b, body: 0x3d2706, cloth: 0x472e0a, trim: 0xfcd34d },
  neon:    { label: 'Neon',    accent: 0xf43f5e, body: 0x270718, cloth: 0x3b0b23, trim: 0x38bdf8 },
  obsidian:{ label: 'Obsidian',accent: 0xe11d48, body: 0x111116, cloth: 0x1a1a24, trim: 0xf43f5e },
};


/**
 * BODY PRESETS ("gender").
 *
 * Deliberately proportion presets rather than a binary switch: each entry
 * scales existing bones, so the SAME rig and the same animations drive every
 * body. No extra meshes, no duplicate skeleton, nothing to keep in sync.
 *
 * `shoulders`/`hips`/`chest`/`waist` are multipliers applied to the rig's
 * default scale; `height` scales the whole figure.
 */
export const BODY_PRESETS = {
  neutral:   { label: 'Neutral',   height: 1.00, shoulders: 1.00, chest: 1.00, waist: 1.00, hips: 1.00 },
  masculine: { label: 'Masculine', height: 1.03, shoulders: 1.14, chest: 1.10, waist: 0.94, hips: 0.94 },
  feminine:  { label: 'Feminine',  height: 0.97, shoulders: 0.90, chest: 0.97, waist: 0.86, hips: 1.14 },
  athletic:  { label: 'Athletic',  height: 1.02, shoulders: 1.10, chest: 1.06, waist: 0.88, hips: 1.00 },
  slim:      { label: 'Slim',      height: 1.01, shoulders: 0.94, chest: 0.92, waist: 0.86, hips: 0.92 },
  heavy:     { label: 'Sturdy',    height: 0.99, shoulders: 1.08, chest: 1.16, waist: 1.18, hips: 1.10 },
};

/** Hairstyles. Procedural geometry parented to the head bone. */
export const HAIRSTYLES = {
  none:      { label: 'None (bare)' },
  short:     { label: 'Short crop' },
  buzz:      { label: 'Buzz cut' },
  swept:     { label: 'Swept back' },
  bob:       { label: 'Bob' },
  long:      { label: 'Long' },
  ponytail:  { label: 'Ponytail' },
  bun:       { label: 'Top bun' },
  mohawk:    { label: 'Mohawk' },
  afro:      { label: 'Afro' },
};

/** Hair colours, independent of the outfit palette. */
export const HAIR_COLORS = {
  match:    { label: 'Match theme', color: null },
  black:    { label: 'Black',       color: 0x1a1a20 },
  brown:    { label: 'Brown',       color: 0x4a2c17 },
  blonde:   { label: 'Blonde',      color: 0xd9b26a },
  auburn:   { label: 'Auburn',      color: 0x7a2e1b },
  silver:   { label: 'Silver',      color: 0xc8d2dc },
  white:    { label: 'White',       color: 0xf0f4f8 },
  blue:     { label: 'Electric',    color: 0x38bdf8 },
  pink:     { label: 'Pink',        color: 0xff6fb5 },
  green:    { label: 'Neon green',  color: 0x34d399 },
  violet:   { label: 'Violet',      color: 0xa78bfa },
};

/**
 * Apply a body preset by scaling bones.
 * Returns the preset used so callers can report it.
 */
export function applyBodyPreset(bones, presetId) {
  const p = BODY_PRESETS[presetId] || BODY_PRESETS.neutral;
  const set = (bone, x, y, z) => { if (bone) bone.scale.set(x, y, z); };
  // Torso silhouette
  set(bones.chest,    p.chest,     1, p.chest * 0.95);
  set(bones.spine,    p.waist,     1, p.waist * 0.95);
  set(bones.hips,     p.hips,      1, p.hips * 0.95);
  // Shoulder width comes from the clavicle bones
  set(bones.shoulderL, p.shoulders, 1, 1);
  set(bones.shoulderR, p.shoulders, 1, 1);
  // Overall height on the root
  if (bones.root) bones.root.scale.set(1, p.height, 1);
  return p;
}

/**
 * Build hair meshes for the head bone.
 * @returns {Array} meshes, so they can be disposed on swap
 */
export function buildHair(THREE, bones, hairId, colorId, paletteId) {
  const head = bones.head;
  if (!head || !hairId || hairId === 'none') return [];

  const pal = PALETTES[paletteId] || PALETTES.cyan;
  const spec = HAIR_COLORS[colorId] || HAIR_COLORS.match;
  const col = spec.color ?? pal.accent;

  const hairMat = new THREE.MeshStandardMaterial({
    color: col, roughness: 0.72, metalness: 0.06,
    emissive: col, emissiveIntensity: 0.06, flatShading: false,
  });

  const out = [];
  const add = (geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, hairMat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.scale.set(sx, sy, sz);
    head.add(m);
    out.push(m);
    return m;
  };

  // Skull cap shared by most styles: a hemisphere sitting on the head.
  const cap = (scaleY = 1, phi = Math.PI * 0.56) =>
    add(new THREE.SphereGeometry(0.207, 24, 16, 0, Math.PI * 2, 0, phi),
        0, 0.176, 0, 0, 0, 0, 0.88, 1.12 * scaleY, 0.93);

  switch (hairId) {
    case 'buzz':
      cap(0.72, Math.PI * 0.46);
      break;

    case 'short':
      cap(0.92);
      // slight fringe
      add(new THREE.SphereGeometry(0.1, 14, 10), 0, 0.235, 0.15, 0, 0, 0, 1.5, 0.5, 0.7);
      break;

    case 'swept':
      cap(0.95);
      add(new THREE.SphereGeometry(0.12, 16, 12), 0, 0.25, -0.03, -0.35, 0, 0, 1.35, 0.6, 1.25);
      break;

    case 'bob':
      cap(1.0);
      for (const side of [-1, 1]) {
        add(new THREE.CapsuleGeometry(0.062, 0.16, 4, 12),
            side * 0.155, 0.09, -0.01, 0, 0, side * 0.12, 1, 1, 0.75);
      }
      add(new THREE.SphereGeometry(0.11, 16, 12), 0, 0.13, -0.15, 0, 0, 0, 1.5, 1.0, 0.7);
      break;

    case 'long':
      cap(1.0);
      for (const side of [-1, 1]) {
        add(new THREE.CapsuleGeometry(0.062, 0.34, 4, 12),
            side * 0.15, -0.02, -0.02, 0, 0, side * 0.06, 1, 1, 0.7);
      }
      add(new THREE.CapsuleGeometry(0.105, 0.3, 4, 14), 0, -0.03, -0.13, 0, 0, 0, 1.3, 1, 0.55);
      break;

    case 'ponytail':
      cap(0.95);
      add(new THREE.CapsuleGeometry(0.052, 0.30, 4, 12), 0, 0.03, -0.19, 0.38, 0, 0);
      add(new THREE.TorusGeometry(0.05, 0.014, 8, 16), 0, 0.15, -0.16, Math.PI / 2, 0, 0);
      break;

    case 'bun':
      cap(0.9);
      add(new THREE.SphereGeometry(0.075, 16, 14), 0, 0.31, -0.05);
      add(new THREE.TorusGeometry(0.062, 0.013, 8, 18), 0, 0.275, -0.04, Math.PI / 2, 0, 0);
      break;

    case 'mohawk':
      // strip of increasing then decreasing height along the skull
      for (let i = 0; i < 7; i++) {
        const t = i / 6;
        const h = 0.09 + Math.sin(t * Math.PI) * 0.13;
        add(new THREE.BoxGeometry(0.045, h, 0.055),
            0, 0.235 + h * 0.35, 0.115 - t * 0.235);
      }
      break;

    case 'afro':
      add(new THREE.SphereGeometry(0.235, 20, 16), 0, 0.2, -0.01, 0, 0, 0, 1.02, 0.98, 1.02);
      break;

    default:
      cap(0.95);
  }
  return out;
}

export const OUTFITS = {
  none:      { label: 'Hologram (no clothing)', desc: 'Pure wireframe form.' },
  suit:      { label: 'Tactical Suit',  desc: 'Fitted bodysuit with chest plate and belt.' },
  jacket:    { label: 'Flight Jacket',  desc: 'Bomber jacket, collar and cuffs.' },
  hoodie:    { label: 'Hoodie',         desc: 'Loose hoodie with hood down and pocket.' },
  armor:     { label: 'Exo Armor',      desc: 'Pauldrons, chest plate, greaves.' },
  labcoat:   { label: 'Lab Coat',       desc: 'Open coat with long panels.' },
  formal:    { label: 'Formal',         desc: 'Blazer, lapels and slacks.' },
  cyberpunk: { label: 'Cyberpunk',      desc: 'High-collar neon jacket with plasma seams.' },
  solarpunk: { label: 'Solarpunk',      desc: 'Bioluminescent draped robe.' },
  astral:    { label: 'Astral Armor',   desc: 'Celestial pauldrons with star emblem.' },
  stealth:   { label: 'Stealth Ops',    desc: 'Shadow suit with energy lines.' },
};

export const ACCESSORIES = {
  none:    { label: 'None' },
  visor:   { label: 'HUD Visor' },
  halo:    { label: 'Orbit Halo' },
  headset: { label: 'Headset' },
  cape:    { label: 'Cape' },
  crown:   { label: 'Cyber Crown' },
  wings:   { label: 'Energy Wings' },
  goggles: { label: 'Tactical Goggles' },
};

/**
 * @param {any} THREE
 * @param {number} color
 * @param {{opacity?:number, ei?:number, flat?:boolean, emissive?:number}} [opts]
 */
function mat(THREE, color, { opacity = 0.72, ei = 0.28, flat = true, emissive } = {}) {
  return new THREE.MeshPhongMaterial({
    color, emissive: emissive ?? color, emissiveIntensity: ei,
    transparent: true, opacity, shininess: 70, specular: 0x88e5ff, flatShading: flat,
  });
}

/**
 * Build the garment meshes for an outfit.
 * @returns {Array} meshes (kept so they can be disposed on swap)
 */
export function buildOutfit(THREE, bones, outfitId, paletteId) {
  const pal = PALETTES[paletteId] || PALETTES.cyan;
  const out = [];
  const cloth = mat(THREE, pal.cloth, { opacity: .78, ei: .2 });
  const trim = mat(THREE, pal.trim, { opacity: .9, ei: .5 });
  const accent = mat(THREE, pal.accent, { opacity: .85, ei: .55 });

  const attach = (bone, geo, material, pos = [0, 0, 0], rot = [0, 0, 0], scale) => {
    if (!bones[bone]) return null;
    const m = new THREE.Mesh(geo, material);
    m.position.set(...pos);
    m.rotation.set(...rot);
    if (scale) m.scale.set(...scale);
    bones[bone].add(m);
    out.push(m);
    return m;
  };

  if (outfitId === 'none') return out;

  const O = outfitId;

  // ── torso garment
  if (O === 'suit' || O === 'armor' || O === 'formal' || O === 'jacket' || O === 'hoodie' || O === 'labcoat') {
    const bulk = O === 'hoodie' ? .045 : O === 'jacket' ? .035 : O === 'armor' ? .05 : .022;
    attach('chest', new THREE.CapsuleGeometry(.148 + bulk, .19, 4, 18), cloth, [0, .09, 0]);
    attach('spine', new THREE.CapsuleGeometry(.118 + bulk * .8, .21, 4, 18), cloth, [0, .1, 0]);
  }

  // ── chest detail
  if (O === 'suit') {
    attach('chest', new THREE.CylinderGeometry(.04, .04, .02, 20), accent, [0, .13, .14], [Math.PI / 2, 0, 0]);
    attach('chest', new THREE.BoxGeometry(.24, .01, .01), trim, [0, .03, .15]);
    attach('hips', new THREE.TorusGeometry(.135, .015, 6, 24), trim, [0, .0, 0], [Math.PI / 2, 0, 0]);
    attach('hips', new THREE.BoxGeometry(.055, .035, .018), accent, [0, .0, .13]);
  }
  if (O === 'armor') {
    attach('chest', new THREE.BoxGeometry(.26, .24, .1), mat(THREE, pal.accent, { opacity: .5, ei: .45 }), [0, .1, .06]);
    attach('chest', new THREE.CylinderGeometry(.038, .038, .025, 6), trim, [0, .13, .12], [Math.PI / 2, 0, 0]);
    for (const s of ['L', 'R']) {
      attach(`shoulder${s}`, new THREE.SphereGeometry(.088, 12, 10, 0, Math.PI * 2, 0, Math.PI / 2),
        mat(THREE, pal.accent, { opacity: .6, ei: .4 }), [(s === 'L' ? 1 : -1) * .03, .01, 0]);
      attach(`shin${s}`, new THREE.CapsuleGeometry(.064, .2, 4, 12), cloth, [0, -.21, 0]);
      attach(`foreArm${s}`, new THREE.CapsuleGeometry(.047, .12, 4, 10), cloth, [0, -.14, 0]);
    }
  }
  if (O === 'jacket') {
    for (const s of ['L', 'R']) {
      attach(`upperArm${s}`, new THREE.CapsuleGeometry(.056, .24, 4, 12), cloth, [0, -.145, 0]);
      attach(`foreArm${s}`, new THREE.CapsuleGeometry(.047, .15, 4, 12), cloth, [0, -.11, 0]);
      attach(`foreArm${s}`, new THREE.TorusGeometry(.042, .01, 6, 16), trim, [0, -.21, 0], [Math.PI / 2, 0, 0]);
    }
    attach('chest', new THREE.TorusGeometry(.095, .022, 6, 20, Math.PI), trim, [0, .19, .04], [1.35, 0, 0]);
    attach('chest', new THREE.BoxGeometry(.012, .28, .012), trim, [0, .07, .155]);
  }
  if (O === 'hoodie') {
    for (const s of ['L', 'R']) {
      attach(`upperArm${s}`, new THREE.CapsuleGeometry(.062, .24, 4, 12), cloth, [0, -.145, 0]);
      attach(`foreArm${s}`, new THREE.CapsuleGeometry(.053, .2, 4, 12), cloth, [0, -.13, 0]);
    }
    // hood bunched at the back
    attach('neck', new THREE.SphereGeometry(.115, 14, 12, 0, Math.PI * 2, 0, Math.PI * .6),
      cloth, [0, .04, -.08], [-.5, 0, 0]);
    // front pocket
    attach('spine', new THREE.BoxGeometry(.16, .08, .03), mat(THREE, pal.cloth, { opacity: .9, ei: .16 }), [0, .04, .13]);
  }
  if (O === 'labcoat') {
    for (const side of [-1, 1]) {
      attach('spine', new THREE.BoxGeometry(.11, .5, .025),
        mat(THREE, 0xe8f4ff, { opacity: .35, ei: .1 }), [side * .08, -.08, .11]);
    }
    attach('chest', new THREE.BoxGeometry(.07, .045, .018), accent, [-.09, .09, .15]);
    for (const s of ['L', 'R']) attach(`upperArm${s}`, new THREE.CapsuleGeometry(.054, .22, 4, 12),
      mat(THREE, 0xe8f4ff, { opacity: .32, ei: .1 }), [0, -.14, 0]);
  }
  if (O === 'formal') {
    attach('chest', new THREE.BoxGeometry(.038, .17, .015), trim, [0, .07, .152]);        // tie
    for (const side of [-1, 1]) {
      attach('chest', new THREE.BoxGeometry(.07, .17, .015),
        mat(THREE, pal.cloth, { opacity: .92, ei: .14 }), [side * .075, .09, .148], [0, 0, side * .14]);
      attach(`thigh${side > 0 ? 'L' : 'R'}`, new THREE.CapsuleGeometry(.078, .32, 4, 12), cloth, [0, -.22, 0]);
    }
    for (const s of ['L', 'R']) attach(`upperArm${s}`, new THREE.CapsuleGeometry(.056, .24, 4, 12), cloth, [0, -.145, 0]);
  }

  if (O === 'cyberpunk') {
    attach('chest', new THREE.TorusGeometry(.14, .025, 8, 24, Math.PI * 1.2), accent, [0, .2, .02], [1.2, 0, 0]);
    for (const s of ['L', 'R']) {
      attach(`upperArm${s}`, new THREE.CapsuleGeometry(.06, .24, 4, 12), cloth, [0, -.145, 0]);
      attach(`shoulder${s}`, new THREE.BoxGeometry(.12, .06, .1), trim, [0, .04, 0]);
    }
  }
  if (O === 'solarpunk') {
    attach('chest', new THREE.CylinderGeometry(.16, .22, .4, 16, 1, true), cloth, [0, -.05, 0]);
    attach('chest', new THREE.TorusGeometry(.15, .015, 6, 20), accent, [0, .14, 0], [Math.PI / 2, 0, 0]);
  }
  if (O === 'astral') {
    attach('chest', new THREE.OctahedronGeometry(.06), accent, [0, .12, .14]);
    for (const s of ['L', 'R']) {
      attach(`shoulder${s}`, new THREE.ConeGeometry(.08, .12, 5), trim, [(s === 'L' ? 1 : -1) * .04, .06, 0], [0, 0, (s === 'L' ? -1 : 1) * .4]);
    }
  }
  if (O === 'stealth') {
    attach('chest', new THREE.CapsuleGeometry(.14, .25, 4, 16), cloth, [0, .05, 0]);
    for (const s of ['L', 'R']) {
      attach(`foreArm${s}`, new THREE.CylinderGeometry(.045, .04, .18), trim, [0, -.12, 0]);
      attach(`shin${s}`, new THREE.CylinderGeometry(.055, .048, .28), trim, [0, -.18, 0]);
    }
  }

  // ── legs for suit
  if (O === 'suit' || O === 'cyberpunk' || O === 'stealth') {
    for (const s of ['L', 'R']) {
      attach(`thigh${s}`, new THREE.CapsuleGeometry(.076, .32, 4, 12), cloth, [0, -.22, 0]);
      attach(`shin${s}`, new THREE.CapsuleGeometry(.06, .32, 4, 12), cloth, [0, -.21, 0]);
      attach(`shin${s}`, new THREE.TorusGeometry(.056, .01, 6, 16), trim, [0, -.05, 0], [Math.PI / 2, 0, 0]);
    }
  }

  return out;
}

/** Accessories are built separately so they can be toggled independently. */
export function buildAccessory(THREE, bones, accId, paletteId) {
  const pal = PALETTES[paletteId] || PALETTES.cyan;
  const out = [];
  if (!accId || accId === 'none' || (!bones.head && !bones.chest)) return out;

  const add = (bone, geo, material, pos = [0, 0, 0], rot = [0, 0, 0]) => {
    if (!bones[bone]) return null;
    const m = new THREE.Mesh(geo, material);
    m.position.set(...pos); m.rotation.set(...rot);
    bones[bone].add(m); out.push(m); return m;
  };
  const glow = mat(THREE, pal.accent, { opacity: .65, ei: .8 });
  const solid = mat(THREE, pal.cloth, { opacity: .9, ei: .3 });

  if (accId === 'visor') {
    add('head', new THREE.BoxGeometry(.25, .06, .025),
      new THREE.MeshBasicMaterial({ color: pal.accent, transparent: true, opacity: .45 }), [0, .2, .18]);
    add('head', new THREE.BoxGeometry(.27, .01, .01), glow, [0, .235, .185]);
  }
  if (accId === 'halo') {
    const halo = add('head', new THREE.TorusGeometry(.17, .008, 8, 48), glow, [0, .35, 0], [Math.PI / 2, 0, 0]);
    if (halo) halo.userData.spin = true;
  }
  if (accId === 'headset') {
    add('head', new THREE.TorusGeometry(.2, .012, 8, 28, Math.PI), solid, [0, .18, 0], [0, 0, 0]);
    for (const side of [-1, 1]) add('head', new THREE.CylinderGeometry(.042, .042, .03, 14), solid,
      [side * .19, .18, 0], [0, 0, Math.PI / 2]);
    add('head', new THREE.CapsuleGeometry(.007, .075, 4, 8), glow, [.17, .14, .1], [0, 0, -.7]);
  }
  if (accId === 'cape') {
    const cape = add('chest', new THREE.PlaneGeometry(.36, .85, 6, 10),
      new THREE.MeshPhongMaterial({ color: pal.accent, emissive: pal.accent, emissiveIntensity: .25,
        transparent: true, opacity: .3, side: THREE.DoubleSide, flatShading: true }), [0, -.2, -.13]);
    if (cape) cape.userData.cloth = true;
  }
  if (accId === 'crown') {
    add('head', new THREE.CylinderGeometry(.16, .14, .05, 7, 1, true), glow, [0, .32, 0]);
  }
  if (accId === 'wings') {
    for (const side of [-1, 1]) {
      add('chest', new THREE.BoxGeometry(.35, .08, .01), glow, [side * .22, .1, -.14], [0, 0, side * .35]);
    }
  }
  if (accId === 'goggles') {
    for (const side of [-1, 1]) {
      add('head', new THREE.CylinderGeometry(.045, .045, .02, 16), solid, [side * .08, .21, .17], [Math.PI / 2, 0, 0]);
    }
  }
  return out;
}

export default {
  OUTFITS, PALETTES, ACCESSORIES, HAIRSTYLES, HAIR_COLORS, BODY_PRESETS,
  buildOutfit, buildAccessory, buildHair, applyBodyPreset,
};
