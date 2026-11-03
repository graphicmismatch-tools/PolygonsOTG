import { Mesh } from './mesh';
import { V3 } from './vec';
import { triangulateFace } from './ops';
import { trisToQuads } from './topology';

/* ======================================================================
 * Remeshing.
 *
 *  voxel   – signed distance field on a regular grid (narrow-band exact
 *            point–triangle distances, flood-fill inside/outside) and
 *            naive Surface Nets extraction → watertight, all-quad mesh.
 *            Optional Taubin smoothing and projection back onto the
 *            original surface to keep detail.
 *  blocks  – same field, emitted as cubes (Blender's "Blocks" mode).
 *  isotropic – Botsch & Kobbelt 2004: repeat split (> 4/3 L), collapse
 *            (< 4/5 L), valence-driven flips, tangential relaxation and
 *            projection onto the input. Keeps open boundaries.
 * ==================================================================== */

export type RemeshMode = 'voxel' | 'blocks' | 'isotropic';

export interface RemeshOptions {
  mode: RemeshMode;
  /** voxel size (voxel/blocks) or target edge length (isotropic), world units of the mesh */
  size: number;
  /** voxel: smoothing iterations */
  smooth?: number;
  /** voxel: project vertices back onto the input surface */
  project?: boolean;
  /** isotropic: iterations */
  iterations?: number;
  /** isotropic: pair triangles into quads afterwards */
  quads?: boolean;
}

export interface RemeshInfo { size: number; clamped: boolean }

/** Max grid points for voxel modes (memory/time guard). */
export const VOXEL_POINT_LIMIT = 3_000_000;

/* ------------------------------------------------------------------ geometry helpers */

export interface TriSoup { P: Float64Array; T: Int32Array; nv: number; nt: number }

export function triSoup(m: Mesh): TriSoup {
  const tris: number[] = [];
  for (const f of m.faces) for (const [a, b, c] of triangulateFace(m.verts, f.v)) tris.push(f.v[a], f.v[b], f.v[c]);
  const P = new Float64Array(m.verts.length * 3);
  m.verts.forEach((p, i) => { P[i * 3] = p[0]; P[i * 3 + 1] = p[1]; P[i * 3 + 2] = p[2]; });
  return { P, T: Int32Array.from(tris), nv: m.verts.length, nt: tris.length / 3 };
}

/** Closest point on triangle (Ericson, Real-Time Collision Detection 5.1.5). Writes into out, returns squared distance. */
export function closestOnTri(px: number, py: number, pz: number, P: Float64Array, a: number, b: number, c: number, out: Float64Array): number {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
  const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let rx: number, ry: number, rz: number;
  if (d1 <= 0 && d2 <= 0) { rx = ax; ry = ay; rz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { rx = bx; ry = by; rz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); rx = ax + abx * v; ry = ay + aby * v; rz = az + abz * v; }
      else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { rx = cx; ry = cy; rz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); rx = ax + acx * w; ry = ay + acy * w; rz = az + acz * w; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); rx = bx + (cx - bx) * w; ry = by + (cy - by) * w; rz = bz + (cz - bz) * w; }
            else { const den = 1 / (va + vb + vc); const v = vb * den, w = vc * den; rx = ax + abx * v + acx * w; ry = ay + aby * v + acy * w; rz = az + abz * v + acz * w; }
          }
        }
      }
    }
  }
  out[0] = rx; out[1] = ry; out[2] = rz;
  return (px - rx) ** 2 + (py - ry) ** 2 + (pz - rz) ** 2;
}

/** Uniform grid of triangles for nearest-point queries on the original surface. */
export class TriGrid {
  private cells = new Map<number, number[]>();
  private min: V3;
  private cs: number;
  private tmp = new Float64Array(3);
  constructor(private s: TriSoup, cellSize: number) {
    const { P, T, nt } = s;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    for (let i = 0; i < s.nv; i++) { x0 = Math.min(x0, P[i * 3]); y0 = Math.min(y0, P[i * 3 + 1]); z0 = Math.min(z0, P[i * 3 + 2]); }
    this.min = [x0, y0, z0];
    this.cs = Math.max(cellSize, 1e-6);
    for (let t = 0; t < nt; t++) {
      let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
      for (let k = 0; k < 3; k++) { const v = T[t * 3 + k]; lx = Math.min(lx, P[v * 3]); ly = Math.min(ly, P[v * 3 + 1]); lz = Math.min(lz, P[v * 3 + 2]); hx = Math.max(hx, P[v * 3]); hy = Math.max(hy, P[v * 3 + 1]); hz = Math.max(hz, P[v * 3 + 2]); }
      const [i0, j0, k0] = this.cell(lx, ly, lz), [i1, j1, k1] = this.cell(hx, hy, hz);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
        const key = this.key(i, j, k);
        const l = this.cells.get(key);
        if (l) l.push(t); else this.cells.set(key, [t]);
      }
    }
  }
  private cell(x: number, y: number, z: number): [number, number, number] {
    return [Math.floor((x - this.min[0]) / this.cs), Math.floor((y - this.min[1]) / this.cs), Math.floor((z - this.min[2]) / this.cs)];
  }
  private key(i: number, j: number, k: number) { return (i * 73856093) ^ (j * 19349663) ^ (k * 83492791); }
  /** Nearest point on the surface; searches growing shells of cells. */
  nearest(x: number, y: number, z: number, out: Float64Array): number {
    const [ci, cj, ck] = this.cell(x, y, z);
    let best = Infinity;
    const { P, T } = this.s;
    for (let r = 0; r < 64; r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) for (let k = ck - r; k <= ck + r; k++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue;
        const l = this.cells.get(this.key(i, j, k));
        if (!l) continue;
        for (const t of l) {
          const d = closestOnTri(x, y, z, P, T[t * 3], T[t * 3 + 1], T[t * 3 + 2], this.tmp);
          if (d < best) { best = d; out[0] = this.tmp[0]; out[1] = this.tmp[1]; out[2] = this.tmp[2]; }
        }
      }
      // anything in shell r+1 is at least r*cs away
      if (best < Infinity && Math.sqrt(best) <= r * this.cs) break;
    }
    return best;
  }
}

/* ------------------------------------------------------------------ voxel field */

interface Field {
  nx: number; ny: number; nz: number; h: number; ox: number; oy: number; oz: number;
  sdf: Float32Array;
  nearestTri: Int32Array;
  clamped: boolean;
}

function buildField(s: TriSoup, size: number): Field | null {
  const { P, T, nt, nv } = s;
  if (!nt) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < nv; i++) { x0 = Math.min(x0, P[i * 3]); y0 = Math.min(y0, P[i * 3 + 1]); z0 = Math.min(z0, P[i * 3 + 2]); x1 = Math.max(x1, P[i * 3]); y1 = Math.max(y1, P[i * 3 + 1]); z1 = Math.max(z1, P[i * 3 + 2]); }
  let h = Math.max(size, 1e-5);
  const pad = 2;
  let clamped = false;
  const dims = (hh: number) => [Math.ceil((x1 - x0) / hh) + 2 * pad + 1, Math.ceil((y1 - y0) / hh) + 2 * pad + 1, Math.ceil((z1 - z0) / hh) + 2 * pad + 1];
  let [nx, ny, nz] = dims(h);
  while (nx * ny * nz > VOXEL_POINT_LIMIT) { h *= 1.15; [nx, ny, nz] = dims(h); clamped = true; }
  const ox = x0 - pad * h, oy = y0 - pad * h, oz = z0 - pad * h;
  const N = nx * ny * nz;
  const ud = new Float32Array(N).fill(Infinity);
  const near = new Int32Array(N).fill(-1);
  const tmp = new Float64Array(3);
  const band = 1.5 * h;
  // narrow band: exact distances for grid points near each triangle
  for (let t = 0; t < nt; t++) {
    const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
    const lx = Math.min(P[a * 3], P[b * 3], P[c * 3]) - band, hx = Math.max(P[a * 3], P[b * 3], P[c * 3]) + band;
    const ly = Math.min(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1]) - band, hy = Math.max(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1]) + band;
    const lz = Math.min(P[a * 3 + 2], P[b * 3 + 2], P[c * 3 + 2]) - band, hz = Math.max(P[a * 3 + 2], P[b * 3 + 2], P[c * 3 + 2]) + band;
    const i0 = Math.max(0, Math.ceil((lx - ox) / h)), i1 = Math.min(nx - 1, Math.floor((hx - ox) / h));
    const j0 = Math.max(0, Math.ceil((ly - oy) / h)), j1 = Math.min(ny - 1, Math.floor((hy - oy) / h));
    const k0 = Math.max(0, Math.ceil((lz - oz) / h)), k1 = Math.min(nz - 1, Math.floor((hz - oz) / h));
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const idx = i + nx * (j + ny * k);
      const d = Math.sqrt(closestOnTri(ox + i * h, oy + j * h, oz + k * h, P, a, b, c, tmp));
      if (d < ud[idx]) { ud[idx] = d; near[idx] = t; }
    }
  }
  // inside/outside: flood fill from the grid border through points away from the surface
  const wall = 0.6 * h; // > h/2 so a 6-connected path can never slip through a surface
  const outside = new Uint8Array(N);
  const stack: number[] = [];
  const pushIf = (i: number, j: number, k: number) => {
    const idx = i + nx * (j + ny * k);
    if (!outside[idx] && !(ud[idx] < wall)) { outside[idx] = 1; stack.push(idx); }
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) pushIf(i, j, k);
  }
  while (stack.length) {
    const idx = stack.pop()!;
    const i = idx % nx, j = Math.floor(idx / nx) % ny, k = Math.floor(idx / (nx * ny));
    if (i > 0) pushIf(i - 1, j, k); if (i < nx - 1) pushIf(i + 1, j, k);
    if (j > 0) pushIf(i, j - 1, k); if (j < ny - 1) pushIf(i, j + 1, k);
    if (k > 0) pushIf(i, j, k - 1); if (k < nz - 1) pushIf(i, j, k + 1);
  }
  // any interior points at all? (open / flat meshes have none)
  let anyInside = false;
  for (let idx = 0; idx < N && !anyInside; idx++) if (!outside[idx] && !(ud[idx] < wall)) anyInside = true;
  const sdf = new Float32Array(N);
  const far = 2 * h;
  for (let idx = 0; idx < N; idx++) {
    const d = Math.min(ud[idx], far);
    if (!anyInside) { sdf[idx] = d - 0.5 * h; continue; } // thicken open surfaces into a thin shell
    if (outside[idx]) { sdf[idx] = d; continue; }
    if (!(ud[idx] < wall)) { sdf[idx] = -d; continue; } // enclosed, away from surface
    // near the surface: side from the nearest triangle's normal
    const t = near[idx];
    const i = idx % nx, j = Math.floor(idx / nx) % ny, k = Math.floor(idx / (nx * ny));
    const px = ox + i * h, py = oy + j * h, pz = oz + k * h;
    const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
    const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
    const e2x = P[c * 3] - P[a * 3], e2y = P[c * 3 + 1] - P[a * 3 + 1], e2z = P[c * 3 + 2] - P[a * 3 + 2];
    const nxv = e1y * e2z - e1z * e2y, nyv = e1z * e2x - e1x * e2z, nzv = e1x * e2y - e1y * e2x;
    closestOnTri(px, py, pz, P, a, b, c, tmp);
    const side = (px - tmp[0]) * nxv + (py - tmp[1]) * nyv + (pz - tmp[2]) * nzv;
    sdf[idx] = side >= 0 ? d : -d;
  }
  return { nx, ny, nz, h, ox, oy, oz, sdf, nearestTri: near, clamped };
}

/* ------------------------------------------------------------------ voxel: surface nets */

function surfaceNets(F: Field): Mesh {
  const { nx, ny, nz, h, ox, oy, oz, sdf } = F;
  const m = new Mesh();
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const pid = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const val = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let neg = 0;
    for (let c = 0; c < 8; c++) { const [a, b, d] = corner[c]; val[c] = sdf[pid(i + a, j + b, k + d)]; if (val[c] < 0) neg++; }
    if (neg === 0 || neg === 8) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [e0, e1] of edges) {
      const v0 = val[e0], v1 = val[e1];
      if ((v0 < 0) === (v1 < 0)) continue;
      const t = v0 / (v0 - v1);
      const c0 = corner[e0], c1 = corner[e1];
      sx += c0[0] + (c1[0] - c0[0]) * t; sy += c0[1] + (c1[1] - c0[1]) * t; sz += c0[2] + (c1[2] - c0[2]) * t;
      n++;
    }
    cellVert[cid(i, j, k)] = m.addVert([ox + (i + sx / n) * h, oy + (j + sy / n) * h, oz + (k + sz / n) * h]);
  }
  // a quad for every grid edge with a sign change, joining the 4 cells around it
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    m.addFace(flip ? [a, d, c, b] : [a, b, c, d]);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const s0 = sdf[pid(i, j, k)] < 0, s1 = sdf[pid(i + 1, j, k)] < 0;
    if (s0 === s1) continue;
    quad(cellVert[cid(i, j - 1, k - 1)], cellVert[cid(i, j, k - 1)], cellVert[cid(i, j, k)], cellVert[cid(i, j - 1, k)], !s0);
  }
  for (let k = 1; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const s0 = sdf[pid(i, j, k)] < 0, s1 = sdf[pid(i, j + 1, k)] < 0;
    if (s0 === s1) continue;
    quad(cellVert[cid(i - 1, j, k - 1)], cellVert[cid(i - 1, j, k)], cellVert[cid(i, j, k)], cellVert[cid(i, j, k - 1)], !s0);
  }
  for (let k = 0; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const s0 = sdf[pid(i, j, k)] < 0, s1 = sdf[pid(i, j, k + 1)] < 0;
    if (s0 === s1) continue;
    quad(cellVert[cid(i - 1, j - 1, k)], cellVert[cid(i, j - 1, k)], cellVert[cid(i, j, k)], cellVert[cid(i - 1, j, k)], !s0);
  }
  m.changed();
  return m;
}

/* ------------------------------------------------------------------ voxel: blocks */

function blocks(F: Field): Mesh {
  const { nx, ny, nz, h, ox, oy, oz, sdf } = F;
  const m = new Mesh();
  const pid = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  // cell occupancy from the trilinear centre value
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const occ = new Uint8Array(cx * cy * cz);
  const cid = (i: number, j: number, k: number) => i + cx * (j + cy * k);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    let s = 0;
    for (let c = 0; c < 8; c++) s += sdf[pid(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
    if (s < 0) occ[cid(i, j, k)] = 1;
  }
  const vmap = new Map<number, number>();
  const V = (i: number, j: number, k: number) => {
    const key = pid(i, j, k);
    let v = vmap.get(key);
    if (v === undefined) { v = m.addVert([ox + i * h, oy + j * h, oz + k * h]); vmap.set(key, v); }
    return v;
  };
  const filled = (i: number, j: number, k: number) => i >= 0 && j >= 0 && k >= 0 && i < cx && j < cy && k < cz && occ[cid(i, j, k)] === 1;
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    if (!occ[cid(i, j, k)]) continue;
    if (!filled(i - 1, j, k)) m.addFace([V(i, j, k), V(i, j, k + 1), V(i, j + 1, k + 1), V(i, j + 1, k)]);
    if (!filled(i + 1, j, k)) m.addFace([V(i + 1, j, k), V(i + 1, j + 1, k), V(i + 1, j + 1, k + 1), V(i + 1, j, k + 1)]);
    if (!filled(i, j - 1, k)) m.addFace([V(i, j, k), V(i + 1, j, k), V(i + 1, j, k + 1), V(i, j, k + 1)]);
    if (!filled(i, j + 1, k)) m.addFace([V(i, j + 1, k), V(i, j + 1, k + 1), V(i + 1, j + 1, k + 1), V(i + 1, j + 1, k)]);
    if (!filled(i, j, k - 1)) m.addFace([V(i, j, k), V(i, j + 1, k), V(i + 1, j + 1, k), V(i + 1, j, k)]);
    if (!filled(i, j, k + 1)) m.addFace([V(i, j, k + 1), V(i + 1, j, k + 1), V(i + 1, j + 1, k + 1), V(i, j + 1, k + 1)]);
  }
  m.changed();
  return m;
}

/** Taubin λ|μ smoothing: shrink-free Laplacian. */
function taubin(m: Mesh, iterations: number) {
  const nb = m.verts.map((_, i) => m.vertNeighbors(i));
  const step = (f: number) => {
    const next = m.verts.map((p, i) => {
      const n = nb[i];
      if (!n.length) return p;
      let x = 0, y = 0, z = 0;
      for (const j of n) { x += m.verts[j][0]; y += m.verts[j][1]; z += m.verts[j][2]; }
      x /= n.length; y /= n.length; z /= n.length;
      return [p[0] + (x - p[0]) * f, p[1] + (y - p[1]) * f, p[2] + (z - p[2]) * f] as V3;
    });
    m.verts = next;
  };
  for (let i = 0; i < iterations; i++) { step(0.5); step(-0.53); }
  m.touch();
}

function projectOnto(m: Mesh, grid: TriGrid, weight = 1) {
  const out = new Float64Array(3);
  m.verts = m.verts.map((p) => {
    grid.nearest(p[0], p[1], p[2], out);
    return [p[0] + (out[0] - p[0]) * weight, p[1] + (out[1] - p[1]) * weight, p[2] + (out[2] - p[2]) * weight] as V3;
  });
  m.touch();
}

/* ------------------------------------------------------------------ isotropic */

function isotropic(src: Mesh, L: number, iterations: number): Mesh {
  const soup = triSoup(src);
  const grid = new TriGrid(soup, L * 2);
  const V: V3[] = src.verts.map((p) => [p[0], p[1], p[2]]);
  let F: number[][] = [];
  for (let t = 0; t < soup.nt; t++) F.push([soup.T[t * 3], soup.T[t * 3 + 1], soup.T[t * 3 + 2]]);
  const hi = (4 / 3) * L, lo = (4 / 5) * L;
  const d2 = (a: number, b: number) => (V[a][0] - V[b][0]) ** 2 + (V[a][1] - V[b][1]) ** 2 + (V[a][2] - V[b][2]) ** 2;
  const key = (a: number, b: number) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  const triN = (f: number[]): V3 => {
    const [a, b, c] = f;
    const ux = V[b][0] - V[a][0], uy = V[b][1] - V[a][1], uz = V[b][2] - V[a][2];
    const vx = V[c][0] - V[a][0], vy = V[c][1] - V[a][1], vz = V[c][2] - V[a][2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  const edgeFaces = () => {
    const map = new Map<number, number[]>();
    F.forEach((f, fi) => { for (let i = 0; i < 3; i++) { const k = key(f[i], f[(i + 1) % 3]); const l = map.get(k); if (l) l.push(fi); else map.set(k, [fi]); } });
    return map;
  };
  const vertFaces = () => {
    const vf: number[][] = V.map(() => []);
    F.forEach((f, fi) => { for (const v of f) vf[v].push(fi); });
    return vf;
  };
  const boundaryVerts = (ef: Map<number, number[]>) => {
    const b = new Uint8Array(V.length);
    for (const [k, l] of ef) if (l.length !== 2) { b[Math.floor(k / 4194304)] = 1; b[k % 4194304] = 1; }
    return b;
  };

  const split = () => {
    for (let pass = 0; pass < 6; pass++) {
      const ef = edgeFaces();
      let n = 0;
      const lockF = new Uint8Array(F.length);
      const longE: [number, number, number][] = [];
      for (const [k, l] of ef) { const a = Math.floor(k / 4194304), b = k % 4194304; const L2 = d2(a, b); if (L2 > hi * hi) longE.push([a, b, L2]); void l; }
      longE.sort((x, y) => y[2] - x[2]);
      for (const [a, b] of longE) {
        const fl = ef.get(key(a, b))!;
        if (fl.some((f) => lockF[f])) continue;
        const m = V.length;
        V.push([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2, (V[a][2] + V[b][2]) / 2]);
        for (const fi of fl) {
          const f = F[fi];
          const i = f.findIndex((v, ii) => (v === a && f[(ii + 1) % 3] === b) || (v === b && f[(ii + 1) % 3] === a));
          const x = f[i], y = f[(i + 1) % 3], c = f[(i + 2) % 3];
          F[fi] = [x, m, c];
          F.push([m, y, c]);
          lockF[fi] = 1;
        }
        n++;
      }
      if (!n) break;
    }
  };

  const collapse = () => {
    const ef = edgeFaces();
    const vf = vertFaces();
    const bnd = boundaryVerts(ef);
    const nbrs = (v: number) => { const s = new Set<number>(); for (const f of vf[v]) if (F[f]) for (const u of F[f]) if (u !== v) s.add(u); return s; };
    const lock = new Uint8Array(V.length);
    const dead = new Uint8Array(F.length);
    const shortE: [number, number, number][] = [];
    for (const k of ef.keys()) { const a = Math.floor(k / 4194304), b = k % 4194304; const L2 = d2(a, b); if (L2 < lo * lo) shortE.push([a, b, L2]); }
    shortE.sort((x, y) => x[2] - y[2]);
    for (const [a, b] of shortE) {
      if (lock[a] || lock[b] || bnd[a] || bnd[b]) continue;
      const na = nbrs(a), nb = nbrs(b);
      let common = 0;
      for (const x of na) if (nb.has(x)) common++;
      if (common !== 2) continue; // link condition
      const mpos: V3 = [(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2, (V[a][2] + V[b][2]) / 2];
      let ok = true;
      for (const x of [...na, ...nb]) { if (x === a || x === b) continue; const dd = (mpos[0] - V[x][0]) ** 2 + (mpos[1] - V[x][1]) ** 2 + (mpos[2] - V[x][2]) ** 2; if (dd > hi * hi) { ok = false; break; } }
      if (!ok) continue;
      // normal flip guard
      const oldA = V[a], oldB = V[b];
      const affected = [...vf[a], ...vf[b]].filter((f) => !dead[f] && !(F[f].includes(a) && F[f].includes(b)));
      const before = affected.map((f) => triN(F[f]));
      V[a] = mpos; V[b] = mpos;
      for (let i = 0; i < affected.length && ok; i++) {
        const n0 = before[i], n1 = triN(F[affected[i]]);
        const l0 = Math.hypot(...n0), l1 = Math.hypot(...n1);
        if (l1 < 1e-14 || (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1 + 1e-30) < 0.2) ok = false;
      }
      if (!ok) { V[a] = oldA; V[b] = oldB; continue; }
      for (const f of vf[b]) {
        if (dead[f]) continue;
        if (F[f].includes(a)) { dead[f] = 1; continue; }
        F[f] = F[f].map((v) => (v === b ? a : v));
        vf[a].push(f);
      }
      vf[b] = [];
      lock[a] = 1; lock[b] = 1;
      for (const x of na) lock[x] = 1;
      for (const x of nb) lock[x] = 1;
    }
    F = F.filter((_, i) => !dead[i]);
  };

  const flip = () => {
    const ef = edgeFaces();
    const bnd = boundaryVerts(ef);
    const val = new Int32Array(V.length);
    for (const k of ef.keys()) { val[Math.floor(k / 4194304)]++; val[k % 4194304]++; }
    const target = (v: number) => (bnd[v] ? 4 : 6);
    const lock = new Uint8Array(V.length);
    for (const [k, l] of ef) {
      if (l.length !== 2) continue;
      const a = Math.floor(k / 4194304), b = k % 4194304;
      if (lock[a] || lock[b]) continue;
      const f1 = F[l[0]], f2 = F[l[1]];
      const c = f1.find((v) => v !== a && v !== b)!, d = f2.find((v) => v !== a && v !== b)!;
      if (lock[c] || lock[d] || c === d || ef.has(key(c, d))) continue;
      const dev = (x: number, dv: number) => Math.abs(val[x] + dv - target(x));
      const before = dev(a, 0) + dev(b, 0) + dev(c, 0) + dev(d, 0);
      const after = dev(a, -1) + dev(b, -1) + dev(c, 1) + dev(d, 1);
      if (after >= before) continue;
      // orient: f1 must contain a->b
      let A = a, B = b;
      const i1 = f1.indexOf(A);
      if (f1[(i1 + 1) % 3] !== B) { A = b; B = a; }
      const C = f1.find((v) => v !== A && v !== B)!, D = f2.find((v) => v !== A && v !== B)!;
      const n1 = [A, D, C], n2 = [D, B, C];
      const o1 = triN(f1), o2 = triN(f2), m1 = triN(n1), m2 = triN(n2);
      const avg: V3 = [o1[0] + o2[0], o1[1] + o2[1], o1[2] + o2[2]];
      const dot = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
      if (dot(m1, avg) <= 0 || dot(m2, avg) <= 0) continue;
      const la = Math.hypot(...avg), l1 = Math.hypot(...m1), l2 = Math.hypot(...m2);
      if (dot(m1, avg) / (la * l1) < 0.7 || dot(m2, avg) / (la * l2) < 0.7) continue; // don't fold sharp creases
      F[l[0]] = n1; F[l[1]] = n2;
      val[A]--; val[B]--; val[C]++; val[D]++;
      lock[A] = lock[B] = lock[C] = lock[D] = 1;
    }
  };

  const relax = () => {
    const ef = edgeFaces();
    const bnd = boundaryVerts(ef);
    const nb: number[][] = V.map(() => []);
    for (const k of ef.keys()) { const a = Math.floor(k / 4194304), b = k % 4194304; nb[a].push(b); nb[b].push(a); }
    const vn: V3[] = V.map(() => [0, 0, 0]);
    for (const f of F) { const n = triN(f); for (const v of f) { vn[v][0] += n[0]; vn[v][1] += n[1]; vn[v][2] += n[2]; } }
    const next = V.map((p, i) => {
      if (bnd[i] || !nb[i].length) return p;
      let x = 0, y = 0, z = 0;
      for (const j of nb[i]) { x += V[j][0]; y += V[j][1]; z += V[j][2]; }
      x = x / nb[i].length - p[0]; y = y / nb[i].length - p[1]; z = z / nb[i].length - p[2];
      const l = Math.hypot(...vn[i]) || 1;
      const n = [vn[i][0] / l, vn[i][1] / l, vn[i][2] / l];
      const d = x * n[0] + y * n[1] + z * n[2];
      return [p[0] + (x - d * n[0]) * 0.5, p[1] + (y - d * n[1]) * 0.5, p[2] + (z - d * n[2]) * 0.5] as V3;
    });
    for (let i = 0; i < V.length; i++) V[i] = next[i];
  };

  const project = () => {
    const out = new Float64Array(3);
    const used = new Uint8Array(V.length);
    for (const f of F) for (const v of f) used[v] = 1;
    for (let i = 0; i < V.length; i++) if (used[i]) { grid.nearest(V[i][0], V[i][1], V[i][2], out); V[i] = [out[0], out[1], out[2]]; }
  };

  for (let it = 0; it < iterations; it++) { split(); collapse(); flip(); relax(); project(); }

  const m = new Mesh();
  m.verts = V;
  for (const f of F) m.addFace(f);
  m.changed();
  m.cleanup();
  return m;
}

/* ------------------------------------------------------------------ entry */

export function remesh(src: Mesh, opts: RemeshOptions, info?: RemeshInfo): Mesh {
  if (!src.faces.length) return src;
  if (opts.mode === 'isotropic') {
    const m = isotropic(src, Math.max(opts.size, 1e-4), Math.max(1, Math.round(opts.iterations ?? 4)));
    if (opts.quads) { trisToQuads(m, 25); m.cleanup(); }
    if (info) { info.size = opts.size; info.clamped = false; }
    return m;
  }
  const soup = triSoup(src);
  const field = buildField(soup, opts.size);
  if (!field) return src;
  if (info) { info.size = field.h; info.clamped = field.clamped; }
  let m = opts.mode === 'blocks' ? blocks(field) : surfaceNets(field);
  m.cleanup();
  if (opts.mode === 'voxel') {
    const s = Math.max(0, Math.round(opts.smooth ?? 1));
    if (s) taubin(m, s);
    if (opts.project) projectOnto(m, new TriGrid(soup, field.h * 2), 0.85);
  }
  return m;
}

/** Sensible default size for a mesh: a fraction of its bounding-box diagonal. */
export function defaultRemeshSize(m: Mesh, fraction = 1 / 40): number {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const p of m.verts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); z0 = Math.min(z0, p[2]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); z1 = Math.max(z1, p[2]); }
  const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  return isFinite(d) && d > 0 ? Math.round(d * fraction * 1e4) / 1e4 : 0.05;
}
