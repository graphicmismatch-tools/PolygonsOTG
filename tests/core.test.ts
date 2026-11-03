import { describe, it, expect } from 'vitest';
import { createPrimitive, PRIMITIVES } from '../src/core/primitives';
import { Mesh, ekey } from '../src/core/mesh';
import * as ops from '../src/core/ops';
import { catmullClark, mirror } from '../src/core/modifiers';
import { unwrapLSCM, smartProject, uvIslands } from '../src/core/uv';
import { cross, dot, sub, avg3 } from '../src/core/vec';

/** Euler characteristic V - E + F and closedness checks. */
function closed(m: Mesh) { return m.edges.every((e) => e.faces.length === 2); }
function outward(m: Mesh) {
  // signed volume positive => outward
  const c = avg3(m.verts);
  let vol = 0;
  for (const f of m.faces) {
    const p0 = sub(m.verts[f.v[0]], c);
    for (let i = 1; i + 1 < f.v.length; i++) vol += dot(p0, cross(sub(m.verts[f.v[i]], c), sub(m.verts[f.v[i + 1]], c)));
  }
  return vol > 0;
}
function consistent(m: Mesh) {
  // each manifold edge traversed once in each direction
  const dir = new Map<string, number>();
  for (const f of m.faces) for (let i = 0; i < f.v.length; i++) { const k = `${f.v[i]}>${f.v[(i + 1) % f.v.length]}`; dir.set(k, (dir.get(k) ?? 0) + 1); }
  return [...dir.values()].every((c) => c === 1);
}

describe('primitives', () => {
  for (const p of PRIMITIVES) {
    if (['plane', 'grid', 'circle', 'vertex'].includes(p.type)) continue;
    it(`${p.type} is closed, consistent and outward`, () => {
      const m = createPrimitive(p.type);
      expect(closed(m)).toBe(true);
      expect(consistent(m)).toBe(true);
      expect(outward(m)).toBe(true);
      expect(m.verts.length - m.edges.length + m.faces.length).toBe(p.type === 'torus' ? 0 : 2);
    });
  }
});

describe('edit ops', () => {
  it('extrudes a cube face region', () => {
    const m = createPrimitive('cube');
    m.selF = new Set([0]); m.flush('face');
    const r = ops.extrudeFaces(m);
    expect(m.faces.length).toBe(10);
    expect(m.verts.length).toBe(12);
    expect(r.moveVerts.length).toBe(4);
    expect(closed(m) && consistent(m)).toBe(true);
    expect(r.normal![2]).toBeCloseTo(1);
  });
  it('extrudes two adjacent faces as region', () => {
    const m = createPrimitive('cube');
    m.selF = new Set([0, 4]); m.flush('face');
    ops.extrudeFaces(m);
    expect(closed(m) && consistent(m)).toBe(true);
    expect(m.faces.length).toBe(6 + 6);
  });
  it('extrudes edges of a plane', () => {
    const m = createPrimitive('plane');
    m.selE = new Set([ekey(0, 1)]); m.flush('edge');
    ops.extrudeEdges(m);
    expect(m.faces.length).toBe(2);
    expect(consistent(m)).toBe(true);
  });
  it('extrudes a lone vertex into a wire edge', () => {
    const m = createPrimitive('vertex');
    m.selV = new Set([0]); m.flush('vert');
    ops.extrudeEdges(m);
    expect(m.verts.length).toBe(2);
    expect(m.looseEdges.length).toBe(1);
    expect(m.edges.length).toBe(1);
  });
  it('insets faces', () => {
    const m = createPrimitive('cube');
    m.selF = new Set([0]); m.flush('face');
    const h = ops.insetFaces(m)!;
    h.set(0.3, 0.1);
    expect(m.faces.length).toBe(10);
    expect(closed(m) && consistent(m)).toBe(true);
  });
  it('subdivides a face and splits neighbours', () => {
    const m = createPrimitive('cube');
    m.selF = new Set([0]); m.flush('face');
    ops.subdivideFaces(m);
    expect(m.faces.length).toBe(9);
    expect(closed(m) && consistent(m)).toBe(true);
  });
  it('loop cuts around a cube', () => {
    const m = createPrimitive('cube');
    const k = ekey(4, 5);
    const h = ops.loopCut(m, k)!;
    expect(h).toBeTruthy();
    expect(m.faces.length).toBe(10);
    expect(m.verts.length).toBe(12);
    expect(closed(m) && consistent(m)).toBe(true);
    expect(m.selE.size).toBe(4);
    h.set(0.5);
  });
  it('loop cuts a grid with multiple cuts (open ring)', () => {
    const m = createPrimitive('grid', { segments: 3 });
    const before = m.faces.length;
    ops.loopCut(m, ekey(0, 1), 2);
    expect(m.faces.length).toBe(before + 6);
    expect(consistent(m)).toBe(true);
  });
  it('loop cut through a cylinder ring ends at caps', () => {
    const m = createPrimitive('cylinder', { segments: 8 });
    // a vertical side edge: bot[0]=0 to top[0]=8
    ops.loopCut(m, ekey(0, 1));
    expect(closed(m) && consistent(m)).toBe(true);
  });
  it('merges at center', () => {
    const m = createPrimitive('cube');
    m.selV = new Set([4, 5, 6, 7]); m.flush('vert');
    ops.mergeAtCenter(m);
    expect(m.verts.length).toBe(5);
    expect(m.faces.length).toBe(5);
    expect(closed(m) && consistent(m)).toBe(true);
  });
  it('merges by distance', () => {
    const m = createPrimitive('cube');
    m.selF = new Set([0]); m.flush('face');
    ops.extrudeFaces(m); // duplicate verts at same position
    m.selV.clear();
    const removed = ops.mergeByDistance(m, 1e-4, false);
    expect(removed).toBe(4);
  });
  it('deletes faces and fills them back', () => {
    const m = createPrimitive('cube');
    m.selF = new Set([0]); m.flush('face');
    ops.deleteSelection(m, 'face');
    expect(m.faces.length).toBe(5);
    expect(closed(m)).toBe(false);
    // select the hole border
    const border = m.edges.filter((e) => e.faces.length === 1);
    m.selE = new Set(border.map((e) => e.key)); m.flush('edge');
    expect(ops.fill(m)).toBe(true);
    expect(closed(m) && consistent(m)).toBe(true);
  });
  it('recalculates normals', () => {
    const m = createPrimitive('cube');
    ops.flipFaces(m, [0, 2]);
    expect(consistent(m)).toBe(false);
    m.selF.clear();
    ops.recalcNormals(m, false);
    expect(consistent(m) && outward(m)).toBe(true);
  });
  it('edge loop selection on a torus', () => {
    const m = createPrimitive('torus', { segments: 8, rings: 6 });
    const loop = ops.edgeLoop(m, m.edges[0].key);
    expect([6, 8]).toContain(loop.length);
  });
  it('triangulates', () => {
    const m = createPrimitive('cylinder', { segments: 8 });
    m.selF = new Set(m.faces.map((_, i) => i)); m.flush('face');
    ops.triangulate(m);
    expect(m.faces.every((f) => f.v.length === 3)).toBe(true);
    expect(closed(m) && consistent(m)).toBe(true);
  });
  it('dissolves faces into an n-gon', () => {
    const m = createPrimitive('grid', { segments: 2 });
    m.selF = new Set([0, 1, 2, 3]); m.flush('face');
    expect(ops.dissolveFaces(m)).toBe(true);
    expect(m.faces.length).toBe(1);
    expect(m.faces[0].v.length).toBe(8);
  });
});

describe('modifiers', () => {
  it('catmull-clark on cube', () => {
    const m = catmullClark(createPrimitive('cube'));
    expect(m.faces.length).toBe(24);
    expect(m.verts.length).toBe(26);
    expect(closed(m) && consistent(m)).toBe(true);
  });
  it('mirror merges center', () => {
    const m = createPrimitive('cube');
    m.selV = new Set([0, 3, 4, 7]); m.flush('vert');
    ops.deleteSelection(m, 'vert'); // keep +x half... remaining verts at x=+1
    const half = createPrimitive('grid', { segments: 1 });
    half.verts.forEach((p) => (p[0] += 1));
    const r = mirror(half, 0, 0.001);
    expect(r.faces.length).toBe(2);
    expect(r.verts.length).toBe(6);
    expect(consistent(r)).toBe(true);
  });
});

describe('uv', () => {
  it('lscm unwraps a cube with seams', () => {
    const m = createPrimitive('cube');
    // classic cube seams: cut around top & bottom except one edge, plus one vertical edge
    for (const e of m.edges) m.seams.add(e.key);
    // remove some seams so chart stays connected as cross
    const res = unwrapLSCM(m);
    expect(res.charts).toBe(6);
    for (const f of m.faces) for (const u of f.uv) { expect(u[0]).toBeGreaterThanOrEqual(-1e-6); expect(u[0]).toBeLessThanOrEqual(1 + 1e-6); }
  });
  it('lscm unwraps an open grid as a single island', () => {
    const m = createPrimitive('grid', { segments: 4 });
    m.verts.forEach((p) => (p[1] = Math.sin(p[0]) * 0.3));
    const res = unwrapLSCM(m);
    expect(res.charts).toBe(1);
    expect(res.fallback).toBe(0);
    expect(uvIslands(m, m.faces.map((_, i) => i)).length).toBe(1);
    // check conformality: UV quads near square
    const f = m.faces[5];
    const d1 = Math.hypot(f.uv[1][0] - f.uv[0][0], f.uv[1][1] - f.uv[0][1]);
    const d2 = Math.hypot(f.uv[3][0] - f.uv[0][0], f.uv[3][1] - f.uv[0][1]);
    expect(d1 / d2).toBeGreaterThan(0.7);
    expect(d1 / d2).toBeLessThan(1.4);
  });
  it('smart project a sphere', () => {
    const m = createPrimitive('uvsphere');
    const n = smartProject(m);
    expect(n).toBeGreaterThan(1);
  });
});

describe('vertex tools', () => {
  it('connects two opposite verts of a quad', () => {
    const m = createPrimitive('plane');
    m.selV = new Set([0, 3]); m.flush('vert');
    expect(ops.connectVerts(m)).toBe(1);
    expect(m.faces.length).toBe(2);
    expect(consistent(m)).toBe(true);
  });
  it('subdivides edges in place', () => {
    const m = createPrimitive('cube');
    m.selE = new Set([ekey(4, 5)]); m.flush('edge');
    ops.subdivideEdges(m, 2);
    expect(m.verts.length).toBe(10);
    expect(closed(m) && consistent(m)).toBe(true);
  });
  it('bridges two loops', () => {
    const m = createPrimitive('cylinder', { segments: 6 });
    // delete caps -> two open loops
    const caps = m.faces.map((f, i) => (f.v.length === 6 ? i : -1)).filter((i) => i >= 0);
    m.selF = new Set(caps); m.flush('face');
    ops.deleteOnlyFaces(m);
    // delete sides, keep only wire loops: instead select the two border loops of the tube and bridge again after removing sides
    m.selF = new Set(m.faces.map((_, i) => i)); m.flush('face');
    ops.deleteSelection(m, 'face');
    // rebuild as two circles
    const a = createPrimitive('circle', { segments: 6, fill: false });
    a.verts.forEach((p) => (p[1] = -1));
    const b = createPrimitive('circle', { segments: 6, fill: false });
    b.verts.forEach((p) => (p[1] = 1));
    const mm = new Mesh();
    mm.verts = [...a.verts, ...b.verts];
    mm.looseEdges = [...a.looseEdges, ...b.looseEdges.map(([x, y]) => [x + 6, y + 6] as [number, number])];
    mm.changed();
    mm.selV = new Set(mm.verts.map((_, i) => i)); mm.flush('vert');
    expect(ops.bridgeEdgeLoops(mm)).toBe(true);
    expect(mm.faces.length).toBe(6);
    expect(consistent(mm)).toBe(true);
  });
});

describe('lscm with seams', () => {
  it('unwraps a cylinder side into a near-rectangle strip', () => {
    const m = createPrimitive('cylinder', { segments: 12 });
    for (const e of m.edges) { if (e.faces.some((fi) => m.faces[fi].v.length > 4)) m.seams.add(e.key); }
    const side = m.edges.find((e) => e.faces.every((fi) => m.faces[fi].v.length === 4))!;
    m.seams.add(side.key);
    const res = unwrapLSCM(m);
    expect(res.charts).toBe(3);
    expect(res.fallback).toBe(0);
    // all side quads should have the same UV size (isometric strip)
    const quads = m.faces.filter((f) => f.v.length === 4);
    const sizes = quads.map((f) => Math.hypot(f.uv[1][0] - f.uv[0][0], f.uv[1][1] - f.uv[0][1]));
    const hs = quads.map((f) => Math.hypot(f.uv[3][0] - f.uv[0][0], f.uv[3][1] - f.uv[0][1]));
    const mn = Math.min(...sizes), mx = Math.max(...sizes);
    expect(mx / mn).toBeLessThan(1.05);
    // aspect ratio of a quad = (2πr/12) / h = 0.5236 / 2
    expect(sizes[0] / hs[0]).toBeGreaterThan(0.24);
    expect(sizes[0] / hs[0]).toBeLessThan(0.28);
  });
});
