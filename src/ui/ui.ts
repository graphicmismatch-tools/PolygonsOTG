import { App, SelOp } from '../app';
import { AppMode } from '../render/viewport';
import { h, clear, icon, showMenu, MenuItem, dialog, toast, installTooltips } from './dom';
import { Theme, loadTheme, saveTheme, applyTheme, canvasColors, HUE_PRESETS, DEFAULT_THEME } from './theme';
import { PRIMITIVES } from '../core/primitives';
import { BRUSHES } from '../modes/sculpt';
import { UVEditor } from '../modes/uvEditor';
import { SceneObject } from '../core/scene';
import { exportOBJ, exportSTL, exportGLB, importOBJ, importGLTF, importSTL, serializeProject } from '../io/formats';
import { saveFile, openFile, readAsDataURL, isAndroidApp } from '../io/files';
import { Axis } from '../modes/transform';
import { V3 } from '../core/vec';
import { Modifier } from '../core/modifiers';
import { openInputTest } from './inputTest';

const MODES: { id: AppMode; label: string; icon: string }[] = [
  { id: 'object', label: 'Object', icon: 'modeObject' },
  { id: 'edit', label: 'Edit', icon: 'modeEdit' },
  { id: 'sculpt', label: 'Sculpt', icon: 'modeSculpt' },
  { id: 'uv', label: 'UV editing', icon: 'modeUV' },
];

const MOD_NAMES: Record<string, string> = { mirror: 'Mirror', subsurf: 'Subdivision', remesh: 'Remesh', decimate: 'Decimate' };

const BRUSH_ICONS: Record<string, string> = {
  draw: 'brushDraw', clay: 'brushClay', inflate: 'brushInflate', smooth: 'brushSmooth',
  flatten: 'brushFlatten', pinch: 'brushPinch', crease: 'brushCrease', grab: 'brushGrab',
};

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;
const fmt = (x: number, d = 3) => String(Math.round(x * 10 ** d) / 10 ** d);

export class UI {
  root: HTMLElement;
  topbar!: HTMLElement;
  rail!: HTMLElement;
  panel!: HTMLElement;
  view3d!: HTMLElement;
  viewUV!: HTMLElement;
  modalBar!: HTMLElement;
  editBar!: HTMLElement;
  statusEl!: HTMLElement;
  uv!: UVEditor;
  app!: App;
  private panelScroll = 0;
  theme: Theme = loadTheme();

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
  }

  private build() {
    const canvas = h('canvas', { class: 'gl' });
    const overlay = h('canvas', { class: 'overlay' });
    this.view3d = h('div', { class: 'view view3d' }, canvas, overlay);
    const uvCanvas = h('canvas', { class: 'uvcanvas' });
    this.viewUV = h('div', { class: 'view viewuv hidden' }, uvCanvas);
    this.topbar = h('header', { class: 'topbar' });
    this.rail = h('nav', { class: 'rail' });
    this.panel = h('aside', { class: 'panel hidden' });
    this.modalBar = h('div', { class: 'modalbar hidden' });
    this.editBar = h('div', { class: 'editbar' });
    this.statusEl = h('div', { class: 'status' });
    const workspace = h('div', { class: 'workspace' }, this.view3d, this.viewUV);
    const main = h('div', { class: 'main' }, this.rail, workspace, this.panel);
    this.root.append(this.topbar, main);
    this.view3d.append(this.editBar, this.modalBar, this.statusEl, this.navWidget());

    this.app = new App(canvas, overlay, this.view3d);
    this.uv = new UVEditor(uvCanvas, this.viewUV, this.app);
    this.app.uvRedraw = () => this.uv.redraw();
    this.uv.onModal = () => this.renderModal();
    installTooltips();
    this.loadInputSettings();
    this.setTheme(this.theme, false);

    const app = this.app;
    app.on('mode', () => { this.renderAll(); });
    app.on('change', () => { this.renderPanel(); this.renderStatus(); this.renderEditBar(); });
    app.on('modal', () => this.renderModal());
    app.on('history', () => this.renderTop());
    app.on('status', () => this.renderStatus());

    const ro = new ResizeObserver(() => { app.resize(); this.uv.resize(); });
    ro.observe(this.view3d);
    ro.observe(this.viewUV);
    window.addEventListener('resize', () => { app.resize(); this.uv.resize(); });
    this.renderAll();
  }

  /** Persist pen/touch settings (they're device specific, so they live outside the project). */
  saveInputSettings() {
    const g = this.app.gestures.settings;
    try { localStorage.setItem('polygons-otg-input', JSON.stringify({ palmRejection: g.palmRejection, stylusDetect: g.stylusDetect, touchAsPen: g.touchAsPen })); } catch { /* ignore */ }
  }

  private loadInputSettings() {
    try {
      const j = JSON.parse(localStorage.getItem('polygons-otg-input') ?? 'null');
      if (!j) return;
      const g = this.app.gestures.settings;
      if (['auto', 'on', 'off'].includes(j.palmRejection)) { g.palmRejection = j.palmRejection; this.app.settings.palmRejection = j.palmRejection; }
      if (['auto', 'thin'].includes(j.stylusDetect)) g.stylusDetect = j.stylusDetect;
      if (typeof j.touchAsPen === 'boolean') g.touchAsPen = j.touchAsPen;
    } catch { /* ignore */ }
  }

  /** Apply a hue/tint theme to CSS and to the canvases. */
  setTheme(t: Theme, save = true) {
    this.theme = { hue: Math.round(t.hue) % 360, tint: Math.max(0, Math.min(1, t.tint)) };
    applyTheme(this.theme);
    const c = canvasColors(this.theme);
    this.app.vp.setBackground(c.viewport);
    Object.assign(this.uv.colors, { uvBg: c.uvBg, uvPaper: c.uvPaper, faceTint: c.faceTint, corner: c.corner });
    this.uv.redraw();
    if (save) saveTheme(this.theme);
  }

  renderAll() {
    this.root.classList.toggle('left-handed', this.app.settings.leftHanded);
    this.root.dataset.mode = this.app.mode;
    this.viewUV.classList.toggle('hidden', this.app.mode !== 'uv');
    this.panel.classList.toggle('hidden', !this.app.settings.panelOpen);
    this.renderTop();
    this.renderRail();
    this.renderEditBar();
    this.renderPanel();
    this.renderModal();
    this.renderStatus();
    requestAnimationFrame(() => { this.app.resize(); this.uv.resize(); });
  }

  /* ================================================================ top bar */
  renderTop() {
    const app = this.app;
    clear(this.topbar);
    const menuBtn = h('button', { class: 'iconbtn', tip: 'Menu', onclick: () => this.mainMenu(menuBtn) }, icon('menu'));
    const tabs = h('div', { class: 'tabs' }, MODES.map((m) => h('button', {
      class: `tab${app.mode === m.id ? ' active' : ''}`,
      tip: `${m.label} mode`,
      onclick: () => app.setMode(m.id),
    }, icon(m.icon, 22))));
    const undo = h('button', { class: 'iconbtn', tip: app.history.undoLabel ? `Undo ${app.history.undoLabel}` : 'Undo', disabled: !app.history.canUndo && !app.modal, onclick: () => app.undo() }, icon('undo'));
    const redo = h('button', { class: 'iconbtn', tip: 'Redo', disabled: !app.history.canRedo, onclick: () => app.redo() }, icon('redo'));
    const panel = h('button', { class: `iconbtn${app.settings.panelOpen ? ' on' : ''}`, tip: 'Properties panel', onclick: () => { app.settings.panelOpen = !app.settings.panelOpen; this.renderAll(); } }, icon('panel'));
    const objName = app.active ? h('div', { class: 'objname' }, app.active.name) : null;
    this.topbar.append(menuBtn, tabs, h('div', { class: 'spacer' }), ...(objName ? [objName] : []), undo, redo, panel);
  }

  private mainMenu(anchor: HTMLElement) {
    const app = this.app;
    showMenu(anchor, [
      { label: 'New scene', action: () => dialog('New scene', h('p', {}, 'Discard the current scene and start over?'), [{ label: 'Cancel' }, { label: 'New', primary: true, action: () => app.newScene() }]) },
      { label: 'Open project…', action: () => this.openProject() },
      { label: 'Save project', hint: '.potg', action: () => this.saveProject() },
      { separator: true, label: '' },
      { label: 'Import', submenu: () => [
        { label: 'Wavefront OBJ', action: () => this.importModel('obj') },
        { label: 'glTF / GLB', action: () => this.importModel('glb') },
        { label: 'STL', action: () => this.importModel('stl') },
      ] },
      { label: 'Export', submenu: () => [
        { label: 'Wavefront OBJ', action: () => this.exportModel('obj') },
        { label: 'glTF binary (GLB)', action: () => this.exportModel('glb') },
        { label: 'STL (3D print)', action: () => this.exportModel('stl') },
        { label: 'Screenshot PNG', action: () => this.screenshot() },
      ] },
      { separator: true, label: '' },
      { label: 'Settings…', action: () => this.settingsDialog() },
      { label: 'Stylus & touch test…', action: () => openInputTest(this.app, () => this.saveInputSettings()) },
      { label: 'Gestures & shortcuts', action: () => this.helpDialog() },
    ], 'Polygons OTG');
  }

  private exportTargets(): SceneObject[] {
    const app = this.app;
    const sel = app.selectedObjects();
    return sel.length ? sel : app.scene.objects.filter((o) => o.visible);
  }

  private async saveProject() {
    this.app.confirmModal();
    await saveFile(`scene_${stamp()}.potg`, 'application/json', serializeProject(this.app.scene));
    if (!isAndroidApp()) toast('Project saved');
  }

  private async openProject() {
    const f = await openFile('.potg,.json,application/json');
    if (!f) return;
    try { this.app.loadProject(JSON.parse(await f.text())); toast(`Opened ${f.name}`); }
    catch (e) { toast(`Could not open: ${(e as Error).message}`); }
  }

  private async importModel(kind: 'obj' | 'glb' | 'stl') {
    const app = this.app;
    const f = await openFile(kind === 'obj' ? '.obj' : kind === 'stl' ? '.stl' : '.glb,.gltf');
    if (!f) return;
    try {
      app.setMode('object');
      app.record('Import');
      const base = f.name.replace(/\.[^.]+$/, '');
      let added = 0;
      if (kind === 'obj') {
        for (const r of importOBJ(await f.text())) { app.scene.add(new SceneObject(app.scene.uniqueName(r.name || base), r.mesh)); added++; }
      } else if (kind === 'stl') {
        app.scene.add(new SceneObject(app.scene.uniqueName(base), importSTL(await f.arrayBuffer()))); added++;
      } else {
        const data = f.name.endsWith('.gltf') ? await f.text() : await f.arrayBuffer();
        for (const r of await importGLTF(data)) {
          const o = new SceneObject(app.scene.uniqueName(r.name || base), r.mesh);
          o.position = r.position; o.rotation = r.rotation; o.scale = r.scale;
          if (r.texture) o.material.texture = r.texture;
          if (r.color) o.material.color = r.color;
          app.scene.add(o); added++;
        }
      }
      app.changed();
      app.frameSelected();
      toast(`Imported ${added} object${added === 1 ? '' : 's'}`);
    } catch (e) {
      app.history.cancelLast();
      toast(`Import failed: ${(e as Error).message}`);
    }
  }

  private async exportModel(kind: 'obj' | 'glb' | 'stl') {
    const objs = this.exportTargets();
    if (!objs.length) { toast('Nothing to export'); return; }
    this.app.confirmModal();
    const name = objs.length === 1 ? objs[0].name : 'scene';
    try {
      if (kind === 'obj') await saveFile(`${name}.obj`, 'text/plain', exportOBJ(objs));
      else if (kind === 'stl') await saveFile(`${name}.stl`, 'model/stl', exportSTL(objs));
      else await saveFile(`${name}.glb`, 'model/gltf-binary', await exportGLB(objs, (u) => this.app.vp.getTexture(u)));
      if (!isAndroidApp()) toast(`Exported ${name}.${kind}`);
    } catch (e) { toast(`Export failed: ${(e as Error).message}`); }
  }

  private async screenshot() {
    const url = this.app.vp.snapshotPNG();
    const blob = await (await fetch(url)).blob();
    await saveFile(`render_${stamp()}.png`, 'image/png', blob);
  }

  /* ================================================================ left rail */
  /** Icon tool button; `name` is the friendly name shown on long-press. */
  private btn(iconName: string, name: string, action: () => void, opts: { active?: boolean; cls?: string; disabled?: boolean } = {}) {
    return h('button', { class: `tool${opts.active ? ' active' : ''}${opts.cls ? ' ' + opts.cls : ''}`, tip: name, disabled: opts.disabled, onclick: action }, icon(iconName, 24));
  }
  private group(...items: (HTMLElement | null)[]) {
    return h('div', { class: 'rail-group' }, ...items);
  }
  private menuBtn(iconName: string, name: string, items: () => MenuItem[], cls = '') {
    const b: HTMLButtonElement = h('button', { class: `tool more ${cls}`, tip: name, onclick: () => showMenu(b, items(), name) }, icon(iconName, 24));
    return b;
  }

  private remeshItems(): MenuItem[] {
    const app = this.app;
    return [
      { label: 'Voxel remesh', hint: 'even quads, closes holes', action: () => app.remeshOp('voxel') },
      { label: 'Isotropic remesh', hint: 'even triangles', action: () => app.remeshOp('isotropic') },
      { label: 'Blocks remesh', hint: 'voxel-art cubes', action: () => app.remeshOp('blocks') },
      { separator: true, label: '' },
      { label: 'Decimate: collapse', hint: 'reduce by ratio', action: () => app.decimateOp('collapse') },
      { label: 'Decimate: un-subdivide', hint: 'quad grids', action: () => app.decimateOp('unsubdivide') },
      { label: 'Decimate: planar', hint: 'merge flat areas', action: () => app.decimateOp('planar') },
    ];
  }

  renderRail() {
    const app = this.app;
    clear(this.rail);
    const T = (kind: 'move' | 'rotate' | 'scale') => () => app.startTransform(kind, 'button');
    const mode = app.mode;
    const transforms = () => this.group(this.btn('move', 'Move', T('move')), this.btn('rotate', 'Rotate', T('rotate')), this.btn('scale', 'Scale', T('scale')));
    if (mode === 'object') {
      this.rail.append(
        this.group(this.menuBtn('add', 'Add mesh', () => PRIMITIVES.map((p) => ({ label: p.label, action: () => app.addPrimitive(p.type) })))),
        transforms(),
        this.group(
          this.btn('duplicate', 'Duplicate', () => app.duplicateObjects()),
          this.btn('join', 'Join into active', () => app.joinObjects()),
          this.btn('trash', 'Delete', () => app.deleteObjects(), { cls: 'danger' }),
        ),
        this.group(
          this.menuBtn('shading', 'Shading', () => [{ label: 'Flat', action: () => app.setShading(false) }, { label: 'Smooth', action: () => app.setShading(true) }]),
          this.menuBtn('apply', 'Apply transform', () => [
            { label: 'All transforms', action: () => app.applyTransform('all') },
            { label: 'Rotation & scale', action: () => app.applyTransform('rotscale') },
            { label: 'Location', action: () => app.applyTransform('location') },
          ]),
          this.menuBtn('remesh', 'Remesh / decimate', () => this.remeshItems()),
          this.menuBtn('origin', 'Set origin', () => [
            { label: 'To geometry centre', action: () => app.setOrigin('geometry') },
            { label: 'To geometry bottom', action: () => app.setOrigin('bottom') },
            { label: 'To view centre', action: () => app.setOrigin('cursor') },
          ]),
        ),
      );
    } else if (mode === 'edit' || mode === 'uv') {
      if (mode === 'uv') this.rail.append(...this.uvRail());
      this.rail.append(
        transforms(),
        this.group(
          this.btn('extrude', 'Extrude (E)', () => app.extrude()),
          this.btn('inset', 'Inset faces (I)', () => app.inset()),
          this.btn('loopcut', 'Loop cut — tap an edge', () => app.setTool(app.tool === 'loopcut' ? 'select' : 'loopcut'), { active: app.tool === 'loopcut' }),
          this.btn('subdivide', 'Subdivide', () => app.subdivide()),
          this.btn('bevel', 'Bevel (Ctrl+B)', () => app.bevel()),
          this.btn('knife', 'Knife — drag a cut line (K)', () => app.setTool(app.tool === 'knife' ? 'select' : 'knife'), { active: app.tool === 'knife' }),
        ),
        this.group(
          this.btn('connect', 'Connect vertices (J)', () => app.connect()),
          this.btn('merge', 'Merge at centre (M)', () => app.merge()),
          this.btn('fill', 'Fill face / edge (F)', () => app.fill()),
          this.btn('bridge', 'Bridge edge loops', () => app.bridge()),
          this.menuBtn('deleteMenu', 'Delete', () => [
            { label: 'Vertices', action: () => app.deleteElements('vert') },
            { label: 'Edges', action: () => app.deleteElements('edge') },
            { label: 'Faces', action: () => app.deleteElements('face') },
            { label: 'Only faces (keep edges)', action: () => app.deleteElements('onlyfaces') },
            { label: 'Dissolve faces', action: () => app.deleteElements('dissolve') },
          ]),
        ),
        this.group(
          this.menuBtn('selectMenu', 'Select', () => [
            { label: 'All / none', hint: 'A', action: () => app.selectAll() },
            { label: 'Invert', action: () => app.selectInvert() },
            { label: 'Linked', hint: 'L', action: () => app.selectLinked() },
            { label: 'Grow', action: () => app.selectGrow() },
            { label: 'Shrink', action: () => app.selectShrink() },
            { label: 'Edge loop', action: () => app.selectLoop() },
            { label: 'Edge ring', action: () => app.selectRing() },
          ]),
          this.menuBtn('meshMenu', 'Mesh tools', () => [
            { label: 'Bevel edges', hint: 'Ctrl+B', action: () => app.bevel(false) },
            { label: 'Bevel vertices', hint: 'Ctrl+Shift+B', action: () => app.bevel(true) },
            { separator: true, label: '' },
            { label: 'Duplicate', action: () => app.duplicateElements() },
            { label: 'Separate to object', action: () => app.separate() },
            { label: 'Split (disconnect)', action: () => app.splitSel() },
            { label: 'Smooth vertices', action: () => app.smooth() },
            { label: 'Merge by distance', action: () => app.mergeByDistance() },
            { label: 'Triangulate', action: () => app.triangulate() },
            { label: 'Flip normals', action: () => app.flipNormals() },
            { label: 'Recalculate normals', action: () => app.recalcNormals() },
            { label: 'Snap to X = 0', action: () => app.snapCenterX() },
            { label: 'Remesh / decimate', submenu: () => this.remeshItems() },
            { separator: true, label: '' },
            { label: 'Add primitive', submenu: () => PRIMITIVES.map((p) => ({ label: p.label, action: () => app.addPrimitive(p.type) })) },
          ]),
          this.menuBtn('seams', 'Seams', () => [
            { label: 'Mark seam', action: () => app.markSeam(true) },
            { label: 'Clear seam', action: () => app.markSeam(false) },
            { label: 'Seams from UV islands', action: () => app.uvSeamsFromIslands() },
          ]),
          mode === 'edit' ? this.btn('unwrap', 'Unwrap UVs (U)', () => app.uvUnwrap()) : null,
        ),
      );
    } else if (mode === 'sculpt') {
      const b = app.brush;
      this.rail.append(
        this.group(...BRUSHES.map((br) => this.btn(BRUSH_ICONS[br.type], `${br.label} brush`, () => { b.type = br.type; this.renderRail(); this.renderPanel(); }, { active: b.type === br.type }))),
        this.group(
          this.btn(b.invert ? 'brushSub' : 'brushAdd', b.invert ? 'Subtract (tap for add)' : 'Add (tap for subtract)', () => { b.invert = !b.invert; this.renderRail(); app.vp.requestRender(); }, { active: b.invert }),
          this.btn('mirror', 'X symmetry', () => { b.symmetryX = !b.symmetryX; this.renderRail(); }, { active: b.symmetryX }),
        ),
        this.group(
          this.btn('dyntopo', b.dyntopo ? 'Dynamic topology: on (adds detail)' : 'Dynamic topology: off', () => { b.dyntopo = !b.dyntopo; this.renderRail(); this.renderEditBar(); this.renderPanel(); }, { active: b.dyntopo }),
          this.btn('subdivide', 'Subdivide whole mesh', () => app.subdivideForSculpt(1)),
          this.menuBtn('remesh', 'Remesh / decimate', () => this.remeshItems()),
          this.btn('shading', app.active?.smooth ? 'Shade flat' : 'Shade smooth', () => { app.setShading(!app.active?.smooth); this.renderRail(); }, { active: !!app.active?.smooth }),
        ),
      );
    }
  }

  private uvRail(): HTMLElement[] {
    const app = this.app, uv = this.uv;
    return [
      this.group(
        this.btn('unwrap', 'Unwrap (seams)', () => app.uvUnwrap(), { cls: 'uvtool' }),
        this.btn('smartUV', 'Smart UV project', () => app.uvSmart(), { cls: 'uvtool' }),
        this.menuBtn('project', 'Project', () => [
          { label: 'From view', action: () => app.uvProject('view') },
          { label: 'Cube', action: () => app.uvProject('cube') },
          { label: 'Cylinder', action: () => app.uvProject('cylinder') },
          { label: 'Sphere', action: () => app.uvProject('sphere') },
        ], 'uvtool'),
        this.btn('pack', 'Pack islands', () => app.uvPack(), { cls: 'uvtool' }),
      ),
      this.group(
        this.btn('move', 'Grab UVs', () => uv.start('move'), { cls: 'uvtool' }),
        this.btn('rotate', 'Rotate UVs', () => uv.start('rotate'), { cls: 'uvtool' }),
        this.btn('scale', 'Scale UVs', () => uv.start('scale'), { cls: 'uvtool' }),
        this.menuBtn('tools', 'UV tools', () => [
          { label: 'Select all / none', action: () => uv.selectAll() },
          { label: 'Select islands', action: () => uv.selectLinked() },
          { separator: true, label: '' },
          { label: 'Flip horizontally', action: () => uv.op('flipU') },
          { label: 'Flip vertically', action: () => uv.op('flipV') },
          { label: 'Rotate 90°', action: () => uv.op('rot90') },
          { label: 'Weld / stitch to average', action: () => uv.op('weld') },
          { label: 'Align horizontally', action: () => uv.op('alignV') },
          { label: 'Align vertically', action: () => uv.op('alignU') },
          { label: 'Fit to 0–1', action: () => uv.op('fitBounds') },
          { separator: true, label: '' },
          { label: 'Frame UV view', action: () => uv.fit() },
        ], 'uvtool'),
        this.menuBtn('image', 'Image & texture', () => [
          { label: 'Load texture…', action: () => this.loadTexture() },
          { label: 'Remove texture', action: () => this.setTexture(null), disabled: !app.active?.material.texture },
          { label: 'Checker preview', checked: app.vp.settings.checker, action: () => { app.vp.settings.checker = !app.vp.settings.checker; app.changed(); this.renderRail(); } },
          { label: 'Export UV layout PNG', action: () => uv.exportLayout() },
        ], 'uvtool'),
      ),
    ];
  }

  /* ================================================================ edit bar (floating chips) */
  renderEditBar() {
    const app = this.app;
    clear(this.editBar);
    const chip = (iconName: string, on: boolean, action: () => void, name: string) =>
      h('button', { class: `chip${on ? ' on' : ''}`, tip: name, onclick: action }, icon(iconName, 20));
    const sep = () => h('span', { class: 'chip-sep' });
    const edit = app.isEditLike;
    const items: Node[] = [];
    if (edit) {
      items.push(
        chip('vert', app.selectMode === 'vert', () => app.setSelectMode('vert'), 'Vertex select (1)'),
        chip('edge', app.selectMode === 'edge', () => app.setSelectMode('edge'), 'Edge select (2)'),
        chip('face', app.selectMode === 'face', () => app.setSelectMode('face'), 'Face select (3)'),
        sep(),
      );
    }
    if (app.mode !== 'sculpt') {
      const ops: [SelOp, string, string][] = [['set', 'selSet', 'Tap replaces selection'], ['add', 'selAdd', 'Tap adds / toggles'], ['sub', 'selSub', 'Tap removes from selection']];
      for (const [id, ic, t] of ops) items.push(chip(ic, app.selOp === id, () => { app.selOp = id; this.renderEditBar(); }, t));
      items.push(chip('selAll', false, () => app.selectAll(), 'Select all / none (A)'));
      items.push(sep());
      const gz = app.settings.gizmo;
      const gIcon: Record<string, string> = { move: 'move', rotate: 'rotate', scale: 'scale', none: 'gizmoOff' };
      const gName: Record<string, string> = { move: 'Move gizmo', rotate: 'Rotate gizmo', scale: 'Scale gizmo', none: 'No gizmo' };
      const gBtn: HTMLButtonElement = h('button', { class: `chip${gz !== 'none' ? ' on' : ''}`, tip: `Gizmo: ${gName[gz]}`, onclick: () => showMenu(gBtn, (['move', 'rotate', 'scale', 'none'] as const).map((g) => ({ label: gName[g], checked: gz === g, action: () => { app.settings.gizmo = g; this.renderEditBar(); app.vp.requestRender(); } })), 'Gizmo') }, icon(gIcon[gz], 20));
      items.push(gBtn);
    }
    if (edit) {
      items.push(
        chip('xray', app.vp.settings.xray, () => { app.vp.settings.xray = !app.vp.settings.xray; app.changed(); this.renderEditBar(); }, 'X-ray: see & select through'),
        chip('mirror', app.settings.mirrorX, () => { app.settings.mirrorX = !app.settings.mirrorX; this.renderEditBar(); }, 'Mirror edits across X'),
      );
      const pr = app.settings.proportional;
      const fall: [string, string][] = [['off', 'Off'], ['smooth', 'Smooth'], ['sphere', 'Sphere'], ['linear', 'Linear'], ['sharp', 'Sharp'], ['constant', 'Constant']];
      const pBtn: HTMLButtonElement = h('button', { class: `chip${pr.enabled ? ' on' : ''}`, tip: pr.enabled ? `Proportional editing: ${pr.falloff} (O)` : 'Proportional editing: off (O)', onclick: () => showMenu(pBtn, [
        ...fall.map(([f, l]) => ({ label: l, checked: f === 'off' ? !pr.enabled : pr.enabled && pr.falloff === f, action: () => { app.setPropFalloff(f as any); this.renderEditBar(); } })),
        { separator: true, label: '' },
        { label: `Radius: ${fmt(pr.radius, 3)}`, hint: 'adjust while transforming', disabled: true },
      ], 'Proportional') }, icon('proportional', 20));
      items.push(pBtn);
    }
    if (app.mode !== 'sculpt') items.push(chip('snap', app.settings.snap.enabled, () => { app.settings.snap.enabled = !app.settings.snap.enabled; this.renderEditBar(); }, 'Snap to increments'));
    const tap = app.gestures.settings.touchAsPen;
    items.push(chip('touchPen', tap, () => { app.gestures.settings.touchAsPen = !tap; this.saveInputSettings(); this.renderEditBar(); this.renderStatus(); },
      tap ? 'Touch acts like a pen: ON — 1 finger edits, 2 fingers navigate' : 'Touch acts like a pen: OFF — 1 finger navigates'));
    if (app.mode === 'sculpt') {
      const b = app.brush;
      items.push(this.slider('radius', 'Brush radius', b.radius, 5, 300, 1, (v) => { b.radius = v; app.vp.requestRender(); }, 'px'));
      items.push(this.slider('strength', 'Brush strength', b.strength, 0.01, 1, 0.01, (v) => { b.strength = v; app.vp.requestRender(); }));
      if (b.dyntopo) items.push(this.slider('detail', 'Detail size (smaller = finer)', b.detail, 2, 40, 1, (v) => { b.detail = v; }, 'px'));
    }
    this.editBar.append(...items);
  }

  private slider(iconName: string, name: string, value: number, min: number, max: number, step: number, set: (v: number) => void, unit = '') {
    const out = h('span', { class: 'slider-val' }, `${fmt(value, 2)}${unit}`);
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': name }) as HTMLInputElement;
    input.addEventListener('input', () => { const v = +input.value; out.textContent = `${fmt(v, 2)}${unit}`; set(v); });
    const ic = h('span', { tip: name, style: 'display:grid' }, icon(iconName, 18));
    return h('label', { class: 'chip slider' }, ic, input, out);
  }

  /* ================================================================ modal bar */
  renderModal() {
    const app = this.app;
    const bar = this.modalBar;
    clear(bar);
    const uvModal = this.uv.modal;
    const m = app.modal;
    if (!m && !uvModal) { bar.classList.add('hidden'); this.renderTop(); return; }
    bar.classList.remove('hidden');
    const ok = h('button', { class: 'mbtn ok', tip: 'Confirm (Enter)', onclick: () => { if (uvModal) this.uv.confirm(); else app.confirmModal(); } }, icon('check', 20));
    const cancel = h('button', { class: 'mbtn cancel', tip: 'Cancel (Esc)', onclick: () => { if (uvModal) this.uv.cancel(); else app.cancelModal(); } }, icon('close', 20));
    if (uvModal) {
      const axes: ('u' | 'v')[] = ['u', 'v'];
      bar.append(
        h('div', { class: 'mlabel' }, this.uv.describe()),
        ...(uvModal.kind !== 'rotate' ? axes.map((a) => h('button', { class: `axis ${a === 'u' ? 'x' : 'y'}${uvModal.axis === a ? ' on' : ''}`, tip: `Lock to ${a.toUpperCase()}`, onclick: () => this.uv.setAxis(a) }, a.toUpperCase())) : []),
        this.numInput((v) => this.uv.setNumeric(v)),
        cancel, ok,
      );
      return;
    }
    if (m!.kind === 'transform') {
      const s = m!.session;
      const axisBtn = (a: Axis, label: string) => h('button', { class: `axis ${a}${s.axis === a ? ' on' : ''}`, tip: a === 'n' ? 'Along normal' : `Lock to ${label} axis`, onclick: () => app.setModalAxis(a) }, label);
      bar.append(...([
        h('div', { class: 'mlabel' }, (m!.label !== s.kind ? `${m!.label} · ` : '') + s.describe()),
        axisBtn('x', 'X'), axisBtn('y', 'Y'), axisBtn('z', 'Z'),
        s.customAxis ? axisBtn('n', 'N') : null as any,
        this.numInput((v) => { s.setNumeric(v); }),
        s.target.kind === 'verts' && s.target.prop ? h('div', { class: 'param' },
          h('span', { class: 'pname', tip: 'Proportional radius (wheel or [ ] also work)', style: 'display:grid' }, icon('proportional', 16)),
          h('button', { class: 'mbtn small', tip: 'Smaller radius', onclick: () => app.scalePropRadius(1 / 1.25) }, icon('minus', 16)),
          h('span', { class: 'pval' }, fmt(app.settings.proportional.radius, 3)),
          h('button', { class: 'mbtn small', tip: 'Larger radius', onclick: () => app.scalePropRadius(1.25) }, icon('plus', 16)),
        ) : null as any,
        cancel, ok,
      ] as (Node | null)[]).filter((x): x is Node => !!x));
      if (m!.flavor === 'button') bar.append(h('div', { class: 'mhint' }, 'Drag anywhere in the view'));
    } else {
      bar.append(h('div', { class: 'mlabel' }, m!.label));
      m!.params.forEach((p, i) => {
        bar.append(h('div', { class: 'param' },
          h('span', { class: 'pname' }, p.name),
          h('button', { class: 'mbtn small', tip: `Decrease ${p.name.toLowerCase()}`, onclick: () => app.setParam(i, p.value - p.step) }, icon('minus', 16)),
          h('span', { class: 'pval' }, p.int && p.min === 0 && p.max === 1 ? (p.value ? 'on' : 'off') : p.int ? String(p.value) : fmt(p.value, 3)),
          h('button', { class: 'mbtn small', tip: `Increase ${p.name.toLowerCase()}`, onclick: () => app.setParam(i, p.value + p.step) }, icon('plus', 16)),
        ));
      });
      bar.append(cancel, ok, h('div', { class: 'mhint' }, `Drag in the view to adjust ${m!.params[0].name.toLowerCase()}`));
    }
    this.renderTop();
  }

  private numInput(apply: (v: number) => void) {
    const inp = h('input', { class: 'num', type: 'text', inputmode: 'decimal', placeholder: '123', enterkeyhint: 'done' }) as HTMLInputElement;
    inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (isFinite(v)) apply(v); });
    return inp;
  }

  /* ================================================================ status */
  renderStatus() {
    const app = this.app;
    clear(this.statusEl);
    const a = app.active;
    let stats = '';
    if (a && (app.isEditLike || app.mode === 'sculpt')) {
      const s = a.mesh.stats();
      stats = app.isEditLike ? `V ${a.mesh.selV.size}/${s.verts}  E ${a.mesh.selE.size}/${s.edges}  F ${a.mesh.selF.size}/${s.faces}  Tris ${s.tris}` : `V ${s.verts}  F ${s.faces}  Tris ${s.tris}`;
    } else {
      let v = 0, f = 0, t = 0;
      for (const o of app.scene.objects) { const s = o.mesh.stats(); v += s.verts; f += s.faces; t += s.tris; }
      stats = `${app.scene.objects.length} obj  V ${v}  F ${f}  Tris ${t}`;
    }
    const hint = app.statusText || this.hint();
    this.statusEl.append(h('div', { class: 'stats' }, stats));
    if (hint) this.statusEl.append(h('div', { class: 'hint' }, hint));
  }

  private hint(): string {
    const app = this.app;
    const pen = app.gestures.penMode;
    if (app.modal || this.uv.modal) return '';
    if (app.gestures.settings.touchAsPen && !pen) {
      if (app.mode === 'sculpt') return 'Touch = pen: 1 finger sculpts anywhere · 2 fingers pan/zoom · orbit with the nav buttons';
      return 'Touch = pen: tap select · drag empty = box select · drag element = move · 2 fingers pan/zoom · orbit with the nav buttons';
    }
    if (app.mode === 'sculpt' && app.brush.dyntopo) return (pen ? 'Pen sculpts' : 'Drag on mesh to sculpt') + ' · dynamic topology adds detail under the brush (Detail slider)';
    if (app.mode === 'sculpt') return pen ? 'Pen sculpts (pressure) · fingers navigate' : 'Drag on mesh to sculpt · drag off mesh to orbit · 2 fingers pan/zoom';
    if (app.tool === 'loopcut') return 'Tap an edge to insert an edge loop';
    if (app.tool === 'knife') return 'Knife: drag a line across faces to cut · starts/ends snap to vertices · 2 fingers navigate';
    if (app.isEditLike) return pen ? 'Pen: tap select, drag empty = box, drag vertex = move · fingers navigate' : 'Tap select · drag vertex to move · hold+drag box select · 1 finger orbit · 2 fingers pan/zoom · 2-finger tap undo';
    return pen ? 'Pen: tap select, drag = box select · fingers navigate' : 'Tap select · double-tap object to edit · 1 finger orbit · 2 fingers pan/zoom';
  }

  /* ================================================================ nav widget */
  private navWidget() {
    const wrap = h('div', { class: 'nav' });
    const drag = (name: string, title: string, fn: (dx: number, dy: number) => void) => {
      const b = h('button', { class: 'navbtn', tip: title }, icon(name, 20));
      let last: { x: number; y: number } | null = null;
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); last = { x: e.clientX, y: e.clientY }; b.classList.add('on'); });
      b.addEventListener('pointermove', (e) => { if (!last) return; fn(e.clientX - last.x, e.clientY - last.y); last = { x: e.clientX, y: e.clientY }; });
      const end = () => { last = null; b.classList.remove('on'); };
      b.addEventListener('pointerup', end);
      b.addEventListener('pointercancel', end);
      return b;
    };
    const tapBtn = (name: string, title: string, fn: (b: HTMLElement) => void) => { const b: HTMLButtonElement = h('button', { class: 'navbtn', tip: title, onclick: () => fn(b) }, icon(name, 20)); return b; };
    wrap.append(
      drag('orbit', 'Orbit (drag)', (dx, dy) => { this.app.vp.cam.orbit(dx, dy); this.app.redraw(); }),
      drag('pan', 'Pan (drag)', (dx, dy) => { this.app.vp.cam.pan(dx, dy, this.app.vp.height); this.app.redraw(); }),
      drag('zoom', 'Zoom (drag up/down)', (_dx, dy) => this.app.zoomAt(Math.exp(dy * 0.01), -1, -1)),
      tapBtn('frame', 'Frame selection', () => this.app.frameSelected()),
      tapBtn('views', 'Views', (b) => showMenu(b, [
        { label: 'Front', hint: 'Num1', action: () => this.app.setView('front') },
        { label: 'Back', action: () => this.app.setView('back') },
        { label: 'Right', hint: 'Num3', action: () => this.app.setView('right') },
        { label: 'Left', action: () => this.app.setView('left') },
        { label: 'Top', hint: 'Num7', action: () => this.app.setView('top') },
        { label: 'Bottom', action: () => this.app.setView('bottom') },
        { separator: true, label: '' },
        { label: 'Orthographic', checked: this.app.vp.cam.ortho, action: () => this.app.toggleOrtho() },
        { label: 'Frame all', action: () => this.app.frameAll() },
        { label: 'Wireframe', checked: this.app.vp.settings.wireframe, action: () => { this.app.vp.settings.wireframe = !this.app.vp.settings.wireframe; this.app.changed(); } },
        { label: 'Grid', checked: this.app.vp.settings.showGrid, action: () => { this.app.vp.settings.showGrid = !this.app.vp.settings.showGrid; this.app.redraw(); } },
      ], 'View')),
    );
    return wrap;
  }

  /* ================================================================ properties panel */
  renderPanel() {
    const app = this.app;
    if (!app.settings.panelOpen) return;
    // don't rebuild while the user is typing in the panel
    if (this.panel.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT' && (document.activeElement as HTMLInputElement).type !== 'range') return;
    this.panelScroll = this.panel.scrollTop;
    clear(this.panel);
    const sec = (title: string, ...c: (Node | null)[]) => h('section', { class: 'psec' }, h('h3', {}, title), ...c);
    // outliner
    const list = h('div', { class: 'outliner' }, app.scene.objects.map((o) => h('div', {
      class: `orow${app.scene.selected.has(o.id) ? ' sel' : ''}${app.scene.activeId === o.id ? ' act' : ''}`,
      onclick: (e: MouseEvent) => { if (app.mode !== 'object') app.setMode('object'); app.selectObject(o, e.shiftKey || app.selOp === 'add' ? 'add' : 'set'); },
    },
      h('span', { class: 'oname' }, o.name),
      h('span', { class: 'ostat' }, `${o.mesh.faces.length}f`),
      h('button', { class: 'iconbtn small', tip: o.visible ? 'Hide' : 'Show', onclick: (e: Event) => { e.stopPropagation(); app.record('Visibility'); o.visible = !o.visible; app.changed(); } }, icon(o.visible ? 'eye' : 'eyeoff', 18)),
    )));
    this.panel.append(sec('Scene', list));

    const a = app.active;
    if (app.mode === 'sculpt') this.panel.append(this.brushSection());
    if (a) {
      // object properties
      const name = h('input', { class: 'text', value: a.name }) as HTMLInputElement;
      name.addEventListener('change', () => { app.record('Rename'); a.name = name.value || a.name; app.changed(); this.renderTop(); });
      const vec = (label: string, get: () => V3, set: (v: V3) => void, conv = (x: number) => x, inv = (x: number) => x) => {
        const v = get();
        return h('div', { class: 'vecrow' }, h('span', { class: 'vlabel' }, label), ...[0, 1, 2].map((i) => {
          const inp = h('input', { class: `num ax${i}`, type: 'text', inputmode: 'decimal', value: fmt(conv(v[i])) }) as HTMLInputElement;
          inp.addEventListener('change', () => { const x = parseFloat(inp.value); if (!isFinite(x)) return; app.record(label); const nv = [...get()] as V3; nv[i] = inv(x); set(nv); app.changed(); });
          return inp;
        }));
      };
      this.panel.append(sec('Object',
        h('div', { class: 'row' }, h('span', { class: 'vlabel' }, 'Name'), name),
        vec('Location', () => a.position, (v) => (a.position = v)),
        vec('Rotation°', () => a.rotation, (v) => (a.rotation = v), deg, rad),
        vec('Scale', () => a.scale, (v) => (a.scale = v)),
        h('div', { class: 'row' },
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a.smooth, onchange: (e: Event) => app.setShading((e.target as HTMLInputElement).checked) }), 'Smooth shading'),
        ),
      ));
      // modifiers
      const mods = h('div', {}, a.modifiers.map((md) => {
        const head = h('div', { class: 'modhead' },
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: md.enabled, onchange: (e: Event) => { app.record('Toggle modifier'); md.enabled = (e.target as HTMLInputElement).checked; app.changed(); } }), MOD_NAMES[md.type]),
          h('div', { class: 'spacer' }),
          h('button', { class: 'tiny', onclick: () => app.applyModifiers(md.id) }, 'Apply'),
          h('button', { class: 'iconbtn small', tip: 'Remove modifier', onclick: () => { app.record('Remove modifier'); a.modifiers = a.modifiers.filter((x) => x !== md); app.changed(); } }, icon('trash', 16)),
        );
        let body: Node;
        if (md.type === 'mirror') {
          body = h('div', { class: 'row seg' }, ['X', 'Y', 'Z'].map((l, i) => h('button', { class: `segbtn${md.axis === i ? ' on' : ''}`, onclick: () => { app.record('Mirror axis'); md.axis = i as 0 | 1 | 2; app.changed(); } }, l)));
        } else if (md.type === 'subsurf') {
          body = h('div', { class: 'row seg' }, h('span', { class: 'vlabel' }, 'Levels'), [1, 2, 3].map((l) => h('button', { class: `segbtn${md.levels === l ? ' on' : ''}`, onclick: () => { app.record('Subdiv levels'); md.levels = l; app.changed(); } }, String(l))));
        } else body = this.heavyModifierBody(md);
        return h('div', { class: 'mod' }, head, body);
      }));
      const addMod: HTMLButtonElement = h('button', { class: 'tiny', onclick: () => showMenu(addMod, [
        { label: 'Mirror', action: () => app.addModifier('mirror') },
        { label: 'Subdivision surface', action: () => app.addModifier('subsurf') },
        { label: 'Remesh', hint: 'voxel / blocks / isotropic', action: () => app.addModifier('remesh') },
        { label: 'Decimate', hint: 'collapse / un-subdiv / planar', action: () => app.addModifier('decimate') },
      ], 'Add modifier') }, '+ Add modifier');
      const evalFaces = app.vp.view(a.id)?.evalMesh?.faces.length;
      const resultRow = a.modifiers.some((m) => m.enabled) && evalFaces !== undefined
        ? h('div', { class: 'note' }, `result: ${evalFaces} faces (base ${a.mesh.faces.length})${a.modifiers.some((m) => m.enabled && (m.type === 'remesh' || m.type === 'decimate')) ? ' · remesh/decimate are hidden in edit mode' : ''}`)
        : null;
      this.panel.append(sec('Modifiers', mods, resultRow, h('div', { class: 'row' }, addMod,
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: app.vp.settings.showModifiersInEdit, onchange: (e: Event) => { app.vp.settings.showModifiersInEdit = (e.target as HTMLInputElement).checked; app.changed(); } }), 'Show in edit'))));
      // material
      const color = h('input', { type: 'color', value: a.material.color }) as HTMLInputElement;
      color.addEventListener('input', () => { a.material.color = color.value; app.redraw(); });
      color.addEventListener('change', () => { app.changed(); });
      const rough = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(a.material.roughness) }) as HTMLInputElement;
      rough.addEventListener('input', () => { a.material.roughness = +rough.value; app.redraw(); });
      rough.addEventListener('change', () => app.changed());
      const metal = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(a.material.metalness) }) as HTMLInputElement;
      metal.addEventListener('input', () => { a.material.metalness = +metal.value; app.redraw(); });
      metal.addEventListener('change', () => app.changed());
      this.panel.append(sec('Material',
        h('div', { class: 'row' }, h('span', { class: 'vlabel' }, 'Colour'), color),
        h('div', { class: 'row' }, h('span', { class: 'vlabel' }, 'Rough'), rough),
        h('div', { class: 'row' }, h('span', { class: 'vlabel' }, 'Metal'), metal),
        h('div', { class: 'row' },
          h('button', { class: 'tiny', onclick: () => this.loadTexture() }, a.material.texture ? 'Replace texture' : 'Load texture'),
          a.material.texture ? h('button', { class: 'tiny', onclick: () => this.setTexture(null) }, 'Remove') : null),
        a.material.texture ? h('img', { class: 'texthumb', src: a.material.texture }) : null,
      ));
    }
    this.panel.scrollTop = this.panelScroll;
  }

  /** Settings UI for the remesh / decimate modifiers. Changes recompute after a frame so a busy hint shows. */
  private heavyModifierBody(md: Modifier): Node {
    const app = this.app;
    const commit = (label: string, f: () => void) => {
      app.record(label);
      f();
      app.status('Updating modifiers…', 0);
      this.renderPanel();
      setTimeout(() => { app.changed(); app.status('', 1); this.renderPanel(); }, 30);
    };
    const seg = <T extends string | number>(label: string, opts: [T, string][], cur: T | undefined, set: (v: T) => void) =>
      h('div', { class: 'row seg' }, h('span', { class: 'vlabel' }, label), opts.map(([v, l]) => h('button', { class: `segbtn${cur === v ? ' on' : ''}`, onclick: () => commit(label, () => set(v)) }, l)));
    const check = (label: string, v: boolean | undefined, set: (x: boolean) => void) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!v, onchange: (e: Event) => commit(label, () => set((e.target as HTMLInputElement).checked)) }), label);
    const num = (label: string, v: number, set: (x: number) => void, factor = 1.25) => {
      const inp = h('input', { class: 'num', type: 'text', inputmode: 'decimal', value: fmt(v, 4) }) as HTMLInputElement;
      inp.addEventListener('change', () => { const x = parseFloat(inp.value); if (isFinite(x) && x > 0) commit(label, () => set(x)); });
      return h('div', { class: 'row' }, h('span', { class: 'vlabel' }, label),
        h('button', { class: 'mbtn small', tip: `Smaller ${label.toLowerCase()}`, onclick: () => commit(label, () => set(v / factor)) }, icon('minus', 14)),
        inp,
        h('button', { class: 'mbtn small', tip: `Larger ${label.toLowerCase()}`, onclick: () => commit(label, () => set(v * factor)) }, icon('plus', 14)));
    };
    if (md.type === 'remesh') {
      const mode = md.remeshMode ?? 'voxel';
      return h('div', {},
        seg('Mode', [['voxel', 'Voxel'], ['blocks', 'Blocks'], ['isotropic', 'Isotropic']], mode, (v) => (md.remeshMode = v)),
        num(mode === 'isotropic' ? 'Edge len' : 'Voxel', md.size ?? 0.05, (x) => (md.size = x)),
        mode === 'voxel' ? seg('Smooth', [[0, '0'], [1, '1'], [2, '2'], [4, '4']], md.smooth ?? 1, (v) => (md.smooth = v)) : null,
        mode === 'voxel' ? check('Project onto original', md.project, (x) => (md.project = x)) : null,
        mode === 'isotropic' ? seg('Iterations', [[2, '2'], [4, '4'], [8, '8']], md.iterations ?? 4, (v) => (md.iterations = v)) : null,
        mode === 'isotropic' ? check('Quads where possible', md.quads, (x) => (md.quads = x)) : null,
      );
    }
    const mode = md.decimateMode ?? 'collapse';
    const ratio = h('input', { type: 'range', min: '0.01', max: '1', step: '0.01', value: String(md.ratio ?? 0.5) }) as HTMLInputElement;
    const ratioVal = h('span', { class: 'slider-val' }, fmt(md.ratio ?? 0.5, 2));
    ratio.addEventListener('input', () => { ratioVal.textContent = fmt(+ratio.value, 2); });
    ratio.addEventListener('change', () => commit('Decimate ratio', () => (md.ratio = +ratio.value)));
    return h('div', {},
      seg('Mode', [['collapse', 'Collapse'], ['unsubdivide', 'Un-subdiv'], ['planar', 'Planar']], mode, (v) => (md.decimateMode = v)),
      mode === 'collapse' ? h('div', { class: 'row' }, h('span', { class: 'vlabel' }, 'Ratio'), ratio, ratioVal) : null,
      mode === 'collapse' ? check('Quads where possible', md.quads, (x) => (md.quads = x)) : null,
      mode === 'collapse' ? check('Keep open borders', md.keepBoundary !== false, (x) => (md.keepBoundary = x)) : null,
      mode === 'unsubdivide' ? seg('Levels', [[1, '1'], [2, '2'], [3, '3']], md.iterations ?? 1, (v) => (md.iterations = v)) : null,
      mode === 'planar' ? num('Angle°', md.angle ?? 5, (x) => (md.angle = Math.min(90, x)), 1.5) : null,
      mode === 'planar' ? check('Stop at seams', md.delimitSeams, (x) => (md.delimitSeams = x)) : null,
    );
  }

  private brushSection() {
    const app = this.app, b = app.brush;
    const row = (label: string, el: Node) => h('div', { class: 'row' }, h('span', { class: 'vlabel' }, label), el);
    const range = (v: number, min: number, max: number, step: number, set: (x: number) => void) => {
      const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(v) }) as HTMLInputElement;
      r.addEventListener('input', () => { set(+r.value); this.renderEditBar(); app.vp.requestRender(); });
      return r;
    };
    const check = (label: string, v: boolean, set: (x: boolean) => void) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: v, onchange: (e: Event) => { set((e.target as HTMLInputElement).checked); this.renderRail(); } }), label);
    return h('section', { class: 'psec' }, h('h3', {}, `Brush · ${BRUSHES.find((x) => x.type === b.type)!.label}`),
      row('Radius', range(b.radius, 5, 300, 1, (x) => (b.radius = x))),
      row('Strength', range(b.strength, 0.01, 1, 0.01, (x) => (b.strength = x))),
      row('Falloff', h('div', { class: 'seg' }, (['smooth', 'sphere', 'sharp', 'linear'] as const).map((f) => h('button', { class: `segbtn${b.falloff === f ? ' on' : ''}`, onclick: () => { b.falloff = f; this.renderPanel(); } }, f)))),
      check('Pen pressure → strength', b.pressureStrength, (x) => (b.pressureStrength = x)),
      check('Pen pressure → radius', b.pressureRadius, (x) => (b.pressureRadius = x)),
      check('X symmetry', b.symmetryX, (x) => (b.symmetryX = x)),
      check('Dynamic topology (add detail while sculpting)', b.dyntopo, (x) => { b.dyntopo = x; this.renderEditBar(); }),
      row('Detail px', range(b.detail, 2, 40, 1, (x) => (b.detail = x))),
      check('Invert (subtract)', b.invert, (x) => (b.invert = x)),
    );
  }

  private async loadTexture() {
    const f = await openFile('image/*');
    if (!f) return;
    this.setTexture(await readAsDataURL(f));
  }

  private setTexture(url: string | null) {
    const a = this.app.active;
    if (!a) return;
    this.app.record(url ? 'Load texture' : 'Remove texture');
    a.material.texture = url;
    if (url) this.app.vp.settings.checker = false;
    this.app.changed();
    this.renderRail();
  }

  /* ================================================================ dialogs */
  private settingsDialog() {
    const app = this.app, s = app.settings, g = app.gestures.settings;
    const seg = <T extends string>(opts: [T, string][], cur: T, set: (v: T) => void) => {
      const box = h('div', { class: 'seg' });
      const draw = (c: T) => { clear(box); box.append(...opts.map(([v, l]) => h('button', { class: `segbtn${c === v ? ' on' : ''}`, onclick: () => { set(v); draw(v); } }, l))); };
      draw(cur);
      return box;
    };
    const check = (label: string, v: boolean, set: (x: boolean) => void) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: v, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }), label);
    const num = (label: string, v: number, set: (x: number) => void) => {
      const i = h('input', { class: 'num', type: 'text', inputmode: 'decimal', value: String(v) }) as HTMLInputElement;
      i.addEventListener('change', () => { const x = parseFloat(i.value); if (isFinite(x) && x > 0) set(x); });
      return h('div', { class: 'row' }, h('span', { class: 'vlabel wide' }, label), i);
    };
    // appearance: hue + tint (live)
    const hue = h('input', { type: 'range', class: 'hue-slider', min: '0', max: '359', step: '1', value: String(this.theme.hue), 'aria-label': 'Hue' }) as HTMLInputElement;
    const tint = h('input', { type: 'range', class: 'tint-slider', min: '0', max: '1', step: '0.05', value: String(this.theme.tint), 'aria-label': 'Tint' }) as HTMLInputElement;
    const swatches = h('div', { class: 'swatches' });
    const drawSwatches = () => {
      clear(swatches);
      swatches.append(...HUE_PRESETS.map((hv) => h('button', { class: `swatch${this.theme.hue === hv && this.theme.tint > 0 ? ' on' : ''}`, tip: `Hue ${hv}°`, style: `background:hsl(${hv} 85% 62%)`, onclick: () => { hue.value = String(hv); if (+tint.value === 0) tint.value = '1'; upd(); } })),
        h('button', { class: `swatch${this.theme.tint === 0 ? ' on' : ''}`, tip: 'Neutral grey', style: 'background:hsl(0 0% 62%)', onclick: () => { tint.value = '0'; upd(); } }));
    };
    const upd = () => { this.setTheme({ hue: +hue.value, tint: +tint.value }); drawSwatches(); };
    hue.addEventListener('input', upd);
    tint.addEventListener('input', upd);
    drawSwatches();
    const preview = h('div', { class: 'preview-row' }, ...['--bg', '--bg2', '--bg3', '--bg4', '--fg2', '--accent'].map((v) => h('span', { style: `background:var(${v})` })));
    const body = h('div', { class: 'settings' },
      h('h4', {}, 'Appearance'),
      h('p', { class: 'note' }, 'The interface is monochrome in one hue of your choice. Axis colours, destructive actions, seams and selection keep their functional colours.'),
      h('div', { class: 'row' }, h('span', { class: 'vlabel' }, 'Hue'), hue),
      h('div', { class: 'row' }, h('span', { class: 'vlabel' }, 'Tint'), tint),
      swatches,
      preview,
      h('div', { class: 'row' }, h('button', { class: 'tiny', onclick: () => { hue.value = String(DEFAULT_THEME.hue); tint.value = String(DEFAULT_THEME.tint); upd(); } }, 'Reset to default')),
      h('h4', {}, 'Stylus & touch'),
      h('div', { class: 'row' }, h('span', { class: 'vlabel wide' }, 'Palm rejection'), seg([['auto', 'Auto'], ['on', 'Pen only'], ['off', 'Off']], g.palmRejection, (v) => { g.palmRejection = v; s.palmRejection = v; if (v === 'off' || v === 'auto') app.gestures.resetPen(); this.renderStatus(); this.saveInputSettings(); })),
      h('p', { class: 'note' }, 'Auto: once an active pen is used, fingers only navigate (orbit / pan / zoom) and the pen does all editing. Pen barrel button drag orbits.'),
      check('Touch acts like a pen (1 finger edits, 2 fingers navigate)', g.touchAsPen, (x) => { g.touchAsPen = x; this.saveInputSettings(); this.renderEditBar(); this.renderStatus(); }),
      h('p', { class: 'note' }, 'Turn this on if your stylus is reported as a finger (e.g. Lenovo Tab Pen Plus on the Idea Tab Pro): the pen then taps, box-selects, moves and sculpts like a real pen.'),
      h('div', { class: 'row' }, h('span', { class: 'vlabel wide' }, 'Pen detection'), seg([['auto', 'Auto'], ['thin', 'Thin contact = pen']], g.stylusDetect, (v) => { g.stylusDetect = v; this.saveInputSettings(); })),
      h('p', { class: 'note' }, 'Use "Thin contact = pen" only if the stylus test shows your pen arriving as a finger.'),
      h('div', { class: 'row' },
        h('button', { class: 'tiny', onclick: () => openInputTest(this.app, () => this.saveInputSettings()) }, 'Open stylus & touch test'),
        h('button', { class: 'tiny', onclick: () => { this.app.autosave().finally(() => { location.href = location.pathname + '?stylustest'; }); } }, 'Test without 3D view')),
      check('One-finger drag on empty space orbits', s.touchOrbit, (x) => (s.touchOrbit = x)),
      check('Drag vertices / selected elements directly', s.tweak, (x) => (s.tweak = x)),
      check('Left-handed layout (tools on the right)', s.leftHanded, (x) => { s.leftHanded = x; this.renderAll(); }),
      window.PolygonsAndroid?.setFullscreen ? h('h4', {}, 'Display') : null,
      window.PolygonsAndroid?.setFullscreen ? check('Full screen (hide status & navigation bars)', !!window.PolygonsAndroid.isFullscreen?.(), (x) => window.PolygonsAndroid!.setFullscreen!(x)) : null,
      window.PolygonsAndroid?.setFullscreen ? h('p', { class: 'note' }, 'On some tablets (e.g. Lenovo Idea Tab Pro) full screen switches the pen off until the screen is turned off and on. Leave it off if your stylus stops responding.') : null,
      h('h4', {}, 'Snapping increments'),
      num('Move (units)', s.snap.move, (x) => (s.snap.move = x)),
      num('Rotate (degrees)', s.snap.rotate, (x) => (s.snap.rotate = x)),
      num('Scale (factor)', s.snap.scale, (x) => (s.snap.scale = x)),
    );
    dialog('Settings', body);
  }

  private helpDialog() {
    const rows: [string, string][] = [
      ['Long-press any icon', 'Shows its name (hover with a pen or mouse works too)'],
      ['Touch: tap', 'Select (replace / add / remove chips choose how)'],
      ['Touch: double-tap', 'Object → enter Edit · Edge → loop · Vertex/face → linked'],
      ['Touch: drag empty', 'Orbit'],
      ['Touch: drag vertex', 'Move it (tweak)'],
      ['Touch: hold, then drag', 'Box select'],
      ['Two fingers', 'Pinch zoom + pan'],
      ['Two-finger tap / three', 'Undo / redo'],
      ['Pen: tap / drag', 'Select / box select or tweak'],
      ['Pen: barrel button drag', 'Orbit'],
      ['Pen: pressure', 'Sculpt strength (and radius, optional)'],
      ['Pen hover', 'Pre-highlight, brush cursor, loop-cut preview'],
      ['Transform buttons', 'Then drag anywhere; X/Y/Z chips constrain; ✓ confirms'],
      ['Proportional', 'Chip or O toggles; while moving use −/+ in the bar, the mouse wheel or [ ]'],
      ['Knife', 'Drag a straight line across faces; repeat for more cuts'],
      ['Remesh / decimate', 'Modifiers in the panel, or one-shot from the globe menu (Object & Sculpt rail, Edit → Mesh tools)'],
      ['Keys', 'Tab edit · G/R/S + X/Y/Z · E extrude · I inset · Ctrl+B bevel · K knife · O proportional · Ctrl+R loop cut · M merge · F fill · J connect · L linked · U unwrap · A all · X delete · Shift+D duplicate · Ctrl+Z undo'],
      ['Mouse', 'Left select/box · Middle orbit · Shift+Middle / Right pan · Wheel zoom'],
    ];
    dialog('Gestures & shortcuts', h('table', { class: 'help' }, rows.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b)))));
  }
}

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
