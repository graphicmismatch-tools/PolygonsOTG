import { Mesh, MeshJSON } from './mesh';
import { Modifier } from './modifiers';
import { V3 } from './vec';

export interface Material {
  color: string;
  /** Data URL of an image texture, or null. */
  texture: string | null;
  roughness: number;
  metalness: number;
}

export const defaultMaterial = (): Material => ({ color: '#c8ccd4', texture: null, roughness: 0.75, metalness: 0 });

let idCounter = 0;
export const newId = () => `o${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export class SceneObject {
  id = newId();
  name: string;
  mesh: Mesh;
  position: V3 = [0, 0, 0];
  rotation: V3 = [0, 0, 0];
  scale: V3 = [1, 1, 1];
  smooth = false;
  visible = true;
  modifiers: Modifier[] = [];
  material: Material = defaultMaterial();

  constructor(name: string, mesh: Mesh) {
    this.name = name;
    this.mesh = mesh;
  }

  toJSON(): SceneObjectJSON {
    return {
      id: this.id, name: this.name, mesh: this.mesh.toJSON(),
      position: [...this.position] as V3, rotation: [...this.rotation] as V3, scale: [...this.scale] as V3,
      smooth: this.smooth, visible: this.visible,
      modifiers: this.modifiers.map((m) => ({ ...m })), material: { ...this.material },
    };
  }

  static fromJSON(j: SceneObjectJSON): SceneObject {
    const o = new SceneObject(j.name, Mesh.fromJSON(j.mesh));
    o.id = j.id ?? newId();
    o.position = [...j.position] as V3;
    o.rotation = [...j.rotation] as V3;
    o.scale = [...j.scale] as V3;
    o.smooth = !!j.smooth;
    o.visible = j.visible !== false;
    o.modifiers = (j.modifiers ?? []).map((m) => ({ ...m }));
    o.material = { ...defaultMaterial(), ...(j.material ?? {}) };
    return o;
  }
}

export interface SceneObjectJSON {
  id: string;
  name: string;
  mesh: MeshJSON;
  position: V3;
  rotation: V3;
  scale: V3;
  smooth: boolean;
  visible: boolean;
  modifiers: Modifier[];
  material: Material;
}

export interface SceneJSON {
  format: 'polygons-otg';
  version: 1;
  objects: SceneObjectJSON[];
  active: string | null;
  selected: string[];
}

export class Scene {
  objects: SceneObject[] = [];
  activeId: string | null = null;
  selected = new Set<string>();

  get active(): SceneObject | null {
    return this.objects.find((o) => o.id === this.activeId) ?? null;
  }

  byId(id: string) { return this.objects.find((o) => o.id === id) ?? null; }

  add(o: SceneObject, select = true) {
    this.objects.push(o);
    if (select) { this.selected.clear(); this.selected.add(o.id); this.activeId = o.id; }
    return o;
  }

  remove(id: string) {
    this.objects = this.objects.filter((o) => o.id !== id);
    this.selected.delete(id);
    if (this.activeId === id) this.activeId = this.objects.find((o) => this.selected.has(o.id))?.id ?? null;
  }

  uniqueName(base: string) {
    const names = new Set(this.objects.map((o) => o.name));
    if (!names.has(base)) return base;
    for (let i = 1; ; i++) { const n = `${base}.${String(i).padStart(3, '0')}`; if (!names.has(n)) return n; }
  }

  toJSON(): SceneJSON {
    return { format: 'polygons-otg', version: 1, objects: this.objects.map((o) => o.toJSON()), active: this.activeId, selected: [...this.selected] };
  }

  load(j: SceneJSON) {
    this.objects = j.objects.map((o) => SceneObject.fromJSON(o));
    this.activeId = j.active;
    this.selected = new Set(j.selected ?? []);
  }
}
