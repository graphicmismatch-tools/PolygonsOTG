import { Scene, SceneObject } from './scene';
import { V3 } from './vec';
import { cloneArmature } from './armature';

/**
 * Snapshot-based undo. Low/medium poly meshes are small enough that a full
 * clone per step is cheap and far more robust than per-operation inverses.
 */
interface Snapshot {
  label: string;
  objects: { obj: SceneObject; data: ReturnType<typeof snapObject> }[];
  order: string[];
  active: string | null;
  selected: string[];
  mode: string;
}

function snapObject(o: SceneObject) {
  return {
    id: o.id, name: o.name, mesh: o.mesh.clone(),
    position: [...o.position] as V3, rotation: [...o.rotation] as V3, scale: [...o.scale] as V3,
    smooth: o.smooth, visible: o.visible,
    modifiers: o.modifiers.map((m) => ({ ...m })),
    material: { ...o.material },
    armature: o.armature ? cloneArmature(o.armature) : null,
  };
}

export class History {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  limit = 40;
  onChange: () => void = () => {};

  constructor(private scene: Scene, private getMode: () => string) {}

  private take(label: string): Snapshot {
    return {
      label,
      objects: this.scene.objects.map((o) => ({ obj: o, data: snapObject(o) })),
      order: this.scene.objects.map((o) => o.id),
      active: this.scene.activeId,
      selected: [...this.scene.selected],
      mode: this.getMode(),
    };
  }

  /** Call BEFORE mutating the scene. */
  push(label: string) {
    this.undoStack.push(this.take(label));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.onChange();
  }

  /** Drop the most recent snapshot (e.g. an operation that was cancelled). */
  cancelLast() { this.undoStack.pop(); this.onChange(); }

  private restore(s: Snapshot) {
    this.scene.objects = s.objects.map(({ obj, data }) => {
      obj.name = data.name;
      obj.mesh = data.mesh.clone();
      obj.position = [...data.position] as V3;
      obj.rotation = [...data.rotation] as V3;
      obj.scale = [...data.scale] as V3;
      obj.smooth = data.smooth;
      obj.visible = data.visible;
      obj.modifiers = data.modifiers.map((m) => ({ ...m }));
      obj.material = { ...data.material };
      obj.armature = data.armature ? cloneArmature(data.armature) : null;
      return obj;
    });
    this.scene.activeId = s.active;
    this.scene.selected = new Set(s.selected);
  }

  undo(): Snapshot | null {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push(this.take(s.label));
    this.restore(s);
    this.onChange();
    return s;
  }

  redo(): Snapshot | null {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push(this.take(s.label));
    this.restore(s);
    this.onChange();
    return s;
  }

  clear() { this.undoStack = []; this.redoStack = []; this.onChange(); }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label ?? ''; }
}
