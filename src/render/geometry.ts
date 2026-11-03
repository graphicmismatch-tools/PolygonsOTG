import * as THREE from 'three';
import { Mesh } from '../core/mesh';
import { triangulateFace } from '../core/ops';
import { polyNormalRaw } from '../core/vec';

export interface BuiltGeometry {
  geometry: THREE.BufferGeometry;
  /** face index for each triangle */
  triFace: Int32Array;
  /** mesh vertex index for each triangle corner */
  cornerVert: Int32Array;
  /** corner index inside its face, for each triangle corner */
  cornerIdx: Int32Array;
  smooth: boolean;
  topoId: number;
  uvId: number;
  version: number;
}

/** Build non-indexed triangle geometry with per-corner UVs and flat or smooth normals. */
export function buildGeometry(m: Mesh, smooth: boolean): BuiltGeometry {
  const triList: number[] = [];
  const triFaceList: number[] = [];
  const uvs: number[] = [];
  const cornerIdxList: number[] = [];
  m.faces.forEach((f, fi) => {
    const tris = f.v.length === 3 ? [[0, 1, 2]] : triangulateFace(m.verts, f.v);
    for (const t of tris) {
      for (const c of t) { triList.push(f.v[c]); cornerIdxList.push(c); uvs.push(f.uv[c][0], f.uv[c][1]); }
      triFaceList.push(fi);
    }
  });
  const cornerVert = Int32Array.from(triList);
  const triFace = Int32Array.from(triFaceList);
  const geometry = new THREE.BufferGeometry();
  const pos = new Float32Array(cornerVert.length * 3);
  const nrm = new Float32Array(cornerVert.length * 3);
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(uvs), 2));
  const built: BuiltGeometry = { geometry, triFace, cornerVert, cornerIdx: Int32Array.from(cornerIdxList), smooth, topoId: m.topoId, uvId: m.uvId, version: m.version };
  updatePositions(built, m);
  return built;
}

/** Fast path: topology unchanged, refresh positions & normals. */
export function updatePositions(b: BuiltGeometry, m: Mesh) {
  const pos = b.geometry.getAttribute('position') as THREE.BufferAttribute;
  const nrm = b.geometry.getAttribute('normal') as THREE.BufferAttribute;
  const P = pos.array as Float32Array, N = nrm.array as Float32Array;
  const cv = b.cornerVert;
  for (let i = 0; i < cv.length; i++) {
    const p = m.verts[cv[i]];
    P[i * 3] = p[0]; P[i * 3 + 1] = p[1]; P[i * 3 + 2] = p[2];
  }
  // face normals (Newell over the whole polygon so quads stay flat-looking)
  const fn = new Float32Array(m.faces.length * 3);
  m.faces.forEach((f, fi) => {
    const n = polyNormalRaw(f.v.map((v) => m.verts[v]));
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    if (b.smooth) { fn[fi * 3] = n[0] / 2; fn[fi * 3 + 1] = n[1] / 2; fn[fi * 3 + 2] = n[2] / 2; } // area weighted
    else { fn[fi * 3] = n[0] / l; fn[fi * 3 + 1] = n[1] / l; fn[fi * 3 + 2] = n[2] / l; }
  });
  if (b.smooth) {
    const vn = new Float32Array(m.verts.length * 3);
    m.faces.forEach((f, fi) => { for (const v of f.v) { vn[v * 3] += fn[fi * 3]; vn[v * 3 + 1] += fn[fi * 3 + 1]; vn[v * 3 + 2] += fn[fi * 3 + 2]; } });
    for (let v = 0; v < m.verts.length; v++) {
      const l = Math.hypot(vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]) || 1;
      vn[v * 3] /= l; vn[v * 3 + 1] /= l; vn[v * 3 + 2] /= l;
    }
    for (let i = 0; i < cv.length; i++) { N[i * 3] = vn[cv[i] * 3]; N[i * 3 + 1] = vn[cv[i] * 3 + 1]; N[i * 3 + 2] = vn[cv[i] * 3 + 2]; }
  } else {
    for (let t = 0; t < b.triFace.length; t++) {
      const f = b.triFace[t];
      for (let c = 0; c < 3; c++) { const i = t * 3 + c; N[i * 3] = fn[f * 3]; N[i * 3 + 1] = fn[f * 3 + 1]; N[i * 3 + 2] = fn[f * 3 + 2]; }
    }
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
  b.geometry.computeBoundingSphere();
  b.geometry.computeBoundingBox();
}

/** Fast path: refresh UV attribute from face corners. */
export function updateUVs(b: BuiltGeometry, m: Mesh) {
  const uv = b.geometry.getAttribute('uv') as THREE.BufferAttribute;
  const U = uv.array as Float32Array;
  for (let t = 0; t < b.triFace.length; t++) {
    const f = m.faces[b.triFace[t]];
    for (let c = 0; c < 3; c++) {
      const i = t * 3 + c;
      const u = f.uv[b.cornerIdx[i]];
      U[i * 2] = u[0]; U[i * 2 + 1] = u[1];
    }
  }
  uv.needsUpdate = true;
  b.uvId = m.uvId;
}

/** Bring a built geometry up to date. Returns a (possibly new) geometry. */
export function refreshGeometry(b: BuiltGeometry | null, m: Mesh, smooth: boolean): BuiltGeometry {
  if (!b || b.topoId !== m.topoId || b.smooth !== smooth || b.cornerVert.length === 0 && m.faces.length) {
    b?.geometry.dispose();
    return buildGeometry(m, smooth);
  }
  if (b.version !== m.version) {
    updatePositions(b, m);
    if (b.uvId !== m.uvId) updateUVs(b, m);
    b.version = m.version;
  }
  return b;
}
