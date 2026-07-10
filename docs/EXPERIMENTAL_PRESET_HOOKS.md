# Experimental preset hooks (Depth Anything, glTF, Transformers.js)

Living notes for issue [#118](https://github.com/ford442/Project-M/issues/118) — how B3HD’s
advanced capabilities can enhance or be driven by Milkdrop presets **without** changing
core `.milk` compatibility.

## Architecture principle

| Layer | Role | Milkdrop-safe? |
|-------|------|----------------|
| `projectm-core.html` + shared `projectm-*.js` | Canonical visualization host | Yes — default path |
| `projectm.1ink` / `projectm_new.1ink` | Legacy full shell with inlined experiments | N/A (legacy) |
| `projectm-experimental-bridge.js` | **Opt-in** lazy bridge (`?experimental=1`) | Yes — off by default |
| `presets/experimental/` | Sample presets + docs only; excluded from default compat | Yes — opt-in load |

Standard presets in `custom_milk_fixed/`, `presets/tests/`, and API corpora are **never**
required to reference depth, glTF, or Transformers.js.

---

## Current B3HD usage (as of 2026-07)

### Depth Anything + Transformers.js

**Where:** `html/projectm.1ink`, `html/projectm_new.1ink` (not `projectm-core.html`).

**Flow:**

1. `getDepth()` XHR-fetches a UTF-32–encoded ES module from a remote URL (default
   `https://noahcohn.com/dpt-shader-sml-001.3ijs`, alt `wasm.noahcohn.com/b3hd/w0-022-depth.3ijs`).
2. UI uploads an image (or Python/Pyodide pipeline pushes a frame) → resized →
   `imageChannel.postMessage({ imageDataURL })` via `BroadcastChannel`.
3. The depth module runs Transformers.js inference and writes a depth visualization to
   `#resultImage` (and related DOM).
4. **No automatic link to projectM presets today** — depth output is a parallel 2D/3D pipeline.

**Related legacy hooks:** Pyodide image enhancement (`processImage`), APNG capture from
`#scanvas` / Three.js `#tvi`, `imageURL` channel for remote image paths.

### glTF load / save

**Where:** same legacy full hosts.

**Flow:**

- **Load:** `#loadGLTF` → `loaderChannel.postMessage({ GLloc })` where `GLloc` is the
  user-entered title from `#savedName`. A separate Three.js module (loaded with the depth
  stack) listens and hydrates a 3D scene.
- **Save:** `#savegltf` copies the title into `#saveName`; the glTF exporter module reads
  DOM state and serializes the current scene.
- **No preset metadata or WASM texture path integration** — orthogonal to Milkdrop FBOs.

### What *does* connect to presets today

| Mechanism | Location | Preset touchpoint |
|-----------|----------|-------------------|
| VFS `/textures/` scan + download | `projectM_emscripten.cpp` `scanTextures()` | `shapecode_N_image=foo.png`, `textured=1` |
| `projectm_sprite_create` / `_create_sprite` | WASM export | Milkdrop user-sprite `img=` sections |
| `DrawInitialImage` / feedback texture | libprojectM | Transition seed from previous preset output |
| Header metadata (`// tags:`, `// tier:`) | `docs/PRESET_METADATA.md` | Demo UX only — not renderer |

---

## Prototype bridge (`?experimental=1`)

`html/projectm-experimental-bridge.js` is imported by `projectm-core.html` but **activates
only** when the URL contains `experimental=1`.

### Enable

```
html/projectm-core.html?experimental=1&localPresets=1
```

Optional: `&depthModule=https://…/custom-depth.3ijs` to override the module URL.

### API (`window.pmExperimental`)

| Method | Purpose |
|--------|---------|
| `loadDepthModule()` | Fetch + eval legacy UTF-32 depth module |
| `runDepthFromUpload(dataUrl)` | Post image into `imageChannel` |
| `captureCanvasForDepth(canvas)` | Snapshot `#mcanvas` → depth pipeline |
| `applyDepthTexture(src)` | Write PNG to `/textures/pm_depth_map.png` |
| `injectVfsTexture(module, path, bytes)` | Generic VFS texture injection |
| `requestGltfLoad(title)` | Post to `loaderChannel` (legacy glTF loader) |
| `parseExperimentalMetadata(milkText)` | Parse `// pm:experimental` header |

### Events

| Event | When |
|-------|------|
| `pm:preset-loaded` | Dispatched from `updatePresetDisplay()` with `{ name, path }` |
| `pm:depth-texture-ready` | After depth map written to VFS |
| `pm:gltf-save-requested` | User clicked experimental glTF save |

---

## New preset authoring pattern (opt-in header)

Place **before** `MILKDROP_PRESET_VERSION` in experimental presets only:

```milk
// pm:experimental depth=auto depth-texture=pm_depth_map shapecode=0
// tags: experimental, depth, signature
MILKDROP_PRESET_VERSION=201
...
shapecode_0_enabled=1
shapecode_0_textured=1
shapecode_0_image=pm_depth_map.png
```

| Directive | Meaning |
|-----------|---------|
| `depth=auto` | On preset load, run depth pipeline if a source image is pending |
| `depth-texture=pm_depth_map` | VFS filename (`.png` added by bridge) |
| `depth-source=upload` | Require user upload before auto-run |
| `gltf-export=on-lock` | Future: export glTF when preset locked (coordinator only) |
| `gltf-export=true` | Flag for manual export via experimental panel |

**Compatibility:** Presets without this header behave exactly as before. If
`pm_depth_map.png` is missing, projectM falls back to the main feedback texture for
textured shapes (see `CustomShape.cpp`).

---

## Integration ideas — effort tiers

### Low-hanging fruit (prototype started)

| Idea | How | Effort |
|------|-----|--------|
| Depth → displacement texture | Bridge writes `/textures/pm_depth_map.png`; preset uses `shapecode_*_image` | **Done (prototype)** |
| Canvas → depth → preset | “Depth from canvas” captures live viz, re-injects as texture | **Done (prototype)** |
| Preset metadata drives depth | `// pm:experimental depth=auto` on load | **Done (prototype)** |
| BroadcastChannel parity | `imageChannel` / `loaderChannel` wired in bridge | **Done (prototype)** |
| User-sprite parallax layer | `projectm_sprite_create` with depth-as-alpha (host builds sprite code) | Small — JS only |
| Featured pack tag `experimental` | Filter in `projectm-preset-library.js` | Small |

### Medium effort

| Idea | Notes |
|------|-------|
| Warp/composite `sampler` for depth | Inject custom texture + HLSL `tex2D` in `shader_body` (PSVERSION 3); needs stable sampler naming in transpiler |
| Beat-synced depth refresh | Re-capture canvas on `bass_att` threshold; throttle to ≤2 Hz |
| Depth as `q` variable proxy | Host writes smoothed depth centroid into a preset global via sprite `per_frame` (hacky) |
| Lazy-load depth module from shared `projectm-experimental-depth.js` wrapper | Dedupe `getDepth()` from `.1ink` hosts |

### High effort / research

| Idea | Notes |
|------|-------|
| Full glTF scene export of preset state | Requires serializing FBO floats, mesh UVs, shader graphs — not in Milkdrop format |
| Real-time 3D layering (Three.js + projectM FBO) | Dual WebGL contexts or shared texture import via `WEBGL_shared_resources` (limited support) |
| Transformers.js in preset equations | Not feasible — equations are eval’d in projectM-eval, not JS |
| Depth-driven mesh tessellation | Would need C++ hook in `PerPixelMesh` — upstream-sized change |
| COOP/COEP + Transformers WASM threads | Already required for projectM pthreads; depth model adds ~50–100 MB |

---

## Sample preset

`presets/experimental/depth_overlay_demo.milk` — textured shape overlay that uses
`pm_depth_map.png` when the experimental bridge has injected it. Safe to load without
depth (falls back to feedback texture).

Load manually:

```
?experimental=1&localPresets=1&devPreset=1
```

Then paste or fetch the `.milk`, upload an image or capture canvas, reload preset.

---

## Separation checklist (for PRs)

- [ ] No changes to default `PresetCompat` paths for `presets/experimental/`
- [ ] `projectm-experimental-bridge.js` gated behind `?experimental=1`
- [ ] No new hard dependencies in `projectm-init.js` / WASM link line
- [ ] Document any new `// pm:experimental` fields here, not in `PRESET_METADATA.md` core table
- [ ] Legacy `.1ink` hosts unchanged unless explicitly migrating a hook into the bridge

---

## Related files

- `html/projectm-experimental-bridge.js` — prototype bridge
- `html/projectm.1ink` — legacy depth / glTF UI + `getDepth()`
- `html/README.md` — host architecture (extended features = lazy modules)
- `docs/PRESET_METADATA.md` — standard metadata (orthogonal)
- `docs/PRESET_ROADMAP.md` — milestone M3 / issue #118
