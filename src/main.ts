import './styles.css';
import { UI } from './ui/ui';
import { closeMenus, h, installTooltips } from './ui/dom';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Gestures } from './input';
import { openInputTest } from './ui/inputTest';

const root = document.getElementById('app')!;

if (location.search.includes('stylustest')) {
  // Stylus test with no 3D view at all (no WebGL context in the process), to tell
  // whether the system disables the pen because of the 3D renderer.
  standaloneStylusTest();
} else {
  startApp();
}

function standaloneStylusTest() {
  const surface = document.createElement('div');
  const gestures = new Gestures(surface, {} as any);
  try {
    const j = JSON.parse(localStorage.getItem('polygons-otg-input') ?? 'null');
    if (j) Object.assign(gestures.settings, { palmRejection: j.palmRejection ?? 'auto', stylusDetect: j.stylusDetect ?? 'auto', touchAsPen: !!j.touchAsPen });
  } catch { /* ignore */ }
  installTooltips();
  const back = h('button', { class: 'tiny', style: 'position:fixed;left:12px;bottom:12px;z-index:100', onclick: () => { location.href = location.pathname; } }, 'Back to Polygons OTG');
  const reopen = h('button', { class: 'tiny', style: 'position:fixed;left:12px;bottom:60px;z-index:100', onclick: () => openInputTest({ gestures } as any, () => {}) }, 'Open the test again');
  root.append(h('div', { style: 'padding:16px;color:var(--fg2)' }, 'Stylus test without the 3D view (no WebGL). Keep the app maximised.'));
  document.body.append(back, reopen); // above dialogs (#app is its own stacking context)
  openInputTest({ gestures } as any, () => {});
}

function startApp() {
  const ui = new UI(root);
  (window as any).polygons = ui; // handy for debugging / automation

  (async () => {
    const restored = await ui.app.restore();
    if (!restored) ui.app.newScene(true);
    else ui.app.frameAll();
    ui.renderAll();
  })();

  // Android back button: close / cancel / leave sub-modes first, exit only from object mode.
  const onBack = (): boolean => {
    const app = ui.app;
    const overlay = document.querySelector('.dialog-backdrop, .menu-backdrop');
    if (overlay) { closeMenus(); document.querySelectorAll('.dialog-backdrop').forEach((d) => d.remove()); return true; }
    if (ui.uv.modal) { ui.uv.cancel(); return true; }
    if (app.modal) { app.cancelModal(); return true; }
    if (app.tool === 'loopcut' || app.tool === 'knife') { app.setTool('select'); return true; }
    if (app.settings.panelOpen && window.innerWidth <= 700) { app.settings.panelOpen = false; ui.renderAll(); return true; }
    if (app.mode !== 'object') { app.setMode('object'); return true; }
    return false;
  };
  (window as any).__onAndroidBack = onBack;
  if (Capacitor.isNativePlatform()) CapApp.addListener('backButton', () => { if (!onBack()) CapApp.exitApp(); });
}

// Offline support when served over http(s) (not inside the Android asset loader).
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !Capacitor.isNativePlatform() && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
