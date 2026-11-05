import * as THREE from 'three';
import { OrbitCamera } from './viewport';

/**
 * Orientation gizmo in the corner of the 3D view: the six world axes as seen
 * from the current camera. Tap an axis ball to look along it (tap the one
 * facing you again to flip to the opposite side); drag the gizmo to orbit.
 */
type AxisName = 'x' | 'y' | 'z';
interface Ball { axis: AxisName; positive: boolean; x: number; y: number; depth: number }

const COLORS: Record<AxisName, [string, string]> = {
  // [bright, dim] — matching the transform axis colours
  x: ['#ee4b55', '#8f3a40'],
  y: ['#7ccf3a', '#4d7a2c'],
  z: ['#4a86f0', '#33558f'],
};

/** View that looks along each axis ball (camera placed on that side). */
const VIEW_OF: Record<string, 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'> = {
  'x+': 'right', 'x-': 'left', 'y+': 'top', 'y-': 'bottom', 'z+': 'front', 'z-': 'back',
};

export class ViewGizmo {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size = 96;
  private dpr = 1;
  private balls: Ball[] = [];
  private hot: Ball | null = null;
  private drag: { id: number; x: number; y: number; moved: boolean } | null = null;

  constructor(
    private cam: OrbitCamera,
    private onOrbit: (dx: number, dy: number) => void,
    private onView: (v: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom') => void,
  ) {
    this.el = document.createElement('canvas');
    this.el.className = 'viewgizmo';
    this.el.setAttribute('aria-label', 'View orientation: tap an axis to look along it, drag to orbit');
    this.ctx = this.el.getContext('2d')!;
    this.el.addEventListener('pointerdown', this.down);
    this.el.addEventListener('pointermove', this.move);
    this.el.addEventListener('pointerup', this.up);
    this.el.addEventListener('pointercancel', () => { this.drag = null; });
    this.el.addEventListener('pointerleave', () => { if (!this.drag) { this.hot = null; this.draw(); } });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  resize(cssSize: number, dpr: number) {
    this.size = cssSize; this.dpr = dpr;
    this.el.width = this.el.height = Math.round(cssSize * dpr);
    this.el.style.width = this.el.style.height = `${cssSize}px`;
    this.draw();
  }

  private local(e: PointerEvent) { const r = this.el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  private pick(x: number, y: number): Ball | null {
    const r = this.ballRadius() + 3;
    // front-most first
    for (const b of [...this.balls].sort((a, c) => c.depth - a.depth)) if (Math.hypot(b.x - x, b.y - y) <= r) return b;
    return null;
  }

  private down = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const p = this.local(e);
    this.drag = { id: e.pointerId, x: p.x, y: p.y, moved: false };
  };

  private move = (e: PointerEvent) => {
    const p = this.local(e);
    if (this.drag && this.drag.id === e.pointerId) {
      const dx = p.x - this.drag.x, dy = p.y - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < (e.pointerType === 'touch' ? 6 : 3)) return;
      this.drag.moved = true;
      this.drag.x = p.x; this.drag.y = p.y;
      // the gizmo is small: orbit a bit faster than on the canvas
      this.onOrbit(dx * 2, dy * 2);
      return;
    }
    if (e.pointerType === 'touch') return;
    const h = this.pick(p.x, p.y);
    if (h !== this.hot) { this.hot = h; this.draw(); }
  };

  private up = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved) return;
    const p = this.local(e);
    const b = this.pick(p.x, p.y);
    if (!b) return;
    // tapping the axis you already look along flips to the opposite side
    let key = `${b.axis}${b.positive ? '+' : '-'}`;
    if (this.facing(key)) key = `${b.axis}${b.positive ? '-' : '+'}`;
    this.onView(VIEW_OF[key]);
  };

  /** Is the camera already looking along this axis ball? */
  private facing(key: string) {
    const dir = new THREE.Vector3().setFromMatrixColumn(this.cam.camera.matrixWorld, 2); // toward the viewer
    const a = new THREE.Vector3(key[0] === 'x' ? 1 : 0, key[0] === 'y' ? 1 : 0, key[0] === 'z' ? 1 : 0).multiplyScalar(key[1] === '+' ? 1 : -1);
    return dir.dot(a) > 0.999;
  }

  private ballRadius() { return Math.max(7, this.size * 0.1); }

  /** Redraw for the current camera. Cheap; call after every render. */
  draw() {
    const ctx = this.ctx, s = this.size, c = s / 2;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);
    const m = this.cam.camera.matrixWorld;
    const right = new THREE.Vector3().setFromMatrixColumn(m, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(m, 1);
    const back = new THREE.Vector3().setFromMatrixColumn(m, 2);
    const br = this.ballRadius();
    const reach = c - br - 2;
    this.balls = [];
    for (const axis of ['x', 'y', 'z'] as AxisName[]) {
      const v = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
      for (const positive of [true, false]) {
        const d = positive ? v : v.clone().negate();
        this.balls.push({ axis, positive, x: c + d.dot(right) * reach, y: c - d.dot(up) * reach, depth: d.dot(back) });
      }
    }
    // backdrop disc, stronger while in use
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.fillStyle = this.drag?.moved || this.hot ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
    ctx.fill();
    // back to front
    for (const b of [...this.balls].sort((a, z) => a.depth - z.depth)) {
      const [bright, dim] = COLORS[b.axis];
      const hot = this.hot === b;
      if (b.positive) {
        ctx.strokeStyle = bright;
        ctx.lineWidth = 2;
        ctx.globalAlpha = b.depth < -0.2 ? 0.55 : 1;
        ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.beginPath(); ctx.arc(b.x, b.y, br, 0, Math.PI * 2);
        ctx.fillStyle = bright; ctx.fill();
        if (hot) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke(); }
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#111114';
        ctx.font = `bold ${Math.round(br * 1.25)}px 'JetBrains Mono', ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(b.axis.toUpperCase(), b.x, b.y + 0.5);
      } else {
        ctx.beginPath(); ctx.arc(b.x, b.y, br * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = dim; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = hot ? '#ffffff' : bright; ctx.lineWidth = hot ? 2 : 1.2; ctx.stroke();
        if (hot) {
          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${Math.round(br)}px 'JetBrains Mono', ui-monospace, monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(`-${b.axis.toUpperCase()}`, b.x, b.y + 0.5);
        }
      }
    }
  }
}
