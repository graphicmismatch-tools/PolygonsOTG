// Small, allocation-friendly vector helpers working on plain tuples.
export type V2 = [number, number];
export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const lerp = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const lerp2 = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const normalize = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const avg3 = (pts: V3[]): V3 => {
  const r: V3 = [0, 0, 0];
  for (const p of pts) { r[0] += p[0]; r[1] += p[1]; r[2] += p[2]; }
  const n = Math.max(1, pts.length);
  return [r[0] / n, r[1] / n, r[2] / n];
};
export const avg2 = (pts: V2[]): V2 => {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  const n = Math.max(1, pts.length);
  return [x / n, y / n];
};

/** Newell's method: robust normal for (possibly non-planar) polygons. Not normalized. */
export function polyNormalRaw(pts: V3[]): V3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}
export const polyNormal = (pts: V3[]): V3 => normalize(polyNormalRaw(pts));
export const polyArea = (pts: V3[]): number => len(polyNormalRaw(pts)) / 2;

/** Build an orthonormal tangent basis (u, v) perpendicular to n. */
export function basisFromNormal(n: V3): [V3, V3] {
  const ref: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(ref, n));
  const v = cross(n, u);
  return [u, v];
}

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
