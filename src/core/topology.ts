import { Mesh } from './mesh';
import { V2, V3, polyNormal } from './vec';

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

