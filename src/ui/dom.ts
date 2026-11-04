type Props = Record<string, any> & { class?: string; style?: string };
type Child = Node | string | null | undefined | false | Child[];

/** Tiny hyperscript helper. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'tip') { el.dataset.tip = v; el.setAttribute('aria-label', v); }
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(c));
  }
}

export function clear(el: HTMLElement) { while (el.firstChild) el.firstChild.remove(); }

/* ------------------------------------------------------------------ icons
 * 24x24 stroke icons. `d` is stroked; `fill` is filled at reduced opacity;
 * `solid` is filled fully; `bold` is stroked thicker (emphasis line). */
interface IconDef { d?: string; fill?: string; solid?: string; bold?: string }
const dot = (x: number, y: number, r = 1.8) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const ICONS: Record<string, IconDef> = {
  menu: { d: 'M4 6h16M4 12h16M4 18h16' },
  undo: { d: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3' },
  redo: { d: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3' },
  panel: { d: 'M4 4h16v16H4zM14 4v16M16.5 8h1.5M16.5 11h1.5' },
  orbit: { d: 'M12 3a9 4 0 100 18 9 4 0 100-18zM3 12a9 9 0 0018 0' },
  pan: { d: 'M8 12V5a1.5 1.5 0 013 0v6M11 10V4a1.5 1.5 0 013 0v7M14 10V6a1.5 1.5 0 013 0v8a7 7 0 01-7 7 6 6 0 01-5-3l-3-5a1.5 1.5 0 012.5-1.5L8 14' },
  zoom: { d: 'M10 4a6 6 0 100 12 6 6 0 000-12zM15 15l6 6M7 10h6M10 7v6' },
  frame: { d: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5', fill: 'M9 9h6v6H9z' },
  views: { d: 'M12 2l9 5v10l-9 5-9-5V7zM12 12l9-5M12 12v10M12 12L3 7' },
  check: { d: 'M5 12l5 5 9-10' },
  close: { d: 'M6 6l12 12M18 6L6 18' },
  plus: { d: 'M12 5v14M5 12h14' },
  minus: { d: 'M5 12h14' },
  eye: { d: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z' },
  eyeoff: { d: 'M3 3l18 18M10.6 6.1A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3 3.6M6.2 6.2C3.6 8 2 12 2 12s4 6 10 6a9.6 9.6 0 004.4-1' },
  trash: { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5' },
  help: { d: 'M12 22a10 10 0 100-20 10 10 0 000 20zM9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01' },
  settings: { d: 'M12 9a3 3 0 100 6 3 3 0 000-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1' },
  // selection modes
  vert: { d: 'M4 18L12 5l8 13z', solid: dot(12, 5, 2.8) },
  edge: { d: 'M4 18L12 5l8 13z', bold: 'M4 18h16' },
  face: { d: 'M4 18L12 5l8 13z', fill: 'M4 18L12 5l8 13z' },
  // modes
  modeObject: { d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12v9M12 12l8-4.5M12 12L4 7.5', fill: 'M12 12l8-4.5L12 3 4 7.5z' },
  modeEdit: { d: 'M5 18L12 6l7 12z', solid: dot(5, 18) + dot(12, 6) + dot(19, 18) },
  modeSculpt: { d: 'M14 4l6 6-8 8-6-6zM6 12l-2 6 6-2', fill: 'M14 4l6 6-3 3-6-6z' },
  modeUV: { d: 'M4 4h16v16H4zM4 12h16M12 4v16', fill: 'M12 12h8v8h-8z' },
  // selection ops
  selSet: { d: 'M5 3l14 7-6 2-2 6z' },
  selAdd: { d: 'M4 3l11 5.5-4.7 1.6L8.7 15zM18 13v8M14 17h8' },
  selSub: { d: 'M4 3l11 5.5-4.7 1.6L8.7 15zM14 17h8' },
  selAll: { d: 'M4 8V4h4M10 4h4M16 4h4v4M20 10v4M20 16v4h-4M14 20h-4M8 20H4v-4M4 14v-4', fill: 'M8 8h8v8H8z' },
  // transforms
  move: { d: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3' },
  rotate: { d: 'M20 12a8 8 0 11-2.3-5.6M20 4v5h-5' },
  scale: { d: 'M4 20l7-7M4 14v6h6M20 4l-7 7M20 10V4h-6', fill: 'M9 9h6v6H9z' },
  gizmoOff: { d: 'M12 3v18M3 12h18M4 4l16 16' },
  // object
  add: { d: 'M12 5v14M5 12h14' },
  duplicate: { d: 'M9 9h11v11H9zM5 15H4V4h11v1' },
  join: { d: 'M6 3v5a6 6 0 006 6 6 6 0 006-6V3M12 14v7' },
  shading: { d: 'M12 3a9 9 0 100 18 9 9 0 000-18z', fill: 'M12 3a9 9 0 010 18z' },
  apply: { d: 'M4 4h16v16H4zM8 12l3 3 5-6' },
  origin: { d: 'M12 2v6M12 16v6M2 12h6M16 12h6', solid: dot(12, 12, 2.4) },
  // edit tools
  extrude: { d: 'M4 15h16v5H4zM12 12V3M8 7l4-4 4 4', fill: 'M4 15h16v5H4z' },
  inset: { d: 'M3 3h18v18H3zM3 3l5 5M21 3l-5 5M3 21l5-5M21 21l-5-5', fill: 'M8 8h8v8H8z' },
  loopcut: { d: 'M4 4h16v16H4zM12 4v16', bold: 'M2 12h20' },
  subdivide: { d: 'M4 4h16v16H4zM12 4v16M4 12h16' },
  connect: { d: 'M4 4h16v16H4z', bold: 'M5 19L19 5', solid: dot(4, 20, 2.4) + dot(20, 4, 2.4) },
  merge: { d: 'M4 4l5 5M20 4l-5 5M4 20l5-5M20 20l-5-5', solid: dot(12, 12, 2.6) },
  fill: { d: 'M4 18L8 5l12 3-3 12z', fill: 'M4 18L8 5l12 3-3 12z' },
  bridge: { d: 'M3 5h18M3 19h18', fill: 'M5 5h14v14H5z' },
  deleteMenu: { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5' },
  selectMenu: { d: 'M5 3l14 7-6 2-2 6z', solid: dot(19, 19, 1.5) + dot(14.5, 19, 1.5) },
  meshMenu: { d: 'M14.5 6a4 4 0 00-5 5L3 17.5 6.5 21l6.5-6.5a4 4 0 005-5L15 12.5 11.5 9z' },
  seams: { d: 'M6 3a3 3 0 100 6 3 3 0 000-6zM6 15a3 3 0 100 6 3 3 0 000-6zM8.5 7.5L20 18M8.5 16.5L20 6' },
  unwrap: { d: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z', fill: 'M9 9h6v6H9z' },
  bevel: { d: 'M4 20V10l6-6h10v16z', bold: 'M4 10l6-6' },
  knife: { d: 'M3 21l8.5-8.5', fill: 'M11.5 12.5L19 3l2 2-7.5 9.5z', bold: '' },
  proportional: { d: 'M12 2.5a9.5 9.5 0 100 19 9.5 9.5 0 000-19z', fill: 'M12 7a5 5 0 100 10 5 5 0 000-10z', solid: 'M10.4 12a1.6 1.6 0 103.2 0 1.6 1.6 0 10-3.2 0' },
  dyntopo: { d: 'M3 20L12 4l9 16zM7.5 12h9M12 20l-4.5-8M12 20l4.5-8' },
  detail: { d: 'M4 4h16v16H4zM4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16' },
  remesh: { d: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3.5 9h17M3.5 15h17M12 3c-3 3-3 15 0 18M12 3c3 3 3 15 0 18' },
  touchPen: { d: 'M4 20l3.5-1L18 8.5 15.5 6 5 16.5zM13.5 8l2.5 2.5', solid: 'M18.5 3.5a2 2 0 102.8 2.8 2 2 0 10-2.8-2.8' },
  // view toggles
  xray: { d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5', bold: '', fill: 'M12 12v9l-8-4.5v-9z' },
  mirror: { d: 'M12 2v2M12 7v2M12 12v2M12 17v2M12 22v0', fill: 'M9 6L3 12l6 6zM15 6l6 6-6 6z' },
  snap: { d: 'M6 3v8a6 6 0 0012 0V3h-4v8a2 2 0 01-4 0V3zM6 7h4M14 7h4' },
  // sculpt
  brushDraw: { d: 'M3 17c3-6 6 0 9-6s6 0 9-6' },
  brushClay: { d: 'M3 19h18', fill: 'M5 15h14v4H5zM8 11h8v4H8z' },
  brushInflate: { d: 'M12 7a5 5 0 100 10 5 5 0 000-10zM12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3', fill: 'M12 7a5 5 0 100 10 5 5 0 000-10z' },
  brushSmooth: { d: 'M3 8c3-4 6 4 9 0s6-4 9 0', bold: 'M3 17h18' },
  brushFlatten: { d: 'M7 5l5 5 5-5M12 3v7', bold: 'M3 15h18' },
  brushPinch: { d: 'M2 12h6M22 12h-6M5 9l3 3-3 3M19 9l-3 3 3 3', solid: dot(12, 12, 1.6) },
  brushCrease: { d: 'M3 6l9 12 9-12' },
  brushGrab: { d: 'M8 12V5a1.5 1.5 0 013 0v6M11 10V4a1.5 1.5 0 013 0v7M14 10V6a1.5 1.5 0 013 0v8a7 7 0 01-7 7 6 6 0 01-5-3l-3-5a1.5 1.5 0 012.5-1.5L8 14' },
  brushAdd: { d: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8v8M8 12h8' },
  brushSub: { d: 'M12 3a9 9 0 100 18 9 9 0 000-18zM8 12h8' },
  radius: { d: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 12h9', solid: dot(12, 12, 1.5) },
  strength: { d: 'M13 2L4 14h7l-1 8 9-12h-7z' },
  // uv
  smartUV: { d: 'M3 3h8v8H3zM13 13h8v8h-8zM17 2v7M13.5 5.5h7' },
  project: { d: 'M3 12l7-5v10zM10 7l11-4M10 17l11 4', bold: 'M21 3v18' },
  pack: { d: 'M3 3h18v18H3zM3 12h10M13 3v18M13 16h8' },
  tools: { d: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4' },
  image: { d: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M16 9h.01' },
  // rigging
  bone: { d: 'M7 17l10-10M5 15a2.5 2.5 0 103.5 3.5M3.8 19.5L5 15M15.5 5.5A2.5 2.5 0 1019 9M19 9l1.2-4.5L15.5 5.5', solid: dot(7, 17, 1.2) },
  modePose: { d: 'M12 3a2 2 0 100 4 2 2 0 000-4zM12 7v7M12 14l-4 7M12 14l4 7M12 9l-6 3M12 9l5-4', solid: dot(12, 9, 1.4) },
  modeWeight: { d: 'M4 20c2-8 6-13 8-16 2 3 6 8 8 16z', fill: 'M7 20c1.5-5 3.5-8 5-10 1.5 2 3.5 5 5 10z' },
  boneAdd: { d: 'M5 19l9-9M3 21l2-2M16 4v6M13 7h6' },
  boneExtrude: { d: 'M4 20l7-7M11 13l7-7', solid: dot(11, 13, 2) + dot(18, 6, 1.6) },
  rig: { d: 'M12 3v5M12 8l-6 5M12 8l6 5M6 13v6M18 13v6', solid: dot(12, 3, 1.6) + dot(12, 8, 1.6) + dot(6, 13, 1.6) + dot(18, 13, 1.6) },
  symmetrize: { d: 'M12 3v18M9 7L4 12l5 5M15 7l5 5-5 5' },
  clearPose: { d: 'M4 12a8 8 0 1016 0 8 8 0 00-16 0M4 4l4 4M8 4v4H4' },
  autoWeights: { d: 'M13 2L4 14h7l-1 8 9-12h-7z', fill: 'M13 2L4 14h7l-1 8 9-12h-7z' },
  wDraw: { d: 'M4 20c2-8 6-13 8-16 2 3 6 8 8 16z', bold: 'M8 20h8' },
  // animation
  play: { d: 'M7 4l13 8-13 8z', fill: 'M7 4l13 8-13 8z' },
  pause: { d: 'M7 4v16M17 4v16', bold: 'M7 4v16M17 4v16' },
  key: { d: 'M12 3l7 9-7 9-7-9z', fill: 'M12 3l7 9-7 9-7-9z' },
  keyDel: { d: 'M12 3l7 9-7 9-7-9zM8 12h8' },
  prevKey: { d: 'M5 4v16M19 5l-5 7 5 7-5-7z', fill: 'M19 5l-5 7 5 7' },
  nextKey: { d: 'M19 4v16M5 5l5 7-5 7 5-7z', fill: 'M5 5l5 7-5 7' },
  autoKey: { d: 'M12 3a9 9 0 100 18 9 9 0 000-18z', solid: dot(12, 12, 4.5) },
  ik: { d: 'M4 20l6-8 4 6 6-12', solid: dot(20, 6, 2) },
  film: { d: 'M3 5h18v14H3zM7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4' },
};

export function icon(name: string, size = 22): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'square');
  svg.setAttribute('stroke-linejoin', 'miter');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('shape-rendering', 'geometricPrecision');
  const def = ICONS[name] ?? { d: '' };
  const path = (d: string, attrs: Record<string, string>) => {
    if (!d) return;
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
    svg.appendChild(p);
  };
  if (def.fill) path(def.fill, { fill: 'currentColor', 'fill-opacity': '0.35', stroke: 'none' });
  if (def.d) path(def.d, {});
  if (def.bold) path(def.bold, { 'stroke-width': '3.2' });
  if (def.solid) path(def.solid, { fill: 'currentColor', stroke: 'none' });
  return svg;
}

/* ------------------------------------------------------------------ tooltips
 * Elements with data-tip show their friendly name on long-press (touch / pen)
 * or after a short hover (mouse / hovering pen). A long-press never triggers
 * the button's action. */
let tipEl: HTMLElement | null = null;
let tipTimer = 0;
let hideTimer = 0;
let suppressClick = false;
let pressStart: { x: number; y: number; target: HTMLElement } | null = null;

export function tip<T extends HTMLElement>(el: T, text: string): T {
  el.dataset.tip = text;
  el.setAttribute('aria-label', text);
  return el;
}

function showTip(target: HTMLElement) {
  const text = target.dataset.tip;
  if (!text || !target.isConnected) return;
  clearTimeout(hideTimer);
  if (!tipEl) { tipEl = h('div', { class: 'tooltip', role: 'tooltip' }); document.body.append(tipEl); }
  tipEl.textContent = text;
  tipEl.classList.add('show');
  const r = target.getBoundingClientRect();
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  const vw = window.innerWidth;
  // prefer the side away from the finger: right of rail items, else above
  let x: number, y: number;
  if (r.left < 120 && r.height < 80 && r.right + tw + 10 < vw) { x = r.right + 8; y = r.top + r.height / 2 - th / 2; }
  else if (r.right > vw - 120 && r.left - tw - 10 > 0) { x = r.left - tw - 8; y = r.top + r.height / 2 - th / 2; }
  else { x = r.left + r.width / 2 - tw / 2; y = r.top - th - 8; if (y < 4) y = r.bottom + 8; }
  tipEl.style.left = `${Math.max(4, Math.min(vw - tw - 4, x))}px`;
  tipEl.style.top = `${Math.max(4, y)}px`;
}

export function hideTip(delay = 0) {
  clearTimeout(tipTimer);
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => tipEl?.classList.remove('show'), delay);
}

export function installTooltips() {
  const findTip = (e: Event) => (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
  document.addEventListener('pointerdown', (e) => {
    hideTip();
    const t = findTip(e);
    if (!t) return;
    pressStart = { x: e.clientX, y: e.clientY, target: t };
    tipTimer = window.setTimeout(() => {
      if (!pressStart) return;
      showTip(t);
      suppressClick = true;
      navigator.vibrate?.(10);
    }, e.pointerType === 'mouse' ? 700 : 450);
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) { pressStart = null; clearTimeout(tipTimer); }
  }, true);
  const end = () => {
    if (pressStart && suppressClick) hideTip(1200);
    pressStart = null;
    clearTimeout(tipTimer);
    // the click (if any) fires right after pointerup; release suppression shortly after
    if (suppressClick) setTimeout(() => (suppressClick = false), 350);
  };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
  document.addEventListener('click', (e) => {
    if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; }
  }, true);
  document.addEventListener('contextmenu', (e) => { if (findTip(e)) e.preventDefault(); }, true);
  // hover tooltips for mouse and hovering pens
  const canHover = () => matchMedia('(any-hover: hover)').matches;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch' || pressStart || (e.pointerType === 'mouse' && !canHover())) return;
    const t = findTip(e);
    if (!t) return;
    clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => showTip(t), 550);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch' || pressStart) return;
    const t = findTip(e);
    if (t && !t.contains(e.relatedTarget as Node)) hideTip();
  });
}

export interface MenuItem {
  label: string;
  hint?: string;
  action?: () => void;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  separator?: boolean;
  submenu?: () => MenuItem[];
}

let openMenu: HTMLElement | null = null;

export function closeMenus() { openMenu?.remove(); openMenu = null; }

/** Popover menu anchored to an element (touch-friendly, closes on outside tap). */
export function showMenu(anchor: HTMLElement, items: MenuItem[], title?: string) {
  closeMenus();
  const backdrop = h('div', { class: 'menu-backdrop', onpointerdown: (e: Event) => { if (e.target === backdrop) { e.preventDefault(); closeMenus(); } } });
  const box = h('div', { class: 'menu' }, title ? h('div', { class: 'menu-title' }, title) : null);
  for (const it of items) {
    if (it.separator) { box.append(h('div', { class: 'menu-sep' })); continue; }
    const b = h('button', {
      class: `menu-item${it.danger ? ' danger' : ''}${it.checked ? ' checked' : ''}`,
      disabled: it.disabled,
      onclick: () => {
        if (it.submenu) { showMenu(anchor, it.submenu(), it.label); return; }
        closeMenus();
        it.action?.();
      },
    }, h('span', { class: 'menu-check' }, it.checked === undefined ? '' : it.checked ? '[x]' : '[ ]'), h('span', { class: 'menu-label' }, it.label), it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null, it.submenu ? h('span', { class: 'menu-hint' }, '›') : null);
    box.append(b);
  }
  backdrop.append(box);
  document.body.append(backdrop);
  openMenu = backdrop;
  // position
  const r = anchor.getBoundingClientRect();
  const bw = box.offsetWidth, bh = box.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = r.right + 6, y = r.top;
  if (x + bw > vw - 6) x = r.left - bw - 6;
  if (x < 6) x = Math.max(6, Math.min(vw - bw - 6, r.left));
  if (x === Math.max(6, Math.min(vw - bw - 6, r.left))) y = r.bottom + 6;
  if (y + bh > vh - 6) y = Math.max(6, vh - bh - 6);
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
}

/** Simple modal dialog. */
export function dialog(title: string, body: HTMLElement, buttons: { label: string; primary?: boolean; action?: () => void }[] = [{ label: 'Close' }]) {
  closeMenus();
  const wrap = h('div', { class: 'dialog-backdrop' });
  const close = () => wrap.remove();
  const box = h('div', { class: 'dialog' },
    h('div', { class: 'dialog-title' }, title),
    h('div', { class: 'dialog-body' }, body),
    h('div', { class: 'dialog-buttons' }, buttons.map((b) => h('button', { class: b.primary ? 'primary' : '', onclick: () => { close(); b.action?.(); } }, b.label))),
  );
  wrap.append(box);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.body.append(wrap);
  return close;
}

export function toast(text: string) {
  const t = h('div', { class: 'toast' }, text);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}
