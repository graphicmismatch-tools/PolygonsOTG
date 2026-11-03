import { h, clear, icon } from './dom';

/* ======================================================================
 * Respite / Aseprite-style colour picker: SV square + vertical hue strip,
 * RGB / HSV slider tabs with number boxes, hex field and a saved palette.
 * HSV is kept as its own state so the hue survives greys and black.
 * ==================================================================== */

type RGB = [number, number, number];

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0')).join('');

export function rgbToHsv(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d) {
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  return { h: hh, s: mx ? d / mx : 0, v: mx };
}
export function hsvToRgb(hh: number, s: number, v: number): RGB {
  const c = v * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const PALETTE_KEY = 'polygons-otg-palette';
const DEFAULT_PALETTE = [
  '#c8ccd4', '#f2f2f2', '#8a8f99', '#3c3f46', '#1b1c20', '#e8c9a8', '#b07d5a', '#6b4532',
  '#e04a4a', '#f08a3c', '#f2c94c', '#7ccf3a', '#3fb58f', '#4a86f0', '#7a5cf0', '#d65db1',
];
function loadPalette(): string[] {
  try { const j = JSON.parse(localStorage.getItem(PALETTE_KEY) ?? 'null'); if (Array.isArray(j) && j.every((x) => typeof x === 'string')) return j; } catch { /* ignore */ }
  return DEFAULT_PALETTE.slice();
}
function savePalette(p: string[]) { try { localStorage.setItem(PALETTE_KEY, JSON.stringify(p)); } catch { /* ignore */ } }

/** hue memory per picker id so re-rendered pickers keep the hue of greys */
const hueMemory = new Map<string, { h: number; s: number }>();

export interface ColorPickerOptions {
  id: string;
  value: string;
  /** live updates while dragging (cheap redraw) */
  onInput: (hex: string) => void;
  /** a change is finished (record undo, full update) */
  onCommit: (hex: string) => void;
  /** called once before the first change of an interaction (e.g. push undo) */
  onBegin?: () => void;
}

export function colorPicker(o: ColorPickerOptions): HTMLElement {
  let [r, g, b] = hexToRgb(o.value);
  let hsv = rgbToHsv(r, g, b);
  const mem = hueMemory.get(o.id);
  if (mem) { if (!hsv.s || !hsv.v) hsv.h = mem.h; if (!hsv.v) hsv.s = mem.s; }
  let mode: 'rgb' | 'hsv' = 'hsv';
  let began = false;
  const begin = () => { if (!began) { began = true; o.onBegin?.(); } };
  const commit = () => { if (began) { began = false; o.onCommit(hex()); } };
  const hex = () => rgbToHex(r, g, b);

  const swatch = h('div', { class: 'cp-swatch' });
  const hexIn = h('input', { class: 'num cp-hex', type: 'text', value: hex().slice(1), maxlength: '7', spellcheck: false, 'aria-label': 'Hex colour' }) as HTMLInputElement;
  const sv = h('canvas', { class: 'cp-sv', 'aria-label': 'Saturation and value' }) as HTMLCanvasElement;
  const hue = h('canvas', { class: 'cp-hue', 'aria-label': 'Hue' }) as HTMLCanvasElement;
  const tabs = h('div', { class: 'seg cp-tabs' });
  const sliders = h('div', { class: 'cp-sliders' });
  const palette = h('div', { class: 'cp-palette' });

  const setFromHsv = () => {
    [r, g, b] = hsvToRgb(hsv.h, hsv.s, hsv.v);
    hueMemory.set(o.id, { h: hsv.h, s: hsv.s });
    sync();
    o.onInput(hex());
  };
  const setFromRgb = (nr: number, ng: number, nb: number) => {
    [r, g, b] = [nr, ng, nb];
    const n = rgbToHsv(r, g, b);
    if (!n.v) n.s = hsv.s;
    if (!n.s || !n.v) n.h = hsv.h;
    hsv = n;
    hueMemory.set(o.id, { h: hsv.h, s: hsv.s });
    sync();
    o.onInput(hex());
  };

  const fit = (cv: HTMLCanvasElement) => {
    const d = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(cv.clientWidth * d)), hh = Math.max(1, Math.round(cv.clientHeight * d));
    if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
    return { x: cv.getContext('2d')!, w, h: hh, d };
  };
  const marker = (x: CanvasRenderingContext2D, px: number, py: number, w: number, hh: number) => {
    x.lineWidth = 2; x.strokeStyle = '#000'; x.strokeRect(px - w / 2, py - hh / 2, w, hh);
    x.strokeStyle = '#fff'; x.strokeRect(px - w / 2 + 2, py - hh / 2 + 2, w - 4, hh - 4);
  };
  const drawCanvases = () => {
    let c = fit(sv);
    c.x.fillStyle = `rgb(${hsvToRgb(hsv.h, 1, 1)})`; c.x.fillRect(0, 0, c.w, c.h);
    let gr = c.x.createLinearGradient(0, 0, c.w, 0); gr.addColorStop(0, '#fff'); gr.addColorStop(1, '#fff0'); c.x.fillStyle = gr; c.x.fillRect(0, 0, c.w, c.h);
    gr = c.x.createLinearGradient(0, 0, 0, c.h); gr.addColorStop(0, '#0000'); gr.addColorStop(1, '#000'); c.x.fillStyle = gr; c.x.fillRect(0, 0, c.w, c.h);
    marker(c.x, hsv.s * c.w, (1 - hsv.v) * c.h, 12 * c.d, 12 * c.d);
    c = fit(hue);
    gr = c.x.createLinearGradient(0, 0, 0, c.h);
    for (let i = 0; i <= 6; i++) gr.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
    c.x.fillStyle = gr; c.x.fillRect(0, 0, c.w, c.h);
    marker(c.x, c.w / 2, (hsv.h / 360) * c.h, c.w, 8 * c.d);
  };

  const SL = { rgb: [['R', 'r', 255], ['G', 'g', 255], ['B', 'b', 255]], hsv: [['H', 'h', 360], ['S', 's', 100], ['V', 'v', 100]] } as const;
  const buildSliders = () => {
    clear(sliders);
    for (const [label, k, max] of SL[mode]) {
      const range = h('input', { type: 'range', min: '0', max: String(max), 'data-k': k, 'aria-label': label }) as HTMLInputElement;
      const num = h('input', { class: 'num', type: 'text', inputmode: 'numeric', 'data-k': k, 'aria-label': label }) as HTMLInputElement;
      const onVal = (vv: number) => {
        begin();
        const v = clamp(Math.round(vv) || 0, 0, max);
        if (k === 'h' || k === 's' || k === 'v') { hsv = { ...hsv, [k]: k === 'h' ? v : v / 100 }; setFromHsv(); }
        else { const ch = { r, g, b }; ch[k] = v; setFromRgb(ch.r, ch.g, ch.b); }
      };
      range.addEventListener('input', () => onVal(+range.value));
      range.addEventListener('change', commit);
      num.addEventListener('change', () => { onVal(+num.value); commit(); });
      sliders.append(h('div', { class: 'cp-slider' }, h('span', {}, label), range, num));
    }
    syncSliders();
  };
  const syncSliders = () => {
    const vals: Record<string, number> = { r, g, b, h: Math.round(hsv.h), s: Math.round(hsv.s * 100), v: Math.round(hsv.v * 100) };
    const rgb = (...c: number[]) => `rgb(${c})`, hs = (a: number, s: number, v: number) => rgb(...hsvToRgb(a, s, v));
    const grads: Record<string, string[]> = {
      r: [rgb(0, g, b), rgb(255, g, b)], g: [rgb(r, 0, b), rgb(r, 255, b)], b: [rgb(r, g, 0), rgb(r, g, 255)],
      h: [0, 60, 120, 180, 240, 300, 359.9].map((d) => hs(d, 1, 1)), s: [hs(hsv.h, 0, hsv.v), hs(hsv.h, 1, hsv.v)], v: [hs(hsv.h, hsv.s, 0), hs(hsv.h, hsv.s, 1)],
    };
    for (const el of sliders.querySelectorAll('input') as NodeListOf<HTMLInputElement>) {
      const k = el.dataset.k!;
      if (el.type === 'range') { el.value = String(vals[k]); el.style.setProperty('--track', `linear-gradient(90deg, ${grads[k].join(',')})`); }
      else if (el !== document.activeElement) el.value = String(vals[k]);
    }
  };
  const buildTabs = () => {
    clear(tabs);
    for (const m of ['hsv', 'rgb'] as const) tabs.append(h('button', { class: `segbtn${mode === m ? ' on' : ''}`, onclick: () => { mode = m; buildTabs(); buildSliders(); } }, m.toUpperCase()));
  };

  let pal = loadPalette();
  const buildPalette = () => {
    clear(palette);
    const cur = hex();
    pal.forEach((c, i) => {
      const btn = h('button', { class: `cp-chip${c.toLowerCase() === cur ? ' on' : ''}`, style: `background:${c}`, tip: `${c} — long-press to remove`, onclick: () => { begin(); setFromRgb(...hexToRgb(c)); commit(); } });
      const remove = (e: Event) => { e.preventDefault(); pal.splice(i, 1); savePalette(pal); buildPalette(); };
      btn.addEventListener('contextmenu', remove);
      let t = 0;
      btn.addEventListener('pointerdown', () => { t = window.setTimeout(() => { btn.dataset.removing = '1'; }, 600); });
      btn.addEventListener('pointerup', (e) => { clearTimeout(t); if (btn.dataset.removing) { delete btn.dataset.removing; remove(e); } });
      btn.addEventListener('pointercancel', () => clearTimeout(t));
      palette.append(btn);
    });
    palette.append(h('button', { class: 'cp-chip cp-add', tip: 'Add current colour to the palette', onclick: () => { const c = hex(); if (!pal.includes(c)) { pal.push(c); savePalette(pal); buildPalette(); } } }, icon('plus', 14)));
  };

  const sync = () => {
    swatch.style.background = hex();
    if (document.activeElement !== hexIn) hexIn.value = hex().slice(1);
    drawCanvases();
    syncSliders();
    for (const el of palette.querySelectorAll('.cp-chip') as NodeListOf<HTMLElement>) el.classList.toggle('on', (el.style.background && rgbToHex(...cssRgb(el.style.background))) === hex());
  };

  // drag areas
  const drag = (el: HTMLCanvasElement, fn: (x: number, y: number) => void) => {
    const at = (e: PointerEvent) => { const rc = el.getBoundingClientRect(); fn(clamp((e.clientX - rc.left) / rc.width, 0, 1), clamp((e.clientY - rc.top) / rc.height, 0, 1)); };
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); begin(); at(e); });
    el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) at(e); });
    el.addEventListener('pointerup', commit);
    el.addEventListener('pointercancel', commit);
  };
  drag(sv, (x, y) => { hsv = { ...hsv, s: x, v: 1 - y }; setFromHsv(); });
  drag(hue, (_x, y) => { hsv = { ...hsv, h: Math.min(359.9, y * 360) }; setFromHsv(); });

  hexIn.addEventListener('change', () => {
    const v = hexIn.value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(v)) { begin(); setFromRgb(...hexToRgb('#' + v)); commit(); }
    hexIn.value = hex().slice(1);
  });

  const root = h('div', { class: 'cp' },
    h('div', { class: 'cp-head' }, swatch, h('span', { class: 'cp-hash' }, '#'), hexIn, tabs),
    h('div', { class: 'cp-spectrum' }, sv, hue),
    sliders,
    palette,
  );
  buildTabs(); buildSliders(); buildPalette();
  // canvases need layout before they can size themselves
  const ro = new ResizeObserver(() => drawCanvases());
  ro.observe(sv);
  requestAnimationFrame(sync);
  return root;
}

function cssRgb(s: string): RGB {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}
