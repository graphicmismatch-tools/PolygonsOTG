import { Mesh } from './mesh';
import { V2, V3, normalize } from './vec';

export type PrimitiveType = 'cube' | 'plane' | 'grid' | 'circle' | 'uvsphere' | 'icosphere' | 'cylinder' | 'cone' | 'torus' | 'vertex';

export interface PrimitiveOptions {
  size?: number;
  segments?: number;
  rings?: number;
  subdivisions?: number;
  fill?: boolean;
}

export const PRIMITIVES: { type: PrimitiveType; label: string; defaults: PrimitiveOptions }[] = [
  { type: 'cube', label: 'Cube', defaults: { size: 2 } },
  { type: 'plane', label: 'Plane', defaults: { size: 2 } },
  { type: 'grid', label: 'Grid', defaults: { size: 2, segments: 4 } },
  { type: 'circle', label: 'Circle', defaults: { size: 1, segments: 12, fill: true } },
  { type: 'uvsphere', label: 'UV Sphere', defaults: { size: 1, segments: 12, rings: 8 } },
  { type: 'icosphere', label: 'Ico Sphere', defaults: { size: 1, subdivisions: 1 } },
  { type: 'cylinder', label: 'Cylinder', defaults: { size: 1, segments: 12 } },
  { type: 'cone', label: 'Cone', defaults: { size: 1, segments: 12 } },
  { type: 'torus', label: 'Torus', defaults: { size: 1, segments: 16, rings: 8 } },
  { type: 'vertex', label: 'Single Vertex', defaults: {} },
];

export function createPrimitive(type: PrimitiveType, opts: PrimitiveOptions = {}): Mesh {
  const d = PRIMITIVES.find((p) => p.type === type)!.defaults;
  const o = { ...d, ...opts };
  switch (type) {
    case 'cube': return cube(o.size!);
    case 'plane': return grid(o.size!, 1);
    case 'grid': return grid(o.size!, o.segments!);
    case 'circle': return circle(o.size!, o.segments!, o.fill!);
    case 'uvsphere': return uvSphere(o.size!, o.segments!, o.rings!);
    case 'icosphere': return icoSphere(o.size!, o.subdivisions!);
    case 'cylinder': return cylinder(o.size!, o.size! * 2, o.segments!, o.size!);
    case 'cone': return cylinder(o.size!, o.size! * 2, o.segments!, 0);
    case 'torus': return torus(o.size!, o.size! * 0.25, o.segments!, o.rings!);
    case 'vertex': { const m = new Mesh(); m.addVert([0, 0, 0]); m.changed(); return m; }
  }
}

function cube(size: number): Mesh {
  const m = new Mesh();
  const h = size / 2;
  const p: V3[] = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
  p.forEach((x) => m.addVert(x));
  // faces CCW seen from outside; UVs laid out in a cross-like strip
  const faces: [number[], V2][] = [
    [[4, 5, 6, 7], [0.375, 0.5]],   // +Z front
    [[1, 0, 3, 2], [0.375, 0]],     // -Z back
    [[5, 1, 2, 6], [0.625, 0.5]],   // +X right
    [[0, 4, 7, 3], [0.125, 0.5]],   // -X left
    [[7, 6, 2, 3], [0.375, 0.75]],  // +Y top
    [[0, 1, 5, 4], [0.375, 0.25]],  // -Y bottom
  ];
  for (const [v, o] of faces) {
    const s = 0.25;
    m.addFace(v, [[o[0], o[1]], [o[0] + s, o[1]], [o[0] + s, o[1] + s], [o[0], o[1] + s]]);
  }
  m.changed();
  return m;
}

function grid(size: number, seg: number): Mesh {
  const m = new Mesh();
  const h = size / 2;
  for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) m.addVert([-h + (size * i) / seg, 0, h - (size * j) / seg]);
  const idx = (i: number, j: number) => j * (seg + 1) + i;
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
    m.addFace([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)], [
      [i / seg, j / seg], [(i + 1) / seg, j / seg], [(i + 1) / seg, (j + 1) / seg], [i / seg, (j + 1) / seg],
    ]);
  }
  m.changed();
  return m;
}

function circle(r: number, seg: number, fill: boolean): Mesh {
  const m = new Mesh();
  const loop: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    loop.push(m.addVert([Math.cos(a) * r, 0, -Math.sin(a) * r]));
  }
  if (fill) m.addFace(loop, loop.map((_, i) => { const a = (i / seg) * Math.PI * 2; return [0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5] as V2; }));
  else for (let i = 0; i < seg; i++) m.looseEdges.push([loop[i], loop[(i + 1) % seg]]);
  m.changed();
  return m;
}

function uvSphere(r: number, seg: number, rings: number): Mesh {
  const m = new Mesh();
  const top = m.addVert([0, r, 0]);
  const rows: number[][] = [];
  for (let j = 1; j < rings; j++) {
    const phi = (j / rings) * Math.PI;
    const row: number[] = [];
    for (let i = 0; i < seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      row.push(m.addVert([Math.sin(phi) * Math.cos(th) * r, Math.cos(phi) * r, -Math.sin(phi) * Math.sin(th) * r]));
    }
    rows.push(row);
  }
  const bottom = m.addVert([0, -r, 0]);
  const U = (i: number) => i / seg, Vv = (j: number) => 1 - j / rings;
  for (let i = 0; i < seg; i++) {
    const n = (i + 1) % seg;
    m.addFace([top, rows[0][i], rows[0][n]], [[U(i + 0.5), 1], [U(i), Vv(1)], [U(i + 1), Vv(1)]]);
  }
  for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < seg; i++) {
    const n = (i + 1) % seg;
    m.addFace([rows[j][i], rows[j + 1][i], rows[j + 1][n], rows[j][n]], [[U(i), Vv(j + 1)], [U(i), Vv(j + 2)], [U(i + 1), Vv(j + 2)], [U(i + 1), Vv(j + 1)]]);
  }
  const last = rows[rows.length - 1];
  for (let i = 0; i < seg; i++) {
    const n = (i + 1) % seg;
    m.addFace([bottom, last[n], last[i]], [[U(i + 0.5), 0], [U(i + 1), Vv(rings - 1)], [U(i), Vv(rings - 1)]]);
  }
  m.changed();
  return m;
}

function icoSphere(r: number, subdiv: number): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => normalize(v as V3));
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < Math.min(4, subdiv); s++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let i = cache.get(k);
      if (i === undefined) { i = verts.length; verts.push(normalize([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2, (verts[a][2] + verts[b][2]) / 2])); cache.set(k, i); }
      return i;
    };
    const nf: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nf;
  }
  verts = verts.map((v) => [v[0] * r, v[1] * r, v[2] * r]);
  const m = new Mesh();
  verts.forEach((v) => m.addVert(v));
  for (const f of faces) {
    m.addFace(f, f.map((i) => {
      const v = normalize(verts[i]);
      return [0.5 + Math.atan2(v[2], v[0]) / (2 * Math.PI), 0.5 + Math.asin(Math.max(-1, Math.min(1, v[1]))) / Math.PI] as V2;
    }));
  }
  m.changed();
  return m;
}

function cylinder(r: number, h: number, seg: number, rTop: number): Mesh {
  const m = new Mesh();
  const bot: number[] = [], top: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    bot.push(m.addVert([Math.cos(a) * r, -h / 2, -Math.sin(a) * r]));
  }
  if (rTop > 0) {
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      top.push(m.addVert([Math.cos(a) * rTop, h / 2, -Math.sin(a) * rTop]));
    }
  }
  const apex = rTop > 0 ? -1 : m.addVert([0, h / 2, 0]);
  for (let i = 0; i < seg; i++) {
    const n = (i + 1) % seg;
    const u0 = i / seg, u1 = (i + 1) / seg;
    if (rTop > 0) m.addFace([bot[i], bot[n], top[n], top[i]], [[u0, 0], [u1, 0], [u1, 0.5], [u0, 0.5]]);
    else m.addFace([bot[i], bot[n], apex], [[u0, 0], [u1, 0], [(u0 + u1) / 2, 0.5]]);
  }
  const capUV = (i: number, ox: number): V2 => { const a = (i / seg) * Math.PI * 2; return [ox + 0.25 + Math.cos(a) * 0.24, 0.75 + Math.sin(a) * 0.24]; };
  m.addFace(bot.slice().reverse(), bot.map((_, i) => capUV(seg - 1 - i, 0)));
  if (rTop > 0) m.addFace(top, top.map((_, i) => capUV(i, 0.5)));
  m.changed();
  return m;
}

function torus(R: number, r: number, seg: number, rings: number): Mesh {
  const m = new Mesh();
  const idx = (i: number, j: number) => (i % seg) * rings + (j % rings);
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    for (let j = 0; j < rings; j++) {
      const b = (j / rings) * Math.PI * 2;
      const d = R + Math.cos(b) * r;
      m.addVert([Math.cos(a) * d, Math.sin(b) * r, -Math.sin(a) * d]);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < rings; j++) {
    m.addFace([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)], [
      [i / seg, j / rings], [(i + 1) / seg, j / rings], [(i + 1) / seg, (j + 1) / rings], [i / seg, (j + 1) / rings],
    ]);
  }
  m.changed();
  return m;
}
