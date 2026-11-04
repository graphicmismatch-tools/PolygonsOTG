# Polygons OTG

**A quick-and-dirty but competent low → medium poly 3D modeller for Android tablets and phones.**

Polygons OTG is built around **vertex editing** rather than sculpting. It works with fingers, active styluses and mouse/keyboard alike. It has four workspaces modelled on Blender's, each with a smaller scope: **Object**, **Edit**, **Sculpt** and **UV**. The interface is terminal-style and monochrome, in a hue you choose.

It runs as an Android app (Capacitor) and, from the same code, in any modern browser as an installable offline PWA.

---

## Features

### Object mode
- **Primitives:** cube, plane, grid, circle, UV sphere, ico sphere, cylinder, cone, torus and single vertex.
- **Transforms:** move, rotate and scale with a gizmo or a drag-anywhere tool. There are X/Y/Z axis locks, typed values and snapping.
- **Object tools:** duplicate, delete, join, apply transform, set origin, and flat/smooth shading.
- **Properties panel:** an outliner, numeric location, rotation and scale fields, a modifier stack and a material. The material has a Respite-style colour picker, roughness, metalness and an image texture.
- **Modifiers:** Mirror, Subdivision Surface, Remesh and Decimate. All of them can be applied.

### Edit mode (vertex / edge / face)
- **Selecting:** tap, box, edge loop, edge ring, linked, grow, shrink, invert and all/none. You can drag vertices directly, and X-ray lets you select through the mesh.
- **Modelling:** extrude (region, edges or a lone vertex), inset, loop cut and slide (multiple cuts), bevel (edges or vertices, rounded with segments) and knife. Also subdivide, connect vertices, merge (at centre or by distance), fill, bridge edge loops, and delete or dissolve.
- **Mesh tools:** duplicate, separate, split, smooth, triangulate, flip and recalculate normals, and snap to X = 0.
- **Editing aids:** proportional editing (smooth, sphere, linear, sharp or constant falloff, with the radius adjustable live), X-mirror editing and snapping.

### Sculpt mode
- **Brushes:** draw, clay, inflate, smooth, flatten, pinch, crease and grab.
- **Pen pressure** can drive strength and/or radius. There's X symmetry and four falloff curves.
- **Dynamic topology** splits long edges under the brush, so a low-poly base gains detail exactly where you sculpt. You set the detail size in screen pixels.
- **Remesh in one step** (voxel or isotropic) to even out a sculpt afterwards.

### UV editing
- **Split view:** the 3D edit view next to a 2D UV editor.
- **Unwrapping:** seam-based LSCM conformal unwrap, smart UV project, and projection from view, cube, cylinder or sphere, plus island packing.
- **UV editing:** move, rotate and scale (with axis lock), flip, rotate 90°, weld, align, fit to 0–1, and island selection.
- **Textures:** a checker preview and image textures. You can export the UV layout as a PNG.

### Rigging & weights
- **Armatures:** Add → Armature. In Edit mode, bone joints act like vertices (tap, box select, drag, move/rotate/scale). Extrude (E) grows a child bone from the selected joint. You can also add, subdivide and delete bones, and symmetrize from +X to −X (Name.L → Name.R). The panel lists the bone hierarchy and edits each bone's name, parent, roll and whether it deforms the mesh.
- **Binding:** select the mesh and the armature, then use Rig → Bind. It adds an Armature modifier and, optionally, automatic weights (distance to the bones, smoothed across the surface). Rig → Bind with empty groups leaves the weights for you to paint.
- **Pose mode:** tap a bone to select it, or drag a bone to rotate it about its joint. R/G/S work too, with axis locks and typed values. Clear the pose of selected bones or the whole rig. Bound meshes deform live in Object and Pose mode.
- **Weight mode:** paint one bone's group (blue 0 → red 1) with draw, add, subtract and smooth brushes, with pen pressure and .L/.R X symmetry. Also: automatic weights, assign or remove the Edit-mode selection, mirror, normalize, and clear group.
- **Weights follow edits:** extrude, inset, loop cut, bevel, subdivide, knife and the rest interpolate weights for new vertices. Mirror and Subdivision modifiers carry them through, and remesh and decimate transfer them to the new mesh.

### Remesh & decimate
Use these as modifiers or as one-step actions (the globe button in the Object and Sculpt toolbars, or Edit → Mesh tools). The modes follow Blender's Remesh and Decimate modifiers and are implemented from the published algorithms:

| Mode | Method | Use it for |
|---|---|---|
| Remesh · Voxel | Distance field on a grid → naive Surface Nets, Taubin smoothing, optional projection back onto the original | Even, closed all-quad mesh after sculpting. It also closes holes and fuses overlapping parts |
| Remesh · Blocks | The same field, emitted as cubes | Voxel-art look |
| Remesh · Isotropic | Botsch & Kobbelt: split, collapse, valence flips, tangential relaxation, projection | Uniform triangles that keep open borders, optionally paired into quads |
| Decimate · Collapse | Garland & Heckbert quadric error metrics | Cutting the face count by a ratio while keeping the shape |
| Decimate · Un-subdivide | Labels each corner as original, edge or face-centre, then rebuilds the coarse faces | Undoing subdivision on quad grids |
| Decimate · Planar | Merges faces within an angle limit into n-gons and dissolves collinear vertices | Hard-surface and CAD-style cleanup |

### Files
- **Import:** OBJ, glTF/GLB and STL.
- **Export:** OBJ (with UVs and normals), GLB (with materials and textures, and skinned meshes with their skeleton in rest pose), STL and PNG screenshots. OBJ and STL use the current pose.
- **Projects:** saved as `.potg` files, with autosave on the device.
- **On Android**, exports open the share sheet: choose "Save to Files" or any app.

---

## Using it

### Input

| | Finger | Active stylus | Mouse / keyboard |
|---|---|---|---|
| Select | Tap. The replace / add / remove chips choose how a tap changes the selection | Tap | Click. Shift adds, Ctrl removes |
| Box select | Hold, then drag | Drag on empty space | Drag on empty space |
| Move an element | Drag it | Drag it | Drag it |
| Orbit | One-finger drag on empty space, or the orbit button | Drag with the barrel button held | Middle drag |
| Pan / zoom | Two-finger drag / pinch | Nav buttons | Right or Shift + middle drag / wheel |
| Undo / redo | Two-finger tap / three-finger tap | Toolbar | Ctrl+Z / Ctrl+Shift+Z |
| Sculpt | Drag on the mesh | Pressure-sensitive strokes with a hover cursor | Drag. Hold Ctrl to invert |

- **Transform tools** work without a keyboard. Tap Move, Rotate, Scale or Extrude, then drag anywhere; repeated drags add up. Lock to an axis with the X/Y/Z chips (or N for the face normal), type an exact value, then tap ✓.
- **Parametric tools** (inset, bevel, loop cut, subdivide, remesh and others) show −/+ steppers. You can also drag in the view to adjust them.
- **Long-press any icon** to see its name. A long-press never runs the tool. Hovering with a pen or mouse also shows the name.
- **Palm rejection (Auto):** once a pen is seen, fingers only move the view and the pen does all the editing.
- **Touch acts like a pen:** this toggle is for styluses the system reports as a finger. With it on, one touch edits exactly like a pen and two fingers navigate.
- **Menu → Stylus & touch test** shows live what your pen and fingers report: type, pressure, tilt, buttons and contact size.
- **Blender keys** work with a keyboard attached: Tab, G/R/S then X/Y/Z, E, I, Ctrl+B, K, O, Ctrl+R, M, F, J, L, U, A, X, Shift+D, 1/2/3 and Numpad 1/3/5/7.

### Appearance
Go to *Menu → Settings → Appearance* and pick a hue and tint (tint 0 gives neutral grey). Functional colours stay fixed: the X/Y/Z axes, red for destructive actions and seams, and the orange viewport selection.

### Tablet note: Lenovo Idea Tab Pro + Tab Pen Plus
On this tablet, the pen stopped working while an earlier custom WebView build of the app was maximised. It only came back in a floating window, or after turning the screen off and on. Rebuilding the Android shell as a stock Capacitor project fixed it. The shell now uses the same Capacitor versions and setup as the [Respite](https://github.com/graphicmismatch/respite) pixel editor, which already worked on that tablet. **Keep the `android/` project close to the Capacitor template** if you change it.

---

## Building

Requirements: Node 20+. For the Android APK you also need JDK 21 and the Android SDK (platform 36), with `android/local.properties` containing `sdk.dir=...`.

```bash
npm install
npm run dev        # dev server, reachable from a phone on the same network
npm test           # geometry kernel tests (vitest)
npm run build      # production web build -> dist/
npm run apk        # web build + cap sync + ./gradlew assembleDebug
                   # -> android/app/build/outputs/apk/debug/app-debug.apk
```

The debug APK installs directly by sideloading or with `adb install`. Add a release `signingConfig` before publishing to a store. The GitHub Actions workflow (`.github/workflows/android.yml`) runs the tests and uploads the web bundle and the APK as build artifacts.

## Project layout

```
src/
  core/      mesh (n-gons, wire edges, seams, selection), edit ops, bevel, primitives,
             modifiers, remesh, decimate, dynamic topology, UV unwrap/packing, scene, undo,
             armatures (bones, pose evaluation) and skinning (weights, auto weights)
  render/    three.js viewport, GPU geometry builder, edit overlays, picking, gizmo
  modes/     transform sessions, sculpt brushes, weight paint, UV editor
  input.ts   unified pointer gestures for touch / pen / mouse
  app.ts     application controller (modes, tools, selection, actions, keyboard)
  ui/        DOM UI: toolbars, chips, transform bar, properties panel, colour picker,
             theme, stylus test
  io/        OBJ / GLB / STL import and export, file access (Capacitor or browser)
android/     Capacitor 8 Android project (stock BridgeActivity)
tests/       vitest tests for the geometry kernel, bevel, remesh, decimate and rigging
```

The modelling kernel is plain TypeScript with no rendering dependency. three.js is used for display, and its matrix maths for bone transforms.

## Limitations
- Remeshing discards UVs and seams, so re-unwrap afterwards. The voxel grid is capped at about 3M points.
- Dynamic topology only adds detail and never collapses edges. It pauses above 400k faces.
- LSCM unwrapping needs seams on closed shapes. Closed parts without seams fall back to smart projection.
- Bevel needs edges with faces on both sides. Corners where three or more bevelled edges meet get a flat patch.
- The knife cuts in straight lines from edge to edge.
- GLB export keeps the 4 strongest bones per vertex (glTF's limit). Vertices without weights are bound to the root bone. There is no animation yet, so the skeleton exports in rest pose.
- Automatic weights use distance to the bones, not heat diffusion: check thin parts that sit close to other bones (fingers, arms near the torso) and touch them up in Weight mode.
- Meshes follow an armature through the Armature modifier, not object parenting: moving the armature object doesn't move a bound mesh in rest pose.
- Edit mode stays responsive up to a few tens of thousands of faces on current tablets.

## References
- Botsch & Kobbelt, *A Remeshing Approach to Multiresolution Modeling* (2004): isotropic remeshing.
- Garland & Heckbert, *Surface Simplification Using Quadric Error Metrics* (1997): collapse decimation.
- Lévy et al., *Least Squares Conformal Maps* (2002): UV unwrapping.
- Naive Surface Nets, as described by M. Lysenko: voxel remesh extraction.
- Blender manual: Remesh and Decimate modifier modes.
