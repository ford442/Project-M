# WASM JavaScript API

Typed helpers for calling the projectM Emscripten wrapper (`projectM_emscripten.cpp`) from browser hosts. This document describes the **codegen surface** (Option B); a future embind `ProjectMHost` class may wrap these for third-party npm packaging.

## Single source of truth

| Artifact | Role |
|----------|------|
| [`cmake/WasmApiManifest.cmake`](../cmake/WasmApiManifest.cmake) | The only list of exports: per-symbol scope, signature, binding, visibility |
| [`cmake/EmscriptenWasmFlags.cmake`](../cmake/EmscriptenWasmFlags.cmake) | Link flags; derives `EXPORTED_FUNCTIONS` from the manifest |
| [`src/wasm/generated/WasmApiExports.cpp`](../src/wasm/generated/WasmApiExports.cpp) | Every `extern "C"` export: the `pm_` barriers and the compat shims (committed) |
| [`src/wasm/generated/WasmApiImpl.hpp`](../src/wasm/generated/WasmApiImpl.hpp) | The `WasmApi::` implementations' declarations (committed) |
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
| `dualFboGetFormat` | `dual_fbo_get_format` | 0=RGBA16F, 1=RGBA32F, 2=RGBA8 (same numbering as `create_host_with_config`'s `fboPrecision`) |
| `getContextSnapshot` | `get_context_snapshot` | What the host negotiated with WebGL, packed: bit 0 has a context, 1 `EXT_color_buffer_float`, 2 `EXT_float_blend`, 3 `WEBGL_lose_context`, bits 8-9 the dual-FBO format. 0 before init. Prefer `ProjectMContext.contextSnapshot`, which decodes it. See [EMSCRIPTEN.md](EMSCRIPTEN.md#reading-what-was-negotiated) |
| `transitionStart` | `transition_start` | |
| `transitionCancel` | `transition_cancel` | |
| `transitionIsActive` | `transition_is_active` | |
| `transitionGetBlend` | `transition_get_blend` | |
| `transitionSetDuration` | `transition_set_duration` | |
| `transitionGetDuration` | `transition_get_duration` | |
| `transitionSetDurationBeats` | `transition_set_duration_beats` | Crossfade length in beats, resolved against the tempo when each crossfade starts; seconds apply while the tempo is unknown. 0 = seconds only. Also sets the engine's own soft cuts |
| `transitionGetDurationBeats` | `transition_get_duration_beats` | |
| `getRhythmBpm` | `get_rhythm_bpm` | Tempo, 0 while the tracker is not confident. See [AUDIO_PIPELINE.md](AUDIO_PIPELINE.md#rhythm-analysis) |
| `getRhythmBeatPhase` | `get_rhythm_beat_phase` | 0..1, 0 = the predicted beat |
| `getRhythmBarPhase` | `get_rhythm_bar_phase` | 0..1 over four beats, 0 = downbeat |
| `getRhythmConfidence` | `get_rhythm_confidence` | 0..1 (1 while a hint is set) |
| `getRhythmBeatIndex` | `get_rhythm_beat_index` | Beats since the engine started |
| `getRhythmSection` | `get_rhythm_section` | Section index |
| `setRhythmHint` | `set_rhythm_hint` | A known tempo (MIDI clock, track BPM) instead of the estimate; 0 clears |
| `setPresetSwitchPolicy` | `set_preset_switch_policy` | 0 timer, 1 every `bars` bars, 2 on a section change (at most every `bars` bars). Falls back to the timer while the tempo is unknown |
| `getPresetSwitchPolicy` | `get_preset_switch_policy` | |
| `setHardCutOnBeat` | `set_hard_cut_on_beat` | Beat-detection hard cuts wait for the next beat |
| `setRhythmEvents` | `set_rhythm_events` | Report beats/bars/sections to `globalThis.pmOnRhythmEvent` (see below). Off by default |
| `setFlashLimitEnabled` | `set_flash_limit_enabled` | Temporal flash limiter, off by default. See [FLASH_LIMITER.md](FLASH_LIMITER.md) |
| `getFlashLimitEnabled` | `get_flash_limit_enabled` | |
| `setFlashLimitThreshold` | `set_flash_limit_threshold` | Luminance span the presented frames may cover within ~⅓ s (default 0.06) |
| `getFlashLimitThreshold` | `get_flash_limit_threshold` | |
| `getFlashLimitClampedFrames` | `get_flash_limit_clamped_frames` | Frames clamped since enabled. Reads back from the GPU: poll a few times a second at most |
| `getCommittedFrameCount` | `get_committed_frame_count` | `emscripten_webgl_commit_frame()` calls on this host (manual present only) |
| `captureFrameRequest` | `capture_frame_request` | Read back the next presented frame; prefer `ProjectMContext.captureFrame()` |
| `captureFrameStatus` | `capture_frame_status` | 0 idle, 1 requested, 2 pending, 3 ready, 4 failed; never waits |
| `captureFrameResolve` | `capture_frame_resolve` | `wait` takes a pending (manual-present) capture at once |
| `captureFrameDataPtr` | `capture_frame_data_ptr` | RGBA8, top row first, in `HEAPU8` |
| `captureFrameWidth` / `captureFrameHeight` | `capture_frame_width` / `capture_frame_height` | |
| `captureFrameIndex` | `capture_frame_index` | `get_rendered_frame_count()` right after the captured frame |
| `captureFrameRelease` | `capture_frame_release` | |
| `textureSlotRegister` | `texture_slot_register` | Create or resize a live texture presets sample as `sampler_<name>`; prefer `ProjectMContext.registerTexture()`. See [LIVE_INPUT.md](LIVE_INPUT.md) |
| `textureSlotBuffer` / `textureSlotCommit` | `texture_slot_buffer` / `texture_slot_commit` | Where to write the next RGBA8 frame in `HEAPU8` (0 unless `bytes` is the slot's size), then mark it complete for the next `render_frame()`; prefer `ProjectMContext.updateTexture()` |
| `textureSlotUnregister` | `texture_slot_unregister` | |
| `evalSet` / `evalClear` | `eval_set` / `eval_clear` | Host value for a per-frame variable (q1..q32, zoom, decay, ...) on every preset until cleared (`''` clears all); prefer `ProjectMContext.setEvalVar()` / `clearEvalVar()` |
| `createSprite` | `create_sprite` | User sprite on the active host from `(type, code)`; returns its id, 0 if refused. See "User sprites" below |
| `getProjectmHandle` | `get_projectm_handle` | The active host's engine handle (its host handle; 0 without an engine): the `pmHandle` the `projectm_sprite_*_wrapper` and PCM exports take |
| `projectmSpriteCreateWrapper` | `projectm_sprite_create_wrapper` | `projectM-4/user_sprites.h` behind a validated `pmHandle`: a stale or unknown handle is a no-op returning 0. (Before 0.3.0 the raw `projectm_sprite_*` exports took the engine's address, so a handle kept past `destroy_host()` could drive whichever engine reused that memory.) |
| `projectmSpriteDestroyWrapper` / `projectmSpriteDestroyAllWrapper` | `projectm_sprite_destroy_wrapper` / `_destroy_all` | |
| `projectmSpriteGetSpriteCountWrapper` / `projectmSpriteGetSpriteIdsWrapper` | `projectm_sprite_get_sprite_count_wrapper` / `_get_sprite_ids` | `spriteIds` is a heap pointer to `count` uint32s |
| `projectmSpriteGetMaxSpritesWrapper` / `projectmSpriteSetMaxSpritesWrapper` | `projectm_sprite_get_max_sprites_wrapper` / `_set_max_sprites` | Default 16; at the limit the oldest sprite makes room |
| `projectmSpriteGetVarWrapper` / `projectmSpriteSetVarWrapper` | `projectm_sprite_get_var_wrapper` / `_set_var` | A sprite expression variable; 0 for an unknown sprite or name |

Export names are also listed in `PUBLIC_WASM_API` inside the generated module.

### User sprites

A user sprite is an image drawn over every preset, positioned and colored by its own
expression code (upstream's `projectM-4/user_sprites.h`). The code is Milkdrop sprite
code, one `key=value` per line: `img=` a texture base name from the texture paths
(`/textures/` in the VFS, no extension), `init_N=` run once, `code_N=` run every frame.
Variables: `x`, `y`, `sx`, `sy`, `rot`, `flipx`, `flipy`, `repeatx`, `repeaty`,
`blendmode` (0..4), `r`, `g`, `b`, `a`, `burn`, `done`, and read-only `time`, `frame`,
`fps`, `progress`, `bass`/`mid`/`treb` and their `_att` forms.

```javascript
const id = await context.createSprite('img=pm_depth_map\ninit_1=sx=0.5; sy=0.5;\ncode_1=x=px; y=0.5;');
await context.setSpriteVar(id, 'px', 0.25); // code_1 reads it on the next frame
await context.getSpriteVar(id, 'x');        // 0.25 after that frame
await context.destroySprite(id);
```

`ProjectMContext.createSprite()` / `destroySprite()` / `getSpriteVar()` / `setSpriteVar()`
work in both render topologies (in the worker one each is a `ccall` round trip) and reject
on a bundle without the exports. A sprite's per-frame code runs after `setSpriteVar()`, so a
variable the code assigns every frame is overwritten: drive the sprite through a variable
of your own that the code reads, as above.

`create_sprite(type, code)` replaced a zero-argument export of the same name that ignored
its caller and drew a fixed demo sprite. A host calling `create_sprite` on a bundle that
may be older should check for `_projectm_sprite_create_wrapper` first; only that name tells the two
apart.

### Rhythm events (`pmOnRhythmEvent`)

While `set_rhythm_events(1)` is on, `render_frame()` calls
`globalThis.pmOnRhythmEvent(event)` on every frame that carries a beat, a downbeat or a
section change, and on no other frame (about two calls a second at 120 BPM). `event` is
`{ host, beat, bar, section, bpm, beatIndex, barPhase, sectionIndex, confidence }`
(`RhythmEvent` in `html/projectm-render-worker-types.ts`); `host` is the engine's host
handle, for telling apart the engines of a shared Module — `0` for the default host since
bundle 040 (earlier bundles sent its address, like any other host). A crossfade renders the engine
twice per frame; the events of both renders are reported once.

Hosts should not install the global themselves: `ProjectMContext.on('beat' | 'bar' |
'section', listener)` turns the engine reporting on while it has listeners, filters by
host, and works in both topologies (the render worker relays each event as a
`rhythm-event` message, unbatched so a beat is not delivered late).

### Internal (first-party host only)

Used by projectM.1ink.us hosts, benchmarks, and smoke tests. **Not** a semver-stable contract for external embedders.

Examples: `setPerfHud`, `getOmpEnabled`, `dual_fbo_get_*` GL handles, `add_custom_milk_paths`, legacy `add_audio_data`, `reload_texture` (the experimental bridge's in-place depth-map update; see [EXPERIMENTAL_PRESET_HOOKS.md](EXPERIMENTAL_PRESET_HOOKS.md#the-pm_depth-shader-sampler)).

### Runtime (Emscripten heap)

`malloc` / `free` — exported for linking but not wrapped in the public API table. Hosts should use `feedPcmFloat` instead of manual `_malloc` for PCM.

## Governor v2 host callbacks (push) vs. getters (pull)

`WasmPerfGovernor.cpp` fires two `window.pmOn*` callbacks on every tier change, in
addition to the pre-existing `window.pmOnGovernorTierChange(tier)`:

| Callback | Fired with | Purpose |
|----------|-----------|---------|
| `window.pmOnGovernorTierChange(host, tier)` | `number` (0/1/2) | Pre-existing; UI "reduced quality" indicator |
| `window.pmOnGovernorRenderScaleChange(host, scale)` | `number` (1.0/0.75/0.5) | **Must be handled for the render-scale tier to have any effect** — see below |
| `window.pmOnGovernorBlurCapChange(host, cap)` | `number` (-1/1/2) | Informational/telemetry only; the blur cap is applied purely in C++ |

`host` (bundle 040+) is the engine whose governor moved: `create_host*()`'s handle, or `0`
for the default host. Bundles up to 039 pass the payload alone. Every page callback follows
this shape — `pmSetPerfHudEnabled(host, enabled)`, `pmOnTranspiledShaderStored(host, key,
kind, glsl)`, `pmReportInitError(host, code, detail)`, `pmHideInitError(host)`, `pmOnPresetSwitchFailed(host, preset, message)`, and `host` on
the `pmOnPerfFrame` stats and `pmOnRhythmEvent` event objects. Listen through
`subscribeWasmCallback(name, listener, globalThis, { engineHost })`
(`html/projectm-wasm-callbacks.js`), which accepts both bundle shapes and hands each listener
an event object with `host` on it; see "Page globals" in `html/README.md`.

With two engines in one Module, every engine call names its engine: see
[ABI v2](#abi-v2-every-export-names-its-host). `bindModuleToHost(module, host)` in the
generated wrappers returns a view on which every export reaches `host`'s engine (and throws if
that host has been destroyed), so a caller that awaits between calls stays on its own engine;
`createModuleTransport(module, { host })` is built on it.

`html/projectm-fps-governor.js`'s `setupFpsGovernor(Module, { onRenderScaleChange })`
listens to all three (through `html/projectm-wasm-callbacks.js`, which owns the global name
and fans out, so several contexts can listen at once) and returns `getRenderScale()` /
`getBlurCap()` pull-getters (for hosts that bind late; `exposeGovernorGlobals()` in
`html/projectm-legacy-globals.js` republishes them as `window.pmGetGovernorRenderScale()` /
`window.pmGetGovernorBlurCap()` for pages that still call those names). **The mesh and blur-cap tiers are applied
entirely inside the WASM module** (`projectm_set_mesh_size` / `projectm_set_max_blur_level`
in `ApplyQualityTier()`) — no host action needed for those two. The render-scale tier is
different: it requires the **host** to shrink the `<canvas>` backing store
(`canvas.width`/`canvas.height`) while leaving its CSS box size
(`canvas.style.width`/`height`) unchanged, so the browser's own bitmap-to-CSS-box
scaling does the "present upscale". `html/projectm-context.js`'s `syncCanvasSize()` /
`ProjectMContext` already do this; a host that bypasses both and drives `set_window_size` directly must
implement `onRenderScaleChange` itself or the render-scale tier will silently no-op
(mesh and blur still step down, so FPS still recovers, just less than governor v2
expects on fill-bound devices).

Query params / localStorage, mirroring the existing `?targetFps=`/`?governor=` pattern:

| Knob | Values | Effect |
|------|--------|--------|
| `?aa=1` / `?aa=0`, `localStorage.canvasAA` | `'1'`/`'0'` | Canvas MSAA opt-in (default off, see [EMSCRIPTEN.md](EMSCRIPTEN.md)) |

## Render worker bridge

The OffscreenCanvas worker's `ccall` proxy takes its symbol names from the signature table in [`html/projectm-render-transport.js`](../html/projectm-render-transport.js) (`createWorkerTransport()`), the same table the main-thread transport validates against, so the two topologies cannot drift. The worker script itself (`projectm-render-worker.js`) cannot import ES modules; it mirrors `feedPcmFloat` inline.

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

## ABI v2: every export names its host

Bundles since #352 export every engine call twice:

- **`pm_<name>(host, ...)`**: the export proper. `host` is the handle `create_host*()` returned,
  or 0 for the implicit default host a legacy `init()` brought up (never "whichever host is
  active"). It resolves the handle, binds that host (its WebGL context current, its shader-cache
  key armed) and runs the implementation. An unknown or destroyed handle returns the export's
  failure value (0, or what the manifest says, e.g. `pm_init` returns -1) and logs once per
  handle; it never reaches another engine.
- **`<name>(...)`**: the compat name, unchanged from earlier bundles, which forwards to
  `pm_<name>` with the host `set_active_host()` selected. The compat names stay for one bundle
  version. `projectm_sprite_*_wrapper(pmHandle, ...)` already took the engine's handle; they
  forward it (0 is a no-op there, as before), and `projectm_pcm_add_float_wrapper(0, ...)` is
  still the active host.

Nothing in the host layer selects a host any more: `bindModuleToHost()` routes a bound view's
`_name(...)` and `ccall('name', ...)` to `pm_name` with the view's host (the `HOST_SYMBOLS`
table), the render worker does the same by convention (a `_pm_<name>` twin), and the PCM ring
helpers read a host's ring through the view. Against a bundle without `pm_host_is_live` all of
them fall back to activating the host first, as before.

**`createHostApi(module, host)`** returns every engine call of one host as methods named after
the implementation (`api.setMesh(48, 32)`, `api.spriteCreate(type, code)`,
`api.getLastError()`), and `ProjectMContext#call` is that object for the context's own host
(null in the worker topology and before `start()`).

**Exceptions never unwind into JavaScript.** Every export is one barrier
(`src/wasm/WasmApiBarrier.hpp`) that catches what the implementation throws, including
`std::bad_alloc` on the fixed heap (the link sets `ABORTING_MALLOC=0`, and a throwing
`new_handler` stops mimalloc from aborting), so one engine's failure never aborts the Module and
the other engines in it. A host-scoped failure is that host's last error:

| `pm_get_last_error(host)` | Meaning |
|---|---|
| 0 | none (`pm_clear_last_error(host)` resets it) |
| 1 | an export threw; `pm_get_last_error_message(host)` has `what()` |
| 2 | out of memory |
| 3 | a buffer commit named a generation that was replaced (below) |

`pm_debug_throw(host, kind)` (internal) throws (1) or exhausts the heap (2) inside an export, for
`tests/wasm-smoke/host_churn.html`.

**Buffers carry a generation.** A live texture's staging buffer is `{ ptr, byteLength,
generation }` (`acquireTextureBuffer()` in `html/projectm-live-texture.js`). The generation
changes whenever the slot reallocates it, `texture_slot_generation()` reads it, and
`texture_slot_commit_generation(name, generation)` refuses a replaced one (-1, last error 3).
A page that awaits between acquiring a buffer and writing it checks the generation before the
write. Frame capture's buffer is identified by `capture_frame_index()`.

**The PCM ring handshake.** A ring the AudioWorklet may have mapped stays parked after its host
releases it, until the processor answers `pcmRingDetach` with `pcmRingDetached`
(`pcm_ring_release_retired()`), so no quantum lands in reallocated heap (see
[EMSCRIPTEN.md, per-instance state](EMSCRIPTEN.md)).

**The manifest** (`cmake/WasmApiManifest.cmake`) is the only place an export is declared. Each
entry is `name|visibility|scope|binding|returns|args|doc`; the scope says how the export finds
its engine:

| Scope | Exports | Implementation |
|---|---|---|
| `host` | `pm_<name>(host, ...)` + compat `<name>(...)` on the active host | `WasmApi::<name>(WasmHost&, ...)` |
| `host-v2` | `pm_<name>(host, ...)` only | same |
| `handle:pm_<impl>` | compat `<name>(handle, ...)` + `pm_<impl>(host, ...)` | `WasmApi::<impl>(WasmHost&, ...)` |
| `handle-or-active:pm_<impl>` | as `handle`, but compat handle 0 is the active host | same |
| `alias:<impl>` | compat `<name>(...)` forwarding to `pm_<impl>` on the active host | (the other entry's) |
| `module` | `<name>(...)`: no engine (registry, render-path switches, audio) | `WasmApi::<name>(...)` |
| `legacy[:impl]` | compat-only, on the active host (`init_with_canvases`, `set_active_host`, ...) | `WasmApi::<impl>(...)` in the compat layer (`WasmLegacyExports.cpp`, `WasmHost.cpp`) |
| `runtime` | Emscripten runtime symbols (`_malloc`, ...) | none |

Types are C types (`void bool i32 u32 f32 f64 usize cstr` and pointers such as `f32*`); a return
may carry its failure value (`i32=-1`). Doc strings may not contain `;` (CMake splits list
entries on it).

## Raw `Module._foo` / `ccall`

Legacy hosts (`.1ink` shells, inline `<script type="module">` in `projectm-core.html`) may still call `Module._start_render` or `Module.ccall` directly during migration. New code should import the generated helpers.

## Future: embind `ProjectMHost` (Option A / C)

Not linked today: the bundle had `-l embind` on the wrapper link but no `EMSCRIPTEN_BINDINGS` at all (its only use was a dead, unexported PCM helper), so it was dropped along with ~10 KB of glue (#260). A future phase may expose a small `ProjectMHost` class (handle, PCM, presets, transitions) while keeping these flat exports for backward compatibility; that phase adds `-l embind` back in `cmake/GenerateWasmLinkCommon.cmake` together with its first binding.

## Related

- [EMSCRIPTEN.md](EMSCRIPTEN.md) — build flags, init errors, context loss
- [DEPLOYMENT.md](DEPLOYMENT.md) — `html/generated/*.js` is included in deploy bundles
