import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createPrimitive } from '../src/core/primitives';
import { Mesh } from '../src/core/mesh';
import * as ops from '../src/core/ops';
import { catmullClark, mirror, evaluate, newModifier } from '../src/core/modifiers';
import { remesh } from '../src/core/remesh';
import { decimate } from '../src/core/decimate';
import { bevel } from '../src/core/bevel';
import * as rig from '../src/core/armature';
import { autoWeights, deformMesh, meshSpaceSkin, topInfluences } from '../src/core/skin';
import { Scene, SceneObject, evalContext } from '../src/core/scene';

/** Two-bone vertical chain: 0→1 (Lower), 1→2 (Upper). */
function chain() {
  const mesh = new Mesh();
  mesh.addVert([0, 0, 0]); mesh.addVert([0, 1, 0]); mesh.addVert([0, 2, 0]);
  const arm = rig.newArmature();
  arm.bones.push({ name: 'Lower', parent: -1, head: 0, tail: 1, roll: 0, deform: true, pose: rig.identityPose() });
  arm.bones.push({ name: 'Upper', parent: 0, head: 1, tail: 2, roll: 0, deform: true, pose: rig.identityPose() });
  rig.syncJointMesh(mesh, arm);
  return { mesh, arm };
}

/** A tall subdivided column around the chain. */
function column(): Mesh {
  const m = createPrimitive('cube');
  m.verts = m.verts.map((p) => [p[0] * 0.2, (p[1] + 1) , p[2] * 0.2]);
  m.touch();
  let r = m;
  for (let i = 0; i < 2; i++) r = catmullClark(r);
  return r;
}

const lowest = (m: Mesh) => m.verts.reduce((b, p, i) => (p[1] < m.verts[b][1] ? i : b), 0);
const highest = (m: Mesh) => m.verts.reduce((b, p, i) => (p[1] > m.verts[b][1] ? i : b), 0);
const fullyWeighted = (m: Mesh) => m.verts.every((_, i) => m.weightsOf(i).length > 0);

describe('armature', () => {
  it('rest frames point +Y along the bone', () => {
    const { mesh, arm } = chain();
    const R = rig.restMatrix(mesh, arm.bones[1]);
    const y = new THREE.Vector3(0, 1, 0).applyMatrix4(R);
    expect(y.toArray().map((x) => +x.toFixed(6))).toEqual([0, 2, 0]);
    const ev = rig.evalArmature(mesh, arm);
    for (const s of ev.skin) expect(s.equals(new THREE.Matrix4())).toBe(true);
  });

  it('rotating a parent carries the child', () => {
    const { mesh, arm } = chain();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    arm.bones[0].pose.rot = [q.x, q.y, q.z, q.w];
    const ev = rig.evalArmature(mesh, arm);
    const tip = new THREE.Vector3(0, 1, 0).applyMatrix4(ev.posed[1]);
    expect(tip.x).toBeCloseTo(-2, 5);
    expect(tip.y).toBeCloseTo(0, 5);
  });

  it('delete re-parents children and drops unused joints', () => {
    const { mesh, arm } = chain();
    rig.deleteBones(mesh, arm, new Set([0]));
    expect(arm.bones.length).toBe(1);
    expect(arm.bones[0].parent).toBe(-1);
    expect(mesh.verts.length).toBe(2);
    expect(mesh.looseEdges).toEqual([[arm.bones[0].head, arm.bones[0].tail]]);
  });

  it('flips side names', () => {
    expect(rig.flipName('Arm.L')).toBe('Arm.R');
    expect(rig.flipName('hand_r')).toBe('hand_l');
    expect(rig.flipName('LeftFoot')).toBe('RightFoot');
    expect(rig.flipName('Spine')).toBe('Spine');
  });

  it('survives JSON round trip with the scene', () => {
    const { mesh, arm } = chain();
    const o = new SceneObject('Rig', mesh);
    o.armature = arm;
    arm.bones[1].pose.loc = [0.1, 0.2, 0.3];
    const back = SceneObject.fromJSON(JSON.parse(JSON.stringify(o.toJSON())));
    expect(back.armature!.bones.map((b) => b.name)).toEqual(['Lower', 'Upper']);
    expect(back.armature!.bones[1].pose.loc).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('weights', () => {
  it('automatic weights cover every vertex with ≤ 4 normalised influences', () => {
    const { mesh: am, arm } = chain();
    const m = column();
    autoWeights(m, am, arm, new THREE.Matrix4());
    expect(m.groups).toEqual(['Lower', 'Upper']);
    expect(fullyWeighted(m)).toBe(true);
    for (let i = 0; i < m.verts.length; i++) {
      const l = m.weightsOf(i);
      expect(l.length).toBeLessThanOrEqual(4);
      expect(l.reduce((a, [, w]) => a + w, 0)).toBeCloseTo(1, 4);
    }
    // bottom follows Lower, top follows Upper
    const lo = lowest(m), hi = highest(m);
    expect(m.weight(lo, 0)).toBeGreaterThan(0.9);
    expect(m.weight(hi, 1)).toBeGreaterThan(0.9);
  });

  it('skinning bends the top with the upper bone', () => {
    const { mesh: am, arm } = chain();
    const m = column();
    autoWeights(m, am, arm, new THREE.Matrix4());
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    arm.bones[1].pose.rot = [q.x, q.y, q.z, q.w];
    const d = deformMesh(m, meshSpaceSkin(am, arm, new THREE.Matrix4()));
    const hi = highest(m);
    // the top is ~0.8 above the knee: rotating 90° about Z swings it to −X at knee height
    expect(d.verts[hi][0]).toBeLessThan(-0.6);
    expect(d.verts[hi][1]).toBeCloseTo(1, 0);
    const lo = lowest(m);
    expect(d.verts[lo]).toEqual(m.verts[lo]);
  });

  it('weights follow topology edits', () => {
    const { mesh: am, arm } = chain();
    const base = column();
    autoWeights(base, am, arm, new THREE.Matrix4());
    const cases: [string, (m: Mesh) => Mesh | void][] = [
      ['extrude', (m) => { m.selF.add(0); m.flush('face'); ops.extrudeFaces(m); }],
      ['inset', (m) => { m.selF.add(0); m.flush('face'); ops.insetFaces(m)?.set(0.3, 0); }],
      ['subdivide', (m) => { m.selF.add(0); m.selF.add(1); m.flush('face'); ops.subdivideFaces(m); }],
      ['loop cut', (m) => { ops.loopCut(m, m.edges[0].key, 2); }],
      ['bevel', (m) => { m.selE.add(m.edges[0].key); bevel(m, { width: 0.02, segments: 2 }); }],
      ['delete', (m) => { m.selV.add(3); ops.deleteSelection(m, 'vert'); }],
      ['subsurf', (m) => catmullClark(m)],
      ['mirror', (m) => { m.verts = m.verts.map((p) => [p[0] + 0.5, p[1], p[2]]); m.touch(); return mirror(m, 0, 0.001); }],
      ['decimate', (m) => decimate(m, { mode: 'collapse', ratio: 0.3 })],
      ['remesh', (m) => remesh(m, { mode: 'voxel', size: 0.06 })],
    ];
    for (const [name, op] of cases) {
      const m = base.clone();
      const r = op(m) ?? m;
      expect(r.vw.length, name).toBe(r.verts.length);
      expect(fullyWeighted(r), name).toBe(true);
    }
  });

  it('mirror modifier flips side groups', () => {
    const m = createPrimitive('cube');
    m.verts = m.verts.map((p) => [p[0] + 2, p[1], p[2]]);
    m.groupIndex('Arm.L', true);
    for (let i = 0; i < m.verts.length; i++) m.setWeight(i, 0, 1);
    const r = mirror(m, 0, 0.001);
    const right = r.verts.findIndex((p) => p[0] < 0);
    expect(r.groups[r.weightsOf(right)[0][0]]).toBe('Arm.R');
  });

  it('top influences keeps the strongest four, normalised', () => {
    const l = topInfluences([[0, 0.1], [1, 0.5], [2, 0.2], [3, 0.4], [4, 0.3]]);
    expect(l.map(([g]) => g)).toEqual([1, 3, 4, 2]);
    expect(l.reduce((a, [, w]) => a + w, 0)).toBeCloseTo(1, 6);
  });

  it('armature modifier deforms through the scene context', () => {
    const scene = new Scene();
    const { mesh: am, arm } = chain();
    const a = new SceneObject('Rig', am); a.armature = arm;
    const body = new SceneObject('Body', column());
    autoWeights(body.mesh, am, arm, new THREE.Matrix4());
    const md = newModifier('armature'); md.target = a.id;
    body.modifiers.push(md, newModifier('subsurf'));
    scene.add(a); scene.add(body);
    arm.bones[0].pose.loc = [0, 0, 1];
    const r = evaluate(body.mesh, body.modifiers, evalContext(scene, body));
    expect(r.verts.every((p) => p[2] > 0.6)).toBe(true);
  });
});
