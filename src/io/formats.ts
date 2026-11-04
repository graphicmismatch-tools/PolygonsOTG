import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Mesh } from '../core/mesh';
import { Scene, SceneObject, evalContext } from '../core/scene';
import { evalArmature } from '../core/armature';
import { topInfluences } from '../core/skin';
import { evaluate } from '../core/modifiers';
import { buildGeometry } from '../render/geometry';
import { V2, V3, polyNormal } from '../core/vec';
import { triangulateFace } from '../core/ops';
import { trisToQuads } from '../core/topology';
export { trisToQuads };

const objMatrix = (o: SceneObject) =>
  new THREE.Matrix4().compose(new THREE.Vector3(...o.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...o.rotation, 'XYZ')), new THREE.Vector3(...o.scale));

const fmt = (x: number) => (Math.abs(x) < 1e-9 ? '0' : x.toFixed(6).replace(/\.?0+$/, ''));

/* ------------------------------------------------------------------ OBJ */
export function exportOBJ(objects: SceneObject[], applyModifiers = true, scene?: Scene): string {
  const out: string[] = ['# Exported from Polygons OTG', ''];
  let vOff = 1, vtOff = 1, vnOff = 1;
  for (const o of objects) {
    if (o.armature) continue;
    const m = applyModifiers ? evaluate(o.mesh, o.modifiers, scene ? evalContext(scene, o) : undefined) : o.mesh;
    const M = objMatrix(o);
    const N = new THREE.Matrix3().getNormalMatrix(M);
    out.push(`o ${o.name.replace(/\s+/g, '_')}`);
    for (const p of m.verts) { const v = new THREE.Vector3(...p).applyMatrix4(M); out.push(`v ${fmt(v.x)} ${fmt(v.y)} ${fmt(v.z)}`); }
    let vt = 0;
    for (const f of m.faces) for (const u of f.uv) { out.push(`vt ${fmt(u[0])} ${fmt(u[1])}`); vt++; }
    // normals: per face (flat) or per vertex (smooth)
    let vnCount = 0;
    if (o.smooth) {
      for (let i = 0; i < m.verts.length; i++) { const n = new THREE.Vector3(...m.vertNormal(i)).applyMatrix3(N).normalize(); out.push(`vn ${fmt(n.x)} ${fmt(n.y)} ${fmt(n.z)}`); vnCount++; }
      out.push('s 1');
    } else {
      for (let i = 0; i < m.faces.length; i++) { const n = new THREE.Vector3(...m.faceNormal(i)).applyMatrix3(N).normalize(); out.push(`vn ${fmt(n.x)} ${fmt(n.y)} ${fmt(n.z)}`); vnCount++; }
      out.push('s off');
    }
    let c = 0;
    m.faces.forEach((f, fi) => {
      const parts = f.v.map((v) => { const s = `${v + vOff}/${c + vtOff}/${(o.smooth ? v : fi) + vnOff}`; c++; return s; });
      out.push(`f ${parts.join(' ')}`);
    });
    for (const [a, b] of m.looseEdges) out.push(`l ${a + vOff} ${b + vOff}`);
    vOff += m.verts.length; vtOff += vt; vnOff += vnCount;
    out.push('');
  }
  return out.join('\n');
}

export function importOBJ(text: string): { name: string; mesh: Mesh }[] {
  const pos: V3[] = [], uvs: V2[] = [];
  const results: { name: string; mesh: Mesh; map: Map<number, number> }[] = [];
  let cur: { name: string; mesh: Mesh; map: Map<number, number> } | null = null;
  const ensure = (name = 'Imported') => { if (!cur) { cur = { name, mesh: new Mesh(), map: new Map() }; results.push(cur); } return cur; };
  const vi = (s: string, n: number) => { const i = parseInt(s, 10); return i < 0 ? n + i : i - 1; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const k = parts[0];
    if (k === 'v') pos.push([+parts[1], +parts[2], +parts[3]]);
    else if (k === 'vt') uvs.push([+parts[1], +(parts[2] ?? 0)]);
    else if (k === 'o' || k === 'g') { if (!cur || cur.mesh.faces.length || cur.mesh.verts.length) { cur = { name: parts.slice(1).join(' ') || 'Object', mesh: new Mesh(), map: new Map() }; results.push(cur); } else cur.name = parts.slice(1).join(' ') || cur.name; }
    else if (k === 'f' || k === 'l') {
      const c = ensure();
      const idx: number[] = [], uv: V2[] = [];
      for (const tok of parts.slice(1)) {
        const [a, b] = tok.split('/');
        const gi = vi(a, pos.length);
        let li = c.map.get(gi);
        if (li === undefined) { li = c.mesh.addVert(pos[gi] ?? [0, 0, 0]); c.map.set(gi, li); }
        idx.push(li);
        uv.push(b ? [...(uvs[vi(b, uvs.length)] ?? [0, 0])] as V2 : [0, 0]);
      }
      if (k === 'f' && idx.length >= 3) c.mesh.addFace(idx, uv);
      else if (k === 'l') for (let i = 0; i + 1 < idx.length; i++) c.mesh.looseEdges.push([idx[i], idx[i + 1]]);
    }
  }
  for (const r of results) { r.mesh.changed(); r.mesh.cleanup(); }
  return results.filter((r) => r.mesh.verts.length).map(({ name, mesh }) => ({ name, mesh }));
}

/* ------------------------------------------------------------------ STL */
export function exportSTL(objects: SceneObject[], scene?: Scene): ArrayBuffer {
  const tris: number[][] = [];
  for (const o of objects) {
    if (o.armature) continue;
    const m = evaluate(o.mesh, o.modifiers, scene ? evalContext(scene, o) : undefined);
    const M = objMatrix(o);
    const W = m.verts.map((p) => { const v = new THREE.Vector3(...p).applyMatrix4(M); return [v.x, v.y, v.z] as V3; });
    for (const f of m.faces) {
      for (const [a, b, c] of triangulateFace(W, f.v)) {
        const n = polyNormal([W[f.v[a]], W[f.v[b]], W[f.v[c]]]);
        tris.push([...n, ...W[f.v[a]], ...W[f.v[b]], ...W[f.v[c]]]);
      }
    }
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  const header = 'Polygons OTG binary STL';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) { for (let i = 0; i < 12; i++) { dv.setFloat32(off, t[i], true); off += 4; } dv.setUint16(off, 0, true); off += 2; }
  return buf;
}

/* ------------------------------------------------------------------ glTF */
/**
 * glTF binary. Meshes bound to an armature export as skinned meshes (rest pose,
 * up to 4 joints per vertex) with the armature as a bone hierarchy; armatures
 * referenced by exported meshes are included automatically.
 */
export async function exportGLB(objects: SceneObject[], getTexture: (url: string) => THREE.Texture, scene?: Scene): Promise<ArrayBuffer> {
  const root = new THREE.Scene();
  // armatures: explicitly exported, or needed by an exported mesh
  const armIds = new Set<string>();
  for (const o of objects) {
    if (o.armature) armIds.add(o.id);
    for (const md of o.modifiers) if (md.type === 'armature' && md.enabled && md.target && scene?.byId(md.target)?.armature) armIds.add(md.target);
  }
  const skeletons = new Map<string, { bones: THREE.Bone[]; skeleton: THREE.Skeleton; index: Map<string, number>; root: number }>();
  for (const id of armIds) {
    const a = objects.find((o) => o.id === id) ?? scene?.byId(id);
    if (!a?.armature) continue;
    const node = new THREE.Object3D();
    node.name = a.name;
    node.position.set(...a.position);
    node.rotation.set(...a.rotation);
    node.scale.set(...a.scale);
    root.add(node);
    const ev = evalArmature(a.mesh, a.armature, false);
    const arm = a.armature;
    const bones = arm.bones.map((b) => { const bone = new THREE.Bone(); bone.name = b.name; return bone; });
    arm.bones.forEach((b, i) => {
      const parent = b.parent >= 0 && b.parent < bones.length ? b.parent : -1;
      const local = parent >= 0 ? ev.rest[parent].clone().invert().multiply(ev.rest[i]) : ev.rest[i].clone();
      local.decompose(bones[i].position, bones[i].quaternion, bones[i].scale);
      (parent >= 0 ? bones[parent] : node).add(bones[i]);
    });
    node.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones, bones.map((bone) => bone.matrixWorld.clone().invert()));
    const index = new Map(arm.bones.map((b, i) => [b.name, i] as [string, number]));
    skeletons.set(id, { bones, skeleton, index, root: Math.max(0, arm.bones.findIndex((b) => b.parent < 0)) });
  }
  for (const o of objects) {
    if (o.armature) continue;
    const armMod = o.modifiers.find((md) => md.type === 'armature' && md.enabled && md.target && skeletons.has(md.target));
    // the skin carries the deformation, so the mesh is exported in its rest shape
    const m = evaluate(o.mesh, o.modifiers.filter((md) => md.type !== 'armature'));
    const built = buildGeometry(m, o.smooth);
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(o.material.color), roughness: o.material.roughness, metalness: o.material.metalness });
    if (o.material.texture) { mat.map = getTexture(o.material.texture); mat.color.set('#ffffff'); }
    let mesh: THREE.Mesh;
    if (armMod) {
      const sk = skeletons.get(armMod.target!)!;
      const gmap = m.groups.map((g) => sk.index.get(g) ?? -1);
      const cv = built.cornerVert;
      const si = new Uint16Array(cv.length * 4), sw = new Float32Array(cv.length * 4);
      const perVert = m.verts.map((_, v) => topInfluences(m.weightsOf(v).filter(([g]) => gmap[g] >= 0).map(([g, w]) => [gmap[g], w] as [number, number])));
      for (let i = 0; i < cv.length; i++) {
        const l = perVert[cv[i]];
        // unweighted vertices follow the root bone
        if (!l.length) { si[i * 4] = sk.root; sw[i * 4] = 1; continue; }
        l.forEach(([b, w], k) => { si[i * 4 + k] = b; sw[i * 4 + k] = w; });
      }
      built.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      built.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      const sm = new THREE.SkinnedMesh(built.geometry, mat);
      mesh = sm;
    } else mesh = new THREE.Mesh(built.geometry, mat);
    mesh.name = o.name;
    mesh.position.set(...o.position);
    mesh.rotation.set(...o.rotation);
    mesh.scale.set(...o.scale);
    root.add(mesh);
    if (armMod) {
      mesh.updateMatrixWorld(true);
      (mesh as THREE.SkinnedMesh).bind(skeletons.get(armMod.target!)!.skeleton, mesh.matrixWorld.clone());
    }
  }
  const exporter = new GLTFExporter();
  const res = await exporter.parseAsync(root, { binary: true, onlyVisible: false });
  return res as ArrayBuffer;
}

/** Convert triangle soup geometry into an editable mesh by welding positions. */
export function weldGeometry(g: THREE.BufferGeometry, eps = 1e-5): Mesh {
  const m = new Mesh();
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const index = g.getIndex();
  const map = new Map<string, number>();
  const q = (x: number) => Math.round(x / eps);
  const vid = (i: number) => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${q(x)},${q(y)},${q(z)}`;
    let v = map.get(k);
    if (v === undefined) { v = m.addVert([x, y, z]); map.set(k, v); }
    return v;
  };
  const count = index ? index.count : pos.count;
  for (let t = 0; t + 2 < count; t += 3) {
    const ids = [0, 1, 2].map((k) => (index ? index.getX(t + k) : t + k));
    const vs = ids.map(vid);
    if (new Set(vs).size < 3) continue;
    m.addFace(vs, ids.map((i) => (uv ? [uv.getX(i), uv.getY(i)] : [0, 0]) as V2));
  }
  m.changed();
  m.cleanup();
  return m;
}

export async function importGLTF(data: ArrayBuffer | string): Promise<{ name: string; mesh: Mesh; position: V3; rotation: V3; scale: V3; texture: string | null; color: string | null }[]> {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(data as any, '');
  const out: { name: string; mesh: Mesh; position: V3; rotation: V3; scale: V3; texture: string | null; color: string | null }[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry.clone();
    const m = weldGeometry(g);
    trisToQuads(m);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    mesh.matrixWorld.decompose(p, q, s);
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    let texture: string | null = null;
    const img = mat?.map?.image as (HTMLImageElement | ImageBitmap | undefined);
    if (img) {
      try {
        const c = document.createElement('canvas');
        c.width = (img as any).width; c.height = (img as any).height;
        c.getContext('2d')!.drawImage(img as any, 0, 0);
        texture = c.toDataURL('image/png');
      } catch { texture = null; }
    }
    out.push({ name: mesh.name || 'Mesh', mesh: m, position: [p.x, p.y, p.z], rotation: [e.x, e.y, e.z], scale: [s.x, s.y, s.z], texture, color: mat?.color ? '#' + mat.color.getHexString() : null });
  });
  return out;
}

export function importSTL(data: ArrayBuffer): Mesh {
  const g = new STLLoader().parse(data);
  const m = weldGeometry(g, 1e-4);
  trisToQuads(m);
  return m;
}

/* ------------------------------------------------------------------ project */
export function serializeProject(scene: Scene): string {
  return JSON.stringify(scene.toJSON());
}
