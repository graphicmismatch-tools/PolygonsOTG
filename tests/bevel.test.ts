import { describe, it, expect } from 'vitest';
import { createPrimitive } from '../src/core/primitives';
import { Mesh, ekey } from '../src/core/mesh';
import { bevel } from '../src/core/bevel';

const closed = (m: Mesh) => m.edges.every((e) => e.faces.length === 2);
const consistent = (m: Mesh) => {
  const d = new Map<string, number>();
  for (const f of m.faces) for (let i = 0; i < f.v.length; i++) { const k = `${f.v[i]}>${f.v[(i + 1) % f.v.length]}`; d.set(k, (d.get(k) ?? 0) + 1); }
  return [...d.values()].every((c) => c === 1);
};
const euler = (m: Mesh) => m.verts.length - m.edges.length + m.faces.length;

function cubeWithEdges(keys: [number, number][]) {
  const m = createPrimitive('cube');
  m.selE = new Set(keys.map(([a, b]) => ekey(a, b)));
  m.flush('edge');
  return m;
}

describe('bevel', () => {
  it('single cube edge, 1 segment', () => {
    const m = cubeWithEdges([[4, 5]]);
    expect(bevel(m, { width: 0.3, segments: 1 })).toBe(true);
    expect(m.faces.length).toBe(7);
    expect(m.verts.length).toBe(10);
    expect(closed(m) && consistent(m)).toBe(true);
    expect(euler(m)).toBe(2);
  });
  it('single cube edge, 4 segments (rounded)', () => {
    const m = cubeWithEdges([[4, 5]]);
    bevel(m, { width: 0.3, segments: 4 });
    expect(closed(m) && consistent(m)).toBe(true);
    expect(euler(m)).toBe(2);
    expect(m.faces.length).toBe(6 + 4 + 2);
  });
  it('three edges meeting at a corner', () => {
    const m = cubeWithEdges([[6, 5], [6, 7], [6, 2]]);
    bevel(m, { width: 0.25, segments: 1 });
    expect(closed(m) && consistent(m)).toBe(true);
    expect(euler(m)).toBe(2);
    // 6 faces + 3 strips + 1 triangle corner patch + 3 end patches? (2-of-3 style corners) -> at least 10
    expect(m.faces.length).toBeGreaterThanOrEqual(10);
  });
  it('three edges at a corner with segments', () => {
    const m = cubeWithEdges([[6, 5], [6, 7], [6, 2]]);
    bevel(m, { width: 0.25, segments: 3 });
    expect(closed(m) && consistent(m)).toBe(true);
    expect(euler(m)).toBe(2);
  });
  it('all cube edges', () => {
    const m = createPrimitive('cube');
    m.selE = new Set(m.edges.map((e) => e.key)); m.flush('edge');
    bevel(m, { width: 0.2, segments: 1 });
    expect(m.faces.length).toBe(6 + 12 + 8);
    expect(closed(m) && consistent(m)).toBe(true);
    expect(euler(m)).toBe(2);
  });
  it('all cube edges with segments', () => {
    const m = createPrimitive('cube');
    m.selE = new Set(m.edges.map((e) => e.key)); m.flush('edge');
    bevel(m, { width: 0.2, segments: 3 });
    expect(closed(m) && consistent(m)).toBe(true);
    expect(euler(m)).toBe(2);
  });
  it('edge loop around a cylinder', () => {
    const m = createPrimitive('cylinder', { segments: 8 });
    // top rim edges
    const rim = m.edges.filter((e) => m.verts[e.a][1] > 0 && m.verts[e.b][1] > 0);
    m.selE = new Set(rim.map((e) => e.key)); m.flush('edge');
    bevel(m, { width: 0.2, segments: 2 });
    expect(closed(m) && consistent(m)).toBe(true);
    expect(euler(m)).toBe(2);
  });
  it('vertex bevel (chamfer a cube corner)', () => {
    const m = createPrimitive('cube');
    m.selV = new Set([6]); m.flush('vert');
    bevel(m, { width: 0.4, segments: 1, vertexOnly: true });
    expect(m.verts.length).toBe(10);
    expect(m.faces.length).toBe(7);
    expect(closed(m) && consistent(m)).toBe(true);
  });
  it('bevel on a grid interior edge loop', () => {
    const m = createPrimitive('grid', { segments: 4 });
    // middle row edges along x at z=0
    const mid = m.edges.filter((e) => Math.abs(m.verts[e.a][2]) < 1e-6 && Math.abs(m.verts[e.b][2]) < 1e-6);
    m.selE = new Set(mid.map((e) => e.key)); m.flush('edge');
    bevel(m, { width: 0.1, segments: 1 });
    expect(consistent(m)).toBe(true);
  });
});

import { refine } from '../src/core/dyntopo';
import { knifeCut } from '../src/core/ops';

describe('dyntopo refine', () => {
  it('adds detail only under the brush and stays watertight', () => {
    const m = createPrimitive('cube');
    const before = m.faces.length;
    const n = refine(m, [1, 1, 1], 0.8, 0.25);
    expect(n).toBeGreaterThan(10);
    expect(m.faces.length).toBeGreaterThan(before);
    expect(closed(m) && consistent(m)).toBe(true);
    expect(euler(m)).toBe(2);
    // far corner untouched: vertex 0 still has only its original 3 neighbours
    expect(m.vertNeighbors(0).length).toBeLessThanOrEqual(4);
  });
  it('respects the split budget', () => {
    const m = createPrimitive('uvsphere');
    const n = refine(m, [0, 1, 0], 1, 0.01, 200);
    expect(n).toBe(200);
    expect(closed(m) && consistent(m)).toBe(true);
  });
});

describe('knife', () => {
  it('cuts across a cube face between two edges', () => {
    const m = createPrimitive('cube');
    // front face [4,5,6,7]: cut from edge 4-7 to edge 5-6
    const cuts = knifeCut(m, [{ a: 4, b: 7, t: 0.5 }, { a: 5, b: 6, t: 0.5 }]);
    expect(cuts).toBe(1);
    expect(m.faces.length).toBe(7);
    expect(closed(m) && consistent(m)).toBe(true);
  });
  it('cuts a line across two faces', () => {
    const m = createPrimitive('cube');
    const cuts = knifeCut(m, [{ a: 4, b: 7, t: 0.5 }, { a: 5, b: 6, t: 0.5 }, { a: 1, b: 2, t: 0.5 }]);
    expect(cuts).toBe(2);
    expect(closed(m) && consistent(m)).toBe(true);
  });
});
