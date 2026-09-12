# WASM JavaScript API

Typed helpers for calling the projectM Emscripten wrapper (`projectM_emscripten.cpp`) from browser hosts. This document describes the **codegen surface** (Option B); a future embind `ProjectMHost` class may wrap these for third-party npm packaging.

## Single source of truth

| Artifact | Role |
|----------|------|
| [`cmake/EmscriptenWasmFlags.cmake`](../cmake/EmscriptenWasmFlags.cmake) | `EXPORTED_FUNCTIONS` list for the WASM link |
| [`cmake/WasmApiManifest.cmake`](../cmake/WasmApiManifest.cmake) | Per-symbol signatures, bindings, visibility |
| [`html/generated/projectm-wasm-api.ts`](../html/generated/projectm-wasm-api.ts) | TypeScript types + wrappers (committed) |
| [`html/generated/projectm-wasm-api.js`](../html/generated/projectm-wasm-api.js) | Browser runtime ES module (committed) |

Regenerate all derived artifacts after editing the manifest or export list:

```bash
scripts/sync_wasm_link_common.sh
```

CI verifies sync via `scripts/verify_wasm_link_common.sh` and type-checks with `scripts/check_html_types.sh`.

## Usage in host code

Import from the generated runtime module (`.js` extension required for browser ES modules):

```javascript
import {
    initWithCanvases,
    startRender,
    renderFrame,
    loadPresetFile,
    feedPcmFloat,
    setPresetLocked,
} from './generated/projectm-wasm-api.js';

// Prefer initWithCanvases when not using page-global #mcanvas / #scanvas.
const code = initWithCanvases(Module, '#my-main-canvas', '#my-secondary-canvas');
if (code !== 0) { /* handle init error */ }

startRender(Module, canvas.width, canvas.height);
loadPresetFile(Module, '/presets/foo.milk');

// Each animation frame:
renderFrame(Module);

// PCM (prefer feedPcmFloat over manual HEAPF32/_malloc):
feedPcmFloat(Module, interleavedFloat32, samplesPerChannel, 2);
```

`ProjectMModule` in the `.ts` file documents the Emscripten `Module` shape (`ccall`, `_malloc`, `HEAPF32`, exported `_foo` symbols).

## Visibility tiers

Symbols in [`cmake/WasmApiManifest.cmake`](../cmake/WasmApiManifest.cmake) are tagged:

### Public (stable embed API)

Intended for third-party embedders. Breaking changes require a major WASM bundle version bump.

The tier is **enforced**, not advisory. `scripts/check_wasm_public_api.sh` extracts
every `public` entry as `name(args) -> returns [binding]` and diffs it against
`packages/web/wasm-public-api.baseline`; the Web Host Tests workflow runs it as
`npm run check:api`. Adding a symbol is free. Removing one, or changing its
return type, argument list, or `ccall`/`direct` binding, fails CI unless
`packages/web/package.json` carries a bump (major at >= 1.0.0, minor pre-1.0).
Re-bless the surface with `scripts/check_wasm_public_api.sh --update`. Editing a
symbol's doc text is not an API change and needs nothing.

| JS helper | C symbol | Notes |
|-----------|----------|-------|
| `init` | `init` | Returns `0` on success; see [EMSCRIPTEN.md#init-error-codes](EMSCRIPTEN.md#init-error-codes) |
| `setCanvasSelectors` | `set_canvas_selectors` | CSS selectors for primary/secondary canvases (default `#mcanvas`/`#scanvas`) |
| `initWithCanvases` | `init_with_canvases` | Set selectors then `init` |
| `rebindCanvases` | `rebind_canvases` | Tear down + re-init on new selectors (single-instance) |
| `startRender` | `start_render` | After successful `init` |
| `renderFrame` | `render_frame` | One frame per `requestAnimationFrame` (or worker loop) |
| `setWindowSize` | `set_window_size` | Resize viewport |
| `setAspectCorrection` | `set_aspect_correction` | Bezel / aspect correction |
| `loadPresetFile` | `load_preset_file` | VFS path (`ccall` binding) |
| `addPresetFile` | `add_preset_file` | Add to playlist |
| `switchPreset` | `switch_preset` | Next playlist item |
| `setPresetLocked` | `set_preset_locked` | `boolean` coerced to 0/1 |
| `setTransparencyMode` | `set_transparency_mode` | Glass-layer compositing; near-black → alpha 0 |
| `getTransparencyMode` | `get_transparency_mode` | |
| `setTransparencyThreshold` | `set_transparency_threshold` | RGB threshold (default `0.01`) |
| `getTransparencyThreshold` | `get_transparency_threshold` | |
| `feedPcmFloat` | (helper) | Wraps `projectm_pcm_add_float_wrapper` |
| `setTargetFps` | `set_target_fps` | |
| `setQualityGovernor` | `set_quality_governor` | |
| `getQualityTier` | `get_quality_tier` | 0=high, 1=regular, 2=low (governor v2, see [PERFORMANCE.md](PERFORMANCE.md#adaptive-quality-governor-wasm-v2)) |
| `getGovernorRenderScale` | `get_governor_render_scale` | Current tier's internal render-scale factor (1.0/0.75/0.5) |
| `getGovernorBlurCap` | `get_governor_blur_cap` | Current tier's blur-level cap (-1 = unlimited, else 0-3) |
| `setMesh` | `set_mesh` | Per-pixel grid |
| `pmHandleContextLoss` | `pm_handle_context_loss` | WebGL context loss |
| `dualFboBeginTransition` | `dual_fbo_begin_transition` | Allocates both FBO pairs on demand; `false` means "retry next frame", not "hard cut" |
| `dualFboIsPresetAAllocated` | `dual_fbo_is_preset_a_allocated` | False at startup and after the idle release; check with the B query before `transitionStart` |
| `dualFboIsPresetBAllocated` | `dual_fbo_is_preset_b_allocated` | |
| `dualFboSetIdleReleaseSeconds` | `dual_fbo_set_idle_release_seconds` | Idle seconds before the preset-A pair is reclaimed (0 = immediate, &lt;0 = never). Default 5 |
| `dualFboGetIdleReleaseSeconds` | `dual_fbo_get_idle_release_seconds` | |
| `dualFboIsPresetBReady` | `dual_fbo_is_preset_b_ready` | |
| `dualFboGetFormat` | `dual_fbo_get_format` | 0=RGBA32F, 1=RGBA16F, 2=RGBA8 |
| `transitionStart` | `transition_start` | |
| `transitionCancel` | `transition_cancel` | |
| `transitionIsActive` | `transition_is_active` | |
| `transitionGetBlend` | `transition_get_blend` | |
| `transitionSetDuration` | `transition_set_duration` | |
| `transitionGetDuration` | `transition_get_duration` | |

Export names are also listed in `PUBLIC_WASM_API` inside the generated module.

### Internal (first-party host only)

Used by projectM.1ink.us hosts, benchmarks, and smoke tests. **Not** a semver-stable contract for external embedders.

Examples: `setPerfHud`, `getOmpEnabled`, `dual_fbo_get_*` GL handles, `add_custom_milk_paths`, legacy `add_audio_data`, `create_sprite`.

### Runtime (Emscripten heap)

`malloc` / `free` — exported for linking but not wrapped in the public API table. Hosts should use `feedPcmFloat` instead of manual `_malloc` for PCM.

## Governor v2 host callbacks (push) vs. getters (pull)

`WasmPerfGovernor.cpp` fires two `window.pmOn*` callbacks on every tier change, in
addition to the pre-existing `window.pmOnGovernorTierChange(tier)`:

| Callback | Fired with | Purpose |
|----------|-----------|---------|
| `window.pmOnGovernorTierChange(tier)` | `number` (0/1/2) | Pre-existing; UI "reduced quality" indicator |
| `window.pmOnGovernorRenderScaleChange(scale)` | `number` (1.0/0.75/0.5) | **Must be handled for the render-scale tier to have any effect** — see below |
| `window.pmOnGovernorBlurCapChange(cap)` | `number` (-1/1/2) | Informational/telemetry only; the blur cap is applied purely in C++ |

`html/projectm-fps-governor.js`'s `setupFpsGovernor(Module, { onRenderScaleChange })`
wires all three plus `window.pmGetGovernorRenderScale()` / `window.pmGetGovernorBlurCap()`
pull-getters (for hosts that bind late). **The mesh and blur-cap tiers are applied
entirely inside the WASM module** (`projectm_set_mesh_size` / `projectm_set_max_blur_level`
in `ApplyQualityTier()`) — no host action needed for those two. The render-scale tier is
different: it requires the **host** to shrink the `<canvas>` backing store
(`canvas.width`/`canvas.height`) while leaving its CSS box size
(`canvas.style.width`/`height`) unchanged, so the browser's own bitmap-to-CSS-box
scaling does the "present upscale". `html/projectm-context.js`'s `syncCanvasSize()` /
`ProjectMContext` and `html/projectm-core.html`'s `syncModuleSize()` (via `pmContext`)
already do this; a host that bypasses both and drives `set_window_size` directly must
implement `onRenderScaleChange` itself or the render-scale tier will silently no-op
(mesh and blur still step down, so FPS still recovers, just less than governor v2
expects on fill-bound devices).

Query params / localStorage, mirroring the existing `?targetFps=`/`?governor=` pattern:

| Knob | Values | Effect |
|------|--------|--------|
| `?aa=1` / `?aa=0`, `localStorage.canvasAA` | `'1'`/`'0'` | Canvas MSAA opt-in (default off, see [EMSCRIPTEN.md](EMSCRIPTEN.md)) |

## Render worker bridge

[`html/projectm-wasm-api-worker.ts`](../html/projectm-wasm-api-worker.ts) re-exports `WASM_API_SYMBOLS` (camelCase key → C symbol string) for the OffscreenCanvas worker `ccall` proxy. The worker script itself (`projectm-render-worker.js`) cannot import ES modules; it mirrors `feedPcmFloat` inline.

Governor v2 render-scale **is** wired in the render-worker topology:
`WasmPerfGovernor.cpp` pushes tier changes through `globalThis`, which inside a
worker is the worker scope, and `projectm-render-worker.js` installs
`pmOnGovernorRenderScaleChange` there and resizes the `OffscreenCanvas` backing
store it owns. The host keeps the CSS box at full size, exactly as on the main
thread, so the present upscale looks the same either way — and the effective
scale comes back to the host on the `stats` message.

Hosts should not reach for the worker handle directly: `RenderTransport`
(`html/projectm-render-transport.js`, typed in
`html/projectm-transport-types.ts`) issues the same call over either topology,
marshaling it from the generated `WASM_API_SIGNATURES` table so the ccall
argument types cannot drift from the main-thread wrappers. What is still
main-thread-only is the set of dev panels that read engine state through a
module object on the page (perf HUD, preset dev tools, experimental bridge,
FBO-format banner).

## Raw `Module._foo` / `ccall`

Legacy hosts (`.1ink` shells, inline `<script type="module">` in `projectm-core.html`) may still call `Module._start_render` or `Module.ccall` directly during migration. New code should import the generated helpers.

## Future: embind `ProjectMHost` (Option A / C)

`-l embind` is already linked on the wrapper TU. A future phase may expose a small `ProjectMHost` class (handle, PCM, presets, transitions) while keeping these flat exports for backward compatibility.

## Related

- [EMSCRIPTEN.md](EMSCRIPTEN.md) — build flags, init errors, context loss
- [DEPLOYMENT.md](DEPLOYMENT.md) — `html/generated/*.js` is included in deploy bundles
