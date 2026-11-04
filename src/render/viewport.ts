import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { Scene, SceneObject, evalContext, armatureKey } from '../core/scene';
import { evalArmature, boneLength } from '../core/armature';
import { weightColor } from '../core/skin';
import { Mesh, parseKey } from '../core/mesh';
import { evaluate, HEAVY_MODIFIERS } from '../core/modifiers';
import { buildGeometry, refreshGeometry, BuiltGeometry } from './geometry';
import { V3 } from '../core/vec';

export type AppMode = 'object' | 'edit' | 'sculpt' | 'uv' | 'pose' | 'weight';

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
  // armature display
  bones: LineSegments2 | null = null;
  boneKey = '';
  /** posed head / tail of each bone in object space */
  boneEnds: [THREE.Vector3, THREE.Vector3][] = [];
  weightKey = '';

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
    this.bones?.geometry.dispose();
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
  private depthNear = 0;
  private depthFar = 1;
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
  /** Set while a transform / stroke is running: heavy modifiers aren't re-evaluated. */
  deferHeavy = false;
  settings: ViewSettings = { xray: false, wireframe: false, showModifiersInEdit: true, checker: false, showGrid: true };
  /** Vertex group shown as a heat map in weight mode. */
  weightGroup: string | null = null;
  private boneMat: LineMaterial;

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x3a3b41);
    this.scene3.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.6));
    this.headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene3.add(this.headlight);
    this.scene3.add(this.headlight.target);
    this.grid = makeGrid();
    this.scene3.add(this.grid);

    // Linear view depth, remapped to [near, far] and packed into 24 bits with exact integer
    // ops. Packing the non-linear gl_FragCoord.z with float divisions lost too much precision
    // on mobile GPUs: interior vertices tested as hidden and only silhouette ones (whose
    // neighbourhood touches the cleared background) survived box select.
    this.depthMat = new THREE.ShaderMaterial({
      uniforms: { uNear: { value: 0 }, uFar: { value: 1 } },
      vertexShader: `varying float vViewZ;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vViewZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `precision highp float; precision highp int;
        uniform float uNear; uniform float uFar; varying float vViewZ;
        void main(){
          float d = clamp((vViewZ - uNear) / (uFar - uNear), 0.0, 1.0);
          uint v = uint(d * 16777215.0 + 0.5);
          gl_FragColor = vec4(float((v >> 16u) & 255u), float((v >> 8u) & 255u), float(v & 255u), 255.0) / 255.0;
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
    this.boneMat = new LineMaterial({ linewidth: 1.6, vertexColors: true, worldUnits: false, depthTest: false, transparent: true });
    this.outlineMat = new LineMaterial({ linewidth: 1.2, color: 0xe08a2c, worldUnits: false });
    this.outlineMatActive = new LineMaterial({ linewidth: 1.6, color: 0xffb347, worldUnits: false });
    this.faceSelMat = new THREE.MeshBasicMaterial({ color: 0xff9a1f, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.checkerTex = makeChecker();
    this.loop();
  }

  requestRender() { this.needsRender = true; this.depthValid = false; }

  /** Theme-driven background colour (any CSS colour string). */
  setBackground(css: string) { this.renderer.setClearColor(new THREE.Color().setStyle(css)); this.requestRender(); }

  resize(w: number, h: number, dpr: number) {
    this.width = Math.max(1, w); this.height = Math.max(1, h); this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    this.cam.aspect = this.width / this.height;
    for (const m of [this.lineMat, this.lineMatXray, this.outlineMat, this.outlineMatActive, this.boneMat]) m.resolution.set(this.width, this.height);
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
    const editing = isActive && (mode === 'edit' || mode === 'uv' || mode === 'sculpt' || mode === 'weight');
    const useMods = !(editing && (mode === 'sculpt' || mode === 'weight' || !this.settings.showModifiersInEdit));
    // armature deformation is shown in object / pose mode only: edits happen on the rest shape
    const mods = useMods ? o.modifiers.filter((m) => m.enabled && !(editing && (HEAVY_MODIFIERS.includes(m.type) || m.type === 'armature'))) : [];
    const heavy = mods.some((m) => HEAVY_MODIFIERS.includes(m.type));
    const modsKey = JSON.stringify(mods) + (mods.some((m) => m.type === 'armature') ? armatureKey(scene, o) : '');
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
      // heavy modifiers: while dragging/sculpting keep showing the last result
      const stale = heavy && this.deferHeavy && v.built && v.displayKey.startsWith(`${key}|v`);
      if (v.displayKey !== fullKey && !stale) {
        if (v.built && v.built !== v.cage) v.built.geometry.dispose();
        v.evalMesh = evaluate(o.mesh, mods, evalContext(scene, o));
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
    // weight paint heat map
    const showWeights = editing && mode === 'weight';
    if (showWeights) this.syncWeightColors(v);
    if (mat.vertexColors !== showWeights) { mat.vertexColors = showWeights; mat.needsUpdate = true; }
    if (showWeights) { mat.color.set('#ffffff'); if (mat.map) { mat.map = null; v.textureKey = ''; mat.needsUpdate = true; } }
    const xray = editing && mode !== 'sculpt' && (this.settings.xray || !!o.armature);
    mat.transparent = xray;
    mat.opacity = xray ? 0.35 : 1;
    mat.depthWrite = !xray;
    mat.wireframe = this.settings.wireframe && !editing;

    // object-mode selection outline
    const showOutline = !o.armature && (mode === 'object' && scene.selected.has(o.id) || (this.settings.wireframe && !editing));
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
    if (editing && mode !== 'sculpt' && mode !== 'weight') this.syncOverlay(v, xray);
    else if (v.points) v.disposeOverlay();

    // bones
    if (o.armature) this.syncBones(v, scene, mode, editing);
    else if (v.bones) { v.group.remove(v.bones); v.bones.geometry.dispose(); v.bones = null; v.boneEnds = []; }

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

  private syncWeightColors(v: ObjectView) {
    const m = v.obj.mesh;
    const b = v.built;
    if (!b) return;
    const g = this.weightGroup ? m.groups.indexOf(this.weightGroup) : -1;
    const key = `${b.topoId}|${b.version}|${m.weightId}|${g}|${b.geometry.id}`;
    if (v.weightKey === key && b.geometry.getAttribute('color')) return;
    v.weightKey = key;
    const cv = b.cornerVert;
    const col = new Float32Array(cv.length * 3);
    const perVert = m.verts.map((_, i) => weightColor(g >= 0 ? m.weight(i, g) : 0));
    for (let i = 0; i < cv.length; i++) col.set(perVert[cv[i]] ?? [0, 0, 0.5], i * 3);
    b.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }

  private syncBones(v: ObjectView, scene: Scene, mode: AppMode, editing: boolean) {
    const o = v.obj, arm = o.armature!, m = o.mesh;
    const isActive = scene.activeId === o.id;
    // weight painting happens on the rest shape, so bound rigs are shown at rest too
    const rest = (isActive && mode === 'edit') || mode === 'weight';
    const posing = isActive && mode === 'pose';
    const objSel = mode === 'object' && scene.selected.has(o.id);
    const key = `${m.version}|${rest}|${posing}|${objSel}|${isActive}|${arm.selected}|${arm.active}|` + arm.bones.map((b) => `${b.parent}:${b.head}:${b.tail}:${b.roll}:${b.pose.rot}:${b.pose.loc}:${b.pose.scale}:${b.ik ? JSON.stringify(b.ik) : ''}`).join(';');
    if (v.bones && v.boneKey === key) return;
    v.boneKey = key;
    const ev = evalArmature(m, arm, !rest);
    const pos: number[] = [], col: number[] = [];
    const sel = new Set(arm.selected);
    const base = new THREE.Color(rest ? '#7d838f' : '#b8bcc6');
    const cSel = new THREE.Color('#59b8ff'), cAct = new THREE.Color('#a8deff');
    const cObj = new THREE.Color(isActive ? '#ffb347' : '#e08a2c');
    v.boneEnds = [];
    arm.bones.forEach((b, i) => {
      const L = boneLength(m, b) || 0.001;
      const M = ev.posed[i];
      const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(M);
      const head = P(0, 0, 0), tail = P(0, L, 0);
      v.boneEnds.push([head, tail]);
      const r = L * 0.1, y = L * 0.15;
      const ring = [P(r, y, 0), P(0, y, r), P(-r, y, 0), P(0, y, -r)];
      const segs: [THREE.Vector3, THREE.Vector3][] = [];
      for (let k = 0; k < 4; k++) segs.push([head, ring[k]], [ring[k], ring[(k + 1) % 4]], [ring[k], tail]);
      const c = posing ? (i === arm.active && sel.has(i) ? cAct : sel.has(i) ? cSel : base) : objSel ? cObj : base;
      for (const [a, bb] of segs) { pos.push(a.x, a.y, a.z, bb.x, bb.y, bb.z); col.push(c.r, c.g, c.b, c.r, c.g, c.b); }
    });
    if (v.bones) { v.group.remove(v.bones); v.bones.geometry.dispose(); v.bones = null; }
    if (!pos.length) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    g.setColors(col);
    v.bones = new LineSegments2(g, this.boneMat);
    v.bones.renderOrder = 6;
    v.group.add(v.bones);
    void editing;
  }

  /** World-space posed bone ends of an armature object. */
  boneEndsWorld(o: SceneObject): [THREE.Vector3, THREE.Vector3][] {
    const v = this.views.get(o.id);
    if (!v) return [];
    v.group.updateMatrixWorld(true);
    return v.boneEnds.map(([a, b]) => [a.clone().applyMatrix4(v.group.matrixWorld), b.clone().applyMatrix4(v.group.matrixWorld)]);
  }

  /** Nearest bone of an armature object to a screen point (within r px), or -1. */
  pickBone(o: SceneObject, x: number, y: number, r: number): number {
    let best = -1, bd = r;
    this.boneEndsWorld(o).forEach(([a, b], i) => {
      const sa = this.project(a), sb = this.project(b);
      if (sa.behind && sb.behind) return;
      const d = segDist2D(x, y, sa.x, sa.y, sb.x, sb.y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
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
      if (o.armature) {
        const bi = this.pickBone(o, x, y, 16);
        if (bi >= 0) {
          const [a, b] = this.boneEndsWorld(o)[bi];
          const p = a.clone().lerp(b, 0.5);
          // bones draw on top: prefer them over surfaces
          const d = 0;
          if (!best || d < best.distance) best = { obj: o, point: p, distance: d };
        }
        continue;
      }
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
    const cam = this.cam.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    this.depthNear = cam.near; this.depthFar = cam.far;
    this.depthMat.uniforms.uNear.value = cam.near;
    this.depthMat.uniforms.uFar.value = cam.far;
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
    const cam = this.cam.camera;
    const vz = -world.clone().applyMatrix4(cam.matrixWorldInverse).z;
    let maxD = -1;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const x = px + ox, y = py + oy;
      if (x < 0 || y < 0 || x >= this.depthW || y >= this.depthH) continue;
      const i = (y * this.depthW + x) * 4;
      const b = this.depthBuf!;
      const sd = (b[i] * 65536 + b[i + 1] * 256 + b[i + 2]) / 16777215;
      if (sd > maxD) maxD = sd;
    }
    if (maxD < 0 || maxD >= 1) return true; // off-buffer or touching background (silhouette)
    const surf = this.depthNear + maxD * (this.depthFar - this.depthNear);
    const ref = this.cam.ortho ? this.cam.distance : Math.max(surf, 0);
    return vz <= surf + Math.max(ref * 0.01, 1e-3) + tolerance;
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

function segDist2D(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
