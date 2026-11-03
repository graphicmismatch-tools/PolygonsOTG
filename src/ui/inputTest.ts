import { App } from '../app';
import { h, clear, dialog } from './dom';
import { THIN_CONTACT_PX } from '../input';

/**
 * Stylus / touch test. Draw on the pad: the stroke colour shows how the app
 * classifies the pointer and its width follows pressure. The readout shows
 * the raw web values and (inside the Android app) the raw Android MotionEvent,
 * so mis-reported pens can be diagnosed.
 */
export function openInputTest(app: App, onSettingsChanged: () => void) {
  const g = app.gestures;
  const pad = h('canvas', { class: 'input-pad' }) as HTMLCanvasElement;
  const live = h('pre', { class: 'input-live' }, 'Draw or hover on the pad with your pen, then with a finger.');
  const summary = h('div', { class: 'input-summary' });
  const actions = h('div', { class: 'row' });
  const stats = {
    pen: 0, touch: 0, mouse: 0, other: 0, hover: 0, moves: 0, cancels: 0,
    pressures: new Set<number>(),
    thinTouches: 0, wideTouches: 0,
    nativeStylus: false, nativeFixed: 0, device: '',
  };
  const ctx = pad.getContext('2d')!;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const resize = () => {
    const r = pad.getBoundingClientRect();
    pad.width = Math.max(1, Math.round(r.width * dpr));
    pad.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const last = new Map<number, { x: number; y: number }>();
  const colour = (t: string) => (t === 'pen' ? '#7ccf3a' : t === 'touch' ? '#4a86f0' : '#ffa033');

  const nativeInfo = (): any => {
    try { return window.PolygonsAndroid && (window.PolygonsAndroid as any).lastMotion ? JSON.parse((window.PolygonsAndroid as any).lastMotion()) : null; } catch { return null; }
  };
  const TOOL = ['unknown', 'finger', 'stylus', 'mouse', 'eraser'];

  const show = (e: PointerEvent, kind: string) => {
    const cls = g.classify(e);
    const n = nativeInfo();
    if (n) {
      stats.device = n.device;
      if (n.stylusSource || n.tool === 2 || n.tool === 4) stats.nativeStylus = true;
      stats.nativeFixed = n.fixed;
    }
    live.textContent =
      `${kind.padEnd(12)} web pointerType = ${e.pointerType || '(empty)'}  →  app uses: ${cls.toUpperCase()}\n` +
      `pressure ${e.pressure.toFixed(3)}  tilt ${e.tiltX}/${e.tiltY}  buttons ${e.buttons}  button ${e.button}\n` +
      `contact ${e.width.toFixed(1)}×${e.height.toFixed(1)} px  id ${e.pointerId}  primary ${e.isPrimary}\n` +
      (n ? `android: ${n.action} tool=${TOOL[n.tool] ?? n.tool} stylusSource=${n.stylusSource} buttons=${n.buttons} pressure=${Number(n.pressure).toFixed(3)}\n         device "${n.device}"  pen events corrected: ${n.fixed}` : 'android: (raw Android events are not exposed in this build)');
    renderSummary();
  };

  const renderSummary = () => {
    clear(summary); clear(actions);
    const lines: [boolean | null, string][] = [];
    lines.push([stats.pen > 0, stats.pen ? `Pen detected (${stats.pen} events)` : 'No pen events yet — draw on the pad with the pen']);
    if (stats.pen) lines.push([g.pressureSupported, g.pressureSupported ? `Pressure works (${stats.pressures.size} distinct levels)` : 'No real pressure reported — the app uses full strength']);
    if (stats.hover) lines.push([true, 'Hover works (preview highlights / brush cursor)']);
    if (stats.nativeStylus && !stats.pen && stats.touch) lines.push([false, 'Android sees a stylus but the web view gets a finger']);
    if (!stats.pen && stats.thinTouches > 3 && stats.wideTouches === 0) lines.push([null, `All contacts so far were tiny (≤ ${THIN_CONTACT_PX}px) — draw with a finger too to compare`]);
    if (stats.touch || stats.pen) lines.push([stats.moves > 0, `${stats.moves} move events${stats.cancels ? `, ${stats.cancels} cancelled` : ''}`]);
    if (stats.touch && !stats.pen) lines.push([null, g.settings.touchAsPen
      ? 'Touch acts like a pen is ON: one finger / your pen edits like a pen, two fingers navigate.'
      : 'If your pen draws blue, Android reports it as a finger. Turn on "Touch acts like a pen" so it edits like a pen (two fingers still navigate).']);
    if (stats.device) lines.push([null, `Input device: ${stats.device}`]);
    for (const [ok, t] of lines) summary.append(h('div', { class: ok === null ? 'note' : ok ? 'ok' : 'bad' }, `${ok === null ? '' : ok ? '[ok] ' : '[!!] '}${t}`));
    actions.append(h('button', { class: 'tiny', onclick: () => { g.settings.touchAsPen = !g.settings.touchAsPen; onSettingsChanged(); renderSummary(); } },
      g.settings.touchAsPen ? 'Touch acts like a pen: ON' : 'Touch acts like a pen: OFF'));
    const thin = g.settings.stylusDetect === 'thin';
    if ((!stats.pen && stats.thinTouches > 0 && stats.wideTouches > 0) || thin) {
      actions.append(h('button', { class: 'tiny', onclick: () => { g.settings.stylusDetect = thin ? 'auto' : 'thin'; onSettingsChanged(); renderSummary(); } },
        thin ? 'Use normal pen detection' : 'Treat thin contacts as pen'));
    }
    actions.append(h('button', { class: 'tiny', onclick: () => { ctx.clearRect(0, 0, pad.width, pad.height); Object.assign(stats, { pen: 0, touch: 0, mouse: 0, other: 0, hover: 0, thinTouches: 0, wideTouches: 0 }); stats.pressures.clear(); renderSummary(); } }, 'Clear'));
  };

  pad.style.touchAction = 'none';
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { pad.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const r = pad.getBoundingClientRect();
    last.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    const t = e.pointerType;
    if (t === 'pen') stats.pen++; else if (t === 'touch') stats.touch++; else if (t === 'mouse') stats.mouse++; else stats.other++;
    if (t === 'touch') { if (e.width <= THIN_CONTACT_PX && e.height <= THIN_CONTACT_PX) stats.thinTouches++; else stats.wideTouches++; }
    show(e, 'down');
  });
  pad.addEventListener('pointermove', (e) => {
    const r = pad.getBoundingClientRect();
    const l = last.get(e.pointerId);
    if (!l) { if (e.pointerType !== 'touch') { stats.hover++; show(e, 'hover'); } return; }
    stats.moves++;
    const evs = (e.getCoalescedEvents?.() ?? [e]) as PointerEvent[];
    for (const ce of evs.length ? evs : [e]) {
      const cx = ce.clientX - r.left, cy = ce.clientY - r.top;
      if (g.classify(ce) === 'pen' && ce.pressure > 0) {
        stats.pressures.add(Math.round(ce.pressure * 100));
        if (ce.pressure !== 0.5 && ce.pressure !== 1) g.pressureSupported = true;
      }
      const cls = g.classify(ce);
      const pr = cls === 'pen' ? (ce.pressure > 0 ? ce.pressure : 0.5) : 0.5;
      ctx.strokeStyle = colour(cls);
      ctx.lineWidth = 1 + pr * 10;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(cx, cy); ctx.stroke();
      l.x = cx; l.y = cy;
    }
    show(e, 'move');
  });
  const end = (e: PointerEvent) => { if (e.type === 'pointercancel') stats.cancels++; last.delete(e.pointerId); show(e, e.type === 'pointercancel' ? 'CANCEL' : 'up'); };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  pad.addEventListener('contextmenu', (e) => e.preventDefault());

  const legend = h('div', { class: 'note' }, 'stroke colour: green = pen · blue = finger · orange = mouse · width = pressure');
  const noGl = location.search.includes('stylustest')
    ? null
    : h('div', { class: 'row' }, h('span', { class: 'note' }, 'Pen ignored here but fine in a floating window?'),
      h('button', { class: 'tiny', onclick: () => { (app as any).autosave?.().finally?.(() => { location.href = location.pathname + '?stylustest'; }); } }, 'Test without 3D view'));
  const body = h('div', { class: 'input-test' }, legend, pad, live, summary, actions, noGl);
  dialog('Stylus & touch test', body);
  requestAnimationFrame(() => { resize(); renderSummary(); });
}
