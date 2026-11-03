type Props = Record<string, any> & { class?: string; style?: string };
type Child = Node | string | null | undefined | false | Child[];

/** Tiny hyperscript helper. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
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

/* Minimal stroke icons (24x24 viewBox). */
const ICONS: Record<string, string> = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
  panel: 'M4 4h16v16H4zM14 4v16',
  orbit: 'M12 3a9 4 0 100 18 9 4 0 100-18zM3 12a9 9 0 0018 0',
  pan: 'M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3',
  zoom: 'M10 4a6 6 0 100 12 6 6 0 000-12zM15 15l6 6M7 10h6M10 7v6',
  frame: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M9 9h6v6H9z',
  views: 'M12 2l9 5v10l-9 5-9-5V7zM12 12l9-5M12 12v10M12 12L3 7',
  persp: 'M3 6l18-3v18L3 18zM3 12h18',
  check: 'M5 12l5 5 9-10',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeoff: 'M3 3l18 18M10.6 6.1A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3 3.6M6.2 6.2C3.6 8 2 12 2 12s4 6 10 6a9.6 9.6 0 004.4-1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  vert: 'M4 18L12 5l8 13zM12 5m-2.5 0a2.5 2.5 0 105 0 2.5 2.5 0 10-5 0',
  edge: 'M4 18L12 5l8 13z',
  face: 'M4 18L12 5l8 13z',
  pen: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3',
  help: 'M12 22a10 10 0 100-20 10 10 0 000 20zM9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01',
};

export function icon(name: string, size = 22): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', ICONS[name] ?? '');
  if (name === 'face') { p.setAttribute('fill', 'currentColor'); p.setAttribute('fill-opacity', '0.45'); }
  svg.appendChild(p);
  if (name === 'vert') {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', '12'); c.setAttribute('cy', '5'); c.setAttribute('r', '2.6'); c.setAttribute('fill', 'currentColor');
    svg.appendChild(c);
  }
  if (name === 'edge') {
    const l = document.createElementNS(ns, 'path');
    l.setAttribute('d', 'M4 18h16'); l.setAttribute('stroke-width', '3.4');
    svg.appendChild(l);
  }
  return svg;
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
    }, h('span', { class: 'menu-check' }, it.checked ? '✓' : ''), h('span', { class: 'menu-label' }, it.label), it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null, it.submenu ? h('span', { class: 'menu-hint' }, '›') : null);
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
