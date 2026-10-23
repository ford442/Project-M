# Using libprojectM in Emscripten

projectM supports OpenGL ES rendering, and can be compiled into WebAssembly for use in browsers. WebGL is similar to
OpenGL ES, but not identical, so a few additional considerations apply to get projectM running with Emscripten.

## Additional Build Settings

This fork's flags are not a list to copy from here. They are defined once, in
[`cmake/EmscriptenWasmFlags.cmake`](../cmake/EmscriptenWasmFlags.cmake); `scripts/wasm_link_common.inc.sh` (the
wrapper link) and `cmake/generated/ProjectMWasmBuildConfig.hpp` are generated from it
([Emscripten flag single source of truth](#emscripten-flag-single-source-of-truth)). The values in force, with what
each is for, are in the [flag matrix](#flag-matrix-cmake-lib-link-vs-shell-wrapper-link) and, for the heap, in
[Heap model](#heap-model). Do not carry settings over from older Emscripten notes: the heap is fixed
(`ALLOW_MEMORY_GROWTH=0`) and the GL emulation layers are off (`FULL_ES2=0`, `FULL_ES3=0`).

The WebGL context is not created through SDL: `src/wasm/WasmWebGLContext.cpp` calls
`emscripten_webgl_create_context()` directly. Its attributes are described under
[WebGL context attributes](#webgl-context-attributes).

## Dual-Pipeline Preset Transitions

The dual pipeline (two preset FBO sets cross-faded by `transition_*`) is always compiled into the
WASM host. It used to sit behind an `ENABLE_WASM_TRANSITIONS` CMake option; once ASYNCIFY went,
that option no longer changed a single compile or link setting, CI was building and testing
everything twice for it, and it has been removed.

### Required flags (all set automatically under `if(EMSCRIPTEN)` in CMakeLists.txt)

| Flag | Purpose |
|------|---------|
| `-s USE_WEBGL2=1` | Target WebGL 2.0 — required for MRTs and float texture support |
| `-s MIN_WEBGL_VERSION=2 -s MAX_WEBGL_VERSION=2` | Strictly target WebGL 2.0 and avoid fallback to WebGL 1.0 |
| `-s FULL_ES2=0 -s FULL_ES3=0` | Native WebGL 2 only; no GL emulation layer (libprojectM uses no client-side arrays or buffer mapping) |
| `-O3` | Wrapper link; the static libs take their level from `CMAKE_BUILD_TYPE` (Release by default) |
| `-s INITIAL_MEMORY=256mb -s ALLOW_MEMORY_GROWTH=0` | Fixed heap, sized from a measured high-water mark — see [Heap model](#heap-model) |
| `-pthread`, `PTHREAD_POOL_SIZE` | Presets are prepared (parsed, shaders transpiled) on a per-host pthread while the render loop keeps running — see [Preset loading](#preset-loading) |

There is no `-s ASYNCIFY`: nothing suspends the wasm stack. The build used ASYNCIFY for a single
`emscripten_sleep(0)` before each preset compile; that yield is gone now the compile's CPU half
runs on a prepare thread. `scripts/check_no_asyncify.sh` fails CI if the Asyncify runtime comes
back into the bundle.

## Preset loading

A preset load is split at the GL boundary (libprojectM: `projectM-4/preset_prepare.h`).
The CPU half runs on the host's prepare thread and the GL half on the render thread.
The current preset keeps rendering in between:

| Step | Thread | Where | Work |
|------|--------|-------|------|
| Request | main runtime | `RequestPresetPrepare()` (`WasmPresetPrepare.cpp`) | Reads the preset from MEMFS, then `projectm_preset_prepare_begin_file_contents()` snapshots the texture file list and asks the transpiled-GLSL cache which shaders it holds; the job is posted to the host's queue |
| Prepare | prepare thread | `PrepareThreadMain()` | `projectm_preset_prepare_run()`: parse, analyse and transpile the warp/composite HLSL speculatively. No FS calls: each one would be proxied to the main thread and wait for its current frame |
| Activate | main runtime | `ActivatePreparedPreset()`, top of `render_frame()` | `projectm_load_prepared_preset()`: create the preset's GL objects, compile, start the switch |
| Switch | main runtime | `render_frame()` / `projectm_poll_pending_preset()` | with `KHR_parallel_shader_compile`, the switch waits until the driver reports the links complete; without it, it happens at activation |

Every load goes this way. `load_preset_file()` / `load_preset_file_hard()` set the playlist
position. `switch_preset()` and the engine's preset timer call `play_next`. The playlist's
preset-load hook (`on_playlist_preset_load()`) turns each of these into a request.

- **Latest wins.** Each host has one pending slot and one completed slot. A newer request
  replaces a pending one, and a result is only activated if nothing newer has been posted.
- **Readiness.** `app_data.loading` means "a preparation is in flight". It gates
  `is_preset_ready()` and timer-driven switches, but no longer pauses the render loop.
  `load_preset_callback_done()` runs, and `is_preset_ready()` turns true, once the switch has
  happened.
- **No reentrancy.** When a job finishes, the prepare thread wakes the main runtime thread by
  proxying a call that only schedules a zero-delay timer. A main thread blocked on a futex (a
  contended mutex, or an OpenMP barrier mid-frame) runs proxied calls inside the wait
  (`_emscripten_yield`). Activating there would re-enter the engine mid-render.
  `render_frame()` also polls every frame.
- **Teardown.** The prepare thread is detached and never joined. Joining would block the main
  thread for as long as a transpile takes. `destroy_host()` marks the queue stopped, and a
  running job frees itself when it finishes. Destroying an engine (context loss, rebind)
  discards in-flight results.
- **Shader cache.** The IndexedDB transpiled-GLSL cache is unchanged: same key, same store hook.
  `begin` asks the cache on the main thread, so a shader type the cache already holds is not
  transpiled ahead. The render thread then compiles the cached GLSL, as before.

## WebGL context attributes

`WasmWebGLContext.cpp` creates the rendering context with Emscripten's html5 WebGL API only — there is
no parallel EGL config path. `ProjectMWebGLAttributes()` builds the attribute block from the host's
`WasmContextConfig`, which the **host passes from JS as an argument of host creation**:

```c
uintptr_t create_host_with_config(const char* primary, const char* secondary,
                                  int flags, int powerPreference, int fboPrecision);
```

The config is stored on that `WasmHost` before `emscripten_webgl_create_context`, so there is no
"configure, then create" window and no process-wide slot for a second engine to land in. Both
topologies use the same shape (`WasmContextConfig` in `html/projectm-render-worker-types.ts`): the main
thread calls the export through `createConfiguredHost()` (`html/projectm-context-config.js`), the
OffscreenCanvas render worker receives `{ flags, powerPreference, fboPrecision }` in its `init`
message and passes the same three numbers. `resolveWasmContextConfig(options)` turns
`ProjectMContextOptions` into it; `CONTEXT_CONFIG_FLAGS` names the bits (both are re-exported from
`projectm-context.js`, i.e. `@projectm/web/context`). The C++ side does not scrape `window.location` /
`localStorage` — query-string parsing (`?aa=1`, `?capture=1`, `?fboPrecision=high`) lives in the host JS
layer (`projectm-core.html`).

| Attribute | `flags` bit | `ProjectMContext` option | Default | Rationale |
|-----------|-------------|--------------------------|---------|-----------|
| `majorVersion` / `minorVersion` | — | — (fixed 2 / 0) | 2 / 0 | WebGL 2 only (`MIN/MAX_WEBGL_VERSION=2`) |
| `antialias` | `1 << 0` | `antialias` | `false` | Everything hitting the canvas (FBO 0) is a fullscreen quad + optional sprites; MSAA is invisible on a fullscreen quad — only sprite geometry benefits (`docs/GRAPHICS_PERF_RECOVERY_PLAN.md` §5, #178). `projectm-core.html` reads `?aa=1` / `localStorage.canvasAA`. |
| `preserveDrawingBuffer` | `1 << 1` | `preserveDrawingBuffer` | `false` | Screenshot/capture hosts set `true` (`?capture=1`) for a stable back-buffer |
| `depth` | `1 << 2` | `depth` | `false` | Milkdrop's depth use lives on preset FBOs (#246). Sprites that depth-test against the canvas opt in (`?depth=1`) |
| `stencil` | `1 << 3` | `stencil` | `false` | Same reasoning as `depth`; `?depth=1` restores both |
| `alpha` | `1 << 4` | `contextAlpha` | `false`; follows `transparent` | An opaque canvas unless the page wants transparency (#135): the browser composites an alpha-less canvas without blending. A page with a runtime transparency toggle asks for it up front (`contextAlpha: true`, as `projectm-core.html` does). The `alpha` option is a **separate** canvas-CSS compositing hint and never sets this bit. See [Canvas alpha](#canvas-alpha). |
| `premultipliedAlpha` | `1 << 5` | `premultipliedAlpha` | `true` | Browser compositing default; transparency-keying hosts with straight alpha turn it off |
| `failIfMajorPerformanceCaveat` | `1 << 6` | `failIfMajorPerformanceCaveat` | `false` | Off so software GL still starts (smoke, goldens). Production hosts opt in to refuse a software renderer: init code `8`. Whether a renderer counts as a caveat is the browser's call — headless Chromium 151 with `--use-angle=swiftshader` (CI) accepts SwiftShader even for a plain `getContext()` with the flag, so the refusal path is not exercised there. |
| `explicitSwapControl` | `1 << 7` | `explicitSwapControl`, or `presentMode: 'manual'` | `false` | Manual present; needs the explicit-swap link flavor (see [Link flavors](#link-flavors)), otherwise init code `9` |
| `desynchronized` | `1 << 8` | `desynchronized` | `false` | Low-latency present hint for live hosts (may tear). The pinned Emscripten's `EmscriptenWebGLContextAttributes` has the field, so it is passed straight through; no JS-side `getContext` exists beside the C++ path. |
| `enableExtensionsByDefault` | — | (fixed on) | `true` | Lets projectM probe float/half-float FBO formats |
| `proxyContextToMainThread` | — | (fixed) | `EMSCRIPTEN_WEBGL_CONTEXT_PROXY_DISALLOW` | The context is created on the thread that renders it (main thread, or the render worker). OpenMP helpers and preset prepare threads never issue GL; a GL call from the wrong thread is a bug, not something to paper over with proxying. (Only takes effect in a link with `OFFSCREEN_FRAMEBUFFER`, i.e. the explicit-swap flavor.) |
| `powerPreference` | (own arg) | `powerPreference` | `high-performance` | `0` default, `1` low-power, `2` high-performance |
| dual-FBO precision | (own arg) | `fboPrecision` | `half` (RGBA16F) | `0` RGBA16F, `1` RGBA32F, `2` RGBA8 (`FboFloatFormat`, as `dual_fbo_get_format()` reports); consumed by `DualPingPongFramebuffer::DetectFormat()` |

Attributes are baked into the WebGL context and cannot change afterward; each host keeps its own
(#246) — see [Multi-instance host state](#multi-instance-host-state). `create_host_with_config()`
returns `0` on failure; `get_last_init_error()` then gives the [init error code](#init-error-codes)
(`4` instance cap, `2` / `6` / `7` / `8` / `9` context stage).

**Legacy exports.** `set_context_config(antialias, preserveDrawingBuffer, depth, stencil, alpha,
powerPreference, fboPrecision)` and `create_host()` stay exported for host pages written against
older bundles. There is no process-global slot behind them any more: `set_context_config()` sets the
active host's config if that host has no context yet; otherwise it parks the request **on that host**
for the next context created — a `create_host()` issued while it is active, or its own re-creation.
It can only express the original seven attributes (premultipliedAlpha on, everything newer off). No
in-tree caller uses either; `createConfiguredHost()` only falls back to them for a bundle without
`create_host_with_config()`, and refuses a config they cannot express rather than drop part of it.

### Canvas alpha

What reaches the canvas's alpha channel is part of the contract, because with `alpha: true` the browser
composites it over the page:

- **Transparency off** (the default): every pixel has alpha 1. On an opaque canvas (`contextAlpha` off,
  the default) that is the browser's doing; on a canvas with alpha the engine fills the channel with 1
  after each direct-path frame (`FillAlphaOfOpaqueFrame()` in `WasmRenderLoop.cpp`) and the dual-FBO
  compositor writes 1. A preset's alpha channel is what its blend modes left behind (video echo,
  the darken/brighten filters), not coverage, and used to show the page through.
- **Transparency on**: valid premultiplied output. A pixel whose brightest channel is under the threshold
  is cut out to `(0, 0, 0, 0)`, every other pixel is opaque. libprojectM's transparency pass
  (`CopyTexture`), the transition shader, the flash limiter's blend and the dual-FBO compositor
  (`WasmCompositorShader.hpp`) all keep `rgb <= a`; before, a cut-out pixel kept its colour over alpha 0,
  which a premultiplied canvas adds onto the page.
- Turning transparency on for a context whose canvas has no alpha channel draws the cut-out pixels black
  and `ProjectMContext.setTransparent()` logs it once.

`ColorOutputTest` (native, `tests/libprojectM/`) holds each shader to this; `context_attributes.mjs --check`
reads the canvas pixels back in a browser.

### One canvas, one context

A canvas keeps the first WebGL context it hands out: every later `getContext()` returns that one and
ignores the attributes it is given, and destroying Emscripten's handle does not undo it. So a host
re-created on the same element — `destroy_host()` then a create, a `ProjectMContext` started again with
a different `transparent` — used to come up with the **old** attributes while its config said otherwise.

Each context the engine creates is stamped, on the canvas object, with the request it was made for.
A create that lands on a canvas stamped with a different request (or, unstamped, holding a context whose
alpha / depth / stencil / premultipliedAlpha / preserveDrawingBuffer differ: page script got there first)
destroys what it got, swaps the element for a fresh copy (`cloneNode(false)`: same id, classes, inline
style and width/height attributes, same place in the document), and creates the context again on the copy.
The copy announces itself with a bubbling `projectm-canvas-replaced` event (`detail.previous` is the old
element); `ProjectMContext` follows it, so `context.canvas` is the element being drawn into. A page that
holds the element itself should listen for it too. Context-loss recovery re-creates the context with the
same request and keeps the element.

In the render worker the canvas arrived by transfer and only the page could give it a new one, so there the
engine logs the mismatch and carries on; the snapshot below reports what the context really has.

### Reading what was negotiated

The attributes above are what the host *asks for*. What it got is `get_context_snapshot()`, one packed int
(`WasmContextSnapshotBit` in `WasmWebGLContext.hpp`), surfaced as the read-only `ProjectMContext.contextSnapshot`
after `start()`:

```js
const context = await createProjectMContext({ canvas, fboPrecision: 'high' });
context.contextSnapshot;
// { floatColorBuffer: true, floatBlend: true, loseContext: true,
//   fboFormat: 1, fboFormatName: 'RGBA32F',
//   attributes: { antialias: false, preserveDrawingBuffer: false, depth: false, stencil: false,
//                 contextAlpha: false, premultipliedAlpha: true, failIfMajorPerformanceCaveat: false,
//                 explicitSwapControl: false, desynchronized: false, powerPreference: 'high-performance' },
//   mismatches: [] }
```

On a GPU without `EXT_color_buffer_float` the same `'high'` request ends up as `RGBA16F` (if
`EXT_color_buffer_half_float` exists) or `RGBA8`, and `fboFormat` says so.

| Field | Meaning |
|-------|---------|
| `floatColorBuffer` | `EXT_color_buffer_float` is present: `RGBA16F` / `RGBA32F` render targets work |
| `floatBlend` | `EXT_float_blend` is present: blending into `RGBA32F` targets works |
| `loseContext` | `WEBGL_lose_context` is present on the context, so a loss can be simulated ([Testing context loss](#testing-context-loss)) |
| `fboFormat` / `fboFormatName` | The dual-FBO format `DetectFormat()` picked, in the `fboPrecision` numbering (`0` RGBA16F, `1` RGBA32F, `2` RGBA8). Differs from the requested `fboPrecision` when the GPU cannot do it |
| `attributes` | The context's real attributes, read from `getContextAttributes()` after creation, under the option names (`contextAlpha` is WebGL's `alpha`). `explicitSwapControl` is the request (WebGL does not report it). `null` on a bundle that predates them |
| `mismatches` | "Requested vs effective": one `{ attribute, requested, effective }` per attribute the context does not have as the config asked, logged once by `ProjectMContext` with `console.warn`. A browser may decline `antialias` or `desynchronized`; anything else means the canvas could not be given a context of its own (the render worker, see above). Manual present expects `preserveDrawingBuffer`: Emscripten creates its offscreen back buffer's context with it |

It reports and requests nothing: there is no extra context attribute. The capabilities are probed once, when the
context is created, and are independent of the format chosen (a host that asked for `fboPrecision: 'byte'` still sees
`floatColorBuffer: true` on a float-capable GPU). The object is frozen. It is `null` before `start()` resolves, on a
bundle that predates the export, and after `destroy()`. A successful context-loss recovery builds a new context, so
it is read again then. In the render-worker topology it describes the worker's context; the worker sends the value in
its `ready` and `context-recovered` messages rather than answering a `ccall`, because the main thread waits for
neither (a `ccall` for an export the bundle lacks is never answered).

### The SDL test UI's framebuffer

`projectM-Test-UI` (`src/sdl-test-ui/setup.cpp`, `initGL()`) requests the same default framebuffer as the canvas
above: double buffered, **no alpha channel requested** (the canvas is opaque by default), **no depth, no stencil,
no multisampling**. SDL's own defaults often add a depth buffer and the driver may add MSAA, so a preset bug chased
in the test UI would otherwise disagree with the browser. Like `?aa=1` / `?depth=1` on the canvas, both are opt-in,
by environment variable. A GLES build (`ENABLE_GLES`) asks for OpenGL ES **3.0**, the API WebGL 2 exposes, so a
shader or call that needs more fails in the test UI as it does in the browser:

| Variable | Requests |
|----------|----------|
| `PROJECTM_UI_AA=1` | 4x multisampled default framebuffer |
| `PROJECTM_UI_DEPTH=1` | 24-bit depth + 8-bit stencil |
| `PROJECTM_UI_GLES32=1` | OpenGL ES 3.2 instead of 3.0 (GLES builds only) |

A context that cannot be created or made current, or a GL loader that fails, ends the UI with the error rather
than rendering with null entry points.

On startup the UI logs what the driver actually gave (`SDL_GL_GetAttribute()` after the context exists), e.g.
`Framebuffer: double buffer 1, alpha 0, depth 0, stencil 0, multisample buffers 0 (samples 0)` (a display may
still hand out an alpha channel), and warns when it
differs from the request. SDL reports a missing depth or stencil buffer on a core-profile context as a failed query
(`OpenGL error: 00000502`) with the value left at 0; the UI reads that as size 0. A display with no matching visual
(for example MSAA on Xvfb) makes window creation fail with a message naming these variables.

### Manual present (`explicitSwapControl`)

With `explicitSwapControl` on, nothing reaches the canvas until it is committed: `render_frame()`
calls `emscripten_webgl_commit_frame()` exactly once, after the compositor (on both the direct and
the dual-FBO path). No commit, no present. That is the hook offline video capture (#256 / #262)
builds on; the encoder itself is not here. `get_committed_frame_count()` counts the commits, so a
deterministic run of N ticks can be checked for exactly N. `ProjectMContext` spells the option
`presentMode: 'manual'` (or `explicitSwapControl: true`).

The frame to encode comes from `captureFrame()` / `capture_frame_*()`, read inside `render_frame()`
before the commit, from a pixel-pack buffer behind a fence on a manual-present host. That path needs
no `preserveDrawingBuffer`. See [FLASH_LIMITER.md](FLASH_LIMITER.md#frame-capture), which also
covers the opt-in temporal flash limiter applied before present.

The pinned Emscripten (6.0.x) only honours `explicitSwapControl` with `OFFSCREENCANVAS_SUPPORT` or
`OFFSCREEN_FRAMEBUFFER`: without either, `emscripten_webgl_create_context` returns 0. Browsers removed
`OffscreenCanvas.commit()`, so on a real canvas the only working mechanism is `OFFSCREEN_FRAMEBUFFER`:
FBO 0 becomes an offscreen back buffer and the commit blits it onto the canvas.
`OFFSCREENCANVAS_SUPPORT` must stay off (it proxies GL from pthreads back to the main thread and would
undo the render worker). So manual present is the separate **explicit-swap link flavor**; the
production bundle refuses the attribute up front with init code `9` instead of reporting "no WebGL 2".
The back buffer is resized by `emscripten_set_canvas_element_size()`, which `set_window_size()` calls
on both topologies; a host that changes `canvas.width` without calling `set_window_size()` leaves it at
the old size.

`tests/wasm-smoke/context_attributes.mjs --module <bundle.js> --check` (its own CI step, not part of
the default smoke) creates hosts through `create_host_with_config()` in a real browser: it reads every
attribute back from the context (`Module.ctx.getContextAttributes()`) and holds the snapshot's
`attributes` to it; re-creates a host on its element with other attributes (fresh element, event, size and
CSS carried over), with the same attributes (element kept), and on an element page script already took a
context from (replaced); reads canvas pixels back for the [canvas alpha](#canvas-alpha) contract; checks that a
`failIfMajorPerformanceCaveat` host agrees with the browser's own answer to the same request (up when
the browser accepts it, init code `8` when it refuses), and that `explicitSwapControl` is refused with
init code `9` — or, with `--explicit-swap` against the explicit-swap flavor, comes up with FBO 0
redirected to Emscripten's offscreen back buffer.

### Link flavors

`scripts/build_wasm.sh` (through `scripts/build_wasm_smoke_wrapper.sh`) links the production
bundle by default. The opt-in flavors change the link and tag the build-id (`+gl-debug`,
`+explicit-swap`, `+debug`), so `scripts/build_wasm.sh --stage`, `scripts/prepare_deploy_bundle.sh`
and `deploy.py` refuse to ship them:

| Variable | Adds | For |
|----------|------|-----|
| `--debug` (`PROJECTM_WASM_DEBUG=1`) | `-sASSERTIONS=2 -sSAFE_HEAP=1 -sSTACK_OVERFLOW_CHECK=2` | Runtime checks: wild pointers, stack overflow on any thread, pthread-pool exhaustion warnings. CI runs the smoke, the host churn test (`tests/wasm-smoke/host_churn.mjs`) and the deepest-nesting presets (`scripts/deepest_presets.mjs`) on it. Output defaults to `cmake-build/wasm-smoke-debug/` |
| `PROJECTM_WASM_GL_DEBUG=1` | `-sGL_TRACK_ERRORS=1 -sGL_ASSERTIONS=1` | A bad context attribute or GL call is reported instead of showing as a black canvas. Production keeps `GL_TRACK_ERRORS=0`. |
| `PROJECTM_WASM_EXPLICIT_SWAP=1` | `-sOFFSCREEN_FRAMEBUFFER=1`, `-DPROJECTM_WASM_OFFSCREEN_FRAMEBUFFER=1` | `explicitSwapControl` (manual present) |

The production `-s` settings are otherwise unchanged: `MIN/MAX_WEBGL_VERSION=2`, `FULL_ES2=0`,
`FULL_ES3=0`, `GL_ENABLE_GET_PROC_ADDRESS=1`, `GL_TRACK_ERRORS=0`, `ALLOW_MEMORY_GROWTH=0`,
`INITIAL_MEMORY=256mb`, `MALLOC=mimalloc`, no `ASYNCIFY`, and **no `OFFSCREENCANVAS_SUPPORT`** — the
worker path registers the transferred canvas on `specialHTMLTargets['#mcanvas']` on purpose, and
turning that setting on would proxy GL back to the main thread.

The float extensions (`EXT_color_buffer_float`, `EXT_color_buffer_half_float`, `EXT_float_blend`,
`OES_texture_float_linear`) are enabled in one place, `ProjectMEnableRequiredWebGLExtensions()`, right after
the context is made current; what it found is the host's `WasmContextCaps`, which `DetectFormat()` and the
snapshot read instead of asking WebGL again. Browser presentation does **not** call `eglSwapBuffers()` — frames are
presented when the WebGL canvas is composited by the browser (or, with `explicitSwapControl`, when committed).

### Canvas color space (sRGB)

After the context is current, `ProjectMApplySrgbCanvasColorSpace()` sets
`drawingBufferColorSpace` and `unpackColorSpace` to `"srgb"` when the browser
exposes those WebGL color-management properties. Milkdrop content is authored
in an sRGB / Rec.709-like cube; pinning the tag keeps that look stable on
Display-P3 panels (the compositor maps sRGB → the display) instead of
reinterpreting the same RGB numbers as P3.

This runs for both the main-thread canvas and the OffscreenCanvas render-worker
path (via Emscripten's `GLctx`). Dual-FBO `RGBA16F` intermediates are **not**
Display-P3 or HDR output, and not extra feedback precision either: libprojectM
renders each frame through 8-bit targets before it gets there (see
[Dual-FBO precision policy](#dual-fbo-precision-policy-wasm)). Do **not**
set `drawingBufferColorSpace = "display-p3"` without a final sRGB→P3 convert in
the compositor — that would change preset appearance. `ENABLE_HDR_RENDERING` /
`ENABLE_HDR_P3` are separate libprojectM fidelity flags and are off by default.
With `ENABLE_HDR_P3` the composite shader's output runs linear → Reinhard tone
map → BT.709-to-Display-P3 matrix (on linear light) → sRGB transfer
(`ShaderTranspiler::HdrOutputFunctions()`); the matrix used to come after the
transfer, on encoded values. `ColorOutputTest` pins pure BT.709 red to encoded
P3 `(0.9175, 0.2003, 0.1386)` within 1/255.

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
WebGL context + its attribute config, canvas selectors, PCM ring, and in-flight shader-cache
key) lives in a heap-allocated `WasmHost` — see
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

The shared main loop restores the host that was active before each tick, so a JS sequence that
selects a host and then yields (e.g. `shader_cache_begin_load` → await IndexedDB →
`shader_cache_import_glsl`) still lands on that host. `set_active_host(0)` selects the first
live host (the default host on single-instance pages).

**Per-instance vs. still process-global.** Rendering, transitions, the idle-FBO release
(#199), the quality governor (#178), and — since #246 (Phase C) — the context config, the PCM
ring and the shader-cache key are per-host:

- **WebGL context config.** An argument of `create_host_with_config()`, stored on the new host
  before its context is created; nothing process-wide. A host's config is never rewritten once its
  context exists. The legacy `create_host()` inherits the previous host's config, or one a legacy
  `set_context_config()` parked on the previous host (see [WebGL context attributes](#webgl-context-attributes)).
- **PCM ring.** Each host owns its ring; `pcm_ring_*` / `get_pcm_ring_*` and the per-frame
  drain operate on the active host, so draining host A never consumes host B's writes. JS picks
  a ring with `feedPcmThroughRing(module, buf, { hostHandle })` / `getPcmRingWriter(module,
  hostHandle)` (`html/projectm-pcm-ring.js`). Released rings are retired and reused rather than
  freed immediately, so a producer that has not yet processed the detach cannot write into
  reallocated heap.
- **Transpiled-GLSL shader cache.** Load state is per host, and the key handed to libprojectM is
  namespaced with the host handle (`host<handle>|<key>`). `set_active_host()` re-arms
  libprojectM's single process-wide key for the newly active host, so concurrent loads cannot
  serve host A's GLSL to host B. The store hook strips the namespace, so the IndexedDB store
  still shares compiled GLSL across hosts by preset key.

Still shared, by design:

- **Web Audio worklet.** One `AudioContext` + one worklet node per Module
  (`projectMAudioContext_Global_Cpp` / `projectMWorkletNode_Global_Cpp`). It is sent one
  `pcmRing` descriptor per host (tagged `hostHandle`, withdrawn with `pcmRingDetach`) and writes
  each quantum into every attached ring; without cross-origin isolation the `pcmData` fallback
  handler fans out over `Module.__pmPcmRings` instead. Every engine therefore hears the same
  worklet source; per-engine sources are the host's job (`feedPcmThroughRing(…, { hostHandle })`)
  until the in-page audio engine (#228) lands.
- **Emscripten main loop** (`g_mainLoopRegistered`): one loop services every started host.

`kMaxHosts` stays **2** until #228 settles the audio story. `scripts/check_wasm_host_globals.sh`
(run by the C++ format gate) rejects object-like `#define` aliases of `WasmHost` state in
`src/wasm/`.

## Building the bundle

One command builds what CI tests and what `deploy.py` uploads:

```bash
source /path/to/emsdk/emsdk_env.sh        # 6.0.6, see "Emscripten SDK version"
scripts/build_wasm.sh                     # libraries + link + checks -> cmake-build/wasm-smoke/
scripts/build_wasm.sh --stage             # ... and stage for deploy.py (repo root + pm/)
scripts/build_wasm.sh --lto               # whole-program LTO (rebuilds the libraries)
scripts/build_wasm.sh --link-only --debug # runtime-checks flavor -> cmake-build/wasm-smoke-debug/
```

`build_emscripten.yml` and `scripts/colab_build.sh` run the same script. It runs, in order:
`scripts/build_wasm_install.sh` (incremental configure/build/install of the static libraries,
Release, so `NDEBUG`), `scripts/build_wasm_smoke_wrapper.sh` (the `src/wasm/` wrapper link),
`scripts/check_wasm_bundle_features.sh` (below) and, with `--stage`,
`scripts/prepare_deploy_bundle.sh`. Defaults: `INSTALL_DIR=install`,
`CMAKE_BUILD_DIR=cmake-build-wasm`, `OUT_DIR=cmake-build/wasm-smoke`; `--help` lists the rest.

**Nothing changes the binary after the link.** At `-O3` the link already runs `wasm-opt -O3`; the
old `optimize.sh` ran it a second time on the *staged* bundle (saving 604 B, 0.04%) plus an
optional WasmEdge AOT pass browsers cannot use, after the hashes and the `.br`/`.gz` copies were
made, so the deployed bundle was one no gate had seen. It is now `scripts/optimize.sh`, benchmarks
only. `scripts/build_projectm.sh` (hardcoded `/root/emsdk`, host-built projectm-eval, install to
`/usr/local`) and `git.sh` are gone.

**The wrapper compiles like the library.** The `src/wasm/` TUs include internal libprojectM
headers, so they must see the same `config.h` and compile definitions (`PRJM_F_SIZE`,
`PROJECTM_STATIC_DEFINE`, `NDEBUG`, …) or the two halves disagree on a type's layout (an ODR
violation the linker does not report). CMake writes them to
`<CMAKE_BUILD_DIR>/projectm-wasm-wrapper-flags.txt` (`projectm_write_emscripten_wrapper_flags()`
in `cmake/EmscriptenWasmFlags.cmake`, from the targets' `COMPILE_DEFINITIONS`), and both the
wrapper link and `scripts/check_cpp_tidy.sh` read that file. It also records whether the libraries
were built for LTO; the link follows it, fails if `PROJECTM_WASM_LTO` in the environment says
otherwise, and checks the archives really are bitcode (or wasm objects).

**`<bundle>.build-id`.** Line 1 is the source fingerprint (`scripts/wasm_source_fingerprint.sh`)
plus the flavor tags. Then `key=value` facts: `wasm-sha256` and `js-sha256` of the linked
binary and glue, `lto-libs` / `lto-link`, `ndebug`, `emcc`. Staging rewrites the glue's bundle name,
so the staged id carries the staged `js-sha256` and the link's as `link-js-sha256`. Two builds of the
same tree with the same SDK give the same hashes, in any build directory (checked 2026-10-23: a
fresh `cmake-build-wasm-repro` and an incremental `cmake-build-wasm-bw` both produced
`wasm-sha256=941a0ab7…`).

## Emscripten flag single source of truth

WASM compile/link flags, `EXPORTED_FUNCTIONS`, and the OpenMP/pthread pool cap are defined in
`cmake/EmscriptenWasmFlags.cmake`. That module drives:

- The `ENABLE_EMSCRIPTEN` block in `CMakeLists.txt` (static lib build)
- The generated `scripts/wasm_link_common.inc.sh` (final `projectM_emscripten.cpp` wrapper link)
- The generated `cmake/generated/ProjectMWasmBuildConfig.hpp` (`kWasmOpenMpThreads`,
  `kWasmPresetPrepareThreads`, `kWasmPthreadPoolSize`, `kWasmStackSize`, `kWasmPthreadStackSize`)
- `<CMAKE_BUILD_DIR>/projectm-wasm-wrapper-flags.txt` (the libraries' `config.h`, definitions and
  LTO state for the wrapper compile; see [Building the bundle](#building-the-bundle))

The thread counts are constants in the module, not cache options: the pool size is baked into both
the link (`PTHREAD_POOL_SIZE`) and the header's `static_assert`, and a smaller pool than OpenMP plus
the prepare threads need brings back the lazy-Worker hang (see "Main-thread freeze on 033/034"). A
`-DPROJECTM_WASM_PTHREAD_POOL_SIZE=…` that disagrees is a configure error, and the wrapper link
rejects a `PROJECTM_WASM_PTHREAD_POOL_SIZE` environment override.

**Stacks.** `STACK_SIZE=1MB` (main thread) and `DEFAULT_PTHREAD_STACK_SIZE=512KB` (every pthread,
the preset prepare thread included). Emscripten's defaults are 64 KB each. The prepare thread parses
equations (projectM-eval) and transpiles shaders (hlslparser), and both recurse once per nesting
level: `tests/libprojectM/data/PresetPrepare/prepare-deep-nesting.milk` (64 levels) overflows a
64 KB pthread stack on the `--debug` link, 32 levels fit, and 512 KB handles 256. Real presets nest
at most 5 deep (`node scripts/deepest_presets.mjs --verbose`). Six pthreads cost 3 MB of the
256 MB heap.

**`INVOKE_RUN=0`** is in the canonical wrapper list (every host calls `init*()` /
`create_host*()` itself). Evaluated and **not** adopted (2026-10-23, same tree, glue sizes):
`-sTEXTDECODER=2` saves 401 B raw / 158 B gzip, and `-sINCOMING_MODULE_JS_API=[…]` (the 14
properties any host in `html/`, `packages/web/` or the tests passes to `createModule`) saves
744 B / 265 B. The `.wasm` is unchanged either way. The first drops the decoder fallback for
no measurable gain; the second makes any `Module` property a host passes that is missing from the
list silently ignored. Neither is worth that.

**`-fno-strict-aliasing`, `-fno-math-errno`** are `PROJECTM_WASM_CODEGEN_COMPILE_FLAGS`, not SIMD
flags. An audit with GCC `-O3 -fstrict-aliasing -Wstrict-aliasing=2` over the native build
(2026-10-23) found nothing, and the SIMD code in `WaveformAligner` loads and stores through
`wasm_v128_load`/`wasm_v128_store`, which are `may_alias`. The flag stays as a safety net for the
vendored code; dropping it would need a golden-image run.

Regenerate derived artifacts after editing the CMake module:

```bash
scripts/sync_wasm_link_common.sh
```

CI runs `scripts/verify_wasm_link_common.sh` to ensure generated files are committed in sync.

Typed JavaScript wrappers are generated into `html/generated/projectm-wasm-api.{ts,js}` from `cmake/WasmApiManifest.cmake`. See [WASM_JS_API.md](WASM_JS_API.md).

## Wasm feature floor

An engine that lacks a feature used by any one instruction rejects the **whole** module at
`WebAssembly.compile` time, and the page reports it as a generic init failure, not as a missing code
path. So the bundle is built for exactly one feature set, the one every target browser compiles:

| Feature (flag) | Chrome | Firefox | Safari |
|---|---|---|---|
| Threads + shared memory (`-pthread`) | 74 | 79 | 14.1 (iOS 14.5) |
| Fixed-width SIMD (`-msimd128`) | 91 | 89 | 16.4 |
| Exception handling, legacy encoding (`-fwasm-exceptions`, emsdk 6.0.6) | 95 | 100 | 15.2 |
| Bulk memory, sign-ext, non-trapping float-to-int, mutable globals | older than all of the above | | |

Safari 16.4 is therefore the floor. What is deliberately **not** used:

- **Relaxed SIMD** (`-mrelaxed-simd`): Safari ships it only behind a JavaScriptCore flag, so the
  bundle used to fail to compile there at all. It was worth 34 compiler-contracted
  `f32x4`/`f64x2.relaxed_madd` instructions, none in the per-pixel mesh loop (preset per-frame
  bookkeeping, one-off noise-texture generation, `stb_image` decode). Dropping it moved a few
  `000-empty` pixels by up to 7/255 on one channel, under the golden gate's per-pixel threshold
  (all 26 goldens still pass). A second, relaxed bundle tier plus a probing loader would have
  doubled CI and the deploy for no measurable win. Revisit only with a benchmark that shows one.
- **Memory64**: not in Safari.
- **JSPI** (`-sJSPI`): nothing suspends the wasm stack since presets are prepared on a pthread
  (see [Preset loading](#preset-loading)), so there is nothing for it to replace. ASYNCIFY is gone,
  not waiting for JSPI.

`scripts/check_wasm_bundle_features.sh <bundle>.wasm` disassembles the linked bundle and fails on
relaxed-SIMD or Memory64 instructions; `build_emscripten.yml` runs it because Chromium, which runs
every browser gate, supports all of them and would never notice. It also covers prebuilt archives
the link pulls in (`omp/libomp.a`). `scripts/build_wasm.sh` runs it on every link, and it checks the
build as well: main and pthread stack sizes match `ProjectMWasmBuildConfig.hpp` (read from the
binary and glue, not from the flags), every TU was built with `NDEBUG` (no `__assert_fail` in the
symbol map, except on the `--debug` flavor whose `ASSERTIONS` libc legitimately has it), and the
`.build-id`'s `lto-libs` equals `lto-link`. Browser minimums above are from
[webassembly.org/features](https://webassembly.org/features/) as of 2026-09.

## Heap model

The heap is fixed: `INITIAL_MEMORY=256mb`, `ALLOW_MEMORY_GROWTH=0`. The measured high-water mark is
**19.25 MiB**, runtime and pthread stacks included. It was measured with
`tests/wasm-smoke/measure-heap.mjs` on a relink with `-sINITIAL_MEMORY=16mb`, so any allocation past
16 MiB shows up as growth, and it was the same at 1920x1080 and 3840x2160 for `000-empty`,
`110-per_pixel`, `261-compshader-noisevol_lq`, `270-compshader-solid-color`, and the heavy
`presets/custom/` presets `milk001_variant`, `milk011` and `fractal_tunnel_grok`, across a
dual-FBO transition. Framebuffers and textures live in GPU memory, not the heap. A forced 64 MB
`malloc` did show up (19.25 to 89.5 MiB), so the probe does see growth. 256 MB is about 13x the
high-water mark and the same initial reservation as before, so nothing that fit before can fail now.

The old `ALLOW_MEMORY_GROWTH=1` + `MAXIMUM_MEMORY=4gb` cost three things:

1. The browser reserved **4 GB** of address space for the shared memory up front, which low-memory
   mobile refuses (init error `3`).
2. With pthreads, every heap access from JS went through a `growMemViews()` check: 303 call sites in
   the glue, GL calls included (`emcc -Wpthreads-mem-growth`).
3. A maximum over 2 GB turned off WebGL2's garbage-free upload APIs (`tools/link.py`, for
   Firefox < 151), so every `glUniform*v` allocated a subarray view.

Together with dropping embind, the JS glue went from 208,899 to 187,681 bytes (-10%).
`-sGROWABLE_ARRAYBUFFERS` is not needed now that nothing grows.

To re-measure after a change that could allocate much more (bigger meshes, image textures, more
hosts), relink with `PROJECTM_WASM_EXTRA_LINK_FLAGS=-sINITIAL_MEMORY=16mb` and run
`measure-heap.mjs` with `PROJECTM_HEAP_WIDTH`/`PROJECTM_HEAP_HEIGHT`. Raise `INITIAL_MEMORY` if the
high-water mark gets within 4x of it; turn growth back on only if a real workload cannot be bounded.

## Symbolizing a production stack trace

The link passes `--emit-symbol-map`, which writes `<bundle>.js.symbols` (`index:name` per line)
next to the glue; the `.wasm` is byte-identical with or without it. `prepare_deploy_bundle.sh`
stages it as `projectm-v.<version>-thread.symbols` at the repo root. It is gitignored and
`deploy.py` does not upload it, so keep the file for every version you deploy. A frame such as
`wasm-function[1234]` resolves with `grep '^1234:' projectm-v.039-thread.symbols | c++filt`.
The index includes imports, so use the number exactly as the browser printed it.

## Deploy staleness guard

`scripts/build_wasm_smoke_wrapper.sh` writes `projectm-v.030-thread.build-id` next to its outputs
(format in [Building the bundle](#building-the-bundle)). Line 1, the source fingerprint
(`scripts/wasm_source_fingerprint.sh`: working-tree contents of `src/`, `vendor/`, `cmake/`, the
build scripts, submodule commits and the extra-link-flags knob), answers "was this built from this
tree"; the binary hashes answer "is this the binary that was built".
`scripts/prepare_deploy_bundle.sh` rebuilds by default (through `scripts/build_wasm.sh`) and stages
the id as `<bundle>.build-id`. `deploy.py` refuses to upload:

- a canonical bundle whose fingerprint does not match the tree it runs from
  (`--allow-stale-wasm` overrides), and
- any staged copy (`<bundle>.wasm`, `.js`, `pm/` mirrors, their `.br`/`.gz`, legacy
  `.1ijs`/`.3ijs`) that does not decode to the build-id's `wasm-sha256` / `js-sha256`. Not
  overridable: that file is a binary nobody tested.

`python3 deploy.py --check-bundle` runs both checks without the network; `build_emscripten.yml` runs
it after `scripts/build_wasm.sh --stage`. `PROJECTM_DEPLOY_REUSE_BUILD=1` lets
`prepare_deploy_bundle.sh` skip the rebuild, but only for outputs whose fingerprint matches.

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
| `WasmRenderPathOverrides.cpp` | `?blurPath` / `?copyPath` / `?perPixelEval` ablation switches: `set_render_path_overrides()` from the host (the only route into the render worker), else the page URL, applied once from `init()` |
| `WasmWebGLContext.cpp` | WebGL 2 context create/destroy, extension enablement, configurable canvas CSS selectors |
| `WasmGraphics.hpp` | Dual ping-pong FBO manager, `RenderStateGuard`, `reset_render_state_between_pipelines()`, compositing/crossfade shader (header — shared by the render loop and the dual-FBO exports) |
| `WasmDualFbo.cpp` | `dual_fbo_*` and `transition_*` exports (per-host FBO/compositor instances live on `WasmHost`) |
| `WasmPresent.cpp` | The end of a frame: flash-limiter switches (forwarding to libprojectM's C API), per-host frame readback (`capture_frame_*`, taken in `render_frame()` before a manual-present commit) and the commit counter. See [FLASH_LIMITER.md](FLASH_LIMITER.md) |
| `WasmDeterminism.cpp` | Virtual clock (`WasmNow()`, `DeterministicFrameTick()`), deterministic RNG switch, main-loop pause — `set_deterministic_*` / `set_render_loop_paused` exports. See [GRAPHICS_BENCHMARK_HARNESS.md](GRAPHICS_BENCHMARK_HARNESS.md) |
| `WasmAudioBridge.cpp` | Audio worklet + media-element EM_JS interop, PCM feed wrappers, `pl()` / stream-source exports |
| `WasmPcmRing.cpp` | The single PCM ingest: the WASM-owned ring, its descriptor exports, and the per-frame drain |
| `WasmPerfGovernor.cpp` | Perf HUD instrumentation, adaptive quality governor, OpenMP introspection exports |
| `WasmRhythm.cpp` | Musical time: `get_rhythm_*` readouts, `set_rhythm_hint`, `set_preset_switch_policy`, `transition_set_duration_beats`, `set_hard_cut_on_beat`, and the `set_rhythm_events` → `pmOnRhythmEvent` beat/bar/section events (see [AUDIO_PIPELINE.md](AUDIO_PIPELINE.md#rhythm-analysis)) |
| `WasmPlaylistBridge.cpp` | Preset-switch callbacks, the playlist's preset-load hook, playlist path/preset add helpers, `load_preset_file()`, preset-readiness queries |
| `WasmPresetPrepare.hpp` / `WasmPresetPrepare.cpp` | Per-host preset prepare thread and its single-slot queue; activation of prepared presets from `render_frame()` (see [Preset loading](#preset-loading)) |
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
   process-global, which would silently be shared across instances. Open the
   function body with `WasmHost& H = Host();` plus local references where that
   reads better (e.g. `auto& g_dualFbo = H.dualFbo;`), so export bodies stay
   handle-free. Do **not** add object-like `#define` aliases for host state —
   `scripts/check_wasm_host_globals.sh` rejects them (#246). Bind the references
   *after* any host switch in the same body. Make your export run under the caller's host by
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
| `SHARED_MEMORY=1`, `-pthread` | yes | yes | Required for the pthread pool + SharedArrayBuffer. No `WASM_WORKERS`: every thread is a pthread |
| `PTHREAD_POOL_SIZE` | yes (`5`) | yes (`5`; an env override is rejected) | OpenMP helpers (`kWasmOpenMpThreads - 1` = 3) + one prepare thread per host (`kWasmPresetPrepareThreads` = 2) |
| `STACK_SIZE=1MB`, `DEFAULT_PTHREAD_STACK_SIZE=512KB` | yes | yes | See [Emscripten flag single source of truth](#emscripten-flag-single-source-of-truth) |
| `INVOKE_RUN=0` | no | yes | Hosts call `init*()` / `create_host*()` themselves |
| `-fno-strict-aliasing -fno-math-errno` | compile | compile | `PROJECTM_WASM_CODEGEN_COMPILE_FLAGS` |
| `-include config.h`, libprojectM's compile definitions | compile | compile (`projectm-wasm-wrapper-flags.txt`) | Same type layouts on both sides of the link |
| `MALLOC=mimalloc`, `INITIAL_MEMORY=256mb`, `ALLOW_MEMORY_GROWTH=0` | yes | yes | Fixed heap; see [Heap model](#heap-model) |
| `USE_WEBGL2=1`, `MIN/MAX_WEBGL_VERSION=2`, `FULL_ES2=0`, `FULL_ES3=0` | yes | yes | Native WebGL 2, no GL emulation layer |
| `GL_TRACK_ERRORS=0` | yes | yes | No per-call GL error tracking. (`GL_POOL_TEMP_BUFFERS` is gone: with the heap under 2 GB the garbage-free WebGL2 upload APIs are on and it no longer reaches the glue) |
| `-msimd128`, no `-mrelaxed-simd` | compile + link | compile + link | The [feature floor](#wasm-feature-floor) |
| `-fwasm-exceptions` | compile + link | compile + link | C++ exception ABI, unconditional. The JS-trampoline fallback (`PROJECTM_WASM_EXCEPTIONS=js`) only existed because of ASYNCIFY and is rejected now |
| `-flto` (`PROJECTM_WASM_LTO`) | compile (`-DPROJECTM_WASM_LTO=ON`, `scripts/build_wasm.sh --lto`) | link (follows the libraries) | Opt-in whole-program LTO: the static libs become bitcode. One switch, the CMake cache entry; the link reads it from `projectm-wasm-wrapper-flags.txt`. The wrapper TUs stay native objects because Emscripten 6.0.6 drops `EM_JS` definitions compiled to bitcode |
| `EXPORTED_FUNCTIONS` (`PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS`) | no | yes | Single list in `EmscriptenWasmFlags.cmake`. The CMake link only produces the unit-test executables, which do not contain these symbols |
| `EXPORTED_RUNTIME_METHODS` | `ccall,cwrap` | `ccall,cwrap,FS` | Wrapper adds `FS` for VFS preset loading |
| `ENVIRONMENT=web,worker`, `MODULARIZE=1`, `EXPORT_NAME=createModule` | no | yes | Browser bundle packaging |
| `--emit-symbol-map` | no | yes | Writes `<bundle>.js.symbols` for symbolizing production stack traces; see [Symbolizing a production stack trace](#symbolizing-a-production-stack-trace) |
| OpenMP cap in `projectM_emscripten.cpp` | — | — | `omp_set_num_threads(min(kWasmOpenMpThreads, hardwareConcurrency - 1))`; see below |
| OpenMP blocktime in `projectM_emscripten.cpp` | — | — | `kmp_set_blocktime(0)` — see "OpenMP blocktime" below |

**OpenMP / pthread pool:** libomp's default `omp_get_max_threads()` on wasm follows
`navigator.hardwareConcurrency`, but only `PTHREAD_POOL_SIZE` Workers are pre-spawned.
`projectM_emscripten.cpp::ConfigureWasmOpenMPThreadCount()` calls `omp_set_num_threads()` with
`kWasmOpenMpThreads`, clamped at runtime to `navigator.hardwareConcurrency - 1` (at least 1), so
OpenMP never requests more threads than Workers exist (fixes 033/034 main-thread freeze) and a 2- or
4-core phone keeps a core for the page's AudioWorklet instead of oversubscribing it.
The pool also holds one preset prepare thread per host. The generated header `static_assert`s that
`PTHREAD_POOL_SIZE` covers both. Change the team size (`PROJECTM_WASM_OPENMP_THREADS`) or the
prepare-thread count (`PROJECTM_WASM_PRESET_PREPARE_THREADS`) in `EmscriptenWasmFlags.cmake`, then
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

### Phases

The dual-pipeline transition feature was implemented in 5 phases, all merged:

1. **Phase 1** (merged) — Emscripten build flags (`USE_WEBGL2`, `ALLOW_MEMORY_GROWTH`, `-O3`; `ASYNCIFY` and
   `FULL_ES3` have been removed since)
2. **Phase 2** (merged) — Dual ping-pong FBO architecture with floating-point texture support
3. **Phase 3** (merged) — WebGL state isolation & playlist transition routing
4. **Phase 4** (merged) — Async shader transpilation pipeline & GLSL ES 3.0 correctness. Its `emscripten_sleep(0)`
   yield has been replaced by the prepare thread (see [Preset loading](#preset-loading))
5. **Phase 5** (merged) — Final compositing pass: dual-texture blend shader, run by `render_frame()` while a
   transition is active

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
2. Sets `app_data.loading = EM_TRUE`, meaning "a preparation is in flight". This no longer pauses the
   render loop; the current preset keeps drawing.
3. Queues the load on the host's prepare thread through the playlist and returns. The thread does the
   HLSL→GLSL transpile (see [Preset loading](#preset-loading)). This replaced an `emscripten_sleep(0)`
   yield that needed ASYNCIFY and still stopped the render loop for the whole compile.
4. `render_frame()` activates the prepared preset: GL objects, compile, then link. With
   `KHR_parallel_shader_compile`, the link runs on driver threads and the switch waits for it.
5. `load_preset_callback_done` fires once the engine has switched. It clears the loading flag and sets
   `g_presetBReady = true`.

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
| `2` | WebGL | `emscripten_webgl_create_context` failed: no WebGL 2 context. | WebGL 2 unsupported/disabled (older Safari, locked-down GPUs, hardware acceleration disabled). |
| `3` | projectM | `projectm_create()` returned `NULL` after the GL context was successfully created. | Out-of-memory (still possible on very low-RAM mobile even with `INITIAL_MEMORY=256mb`), or an internal projectM error. |
| `5` | WebGL context lost | The host's WebGL context is lost and the browser has not restored it yet (e.g. the context-loss overlay was tapped before `webglcontextrestored`). `init()` refuses rather than build an engine on the dead context. | Not an error: `checkInit()` shows nothing and the context-loss overlay stays up; the `webglcontextrestored` handler retries. |
| `4` | Cross-origin isolation / instance cap | *(JS-side, not returned by `init()`)* `window.crossOriginIsolated` is `false`; also what `get_last_init_error()` reports after `create_host*()` refused at `kMaxHosts`. | The page is not served with `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy`. See `docs/DEPLOYMENT.md#cross-origin-isolation-coopcoep`. |
| `6` | WebGL | Primary canvas selector resolves to nothing (`specialHTMLTargets`, then the DOM). Was part of `2`. | Selector typo, canvas not in the document yet, worker canvas not registered. |
| `7` | WebGL | The context was created but `emscripten_webgl_make_context_current` failed. Was part of `2`. | GPU process trouble; context lost between create and activate. |
| `8` | WebGL | `failIfMajorPerformanceCaveat` refused the context, and a probe on a throwaway 1×1 `OffscreenCanvas` shows WebGL 2 *would* come up without it — i.e. only a software renderer (SwiftShader, llvmpipe) is available. | Hardware acceleration off, blocklisted GPU/driver, headless browser. Only possible when the host opted in. |
| `9` | WebGL | `explicitSwapControl` was requested from a bundle linked without `OFFSCREEN_FRAMEBUFFER`. | Page needs the explicit-swap link flavor ([Link flavors](#link-flavors)). |

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
EM_JS(void, js_notify_init_error, (double host, int code, const char* detail), { ... });
```

which invokes `window.pmReportInitError(host, code, detail)` if the host page has defined it.
`host` is the engine whose init failed (`create_host*()`'s handle, `0` for the default host,
`-1` for a `create_host*()` refused at `kMaxHosts` before any engine existed); bundles up to
039 called `(code, detail)`. The same code
is kept for `get_last_init_error()` (0 after a success), which is how a caller of
`create_host_with_config()` — which can only return a 0 handle — tells the failures apart; the render
worker puts it in its `error` message's `code`. On
success, `init()` calls `js_report_init_success()`, which invokes `window.pmHideInitError(host)` if
defined. (Listen through `subscribeWasmCallback()` in `html/projectm-wasm-callbacks.js` rather
than assigning the global yourself — see "Page globals" in `html/README.md`.)

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
do not use the overlay. Instead, `on_preset_switch_failed` calls
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

`docs/mockups/projectm_test.1ink` is a standalone UI mockup (no projectM
module load at all — every button is a `console.log` stub). It is not
deployed and is out of scope for external-player wiring.

### Manual reactivity check

To confirm an external source feels comparable to local playback on a bass-heavy preset
(e.g. `presets/custom/milk011.milk`):

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

`ProjectMContext` installs recovery itself, on both render topologies. Standalone hosts call
`setupContextLossRecovery(target, { canvas })` from `html/projectm-context-loss.js`, where `target`
is a `ProjectMContext` or a bare `RenderTransport`. The module never touches the Emscripten
`Module` (it is on the `scripts/check_core_host_public_api.sh` gate list): every engine call goes
through the transport, so the same recovery runs whether the engine is on this thread or in the
render worker.

```js
import { setupContextLossRecovery } from './projectm-context-loss.js';

const dispose = setupContextLossRecovery(context, { canvas });   // dispose() removes every listener
```

Where the events are heard depends on where the context lives:

| Topology | `webglcontextlost` / `webglcontextrestored` fire on | Who hears them |
|----------|------------------------------------------------------|----------------|
| `main` | the page's `<canvas>` | `projectm-context-loss.js`, which calls `preventDefault()` and `transport.callVoid('pmHandleContextLoss')` |
| `worker` | the transferred `OffscreenCanvas`, inside the render worker | the worker, which does the `preventDefault()` + `pm_handle_context_loss()` half itself and relays `context-lost` / `context-restored` (see `projectm-render-worker-types.ts`); the page hears them through `transport.onContextEvent()` |

Either way the re-init is one call, `transport.recoverContext()`, and only a context that actually
lost its engine is rebuilt. On the worker it is a `recover-context` message; the worker answers
`context-recovered` with `init()`'s status.

Behavior:

- On loss: the "Graphics paused — tap to restore" overlay is shown (it needs a `document`; without
  one, recovery still runs silently) and projectM's instance, playlist, and dual-FBO bookkeeping
  are torn down by `pm_handle_context_loss()` (`EMSCRIPTEN_KEEPALIVE`, `projectM_emscripten.cpp`) —
  all GL calls during teardown are no-ops on a lost context, so this only resets state.
- On `webglcontextrestored` (or a tap on the overlay): `transport.recoverContext()` runs `init()`,
  which is the re-init export. Because `pm_handle_context_loss()` reset the module-level `pm`
  handle to `NULL`, `init()` takes its full re-initialization path (new EGL/WebGL context, new
  projectM and playlist instances re-scanning `/presets/` in the in-memory filesystem, which still
  contains every preset loaded so far). `start_render()` is then called again to apply the current
  viewport and restart the loop (FBO format probing happens in `init()`, and both dual-FBO pairs
  are allocated lazily on the next transition). Finally, the last-displayed preset is reloaded
  through the transport from `window.currentPresetPath` (set by `updatePresetDisplay()` in
  `html/projectm-presets.js` on every preset switch). Everything else survives a loss on its own:
  the transferred canvas and its `#mcanvas` registration, the host's context config, and the PCM ring
  (`pcm_ring_init()` is idempotent for an unchanged capacity, so the descriptor stays valid; the
  worker re-publishes it anyway so a host that dropped its writer can map it again).
- `pm_handle_context_loss()` tears down every host whose context reports lost — the host that
  owns the canvas, not whichever host is active — and leaves it active so the restore path's
  `init()` / `start_render()` rebuild that host. It keeps the lost context's handle so `init()`
  can see the loss: while the context is still lost `init()` returns `5` and builds nothing (an
  engine made on the dead context would hold GL names that vanish on restore). `checkInit()`
  stays quiet for `5` and the context-loss overlay stays up until `webglcontextrestored`.
- `init()` also re-applies what the page had set on the engine it replaces — mesh size (or the
  governor tier's), aspect correction, preset lock, transparency mode/threshold, target fps and
  the governor tier's blur limits — so a restore does not silently fall back to defaults. The same
  applies after `rebind_canvases()`.
- `init()`'s "already initialized" early return now also checks that the engine's context is live
  and current; an engine left on a lost context is torn down and rebuilt.
- If `init()` fails during recovery for any other reason, the engine reports it through
  `pmReportInitError` (which drives the `#pm-init-error` overlay and its "Retry" button on a page
  that called `setupInitErrorHandling()`; that callback fires in the worker's scope in the worker
  topology, so there the page only sees the console error recovery logs) and the "Graphics paused"
  overlay stays up.

### Testing context loss

In Chrome DevTools: **More tools → Rendering → "Force WebGL Context Loss"** (or use the
WebGL Inspector extension) while a preset is running on `#mcanvas`. The canvas should freeze and
the "Graphics paused — tap to restore" overlay should appear. Triggering "Restore WebGL Context"
(or tapping the overlay) should resume rendering with the same preset within a second or two.
Do this on the default (`renderTopology: 'auto'`, i.e. worker) page as well as with
`?renderWorker=0`.

Automated, against a built bundle (loses the real context with `WEBGL_lose_context` — on the canvas
for `main`, inside the render worker for `worker` — and checks the overlay, the engine teardown and
the rebuild):

```bash
node scripts/test_context_loss_playwright.mjs cmake-build/wasm-smoke/projectm-v.030-thread.js [worker|main ...]
```

It exits `2` (not `0`) if the browser detects the loss but refuses to restore a synthetic one, as
headless Chromium does on some builds: recovery itself was not exercised then. The wire protocol and
the recovery logic are covered without a browser by `tests/web/projectm-render-worker.test.mjs`,
`tests/web/projectm-render-worker-host.test.mjs`, `tests/web/projectm-render-transport.test.mjs` and
`tests/web/projectm-context-loss.test.mjs`.

## Main Render Loop (`renderLoop()` → `render_frame()`)

`start_render(width, height)` registers `renderLoop()` as the Emscripten main
loop via `emscripten_set_main_loop()`. `renderLoop()` itself does not call
`projectm_opengl_render_frame()` — it delegates every frame to `render_frame()`
(also `EMSCRIPTEN_KEEPALIVE`-exported, used by the benchmark harness and tests).

`render_frame()` picks one of two paths:

- **Direct-to-canvas path** (steady state — the common case): when no preset
  crossfade is active, `render_frame()` calls `projectm_opengl_render_frame(pm)`
  straight to FBO 0 (the browser canvas), wrapped in a `RenderStateGuard`. This is
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
  renders straight to FBO 0, wrapped in a `RenderStateGuard` for parity with the
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

- ~~The `app_data.loading == EM_TRUE` early-return~~ — removed: presets are
  prepared on a pthread and activated at the top of `render_frame()`, so the
  loop keeps rendering the current preset while the next one loads (see
  [Preset loading](#preset-loading)).
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
  node scripts/capture_custom_milk_screenshots.mjs --preset presets/custom/milk012.milk
  ```

  `capture_report.json` includes `canvasMeanRgb`, `presetSwitchFailed`, and `consoleErrors` per
  preset; the script also prints warnings for a near-black mean (`<= 20`), a failed preset switch,
  or any captured console errors.

### Rebuilding the WASM smoke bundle

The capture script defaults to `cmake-build/wasm-smoke/projectm-v.030-thread.js`,
the output of `scripts/build_wasm.sh` (see [Building the bundle](#building-the-bundle)).
Nothing rebuilds it for you: a change to `src/wasm/` or the engine has **no effect on
screenshots until you rerun `scripts/build_wasm.sh`**.

#### Emscripten SDK version

**Use Emscripten SDK 6.0.6**, the version pinned by
`.github/workflows/build_emscripten.yml`, `graphics_perf_bench.yml` and
`nightly_preset_screenshots.yml`:

```bash
cd /path/to/emsdk
./emsdk install 6.0.6 && ./emsdk activate 6.0.6
source ./emsdk_env.sh   # required in every new shell before building
```

Why 6.0.6 (2026-09):

- It is what the product is actually built with. Bundle 037, the committed
  golden images and the `omp/omp.zip` libomp (6.0.3) all came from 6.0.x; CI was
  the only thing still on 3.1.53.
- 3.1.53 could no longer run CI at all. Building `llvmorg-19.1.0` libomp from
  source fails there (`z_Linux_util.cpp`: use of undeclared identifier
  `PAGESIZE`), so every run stopped before the smoke, golden and audio steps.
  That also rules out keeping 3.1.53 as a canary job.
- Verified on 6.0.6: from-source libomp builds; wrapper links; browser smoke
  (init, OpenMP 4 threads, cold load, dual-FBO soft cut, two instances,
  known-bad preset) passes; all 26 goldens match at ssim 1.00000.
- Unblocks JSPI (needs ≥ 3.1.58) and lets CI build the `-fwasm-exceptions`
  ABI the flags now default to.

An older note here said a newer SDK (5.0.4) rendered an all-black canvas for
every preset. That does not reproduce on 6.0.6 with the current source.

Emscripten 6.0.6 does not emit a separate `projectm-v.030-thread.worker.js`;
pthread workers load the main glue script.

To rebuild after changing `src/wasm/` (or projectM itself), then capture:

```bash
scripts/build_wasm.sh            # -> cmake-build/wasm-smoke/projectm-v.030-thread.{js,wasm}
node scripts/capture_custom_milk_screenshots.mjs --preset presets/custom/milk012.milk
# another build: PROJECTM_WASM_JS=<path to its .js> (the sibling .wasm is found
# automatically; legacy .1ijs/.ijs glue is accepted too)
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

`DualPingPongFramebuffer::DetectFormat()` (`src/wasm/WasmGraphics.hpp`) picks the format:

- Default: `RGBA16F` whenever it is renderable — WebGL 2 plus `EXT_color_buffer_float` *or*
  `EXT_color_buffer_half_float` (`fboPrecision: 'half'`). It is always filterable in WebGL 2.
- High precision opt-in: `fboPrecision: 'high'` (host JS reads `?fboPrecision=high`) uses `RGBA32F`
  when `EXT_color_buffer_float` is present. `RGBA32F` is only linearly filterable with
  `OES_texture_float_linear`; without it the textures are sampled `GL_NEAREST`, because a
  `GL_LINEAR` sampler on an unfilterable format leaves the texture incomplete and it samples as
  black (common on mobile/iOS GPUs). The compositor draws the FBOs 1:1, so nothing is lost.
- Force byte: `fboPrecision: 'byte'` pins `RGBA8` (debug the degraded path on a float-capable GPU)
- Fallback: `RGBA8` (degraded-mode banner in `html/projectm-fbo-format.js`), also where a float format
  ends up when its framebuffer turns out incomplete at the first transition (`CreateFBOWithFallback()`
  re-creates every surface as `RGBA8`; the compositor dithers that output, and the snapshot's
  `fboFormat` follows)

What any of these formats can hold is bounded by what goes in: the dual FBOs receive each preset's
finished frame, which libprojectM rendered through 8-bit feedback, warp and composite targets
(`ENABLE_HDR_RENDERING` is off in the WASM build). A float format keeps the crossfade from rounding a
second time; it does not remove the feedback banding of recursive presets, which happens upstream.

Before #258 the chain fell back to `RGBA32F` whenever `EXT_color_buffer_half_float` was missing,
even though `EXT_color_buffer_float` already makes `RGBA16F` renderable — doubling VRAM and
bandwidth for nothing — and always used `GL_LINEAR`.

One numbering covers both directions (`FboFloatFormat`): `create_host_with_config()`'s `fboPrecision`
argument and `dual_fbo_get_format()`'s result are both **0 = RGBA16F, 1 = RGBA32F, 2 = RGBA8**.
(The getter used to return 0 for RGBA32F and 1 for RGBA16F.)

The precision is set through `ProjectMContext`'s `fboPrecision` option / `create_host_with_config()`; the C++ side no
longer reads `?fboPrecision=` from the URL (see "WebGL context attributes" above). In the render
worker topology it travels in the worker's `init` message.

`RGBA32F` is 16 bytes/px against 8 for `RGBA16F`, across four surfaces (A_Read/A_Write,
B_Read/B_Write) — so the default halves both transition VRAM and compositor bandwidth during a
crossfade. Half-float's 10-bit mantissa is still well beyond what an 8-bit display resolves, so the
crossfade itself adds no rounding on float-capable GPUs.

Because the saving is on the transition path only, measure it with the crossfade-gated benchmark
(`?benchmark=1&crossfade=1`, see [docs/PERFORMANCE.md](PERFORMANCE.md)) — a steady-state
`?benchmark=1` run never composites the Preset B surfaces and will show no difference.
`scripts/capture_fbo_precision_benchmark.mjs` drives both variants against one build and writes
the before/after JSON pair to `benchmark-results/`.

## Initializing Emscripten's OpenGL Context

There is nothing to initialize by hand: `WasmWebGLCreateAndActivateContext()`
(`src/wasm/WasmWebGLContext.cpp`) creates the WebGL 2 context with `emscripten_webgl_create_context()` and enables
the extensions projectM needs. Float *textures* are core in WebGL 2; rendering to them needs `EXT_color_buffer_float`
(and `EXT_float_blend` to blend into `RGBA32F`). The WebGL 1 names (`OES_texture_float` and friends) do not exist on a
WebGL 2 context and are not used. What was negotiated is readable from JS afterwards:
[Reading what was negotiated](#reading-what-was-negotiated).
