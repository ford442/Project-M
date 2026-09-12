# Using libprojectM in Emscripten

projectM supports OpenGL ES rendering, and can be compiled into WebAssembly for use in browsers. WebGL is similar to
OpenGL ES, but not identical, so a few additional considerations apply to get projectM running with Emscripten.

## Additional Build Settings

A few additional build settings will be required when building an Emscripten wrapper. Pass these flags/parameterrs to
the Emscripten linker:

- `-sUSE_SDL=2`: Recommended if you use Emscripten's built-in SDL2 port to set up the rendering context. This
  flag will link the appropriate library. (Not used by this fork's `projectM_emscripten.cpp` wrapper, which sets up
  its own EGL/WebGL context — see `claude.md`.)
- `-sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2`: Forces the use of WebGL 2, which is required for OpenGL ES 3 emulation.
- `-sFULL_ES3=1`: Enables full emulation support for OpenGL ES 3.0. This fork builds with `-sFULL_ES2=0`
  (ES2 emulation off) — see `claude.md` "WASM Build Flags".
- `-sALLOW_MEMORY_GROWTH=1`: Allows allocating additional memory if necessary. This may be required to load additional
  textures etc. in projectM.

## Dual-Pipeline Preset Transitions (ENABLE_WASM_TRANSITIONS)

Phase 1 of the dual-pipeline preset transition feature introduces dedicated CMake and linker flags for the WASM build
that are prerequisites for smooth preset cross-fading in the browser.

### Required flags (all set automatically under `if(EMSCRIPTEN)` in CMakeLists.txt)

| Flag | Purpose |
|------|---------|
| `-s USE_WEBGL2=1` | Target WebGL 2.0 — required for MRTs and float texture support |
| `-s MIN_WEBGL_VERSION=2 -s MAX_WEBGL_VERSION=2` | Strictly target WebGL 2.0 and avoid fallback to WebGL 1.0 |
| `-s FULL_ES3=1` | Enable full OpenGL ES 3.0 emulation for advanced shader features |
| `-O3` | Maximum optimization — needed to handle dual-preset CPU load |
| `-s ALLOW_MEMORY_GROWTH=1` | Allow WASM heap to grow dynamically — prevents OOM crash when loading a second preset |
| `-s ASYNCIFY=1` | Allow synchronous C++ functions to yield to the JS event loop — prevents browser freeze during shader compilation |
| `-s ASYNCIFY_ONLY=@cmake/wasm_asyncify_only.txt` | Instrument only the `load_preset_file*` yield stack (Option B); keep the 60 Hz render path off Asyncify |

### CMake option: `ENABLE_WASM_TRANSITIONS`

Dual-pipeline transitions are enabled by default for Emscripten builds:

```shell
emcmake cmake -B build-wasm
```

When `ENABLE_WASM_TRANSITIONS=ON`, the following extra flag is applied:

- `-s ASYNCIFY_STACK_SIZE=65536`: Tunes the ASYNCIFY stack size to reduce binary bloat while preserving enough stack
  space for concurrent preset loading and shader compilation.

`ASYNCIFY_ONLY` (see `cmake/wasm_asyncify_only.txt`) is applied whenever `ASYNCIFY=1` is on — independent of
this option — so the render path stays uninstrumented even for hard-cut-only builds.

Set `-DENABLE_WASM_TRANSITIONS=OFF` only when explicitly debugging the legacy hard-cut path or comparing transition
overhead.

## WebGL context attributes

`WasmWebGLContext.cpp::init()` creates the rendering context with Emscripten's html5 WebGL API only — there is
no parallel EGL config path. `ProjectMDefaultWebGLAttributes()` builds the attribute block from a
`WasmContextConfig` the **host sets from JS** via `set_context_config()` (#128 / #84 / #179 A5). The C++ side no
longer scrapes `window.location` / `localStorage` for context attributes — query-string parsing (`?aa=1`,
`?capture=1`, `?fboPrecision=high`) lives in the host JS layer (`projectm-core.html`) and is forwarded through
`ProjectMContextOptions`. Defaults (used when a host calls neither `set_context_config()` nor `ProjectMContext`)
match the historical behavior:

| Attribute | `ProjectMContext` option | Default | Rationale |
|-----------|--------------------------|---------|-----------|
| `majorVersion` / `minorVersion` | — (fixed 2 / 0) | 2 / 0 | WebGL 2 required for GLES 3 emulation |
| `alpha` | (fixed on; the `alpha` option is a separate CSS hint) | `true` | Transparency overlays (`#135`) |
| `depth` | `depth` | `true` | Preset shaders may use depth |
| `stencil` | `stencil` | `true` | Preset shaders may use stencil |
| `antialias` | `antialias` | `false` | Everything hitting the canvas (FBO 0) is a fullscreen quad + optional sprites; a fullscreen quad has no interior edges, so MSAA is invisible on it — only sprite geometry benefits (`docs/GRAPHICS_PERF_RECOVERY_PLAN.md` §5, #178). Host opts in (`projectm-core.html` reads `?aa=1` / `localStorage.canvasAA`). |
| `premultipliedAlpha` | (fixed on) | `true` | Matches browser compositing defaults |
| `preserveDrawingBuffer` | `preserveDrawingBuffer` | `false` | Screenshot/capture hosts set `true` (e.g. `?capture=1` in host JS, or `capture.html` calling `set_context_config`) for a stable back-buffer |
| `enableExtensionsByDefault` | (fixed on) | `true` | Lets projectM probe float/half-float FBO formats |
| `powerPreference` | `powerPreference` | `high-performance` | Prefer discrete GPU; mobile hosts may request `low-power` |
| dual-FBO precision | `fboPrecision` | `half` (RGBA16F) | `high` → RGBA32F, `byte` → RGBA8; consumed by `DualPingPongFramebuffer::DetectFormat()` |

`set_context_config(antialias, preserveDrawingBuffer, depth, stencil, alpha, powerPreference, fboPrecision)` is read
at context creation, so call it **before** `init()` / `init_with_canvases()` / `create_host()`. Attributes are baked
into the WebGL context and cannot change afterward.

Required float texture extensions (`EXT_color_buffer_float`, `EXT_float_blend`, half-float samplers) are enabled
explicitly after the context is made current. Browser presentation does **not** call `eglSwapBuffers()` — frames are
presented when the WebGL canvas is composited by the browser.

### Canvas color space (sRGB)

After the context is current, `ProjectMApplySrgbCanvasColorSpace()` sets
`drawingBufferColorSpace` and `unpackColorSpace` to `"srgb"` when the browser
exposes those WebGL color-management properties. Milkdrop content is authored
in an sRGB / Rec.709-like cube; pinning the tag keeps that look stable on
Display-P3 panels (the compositor maps sRGB → the display) instead of
reinterpreting the same RGB numbers as P3.

This runs for both the main-thread canvas and the OffscreenCanvas render-worker
path (via Emscripten's `GLctx`). Dual-FBO `RGBA16F` intermediates remain a
precision/feedback choice and are **not** Display-P3 or HDR output. Do **not**
set `drawingBufferColorSpace = "display-p3"` without a final sRGB→P3 convert in
the compositor — that would change preset appearance. `ENABLE_HDR_RENDERING` /
`ENABLE_HDR_P3` are separate libprojectM fidelity flags and are off by default.

## Configurable canvas selectors

Historically the WASM host hardcoded `#mcanvas` / `#scanvas`. Those remain the **defaults** for
backward compatibility. Hosts can override the CSS selectors used for WebGL context creation and
`set_window_size()`:

| API | Binding | Behavior |
|-----|---------|----------|
| `Module.primaryCanvasSelector` / `Module.secondaryCanvasSelector` | `createModule({...})` factory config | Read once at `init()` when selectors were not set via C API |
| `set_canvas_selectors(primary, secondary)` | `ccall` | Store selectors for subsequent `init` / resize |
| `init_with_canvases(primary, secondary)` | `ccall` | Set selectors then call `init()` |
| `rebind_canvases(primary, secondary)` | `ccall` | Tear down engine + GL, then `init()` on new selectors (**single-instance rebind**) |

`ProjectMContext` / `<project-m-visualizer>` assign unique canvas element ids (e.g.
`pm-main-canvas-…`) and call `init_with_canvases` — they do **not** require page-global
`#mcanvas` / `#scanvas`.

### Multi-instance story (memory)

Two engines in **one** Module are now supported (#168 Phase B). Per-instance host state
(`AppData`, the dual-FBO manager, transition timeline, quality governor, audio-source flag,
WebGL context, and canvas selectors) lives in a heap-allocated `WasmHost` — see
[Multi-instance host state](#multi-instance-host-state) below. The instance count is capped at
`max_host_count()` (**2** for v1: A/B, compare-two-presets).

| Approach | Supported? | Memory notes |
|----------|:----------:|--------------|
| One Module, one visualizer, configurable selectors | **yes** | One `INITIAL_MEMORY` reservation (default **256mb**, growable to 4gb) |
| One Module, `rebind_canvases()` to switch surfaces | **yes** | Same Module; only one surface active |
| Two visualizers in one document sharing one Module (`create_host()`) | **yes** (cap 2) | One `INITIAL_MEMORY` reservation; two engines + two dual-FBO pairs on the same heap |
| Three+ engines in one Module | **no** | `create_host()` past `max_host_count()` returns 0 with a typed error rather than sharing GL state |
| Two Module instantiations in one document | **avoid** | ≈256 MiB+ each (`INITIAL_MEMORY`); can still OOM low-RAM mobile |
| Multi-embed via **cross-origin-isolated iframes** | **yes** | One Module per iframe; isolate COOP/COEP on the iframe origin |

For A/B in one Module, boot one Module with `bootProjectMSharedModule()` and give each
`ProjectMContext` (or `<project-m-visualizer>`) a `sharedModule` — see
`html/embed-multi-same-module.html`. The cross-origin-isolated **iframe** recipe
(one Module per iframe, see [DEPLOYMENT.md](DEPLOYMENT.md#cross-origin-isolation-coopcoep))
remains the escape hatch for full isolation or more than two engines.

### Multi-instance host state

Every former process-global host variable now lives in a heap `WasmHost`
(`src/wasm/WasmHost.hpp`). `src/wasm/WasmHost.cpp` owns a small registry (the ONE remaining
host-level global: the active-host pointer + a slot array capped at `kMaxHosts`) and exposes
the multi-instance C exports:

| Export | Purpose |
|--------|---------|
| `create_host(primary, secondary)` | Allocate + init an engine on the given canvases; returns an opaque handle (0 at the cap or on init failure) |
| `set_active_host(handle)` | Select which host the no-handle exports operate on and make its WebGL context current (0 = default host) |
| `get_active_host()` | Opaque handle of the active host (0 if none) |
| `destroy_host(handle)` | Tear down and free a host created with `create_host()` |
| `host_count()` / `max_host_count()` | Live instance count / compile-time cap |

Every other export operates on the **active** host. `ProjectMContext` selects it with
`set_active_host()` before each control op (the "close over it" model); the shared Emscripten
main loop renders each started host in turn, making each one current for its frame. Legacy
no-handle callers keep working against a lazily-created compat **default** host (slot 0), so a
single-instance page needs no changes.

**Per-instance vs. still process-global.** Rendering, transitions, the idle-FBO release
(#199), and the quality governor (#178) are per-host. Two things remain process-global in v1
and are documented limitations, not bugs:

- **Audio.** The Web Audio worklet / analyser plumbing (`window.projectMAudioContext_Global_Cpp`,
  one worklet node) is shared. The second engine is visual-only unless the host routes PCM to it
  explicitly via `_projectm_pcm_add_float_wrapper(handle, …)` (the wrapper now honors a non-zero
  engine handle; 0 still means "active host").
- **Transpiled-GLSL shader cache.** `shader_cache_*` install a libprojectM-global hook, so
  concurrent preset loads on both engines would share the cache key. Fine for the A/B case,
  where one preset loads at a time.

## Emscripten flag single source of truth

WASM compile/link flags, `EXPORTED_FUNCTIONS`, and the OpenMP/pthread pool cap are defined in
`cmake/EmscriptenWasmFlags.cmake`. That module drives:

- The `ENABLE_EMSCRIPTEN` block in `CMakeLists.txt` (static lib build)
- The generated `scripts/wasm_link_common.inc.sh` (final `projectM_emscripten.cpp` wrapper link)
- The generated `cmake/generated/ProjectMWasmBuildConfig.hpp` (`kWasmPthreadPoolSize` for OpenMP)

Regenerate derived artifacts after editing the CMake module:

```bash
scripts/sync_wasm_link_common.sh
```

CI runs `scripts/verify_wasm_link_common.sh` to ensure generated files are committed in sync.

Typed JavaScript wrappers are generated into `html/generated/projectm-wasm-api.{ts,js}` from `cmake/WasmApiManifest.cmake`. See [WASM_JS_API.md](WASM_JS_API.md).

## WASM host source layout

The Emscripten host wrapper was historically a single ~3100-line
`projectM_emscripten.cpp`. It is now split into focused translation units, all
living under `src/wasm/` and sharing `ProjectMWasmInternal.hpp` for the common
Emscripten/projectM/GL includes and the small amount of cross-TU state:

| File | Responsibility |
|------|----------------|
| `projectM_emscripten.cpp` | Engine lifecycle: init / rebind / destruct / context-loss, engine setters, `main()` |
| `WasmHost.hpp` / `WasmHost.cpp` | Per-instance `WasmHost` struct (all former host globals), the host registry + active-host pointer, and the `create_host` / `set_active_host` / `destroy_host` multi-instance exports (#168 Phase B) |
| `WasmRenderLoop.cpp` | Emscripten main loop (iterates started hosts), `start_render()`, the dual-FBO compositor decision, `render_frame()`, `set_window_size()` |
| `WasmShaderCache.cpp` | Transpiled-GLSL cache hooks (host-page store/lookup), `shader_cache_*` and `get_glsl_generator_version()` exports |
| `WasmRenderPathOverrides.cpp` | `?blurPath` / `?copyPath` / `?fboPrecision` URL ablation switches, applied once from `init()` |
| `WasmWebGLContext.cpp` | WebGL 2 context create/destroy, extension enablement, configurable canvas CSS selectors |
| `WasmGraphics.hpp` | Dual ping-pong FBO manager, `GLStateGuard`, `gl_reset_state_between_pipelines()`, compositing/crossfade shader (header — shared by the render loop and the dual-FBO exports) |
| `WasmDualFbo.cpp` | `dual_fbo_*` and `transition_*` exports (per-host FBO/compositor instances live on `WasmHost`) |
| `WasmDeterminism.cpp` | Virtual clock (`WasmNow()`, `DeterministicFrameTick()`), deterministic RNG switch, main-loop pause — `set_deterministic_*` / `set_render_loop_paused` exports. See [GRAPHICS_BENCHMARK_HARNESS.md](GRAPHICS_BENCHMARK_HARNESS.md) |
| `WasmAudioBridge.cpp` | Audio worklet + media-element EM_JS interop, PCM feed wrappers, `pl()` / stream-source exports |
| `WasmPcmRing.cpp` | The single PCM ingest: the WASM-owned ring, its descriptor exports, and the per-frame drain |
| `WasmPerfGovernor.cpp` | Perf HUD instrumentation, adaptive quality governor, OpenMP introspection exports |
| `WasmPlaylistBridge.cpp` | Preset-switch callbacks, playlist path/preset add helpers, `load_preset_file()`, preset-readiness queries |
| `WasmJsBindings.cpp` | EM_JS clusters: DOM/VFS bootstrap (`js_init_projectm_dom`), preset download helpers, host-page notifications |

`ProjectMWasmBuildConfig.hpp` is generated (see above). `WasmGraphics.hpp` is a
header of cohesive graphics classes shared by two TUs; it exceeds the ~800-LOC
guideline for a single unit by design, because splitting the FBO manager,
state guard, and compositing shader across headers would fragment one tightly
coupled subsystem.

All non-header TUs are passed to the final `emcc` link in
`scripts/build_wasm_smoke_wrapper.sh` (`wrapper_sources`). Add new `.cpp` files
to that array.

### Where to add a WASM export

To add a new `EMSCRIPTEN_KEEPALIVE` C export:

1. **Implement it** in the TU that owns the concern (e.g. a new audio export
   goes in `WasmAudioBridge.cpp`, WebGL/canvas work in `WasmWebGLContext.cpp`).
   Wrap it in `extern "C" { ... }` and mark it
   `EMSCRIPTEN_KEEPALIVE`. If it needs **per-instance** state, add a field to
   `struct WasmHost` (`WasmHost.hpp`) and reach it through `Host()` — never a new
   process-global, which would silently be shared across instances. Each TU maps
   the field to the active host with the object-like macros / `auto&` aliases at
   the top of the file (e.g. `#define g_dualFbo (Host().dualFbo)`), so export
   bodies stay handle-free; make your export run under the caller's host by
   having the JS side call `set_active_host()` first (`ProjectMContext` already
   does this before every control op).
2. **Register the symbol** in `cmake/EmscriptenWasmFlags.cmake`
   (`PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS`) so it is added to
   `EXPORTED_FUNCTIONS`, and add a matching entry to
   `PROJECTM_WASM_API_MANIFEST` in `cmake/WasmApiManifest.cmake`.
3. **Regenerate** derived artifacts with `scripts/sync_wasm_link_common.sh` and
   commit them (CI runs `scripts/verify_wasm_link_common.sh`).
4. Keep export **names** stable — hosts and `cmake/WasmApiManifest.cmake` depend
   on them.

If you add a new `.cpp` TU, also add it to the `wrapper_sources` array in
`scripts/build_wasm_smoke_wrapper.sh`.

### Flag matrix (CMake lib link vs. shell wrapper link)

| Setting | CMake lib link | Shell wrapper link | Notes |
|---------|:--------------:|:------------------:|-------|
| `SHARED_MEMORY=1`, `WASM_WORKERS=1`, `-pthread` | yes | yes | Required for pthread pool + SharedArrayBuffer |
| `PTHREAD_POOL_SIZE` | yes (`4`) | yes (`4`, overridable via `PROJECTM_WASM_PTHREAD_POOL_SIZE`) | Must match `kWasmPthreadPoolSize` / `omp_set_num_threads()` |
| `MALLOC=mimalloc`, `INITIAL_MEMORY=256mb`, `MAXIMUM_MEMORY=4gb`, `ALLOW_MEMORY_GROWTH=1` | yes | yes | See `docs/PERFORMANCE.md` for right-sizing |
| `USE_WEBGL2=1`, `MIN/MAX_WEBGL_VERSION=2`, `FULL_ES2=0`, `FULL_ES3=1` | yes | yes | WebGL 2 / GLES 3 target |
| `GL_POOL_TEMP_BUFFERS=0`, `GL_MAX_TEMP_BUFFER_SIZE=33177600`, `GL_TRACK_ERRORS=0` | yes | yes | GL emulation tuning |
| `ASYNCIFY=1`, `ASYNCIFY_ONLY=@cmake/wasm_asyncify_only.txt`, `ASYNCIFY_STACK_SIZE=65536` | yes / yes / when `ENABLE_WASM_TRANSITIONS=ON` | yes / yes / when `ENABLE_WASM_TRANSITIONS=ON` | Non-blocking shader compile; ONLY list is always-on with ASYNCIFY |
| `EXPORTED_FUNCTIONS` (`PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS`) | yes | yes | Single list in `EmscriptenWasmFlags.cmake` |
| `EXPORTED_RUNTIME_METHODS` | `ccall,cwrap` | `ccall,cwrap,FS` | Wrapper adds `FS` for VFS preset loading |
| `TRUSTED_TYPES=1`, `WASM_BIGINT=1`, `AUDIO_WORKLET=1` | yes | no | Applied when linking static libs via CMake |
| `ENVIRONMENT=web,worker`, `MODULARIZE=1`, `EXPORT_NAME=createModule` | no | yes | Browser bundle packaging |
| `-l embind` | no | yes | Wrapper TU uses embind |
| OpenMP cap in `projectM_emscripten.cpp` | — | — | `omp_set_num_threads(kWasmPthreadPoolSize)` from generated header |
| OpenMP blocktime in `projectM_emscripten.cpp` | — | — | `kmp_set_blocktime(0)` — see "OpenMP blocktime" below |

**OpenMP / pthread pool:** libomp's default `omp_get_max_threads()` on wasm follows
`navigator.hardwareConcurrency`, but only `PTHREAD_POOL_SIZE` Workers are pre-spawned.
`projectM_emscripten.cpp::ConfigureWasmOpenMPThreadCount()` calls `omp_set_num_threads(kWasmPthreadPoolSize)`
so OpenMP never requests more threads than Workers exist (fixes 033/034 main-thread freeze).
Change the pool size only in `PROJECTM_WASM_PTHREAD_POOL_SIZE` inside `EmscriptenWasmFlags.cmake`, then
regenerate with `scripts/sync_wasm_link_common.sh`.

**OpenMP blocktime (audio + framerate):** capping the thread count is only half of
what wasm needs from libomp. After each parallel region libomp leaves the helper
threads in a **spin** wait and only lets them sleep once `KMP_BLOCKTIME` has
elapsed — default **200 ms**. `PerPixelMesh::CalculateMesh` opens a region every
rendered frame (the default 80x60 / 64x48 meshes are 4941 / 3185 verts, both over
`OpenMp::kMinPerPixelMeshVerts`), so at 60 fps the next region arrives ~17 ms in
and the helpers never reach the sleep path: they hold their cores for the entire
session rather than only while projectM computes.

That starves the page's `AudioWorklet`, which must fill a 128-sample quantum
every ~2.7 ms at 48 kHz, and it slows the render loop that is competing for the
same cores — one cause behind both the degraded audio and the lower framerate
reported against bundle 036 versus 032. (032's `.wasm` links no libomp at all;
`strings` finds no `kmp_`/`GOMP_`/`libomp` in it, and both bundles ship the same
`pthreadPoolSize=4`.) `ConfigureWasmOpenMPThreadCount()` therefore also calls
`kmp_set_blocktime(0)`. The env-var route does not work here: libomp reads
`KMP_BLOCKTIME` through `getenv()` during its own init and a wasm module has no
environment to inherit one from.

**Gate the call on `KMP_VERSION_MAJOR`, not `__KAI_KMPC_CONVENTION`.** Both are
defined by libomp's `omp.h`, but that header `#undef`s `__KAI_KMPC_CONVENTION` at
the end — it is a calling-convention helper for the declarations, not a feature
flag. Gating on it made `#if defined(__KAI_KMPC_CONVENTION)` always false, so
`kmp_set_blocktime(0)` compiled to nothing and `get_omp_blocktime()` always
returned `-1`, in bundles that do link libomp. The fix was inert from the day it
landed until 037. `KMP_VERSION_MAJOR` is defined near the top of the same header,
is likewise absent from GCC's libgomp `omp.h`, and survives to end of translation
unit.

Verify it in any deployed bundle with the `get_omp_blocktime` export — `0` means
the fix is present, `200` means it is not, `-1` means the bundle has no libomp
(or, before 037, that the guard above had compiled the call away):

```js
Module._get_omp_blocktime()   // or getOmpBlocktime(Module) from the generated API
```

### Future phases

The full dual-pipeline transition feature is being implemented in 5 phases:

1. **Phase 1** (merged) — Emscripten build flags (`USE_WEBGL2`, `FULL_ES3`, `ASYNCIFY`, `ALLOW_MEMORY_GROWTH`, `-O3`)
2. **Phase 2** (merged) — Dual ping-pong FBO architecture with floating-point texture support
3. **Phase 3** (merged) — WebGL state isolation & playlist transition routing
4. **Phase 4** (this change) — Async shader transpilation pipeline & GLSL ES 3.0 correctness
5. **Phase 5** — Final compositing pass: dual-texture blend shader

## Phase 4 — Async Shader Transpilation & Transition Gating

Phase 4 ensures that HLSL→GLSL transpilation and preset loading never freeze the browser, and that the visual transition blend only begins once the incoming preset's shaders are confirmed compiled and linked.

### GLSL ES 3.00 compliance

When building for Emscripten/WASM, `USE_GLES=ON` is set automatically by CMake. This activates the GLES shader pipeline throughout the library:

- The hlslparser `GLSLGenerator` targets `Version_300_ES`, emitting `#version 300 es` and precision qualifiers for every transpiled fragment shader.
- Static shaders (blur, warp, composite vertex shaders) are prepended with the GLES version header by `MilkdropStaticShaders::AddVersionHeader`, which includes:
  ```glsl
  #version 300 es
  
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  precision highp sampler3D;
  ```
- All generated fragment shaders use `out vec4` instead of `gl_FragColor`, `texture()` instead of `texture2D()`/`textureCube()`, and `in`/`out` instead of `varying`/`attribute`.

### Async preset loading

`load_preset_file()` now:

1. Resets the `g_presetBReady` gate to `false` at the start of every load.
2. Sets `app_data.loading = EM_TRUE` to pause the render loop and prevent GL state conflicts during shader compilation.
3. Calls `emscripten_sleep(0)` to **yield to the browser event loop** before the heavy HLSL→GLSL transpilation and `glCompileShader`/`glLinkProgram` calls begin. This prevents the browser from showing an "unresponsive page" warning.
4. Loads the preset via the playlist manager (which runs the full shader compilation pipeline internally).
5. `load_preset_callback_done` fires synchronously once `GL_LINK_STATUS == GL_TRUE` is confirmed; it clears the loading flag and sets `g_presetBReady = true`.

### Transition gating

JavaScript **must** poll `dual_fbo_is_preset_b_ready()` and wait for it to return `true` before starting the compositing blend.
The HTML demos use `startTransitionWhenReady()` from `html/projectm-external-pcm.js`, which polls with
`requestAnimationFrame`, allocates Preset B with `dual_fbo_begin_transition()` if needed, confirms
`dual_fbo_is_preset_b_allocated()`, then calls `transition_start()`.

```js
import { startTransitionWhenReady } from './projectm-external-pcm.js';

Module.ccall('load_preset_file', null, ['string'], [vfsPath]);
startTransitionWhenReady({ module: Module });
```

The flag is reset to `false` on every `load_preset_file()` call, so polling loops correctly handle back-to-back preset switches.

## Init Error Codes

`init()` (exported via `EMSCRIPTEN_KEEPALIVE`, see `projectM_emscripten.cpp`) returns an integer
status code so host pages can detect failures that would otherwise leave the canvas blank with
only a `stderr` message in the console.

| Code | Stage | Meaning | Common causes |
|------|-------|---------|----------------|
| `0` | — | Success. | — |
| `2` | WebGL | Primary canvas selector not found, `emscripten_webgl_create_context` failed, or the created context could not be activated. | Missing canvas element, WebGL 2 unsupported/disabled (older Safari, locked-down GPUs, hardware acceleration disabled). |
| `3` | projectM | `projectm_create()` returned `NULL` after the GL context was successfully created. | Out-of-memory (still possible on very low-RAM mobile even with `INITIAL_MEMORY=256mb`), or an internal projectM error. |
| `4` | Cross-origin isolation | *(JS-side only, not returned by `init()`)* `window.crossOriginIsolated` is `false`. | The page is not served with `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy`. See `docs/DEPLOYMENT.md#cross-origin-isolation-coopcoep`. |

### Main-thread freeze on 033/034 (OpenMP vs. pthread pool)

If the page becomes completely unresponsive a second or two after loading a threaded build
(`projectm-v.033-thread` / `034`), with `crossOriginIsolated === true` and no console error,
the likely cause is an **OpenMP thread-count mismatch**:

- Builds from `d862448f4` onward enable OpenMP on wasm (`PRJM_ENABLE_OPENMP`).
- libomp's default `omp_get_max_threads()` follows `navigator.hardwareConcurrency`
  (`_emscripten_num_logical_cores` in the glue).
- Only **four** pthread Workers are pre-spawned (`PTHREAD_POOL_SIZE=4`).
- `#pragma omp parallel` regions then wait for more threads than Workers exist → silent
  main-thread deadlock.

**Fix (035+):** `projectM_emscripten.cpp::init()` calls `omp_set_num_threads(kWasmPthreadPoolSize)` (from
`cmake/generated/ProjectMWasmBuildConfig.hpp`, sourced from `PROJECTM_WASM_PTHREAD_POOL_SIZE` in
`cmake/EmscriptenWasmFlags.cmake`) to match `PTHREAD_POOL_SIZE`. Rebuild with `scripts/build_wasm_install.sh` +
`scripts/prepare_deploy_bundle.sh` and redeploy. v0.32 did not exhibit this because OpenMP
was not active in that bundle.

### Reporting failures to the host page

Code `4` is a special case: it is detected and reported entirely in JavaScript via
`checkCrossOriginIsolation()` (`html/projectm-init-errors.js`), called *before* the WASM
module is loaded — `init()` itself never returns `4`. See
`docs/DEPLOYMENT.md#cross-origin-isolation-coopcoep`.

On any non-zero return, `init()` calls:

```c
EM_JS(void, js_report_init_error, (int code, const char* detail), { ... });
```

which invokes `window.pmReportInitError(code, detail)` if the host page has defined it. On
success, `init()` calls `js_report_init_success()`, which invokes `window.pmHideInitError()` if
defined.

`html/projectm-init-errors.js` provides a ready-made implementation of both hooks: it shows a
styled `#pm-init-error` overlay with a human-readable message, browser/GPU compatibility hints,
a link back to this document, and a "Retry" button that re-runs `init()`. Host pages call
`setupInitErrorHandling()` once during setup and `checkInit(Module)` after `Module._init()`:

```js
import { setupInitErrorHandling, checkInit } from './projectm-init-errors.js';

const initErrors = setupInitErrorHandling(() => attemptInit());

async function attemptInit() {
    // ... load the WASM module into `Module` ...
    if (!checkInit(Module)) {
        return; // overlay is shown; do not call _start_render()
    }
    Module._start_render(mcanvas.width, mcanvas.height);
}
```

Appending `?simulateInitFail=1` to the page URL forces the overlay to show (using code `2`) for
QA/testing without needing to actually break WebGL.

### Preset-load failures

Failures that happen *after* a successful `init()` (e.g. an individual preset fails to switch)
do not use the overlay. Instead, `_on_preset_switch_failed` calls
`js_report_preset_switch_failed(preset_filename, message)`, which logs a `console.warn` and, if
the page defines a `#stat` element, sets its text to `Preset failed: <name>` with a red
background — the same readout already used for preset-loading status messages.

## Audio Autoplay Policy

Browsers (most strictly Safari/iOS) start every `AudioContext` in the `suspended` state and only
allow `resume()` from inside a user-gesture handler (click, tap, or key press). Every Web Audio
producer is affected by this:

- **Worklet playback** and **media elements** (routed through the same worklet) both use the shared
  `globalThis.projectMAudioContext_Global_Cpp`, created synchronously inside
  `js_initialize_worklet_system_once` (`WasmAudioBridge.cpp`), which C++ `init()` calls before
  reporting success via `js_report_init_success()`. If the browser created this context in the
  `suspended` state, no audio reaches projectM until it is resumed from a user gesture.
  The worklet *module* is loaded asynchronously (`audioWorklet.addModule`); if that fails or is
  still pending when `pl()` runs, older builds silently skipped playback. Current builds wait on
  `globalThis.projectMWorkletReady`, and hosts call `ensureWorkletReady()` /
  `installWorkletPlaybackSafetyNet()` from `html/projectm-worklet-playback.js` so a failed
  async setup can be repaired on the music-button gesture.
- **External PCM** (`html/projectm-external-pcm.js`, used by MOD/FLAC players) never creates an
  `AudioContext` of its own and is unaffected by autoplay restrictions.

`html/projectm-audio-bootstrap.js` provides the fix:

```js
import { ensureAudioRunning, setupAudioUnlock } from './projectm-audio-bootstrap.js';

if (!checkInit(Module)) {
    return;
}
setupAudioUnlock();
```

`setupAudioUnlock()`, called once after `checkInit(Module)` succeeds:

- Is a no-op if `window.projectMAudioContext_Global_Cpp` does not exist (external-PCM-only mode)
  or is already `running`.
- Otherwise shows a "Tap to enable audio" overlay and registers `pointerdown`/`keydown` listeners
  on `document` that call `ensureAudioRunning()`, which resumes the shared `AudioContext` and
  hides the overlay once it reports `running`.

Host pages should also call `ensureAudioRunning()` from their own primary interaction handlers
(e.g. the `musicBtn` click handler) so that resuming audio does not depend solely on the overlay.

The `?debugSender` test panel (see `html/projectm-core.html`) creates its own independent
`AudioContext` for local PCM testing and is unaffected by `setupAudioUnlock()`.

## External Audio Sources (sensitivity parity)

See **[`docs/AUDIO_PIPELINE.md`](AUDIO_PIPELINE.md)** for the full ingress diagram, synthetic
test harness (`?audioTest=1`), automated `PCMAudioReactivity` tests, and WASM smoke runner.

projectM has several audio ingress paths and they don't all preprocess PCM identically, so an
external player (MOD/FLAC popup or iframe) can look *less* reactive than a local `#track` even when
audio is clearly audible. The beat-sensitivity setting itself is the same for every source —
`projectm_set_beat_sensitivity(pm, 1.50)` at init (`projectM_emscripten.cpp`) — but sensitivity acts
on detection *after* PCM is ingested, so differences in the PCM's amplitude and analysis window
before `projectm_pcm_add_float` change how reactive presets feel.

How the paths differ:

| Path | Source | What reaches the engine |
|------|--------|-------------------------|
| AudioWorklet | raw decoded worklet PCM | every 128-frame quantum, stereo, into the PCM ring |
| Media element | `MediaElementAudioSourceNode` → the same worklet | every 128-frame quantum, stereo, into the PCM ring |
| External PCM | player PCM via `postMessage` | the whole chunk, into the PCM ring |

All of them write the one ring described in `docs/AUDIO_PIPELINE.md`, which
`render_frame()` drains — so no path has an analysis window of its own to keep in
sync with the others.

`html/projectm-external-pcm.js` keeps one preprocessing step of its own in
`defaultFeedPCMToModule` / `preprocessExternalPcm`:

- **Input gain** — an optional multiplier (default `1.0`, no change) applied before the write. External
  players send raw analyser amplitude with no gain stage, so a quiet source can be boosted to match
  `#track` loudness on a reference preset *without* rebuilding the WASM module. Configure it with
  any of:
  - `localStorage.externalPcmGain = "1.8"` (read live per chunk; survives reloads), or
  - `setupExternalAudioReceiver({ gain: 1.8 })` / `setExternalPcmGain(1.8)` at runtime.
  `localStorage` wins when set, so a user override beats the page default.
- **Debug RMS** — `setupExternalAudioReceiver({ debugRms: true })` logs per-chunk `rms`/`peak`/`gain`
  via `console.debug`, so you can compare an external source's loudness against the internal one when
  tuning gain.

Channel handling: mono (`channels: 1`) is duplicated into both ring channels at the host boundary;
stereo (`channels: 2`) must be even-length interleaved L/R and is preserved end to end. Senders that
derive PCM from a single AnalyserNode should send `channels: 1`. For best fidelity a player should
forward **decoded output** rather than `getFloatTimeDomainData`, which is post-FFT-window
time-domain data rather than the exact rendered samples.

### Which HTML variant to use for external-player testing

`html/projectm-core.html` is the **canonical** page for FLAC/MOD external-player
testing — it wires `createPopupAudioPlayerController` (popup windows, with
`flacPlayerUrl`/`modPlayerUrl` `localStorage` overrides) together with
`setupExternalAudioReceiver` from `html/projectm-external-pcm.js`, plus the
`?debugSender` tone harness used for the manual reactivity check below.

All other shipped demo variants share the same `projectm-external-pcm.js` /
`projectm-audio-player.js` modules (no copy-paste PCM receivers) via
`createSectionAudioPlayerController`, which toggles an in-page
`flacPlayerSection`/`modPlayerSection` iframe (`?projectm=1`) instead of a
popup:

- `projectm_panel.1ink`, `projectm_panel2.1ink`, `projectm_new.1ink` — FLAC +
  MOD sections wired out of the box.
- `projectm.1ink` — FLAC + MOD sections wired (MOD player section added
  alongside the existing FLAC section).

`projectm_test.1ink` is a standalone UI mockup (no projectM module load at
all — every button is a `console.log` stub) and is out of scope for
external-player wiring.

### Manual reactivity check

To confirm an external source feels comparable to local playback on a bass-heavy preset
(e.g. `custom_milk_fixed/milk011.milk`):

1. Load the reference preset and play a local file via `#track`; note the visual response.
2. Open the FLAC player popup and play a similarly-loud track; compare reactivity.
3. Open the MOD player popup and play a bass-heavy module; compare again.
4. If an external source is visibly weaker, enable `debugRms` and compare RMS against the local
   source, then raise `localStorage.externalPcmGain` until they match (a value around the RMS ratio).
5. The built-in `startLocalProjectMTestSender()` tone harness (`?debugSender` panel in
   `html/projectm-core.html`) is the controlled baseline: a steady tone should drive `bass_att`
   similarly to an external player at matched gain.

## WebGL Context Loss Recovery

Long-running sessions (hours of preset switching, mobile tab backgrounding, GPU driver resets)
can lose the WebGL context underlying `#mcanvas`. Without handling, this leaves a frozen or
black canvas with no on-screen indication — only a `webglcontextlost` event and silence in the
console.

`html/projectm-context-loss.js` exports `setupContextLossRecovery(Module, { canvasSelector })`,
called once after `checkInit(Module)` succeeds (alongside `setupAudioUnlock()`):

```js
import { setupContextLossRecovery } from './projectm-context-loss.js';

if (!checkInit(Module)) {
    return;
}
setupContextLossRecovery(Module);
```

Behavior:

- On `webglcontextlost`: calls `event.preventDefault()` (required for the browser to allow
  recovery), calls `Module._pm_handle_context_loss()` (`EMSCRIPTEN_KEEPALIVE`,
  `projectM_emscripten.cpp`) to tear down the projectM instance, playlist, and dual-FBO
  bookkeeping — all GL calls during teardown are no-ops on a lost context, so this only resets
  state — and shows a "Graphics paused — tap to restore" overlay.
- On `webglcontextrestored` (or a tap on the overlay): re-runs `checkInit(Module)`, which calls
  `Module._init()`. Because `pm_handle_context_loss()` reset the module-level `pm` handle to
  `NULL`, `init()` takes its full re-initialization path (new EGL/WebGL context, new projectM and
  playlist instances re-scanning `/presets/` in the in-memory filesystem, which still contains
  every preset loaded so far). `Module._start_render()` is then called again to apply the current
  viewport and restart the loop (FBO format probing happens in `init()`, and both dual-FBO pairs
  are allocated lazily on the next transition). Finally, the last-displayed preset is reloaded via
  `window.currentPresetPath` (set by `updatePresetDisplay()` in `html/projectm-presets.js` on every
  preset switch).
- If `init()` fails during recovery (e.g. the browser hasn't actually restored the context yet),
  `checkInit()` shows the existing `#pm-init-error` overlay with its "Retry" button instead.

### Testing context loss

In Chrome DevTools: **More tools → Rendering → "Force WebGL Context Loss"** (or use the
WebGL Inspector extension) while a preset is running on `#mcanvas`. The canvas should freeze and
the "Graphics paused — tap to restore" overlay should appear. Triggering "Restore WebGL Context"
(or tapping the overlay) should resume rendering with the same preset within a second or two.

## Main Render Loop (`renderLoop()` → `render_frame()`)

`start_render(width, height)` registers `renderLoop()` as the Emscripten main
loop via `emscripten_set_main_loop()`. `renderLoop()` itself does not call
`projectm_opengl_render_frame()` — it delegates every frame to `render_frame()`
(also `EMSCRIPTEN_KEEPALIVE`-exported, used by the benchmark harness and tests).

`render_frame()` picks one of two paths:

- **Direct-to-canvas path** (steady state — the common case): when no preset
  crossfade is active, `render_frame()` calls `projectm_opengl_render_frame(pm)`
  straight to FBO 0 (the browser canvas), wrapped in a `GLStateGuard`. This is
  the same single-pass path used before the dual-FBO transition work landed.
- **Dual-FBO compositor path** (preset crossfades only): when
  `g_transitionActive` is true and both Preset A/B FBOs plus
  `g_compositorShader` are ready, it renders Preset A and Preset B into their
  ping-pong FBOs and then calls `g_compositorShader.Draw(...)`, which binds
  the default framebuffer (FBO 0, i.e. `#mcanvas`) and blits the cross-faded
  result to it.

  > **Important:** rendering Preset A/B into their Write FBOs **must** use
  > `projectm_opengl_render_frame_fbo(pm, fbo)` (not plain
  > `projectm_opengl_render_frame(pm)`). The plain variant always finishes its
  > internal composite blit on **FBO 0** regardless of which FBO is currently
  > bound (`ProjectM::RenderFrame()` defaults `targetFramebufferObject` to `0`
  > — see `ProjectM.cpp`), so calling it while `g_dualFbo.GetAWriteFBO()`/
  > `GetBWriteFBO()` is bound silently renders to the canvas instead of the
  > Write FBO, leaving the Write texture black and causing
  > `g_compositorShader.Draw(...)` to blit that black texture back over the
  > canvas — a 100%-black `#mcanvas` even though projectM itself rendered
  > correctly. `projectm_opengl_render_frame_fbo()` (available since projectM
  > 4.2.0, `render_opengl.h`) passes the target FBO through correctly.
- **Legacy single-pass fallback** (before `start_render()` has run, or if the
  compositor shader failed to initialise while a transition is active):
  `render_frame()` calls `projectm_opengl_render_frame(pm)` directly, which
  renders straight to FBO 0, wrapped in a `GLStateGuard` for parity with the
  dual-FBO path's per-pass guards.

Either path leaves the finished frame in FBO 0 and increments
`g_renderedFrameCount` exactly once. Browser presentation is handled by the
WebGL canvas compositor; wasm does not call `eglSwapBuffers()`.

### Dual-FBO allocation lifetime

Because only the compositor path touches them, **neither ping-pong pair is
allocated at startup**. `start_render()` records the viewport size via
`DualPingPongFramebuffer::Resize()` and stops there; `dual_fbo_begin_transition()`
brings up whichever pairs are missing, which on a cold start is both of them.
After a crossfade finishes, `PromoteBtoA()` releases Preset B immediately and
`ReleaseDualFboIfIdle()` reclaims Preset A once it has been idle for
`dual_fbo_set_idle_release_seconds()` (default 5 s, `< 0` to keep it resident).
See [PERFORMANCE.md](PERFORMANCE.md#dual-fbo-vram-residency-and-lazy-preset-a-allocation-issue-199)
for the VRAM figures and the rationale for the grace period.

The consequence for host pages: **check both
`dual_fbo_is_preset_a_allocated()` and `dual_fbo_is_preset_b_allocated()` before
calling `transition_start()`.** `transition_start()` refuses to arm the blend
without both pairs, so a host that skips the check gets a silent hard cut
instead of a crossfade. `html/projectm-transitions.js` does this in its
readiness poll; `tests/web/projectm-transitions.test.mjs` covers the ordering.
A `false` return from `dual_fbo_begin_transition()` means "retry on a later
frame", not "give up" — and a host that gives up should call
`dual_fbo_cancel_transition()` so any pairs it allocated are handed back.

`renderLoop()` preserves:

- The `app_data.loading == EM_TRUE` early-return (set by `load_preset_file()`
  during shader compilation) — no GL work, including `render_frame()`, runs
  while a preset is loading.
- The perf HUD GPU timer hooks (`js_perf_gpu_begin_frame()` /
  `js_perf_gpu_end_frame()`), which now bracket `render_frame()` instead of a
  bare `projectm_opengl_render_frame()` call, so GPU timings include the
  compositor blit.
- The post-load grace-frame and quality-governor bookkeeping.

Because `render_frame()` already contains the full Phase 5 transition-blend
logic (see "Dual-Pipeline Preset Transitions" above), routing `renderLoop()`
through it is what makes preset transitions and the dual-FBO output actually
reach the canvas — previously `renderLoop()` bypassed both.

## Local `.milk` preset authoring loop

For offline iteration and agent-driven authoring, `html/projectm-presets.js` now exports
`loadLocalPresetFile(file, { module, startTransitionWhenReady })`.

Behavior:

- Validates that the selected file ends in `.milk`
- Rejects files larger than 2MB
- Writes bytes into the Emscripten VFS at `/presets/local_<sanitized_name>.milk`
- Calls `Module.ccall('load_preset_file', null, ['string'], [vfsPath])`
- Starts the normal dual-pipeline transition gate via `startTransitionWhenReady`
- Reports success/failure through the page `#stat` element when available

In `html/projectm-core.html`, append `?localPresets=1` to show the dev-only local preset picker
and drag-drop zone. In `html/projectm_new.1ink`, the same query flag enables a local preset button.

## Headless Preset Screenshot Capture

`tests/wasm-smoke/capture.html` + `scripts/capture_custom_milk_screenshots.mjs` render a single
preset headlessly (via Playwright/Chromium) and produce a PNG of `#mcanvas`, used to catch
black-canvas/regressions in the render pipeline without a full browser.

`capture.html`:

- Sets `window.__projectMCaptureMode = true` before loading the WASM module. `js_init_projectm_dom()`
  (`projectM_emscripten.cpp`) checks this flag (and `?capture=1`/`?capture=true`) and, if set, skips
  the `scanTextures()` / `scanSongs()` / `scanCustomMilk()` remote XHR scans that `init()` would
  otherwise kick off — keeping the capture page free of non-deterministic network I/O. The page
  already provides the stub DOM elements (`#musicBtn`, `#customMilkBtn`, `#milkPath`, `#textureDir`,
  `#songDir`, `#track`) that `js_init_projectm_dom()` expects.
- After `load_preset_file()`, polls `is_preset_ready()` / `preset_switch_failed()`
  (`EMSCRIPTEN_KEEPALIVE`, `WasmPlaylistBridge.cpp`) once per `requestAnimationFrame` instead of a
  fixed sleep, so the capture waits for shader compile/link to finish and for a few frames of the
  dual-FBO/compositor pipeline to render before the screenshot frame budget starts. A
  `readyTimeoutMs` query param (default 30s) bounds this wait.
- Exposes `window.__projectMPresetCapture` with: `presetPath`, `frames` (total frames advanced,
  including the ready-wait), `canvasMeanRgb` (`{ r, g, b, mean }` from `gl.readPixels` over the
  whole canvas — a `mean <= 20` indicates an effectively black frame), `consoleErrors` (captured
  `console.error`/`console.warn`/uncaught-error/unhandledrejection messages), and
  `presetSwitchFailed` (from `preset_switch_failed()` and the `js_report_preset_switch_failed`
  globals).

`scripts/capture_custom_milk_screenshots.mjs`:

- Its static file server already serves `.wasm` as `application/wasm` (required for
  `WebAssembly.instantiateStreaming`) alongside the COOP/COEP headers from
  `docs/DEPLOYMENT.md#cross-origin-isolation-coopcoep`.
- Launches Chromium with `--use-gl=swiftshader --enable-unsafe-swiftshader` so headless WebGL2
  works without a real GPU. If your Chromium build doesn't bundle SwiftShader, install a software
  GL driver (e.g. Mesa llvmpipe via `libgl1-mesa-dri`/`mesa-vulkan-drivers`) instead.
- When run with a single `--preset`, also captures `presets/tests/000-empty.milk` as a baseline so
  the report and PNGs can be compared against a known-minimal preset:

  ```bash
  node scripts/capture_custom_milk_screenshots.mjs --preset custom_milk_fixed/milk012.milk
  ```

  `capture_report.json` includes `canvasMeanRgb`, `presetSwitchFailed`, and `consoleErrors` per
  preset; the script also prints warnings for a near-black mean (`<= 20`), a failed preset switch,
  or any captured console errors.

### Rebuilding the WASM smoke bundle

The capture script defaults to the **prebuilt** module at the repo root
(`projectm-v.030-thread.1ijs` + `projectm-v.030-thread.wasm`). These are *not*
regenerated automatically, so any change to `projectM_emscripten.cpp` — including
fixes to `render_frame()` — has **no effect on screenshots until the smoke
wrapper is rebuilt and the artifacts are refreshed**.

**Use Emscripten SDK 3.1.53** — the same version pinned by
`.github/workflows/build_emscripten.yml` / `nightly_preset_screenshots.yml`.
A rebuild with a newer SDK (e.g. 5.0.4) was observed to produce an all-black
canvas for every preset, independent of any source changes:

```bash
cd /path/to/emsdk
./emsdk install 3.1.53 && ./emsdk activate 3.1.53
source ./emsdk_env.sh   # required in every new shell before building
```

To rebuild after changing `projectM_emscripten.cpp` (or projectM itself):

```bash
# 1. Build + install projectM static libs for wasm (BUILD_TESTING off keeps
#    this fast; ENABLE_WASM_TRANSITIONS=ON matches the smoke wrapper's
#    ASYNCIFY_STACK_SIZE handling below).
emcmake cmake -S . -B cmake-build-wasm -DBUILD_TESTING=NO \
  -DENABLE_WASM_TRANSITIONS=ON -DCMAKE_INSTALL_PREFIX=install-wasm
cmake --build cmake-build-wasm -j"$(nproc)"
cmake --install cmake-build-wasm

# 2. Build the smoke wrapper against the installed libs.
INSTALL_DIR=$PWD/install-wasm OUT_DIR=$PWD/cmake-build-wasm/wasm-smoke \
  ENABLE_WASM_TRANSITIONS=ON scripts/build_wasm_smoke_wrapper.sh
# -> writes cmake-build-wasm/wasm-smoke/projectm-v.030-thread.{js,wasm,worker.js}
```

`scripts/build_wasm_smoke_wrapper.sh` does **not** pass `-flto`: the projectM
static libs are built without LTO, and mixing bitcode (`-flto`) and
non-bitcode inputs makes `wasm-ld` fail with `attempt to add bitcode file
after LTO` under emsdk 3.1.53.

Then point the capture script at the freshly built module, either by **copying
the artifacts to the repo root** (what the committed bundle expects):

```bash
cp cmake-build-wasm/wasm-smoke/projectm-v.030-thread.js        projectm-v.030-thread.js
cp cmake-build-wasm/wasm-smoke/projectm-v.030-thread.wasm      projectm-v.030-thread.wasm
cp cmake-build-wasm/wasm-smoke/projectm-v.030-thread.worker.js projectm-v.030-thread.worker.js
iconv -f UTF-8 -t UTF-16 projectm-v.030-thread.js -o projectm-v.030-thread.1ijs
iconv -f UTF-8 -t UTF-32 projectm-v.030-thread.js -o projectm-v.030-thread.3ijs
```

> **Don't forget `projectm-v.030-thread.worker.js`.** The `-pthread`/
> `PTHREAD_POOL_SIZE` build spawns one Worker per logical core to load this
> file at startup. If it's missing at the repo root, every worker request
> comes back blocked (`net::ERR_BLOCKED_BY_RESPONSE` under the capture
> script's `Cross-Origin-Embedder-Policy: require-corp`), the module never
> finishes initializing, and `capture.html` times out waiting for
> `is_preset_ready()` — even though the exact same build works fine when
> referenced via `PROJECTM_WASM_JS` pointing directly at the build directory
> (where the worker file sits next to the `.js`).

…or, without copying, by setting `PROJECTM_WASM_JS` to the freshly built `.js`
(the script finds the sibling `.wasm` automatically and accepts `.js`, `.ijs`,
or `.1ijs`; the sibling `.worker.js` is found the same way):

```bash
PROJECTM_WASM_JS=cmake-build-wasm/wasm-smoke/projectm-v.030-thread.js \
  node scripts/capture_custom_milk_screenshots.mjs --preset custom_milk_fixed/milk012.milk
```

Verify the rebuilt module renders non-black output by capturing a known-good
preset (e.g. `milk012`) and confirming `canvasMeanRgb.mean` is above the
`--dark-threshold` in `capture_report.json` — or open
`tests/wasm-smoke/capture.html?capture=1&module=<rel-path-to-.js>&preset=<rel-path-to-.milk>`
directly in a COOP/COEP-isolated browser.

## Performance Profiling

`Module._set_perf_hud(1)` enables CPU/GPU frame-time instrumentation and an on-screen HUD; a
`?benchmark=1&frames=N&preset=...` query param runs a headless benchmark and reports JSON
mean/median/p95 stats. See [docs/PERFORMANCE.md](PERFORMANCE.md) for details.

## Dual-FBO precision policy (WASM)

Dual-FBO format probing defaults to `RGBA16F -> RGBA32F -> RGBA8` to cut transition VRAM/bandwidth
while keeping float precision by default.

- Default: `RGBA16F` when `EXT_color_buffer_half_float` is available (`fboPrecision: 'half'`)
- High precision opt-in: `fboPrecision: 'high'` (host JS reads `?fboPrecision=high`) prefers `RGBA32F` first
- Force byte: `fboPrecision: 'byte'` pins `RGBA8` (debug the degraded path on a float-capable GPU)
- Fallback: `RGBA8` (degraded-mode banner in `html/projectm-fbo-format.js`)

The precision is set through `ProjectMContext`'s `fboPrecision` option / `set_context_config()`; the C++ side no
longer reads `?fboPrecision=` from the URL (see "WebGL context attributes" above).

`RGBA32F` is 16 bytes/px against 8 for `RGBA16F`, across four surfaces (A_Read/A_Write,
B_Read/B_Write) — so the default halves both transition VRAM and compositor bandwidth during a
crossfade. Half-float's 10-bit mantissa is still well beyond what an 8-bit display resolves, so
this is not the `RGBA8` degraded path and carries no banding risk on float-capable GPUs.

Because the saving is on the transition path only, measure it with the crossfade-gated benchmark
(`?benchmark=1&crossfade=1`, see [docs/PERFORMANCE.md](PERFORMANCE.md)) — a steady-state
`?benchmark=1` run never composites the Preset B surfaces and will show no difference.
`scripts/capture_fbo_precision_benchmark.mjs` drives both variants against one build and writes
the before/after JSON pair to `benchmark-results/`.

## Initializing Emscripten's OpenGL Context

In addition to the above linker flags, some additional initialization steps must be performed to set up the OpenGL
rendering context for projectM. Specifically, the `OES_texture_float` WenGL extension must be loaded explicitly to
support the required texture format for the motion vector grid. The following code template can be used to set up a
proper SDL2/WebGL context for projectM:

```c

#include <emscripten.h>
#include <emscripten/html5_webgl.h>

#include <GL/gl.h>

#include <SDL.h>

int main(void)
{
    // Init SDL's video and audio subsystems
    SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);

    // Create the SDL window (will be tied to the Emscripten HTML5 canvas)
    SDL_window* window = NULL;
    SDL_renderer* renderer = NULL;
    SDL_CreateWindowAndRenderer(1024, 768, SDL_WINDOW_OPENGL, &window, &renderer);
    if (window == NULL || renderer == NULL)
    {
        fprintf(stderr, "Failed to create SDL renderer: %s\n", SDL_GetError());
        return 1;
    }

    // Enable floating-point texture support for motion vector grid.
    auto webGlContext = emscripten_webgl_get_current_context();
    emscripten_webgl_enable_extension(webGlContext, "OES_texture_float");

    // Initialize projectM and put all other stuff below.
    
    return 0;
}

```
