import { describe, it, expect } from 'vitest';
import { createPrimitive } from '../src/core/primitives';
import { Mesh, isPinned } from '../src/core/mesh';
import { unwrapLSCM, liveUnwrap, chartsOf, uvStretch } from '../src/core/uv';
import * as ops from '../src/core/ops';

/** Grid 6×6 bent into a half cylinder: developable, so LSCM is exact. */
function sheet(): Mesh {
  const m = createPrimitive('grid', { size: 2, segments: 6 } as any);
  m.verts = m.verts.map(([x, , z]) => [Math.sin(x) , 1 - Math.cos(x), z]);
  m.touch();
  return m;
}
const cornerOf = (m: Mesh, v: number): [number, number] => { const f = m.vertFaces(v)[0]; return [f, m.faces[f].v.indexOf(v)]; };
const pin = (m: Mesh, v: number, uv: [number, number]) => {
  for (const fi of m.vertFaces(v)) { const f = m.faces[fi]; const c = f.v.indexOf(v); f.pin = f.pin ?? f.v.map(() => false); f.pin[c] = true; f.uv[c] = [...uv]; }
};
const uvOf = (m: Mesh, v: number) => { const [f, c] = cornerOf(m, v); return m.faces[f].uv[c]; };

describe('pins & live unwrap', () => {
  it('two pins are kept exactly and the rest follows', () => {
    const m = sheet();
    unwrapLSCM(m);
    const a = 0, b = m.verts.length - 1;
    pin(m, a, [0.1, 0.1]); pin(m, b, [0.9, 0.7]);
    const r = unwrapLSCM(m);
    expect(r.pinned).toBe(1);
    expect(uvOf(m, a)).toEqual([0.1, 0.1]);
    expect(uvOf(m, b)).toEqual([0.9, 0.7]);
    // a developable sheet stays undistorted around the pins
    expect(uvStretch(m, m.faces.map((_, i) => i), 'angle').mean).toBeLessThan(0.02);
  });

  it('one pin anchors an island without repacking it', () => {
    const m = sheet();
    unwrapLSCM(m);
    const before = m.faces.map((f) => f.uv.map((u) => [...u]));
    pin(m, 5, [0.3, 0.6]);
    unwrapLSCM(m);
    expect(uvOf(m, 5)).toEqual([0.3, 0.6]);
    // same size as before (fitted onto the previous layout)
    const span = (uv: number[][][]) => { const xs = uv.flat().map((u) => u[0]); return Math.max(...xs) - Math.min(...xs); };
    expect(Math.abs(span(m.faces.map((f) => f.uv)) / span(before) - 1)).toBeLessThan(0.05);
  });

  it('live unwrap re-solves a chart in place after a seam change', () => {
    const m = createPrimitive('cylinder');
    // open the cylinder: one vertical seam plus the cap rims
    for (const e of m.edges) if (e.faces.length === 2 && Math.abs(m.verts[e.a][1] - m.verts[e.b][1]) < 1e-6) m.seams.add(e.key);
    const side = m.edges.find((e) => Math.abs(m.verts[e.a][1] - m.verts[e.b][1]) > 0.5)!;
    m.seams.add(side.key);
    unwrapLSCM(m);
    const faces = m.edge(side.key)!.faces;
    const charts = chartsOf(m, faces);
    const centre = (c: number[]) => { let x = 0, y = 0, n = 0; for (const f of c) for (const u of m.faces[f].uv) { x += u[0]; y += u[1]; n++; } return [x / n, y / n]; };
    const c0 = centre(charts[0]);
    const r = liveUnwrap(m, charts);
    expect(r.solved).toBe(1);
    const c1 = centre(charts[0]);
    expect(Math.hypot(c1[0] - c0[0], c1[1] - c0[1])).toBeLessThan(0.02);
  });

  it('pins survive undo snapshots, JSON and flipping', () => {
    const m = sheet();
    pin(m, 3, [0.5, 0.5]);
    const [f, c] = cornerOf(m, 3);
    expect(isPinned(m.clone().faces[f], c)).toBe(true);
    expect(isPinned(Mesh.fromJSON(JSON.parse(JSON.stringify(m.toJSON()))).faces[f], c)).toBe(true);
    ops.flipFaces(m, [f]);
    expect(isPinned(m.faces[f], m.faces[f].v.indexOf(3))).toBe(true);
  });
});

describe('stretch', () => {
  it('is zero for a clean unwrap and grows with distortion', () => {
    const m = sheet();
    unwrapLSCM(m);
    const all = m.faces.map((_, i) => i);
    expect(uvStretch(m, all, 'angle').mean).toBeLessThan(0.02);
    expect(uvStretch(m, all, 'area').mean).toBeLessThan(0.02);
    // squash U by half: angles distort, relative areas stay equal
    for (const f of m.faces) f.uv = f.uv.map(([u, v]) => [u * 0.5, v]);
    expect(uvStretch(m, all, 'angle').mean).toBeGreaterThan(0.4);
    expect(uvStretch(m, all, 'area').mean).toBeLessThan(0.02);
    // shrink one face: its area share drops
    m.faces[0].uv = m.faces[0].uv.map(([u, v]) => [u * 0.2, v * 0.2]);
    expect(uvStretch(m, all, 'area').face[0]).toBeGreaterThan(0.5);
  });

  it('flags collapsed faces', () => {
    const m = sheet();
    m.faces[2].uv = m.faces[2].uv.map(() => [0.5, 0.5]);
    expect(uvStretch(m, [2], 'angle').face[2]).toBe(1);
  });
});
