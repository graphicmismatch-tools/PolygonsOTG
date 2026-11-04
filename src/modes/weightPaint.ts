import * as THREE from 'three';
import { SceneObject } from '../core/scene';
import { Viewport } from '../render/viewport';
import { PInfo, ToolHandler } from '../input';
import { falloff } from './sculpt';
import { flipName } from '../core/armature';

export type WeightTool = 'draw' | 'add' | 'subtract' | 'smooth';

export interface WeightBrush {
  tool: WeightTool;
  /** screen pixels */
  radius: number;
  strength: number;
  /** target weight for the draw tool */
  weight: number;
  symmetryX: boolean;
  falloff: 'smooth' | 'sphere' | 'sharp' | 'linear';
  pressureStrength: boolean;
}

export const defaultWeightBrush = (): WeightBrush => ({ tool: 'draw', radius: 50, strength: 0.5, weight: 1, symmetryX: true, falloff: 'smooth', pressureStrength: true });

export const WEIGHT_TOOLS: { tool: WeightTool; label: string; icon: string; hint: string }[] = [
  { tool: 'draw', label: 'Draw', icon: 'wDraw', hint: 'Paint toward the weight value' },
  { tool: 'add', label: 'Add', icon: 'brushAdd', hint: 'Increase weight' },
  { tool: 'subtract', label: 'Subtract', icon: 'brushSub', hint: 'Decrease weight' },
  { tool: 'smooth', label: 'Smooth', icon: 'brushSmooth', hint: 'Blend with neighbouring weights' },
];

/** Paints one vertex group of the object's base mesh. */
export class WeightStroke implements ToolHandler {
  private W: THREE.Matrix4;
  private scaleAvg = 1;
  private neighbors: number[][] | null = null;
  private lastX = 0;
  private lastY = 0;
  private started = false;
  changed = false;

  constructor(
    private obj: SceneObject,
    private vp: Viewport,
    private brush: WeightBrush,
    private group: string,
    private onUpdate: () => void,
    private onEnd: (changed: boolean) => void,
    private invertHeld: () => boolean,
  ) {
    this.W = vp.objectMatrix(obj);
    const s = new THREE.Vector3(); this.W.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    this.scaleAvg = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
  }

  begin(x: number, y: number, p: PInfo): boolean {
    this.lastX = x; this.lastY = y;
    if (!this.vp.pickDisplay(this.obj, x, y)) return false;
    this.started = true;
    this.dab(x, y, p);
    this.onUpdate();
    return true;
  }

  move(x: number, y: number, p: PInfo) {
    if (!this.started) { this.begin(x, y, p); return; }
    const step = Math.max(2, this.brush.radius * 0.2);
    const dist = Math.hypot(x - this.lastX, y - this.lastY);
    if (dist < step) return;
    const n = Math.floor(dist / step);
    const sx = this.lastX, sy = this.lastY;
    for (let i = 1; i <= n; i++) { const t = (i * step) / dist; this.dab(sx + (x - sx) * t, sy + (y - sy) * t, p); }
    this.lastX = sx + (x - sx) * ((n * step) / dist);
    this.lastY = sy + (y - sy) * ((n * step) / dist);
    this.onUpdate();
  }

  end() { this.onEnd(this.changed); }
  cancel() { this.onEnd(this.changed); }

  private dab(x: number, y: number, p: PInfo) {
    const hit = this.vp.pickDisplay(this.obj, x, y);
    if (!hit) return;
    const cam = this.vp.cam;
    const wpp = cam.ortho ? cam.worldPerPixel(this.vp.height) : (2 * cam.camera.position.distanceTo(hit.point) * Math.tan((cam.fov * Math.PI) / 360)) / this.vp.height;
    const r = (this.brush.radius * wpp) / this.scaleAvg;
    let s = this.brush.strength;
    if (this.brush.pressureStrength && p.type === 'pen') s *= p.pressure;
    const m = this.obj.mesh;
    const g = m.groupIndex(this.group, true);
    this.paintAt(hit.local, r, s, g);
    if (this.brush.symmetryX) {
      const mg = m.groupIndex(flipName(this.group), true);
      this.paintAt(new THREE.Vector3(-hit.local.x, hit.local.y, hit.local.z), r, s, mg);
    }
    m.weightsChanged();
  }

  private paintAt(c: THREE.Vector3, r: number, s: number, g: number) {
    const m = this.obj.mesh;
    const V = m.verts;
    const r2 = r * r;
    let tool = this.brush.tool;
    if (this.invertHeld()) tool = tool === 'subtract' ? 'add' : tool === 'add' ? 'subtract' : tool;
    const hits: [number, number][] = [];
    for (let i = 0; i < V.length; i++) {
      const dx = V[i][0] - c.x, dy = V[i][1] - c.y, dz = V[i][2] - c.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r2) hits.push([i, falloff(this.brush.falloff, Math.sqrt(d2) / r)]);
    }
    if (!hits.length) return;
    let smoothTarget: Float64Array | null = null;
    if (tool === 'smooth') {
      if (!this.neighbors) this.neighbors = V.map((_, i) => m.vertNeighbors(i));
      smoothTarget = new Float64Array(hits.length);
      hits.forEach(([v], k) => {
        const n = this.neighbors![v];
        let t = 0;
        for (const u of n) t += m.weight(u, g);
        smoothTarget![k] = n.length ? t / n.length : m.weight(v, g);
      });
    }
    hits.forEach(([v, f], k) => {
      const cur = m.weight(v, g);
      const a = Math.min(1, s * f);
      let next = cur;
      if (tool === 'draw') next = cur + (this.brush.weight - cur) * a * 0.6;
      else if (tool === 'add') next = cur + a * 0.25;
      else if (tool === 'subtract') next = cur - a * 0.25;
      else next = cur + (smoothTarget![k] - cur) * a * 0.6;
      next = Math.max(0, Math.min(1, next));
      if (Math.abs(next - cur) > 1e-5) { m.setWeight(v, g, next); this.changed = true; }
    });
  }
}
