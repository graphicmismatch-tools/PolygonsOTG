import * as THREE from 'three';
import { Viewport } from '../render/viewport';
import { SceneObject } from '../core/scene';
import { V3 } from '../core/vec';

export type TKind = 'move' | 'rotate' | 'scale';
export type Axis = 'x' | 'y' | 'z' | 'n' | null; // 'n' = custom (e.g. normal)

export interface VertTarget {
  kind: 'verts';
  obj: SceneObject;
  verts: number[];
  orig: V3[];
  /** mirror partner for each mesh vertex (-1 none), used with X symmetry */
  mirror: Int32Array | null;
}
export interface ObjTarget {
  kind: 'objects';
  objs: SceneObject[];
  orig: { pos: V3; rot: V3; scale: V3 }[];
}
export type TTarget = VertTarget | ObjTarget;

const AXES: Record<'x' | 'y' | 'z', THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1),
};

export interface Snap { enabled: boolean; move: number; rotate: number; scale: number }

/**
 * Interactive transform. Values accumulate over several drags (touch-friendly);
 * `apply()` always recomputes from the original state, so cancel is exact.
 */
export class TransformSession {
  axis: Axis;
  customAxis: THREE.Vector3 | null;
  pivot: THREE.Vector3;
  /** accumulated from finished drags */
  private accMove = new THREE.Vector3();
  private accAngle = 0;
  private accScale = 1;
  /** current total */
  move = new THREE.Vector3();
  angle = 0;
  factor = 1;
  private dragStart: { x: number; y: number } | null = null;
  private lastAngle = 0;
  private angleUnwrap = 0;
  numeric: number | null = null;
  onChange: () => void = () => {};

  constructor(
    public kind: TKind,
    public target: TTarget,
    private vp: Viewport,
    public snap: Snap,
    opts: { axis?: Axis; customAxis?: V3 | null; pivot?: THREE.Vector3 } = {},
  ) {
    this.axis = opts.axis ?? null;
    this.customAxis = opts.customAxis ? new THREE.Vector3(...opts.customAxis).normalize() : null;
    this.pivot = opts.pivot?.clone() ?? this.computePivot();
  }

  computePivot(): THREE.Vector3 {
    const t = this.target;
    const c = new THREE.Vector3();
    if (t.kind === 'verts') {
      if (!t.verts.length) return c;
      const m = this.vp.objectMatrix(t.obj);
      const box = new THREE.Box3();
      for (const p of t.orig) box.expandByPoint(new THREE.Vector3(...p).applyMatrix4(m));
      return box.getCenter(c);
    }
    for (const o of t.orig) c.add(new THREE.Vector3(...o.pos));
    return c.divideScalar(Math.max(1, t.orig.length));
  }

  axisVector(): THREE.Vector3 | null {
    if (this.axis === 'n') return this.customAxis;
    if (this.axis) return AXES[this.axis].clone();
    return null;
  }

  setAxis(a: Axis) {
    // keep accumulated motion projected on the new axis
    this.axis = this.axis === a ? null : a;
    const av = this.axisVector();
    if (av && this.kind === 'move') { this.accMove = av.clone().multiplyScalar(this.accMove.dot(av)); }
    this.move.copy(this.accMove); this.angle = this.accAngle; this.factor = this.accScale;
    this.apply();
  }

  beginDrag(x: number, y: number) {
    this.dragStart = { x, y };
    const ps = this.vp.project(this.pivot);
    this.lastAngle = Math.atan2(y - ps.y, x - ps.x);
    this.angleUnwrap = 0;
    this.numeric = null;
  }

  drag(x: number, y: number) {
    if (!this.dragStart) this.beginDrag(x, y);
    const s = this.dragStart!;
    const dx = x - s.x, dy = y - s.y;
    const ps = this.vp.project(this.pivot);
    if (this.kind === 'move') {
      const av = this.axisVector();
      let d: THREE.Vector3;
      if (av) {
        const k = this.vp.cam.worldPerPixel(this.vp.height) * 60;
        const s1 = this.vp.project(this.pivot.clone().addScaledVector(av, k));
        const sx = s1.x - ps.x, sy = s1.y - ps.y;
        const sl = Math.hypot(sx, sy);
        let amount: number;
        if (sl < 8) amount = -dy * this.vp.cam.worldPerPixel(this.vp.height);
        else amount = ((dx * sx + dy * sy) / sl) / (sl / k);
        if (this.snap.enabled) amount = Math.round(amount / this.snap.move) * this.snap.move;
        d = av.clone().multiplyScalar(amount);
      } else {
        d = this.screenDeltaToWorld(ps, dx, dy);
        if (this.snap.enabled) d.set(snapTo(d.x, this.snap.move), snapTo(d.y, this.snap.move), snapTo(d.z, this.snap.move));
      }
      this.move.copy(this.accMove).add(d);
    } else if (this.kind === 'rotate') {
      const r0 = Math.hypot(s.x - ps.x, s.y - ps.y);
      let a: number;
      if (r0 < 36) a = dx * 0.01;
      else {
        const cur = Math.atan2(y - ps.y, x - ps.x);
        let delta = cur - this.lastAngle;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        this.angleUnwrap += delta;
        this.lastAngle = cur;
        a = this.angleUnwrap;
      }
      let total = this.accAngle + a;
      if (this.snap.enabled) total = Math.round(total / ((this.snap.rotate * Math.PI) / 180)) * ((this.snap.rotate * Math.PI) / 180);
      this.angle = total;
    } else {
      const r0 = Math.hypot(s.x - ps.x, s.y - ps.y);
      let f: number;
      if (r0 < 36) f = Math.exp(dx * 0.01);
      else f = Math.hypot(x - ps.x, y - ps.y) / r0;
      let total = this.accScale * f;
      if (this.snap.enabled) total = Math.round(total / this.snap.scale) * this.snap.scale || this.snap.scale;
      this.factor = total;
    }
    this.apply();
  }

  endDrag() {
    this.accMove.copy(this.move);
    this.accAngle = this.angle;
    this.accScale = this.factor;
    this.dragStart = null;
  }

  /** Numeric entry: move distance along axis (X if none), degrees, or factor. */
  setNumeric(v: number) {
    this.numeric = v;
    if (this.kind === 'move') { const av = this.axisVector() ?? AXES.x.clone(); this.move.copy(av.multiplyScalar(v)); }
    else if (this.kind === 'rotate') this.angle = (v * Math.PI) / 180;
    else this.factor = v;
    this.endDrag();
    this.apply();
  }

  private screenDeltaToWorld(ps: { x: number; y: number; z: number }, dx: number, dy: number) {
    const cam = this.vp.cam.camera;
    const a = new THREE.Vector3((ps.x / this.vp.width) * 2 - 1, -(ps.y / this.vp.height) * 2 + 1, ps.z).unproject(cam);
    const b = new THREE.Vector3(((ps.x + dx) / this.vp.width) * 2 - 1, -((ps.y + dy) / this.vp.height) * 2 + 1, ps.z).unproject(cam);
    return b.sub(a);
  }

  /** Rotation axis in world space. */
  private rotAxis(): THREE.Vector3 {
    const cam = this.vp.cam.camera;
    const toCam = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2).normalize();
    const av = this.axisVector();
    if (!av) return toCam.negate();
    return av.clone().multiplyScalar(av.dot(toCam) >= 0 ? -1 : 1);
  }

  /** World-space transform matrix for the current values (about pivot). */
  matrix(): THREE.Matrix4 {
    const P = new THREE.Matrix4().makeTranslation(this.pivot.x, this.pivot.y, this.pivot.z);
    const Pi = new THREE.Matrix4().makeTranslation(-this.pivot.x, -this.pivot.y, -this.pivot.z);
    let M = new THREE.Matrix4();
    if (this.kind === 'move') M.makeTranslation(this.move.x, this.move.y, this.move.z);
    else if (this.kind === 'rotate') M = P.clone().multiply(new THREE.Matrix4().makeRotationAxis(this.rotAxis(), this.angle)).multiply(Pi);
    else {
      const av = this.axisVector();
      let S: THREE.Matrix4;
      if (!av) S = new THREE.Matrix4().makeScale(this.factor, this.factor, this.factor);
      else {
        // scale along arbitrary axis: I + (f-1) a a^T
        const f = this.factor - 1;
        S = new THREE.Matrix4().set(
          1 + f * av.x * av.x, f * av.x * av.y, f * av.x * av.z, 0,
          f * av.y * av.x, 1 + f * av.y * av.y, f * av.y * av.z, 0,
          f * av.z * av.x, f * av.z * av.y, 1 + f * av.z * av.z, 0,
          0, 0, 0, 1,
        );
      }
      M = P.clone().multiply(S).multiply(Pi);
    }
    return M;
  }

  apply() {
    const M = this.matrix();
    const t = this.target;
    if (t.kind === 'verts') {
      const W = this.vp.objectMatrix(t.obj);
      const Wi = W.clone().invert();
      const L = Wi.clone().multiply(M).multiply(W); // local-space transform
      const mesh = t.obj.mesh;
      const moved = new Set(t.verts);
      const v = new THREE.Vector3();
      t.verts.forEach((vi, i) => {
        const o = t.orig[i];
        v.set(o[0], o[1], o[2]).applyMatrix4(L);
        if (t.mirror && Math.abs(o[0]) < 1e-4 && t.mirror[vi] === vi) v.x = 0;
        mesh.verts[vi] = [v.x, v.y, v.z];
      });
      if (t.mirror) {
        for (const vi of t.verts) {
          const p = t.mirror[vi];
          if (p >= 0 && p !== vi && !moved.has(p)) { const q = mesh.verts[vi]; mesh.verts[p] = [-q[0], q[1], q[2]]; }
        }
      }
      mesh.touch();
    } else {
      t.objs.forEach((o, i) => {
        const orig = t.orig[i];
        const m = new THREE.Matrix4().compose(new THREE.Vector3(...orig.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...orig.rot, 'XYZ')), new THREE.Vector3(...orig.scale));
        let res: THREE.Matrix4;
        if (this.kind === 'scale') {
          // keep object scale on its local axes: scale position about pivot & local scale by factor
          const av = this.axisVector();
          const pos = new THREE.Vector3(...orig.pos).applyMatrix4(M);
          const sc = new THREE.Vector3(...orig.scale);
          if (!av) sc.multiplyScalar(this.factor);
          else {
            // find the local axis most aligned with the world axis
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...orig.rot, 'XYZ'));
            const loc = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((a) => Math.abs(a.applyQuaternion(q).dot(av)));
            const k = loc.indexOf(Math.max(...loc));
            sc.setComponent(k, sc.getComponent(k) * this.factor);
          }
          o.position = [pos.x, pos.y, pos.z];
          o.scale = [sc.x, sc.y, sc.z];
          o.rotation = [...orig.rot] as V3;
          return;
        }
        res = M.clone().multiply(m);
        const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
        res.decompose(p, q, s);
        const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
        o.position = [p.x, p.y, p.z];
        o.rotation = [e.x, e.y, e.z];
        o.scale = [...orig.scale] as V3;
      });
    }
    this.onChange();
  }

  /** Restore original state. */
  cancel() {
    const t = this.target;
    if (t.kind === 'verts') {
      const mesh = t.obj.mesh;
      t.verts.forEach((vi, i) => { mesh.verts[vi] = [...t.orig[i]] as V3; });
      if (t.mirror) {
        for (const vi of t.verts) {
          const p = t.mirror[vi];
          if (p >= 0 && p !== vi && !t.verts.includes(p)) { const q = t.orig[t.verts.indexOf(vi)]; mesh.verts[p] = [-q[0], q[1], q[2]]; }
        }
      }
      mesh.touch();
    } else {
      t.objs.forEach((o, i) => { o.position = [...t.orig[i].pos] as V3; o.rotation = [...t.orig[i].rot] as V3; o.scale = [...t.orig[i].scale] as V3; });
    }
    this.onChange();
  }

  describe(): string {
    const ax = this.axis ? (this.axis === 'n' ? ' along normal' : ` on ${this.axis.toUpperCase()}`) : '';
    if (this.kind === 'move') {
      const av = this.axisVector();
      if (av) return `Move${ax}: ${this.move.dot(av).toFixed(3)}`;
      return `Move: ${this.move.x.toFixed(2)}, ${this.move.y.toFixed(2)}, ${this.move.z.toFixed(2)}`;
    }
    if (this.kind === 'rotate') return `Rotate${ax}: ${((this.angle * 180) / Math.PI).toFixed(1)}°`;
    return `Scale${ax}: ${this.factor.toFixed(3)}`;
  }
}

const snapTo = (x: number, s: number) => Math.round(x / s) * s;

export function vertTarget(obj: SceneObject, verts: number[], mirror: Int32Array | null): VertTarget {
  return { kind: 'verts', obj, verts, orig: verts.map((v) => [...obj.mesh.verts[v]] as V3), mirror };
}

export function objTarget(objs: SceneObject[]): ObjTarget {
  return { kind: 'objects', objs, orig: objs.map((o) => ({ pos: [...o.position] as V3, rot: [...o.rotation] as V3, scale: [...o.scale] as V3 })) };
}
