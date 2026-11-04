import { SceneObject } from '../core/scene';
import { ekey } from '../core/mesh';
import { uvIslands } from '../core/uv';
import { V2 } from '../core/vec';

/**
 * UV layout export: an image of the UV map to paint textures over. The
 * square is the 0–1 UV space with V pointing up, exactly as textures are
 * sampled (top-left of the image = U 0, V 1).
 */
export interface UVLayoutOptions {
  /** pixels (square) */
  size: number;
  format: 'png' | 'svg';
  background: 'transparent' | 'white' | 'black';
  fill: 'none' | 'grey' | 'islands';
  /** 0–1 */
  fillOpacity: number;
  lineColor: string;
  /** stroke width in px for a 1024 image (scales with size) */
  lineWidth: number;
  seams: boolean;
  /** faint 8×8 grid and the 0–1 border */
  grid: boolean;
}

export const defaultLayoutOptions = (): UVLayoutOptions => ({
  size: 2048, format: 'png', background: 'transparent', fill: 'islands', fillOpacity: 0.25,
  lineColor: '#000000', lineWidth: 2, seams: true, grid: false,
});

interface Poly { pts: V2[]; color: string }
interface Seg { a: V2; b: V2; seam: boolean }

function islandColor(i: number): string {
  const hue = (i * 137.508) % 360;
  return `hsl(${hue.toFixed(1)} 70% 55%)`;
}

/** Faces (as UV polygons) and deduplicated UV edges of the objects. */
function collect(objs: SceneObject[], o: UVLayoutOptions): { polys: Poly[]; segs: Seg[] } {
  const polys: Poly[] = [];
  const segMap = new Map<string, Seg>();
  const q = (x: number) => Math.round(x * 1e5);
  let isl = 0;
  for (const ob of objs) {
    const m = ob.mesh;
    const islands = o.fill === 'islands' ? uvIslands(m, m.faces.map((_, i) => i)) : [m.faces.map((_, i) => i)];
    for (const faces of islands) {
      const color = o.fill === 'islands' ? islandColor(isl++) : '#808080';
      for (const fi of faces) {
        const f = m.faces[fi];
        polys.push({ pts: f.uv, color });
        const n = f.v.length;
        for (let k = 0; k < n; k++) {
          const a = f.uv[k], b = f.uv[(k + 1) % n];
          const ka = `${q(a[0])},${q(a[1])}`, kb = `${q(b[0])},${q(b[1])}`;
          const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          const seam = m.seams.has(ekey(f.v[k], f.v[(k + 1) % n]));
          const prev = segMap.get(key);
          if (prev) prev.seam ||= seam; else segMap.set(key, { a, b, seam });
        }
      }
    }
  }
  return { polys, segs: [...segMap.values()] };
}

const BG: Record<UVLayoutOptions['background'], string | null> = { transparent: null, white: '#ffffff', black: '#000000' };
const SEAM = '#e8322c';

/** Draw the layout into a 2D canvas context of `size` × `size`. */
export function drawUVLayout(ctx: CanvasRenderingContext2D, objs: SceneObject[], o: UVLayoutOptions, size = o.size) {
  const { polys, segs } = collect(objs, o);
  const X = (u: V2) => u[0] * size, Y = (u: V2) => (1 - u[1]) * size;
  ctx.clearRect(0, 0, size, size);
  const bg = BG[o.background];
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size); }
  const lw = Math.max(0.5, (o.lineWidth * size) / 1024);
  if (o.grid) {
    ctx.strokeStyle = o.background === 'black' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)';
    ctx.lineWidth = Math.max(0.5, lw * 0.5);
    ctx.beginPath();
    for (let i = 1; i < 8; i++) { const p = (i / 8) * size; ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.moveTo(0, p); ctx.lineTo(size, p); }
    ctx.stroke();
    ctx.strokeRect(lw / 2, lw / 2, size - lw, size - lw);
  }
  if (o.fill !== 'none' && o.fillOpacity > 0) {
    ctx.globalAlpha = o.fillOpacity;
    for (const p of polys) {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      p.pts.forEach((u, i) => (i ? ctx.lineTo(X(u), Y(u)) : ctx.moveTo(X(u), Y(u))));
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = o.lineColor;
  ctx.beginPath();
  for (const s of segs) if (!(o.seams && s.seam)) { ctx.moveTo(X(s.a), Y(s.a)); ctx.lineTo(X(s.b), Y(s.b)); }
  ctx.stroke();
  if (o.seams) {
    ctx.strokeStyle = SEAM;
    ctx.lineWidth = lw * 1.5;
    ctx.beginPath();
    for (const s of segs) if (s.seam) { ctx.moveTo(X(s.a), Y(s.a)); ctx.lineTo(X(s.b), Y(s.b)); }
    ctx.stroke();
  }
}

/** Vector version: crisp at any size and easy to put on its own layer. */
export function uvLayoutSVG(objs: SceneObject[], o: UVLayoutOptions): string {
  const { polys, segs } = collect(objs, o);
  const S = o.size;
  const f = (x: number) => (Math.round(x * 100) / 100).toString();
  const pt = (u: V2) => `${f(u[0] * S)},${f((1 - u[1]) * S)}`;
  const lw = Math.max(0.5, (o.lineWidth * S) / 1024);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`];
  const bg = BG[o.background];
  if (bg) out.push(`<rect width="${S}" height="${S}" fill="${bg}"/>`);
  if (o.grid) {
    const c = o.background === 'black' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)';
    const d: string[] = [];
    for (let i = 1; i < 8; i++) { const p = f((i / 8) * S); d.push(`M${p} 0V${S}M0 ${p}H${S}`); }
    out.push(`<g id="grid" fill="none" stroke="${c}" stroke-width="${f(lw * 0.5)}"><path d="${d.join('')}"/><rect x="${f(lw / 2)}" y="${f(lw / 2)}" width="${f(S - lw)}" height="${f(S - lw)}"/></g>`);
  }
  if (o.fill !== 'none' && o.fillOpacity > 0) {
    out.push(`<g id="faces" fill-opacity="${o.fillOpacity}" stroke="none">`);
    for (const p of polys) out.push(`<polygon fill="${p.color}" points="${p.pts.map(pt).join(' ')}"/>`);
    out.push('</g>');
  }
  const line = (list: Seg[]) => list.map((s) => `M${pt(s.a)}L${pt(s.b)}`).join('');
  out.push(`<path id="edges" fill="none" stroke="${o.lineColor}" stroke-width="${f(lw)}" stroke-linecap="round" stroke-linejoin="round" d="${line(segs.filter((s) => !(o.seams && s.seam)))}"/>`);
  if (o.seams) out.push(`<path id="seams" fill="none" stroke="${SEAM}" stroke-width="${f(lw * 1.5)}" stroke-linecap="round" d="${line(segs.filter((s) => s.seam))}"/>`);
  out.push('</svg>');
  return out.join('\n');
}

export async function uvLayoutPNG(objs: SceneObject[], o: UVLayoutOptions): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = c.height = o.size;
  drawUVLayout(c.getContext('2d')!, objs, o);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Image too large for this device'))), 'image/png'));
}

/* ------------------------------------------------------------------ checks */

/** Triangle raster on an n×n grid (centre sampling), calling `hit` per covered cell. */
function rasterTri(a: V2, b: V2, c: V2, n: number, hit: (i: number) => void) {
  const xs = [a[0], b[0], c[0]].map((x) => x * n), ys = [a[1], b[1], c[1]].map((y) => y * n);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(n - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(n - 1, Math.ceil(Math.max(...ys)));
  const area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
  if (Math.abs(area) < 1e-12) return;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((xs[1] - px) * (ys[2] - py) - (xs[2] - px) * (ys[1] - py)) / area;
    const w1 = ((xs[2] - px) * (ys[0] - py) - (xs[0] - px) * (ys[2] - py)) / area;
    const w2 = 1 - w0 - w1;
    if (w0 >= 0 && w1 >= 0 && w2 >= 0) hit(y * n + x);
  }
}

export interface LayoutCheck { warnings: string[]; notes: string[] }

/** Things that make a layout a poor texture guide. */
export function uvLayoutCheck(objs: SceneObject[]): LayoutCheck {
  const warnings: string[] = [], notes: string[] = [];
  const meshes = objs.filter((o) => !o.armature && o.mesh.faces.length);
  if (!meshes.length) { warnings.push('Nothing with faces is selected, so the layout would be empty.'); return { warnings, notes }; }
  const N = 256;
  const owner = new Int32Array(N * N).fill(-1);
  let overlap = 0, covered = 0, islandId = 0;
  for (const o of meshes) {
    const m = o.mesh;
    const flat = m.faces.every((f) => f.uv.every((u) => Math.abs(u[0] - f.uv[0][0]) < 1e-9 && Math.abs(u[1] - f.uv[0][1]) < 1e-9));
    if (flat) { warnings.push(`${o.name} has no UV map yet: unwrap it in UV mode first.`); continue; }
    const outside = m.faces.filter((f) => f.uv.some((u) => u[0] < -1e-4 || u[0] > 1 + 1e-4 || u[1] < -1e-4 || u[1] > 1 + 1e-4)).length;
    if (outside) warnings.push(`${outside} face${outside > 1 ? 's' : ''} of ${o.name} reach outside the 0–1 square and get cut off in the image (the texture repeats there). Pack islands in UV mode to fit them.`);
    const zero = m.faces.filter((f) => { let a = 0; for (let i = 1; i + 1 < f.uv.length; i++) a += (f.uv[i][0] - f.uv[0][0]) * (f.uv[i + 1][1] - f.uv[0][1]) - (f.uv[i + 1][0] - f.uv[0][0]) * (f.uv[i][1] - f.uv[0][1]); return Math.abs(a) < 1e-10; }).length;
    if (zero) warnings.push(`${zero} face${zero > 1 ? 's' : ''} of ${o.name} have no UV area and won't show (or take any texture).`);
    // overlap between islands (a mirrored unwrap shares texture on purpose)
    for (const isl of uvIslands(m, m.faces.map((_, i) => i))) {
      const id = islandId++;
      const mine = new Set<number>();
      for (const fi of isl) {
        const uv = m.faces[fi].uv;
        for (let i = 1; i + 1 < uv.length; i++) rasterTri(uv[0], uv[i], uv[i + 1], N, (c) => mine.add(c));
      }
      for (const c of mine) { if (owner[c] >= 0 && owner[c] !== id) overlap++; else covered++; owner[c] = id; }
    }
    if (o.modifiers.some((md) => md.enabled && md.type === 'mirror')) notes.push(`${o.name} has a Mirror modifier: the mirrored half uses the same UVs, so paint once for both sides.`);
  }
  const pct = covered ? (overlap / (covered + overlap)) * 100 : 0;
  if (pct >= 1) warnings.push(`Islands overlap (about ${Math.round(pct)}% of the used area): those parts will share the same pixels. Fine for mirrored or repeated parts, otherwise re-pack.`);
  if (meshes.length > 1) notes.push(`${meshes.length} objects are drawn together. That only matches if they share one texture; otherwise export one at a time.`);
  if (covered && covered / (N * N) < 0.25) notes.push(`The islands use about ${Math.round((covered / (N * N)) * 100)}% of the square. Packing them would give the texture more resolution.`);
  return { warnings, notes };
}
