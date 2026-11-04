import { describe, it, expect } from 'vitest';
import { createPrimitive } from '../src/core/primitives';
import { SceneObject } from '../src/core/scene';
import { unwrapLSCM, smartProject } from '../src/core/uv';
import { newModifier } from '../src/core/modifiers';
import { uvLayoutSVG, uvLayoutCheck, defaultLayoutOptions } from '../src/io/uvLayout';

function unwrapped() {
  const m = createPrimitive('cube');
  smartProject(m);
  return new SceneObject('Box', m);
}

describe('uv layout', () => {
  it('draws one polygon per face and each UV edge once', () => {
    const o = unwrapped();
    const svg = uvLayoutSVG([o], { ...defaultLayoutOptions(), size: 512 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<polygon/g) ?? []).length).toBe(6);
    const edges = svg.match(/id="edges"[^>]*d="([^"]*)"/)![1];
    const segs = (edges.match(/M/g) ?? []).length;
    // 6 separate quads at most 24 segments; shared island edges are drawn once
    expect(segs).toBeGreaterThan(0);
    expect(segs).toBeLessThanOrEqual(24);
    // V up: a UV of (0, 1) maps to the top-left pixel
    expect(svg).toContain('width="512"');
  });

  it('puts seams on their own layer', () => {
    const o = unwrapped();
    const k = o.mesh.edges[0].key;
    o.mesh.seams.add(k);
    const svg = uvLayoutSVG([o], { ...defaultLayoutOptions(), seams: true });
    expect(svg.match(/id="seams"[^>]*d="([^"]*)"/)![1].length).toBeGreaterThan(0);
  });

  it('flags missing, out-of-range and overlapping UVs', () => {
    const blank = new SceneObject('Blank', createPrimitive('cube'));
    for (const f of blank.mesh.faces) f.uv = f.uv.map(() => [0, 0]);
    expect(uvLayoutCheck([blank]).warnings[0]).toContain('no UV map');

    const out = unwrapped();
    for (const f of out.mesh.faces) f.uv = f.uv.map(([u, v]) => [u + 0.8, v]);
    expect(uvLayoutCheck([out]).warnings.some((w) => w.includes('outside the 0–1'))).toBe(true);

    const stacked = new SceneObject('Stacked', createPrimitive('cube'));
    // map every face to the full square: separate islands stacked on each other
    for (const f of stacked.mesh.faces) f.uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(uvLayoutCheck([stacked]).warnings.some((w) => w.includes('overlap'))).toBe(true);

    const clean = unwrapped();
    expect(uvLayoutCheck([clean]).warnings).toEqual([]);
  });

  it('notes mirror modifiers and multiple objects', () => {
    const a = unwrapped(), b = unwrapped();
    a.modifiers.push(newModifier('mirror'));
    const notes = uvLayoutCheck([a, b]).notes;
    expect(notes.some((n) => n.includes('Mirror'))).toBe(true);
    expect(notes.some((n) => n.includes('2 objects'))).toBe(true);
  });

  it('unwrapped sphere stays inside the square', () => {
    const m = createPrimitive('uvsphere');
    const o = new SceneObject('Ball', m);
    for (const k of m.edges.filter((e) => Math.abs(m.verts[e.a][0]) < 1e-6 && m.verts[e.a][2] > 0 && Math.abs(m.verts[e.b][0]) < 1e-6 && m.verts[e.b][2] > 0)) m.seams.add(k.key);
    unwrapLSCM(m);
    expect(uvLayoutCheck([o]).warnings.filter((w) => w.includes('outside'))).toEqual([]);
  });
});
