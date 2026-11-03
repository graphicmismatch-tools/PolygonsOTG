import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { Scene, SceneObject } from '../core/scene';
import { Mesh, parseKey } from '../core/mesh';
import { evaluate } from '../core/modifiers';
import { buildGeometry, refreshGeometry, BuiltGeometry } from './geometry';
import { V3 } from '../core/vec';

export type AppMode = 'object' | 'edit' | 'sculpt' | 'uv';

export interface ViewSettings {
  xray: boolean;
  wireframe: boolean;
  showModifiersInEdit: boolean;
  checker: boolean;
  showGrid: boolean;
}

const COL_SEL = new THREE.Color('#ffa033');
const COL_EDGE = new THREE.Color('#151518');
const COL_SEAM = new THREE.Color('#ff3b3b');
const COL_VERT = new THREE.Color('#101012');

/* ------------------------------------------------------------------ camera */
export class OrbitCamera {
  target = new THREE.Vector3(0, 0, 0);
  yaw = Math.PI / 4;
  pitch = -0.5;
  distance = 9;
  ortho = false;
  fov = 45;
  persp = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  orth = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  aspect = 1;

  get camera(): THREE.Camera { return this.ortho ? this.orth : this.persp; }

  update() {
    this.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.pitch));
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const pos = this.target.clone().addScaledVector(dir, this.distance);
    for (const cam of [this.persp, this.orth]) {
      cam.position.copy(pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.target);
    }
    this.persp.fov = this.fov;
    this.persp.aspect = this.aspect;
    this.persp.near = Math.max(0.005, this.distance * 0.005);
    this.persp.far = this.distance * 50 + 500;
    this.persp.updateProjectionMatrix();
    const h = this.distance * Math.tan((this.fov * Math.PI) / 360);
    this.orth.left = -h * this.aspect; this.orth.right = h * this.aspect; this.orth.top = h; this.orth.bottom = -h;
    this.orth.near = -this.distance * 50 - 500; this.orth.far = this.distance * 50 + 500;
    this.orth.updateProjectionMatrix();
    this.persp.updateMatrixWorld(); this.orth.updateMatrixWorld();
  }

  orbit(dx: number, dy: number) { this.yaw -= dx * 0.008; this.pitch -= dy * 0.008; }

  /** World units per CSS pixel at the target depth. */
  worldPerPixel(viewH: number) { return (2 * this.distance * Math.tan((this.fov * Math.PI) / 360)) / Math.max(1, viewH); }

  pan(dx: number, dy: number, viewH: number) {
    const s = this.worldPerPixel(viewH);
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    this.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
  }

  setView(name: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom') {
    const v: Record<string, [number, number]> = {
      front: [0, 0], back: [Math.PI, 0], right: [Math.PI / 2, 0], left: [-Math.PI / 2, 0], top: [0, -Math.PI / 2], bottom: [0, Math.PI / 2],
    };
    [this.yaw, this.pitch] = v[name];
  }
}

/* ------------------------------------------------------------------ per-object visuals */
class ObjectView {
  group = new THREE.Group();
  display: THREE.Mesh;
  built: BuiltGeometry | null = null;
  evalMesh: Mesh | null = null;
  displayKey = '';
  material: THREE.MeshStandardMaterial;
  outline: LineSegments2 | null = null;
  outlineKey = '';
  // edit cage
  cage: BuiltGeometry | null = null;
  points: THREE.Points | null = null;
  lines: LineSegments2 | null = null;
  faceSel: THREE.Mesh | null = null;
  overlayKey = '';
  textureKey = '';
  depthMesh: THREE.Mesh;

  constructor(public obj: SceneObject, depthMat: THREE.Material) {
    this.material = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.75, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.display = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.group.add(this.display);
    this.depthMesh = new THREE.Mesh(new THREE.BufferGeometry(), depthMat);
    this.depthMesh.matrixAutoUpdate = false;
  }

  dispose() {
    this.built?.geometry.dispose();
    if (this.cage && this.cage !== this.built) this.cage.geometry.dispose();
    this.material.dispose();
    this.material.map?.dispose();
    this.disposeOverlay();
    this.outline?.geometry.dispose();
  }

  disposeOverlay() {
    for (const o of [this.points, this.lines, this.faceSel]) {
      if (!o) continue;
      this.group.remove(o);
      o.geometry.dispose();
    }
    this.points = this.lines = this.faceSel = null;
    this.overlayKey = '';
  }
}

/* ------------------------------------------------------------------ viewport */
export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene3 = new THREE.Scene();
  cam = new OrbitCamera();
  views = new Map<string, ObjectView>();
  width = 1;
  height = 1;
  dpr = 1;
  private needsRender = true;
  private grid: THREE.Group;
  private headlight: THREE.DirectionalLight;
  private depthRT: THREE.WebGLRenderTarget | null = null;
  private depthScene = new THREE.Scene();
  private depthMat: THREE.ShaderMaterial;
  private depthBuf: Uint8Array | null = null;
  private depthW = 0;
  private depthH = 0;
  private depthValid = false;
  private pointMat: THREE.ShaderMaterial;
  private lineMat: LineMaterial;
  private lineMatXray: LineMaterial;
  private outlineMat: LineMaterial;
  private outlineMatActive: LineMaterial;
  private faceSelMat: THREE.MeshBasicMaterial;
  private checkerTex: THREE.Texture;
  private textureCache = new Map<string, THREE.Texture>();
  onAfterRender: () => void = () => {};
  mode: AppMode = 'object';
  settings: ViewSettings = { xray: false, wireframe: false, showModifiersInEdit: true, checker: false, showGrid: true };

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x3a3b41);
    this.scene3.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.6));
    this.headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene3.add(this.headlight);
    this.scene3.add(this.headlight.target);
    this.grid = makeGrid();
    this.scene3.add(this.grid);

    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `precision highp float;
        void main(){
          float d = clamp(gl_FragCoord.z, 0.0, 1.0);
          float v = floor(d * 16777215.0);
          float r = floor(v / 65536.0);
          float g = floor((v - r * 65536.0) / 256.0);
          float b = v - r * 65536.0 - g * 256.0;
          gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    this.pointMat = new THREE.ShaderMaterial({
      uniforms: { size: { value: 7 } },
      vertexShader: `attribute vec3 color; varying vec3 vC; uniform float size;
        void main(){ vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = size; }`,
      fragmentShader: `varying vec3 vC;
        void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
          vec3 col = d > 0.36 ? vec3(0.95) : vC; gl_FragColor = vec4(col, 1.0); }`,
      depthTest: true,
    });
    this.lineMat = new LineMaterial({ linewidth: 1.6, vertexColors: true, worldUnits: false });
    this.lineMatXray = new LineMaterial({ linewidth: 1.6, vertexColors: true, worldUnits: false, depthTest: false, transparent: true });
    this.outlineMat = new LineMaterial({ linewidth: 1.2, color: 0xe08a2c, worldUnits: false });
    this.outlineMatActive = new LineMaterial({ linewidth: 1.6, color: 0xffb347, worldUnits: false });
    this.faceSelMat = new THREE.MeshBasicMaterial({ color: 0xff9a1f, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.checkerTex = makeChecker();
    this.loop();
  }

  requestRender() { this.needsRender = true; this.depthValid = false; }

  resize(w: number, h: number, dpr: number) {
    this.width = Math.max(1, w); this.height = Math.max(1, h); this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    this.cam.aspect = this.width / this.height;
    for (const m of [this.lineMat, this.lineMatXray, this.outlineMat, this.outlineMatActive]) m.resolution.set(this.width, this.height);
    this.pointMat.uniforms.size.value = (matchMedia('(pointer: coarse)').matches ? 9 : 7) * dpr;
    this.requestRender();
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    if (!this.needsRender) return;
    this.needsRender = false;
    this.render();
  };

  render() {
    this.cam.update();
    const cam = this.cam.camera;
    this.headlight.position.copy(cam.position).add(new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).multiplyScalar(this.cam.distance * 0.5));
    this.headlight.target.position.copy(this.cam.target);
    this.grid.visible = this.settings.showGrid;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene3, cam);
    this.onAfterRender();
  }

  /* ---------------------------------------------------------------- sync */
  /** Bring three.js objects in line with the scene. Cheap when nothing changed. */
  sync(scene: Scene, mode: AppMode) {
    this.mode = mode;
    const alive = new Set(scene.objects.map((o) => o.id));
    for (const [id, v] of this.views) if (!alive.has(id)) { this.scene3.remove(v.group); v.dispose(); this.views.delete(id); }
    for (const o of scene.objects) {
      let v = this.views.get(o.id);
      if (!v || v.obj !== o) {
        if (v) { this.scene3.remove(v.group); v.dispose(); }
        v = new ObjectView(o, this.depthMat);
        this.views.set(o.id, v);
        this.scene3.add(v.group);
      }
      this.syncObject(v, scene, mode);
    }
    this.requestRender();
  }

  private syncObject(v: ObjectView, scene: Scene, mode: AppMode) {
    const o = v.obj;
    v.group.visible = o.visible;
    v.group.position.set(...o.position);
    v.group.rotation.set(o.rotation[0], o.rotation[1], o.rotation[2], 'XYZ');
    v.group.scale.set(...o.scale);
    v.group.updateMatrixWorld(true);
    const isActive = scene.activeId === o.id;
    const editing = isActive && (mode === 'edit' || mode === 'uv' || mode === 'sculpt');
    const useMods = !(editing && (mode === 'sculpt' || !this.settings.showModifiersInEdit));
    const mods = useMods ? o.modifiers.filter((m) => m.enabled) : [];
    const modsKey = JSON.stringify(mods);
    const key = `${modsKey}|${o.smooth}`;
    // display geometry
    if (!mods.length) {
      const prev = v.built;
      v.built = refreshGeometry(v.evalMesh === o.mesh ? v.built : null, o.mesh, o.smooth);
      if (prev && prev !== v.built && prev !== v.cage) { /* disposed in refresh */ }
      v.evalMesh = o.mesh;
      v.displayKey = `nomod|${v.built.topoId}|${v.built.version}`;
      v.display.geometry = v.built.geometry;
    } else {
      const fullKey = `${key}|v${o.mesh.version}`;
      if (v.displayKey !== fullKey) {
        if (v.built && v.built !== v.cage) v.built.geometry.dispose();
        v.evalMesh = evaluate(o.mesh, mods);
        v.built = buildGeometry(v.evalMesh, o.smooth);
        v.display.geometry = v.built.geometry;
        v.displayKey = fullKey;
      }
    }

    // material
    const mat = v.material;
    mat.color.set(o.material.color);
    mat.roughness = o.material.roughness;
    mat.metalness = o.material.metalness;
    const texKey = this.settings.checker && (mode === 'uv' || mode === 'edit') ? 'checker' : o.material.texture ?? '';
    if (v.textureKey !== texKey) {
      v.textureKey = texKey;
      mat.map = texKey === 'checker' ? this.checkerTex : texKey ? this.getTexture(texKey) : null;
      if (texKey === 'checker') mat.color.set('#ffffff');
      mat.needsUpdate = true;
    }
    if (texKey === 'checker') mat.color.set('#ffffff');
    const xray = editing && mode !== 'sculpt' && this.settings.xray;
    mat.transparent = xray;
    mat.opacity = xray ? 0.35 : 1;
    mat.depthWrite = !xray;
    mat.wireframe = this.settings.wireframe && !editing;

    // object-mode selection outline
    const showOutline = mode === 'object' && scene.selected.has(o.id) || (this.settings.wireframe && !editing);
    if (showOutline) {
      const okey = `${v.displayKey}|${o.mesh.version}`;
      if (!v.outline || v.outlineKey !== okey) {
        v.outline?.geometry.dispose();
        if (v.outline) v.group.remove(v.outline);
        const em = v.evalMesh ?? o.mesh;
        const pos: number[] = [];
        for (const e of em.edges) pos.push(...em.verts[e.a], ...em.verts[e.b]);
        const g = new LineSegmentsGeometry();
        g.setPositions(pos);
        v.outline = new LineSegments2(g, this.outlineMat);
        v.outlineKey = okey;
        v.group.add(v.outline);
      }
      v.outline.material = scene.selected.has(o.id) ? (isActive ? this.outlineMatActive : this.outlineMat) : this.lineMat;
      if (!scene.selected.has(o.id)) { v.outline.material = this.outlineMat; }
      v.outline.visible = true;
    } else if (v.outline) v.outline.visible = false;

    // edit overlays
    if (editing && mode !== 'sculpt') this.syncOverlay(v, xray);
    else if (v.points) v.disposeOverlay();

    // cage geometry used for picking / depth
    if (editing) {
      if (!mods.length) v.cage = v.built;
      else {
        const own = v.cage && v.cage !== v.built ? v.cage : null;
        v.cage = refreshGeometry(own, o.mesh, false);
      }
    } else {
      if (v.cage && v.cage !== v.built) v.cage.geometry.dispose();
      v.cage = null;
    }
  }

  private syncOverlay(v: ObjectView, xray: boolean) {
    const m = v.obj.mesh;
    const key = `${m.version}|${m.selV.size}|${m.selE.size}|${m.selF.size}|${hashSel(m)}|${xray}`;
    if (v.overlayKey === key && v.points) return;
    v.disposeOverlay();
    v.overlayKey = key;
    // vertices
    const vp = new Float32Array(m.verts.length * 3);
    const vc = new Float32Array(m.verts.length * 3);
    m.verts.forEach((p, i) => {
      vp.set(p, i * 3);
      const c = m.selV.has(i) ? COL_SEL : COL_VERT;
      vc[i * 3] = c.r; vc[i * 3 + 1] = c.g; vc[i * 3 + 2] = c.b;
    });
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(vp, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(vc, 3));
    v.points = new THREE.Points(pg, this.pointMat);
    v.points.renderOrder = 3;
    (v.points.material as THREE.ShaderMaterial).depthTest = !xray;
    // edges
    const edges = m.edges;
    const lp: number[] = [], lc: number[] = [];
    for (const e of edges) {
      lp.push(...m.verts[e.a], ...m.verts[e.b]);
      const sel = m.selE.has(e.key);
      const c = sel ? COL_SEL : m.seams.has(e.key) ? COL_SEAM : COL_EDGE;
      lc.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const lg = new LineSegmentsGeometry();
    if (lp.length) { lg.setPositions(lp); lg.setColors(lc); }
    v.lines = new LineSegments2(lg, xray ? this.lineMatXray : this.lineMat);
    v.lines.renderOrder = 2;
    // selected faces
    const fp: number[] = [];
    for (const fi of m.selF) {
      const f = m.faces[fi];
      if (!f) continue;
      for (let i = 1; i + 1 < f.v.length; i++) fp.push(...m.verts[f.v[0]], ...m.verts[f.v[i]], ...m.verts[f.v[i + 1]]);
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    v.faceSel = new THREE.Mesh(fg, this.faceSelMat);
    v.faceSel.renderOrder = 1;
    v.group.add(v.faceSel, v.lines, v.points);
  }

  getTexture(url: string): THREE.Texture {
    let t = this.textureCache.get(url);
    if (!t) {
      t = new THREE.TextureLoader().load(url, () => this.requestRender());
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      this.textureCache.set(url, t);
    }
    return t;
  }

  get checkerTexture() { return this.checkerTex; }

  /* ---------------------------------------------------------------- picking */
  view(id: string) { return this.views.get(id); }

  /** Project a world point to CSS-pixel screen coordinates. */
  project(p: THREE.Vector3): { x: number; y: number; z: number; behind: boolean } {
    const v = p.clone().project(this.cam.camera);
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height, z: v.z, behind: v.z > 1 || v.z < -1 };
  }

  ray(x: number, y: number): THREE.Raycaster {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.cam.camera);
    return rc;
  }

  /** Raycast visible display meshes; returns closest hit. */
  pickObject(scene: Scene, x: number, y: number): { obj: SceneObject; point: THREE.Vector3; distance: number } | null {
    const rc = this.ray(x, y);
    let best: { obj: SceneObject; point: THREE.Vector3; distance: number } | null = null;
    for (const o of scene.objects) {
      if (!o.visible) continue;
      const v = this.views.get(o.id);
      if (!v) continue;
      const hits = rc.intersectObject(v.display, false);
      if (hits.length && (!best || hits[0].distance < best.distance)) best = { obj: o, point: hits[0].point, distance: hits[0].distance };
      // wire-only / point-only objects: pick by projected vertices
      if (!o.mesh.faces.length) {
        const mw = v.group.matrixWorld;
        for (const p of o.mesh.verts) {
          const s = this.project(new THREE.Vector3(...p).applyMatrix4(mw));
          if (Math.hypot(s.x - x, s.y - y) < 20) { const d = this.cam.camera.position.distanceTo(new THREE.Vector3(...p).applyMatrix4(mw)); if (!best || d < best.distance) best = { obj: o, point: new THREE.Vector3(...p).applyMatrix4(mw), distance: d }; }
        }
      }
    }
    return best;
  }

  /** Raycast the edit cage of an object. */
  pickCageFace(obj: SceneObject, x: number, y: number): { face: number; point: THREE.Vector3; local: THREE.Vector3 } | null {
    const v = this.views.get(obj.id);
    if (!v || !v.cage) return null;
    const mesh = new THREE.Mesh(v.cage.geometry, v.material);
    mesh.matrixWorld.copy(v.group.matrixWorld);
    mesh.matrixAutoUpdate = false;
    const hits = this.ray(x, y).intersectObject(mesh, false);
    if (!hits.length || hits[0].faceIndex == null) return null;
    const inv = v.group.matrixWorld.clone().invert();
    return { face: v.cage.triFace[hits[0].faceIndex], point: hits[0].point, local: hits[0].point.clone().applyMatrix4(inv) };
  }

  /** Raycast the *display* mesh of an object (sculpt). */
  pickDisplay(obj: SceneObject, x: number, y: number) {
    const v = this.views.get(obj.id);
    if (!v) return null;
    const hits = this.ray(x, y).intersectObject(v.display, false);
    if (!hits.length) return null;
    const inv = v.group.matrixWorld.clone().invert();
    return { point: hits[0].point, local: hits[0].point.clone().applyMatrix4(inv), face: v.built ? v.built.triFace[hits[0].faceIndex ?? 0] : -1 };
  }

  /** Render a depth buffer of edit cages (or display meshes) for occlusion tests. */
  ensureDepth() {
    if (this.depthValid && this.depthBuf) return;
    const w = Math.max(1, Math.floor(this.width * this.dpr / 2)), h = Math.max(1, Math.floor(this.height * this.dpr / 2));
    if (!this.depthRT || this.depthW !== w || this.depthH !== h) {
      this.depthRT?.dispose();
      this.depthRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true });
      this.depthW = w; this.depthH = h;
      this.depthBuf = new Uint8Array(w * h * 4);
    }
    this.depthScene.clear();
    for (const v of this.views.values()) {
      if (!v.obj.visible) continue;
      const geo = v.cage?.geometry ?? v.built?.geometry;
      if (!geo) continue;
      v.depthMesh.geometry = geo;
      v.depthMesh.matrixWorld.copy(v.group.matrixWorld);
      this.depthScene.add(v.depthMesh);
    }
    this.cam.update();
    const prevClear = new THREE.Color();
    this.renderer.getClearColor(prevClear);
    this.renderer.setClearColor(0xffffff, 1);
    this.renderer.setRenderTarget(this.depthRT);
    this.renderer.clear();
    this.renderer.render(this.depthScene, this.cam.camera);
    this.renderer.readRenderTargetPixels(this.depthRT!, 0, 0, w, h, this.depthBuf!);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(prevClear, 1);
    this.depthValid = true;
  }

  /** Whether a world point is not hidden behind cage surfaces. */
  isVisible(world: THREE.Vector3, tolerance = 0.002): boolean {
    this.ensureDepth();
    const s = this.project(world);
    if (s.behind) return false;
    const px = Math.floor((s.x / this.width) * this.depthW);
    const py = Math.floor((1 - s.y / this.height) * this.depthH);
    const d = s.z * 0.5 + 0.5;
    let maxD = -1;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const x = px + ox, y = py + oy;
      if (x < 0 || y < 0 || x >= this.depthW || y >= this.depthH) continue;
      const i = (y * this.depthW + x) * 4;
      const b = this.depthBuf!;
      const sd = (b[i] * 65536 + b[i + 1] * 256 + b[i + 2]) / 16777215;
      if (sd > maxD) maxD = sd;
    }
    if (maxD < 0) return true;
    // compare in linear view depth to get a scale-independent tolerance
    if (this.cam.ortho) return d <= maxD + tolerance;
    const lin = (z: number) => { const n = this.cam.persp.near, f = this.cam.persp.far; const ndc = z * 2 - 1; return (2 * n * f) / (f + n - ndc * (f - n)); };
    const ld = lin(d), ls = lin(maxD);
    return ld <= ls + Math.max(ls * 0.01, 1e-3);
  }

  objectMatrix(o: SceneObject): THREE.Matrix4 {
    const v = this.views.get(o.id);
    if (v) { v.group.updateMatrixWorld(true); return v.group.matrixWorld.clone(); }
    const m = new THREE.Matrix4();
    m.compose(new THREE.Vector3(...o.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...o.rotation, 'XYZ')), new THREE.Vector3(...o.scale));
    return m;
  }

  /** Frame a world-space bounding box. */
  frameBox(box: THREE.Box3) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(0.25, box.getSize(new THREE.Vector3()).length() / 2);
    this.cam.target.copy(c);
    this.cam.distance = r / Math.sin((this.cam.fov * Math.PI) / 360) * 1.1;
    this.requestRender();
  }

  snapshotPNG(): string {
    this.render();
    return this.canvas.toDataURL('image/png');
  }
}

function hashSel(m: Mesh) {
  let h = 0;
  for (const v of m.selV) h = (h * 31 + v + 1) | 0;
  for (const f of m.selF) h = (h * 17 + f + 7) | 0;
  for (const k of m.seams) h = (h * 13 + k.length + parseKey(k)[0]) | 0;
  return h;
}

function makeGrid(): THREE.Group {
  const g = new THREE.Group();
  const minor: number[] = [], major: number[] = [];
  const N = 20;
  for (let i = -N; i <= N; i++) {
    const arr = i % 5 === 0 ? major : minor;
    if (i !== 0) { arr.push(i, 0, -N, i, 0, N); arr.push(-N, 0, i, N, 0, i); }
  }
  const mk = (pos: number[], color: number, opacity: number) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  };
  g.add(mk(minor, 0x8a8a95, 0.18));
  g.add(mk(major, 0x9a9aa8, 0.35));
  g.add(mk([-N, 0, 0, N, 0, 0], 0xe0464e, 0.9));
  g.add(mk([0, 0, -N, 0, 0, N], 0x3d7bea, 0.9));
  g.renderOrder = -1;
  return g;
}

function makeChecker(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  const n = 8, s = 512 / n;
  const hues = [0, 30, 60, 120, 180, 210, 260, 300];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dark = (x + y) % 2 === 0;
    ctx.fillStyle = `hsl(${hues[(x + (n - 1 - y)) % hues.length]}, 45%, ${dark ? 38 : 70}%)`;
    ctx.fillRect(x * s, y * s, s, s);
    ctx.fillStyle = dark ? '#fff' : '#222';
    ctx.font = `bold ${s * 0.32}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`${String.fromCharCode(65 + x)}${n - y}`, x * s + s / 2, y * s + s / 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

export function v3(p: V3) { return new THREE.Vector3(p[0], p[1], p[2]); }
