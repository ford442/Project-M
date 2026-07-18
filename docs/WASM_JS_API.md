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
    init,
    startRender,
    renderFrame,
    loadPresetFile,
    feedPcmFloat,
    setPresetLocked,
} from './generated/projectm-wasm-api.js';

const code = init(Module);
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

| JS helper | C symbol | Notes |
|-----------|----------|-------|
| `init` | `init` | Returns `0` on success; see [EMSCRIPTEN.md#init-error-codes](EMSCRIPTEN.md#init-error-codes) |
| `startRender` | `start_render` | After successful `init` |
| `renderFrame` | `render_frame` | One frame per `requestAnimationFrame` (or worker loop) |
| `setWindowSize` | `set_window_size` | Resize viewport |
| `setAspectCorrection` | `set_aspect_correction` | Bezel / aspect correction |
| `loadPresetFile` | `load_preset_file` | VFS path (`ccall` binding) |
| `addPresetFile` | `add_preset_file` | Add to playlist |
| `switchPreset` | `switch_preset` | Next playlist item |
| `setPresetLocked` | `set_preset_locked` | `boolean` coerced to 0/1 |
| `setTransparencyMode` | `set_transparency_mode` | Glass-layer compositing; near-black → alpha 0 |
| `setTransparencyThreshold` | `set_transparency_threshold` | RGB threshold (default `0.01`) |
| `feedPcmFloat` | (helper) | Wraps `projectm_pcm_add_float_wrapper` |
| `setTargetFps` | `set_target_fps` | |
| `setQualityGovernor` | `set_quality_governor` | |
| `getQualityTier` | `get_quality_tier` | |
| `setMesh` | `set_mesh` | Per-pixel grid |
| `pmHandleContextLoss` | `pm_handle_context_loss` | WebGL context loss |
| `dualFboBeginTransition` | `dual_fbo_begin_transition` | |
| `dualFboIsPresetBAllocated` | `dual_fbo_is_preset_b_allocated` | |
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

## Render worker bridge

[`html/projectm-wasm-api-worker.ts`](../html/projectm-wasm-api-worker.ts) re-exports `WASM_API_SYMBOLS` (camelCase key → C symbol string) for the OffscreenCanvas worker `ccall` proxy. The worker script itself (`projectm-render-worker.js`) cannot import ES modules; it mirrors `feedPcmFloat` inline.

## Raw `Module._foo` / `ccall`

Legacy hosts (`.1ink` shells, inline `<script type="module">` in `projectm-core.html`) may still call `Module._start_render` or `Module.ccall` directly during migration. New code should import the generated helpers.

## Future: embind `ProjectMHost` (Option A / C)

`-l embind` is already linked on the wrapper TU. A future phase may expose a small `ProjectMHost` class (handle, PCM, presets, transitions) while keeping these flat exports for backward compatibility.

## Related

- [EMSCRIPTEN.md](EMSCRIPTEN.md) — build flags, init errors, context loss
- [DEPLOYMENT.md](DEPLOYMENT.md) — `html/generated/*.js` is included in deploy bundles
