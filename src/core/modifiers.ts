import { Mesh, Face, ekey } from './mesh';
import { V2, V3, avg2, avg3, lerp2 } from './vec';
import { remesh, RemeshMode, defaultRemeshSize } from './remesh';
import { decimate, DecimateMode } from './decimate';

export type ModifierType = 'mirror' | 'subsurf' | 'remesh' | 'decimate';

/** Modifiers too slow to re-run on every edit (deferred while dragging, hidden in edit mode). */
export const HEAVY_MODIFIERS: ModifierType[] = ['remesh', 'decimate'];

export interface Modifier {
  id: string;
  type: ModifierType;
  enabled: boolean;
  /** mirror: axis 0/1/2 ; subsurf: levels */
  axis?: 0 | 1 | 2;
  mergeDist?: number;
  levels?: number;
  // remesh
  remeshMode?: RemeshMode;
  size?: number;
  smooth?: number;
  project?: boolean;
  iterations?: number;
  quads?: boolean;
  // decimate
  decimateMode?: DecimateMode;
  ratio?: number;
  angle?: number;
  delimitSeams?: boolean;
  keepBoundary?: boolean;
}

export function newModifier(type: ModifierType, mesh?: Mesh): Modifier {
  const id = Math.random().toString(36).slice(2, 9);
  switch (type) {
    case 'mirror': return { id, type, enabled: true, axis: 0, mergeDist: 0.001 };
    case 'subsurf': return { id, type, enabled: true, levels: 1 };
    case 'remesh': return { id, type, enabled: true, remeshMode: 'voxel', size: mesh ? defaultRemeshSize(mesh, 1 / 40) : 0.05, smooth: 1, project: true, iterations: 4, quads: false };
    case 'decimate': return { id, type, enabled: true, decimateMode: 'collapse', ratio: 0.5, quads: true, keepBoundary: true, iterations: 1, angle: 5, delimitSeams: false };
  }
}

/** Evaluate the modifier stack and return a new mesh (no selection data). */
export function evaluate(base: Mesh, mods: Modifier[]): Mesh {
  let m = base;
  let copied = false;
  for (const mod of mods) {
    if (!mod.enabled) continue;
    if (!copied) { m = stripSelection(base); copied = true; }
    if (mod.type === 'mirror') m = mirror(m, mod.axis ?? 0, mod.mergeDist ?? 0.001);
    else if (mod.type === 'subsurf') for (let i = 0; i < Math.min(4, mod.levels ?? 1); i++) m = catmullClark(m);
    else if (mod.type === 'remesh') m = remesh(m, { mode: mod.remeshMode ?? 'voxel', size: mod.size ?? 0.05, smooth: mod.smooth, project: mod.project, iterations: mod.iterations, quads: mod.quads });
    else if (mod.type === 'decimate') m = decimate(m, { mode: mod.decimateMode ?? 'collapse', ratio: mod.ratio, quads: mod.quads, keepBoundary: mod.keepBoundary, iterations: mod.iterations, angle: mod.angle, delimitSeams: mod.delimitSeams });
  }
  return m;
}

function stripSelection(src: Mesh): Mesh {
  const m = new Mesh();
  m.verts = src.verts.map((p) => [p[0], p[1], p[2]] as V3);
  m.faces = src.faces.map((f) => ({ v: f.v.slice(), uv: f.uv.map((u) => [u[0], u[1]] as V2) }));
  m.looseEdges = src.looseEdges.map((e) => [e[0], e[1]] as [number, number]);
  m.seams = new Set(src.seams);
  m.changed();
  return m;
}

export function mirror(src: Mesh, axis: 0 | 1 | 2, mergeDist: number): Mesh {
  const m = new Mesh();
  m.verts = src.verts.map((p) => [p[0], p[1], p[2]] as V3);
  const n = src.verts.length;
  const map = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const p = src.verts[i];
    if (Math.abs(p[axis]) <= mergeDist) { map[i] = i; m.verts[i][axis] = 0; continue; }
    const q: V3 = [p[0], p[1], p[2]];
    q[axis] = -q[axis];
    map[i] = m.verts.length;
    m.verts.push(q);
  }
  m.faces = src.faces.map((f) => ({ v: f.v.slice(), uv: f.uv.map((u) => [u[0], u[1]] as V2) }));
  for (const f of src.faces) {
    const v = f.v.map((x) => map[x]).reverse();
    const uv = f.uv.map((u) => [u[0], u[1]] as V2).reverse();
    m.faces.push({ v, uv });
  }
  m.looseEdges = src.looseEdges.map((e) => [e[0], e[1]] as [number, number]);
  for (const [a, b] of src.looseEdges) m.looseEdges.push([map[a], map[b]]);
  m.seams = new Set(src.seams);
  for (const k of src.seams) { const [a, b] = k.split('_').map(Number); m.seams.add(ekey(map[a], map[b])); }
  m.changed();
  m.cleanup();
  return m;
}

/** One level of Catmull–Clark subdivision on an n-gon mesh (with boundary rules). */
export function catmullClark(src: Mesh): Mesh {
  const V = src.verts;
  const edges = src.edges;
  const facePts: V3[] = src.faces.map((f) => avg3(f.v.map((i) => V[i])));
  const edgePts: V3[] = edges.map((e) => {
    if (e.faces.length === 2) return avg3([V[e.a], V[e.b], facePts[e.faces[0]], facePts[e.faces[1]]]);
    return avg3([V[e.a], V[e.b]]);
  });
  const isBoundaryV = new Uint8Array(V.length);
  for (const e of edges) if (e.faces.length !== 2) { isBoundaryV[e.a] = 1; isBoundaryV[e.b] = 1; }
  const newV: V3[] = V.map((p, i) => {
    const vf = src.vertFaces(i);
    const ve = src.vertEdges(i);
    if (!vf.length) return [p[0], p[1], p[2]];
    if (isBoundaryV[i]) {
      const be = ve.filter((e) => e.faces.length !== 2);
      if (be.length !== 2) return [p[0], p[1], p[2]]; // corner / non-manifold: keep
      const a = be[0].a === i ? V[be[0].b] : V[be[0].a];
      const b = be[1].a === i ? V[be[1].b] : V[be[1].a];
      return [p[0] * 0.75 + (a[0] + b[0]) * 0.125, p[1] * 0.75 + (a[1] + b[1]) * 0.125, p[2] * 0.75 + (a[2] + b[2]) * 0.125];
    }
    const n = vf.length;
    const F = avg3(vf.map((f) => facePts[f]));
    const R = avg3(ve.map((e) => avg3([V[e.a], V[e.b]])));
    return [
      (F[0] + 2 * R[0] + (n - 3) * p[0]) / n,
      (F[1] + 2 * R[1] + (n - 3) * p[1]) / n,
      (F[2] + 2 * R[2] + (n - 3) * p[2]) / n,
    ];
  });
  const out = new Mesh();
  out.verts = newV;
  const fBase = out.verts.length;
  out.verts.push(...facePts);
  const eBase = out.verts.length;
  out.verts.push(...edgePts);
  const eIndex = (a: number, b: number) => eBase + src.edgeIndex(ekey(a, b))!;
  const faces: Face[] = [];
  src.faces.forEach((f, fi) => {
    const n = f.v.length;
    const cuv = avg2(f.uv);
    for (let i = 0; i < n; i++) {
      const prev = (i + n - 1) % n, next = (i + 1) % n;
      faces.push({
        v: [f.v[i], eIndex(f.v[i], f.v[next]), fBase + fi, eIndex(f.v[prev], f.v[i])],
        uv: [f.uv[i], lerp2(f.uv[i], f.uv[next], 0.5), cuv, lerp2(f.uv[prev], f.uv[i], 0.5)],
      });
    }
  });
  out.faces = faces;
  // loose edges: split in two
  for (const [a, b] of src.looseEdges) { const m = eIndex(a, b); out.looseEdges.push([a, m], [m, b]); }
  for (const k of src.seams) {
    const e = src.edge(k);
    if (!e) continue;
    const m = eIndex(e.a, e.b);
    out.seams.add(ekey(e.a, m)); out.seams.add(ekey(m, e.b));
  }
  out.changed();
  return out;
}
