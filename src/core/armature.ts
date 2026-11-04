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
  /** inverse kinematics: this bone's tail reaches for the target bone's head */
  ik?: IKConstraint;
}

export interface IKConstraint {
  enabled: boolean;
  /** bone index of the target (usually an unparented control bone) */
  target: number;
  /** number of bones in the chain including this one; 0 = up to the root */
  chain: number;
  /** optional pole bone the chain bends toward (-1 none) */
  pole: number;
  /** extra twist of the bend plane around the chain axis, radians */
  poleAngle: number;
}

export type Interp = 'linear' | 'ease' | 'constant';

export interface Key {
  frame: number;
  pose: PoseXf;
  /** how values travel from this key to the next */
  interp: Interp;
}

/** A named animation clip: keyframes per bone name. */
export interface Action {
  name: string;
  start: number;
  end: number;
  fps: number;
  tracks: Record<string, Key[]>;
}

export interface Armature {
  bones: Bone[];
  /** pose-mode selection */
  selected: number[];
  active: number;
  actions: Action[];
  /** index into actions, -1 none */
  activeAction: number;
}

export const identityPose = (): PoseXf => ({ rot: [0, 0, 0, 1], loc: [0, 0, 0], scale: [1, 1, 1] });
export const isIdentityPose = (p: PoseXf) =>
  Math.abs(p.rot[0]) + Math.abs(p.rot[1]) + Math.abs(p.rot[2]) < 1e-9 && Math.abs(p.loc[0]) + Math.abs(p.loc[1]) + Math.abs(p.loc[2]) < 1e-9 && p.scale.every((s) => Math.abs(s - 1) < 1e-9);

export function newArmature(): Armature { return { bones: [], selected: [], active: -1, actions: [], activeAction: -1 }; }

export function clonePose(p: PoseXf): PoseXf { return { rot: [...p.rot] as Quat, loc: [...p.loc] as V3, scale: [...p.scale] as V3 }; }

export function cloneAction(a: Action): Action {
  const tracks: Record<string, Key[]> = {};
  for (const [k, keys] of Object.entries(a.tracks)) tracks[k] = keys.map((x) => ({ frame: x.frame, interp: x.interp, pose: clonePose(x.pose) }));
  return { name: a.name, start: a.start, end: a.end, fps: a.fps, tracks };
}

export function cloneArmature(a: Armature): Armature {
  return {
    bones: a.bones.map((b) => ({ ...b, pose: clonePose(b.pose), ...(b.ik ? { ik: { ...b.ik } } : {}) })),
    selected: a.selected.slice(), active: a.active,
    actions: a.actions.map(cloneAction), activeAction: a.activeAction,
  };
}

export function armatureFromJSON(j: any): Armature {
  return {
    bones: (j?.bones ?? []).map((b: any) => ({
      name: String(b.name), parent: b.parent ?? -1, head: b.head, tail: b.tail, roll: b.roll ?? 0, deform: b.deform !== false,
      pose: b.pose ? clonePose(b.pose) : identityPose(),
      ...(b.ik ? { ik: { enabled: b.ik.enabled !== false, target: b.ik.target ?? -1, chain: b.ik.chain ?? 2, pole: b.ik.pole ?? -1, poleAngle: b.ik.poleAngle ?? 0 } } : {}),
    })),
    selected: (j?.selected ?? []).slice(),
    active: j?.active ?? -1,
    actions: (j?.actions ?? []).map((a: any) => cloneAction({ name: String(a.name ?? 'Action'), start: a.start ?? 1, end: a.end ?? 24, fps: a.fps ?? 24, tracks: a.tracks ?? {} })),
    activeAction: j?.activeAction ?? -1,
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
  /** effective local poses (after IK) */
  poses: PoseXf[];
}

/** Rest, posed and skinning matrices for every bone. */
export function evalArmature(mesh: Mesh, arm: Armature, usePose = true): ArmatureEval {
  const rest = arm.bones.map((b) => restMatrix(mesh, b));
  const restInv = rest.map((m) => m.clone().invert());
  const order = boneOrder(arm);
  let poses = arm.bones.map((b) => (usePose ? b.pose : identityPose()));
  let posed = forwardKinematics(arm, poses, rest, restInv, order);
  const iks = usePose ? order.filter((i) => validIK(arm, i)) : [];
  if (iks.length) {
    poses = poses.map(clonePose);
    for (const i of iks) posed = solveIK(mesh, arm, i, poses, rest, restInv, order, posed);
  }
  const skin = posed.map((p, i) => p.clone().multiply(restInv[i]));
  return { rest, posed, skin, poses };
}

function forwardKinematics(arm: Armature, poses: PoseXf[], rest: THREE.Matrix4[], restInv: THREE.Matrix4[], order: number[]): THREE.Matrix4[] {
  const posed: THREE.Matrix4[] = new Array(arm.bones.length);
  for (const i of order) posed[i] = parentBase(arm, i, rest, restInv, posed).multiply(poseLocal(poses[i]));
  return posed;
}

/** Bones of an IK chain, root first (ending with the IK bone itself). */
export function ikChain(arm: Armature, i: number): number[] {
  const c = [i];
  const max = arm.bones[i].ik?.chain || 1e9;
  let p = arm.bones[i].parent;
  while (p >= 0 && c.length < max && c.length < arm.bones.length) { c.unshift(p); p = arm.bones[p].parent; }
  return c;
}

export function validIK(arm: Armature, i: number): boolean {
  const ik = arm.bones[i].ik;
  if (!ik || !ik.enabled || ik.target < 0 || ik.target >= arm.bones.length || ik.target === i) return false;
  // the target must not be moved by the chain itself
  return !ikChain(arm, i).some((c) => c === ik.target || isAncestor(arm, c, ik.target));
}

const pos3 = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);

/**
 * FABRIK on the chain's joint positions (optionally bent toward a pole), then
 * each bone is rotated, root first, to point along its solved segment.
 * Only rotations change; locations and scales are kept.
 */
function solveIK(mesh: Mesh, arm: Armature, i: number, poses: PoseXf[], rest: THREE.Matrix4[], restInv: THREE.Matrix4[], order: number[], posed: THREE.Matrix4[]): THREE.Matrix4[] {
  const ik = arm.bones[i].ik!;
  const chain = ikChain(arm, i);
  const n = chain.length;
  const tipLen = boneLength(mesh, arm.bones[i]);
  const joints = (P: THREE.Matrix4[]) => [...chain.map((c) => pos3(P[c])), new THREE.Vector3(0, tipLen, 0).applyMatrix4(P[i])];
  const J = joints(posed);
  const len = J.slice(1).map((p, k) => p.distanceTo(J[k]));
  const total = len.reduce((a, b) => a + b, 0);
  if (total < 1e-9) return posed;
  const target = pos3(posed[ik.target]);
  const root = J[0].clone();
  const pole = ik.pole >= 0 && ik.pole < arm.bones.length && ik.pole !== i ? pos3(posed[ik.pole]) : null;
  // a straight chain can't decide which way to fold: nudge the inner joints toward the pole
  // (or the first bone's +Z) so FABRIK has a bend direction to work with
  if (n >= 2) {
    const axis = J[n].clone().sub(J[0]).normalize();
    const hint = pole ? pole.clone().sub(J[0]) : new THREE.Vector3(0, 0, 1).transformDirection(posed[chain[0]]);
    hint.addScaledVector(axis, -hint.dot(axis));
    if (hint.lengthSq() > 1e-12) { hint.normalize().multiplyScalar(total * 0.02); for (let k = 1; k < n; k++) J[k].add(hint); }
  }
  if (root.distanceTo(target) >= total) {
    const d = target.clone().sub(root).normalize();
    for (let k = 1; k <= n; k++) J[k] = J[k - 1].clone().addScaledVector(d, len[k - 1]);
  } else {
    for (let it = 0; it < 24; it++) {
      J[n].copy(target);
      for (let k = n - 1; k >= 0; k--) J[k] = J[k + 1].clone().add(J[k].clone().sub(J[k + 1]).normalize().multiplyScalar(len[k]));
      J[0].copy(root);
      for (let k = 0; k < n; k++) J[k + 1] = J[k].clone().add(J[k + 1].clone().sub(J[k]).normalize().multiplyScalar(len[k]));
      if (J[n].distanceTo(target) < total * 1e-5) break;
    }
  }
  // turn the bend plane toward the pole
  if (pole && n >= 2) {
    const axis = J[n].clone().sub(J[0]);
    if (axis.lengthSq() > 1e-12) {
      axis.normalize();
      const flat = (p: THREE.Vector3) => { const v = p.clone().sub(J[0]); return v.addScaledVector(axis, -v.dot(axis)); };
      const pp = flat(pole);
      for (let k = 1; k < n; k++) {
        const jp = flat(J[k]);
        if (jp.lengthSq() < 1e-12 || pp.lengthSq() < 1e-12) continue;
        const ang = Math.atan2(jp.clone().cross(pp).dot(axis), jp.dot(pp)) + ik.poleAngle;
        J[k].sub(J[0]).applyAxisAngle(axis, ang).add(J[0]);
      }
    }
  }
  // rotate bones to match, root first
  let P = posed;
  for (let k = 0; k < n; k++) {
    const b = chain[k];
    const cur = joints(P);
    const from = cur[k + 1].clone().sub(cur[k]), to = J[k + 1].clone().sub(J[k]);
    if (from.lengthSq() < 1e-14 || to.lengthSq() < 1e-14) continue;
    const q = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    const h = cur[k];
    const Pn = new THREE.Matrix4().makeTranslation(h.x, h.y, h.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-h.x, -h.y, -h.z)).multiply(P[b]);
    const local = parentBase(arm, b, rest, restInv, P).invert().multiply(Pn);
    const lq = new THREE.Quaternion();
    local.decompose(new THREE.Vector3(), lq, new THREE.Vector3());
    poses[b] = { ...poses[b], rot: [lq.x, lq.y, lq.z, lq.w] };
    P = forwardKinematics(arm, poses, rest, restInv, order);
  }
  return P;
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
  const deletedNames = new Set([...del].map((i) => arm.bones[i]?.name));
  arm.bones = keepIdx.map((i) => ({ ...arm.bones[i], parent: newParent(i) }));
  for (const b of arm.bones) if (b.ik) b.ik = { ...b.ik, target: b.ik.target >= 0 ? remap[b.ik.target] : -1, pole: b.ik.pole >= 0 ? remap[b.ik.pole] : -1 };
  for (const a of arm.actions) for (const n of deletedNames) delete a.tracks[n];
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

/* ------------------------------------------------------------------ animation */

export function newAction(name: string): Action { return { name, start: 1, end: 48, fps: 24, tracks: {} }; }

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Pose of one track at a (fractional) frame. */
export function sampleTrack(keys: Key[], frame: number): PoseXf | null {
  if (!keys.length) return null;
  if (frame <= keys[0].frame) return clonePose(keys[0].pose);
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return clonePose(last.pose);
  let k = 0;
  while (k + 1 < keys.length && keys[k + 1].frame <= frame) k++;
  const a = keys[k], b = keys[k + 1];
  if (a.interp === 'constant') return clonePose(a.pose);
  let t = (frame - a.frame) / Math.max(1e-9, b.frame - a.frame);
  if (a.interp === 'ease') t = smooth(t);
  const lerp = (x: V3, y: V3): V3 => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
  const q = new THREE.Quaternion(...a.pose.rot).slerp(new THREE.Quaternion(...b.pose.rot), t);
  return { rot: [q.x, q.y, q.z, q.w], loc: lerp(a.pose.loc, b.pose.loc), scale: lerp(a.pose.scale, b.pose.scale) };
}

/** Set every keyed bone's pose from an action at a frame (unkeyed bones keep theirs). */
export function applyAction(arm: Armature, action: Action, frame: number) {
  for (const b of arm.bones) {
    const keys = action.tracks[b.name];
    const p = keys ? sampleTrack(keys, frame) : null;
    if (p) b.pose = p;
  }
}

/** Insert (or replace) a key for the given bones at a frame. */
export function insertKeys(arm: Armature, action: Action, bones: number[], frame: number, interp: Interp = 'ease') {
  for (const i of bones) {
    const b = arm.bones[i];
    if (!b) continue;
    const keys = action.tracks[b.name] ?? (action.tracks[b.name] = []);
    const at = keys.findIndex((k) => Math.abs(k.frame - frame) < 1e-6);
    const key: Key = { frame, pose: clonePose(b.pose), interp: at >= 0 ? keys[at].interp : interp };
    if (at >= 0) keys[at] = key; else { keys.push(key); keys.sort((x, y) => x.frame - y.frame); }
  }
}

/** Remove the keys at a frame for the given bones; returns how many were removed. */
export function deleteKeys(arm: Armature, action: Action, bones: number[], frame: number): number {
  let n = 0;
  for (const i of bones) {
    const name = arm.bones[i]?.name;
    const keys = name ? action.tracks[name] : undefined;
    if (!keys) continue;
    const before = keys.length;
    action.tracks[name] = keys.filter((k) => Math.abs(k.frame - frame) > 1e-6);
    n += before - action.tracks[name].length;
    if (!action.tracks[name].length) delete action.tracks[name];
  }
  return n;
}

/** Sorted distinct key frames (of some bones, or all). */
export function keyFrames(arm: Armature, action: Action, bones?: number[]): number[] {
  const names = bones ? bones.map((i) => arm.bones[i]?.name).filter(Boolean) as string[] : Object.keys(action.tracks);
  const set = new Set<number>();
  for (const n of names) for (const k of action.tracks[n] ?? []) set.add(k.frame);
  return [...set].sort((a, b) => a - b);
}

/** Rename a bone's animation tracks. */
export function renameTracks(arm: Armature, oldName: string, newName: string) {
  for (const a of arm.actions) if (a.tracks[oldName]) { a.tracks[newName] = a.tracks[oldName]; delete a.tracks[oldName]; }
}
