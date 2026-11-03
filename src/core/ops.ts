import { Mesh, Face, ekey, parseKey, SelectMode } from './mesh';
import { V2, V3, add, avg2, avg3, basisFromNormal, cross, dot, lerp, lerp2, normalize, polyNormal, sub } from './vec';
import { ShapeUtils, Vector2 } from 'three';

/* ======================================================================
 * Edit-mode operations. Every function mutates the mesh in place and
 * leaves a sensible selection behind (usually the newly created geometry).
 * ==================================================================== */

/** Vertices affected by a transform for the current selection. */
export function selectedVerts(m: Mesh): number[] {
  return [...m.selV].filter((v) => v < m.verts.length);
}

/** Corner UV for vertex v in face f, if the face uses it. */
function cornerUV(f: Face, v: number): V2 | undefined {
  const i = f.v.indexOf(v);
  return i >= 0 ? f.uv[i] : undefined;
}

/** Insert vertex nv into every face that has edge (a,b), between a and b. */
function splitEdgeInFaces(m: Mesh, a: number, b: number, nv: number, t: number, skip?: Set<number>) {
  // t is measured from a toward b
  m.faces.forEach((f, fi) => {
    if (skip?.has(fi)) return;
    const n = f.v.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (f.v[i] === a && f.v[j] === b) {
        f.v.splice(i + 1, 0, nv); f.uv.splice(i + 1, 0, lerp2(f.uv[i], f.uv[j], t));
        return;
      }
      if (f.v[i] === b && f.v[j] === a) {
        f.v.splice(i + 1, 0, nv); f.uv.splice(i + 1, 0, lerp2(f.uv[i], f.uv[j], 1 - t));
        return;
      }
    }
  });
  // loose edge split
  const li = m.looseEdges.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
  if (li >= 0) { m.looseEdges.splice(li, 1, [a, nv], [nv, b]); }
}

// ---------------------------------------------------------------- extrude

export interface ExtrudeResult {
  /** Newly created vertices that should follow the subsequent grab. */
  moveVerts: number[];
  /** Suggested constraint direction (average normal) in object space. */
  normal: V3 | null;
}

/** Extrude selected faces as a region. */
export function extrudeFaces(m: Mesh): ExtrudeResult {
  const region = [...m.selF].filter((i) => i < m.faces.length);
  if (!region.length) return { moveVerts: [], normal: null };
  const regionSet = new Set(region);
  const normal = normalize(region.map((f) => m.faceNormal(f)).reduce((a, b) => add(a, b), [0, 0, 0] as V3));

  // boundary edges of region (directed as in their region face)
  const boundary: [number, number, Face][] = [];
  for (const fi of region) {
    const f = m.faces[fi];
    const n = f.v.length;
    for (let i = 0; i < n; i++) {
      const a = f.v[i], b = f.v[(i + 1) % n];
      const e = m.edge(ekey(a, b))!;
      const inRegion = e.faces.filter((x) => regionSet.has(x)).length;
      if (inRegion === 1) boundary.push([a, b, f]);
    }
  }
  const map = new Map<number, number>();
  for (const fi of region) for (const v of m.faces[fi].v) if (!map.has(v)) map.set(v, m.addVert(m.verts[v]));

  const sideFaces: number[] = [];
  for (const [a, b, f] of boundary) {
    const ua = cornerUV(f, a)!, ub = cornerUV(f, b)!;
    sideFaces.push(m.addFace([a, b, map.get(b)!, map.get(a)!], [ua, ub, ub, ua]));
  }
  for (const fi of region) { const f = m.faces[fi]; f.v = f.v.map((v) => map.get(v)!); }

  // selection: the moved region
  m.selF = new Set(region);
  m.changed();
  m.flush('face');
  // remove interior verts that became orphaned
  m.cleanup();
  const moveVerts = [...m.selV];
  return { moveVerts, normal };
}

/** Extrude selected edges (or lone vertices) into new geometry. */
export function extrudeEdges(m: Mesh): ExtrudeResult {
  const edges = [...m.selE].map(parseKey);
  const map = new Map<number, number>();
  const dup = (v: number) => { let n = map.get(v); if (n === undefined) { n = m.addVert(m.verts[v]); map.set(v, n); } return n; };
  const newSelE = new Set<string>();
  let nrm: V3 = [0, 0, 0];
  for (const [a0, b0] of edges) {
    let a = a0, b = b0;
    const e = m.edge(ekey(a, b));
    let uvA: V2 = [0, 0], uvB: V2 = [0, 0];
    if (e && e.faces.length) {
      const f = m.faces[e.faces[0]];
      const i = f.v.indexOf(a), j = f.v.indexOf(b);
      // orient side quad opposite to the face's direction along the edge
      if ((i + 1) % f.v.length === j) { [a, b] = [b, a]; }
      uvA = f.uv[f.v.indexOf(a)]; uvB = f.uv[f.v.indexOf(b)];
      nrm = add(nrm, m.faceNormal(e.faces[0]));
    }
    const na = dup(a), nb = dup(b);
    m.addFace([a, b, nb, na], [uvA, uvB, uvB, uvA]);
    newSelE.add(ekey(na, nb));
  }
  // lone selected vertices (not part of any selected edge)
  const inEdge = new Set(edges.flat());
  for (const v of m.selV) {
    if (inEdge.has(v)) continue;
    const nv = dup(v);
    m.looseEdges.push([v, nv]);
  }
  m.changed();
  m.selV = new Set(map.values());
  m.selE = newSelE;
  m.selF.clear();
  m.cleanup();
  const l = Math.hypot(...nrm);
  return { moveVerts: [...m.selV], normal: l > 1e-9 && edges.length ? normalize(nrm) : null };
}

export function extrude(m: Mesh, mode: SelectMode): ExtrudeResult {
  if (mode === 'face' || (m.selF.size && mode !== 'edge' && m.selF.size * 1 > 0 && allSelectedCoveredByFaces(m))) return extrudeFaces(m);
  return extrudeEdges(m);
}

function allSelectedCoveredByFaces(m: Mesh) {
  const cov = new Set<number>();
  for (const f of m.selF) for (const v of m.faces[f].v) cov.add(v);
  for (const v of m.selV) if (!cov.has(v)) return false;
  return true;
}

// ---------------------------------------------------------------- inset

export interface InsetHandle {
  /** Re-position inner vertices for amount in [0,1). */
  set(amount: number, depth: number): void;
}

/** Inset each selected face individually. Returns a handle for interactive tweaking. */
export function insetFaces(m: Mesh): InsetHandle | null {
  const sel = [...m.selF].filter((i) => i < m.faces.length);
  if (!sel.length) return null;
  const records: { nv: number; from: V3; center: V3; normal: V3 }[] = [];
  const newSel: number[] = [];
  for (const fi of sel) {
    const f = m.faces[fi];
    const center = m.faceCenter(fi);
    const normal = m.faceNormal(fi);
    const inner = f.v.map((v) => { const nv = m.addVert(m.verts[v]); records.push({ nv, from: [...m.verts[v]] as V3, center, normal }); return nv; });
    const n = f.v.length;
    const cuv = avg2(f.uv);
    const innerUV = f.uv.map((u) => lerp2(u, cuv, 0.2));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      m.addFace([f.v[i], f.v[j], inner[j], inner[i]], [f.uv[i], f.uv[j], innerUV[j], innerUV[i]]);
    }
    f.v = inner; f.uv = innerUV;
    newSel.push(fi);
  }
  m.selF = new Set(newSel);
  m.changed();
  m.flush('face');
  const handle: InsetHandle = {
    set(amount: number, depth: number) {
      for (const r of records) {
        const p = lerp(r.from, r.center, amount);
        m.verts[r.nv] = add(p, [r.normal[0] * depth, r.normal[1] * depth, r.normal[2] * depth]);
      }
      m.touch();
    },
  };
  handle.set(0.2, 0);
  return handle;
}

// ---------------------------------------------------------------- subdivide

/** Split selected faces into quads around their center (edges shared with neighbours are split there too). */
export function subdivideFaces(m: Mesh, smooth = false) {
  const sel = [...m.selF].filter((i) => i < m.faces.length);
  if (!sel.length) return;
  const selSet = new Set(sel);
  const mid = new Map<string, number>();
  const midOf = (a: number, b: number) => {
    const k = ekey(a, b);
    let v = mid.get(k);
    if (v === undefined) { v = m.addVert(lerp(m.verts[a], m.verts[b], 0.5)); mid.set(k, v); }
    return v;
  };
  const newFaces: Face[] = [];
  const created: number[] = [];
  for (const fi of sel) {
    const f = m.faces[fi];
    const n = f.v.length;
    const c = m.addVert(m.faceCenter(fi));
    const cuv = avg2(f.uv);
    for (let i = 0; i < n; i++) {
      const prev = (i + n - 1) % n, next = (i + 1) % n;
      const mPrev = midOf(f.v[prev], f.v[i]), mNext = midOf(f.v[i], f.v[next]);
      newFaces.push({
        v: [f.v[i], mNext, c, mPrev],
        uv: [f.uv[i], lerp2(f.uv[i], f.uv[next], 0.5), cuv, lerp2(f.uv[prev], f.uv[i], 0.5)],
      });
    }
  }
  // split edges in unselected neighbour faces
  for (const [k, v] of mid) { const [a, b] = parseKey(k); splitEdgeInFaces(m, a, b, v, 0.5, selSet); }
  // seams follow split edges
  for (const [k, v] of mid) if (m.seams.has(k)) { const [a, b] = parseKey(k); m.seams.delete(k); m.seams.add(ekey(a, v)); m.seams.add(ekey(v, b)); }
  const keep = m.faces.filter((_, i) => !selSet.has(i));
  m.faces = keep;
  for (const f of newFaces) { m.faces.push(f); created.push(m.faces.length - 1); }
  m.selF = new Set(created);
  m.changed();
  m.flush('face');
  if (smooth) smoothVerts(m, [...m.selV], 0.5, 1);
}

// ---------------------------------------------------------------- loop cut

/** Collect the ring of quads crossing edge `start`. Returns ordered oriented ring edges. */
export function edgeRing(m: Mesh, startKey: string): { edges: [number, number][]; faces: number[]; closed: boolean } {
  const e0 = m.edge(startKey);
  if (!e0) return { edges: [], faces: [], closed: false };
  const ringEdges: [number, number][] = [[e0.a, e0.b]];
  const ringFaces: number[] = [];
  let closed = false;
  const walk = (dirFace: number | undefined, a: number, b: number, forward: boolean) => {
    const visitedFaces = new Set<number>();
    let fi = dirFace;
    let ca = a, cb = b;
    const outE: [number, number][] = [], outF: number[] = [];
    while (fi !== undefined && !visitedFaces.has(fi)) {
      visitedFaces.add(fi);
      const f = m.faces[fi];
      if (f.v.length !== 4) break;
      const i = f.v.indexOf(ca);
      const n = 4;
      let oa: number, ob: number;
      if (f.v[(i + 1) % n] === cb) { oa = f.v[(i + 3) % n]; ob = f.v[(i + 2) % n]; }
      else { oa = f.v[(i + 1) % n]; ob = f.v[(i + 2) % n]; }
      outF.push(fi);
      const ok = ekey(oa, ob);
      if (ok === startKey) { closed = true; break; }
      outE.push([oa, ob]);
      const oe = m.edge(ok)!;
      fi = oe.faces.find((x) => x !== fi);
      ca = oa; cb = ob;
    }
    return forward ? { outE, outF } : { outE: outE.reverse(), outF: outF.reverse() };
  };
  const fwd = walk(e0.faces[0], e0.a, e0.b, true);
  let bwdE: [number, number][] = [], bwdF: number[] = [];
  if (!closed && e0.faces[1] !== undefined) {
    const r = walk(e0.faces[1], e0.a, e0.b, false);
    bwdE = r.outE; bwdF = r.outF;
  }
  return { edges: [...bwdE, ...ringEdges, ...fwd.outE], faces: [...bwdF, ...ringFaces, ...fwd.outF], closed };
}

export interface LoopCutHandle { set(t: number): void; }

/** Insert an edge loop across the ring through `startKey`. */
export function loopCut(m: Mesh, startKey: string, cuts = 1): LoopCutHandle | null {
  const ring = edgeRing(m, startKey);
  if (!ring.edges.length) return null;
  const ringFaceSet = new Set(ring.faces);
  // new verts per ring edge, `cuts` of them, oriented a->b
  const newV = new Map<string, { a: number; b: number; vs: number[] }>();
  for (const [a, b] of ring.edges) {
    const vs: number[] = [];
    for (let c = 1; c <= cuts; c++) vs.push(m.addVert(lerp(m.verts[a], m.verts[b], c / (cuts + 1))));
    newV.set(ekey(a, b), { a, b, vs });
  }
  const vAt = (a: number, b: number, c: number) => {
    const r = newV.get(ekey(a, b))!;
    return r.a === a ? r.vs[c] : r.vs[cuts - 1 - c];
  };
  const newFaces: Face[] = [];
  const newLoopEdges = new Set<string>();
  for (const fi of ring.faces) {
    const f = m.faces[fi];
    // find the two ring edges in this quad
    let s = -1;
    for (let i = 0; i < 4; i++) { if (newV.has(ekey(f.v[i], f.v[(i + 1) % 4])) && newV.has(ekey(f.v[(i + 2) % 4], f.v[(i + 3) % 4]))) { s = i; break; } }
    if (s < 0) { newFaces.push(f); continue; }
    const p0 = f.v[s], p1 = f.v[(s + 1) % 4], p2 = f.v[(s + 2) % 4], p3 = f.v[(s + 3) % 4];
    const u0 = f.uv[s], u1 = f.uv[(s + 1) % 4], u2 = f.uv[(s + 2) % 4], u3 = f.uv[(s + 3) % 4];
    let prevA = p0, prevB = p3, prevUA = u0, prevUB = u3;
    for (let c = 0; c <= cuts; c++) {
      const t = (c + 1) / (cuts + 1);
      const nA = c < cuts ? vAt(p0, p1, c) : p1;
      const nB = c < cuts ? vAt(p3, p2, c) : p2;
      const nuA = c < cuts ? lerp2(u0, u1, t) : u1;
      const nuB = c < cuts ? lerp2(u3, u2, t) : u2;
      newFaces.push({ v: [prevA, nA, nB, prevB], uv: [prevUA, nuA, nuB, prevUB] });
      if (c < cuts) newLoopEdges.add(ekey(nA, nB));
      prevA = nA; prevB = nB; prevUA = nuA; prevUB = nuB;
    }
  }
  // end faces (non-quads or boundary) get the new verts inserted
  for (const [, r] of newV) {
    for (let c = 0; c < cuts; c++) {
      // insert progressively: a -> vs[0] -> vs[1] ... -> b
      const a = c === 0 ? r.a : r.vs[c - 1];
      splitEdgeInFaces(m, a, r.b, r.vs[c], (c + 1) / (cuts + 1), ringFaceSet);
    }
    const k = ekey(r.a, r.b);
    if (m.seams.has(k)) { m.seams.delete(k); const chain = [r.a, ...r.vs, r.b]; for (let i = 0; i + 1 < chain.length; i++) m.seams.add(ekey(chain[i], chain[i + 1])); }
  }
  // fix: splitEdgeInFaces inserted into partially-progressed edges; for multi-cuts
  // the remaining edge after first insert is (vs[c-1], b) which is what we pass.
  m.faces = m.faces.filter((_, i) => !ringFaceSet.has(i)).concat(newFaces.filter((f) => f.v.length >= 3));
  m.changed();
  m.clearSelection();
  m.selE = newLoopEdges;
  for (const k of newLoopEdges) { const [a, b] = parseKey(k); m.selV.add(a); m.selV.add(b); }
  const records = [...newV.values()];
  return {
    set(t: number) {
      // t in (-1,1): slide single cut between edge ends
      if (cuts !== 1) return;
      const f = (t + 1) / 2;
      for (const r of records) m.verts[r.vs[0]] = lerp(m.verts[r.a], m.verts[r.b], f);
      m.touch();
    },
  };
}

// ---------------------------------------------------------------- merge / delete / fill

function remapVerts(m: Mesh, map: Map<number, number>) {
  for (const f of m.faces) f.v = f.v.map((v) => map.get(v) ?? v);
  m.looseEdges = m.looseEdges.map(([a, b]) => [map.get(a) ?? a, map.get(b) ?? b] as [number, number]);
  m.seams = new Set([...m.seams].map((k) => { const [a, b] = parseKey(k); return ekey(map.get(a) ?? a, map.get(b) ?? b); }));
  m.changed();
}

export function mergeAtCenter(m: Mesh, at: 'center' | 'first' = 'center') {
  const vs = selectedVerts(m);
  if (vs.length < 2) return;
  const target = vs[0];
  m.verts[target] = at === 'center' ? avg3(vs.map((v) => m.verts[v])) : m.verts[target];
  const map = new Map<number, number>();
  for (const v of vs) map.set(v, target);
  remapVerts(m, map);
  m.selV = new Set([target]); m.selE.clear(); m.selF.clear();
  m.cleanup(true);
}

/** Merge vertices closer than `dist` (selected only if any selected). Returns removed count. */
export function mergeByDistance(m: Mesh, distance = 1e-4, onlySelected = true): number {
  const cand = onlySelected && m.selV.size ? selectedVerts(m) : m.verts.map((_, i) => i);
  const cell = Math.max(distance, 1e-6);
  const grid = new Map<string, number[]>();
  const map = new Map<number, number>();
  const kOf = (p: V3) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  for (const v of cand) {
    const p = m.verts[v];
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
      const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!list) continue;
      for (const o of list) { const q = m.verts[o]; if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= distance) { found = o; break; } }
    }
    if (found >= 0) map.set(v, found);
    else { const k = kOf(p); (grid.get(k) ?? grid.set(k, []).get(k)!).push(v); }
  }
  if (!map.size) return 0;
  remapVerts(m, map);
  const before = m.verts.length;
  m.selV = new Set([...m.selV].map((v) => map.get(v) ?? v));
  m.cleanup(true);
  m.flush('vert');
  return before - m.verts.length;
}

export function deleteSelection(m: Mesh, mode: SelectMode) {
  if (mode === 'vert') {
    const del = m.selV;
    m.faces = m.faces.filter((f) => !f.v.some((v) => del.has(v)));
    m.looseEdges = m.looseEdges.filter(([a, b]) => !del.has(a) && !del.has(b));
    const keep = m.verts.map((_, i) => (del.has(i) ? 0 : 1));
    m.clearSelection();
    m.compact(keep);
    m.cleanup();
  } else if (mode === 'edge') {
    const del = m.selE;
    m.faces = m.faces.filter((f) => { for (let i = 0; i < f.v.length; i++) if (del.has(ekey(f.v[i], f.v[(i + 1) % f.v.length]))) return false; return true; });
    m.looseEdges = m.looseEdges.filter(([a, b]) => !del.has(ekey(a, b)));
    m.clearSelection();
    m.changed();
    m.cleanup();
  } else {
    const del = m.selF;
    // keep edges of removed faces that are not used elsewhere? Blender removes them (delete faces). We do the same.
    m.faces = m.faces.filter((_, i) => !del.has(i));
    m.clearSelection();
    m.changed();
    m.cleanup();
  }
}

/** Delete only the selected faces, keeping their edges as wire. */
export function deleteOnlyFaces(m: Mesh) {
  const del = m.selF;
  const keepEdges: [number, number][] = [];
  m.faces.forEach((f, i) => { if (del.has(i)) for (let j = 0; j < f.v.length; j++) keepEdges.push([f.v[j], f.v[(j + 1) % f.v.length]]); });
  m.faces = m.faces.filter((_, i) => !del.has(i));
  m.looseEdges.push(...keepEdges);
  m.clearSelection();
  m.changed();
  m.cleanup();
}

/** Dissolve selected vertices (with valence 2 on edges) or merge selected faces into one n-gon. */
export function dissolveFaces(m: Mesh) {
  const sel = [...m.selF];
  if (sel.length < 2) return false;
  const selSet = new Set(sel);
  // boundary half-edges of the region
  const half = new Map<number, { to: number; uvFrom: V2 }[]>();
  for (const fi of sel) {
    const f = m.faces[fi];
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i], b = f.v[(i + 1) % f.v.length];
      const e = m.edge(ekey(a, b))!;
      if (e.faces.filter((x) => selSet.has(x)).length === 1) (half.get(a) ?? half.set(a, []).get(a)!).push({ to: b, uvFrom: f.uv[i] });
    }
  }
  // must be a single simple loop
  if ([...half.values()].some((l) => l.length !== 1)) return false;
  const start = half.keys().next().value as number;
  const v: number[] = [], uv: V2[] = [];
  let cur = start;
  do {
    const h = half.get(cur)![0];
    v.push(cur); uv.push(h.uvFrom);
    cur = h.to;
    if (v.length > half.size) return false;
  } while (cur !== start);
  if (v.length !== half.size) return false;
  m.faces = m.faces.filter((_, i) => !selSet.has(i));
  m.faces.push({ v, uv });
  m.selF = new Set([m.faces.length - 1]);
  m.changed();
  m.cleanup();
  m.flush('face');
  return true;
}

/** Create a face (≥3 verts) or edge (2 verts) from the selection. */
export function fill(m: Mesh): boolean {
  const vs = selectedVerts(m);
  if (vs.length === 2) {
    m.looseEdges.push([vs[0], vs[1]]);
    m.changed(); m.cleanup(); m.flush('vert');
    return true;
  }
  if (vs.length < 3) return false;
  let order: number[] | null = null;
  // try selected edges forming one loop
  const adj = new Map<number, number[]>();
  for (const k of m.selE) { const [a, b] = parseKey(k); (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); (adj.get(b) ?? adj.set(b, []).get(b)!).push(a); }
  const set = new Set(vs);
  if (adj.size === vs.length && [...adj.values()].every((l) => l.length === 2)) {
    order = [vs[0]];
    let prev = -1, cur = vs[0];
    for (;;) {
      const nx = adj.get(cur)!.find((x) => x !== prev)!;
      if (nx === vs[0]) break;
      if (!set.has(nx) || order.length > vs.length) { order = null; break; }
      order.push(nx); prev = cur; cur = nx;
    }
    if (order && order.length !== vs.length) order = null;
  }
  // chain of boundary edges: if verts form an open chain (2 endpoints), close it
  if (!order) {
    const pts = vs.map((v) => m.verts[v]);
    const c = avg3(pts);
    const n = polyNormal(pts.length >= 3 ? pts : [...pts, c]);
    const nn = Math.hypot(...n) > 0.5 ? n : bestFitNormal(pts);
    const [u, w] = basisFromNormal(nn);
    order = vs.slice().sort((a, b) => {
      const pa = sub(m.verts[a], c), pb = sub(m.verts[b], c);
      return Math.atan2(dot(pa, w), dot(pa, u)) - Math.atan2(dot(pb, w), dot(pb, u));
    });
  }
  // orient consistently with a neighbouring face if possible
  for (let i = 0; i < order.length; i++) {
    const a = order[i], b = order[(i + 1) % order.length];
    const e = m.edge(ekey(a, b));
    if (e && e.faces.length) {
      const f = m.faces[e.faces[0]];
      const fi = f.v.indexOf(a);
      if (f.v[(fi + 1) % f.v.length] === b) order.reverse();
      break;
    }
  }
  m.addFace(order, planarUV(order.map((v) => m.verts[v])));
  m.selF = new Set([m.faces.length - 1]);
  m.changed();
  m.cleanup();
  m.flush('face');
  return true;
}

function bestFitNormal(pts: V3[]): V3 {
  const c = avg3(pts);
  let best: V3 = [0, 1, 0], bestL = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const n = cross(sub(pts[i], c), sub(pts[j], c));
    const l = Math.hypot(...n);
    if (l > bestL) { bestL = l; best = n; }
  }
  return normalize(best);
}

function planarUV(pts: V3[]): V2[] {
  const n = polyNormal(pts);
  const [u, v] = basisFromNormal(Math.hypot(...n) > 0.5 ? n : [0, 1, 0]);
  return pts.map((p) => [dot(p, u), dot(p, v)] as V2);
}

// ---------------------------------------------------------------- normals

export function flipFaces(m: Mesh, which?: number[]) {
  const list = which ?? [...m.selF];
  for (const fi of list) { const f = m.faces[fi]; f.v.reverse(); f.uv.reverse(); }
  m.changed();
}

/** Make winding consistent within each connected component, pointing outward. */
export function recalcNormals(m: Mesh, onlySelected = true) {
  const target = onlySelected && m.selF.size ? new Set(m.selF) : new Set(m.faces.map((_, i) => i));
  const visited = new Set<number>();
  for (const seed of target) {
    if (visited.has(seed)) continue;
    const comp: number[] = [];
    const queue = [seed];
    visited.add(seed);
    while (queue.length) {
      const fi = queue.shift()!;
      comp.push(fi);
      const f = m.faces[fi];
      const n = f.v.length;
      for (let i = 0; i < n; i++) {
        const a = f.v[i], b = f.v[(i + 1) % n];
        const e = m.edge(ekey(a, b))!;
        for (const nf of e.faces) {
          if (nf === fi || visited.has(nf) || !target.has(nf)) continue;
          const g = m.faces[nf];
          const gi = g.v.indexOf(a);
          // consistent neighbour traverses the edge b->a
          if (g.v[(gi + 1) % g.v.length] === b) { g.v.reverse(); g.uv.reverse(); }
          visited.add(nf);
          queue.push(nf);
        }
      }
    }
    // signed volume w.r.t. component centroid
    const cs = new Set<number>();
    for (const fi of comp) for (const v of m.faces[fi].v) cs.add(v);
    const c = avg3([...cs].map((v) => m.verts[v]));
    let vol = 0;
    for (const fi of comp) {
      const f = m.faces[fi];
      const p0 = sub(m.verts[f.v[0]], c);
      for (let i = 1; i + 1 < f.v.length; i++) vol += dot(p0, cross(sub(m.verts[f.v[i]], c), sub(m.verts[f.v[i + 1]], c)));
    }
    if (vol < 0) for (const fi of comp) { m.faces[fi].v.reverse(); m.faces[fi].uv.reverse(); }
  }
  m.changed();
}

// ---------------------------------------------------------------- misc topology

export function triangulate(m: Mesh) {
  const sel = [...m.selF];
  const created: number[] = [];
  const remove = new Set<number>();
  for (const fi of sel) {
    const f = m.faces[fi];
    if (f.v.length <= 3) continue;
    const tris = triangulateFace(m.verts, f.v);
    remove.add(fi);
    for (const [a, b, c] of tris) created.push(m.addFace([f.v[a], f.v[b], f.v[c]], [f.uv[a], f.uv[b], f.uv[c]]));
  }
  if (!remove.size) return;
  const keepSel: Face[] = created.map((i) => m.faces[i]).concat(sel.filter((i) => !remove.has(i)).map((i) => m.faces[i]));
  m.faces = m.faces.filter((_, i) => !remove.has(i));
  m.selF = new Set(keepSel.map((f) => m.faces.indexOf(f)));
  m.changed();
  m.flush('face');
}

/** Ear-clipping triangulation of a polygon (indices into the face loop). */
export function triangulateFace(verts: V3[], loop: number[]): [number, number, number][] {
  const n = loop.length;
  if (n === 3) return [[0, 1, 2]];
  const pts = loop.map((v) => verts[v]);
  if (n === 4) {
    // choose the diagonal that keeps both triangles facing the same way
    const nrm = polyNormal(pts);
    const t = (a: number, b: number, c: number) => dot(cross(sub(pts[b], pts[a]), sub(pts[c], pts[a])), nrm);
    if (t(0, 1, 2) > 0 && t(0, 2, 3) > 0) return [[0, 1, 2], [0, 2, 3]];
    return [[1, 2, 3], [1, 3, 0]];
  }
  const nrm = polyNormal(pts);
  const [u, v] = basisFromNormal(Math.hypot(...nrm) > 0.5 ? nrm : [0, 1, 0]);
  const contour = pts.map((p) => new Vector2(dot(p, u), dot(p, v)));
  const tris = ShapeUtils.triangulateShape(contour, []) as number[][];
  if (tris.length !== n - 2) {
    const fan: [number, number, number][] = [];
    for (let i = 1; i + 1 < n; i++) fan.push([0, i, i + 1]);
    return fan;
  }
  // earcut may flip winding relative to our normal
  return tris.map(([a, b, c]) => {
    const w = dot(cross(sub(pts[b], pts[a]), sub(pts[c], pts[a])), nrm);
    return (w >= 0 ? [a, b, c] : [a, c, b]) as [number, number, number];
  });
}

/** Duplicate selected geometry (faces + loose selected edges). New geometry becomes selected. */
export function duplicateSelection(m: Mesh): number[] {
  const map = new Map<number, number>();
  const dup = (v: number) => { let n = map.get(v); if (n === undefined) { n = m.addVert(m.verts[v]); map.set(v, n); } return n; };
  const newF: number[] = [];
  for (const fi of [...m.selF]) { const f = m.faces[fi]; newF.push(m.addFace(f.v.map(dup), f.uv)); }
  for (const k of m.selE) {
    const [a, b] = parseKey(k);
    const e = m.edge(k);
    if (e && e.faces.some((f) => m.selF.has(f))) continue;
    m.looseEdges.push([dup(a), dup(b)]);
  }
  for (const v of m.selV) dup(v);
  m.changed();
  m.selV = new Set(map.values());
  m.selF = new Set(newF);
  m.flush('vert');
  return [...m.selV];
}

/** Split selected faces off (disconnect from rest). */
export function splitSelection(m: Mesh) {
  const sel = new Set(m.selF);
  if (!sel.size) return;
  const shared = new Set<number>();
  m.faces.forEach((f, i) => { if (!sel.has(i)) for (const v of f.v) shared.add(v); });
  const map = new Map<number, number>();
  for (const fi of sel) {
    const f = m.faces[fi];
    f.v = f.v.map((v) => { if (!shared.has(v)) return v; let n = map.get(v); if (n === undefined) { n = m.addVert(m.verts[v]); map.set(v, n); } return n; });
  }
  m.changed();
  m.flush('face');
}

// ---------------------------------------------------------------- selection helpers

export function selectLinked(m: Mesh, mode: SelectMode) {
  const seen = new Set<number>(m.selV);
  const queue = [...m.selV];
  while (queue.length) {
    const v = queue.pop()!;
    for (const n of m.vertNeighbors(v)) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  m.selV = seen;
  m.flush('vert');
  if (mode !== 'vert') m.flush(mode === 'edge' ? 'vert' : 'vert');
}

export function growSelection(m: Mesh) {
  const add: number[] = [];
  for (const v of m.selV) {
    for (const f of m.vertFaces(v)) for (const x of m.faces[f].v) add.push(x);
    for (const n of m.vertNeighbors(v)) add.push(n);
  }
  for (const v of add) m.selV.add(v);
  m.flush('vert');
}

export function shrinkSelection(m: Mesh) {
  const rem: number[] = [];
  for (const v of m.selV) if (m.vertNeighbors(v).some((n) => !m.selV.has(n))) rem.push(v);
  for (const v of rem) m.selV.delete(v);
  m.flush('vert');
}

export function invertSelection(m: Mesh, mode: SelectMode) {
  if (mode === 'face') {
    const s = new Set<number>();
    m.faces.forEach((_, i) => { if (!m.selF.has(i)) s.add(i); });
    m.selF = s; m.flush('face');
  } else if (mode === 'edge') {
    const s = new Set<string>();
    for (const e of m.edges) if (!m.selE.has(e.key)) s.add(e.key);
    m.selE = s; m.flush('edge');
  } else {
    const s = new Set<number>();
    m.verts.forEach((_, i) => { if (!m.selV.has(i)) s.add(i); });
    m.selV = s; m.flush('vert');
  }
}

/** Edge loop through quads, starting at edge key. */
export function edgeLoop(m: Mesh, startKey: string): string[] {
  const e0 = m.edge(startKey);
  if (!e0) return [];
  const result = new Set<string>([startKey]);
  const step = (from: number, at: number) => {
    let prevKey = ekey(from, at);
    let cur = at;
    for (let guard = 0; guard < 100000; guard++) {
      const edges = m.vertEdges(cur);
      if (edges.length !== 4) return;
      const prevE = m.edge(prevKey)!;
      const prevFaces = new Set(prevE.faces);
      const cand = edges.filter((e) => e.key !== prevKey && !e.faces.some((f) => prevFaces.has(f)));
      if (cand.length !== 1) return;
      const nx = cand[0];
      if (result.has(nx.key)) return;
      result.add(nx.key);
      prevKey = nx.key;
      cur = nx.a === cur ? nx.b : nx.a;
    }
  };
  step(e0.a, e0.b);
  step(e0.b, e0.a);
  return [...result];
}

export function smoothVerts(m: Mesh, verts: number[], factor = 0.5, iterations = 1) {
  for (let it = 0; it < iterations; it++) {
    const next = new Map<number, V3>();
    for (const v of verts) {
      const ns = m.vertNeighbors(v);
      if (!ns.length) continue;
      next.set(v, lerp(m.verts[v], avg3(ns.map((n) => m.verts[n])), factor));
    }
    for (const [v, p] of next) m.verts[v] = p;
  }
  m.touch();
}

/** Toggle seams on the selected edges. */
export function markSeams(m: Mesh, on: boolean) {
  for (const k of m.selE) { if (on) m.seams.add(k); else m.seams.delete(k); }
  m.touch();
}

/** Snap selected vertices to x = 0 (useful with mirror). */
export function snapToCenterX(m: Mesh) {
  for (const v of m.selV) m.verts[v][0] = 0;
  m.touch();
}

/** For each vertex, its mirror partner across X (or -1). */
export function mirrorMap(m: Mesh, eps = 1e-4): Int32Array {
  const res = new Int32Array(m.verts.length).fill(-1);
  const grid = new Map<string, number[]>();
  const c = Math.max(eps * 10, 1e-3);
  const key = (x: number, y: number, z: number) => `${Math.round(x / c)},${Math.round(y / c)},${Math.round(z / c)}`;
  m.verts.forEach((p, i) => { const k = key(p[0], p[1], p[2]); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); });
  m.verts.forEach((p, i) => {
    const cands = grid.get(key(-p[0], p[1], p[2])) ?? [];
    for (const j of cands) {
      const q = m.verts[j];
      if (Math.abs(q[0] + p[0]) < eps * 10 && Math.abs(q[1] - p[1]) < eps * 10 && Math.abs(q[2] - p[2]) < eps * 10) { res[i] = j; break; }
    }
  });
  return res;
}

/** Connect selected vertex pairs that share a face by splitting that face (like Blender's J). */
export function connectVerts(m: Mesh): number {
  const sel = selectedVerts(m);
  if (sel.length < 2) return 0;
  const set = new Set(sel);
  let cuts = 0;
  // repeatedly split faces that contain ≥2 selected, non-adjacent verts
  for (let guard = 0; guard < 1000; guard++) {
    let did = false;
    for (let fi = 0; fi < m.faces.length && !did; fi++) {
      const f = m.faces[fi];
      const n = f.v.length;
      const idx = f.v.map((v, i) => (set.has(v) ? i : -1)).filter((i) => i >= 0);
      if (idx.length < 2) continue;
      for (let a = 0; a < idx.length && !did; a++) for (let b = a + 1; b < idx.length && !did; b++) {
        const i = idx[a], j = idx[b];
        if ((i + 1) % n === j || (j + 1) % n === i) continue;
        const f1v = f.v.slice(i, j + 1), f1uv = f.uv.slice(i, j + 1);
        const f2v = [...f.v.slice(j), ...f.v.slice(0, i + 1)], f2uv = [...f.uv.slice(j), ...f.uv.slice(0, i + 1)];
        m.faces[fi] = { v: f1v, uv: f1uv };
        m.faces.push({ v: f2v, uv: f2uv });
        cuts++;
        did = true;
      }
    }
    if (!did) break;
  }
  // two selected verts with no shared face: make a wire edge
  if (!cuts && sel.length === 2) m.looseEdges.push([sel[0], sel[1]]);
  m.changed();
  m.cleanup();
  m.flush('vert');
  return cuts;
}

/** Insert `cuts` evenly spaced vertices on every selected edge. */
export function subdivideEdges(m: Mesh, cuts = 1) {
  const keys = [...m.selE];
  const newV: number[] = [];
  for (const k of keys) {
    const [a, b] = parseKey(k);
    let prev = a;
    const chain = [a];
    for (let c = 1; c <= cuts; c++) {
      const t = c / (cuts + 1);
      const nv = m.addVert(lerp(m.verts[a], m.verts[b], t));
      // insert between prev and b; relative t on the remaining segment
      splitEdgeInFaces(m, prev, b, nv, 1 / (cuts + 2 - c));
      chain.push(nv);
      newV.push(nv);
      prev = nv;
    }
    chain.push(b);
    if (m.seams.has(k)) { m.seams.delete(k); for (let i = 0; i + 1 < chain.length; i++) m.seams.add(ekey(chain[i], chain[i + 1])); }
  }
  m.changed();
  for (const v of newV) m.selV.add(v);
  m.flush('vert');
}

/** Order selected edges into closed/open loops (vertex chains). */
export function selectedEdgeLoops(m: Mesh): { verts: number[]; closed: boolean }[] {
  const adj = new Map<number, number[]>();
  for (const k of m.selE) { const [a, b] = parseKey(k); (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); (adj.get(b) ?? adj.set(b, []).get(b)!).push(a); }
  const seen = new Set<number>();
  const loops: { verts: number[]; closed: boolean }[] = [];
  const starts = [...adj.keys()].sort((x, y) => adj.get(x)!.length - adj.get(y)!.length);
  for (const s of starts) {
    if (seen.has(s)) continue;
    const chain = [s];
    seen.add(s);
    let prev = -1, cur = s, closed = false;
    for (;;) {
      const nx = (adj.get(cur) ?? []).find((x) => x !== prev && (!seen.has(x) || (x === s && chain.length > 2)));
      if (nx === undefined) break;
      if (nx === s) { closed = true; break; }
      chain.push(nx); seen.add(nx); prev = cur; cur = nx;
    }
    loops.push({ verts: chain, closed });
  }
  return loops;
}

/** Bridge two selected edge loops with quads. */
export function bridgeEdgeLoops(m: Mesh): boolean {
  const loops = selectedEdgeLoops(m);
  if (loops.length !== 2) return false;
  let [A, B] = loops;
  if (A.verts.length !== B.verts.length || A.closed !== B.closed) return false;
  const n = A.verts.length;
  const P = (v: number) => m.verts[v];
  // choose direction & offset with minimal total distance
  let best = Infinity, bestOff = 0, bestRev = false;
  for (const rev of [false, true]) {
    const bv = rev ? B.verts.slice().reverse() : B.verts;
    for (let off = 0; off < (A.closed ? n : 1); off++) {
      let d = 0;
      for (let i = 0; i < n; i++) { const p = P(A.verts[i]), q = P(bv[(i + off) % n]); d += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }
      if (d < best) { best = d; bestOff = off; bestRev = rev; }
    }
  }
  const bv = bestRev ? B.verts.slice().reverse() : B.verts.slice();
  B = { verts: bv.map((_, i) => bv[(i + bestOff) % n]), closed: B.closed };
  const created: number[] = [];
  const segs = A.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    created.push(m.addFace([A.verts[i], A.verts[j], B.verts[j], B.verts[i]]));
  }
  // orient consistently with neighbours: check first quad against an adjacent face along A edge
  const e = m.edge(ekey(A.verts[0], A.verts[1]));
  const other = e?.faces.find((f) => !created.includes(f));
  if (other !== undefined) {
    const f = m.faces[other];
    const i = f.v.indexOf(A.verts[0]);
    if (f.v[(i + 1) % f.v.length] === A.verts[1]) flipFaces(m, created);
  }
  // fresh UVs for bridge
  created.forEach((fi, i) => { m.faces[fi].uv = [[i / segs, 0], [(i + 1) / segs, 0], [(i + 1) / segs, 1], [i / segs, 1]]; });
  m.changed();
  m.cleanup();
  m.selF = new Set(created.filter((i) => i < m.faces.length));
  m.flush('face');
  return true;
}
