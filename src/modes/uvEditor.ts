import { App } from '../app';
import { Gestures, PInfo, ToolHandler } from '../input';
import { V2 } from '../core/vec';
import { uvIslands, chartsOf, liveUnwrap, uvStretch, StretchMode } from '../core/uv';
import { isPinned } from '../core/mesh';
import { weightColor } from '../core/skin';

type UVKind = 'move' | 'rotate' | 'scale';

const ck = (f: number, c: number) => `${f}:${c}`;
const pk = (k: string): [number, number] => { const i = k.indexOf(':'); return [+k.slice(0, i), +k.slice(i + 1)]; };

/**
 * 2D UV editor. Shows the faces selected in the 3D view (or all faces if
 * none are selected) over the object's texture / a checker.
 */
export class UVEditor {
  ctx: CanvasRenderingContext2D;
  view = { cx: 0, cy: 0, scale: 300 };
  sel = new Set<string>();
  private selTopo = -1;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  modal: { kind: UVKind; orig: Map<string, V2>; pivot: V2; acc: number[]; cur: number[]; axis: 'u' | 'v' | null; dragStart: { x: number; y: number } | null; lastA: number; unwrap: number } | null = null;
  private img: CanvasImageSource | null = null;
  private imgKey = '';
  private width = 1;
  private height = 1;
  private dpr = 1;
  private needs = true;
  gestures: Gestures;
  onModal: () => void = () => {};
  fitted = false;
  /** Theme colours for the 2D canvas. */
  colors = { uvBg: '#1f2024', uvPaper: '#2c2d33', faceTint: 'rgba(160,160,170,0.10)', corner: '#e8e8ec' };
  private userMoved = false;
  /** Colour faces by UV distortion. */
  stretch: 'off' | StretchMode = 'off';
  private stretchCache: { key: string; face: Float32Array; mean: number } | null = null;
  /** Live unwrap during a transform: charts re-solved around their pins, and their UVs for cancel. */
  private live: { charts: number[][]; backup: Map<number, V2[]>; pending: boolean } | null = null;

  constructor(private canvas: HTMLCanvasElement, private container: HTMLElement, private app: App) {
    this.ctx = canvas.getContext('2d')!;
    this.gestures = new Gestures(container, {
      beginTool: (x, y, p) => this.beginTool(x, y, p),
      beginBox: (x, y, p) => this.beginBox(x, y, p),
      tap: (x, y, p, c) => this.tap(x, y, p, c),
      hover: () => {},
      orbit: (dx, dy) => this.pan(dx, dy),
      pan: (dx, dy) => this.pan(dx, dy),
      zoom: (f, x, y) => this.zoom(f, x, y),
      undo: () => app.undo(),
      redo: () => app.redo(),
      touchDragOrbits: () => true,
    });
    this.gestures.settings = app.gestures.settings;
    const loop = () => { requestAnimationFrame(loop); if (this.needs) { this.needs = false; this.draw(); } };
    loop();
  }

  redraw() { this.needs = true; }

  resize() {
    const r = this.container.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.width = Math.max(1, r.width); this.height = Math.max(1, r.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    if (this.width > 40 && this.height > 40 && (!this.fitted || !this.userMoved)) this.fit();
    this.redraw();
  }

  fit() {
    const s = Math.min(this.width, this.height) * 0.86;
    this.view = { scale: s, cx: (this.width - s) / 2, cy: (this.height + s) / 2 };
    this.fitted = true;
    this.userMoved = false;
    this.redraw();
  }

  private toScreen(u: V2) { return { x: this.view.cx + u[0] * this.view.scale, y: this.view.cy - u[1] * this.view.scale }; }
  private toUV(x: number, y: number): V2 { return [(x - this.view.cx) / this.view.scale, (this.view.cy - y) / this.view.scale]; }
  private pan(dx: number, dy: number) { this.userMoved = true; this.view.cx += dx; this.view.cy += dy; this.redraw(); }
  private zoom(f: number, x: number, y: number) {
    this.userMoved = true;
    const ns = Math.min(50000, Math.max(20, this.view.scale / f));
    const k = ns / this.view.scale;
    this.view.cx = x - (x - this.view.cx) * k;
    this.view.cy = y - (y - this.view.cy) * k;
    this.view.scale = ns;
    this.redraw();
  }

  private get obj() { return this.app.mode === 'uv' ? this.app.active : null; }

  /** Faces displayed in the editor. */
  faces(): number[] {
    const o = this.obj;
    if (!o) return [];
    const m = o.mesh;
    return m.selF.size ? [...m.selF].filter((f) => f < m.faces.length) : m.faces.map((_, i) => i);
  }

  private validateSel() {
    const o = this.obj;
    if (!o) return;
    if (o.mesh.topoId !== this.selTopo) { this.sel.clear(); this.selTopo = o.mesh.topoId; }
  }

  /** All corners sharing vertex & uv position with (f,c) among visible faces. */
  private sticky(f: number, c: number, faces: number[]): string[] {
    const m = this.obj!.mesh;
    const v = m.faces[f].v[c];
    const u = m.faces[f].uv[c];
    const res: string[] = [];
    for (const fi of m.vertFaces(v)) {
      if (!faces.includes(fi)) continue;
      const g = m.faces[fi];
      const ci = g.v.indexOf(v);
      const w = g.uv[ci];
      if (Math.abs(w[0] - u[0]) < 1e-5 && Math.abs(w[1] - u[1]) < 1e-5) res.push(ck(fi, ci));
    }
    return res;
  }

  private pickCorner(x: number, y: number, r: number): [number, number] | null {
    const m = this.obj?.mesh;
    if (!m) return null;
    let best: [number, number] | null = null, bd = r;
    for (const fi of this.faces()) {
      const f = m.faces[fi];
      f.uv.forEach((u, c) => { const s = this.toScreen(u); const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = [fi, c]; } });
    }
    return best;
  }

  private pickFaceAt(x: number, y: number): number {
    const m = this.obj?.mesh;
    if (!m) return -1;
    const p = this.toUV(x, y);
    const fs = this.faces();
    for (let i = fs.length - 1; i >= 0; i--) {
      const f = m.faces[fs[i]];
      if (pointInPoly(p[0], p[1], f.uv)) return fs[i];
    }
    return -1;
  }

  private selectCorners(keys: string[], op: 'set' | 'add' | 'sub', toggle = false) {
    if (op === 'set') this.sel.clear();
    const allSel = keys.every((k) => this.sel.has(k));
    for (const k of keys) {
      if (op === 'sub' || (toggle && allSel)) this.sel.delete(k); else this.sel.add(k);
    }
  }

  private tap(x: number, y: number, p: PInfo, count: number) {
    if (this.modal) { this.confirm(); return; }
    if (!this.obj) return;
    this.validateSel();
    const op = p.shift ? 'add' : p.ctrl ? 'sub' : this.app.selOp;
    const faces = this.faces();
    const r = p.type === 'touch' ? 26 : 12;
    if (count >= 2) {
      const c = this.pickCorner(x, y, r);
      const f = c ? c[0] : this.pickFaceAt(x, y);
      if (f >= 0) this.selectIsland(f, op === 'sub' ? 'sub' : 'add');
      this.redraw();
      return;
    }
    if (this.app.selectMode === 'face') {
      const f = this.pickFaceAt(x, y);
      if (f < 0) { if (op === 'set') this.sel.clear(); }
      else this.selectCorners(this.obj.mesh.faces[f].uv.map((_, c) => ck(f, c)), op, op === 'add');
    } else {
      const c = this.pickCorner(x, y, r);
      if (!c) { if (op === 'set') this.sel.clear(); }
      else this.selectCorners(this.sticky(c[0], c[1], faces), op, op === 'add');
    }
    this.redraw();
    this.onModal();
  }

  selectIsland(f: number, op: 'add' | 'sub' = 'add') {
    const m = this.obj!.mesh;
    const isl = uvIslands(m, this.faces()).find((i) => i.includes(f));
    if (!isl) return;
    for (const fi of isl) m.faces[fi].uv.forEach((_, c) => (op === 'sub' ? this.sel.delete(ck(fi, c)) : this.sel.add(ck(fi, c))));
  }

  selectAll() {
    const m = this.obj?.mesh;
    if (!m) return;
    this.validateSel();
    const all: string[] = [];
    for (const fi of this.faces()) m.faces[fi].uv.forEach((_, c) => all.push(ck(fi, c)));
    if (all.every((k) => this.sel.has(k))) this.sel.clear(); else all.forEach((k) => this.sel.add(k));
    this.redraw();
  }

  selectLinked() {
    const m = this.obj?.mesh;
    if (!m) return;
    const fs = new Set([...this.sel].map((k) => pk(k)[0]));
    for (const f of fs) this.selectIsland(f, 'add');
    this.redraw();
  }

  private beginBox(x: number, y: number, p: PInfo): ToolHandler | null {
    if (this.modal || !this.obj) return null;
    this.validateSel();
    this.box = { x0: x, y0: y, x1: x, y1: y };
    const op = p.shift ? 'add' : p.ctrl ? 'sub' : this.app.selOp;
    return {
      move: (mx, my) => { this.box!.x1 = mx; this.box!.y1 = my; this.redraw(); },
      end: () => {
        const b = this.box!; this.box = null;
        const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
        if (op === 'set') this.sel.clear();
        const m = this.obj!.mesh;
        for (const fi of this.faces()) m.faces[fi].uv.forEach((u, c) => {
          const s = this.toScreen(u);
          if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) { if (op === 'sub') this.sel.delete(ck(fi, c)); else this.sel.add(ck(fi, c)); }
        });
        this.redraw();
        this.onModal();
      },
      cancel: () => { this.box = null; this.redraw(); },
    };
  }

  private beginTool(x: number, y: number, p: PInfo): ToolHandler | null {
    if (!this.obj) return null;
    this.validateSel();
    if (this.modal) {
      const md = this.modal;
      md.dragStart = { x, y };
      const ps = this.toScreen(md.pivot);
      md.lastA = Math.atan2(y - ps.y, x - ps.x);
      md.unwrap = 0;
      let moved = false;
      return {
        move: (mx, my) => { moved = true; this.dragModal(mx, my); },
        end: () => { md.acc = md.cur.slice(); md.dragStart = null; if (!moved) this.confirm(); },
        cancel: () => { md.dragStart = null; },
      };
    }
    // tweak: drag a selected corner (or any corner: selects it first)
    const c = this.pickCorner(x, y, p.type === 'touch' ? 22 : 10);
    if (!c) return null;
    const key = ck(c[0], c[1]);
    const was = this.sel.has(key);
    let started = false;
    return {
      move: (mx, my) => {
        if (!started) {
          if (Math.hypot(mx - x, my - y) < (p.type === 'touch' ? 10 : 4)) return;
          if (!was) { this.sel.clear(); this.selectCorners(this.sticky(c[0], c[1], this.faces()), 'add'); }
          this.start('move');
          this.modal!.dragStart = { x, y };
          started = true;
        }
        this.dragModal(mx, my);
      },
      end: (ex, ey, ep) => { if (started) this.confirm(); else this.tap(ex, ey, ep, 1); },
      cancel: () => { if (started) this.cancel(); },
    };
  }

  /* ---------------------------------------------------------------- transforms */
  start(kind: UVKind) {
    const m = this.obj?.mesh;
    if (!m) return;
    this.validateSel();
    if (this.modal) this.confirm();
    if (!this.sel.size) { this.app.status('Select UVs first'); return; }
    this.app.record(`UV ${kind}`);
    const orig = new Map<string, V2>();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const k of this.sel) {
      const [f, c] = pk(k);
      const u = m.faces[f]?.uv[c];
      if (!u) continue;
      orig.set(k, [u[0], u[1]]);
      x0 = Math.min(x0, u[0]); x1 = Math.max(x1, u[0]); y0 = Math.min(y0, u[1]); y1 = Math.max(y1, u[1]);
    }
    this.live = null;
    if (this.app.settings.liveUnwrap) {
      const pinnedFaces = [...this.sel].map(pk).filter(([f, c]) => m.faces[f] && isPinned(m.faces[f], c)).map(([f]) => f);
      if (pinnedFaces.length) {
        const charts = chartsOf(m, pinnedFaces);
        const backup = new Map<number, V2[]>();
        for (const c of charts) for (const f of c) backup.set(f, m.faces[f].uv.map((u) => [u[0], u[1]] as V2));
        this.live = { charts, backup, pending: false };
      }
    }
    const id = kind === 'scale' ? [1, 1] : [0, 0];
    this.modal = { kind, orig, pivot: [(x0 + x1) / 2, (y0 + y1) / 2], acc: id.slice(), cur: id.slice(), axis: null, dragStart: null, lastA: 0, unwrap: 0 };
    this.onModal();
    this.redraw();
  }

  setAxis(a: 'u' | 'v' | null) {
    if (!this.modal) return;
    this.modal.axis = this.modal.axis === a ? null : a;
    this.applyModal();
  }

  private dragModal(x: number, y: number) {
    const md = this.modal!;
    if (!md.dragStart) md.dragStart = { x, y };
    const s = md.dragStart;
    const ps = this.toScreen(md.pivot);
    const snap = this.app.settings.snap.enabled;
    if (md.kind === 'move') {
      let du = (x - s.x) / this.view.scale, dv = -(y - s.y) / this.view.scale;
      if (snap) { const g = 1 / 32; du = Math.round(du / g) * g; dv = Math.round(dv / g) * g; }
      md.cur = [md.acc[0] + du, md.acc[1] + dv];
    } else if (md.kind === 'rotate') {
      const r0 = Math.hypot(s.x - ps.x, s.y - ps.y);
      let a: number;
      if (r0 < 30) a = (x - s.x) * 0.01;
      else {
        const cur = Math.atan2(y - ps.y, x - ps.x);
        let d = cur - md.lastA;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        md.unwrap += d; md.lastA = cur; a = md.unwrap;
      }
      let t = md.acc[0] - a; // screen y is flipped
      if (snap) { const st = (this.app.settings.snap.rotate * Math.PI) / 180; t = Math.round(t / st) * st; }
      md.cur = [t, 0];
    } else {
      const r0 = Math.hypot(s.x - ps.x, s.y - ps.y);
      const f = r0 < 30 ? Math.exp((x - s.x) * 0.01) : Math.hypot(x - ps.x, y - ps.y) / r0;
      let k = md.acc[0] * f;
      if (snap) k = Math.round(k / this.app.settings.snap.scale) * this.app.settings.snap.scale || this.app.settings.snap.scale;
      md.cur = [k, k];
    }
    this.applyModal();
  }

  setNumeric(v: number) {
    const md = this.modal;
    if (!md) return;
    if (md.kind === 'move') md.cur = md.axis === 'v' ? [0, v] : [v, md.axis === 'u' ? 0 : 0];
    else if (md.kind === 'rotate') md.cur = [(v * Math.PI) / 180, 0];
    else md.cur = [v, v];
    md.acc = md.cur.slice();
    this.applyModal();
  }

  private applyModal() {
    const md = this.modal!;
    const m = this.obj!.mesh;
    const [px, py] = md.pivot;
    for (const [k, o] of md.orig) {
      const [f, c] = pk(k);
      let u = o[0], v = o[1];
      if (md.kind === 'move') { if (md.axis !== 'v') u += md.cur[0]; if (md.axis !== 'u') v += md.cur[1]; }
      else if (md.kind === 'rotate') {
        const a = md.cur[0], cs = Math.cos(a), sn = Math.sin(a);
        const dx = u - px, dy = v - py;
        u = px + dx * cs - dy * sn; v = py + dx * sn + dy * cs;
      } else {
        if (md.axis !== 'v') u = px + (u - px) * md.cur[0];
        if (md.axis !== 'u') v = py + (v - py) * md.cur[1];
      }
      m.faces[f].uv[c] = [u, v];
    }
    m.uvChanged();
    // live unwrap: re-solve the pinned islands at most once per frame
    if (this.live && !this.live.pending) {
      this.live.pending = true;
      requestAnimationFrame(() => {
        if (!this.live || !this.modal) return;
        this.live.pending = false;
        liveUnwrap(m, this.live.charts);
        this.app.redraw();
        this.redraw();
      });
    }
    this.app.redraw();
    this.onModal();
  }

  describe(): string {
    const md = this.modal;
    if (!md) return '';
    const ax = md.axis ? ` (${md.axis.toUpperCase()})` : '';
    if (md.kind === 'move') return `Move${ax}: ${md.cur[0].toFixed(3)}, ${md.cur[1].toFixed(3)}`;
    if (md.kind === 'rotate') return `Rotate: ${((md.cur[0] * 180) / Math.PI).toFixed(1)}°`;
    return `Scale${ax}: ${md.cur[0].toFixed(3)}`;
  }

  confirm() {
    if (!this.modal) return;
    if (this.live) { liveUnwrap(this.obj!.mesh, this.live.charts); this.live = null; }
    this.modal = null;
    this.app.changed();
    this.onModal();
    this.redraw();
  }

  cancel() {
    const md = this.modal;
    if (!md) return;
    const m = this.obj!.mesh;
    if (this.live) { for (const [f, uv] of this.live.backup) if (m.faces[f]) m.faces[f].uv = uv; this.live = null; }
    for (const [k, o] of md.orig) { const [f, c] = pk(k); if (m.faces[f]) m.faces[f].uv[c] = [o[0], o[1]]; }
    m.uvChanged();
    this.modal = null;
    this.app.history.cancelLast();
    this.app.changed();
    this.onModal();
  }

  /** One-shot operations on selected UVs. */
  op(kind: 'flipU' | 'flipV' | 'rot90' | 'weld' | 'alignU' | 'alignV' | 'fitBounds') {
    const m = this.obj?.mesh;
    if (!m) return;
    this.validateSel();
    let keys = [...this.sel];
    if (!keys.length && kind === 'fitBounds') keys = this.faces().flatMap((f) => m.faces[f].uv.map((_, c) => ck(f, c)));
    if (!keys.length) { this.app.status('Select UVs first'); return; }
    this.app.record(`UV ${kind}`);
    const pts = keys.map((k) => { const [f, c] = pk(k); return { f, c, u: m.faces[f].uv[c] }; });
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, sx = 0, sy = 0;
    for (const p of pts) { x0 = Math.min(x0, p.u[0]); x1 = Math.max(x1, p.u[0]); y0 = Math.min(y0, p.u[1]); y1 = Math.max(y1, p.u[1]); sx += p.u[0]; sy += p.u[1]; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, ax = sx / pts.length, ay = sy / pts.length;
    const sc = Math.max(x1 - x0, y1 - y0) || 1;
    for (const p of pts) {
      let [u, v] = p.u;
      switch (kind) {
        case 'flipU': u = 2 * cx - u; break;
        case 'flipV': v = 2 * cy - v; break;
        case 'rot90': { const dx = u - cx, dy = v - cy; u = cx - dy; v = cy + dx; break; }
        case 'weld': u = ax; v = ay; break;
        case 'alignU': u = ax; break;
        case 'alignV': v = ay; break;
        case 'fitBounds': u = (u - x0) / sc; v = (v - y0) / sc; break;
      }
      m.faces[p.f].uv[p.c] = [u, v];
    }
    m.uvChanged();
    this.app.changed();
  }

  /** Pin (or unpin) the selected UV corners. */
  pinSelected(on: boolean) {
    const m = this.obj?.mesh;
    if (!m) return;
    this.validateSel();
    if (!this.sel.size) { this.app.status(on ? 'Select UV points to pin' : 'Select UV points to unpin'); return; }
    this.app.record(on ? 'Pin UVs' : 'Unpin UVs');
    let n = 0;
    for (const k of this.sel) {
      const [fi, c] = pk(k);
      const f = m.faces[fi];
      if (!f) continue;
      if (!f.pin || f.pin.length !== f.v.length) f.pin = f.v.map(() => false);
      if (f.pin[c] !== on) n++;
      f.pin[c] = on;
      if (!f.pin.some(Boolean)) delete f.pin;
    }
    m.uvChanged();
    this.app.changed();
    this.app.status(on ? `Pinned ${this.pinnedPoints(m)} UV points · Unwrap now keeps them in place` : `Unpinned · ${this.pinnedPoints(m)} pinned left`);
    void n;
  }

  /** Distinct pinned UV positions (counting sticky corners once). */
  pinnedPoints(m = this.obj?.mesh): number {
    if (!m) return 0;
    const set = new Set<string>();
    m.faces.forEach((f) => f.uv.forEach((u, c) => { if (isPinned(f, c)) set.add(`${f.v[c]}|${u[0].toFixed(5)}|${u[1].toFixed(5)}`); }));
    return set.size;
  }

  /** Select every pinned corner. */
  selectPinned() {
    const m = this.obj?.mesh;
    if (!m) return;
    this.validateSel();
    this.sel.clear();
    for (const fi of this.faces()) m.faces[fi].uv.forEach((_, c) => { if (isPinned(m.faces[fi], c)) this.sel.add(ck(fi, c)); });
    this.redraw();
    this.onModal();
  }

  private stretchValues(faces: number[]) {
    const m = this.obj!.mesh;
    const key = `${this.stretch}|${m.version}|${m.uvId}|${faces.length}|${m.selF.size}`;
    if (this.stretchCache?.key !== key) this.stretchCache = { key, ...uvStretch(m, faces, this.stretch as StretchMode) };
    return this.stretchCache;
  }

  /* ---------------------------------------------------------------- drawing */
  private ensureImage() {
    const o = this.obj;
    const key = o?.material.texture ? o.material.texture : this.app.vp.settings.checker ? 'checker' : '';
    if (key === this.imgKey) return;
    this.imgKey = key;
    if (!key) { this.img = null; return; }
    if (key === 'checker') { this.img = this.app.vp.checkerTexture.image as HTMLCanvasElement; return; }
    const im = new Image();
    im.onload = () => this.redraw();
    im.src = key;
    this.img = im;
  }

  draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.colors.uvBg;
    ctx.fillRect(0, 0, this.width, this.height);
    const o = this.obj;
    if (!o) return;
    this.validateSel();
    this.ensureImage();
    const { scale } = this.view;
    const tl = this.toScreen([0, 1]);
    // texture / backdrop
    ctx.fillStyle = this.colors.uvPaper;
    ctx.fillRect(tl.x, tl.y, scale, scale);
    if (this.img && ((this.img as HTMLImageElement).complete !== false)) {
      ctx.globalAlpha = 0.85;
      try { ctx.drawImage(this.img, tl.x, tl.y, scale, scale); } catch { /* not ready */ }
      ctx.globalAlpha = 1;
    }
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      ctx.moveTo(tl.x + t * scale, tl.y); ctx.lineTo(tl.x + t * scale, tl.y + scale);
      ctx.moveTo(tl.x, tl.y + t * scale); ctx.lineTo(tl.x + scale, tl.y + t * scale);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.strokeRect(tl.x, tl.y, scale, scale);

    const m = o.mesh;
    const faces = this.faces();
    const st = this.stretch !== 'off' ? this.stretchValues(faces) : null;
    // faces
    ctx.lineWidth = 1.2;
    for (const fi of faces) {
      const f = m.faces[fi];
      ctx.beginPath();
      f.uv.forEach((u, i) => { const s = this.toScreen(u); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
      ctx.closePath();
      const allSel = f.uv.every((_, c) => this.sel.has(ck(fi, c)));
      if (st) {
        // stretch: blue (none) → red (strong); the curve spreads the low end where most faces live
        const c = weightColor(Math.min(1, Math.sqrt(st.face[fi] * 2)));
        ctx.fillStyle = `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},0.8)`;
        ctx.fill();
        if (allSel) { ctx.fillStyle = 'rgba(255,154,31,0.3)'; ctx.fill(); }
      } else {
        ctx.fillStyle = allSel ? 'rgba(255,154,31,0.28)' : this.colors.faceTint;
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(20,20,24,0.9)';
      ctx.stroke();
    }
    // selected edges & seams
    for (const fi of faces) {
      const f = m.faces[fi];
      const n = f.v.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const selE = this.sel.has(ck(fi, i)) && this.sel.has(ck(fi, j));
        const seam = m.seams.has(f.v[i] < f.v[j] ? `${f.v[i]}_${f.v[j]}` : `${f.v[j]}_${f.v[i]}`);
        if (!selE && !seam) continue;
        const a = this.toScreen(f.uv[i]), b = this.toScreen(f.uv[j]);
        ctx.strokeStyle = selE ? '#ffa033' : '#ff4848';
        ctx.lineWidth = selE ? 2 : 1.6;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    // corners (pins drawn bigger, red, on top)
    const r = matchMedia('(pointer: coarse)').matches ? 3.5 : 2.5;
    const pins: { x: number; y: number; sel: boolean }[] = [];
    for (const fi of faces) {
      const f = m.faces[fi];
      f.uv.forEach((u, c) => {
        const s = this.toScreen(u);
        const sel = this.sel.has(ck(fi, c));
        if (isPinned(f, c)) { pins.push({ x: s.x, y: s.y, sel }); return; }
        ctx.fillStyle = sel ? '#ffa033' : this.colors.corner;
        ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
      });
    }
    const pr = r + 2;
    for (const p of pins) {
      ctx.fillStyle = p.sel ? '#ffa033' : '#ff3b3b';
      ctx.fillRect(p.x - pr, p.y - pr, pr * 2, pr * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x - pr + 0.5, p.y - pr + 0.5, pr * 2 - 1, pr * 2 - 1);
    }
    if (this.modal) {
      const p = this.toScreen(this.modal.pivot);
      ctx.strokeStyle = '#ffd27a';
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke();
    }
    if (this.box) {
      const b = this.box;
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.setLineDash([]);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = "11px 'JetBrains Mono', 'Roboto Mono', 'Droid Sans Mono', ui-monospace, monospace";
    const info = m.selF.size ? `${faces.length} selected faces` : 'All faces (select faces in 3D to filter)';
    const live = this.app.settings.liveUnwrap ? ' · live unwrap' : '';
    ctx.fillText(info + live, 10, this.height - 10);
    if (st) {
      // legend
      const w = 120, h = 8, x = this.width - w - 12, y = this.height - 22;
      for (let i = 0; i < w; i++) { const c = weightColor(Math.min(1, Math.sqrt((i / w) * 2))); ctx.fillStyle = `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`; ctx.fillRect(x + i, y, 1, h); }
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.textAlign = 'right';
      ctx.fillText(`${this.stretch} stretch · mean ${(st.mean * 100).toFixed(1)}%`, this.width - 12, y - 4);
      ctx.textAlign = 'left';
    }
  }

}

function pointInPoly(x: number, y: number, poly: V2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
