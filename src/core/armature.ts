import * as THREE from 'three';
import { Mesh } from './mesh';
import { V3 } from './vec';

/**
 * Armatures live in a SceneObject next to a "joint mesh": every bone end is a
 * vertex of `obj.mesh` and every bone is a loose edge between its head and tail
 * vertex. Edit mode therefore reuses all vertex selection / transform tools;
 * the bone list below adds names, hierarchy, roll and the pose.
 *
 * Bone frames follow the usual convention: origin at the head, +Y pointing to
 * the tail, roll spinning the frame around Y.
 */

export type Quat = [number, number, number, number];

export interface PoseXf {
  rot: Quat;
  loc: V3;
  scale: V3;
}

export interface Bone {
  name: string;
  /** index into bones, -1 for a root */
  parent: number;
  /** joint vertex indices in the armature's mesh */
  head: number;
  tail: number;
  /** radians around the bone's Y axis */
  roll: number;
  /** contributes to skin deformation (and gets a vertex group) */
  deform: boolean;
  pose: PoseXf;
}

export interface Armature {
  bones: Bone[];
  /** pose-mode selection */
  selected: number[];
  active: number;
}

export const identityPose = (): PoseXf => ({ rot: [0, 0, 0, 1], loc: [0, 0, 0], scale: [1, 1, 1] });
export const isIdentityPose = (p: PoseXf) =>
  Math.abs(p.rot[0]) + Math.abs(p.rot[1]) + Math.abs(p.rot[2]) < 1e-9 && Math.abs(p.loc[0]) + Math.abs(p.loc[1]) + Math.abs(p.loc[2]) < 1e-9 && p.scale.every((s) => Math.abs(s - 1) < 1e-9);

export function newArmature(): Armature { return { bones: [], selected: [], active: -1 }; }

export function clonePose(p: PoseXf): PoseXf { return { rot: [...p.rot] as Quat, loc: [...p.loc] as V3, scale: [...p.scale] as V3 }; }

export function cloneArmature(a: Armature): Armature {
  return { bones: a.bones.map((b) => ({ ...b, pose: clonePose(b.pose) })), selected: a.selected.slice(), active: a.active };
}

export function armatureFromJSON(j: any): Armature {
  return {
    bones: (j?.bones ?? []).map((b: any) => ({
      name: String(b.name), parent: b.parent ?? -1, head: b.head, tail: b.tail, roll: b.roll ?? 0, deform: b.deform !== false,
      pose: b.pose ? { rot: [...b.pose.rot] as Quat, loc: [...b.pose.loc] as V3, scale: [...b.pose.scale] as V3 } : identityPose(),
    })),
    selected: (j?.selected ?? []).slice(),
    active: j?.active ?? -1,
  };
}

/** A fresh armature object's data: one bone, 1 unit tall. */
export function singleBoneArmature(): { mesh: Mesh; arm: Armature } {
  const mesh = new Mesh();
  mesh.addVert([0, 0, 0]);
  mesh.addVert([0, 1, 0]);
  mesh.looseEdges.push([0, 1]);
  mesh.changed();
  const arm = newArmature();
  arm.bones.push({ name: 'Bone', parent: -1, head: 0, tail: 1, roll: 0, deform: true, pose: identityPose() });
  return { mesh, arm };
}

/** Parent-first ordering (robust to any storage order). */
export function boneOrder(arm: Armature): number[] {
  const out: number[] = [];
  const state = new Uint8Array(arm.bones.length);
  const visit = (i: number) => {
    if (state[i]) return;
    state[i] = 1;
    const p = arm.bones[i].parent;
    if (p >= 0 && p < arm.bones.length && p !== i) visit(p);
    out.push(i);
  };
  arm.bones.forEach((_, i) => visit(i));
  return out;
}

export function boneLength(mesh: Mesh, b: Bone): number {
  const h = mesh.verts[b.head], t = mesh.verts[b.tail];
  return h && t ? Math.hypot(t[0] - h[0], t[1] - h[1], t[2] - h[2]) : 0;
}

const Y = new THREE.Vector3(0, 1, 0);

/** Rest frame of a bone in armature space. */
export function restMatrix(mesh: Mesh, b: Bone): THREE.Matrix4 {
  const h = mesh.verts[b.head] ?? [0, 0, 0], t = mesh.verts[b.tail] ?? [0, 1, 0];
  const dir = new THREE.Vector3(t[0] - h[0], t[1] - h[1], t[2] - h[2]);
  if (dir.lengthSq() < 1e-14) dir.copy(Y); else dir.normalize();
  const q = new THREE.Quaternion();
  if (dir.y < -0.999999) q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  else q.setFromUnitVectors(Y, dir);
  if (b.roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(Y, b.roll));
  return new THREE.Matrix4().compose(new THREE.Vector3(h[0], h[1], h[2]), q, new THREE.Vector3(1, 1, 1));
}

export function poseLocal(p: PoseXf): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(...p.loc), new THREE.Quaternion(...p.rot), new THREE.Vector3(...p.scale));
}

export interface ArmatureEval {
  rest: THREE.Matrix4[];
  /** posed bone frames in armature space */
  posed: THREE.Matrix4[];
  /** posed · rest⁻¹ (armature space) */
  skin: THREE.Matrix4[];
}

/** Rest, posed and skinning matrices for every bone. */
export function evalArmature(mesh: Mesh, arm: Armature, usePose = true): ArmatureEval {
  const n = arm.bones.length;
  const rest = arm.bones.map((b) => restMatrix(mesh, b));
  const restInv = rest.map((m) => m.clone().invert());
  const posed: THREE.Matrix4[] = new Array(n);
  for (const i of boneOrder(arm)) {
    const b = arm.bones[i];
    const local = usePose ? poseLocal(b.pose) : new THREE.Matrix4();
    posed[i] = parentBase(arm, i, rest, restInv, posed).multiply(local);
  }
  const skin = posed.map((p, i) => p.clone().multiply(restInv[i]));
  return { rest, posed, skin };
}

/** Frame a bone's pose is expressed in: the parent's posed frame carried by the rest offset. */
export function parentBase(arm: Armature, i: number, rest: THREE.Matrix4[], restInv: THREE.Matrix4[], posed: THREE.Matrix4[]): THREE.Matrix4 {
  const p = arm.bones[i].parent;
  if (p < 0 || !posed[p]) return rest[i].clone();
  return posed[p].clone().multiply(restInv[p]).multiply(rest[i]);
}

/** True when the bone's head sits on its parent's tail (can't be moved in pose mode). */
export function isConnected(arm: Armature, i: number): boolean {
  const b = arm.bones[i];
  return b.parent >= 0 && arm.bones[b.parent]?.tail === b.head;
}

export function isAncestor(arm: Armature, anc: number, i: number): boolean {
  let p = arm.bones[i]?.parent ?? -1;
  for (let guard = 0; p >= 0 && guard < 10000; guard++) { if (p === anc) return true; p = arm.bones[p].parent; }
  return false;
}

/** .L ↔ .R style name mirroring; returns the name unchanged when it has no side. */
export function flipName(name: string): string {
  const rules: [RegExp, (m: string) => string][] = [
    [/([._\- ])([LlRr])$/, (m) => m[0] + ({ L: 'R', R: 'L', l: 'r', r: 'l' } as Record<string, string>)[m[1]]],
    [/^([LlRr])([._\- ])/, (m) => ({ L: 'R', R: 'L', l: 'r', r: 'l' } as Record<string, string>)[m[0]] + m[1]],
    [/(Left|Right|left|right|LEFT|RIGHT)/, (m) => ({ Left: 'Right', Right: 'Left', left: 'right', right: 'left', LEFT: 'RIGHT', RIGHT: 'LEFT' } as Record<string, string>)[m]],
  ];
  for (const [re, f] of rules) if (re.test(name)) return name.replace(re, (m) => f(m));
  return name;
}

export function uniqueBoneName(arm: Armature, base: string): string {
  const names = new Set(arm.bones.map((b) => b.name));
  if (!names.has(base)) return base;
  const m = base.match(/^(.*?)(\.\d+)?([._][LR])?$/);
  const stem = m?.[1] ?? base, side = m?.[3] ?? '';
  for (let i = 1; ; i++) { const n = `${stem}.${String(i).padStart(3, '0')}${side}`; if (!names.has(n)) return n; }
}

/** Remove bones (and their now-unused joints); children are re-parented to the removed bone's parent. */
export function deleteBones(mesh: Mesh, arm: Armature, del: Set<number>) {
  const keepIdx: number[] = [];
  const remap = new Int32Array(arm.bones.length).fill(-1);
  arm.bones.forEach((_, i) => { if (!del.has(i)) { remap[i] = keepIdx.length; keepIdx.push(i); } });
  const newParent = (i: number): number => {
    let p = arm.bones[i].parent;
    while (p >= 0 && del.has(p)) p = arm.bones[p].parent;
    return p >= 0 ? remap[p] : -1;
  };
  arm.bones = keepIdx.map((i) => ({ ...arm.bones[i], parent: newParent(i) }));
  arm.selected = arm.selected.filter((i) => remap[i] >= 0).map((i) => remap[i]);
  arm.active = arm.active >= 0 ? remap[arm.active] : -1;
  syncJointMesh(mesh, arm);
}

/**
 * Rebuild the joint mesh's loose edges from the bone list and drop unused
 * joints, remapping bone joint indices.
 */
export function syncJointMesh(mesh: Mesh, arm: Armature) {
  const used = new Uint8Array(mesh.verts.length);
  for (const b of arm.bones) { used[b.head] = 1; used[b.tail] = 1; }
  const remap = new Int32Array(mesh.verts.length).fill(-1);
  let n = 0;
  for (let i = 0; i < mesh.verts.length; i++) if (used[i]) remap[i] = n++;
  for (const b of arm.bones) { b.head = remap[b.head]; b.tail = remap[b.tail]; }
  const selV = [...mesh.selV].filter((v) => used[v]).map((v) => remap[v]);
  mesh.verts = mesh.verts.filter((_, i) => used[i]);
  mesh.faces = [];
  mesh.looseEdges = arm.bones.map((b) => [b.head, b.tail] as [number, number]);
  mesh.seams.clear();
  mesh.selV = new Set(selV);
  mesh.selF.clear();
  mesh.changed();
  mesh.flush('vert');
}

/** Bones whose both joints are selected in edit mode (or whose edge is selected). */
export function selectedEditBones(mesh: Mesh, arm: Armature): number[] {
  const out: number[] = [];
  arm.bones.forEach((b, i) => { if (mesh.selV.has(b.head) && mesh.selV.has(b.tail)) out.push(i); });
  return out;
}
