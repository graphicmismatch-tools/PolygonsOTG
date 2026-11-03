# Polygons OTG

A quick-and-dirty but competent **low → medium poly 3D modeller for Android**, built
around **vertex editing** rather than sculpting. It works with **fingers and active
styluses** (S Pen, USI pens and similar), and has four workspaces modelled on Blender's,
each with a smaller scope:

| Workspace | What it covers |
|-----------|----------------|
| **Object** | Add primitives (cube, plane, grid, circle, UV/ico sphere, cylinder, cone, torus, single vertex). Move, rotate and scale with a gizmo or a drag-anywhere tool. Duplicate, delete, join, apply transforms, set origin, flat/smooth shading. Outliner, numeric transform fields, **Mirror** and **Subdivision Surface** modifiers, and a material (colour, roughness, metalness, image texture). |
| **Edit** | Vertex, edge and face selection with tap, box, loop, ring, linked, grow, shrink and invert. Direct vertex dragging. Extrude (region, edge or vertex), inset, loop cut and slide (multiple cuts), subdivide, connect vertices, merge (at centre or by distance), fill (makes a face or edge), bridge edge loops, delete or dissolve, duplicate, separate, split, smooth, triangulate, flip and recalculate normals. Also X-mirror editing, snapping, X-ray, and marking seams. |
| **Sculpt** | A small sculpt mode for shaping. It has 8 brushes: draw, clay, inflate, smooth, flatten, pinch, crease and grab. Pen pressure can control strength and/or radius. Also X symmetry, falloff curves, and a button that subdivides the mesh to add resolution. |
| **UV** | Split view: the 3D edit view next to a 2D UV editor. Seam-based **LSCM conformal unwrap**, smart UV project, and projection from view, cube, cylinder or sphere. Island packing. Move, rotate and scale UVs (with axis lock), flip, rotate 90°, weld, align and fit. Island selection, a checker preview, image textures, and UV layout PNG export. |

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

- Sculpting works directly on the mesh vertices. There is no dynamic topology or multires, so subdivide first if you want more detail. Modifiers are hidden while you sculpt.
- Meshes up to a few tens of thousands of faces stay responsive on recent phones and tablets.
- LSCM needs seams on closed shapes. A closed part without seams falls back to smart projection, and the status bar tells you when that happens.
- Bevel, knife and proportional editing are not implemented yet.
