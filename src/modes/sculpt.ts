import * as THREE from 'three';
import { SceneObject } from '../core/scene';
import { V3 } from '../core/vec';
import { Viewport } from '../render/viewport';
import { PInfo, ToolHandler } from '../input';

export type BrushType = 'draw' | 'clay' | 'inflate' | 'smooth' | 'flatten' | 'pinch' | 'grab' | 'crease';

export interface BrushSettings {
  type: BrushType;
  /** radius in screen pixels */
  radius: number;
  strength: number;
  invert: boolean;
  pressureStrength: boolean;
  pressureRadius: boolean;
  symmetryX: boolean;
  falloff: 'smooth' | 'sphere' | 'sharp' | 'linear';
}

export const BRUSHES: { type: BrushType; label: string; hint: string }[] = [
  { type: 'draw', label: 'Draw', hint: 'Push surface out along the stroke normal' },
  { type: 'clay', label: 'Clay', hint: 'Build up and flatten at the same time' },
  { type: 'inflate', label: 'Inflate', hint: 'Grow along each vertex normal' },
  { type: 'smooth', label: 'Smooth', hint: 'Relax vertices toward neighbours' },
  { type: 'flatten', label: 'Flatten', hint: 'Pull vertices onto a plane' },
  { type: 'pinch', label: 'Pinch', hint: 'Pull vertices toward the brush centre' },
  { type: 'crease', label: 'Crease', hint: 'Pinch + push in for sharp creases' },
  { type: 'grab', label: 'Grab', hint: 'Drag a region of vertices around' },
];

export const defaultBrush = (): BrushSettings => ({
  type: 'draw', radius: 60, strength: 0.5, invert: false, pressureStrength: true, pressureRadius: false, symmetryX: true, falloff: 'smooth',
});

function falloff(kind: BrushSettings['falloff'], t: number) {
  // t = dist / radius in [0,1]
  if (t >= 1) return 0;
  switch (kind) {
    case 'sphere': return Math.sqrt(1 - t * t);
    case 'sharp': return (1 - t) * (1 - t);
    case 'linear': return 1 - t;
    default: return 3 * (1 - t) * (1 - t) - 2 * (1 - t) * (1 - t) * (1 - t);
  }
}

/**
 * A sculpt stroke over the base mesh vertices of an object.
 * Works in object local space; radius is converted from screen px.
 */
export class SculptStroke implements ToolHandler {
  private mesh;
  private neighbors: number[][] = [];
  private vertFaces: number[][] = [];
  private inv: THREE.Matrix4;
  private W: THREE.Matrix4;
  private lastX = 0;
  private lastY = 0;
  private started = false;
  private grabSet: { v: number; w: number; o: V3 }[] = [];
  private grabMirror: { v: number; w: number; o: V3 }[] = [];
  private grabStartLocal = new THREE.Vector3();
  private grabDepth = 0;
  private grabStartScreen = { x: 0, y: 0 };
  private localRadius = 0;
  private scaleAvg = 1;
  changed = false;

  constructor(
    private obj: SceneObject,
    private vp: Viewport,
    private brush: BrushSettings,
    private onUpdate: () => void,
    private onEnd: (changed: boolean) => void,
    private onCancel: () => void,
    private invertHeld: () => boolean,
  ) {
    this.mesh = obj.mesh;
    const m = this.mesh;
    this.neighbors = m.verts.map((_, i) => m.vertNeighbors(i));
    this.vertFaces = m.verts.map((_, i) => m.vertFaces(i));
    this.W = vp.objectMatrix(obj);
    this.inv = this.W.clone().invert();
    const s = new THREE.Vector3(); this.W.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    this.scaleAvg = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
  }

  /** Begin at screen pos; returns false if the stroke does not hit the mesh. */
  begin(x: number, y: number, p: PInfo): boolean {
    const hit = this.vp.pickDisplay(this.obj, x, y);
    this.lastX = x; this.lastY = y;
    if (!hit) return false;
    this.started = true;
    if (this.brush.type === 'grab') {
      this.grabStartLocal.copy(hit.local);
      this.grabDepth = this.vp.project(hit.point).z;
      this.grabStartScreen = { x, y };
      const r = this.radiusLocal(hit.point, p);
      this.grabSet = this.collect(hit.local, r);
      if (this.brush.symmetryX) this.grabMirror = this.collect(new THREE.Vector3(-hit.local.x, hit.local.y, hit.local.z), r).filter((g) => !this.grabSet.some((s) => s.v === g.v));
    } else this.dab(x, y, p);
    return true;
  }

  private radiusLocal(world: THREE.Vector3, p: PInfo) {
    let rpx = this.brush.radius;
    if (this.brush.pressureRadius && p.type === 'pen') rpx *= 0.25 + 0.75 * p.pressure;
    // world size of rpx at the hit depth
    const cam = this.vp.cam;
    let wpp: number;
    if (cam.ortho) wpp = cam.worldPerPixel(this.vp.height);
    else {
      const d = cam.camera.position.distanceTo(world);
      wpp = (2 * d * Math.tan((cam.fov * Math.PI) / 360)) / this.vp.height;
    }
    this.localRadius = (rpx * wpp) / this.scaleAvg;
    return this.localRadius;
  }

  private collect(c: THREE.Vector3, r: number) {
    const res: { v: number; w: number; o: V3 }[] = [];
    const V = this.mesh.verts;
    const r2 = r * r;
    for (let i = 0; i < V.length; i++) {
      const p = V[i];
      const dx = p[0] - c.x, dy = p[1] - c.y, dz = p[2] - c.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r2) res.push({ v: i, w: falloff(this.brush.falloff, Math.sqrt(d2) / r), o: [p[0], p[1], p[2]] });
    }
    return res;
  }

  move(x: number, y: number, p: PInfo) {
    if (!this.started) {
      if (this.begin(x, y, p)) this.onUpdate();
      return;
    }
    if (this.brush.type === 'grab') { this.grab(x, y); return; }
    // spacing: dab every ~15% of radius
    const step = Math.max(2, this.brush.radius * 0.15);
    const dist = Math.hypot(x - this.lastX, y - this.lastY);
    if (dist < step) return;
    const n = Math.floor(dist / step);
    const sx = this.lastX, sy = this.lastY;
    for (let i = 1; i <= n; i++) {
      const t = (i * step) / dist;
      this.dab(sx + (x - sx) * t, sy + (y - sy) * t, p);
    }
    this.lastX = sx + (x - sx) * ((n * step) / dist);
    this.lastY = sy + (y - sy) * ((n * step) / dist);
    this.onUpdate();
  }

  private grab(x: number, y: number) {
    const cam = this.vp.cam.camera;
    const toWorld = (sx: number, sy: number) => new THREE.Vector3((sx / this.vp.width) * 2 - 1, -(sy / this.vp.height) * 2 + 1, this.grabDepth).unproject(cam);
    const dW = toWorld(x, y).sub(toWorld(this.grabStartScreen.x, this.grabStartScreen.y));
    // world delta -> local delta (direction only)
    const m3 = new THREE.Matrix3().setFromMatrix4(this.inv);
    const d = dW.applyMatrix3(m3);
    const s = this.brush.strength * 2 > 1 ? 1 : this.brush.strength * 2;
    const V = this.mesh.verts;
    for (const g of this.grabSet) V[g.v] = [g.o[0] + d.x * g.w * s, g.o[1] + d.y * g.w * s, g.o[2] + d.z * g.w * s];
    for (const g of this.grabMirror) V[g.v] = [g.o[0] - d.x * g.w * s, g.o[1] + d.y * g.w * s, g.o[2] + d.z * g.w * s];
    this.mesh.touch();
    this.changed = true;
    this.onUpdate();
  }

  private faceNormal(fi: number): V3 {
    const f = this.mesh.faces[fi];
    const V = this.mesh.verts;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < f.v.length; i++) {
      const a = V[f.v[i]], b = V[f.v[(i + 1) % f.v.length]];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return [nx, ny, nz];
  }

  private vertexNormal(v: number): V3 {
    let x = 0, y = 0, z = 0;
    for (const f of this.vertFaces[v]) { const n = this.faceNormal(f); x += n[0]; y += n[1]; z += n[2]; }
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  }

  private dab(x: number, y: number, p: PInfo) {
    const hit = this.vp.pickDisplay(this.obj, x, y);
    if (!hit) return;
    const r = this.radiusLocal(hit.point, p);
    this.dabAt(hit.local, r, p, false);
    if (this.brush.symmetryX) this.dabAt(new THREE.Vector3(-hit.local.x, hit.local.y, hit.local.z), r, p, true);
    this.mesh.touch();
    this.changed = true;
  }

  private dabAt(c: THREE.Vector3, r: number, p: PInfo, _mirrored: boolean) {
    const b = this.brush;
    const affected = this.collect(c, r);
    if (!affected.length) return;
    const V = this.mesh.verts;
    let strength = b.strength;
    if (b.pressureStrength && p.type === 'pen') strength *= Math.max(0.05, p.pressure);
    const sign = (b.invert !== this.invertHeld()) ? -1 : 1;
    // area normal & centre
    let an: V3 = [0, 0, 0];
    let ac: V3 = [0, 0, 0];
    let wsum = 0;
    for (const a of affected) {
      const n = this.vertexNormal(a.v);
      an = [an[0] + n[0] * a.w, an[1] + n[1] * a.w, an[2] + n[2] * a.w];
      ac = [ac[0] + a.o[0] * a.w, ac[1] + a.o[1] * a.w, ac[2] + a.o[2] * a.w];
      wsum += a.w;
    }
    const nl = Math.hypot(...an) || 1;
    an = [an[0] / nl, an[1] / nl, an[2] / nl];
    if (wsum > 0) ac = [ac[0] / wsum, ac[1] / wsum, ac[2] / wsum];
    const amt = r * 0.12 * strength;
    switch (b.type) {
      case 'draw':
        for (const a of affected) { const k = amt * a.w * sign; V[a.v] = [V[a.v][0] + an[0] * k, V[a.v][1] + an[1] * k, V[a.v][2] + an[2] * k]; }
        break;
      case 'inflate':
        for (const a of affected) { const n = this.vertexNormal(a.v); const k = amt * a.w * sign; V[a.v] = [V[a.v][0] + n[0] * k, V[a.v][1] + n[1] * k, V[a.v][2] + n[2] * k]; }
        break;
      case 'clay': {
        // plane slightly above the area centre; pull verts below it up to it
        const off = amt * sign;
        const pc: V3 = [ac[0] + an[0] * off, ac[1] + an[1] * off, ac[2] + an[2] * off];
        for (const a of affected) {
          const q = V[a.v];
          const d = (q[0] - pc[0]) * an[0] + (q[1] - pc[1]) * an[1] + (q[2] - pc[2]) * an[2];
          if (d * sign >= 0) continue;
          const k = -d * a.w * Math.min(1, strength * 1.5);
          V[a.v] = [q[0] + an[0] * k, q[1] + an[1] * k, q[2] + an[2] * k];
        }
        break;
      }
      case 'flatten':
        for (const a of affected) {
          const q = V[a.v];
          const d = (q[0] - ac[0]) * an[0] + (q[1] - ac[1]) * an[1] + (q[2] - ac[2]) * an[2];
          const k = -d * a.w * Math.min(1, strength) * (sign > 0 ? 1 : -0.5);
          V[a.v] = [q[0] + an[0] * k, q[1] + an[1] * k, q[2] + an[2] * k];
        }
        break;
      case 'smooth': {
        const next: [number, V3][] = [];
        const f = Math.min(1, strength * (sign > 0 ? 1 : 0.5));
        for (const a of affected) {
          const ns = this.neighbors[a.v];
          if (!ns.length) continue;
          let sx = 0, sy = 0, sz = 0;
          for (const n of ns) { sx += V[n][0]; sy += V[n][1]; sz += V[n][2]; }
          sx /= ns.length; sy /= ns.length; sz /= ns.length;
          const q = V[a.v], k = a.w * f;
          next.push([a.v, [q[0] + (sx - q[0]) * k, q[1] + (sy - q[1]) * k, q[2] + (sz - q[2]) * k]]);
        }
        for (const [v, q] of next) V[v] = q;
        break;
      }
      case 'pinch':
      case 'crease':
        for (const a of affected) {
          const q = V[a.v];
          const k = a.w * strength * 0.25 * sign;
          let nq: V3 = [q[0] + (c.x - q[0]) * k, q[1] + (c.y - q[1]) * k, q[2] + (c.z - q[2]) * k];
          if (b.type === 'crease') { const kk = -amt * 0.6 * a.w * sign; nq = [nq[0] + an[0] * kk, nq[1] + an[1] * kk, nq[2] + an[2] * kk]; }
          V[a.v] = nq;
        }
        break;
      case 'grab': break;
    }
  }

  end(_x: number, _y: number, _p: PInfo) { this.onEnd(this.changed); }
  cancel() { this.onCancel(); }
}
