# Polygons OTG

A quick-and-dirty but competent **low → medium poly 3D modeller for Android**, built
around **vertex editing** rather than sculpting. It works with **fingers and active
styluses** (S Pen, USI pens and similar), and has four workspaces modelled on Blender's,
each with a smaller scope:

| Workspace | What it covers |
|-----------|----------------|
| **Object** | Add primitives (cube, plane, grid, circle, UV/ico sphere, cylinder, cone, torus, single vertex). Move, rotate and scale with a gizmo or a drag-anywhere tool. Duplicate, delete, join, apply transforms, set origin, flat/smooth shading. Outliner, numeric transform fields, **Mirror** and **Subdivision Surface** modifiers, and a material (colour, roughness, metalness, image texture). |
| **Edit** | Vertex, edge and face selection with tap, box, loop, ring, linked, grow, shrink and invert. Direct vertex dragging. Extrude (region, edge or vertex), inset, loop cut and slide (multiple cuts), **bevel** (edges or vertices, with width and rounded segments), **knife** (drag a cut line across faces, snapping to vertices), subdivide, connect vertices, merge (at centre or by distance), fill (makes a face or edge), bridge edge loops, delete or dissolve, duplicate, separate, split, smooth, triangulate, flip and recalculate normals. Also **proportional editing** (smooth, sphere, linear, sharp or constant falloff, with a radius you can change while transforming), X-mirror editing, snapping, X-ray, and marking seams. |
| **Sculpt** | A small sculpt mode for shaping. It has 8 brushes: draw, clay, inflate, smooth, flatten, pinch, crease and grab. Pen pressure can control strength and/or radius. **Dynamic topology** splits long edges under the brush while you sculpt, so detail appears where you paint. You can set the detail size, and this works on any low-poly base. Also X symmetry, falloff curves, and a button that subdivides the whole mesh. |
| **UV** | Split view: the 3D edit view next to a 2D UV editor. Seam-based **LSCM conformal unwrap**, smart UV project, and projection from view, cube, cylinder or sphere. Island packing. Move, rotate and scale UVs (with axis lock), flip, rotate 90°, weld, align and fit. Island selection, a checker preview, image textures, and UV layout PNG export. |

**Remesh & decimate.** These are available as modifiers (with Apply) or as one-shot actions from the globe menu in the Object and Sculpt rails, and from Edit → Mesh tools. The modes follow Blender's Remesh and Decimate modifiers, using the published algorithms behind them:

| | Method | Good for |
|---|---|---|
| Remesh · **Voxel** | Signed distance field on a grid, with inside/outside found by flood fill, then extracted with naive Surface Nets. Adds Taubin smoothing and can project back onto the original | Even all-quad mesh after sculpting. Closes holes and fuses overlapping parts |
| Remesh · **Blocks** | The same field, emitted as cubes | Voxel-art look |
| Remesh · **Isotropic** | Botsch & Kobbelt 2004: split > 4/3 L, collapse < 4/5 L, valence flips, tangential relaxation, projection | Uniform triangles that keep open borders. Can pair them into quads |
| Decimate · **Collapse** | Garland & Heckbert quadric error metrics with a min-heap, boundary constraint planes, link-condition and flip checks | Reducing the face count by a ratio while keeping the shape |
| Decimate · **Un-subdivide** | Labels each corner as original, edge or face-centre, then rebuilds the coarse faces | Undoing subdivision on quad grids |
| Decimate · **Planar** | Merges faces within an angle limit into n-gons, then dissolves collinear vertices | Hard-surface and CAD-style cleanup |

Remesh and decimate modifiers are hidden in Edit mode so editing stays instant. While you drag, they keep showing the last result, and they recompute when you let go.

You can **import** OBJ, glTF/GLB and STL files. You can **export** OBJ (with UVs and normals), GLB (with materials and textures), STL, and PNG screenshots. Projects save as `.potg` files and autosave to the device.

## Input model

| | Touch | Active stylus | Mouse / keyboard |
|---|---|---|---|
| Select | Tap. The replace / add / remove chips choose how a tap changes the selection | Tap (precise pick radius) | Click. Shift adds, Ctrl removes |
| Box select | Hold, then drag | Drag on empty space | Drag on empty space |
| Move an element | Drag a vertex (or a selected edge or face) | Drag it | Drag it |
| Orbit | One-finger drag on empty space, or the orbit button | Drag with the barrel button held, or the nav buttons | Middle drag |
| Pan / zoom | Two-finger drag / pinch | Nav buttons | Shift + middle drag or right drag / wheel |
| Undo / redo | Two-finger tap / three-finger tap | Toolbar | Ctrl+Z / Ctrl+Shift+Z |
| Sculpt | Drag on the mesh. A drag that starts off the mesh orbits | Pressure-sensitive strokes, with a hover cursor | Drag. Hold Ctrl to invert |

**Icons & tooltips.** Tools are shown as icons. Long-press any icon to see its name; this never triggers the tool. Hovering with a pen or mouse also shows the name.

**Appearance.** The interface is monochrome. In *Menu → Settings → Appearance* you pick the hue, and a tint strength (0 gives neutral grey). Functional colours stay fixed: X/Y/Z axis colours, red for destructive actions and seams, and the orange viewport selection.

**Palm rejection.** In *Auto* mode (the default), once the app sees a pen, fingers only
navigate (orbit, pan, zoom) and all editing is done with the pen. Touches that land while the pen is
down or hovering are ignored. You can change this in *Menu → Settings*: *Pen only*, or *Off*.
Pen hover shows a highlight of the element you are about to pick, the sculpt brush cursor, and a preview of where a loop cut will go.

**Pens reported as fingers.** Some tablets report their pen to Android as a plain finger: no stylus flag, constant pressure. The Lenovo Tab Pen Plus on the Idea Tab Pro is one. For those, turn on **Touch acts like a pen** (the pen chip in the top bar, or Settings). A single touch then behaves exactly like a pen: tap selects, dragging empty space box-selects, dragging an element moves it, and strokes sculpt anywhere. Two fingers still pinch, pan and undo, and the nav buttons orbit. This is the same model as Respite's "Fingers draw".

**Stylus troubleshooting.** *Menu → Stylus & touch test* shows, live, what the web layer and Android report for each pointer, and what the app makes of it. It covers pointer type, pressure, tilt, buttons, contact size, and the raw Android tool type and device. Some tablets report an active pen as a *finger*. The Android wrapper rewrites those events as stylus events when they come from a stylus input device. If a pen still arrives as a finger, *Settings → Pen detection → Thin contact = pen* treats tiny contacts as the pen. Pens that report no real pressure get full strength rather than a placeholder value, and pen taps tolerate tip jitter.

**Transform tools** (Move / Rotate / Scale / Extrude) work on touch without a keyboard. Tap the
tool, then drag anywhere. Drags add up, so you can lift your finger and keep adjusting. Use the X/Y/Z
chips (or *N* for the face normal) to constrain to an axis, type an exact value, then tap ✓. Gizmo
handles act right away: drag an arrow, ring or box, and the change applies when you let go.
Parametric operations (inset, loop cut, subdivide, smooth, merge by distance) show − / + steppers.
You can also drag in the view to adjust them.

Blender-style keys also work when a keyboard is attached: Tab, G/R/S then X/Y/Z, E, I, Ctrl+R, M,
F, J, L, U, A, X, Shift+D, number keys 1/2/3, and Numpad 1/3/7/5.

## Project layout

```
src/
  core/        mesh data structure (n-gons, wire edges, seams, selection), edit ops,
               primitives, modifiers (mirror, Catmull–Clark), UV unwrap (LSCM / projections /
               packing), scene + undo history
  render/      three.js viewport, GPU geometry builder, edit overlays, depth-buffer
               occlusion for picking, gizmo
  modes/       transform sessions, sculpt brushes, UV editor
  input.ts     unified pointer gestures for touch / pen / mouse
  app.ts       application controller (modes, tools, selection, actions, keyboard)
  ui/          DOM UI (top bar, tool rail, floating chips, modal bar, properties panel)
  io/          OBJ / GLB / STL import-export, file access (Android bridge or browser)
android/       native wrapper: full-screen WebView + Storage Access Framework bridge
tests/         vitest unit tests for the geometry kernel
```

The modelling kernel is plain TypeScript and does not depend on rendering. three.js is only used for
display. The Android app is a thin native shell (`MainActivity.java`). It serves the built web
app from APK assets through `WebViewAssetLoader`, so the WebView passes pen pressure, hover and
tilt straight to the pointer-event layer. The same build also runs as an installable,
offline-capable PWA.

## Building

Requirements: Node 20+. For the APK you also need JDK 17+ and the Android SDK (platform 35 and build-tools 35).

```bash
npm install
npm run dev          # dev server (also reachable from a phone on the same network)
npm test             # geometry kernel tests
npm run build        # production web build -> dist/

# Android APK
npm run android:sync             # build + copy dist/ into android/app/src/main/assets/web
cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleRelease        # -> app/build/outputs/apk/release/app-release.apk
```

The release build is signed with the debug key, so it installs directly with `adb install` or by sideloading.
Set your own `signingConfig` in `android/app/build.gradle` before publishing to a store.
The GitHub Actions workflow (`.github/workflows/android.yml`) runs the tests and builds both the web
bundle and the APK as downloadable artifacts.

## Scope notes / limitations

- Remeshing discards UVs and seams, so re-unwrap afterwards. The voxel grid is capped at about 3M points, and the size is raised automatically (with a note in the status bar) when a mesh is too big for the chosen size.
- Dynamic topology only refines: it never merges or collapses edges. Use *Smooth* or lower the detail if an area gets too dense. Above 400k faces it pauses so the device stays responsive. Modifiers are hidden while you sculpt.
- Meshes up to a few tens of thousands of faces stay responsive in edit mode on recent phones and tablets.
- LSCM needs seams on closed shapes. A closed part without seams falls back to smart projection, and the status bar tells you when that happens.
- Bevel works on edges that have a face on both sides. The width is the distance moved along the neighbouring edges, and corners where three or more bevelled edges meet are closed with a flat patch.
- The knife cuts with straight lines from edge to edge. Cuts that start or end in the middle of a face are not supported.
