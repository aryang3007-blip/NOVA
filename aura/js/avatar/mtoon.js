/**
 * AURA :: MToon (VRM cel-shading)
 * ===============================
 * VRM avatars are authored with **MToon**, a toon shader. Loading a VRM with
 * a stock glTF loader gives you `MeshStandardMaterial` — physically-based,
 * smoothly-lit, and completely wrong for the flat anime look the character
 * was designed around. Faces in particular go muddy, because PBR shading
 * puts a soft gradient across the cheek where the artist wanted one clean
 * shadow edge.
 *
 * WHAT THIS DOES
 * --------------
 * Converts the loaded materials into a real cel-shaded material:
 *
 *   • **Stepped diffuse** — lighting is quantised into 2-3 bands instead of a
 *     continuous ramp, with a controllable shade colour and a soft edge.
 *   • **Rim light** — a Fresnel term along the silhouette, which is what
 *     makes VRM characters read against a dark background.
 *   • **Outline** — an inverted-hull back-face pass, the standard toon
 *     outline technique and the one MToon itself uses.
 *
 * WHERE THE PARAMETERS COME FROM
 * ------------------------------
 * VRM declares them in the glTF:
 *   • VRM 1.0 → `materials[i].extensions.VRMC_materials_mtoon`
 *   • VRM 0.x → `extensions.VRM.materialProperties[]` (floats/vectors/textures)
 * We read whichever exists and fall back to sensible defaults, so a plain GLB
 * can also be toon-shaded on request.
 *
 * HONEST SCOPE: this is a faithful *approximation*, not a spec-complete MToon
 * implementation. UV-animation, matcap spheres and multiply-blend shading
 * textures are not implemented. What it does cover is the part you actually
 * see: flat banded shading, the shade colour, rim light and outlines.
 *
 * @module avatar/mtoon
 */

/**
 * @typedef {Object} MToonParams
 * @property {number} shadeShift
 * @property {number} shadeToony
 * @property {number} shadeMultiply
 * @property {number} rimIntensity
 * @property {number} rimFresnelPower
 * @property {number} outlineWidth
 * @property {number} outlineColor
 * @property {number} steps
 * @property {number[]} [shadeColorFactor]    from the VRM extension
 * @property {number[]} [outlineColorFactor]  from the VRM extension
 * @property {string}   [source]              which extension supplied these
 */

/** @type {MToonParams} Defaults used when a model declares no MToon params. */
export const MTOON_DEFAULTS = {
  shadeShift: 0.0,        // where the light/shade boundary sits, -1..1
  shadeToony: 0.9,        // 1 = hard edge, 0 = smooth gradient
  shadeMultiply: 0.72,    // how dark the shade band is
  rimIntensity: 0.35,
  rimFresnelPower: 3.0,
  outlineWidth: 0.0016,   // world units; 0 disables the outline pass
  outlineColor: 0x1a1a22,
  steps: 2,               // number of lighting bands (2 or 3 reads best)
};

const VERT = /* glsl */`
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const FRAG = /* glsl */`
  uniform vec3  uBase;
  uniform vec3  uShade;
  uniform vec3  uRim;
  uniform vec3  uLightDir;
  uniform vec3  uAmbient;
  uniform float uShadeShift;
  uniform float uShadeToony;
  uniform float uRimIntensity;
  uniform float uRimPower;
  uniform float uSteps;
  uniform float uOpacity;
  uniform sampler2D uMap;
  uniform bool  uHasMap;

  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec2 vUv;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 L = normalize(uLightDir);

    // Lambert term remapped so the artist-authored boundary lands where the
    // model expects it, then quantised into bands.
    float ndl = dot(N, L) * 0.5 + 0.5;
    float lit = ndl + uShadeShift;

    float banded;
    if (uSteps <= 1.5) {
      banded = step(0.5, lit);
    } else {
      float s = floor(lit * uSteps) / max(1.0, uSteps - 1.0);
      banded = clamp(s, 0.0, 1.0);
    }
    // uShadeToony blends between a hard step and the raw gradient, which is
    // exactly what MToon's shadingToony parameter controls.
    float shading = mix(smoothstep(0.0, 1.0, lit), banded, uShadeToony);

    vec4 tex = uHasMap ? texture2D(uMap, vUv) : vec4(1.0);
    vec3 base = uBase * tex.rgb;
    vec3 color = mix(uShade * tex.rgb, base, shading);

    // Fresnel rim — the silhouette glow that makes VRM characters pop.
    float fres = pow(1.0 - clamp(dot(N, normalize(vViewDir)), 0.0, 1.0), uRimPower);
    color += uRim * fres * uRimIntensity;

    color += uAmbient * base * 0.25;
    gl_FragColor = vec4(color, tex.a * uOpacity);
    #include <colorspace_fragment>
  }
`;

/**
 * Read MToon parameters for a material out of the glTF JSON.
 * @returns {object} merged with MTOON_DEFAULTS
 */
export function readMToonParams(gltfJson, materialIndex) {
  /** @type {MToonParams} */
  const out = { ...MTOON_DEFAULTS };
  if (!gltfJson || materialIndex == null) return out;

  // VRM 1.0
  const m = gltfJson.materials?.[materialIndex];
  const v1 = m?.extensions?.VRMC_materials_mtoon;
  if (v1) {
    if (v1.shadingShiftFactor != null) out.shadeShift = v1.shadingShiftFactor;
    if (v1.shadingToonyFactor != null) out.shadeToony = v1.shadingToonyFactor;
    if (Array.isArray(v1.shadeColorFactor)) out.shadeColorFactor = v1.shadeColorFactor;
    if (v1.parametricRimLiftFactor != null) out.rimIntensity = v1.parametricRimLiftFactor;
    if (v1.parametricRimFresnelPowerFactor != null) out.rimFresnelPower = v1.parametricRimFresnelPowerFactor;
    if (v1.outlineWidthFactor != null) out.outlineWidth = v1.outlineWidthFactor;
    if (Array.isArray(v1.outlineColorFactor)) out.outlineColorFactor = v1.outlineColorFactor;
    out.source = 'VRMC_materials_mtoon';
    return out;
  }

  // VRM 0.x — flat float/vector maps keyed by name.
  const props = gltfJson.extensions?.VRM?.materialProperties;
  if (Array.isArray(props)) {
    const p = props.find(x => x.name === m?.name) || props[materialIndex];
    if (p && /mtoon/i.test(p.shader || '')) {
      const f = p.floatProperties || {};
      const c = p.vectorProperties || {};
      if (f._ShadeShift != null) out.shadeShift = f._ShadeShift;
      if (f._ShadeToony != null) out.shadeToony = f._ShadeToony;
      if (f._RimLightingMix != null) out.rimIntensity = f._RimLightingMix;
      if (f._RimFresnelPower != null) out.rimFresnelPower = f._RimFresnelPower;
      if (f._OutlineWidth != null) out.outlineWidth = f._OutlineWidth * 0.001;
      if (Array.isArray(c._ShadeColor)) out.shadeColorFactor = c._ShadeColor;
      if (Array.isArray(c._OutlineColor)) out.outlineColorFactor = c._OutlineColor;
      out.source = 'VRM.materialProperties';
      return out;
    }
  }
  out.source = 'defaults';
  return out;
}

/**
 * Replace a mesh's material with a cel-shaded equivalent.
 * @returns {{material:object, outline:object|null}}
 */
export function makeMToonMaterial(THREE, srcMaterial, params, opts = {}) {
  /** @type {MToonParams} */
  const p = { ...MTOON_DEFAULTS, ...params };
  const baseColor = srcMaterial?.color?.clone?.() || new THREE.Color(0xffffff);

  const shade = p.shadeColorFactor
    ? new THREE.Color(p.shadeColorFactor[0], p.shadeColorFactor[1], p.shadeColorFactor[2])
    : baseColor.clone().multiplyScalar(p.shadeMultiply);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: !!srcMaterial?.transparent,
    side: srcMaterial?.side ?? THREE.FrontSide,
    uniforms: {
      uBase: { value: baseColor },
      uShade: { value: shade },
      uRim: { value: new THREE.Color(opts.rimColor ?? 0xbfe6ff) },
      uLightDir: { value: new THREE.Vector3(0.4, 0.9, 0.6).normalize() },
      uAmbient: { value: new THREE.Color(0x223044) },
      uShadeShift: { value: p.shadeShift },
      uShadeToony: { value: p.shadeToony },
      uRimIntensity: { value: p.rimIntensity },
      uRimPower: { value: p.rimFresnelPower },
      uSteps: { value: Math.max(1, p.steps) },
      uOpacity: { value: srcMaterial?.opacity ?? 1 },
      uMap: { value: srcMaterial?.map || null },
      uHasMap: { value: !!srcMaterial?.map },
    },
  });
  material.userData.isMToon = true;

  // Inverted-hull outline: render back faces, pushed out along the normal.
  let outline = null;
  if (p.outlineWidth > 0) {
    const oc = p.outlineColorFactor
      ? new THREE.Color(p.outlineColorFactor[0], p.outlineColorFactor[1], p.outlineColorFactor[2])
      : new THREE.Color(p.outlineColor);
    outline = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uWidth: { value: p.outlineWidth }, uColor: { value: oc } },
      vertexShader: /* glsl */`
        uniform float uWidth;
        void main() {
          vec3 pushed = position + normal * uWidth * 100.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pushed, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        void main() { gl_FragColor = vec4(uColor, 1.0); }`,
    });
    outline.userData.isMToonOutline = true;
  }

  return { material, outline };
}

/**
 * Convert every mesh in a loaded model to MToon.
 *
 * @param {any} THREE
 * @param {object} root       scene root
 * @param {object} gltf       the GLTFLoader result (for extension data)
 * @param {{force?:boolean, rimColor?:number}} [opts]
 *        force=true toon-shades a plain GLB that declares no MToon data.
 * @returns {{converted:number, outlines:number, source:string, applied:boolean}}
 */
export function applyMToon(THREE, root, gltf, opts = {}) {
  const json = gltf?.parser?.json || null;
  const isVrm = !!(json?.extensions?.VRM || json?.extensions?.VRMC_vrm ||
                   json?.extensions?.VRMC_materials_mtoon ||
                   (json?.materials || []).some(m => m?.extensions?.VRMC_materials_mtoon));

  // Don't silently restyle a non-VRM model unless explicitly asked.
  if (!isVrm && !opts.force) {
    return { converted: 0, outlines: 0, source: 'not-a-vrm', applied: false };
  }

  let converted = 0, outlines = 0, source = 'defaults';
  const originals = [];

  // Snapshot the meshes BEFORE mutating. Outline shells are added as children
  // of the meshes they outline, so converting during a live traverse() makes
  // it walk into the shells it just created — infinite recursion, "Maximum
  // call stack size exceeded". Collect first, then modify.
  const meshes = [];
  root.traverse((o) => {
    if ((o.isMesh || o.isSkinnedMesh) && !o.userData?.isMToonOutline) meshes.push(o);
  });

  meshes.forEach((o) => {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const next = [];

    mats.forEach((srcMat, i) => {
      if (!srcMat || srcMat.userData?.isMToon) { next.push(srcMat); return; }
      // Find this material's index in the glTF so we can read its extension.
      const idx = (json?.materials || []).findIndex(m => m?.name && m.name === srcMat.name);
      const params = readMToonParams(json, idx >= 0 ? idx : null);
      if (params.source !== 'defaults') source = params.source;

      const { material, outline } = makeMToonMaterial(THREE, srcMat, params, opts);
      originals.push({ mesh: o, index: i, material: srcMat });
      next.push(material);
      converted++;

      if (outline) {
        // A second mesh sharing the same geometry and skeleton.
        //
        // It is attached as a SIBLING, not a child. Parenting the shell under
        // the mesh it outlines makes every later traverse() walk into it —
        // and because the shell is itself a mesh, converting again recurses
        // without end ("Maximum call stack size exceeded"). As a sibling it
        // inherits the same parent transform and stays invisible to the
        // mesh-collection pass, which filters on isMToonOutline.
        const shell = o.isSkinnedMesh
          ? new THREE.SkinnedMesh(o.geometry, outline)
          : new THREE.Mesh(o.geometry, outline);
        if (o.isSkinnedMesh && o.skeleton) shell.bind(o.skeleton, o.bindMatrix);
        shell.name = `${o.name}__outline`;
        shell.userData.isMToonOutline = true;
        shell.userData.outlineFor = o.uuid;
        shell.renderOrder = -1;
        // Mirror the mesh's own transform so the hull lines up exactly.
        shell.position.copy(o.position);
        shell.quaternion.copy(o.quaternion);
        shell.scale.copy(o.scale);
        (o.parent || root).add(shell);
        outlines++;
      }
    });

    o.material = Array.isArray(o.material) ? next : next[0];
  });

  root.userData.__mtoonOriginals = originals;
  return { converted, outlines, source, applied: converted > 0 };
}

/** Restore the original PBR materials and drop the outline shells. */
export function removeMToon(root) {
  if (!root) return 0;
  const shells = [];
  root.traverse((o) => { if (o.userData?.isMToonOutline) shells.push(o); });
  shells.forEach(s => s.parent?.remove(s));

  const originals = root.userData?.__mtoonOriginals || [];
  for (const { mesh, index, material } of originals) {
    if (Array.isArray(mesh.material)) mesh.material[index] = material;
    else mesh.material = material;
  }
  root.userData.__mtoonOriginals = null;
  return originals.length;
}

/** Keep the toon light direction aligned with the scene's key light. */
export function setMToonLight(root, dirVec3) {
  if (!root || !dirVec3) return;
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m?.userData?.isMToon) m.uniforms.uLightDir.value.copy(dirVec3).normalize();
    }
  });
}

export default { applyMToon, removeMToon, readMToonParams, makeMToonMaterial,
                 setMToonLight, MTOON_DEFAULTS };
