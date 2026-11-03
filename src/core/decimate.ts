import { Mesh, Face, ekey } from './mesh';
import { V2, V3 } from './vec';
import { triangulateFace } from './ops';
import { trisToQuads } from './topology';

/* ======================================================================
 * Decimation (mirrors Blender's Decimate modes).
 *
 *  collapse    – Garland & Heckbert quadric error metrics: each vertex
 *                carries the sum of its faces' plane quadrics; the edge
 *                whose contraction adds least error is collapsed first
 *                (min-heap with lazy invalidation). Boundaries get extra
 *                perpendicular constraint planes; collapses that break the
 *                link condition or flip a face are rejected.
 *  unsubdivide – reverses a subdivision on grid-like quad meshes by
 *                labelling corners original / edge / face-centre and
 *                rebuilding the coarse faces.
 *  planar      – merges neighbouring faces within an angle limit into
 *                n-gons and dissolves straight-line (collinear) vertices.
 * ==================================================================== */

export type DecimateMode = 'collapse' | 'unsubdivide' | 'planar';

export interface DecimateOptions {
  mode: DecimateMode;
  /** collapse: fraction of triangles to keep (0..1] */
  ratio?: number;
  /** collapse: rejoin triangle pairs into quads afterwards */
  quads?: boolean;
  /** collapse: keep open borders in place */
  keepBoundary?: boolean;
  /** unsubdivide: how many subdivision levels to undo */
  iterations?: number;
  /** planar: angle limit in degrees */
  angle?: number;
  /** planar: don't merge across UV seams */
  delimitSeams?: boolean;
}

export function decimate(src: Mesh, o: DecimateOptions): Mesh {
  if (!src.faces.length) return src;
  if (o.mode === 'collapse') return collapseQEM(src, o.ratio ?? 0.5, !!o.quads, o.keepBoundary !== false);
  if (o.mode === 'unsubdivide') {
    let m = src;
    for (let i = 0; i < Math.max(1, Math.round(o.iterations ?? 1)); i++) {
      const r = unsubdivide(m);
      if (!r) break;
      m = r;
    }
    return m;
  }
  return planar(src, o.angle ?? 5, !!o.delimitSeams);
}

/* ------------------------------------------------------------------ collapse (QEM) */

type Q = Float64Array; // 10 coeffs: a2 ab ac ad b2 bc bd c2 cd d2

function addPlane(q: Q, a: number, b: number, c: number, d: number, w: number) {
  q[0] += w * a * a; q[1] += w * a * b; q[2] += w * a * c; q[3] += w * a * d;
  q[4] += w * b * b; q[5] += w * b * c; q[6] += w * b * d;
  q[7] += w * c * c; q[8] += w * c * d; q[9] += w * d * d;
}
function qErr(q: Q, x: number, y: number, z: number) {
  return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x
    + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y
    + q[7] * z * z + 2 * q[8] * z + q[9];
}

class Heap {
  c: number[] = []; a: number[] = []; b: number[] = []; s: number[] = [];
  push(cost: number, a: number, b: number, stamp: number) {
    this.c.push(cost); this.a.push(a); this.b.push(b); this.s.push(stamp);
    let i = this.c.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.c[p] <= this.c[i]) break; this.swap(i, p); i = p; }
  }
  pop(): [number, number, number, number] | null {
    if (!this.c.length) return null;
    const r: [number, number, number, number] = [this.c[0], this.a[0], this.b[0], this.s[0]];
    const last = this.c.length - 1;
    this.swap(0, last);
    this.c.pop(); this.a.pop(); this.b.pop(); this.s.pop();
    let i = 0;
    const n = this.c.length;
    for (;;) {
      const l = 2 * i + 1, rr = l + 1;
      let m = i;
      if (l < n && this.c[l] < this.c[m]) m = l;
      if (rr < n && this.c[rr] < this.c[m]) m = rr;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
    return r;
  }
  private swap(i: number, j: number) {
    [this.c[i], this.c[j]] = [this.c[j], this.c[i]]; [this.a[i], this.a[j]] = [this.a[j], this.a[i]];
    [this.b[i], this.b[j]] = [this.b[j], this.b[i]]; [this.s[i], this.s[j]] = [this.s[j], this.s[i]];
  }
}

function collapseQEM(src: Mesh, ratio: number, quads: boolean, keepBoundary: boolean): Mesh {
  // triangulate (keep per-corner UVs)
  const P: V3[] = src.verts.map((p) => [p[0], p[1], p[2]]);
  const T: number[][] = [];
  const U: V2[][] = [];
  for (const f of src.faces) for (const [a, b, c] of triangulateFace(src.verts, f.v)) { T.push([f.v[a], f.v[b], f.v[c]]); U.push([f.uv[a], f.uv[b], f.uv[c]]); }
  const nT = T.length;
  const target = Math.max(4, Math.floor(nT * Math.min(1, Math.max(0.001, ratio))));
  if (target >= nT) return src;
  const alive = new Uint8Array(nT).fill(1);
  const vf: number[][] = P.map(() => []);
  T.forEach((t, i) => { for (const v of t) vf[v].push(i); });
  const Qs: Q[] = P.map(() => new Float64Array(10));
  const nrm = (t: number[]): [number, number, number, number] => {
    const [a, b, c] = t;
    const ux = P[b][0] - P[a][0], uy = P[b][1] - P[a][1], uz = P[b][2] - P[a][2];
    const vx = P[c][0] - P[a][0], vy = P[c][1] - P[a][1], vz = P[c][2] - P[a][2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return [nx, ny, nz, Math.hypot(nx, ny, nz)];
  };
  // face quadrics (area weighted)
  for (const t of T) {
    const [nx, ny, nz, l] = nrm(t);
    if (l < 1e-20) continue;
    const a = nx / l, b = ny / l, c = nz / l, d = -(a * P[t[0]][0] + b * P[t[0]][1] + c * P[t[0]][2]);
    for (const v of t) addPlane(Qs[v], a, b, c, d, l / 2);
  }
  // boundary constraint planes
  const edgeCount = new Map<string, number>();
  const edgeFace = new Map<string, number>();
  T.forEach((t, i) => { for (let k = 0; k < 3; k++) { const key = ekey(t[k], t[(k + 1) % 3]); edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1); edgeFace.set(key, i); } });
  const isBoundaryV = new Uint8Array(P.length);
  for (const [key, cnt] of edgeCount) {
    if (cnt !== 1) continue;
    const [a, b] = key.split('_').map(Number);
    isBoundaryV[a] = 1; isBoundaryV[b] = 1;
    if (!keepBoundary) continue;
    const [nx, ny, nz, l] = nrm(T[edgeFace.get(key)!]);
    if (l < 1e-20) continue;
    const ex = P[b][0] - P[a][0], ey = P[b][1] - P[a][1], ez = P[b][2] - P[a][2];
    // plane containing the edge, perpendicular to the face
    let px = ey * nz - ez * ny, py = ez * nx - ex * nz, pz = ex * ny - ey * nx;
    const pl = Math.hypot(px, py, pz);
    if (pl < 1e-20) continue;
    px /= pl; py /= pl; pz /= pl;
    const d = -(px * P[a][0] + py * P[a][1] + pz * P[a][2]);
    const w = 1000 * (ex * ex + ey * ey + ez * ez);
    addPlane(Qs[a], px, py, pz, d, w); addPlane(Qs[b], px, py, pz, d, w);
  }

  const stamp = new Int32Array(P.length);
  const heap = new Heap();
  const q = new Float64Array(10);
  const best = (a: number, b: number): [number, V3] => {
    for (let i = 0; i < 10; i++) q[i] = Qs[a][i] + Qs[b][i];
    // solve the 3x3 system for the optimal point
    const A = [q[0], q[1], q[2], q[1], q[4], q[5], q[2], q[5], q[7]];
    const det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
    const cands: V3[] = [P[a], P[b], [(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2, (P[a][2] + P[b][2]) / 2]];
    if (Math.abs(det) > 1e-12) {
      const bx = -q[3], by = -q[6], bz = -q[8];
      const x = (bx * (A[4] * A[8] - A[5] * A[7]) - A[1] * (by * A[8] - A[5] * bz) + A[2] * (by * A[7] - A[4] * bz)) / det;
      const y = (A[0] * (by * A[8] - A[5] * bz) - bx * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * bz - by * A[6])) / det;
      const z = (A[0] * (A[4] * bz - by * A[7]) - A[1] * (A[3] * bz - by * A[6]) + bx * (A[3] * A[7] - A[4] * A[6])) / det;
      // only trust the optimum if it stays near the edge
      const mx = cands[2];
      const span = Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1], P[a][2] - P[b][2]);
      if (Math.hypot(x - mx[0], y - mx[1], z - mx[2]) < span * 2) cands.push([x, y, z]);
    }
    let bc = Infinity, bp = cands[0];
    for (const c of cands) { const e = qErr(q, c[0], c[1], c[2]); if (e < bc) { bc = e; bp = c; } }
    return [Math.max(0, bc), bp];
  };
  const pushEdge = (a: number, b: number) => { const [c] = best(a, b); heap.push(c, a, b, stamp[a] + stamp[b] * 65536); };
  for (const key of edgeCount.keys()) { const [a, b] = key.split('_').map(Number); pushEdge(a, b); }

  const nbrs = (v: number) => { const s = new Set<number>(); for (const f of vf[v]) if (alive[f]) for (const u of T[f]) if (u !== v) s.add(u); return s; };
  let count = nT;
  while (count > target) {
    const e = heap.pop();
    if (!e) break;
    const [, a, b, st] = e;
    if (st !== stamp[a] + stamp[b] * 65536) continue; // stale
    const fa = vf[a].filter((f) => alive[f]), fb = vf[b].filter((f) => alive[f]);
    const shared = fa.filter((f) => T[f].includes(b));
    if (!shared.length) continue;
    // link condition: common neighbours must equal the faces on the edge
    const na = nbrs(a), nb = nbrs(b);
    let common = 0;
    for (const x of na) if (nb.has(x)) common++;
    if (common !== shared.length) continue;
    if (keepBoundary && isBoundaryV[a] && isBoundaryV[b] && shared.length === 2) continue; // would pinch a border
    const [, pos] = best(a, b);
    // reject face flips / degenerate faces
    let ok = true;
    const old = [P[a], P[b]];
    const touched = [...fa, ...fb].filter((f) => !shared.includes(f));
    const before = touched.map((f) => nrm(T[f]));
    P[a] = pos; P[b] = pos;
    for (let i = 0; i < touched.length && ok; i++) {
      const n0 = before[i], n1 = nrm(T[touched[i]]);
      if (n1[3] < 1e-14 || (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (n0[3] * n1[3] + 1e-30) < 0.2) ok = false;
    }
    if (!ok) { P[a] = old[0]; P[b] = old[1]; stamp[a]++; pushEdge(a, b); stamp[a]--; continue; }
    // collapse b -> a
    for (const f of shared) { alive[f] = 0; count--; }
    for (const f of fb) {
      if (!alive[f]) continue;
      T[f] = T[f].map((v) => (v === b ? a : v));
      vf[a].push(f);
    }
    vf[b] = [];
    for (let i = 0; i < 10; i++) Qs[a][i] += Qs[b][i];
    isBoundaryV[a] = isBoundaryV[a] | isBoundaryV[b];
    stamp[a]++; stamp[b]++;
    for (const n of nbrs(a)) pushEdge(Math.min(a, n), Math.max(a, n));
  }
  const m = new Mesh();
  m.verts = P;
  T.forEach((t, i) => { if (alive[i]) m.faces.push({ v: t.slice(), uv: U[i].map((u) => [u[0], u[1]] as V2) }); });
  m.seams = new Set([...src.seams].filter((k) => { const [a, b] = k.split('_').map(Number); return vf[a]?.length && vf[b]?.length; }));
  m.changed();
  m.cleanup();
  if (quads) { trisToQuads(m, 8); m.cleanup(); }
  return m;
}

/* ------------------------------------------------------------------ un-subdivide */

const O = 1, E = 2, Fc = 3;
void E;

/** Undo one level of quad subdivision. Returns null if the mesh isn't a subdivided quad grid. */
export function unsubdivide(src: Mesh): Mesh | null {
  if (!src.faces.length || src.faces.some((f) => f.v.length !== 4)) return null;
  const m = src;
  const label = new Uint8Array(m.verts.length);
  const done = new Uint8Array(m.faces.length);
  // label one connected component starting from a seed face; returns false on contradiction
  const tryComponent = (seed: number, rot: number): { ok: boolean; faces: number[]; verts: number[] } => {
    const lab = new Map<number, number>();
    const faces: number[] = [];
    const sf = m.faces[seed];
    const pattern = [O, E, Fc, E];
    for (let k = 0; k < 4; k++) lab.set(sf.v[k], pattern[(k + rot) % 4]);
    const queue = [seed];
    const seen = new Set([seed]);
    while (queue.length) {
      const fi = queue.shift()!;
      faces.push(fi);
      const f = m.faces[fi];
      // derive missing labels in this quad from any known corner
      let base = -1;
      for (let k = 0; k < 4 && base < 0; k++) { const l = lab.get(f.v[k]); if (l === O) base = k; else if (l === Fc) base = (k + 2) % 4; }
      if (base < 0) return { ok: false, faces, verts: [] };
      const want = [O, E, Fc, E];
      for (let k = 0; k < 4; k++) {
        const v = f.v[(base + k) % 4];
        const l = lab.get(v);
        if (l === undefined) lab.set(v, want[k]);
        else if (l !== want[k]) return { ok: false, faces, verts: [] };
      }
      for (let k = 0; k < 4; k++) {
        const e = m.edge(ekey(f.v[k], f.v[(k + 1) % 4]));
        if (!e) continue;
        for (const g of e.faces) if (!seen.has(g)) { seen.add(g); queue.push(g); }
      }
    }
    return { ok: true, faces, verts: [...lab.keys()].map((v) => { label[v] = lab.get(v)!; return v; }) };
  };
  for (let fi = 0; fi < m.faces.length; fi++) {
    if (done[fi]) continue;
    let res: { ok: boolean; faces: number[] } | null = null;
    // prefer the labelling where face-centre vertices are interior with valence = their face count
    for (let rot = 0; rot < 4 && !res; rot++) {
      const r = tryComponent(fi, rot);
      if (!r.ok) continue;
      let good = true;
      for (const v of r.verts) {
        if (label[v] === Fc && m.vertEdges(v).some((e) => e.faces.length !== 2)) { good = false; break; }
      }
      if (good) res = r;
    }
    if (!res) return null;
    for (const f of res.faces) done[f] = 1;
  }
  // rebuild: each face-centre vertex becomes one coarse face through its O corners
  const out = new Mesh();
  const remap = new Int32Array(m.verts.length).fill(-1);
  const getV = (v: number) => { if (remap[v] < 0) remap[v] = out.addVert(m.verts[v]); return remap[v]; };
  for (let c = 0; c < m.verts.length; c++) {
    if (label[c] !== Fc) continue;
    const fan = m.vertFaces(c);
    const loopV: number[] = [], loopUV: V2[] = [];
    // start anywhere; follow O -> next E -> neighbouring quad
    let fi = fan[0];
    for (let guard = 0; guard <= fan.length; guard++) {
      const f = m.faces[fi];
      const oi = f.v.findIndex((v) => label[v] === O);
      loopV.push(getV(f.v[oi])); loopUV.push(f.uv[oi]);
      const nextE = f.v[(oi + 1) % 4];
      const e = m.edge(ekey(nextE, c));
      const g = e?.faces.find((x) => x !== fi);
      if (g === undefined) return null;
      fi = g;
      if (fi === fan[0]) break;
    }
    if (loopV.length !== fan.length) return null;
    out.faces.push({ v: loopV, uv: loopUV });
  }
  out.changed();
  out.cleanup();
  return out;
}

/* ------------------------------------------------------------------ planar */

function planar(src: Mesh, angleDeg: number, delimitSeams: boolean): Mesh {
  const m = src.clone();
  m.clearSelection();
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const N = m.faces.map((_, i) => m.faceNormal(i));
  const region = new Int32Array(m.faces.length).fill(-1);
  const order = m.faces.map((_, i) => i);
  let rid = 0;
  for (const seed of order) {
    if (region[seed] >= 0) continue;
    const n0 = N[seed];
    const q = [seed];
    region[seed] = rid;
    while (q.length) {
      const fi = q.pop()!;
      const f = m.faces[fi];
      for (let i = 0; i < f.v.length; i++) {
        const k = ekey(f.v[i], f.v[(i + 1) % f.v.length]);
        if (delimitSeams && m.seams.has(k)) continue;
        const e = m.edge(k)!;
        if (e.faces.length !== 2) continue;
        for (const g of e.faces) {
          if (region[g] >= 0) continue;
          const ng = N[g];
          if (ng[0] * n0[0] + ng[1] * n0[1] + ng[2] * n0[2] < cosT) continue;
          if (ng[0] * N[fi][0] + ng[1] * N[fi][1] + ng[2] * N[fi][2] < cosT) continue;
          region[g] = rid;
          q.push(g);
        }
      }
    }
    rid++;
  }
  // merge each region with a single boundary loop into one n-gon
  const groups = new Map<number, number[]>();
  region.forEach((r, i) => (groups.get(r) ?? groups.set(r, []).get(r)!).push(i));
  const newFaces: Face[] = [];
  for (const fs of groups.values()) {
    if (fs.length === 1) { newFaces.push(m.faces[fs[0]]); continue; }
    const set = new Set(fs);
    const half = new Map<number, { to: number; uv: V2 }[]>();
    for (const fi of fs) {
      const f = m.faces[fi];
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i], b = f.v[(i + 1) % f.v.length];
        const e = m.edge(ekey(a, b))!;
        if (e.faces.filter((x) => set.has(x)).length === 1) (half.get(a) ?? half.set(a, []).get(a)!).push({ to: b, uv: f.uv[i] });
      }
    }
    let ok = [...half.values()].every((l) => l.length === 1);
    const loopV: number[] = [], loopUV: V2[] = [];
    if (ok) {
      const start = half.keys().next().value as number;
      let cur = start;
      do {
        const h = half.get(cur)![0];
        loopV.push(cur); loopUV.push(h.uv);
        cur = h.to;
        if (loopV.length > half.size) { ok = false; break; }
      } while (cur !== start);
      if (loopV.length !== half.size) ok = false;
    }
    if (ok) newFaces.push({ v: loopV, uv: loopUV });
    else for (const fi of fs) newFaces.push(m.faces[fi]); // holes inside the region: leave as is
  }
  m.faces = newFaces;
  m.changed();
  m.cleanup();
  // dissolve vertices that sit on a straight line between exactly two edges
  for (let pass = 0; pass < 3; pass++) {
    const remove = new Set<number>();
    for (let v = 0; v < m.verts.length; v++) {
      const es = m.vertEdges(v);
      if (es.length !== 2) continue;
      const a = es[0].a === v ? es[0].b : es[0].a, b = es[1].a === v ? es[1].b : es[1].a;
      const p = m.verts[v], pa = m.verts[a], pb = m.verts[b];
      const u: V3 = [pa[0] - p[0], pa[1] - p[1], pa[2] - p[2]], w: V3 = [pb[0] - p[0], pb[1] - p[1], pb[2] - p[2]];
      const lu = Math.hypot(...u), lw = Math.hypot(...w);
      if (lu < 1e-12 || lw < 1e-12) continue;
      const cosA = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (lu * lw);
      if (cosA > -Math.cos((angleDeg * Math.PI) / 180)) continue; // not straight enough
      if (m.vertFaces(v).some((f) => m.faces[f].v.length <= 3)) continue;
      if (remove.has(a) || remove.has(b)) continue;
      remove.add(v);
    }
    if (!remove.size) break;
    for (const f of m.faces) {
      const keep = f.v.map((x) => !remove.has(x));
      f.uv = f.uv.filter((_, i) => keep[i]);
      f.v = f.v.filter((_, i) => keep[i]);
    }
    m.changed();
    m.cleanup();
  }
  return m;
}
