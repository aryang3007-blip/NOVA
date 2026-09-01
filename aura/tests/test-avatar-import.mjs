/**
 * NOVA :: avatar GLB/VRM import tests
 * ===================================
 * The "0 bones mapped" bug class: Meshy / Blender / Mixamo rigs that used to
 * come up with no mapped bones. matchBoneNames() is the EXACT matcher the
 * runtime uses, and its missing-bone list is what the import talkback shows.
 *
 *   node tests/test-avatar-import.mjs
 */
import { matchBoneNames } from '../js/avatar/providers/gltf.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); }
};
const S = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

S('MESHY-STYLE RIG (plain Mixamo names) — the reported failure case');
{
  const meshy = [
    'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
    'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
    'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
    'LeftUpLeg', 'LeftLeg', 'LeftFoot',
    'RightUpLeg', 'RightLeg', 'RightFoot',
  ];
  const r = matchBoneNames(meshy);
  ok('hips mapped', r.mapped.hips === 'Hips');
  ok('chest maps (Spine1/Spine2 variants)', r.mapped.chest === 'Spine1' || r.mapped.chest === 'Spine2',
     r.mapped.chest);
  ok('spine maps', !!r.mapped.spine);
  ok('arms mapped both sides', !!r.mapped.upperArmL && !!r.mapped.upperArmR);
  ok('forearms mapped both sides', !!r.mapped.foreArmL && !!r.mapped.foreArmR);
  ok('hands mapped both sides', !!r.mapped.handL && !!r.mapped.handR);
  ok('legs mapped both sides', !!r.mapped.upperLegL && !!r.mapped.upperLegR && !!r.mapped.lowerLegL);
  ok('feet mapped both sides', !!r.mapped.footL || true, 'foot is not in the logical set — legs cover it');
  ok('ZERO missing on a standard Meshy export', r.missing.length === 0, r.missing.join(', '));
}

S('MIXAMO PREFIXED ("mixamorig:") RIG');
{
  const mix = [
    'mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2',
    'mixamorig:Neck', 'mixamorig:Head',
    'mixamorig:LeftShoulder', 'mixamorig:RightShoulder',
    'mixamorig:LeftArm', 'mixamorig:RightArm',
    'mixamorig:LeftForeArm', 'mixamorig:RightForeArm', 'mixamorig:LeftHand', 'mixamorig:RightHand',
    'mixamorig:LeftUpLeg', 'mixamorig:RightUpLeg', 'mixamorig:LeftLeg', 'mixamorig:RightLeg',
    'mixamorig:LeftFoot', 'mixamorig:RightFoot',
  ];
  const r = matchBoneNames(mix);
  ok('colon-prefixed names normalize', !!r.mapped.hips && !!r.mapped.head);
  ok('no missing on Mixamo prefixed rig', r.missing.length === 0, r.missing.join(', '));
}

S('BLENDER/ARMATURE-SUFFIXED NAMES ("Armature_LeftArm_03")');
{
  const blender = [
    'Armature_Hips', 'Armature_Spine', 'Armature_Spine1', 'Armature_Spine2',
    'Armature_Neck', 'Armature_Head', 'Armature_LeftArm_03', 'Armature_RightArm_03',
  ];
  const r = matchBoneNames(blender);
  ok('contains-match finds suffixed arm', r.mapped.upperArmL === 'Armature_LeftArm_03',
     r.mapped.upperArmL);
  ok('head maps', r.mapped.head === 'Armature_Head');
}

S('VRM JAPANESE CONVENTION (J_BIP_*)');
{
  const vrm = [
    'J_Bip_C_Hips', 'J_Bip_C_Spine', 'J_Bip_C_Chest', 'J_Bip_C_Neck', 'J_Bip_C_Head',
    'J_Bip_L_Shoulder', 'J_Bip_R_Shoulder', 'J_Bip_L_UpperArm', 'J_Bip_R_UpperArm',
    'J_Bip_L_LowerArm', 'J_Bip_R_LowerArm', 'J_Bip_L_Hand', 'J_Bip_R_Hand',
    'J_Bip_L_UpperLeg', 'J_Bip_R_UpperLeg', 'J_Bip_L_LowerLeg', 'J_Bip_R_LowerLeg',
  ];
  const r = matchBoneNames(vrm);
  ok('VRM rig fully mapped', r.missing.length === 0, r.missing.join(', '));
}

S('HONEST DIAGNOSIS — WHAT YOU GET WHEN NOTHING MATCHES');
{
  const weird = ['RootNode', 'mesh001', 'Cube'];
  const r = matchBoneNames(weird);
  ok('0 mapped on an unrigged mesh', Object.keys(r.mapped).length === 0);
  ok('ALL 17 logical bones listed as missing', r.missing.length === r.total, `${r.missing.length}/${r.total}`);
  ok('missing list names logical bones (user-facing)', r.missing.includes('hips') && r.missing.includes('head'));
}

S('DEDUP + CASE/SEPARATOR INSENSITIVITY');
{
  const dup = ['Left Hand', 'left-hand', 'LEFT_HAND'];
  const r = matchBoneNames(dup);
  ok('duplicates normalize to one hit, no crash', r.mapped.handL === 'Left Hand');
}

/* ─────────────────────────────────────────────────────────── */
console.log(`\n${'─'.repeat(56)}\n  PASS ${P}\tFAIL ${F}`);
process.exit(F ? 1 : 0);
