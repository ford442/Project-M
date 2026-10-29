# Experimental preset hooks (Depth Anything, glTF, Transformers.js)

Living notes for issue [#118](https://github.com/ford442/Project-M/issues/118) /
[JUL-989](https://linear.app/jules-1inkus/issue/JUL-989) — how B3HD’s advanced
capabilities can enhance or be driven by Milkdrop presets **without** changing
core `.milk` compatibility.

**Evaluation status (2026-07-10):** complete for M3. Prototypes ship behind
`?experimental=1`. Full real-time 3D / Transformers-in-equations remain
**out of scope** for core Milkdrop.

## Architecture principle

| Layer | Role | Milkdrop-safe? |
|-------|------|----------------|
| `projectm-core.html` + shared `projectm-*.js` | Canonical visualization host | Yes — default path |
| `projectm.1ink` / `projectm_new.1ink` | Redirect stubs → `projectm-core.html?experimental=1` (formerly legacy full shells with inlined experiments) | N/A (legacy, see git history) |
| `projectm-experimental-bridge.js` | **Opt-in** lazy bridge (`?experimental=1`) | Yes — off by default |
| `presets/experimental/` | Sample presets + docs only; excluded from default compat | Yes — opt-in load |

Standard presets in `presets/custom/`, `presets/tests/`, and API corpora are **never**
required to reference depth, glTF, or Transformers.js.

---

## Task checklist (#118)

- [x] Review current usage of Depth Anything + Transformers.js and glTF load/save
- [x] Brainstorm and prototype ways presets could consume or influence these
- [x] Identify low-hanging fruit vs. high-effort experiments
- [x] Document findings and new preset authoring patterns
- [x] Keep experimental work clearly separated from core Milkdrop compatibility

---

## Current B3HD usage (as of 2026-07)

### Depth Anything + Transformers.js

**Where:** `html/projectm.1ink`, `html/projectm_new.1ink` (legacy full hosts).
**Canonical opt-in:** `html/projectm-experimental-bridge.js` on `projectm-core.html`.

**Legacy flow (`projectm.1ink`):**

1. `getDepth()` XHR-fetches a UTF-32–encoded ES module from a remote URL (default
   `https://noahcohn.com/dpt-shader-sml-001.3ijs`, alt `wasm.noahcohn.com/b3hd/w0-022-depth.3ijs`).
2. UI uploads an image (or Python/Pyodide pipeline pushes a frame) → resized →
   `BroadcastChannel('imageChannel').postMessage({ imageDataURL })` (**input only**).
3. The depth module runs Transformers.js inference and writes a depth visualization to
   `#resultImage` (and related DOM / Three.js `#tvi`).
4. Historically **no automatic link to projectM presets** — depth output was a parallel pipeline.

**Bridge flow (`?experimental=1`):**

1. Same remote depth module (lazy-loaded).
2. Inputs still use `imageChannel` with `role: 'depth-input'`.
3. Results bind from `#resultImage` (hidden element auto-created on core) **or**
   `imageChannel` messages with `role: 'depth-result'`.
4. PNG written to VFS `/textures/pm_depth_map.png`, then `reload_texture('pm_depth_map')`
   updates the loaded texture in place, so a preset sampling `pm_depth`, a
   `shapecode_*_image=pm_depth_map.png` shape or a depth sprite shows the new map on its next
   frame. Only when nothing had loaded the texture yet (or on a bundle without
   `reload_texture`) is the preset reloaded instead. The bridge writes a 1x1 black seed map
   at startup so the first preset that asks for it loads a file texture that can be updated.

### glTF load / save

**Where:** legacy full hosts + experimental panel coordinator.

**Flow:**

- **Load:** `#loadGLTF` / panel → `loaderChannel.postMessage({ GLloc })` where `GLloc` is the
  user-entered title. A separate Three.js module (loaded with the depth stack) listens
  and hydrates a 3D scene.
- **Save:** `#savegltf` / panel copies the title into `#saveName`; the glTF exporter module
  reads DOM state and serializes the current **Three.js** scene (not the Milkdrop FBO graph).
- **Preset tie-in:** `// pm:experimental gltf-export=true|on-lock` sets
  `pmExperimental._gltfExportMode` only — actual export still requires the Three.js module.

### What *does* connect to presets today

| Mechanism | Location | Preset touchpoint |
|-----------|----------|-------------------|
| VFS `/textures/` + depth PNG inject | experimental bridge | `shapecode_N_image=pm_depth_map.png` |
| `pm_depth` shader sampler | libprojectM (`ExperimentalDepthSampler`), gated on the header below | `tex2D(pm_depth, uv)` in warp/composite |
| VFS `/textures/` scan + download | `projectM_emscripten.cpp` `scanTextures()` | `shapecode_N_image=foo.png`, `textured=1` |
| `create_sprite(type, code)` / `projectm_sprite_*_wrapper` / `ProjectMContext.createSprite()` | WASM exports, embed SDK | User sprites from caller code (`img=pm_depth_map` for the depth overlay) |
| Header metadata (`// tags:`, `// tier:`) | `docs/PRESET_METADATA.md` | Demo UX only — not renderer |
| `// pm:experimental …` | experimental bridge | Host orchestration only |

---

## Prototype bridge (`?experimental=1`)

`html/projectm-experimental-bridge.js` is imported by `projectm-core.html` but **activates
only** when the URL contains `experimental=1`.

### Enable

```
html/projectm-core.html?experimental=1&localPresets=1&devPreset=1
```

Optional: `&depthModule=https://…/custom-depth.3ijs` to override the module URL.

### API (`setupExperimentalBridge(...).api`, or `window.pmExperimental` on pages that opt in)

The bridge returns this object and publishes nothing on `window` itself; a page that wants it
in the console calls `exposeExperimentalGlobals()` from `html/projectm-legacy-globals.js`
(`projectm-core.html` does).

| Method | Purpose |
|--------|---------|
| `loadDepthModule()` | Fetch + eval legacy UTF-32 depth module |
| `runDepthFromUpload(dataUrl)` | Post **input** image into `imageChannel` |
| `captureCanvasForDepth(canvas)` | Snapshot `#mcanvas` → depth **input** pipeline |
| `bindDepthResult(src?)` | Write `#resultImage` (or src) to `/textures/pm_depth_map.png` |
| `applyDepthTexture(src)` | Same as bind with optional preset reload options |
| `injectVfsTexture(module, path, bytes)` | Generic VFS texture injection |
| `requestGltfLoad(title)` | Post to `loaderChannel` (legacy glTF loader) |
| `parseExperimentalMetadata(milkText)` | Parse `// pm:experimental` header |
| `wantsExperimentalDepth(meta)` | True if depth=auto / depth-texture / depth=true |
| `buildDepthSpriteCode(opts)` | Milkdrop user-sprite code for the depth overlay |
| `spawnDepthSprite(opts?)` | Create that sprite with `create_sprite()`; returns its id, 0 on a bundle without the sprite exports |
| `spawnDepthSpriteHint()` | Log the sprite code to console |

### Events

| Event | When |
|-------|------|
| `pm:preset-loaded` | From `updatePresetDisplay()` — `{ name, path, text? }` |
| `pm:preset-text` | When milk source text is available — `{ text, path }` |
| `pm:depth-texture-ready` | After depth map written to VFS; `detail.delivery` is `'in-place'`, `'preset-reload'` or `'written'` |
| `pm:gltf-save-requested` | User clicked experimental glTF save |

### Tests

```bash
node --test tests/web/experimental-bridge.test.mjs
```

Covers metadata parsing, depth intent detection, and sprite template generation (no browser/WASM).

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
| `depth=auto` | On preset load, run depth pipeline if a source image is pending. Also declares `pm_depth` (bound to `pm_depth_map`) |
| `depth-texture=pm_depth_map` | VFS basename (bridge writes `.png`); declares `pm_depth` bound to this texture |
| `depth-source=upload` | Require user upload before auto-run |
| `gltf-export=on-lock` | Future: export glTF when preset locked (coordinator only) |
| `gltf-export=true` | Flag for manual export via experimental panel |

**Compatibility:** Presets without this header behave exactly as before. If
`pm_depth_map.png` is missing, projectM falls back to the main feedback texture for
textured shapes (see `CustomShape.cpp`).

### The `pm_depth` shader sampler

A preset whose header asks for a depth texture can sample it in its warp or composite
shader (PSVERSION 2 or 3) without declaring anything:

```milk
// pm:experimental depth-texture=pm_depth_map
...
comp_1=`shader_body
comp_2=`{
comp_3=`    float depth = tex2D(pm_depth, uv).x;
comp_4=`    ret = tex2D(sampler_main, uv).xyz * (0.5 + 0.5 * depth);
comp_5=`}
```

- libprojectM reads the `// pm:experimental` line (`PresetFileParser::ExperimentalDirectives()`)
  and, only then, rewrites the identifier `pm_depth` to `sampler_fc_pm_depth_map` (bilinear,
  clamped) and `texsize_pm_depth` to `texsize_pm_depth_map` before the shader is analyzed. From
  there it is an ordinary Milkdrop user texture: declared, loaded from the texture paths,
  bound. `depth=auto` / `depth=true` without `depth-texture=` binds `pm_depth_map`.
- A preset without the header gets no sampler: `pm_depth` is an undeclared identifier there
  and the shader fails to compile, like any other typo. Stock `.milk` files are untouched.
- Until a depth map exists the bridge's 1x1 black seed is sampled (depth 0 everywhere).
  Without the bridge (no `?experimental=1`) the texture is the engine's black placeholder.
- `presets/experimental/depth_sampler_demo.milk` uses it in both shaders.

When the bridge writes a new map it calls `reload_texture('pm_depth_map')`
(`projectm_reload_texture()` in `projectM-4/texture_reload.h`), which re-decodes the file into
the texture already bound, at its new size, so the running preset needs no reload.

---

## Integration ideas — effort tiers

### Low-hanging fruit (prototyped)

| Idea | How | Status |
|------|-----|--------|
| Depth → displacement texture | Bridge writes `/textures/pm_depth_map.png`; preset uses `shapecode_*_image` | **Done** |
| Warp/composite `pm_depth` sampler | `// pm:experimental depth-texture=…` declares it; `tex2D(pm_depth, uv)` | **Done** |
| Live depth refresh | `reload_texture()` updates the bound texture in place; no preset reload | **Done** |
| Parameterized sprites | `create_sprite(type, code)`, `projectm_sprite_*_wrapper`, `ProjectMContext.createSprite()` | **Done** |
| Canvas → depth → preset | “Depth from canvas” captures live viz as **input**, binds **result** | **Done** |
| Preset metadata drives depth | `// pm:experimental depth=auto` on load | **Done** |
| Input vs result channel split | Inputs: `role=depth-input`; results: `#resultImage` / `role=depth-result` | **Done** |
| glTF export coordinator flag | `gltf-export=true` sets host mode only | **Done** |
| User-sprite parallax overlay | `buildDepthSpriteCode()` + `spawnDepthSprite()` (panel: **Depth sprite**) | **Done** |
| Hidden `#resultImage` on core | Bridge creates if missing | **Done** |
| Milk text on preset load | `updatePresetDisplay({ text })` + `pm:preset-text` | **Done** |

### Medium effort (recommended next)

| Idea | Notes |
|------|-------|
| Beat-synced depth refresh | Re-capture canvas on `bass_att` threshold; throttle to ≤2 Hz (host timer); each result now lands in place |
| Lazy-load shared depth wrapper | Dedupe `getDepth()` from `.1ink` hosts into the bridge only |
| Featured pack tag `experimental` | Filter in `projectm-preset-library.js` when ready for demos |

### High effort / research (do not block core)

| Idea | Notes | Verdict |
|------|-------|---------|
| Full glTF scene export of preset state | Serialize FBO floats, mesh UVs, shader graphs | **Defer** — not Milkdrop format |
| Real-time 3D layering (Three.js + projectM FBO) | Dual WebGL contexts / shared textures | **Defer** — limited browser support |
| Transformers.js in preset equations | Equations run in projectM-eval, not JS | **Infeasible** without new runtime |
| Depth-driven mesh tessellation | C++ hook in `PerPixelMesh` | **Upstream-sized** — not fork-only |
| COOP/COEP + Transformers WASM threads | Already required for projectM pthreads; depth model adds ~50–100 MB | Ops concern only |

---

## Sample presets

| File | Purpose |
|------|---------|
| `presets/experimental/depth_overlay_demo.milk` | Textured shape overlay on `pm_depth_map.png` |
| `presets/experimental/depth_sampler_demo.milk` | Depth-weighted parallax in the warp shader and a depth tint in the composite, through `pm_depth` |
| `presets/experimental/gltf_export_flag_demo.milk` | Sets `gltf-export=true` coordinator flag only |

Load:

```
?experimental=1&localPresets=1&devPreset=1
```

Then load a sample via the local preset picker / dev panel, upload an image or capture
canvas, wait for depth result (or click **Bind result**).

---

## Separation checklist (for PRs)

- [x] No changes to default `PresetCompat` paths for `presets/experimental/`
- [x] `projectm-experimental-bridge.js` gated behind `?experimental=1`
- [x] No new hard dependencies in `projectm-init.js` / WASM link line
- [x] `// pm:experimental` fields documented here, not in core `PRESET_METADATA.md` table
- [x] `projectm.1ink` / `projectm_new.1ink` are now redirect stubs to
  `projectm-core.html?experimental=1` (see html/README.md ".1ink Deprecation
  Path"); their prior inline depth/glTF flow is preserved in git history
- [x] Unit tests do not require network, OpenGL, or the remote depth module

---

## Findings & recommendations

1. **Best integration point is the texture VFS**, not equation language or C++ mesh code.
   Depth maps become ordinary `shapecode_*_image` (or future user-sprite) assets.
2. **Keep Transformers.js and Three.js off the critical path.** They stay lazy, remote,
   and optional. Core WASM boot must never wait on them.
3. **Metadata is the right control plane.** Host-side `// pm:experimental` directives
   orchestrate depth/glTF without parser changes.
4. **glTF export of Milkdrop state is not a product goal.** Export the parallel Three.js
   scene only; treat Milkdrop FBOs as 2D texture sources if compositing is needed later.
5. **Done:** parameterized sprite create (`create_sprite(type, code)`, `projectm_sprite_*_wrapper`,
   `ProjectMContext.createSprite()`) and the `pm_depth` warp/composite sampler, gated on the
   `// pm:experimental` header, with in-place depth refreshes.

---

## Related files

- `html/projectm-experimental-bridge.js` — prototype bridge
- `html/projectm-presets.js` — `pm:preset-loaded` / optional milk `text`
- `html/projectm.1ink` — legacy depth / glTF UI + `getDepth()`
- `html/README.md` — host architecture (extended features = lazy modules)
- `presets/experimental/` — sample presets (not in default compat)
- `tests/web/experimental-bridge.test.mjs` — pure helper tests
- `tests/web/projectm-user-sprites.test.mjs` — sprite exports vs. manifest and transports, in-place depth binding
- `tests/libprojectM/ExperimentalDepthSamplerTest.cpp` — header parsing, `pm_depth` rewrite, GPU reload
- `tests/libprojectM/UserSpriteApiTest.cpp` — sprite create / set_var / get_var / destroy (GPU)
- `docs/PRESET_METADATA.md` — standard metadata (orthogonal)
- `docs/PRESET_ROADMAP.md` — milestone M3 / issue #118
