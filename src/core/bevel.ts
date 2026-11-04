import { Mesh, Face, ekey } from './mesh';
import { V2, V3, add, len, lerp, lerp2, sub } from './vec';

/* ======================================================================
 * Bevel (edges or vertices).
 *
 * Every face corner at a "bevel vertex" is replaced by offset points:
 *  - corner with one bevelled edge     → a point slid along the other edge
 *  - corner with both edges bevelled   → a point inside the face
 *  - corner with no bevelled edge      → the slide points of its two edges
 *                                        (or the original vertex if none)
 * Slide points are keyed per (vertex, edge) so neighbouring faces share
 * them. Each bevelled edge becomes a strip between its two faces (with a
 * rounded quadratic profile when segments > 1) and the hole left at a
 * vertex is closed with a patch polygon.
 * Width is the slide distance along the adjacent edges.
 * ==================================================================== */

export interface BevelOptions {
  width: number;
  segments: number;
  /** Bevel the selected vertices instead of edges. */
  vertexOnly?: boolean;
}

export function bevel(m: Mesh, opts: BevelOptions): boolean {
  const w = Math.max(0, opts.width);
  const segs = Math.max(1, Math.round(opts.segments));
  // ---- which edges / vertices take part
  const bev = new Set<string>();
  const bevVerts = new Set<number>();
  if (opts.vertexOnly) {
    for (const v of m.selV) if (m.vertFaces(v).length) bevVerts.add(v);
  } else {
    for (const k of m.selE) {
      const e = m.edge(k);
      if (!e || e.faces.length !== 2) continue; // only manifold interior edges
      bev.add(k);
      bevVerts.add(e.a); bevVerts.add(e.b);
    }
  }
  if (!bevVerts.size || w <= 0) return false;

  const P = m.verts;
  const isBev = (a: number, b: number) => bev.has(ekey(a, b));
  const edgeLen = (a: number, b: number) => len(sub(P[a], P[b]));
  const slideT = (v: number, u: number) => Math.min(w / Math.max(edgeLen(v, u), 1e-12), 0.49);

  // ---- does an edge (v,u) at bevel vertex v get a slide point?
  // vertex-only: always. edge bevel: if some face adjacent to (v,u) has its
  // *other* edge at v bevelled.
  const slideKey = (v: number, u: number) => `${v}>${u}`;
  const hasSlide = new Set<string>();
  for (const v of bevVerts) {
    for (const fi of m.vertFaces(v)) {
      const f = m.faces[fi];
      const i = f.v.indexOf(v), n = f.v.length;
      const prev = f.v[(i + n - 1) % n], next = f.v[(i + 1) % n];
      if (opts.vertexOnly) { hasSlide.add(slideKey(v, prev)); hasSlide.add(slideKey(v, next)); continue; }
      const bp = isBev(prev, v), bn = isBev(v, next);
      if (bp && !bn) hasSlide.add(slideKey(v, next));
      if (bn && !bp) hasSlide.add(slideKey(v, prev));
    }
  }

  // ---- new vertices
  const slideVert = new Map<string, number>();
  const getSlide = (v: number, u: number) => {
    const k = slideKey(v, u);
    let id = slideVert.get(k);
    if (id === undefined) { id = m.addVert(lerp(P[v], P[u], slideT(v, u)), [[v, 1 - slideT(v, u)], [u, slideT(v, u)]]); slideVert.set(k, id); }
    return id;
  };

  /** Corner replacement for face fi at loop index i: list of (vertex, uv). */
  type Pt = { v: number; uv: V2 };
  const cornerCache = new Map<string, Pt[]>();
  const corner = (fi: number, i: number): Pt[] => {
    const ck = `${fi}:${i}`;
    const hit = cornerCache.get(ck);
    if (hit) return hit;
    const f = m.faces[fi], n = f.v.length;
    const v = f.v[i];
    const ip = (i + n - 1) % n, inx = (i + 1) % n;
    const prev = f.v[ip], next = f.v[inx];
    const uv = f.uv[i], uvP = f.uv[ip], uvN = f.uv[inx];
    let res: Pt[];
    const bp = !opts.vertexOnly && isBev(prev, v), bn = !opts.vertexOnly && isBev(v, next);
    if (bp && bn) {
      const tp = slideT(v, prev), tn = slideT(v, next);
      const pos = add(add(P[v], sub(lerp(P[v], P[prev], tp), P[v])), sub(lerp(P[v], P[next], tn), P[v]));
      const id = m.addVert(pos, v);
      res = [{ v: id, uv: [uv[0] + (uvP[0] - uv[0]) * tp + (uvN[0] - uv[0]) * tn, uv[1] + (uvP[1] - uv[1]) * tp + (uvN[1] - uv[1]) * tn] }];
    } else if (bp) {
      res = [{ v: getSlide(v, next), uv: lerp2(uv, uvN, slideT(v, next)) }];
    } else if (bn) {
      res = [{ v: getSlide(v, prev), uv: lerp2(uv, uvP, slideT(v, prev)) }];
    } else {
      const a: Pt = hasSlide.has(slideKey(v, prev)) ? { v: getSlide(v, prev), uv: lerp2(uv, uvP, slideT(v, prev)) } : { v, uv };
      const b: Pt = hasSlide.has(slideKey(v, next)) ? { v: getSlide(v, next), uv: lerp2(uv, uvN, slideT(v, next)) } : { v, uv };
      res = a.v === b.v ? [a] : [a, b];
    }
    cornerCache.set(ck, res);
    return res;
  };

  // ---- rounded profile between two corner points around original vertex v
  const profileCache = new Map<string, number[]>();
  const profile = (from: Pt, to: Pt, v: number): { v: number; uv: V2 }[] => {
    if (segs <= 1) return [];
    const k = `${from.v}|${to.v}`;
    const rk = `${to.v}|${from.v}`;
    let ids = profileCache.get(k);
    const reversed = !ids && profileCache.has(rk);
    if (reversed) ids = profileCache.get(rk)!.slice().reverse();
    if (!ids) {
      ids = [];
      for (let s = 1; s < segs; s++) {
        const t = s / segs;
        const a = P[from.v], c = P[v], b = P[to.v];
        // quadratic Bézier with the original corner as control point → rounded bevel
        const pos: V3 = [0, 1, 2].map((j) => (1 - t) * (1 - t) * a[j] + 2 * t * (1 - t) * c[j] + t * t * b[j]) as V3;
        ids.push(m.addVert(pos, v));
      }
      profileCache.set(k, ids);
    }
    return ids.map((id, s) => ({ v: id, uv: lerp2(from.uv, to.uv, (s + 1) / segs) }));
  };

  const origFaces = m.faces;
  const newFaces: Face[] = [];
  const created: number[] = [];

  // ---- rebuild existing faces
  origFaces.forEach((f, fi) => {
    const v: number[] = [], uv: V2[] = [];
    f.v.forEach((x, i) => {
      if (!bevVerts.has(x)) { v.push(x); uv.push(f.uv[i]); return; }
      for (const p of corner(fi, i)) { if (v[v.length - 1] !== p.v) { v.push(p.v); uv.push(p.uv); } }
    });
    while (v.length > 1 && v[0] === v[v.length - 1]) { v.pop(); uv.pop(); }
    newFaces.push({ v, uv });
  });

  // ---- strips along bevelled edges
  for (const k of bev) {
    const e = m.edge(k)!;
    const [f, g] = e.faces;
    // orient: in face F the loop goes a -> b
    let F = f, G = g;
    const fl = origFaces[F];
    let ia = fl.v.indexOf(e.a);
    let a = e.a, b = e.b;
    if (fl.v[(ia + 1) % fl.v.length] !== b) { F = g; G = f; }
    const FL = origFaces[F], GL = origFaces[G];
    ia = FL.v.indexOf(a);
    if (FL.v[(ia + 1) % FL.v.length] !== b) { [a, b] = [b, a]; ia = FL.v.indexOf(a); }
    const ib = FL.v.indexOf(b);
    const ja = GL.v.indexOf(a), jb = GL.v.indexOf(b);
    // corner points touching this edge: last point of F's a-corner, first of F's b-corner…
    const cfa = corner(F, ia), cfb = corner(F, ib), cga = corner(G, ja), cgb = corner(G, jb);
    const fa = cfa[cfa.length - 1], fb = cfb[0];
    const gb = cgb[cgb.length - 1], ga = cga[0];
    // rows: from F side to G side, at a and at b
    const rowA = [fa, ...profile(fa, ga, a), ga];
    const rowB = [fb, ...profile(fb, gb, b), gb];
    for (let s = 0; s < rowA.length - 1; s++) {
      newFaces.push({
        v: [rowB[s].v, rowA[s].v, rowA[s + 1].v, rowB[s + 1].v],
        uv: [rowB[s].uv, rowA[s].uv, rowA[s + 1].uv, rowB[s + 1].uv],
      });
      created.push(newFaces.length - 1);
    }
  }

  // ---- patches closing the hole at each bevel vertex
  const directed = new Set<string>();
  for (const f of newFaces) for (let i = 0; i < f.v.length; i++) directed.add(`${f.v[i]}>${f.v[(i + 1) % f.v.length]}`);
  for (const v of bevVerts) {
    const fan = orderedFan(m, origFaces, v);
    if (!fan || fan.length < 2) continue;
    const ring: { v: number; uv: V2 }[] = [];
    const push = (p: { v: number; uv: V2 }) => { if (!ring.length || ring[ring.length - 1].v !== p.v) ring.push(p); };
    for (let k = 0; k < fan.length; k++) {
      const fi = fan[k];
      const f = origFaces[fi];
      const i = f.v.indexOf(v);
      const pts = corner(fi, i);
      // walking the fan the "other way" round the vertex: corner points reversed
      for (const p of pts.slice().reverse()) push(p);
      // across the edge to the next face: if bevelled, add profile points
      const nf = fan[(k + 1) % fan.length];
      const prevV = f.v[(i + f.v.length - 1) % f.v.length]; // shared edge with next fan face
      if (!opts.vertexOnly && isBev(prevV, v) && segs > 1) {
        const g = origFaces[nf];
        const gi = g.v.indexOf(v);
        const gpts = corner(nf, gi);
        const from = pts[0], to = gpts[gpts.length - 1];
        // profile was created F-side → G-side for the strip; reuse (shared cache)
        for (const p of profile(from, to, v)) push(p);
      }
    }
    if (ring.length > 1 && ring[0].v === ring[ring.length - 1].v) ring.pop();
    if (ring.length < 3 || new Set(ring.map((p) => p.v)).size !== ring.length) continue;
    // orient against neighbours: a shared edge must run the other way
    let conflict = false;
    for (let i = 0; i < ring.length && !conflict; i++) if (directed.has(`${ring[i].v}>${ring[(i + 1) % ring.length].v}`)) conflict = true;
    if (conflict) ring.reverse();
    for (let i = 0; i < ring.length; i++) directed.add(`${ring[i].v}>${ring[(i + 1) % ring.length].v}`);
    newFaces.push({ v: ring.map((p) => p.v), uv: ring.map((p) => p.uv) });
    created.push(newFaces.length - 1);
  }

  m.faces = newFaces;
  // seams: bevelled edges' seams are dropped; split slide edges keep nothing special
  for (const k of bev) m.seams.delete(k);
  m.looseEdges = m.looseEdges.filter(([a, b]) => !bevVerts.has(a) && !bevVerts.has(b));
  m.clearSelection();
  m.selF = new Set(created);
  m.changed();
  m.cleanup();
  m.flush('face');
  return true;
}

/** Faces around v ordered so consecutive faces share an edge (v, prev-in-face). Null if open. */
function orderedFan(m: Mesh, faces: Face[], v: number): number[] | null {
  const around = m.vertFaces(v);
  if (!around.length) return null;
  // map: for each face, the vertex preceding v; next face is the one whose "next after v" equals it
  const byNext = new Map<number, number>();
  for (const fi of around) { const f = faces[fi]; const i = f.v.indexOf(v); byNext.set(f.v[(i + 1) % f.v.length], fi); }
  const fan: number[] = [around[0]];
  for (let guard = 0; guard < around.length; guard++) {
    const f = faces[fan[fan.length - 1]];
    const i = f.v.indexOf(v);
    const prev = f.v[(i + f.v.length - 1) % f.v.length];
    const nf = byNext.get(prev);
    if (nf === undefined) return null;
    if (nf === fan[0]) return fan.length === around.length ? fan : null;
    fan.push(nf);
  }
  return null;
}
