import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Mesh } from '../core/mesh';
import { Scene, SceneObject } from '../core/scene';
import { evaluate } from '../core/modifiers';
import { buildGeometry } from '../render/geometry';
import { V2, V3, polyNormal } from '../core/vec';
import { triangulateFace } from '../core/ops';

const objMatrix = (o: SceneObject) =>
  new THREE.Matrix4().compose(new THREE.Vector3(...o.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...o.rotation, 'XYZ')), new THREE.Vector3(...o.scale));

const fmt = (x: number) => (Math.abs(x) < 1e-9 ? '0' : x.toFixed(6).replace(/\.?0+$/, ''));

/* ------------------------------------------------------------------ OBJ */
export function exportOBJ(objects: SceneObject[], applyModifiers = true): string {
  const out: string[] = ['# Exported from Polygons OTG', ''];
  let vOff = 1, vtOff = 1, vnOff = 1;
  for (const o of objects) {
    const m = applyModifiers ? evaluate(o.mesh, o.modifiers) : o.mesh;
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
export function exportSTL(objects: SceneObject[]): ArrayBuffer {
  const tris: number[][] = [];
  for (const o of objects) {
    const m = evaluate(o.mesh, o.modifiers);
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
export async function exportGLB(objects: SceneObject[], getTexture: (url: string) => THREE.Texture): Promise<ArrayBuffer> {
  const root = new THREE.Scene();
  for (const o of objects) {
    const m = evaluate(o.mesh, o.modifiers);
    const built = buildGeometry(m, o.smooth);
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(o.material.color), roughness: o.material.roughness, metalness: o.material.metalness });
    if (o.material.texture) { mat.map = getTexture(o.material.texture); mat.color.set('#ffffff'); }
    const mesh = new THREE.Mesh(built.geometry, mat);
    mesh.name = o.name;
    mesh.position.set(...o.position);
    mesh.rotation.set(...o.rotation);
    mesh.scale.set(...o.scale);
    root.add(mesh);
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

/** Merge coplanar triangle pairs into quads (helps after importing triangulated meshes). */
export function trisToQuads(m: Mesh, angleDeg = 1) {
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const used = new Set<number>();
  const newFaces: typeof m.faces = [];
  // prefer pairing along the longest edge of each triangle
  const edges = m.edges
    .filter((e) => e.faces.length === 2 && m.faces[e.faces[0]].v.length === 3 && m.faces[e.faces[1]].v.length === 3)
    .map((e) => ({ e, l: Math.hypot(...m.verts[e.a].map((x, i) => x - m.verts[e.b][i]) as V3) }))
    .sort((a, b) => b.l - a.l);
  for (const { e } of edges) {
    const [f1, f2] = e.faces;
    if (used.has(f1) || used.has(f2)) continue;
    const n1 = m.faceNormal(f1), n2 = m.faceNormal(f2);
    if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < cosT) continue;
    const A = m.faces[f1], B = m.faces[f2];
    const i = A.v.findIndex((v) => v !== e.a && v !== e.b);
    const opp = B.v.findIndex((v) => v !== e.a && v !== e.b);
    // quad: A[i], A[i+1], B[opp], A[i+2]
    const a1 = (i + 1) % 3, a2 = (i + 2) % 3;
    const quad = [A.v[i], A.v[a1], B.v[opp], A.v[a2]];
    const quv = [A.uv[i], A.uv[a1], B.uv[opp], A.uv[a2]];
    // UV continuity check across the shared edge
    const bu1 = B.uv[B.v.indexOf(A.v[a1])], bu2 = B.uv[B.v.indexOf(A.v[a2])];
    const close = (p: V2, q2: V2) => Math.abs(p[0] - q2[0]) + Math.abs(p[1] - q2[1]) < 1e-4;
    if (!close(bu1, A.uv[a1]) || !close(bu2, A.uv[a2])) continue;
    // convexity check
    const pts = quad.map((v) => m.verts[v]);
    const n = polyNormal(pts);
    let convex = true;
    for (let k = 0; k < 4; k++) {
      const p0 = pts[k], p1 = pts[(k + 1) % 4], p2 = pts[(k + 2) % 4];
      const c = [(p1[1] - p0[1]) * (p2[2] - p1[2]) - (p1[2] - p0[2]) * (p2[1] - p1[1]), (p1[2] - p0[2]) * (p2[0] - p1[0]) - (p1[0] - p0[0]) * (p2[2] - p1[2]), (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0])];
      if (c[0] * n[0] + c[1] * n[1] + c[2] * n[2] <= 0) { convex = false; break; }
    }
    if (!convex) continue;
    used.add(f1); used.add(f2);
    newFaces.push({ v: quad, uv: quv });
  }
  m.faces = m.faces.filter((_, i) => !used.has(i)).concat(newFaces);
  m.selF.clear();
  m.changed();
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
