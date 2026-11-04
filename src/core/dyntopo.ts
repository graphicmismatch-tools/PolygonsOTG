import { Mesh, Face, ekey } from './mesh';
import { V3, lerp, lerp2 } from './vec';
import { triangulateFace } from './ops';

/* ======================================================================
 * Dynamic topology (refine-only) for sculpting.
 *
 * Inside the brush sphere, faces are triangulated and every edge longer
 * than `maxLen` is split at its midpoint (longest first), bisecting the
 * triangles on both sides. Neighbouring n-gons outside the brush just get
 * the midpoint inserted into their loop, so the surface stays watertight.
 * This lets a sculpt stroke add detail exactly where it is needed.
 * ==================================================================== */

export function refine(m: Mesh, c: V3, radius: number, maxLen: number, maxSplits = 1500): number {
  if (maxLen <= 0) return 0;
  const P = m.verts;
  const r2 = radius * radius;
  const inside = (p: V3) => { const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2]; return dx * dx + dy * dy + dz * dz <= r2; };

  // region: faces with a vertex inside the sphere (or containing the centre)
  const regionSet = new Set<number>();
  for (let v = 0; v < P.length; v++) if (inside(P[v])) for (const f of m.vertFaces(v)) regionSet.add(f);
  if (!regionSet.size) return 0;

  // 1-ring around the region (faces sharing a vertex) — the only faces whose edges can change
  const ring = new Set<number>(regionSet);
  for (const fi of regionSet) for (const v of m.faces[fi].v) for (const g of m.vertFaces(v)) ring.add(g);

  // triangulate region faces (in place + appended)
  const isTri = new Set<number>();
  for (const fi of regionSet) {
    const f = m.faces[fi];
    if (f.v.length === 3) { isTri.add(fi); continue; }
    const tris = triangulateFace(P, f.v);
    tris.forEach(([a, b, cc], k) => {
      const nf: Face = { v: [f.v[a], f.v[b], f.v[cc]], uv: [f.uv[a], f.uv[b], f.uv[cc]] };
      if (k === 0) { m.faces[fi] = nf; isTri.add(fi); }
      else { m.faces.push(nf); const id = m.faces.length - 1; isTri.add(id); ring.add(id); regionSet.add(id); }
    });
  }

  // local edge -> faces map over the ring
  const emap = new Map<string, number[]>();
  const addE = (a: number, b: number, f: number) => { const k = ekey(a, b); const l = emap.get(k); if (l) l.push(f); else emap.set(k, [f]); };
  const remE = (a: number, b: number, f: number) => { const k = ekey(a, b); const l = emap.get(k); if (!l) return; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); if (!l.length) emap.delete(k); };
  for (const fi of ring) { const f = m.faces[fi]; for (let i = 0; i < f.v.length; i++) addE(f.v[i], f.v[(i + 1) % f.v.length], fi); }

  const max2 = maxLen * maxLen;
  const len2 = (a: number, b: number) => { const p = P[a], q = P[b]; return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; };
  let splits = 0;
  const touchedNgons = new Set<number>();

  const candidates = () => {
    const out: [number, number, number][] = [];
    for (const fi of regionSet) {
      if (!isTri.has(fi)) continue;
      const f = m.faces[fi];
      for (let i = 0; i < 3; i++) {
        const a = f.v[i], b = f.v[(i + 1) % 3];
        if (a > b) continue; // each undirected edge once per face pair is fine; dedupe below
        const l = len2(a, b);
        if (l <= max2) continue;
        const mid = lerp(P[a], P[b], 0.5);
        if (!inside(mid) && !inside(P[a]) && !inside(P[b])) continue;
        out.push([a, b, l]);
      }
      for (let i = 0; i < 3; i++) {
        const a = f.v[i], b = f.v[(i + 1) % 3];
        if (a < b) continue;
        const l = len2(a, b);
        if (l <= max2) continue;
        const mid = lerp(P[a], P[b], 0.5);
        if (!inside(mid) && !inside(P[a]) && !inside(P[b])) continue;
        out.push([b, a, l]);
      }
    }
    const seen = new Set<string>();
    return out.sort((x, y) => y[2] - x[2]).filter(([a, b]) => { const k = ekey(a, b); if (seen.has(k)) return false; seen.add(k); return true; });
  };

  for (let pass = 0; pass < 12 && splits < maxSplits; pass++) {
    const cand = candidates();
    if (!cand.length) break;
    for (const [a, b] of cand) {
      if (splits >= maxSplits) break;
      const faces = emap.get(ekey(a, b));
      if (!faces || !faces.length) continue;
      if (len2(a, b) <= max2) continue;
      const mv = m.addVert(lerp(P[a], P[b], 0.5), [[a, 0.5], [b, 0.5]]);
      for (const fi of faces.slice()) {
        const f = m.faces[fi];
        const n = f.v.length;
        let i = -1;
        for (let k = 0; k < n; k++) { const x = f.v[k], y = f.v[(k + 1) % n]; if ((x === a && y === b) || (x === b && y === a)) { i = k; break; } }
        if (i < 0) continue;
        const x = f.v[i], y = f.v[(i + 1) % n];
        const ux = f.uv[i], uy = f.uv[(i + 1) % n];
        const umid = lerp2(ux, uy, 0.5);
        for (let k = 0; k < n; k++) remE(f.v[k], f.v[(k + 1) % n], fi);
        if (n === 3 && isTri.has(fi)) {
          const cv = f.v[(i + 2) % 3], uc = f.uv[(i + 2) % 3];
          m.faces[fi] = { v: [x, mv, cv], uv: [ux, umid, uc] };
          m.faces.push({ v: [mv, y, cv], uv: [umid, uy, uc] });
          const nf = m.faces.length - 1;
          isTri.add(nf); regionSet.add(nf); ring.add(nf);
          for (const id of [fi, nf]) { const g = m.faces[id]; for (let k = 0; k < 3; k++) addE(g.v[k], g.v[(k + 1) % 3], id); }
        } else {
          // n-gon outside the brush: insert the midpoint into its loop
          f.v.splice(i + 1, 0, mv); f.uv.splice(i + 1, 0, umid);
          isTri.delete(fi);
          touchedNgons.add(fi);
          for (let k = 0; k < f.v.length; k++) addE(f.v[k], f.v[(k + 1) % f.v.length], fi);
        }
      }
      const sk = ekey(a, b);
      if (m.seams.has(sk)) { m.seams.delete(sk); m.seams.add(ekey(a, mv)); m.seams.add(ekey(mv, b)); }
      splits++;
    }
  }
  // border faces that received extra points become clean triangles (avoids
  // shading artefacts from non-planar n-gons once the brush moves them)
  for (const fi of touchedNgons) {
    const f = m.faces[fi];
    if (f.v.length <= 3) continue;
    const tris = triangulateFace(P, f.v);
    tris.forEach(([a, b, cc], k) => {
      const nf: Face = { v: [f.v[a], f.v[b], f.v[cc]], uv: [f.uv[a], f.uv[b], f.uv[cc]] };
      if (k === 0) m.faces[fi] = nf; else m.faces.push(nf);
    });
  }
  if (splits) m.changed();
  return splits;
}
