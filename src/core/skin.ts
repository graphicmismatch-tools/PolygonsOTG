import * as THREE from 'three';
import { Mesh, VW } from './mesh';
import { Armature, evalArmature, flipName } from './armature';
import { V3 } from './vec';

/** Max joint influences per vertex in the exported skin (glTF's JOINTS_0 / WEIGHTS_0). */
export const MAX_INFLUENCES = 4;

/**
 * Linear blend skinning. `skin` maps a group name to its matrix in the mesh's
 * local space. Weights are normalised per vertex; unweighted vertices stay put.
 */
export function deformMesh(m: Mesh, skin: Map<string, THREE.Matrix4>): Mesh {
  if (!m.groups.length) return m;
  const mats = m.groups.map((g) => skin.get(g)?.elements ?? null);
  const out = m.clone();
  for (let i = 0; i < m.verts.length; i++) {
    const l = m.vw[i];
    if (!l || !l.length) continue;
    let tw = 0;
    let x = 0, y = 0, z = 0;
    const p = m.verts[i];
    for (const [g, w] of l) {
      const e = mats[g];
      if (!e || w <= 0) continue;
      x += w * (e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12]);
      y += w * (e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13]);
      z += w * (e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]);
      tw += w;
    }
    if (tw > 1e-6) out.verts[i] = [x / tw, y / tw, z / tw];
  }
  out.touch();
  return out;
}

/** Skin matrices in mesh space: meshToArm⁻¹ · (posed · rest⁻¹) · meshToArm, keyed by bone name. */
export function meshSpaceSkin(armMesh: Mesh, arm: Armature, meshToArm: THREE.Matrix4): Map<string, THREE.Matrix4> {
  const ev = evalArmature(armMesh, arm);
  const inv = meshToArm.clone().invert();
  const res = new Map<string, THREE.Matrix4>();
  arm.bones.forEach((b, i) => { if (b.deform) res.set(b.name, inv.clone().multiply(ev.skin[i]).multiply(meshToArm)); });
  return res;
}

/** Largest influences first, at most `max`, normalised to sum 1. */
export function topInfluences(l: VW, max = MAX_INFLUENCES): VW {
  const s = l.filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, max);
  const t = s.reduce((a, [, w]) => a + w, 0);
  return t > 0 ? s.map(([g, w]) => [g, w / t]) : [];
}

function segDist2(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = b.clone().sub(a);
  const l2 = ab.lengthSq();
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / l2)) : 0;
  return p.distanceToSquared(a.clone().addScaledVector(ab, t));
}

/**
 * Automatic weights from distance to the deform bones (inverse-distance
 * falloff, then a few rounds of smoothing over mesh edges so joints bend
 * softly). Replaces all existing weights of the deform bones.
 */
export function autoWeights(m: Mesh, armMesh: Mesh, arm: Armature, meshToArm: THREE.Matrix4, smoothIters = 4) {
  const bones = arm.bones.map((b, i) => ({ b, i })).filter(({ b }) => b.deform);
  if (!bones.length || !m.verts.length) return;
  const segs = bones.map(({ b }) => [new THREE.Vector3(...armMesh.verts[b.head]), new THREE.Vector3(...armMesh.verts[b.tail])]);
  // falloff scale: relative to the mesh's size so the result doesn't depend on units
  const box = new THREE.Box3();
  for (const p of m.verts) box.expandByPoint(new THREE.Vector3(...p).applyMatrix4(meshToArm));
  const eps = Math.max(1e-6, (box.getSize(new THREE.Vector3()).length() * 0.01) ** 2);
  const nb = bones.length, nv = m.verts.length;
  const W = new Float32Array(nv * nb);
  const p = new THREE.Vector3();
  for (let v = 0; v < nv; v++) {
    p.set(...m.verts[v]).applyMatrix4(meshToArm);
    let dmin = Infinity;
    const d2 = new Float64Array(nb);
    for (let k = 0; k < nb; k++) { d2[k] = segDist2(p, segs[k][0], segs[k][1]); dmin = Math.min(dmin, d2[k]); }
    // only bones about as close as the nearest one compete (avoids far bones leaking in)
    let tot = 0;
    for (let k = 0; k < nb; k++) {
      if (d2[k] > dmin * 2.25 + eps) continue;
      const w = 1 / (d2[k] + eps) ** 2;
      W[v * nb + k] = w; tot += w;
    }
    if (tot > 0) for (let k = 0; k < nb; k++) W[v * nb + k] /= tot;
  }
  // smooth across the surface
  const nbrs = m.verts.map((_, i) => m.vertNeighbors(i));
  for (let it = 0; it < smoothIters; it++) {
    const next = new Float32Array(W);
    for (let v = 0; v < nv; v++) {
      const n = nbrs[v];
      if (!n.length) continue;
      for (let k = 0; k < nb; k++) {
        let s = 0;
        for (const u of n) s += W[u * nb + k];
        next[v * nb + k] = W[v * nb + k] * 0.5 + (s / n.length) * 0.5;
      }
    }
    W.set(next);
  }
  // write groups
  const gi = bones.map(({ b }) => m.groupIndex(b.name, true));
  const gset = new Set(gi);
  for (let v = 0; v < nv; v++) {
    const keep = (m.vw[v] ?? []).filter(([g]) => !gset.has(g));
    const l: VW = [];
    for (let k = 0; k < nb; k++) if (W[v * nb + k] > 0.01) l.push([gi[k], W[v * nb + k]]);
    m.vw[v] = [...keep, ...topInfluences(l)];
  }
  m.weightsChanged();
}

/**
 * Copy weights onto a rebuilt mesh (remesh, decimate…) by inverse-distance
 * blending of the nearest source vertices.
 */
export function transferWeights(src: Mesh, dst: Mesh) {
  if (!src.groups.length || src === dst) return;
  dst.groups = src.groups.slice();
  dst.vw = [];
  if (!src.verts.length) return;
  const box = new THREE.Box3();
  for (const p of src.verts) box.expandByPoint(new THREE.Vector3(...p));
  const size = box.getSize(new THREE.Vector3());
  const cell = Math.max(1e-5, Math.cbrt((size.x * size.y * size.z || size.lengthSq() || 1) / Math.max(1, src.verts.length)) * 2);
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  src.verts.forEach((p, i) => { const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); });
  for (let v = 0; v < dst.verts.length; v++) {
    const p = dst.verts[v];
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    let near: [number, number][] = [];
    for (let r = 1; r <= 64 && near.length < 3; r *= 2) {
      near = [];
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        const l = grid.get(key(cx + dx, cy + dy, cz + dz));
        if (l) for (const i of l) { const q = src.verts[i]; near.push([i, (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2]); }
      }
      if (r === 1 && near.length >= 3) break;
    }
    near.sort((a, b) => a[1] - b[1]);
    const pick = near.slice(0, 3);
    if (!pick.length) { dst.vw[v] = []; continue; }
    if (pick[0][1] < 1e-12) { dst.vw[v] = src.weightsOf(pick[0][0]).map(([g, w]) => [g, w]); continue; }
    const f = pick.map(([i, d]) => [i, 1 / d] as [number, number]);
    const t = f.reduce((a, [, w]) => a + w, 0);
    dst.vw[v] = src.blendWeights(f.map(([i, w]) => [i, w / t]));
  }
  dst.weightsChanged();
}

/** Mirror weights across X onto partner vertices, flipping .L / .R group names. */
export function mirrorWeightsX(m: Mesh, mirror: Int32Array, onlyFrom?: (v: number) => boolean) {
  for (let v = 0; v < m.verts.length; v++) {
    const p = mirror[v];
    if (p < 0 || p === v || m.verts[v][0] < 0) continue;
    if (onlyFrom && !onlyFrom(v)) continue;
    m.vw[p] = m.weightsOf(v).map(([g, w]) => [m.groupIndex(flipName(m.groups[g]), true), w]);
  }
  m.weightsChanged();
}

/** Turbo colour map style ramp: blue (0) → green → yellow → red (1). */
export function weightColor(w: number): V3 {
  const t = Math.max(0, Math.min(1, w));
  const stops: [number, V3][] = [[0, [0.05, 0.1, 0.55]], [0.25, [0.05, 0.55, 0.85]], [0.5, [0.2, 0.85, 0.3]], [0.75, [0.95, 0.85, 0.1]], [1, [0.95, 0.15, 0.1]]];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, a] = stops[i - 1], [t1, b] = stops[i];
      const f = (t - t0) / (t1 - t0);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}
