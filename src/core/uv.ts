import { Mesh, ekey, isPinned } from './mesh';
import { V2, V3, avg3, basisFromNormal, cross, dot, normalize, polyArea, sub, len } from './vec';
import { triangulateFace } from './ops';

/* ======================================================================
 * UV tools: seam-based LSCM unwrap, smart projection, simple projections
 * and island packing. UVs are stored per face corner.
 * ==================================================================== */

export function targetFaces(m: Mesh): number[] {
  return m.selF.size ? [...m.selF].filter((i) => i < m.faces.length) : m.faces.map((_, i) => i);
}

/** Split faces into charts: connected through non-seam edges, within the given set. */
export function chartsBySeams(m: Mesh, faces: number[]): number[][] {
  const set = new Set(faces);
  const seen = new Set<number>();
  const charts: number[][] = [];
  for (const f0 of faces) {
    if (seen.has(f0)) continue;
    const chart: number[] = [];
    const q = [f0];
    seen.add(f0);
    while (q.length) {
      const fi = q.pop()!;
      chart.push(fi);
      const f = m.faces[fi];
      for (let i = 0; i < f.v.length; i++) {
        const k = ekey(f.v[i], f.v[(i + 1) % f.v.length]);
        if (m.seams.has(k)) continue;
        const e = m.edge(k)!;
        if (e.faces.length > 2) continue;
        for (const nf of e.faces) if (nf !== fi && set.has(nf) && !seen.has(nf)) { seen.add(nf); q.push(nf); }
      }
    }
    charts.push(chart);
  }
  return charts;
}

/** Number of boundary loops-ish: does the chart have any boundary edges? */
function chartHasBoundary(m: Mesh, chart: number[]): boolean {
  const set = new Set(chart);
  for (const fi of chart) {
    const f = m.faces[fi];
    for (let i = 0; i < f.v.length; i++) {
      const k = ekey(f.v[i], f.v[(i + 1) % f.v.length]);
      if (m.seams.has(k)) return true;
      const e = m.edge(k)!;
      if (e.faces.filter((x) => set.has(x)).length < 2) return true;
    }
  }
  return false;
}

/** Islands produced by an unwrap: face -> per-corner uv. `fixed` islands are already placed (not packed). */
type Island = { faces: number[]; uv: Map<number, V2[]>; fixed?: boolean };

export interface ChartOptions {
  /** respect pinned corners (2+ pins: solved around them; 1 pin: anchored there) */
  pins?: boolean;
  /** fit the result onto the chart's current UVs (rotation, scale, position) instead of leaving it for packing */
  inPlace?: boolean;
}

/** Least Squares Conformal Map of one chart. Returns null if it fails. */
export function lscmChart(m: Mesh, chart: number[], opts: ChartOptions = {}): Island | null {
  // Local vertices are "wedges": face corners of the same mesh vertex that are
  // connected through non-seam edges inside the chart. Vertices on a seam get
  // one wedge per side, which is what actually cuts the surface open.
  const chartSet = new Set(chart);
  const cornerBase = new Map<number, number>();
  let nc = 0;
  for (const fi of chart) { cornerBase.set(fi, nc); nc += m.faces[fi].v.length; }
  const parent = new Int32Array(nc).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const cornerOf = (fi: number, v: number) => cornerBase.get(fi)! + m.faces[fi].v.indexOf(v);
  for (const fi of chart) {
    const f = m.faces[fi];
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i], b = f.v[(i + 1) % f.v.length];
      const k = ekey(a, b);
      if (m.seams.has(k)) continue;
      const e = m.edge(k)!;
      if (e.faces.length !== 2) continue;
      const g = e.faces[0] === fi ? e.faces[1] : e.faces[0];
      if (!chartSet.has(g) || g < fi) continue;
      union(cornerOf(fi, a), cornerOf(g, a));
      union(cornerOf(fi, b), cornerOf(g, b));
    }
  }
  const local = new Map<number, number>(); // corner root -> local index
  const verts: number[] = []; // local index -> mesh vertex
  const wedge = (fi: number, ci: number) => {
    const r = find(cornerBase.get(fi)! + ci);
    let l = local.get(r);
    if (l === undefined) { l = verts.length; local.set(r, l); verts.push(m.faces[fi].v[ci]); }
    return l;
  };
  for (const fi of chart) m.faces[fi].v.forEach((_, ci) => wedge(fi, ci));
  const n = verts.length;
  if (n < 3) return null;
  // current UV per wedge (warm start / in-place fit) and pinned wedges
  const curUV: V2[] = new Array(n);
  const pinUV = new Map<number, V2>();
  for (const fi of chart) {
    const f = m.faces[fi];
    f.v.forEach((_, ci) => {
      const l = wedge(fi, ci);
      if (!curUV[l]) curUV[l] = [f.uv[ci][0], f.uv[ci][1]];
      if (opts.pins && isPinned(f, ci) && !pinUV.has(l)) pinUV.set(l, [f.uv[ci][0], f.uv[ci][1]]);
    });
  }
  let pinSpan = 0;
  if (pinUV.size >= 2) {
    const ps = [...pinUV.values()];
    for (const a of ps) for (const b of ps) pinSpan = Math.max(pinSpan, Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  const solvePinned = pinSpan > 1e-9;
  // triangles with local coords
  type Tri = { i: number[]; w: [number, number][] };
  const tris: Tri[] = [];
  for (const fi of chart) {
    const f = m.faces[fi];
    for (const [a, b, c] of triangulateFace(m.verts, f.v)) {
      const ids = [f.v[a], f.v[b], f.v[c]];
      const wids = [wedge(fi, a), wedge(fi, b), wedge(fi, c)];
      const P = ids.map((v) => m.verts[v]);
      const e1 = sub(P[1], P[0]), e2 = sub(P[2], P[0]);
      const nrm = cross(e1, e2);
      const area2 = len(nrm);
      if (area2 < 1e-14) continue;
      const ux = normalize(e1);
      const uy = normalize(cross(nrm, e1));
      const x = [0, len(e1), dot(e2, ux)];
      const y = [0, 0, dot(e2, uy)];
      const s = 1 / Math.sqrt(area2);
      // W_j = (x_k - x_l) + i (y_k - y_l), (j,k,l) cyclic
      const w: [number, number][] = [0, 1, 2].map((j) => {
        const k = (j + 1) % 3, l = (j + 2) % 3;
        return [(x[l] - x[k]) * s, (y[l] - y[k]) * s];
      });
      tris.push({ i: wids, w });
    }
  }
  if (!tris.length) return null;

  // pin two far-apart vertices (or use the user's pins)
  const P = verts.map((v) => m.verts[v]);
  let p0 = 0, p1 = 0, best = -1;
  // approx diameter: farthest from first, then farthest from that
  const far = (from: number) => { let bi = from, bd = -1; for (let i = 0; i < n; i++) { const d = len(sub(P[i], P[from])); if (d > bd) { bd = d; bi = i; } } return bi; };
  p0 = far(0); p1 = far(p0); best = len(sub(P[p0], P[p1]));
  if (!solvePinned && (p0 === p1 || best < 1e-9)) return null;

  // unknown index map: 2 values (u,v) per free vertex
  const pinned = solvePinned ? pinUV : new Map<number, V2>([[p0, [0, 0]], [p1, [best, 0]]]);
  const freeIdx = new Int32Array(n).fill(-1);
  let nf = 0;
  for (let i = 0; i < n; i++) if (!pinned.has(i)) freeIdx[i] = nf++;
  const N = nf * 2;

  // rows: for each tri, real and imaginary residual rows
  type Row = { idx: number[]; val: number[]; rhs: number };
  const rows: Row[] = [];
  for (const t of tris) {
    const re: Row = { idx: [], val: [], rhs: 0 }, im: Row = { idx: [], val: [], rhs: 0 };
    for (let j = 0; j < 3; j++) {
      const vi = t.i[j];
      const [a, b] = t.w[j];
      // real: a*u - b*v ; imag: b*u + a*v
      const pin = pinned.get(vi);
      if (pin) {
        re.rhs -= a * pin[0] - b * pin[1];
        im.rhs -= b * pin[0] + a * pin[1];
      } else {
        const ui = freeIdx[vi] * 2, vv = ui + 1;
        re.idx.push(ui, vv); re.val.push(a, -b);
        im.idx.push(ui, vv); im.val.push(b, a);
      }
    }
    rows.push(re, im);
  }
  // CG on normal equations: (A^T A) x = A^T rhs
  const Ax = (x: Float64Array, out: Float64Array) => {
    out.fill(0);
    const tmp = new Float64Array(rows.length);
    for (let r = 0; r < rows.length; r++) { const row = rows[r]; let s = 0; for (let k = 0; k < row.idx.length; k++) s += row.val[k] * x[row.idx[k]]; tmp[r] = s; }
    for (let r = 0; r < rows.length; r++) { const row = rows[r]; const s = tmp[r]; for (let k = 0; k < row.idx.length; k++) out[row.idx[k]] += row.val[k] * s; }
  };
  const b = new Float64Array(N);
  for (const row of rows) for (let k = 0; k < row.idx.length; k++) b[row.idx[k]] += row.val[k] * row.rhs;
  // initial guess: the current UVs when solving around pins (fast while dragging),
  // else a planar projection onto the best-fit plane
  const x = new Float64Array(N);
  if (solvePinned) {
    for (let i = 0; i < n; i++) if (freeIdx[i] >= 0) { x[freeIdx[i] * 2] = curUV[i][0]; x[freeIdx[i] * 2 + 1] = curUV[i][1]; }
  } else {
    const dir = normalize(sub(P[p1], P[p0]));
    let nrm: V3 = [0, 0, 0];
    for (const fi of chart) { const fn = m.faceNormal(fi); nrm = [nrm[0] + fn[0], nrm[1] + fn[1], nrm[2] + fn[2]]; }
    nrm = normalize(nrm);
    if (len(nrm) < 0.5) nrm = basisFromNormal(dir)[0];
    const yax = normalize(cross(nrm, dir));
    for (let i = 0; i < n; i++) {
      if (freeIdx[i] < 0) continue;
      const d = sub(P[i], P[p0]);
      x[freeIdx[i] * 2] = dot(d, dir);
      x[freeIdx[i] * 2 + 1] = dot(d, yax);
    }
  }
  const r = new Float64Array(N), p = new Float64Array(N), Ap = new Float64Array(N);
  Ax(x, Ap);
  for (let i = 0; i < N; i++) { r[i] = b[i] - Ap[i]; p[i] = r[i]; }
  let rs = r.reduce((s, v) => s + v * v, 0);
  const tol = 1e-12 * Math.max(1, b.reduce((s, v) => s + v * v, 0));
  const maxIt = Math.min(5000, 4 * N + 100);
  for (let it = 0; it < maxIt && rs > tol; it++) {
    Ax(p, Ap);
    let pAp = 0;
    for (let i = 0; i < N; i++) pAp += p[i] * Ap[i];
    if (Math.abs(pAp) < 1e-30) break;
    const alpha = rs / pAp;
    for (let i = 0; i < N; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
    const rsNew = r.reduce((s, v) => s + v * v, 0);
    const beta = rsNew / rs;
    for (let i = 0; i < N; i++) p[i] = r[i] + beta * p[i];
    rs = rsNew;
  }
  const uvLocal: V2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const pin = pinned.get(i);
    uvLocal[i] = pin ? [pin[0], pin[1]] : [x[freeIdx[i] * 2], x[freeIdx[i] * 2 + 1]];
    if (!isFinite(uvLocal[i][0]) || !isFinite(uvLocal[i][1])) return null;
  }
  let fixed = solvePinned;
  if (!solvePinned) {
    // un-mirror if the map is orientation reversing
    let signed = 0;
    for (const fi of chart) {
      const f = m.faces[fi];
      const pts = f.v.map((_, ci) => uvLocal[wedge(fi, ci)]);
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b2 = pts[(i + 1) % pts.length]; signed += a[0] * b2[1] - b2[0] * a[1]; }
    }
    if (signed < 0) for (const u of uvLocal) u[0] = -u[0];
    // one pin, or re-unwrapping in place: fit onto the current UVs, then anchor the pin exactly
    if (pinUV.size >= 1 || opts.inPlace) {
      const fit = fitSimilarity(uvLocal, curUV);
      if (fit) {
        for (const u of uvLocal) { const x0 = u[0], y0 = u[1]; u[0] = fit.a * x0 - fit.b * y0 + fit.tx; u[1] = fit.b * x0 + fit.a * y0 + fit.ty; }
        if (pinUV.size >= 1) {
          const [l, target] = [...pinUV][0];
          const dx = target[0] - uvLocal[l][0], dy = target[1] - uvLocal[l][1];
          for (const u of uvLocal) { u[0] += dx; u[1] += dy; }
        }
        fixed = true;
      }
    }
  }
  const uv = new Map<number, V2[]>();
  for (const fi of chart) uv.set(fi, m.faces[fi].v.map((_, ci) => { const u = uvLocal[wedge(fi, ci)]; return [u[0], u[1]] as V2; }));
  return { faces: chart, uv, fixed };
}

/**
 * Least-squares similarity (rotation, uniform scale, translation) taking
 * points `a` onto `b`, as z ↦ (a + ib)·z + t. Null when `b` is degenerate.
 */
function fitSimilarity(a: V2[], b: V2[]): { a: number; b: number; tx: number; ty: number } | null {
  const n = a.length;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) { ax += a[i][0]; ay += a[i][1]; bx += b[i][0]; by += b[i][1]; }
  ax /= n; ay /= n; bx /= n; by /= n;
  let num1 = 0, num2 = 0, den = 0, spreadB = 0;
  for (let i = 0; i < n; i++) {
    const px = a[i][0] - ax, py = a[i][1] - ay, qx = b[i][0] - bx, qy = b[i][1] - by;
    num1 += px * qx + py * qy;
    num2 += px * qy - py * qx;
    den += px * px + py * py;
    spreadB += qx * qx + qy * qy;
  }
  if (den < 1e-18 || spreadB < 1e-14) return null;
  const ra = num1 / den, rb = num2 / den;
  // a mirrored previous layout gives a poor (near-zero) fit: treat as no reference
  if (Math.hypot(ra, rb) * Math.sqrt(den) < Math.sqrt(spreadB) * 0.25) return null;
  return { a: ra, b: rb, tx: bx - (ra * ax - rb * ay), ty: by - (rb * ax + ra * ay) };
}

/** Planar projection of a group of faces along `n`. */
function planarIsland(m: Mesh, faces: number[], n: V3): Island {
  const [u, v] = basisFromNormal(normalize(n));
  const uv = new Map<number, V2[]>();
  for (const fi of faces) uv.set(fi, m.faces[fi].v.map((x) => [dot(m.verts[x], u), dot(m.verts[x], v)] as V2));
  return { faces, uv };
}

/** Group faces by normal similarity (greedy clustering) then split into connected islands. */
export function smartProjectIslands(m: Mesh, faces: number[], angleDeg = 66): Island[] {
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const normals = new Map<number, V3>(faces.map((f) => [f, m.faceNormal(f)]));
  const areas = new Map<number, number>(faces.map((f) => [f, polyArea(m.faces[f].v.map((v) => m.verts[v]))]));
  const remaining = new Set(faces);
  const islands: Island[] = [];
  while (remaining.size) {
    // seed: largest-area remaining face
    let seed = -1, ba = -1;
    for (const f of remaining) if (areas.get(f)! > ba) { ba = areas.get(f)!; seed = f; }
    const dir = normals.get(seed)!;
    // grow connected region with normals within threshold of the seed direction
    const region: number[] = [];
    const q = [seed];
    remaining.delete(seed);
    while (q.length) {
      const fi = q.pop()!;
      region.push(fi);
      const f = m.faces[fi];
      for (let i = 0; i < f.v.length; i++) {
        const k = ekey(f.v[i], f.v[(i + 1) % f.v.length]);
        if (m.seams.has(k)) continue;
        for (const nf of m.edge(k)!.faces) {
          if (!remaining.has(nf)) continue;
          if (dot(normals.get(nf)!, dir) >= cosT) { remaining.delete(nf); q.push(nf); }
        }
      }
    }
    let avg: V3 = [0, 0, 0];
    for (const f of region) { const nn = normals.get(f)!, a = areas.get(f)!; avg = [avg[0] + nn[0] * a, avg[1] + nn[1] * a, avg[2] + nn[2] * a]; }
    islands.push(planarIsland(m, region, len(avg) > 1e-9 ? avg : dir));
  }
  return islands;
}

export function unwrapLSCM(m: Mesh, margin = 0.02): { charts: number; fallback: number; pinned: number } {
  const faces = targetFaces(m);
  const charts = chartsBySeams(m, faces);
  const islands: Island[] = [];
  let fallback = 0, pinned = 0;
  for (const c of charts) {
    let isl: Island | null = null;
    if (chartHasBoundary(m, c)) isl = lscmChart(m, c, { pins: true });
    if (isl && !islandOK(m, isl)) isl = null;
    if (!isl) { fallback++; islands.push(...smartProjectIslands(m, c)); }
    else if (isl.fixed) { placeIsland(m, isl); pinned++; }
    else islands.push(isl);
  }
  // islands anchored by pins stay where they are; the rest are packed
  applyIslands(m, islands, margin);
  m.uvChanged();
  return { charts: islands.length + pinned, fallback, pinned };
}

function placeIsland(m: Mesh, isl: Island) {
  for (const [fi, uv] of isl.uv) m.faces[fi].uv = uv;
}

/** Seam charts (over the whole mesh) that contain any of the given faces. */
export function chartsOf(m: Mesh, faces: Iterable<number>): number[][] {
  const want = new Set(faces);
  return chartsBySeams(m, m.faces.map((_, i) => i)).filter((c) => c.some((f) => want.has(f)));
}

/**
 * Live unwrap: re-solve the given charts in place, around their pins (or
 * fitted onto their current layout when unpinned). Closed charts are skipped.
 */
export function liveUnwrap(m: Mesh, charts: number[][]): { solved: number; skipped: number } {
  let solved = 0, skipped = 0;
  for (const c of charts) {
    const isl = chartHasBoundary(m, c) ? lscmChart(m, c, { pins: true, inPlace: true }) : null;
    if (isl?.fixed && islandOK(m, isl)) { placeIsland(m, isl); solved++; } else skipped++;
  }
  if (solved) m.uvChanged();
  return { solved, skipped };
}

/* ------------------------------------------------------------------ stretch */

export type StretchMode = 'angle' | 'area';

/**
 * Per-face UV distortion in [0, 1] (0 = none). Angle: how far each triangle's
 * mapping is from conformal (1 − σmin/σmax of its Jacobian). Area: how far the
 * face's share of UV area is from its share of surface area. Faces with no UV
 * area count as fully stretched.
 */
export function uvStretch(m: Mesh, faces: number[], mode: StretchMode): { face: Float32Array; mean: number } {
  const out = new Float32Array(m.faces.length);
  const a3 = new Float64Array(m.faces.length), a2 = new Float64Array(m.faces.length);
  let tot3 = 0, tot2 = 0;
  for (const fi of faces) {
    const f = m.faces[fi];
    let ang = 0, wsum = 0;
    for (const [i, j, k] of f.v.length === 3 ? [[0, 1, 2]] : triangulateFace(m.verts, f.v)) {
      const P0 = m.verts[f.v[i]], P1 = m.verts[f.v[j]], P2 = m.verts[f.v[k]];
      const e1 = sub(P1, P0), e2 = sub(P2, P0);
      const nrm = cross(e1, e2);
      const area3 = len(nrm) / 2;
      if (area3 < 1e-14) continue;
      const ux = normalize(e1), uy = normalize(cross(nrm, e1));
      // 3D triangle in its own plane
      const x1 = len(e1), x2 = dot(e2, ux), y2 = dot(e2, uy);
      const u0 = f.uv[i], u1 = f.uv[j], u2 = f.uv[k];
      const du1 = [u1[0] - u0[0], u1[1] - u0[1]], du2 = [u2[0] - u0[0], u2[1] - u0[1]];
      const area2 = Math.abs(du1[0] * du2[1] - du1[1] * du2[0]) / 2;
      a3[fi] += area3; a2[fi] += area2;
      if (mode === 'angle') {
        // Jacobian J = [du1 du2] · inv([x1 x2; 0 y2])
        const inv = [1 / x1, -x2 / (x1 * y2), 0, 1 / y2];
        const J = [du1[0] * inv[0] + du2[0] * inv[2], du1[0] * inv[1] + du2[0] * inv[3], du1[1] * inv[0] + du2[1] * inv[2], du1[1] * inv[1] + du2[1] * inv[3]];
        const E = J[0] * J[0] + J[2] * J[2], F = J[0] * J[1] + J[2] * J[3], G = J[1] * J[1] + J[3] * J[3];
        const r = Math.sqrt(((E - G) / 2) ** 2 + F * F);
        const smax = Math.sqrt(Math.max(0, (E + G) / 2 + r)), smin = Math.sqrt(Math.max(0, (E + G) / 2 - r));
        ang += (smax > 1e-12 ? 1 - smin / smax : 1) * area3;
        wsum += area3;
      }
    }
    tot3 += a3[fi]; tot2 += a2[fi];
    if (mode === 'angle') out[fi] = wsum > 0 ? ang / wsum : 1;
  }
  if (mode === 'area') {
    for (const fi of faces) {
      if (a3[fi] <= 0) { out[fi] = 0; continue; }
      if (a2[fi] <= 1e-14 || tot2 <= 0) { out[fi] = 1; continue; }
      const r = (a2[fi] / tot2) / (a3[fi] / tot3);
      out[fi] = 1 - Math.min(r, 1 / r);
    }
  }
  let mean = 0, w = 0;
  for (const fi of faces) { mean += out[fi] * a3[fi]; w += a3[fi]; }
  return { face: out, mean: w > 0 ? mean / w : 0 };
}

/** Sanity check: islands with collapsed or wildly distorted area are rejected. */
function islandOK(m: Mesh, isl: Island): boolean {
  let a3 = 0, a2 = 0;
  for (const fi of isl.faces) {
    a3 += polyArea(m.faces[fi].v.map((v) => m.verts[v]));
    const uv = isl.uv.get(fi)!;
    let s = 0;
    for (let i = 0; i < uv.length; i++) { const p = uv[i], q = uv[(i + 1) % uv.length]; s += p[0] * q[1] - q[0] * p[1]; }
    a2 += Math.abs(s) / 2;
  }
  return a2 > a3 * 1e-4 && isFinite(a2);
}

export function smartProject(m: Mesh, angle = 66, margin = 0.02) {
  const islands = smartProjectIslands(m, targetFaces(m), angle);
  applyIslands(m, islands, margin);
  return islands.length;
}

export type Projection = 'cube' | 'cylinder' | 'sphere' | 'view';

/** Simple projections. `viewDir`/`viewUp` are object-space vectors used by 'view'. */
export function project(m: Mesh, kind: Projection, viewRight?: V3, viewUp?: V3) {
  const faces = targetFaces(m);
  if (!faces.length) return;
  const center = avg3(faces.flatMap((f) => m.faces[f].v.map((v) => m.verts[v])));
  let maxR = 1e-9;
  for (const f of faces) for (const v of m.faces[f].v) maxR = Math.max(maxR, len(sub(m.verts[v], center)));
  if (kind === 'view') {
    const r = viewRight ?? [1, 0, 0], u = viewUp ?? [0, 1, 0];
    for (const fi of faces) m.faces[fi].uv = m.faces[fi].v.map((v) => { const d = sub(m.verts[v], center); return [0.5 + dot(d, r) / (2 * maxR), 0.5 + dot(d, u) / (2 * maxR)] as V2; });
  } else if (kind === 'cube') {
    const islands: Island[] = [];
    const groups = new Map<string, number[]>();
    for (const fi of faces) {
      const n = m.faceNormal(fi);
      const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
      const k = `${ax}${n[ax] >= 0 ? '+' : '-'}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(fi);
    }
    for (const [k, g] of groups) {
      const ax = +k[0];
      const n: V3 = [0, 0, 0]; n[ax] = k[1] === '+' ? 1 : -1;
      // keep cube projection in a common scale by not normalizing each island
      islands.push(planarIsland(m, g, n));
    }
    applyIslands(m, islands, 0.02);
    return;
  } else if (kind === 'cylinder' || kind === 'sphere') {
    for (const fi of faces) {
      const f = m.faces[fi];
      const uvs = f.v.map((v) => {
        const d = sub(m.verts[v], center);
        const u = 0.5 + Math.atan2(-d[2], d[0]) / (2 * Math.PI);
        const vv = kind === 'cylinder' ? 0.5 + d[1] / (2 * maxR) : 0.5 + Math.asin(Math.max(-1, Math.min(1, d[1] / Math.max(1e-9, len(d))))) / Math.PI;
        return [u, vv] as V2;
      });
      // fix wrap-around seam inside a face
      const us = uvs.map((x) => x[0]);
      if (Math.max(...us) - Math.min(...us) > 0.5) for (const x of uvs) if (x[0] < 0.5) x[0] += 1;
      f.uv = uvs;
    }
  }
  m.uvChanged();
}

/** Scale islands to uniform texel density, then shelf-pack them into [0,1]². */
function applyIslands(m: Mesh, islands: Island[], margin: number) {
  if (!islands.length) return;
  type Box = { isl: Island; w: number; h: number; minU: number; minV: number; x: number; y: number };
  const boxes: Box[] = [];
  for (const isl of islands) {
    // density normalisation
    let a3 = 0, a2 = 0;
    for (const fi of isl.faces) {
      a3 += polyArea(m.faces[fi].v.map((v) => m.verts[v]));
      const uv = isl.uv.get(fi)!;
      let s = 0;
      for (let i = 0; i < uv.length; i++) { const p = uv[i], q = uv[(i + 1) % uv.length]; s += p[0] * q[1] - q[0] * p[1]; }
      a2 += Math.abs(s) / 2;
    }
    const k = a2 > 1e-12 ? Math.sqrt(a3 / a2) : 1;
    // rotate to minimise bounding box (test a few angles)
    const all: V2[] = [];
    for (const uv of isl.uv.values()) for (const p of uv) { p[0] *= k; p[1] *= k; all.push(p); }
    let bestA = 0, bestArea = Infinity;
    for (let s = 0; s < 18; s++) {
      const a = (s / 18) * (Math.PI / 2);
      const c = Math.cos(a), sn = Math.sin(a);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of all) { const x = p[0] * c - p[1] * sn, y = p[0] * sn + p[1] * c; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const ar = (x1 - x0) * (y1 - y0);
      if (ar < bestArea - 1e-12) { bestArea = ar; bestA = a; }
    }
    const c = Math.cos(bestA), sn = Math.sin(bestA);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of all) { const x = p[0] * c - p[1] * sn, y = p[0] * sn + p[1] * c; p[0] = x; p[1] = y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    // keep islands wider than tall
    if (y1 - y0 > x1 - x0) { for (const p of all) { const x = p[0]; p[0] = -p[1]; p[1] = x; } [x0, x1, y0, y1] = [-y1, -y0, x0, x1]; }
    boxes.push({ isl, w: x1 - x0, h: y1 - y0, minU: x0, minV: y0, x: 0, y: 0 });
  }
  packBoxes(boxes, margin);
  for (const b of boxes) {
    for (const [fi, uv] of b.isl.uv) {
      m.faces[fi].uv = uv.map((p) => [p[0] - b.minU + b.x, p[1] - b.minV + b.y] as V2);
    }
  }
  // normalise to unit square
  const total = boxes.reduce((s, b) => Math.max(s, b.x + b.w, b.y + b.h), 0);
  const sc = total > 0 ? (1 - margin) / total : 1;
  for (const b of boxes) for (const fi of b.isl.faces) m.faces[fi].uv = m.faces[fi].uv.map((p) => [p[0] * sc + margin / 2, p[1] * sc + margin / 2] as V2);
  m.uvChanged();
}

/** Shelf packing; finds a square-ish layout. Positions in island units. */
function packBoxes(boxes: { w: number; h: number; x: number; y: number }[], marginFrac: number) {
  const totalArea = boxes.reduce((s, b) => s + b.w * b.h, 0);
  const maxW = Math.max(...boxes.map((b) => b.w));
  const pad = Math.sqrt(totalArea) * marginFrac;
  const order = boxes.slice().sort((a, b) => b.h - a.h);
  let best = Infinity, bestPos: [number, number][] = [];
  for (const f of [1, 1.1, 1.25, 1.4, 1.6, 2]) {
    const width = Math.max(maxW + pad, Math.sqrt(totalArea) * f);
    let x = 0, y = 0, rowH = 0, usedW = 0;
    const pos: [number, number][] = [];
    for (const b of order) {
      if (x > 0 && x + b.w > width) { x = 0; y += rowH + pad; rowH = 0; }
      pos.push([x, y]);
      x += b.w + pad; rowH = Math.max(rowH, b.h);
      usedW = Math.max(usedW, x);
    }
    const side = Math.max(usedW, y + rowH);
    if (side < best) { best = side; bestPos = pos; }
  }
  order.forEach((b, i) => { b.x = bestPos[i][0]; b.y = bestPos[i][1]; });
}

/** Re-pack the existing UV islands of the target faces (keeping shapes). */
export function packExisting(m: Mesh, margin = 0.02) {
  const faces = targetFaces(m);
  const islands = uvIslands(m, faces).map((fs) => ({ faces: fs, uv: new Map(fs.map((f) => [f, m.faces[f].uv.map((u) => [u[0], u[1]] as V2)])) }));
  applyIslands(m, islands, margin);
}

/** Connected UV islands: faces sharing an edge whose two corner UVs match. */
export function uvIslands(m: Mesh, faces: number[], eps = 1e-5): number[][] {
  const set = new Set(faces);
  const seen = new Set<number>();
  const res: number[][] = [];
  const same = (a: V2, b: V2) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
  for (const f0 of faces) {
    if (seen.has(f0)) continue;
    const isl: number[] = [];
    const q = [f0];
    seen.add(f0);
    while (q.length) {
      const fi = q.pop()!;
      isl.push(fi);
      const f = m.faces[fi];
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i], b = f.v[(i + 1) % f.v.length];
        const ua = f.uv[i], ub = f.uv[(i + 1) % f.v.length];
        const e = m.edge(ekey(a, b));
        if (!e) continue;
        for (const nf of e.faces) {
          if (nf === fi || !set.has(nf) || seen.has(nf)) continue;
          const g = m.faces[nf];
          const ga = g.uv[g.v.indexOf(a)], gb = g.uv[g.v.indexOf(b)];
          if (same(ga, ua) && same(gb, ub)) { seen.add(nf); q.push(nf); }
        }
      }
    }
    res.push(isl);
  }
  return res;
}

/** Mark seams along existing UV island borders. */
export function seamsFromIslands(m: Mesh) {
  const faces = m.faces.map((_, i) => i);
  const islands = uvIslands(m, faces);
  const islandOf = new Int32Array(m.faces.length);
  islands.forEach((isl, i) => isl.forEach((f) => (islandOf[f] = i)));
  for (const e of m.edges) if (e.faces.length === 2 && islandOf[e.faces[0]] !== islandOf[e.faces[1]]) m.seams.add(e.key);
  m.uvChanged();
}
