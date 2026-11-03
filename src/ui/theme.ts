/* ======================================================================
 * Monochrome theme. The whole UI is derived from one user-chosen hue and
 * a tint strength (0 = neutral grey). Functional colours — axis X/Y/Z,
 * destructive red, seams, viewport selection — are deliberately fixed.
 * ==================================================================== */

export interface Theme { hue: number; tint: number }

const KEY = 'polygons-otg-theme';
export const DEFAULT_THEME: Theme = { hue: 32, tint: 1 };
export const HUE_PRESETS = [0, 32, 50, 95, 150, 190, 215, 260, 300, 335];

export function loadTheme(): Theme {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (j && typeof j.hue === 'number' && typeof j.tint === 'number') return { hue: j.hue, tint: j.tint };
  } catch { /* storage unavailable */ }
  return { ...DEFAULT_THEME };
}

export function saveTheme(t: Theme) {
  try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

const hsl = (h: number, s: number, l: number) => `hsl(${h}, ${s.toFixed(1)}%, ${l}%)`;

/** Colours used by canvases (WebGL viewport, UV editor) that cannot read CSS variables. */
export function canvasColors(t: Theme) {
  const s = (k: number) => k * t.tint;
  return {
    viewport: hsl(t.hue, s(9), 24),
    uvBg: hsl(t.hue, s(10), 12),
    uvPaper: hsl(t.hue, s(10), 18),
    grid: hsl(t.hue, s(12), 62),
    faceTint: `hsla(${t.hue}, ${s(30).toFixed(1)}%, 70%, 0.10)`,
    corner: hsl(t.hue, s(14), 91),
  };
}

export function applyTheme(t: Theme) {
  const r = document.documentElement.style;
  r.setProperty('--h', String(t.hue));
  r.setProperty('--t', String(t.tint));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', hsl(t.hue, 10 * t.tint, 11));
}
