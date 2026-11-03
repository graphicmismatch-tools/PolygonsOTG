/* ======================================================================
 * Platform file access. In the Android wrapper a JS bridge
 * (window.PolygonsAndroid) uses the Storage Access Framework; in a
 * browser we fall back to downloads / <input type=file>.
 * ==================================================================== */

interface AndroidBridge {
  saveFile(name: string, mime: string, base64: string): void;
  isAndroid?(): boolean;
}

declare global {
  interface Window {
    PolygonsAndroid?: AndroidBridge;
    __polygonsSaveResult?: (ok: boolean, msg: string) => void;
  }
}

export const isAndroidApp = () => typeof window !== 'undefined' && !!window.PolygonsAndroid;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

export async function saveFile(name: string, mime: string, data: string | ArrayBuffer | Blob): Promise<void> {
  let blob: Blob;
  if (data instanceof Blob) blob = data;
  else blob = new Blob([data], { type: mime });
  if (window.PolygonsAndroid) {
    const buf = await blob.arrayBuffer();
    window.PolygonsAndroid.saveFile(name, mime, toBase64(buf));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function openFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    let done = false;
    input.onchange = () => { done = true; resolve(input.files?.[0] ?? null); input.remove(); };
    // resolve null if the picker is dismissed (focus comes back without change)
    window.addEventListener('focus', () => setTimeout(() => { if (!done) { resolve(null); input.remove(); } }, 1000), { once: true });
    input.click();
  });
}

export function readAsDataURL(f: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(f); });
}

/* ------------------------------------------------------------------ autosave (IndexedDB) */
const DB = 'polygons-otg';
const STORE = 'kv';

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function kvSet(key: string, value: unknown) {
  try {
    const d = await db();
    await new Promise<void>((res, rej) => { const tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(value, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  } catch { /* storage unavailable */ }
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise<T | undefined>((res, rej) => { const tx = d.transaction(STORE, 'readonly'); const r = tx.objectStore(STORE).get(key); r.onsuccess = () => res(r.result as T); r.onerror = () => rej(r.error); });
  } catch { return undefined; }
}
