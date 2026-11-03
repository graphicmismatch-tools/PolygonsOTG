import * as THREE from 'three';
import { Viewport } from './viewport';

export type GizmoKind = 'move' | 'rotate' | 'scale' | 'none';
export type GizmoHandle = { axis: 'x' | 'y' | 'z' | null; kind: 'move' | 'rotate' | 'scale' };

const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const COL = { x: '#ee4b55', y: '#7ccf3a', z: '#4a86f0' };

interface Shape {
  handle: GizmoHandle;
  pts: { x: number; y: number }[];
  color: string;
  tip?: 'arrow' | 'box';
  closed?: boolean;
}

export class Gizmo {
  shapes: Shape[] = [];
  center = { x: 0, y: 0 };
  hot: GizmoHandle | null = null;
  visible = false;

  update(vp: Viewport, pivot: THREE.Vector3 | null, kind: GizmoKind, sizePx = 90) {
    this.shapes = [];
    this.visible = !!pivot && kind !== 'none';
    if (!pivot || kind === 'none') return;
    const c = vp.project(pivot);
    if (c.behind) { this.visible = false; return; }
    this.center = { x: c.x, y: c.y };
    const cam = vp.cam;
    const d = cam.ortho ? cam.distance : cam.camera.position.distanceTo(pivot);
    const wpp = (2 * d * Math.tan((cam.fov * Math.PI) / 360)) / vp.height;
    const L = sizePx * wpp;
    if (kind === 'move' || kind === 'scale') {
      for (const a of ['x', 'y', 'z'] as const) {
        const e = vp.project(pivot.clone().addScaledVector(AX[a], L));
        const len = Math.hypot(e.x - c.x, e.y - c.y);
        if (len < 18 || e.behind) continue;
        const s = { x: c.x + (e.x - c.x) * 0.22, y: c.y + (e.y - c.y) * 0.22 };
        this.shapes.push({ handle: { axis: a, kind }, pts: [s, { x: e.x, y: e.y }], color: COL[a], tip: kind === 'move' ? 'arrow' : 'box' });
      }
      // free / uniform handle
      const ring: { x: number; y: number }[] = [];
      for (let i = 0; i <= 32; i++) { const t = (i / 32) * Math.PI * 2; ring.push({ x: c.x + Math.cos(t) * 14, y: c.y + Math.sin(t) * 14 }); }
      this.shapes.push({ handle: { axis: null, kind }, pts: ring, color: '#ffffff', closed: true });
    } else {
      const toCam = new THREE.Vector3().setFromMatrixColumn(cam.camera.matrixWorld, 2).normalize();
      for (const a of ['x', 'y', 'z'] as const) {
        const n = AX[a];
        const u = new THREE.Vector3().crossVectors(n, Math.abs(n.y) < 0.9 ? AX.y : AX.x).normalize();
        const v = new THREE.Vector3().crossVectors(n, u).normalize();
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i <= 64; i++) {
          const t = (i / 64) * Math.PI * 2;
          const w = pivot.clone().addScaledVector(u, Math.cos(t) * L * 0.85).addScaledVector(v, Math.sin(t) * L * 0.85);
          // front half only, so rings don't overlap confusingly
          const facing = w.clone().sub(pivot).dot(toCam) >= -L * 0.05;
          const s = vp.project(w);
          pts.push(facing ? { x: s.x, y: s.y } : { x: NaN, y: NaN });
        }
        this.shapes.push({ handle: { axis: a, kind: 'rotate' }, pts, color: COL[a] });
      }
      const ring: { x: number; y: number }[] = [];
      for (let i = 0; i <= 64; i++) { const t = (i / 64) * Math.PI * 2; ring.push({ x: c.x + Math.cos(t) * sizePx * 1.05, y: c.y + Math.sin(t) * sizePx * 1.05 }); }
      this.shapes.push({ handle: { axis: null, kind: 'rotate' }, pts: ring, color: '#dddddd', closed: true });
    }
  }

  hit(x: number, y: number, tol: number): GizmoHandle | null {
    if (!this.visible) return null;
    let best: GizmoHandle | null = null, bd = tol;
    for (const s of this.shapes) {
      if (s.closed && s.handle.axis === null && s.handle.kind !== 'rotate') {
        // filled centre handle
        const d = Math.hypot(x - this.center.x, y - this.center.y);
        if (d < Math.max(18, tol) && d < bd + 6) { bd = d - 6; best = s.handle; }
        continue;
      }
      for (let i = 0; i + 1 < s.pts.length; i++) {
        const a = s.pts[i], b = s.pts[i + 1];
        if (isNaN(a.x) || isNaN(b.x)) continue;
        const d = segDist(x, y, a.x, a.y, b.x, b.y);
        if (d < bd) { bd = d; best = s.handle; }
      }
    }
    return best;
  }

  draw(ctx: CanvasRenderingContext2D, active: GizmoHandle | null) {
    if (!this.visible) return;
    for (const s of this.shapes) {
      const hot = (active && active.axis === s.handle.axis && active.kind === s.handle.kind) || (this.hot && this.hot.axis === s.handle.axis && this.hot.kind === s.handle.kind);
      ctx.strokeStyle = hot ? '#ffe680' : s.color;
      ctx.fillStyle = hot ? '#ffe680' : s.color;
      ctx.lineWidth = hot ? 4 : 2.6;
      ctx.lineCap = 'round';
      if (s.closed && s.handle.axis === null && s.handle.kind !== 'rotate') {
        ctx.beginPath();
        ctx.arc(this.center.x, this.center.y, 14, 0, Math.PI * 2);
        ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 2; ctx.stroke();
        continue;
      }
      ctx.beginPath();
      let pen = false;
      for (const p of s.pts) {
        if (isNaN(p.x)) { pen = false; continue; }
        if (!pen) { ctx.moveTo(p.x, p.y); pen = true; } else ctx.lineTo(p.x, p.y);
      }
      if (s.handle.axis === null && s.handle.kind === 'rotate') { ctx.globalAlpha = 0.6; ctx.stroke(); ctx.globalAlpha = 1; }
      else ctx.stroke();
      if (s.tip) {
        const a = s.pts[0], b = s.pts[1];
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(ang);
        ctx.beginPath();
        if (s.tip === 'arrow') { ctx.moveTo(8, 0); ctx.lineTo(-8, -7); ctx.lineTo(-8, 7); ctx.closePath(); }
        else ctx.rect(-6, -6, 12, 12);
        ctx.fill();
        ctx.restore();
      }
    }
  }
}

export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
