/* ======================================================================
 * Gesture router.
 *
 * Unifies mouse, finger and active-stylus input:
 *  - Stylus (pointerType 'pen'): precise tool input with pressure & hover.
 *    Barrel button / eraser end drag = orbit. Once a pen has been seen,
 *    fingers become navigation-only (palm rejection) unless disabled.
 *  - Touch: 1 finger = tool if the tool wants it (gizmo, sculpt on mesh,
 *    vertex tweak, modal transform) else tap-to-select / drag-to-orbit;
 *    hold then drag = box select. 2 fingers = pinch zoom + pan,
 *    2-finger tap = undo, 3-finger tap = redo.
 *  - Mouse: left = tool / box select, middle = orbit (shift = pan,
 *    ctrl = zoom), right drag = pan, wheel = zoom.
 * ==================================================================== */

export type PType = 'mouse' | 'pen' | 'touch';

export interface PInfo {
  type: PType;
  pressure: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** Pen tilt / mouse button etc. could be added here. */
  button: number;
  /** Time-stamp of event (ms). */
  t: number;
}

export interface ToolHandler {
  move(x: number, y: number, p: PInfo): void;
  end(x: number, y: number, p: PInfo): void;
  cancel(): void;
}

export interface GestureCallbacks {
  /** Pointer went down where a tool may want to act. Return a handler to capture the drag. */
  beginTool(x: number, y: number, p: PInfo): ToolHandler | null;
  /** Drag that started on empty space with a precise pointer (pen / mouse) or after long-press. */
  beginBox(x: number, y: number, p: PInfo): ToolHandler | null;
  tap(x: number, y: number, p: PInfo, count: number): void;
  hover(x: number, y: number, p: PInfo | null): void;
  orbit(dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  zoom(factor: number, x: number, y: number): void;
  undo(): void;
  redo(): void;
  /** Whether a lone finger drag on empty space should orbit (vs. do nothing). */
  touchDragOrbits(): boolean;
}

export interface GestureSettings {
  /** 'auto': fingers become navigation-only after a pen is used. */
  palmRejection: 'auto' | 'on' | 'off';
  longPressMs: number;
  /**
   * 'auto': trust pointerType (plus fixes for mis-reported pens).
   * 'thin': also treat touches with a tiny contact area as a pen — for
   * tablets whose pen arrives as a finger even after the native fix.
   */
  stylusDetect: 'auto' | 'thin';
}

/** Contact size (CSS px) at or below which a "touch" counts as a pen in 'thin' mode. */
export const THIN_CONTACT_PX = 3;

interface Track {
  id: number;
  type: PType;
  x: number; y: number;
  sx: number; sy: number;
  t0: number;
  handler: ToolHandler | null;
  role: 'pending' | 'tool' | 'orbit' | 'pan' | 'zoom' | 'nav2' | 'ignore';
  moved: boolean;
}

// Pens (especially EMR / MPP digitisers) jitter a few px on contact, so a pen
// tap gets a generous slop; quick small wiggles still count as taps.
const TAP_SLOP = { mouse: 4, pen: 10, touch: 12 };
const QUICK_TAP = { ms: 220, px: 18 };

export class Gestures {
  private tracks = new Map<number, Track>();
  private penSeenAt = 0;
  private penDown = false;
  private penLast = 0;
  private lastTap = { t: 0, x: 0, y: 0, count: 0 };
  private longPressTimer: number | null = null;
  private multi = { start: 0, maxCount: 0, moved: false, fired: false, lastDist: 0, lastCx: 0, lastCy: 0 };
  settings: GestureSettings = { palmRejection: 'auto', longPressMs: 380, stylusDetect: 'auto' };
  /** Becomes true once a pen reports a pressure that isn't a placeholder (0 / 0.5 / 1). */
  pressureSupported = false;
  /** Raw event log for the stylus test screen. */
  onRaw: ((e: PointerEvent, classifiedAs: PType) => void) | null = null;
  /** True while a pen is known to be in use (for UI hints). */
  /** True while two or more fingers are down (pinch). */
  get multiTouch() { return [...this.tracks.values()].filter((t) => t.role === 'nav2').length >= 2; }
  get penMode() { return this.settings.palmRejection === 'on' || (this.settings.palmRejection === 'auto' && this.penSeenAt > 0); }

  constructor(private el: HTMLElement, private cb: GestureCallbacks) {
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.down, { passive: false });
    el.addEventListener('pointermove', this.move, { passive: false });
    el.addEventListener('pointerup', this.up, { passive: false });
    el.addEventListener('pointercancel', this.cancel, { passive: false });
    el.addEventListener('pointerleave', this.leave);
    el.addEventListener('wheel', this.wheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private pos(e: PointerEvent | WheelEvent) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Decide what kind of pointer this really is. */
  classify(e: PointerEvent): PType {
    const t = e.pointerType;
    if (t === 'pen') return 'pen';
    if (t === 'touch') {
      if (this.settings.stylusDetect === 'thin' && e.width <= THIN_CONTACT_PX && e.height <= THIN_CONTACT_PX) return 'pen';
      return 'touch';
    }
    if (t === 'mouse' || !t) {
      // some digitisers arrive as "mouse" but report real pressure while touching
      const pr = e.pressure;
      if (t === 'mouse' && e.buttons && pr > 0 && pr !== 0.5 && pr !== 1) return 'pen';
      return 'mouse';
    }
    return 'pen'; // unknown future pointer types: treat as a precise pointer
  }

  private info(e: PointerEvent): PInfo {
    const type = this.classify(e);
    let pressure = 1;
    if (type === 'pen') {
      const raw = e.pressure;
      if (raw > 0 && raw !== 0.5 && raw !== 1) this.pressureSupported = true;
      // without real pressure data use full strength instead of a placeholder
      pressure = !this.pressureSupported ? 1 : raw > 0 ? raw : e.buttons ? 0.5 : 0;
    }
    return { type, pressure, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, button: e.button, t: e.timeStamp };
  }

  private touchIsNavOnly() {
    if (this.settings.palmRejection === 'off') return false;
    if (this.settings.palmRejection === 'on') return true;
    return this.penSeenAt > 0;
  }

  private clearLongPress() {
    if (this.longPressTimer !== null) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
  }

  /** Only events that start on the drawing surface are gestures; floating UI keeps its own. */
  private isSurface(e: Event) {
    const t = e.target as HTMLElement | null;
    return !!t && (t === this.el || t.tagName === 'CANVAS');
  }

  private down = (e: PointerEvent) => {
    if (!this.isSurface(e)) return;
    e.preventDefault();
    const { x, y } = this.pos(e);
    const p = this.info(e);
    this.onRaw?.(e, p.type);
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const tr: Track = { id: e.pointerId, type: p.type, x, y, sx: x, sy: y, t0: performance.now(), handler: null, role: 'pending', moved: false };
    this.tracks.set(e.pointerId, tr);

    if (p.type === 'pen') {
      this.penSeenAt = this.penLast = performance.now();
      this.penDown = true;
      // cancel any finger interaction (palm)
      for (const t of this.tracks.values()) if (t.type === 'touch') { t.handler?.cancel(); t.handler = null; t.role = 'ignore'; }
      this.clearLongPress();
      // barrel button (2) or eraser end (32) held while touching: orbit. Some pens report
      // the eraser with button === 5 on down; treat that the same way.
      if ((e.buttons & 2) || (e.buttons & 32) || e.button === 5 || e.button === 2) { tr.role = 'orbit'; return; }
      const h = this.cb.beginTool(x, y, p);
      if (h) { tr.handler = h; tr.role = 'tool'; }
      return;
    }

    if (p.type === 'mouse') {
      if (e.button === 1) { tr.role = e.shiftKey ? 'pan' : e.ctrlKey ? 'zoom' : 'orbit'; return; }
      if (e.button === 2) { tr.role = 'pan'; return; }
      if (e.altKey) { tr.role = e.shiftKey ? 'pan' : 'orbit'; return; }
      const h = this.cb.beginTool(x, y, p);
      if (h) { tr.handler = h; tr.role = 'tool'; }
      return;
    }

    // touch
    if (this.penDown || performance.now() - this.penLast < 400) { tr.role = 'ignore'; return; }
    const touches = [...this.tracks.values()].filter((t) => t.type === 'touch' && t.role !== 'ignore');
    if (touches.length >= 2) {
      // second (or third) finger: switch to multi-touch navigation
      this.clearLongPress();
      for (const t of touches) { if (t.handler) { t.handler.cancel(); t.handler = null; } t.role = 'nav2'; }
      if (touches.length === 2) this.multi = { start: performance.now(), maxCount: 2, moved: false, fired: false, ...this.multiMetrics() };
      else { this.multi.maxCount = Math.max(this.multi.maxCount, touches.length); Object.assign(this.multi, this.multiMetrics()); }
      return;
    }
    if (this.touchIsNavOnly()) { tr.role = 'orbit'; return; }
    const h = this.cb.beginTool(x, y, p);
    if (h) { tr.handler = h; tr.role = 'tool'; return; }
    // long-press → box select
    this.clearLongPress();
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null;
      if (tr.role !== 'pending' || tr.moved || !this.tracks.has(tr.id)) return;
      const bh = this.cb.beginBox(tr.x, tr.y, p);
      if (bh) { tr.handler = bh; tr.role = 'tool'; navigator.vibrate?.(15); }
    }, this.settings.longPressMs);
  };

  private multiMetrics() {
    const ts = [...this.tracks.values()].filter((t) => t.role === 'nav2');
    if (!ts.length) return { lastDist: 0, lastCx: 0, lastCy: 0 };
    const cx = ts.reduce((s, t) => s + t.x, 0) / ts.length;
    const cy = ts.reduce((s, t) => s + t.y, 0) / ts.length;
    const d = ts.length >= 2 ? Math.hypot(ts[0].x - ts[1].x, ts[0].y - ts[1].y) : 0;
    return { lastDist: d, lastCx: cx, lastCy: cy };
  }

  private move = (e: PointerEvent) => {
    const { x, y } = this.pos(e);
    const p = this.info(e);
    const tr = this.tracks.get(e.pointerId);
    if (tr) p.type = tr.type; // keep the classification made at pointer-down
    this.onRaw?.(e, p.type);
    if (!tr) {
      if (!this.isSurface(e)) return;
      // hover (pen in range or mouse without buttons)
      if (p.type === 'pen') this.penSeenAt = this.penLast = performance.now();
      if (p.type !== 'touch') this.cb.hover(x, y, p);
      return;
    }
    e.preventDefault();
    const dx = x - tr.x, dy = y - tr.y;
    tr.x = x; tr.y = y;
    if (!tr.moved && Math.hypot(x - tr.sx, y - tr.sy) > TAP_SLOP[tr.type]) tr.moved = true;

    switch (tr.role) {
      case 'tool': {
        // use coalesced events for smooth strokes
        const evs = (e.getCoalescedEvents?.() ?? []) as PointerEvent[];
        if (evs.length > 1) {
          const r = this.el.getBoundingClientRect();
          for (const ce of evs) tr.handler!.move(ce.clientX - r.left, ce.clientY - r.top, this.info(ce));
        } else tr.handler!.move(x, y, p);
        break;
      }
      case 'orbit': this.cb.orbit(dx, dy); break;
      case 'pan': this.cb.pan(dx, dy); break;
      case 'zoom': this.cb.zoom(Math.exp(dy * 0.01), tr.sx, tr.sy); break;
      case 'nav2': {
        const m = this.multiMetrics();
        const ddx = m.lastCx - this.multi.lastCx, ddy = m.lastCy - this.multi.lastCy;
        if (Math.abs(ddx) + Math.abs(ddy) > 0.01) this.cb.pan(ddx, ddy);
        if (this.multi.lastDist > 0 && m.lastDist > 0) this.cb.zoom(this.multi.lastDist / m.lastDist, m.lastCx, m.lastCy);
        if (tr.moved) this.multi.moved = true;
        Object.assign(this.multi, m);
        break;
      }
      case 'pending': {
        if (!tr.moved) break;
        // a quick, small pen wiggle is still a tap: wait before turning it into a box select
        if (tr.type === 'pen' && performance.now() - tr.t0 < QUICK_TAP.ms && Math.hypot(x - tr.sx, y - tr.sy) < QUICK_TAP.px) break;
        this.clearLongPress();
        if (tr.type === 'touch') {
          tr.role = this.cb.touchDragOrbits() ? 'orbit' : 'ignore';
          if (tr.role === 'orbit') this.cb.orbit(x - tr.sx, y - tr.sy);
        } else {
          const h = this.cb.beginBox(tr.sx, tr.sy, p);
          if (h) { tr.handler = h; tr.role = 'tool'; h.move(x, y, p); }
          else tr.role = tr.type === 'pen' ? 'ignore' : 'orbit';
        }
        break;
      }
    }
    if (tr.type !== 'touch' && tr.role !== 'tool') this.cb.hover(x, y, p);
  };

  private up = (e: PointerEvent) => {
    const tr = this.tracks.get(e.pointerId);
    if (!tr) return;
    e.preventDefault();
    const { x, y } = this.pos(e);
    const p = this.info(e);
    p.type = tr.type;
    this.onRaw?.(e, p.type);
    this.tracks.delete(e.pointerId);
    this.clearLongPress();
    if (tr.type === 'pen') { this.penDown = false; this.penLast = performance.now(); }

    if (tr.role === 'tool') {
      tr.handler!.end(x, y, p);
    } else if (tr.role === 'pending') {
      // still pending means it never became a drag: a tap (pens may have wiggled a little)
      this.emitTap(tr.moved ? tr.sx : x, tr.moved ? tr.sy : y, p);
    } else if (tr.role === 'nav2') {
      // multi-finger tap: fire on the first finger lift
      const dt = performance.now() - this.multi.start;
      if (!this.multi.moved && !this.multi.fired && dt < 320) {
        this.multi.fired = true;
        if (this.multi.maxCount === 2) this.cb.undo();
        else if (this.multi.maxCount >= 3) this.cb.redo();
      }
      const remaining = [...this.tracks.values()].filter((t) => t.role === 'nav2');
      if (remaining.length) {
        Object.assign(this.multi, this.multiMetrics());
        // a single remaining finger stays inert until lifted
        if (remaining.length === 1) remaining[0].role = 'ignore';
      }
    }
    if (p.type !== 'touch') this.cb.hover(x, y, p);
  };

  private emitTap(x: number, y: number, p: PInfo) {
    const now = performance.now();
    const near = Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 30;
    const count = now - this.lastTap.t < 350 && near ? this.lastTap.count + 1 : 1;
    this.lastTap = { t: now, x, y, count };
    this.cb.tap(x, y, p, count);
  }

  private cancel = (e: PointerEvent) => {
    const tr = this.tracks.get(e.pointerId);
    if (!tr) return;
    this.tracks.delete(e.pointerId);
    this.clearLongPress();
    tr.handler?.cancel();
    if (tr.type === 'pen') this.penDown = false;
  };

  private leave = (e: PointerEvent) => {
    if (!this.tracks.has(e.pointerId) && e.pointerType !== 'touch') {
      this.cb.hover(-1, -1, null);
    }
  };

  private wheel = (e: WheelEvent) => {
    if (!this.isSurface(e)) return;
    e.preventDefault();
    const { x, y } = this.pos(e);
    if (e.ctrlKey) this.cb.zoom(Math.exp(e.deltaY * 0.01), x, y); // trackpad pinch
    else if (e.shiftKey) this.cb.pan(-e.deltaX, -e.deltaY);
    else this.cb.zoom(Math.exp(e.deltaY * 0.0015), x, y);
  };

  /** Forget that a pen was used (re-enables finger tools in auto mode). */
  resetPen() { this.penSeenAt = 0; this.penDown = false; this.penLast = 0; }
}
