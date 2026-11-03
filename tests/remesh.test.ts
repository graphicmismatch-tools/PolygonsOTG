import { describe, it, expect } from 'vitest';
import { createPrimitive } from '../src/core/primitives';
import { Mesh } from '../src/core/mesh';
import { remesh } from '../src/core/remesh';
import { decimate, unsubdivide } from '../src/core/decimate';
import { catmullClark } from '../src/core/modifiers';
import { subdivideFaces } from '../src/core/ops';
import { cross, dot, sub, avg3 } from '../src/core/vec';

const closed = (m: Mesh) => m.edges.every((e) => e.faces.length === 2);
const consistent = (m: Mesh) => {
  const d = new Map<string, number>();
  for (const f of m.faces) for (let i = 0; i < f.v.length; i++) { const k = `${f.v[i]}>${f.v[(i + 1) % f.v.length]}`; d.set(k, (d.get(k) ?? 0) + 1); }
  return [...d.values()].every((c) => c === 1);
};
const volume = (m: Mesh) => {
  const c = avg3(m.verts);
  let v = 0;
  for (const f of m.faces) { const p0 = sub(m.verts[f.v[0]], c); for (let i = 1; i + 1 < f.v.length; i++) v += dot(p0, cross(sub(m.verts[f.v[i]], c), sub(m.verts[f.v[i + 1]], c))); }
  return v / 6;
};
const maxRadiusErr = (m: Mesh, r: number) => Math.max(...m.verts.map((p) => Math.abs(Math.hypot(...p) - r)));

describe('remesh', () => {
  it('voxel: sphere -> closed, outward, all quads, close to the surface', () => {
    const s = createPrimitive('uvsphere', { segments: 24, rings: 16 });
    const m = remesh(s, { mode: 'voxel', size: 0.08, smooth: 1, project: true });
    expect(m.faces.length).toBeGreaterThan(500);
    expect(m.faces.every((f) => f.v.length === 4)).toBe(true);
    expect(closed(m) && consistent(m)).toBe(true);
    expect(volume(m)).toBeGreaterThan(0);
    expect(Math.abs(volume(m) - volume(s)) / volume(s)).toBeLessThan(0.05);
    expect(maxRadiusErr(m, 1)).toBeLessThan(0.06);
  });
  it('voxel: merges two overlapping cubes into one shell', () => {
    const a = createPrimitive('cube');
    const b = createPrimitive('cube');
    const m = new Mesh();
    m.verts = [...a.verts, ...b.verts.map((p) => [p[0] + 1, p[1] + 0.5, p[2]] as [number, number, number])];
    m.faces = [...a.faces, ...b.faces.map((f) => ({ v: f.v.map((v) => v + 8), uv: f.uv }))];
    m.changed();
    const r = remesh(m, { mode: 'voxel', size: 0.1, smooth: 0 });
    expect(closed(r) && consistent(r)).toBe(true);
    // a single connected component
    const seen = new Set([0]); const q = [0];
    while (q.length) { const v = q.pop()!; for (const n of r.vertNeighbors(v)) if (!seen.has(n)) { seen.add(n); q.push(n); } }
    expect(seen.size).toBe(r.verts.length);
  });
  it('voxel: thickens an open plane instead of failing', () => {
    const m = remesh(createPrimitive('grid', { segments: 4 }), { mode: 'voxel', size: 0.1, smooth: 0 });
    expect(m.faces.length).toBeGreaterThan(50);
    expect(closed(m)).toBe(true);
  });
  it('blocks: closed, outward, axis-aligned quads', () => {
    const m = remesh(createPrimitive('icosphere', { subdivisions: 2 }), { mode: 'blocks', size: 0.25 });
    expect(m.faces.every((f) => f.v.length === 4)).toBe(true);
    expect(consistent(m)).toBe(true);
    expect(volume(m)).toBeGreaterThan(0);
  });
  it('isotropic: uniform edges on a lumpy mesh, stays closed', () => {
    const s = catmullClark(catmullClark(createPrimitive('cube')));
    const L = 0.2;
    const m = remesh(s, { mode: 'isotropic', size: L, iterations: 5 });
    expect(closed(m) && consistent(m)).toBe(true);
    const lens = m.edges.map((e) => Math.hypot(...m.verts[e.a].map((x, i) => x - m.verts[e.b][i]) as [number, number, number]));
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    expect(mean).toBeGreaterThan(L * 0.7);
    expect(mean).toBeLessThan(L * 1.3);
    const within = lens.filter((l) => l > L * 0.5 && l < L * 1.5).length / lens.length;
    expect(within).toBeGreaterThan(0.9);
  });
  it('isotropic: keeps open boundaries, optional quads', () => {
    const g = createPrimitive('grid', { segments: 3 });
    const m = remesh(g, { mode: 'isotropic', size: 0.25, iterations: 3, quads: true });
    expect(consistent(m)).toBe(true);
    expect(m.faces.some((f) => f.v.length === 4)).toBe(true);
    const bnd = m.edges.filter((e) => e.faces.length === 1).length;
    expect(bnd).toBeGreaterThan(8);
  });
});

describe('decimate', () => {
  it('collapse: halves a sphere and keeps its shape', () => {
    const s = createPrimitive('icosphere', { subdivisions: 3 });
    const tris = s.faces.length;
    const m = decimate(s, { mode: 'collapse', ratio: 0.25 });
    expect(m.faces.length).toBeLessThanOrEqual(Math.ceil(tris * 0.25) + 2);
    expect(closed(m) && consistent(m)).toBe(true);
    expect(maxRadiusErr(m, 1)).toBeLessThan(0.12);
  });
  it('collapse: flat regions go first (cube stays a cube)', () => {
    const c = createPrimitive('cube');
    c.selF = new Set(c.faces.map((_, i) => i)); c.flush('face');
    subdivideFaces(c); subdivideFaces(c);
    const m = decimate(c, { mode: 'collapse', ratio: 0.1 });
    expect(closed(m) && consistent(m)).toBe(true);
    for (const p of m.verts) expect(Math.max(...p.map(Math.abs))).toBeCloseTo(1, 4);
  });
  it('collapse: preserves an open boundary', () => {
    const g = createPrimitive('grid', { segments: 8 });
    const m = decimate(g, { mode: 'collapse', ratio: 0.2 });
    for (const e of m.edges.filter((e) => e.faces.length === 1)) {
      const p = m.verts[e.a];
      expect(Math.max(Math.abs(p[0]), Math.abs(p[2]))).toBeCloseTo(1, 4);
    }
  });
  it('unsubdivide reverses subdivideFaces exactly (topology)', () => {
    const c = createPrimitive('cube');
    c.selF = new Set(c.faces.map((_, i) => i)); c.flush('face');
    subdivideFaces(c);
    expect(c.faces.length).toBe(24);
    const r = unsubdivide(c)!;
    expect(r).toBeTruthy();
    expect(r.faces.length).toBe(6);
    expect(r.verts.length).toBe(8);
    expect(closed(r) && consistent(r)).toBe(true);
  });
  it('unsubdivide two levels of catmull-clark on a cylinder', () => {
    const cyl = createPrimitive('cylinder', { segments: 8 });
    const s = catmullClark(catmullClark(cyl));
    const r = decimate(s, { mode: 'unsubdivide', iterations: 2 });
    expect(r.faces.length).toBe(cyl.faces.length);
    expect(closed(r) && consistent(r)).toBe(true);
  });
  it('unsubdivide refuses a triangle mesh', () => {
    expect(unsubdivide(createPrimitive('icosphere'))).toBeNull();
  });
  it('planar: subdivided cube collapses back to 6 n-gons', () => {
    const c = createPrimitive('cube');
    c.selF = new Set(c.faces.map((_, i) => i)); c.flush('face');
    subdivideFaces(c); subdivideFaces(c);
    const m = decimate(c, { mode: 'planar', angle: 5 });
    expect(m.faces.length).toBe(6);
    expect(m.verts.length).toBe(8);
    expect(closed(m) && consistent(m)).toBe(true);
  });
});
