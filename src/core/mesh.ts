import { V2, V3, avg3, polyNormal } from './vec';

export interface Face {
  /** Vertex indices, counter-clockwise when seen from the front. */
  v: number[];
  /** Per-corner UV coordinates (same length as v). */
  uv: V2[];
  /** Pinned UV corners (kept in place by unwrapping); absent = none pinned. */
  pin?: boolean[];
}

export interface EdgeInfo {
  a: number;
  b: number;
  key: string;
  /** Faces using this edge. */
  faces: number[];
}

export type SelectMode = 'vert' | 'edge' | 'face';

/** Is a face corner's UV pinned? (Pins whose length no longer matches the face are stale and ignored.) */
export const isPinned = (f: Face, c: number) => !!f.pin && f.pin.length === f.v.length && !!f.pin[c];

export const ekey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
export const parseKey = (k: string): [number, number] => {
  const i = k.indexOf('_');
  return [+k.slice(0, i), +k.slice(i + 1)];
};

export interface MeshJSON {
  verts: V3[];
  faces: Face[];
  looseEdges: [number, number][];
  seams: string[];
  selV: number[];
  selE: string[];
  selF: number[];
  /** Vertex groups (bone names) and sparse per-vertex [group, weight] pairs. */
  groups?: string[];
  vw?: VW[];
}

/** Sparse vertex weights: [group index, weight] pairs. */
export type VW = [number, number][];

/** Source for a new vertex's weights: a vertex, or a weighted blend of vertices. */
export type WeightSrc = number | [number, number][];

/**
 * Polygon mesh with n-gon faces, optional loose (wire) edges, UV seams and
 * edit-mode selection state. Topology caches are rebuilt lazily.
 */
export class Mesh {
  verts: V3[] = [];
  faces: Face[] = [];
  looseEdges: [number, number][] = [];
  seams = new Set<string>();
  /** Vertex group names (one per bone); empty when the mesh carries no weights. */
  groups: string[] = [];
  /** Per-vertex weights, parallel to verts when groups exist (missing entries = unweighted). */
  vw: VW[] = [];

  selV = new Set<number>();
  selE = new Set<string>();
  selF = new Set<number>();

  private _version = 0;
  private _topoVersion = -1;
  private _edges: EdgeInfo[] = [];
  private _edgeMap = new Map<string, number>();
  private _vertEdges: number[][] = [];
  private _vertFaces: number[][] = [];

  /** Incremented whenever geometry or topology changes. */
  get version() { return this._version; }
  /** Bumped on topology change (faces / vertex count). */
  topoId = 0;
  /** Bumped when UVs change. */
  uvId = 0;
  /** Positions changed only. */
  touch() { this._version++; }
  /** UVs changed only. */
  uvChanged() { this._version++; this.uvId++; }
  /** Topology changed: invalidate edge caches. */
  changed() { this._version++; this.topoId++; this._topoVersion = -1; }

  private ensureTopo() {
    if (this._topoVersion === this._version && this._topoVersion !== -1) return;
    const edges: EdgeInfo[] = [];
    const map = new Map<string, number>();
    const vertFaces: number[][] = Array.from({ length: this.verts.length }, () => []);
    const addEdge = (a: number, b: number, f: number) => {
      const k = ekey(a, b);
      let i = map.get(k);
      if (i === undefined) {
        i = edges.length;
        map.set(k, i);
        edges.push({ a: Math.min(a, b), b: Math.max(a, b), key: k, faces: [] });
      }
      if (f >= 0) edges[i].faces.push(f);
    };
    this.faces.forEach((f, fi) => {
      const n = f.v.length;
      for (let i = 0; i < n; i++) {
        addEdge(f.v[i], f.v[(i + 1) % n], fi);
        vertFaces[f.v[i]]?.push(fi);
      }
    });
    for (const [a, b] of this.looseEdges) addEdge(a, b, -1);
    const vertEdges: number[][] = Array.from({ length: this.verts.length }, () => []);
    edges.forEach((e, i) => { vertEdges[e.a]?.push(i); vertEdges[e.b]?.push(i); });
    this._edges = edges;
    this._edgeMap = map;
    this._vertEdges = vertEdges;
    this._vertFaces = vertFaces;
    this._topoVersion = this._version;
  }

  get edges(): EdgeInfo[] { this.ensureTopo(); return this._edges; }
  edgeIndex(key: string): number | undefined { this.ensureTopo(); return this._edgeMap.get(key); }
  edge(key: string): EdgeInfo | undefined { const i = this.edgeIndex(key); return i === undefined ? undefined : this._edges[i]; }
  vertEdges(v: number): EdgeInfo[] { this.ensureTopo(); return (this._vertEdges[v] ?? []).map((i) => this._edges[i]); }
  vertFaces(v: number): number[] { this.ensureTopo(); return this._vertFaces[v] ?? []; }
  vertNeighbors(v: number): number[] {
    return this.vertEdges(v).map((e) => (e.a === v ? e.b : e.a));
  }

  faceCenter(fi: number): V3 { return avg3(this.faces[fi].v.map((i) => this.verts[i])); }
  faceNormal(fi: number): V3 { return polyNormal(this.faces[fi].v.map((i) => this.verts[i])); }

  vertNormal(v: number): V3 {
    const n: V3 = [0, 0, 0];
    for (const f of this.vertFaces(v)) {
      const fn = this.faceNormal(f);
      n[0] += fn[0]; n[1] += fn[1]; n[2] += fn[2];
    }
    const l = Math.hypot(n[0], n[1], n[2]);
    return l > 1e-12 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 1, 0];
  }

  addVert(p: V3, from?: WeightSrc): number {
    this.verts.push([p[0], p[1], p[2]]);
    const i = this.verts.length - 1;
    if (this.groups.length) this.vw[i] = from === undefined ? [] : this.blendWeights(from);
    return i;
  }

  // ---------------------------------------------------------------- weights
  get hasWeights() { return this.groups.length > 0; }
  weightsOf(v: number): VW { return this.vw[v] ?? []; }
  weight(v: number, g: number): number { const e = this.vw[v]?.find((x) => x[0] === g); return e ? e[1] : 0; }
  setWeight(v: number, g: number, w: number) {
    const l = this.vw[v] ?? (this.vw[v] = []);
    const i = l.findIndex((x) => x[0] === g);
    if (w <= 1e-4) { if (i >= 0) l.splice(i, 1); return; }
    if (i >= 0) l[i][1] = Math.min(1, w); else l.push([g, Math.min(1, w)]);
  }
  groupIndex(name: string, create = false): number {
    let i = this.groups.indexOf(name);
    if (i < 0 && create) { i = this.groups.length; this.groups.push(name); while (this.vw.length < this.verts.length) this.vw.push([]); }
    return i;
  }
  /** Weighted blend of existing vertices' weights. */
  blendWeights(from: WeightSrc): VW {
    if (typeof from === 'number') return this.weightsOf(from).map(([g, w]) => [g, w]);
    const acc = new Map<number, number>();
    for (const [v, f] of from) for (const [g, w] of this.weightsOf(v)) acc.set(g, (acc.get(g) ?? 0) + w * f);
    return [...acc].filter(([, w]) => w > 1e-4);
  }
  /** Bump after weights change (display refresh). */
  weightId = 0;
  weightsChanged() { this.weightId++; this._version++; }
  copyWeightsFrom(src: Mesh) { this.groups = src.groups.slice(); this.vw = src.vw.map((l) => (l ? l.map(([g, w]) => [g, w] as [number, number]) : [])); }
  addFace(v: number[], uv?: V2[]): number {
    this.faces.push({ v: v.slice(), uv: uv ? uv.map((u) => [u[0], u[1]] as V2) : v.map(() => [0, 0] as V2) });
    return this.faces.length - 1;
  }

  // ---------------------------------------------------------------- selection
  clearSelection() { this.selV.clear(); this.selE.clear(); this.selF.clear(); }

  selectAll(mode: SelectMode) {
    this.verts.forEach((_, i) => this.selV.add(i));
    this.flush('vert');
    if (mode === 'face') this.flush('face');
  }

  /** Re-derive the non-primary selection sets from the primary one for a mode. */
  flush(mode: SelectMode) {
    if (mode === 'vert') {
      this.selE.clear(); this.selF.clear();
      for (const e of this.edges) if (this.selV.has(e.a) && this.selV.has(e.b)) this.selE.add(e.key);
      this.faces.forEach((f, i) => { if (f.v.every((v) => this.selV.has(v))) this.selF.add(i); });
    } else if (mode === 'edge') {
      this.selV.clear(); this.selF.clear();
      for (const k of this.selE) { const [a, b] = parseKey(k); this.selV.add(a); this.selV.add(b); }
      this.faces.forEach((f, i) => {
        const n = f.v.length;
        let all = true;
        for (let j = 0; j < n && all; j++) if (!this.selE.has(ekey(f.v[j], f.v[(j + 1) % n]))) all = false;
        if (all) this.selF.add(i);
      });
    } else {
      this.selV.clear(); this.selE.clear();
      for (const fi of this.selF) {
        const f = this.faces[fi];
        if (!f) continue;
        const n = f.v.length;
        for (let j = 0; j < n; j++) { this.selV.add(f.v[j]); this.selE.add(ekey(f.v[j], f.v[(j + 1) % n])); }
      }
      for (const [a, b] of this.looseEdges) if (this.selV.has(a) && this.selV.has(b)) this.selE.add(ekey(a, b));
    }
  }

  /** Mode switch: convert selection so it stays meaningful. */
  convertSelection(from: SelectMode, to: SelectMode) {
    if (from === to) return;
    if (to === 'vert') this.flush('vert');
    else if (to === 'edge') { this.flush('vert'); }
    else { this.flush('vert'); }
    // after a vertex flush, edges & faces fully covered by selected verts are selected
  }

  // ---------------------------------------------------------------- cleanup
  /**
   * Remove degenerate faces, duplicate consecutive indices, loose edges that
   * duplicate face edges, and unreferenced vertices (with remap).
   */
  cleanup(keepIsolatedSelected = false) {
    // collapse consecutive duplicate indices
    const faces: Face[] = [];
    for (const f of this.faces) {
      const v: number[] = [], uv: V2[] = [], pin: boolean[] = [];
      for (let i = 0; i < f.v.length; i++) {
        if (v.length && v[v.length - 1] === f.v[i]) continue;
        v.push(f.v[i]); uv.push(f.uv[i]); pin.push(!!f.pin?.[i]);
      }
      while (v.length > 1 && v[0] === v[v.length - 1]) { v.pop(); uv.pop(); pin.pop(); }
      if (new Set(v).size >= 3 && new Set(v).size === v.length) faces.push(pin.some(Boolean) ? { v, uv, pin } : { v, uv });
    }
    // remove duplicated faces (same vertex set)
    const seen = new Set<string>();
    const oldSelF = [...this.selF].map((i) => this.faces[i]);
    this.faces = faces.filter((f) => {
      const k = [...f.v].sort((a, b) => a - b).join(',');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // remap face selection by identity
    const fset = new Set(oldSelF);
    this.selF.clear();
    this.faces.forEach((f, i) => {
      for (const of of fset) {
        if (of && of.v.length === f.v.length && of.v.every((x, j) => x === f.v[j])) { this.selF.add(i); break; }
      }
    });
    // loose edges
    const faceEdges = new Set<string>();
    for (const f of this.faces) for (let i = 0; i < f.v.length; i++) faceEdges.add(ekey(f.v[i], f.v[(i + 1) % f.v.length]));
    const le = new Set<string>();
    this.looseEdges = this.looseEdges.filter(([a, b]) => {
      if (a === b) return false;
      const k = ekey(a, b);
      if (faceEdges.has(k) || le.has(k)) return false;
      le.add(k);
      return true;
    });
    // unreferenced verts
    const used = new Uint8Array(this.verts.length);
    for (const f of this.faces) for (const v of f.v) used[v] = 1;
    for (const [a, b] of this.looseEdges) { used[a] = 1; used[b] = 1; }
    if (keepIsolatedSelected) for (const v of this.selV) used[v] = 1;
    this.compact(used);
  }

  /** Keep only vertices where keep[i] is truthy and remap all references. */
  compact(keep: ArrayLike<number>) {
    const remap = new Int32Array(this.verts.length).fill(-1);
    const verts: V3[] = [];
    const vw: VW[] = [];
    for (let i = 0; i < this.verts.length; i++) if (keep[i]) { remap[i] = verts.length; verts.push(this.verts[i]); if (this.groups.length) vw.push(this.vw[i] ?? []); }
    if (verts.length === this.verts.length) { this.changed(); return; }
    this.verts = verts;
    if (this.groups.length) this.vw = vw;
    this.faces = this.faces.filter((f) => f.v.every((v) => remap[v] >= 0));
    for (const f of this.faces) f.v = f.v.map((v) => remap[v]);
    this.looseEdges = this.looseEdges.filter(([a, b]) => remap[a] >= 0 && remap[b] >= 0).map(([a, b]) => [remap[a], remap[b]]);
    const remapKey = (k: string) => { const [a, b] = parseKey(k); return remap[a] >= 0 && remap[b] >= 0 ? ekey(remap[a], remap[b]) : null; };
    this.seams = new Set([...this.seams].map(remapKey).filter((k): k is string => !!k));
    this.selV = new Set([...this.selV].filter((v) => remap[v] >= 0).map((v) => remap[v]));
    this.selE = new Set([...this.selE].map(remapKey).filter((k): k is string => !!k));
    this.changed();
  }

  // ---------------------------------------------------------------- serialization
  clone(): Mesh {
    const m = new Mesh();
    m.verts = this.verts.map((p) => [p[0], p[1], p[2]] as V3);
    m.faces = this.faces.map((f) => (f.pin ? { v: f.v.slice(), uv: f.uv.map((u) => [u[0], u[1]] as V2), pin: f.pin.slice() } : { v: f.v.slice(), uv: f.uv.map((u) => [u[0], u[1]] as V2) }));
    m.looseEdges = this.looseEdges.map((e) => [e[0], e[1]] as [number, number]);
    m.seams = new Set(this.seams);
    m.selV = new Set(this.selV);
    m.selE = new Set(this.selE);
    m.selF = new Set(this.selF);
    m.copyWeightsFrom(this);
    return m;
  }

  toJSON(): MeshJSON {
    return {
      verts: this.verts.map((p) => [round(p[0]), round(p[1]), round(p[2])] as V3),
      faces: this.faces.map((f) => ({ v: f.v.slice(), uv: f.uv.map((u) => [round(u[0]), round(u[1])] as V2), ...(f.pin?.some(Boolean) ? { pin: f.pin.slice() } : {}) })),
      looseEdges: this.looseEdges.map((e) => [e[0], e[1]] as [number, number]),
      seams: [...this.seams],
      selV: [...this.selV],
      selE: [...this.selE],
      selF: [...this.selF],
      ...(this.groups.length ? { groups: this.groups.slice(), vw: this.verts.map((_, i) => (this.vw[i] ?? []).map(([g, w]) => [g, round(w)] as [number, number])) } : {}),
    };
  }

  static fromJSON(j: MeshJSON): Mesh {
    const m = new Mesh();
    m.verts = j.verts.map((p) => [p[0], p[1], p[2]] as V3);
    m.faces = j.faces.map((f) => ({ v: f.v.slice(), uv: (f.uv ?? f.v.map(() => [0, 0])).map((u) => [u[0], u[1]] as V2), ...(f.pin ? { pin: f.v.map((_, i) => !!f.pin![i]) } : {}) }));
    m.looseEdges = (j.looseEdges ?? []).map((e) => [e[0], e[1]] as [number, number]);
    m.seams = new Set(j.seams ?? []);
    m.selV = new Set(j.selV ?? []);
    m.selE = new Set(j.selE ?? []);
    m.selF = new Set(j.selF ?? []);
    if (j.groups?.length) { m.groups = j.groups.slice(); m.vw = m.verts.map((_, i) => (j.vw?.[i] ?? []).map(([g, w]) => [g, w] as [number, number])); }
    m.changed();
    return m;
  }

  stats() {
    let tris = 0;
    for (const f of this.faces) tris += f.v.length - 2;
    return { verts: this.verts.length, edges: this.edges.length, faces: this.faces.length, tris };
  }
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;
