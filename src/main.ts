import './styles.css';
import { UI } from './ui/ui';
import { closeMenus } from './ui/dom';

const root = document.getElementById('app')!;
const ui = new UI(root);
(window as any).polygons = ui; // handy for debugging / automation

(async () => {
  const restored = await ui.app.restore();
  if (!restored) ui.app.newScene(true);
  else ui.app.frameAll();
  ui.renderAll();
})();

// Offline support when served over http(s) (not inside the Android asset loader).
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !location.hostname.includes('appassets') && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Android back button (called by the native wrapper). Returns true when handled.
(window as any).__onAndroidBack = (): boolean => {
  const app = ui.app;
  const overlay = document.querySelector('.dialog-backdrop, .menu-backdrop');
  if (overlay) { closeMenus(); document.querySelectorAll('.dialog-backdrop').forEach((d) => d.remove()); return true; }
  if (ui.uv.modal) { ui.uv.cancel(); return true; }
  if (app.modal) { app.cancelModal(); return true; }
  if (app.tool === 'loopcut') { app.setTool('select'); return true; }
  if (app.settings.panelOpen && window.innerWidth <= 700) { app.settings.panelOpen = false; ui.renderAll(); return true; }
  if (app.mode !== 'object') { app.setMode('object'); return true; }
  return false;
};
