import * as THREE from 'three';
import { Scene, SceneObject } from './core/scene';
import { History } from './core/history';
import { Mesh, SelectMode, ekey, parseKey } from './core/mesh';
import * as ops from './core/ops';
import * as uvOps from './core/uv';
import { createPrimitive, PrimitiveType, PRIMITIVES } from './core/primitives';
import { evaluate, newModifier, ModifierType } from './core/modifiers';
import { V3 } from './core/vec';
import { Viewport, AppMode, v3 } from './render/viewport';
import { Gizmo, GizmoKind, GizmoHandle, segDist } from './render/overlay';
import { Gestures, PInfo, ToolHandler } from './input';
import { TransformSession, TKind, Axis, vertTarget, objTarget, Snap, Falloff, buildProp, setPropRadius } from './modes/transform';
import { bevel as bevelOp } from './core/bevel';
import { remesh, RemeshMode, RemeshInfo, defaultRemeshSize } from './core/remesh';
import { decimate, DecimateMode, unsubdivide } from './core/decimate';
import { SculptStroke, BrushSettings, defaultBrush } from './modes/sculpt';
import { kvGet, kvSet } from './io/files';

export type SelOp = 'set' | 'add' | 'sub';
export type EditTool = 'select' | 'loopcut' | 'knife';

export interface Settings {
  mirrorX: boolean;
  snap: Snap;
  gizmo: GizmoKind;
  tweak: boolean;
  palmRejection: 'auto' | 'on' | 'off';
  touchOrbit: boolean;
  panelOpen: boolean;
  leftHanded: boolean;
  proportional: { enabled: boolean; falloff: Falloff; radius: number };
}

export interface ParamDef { name: string; value: number; min: number; max: number; step: number; drag: number; int?: boolean }

export type Modal =
  | { kind: 'transform'; session: TransformSession; flavor: 'button' | 'drag' | 'key'; label: string; onCancel?: () => void; onConfirm?: () => void }
  | { kind: 'param'; label: string; params: ParamDef[]; run: (v: number[]) => void; onCancel: () => void; heavy?: boolean; flush?: () => void };

type Listener = () => void;

export class App {
  scene = new Scene();
  history: History;
  vp: Viewport;
  gestures: Gestures;
  gizmo = new Gizmo();
  overlay: CanvasRenderingContext2D;
  mode: AppMode = 'object';
  selectMode: SelectMode = 'vert';
  selOp: SelOp = 'set';
  tool: EditTool = 'select';
  brush: BrushSettings = defaultBrush();
  modal: Modal | null = null;
  settings: Settings = {
    mirrorX: false,
    snap: { enabled: false, move: 0.25, rotate: 15, scale: 0.1 },
    gizmo: 'move',
    tweak: true,
    palmRejection: 'auto',
    touchOrbit: true,
    panelOpen: false,
    leftHanded: false,
    proportional: { enabled: false, falloff: 'smooth', radius: 1 },
  };
  hover: { x: number; y: number; type: PInfo['type'] } | null = null;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private activeHandle: GizmoHandle | null = null;
  private loopPreview: [V3, V3][] | null = null;
  private knifeLine: { x0: number; y0: number; x1: number; y1: number; hits: { x: number; y: number }[] } | null = null;
  private preselect: { kind: 'vert' | 'edge' | 'face'; id: number | string } | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private keyInvert = false;
  statusText = '';
  private statusTimer = 0;
  private autosaveTimer = 0;
  /** Set by the UV editor when present. */
  uvRedraw: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, private overlayCanvas: HTMLCanvasElement, private container: HTMLElement) {
    this.vp = new Viewport(canvas);
    this.overlay = overlayCanvas.getContext('2d')!;
    this.history = new History(this.scene, () => this.mode);
    this.history.onChange = () => this.emit('history');
    this.vp.onAfterRender = () => this.drawOverlay();
    this.gestures = new Gestures(container, {
      beginTool: (x, y, p) => this.beginTool(x, y, p),
      beginBox: (x, y, p) => this.beginBox(x, y, p),
      tap: (x, y, p, c) => this.tap(x, y, p, c),
      hover: (x, y, p) => this.onHover(x, y, p),
      orbit: (dx, dy) => { this.vp.cam.orbit(dx, dy); this.redraw(); },
      pan: (dx, dy) => { this.vp.cam.pan(dx, dy, this.vp.height); this.redraw(); },
      zoom: (f, x, y) => this.zoomAt(f, x, y),
      undo: () => this.undo(),
      redo: () => this.redo(),
      touchDragOrbits: () => this.settings.touchOrbit,
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => { if (e.key === 'Control') this.keyInvert = false; });
  }

  /* ================================================================ events */
  on(evt: string, fn: Listener) { (this.listeners.get(evt) ?? this.listeners.set(evt, new Set()).get(evt)!).add(fn); }
  emit(evt: string) { this.listeners.get(evt)?.forEach((f) => f()); if (evt !== 'any') this.listeners.get('any')?.forEach((f) => f()); }

  /** Re-sync 3D + overlays after any change. */
  /** True while a sculpt stroke is in progress. */
  stroking = false;

  redraw() {
    this.vp.deferHeavy = !!this.modal || this.stroking;
    this.vp.sync(this.scene, this.mode);
    this.uvRedraw();
  }

  /** Scene data changed: redraw, notify UI, schedule autosave. */
  changed() {
    this.redraw();
    this.emit('change');
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => this.autosave(), 1500);
  }

  status(text: string, ms = 2500) {
    this.statusText = text;
    this.emit('status');
    clearTimeout(this.statusTimer);
    if (ms > 0) this.statusTimer = window.setTimeout(() => { this.statusText = ''; this.emit('status'); }, ms);
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.vp.resize(r.width, r.height, dpr);
    this.overlayCanvas.width = Math.round(r.width * dpr);
    this.overlayCanvas.height = Math.round(r.height * dpr);
    this.overlayCanvas.style.width = `${r.width}px`;
    this.overlayCanvas.style.height = `${r.height}px`;
    this.redraw();
  }

  get active(): SceneObject | null { return this.scene.active; }
  get editObj(): SceneObject | null { return this.isEditLike ? this.scene.active : null; }
  get isEditLike() { return this.mode === 'edit' || this.mode === 'uv'; }

  /* ================================================================ persistence */
  async autosave() {
    await kvSet('autosave', this.scene.toJSON());
  }

  async restore(): Promise<boolean> {
    const j = await kvGet<ReturnType<Scene['toJSON']>>('autosave');
    if (!j || !j.objects) return false;
    try { this.scene.load(j); } catch { return false; }
    this.mode = 'object';
    this.history.clear();
    this.changed();
    return true;
  }

  newScene(withCube = true) {
    this.cancelModal();
    this.scene.objects = [];
    this.scene.selected.clear();
    this.scene.activeId = null;
    this.mode = 'object';
    if (withCube) this.scene.add(new SceneObject('Cube', createPrimitive('cube')));
    this.history.clear();
    this.vp.cam.target.set(0, 0, 0); this.vp.cam.distance = 9; this.vp.cam.yaw = Math.PI / 4; this.vp.cam.pitch = -0.5;
    this.emit('mode');
    this.changed();
  }

  loadProject(json: any) {
    if (json?.format !== 'polygons-otg') throw new Error('Not a Polygons OTG project');
    this.cancelModal();
    this.scene.load(json);
    this.mode = 'object';
    this.history.clear();
    this.emit('mode');
    this.changed();
    this.frameAll();
  }

  /* ================================================================ undo */
  /** Snapshot before an operation. */
  record(label: string) { this.history.push(label); }

  undo() {
    if (this.modal) { this.cancelModal(); return; }
    const s = this.history.undo();
    if (s) { this.afterRestore(); this.status(`Undo ${s.label}`); }
  }
  redo() {
    if (this.modal) return;
    const s = this.history.redo();
    if (s) { this.afterRestore(); this.status(`Redo ${s.label}`); }
  }
  private afterRestore() {
    if (this.isEditLike || this.mode === 'sculpt') {
      const a = this.active;
      if (!a || (this.mode === 'sculpt' && !a.mesh.faces.length)) this.setMode('object');
    }
    this.changed();
  }
  /** Revert to the last snapshot without keeping a redo step (cancelled chained op). */
  private revertLast() {
    this.history.undo();
    // drop the redo entry that undo created
    (this.history as any).redoStack.pop();
    this.history.onChange();
    this.changed();
  }

  /* ================================================================ modes */
  setMode(m: AppMode) {
    if (m === this.mode) return;
    this.confirmModal();
    const a = this.active;
    if (m !== 'object') {
      if (!a) { this.status('Select an object first'); return; }
      if (m === 'sculpt' && !a.mesh.faces.length) { this.status('Sculpting needs a mesh with faces'); return; }
      this.scene.selected = new Set([a.id]);
      a.visible = true;
    }
    this.mode = m;
    this.tool = 'select';
    this.preselect = null;
    this.loopPreview = null;
    if (m === 'uv') this.vp.settings.checker = true;
    this.emit('mode');
    this.changed();
  }

  toggleEdit() { this.setMode(this.mode === 'edit' ? 'object' : 'edit'); }

  setSelectMode(sm: SelectMode) {
    const a = this.editObj;
    if (a) {
      const m = a.mesh;
      if (sm === 'vert') m.flush('vert');
      else if (sm === 'edge') { if (this.selectMode === 'vert') m.flush('vert'); }
      else { if (this.selectMode !== 'face') { m.flush(this.selectMode === 'edge' ? 'edge' : 'vert'); } }
    }
    this.selectMode = sm;
    this.emit('mode');
    this.changed();
  }

  setTool(t: EditTool) { this.tool = t; this.loopPreview = null; this.emit('mode'); this.redraw(); }

  /* ================================================================ navigation */
  zoomAt(f: number, x: number, y: number) {
    if (this.modal?.kind === 'transform' && this.modal.session.target.kind === 'verts' && this.modal.session.target.prop && x >= 0 && !this.gestures.multiTouch) {
      this.scalePropRadius(1 / f);
      return;
    }
    const cam = this.vp.cam;
    const before = cam.distance;
    cam.distance = Math.min(2000, Math.max(0.02, cam.distance * f));
    // zoom toward the cursor
    if (x >= 0) {
      cam.update();
      const rc = this.vp.ray(x, y);
      const n = new THREE.Vector3().setFromMatrixColumn(cam.camera.matrixWorld, 2);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, cam.target);
      const p = new THREE.Vector3();
      if (rc.ray.intersectPlane(plane, p)) cam.target.lerp(p, 1 - cam.distance / before);
    }
    this.redraw();
  }

  frameSelected() {
    const box = new THREE.Box3();
    const a = this.active;
    if (this.isEditLike && a && a.mesh.selV.size) {
      const M = this.vp.objectMatrix(a);
      for (const v of a.mesh.selV) box.expandByPoint(v3(a.mesh.verts[v]).applyMatrix4(M));
    } else {
      const objs = this.scene.objects.filter((o) => this.scene.selected.has(o.id));
      for (const o of objs.length ? objs : this.scene.objects) this.expandBox(box, o);
    }
    if (box.isEmpty()) return this.frameAll();
    this.vp.frameBox(box);
    this.redraw();
  }

  frameAll() {
    const box = new THREE.Box3();
    for (const o of this.scene.objects) this.expandBox(box, o);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    this.vp.frameBox(box);
    this.redraw();
  }

  private expandBox(box: THREE.Box3, o: SceneObject) {
    const M = this.vp.objectMatrix(o);
    for (const p of o.mesh.verts) box.expandByPoint(v3(p).applyMatrix4(M));
  }

  setView(v: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom') { this.vp.cam.setView(v); this.redraw(); }
  toggleOrtho() { this.vp.cam.ortho = !this.vp.cam.ortho; this.emit('mode'); this.redraw(); }

  /* ================================================================ pivot & selection info */
  selectionPivot(): THREE.Vector3 | null {
    const a = this.active;
    if (this.isEditLike && a) {
      const vs = ops.selectedVerts(a.mesh);
      if (!vs.length) return null;
      const M = this.vp.objectMatrix(a);
      const box = new THREE.Box3();
      for (const v of vs) box.expandByPoint(v3(a.mesh.verts[v]).applyMatrix4(M));
      return box.getCenter(new THREE.Vector3());
    }
    if (this.mode === 'object') {
      const objs = this.selectedObjects();
      if (!objs.length) return null;
      const c = new THREE.Vector3();
      for (const o of objs) c.add(v3(o.position));
      return c.divideScalar(objs.length);
    }
    return null;
  }

  selectedObjects() { return this.scene.objects.filter((o) => this.scene.selected.has(o.id)); }

  /* ================================================================ transforms */
  startTransform(kind: TKind, flavor: 'button' | 'drag' | 'key' = 'button', axis: Axis = null, customAxis: V3 | null = null, opts: { label?: string; onCancel?: () => void; skipRecord?: boolean } = {}): TransformSession | null {
    this.confirmModal();
    const target = this.transformTarget();
    if (!target) { this.status('Nothing selected'); return null; }
    if (!opts.skipRecord) this.record(kind[0].toUpperCase() + kind.slice(1));
    let worldAxis = customAxis;
    if (customAxis && target.kind === 'verts') {
      const n = new THREE.Vector3(...customAxis).transformDirection(this.vp.objectMatrix(target.obj));
      worldAxis = [n.x, n.y, n.z];
    }
    const s = new TransformSession(kind, target, this.vp, this.settings.snap, { axis, customAxis: worldAxis });
    s.onChange = () => { this.redraw(); this.emit('modal'); };
    this.modal = { kind: 'transform', session: s, flavor, label: opts.label ?? kind, onCancel: opts.onCancel };
    if (flavor === 'key' && this.hover) s.beginDrag(this.hover.x, this.hover.y);
    this.emit('modal');
    this.redraw();
    return s;
  }

  private transformTarget() {
    const a = this.active;
    if (this.isEditLike && a) {
      const vs = ops.selectedVerts(a.mesh);
      if (!vs.length) return null;
      const t = vertTarget(a, vs, this.settings.mirrorX ? ops.mirrorMap(a.mesh) : null);
      const pr = this.settings.proportional;
      if (pr.enabled) t.prop = buildProp(a, vs, this.vp.objectMatrix(a), pr.radius, pr.falloff, pr.radius * 3);
      return t;
    }
    if (this.mode === 'object') {
      const objs = this.selectedObjects();
      if (!objs.length) return null;
      return objTarget(objs);
    }
    return null;
  }

  setModalAxis(a: Axis) {
    if (this.modal?.kind === 'transform') { this.modal.session.setAxis(a); this.emit('modal'); }
  }

  /** Scale the proportional-editing radius (live during a transform). */
  scalePropRadius(f: number) {
    const pr = this.settings.proportional;
    pr.radius = Math.min(1000, Math.max(0.001, pr.radius * f));
    const m = this.modal;
    if (m?.kind === 'transform' && m.session.target.kind === 'verts' && m.session.target.prop) {
      const t = m.session.target;
      if (pr.radius > t.prop!.maxRadius) {
        // distances were computed for a smaller radius: restore, recompute, re-apply
        m.session.cancel();
        t.prop = buildProp(t.obj, t.verts, this.vp.objectMatrix(t.obj), pr.radius, pr.falloff, pr.radius * 3);
      } else setPropRadius(t.prop!, pr.radius);
      m.session.apply();
    }
    this.emit('modal');
    this.vp.requestRender();
  }

  setPropFalloff(f: Falloff | 'off') {
    const pr = this.settings.proportional;
    if (f === 'off') pr.enabled = false; else { pr.enabled = true; pr.falloff = f; }
    this.emit('mode');
  }

  confirmModal() {
    const m = this.modal;
    if (!m) return;
    this.modal = null;
    this.activeHandle = null;
    if (m.kind === 'transform') {
      m.session.endDrag();
      m.onConfirm?.();
    } else m.flush?.();
    this.emit('modal');
    this.changed();
  }

  cancelModal() {
    const m = this.modal;
    if (!m) return;
    this.modal = null;
    this.activeHandle = null;
    if (m.kind === 'transform') {
      m.session.cancel();
      if (m.onCancel) m.onCancel(); else this.history.cancelLast();
    } else m.onCancel();
    this.emit('modal');
    this.changed();
  }

  /**
   * Start a parametric op: values are re-applied on a fresh copy of the pre-op mesh.
   * `op` may return a new mesh (whole-mesh rebuilds like remesh) or mutate in place.
   * Heavy ops run deferred (so a busy message can paint) and only when a drag ends.
   */
  startParamOp(label: string, params: ParamDef[], op: (m: Mesh, v: number[]) => Mesh | void, opts: { heavy?: boolean; report?: (m: Mesh) => string } = {}) {
    const a = this.isEditLike ? this.editObj : this.active;
    if (!a) return;
    this.confirmModal();
    this.record(label);
    const before = a.mesh.clone();
    let pending = 0;
    const doRun = (v: number[]) => {
      const m = before.clone();
      const res = op(m, v) ?? m;
      a.mesh = res;
      res.changed();
      this.redraw();
      this.emit('modal');
      if (opts.report) this.status(opts.report(res), 4000);
    };
    const run = (v: number[]) => {
      if (!opts.heavy) return doRun(v);
      clearTimeout(pending);
      this.status(`${label}…`, 0);
      pending = window.setTimeout(() => { pending = 0; doRun(v); }, 30);
    };
    run(params.map((p) => p.value));
    this.modal = {
      kind: 'param', label, params, run, heavy: opts.heavy,
      flush: () => { if (pending) { clearTimeout(pending); pending = 0; doRun(params.map((p) => p.value)); } },
      onCancel: () => { clearTimeout(pending); pending = 0; a.mesh = before; this.history.cancelLast(); },
    };
    this.emit('modal');
  }

  setParam(i: number, value: number) {
    const m = this.modal;
    if (m?.kind !== 'param') return;
    const p = m.params[i];
    p.value = Math.min(p.max, Math.max(p.min, p.int ? Math.round(value) : value));
    m.run(m.params.map((x) => x.value));
  }

  /* ================================================================ gestures */
  private pickRadius(p: PInfo) { return p.type === 'touch' ? 30 : p.type === 'pen' ? 16 : 12; }

  private beginTool(x: number, y: number, p: PInfo): ToolHandler | null {
    // 1. active modal: drags drive it, a tap confirms
    if (this.modal) {
      const modal = this.modal;
      if (modal.kind === 'transform') {
        const s = modal.session;
        if (modal.flavor === 'key' && p.type === 'mouse') {
          // mouse-driven modal: click confirms, right click cancels
          return { move: () => {}, end: () => this.confirmModal(), cancel: () => {} };
        }
        s.beginDrag(x, y);
        let moved = false;
        return {
          move: (mx, my) => { moved = true; s.drag(mx, my); },
          end: () => { s.endDrag(); if (!moved) this.confirmModal(); else this.emit('modal'); },
          cancel: () => { s.endDrag(); },
        };
      }
      // param modal: horizontal drag adjusts first param
      const pm = modal;
      const p0 = pm.params[0];
      const start = p0.value;
      let moved = false;
      const setLive = (v: number) => {
        if (!pm.heavy) return this.setParam(0, v);
        // heavy ops: show the value while dragging, compute on release
        p0.value = Math.min(p0.max, Math.max(p0.min, p0.int ? Math.round(v) : v));
        this.emit('modal');
      };
      return {
        move: (mx) => { moved = true; setLive(start + (mx - x) * p0.drag); },
        end: () => { if (!moved) this.confirmModal(); else if (pm.heavy) pm.run(pm.params.map((q) => q.value)); },
        cancel: () => this.setParam(0, start),
      };
    }

    // 2. sculpt
    if (this.mode === 'sculpt') return this.beginSculpt(x, y, p);

    // 2b. knife: any single-pointer drag draws a cut line
    if (this.isEditLike && this.tool === 'knife') return this.knifeHandler(x, y, p);

    // 3. gizmo
    if (this.settings.gizmo !== 'none') {
      const h = this.gizmo.hit(x, y, p.type === 'touch' ? 26 : 14);
      if (h) return this.gizmoDrag(h, x, y);
    }

    // 4. tweak (drag an element directly)
    if (this.isEditLike && this.tool === 'select' && this.settings.tweak) {
      const t = this.tweakHandler(x, y, p);
      if (t) return t;
    }
    if (this.mode === 'object' && p.type !== 'touch') {
      const hit = this.vp.pickObject(this.scene, x, y);
      if (hit && this.scene.selected.has(hit.obj.id)) return this.dragToMove(x, y, p, () => {});
    }
    return null;
  }

  private gizmoDrag(h: GizmoHandle, x: number, y: number): ToolHandler {
    this.activeHandle = h;
    const s = this.startTransform(h.kind, 'drag', h.axis);
    if (!s) return { move() {}, end() {}, cancel() {} };
    s.beginDrag(x, y);
    return {
      move: (mx, my) => s.drag(mx, my),
      end: () => { this.confirmModal(); },
      cancel: () => this.cancelModal(),
    };
  }

  /** Pointer down on an element: tap selects, drag moves it. */
  private tweakHandler(x: number, y: number, p: PInfo): ToolHandler | null {
    const a = this.editObj!;
    const m = a.mesh;
    const r = this.pickRadius(p);
    let onSelected = false;
    let selectIt: (() => void) | null = null;
    if (this.selectMode === 'vert') {
      const v = this.pickVertex(x, y, r);
      if (v < 0) return null;
      onSelected = m.selV.has(v);
      selectIt = () => { if (!onSelected) { if (this.selOp !== 'add' && !p.shift) m.clearSelection(); m.selV.add(v); m.flush('vert'); } };
    } else if (this.selectMode === 'edge') {
      const k = this.pickEdge(x, y, r);
      if (!k || !m.selE.has(k)) return null;
      onSelected = true;
    } else {
      const f = this.pickFace(x, y);
      if (f < 0 || !m.selF.has(f)) return null;
      onSelected = true;
    }
    if (p.type === 'touch' && this.selectMode !== 'vert' && !onSelected) return null;
    return this.dragToMove(x, y, p, () => selectIt?.());
  }

  /** Generic: no-move = tap (select), move beyond slop = start a free move. */
  private dragToMove(x: number, y: number, p: PInfo, beforeMove: () => void): ToolHandler {
    let s: TransformSession | null = null;
    const slop = p.type === 'touch' ? 10 : p.type === 'pen' ? 8 : 5;
    return {
      move: (mx, my) => {
        if (!s) {
          if (Math.hypot(mx - x, my - y) < slop) return;
          beforeMove();
          this.changed();
          s = this.startTransform('move', 'drag');
          s?.beginDrag(x, y);
        }
        s?.drag(mx, my);
      },
      end: (ex, ey, ep) => {
        if (s) this.confirmModal();
        else this.tap(ex, ey, ep, 1);
      },
      cancel: () => { if (s) this.cancelModal(); },
    };
  }

  private beginSculpt(x: number, y: number, p: PInfo): ToolHandler | null {
    const a = this.active;
    if (!a) return null;
    this.record(`Sculpt ${this.brush.type}`);
    this.stroking = true;
    const stroke = new SculptStroke(a, this.vp, this.brush,
      () => { this.redraw(); },
      (changed) => {
        this.stroking = false;
        if (!changed) this.history.cancelLast();
        else if (stroke.limitHit) this.status('Dynamic topology paused: face limit reached');
        else if (stroke.added) this.status(`+${stroke.added} faces · ${a.mesh.faces.length} total`);
        this.changed();
      },
      () => { this.stroking = false; this.revertLast(); },
      () => this.keyInvert,
    );
    const hit = stroke.begin(x, y, p);
    if (!hit && p.type === 'touch') { this.stroking = false; this.history.cancelLast(); return null; }
    this.redraw();
    const self = this;
    return {
      move(mx, my, mp) { self.hover = { x: mx, y: my, type: mp.type }; stroke.move(mx, my, mp); },
      end(ex, ey, ep) { stroke.end(ex, ey, ep); },
      cancel() { stroke.cancel(); },
    };
  }

  private beginBox(x: number, y: number, p: PInfo): ToolHandler | null {
    if (this.mode === 'sculpt' || this.modal) return null;
    if (this.isEditLike && this.tool === 'loopcut') return null;
    this.box = { x0: x, y0: y, x1: x, y1: y };
    const op: SelOp = p.shift ? 'add' : p.ctrl ? 'sub' : this.selOp;
    return {
      move: (mx, my) => { this.box!.x1 = mx; this.box!.y1 = my; this.vp.requestRender(); },
      end: () => { const b = this.box!; this.box = null; this.boxSelect(b, op); },
      cancel: () => { this.box = null; this.vp.requestRender(); },
    };
  }

  private tap(x: number, y: number, p: PInfo, count: number) {
    if (this.modal) { this.confirmModal(); return; }
    const op: SelOp = p.shift ? 'add' : p.ctrl ? 'sub' : this.selOp;
    if (this.mode === 'object') {
      const hit = this.vp.pickObject(this.scene, x, y);
      if (hit && count >= 2 && hit.obj.id === this.scene.activeId && op === 'set') { this.setMode('edit'); return; }
      this.selectObject(hit?.obj ?? null, op);
      return;
    }
    if (this.mode === 'sculpt') return;
    const a = this.editObj;
    if (!a) return;
    if (this.tool === 'loopcut') {
      const k = this.pickEdge(x, y, this.pickRadius(p) + 10);
      if (k) this.loopCutAt(k);
      return;
    }
    if (this.tool === 'knife') return;
    this.selectAt(x, y, p, op, count);
  }

  private onHover(x: number, y: number, p: PInfo | null) {
    this.hover = p && x >= 0 ? { x, y, type: p.type } : null;
    // gizmo hot state
    const prevHot = this.gizmo.hot;
    this.gizmo.hot = this.hover && !this.modal ? this.gizmo.hit(x, y, p?.type === 'pen' ? 14 : 12) : null;
    // mouse/key-driven modal
    if (this.modal?.kind === 'transform' && this.modal.flavor === 'key' && this.hover && p?.type !== 'touch') {
      this.modal.session.drag(x, y);
      return;
    }
    // preselection (pen / mouse hover)
    const a = this.editObj;
    const prevPre = JSON.stringify(this.preselect);
    this.preselect = null;
    this.loopPreview = null;
    if (a && this.hover && !this.modal && !this.gizmo.hot) {
      const r = this.pickRadius(p!);
      if (this.tool === 'loopcut') {
        const k = this.pickEdge(x, y, r + 10);
        if (k) this.loopPreview = this.loopPreviewFor(k);
      } else if (this.selectMode === 'vert') { const v = this.pickVertex(x, y, r); if (v >= 0) this.preselect = { kind: 'vert', id: v }; }
      else if (this.selectMode === 'edge') { const k = this.pickEdge(x, y, r); if (k) this.preselect = { kind: 'edge', id: k }; }
    }
    if (this.mode === 'sculpt' || this.tool === 'loopcut' || prevPre !== JSON.stringify(this.preselect) || prevHot !== this.gizmo.hot) this.vp.requestRender();
    else this.vp.requestRender();
  }

  /* ================================================================ picking */
  private projCache: { key: string; pts: Float32Array; vis: Uint8Array } | null = null;

  /** Screen positions + visibility of the edit object's vertices. */
  private projected(): { pts: Float32Array; vis: Uint8Array } | null {
    const a = this.editObj;
    if (!a) return null;
    const m = a.mesh;
    this.vp.cam.update();
    const camKey = this.vp.cam.camera.matrixWorld.elements.map((x) => x.toFixed(5)).join(',') + this.vp.cam.distance + this.vp.width + this.vp.height + this.vp.cam.ortho;
    const key = `${a.id}|${m.version}|${camKey}|${this.vp.settings.xray}|${a.position}|${a.rotation}|${a.scale}`;
    if (this.projCache?.key === key) return this.projCache;
    const M = this.vp.objectMatrix(a);
    const n = m.verts.length;
    const pts = new Float32Array(n * 2);
    const vis = new Uint8Array(n);
    const w = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      w.set(...m.verts[i]).applyMatrix4(M);
      const s = this.vp.project(w);
      pts[i * 2] = s.x; pts[i * 2 + 1] = s.y;
      vis[i] = s.behind ? 0 : this.vp.settings.xray ? 1 : this.vp.isVisible(w) ? 1 : 0;
    }
    this.projCache = { key, pts, vis };
    return this.projCache;
  }

  pickVertex(x: number, y: number, r: number): number {
    const P = this.projected();
    if (!P) return -1;
    let best = -1, bd = r;
    for (let i = 0; i < P.vis.length; i++) {
      if (!P.vis[i]) continue;
      const d = Math.hypot(P.pts[i * 2] - x, P.pts[i * 2 + 1] - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  pickEdge(x: number, y: number, r: number): string | null {
    const P = this.projected();
    const a = this.editObj;
    if (!P || !a) return null;
    let best: string | null = null, bd = r;
    const M = this.vp.objectMatrix(a);
    for (const e of a.mesh.edges) {
      const ax = P.pts[e.a * 2], ay = P.pts[e.a * 2 + 1], bx = P.pts[e.b * 2], by = P.pts[e.b * 2 + 1];
      const d = segDist(x, y, ax, ay, bx, by);
      if (d >= bd) continue;
      if (!this.vp.settings.xray && !P.vis[e.a] && !P.vis[e.b]) {
        // check midpoint visibility for long edges whose ends are hidden
        const mid = v3(a.mesh.verts[e.a]).add(v3(a.mesh.verts[e.b])).multiplyScalar(0.5).applyMatrix4(M);
        if (!this.vp.isVisible(mid)) continue;
      }
      bd = d; best = e.key;
    }
    return best;
  }

  pickFace(x: number, y: number): number {
    const a = this.editObj;
    if (!a) return -1;
    if (this.vp.settings.xray) {
      // nearest face centre in screen space, preferring the face under the cursor
      const P = this.projected()!;
      let best = -1, bd = 40;
      a.mesh.faces.forEach((f, fi) => {
        let cx = 0, cy = 0;
        for (const v of f.v) { cx += P.pts[v * 2]; cy += P.pts[v * 2 + 1]; }
        cx /= f.v.length; cy /= f.v.length;
        const inside = pointInPoly(x, y, f.v.map((v) => [P.pts[v * 2], P.pts[v * 2 + 1]]));
        const d = Math.hypot(cx - x, cy - y) * (inside ? 0.25 : 1);
        if (d < bd) { bd = d; best = fi; }
      });
      return best;
    }
    const hit = this.vp.pickCageFace(a, x, y);
    return hit ? hit.face : -1;
  }

  private selectAt(x: number, y: number, p: PInfo, op: SelOp, count: number) {
    const a = this.editObj!;
    const m = a.mesh;
    const r = this.pickRadius(p);
    // set: replace · add: toggle (so a misplaced tap can be undone by tapping again) · sub: remove
    const apply = <T>(set: Set<T>, id: T) => {
      if (op === 'set') { m.clearSelection(); set.add(id); }
      else if (op === 'add') { if (set.has(id)) set.delete(id); else set.add(id); }
      else set.delete(id);
    };
    if (this.selectMode === 'vert') {
      const v = this.pickVertex(x, y, r);
      if (v < 0) { if (op === 'set') m.clearSelection(); }
      else {
        if (count >= 2) { m.selV.add(v); ops.selectLinked(m, 'vert'); }
        else apply(m.selV, v);
      }
      m.flush('vert');
    } else if (this.selectMode === 'edge') {
      const k = this.pickEdge(x, y, r);
      if (!k) { if (op === 'set') m.clearSelection(); }
      else if (count >= 2 || p.alt) {
        const loop = ops.edgeLoop(m, k);
        if (op === 'set') m.clearSelection();
        for (const e of loop) { if (op === 'sub') m.selE.delete(e); else m.selE.add(e); }
      } else apply(m.selE, k);
      m.flush('edge');
    } else {
      const f = this.pickFace(x, y);
      if (f < 0) { if (op === 'set') m.clearSelection(); }
      else if (count >= 2) {
        m.selF.add(f); m.flush('face'); ops.selectLinked(m, 'face');
        m.flush('vert');
      } else apply(m.selF, f);
      if (count < 2) m.flush('face');
    }
    this.changed();
  }

  private boxSelect(b: { x0: number; y0: number; x1: number; y1: number }, op: SelOp) {
    const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
    const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    if (Math.abs(x1 - x0) < 3 && Math.abs(y1 - y0) < 3) { this.vp.requestRender(); return; }
    if (this.mode === 'object') {
      if (op === 'set') this.scene.selected.clear();
      for (const o of this.scene.objects) {
        if (!o.visible) continue;
        const M = this.vp.objectMatrix(o);
        const box = new THREE.Box3();
        for (const p of o.mesh.verts) box.expandByPoint(v3(p).applyMatrix4(M));
        const s = this.vp.project(box.getCenter(new THREE.Vector3()));
        if (inside(s.x, s.y)) { if (op === 'sub') this.scene.selected.delete(o.id); else this.scene.selected.add(o.id); }
      }
      if (!this.scene.selected.has(this.scene.activeId ?? '')) this.scene.activeId = [...this.scene.selected][0] ?? this.scene.activeId;
      this.changed();
      return;
    }
    const a = this.editObj;
    if (!a) return;
    const m = a.mesh;
    const P = this.projected()!;
    if (op === 'set') m.clearSelection();
    if (this.selectMode === 'vert') {
      for (let i = 0; i < P.vis.length; i++) if (P.vis[i] && inside(P.pts[i * 2], P.pts[i * 2 + 1])) { if (op === 'sub') m.selV.delete(i); else m.selV.add(i); }
      m.flush('vert');
    } else if (this.selectMode === 'edge') {
      for (const e of m.edges) {
        if (!P.vis[e.a] || !P.vis[e.b]) continue;
        if (inside(P.pts[e.a * 2], P.pts[e.a * 2 + 1]) && inside(P.pts[e.b * 2], P.pts[e.b * 2 + 1])) { if (op === 'sub') m.selE.delete(e.key); else m.selE.add(e.key); }
      }
      m.flush('edge');
    } else {
      const M = this.vp.objectMatrix(a);
      m.faces.forEach((f, fi) => {
        const c = v3(m.faceCenter(fi)).applyMatrix4(M);
        const s = this.vp.project(c);
        if (!inside(s.x, s.y)) return;
        if (!this.vp.settings.xray && !this.vp.isVisible(c) && !f.v.some((v) => P.vis[v])) return;
        if (op === 'sub') m.selF.delete(fi); else m.selF.add(fi);
      });
      m.flush('face');
    }
    this.changed();
  }

  selectObject(o: SceneObject | null, op: SelOp = 'set') {
    if (!o) { if (op === 'set') this.scene.selected.clear(); }
    else if (op === 'set') { this.scene.selected = new Set([o.id]); this.scene.activeId = o.id; }
    else if (op === 'add') {
      if (this.scene.selected.has(o.id) && this.scene.activeId === o.id) this.scene.selected.delete(o.id);
      else { this.scene.selected.add(o.id); this.scene.activeId = o.id; }
    } else this.scene.selected.delete(o.id);
    this.changed();
  }

  /* ================================================================ overlay */
  private drawOverlay() {
    const ctx = this.overlay;
    const dpr = this.vp.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // gizmo
    const showGizmo = this.settings.gizmo !== 'none' && (this.mode === 'object' || this.isEditLike) && (!this.modal || (this.modal.kind === 'transform' && this.modal.flavor === 'drag'));
    const pivot = showGizmo ? (this.modal?.kind === 'transform' ? this.modal.session.pivot.clone().applyMatrix4(this.modal.session.matrix()) : this.selectionPivot()) : null;
    this.gizmo.update(this.vp, pivot, this.settings.gizmo);
    this.gizmo.draw(ctx, this.activeHandle);
    // modal pivot guide
    if (this.modal?.kind === 'transform' && this.modal.flavor !== 'drag') {
      const s = this.modal.session;
      const pc = this.vp.project(s.pivot.clone().applyMatrix4(s.matrix()));
      ctx.fillStyle = '#ffd27a';
      ctx.beginPath(); ctx.arc(pc.x, pc.y, 4, 0, Math.PI * 2); ctx.fill();
      const av = s.axisVector();
      if (av) {
        const a = this.vp.project(s.pivot.clone().addScaledVector(av, -1000)), b = this.vp.project(s.pivot.clone().addScaledVector(av, 1000));
        const p0 = this.vp.project(s.pivot);
        ctx.strokeStyle = s.axis === 'x' ? '#ee4b55' : s.axis === 'y' ? '#7ccf3a' : s.axis === 'z' ? '#4a86f0' : '#ffd27a';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        // draw a long line through the pivot along the axis direction (clip-safe)
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
        ctx.moveTo(p0.x - (dx / l) * 4000, p0.y - (dy / l) * 4000);
        ctx.lineTo(p0.x + (dx / l) * 4000, p0.y + (dy / l) * 4000);
        ctx.stroke();
      }
    }
    // box select
    if (this.box) {
      const b = this.box;
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    // preselection
    const a = this.editObj;
    if (a && this.preselect) {
      const M = this.vp.objectMatrix(a);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      if (this.preselect.kind === 'vert') {
        const s = this.vp.project(v3(a.mesh.verts[this.preselect.id as number]).applyMatrix4(M));
        ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, Math.PI * 2); ctx.stroke();
      } else if (this.preselect.kind === 'edge') {
        const [i, j] = parseKey(this.preselect.id as string);
        if (a.mesh.verts[i] && a.mesh.verts[j]) {
          const s1 = this.vp.project(v3(a.mesh.verts[i]).applyMatrix4(M)), s2 = this.vp.project(v3(a.mesh.verts[j]).applyMatrix4(M));
          ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y); ctx.stroke();
        }
      }
    }
    // knife line
    if (this.knifeLine) {
      const k = this.knifeLine;
      ctx.strokeStyle = '#ffe14d';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(k.x0, k.y0); ctx.lineTo(k.x1, k.y1); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffe14d';
      for (const h of k.hits) ctx.fillRect(h.x - 3.5, h.y - 3.5, 7, 7);
    }
    // proportional editing radius
    if (this.modal?.kind === 'transform' && this.modal.session.target.kind === 'verts' && this.modal.session.target.prop) {
      const s = this.modal.session;
      const c = s.pivot.clone().applyMatrix4(s.matrix());
      const pc = this.vp.project(c);
      const right = new THREE.Vector3().setFromMatrixColumn(this.vp.cam.camera.matrixWorld, 0);
      const pe = this.vp.project(c.clone().addScaledVector(right, this.settings.proportional.radius));
      const r = Math.hypot(pe.x - pc.x, pe.y - pc.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(pc.x, pc.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    // loop cut preview
    if (a && this.loopPreview) {
      const M = this.vp.objectMatrix(a);
      ctx.strokeStyle = '#ffe14d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [p, q] of this.loopPreview) {
        const s1 = this.vp.project(v3(p).applyMatrix4(M)), s2 = this.vp.project(v3(q).applyMatrix4(M));
        ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
      }
      ctx.stroke();
    }
    // sculpt brush cursor
    if (this.mode === 'sculpt' && this.hover) {
      let r = this.brush.radius;
      ctx.strokeStyle = this.brush.invert !== this.keyInvert ? '#6fb6ff' : '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(this.hover.x, this.hover.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 0.5;
      r *= 0.5;
      ctx.beginPath(); ctx.arc(this.hover.x, this.hover.y, r * this.brush.strength, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private loopPreviewFor(k: string): [V3, V3][] {
    const a = this.editObj!;
    const ring = ops.edgeRing(a.mesh, k);
    const res: [V3, V3][] = [];
    const mid = (e: [number, number]) => { const p = a.mesh.verts[e[0]], q = a.mesh.verts[e[1]]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2] as V3; };
    for (let i = 0; i + 1 < ring.edges.length; i++) res.push([mid(ring.edges[i]), mid(ring.edges[i + 1])]);
    if (ring.closed && ring.edges.length > 2) res.push([mid(ring.edges[ring.edges.length - 1]), mid(ring.edges[0])]);
    if (ring.edges.length === 1) {
      // single edge with no quad ring: show the edge itself
      const e = ring.edges[0];
      res.push([a.mesh.verts[e[0]], a.mesh.verts[e[1]]]);
    }
    return res;
  }

  /* ================================================================ object-mode actions */
  addPrimitive(type: PrimitiveType) {
    this.confirmModal();
    const label = PRIMITIVES.find((p) => p.type === type)!.label;
    if (this.isEditLike && this.active) {
      // add into the edited mesh
      this.record(`Add ${label}`);
      const a = this.active;
      const prim = createPrimitive(type);
      const M = this.vp.objectMatrix(a).invert();
      const t = this.vp.cam.target.clone().applyMatrix4(M);
      const off = a.mesh.verts.length;
      a.mesh.clearSelection();
      prim.verts.forEach((p) => { a.mesh.verts.push([p[0] + t.x, p[1] + t.y, p[2] + t.z]); a.mesh.selV.add(a.mesh.verts.length - 1); });
      for (const f of prim.faces) a.mesh.faces.push({ v: f.v.map((v) => v + off), uv: f.uv });
      for (const [x, y] of prim.looseEdges) a.mesh.looseEdges.push([x + off, y + off]);
      a.mesh.changed();
      a.mesh.flush('vert');
      if (this.selectMode === 'face') a.mesh.flush('vert');
      this.changed();
      return;
    }
    if (this.mode !== 'object') this.setMode('object');
    this.record(`Add ${label}`);
    const o = new SceneObject(this.scene.uniqueName(label.replace(/\s/g, '')), createPrimitive(type));
    const t = this.vp.cam.target;
    o.position = [round(t.x), round(t.y), round(t.z)];
    if (this.settings.snap.enabled) o.position = o.position.map((x) => Math.round(x / this.settings.snap.move) * this.settings.snap.move) as V3;
    this.scene.add(o);
    this.changed();
    this.status(`Added ${label}`);
  }

  deleteObjects() {
    const objs = this.selectedObjects();
    if (!objs.length) return;
    this.record('Delete');
    for (const o of objs) this.scene.remove(o.id);
    this.changed();
  }

  duplicateObjects() {
    const objs = this.selectedObjects();
    if (!objs.length) return;
    this.record('Duplicate');
    this.scene.selected.clear();
    for (const o of objs) {
      const c = SceneObject.fromJSON({ ...o.toJSON(), id: undefined as any });
      c.name = this.scene.uniqueName(o.name.replace(/\.\d+$/, ''));
      this.scene.add(c, false);
      this.scene.selected.add(c.id);
      this.scene.activeId = c.id;
    }
    this.changed();
    this.startTransform('move', 'button', null, null, { skipRecord: true, onCancel: () => this.revertLast() });
  }

  joinObjects() {
    const objs = this.selectedObjects();
    const a = this.active;
    if (objs.length < 2 || !a) { this.status('Select 2+ objects (active receives)'); return; }
    this.record('Join');
    const Ainv = this.vp.objectMatrix(a).invert();
    for (const o of objs) {
      if (o === a) continue;
      const M = Ainv.clone().multiply(this.vp.objectMatrix(o));
      const m = o.mesh;
      const off = a.mesh.verts.length;
      for (const p of m.verts) { const v = v3(p).applyMatrix4(M); a.mesh.verts.push([v.x, v.y, v.z]); }
      for (const f of m.faces) a.mesh.faces.push({ v: f.v.map((x) => x + off), uv: f.uv.map((u) => [u[0], u[1]]) });
      for (const [x, y] of m.looseEdges) a.mesh.looseEdges.push([x + off, y + off]);
      for (const k of m.seams) { const [x, y] = parseKey(k); a.mesh.seams.add(ekey(x + off, y + off)); }
      // flip faces if the joined object's transform mirrors geometry
      if (M.determinant() < 0) for (let i = a.mesh.faces.length - m.faces.length; i < a.mesh.faces.length; i++) { a.mesh.faces[i].v.reverse(); a.mesh.faces[i].uv.reverse(); }
      this.scene.remove(o.id);
    }
    a.mesh.changed();
    this.scene.selected = new Set([a.id]);
    this.scene.activeId = a.id;
    this.changed();
  }

  /** Apply object transform into mesh vertices. */
  applyTransform(which: 'all' | 'rotscale' | 'location' = 'all') {
    const objs = this.selectedObjects();
    if (!objs.length) return;
    this.record('Apply Transform');
    for (const o of objs) {
      const full = this.vp.objectMatrix(o);
      let M: THREE.Matrix4;
      if (which === 'all') M = full;
      else if (which === 'location') M = new THREE.Matrix4().makeTranslation(...o.position);
      else M = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion().setFromEuler(new THREE.Euler(...o.rotation, 'XYZ')), v3(o.scale));
      o.mesh.verts = o.mesh.verts.map((p) => { const v = v3(p).applyMatrix4(M); return [v.x, v.y, v.z] as V3; });
      if (M.determinant() < 0) ops.flipFaces(o.mesh, o.mesh.faces.map((_, i) => i));
      if (which === 'all' || which === 'location') o.position = [0, 0, 0];
      if (which === 'all' || which === 'rotscale') { o.rotation = [0, 0, 0]; o.scale = [1, 1, 1]; }
      o.mesh.changed();
    }
    this.changed();
  }

  /** Move object origin: to geometry centre, or to 3D cursor (view target). */
  setOrigin(to: 'geometry' | 'cursor' | 'bottom') {
    const objs = this.selectedObjects();
    if (!objs.length) return;
    this.record('Set Origin');
    for (const o of objs) {
      if (!o.mesh.verts.length) continue;
      const M = this.vp.objectMatrix(o);
      let newOriginWorld: THREE.Vector3;
      if (to === 'cursor') newOriginWorld = this.vp.cam.target.clone();
      else {
        const box = new THREE.Box3();
        for (const p of o.mesh.verts) box.expandByPoint(v3(p));
        const c = box.getCenter(new THREE.Vector3());
        if (to === 'bottom') c.y = box.min.y;
        newOriginWorld = c.applyMatrix4(M);
      }
      const local = newOriginWorld.clone().applyMatrix4(M.clone().invert());
      o.mesh.verts = o.mesh.verts.map((p) => [p[0] - local.x, p[1] - local.y, p[2] - local.z] as V3);
      o.position = [newOriginWorld.x, newOriginWorld.y, newOriginWorld.z];
      o.mesh.touch();
    }
    this.changed();
  }

  setShading(smooth: boolean) {
    const objs = this.mode === 'object' ? this.selectedObjects() : this.active ? [this.active] : [];
    if (!objs.length) return;
    this.record(smooth ? 'Shade Smooth' : 'Shade Flat');
    for (const o of objs) o.smooth = smooth;
    this.changed();
  }

  addModifier(type: ModifierType) {
    const a = this.active;
    if (!a) return;
    this.record(`Add ${type}`);
    a.modifiers.push(newModifier(type, a.mesh));
    this.changed();
  }

  applyModifiers(id?: string) {
    const a = this.active;
    if (!a) return;
    this.record('Apply Modifier');
    const idx = id ? a.modifiers.findIndex((m) => m.id === id) : a.modifiers.length - 1;
    const toApply = a.modifiers.slice(0, idx + 1).filter((m) => m.enabled);
    const res = evaluate(a.mesh, toApply);
    a.mesh = res === a.mesh ? a.mesh : res;
    a.mesh.clearSelection();
    a.mesh.changed();
    a.modifiers = a.modifiers.slice(idx + 1);
    this.changed();
  }

  /** One-shot remesh of the active object's mesh (edit, sculpt or object mode). */
  remeshOp(mode: RemeshMode) {
    const a = this.active;
    if (!a || !a.mesh.faces.length) { this.status('Remesh needs a mesh with faces'); return; }
    const isVoxel = mode !== 'isotropic';
    const size = defaultRemeshSize(a.mesh, mode === 'blocks' ? 1 / 16 : mode === 'isotropic' ? 1 / 30 : 1 / 48);
    const step = Math.max(0.0005, Math.round(size * 0.2 * 1e4) / 1e4);
    const params: ParamDef[] = [{ name: isVoxel ? 'Voxel size' : 'Edge length', value: size, min: size / 20, max: size * 20, step, drag: step * 0.05, }];
    if (mode === 'voxel') params.push({ name: 'Smooth', value: 1, min: 0, max: 8, step: 1, drag: 0.03, int: true }, { name: 'Project', value: 1, min: 0, max: 1, step: 1, drag: 0.02, int: true });
    if (mode === 'isotropic') params.push({ name: 'Iterations', value: 4, min: 1, max: 12, step: 1, drag: 0.03, int: true }, { name: 'Quads', value: 0, min: 0, max: 1, step: 1, drag: 0.02, int: true });
    const info: RemeshInfo = { size: 0, clamped: false };
    const label = mode === 'voxel' ? 'Voxel Remesh' : mode === 'blocks' ? 'Blocks Remesh' : 'Isotropic Remesh';
    this.startParamOp(label, params, (m, v) => remesh(m, { mode, size: v[0], smooth: v[1], project: v[2] === 1, iterations: v[1], quads: v[2] === 1 }, info),
      { heavy: true, report: (m) => `${label}: ${m.faces.length} faces${info.clamped ? ` (voxel size raised to ${info.size.toFixed(4)} — grid limit)` : ''}` });
  }

  /** One-shot decimate of the active object's mesh. */
  decimateOp(mode: DecimateMode) {
    const a = this.active;
    if (!a || !a.mesh.faces.length) { this.status('Decimate needs a mesh with faces'); return; }
    const before = a.mesh.faces.length;
    let params: ParamDef[];
    if (mode === 'collapse') params = [{ name: 'Ratio', value: 0.5, min: 0.01, max: 1, step: 0.05, drag: 0.002 }, { name: 'Quads', value: 1, min: 0, max: 1, step: 1, drag: 0.02, int: true }];
    else if (mode === 'unsubdivide') params = [{ name: 'Levels', value: 1, min: 1, max: 6, step: 1, drag: 0.03, int: true }];
    else params = [{ name: 'Angle°', value: 5, min: 0.1, max: 60, step: 1, drag: 0.1 }, { name: 'Seams', value: 0, min: 0, max: 1, step: 1, drag: 0.02, int: true }];
    const label = mode === 'collapse' ? 'Decimate' : mode === 'unsubdivide' ? 'Un-subdivide' : 'Planar Decimate';
    this.startParamOp(label, params, (m, v) => {
      if (mode === 'unsubdivide') {
        let r = m; let n = 0;
        for (let i = 0; i < v[0]; i++) { const u = unsubdivide(r); if (!u) break; r = u; n++; }
        if (!n) this.status('Un-subdivide needs an all-quad mesh made by subdividing', 4000);
        return r;
      }
      return decimate(m, mode === 'collapse' ? { mode, ratio: v[0], quads: v[1] === 1 } : { mode, angle: v[0], delimitSeams: v[1] === 1 });
    }, { heavy: true, report: (m) => `${label}: ${before} → ${m.faces.length} faces` });
  }

  /** Convert the evaluated object to a mesh copy and edit the subdivided result (sculpt prep). */
  subdivideForSculpt(levels = 1) {
    const a = this.active;
    if (!a) return;
    this.record('Subdivide Mesh');
    let m = a.mesh;
    for (let i = 0; i < levels; i++) m = evaluate(m, [{ id: 'tmp', type: 'subsurf', enabled: true, levels: 1 }]);
    a.mesh = m;
    a.mesh.changed();
    this.status(`${a.mesh.faces.length} faces`);
    this.changed();
  }

  /* ================================================================ edit-mode actions */
  private editOp(label: string, fn: (m: Mesh) => boolean | void): boolean {
    const a = this.editObj;
    if (!a) return false;
    this.confirmModal();
    this.record(label);
    const res = fn(a.mesh);
    if (res === false) { this.history.cancelLast(); this.changed(); return false; }
    this.changed();
    return true;
  }

  extrude(flavor: 'button' | 'key' = 'button') {
    const a = this.editObj;
    if (!a) return;
    const m = a.mesh;
    if (!m.selV.size) { this.status('Select something to extrude'); return; }
    this.confirmModal();
    this.record('Extrude');
    const r = this.selectMode === 'face' || (m.selF.size && this.selectMode === 'vert' && [...m.selV].every((v) => m.vertFaces(v).some((f) => m.selF.has(f))))
      ? ops.extrudeFaces(m) : ops.extrudeEdges(m);
    if (this.selectMode === 'face') m.flush('face');
    this.changed();
    const axis: Axis = r.normal ? 'n' : null;
    this.startTransform('move', flavor, axis, r.normal, { skipRecord: true, label: 'Extrude', onCancel: () => this.revertLast() });
  }

  inset() {
    const a = this.editObj;
    if (!a || !a.mesh.selF.size) { this.status('Select faces to inset'); return; }
    this.startParamOp('Inset', [
      { name: 'Amount', value: 0.2, min: 0, max: 0.99, step: 0.05, drag: 0.004 },
      { name: 'Depth', value: 0, min: -10, max: 10, step: 0.05, drag: 0.01 },
    ], (m, v) => { const h = ops.insetFaces(m); h?.set(v[0], v[1]); });
  }

  loopCutAt(k: string) {
    this.loopPreview = null;
    this.startParamOp('Loop Cut', [
      { name: 'Slide', value: 0, min: -0.98, max: 0.98, step: 0.05, drag: 0.005 },
      { name: 'Cuts', value: 1, min: 1, max: 16, step: 1, drag: 0.05, int: true },
    ], (m, v) => { const h = ops.loopCut(m, k, v[1]); if (h && v[1] === 1) h.set(v[0]); });
    this.selectMode = 'edge';
    this.emit('mode');
  }

  /** Loop cut on the selected edge (when not using the tap tool). */
  loopCutSelected() {
    const a = this.editObj;
    if (!a) return;
    const k = [...a.mesh.selE][0];
    if (!k) { this.setTool('loopcut'); this.status('Tap an edge to cut a loop across it'); return; }
    this.loopCutAt(k);
  }

  subdivide() {
    const a = this.editObj;
    if (!a) return;
    if (this.selectMode !== 'face' && a.mesh.selE.size && !a.mesh.selF.size) {
      this.startParamOp('Subdivide Edges', [{ name: 'Cuts', value: 1, min: 1, max: 10, step: 1, drag: 0.03, int: true }], (m, v) => ops.subdivideEdges(m, v[0]));
      return;
    }
    if (!a.mesh.selF.size) { this.status('Select faces or edges'); return; }
    this.startParamOp('Subdivide', [{ name: 'Smooth', value: 0, min: 0, max: 1, step: 0.1, drag: 0.004 }], (m, v) => { ops.subdivideFaces(m); if (v[0] > 0) ops.smoothVerts(m, [...m.selV], v[0], 1); });
  }

  /** Bevel selected edges (or vertices in vertex mode when no edges are selected). */
  bevel(vertexOnly?: boolean) {
    const a = this.editObj;
    if (!a) return;
    const m = a.mesh;
    const vOnly = vertexOnly ?? (this.selectMode === 'vert' && m.selE.size === 0);
    if (vOnly ? !m.selV.size : !m.selE.size) { this.status(vOnly ? 'Select vertices to bevel' : 'Select edges to bevel'); return; }
    // default width: 15% of the average selected edge length
    let tot = 0, n = 0;
    for (const k of m.selE) { const [x, y] = parseKey(k); const p = m.verts[x], q = m.verts[y]; tot += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); n++; }
    if (!n) for (const v of m.selV) for (const u of m.vertNeighbors(v)) { const p = m.verts[v], q = m.verts[u]; tot += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); n++; }
    const base = n ? tot / n : 1;
    const w0 = Math.round(base * 0.15 * 1000) / 1000 || 0.05;
    this.startParamOp(vOnly ? 'Bevel Vertices' : 'Bevel', [
      { name: 'Width', value: w0, min: 0, max: base * 10, step: Math.max(0.001, Math.round(base * 0.02 * 1000) / 1000), drag: Math.max(0.0005, this.vp.cam.worldPerPixel(this.vp.height) * 0.5) },
      { name: 'Segments', value: 1, min: 1, max: 12, step: 1, drag: 0.03, int: true },
    ], (mm, v) => { bevelOp(mm, { width: v[0], segments: v[1], vertexOnly: vOnly }); });
    this.selectMode = 'face';
    this.emit('mode');
  }

  /** Knife: drag a straight line across the mesh; faces it crosses are cut. */
  private knifeHandler(x: number, y: number, p: PInfo): ToolHandler {
    const r = this.pickRadius(p);
    const snapV = this.pickVertex(x, y, r);
    const start = snapV >= 0 ? this.screenOf(snapV) : { x, y };
    this.knifeLine = { x0: start.x, y0: start.y, x1: start.x, y1: start.y, hits: [] };
    let cur = { x, y };
    const update = (mx: number, my: number, mp: PInfo) => {
      const ev = this.pickVertex(mx, my, this.pickRadius(mp));
      cur = ev >= 0 ? this.screenOf(ev) : { x: mx, y: my };
      const hits = this.knifeHits(start.x, start.y, cur.x, cur.y, snapV, ev);
      this.knifeLine = { x0: start.x, y0: start.y, x1: cur.x, y1: cur.y, hits: hits.map((h) => ({ x: h.sx, y: h.sy })) };
      this.vp.requestRender();
    };
    return {
      move: (mx, my, mp) => update(mx, my, mp),
      end: (ex, ey, ep) => {
        update(ex, ey, ep);
        const ev = this.pickVertex(ex, ey, this.pickRadius(ep));
        const hits = this.knifeHits(start.x, start.y, cur.x, cur.y, snapV, ev);
        this.knifeLine = null;
        if (hits.length < 2) { this.vp.requestRender(); if (Math.hypot(ex - x, ey - y) > 8) this.status('Knife: the line must cross at least two edges of a face'); return; }
        let cuts = 0;
        this.editOp('Knife', (m) => { cuts = ops.knifeCut(m, hits.map((h) => h.hit)); if (!cuts) { this.status('Knife: nothing to cut'); return false; } });
        if (cuts) { this.selectMode = 'edge'; this.emit('mode'); this.status(`Knife: ${cuts} face${cuts > 1 ? 's' : ''} cut`); }
      },
      cancel: () => { this.knifeLine = null; this.vp.requestRender(); },
    };
  }

  private screenOf(v: number) {
    const a = this.editObj!;
    const s = this.vp.project(v3(a.mesh.verts[v]).applyMatrix4(this.vp.objectMatrix(a)));
    return { x: s.x, y: s.y };
  }

  /** Intersections of the screen segment with visible mesh edges, ordered along the line. */
  private knifeHits(x0: number, y0: number, x1: number, y1: number, startV: number, endV: number) {
    const a = this.editObj!;
    const m = a.mesh;
    const P = this.projected()!;
    const M = this.vp.objectMatrix(a);
    const out: { s: number; sx: number; sy: number; hit: ops.KnifeHit }[] = [];
    if (startV >= 0) out.push({ s: 0, sx: x0, sy: y0, hit: { vert: startV } });
    if (endV >= 0 && endV !== startV) out.push({ s: 1, sx: x1, sy: y1, hit: { vert: endV } });
    const dx = x1 - x0, dy = y1 - y0;
    if (Math.hypot(dx, dy) < 4) return out;
    for (const e of m.edges) {
      if (e.a === startV || e.b === startV || e.a === endV || e.b === endV) continue;
      const ax = P.pts[e.a * 2], ay = P.pts[e.a * 2 + 1], bx = P.pts[e.b * 2], by = P.pts[e.b * 2 + 1];
      const ex = bx - ax, ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const s = ((ax - x0) * ey - (ay - y0) * ex) / den;
      const u = ((ax - x0) * dy - (ay - y0) * dx) / den;
      if (s < 0 || s > 1 || u < 0 || u > 1) continue;
      const sx = x0 + dx * s, sy = y0 + dy * s;
      // perspective-correct parameter: closest point on the 3D edge to the view ray
      const A = v3(m.verts[e.a]).applyMatrix4(M), B = v3(m.verts[e.b]).applyMatrix4(M);
      const ray = this.vp.ray(sx, sy).ray;
      const t = closestOnSegment(ray.origin, ray.direction, A, B);
      const W = A.clone().lerp(B, t);
      if (!this.vp.settings.xray && !this.vp.isVisible(W)) continue;
      if (t < 0.02) out.push({ s, sx, sy, hit: { vert: e.a } });
      else if (t > 0.98) out.push({ s, sx, sy, hit: { vert: e.b } });
      else out.push({ s, sx, sy, hit: { a: e.a, b: e.b, t } });
    }
    out.sort((p, q) => p.s - q.s);
    // drop duplicate consecutive vertex hits
    return out.filter((h, i) => i === 0 || h.hit.vert === undefined || h.hit.vert !== out[i - 1].hit.vert);
  }

  merge(at: 'center' | 'first' = 'center') { this.editOp('Merge', (m) => { if (m.selV.size < 2) { this.status('Select 2+ vertices'); return false; } ops.mergeAtCenter(m, at); }); }
  mergeByDistance() {
    const a = this.editObj;
    if (!a) return;
    let removed = 0;
    this.startParamOp('Merge by Distance', [{ name: 'Distance', value: 0.001, min: 0, max: 1, step: 0.001, drag: 0.0005 }], (m, v) => { removed = ops.mergeByDistance(m, v[0], m.selV.size > 0); });
    this.status(`Removed ${removed} vertices`);
  }
  fill() { this.editOp('Fill', (m) => { const ok = ops.fill(m); if (!ok) this.status('Select 2+ vertices'); return ok; }); if (this.selectMode !== 'face' && this.active) this.active.mesh.flush(this.selectMode === 'edge' ? 'vert' : 'vert'); }
  deleteElements(kind: 'vert' | 'edge' | 'face' | 'onlyfaces' | 'dissolve' = this.selectMode) {
    this.editOp('Delete', (m) => {
      if (kind === 'onlyfaces') ops.deleteOnlyFaces(m);
      else if (kind === 'dissolve') { if (!ops.dissolveFaces(m)) { this.status('Dissolve needs 2+ connected faces with a single outline'); return false; } }
      else ops.deleteSelection(m, kind);
    });
  }
  flipNormals() { this.editOp('Flip Normals', (m) => ops.flipFaces(m)); }
  recalcNormals() { this.editOp('Recalculate Normals', (m) => ops.recalcNormals(m, m.selF.size > 0)); }
  triangulate() { this.editOp('Triangulate', (m) => ops.triangulate(m)); }
  connect() { this.editOp('Connect', (m) => { const n = ops.connectVerts(m); if (!n && m.selV.size !== 2) { this.status('Select vertices that share a face'); return false; } }); }
  bridge() { this.editOp('Bridge', (m) => { if (!ops.bridgeEdgeLoops(m)) { this.status('Select two edge loops with the same vertex count'); return false; } }); this.selectMode = 'face'; this.emit('mode'); }
  splitSel() { this.editOp('Split', (m) => ops.splitSelection(m)); }
  smooth() {
    this.startParamOp('Smooth Vertices', [{ name: 'Factor', value: 0.5, min: 0, max: 1, step: 0.05, drag: 0.004 }, { name: 'Repeat', value: 1, min: 1, max: 20, step: 1, drag: 0.03, int: true }],
      (m, v) => ops.smoothVerts(m, ops.selectedVerts(m), v[0], v[1]));
  }
  duplicateElements() {
    const a = this.editObj;
    if (!a || !a.mesh.selV.size) return;
    this.confirmModal();
    this.record('Duplicate');
    ops.duplicateSelection(a.mesh);
    if (this.selectMode === 'face') a.mesh.flush('face');
    this.changed();
    this.startTransform('move', 'button', null, null, { skipRecord: true, onCancel: () => this.revertLast() });
  }
  separate() {
    const a = this.editObj;
    if (!a || !a.mesh.selF.size) { this.status('Select faces to separate'); return; }
    this.record('Separate');
    const m = a.mesh;
    const part = m.clone();
    // part keeps selected faces only
    const sel = new Set(m.selF);
    part.faces = part.faces.filter((_, i) => sel.has(i));
    part.looseEdges = [];
    part.clearSelection();
    part.changed();
    part.cleanup();
    m.faces = m.faces.filter((_, i) => !sel.has(i));
    m.clearSelection();
    m.changed();
    m.cleanup();
    const o = new SceneObject(this.scene.uniqueName(a.name), part);
    o.position = [...a.position] as V3; o.rotation = [...a.rotation] as V3; o.scale = [...a.scale] as V3;
    o.material = { ...a.material }; o.smooth = a.smooth;
    this.scene.add(o, false);
    this.changed();
    this.status(`Separated into ${o.name}`);
  }

  selectAll() { const a = this.editObj; if (a) { const m = a.mesh; if (m.selV.size === m.verts.length && m.verts.length) m.clearSelection(); else m.selectAll(this.selectMode); this.changed(); } else if (this.mode === 'object') { if (this.scene.selected.size === this.scene.objects.length) this.scene.selected.clear(); else this.scene.objects.forEach((o) => this.scene.selected.add(o.id)); this.changed(); } }
  selectNone() { const a = this.editObj; if (a) { a.mesh.clearSelection(); this.changed(); } else { this.scene.selected.clear(); this.changed(); } }
  selectInvert() { const a = this.editObj; if (a) { ops.invertSelection(a.mesh, this.selectMode); this.changed(); } }
  selectLinked() { const a = this.editObj; if (a) { ops.selectLinked(a.mesh, this.selectMode); this.changed(); } }
  selectGrow() { const a = this.editObj; if (a) { ops.growSelection(a.mesh); this.changed(); } }
  selectShrink() { const a = this.editObj; if (a) { ops.shrinkSelection(a.mesh); this.changed(); } }
  selectLoop() {
    const a = this.editObj;
    if (!a) return;
    const m = a.mesh;
    const keys = [...m.selE];
    if (!keys.length) { this.status('Select an edge first (double-tap an edge for its loop)'); return; }
    for (const k of keys) for (const e of ops.edgeLoop(m, k)) m.selE.add(e);
    m.flush('edge');
    if (this.selectMode === 'vert') m.flush('vert');
    this.changed();
  }
  selectRing() {
    const a = this.editObj;
    if (!a) return;
    const m = a.mesh;
    const keys = [...m.selE];
    if (!keys.length) return;
    m.selE.clear();
    for (const k of keys) for (const [x, y] of ops.edgeRing(m, k).edges) m.selE.add(ekey(x, y));
    m.flush('edge');
    this.selectMode = 'edge';
    this.emit('mode');
    this.changed();
  }
  markSeam(on: boolean) { this.editOp(on ? 'Mark Seam' : 'Clear Seam', (m) => { if (!m.selE.size) { this.status('Select edges'); return false; } ops.markSeams(m, on); }); }
  snapCenterX() { this.editOp('Snap to X=0', (m) => ops.snapToCenterX(m)); }

  /* ================================================================ UV actions */
  uvUnwrap() {
    const a = this.editObj;
    if (!a) return;
    let res = { charts: 0, fallback: 0 };
    this.editOp('Unwrap', (m) => { res = uvOps.unwrapLSCM(m); });
    this.status(res.fallback ? `Unwrapped ${res.charts} islands (${res.fallback} closed part${res.fallback > 1 ? 's' : ''} without seams used smart projection)` : `Unwrapped ${res.charts} island${res.charts > 1 ? 's' : ''}`, 4000);
  }
  uvSmart() { let n = 0; this.editOp('Smart UV Project', (m) => { n = uvOps.smartProject(m); }); this.status(`${n} islands`); }
  uvProject(kind: uvOps.Projection) {
    const a = this.editObj;
    if (!a) return;
    let right: V3 | undefined, up: V3 | undefined;
    if (kind === 'view') {
      const cam = this.vp.cam.camera;
      const inv = new THREE.Matrix3().setFromMatrix4(this.vp.objectMatrix(a)).invert();
      const r = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).applyMatrix3(inv).normalize();
      const u = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).applyMatrix3(inv).normalize();
      right = [r.x, r.y, r.z]; up = [u.x, u.y, u.z];
    }
    this.editOp(`${kind} projection`, (m) => uvOps.project(m, kind, right, up));
  }
  uvPack() { this.editOp('Pack Islands', (m) => uvOps.packExisting(m)); }
  uvSeamsFromIslands() { this.editOp('Seams from Islands', (m) => uvOps.seamsFromIslands(m)); }

  /* ================================================================ keyboard */
  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      if (e.key === 'Enter' || e.key === 'Escape') (t as HTMLInputElement).blur();
      return;
    }
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Control') this.keyInvert = true;
    if (ctrl && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (ctrl && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (this.modal) {
      if (e.key === 'Escape') { this.cancelModal(); return; }
      if (e.key === 'Enter') { this.confirmModal(); return; }
      if (this.modal.kind === 'transform' && (k === 'x' || k === 'y' || k === 'z')) { this.setModalAxis(k as Axis); return; }
      if (this.modal.kind === 'transform' && (e.key === '[' || e.key === 'PageDown')) { this.scalePropRadius(1 / 1.15); return; }
      if (this.modal.kind === 'transform' && (e.key === ']' || e.key === 'PageUp')) { this.scalePropRadius(1.15); return; }
      if (this.modal.kind === 'transform' && (k === 'g' || k === 'r' || k === 's')) {
        const kind: TKind = k === 'g' ? 'move' : k === 'r' ? 'rotate' : 'scale';
        if (this.modal.session.kind !== kind) {
          // switch transform kind
          const m = this.modal; this.modal = null; m.session.cancel(); this.history.cancelLast();
          this.startTransform(kind, 'key');
        }
        return;
      }
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); if (this.mode === 'object' || this.mode === 'edit') this.toggleEdit(); else this.setMode('object'); return; }
    if (e.key === 'Escape') return;
    if (e.key === 'Delete' || (k === 'x' && !ctrl)) { if (this.mode === 'object') this.deleteObjects(); else if (this.isEditLike) this.deleteElements(); return; }
    if (k === 'g') return void this.startTransform('move', 'key');
    if (k === 'r' && !ctrl && !(this.isEditLike && e.shiftKey)) return void this.startTransform('rotate', 'key');
    if (k === 's' && !ctrl) return void this.startTransform('scale', 'key');
    if (k === 'a' && e.altKey) return this.selectNone();
    if (k === 'a' && !ctrl) return this.selectAll();
    if (k === 'i' && ctrl) return this.selectInvert();
    if (k === 'd' && e.shiftKey) { if (this.mode === 'object') this.duplicateObjects(); else this.duplicateElements(); return; }
    if (k === 'j' && ctrl && this.mode === 'object') return this.joinObjects();
    if (e.key === '.' || k === 'f' && this.mode === 'object') return this.frameSelected();
    if (k === 'home') return this.frameAll();
    if (e.code === 'Numpad1') return this.setView(ctrl ? 'back' : 'front');
    if (e.code === 'Numpad3') return this.setView(ctrl ? 'left' : 'right');
    if (e.code === 'Numpad7') return this.setView(ctrl ? 'bottom' : 'top');
    if (e.code === 'Numpad5') return this.toggleOrtho();
    if (this.isEditLike) {
      if (k === '1') return this.setSelectMode('vert');
      if (k === '2') return this.setSelectMode('edge');
      if (k === '3') return this.setSelectMode('face');
      if (k === 'e') return this.extrude('key');
      if (k === 'i') return this.inset();
      if (k === 'r' && ctrl) { e.preventDefault(); return this.setTool(this.tool === 'loopcut' ? 'select' : 'loopcut'); }
      if (k === 'b' && ctrl) { e.preventDefault(); return this.bevel(e.shiftKey ? true : undefined); }
      if (k === 'k') return this.setTool(this.tool === 'knife' ? 'select' : 'knife');
      if (k === 'o') { const pr = this.settings.proportional; pr.enabled = !pr.enabled; this.emit('mode'); this.status(`Proportional editing ${pr.enabled ? 'on' : 'off'}`); return; }
      if (k === 'm') return this.merge();
      if (k === 'f') return this.fill();
      if (k === 'j') return this.connect();
      if (k === 'l') return this.selectLinked();
      if (k === 'u') return this.uvUnwrap();
      if (k === 'n' && e.shiftKey) return this.recalcNormals();
      if (k === 'p') return this.separate();
      if (k === 'v') return this.splitSel();
      if (k === 't' && ctrl) return this.triangulate();
    }
    if (this.mode === 'sculpt') {
      if (k === '[') { this.brush.radius = Math.max(5, this.brush.radius / 1.15); this.emit('mode'); this.vp.requestRender(); }
      if (k === ']') { this.brush.radius = Math.min(400, this.brush.radius * 1.15); this.emit('mode'); this.vp.requestRender(); }
    }
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function pointInPoly(x: number, y: number, poly: number[][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Parameter t∈[0,1] on segment AB closest to the ray (o + s·d). */
function closestOnSegment(o: THREE.Vector3, d: THREE.Vector3, A: THREE.Vector3, B: THREE.Vector3): number {
  const u = B.clone().sub(A);
  const w0 = A.clone().sub(o);
  const a = u.dot(u), b = u.dot(d), c = d.dot(d), dd = u.dot(w0), e = d.dot(w0);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-12) return 0.5;
  const t = (b * e - c * dd) / den;
  return Math.max(0, Math.min(1, t));
}
