# Performance Profiling and Benchmarking

This document covers the frame-time profiling HUD and headless benchmark mode added to the
Emscripten/WASM build, and how to use them to compare WASM performance against a native Linux
build of the same projectM tree.

This is the measurement infrastructure referenced by issue #80. The numbers it produces are meant
to turn "seems faster/slower" into data, and to rank the remaining WASM optimization issues
(#81–#85) by actual impact.

## CPU frame-time breakdown (`projectm_perf.h`)

`src/api/include/projectM-4/projectm_perf.h` exposes a small, process-global, opt-in profiling
API:

```c
void projectm_perf_set_enabled(bool enabled);
bool projectm_perf_is_enabled();
void projectm_perf_get_frame_timings(projectm_perf_frame_timings* out_timings);
```

`projectm_perf_frame_timings` reports CPU time (in milliseconds) for the most recently rendered
frame, broken down into:

| Field | Stage |
|---|---|
| `audio_analysis_ms` | `PCM::UpdateFrameAudioData()` — FFT (`MilkdropFFT.cpp`) + loudness (`Loudness.cpp`) analysis. |
| `per_frame_eval_ms` | Per-frame equation evaluation (`PerFrameUpdate()`, projectm-eval). |
| `per_pixel_eval_ms` | Per-pixel mesh evaluation and warp draw (`PerPixelMesh::Draw`, `PerPixelContext`). **This bucket covers two different kinds of work,** so always read `per_pixel_eval_path` (`perPixelEvalPath` in the benchmark JSON, `Per-pixel/warp [gpu\|cpu]` in the HUD) beside it. On the CPU path it is `projectm-eval` over every warp mesh vertex (OpenMP in WASM); on the GPU path the equations were compiled into the warp vertex shader (#227 Phase 1, [`GPU_PERPIXEL_EVAL.md`](GPU_PERPIXEL_EVAL.md)) and only the uniform upload and draw submit remain. Two measurements are comparable only when the path matches — `?perPixelEval=cpu` forces the CPU side of that A/B. |
| `blur_ms` | Blur texture chain update. |
| `waveforms_shapes_ms` | Custom shapes, custom waveforms, built-in waveform, darken center, border. |
| `composite_ms` | Final compositing pass and associated texture flips. |
| `total_ms` | Whole `ProjectM::RenderFrame()` call (includes the above plus GL driver overhead / untimed stages). |
| `fps` | `1000 / total_ms`. |

Timers are implemented as cheap RAII scopes (`PROJECTM_PERF_SCOPE`, see
`src/libprojectM/PerfTimers.hpp`) around each stage in `ProjectM::RenderFrame()` and
`MilkdropPreset::RenderFrame()`. When `projectm_perf_set_enabled(false)` (the default), every
timer is a single boolean check — no clock calls, no measurable overhead.

## GPU timing

The WASM build additionally measures GPU time for the whole `render_frame()` call using the
`EXT_disjoint_timer_query_webgl2` extension, when available (`js_perf_gpu_begin_frame` /
`js_perf_gpu_end_frame` in `projectM_emscripten.cpp`). GPU results arrive asynchronously (usually
1–2 frames later) and are reported as `gpuMs` in the per-frame stats; if the extension isn't
available (e.g. on some mobile browsers), `gpuMs` is reported as `-1` ("n/a" in the HUD).

## On-screen HUD

Call `Module._set_perf_hud(1)` to enable both the CPU/GPU timers and an on-screen HUD
(`#pm-perf-hud`, top-right corner) showing FPS, total frame time, and a bar for each of the
buckets above (CPU buckets + GPU). Call `Module._set_perf_hud(0)` to disable both.

In `html/projectm-core.html`, append `?perfhud=1` to the page URL to enable the HUD on load.

The HUD implementation lives in `html/projectm-perf.js` (`setupPerfTools()`), which also wires up
the `window.pmOnPerfFrame` / `window.pmSetPerfHudEnabled` hooks called from C++.

## Headless benchmark mode

> **Full preset benchmark guide:** [`docs/BENCHMARKING.md`](BENCHMARKING.md) — `optimize.sh --bench`,
> curated manifest, native parse/audio/OpenMP modes, before/after baselines.
>
> **Reproducible frames and the regression gates:**
> [`docs/GRAPHICS_BENCHMARK_HARNESS.md`](GRAPHICS_BENCHMARK_HARNESS.md) — deterministic
> capture (pinned RNG, virtual clock, frame-exact audio), the golden-image gate on
> software GL, and the relative p95 frame-budget gate on a GPU runner. Read it before
> quoting any figure in this document as measured: numbers taken under a software
> rasterizer, or across two runners, are not comparable and the tooling refuses to
> gate on them.

Append the following query parameters to `projectm-core.html`:

```
?benchmark=1&frames=500&preset=/presets/some_preset.milk
```

- `benchmark=1` — required to enable benchmark mode.
- `frames` — number of frames to sample (default 500).
- `preset` — optional VFS path to a preset to load before sampling (via
  `Module.ccall('load_preset_file', ...)`). If omitted, the currently active/idle preset is used.
- `crossfade=1` — sample **only frames rendered during an active soft-cut crossfade** (see below).
- `crossfadeSec` — crossfade duration in seconds when `crossfade=1` (default 20).
- `crossfadePresets` — comma-separated preset paths to cycle through in crossfade mode. Defaults
  to `?preset=` if given, otherwise the first two featured-pack presets.

Once `frames` samples have been collected, `projectm-perf.js`:

1. Logs a JSON summary to the console, prefixed with `[projectM benchmark]`.
2. Posts the same object via `window.postMessage({ type: 'pm-benchmark-result', result }, '*')`,
   so an automated test harness (e.g. Puppeteer/Playwright) can capture it without scraping the
   console.

### Benchmarking the transition path (`crossfade=1`)

A default `?benchmark=1` run samples steady-state frames, which never touch the Preset B
FBOs. Anything that only affects preset transitions — dual-FBO color format, compositor
bandwidth, crossfade blend cost — is invisible in such a run and must not be measured with one.

`&crossfade=1` keeps a soft cut running for the whole sampling window: `projectm-perf.js` loads
the next preset whenever the previous blend finishes, and discards every frame where
`transition_is_active()` is false. `frames` therefore counts in-crossfade frames only, so a run
takes longer in wall-clock time than the equivalent steady-state run.

To A/B the dual-FBO color format on the same build (RGBA16F default vs. `?fboPrecision=high`):

```
?benchmark=1&crossfade=1&frames=300&crossfadeSec=20
?benchmark=1&crossfade=1&frames=300&crossfadeSec=20&fboPrecision=high
```

The result JSON records `fboFormat` (`"RGBA16F"` / `"RGBA32F"` / `"RGBA8"`) and a `crossfade`
object, so the two captures are self-identifying. Compare `gpuMs` and `compositeMs`.

To run both captures unattended against a local build, use the Playwright wrapper — it serves the
repo, points `projectm-core.html` at the bundle you pass it, runs both variants, and writes
`benchmark-results/fbo-precision-{rgba16f-default,rgba32f-high}.json` plus a median-delta
`fbo-precision-comparison.json`:

```sh
npm install --no-save playwright   # once
npx playwright install chromium    # once
node scripts/capture_fbo_precision_benchmark.mjs cmake-build/wasm-smoke/projectm-v.030-thread.js
```

The script fails the run if a capture comes back without the `crossfade` marker, and warns when a
variant did not get the format it asked for (an `RGBA8` result means the GPU/browser reports no
float color-buffer support at all, which makes the A/B meaningless). Run it on real GPU hardware:
under SwiftShader the frame is CPU-bound and the bandwidth difference will not appear in `gpuMs`.

### Sample output

```json
{
  "frames": 500,
  "preset": "/presets/Geiss - Threads That Move - Pong With Strobe Light.milk",
  "totalMs": { "mean": 14.82, "median": 14.51, "p95": 18.93, "min": 12.04, "max": 24.71 },
  "fps": { "mean": 67.5, "median": 68.9, "p95": 52.8, "min": 40.5, "max": 83.1 },
  "breakdownMs": {
    "audioMs": { "mean": 0.42, "median": 0.40, "p95": 0.61, "min": 0.31, "max": 0.88 },
    "perFrameEvalMs": { "mean": 0.18, "median": 0.17, "p95": 0.27, "min": 0.12, "max": 0.39 },
    "perPixelEvalMs": { "mean": 4.93, "median": 4.81, "p95": 6.42, "min": 3.95, "max": 8.10 },
    "blurMs": { "mean": 1.21, "median": 1.18, "p95": 1.69, "min": 0.92, "max": 2.05 },
    "waveformsShapesMs": { "mean": 0.86, "median": 0.83, "p95": 1.22, "min": 0.61, "max": 1.74 },
    "compositeMs": { "mean": 1.55, "median": 1.50, "p95": 2.11, "min": 1.10, "max": 3.02 },
    "gpuMs": { "mean": 5.62, "median": 5.40, "p95": 7.88, "min": 4.20, "max": 11.30 }
  }
}
```

> The values above are illustrative only (hand-written to show the expected shape of the report);
> they were not captured from a real run. See "Verification performed" in the PR description for
> what was actually measured.

## Graphics ablation switches

Per-stage `breakdownMs` buckets are CPU submit time, so they cannot rank GPU stages against
each other (see [`GRAPHICS_PERF_RECOVERY_PLAN.md`](GRAPHICS_PERF_RECOVERY_PLAN.md)). The way
to size a graphics change is to A/B it against the old behaviour **on the same build** and
diff `gpuMs`/`totalMs` from two otherwise identical `?benchmark=1` runs.

| Switch | WASM | Native | Effect |
|--------|------|--------|--------|
| Blur path | `?blurPath=copy` | `PROJECTM_BLUR_COPY_PATH=1` | Restores the pre-#177 blur chain: each pass renders into a shared scratch attachment and is copied out with `glCopyTexSubImage2D`. Default (unset) renders each pass straight into its blur texture. |
| Texture copy path | `?copyPath=shader` | `PROJECTM_COPY_SHADER_PATH=1` | Restores the pre-#179 copy path: every `CopyTexture` resolve is a fullscreen textured quad. Default (unset) resolves the plain and Y-flipped copies with `glBlitFramebuffer` where the blit is equivalent (no blending, viewport covers the target, source format is color-renderable) and falls back to the quad otherwise. |
| Dual-FBO precision | `?fboPrecision=high` | — | Uses RGBA32F for the WASM compositor instead of the RGBA16F default (GL_NEAREST sampling without `OES_texture_float_linear`). |
| Mesh size | `?meshQuality=low` | — | 64×48 instead of the 80×60 default (a 1.56× vertex-count ratio). |
| Canvas MSAA | `?aa=1` (or `localStorage.canvasAA='1'`) | — | Opts into `antialias:true`; default (unset) is now `false` (governor v2, issue #178). |

The page reads the WASM switches and hands them to the module: `?blurPath`, `?copyPath` and
`?perPixelEval` through `set_render_path_overrides()` (`ProjectMContext`'s `renderPathOverrides`
option, defaulting to the page's query string), `?fboPrecision` through `set_context_config()`.
Both travel in the render worker's `init` message. Until #258 the C++ side read the first three
from `globalThis.location.search`, which inside the render worker is the worker script's URL — so
in the default topology every one of them was silently a no-op. The worker's `stats` message
reports `renderPathOverrides` (the mask `get_render_path_overrides()` reads back: 1 blur copy,
2 copy shader, 4 per-pixel CPU) so a run can confirm the switch landed.

The blur and copy switches are read once, at engine init: the blur render path is decided on
the first blurred frame and then cached, and the copy path is latched the first time a copy
runs. Changing either mid-session has no effect.

> The copy switch only moves presets that still pay a fullscreen flip. Presets using the
> default warp shader already skip the pre-warp copy entirely (#176), and presets **with** a
> composite shader skip the third flip — so the largest A/B delta is expected on an
> old-school preset with a custom warp shader and no composite shader, which pays all three.

> When A/B'ing the blur path, expect `blurMs` to move much further than `totalMs` does.
> `glCopyTexSubImage2D` is one of the few calls in the frame that can force CPU-visible
> ordering, so it inflates that CPU-side bucket out of proportion to its real frame cost.
> Judge the change on `gpuMs`/`totalMs`, not on `blurMs`.

## Native vs. WASM comparison

To answer "are we at desktop parity?", build the native SDL2 test UI from the same source tree and
run the same preset(s):

```sh
cmake -B build-native -DENABLE_SDL_UI=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build-native --target projectMSDL -j
./build-native/src/sdl-test-ui/projectMSDL
```

`projectMSDL` tracks an FPS counter (`projectMSDL::fps()` in `src/sdl-test-ui/pmSDL.cpp`) that can
be logged the same way. For an apples-to-apples comparison:

1. Pick a small, fixed set of presets (ideally ones already used by the WASM preset-compatibility
   harness).
2. For each preset, run both builds at the same window/canvas resolution for the same wall-clock
   duration (or frame count) and record FPS / frame time.
3. Fill in the table below.

| Preset | Native FPS (`projectMSDL`) | Native frame time (ms) | WASM FPS (`?benchmark=1`) | WASM frame time (ms) | WASM/Native ratio |
|---|---|---|---|---|---|
| _preset 1_ | | | | | |
| _preset 2_ | | | | | |
| _preset 3_ | | | | | |

A ratio close to 1.0 indicates WASM parity for that preset. Large gaps, combined with the
`breakdownMs` data above, point at which stage (per-pixel eval, blur, composite, GPU, etc.) to
target next — i.e. how to prioritize #81–#85.

## Mesh resolution and parallel per-pixel evaluation

The per-vertex ("per-pixel") equations (`q1..q32`, `x`/`y`/`rad`/`ang`/`zoom`/`rot`/`warp`/etc.)
are evaluated once per mesh vertex per frame via `PerPixelMesh::CalculateMesh()` /
`PerPixelContext`. The default mesh size (`ProjectM::m_meshX` / `m_meshY` in `ProjectM.hpp`) is
now **80×60** (4961 vertices), up from the previous 48×36 (1728 vertices), improving
warp/zoom/rotation fidelity. The adaptive governor's regular tier is **64×48**
(3073 vertices).

To keep this affordable on the additional ~2.3x vertices, `PerPixelMesh::CalculateMesh()` runs the
per-pixel evaluation loop with `#pragma omp parallel for` when built with `ENABLE_OPENMP=ON`.
The replacement for that loop — compiling `per_pixel_*` to a GLSL vertex snippet on WebGL2,
with a CPU fallback — is [#227](https://github.com/ford442/Project-M/issues/227) Phase 1;
see [`GPU_PERPIXEL_EVAL.md`](GPU_PERPIXEL_EVAL.md). **It has landed**: 186 of the 241 presets
in this tree with per-pixel code now evaluate their equations in the warp vertex shader, and
the rest keep the OpenMP loop with a recorded reason. Its speed has **not** been measured — the
verification ran on a software rasterizer — so until a `?benchmark=1` session on a real device
says otherwise, governor v2 and OpenMP are still the levers you can quote numbers for.
Since `projectm-eval` contexts are not re-entrant (see
`vendor/projectm-eval/docs/Memory-Handling.md`), `MilkdropPreset` maintains a pool of one
`PerPixelContext` per extra OpenMP worker thread (`m_perPixelContextPool`), each compiled with the
same per-pixel code and sharing the preset's `gmegabuf`/`reg00-99` storage
(`PresetState::globalMemory` / `globalRegisters`). Access to that shared storage is now protected
by a real mutex in `EvalLibMutex.cpp` (previously a no-op), avoiding heap corruption in
`MemoryBuffer.c` when multiple threads read/write `gmegabuf` concurrently. Per-frame read-only
variables and `q1..q32` are broadcast to the pool contexts once per frame via
`PerPixelContext::CopyFrameStateFrom()` — O(thread count), not O(vertex count).

### Quality setting

`projectm_set_mesh_size(instance, width, height)` (WASM: `Module._set_mesh(width, height)`) can be
used to change the mesh resolution at runtime. `html/projectm-mesh-quality.js` wires this up in
`projectm-core.html`:

- `'high'` → 80×60 (default)
- `'low'` → 64×48 (regular tier; used as the fallback on `navigator.hardwareConcurrency < 8`)
- `'auto'` (default) picks between the two based on `navigator.hardwareConcurrency`
  (devices with fewer than 8 logical cores start at `'low'`)

The choice is persisted in `localStorage.meshQuality` and can be overridden per page load with
`?meshQuality=high|low|auto`, or changed at runtime via the `setQuality(quality)` that
`setupMeshQuality()` returns (pages that import `html/projectm-legacy-globals.js` and call
`exposeMeshQualityGlobals()` also get it as `window.pmSetMeshQuality(quality)`).

### Verification performed

- Native build with `cmake -B cmake-build-openmp -DENABLE_OPENMP=ON -DENABLE_SDL_UI=OFF
  -DBUILD_TESTING=OFF -DCMAKE_BUILD_TYPE=Release` configures with OpenMP 4.5 enabled and builds
  `projectM`/`projectM_playlist` cleanly with the 48×36 default and the parallel per-pixel loop.
- **Not yet measured in this environment** (no GPU/display available): actual frame times for
  48×36 vs. 32×24 via the `?benchmark=1` harness described above. Given the per-pixel loop is
  embarrassingly parallel and scales with `omp_get_max_threads()`, the expected frame-time
  increase from the ~2.3x vertex count is sub-linear on multi-core hardware, but this should be
  confirmed with real `breakdownMs.perPixelEvalMs` numbers (32×24 vs. 48×36, OpenMP on/off) before
  relying on it for low-end device targeting.

## 60 FPS default and adaptive quality governor

Original Winamp Milkdrop targets 60 FPS and lets quality settings absorb load instead of letting
the frame rate drop. Previously, `ProjectM::m_targetFps` defaulted to **35**, and was also used
directly as the `fps` value passed to presets (`ctx.fps` in `GetRenderContext()`), regardless of
the actually achieved frame rate. Presets that use `fps` for per-frame time-step compensation
(e.g. `q1 = 1/fps`-style expressions in `per_frame`/`per_pixel`/`per_frame_init` equations) would
therefore animate at the wrong speed whenever the real frame rate diverged from 35.

### `m_targetFps` vs. `m_measuredFps`

- `ProjectM::m_targetFps` (`ProjectM.hpp`) now defaults to **60**. It remains a purely
  informational target — read/write via `TargetFramesPerSecond()` /
  `SetTargetFramesPerSecond()` — and on WASM also sets the adaptive governor's frame-time budget
  (`1000 / targetFps`).
- A new `ProjectM::m_measuredFps` (`ProjectM.hpp`) holds an exponentially-smoothed (smoothing
  factor 0.1, clamped to [1, 1000] fps) measurement of the actual frame time, computed in
  `RenderFrame()` from `TimeKeeper::SecondsSinceLastFrame()`.
- `GetRenderContext()` now sets `ctx.fps = m_measuredFps` (previously `m_targetFps`), so the `fps`
  preset variable — and therefore `time`/`frame` time-step compensation that depends on it —
  reflects the actually achieved frame rate.

### Render loop cadence (WASM)

`start_render()` registers `renderLoop()` with
`emscripten_set_main_loop(renderLoop, 0, 0)` and
`emscripten_set_main_loop_timing(EM_TIMING_RAF, 1)` (`WasmRenderLoop.cpp`): one frame per
`requestAnimationFrame`, i.e. vsync-aligned, never rendering frames the compositor will not show,
and throttled by the browser in a background tab.

Until #258 the call was `emscripten_set_main_loop_timing(2, 1)` — `2` is
`EM_TIMING_SETIMMEDIATE`, not `EM_TIMING_RAF` (`1`) — while this section claimed rAF pacing. The
main-thread loop (`?renderWorker=0`, and every browser that falls back from the worker topology)
spun as fast as Emscripten's postMessage shim allowed, so FPS numbers recorded on that path, and the
governor's decisions, measured a spin loop. Compare nothing against main-thread numbers taken
before that fix.

The WASM smoke (`tests/wasm-smoke/index.html`, `checkMainLoopPacing()`) now guards it: it reads the
mode back with `get_main_loop_timing_mode()` (an internal test export; SwiftShader frames cost more
than a refresh, so the frame rate alone cannot tell the two modes apart there) and also bounds the
frame rate at 250/s over 2 s, which catches a spin loop on a real GPU. The render worker and the
deterministic harness pause this loop and drive `render_frame()` themselves, so they are unaffected.

`emscripten_request_animation_frame_loop` was considered but not adopted — `emscripten_set_main_loop`
+ `EM_TIMING_RAF` already gives rAF-paced callbacks without the lifecycle changes switching would
require.

### Adaptive quality governor (WASM, v1)

Implemented in `WasmPerfGovernor.cpp` as `UpdateQualityGovernor()`, called once per frame from
`renderLoop()` (`WasmRenderLoop.cpp`) with the wall-clock time of the whole render (measured via `emscripten_get_now()`,
always-on, independent of `g_perfHudEnabled`). v1 is intentionally minimal — it only steps the
per-pixel mesh resolution between two tiers (matching `html/projectm-mesh-quality.js`):

- **Tier 0 (high)**: 80×60 mesh.
- **Tier 1 (regular)**: 64×48 mesh.

Thresholds, relative to a budget of `1000 / targetFps` ms (≈16.7 ms at the default 60 fps):

- **Step down** a tier after **15 consecutive frames** (~0.25 s @ 60 fps) where the frame time
  exceeds **1.3×** budget (~21.7 ms).
- **Step up** a tier after **90 consecutive frames** (~1.5 s @ 60 fps) where the frame time is
  under **0.8×** budget (~13.3 ms).
- The frame that switches to a newly loaded preset carries its GL compile and link, so it and the
  **10 frames** after it are excluded from both counters (`ActivatePreparedPreset()` starts the
  grace), and a single slow preset compile cannot trigger a permanent downgrade. Frames rendered
  while the next preset is being prepared count normally: the preparation runs on the host's
  prepare thread and the loop keeps drawing the current preset (it used to skip those frames).

On startup, the governor's tier is lazily synced from whatever mesh size
`html/projectm-mesh-quality.js` already applied (`projectm_get_mesh_size`), so the two systems
don't fight each other.

Full multi-subsystem governance (blur passes, FBO resolution, etc.) is out of scope for v1 — see
`html/projectm-fps-governor.js` and `UpdateQualityGovernor()` for where to extend it.

### Adaptive quality governor (WASM, v2)

v2 (issue #178, see [`GRAPHICS_PERF_RECOVERY_PLAN.md`](GRAPHICS_PERF_RECOVERY_PLAN.md)) replaces
the mesh-only stepping above with **three tiers that step three fill/eval-cost axes together**,
because mesh-only stepping does not recover FPS on fill-bound (fullscreen-pass-heavy) devices —
per-pixel mesh is CPU eval cost, but the dual-FBO compositor, blur chain, and MSAA resolve are GPU
fill-rate cost, and `perPixelEvalMs` is the only trustworthy per-stage bucket (see
[Measurement](#measurement-what-the-hud-can-and-cannot-tell-you) in the recovery plan). The
hysteresis (over/under-budget frame thresholds, post-load grace) is unchanged from v1 — only what
a "step down" / "step up" applies has changed.

| Tier | Mesh | Blur cap | Internal render scale | Blur-texture resolution scale |
|------|------|----------|------------------------|--------------------------------|
| 0 (high) | 80×60 | uncapped | 1.0 | 1.0 |
| 1 (regular) | 64×48 | Blur2 | 0.75 | 0.6 |
| 2 (low) | 48×36 | Blur1 | 0.5 | 0.4 |

**Blur-texture resolution scale** (`kQualityTiers[].blurResolutionScale`) is issue #177's
"optionally downscale early blur levels more aggressively when governor v2 requests a blur
tier" item, coordinated here. It's a second, independent knob from the internal render
scale column: blur is a low-frequency effect and tolerates more aggressive downscaling
than the main scene without a visible quality loss, so each tier's blur-texture scale is
set lower than its render scale. Flows through `ProjectM::SetBlurResolutionScale()` →
`RenderContext::blurResolutionScale` → `BlurTexture::SetResolutionScale()`, applied as an
extra multiplier on the source size `AllocateTextures()` progressively halves per level —
purely internal to the WASM module, no host wiring needed (unlike the render-scale tier).
Public C API: `projectm_set_blur_resolution_scale()`/`projectm_get_blur_resolution_scale()`.

**Blur cap** (`kQualityTiers[].maxBlurLevel` in `WasmPerfGovernor.cpp`) flows through
`ProjectM::SetMaxBlurLevel()` → `Renderer::RenderContext::maxBlurLevel` →
`BlurTexture::SetLevelCap()`, set once per frame in `MilkdropPreset::RenderFrame()` before
`blurTexture.Update()`. `BlurTexture::EffectiveLevel()` clamps the pass count in `Update()` and the
descriptor/bind lists in `GetDescriptorsForBlurLevel()`/`Bind()`, so a preset requesting Blur3 under
a Blur1 cap simply doesn't render or sample its Blur2/Blur3 textures that frame — no stale-texture
sampling, no crash, just fewer blur passes. Public C API: `projectm_set_max_blur_level()` /
`projectm_get_max_blur_level()` (`-1` = uncapped, else 0-3).

**Internal render scale** (`kQualityTiers[].renderScale`) is **not** a separate offscreen FBO + blit.
Every WASM FBO (`MilkdropPreset`'s ping-pong pair, the dual-FBO compositor, blur textures) is already
sized from the canvas backing-store resolution (`ProjectM::m_windowWidth/m_windowHeight`, driven by
`set_window_size()`), and the canvas's CSS box size is tracked independently
(`canvas.style.width`/`height`). So shrinking the **backing store**
(`canvas.width`/`canvas.height`) while leaving the CSS box unchanged makes every FBO in the pipeline
render at the reduced resolution "for free" — including halving dual-FBO transition bandwidth at
tier 2 — and the browser's own canvas-bitmap-to-CSS-box scaling does the "present upscale", the same
technique many canvas-based games use for dynamic resolution scaling. This is why the render-scale
tier is a **host** responsibility (see `docs/WASM_JS_API.md#governor-v2-host-callbacks-push-vs-getters`):
`html/projectm-fps-governor.js`'s `setupFpsGovernor(Module, { onRenderScaleChange })` wires
`window.pmOnGovernorRenderScaleChange`, and `html/projectm-context.js`'s `syncCanvasSize()` /
`html/projectm-core.html`'s `syncModuleSize()` (via `pmContext`) apply it. The
render-worker topology applies the same factor to the `OffscreenCanvas` it owns, via the
`globalThis.pmOnGovernorRenderScaleChange` hook installed in
`html/projectm-render-worker.js` — the C++ push reaches both topologies unchanged.

New exports (`WasmPerfGovernor.cpp`, `cmake/WasmApiManifest.cmake`):

- `Module._get_governor_render_scale()` — current tier's render scale (pull; `js_governor_report_render_scale()` is the push counterpart, firing `window.pmOnGovernorRenderScaleChange(scale)`).
- `Module._get_governor_blur_cap()` — current tier's blur cap (pull; push counterpart fires `window.pmOnGovernorBlurCapChange(cap)`).
- `Module._get_quality_tier()` unchanged in signature, now returns 0-2 instead of 0-1.

**Canvas MSAA policy**: `attrs.antialias` now defaults to `false` (see `docs/EMSCRIPTEN.md` §WebGL
context attributes) — opt in with `?aa=1` / `localStorage.canvasAA='1'`. Independent of the tier
governor (a build-time-adjacent context attribute, not something that can be changed after context
creation), but grouped into v2 because it targets the same GPU fill-rate budget.

**Ablation for A/B**: force a tier for benchmarking by disabling the governor
(`?governor=0`) and driving the pieces manually — `?meshQuality=low` (mesh),
`Module._set_mesh(48, 36)` (lowest mesh tier, no `?meshQuality` equivalent yet), and comparing
`?aa=1` vs. default for MSAA. There is no manual render-scale override independent of the governor
tiers today (render scale isn't a standalone preset-visible concept the way mesh/blur are) — to A/B
it, compare `gpuMs`/`totalMs` with the governor forced into tier 2 (sustained artificial load) against
tier 0.

**Not measured in this environment** (no browser/GPU): whether the render-scale tier actually
recovers FPS faster than mesh-only stepping on a fill-bound preset, whether the blur-cap tier
produces a visible "frozen" higher-level blur on presets that lean on `sampler_blur3`, and whether
`antialias:false` is visually acceptable on the sprite-drawing paths. All three should be verified
with `?benchmark=1` and `?perfhud=1` on real hardware per the recovery plan's measurement protocol
before this is called done for issue #178's acceptance criteria.

### Exported controls

New WASM exports (`projectM_emscripten.cpp`, wired up in `CMakeLists.txt` and
`scripts/build_wasm_smoke_wrapper.sh`):

- `Module._set_target_fps(fps)` — sets `m_targetFps` (`projectm_set_fps`) and the governor's
  budget reference. Resets the governor's consecutive-frame counters.
- `Module._set_quality_governor(enabled)` — enables/disables automatic tier changes without
  affecting the current tier.
- `Module._get_quality_tier()` — returns the current tier (0 = high/80×60, 1 = regular/64×48).

`html/projectm-fps-governor.js` (`setupFpsGovernor(Module)`, called from `projectm-core.html`)
applies `?targetFps=`/`?governor=0|1` query params or `localStorage.targetFps` /
`localStorage.qualityGovernor` (guarded: a sandboxed iframe whose `localStorage` throws still
boots), and returns `setTargetFps(fps)`, `setQualityGovernorEnabled(enabled)`, `getQualityTier()`,
`getRenderScale()`, `getBlurCap()` and `dispose()` for host UIs. It writes nothing to `window`;
pages whose inline handlers still call `window.pmSetTargetFps(fps)`,
`window.pmSetQualityGovernorEnabled(enabled)` or `window.pmGetQualityTier()` opt in through
`exposeGovernorGlobals()` in `html/projectm-legacy-globals.js`.
`window.pmOnGovernorTierChange(tier)`, if defined by the host page, is called whenever the
governor changes tiers — that name is an engine callback, see "Page globals" in `html/README.md`.

### Native build

The native (SDL) build's default also changed from 35 to 60 via the shared `m_targetFps{60}`
default in `ProjectM.hpp` — there is no separate native code path for this value, so no
"keep 35 for native" divergence was introduced. The adaptive quality governor itself is WASM-only
(`projectM_emscripten.cpp`); the native build is unaffected beyond the `m_targetFps`/`ctx.fps`
changes described above.

### Verification performed

- Native build (`cmake --build cmake-build-openmp --target projectM projectM_playlist`) succeeds
  with the `m_targetFps`/`m_measuredFps` changes.
- `projectM_emscripten.cpp` syntax-checks cleanly with `em++ -fsyntax-only` (only the 4
  pre-existing unrelated "empty character constant" warnings from embedded JS string literals
  remain).
- **Not yet measured in this environment** (no browser/display available): the `fps` preset
  variable converging to ~60 on desktop Chrome, and the governor stepping down under artificial
  load (e.g. forcing a 64×48 mesh via `Module._set_mesh(64, 48)`). Both should be checked manually
  with `?perfhud=1` once a display is available — `pmGetQualityTier()` and
  `window.pmOnGovernorTierChange` make the governor's state observable from the page.

## Preset shader transpile cache (IndexedDB)

Repeat preset visits previously re-ran HLSL parse/transpile and `glCompileShader` on every
session. The audit in `docs/DETAILED_AUDIT_REPORT.md` estimated **50–200 ms** savings per
revisit on mid-tier mobile from caching transpiled GLSL (compile/link still runs each session
because WebGL program binaries are not portable across context loss).

### What is cached

| Layer | Store (IndexedDB) | Key | Invalidation |
|---|---|---|---|
| `.milk` bytes | `presets` | `{base}::{file}` | Manual / quota LRU (bytes only) |
| Transpiled GLSL (warp + composite) | `shaders` | `shader::{wasmVer}::{glslVer}::{sha256}` | WASM bundle bump (`PROJECTM_WASM_VERSION`), GLSL generator version change, LRU eviction |

`PROJECTM_WASM_VERSION` lives in `html/projectm-wasm-version.js`. The GLSL generator version
comes from `Module._get_glsl_generator_version()` (GLES vs desktop shader headers). On engine
version change, `localStorage.projectm:shaderCacheEngineVersion` mismatch clears the `shaders`
store automatically.

**Not cached:** `WEBGL_get_program_binary` / `getProgramBinary` program blobs (browser support
is limited). Transpiled GLSL is the portable win; true program-binary caching remains a possible
future enhancement.

### C++ / WASM hooks

`MilkdropShader::TranspileHLSLShader()` consults `Renderer::ShaderTranspileCache` before
calling `ShaderTranspiler::TranspileToGlsl()`. On a miss it transpiles, stores via a host
callback, then compiles. Stale cache entries that fail `glCompileShader` fall back to a fresh
transpile.

Emscripten exports (see `cmake/WasmApiManifest.cmake`):

- `_shader_cache_begin_load(key)` — set per-load cache key
- `_shader_cache_import_glsl(type, glsl)` — inject cached warp (`0`) or composite (`1`) GLSL
- `_shader_cache_end_load()` — clear key after load
- `_get_glsl_generator_version()` — cache-key component for JS

`WasmShaderCache.cpp` forwards stored GLSL to JS via `window.pmOnTranspiledShaderStored`.

### JavaScript modules

- `html/projectm-shader-cache.js` — SHA-256 content hash, IDB read/write, LRU eviction
  (96 entries / 48 MiB default caps), `prepareShaderCacheForLoad()` /
  `finalizeShaderCacheForLoad()` wrappers
- `html/projectm-preset-cache.js` — shared DB `projectm-preset-cache` v2 (`presets` +
  `shaders` stores); `preloadFeaturedPack()` and new `preloadFavoritePresets()` for Signature
  Series / user favorites
- `html/projectm-preset-library.js` — `loadPresetEntry()` caches fetched bytes, warms shader
  cache before `loadPresetFile()`, persists new transpile output after load

### Measuring cold vs warm preset switch

Append to `projectm-core.html`:

```
?presetSwitchBench=1
```

`html/projectm-perf.js` loads the first three featured-pack presets twice each (cold then warm)
and logs JSON prefixed with `[projectM preset-switch benchmark]`, also posting
`{ type: 'pm-preset-switch-benchmark', result }` for Playwright harnesses.

Example shape (values illustrative until measured on target hardware):

```json
{
  "presets": [
    { "preset": "Signature Series | …", "coldMs": 142, "warmMs": 38, "savedMs": 104 }
  ],
  "timestamp": "2026-07-18T12:00:00.000Z"
}
```

Warm savings are dominated by skipping HLSL parse/transpile; `glCompileShader` + link still run.

### Verification performed

- Native `projectM` build with `ShaderTranspileCache` + `MilkdropShader` hook compiles cleanly.
- `node --check` on `html/projectm-shader-cache.js`, `html/projectm-preset-cache.js`,
  `html/projectm-perf.js`.
- **Not measured in this environment** (no browser): actual cold/warm ms on mid-tier mobile;
  run `?presetSwitchBench=1` on a device after deploying a WASM build that includes the new
  exports.

## Emscripten link/compile flag audit (issue #80 follow-up)

This section evaluates the Emscripten compile/link flags in `CMakeLists.txt` (`ENABLE_EMSCRIPTEN`
block, roughly lines 143–222) and the equivalent flags duplicated in
`scripts/build_wasm_smoke_wrapper.sh`, `scripts/build_projectm.sh`, and `scripts/colab_build.sh` —
the three scripts that perform the final `emcc projectM_emscripten.cpp ... -o
projectm-v.030-thread.js` link against the prebuilt `libprojectM-4.a` /
`libprojectM-4-playlist.a` static libraries.

**Methodology**: this environment has no browser/display, so frame-time (p50/p95) and startup
time cannot be measured directly (same limitation as the rest of this document). What *can* be
measured headlessly via `scripts/build_wasm_smoke_wrapper.sh`:

- Build success/failure (at the time including compatibility with `ENABLE_WASM_TRANSITIONS`'s
  `ASYNCIFY_STACK_SIZE` tuning; the build has no ASYNCIFY any more).
- Output `.wasm` and `.js` file sizes (smaller artifacts download and parse/instantiate faster,
  particularly relevant to startup time).
- Wall-clock build/link time.

Baseline (`Emscripten 5.0.4`, current `main`, smoke wrapper against `/usr/local`-installed static
libs):

| Build | `.wasm` size | `.js` size | Link time |
|---|---|---|---|
| Baseline (current flags) | 2,083,165 B | 232,720 B | 25.4 s |

### Adopted (kept)

| Flag change | `.wasm` size | `.js` size | Link time | Notes |
|---|---|---|---|---|
| `-flto` added to final `emcc` link | 2,024,548 B (**-58,617 B / -2.8%**) | 233,291 B (+571 B) | 30.6 s (+5.2 s) | Link-time-only LTO (the prebuilt `.a` libs are not themselves built with `-flto`); free `.wasm` size reduction with no source/behavior change. Build succeeds, including with `ENABLE_WASM_TRANSITIONS`'s `ASYNCIFY_STACK_SIZE=65536`. |
| `PTHREAD_POOL_SIZE='navigator.hardwareConcurrency'` (was `=4`) | 2,024,548 B (unchanged) | +28 B | unchanged | **Reverted (2026-07):** matched `omp_get_max_threads()` to core count while only 4 pthread Workers were pre-spawned, deadlocking OpenMP barriers on 033/034 (main-thread freeze). Keep `PTHREAD_POOL_SIZE=4` (see `PROJECTM_WASM_PTHREAD_POOL_SIZE` in `cmake/EmscriptenWasmFlags.cmake`) and call `omp_set_num_threads(kWasmPthreadPoolSize)` in `projectM_emscripten.cpp::init()` so OpenMP and the Worker pool stay aligned. Lazy extra Worker spawns on >4-core devices are acceptable vs. a silent hang. |
| **Combined** (both above) | 2,024,548 B (**-58,617 B / -2.8%**) | 233,319 B (+599 B) | 32.7 s (+7.3 s) | Applied to `build_wasm_smoke_wrapper.sh`, `build_projectm.sh`, `colab_build.sh`. |

Both changes were applied via the shared `scripts/wasm_link_common.inc.sh` include (generated from
`cmake/EmscriptenWasmFlags.cmake`) so smoke, Colab, and helper wrapper links stay aligned with
CMake's `ENABLE_EMSCRIPTEN` flags. `CMakeLists.txt` still does not produce `projectm-v.030-thread.js`
directly (no `add_executable` target — only static libraries are built via CMake, then linked by
`scripts/build_wasm_smoke_wrapper.sh` et al.), so wrapper-critical flags must live in the generated
shell include.

### Measured, but deferred pending in-browser verification

Both rows below were measured under Emscripten 5.0.4 and left out pending a browser run. They
have now had that run: see "Toolchain and flag verification (emsdk 6.0.6)" below. `FULL_ES3=0`
**landed**. `--closure 1` was **rejected** (it breaks the host contract), and a gate now enforces
that decision.

| Flag change | `.wasm` size | `.js` size | Link time | Outcome |
|---|---|---|---|---|
| `-s FULL_ES3=0` (was `=1`), combined with `-flto` | 2,024,444 B (-104 B vs. `-flto` alone) | 222,926 B (**-10,365 B / -4.4%**) | 30.6 s | **Landed** (2026-09-17). No libprojectM GL call needed the emulation layer. |
| `--closure 1`, combined with `-flto` | 2,024,548 B (unchanged) | 96,042 B (**-137,249 B / -58.8%**) | 47.8 s (+22.4 s vs. baseline) | **Rejected** (2026-09-17). Renames 33 of the 41 names that EM_JS shares with `html/`, silently. |

### Analyzed, not changed (high risk / needs dedicated effort)

| Candidate | Finding |
|---|---|
| `-s ASYNCIFY=1` | **Removed.** It was not a flag flip: the one yield it served (`emscripten_sleep(0)` before a preset compile) had to go first. Preset loads now prepare on a per-host pthread and the render loop never suspends. See "ASYNCIFY: retired" below. Not JSPI either: that needs a browser flag on Firefox/Safari, and with the work off the render thread nothing needs suspending. |
| `NO_DISABLE_EXCEPTION_CATCHING` → `-fwasm-exceptions` | **Done (2026-09-17)**, with a full lib + wrapper rebuild. Unconditional since ASYNCIFY went (the `PROJECTM_WASM_EXCEPTIONS=js` fallback is rejected). See "Toolchain and flag verification (emsdk 6.0.6)" below. |
| `-sINITIAL_MEMORY=1024mb` | **Done (epic #163):** reduced to `256mb` — see "WASM heap right-sizing" below. Re-measure with `tests/wasm-smoke/measure-heap.mjs` after deploy. |
| `GL_MAX_TEMP_BUFFER_SIZE=33177600` / `GL_POOL_TEMP_BUFFERS=0` | **Re-evaluated with `FULL_ES3=0` (2026-09-17).** `GL_MAX_TEMP_BUFFER_SIZE` was removed; with `FULL_ES2`/`FULL_ES3` off it has no effect, and its value no longer appears in the glue. `GL_POOL_TEMP_BUFFERS=0` was kept (see below). |

### Verification performed

- `INSTALL_DIR=/usr/local OUT_DIR=... bash scripts/build_wasm_smoke_wrapper.sh` succeeds for the
  baseline and for both adopted changes (`-flto`, `PTHREAD_POOL_SIZE='navigator.hardwareConcurrency'`),
  individually and combined, including the `ENABLE_WASM_TRANSITIONS=ON` default
  (`ASYNCIFY_STACK_SIZE=65536`).
- `.wasm`/`.js` sizes and link times above were measured from the resulting
  `projectm-v.030-thread.{js,wasm}` artifacts.
- **Not measured in this environment**: actual frame-time p50/p95 and startup time deltas (no
  browser/display). The `?benchmark=1` harness from the "Headless benchmark mode" section above
  should be used to confirm the adopted changes are neutral-to-positive on real frame timing, and
  to evaluate the deferred candidates once a display is available.

### Toolchain and flag verification (emsdk 6.0.6)

This session (2026-09-17) worked through the deferred rows above with one toolchain and one
browser. It has a known limit: **no GPU was available.** Every browser run used Chromium on
SwiftShader, the same software GL that the golden gate uses in CI. That makes the pixels
deterministic and exact to compare. It also means no frame times were measured, so none are
recorded here.

**Setup.** Emscripten 6.0.6, `ENABLE_WASM_TRANSITIONS=ON`, smoke wrapper (no `-flto`), and
`libomp.a` from `omp/omp.zip`. Each variant came from one commit and one browser, and changed only
the setting shown.

| Build | `.wasm` | `.js` glue | Smoke | Goldens (26) | Host contract |
|---|---|---|---|---|---|
| Baseline (`FULL_ES3=1`, `GL_MAX_TEMP_BUFFER_SIZE=33177600`, `NO_DISABLE_EXCEPTION_CATCHING`) | 1,591,413 B | 240,483 B | pass | 26/26 ssim 1.00000 | 41/41 |
| `FULL_ES3=0` | 1,591,309 B | 230,347 B (-4.2%) | pass | 26/26 ssim 1.00000 | 41/41 |
| `FULL_ES3=0` + `GL_POOL_TEMP_BUFFERS=1`, `GL_MAX_TEMP_BUFFER_SIZE` default | 1,591,309 B | 234,042 B | pass | 26/26 ssim 1.00000 | — |
| `-fwasm-exceptions` (libs + wrapper rebuilt) | 1,485,386 B (-6.7%) | 225,996 B (-6.0%) | pass | 26/26 ssim 1.00000 | — |
| `--closure 1` (FS methods pinned in externs) | 1,591,413 B | 106,126 B (-55.9%) | pass | not run | **8/41** |
| **Landed:** `FULL_ES3=0` + `-fwasm-exceptions`, clean rebuild with no overrides | **1,485,282 B (-6.7%)** | **215,860 B (-10.2%)** | pass | 26/26 ssim 1.00000 | 41/41 |

"Smoke" means `tests/wasm-smoke/run.mjs`: init, OpenMP (4 threads, blocktime 0), a cold
load (then under Asyncify), dual-FBO soft cut, two engine instances, and (new) a known-bad preset.

**`FULL_ES3=0`: landed.** Emscripten's `tools/link.py` turns on `FULL_ES2` whenever `FULL_ES3` is
set. The two layers add client-side vertex-array emulation (`clientBuffers`, `getTempVertexBuffer`)
and `glMapBufferRange`/`glGetBufferSubData` shims. libprojectM has no use for either: every
`glVertexAttribPointer`/`glDrawElements` passes a `nullptr` offset into a bound VBO/EBO, and it
calls neither mapping function. `GLResolver`/GLAD do not require the ES 3.0 entry points that
`emscripten_webgl2_get_proc_address()` stops returning. The issue flagged the Y-inverted
`glBlitFramebuffer` in `CopyTexture::TryBlit()` as the likeliest difference, but that call is a
direct passthrough (`libwebgl2.js`) with or without emulation. Evidence gathered:

- All 26 goldens are byte-identical. They cover the clear and blit, the per-pixel warp mesh, the
  composite shaders, noise textures, beat detection, and the heavy multi-pass warp + blur preset.
- The smoke dual-FBO soft cut passes.
- A pixel A/B against baseline covered two presets:
  - a blur3 + warp + composite preset (`weeks_presets/total hack do try and fight it.milk`);
  - a warp-without-composite preset (`weeks_presets/Jc - Driven by the Wind.milk`), which pays
    every remaining Y-flip.

  Each ran on baseline, on `FULL_ES3=0` and on `-fwasm-exceptions`, with default blit and with
  `?copyPath=shader`, at frames 60 and 300. All 24 captures had **0 differing pixels** against
  baseline/blit (threshold 0). They were 31-56% non-black, so this is not black-on-black agreement.

There is no GL call that still needs the emulation layer.

**`GL_MAX_TEMP_BUFFER_SIZE` / `GL_POOL_TEMP_BUFFERS`.**
- `GL_MAX_TEMP_BUFFER_SIZE` only sizes the `FULL_ES2` temp-VBO rings, so it was removed. The value
  `33177600` no longer appears in the glue.
- `GL_POOL_TEMP_BUFFERS` is still live, but not because of ES3. `MAXIMUM_MEMORY=4gb` with the
  default `MIN_FIREFOX_VERSION` switches off WebGL2's garbage-free upload APIs, so the pooled
  upload path is compiled in. With the pool at 0, `glUniform*v` passes a `HEAPF32` subarray view.
  With it at 1, small arrays are copied into pooled typed arrays.
- Both settings render identically. The faster one can only be picked by a GPU `?benchmark=1` run,
  so the value stays at 0.

**`-fwasm-exceptions`: landed as the default.** `PROJECTM_WASM_EXCEPTIONS` (`wasm` | `js`) is one
switch read by the CMake lib build and by the wrapper link, so the two cannot drift. A mismatch
fails at link time in both directions (`undefined symbol: __resumeException`, or `__cpp_exception`
/ `__gxx_wasm_personality_v0`), never at runtime.
- **Catch path.** The new smoke step loads a missing preset. `MilkdropPreset::Load` throws
  `MilkdropPresetLoadException`, `PresetFactoryManager` rethrows it, and `ProjectM::LoadPresetFile`
  catches it. The step requires `preset_switch_failed()` and `globalThis.projectMPresetSwitchFailed`.
- **Control.** The step was checked against a build linked with `DISABLE_EXCEPTION_CATCHING=1`.
  There the module aborts and the step fails.
- **Browser support.** Emscripten 6.0.6 emits the legacy EH encoding (1,995 `try`, 0 `try_table`):
  Chrome 95, Firefox 100, Safari 15.2. That is at or below the floor SharedArrayBuffer + COOP/COEP
  already sets, so Safari is not a blocker.
- **Asyncify (historical).** emcc warned that `ASYNCIFY=1` is incompatible with `-fwasm-exceptions`:
  a function that is both Asyncify-instrumented and has a `try` fails to *compile*. It was safe while
  `ASYNCIFY_ONLY` covered only the three `load_preset_file*` frames. The build has no ASYNCIFY now.

**`--closure 1`: rejected.** Two problems:
1. **Link.** `src/wasm/pthread_script_url.pre.js` shadows `Worker` on purpose, and Closure rejected
   it against its own externs (`JSC_VAR_MULTIPLY_DECLARED_ERROR`). A `@suppress {duplicate}` fixes
   that.
2. **Host contract.** ADVANCED renaming then breaks the host through two kinds of names:
   - `Module.FS.writeFile`, `mkdir`, `mkdirTree` (smoke fails immediately; fixable with an externs
     file);
   - 33 of the 41 names that EM_JS/pre-js code shares with `html/`, which no browser test catches.

   The renamed names include `projectMWritePcmRing` (external PCM), `projectMPresetSwitchFailed`,
   `pmReportInitError`, `pmOnPerfFrame`, all three `pmOnGovernor*Change` hooks, `Module.__pmPerfGpuByCtx`,
   and the worklet's `audioData`/`channelsForPM` message fields. The module still boots, renders and
   passes the smoke test.

To adopt Closure, a hand-maintained externs file would have to track every EM_JS body. The failing
check is committed instead: `tests/wasm-smoke/host_contract_names.mjs` runs in CI on every build,
passes 41/41 on the landed flags, and fails listing 33 names on a `--closure 1` build.

**Wrapper `-flto` (`PROJECTM_WASM_LTO=1`) was broken on 6.0.6.** The link failed with undefined
`EM_JS` symbols (`js_report_init_success`, `js_init_projectm_dom`, and eight more): Emscripten
6.0.6 does not register `EM_JS` functions defined in LLVM bitcode as JS imports. Fixed by compiling
the wrapper TUs to native objects before an LTO link; see "Whole-program LTO" below. The -2.8%
figure above predates the host-wrapper split and was measured on 5.0.4.

**CI.** The Emscripten workflow had not passed since 2026-04-24, and each break was hidden behind
the one before it:
1. libomp would not build on 3.1.53.
2. `tests/libprojectM` required a host SDL2 package under Emscripten.
3. The CMake link exported the wrapper's `EXPORTED_FUNCTIONS` into unit-test executables that do
   not define them.
4. `build-gtest` compiled GoogleTest without atomics or a matching exception ABI.
5. `ctest` cannot launch the tests under Emscripten.

All five are addressed in `build_emscripten.yml` and the CMake files. The job was then re-run
locally step for step on 6.0.6: from-source libomp, configure, build including the unit-test link,
install, wrapper link, artifact checks, host contract, browser smoke, screenshot smoke, and golden
self-check. The unit tests are built but no longer run there; `build_linux.yml` runs them natively.

**What is still open** before `PROJECTM_WASM_DEFAULT_VERSION` can move off `032`:
- a GPU `?benchmark=1` p95 run of a bundle cut from these flags, measured against 032 on the same
  machine;
- a real-browser audio-reactivity session.

Neither can be run on software GL. On SwiftShader the headless audio-reactivity harness
(`scripts/test_audio_reactivity_wasm.mjs`, preset `300-beatdetect-bassmidtreb.milk`) gives the
landed build the same pass/fail profile as the pre-change build, with zero PCM ring overruns in
both:
- the worker topology passes;
- on the main thread, treble, bands and stereo pass;
- the main-thread bass assertion fails (the known issue noted in `build_emscripten.yml`).

Main-thread red means (r) differ a little: silence 3.69 / bass 4.86 / treble 12.88 before, and
3.69 / 4.58 / 13.35 after. This harness depends on timing, and the second run shared the CPU with
two capture jobs.

## Dual-FBO VRAM residency and lazy preset-A allocation (issue #199)

### What the dual-FBO pairs are for

`ShouldUseDualFboCompositor()` (`WasmRenderLoop.cpp`) only returns true while a preset
crossfade is running. Steady-state playback takes the direct-to-canvas branch of `render_frame()`
and never binds or samples either ping-pong pair. Both pairs are therefore **crossfade scratch**,
not steady-state render targets — anything they cost between transitions is pure residency.

### Allocation policy

| Event | Preset A pair | Preset B pair |
|---|---|---|
| `start_render()` | not allocated — records viewport size only (`DualPingPongFramebuffer::Resize()`) | not allocated |
| `dual_fbo_begin_transition()` | allocated on demand (both pairs on a cold start) | allocated on demand |
| Blend reaches 1.0 | receives B's surfaces via `PromoteBtoA()` | released |
| `transition_cancel()` / abandoned poll | idle clock starts | released |
| Idle ≥ `dual_fbo_set_idle_release_seconds()` | released by `ReleaseDualFboIfIdle()` | — |

The idle grace period defaults to **5 s**. It exists so back-to-back preset switches reuse the live
pair instead of thrashing `glTexImage2D`; a session that settles on one preset drops the pair.
Hosts can call `dual_fbo_set_idle_release_seconds(0)` to reclaim on the first idle frame, or pass a
negative value to keep the pair resident once allocated (the pre-#199 behavior).

`ReleaseDualFboIfIdle()` deliberately refuses to fire while the preset B pair is allocated: B live
without an active blend means a transition is mid-setup, and pulling A out from under it would make
`transition_start()` bail and degrade the crossfade into a hard cut.

### VRAM delta

Surface cost is `width x height x 4 channels x bytes-per-channel`, two planes per pair. These are
**analytical** figures computed from the allocation sizes in `DualPingPongFramebuffer::CreateFBO()`,
not GPU-side measurements — this repo's CI has no GPU, and WebGL exposes no VRAM query, so the
in-browser number can only be confirmed with a vendor tool (`chrome://gpu`, Xcode GPU report).

| Resolution | Format | Per plane | Preset A pair (2 planes) |
|---|---|---|---|
| 1280x720 | RGBA16F (default) | 7.0 MiB | **14.1 MiB** |
| 1280x720 | RGBA32F (`?fboPrecision=high`) | 14.1 MiB | **28.1 MiB** |
| 1920x1080 | RGBA16F (default) | 15.8 MiB | **31.6 MiB** |
| 1920x1080 | RGBA32F (`?fboPrecision=high`) | 31.6 MiB | **63.3 MiB** |

Steady-state residency for the preset A pair goes from that figure to **0 B**, at both cold start
and between transitions. Peak during a crossfade is unchanged: both pairs are live then either way.
Combined with the RGBA16F default (#198), a 1080p session drops from 63.3 MiB resident to 0 B.

**This is a VRAM and startup-cost item, not an FPS item.** Nothing per-frame touches these surfaces
while the compositor gate is false, so no steady-state framerate change is expected. The win is
mobile headroom and `WebAssembly.instantiate` init failures (error code `3`), pairing with the
`INITIAL_MEMORY` reduction below.

### Peak-heap delta

These are GPU-side textures, so they do not land in `Module.HEAP8` and `measure-heap.mjs` will not
show a `postSteadyState` change. What it *can* show is the `postTransition` checkpoint: since
`measure-heap.mjs` calls `_dual_fbo_begin_transition()` directly, that checkpoint now covers the
cold-start allocate-both-pairs path rather than allocate-B-only. Re-run it after a deploy:

```sh
PROJECTM_SMOKE_ROOT=$PWD node tests/wasm-smoke/measure-heap.mjs \
  cmake-build/wasm-smoke/projectm-v.030-thread.js \
  presets/tests/000-empty.milk
```

### Verification performed

- `node --test tests/web/projectm-transitions.test.mjs` — 10 pass, covering the cold-start
  allocate-both-pairs ordering, re-allocation after an idle release, refusal to arm a blend when
  allocation fails, and FBO hand-back on a timed-out readiness poll.
- `scripts/verify_wasm_link_common.sh` — generated API artifacts in sync with the manifest.
- `scripts/check_html_types.sh` — no new type errors (50 pre-existing errors in
  `projectm-worklet-playback.js`, unchanged).
- **Not measured:** in-browser VRAM, the `glTexImage2D` cost of re-allocating the pair at the start
  of a transition, and any hitch that cost might produce. This environment has no Emscripten
  toolchain and no GPU. The 5 s grace-period default is a judgement call, not a measured optimum;
  if a re-allocation hitch shows up at crossfade start on real hardware, raise it or set a negative
  value to restore always-resident behavior.

## WASM heap right-sizing and ASYNCIFY strategy (epic #163)

### Peak heap measurement

`INITIAL_MEMORY` reserves a fixed WASM linear memory at module instantiation (before any preset
runs). With `ALLOW_MEMORY_GROWTH=1`, the heap can grow up to `MAXIMUM_MEMORY` (4 GiB), but a
large initial reservation increases mobile OOM risk during `WebAssembly.instantiate` (init error
code `3`).

#### Measurement harness

`tests/wasm-smoke/measure-heap.mjs` samples `Module.HEAP8.length` at:

| Checkpoint | When |
|---|---|
| `coldStart` | Immediately after `createModule()` |
| `postInit` | After `init_with_canvases()` |
| `postPresetLoad` | After `load_preset_file()` |
| `postSteadyState` | Peak during `N`× `_render_frame()` (default 120 @ 1280×720, mesh 80×60) |
| `postTransition` | After dual-FBO transition render (when exports present) |

```sh
npm install --no-save playwright && npx playwright install chromium
PROJECTM_SMOKE_ROOT=$PWD node tests/wasm-smoke/measure-heap.mjs \
  cmake-build/wasm-smoke/projectm-v.030-thread.js \
  presets/tests/000-empty.milk \
  presets/tests/110-per_pixel.milk \
  presets/tests/270-compshader-solid-color.milk
```

#### Analytical peak estimates (1280×720, dual-FBO RGBA16F, mesh 80×60)

Measured in-browser peaks require a working GL context; the table below is a static budget used
to pick `INITIAL_MEMORY` when runtime profiling is unavailable. Values are **used** bytes, not the
reserved `INITIAL_MEMORY` slab.

| Preset tier | Example | Estimated peak used | Dominant allocations |
|---|---|---|---|
| Light | `000-empty.milk` | ~45–70 MiB | Core engine, single FBO pair, 80×60 mesh VBOs |
| Medium | `110-per_pixel.milk` | ~70–110 MiB | Per-pixel eval contexts (OpenMP pool), warp buffers |
| Heavy | `270-compshader-solid-color.milk` | ~90–140 MiB | Composite shader + blur chain + dual-FBO transition scratch |

Assumptions: RGBA16F ping-pong (≈7 MiB per 1280×720 plane), dual pipeline ×2, blur mip chain
≈1.3× main FBO, shader-compile spike amortized over `postPresetLoad` checkpoint. Preset-shader
compile spikes can add **+30–80 MiB** transiently; `ALLOW_MEMORY_GROWTH` covers
this without raising `INITIAL_MEMORY`.

#### `INITIAL_MEMORY` change

| Setting | Before | After | Rationale |
|---|---|---|---|
| `INITIAL_MEMORY` | `1024mb` | **`256mb`** | Analytical peaks above + 25% headroom ≈ 175 MiB max → 256 MiB initial avoids 1 GiB upfront reservation on mobile while staying above steady-state use. Growth handles compile spikes. |
| `MAXIMUM_MEMORY` | `4gb` | `4gb` (unchanged) | Keeps headroom for large playlists / future multi-texture presets. |
| `ALLOW_MEMORY_GROWTH` | `1` | `1` (unchanged) | Required for pthread + mimalloc; growth path already enabled. |

Re-run `measure-heap.mjs` after deploy and confirm `postSteadyState` stays below 200 MiB with no
`memory.grow` during steady-state playback; bump `INITIAL_MEMORY` in 64 MiB steps if growth is
observed every frame.

### Dual-FBO Preset A/B lazy allocation (#175 item 5)

Before this change, `start_render()` called `g_dualFbo.AllocatePresetA(width, height)`
unconditionally at startup. Since `ShouldUseDualFboCompositor()` already gates the compositor to
`g_transitionActive`, Preset A's two FBOs sat allocated and untouched for the entire steady-state
session on every page load — including embeds that never trigger a crossfade.

`start_render()` now only records the viewport via `g_dualFbo.Resize()`; Preset A and Preset B
textures are both allocated lazily on the first `dual_fbo_begin_transition()` call
(`WasmDualFbo.cpp`), which fires from `html/projectm-transitions.js`'s `startTransitionWhenReady()`
poll loop once Preset B's shaders are ready — not before a transition is actually requested.

VRAM this removes from every session that never crossfades (the common case for many embeds):

| Resolution | RGBA32F (2 surfaces) | RGBA16F (2 surfaces, current default per #198) |
|---|---|---|
| 1280×720 | ~28 MB | ~14 MB |
| 1920×1080 | ~63 MB | ~31 MB |

This is resident-VRAM / init-cost savings, not a steady-state frame-time change — nothing
per-frame touched these surfaces even before this fix, since the compositor was already
transition-gated. The benefit is reduced `WebAssembly.instantiate` / first-frame VRAM pressure on
memory-constrained mobile GPUs (init error code `3`), pairing with the `INITIAL_MEMORY`
right-sizing above (#163).

**No silent hard-cut regression:** `dual_fbo_begin_transition()` lazily allocates Preset A too if
it isn't already allocated, and the host readiness poll only calls `transition_start()` after
`dual_fbo_begin_transition()` succeeds — see `tests/web/projectm-transitions.test.mjs` ("waits for
preset B, allocates it, then starts once" and "keeps polling when allocation fails"). The first
transition after a cold start still soft-cuts; it does not silently degrade to a hard cut.

### ASYNCIFY: retired

The build has no ASYNCIFY. It used to be kept alive by a single `emscripten_sleep(0)` at the start of
`load_preset_file_impl`. That call yielded to the event loop once, and the rest of the load then ran
synchronously with `renderLoop()` skipping frames: parse, HLSL→GLSL transpile, `glCompileShader`,
`glLinkProgram`, init expressions. Since the OffscreenCanvas render worker became the default (#237),
the yield mostly protected a worker nobody interacts with, and every preset switch still stalled the
loop for the whole compile.

Preset loading is now split at the GL boundary (libprojectM `projectM-4/preset_prepare.h`, see
[EMSCRIPTEN.md → Preset loading](EMSCRIPTEN.md#preset-loading)):

- **Prepare thread.** Each `WasmHost` runs a pthread that parses and analyses the preset (read on the main thread) and
  transpiles its shaders speculatively. The render thread uses that GLSL only if the sampler/texsize
  declarations it builds match the prediction, so the result is byte-identical by construction.
  `PresetCompatPrepared.GlslMatchesInlineTranspile` checks this for every test preset and
  `custom_milk_fixed/`, with zero prediction misses.
- **Render thread.** `render_frame()` activates the prepared preset: GL objects, compile, init
  expressions. With `KHR_parallel_shader_compile`, the link runs on driver threads and the switch
  waits for `GL_COMPLETION_STATUS_KHR` (`shader_link_pending` in `projectm_perf_frame_timings`
  and the HUD). The old preset keeps drawing until then.
- **Not JSPI.** It needs a browser flag on Firefox and Safari, and with the work off the render
  thread nothing needs suspending.

History: Option A (JSPI) was deferred, Option B (`ASYNCIFY_ONLY`, 2026-08) cut instrumentation to
the three `load_preset_file*` frames (−40.8% `.wasm` against whole-program ASYNCIFY), and Option C
("manual yields") was the fallback. This change is the structural fix none of them were:
removing the yield instead of making it cheaper.

#### Size and link time (Emscripten 6.0.6, SwiftShader host, smoke wrapper)

Each row changes one thing relative to the row above. Measured on this branch, 2026-09-24/25, same
machine.

| Build | `.wasm` | glue `.js` | `Asyncify` in glue | Wrapper compile + link |
|---|---|---|---|---|
| 037 flags (`ASYNCIFY=1` + `ASYNCIFY_ONLY`, `WASM_WORKERS=1`) | 1,489,948 B | 216,452 B | 59 | 70.2 s |
| No ASYNCIFY (prepare thread, job API; `WASM_WORKERS`, lib-only `TRUSTED_TYPES`/`AUDIO_WORKLET` dropped) | 1,503,330 B (+0.9%) | 207,399 B (−4.2%) | **0** | 73.2 s |
| + whole-program LTO (`PROJECTM_WASM_LTO`: libs as bitcode) | 1,536,453 B (+2.2%) | 208,033 B | 0 | 46.6 s (wrapper TUs compiled in parallel, then one LTO link) |
| + Release / `NDEBUG` (no LTO) | 1,504,253 B (+0.06%) | 207,399 B | 0 | 76.3 s |

The +13 KB of the second row is new code: `std::thread` and `std::condition_variable`, the job API,
and the prediction. `ASYNCIFY_ONLY` had instrumented only three small functions, so removing it saved
little `.wasm` but 9 KB of glue (the `Asyncify` runtime).

#### Preset switch: frames rendered during the load

`tests/wasm-smoke/preset_switch_stall.mjs` (CI step "Preset switch keeps rendering") runs the
engine's own main loop. It settles `000-empty.milk`, then hard-cuts to
`custom_milk_fixed/milk011.milk`. It counts the frames rendered between the request and the frame
that switches, and compares the longest frame gap around the switch with the settled frames. Two
runs per row, SwiftShader:

| Canvas | Bundle | Frames rendered while loading | Request → ready | Worst frame gap (settled median) |
|---|---|---|---|---|
| 320×180 | 037 flags (ASYNCIFY, blocking load) | **0** (fails) | 369–460 ms | 374–461 ms (38–52 ms) |
| 320×180 | This change | **6–7** | 353–675 ms | 96–312 ms (31 ms) |
| 1280×720 | 037 flags | **0** (fails) | 316 ms | 316 ms, 1.62× p95 |
| 1280×720 | This change | **2–3** | 758–1,067 ms | 0.62–1.88× p95 |

On the old path the whole load was one frame gap. On the new one, the worst gap is the activation
frame: SwiftShader does not expose `KHR_parallel_shader_compile`, so that frame still carries the
GL compile and link. Request → ready is similar at the small canvas, but at 1280×720 it is quantized
to software frames of 100–300 ms. Activation waits for the next frame boundary, and the prepare
thread shares cores with SwiftShader's rasterizer and OpenMP.

The preset file is read on the main thread at request time (`projectm_preset_prepare_begin_file_contents()`).
The prepare thread used to open it itself. Under Emscripten pthreads every FS call from a worker is
proxied to the main thread and waits for its current frame to end, and that alone added about a
third to request → ready at 1280×720 (1.0–1.4 s before).

The ratio is reported, not gated, on software GL: the old whole-load stall measured under 2× p95
there. Gate it (`--max-ratio 2`) on a GPU run (`--gpu`). The #247 hardware baseline should be taken
on a bundle with this change.

#### Whole-program LTO

`PROJECTM_WASM_LTO` (off by default) builds the static libs as LLVM bitcode, and the bundle link
optimises across them. Emscripten 6.0.6 does not register `EM_JS` functions defined in bitcode as JS
imports, which is what broke `PROJECTM_WASM_LTO=1` before (undefined `js_report_init_success` and
the other `EM_JS` symbols). `scripts/build_wasm_smoke_wrapper.sh` now compiles the wrapper TUs to
native objects first and runs LTO only in the link.

Result: `.wasm` **+33 KB (+2.2%)**, smoke passes, no measurable CPU difference.
`scripts/benchmark_presets_wasm.mjs --software-gl` gives per-stage medians within noise: two runs of
the *same* non-LTO bundle differ by up to ~30% per stage (for example `perPixelEvalMs` 3.18 vs
5.36 ms on `110-per_pixel.milk`). It stays opt-in until a GPU run shows a gain worth the size.

#### Release / `NDEBUG`

`scripts/build_wasm_install.sh` now passes `CMAKE_BUILD_TYPE` (default `Release`). Before, the
library was built with no build type, so `NDEBUG` was never defined and every `assert()` stayed in
the shipped wasm. `.wasm` changes by +923 B (inlining shifts). The 26 goldens stay pixel-identical,
and the smoke, preset benchmark and stall test pass.

`scripts/check_no_asyncify.sh` (CI, `build_emscripten.yml`) fails if the Asyncify runtime comes back.
`scripts/verify_wasm_link_common.sh` fails if an `ASYNCIFY` setting reappears in the flags.

### OpenMP blocktime: the 032 → 036 audio + framerate regression

Bundle **036** was reported as both quieter/glitchier and slower than **032** on
the same host, preset and machine, which is why `PROJECTM_WASM_DEFAULT_VERSION`
was pinned back to `032`. Both symptoms are one cause.

**The delta.** 032 predates OpenMP in the wasm build; 036 links the full LLVM
libomp. Confirmed against the deployed artifacts rather than inferred from
source (032 has no source correspondence in this tree — the version constant
only appears from 035 on):

```
$ strings projectm-v.032-thread.wasm | grep -cE 'kmp_|libomp|GOMP_'
0
$ strings projectm-v.036-thread.wasm | grep -cE 'kmp_|libomp|GOMP_'
17
$ grep -o 'pthreadPoolSize=[0-9]*' projectm-v.0{32,36}-thread.*    # both: 4
```

So the pthread pool is identical; what changed is that 036 actually runs OpenMP
parallel regions on it.

**The mechanism.** libomp does not sleep a team's helper threads when a parallel
region ends — it spins them until `KMP_BLOCKTIME` elapses, default **200 ms**.
`PerPixelMesh::CalculateMesh` opens a region every rendered frame (default
meshes are 4941 verts at 80x60 and 3185 at 64x48, both over
`OpenMp::kMinPerPixelMeshVerts = 1000`), so the next region always arrives
~17 ms in at 60 fps — about a twelfth of the spin window. The helpers never
reach the sleep path and hold their cores for the whole session.

Three permanently-spinning helpers plus the render loop is enough to miss the
`AudioWorklet`'s deadline (a 128-sample quantum every ~2.7 ms at 48 kHz), which
is heard as crackle and dropouts, **and** to slow the render loop competing for
the same cores. Note the audio symptom is necessarily indirect: the engine
emits no audio at all: playback is entirely `projectm_audio_processor.js` on the
browser's audio render thread, so no change to PCM ingest, gain, or channel
counts inside the wasm module can alter what a listener hears.

**The fix.** `ConfigureWasmOpenMPThreadCount()` calls `kmp_set_blocktime(0)`
alongside the existing thread-count cap. Setting `KMP_BLOCKTIME` through the
environment does not work in wasm — libomp reads it via `getenv()` during its
own init and the module has no environment. The cost is a futex wake per
parallel region; the gain is three cores that are idle when projectM is not
computing.

**Verifying a deployed bundle:** `Module._get_omp_blocktime()` returns `0` with
the fix, `200` without it, `-1` for a bundle with no libomp (e.g. 032). It is
also reported as `openmp.blocktimeMs` by `html/projectm-perf.js`, so a
before/after capture records it next to the frame times.

**Still to measure in-browser** (needs a rebuilt 036 and real hardware; neither
was available where this was diagnosed): side-by-side FPS for 032 vs. 036 vs.
036+fix on one light and one heavy preset at a fixed mesh/canvas size, and a
listening check on the default FLAC player. If a framerate gap survives with
`blocktimeMs === 0`, the remaining suspect is the dual-FBO compositor path,
unrelated to this fix. (ASYNCIFY, the other one listed here before, has been
removed from the build.)

### OpenMP effectiveness gates

Central thresholds live in `src/libprojectM/OpenMpConfig.hpp`:

| Constant | Value | Applies to |
|---|---|---|
| `kMinParallelLoopIters` | **512** | Waveforms (~256–480 samples), FFT magnitude (256), noise blur rows when `size < 512` |
| `kMinPerPixelMeshVerts` | **1000** | Per-pixel mesh (≥3125 verts @ 64×48), composite grids, custom waveform smooth |

#### Pragma inventory (libprojectM)

| File / function | Loop size (typical) | Gate |
|---|---|---|
| `PerPixelMesh::CalculateMesh` | 4961 verts @ 80×60 | `if(vertexCount >= 1000)` — **parallel** |
| `PerPixelMesh::InitializeMesh` | same | `if(verts >= 1000)` — **parallel** |
| `FinalComposite` grid loops | 32×64 ≈ 2048 | `if(w×h >= 1000)` — **parallel** |
| `MilkdropNoise::generate2D/3D` | 256×256 / 32³ | `if(size >= 512)` on row/slice loops |
| `MilkdropFFT` step 1 | 512 | `if(>= 512)` — borderline, stays parallel on native |
| `MilkdropFFT` step 3 / init tables | 256 / 576 | `if(>= 512)` — **serial** |
| `Loudness::SumBand` | ~85 | OpenMP removed — always serial |
| `WaveformAligner` cross-correlation | <200 | OpenMP removed — always serial (also fixes wasm duplicate `reduction` symbol) |
| Built-in waveforms (`Line`, `SpectrumLine`, …) | 256–480 | `if(m_samples >= 512)` — **serial** |
| `CustomWaveform` scale/smooth | 256–512 / 512+ | `if(sampleCount >= 512)` / `if(verts >= 1000)` |

#### Benchmark thresholds (native, 4-core VM, 2026-07)

```sh
scripts/benchmark_openmp_native.sh
```

| Build | `fftMsPerIter` | Notes |
|---|---|---|
| OpenMP ON | 0.011 | 512-bin FFT — parallel overhead, gated in production hot path |
| OpenMP OFF | 0.005 | Faster for small FFT; per-pixel mesh is the real OpenMP win |

All `OpenMPInfoTest` / `OpenMPBenchTest` / `WaveformAlignerTest` cases pass with `ENABLE_OPENMP`
on and off. WASM smoke reports `openmp.compiled=1 maxThreads=4 parallelObserved=4`.

See also `docs/openmp.md` for the historical target list and build instructions.

## OpenMP on Emscripten/WASM (verification)

### Problem fixed

The Emscripten `CMakeLists.txt` block always passed `-fopenmp`, but `PRJM_ENABLE_OPENMP` was only
defined when `find_package(OpenMP)` succeeded — which does not work on the Emscripten toolchain.
Result: every `#ifdef PRJM_ENABLE_OPENMP` region in `libprojectM` compiled **without** pragmas even
though the final `emcc` link used `-fopenmp` and `libomp.a`.

`cmake/EmscriptenOpenMP.cmake` now detects the bundled `libomp.a` + `omp/omp.h`, defines
`OpenMP::OpenMP_CXX`, auto-enables `ENABLE_OPENMP`, and links `libomp.a` into the static libraries.
Compile flags use `-fopenmp=libomp` (LLVM-recommended for wasm).

Build `libomp.a` once per emsdk version:

```sh
scripts/build_libomp_emscripten.sh
```

### Runtime introspection

WASM exports (also in `projectm_perf.h` for native):

| Export | Purpose |
|---|---|
| `_get_omp_enabled()` | 1 when `PRJM_ENABLE_OPENMP` was compiled into `libprojectM` |
| `_get_omp_max_threads()` | `omp_get_max_threads()` (matches `PTHREAD_POOL_SIZE`) |
| `_get_omp_thread_count_in_parallel()` | Spawns a short `#pragma omp parallel` and returns observed thread count |

The `?benchmark=1` harness (`html/projectm-perf.js`) now includes an `openmp` object in the JSON
report. The wasm-smoke test logs OpenMP status when the exports are present.

### Native microbenchmark

```sh
scripts/benchmark_openmp_native.sh
```

Runs `OpenMPBenchTest` (gtest) with `ENABLE_OPENMP` on/off and prints JSON with FFT throughput.
On a 4-core VM (2026-06): OpenMP ON compiled with 4 threads; FFT microbench showed parallel
overhead dominating the small 512-bin loop (expected — per-pixel mesh at 48×36 is the real win).

### Verification performed

- Native: `scripts/benchmark_openmp_native.sh` — OpenMP ON reports `compiled=1 maxThreads=4`,
  parallel region observes multiple threads; all `OpenMPInfoTest`/`OpenMPBenchTest` cases pass.
- WASM: CI builds `libomp.a` via `scripts/build_libomp_emscripten.sh` before `emcmake` configure;
  smoke test reports `openmp.compiled` / `parallelThreadsObserved` when linked.

## OffscreenCanvas render worker and SIMD audio hot paths (issue #81/#82 follow-up)

Follow-up to the 60 FPS/quality governor and link-flag work above: moving the render loop off the
main thread (Part A) and vectorizing the audio analysis hot paths with `wasm_simd128.h` (Part B).
This depends on the profiling/governor work above and is implemented incrementally, as requested.

### Part A: OffscreenCanvas render worker (default ON)

`html/projectm-render-worker.js` (runs in a dedicated Worker) and
`html/projectm-render-worker-host.js` (main-thread bridge), selected by
`ProjectMContext` through `html/projectm-render-transport.js`.

**Enabled by default.** `?renderWorker=0` (or `localStorage.renderWorker = '0'`)
opts out, and stays a supported path — `tests/web/` covers the opt-out and
`scripts/test_audio_reactivity_wasm.mjs` exercises both topologies. Feature
detection still falls back to the main thread on its own when
`OffscreenCanvas`/`transferControlToOffscreen`/`Worker` are missing or the page
is not cross-origin isolated, so browsers that cannot host a render worker are
unaffected.

**Three things had to be fixed before the default could move**, and all three
failed silently, which is why this stayed opt-in through several rounds of
"needs browser verification":

1. **The module never booted in the worker.** Emscripten creates pthread pool
   Workers from the running script's own URL, which inside
   `projectm-render-worker.js` is that file — not the glue it
   `importScripts()`'d. Every pool worker re-loaded the render worker, none
   joined, and `createModule()` waited forever for a pool that could not fill.
   `src/wasm/pthread_script_url.pre.js` restores `Module.mainScriptUrlOrBlob`
   so the worker can point the pool at the glue.
2. **The engine could not find its canvas.** `init()` resolves `#mcanvas`, and a
   worker has no document. The worker now registers the transferred canvas in
   `Module.specialHTMLTargets` (newly exported) and runs `init()` itself, so the
   C++ needs no worker-specific path — and `WasmWebGLCanvasElementExists()`
   consults the same table rather than only the document, which is what used to
   fail `init()` with code 2.
3. **Resize was a no-op.** The host cannot touch a transferred canvas's
   `width`/`height`; only the worker can. It now sizes its own surface from the
   layout size the host sends, times the governor's render scale.

**How it works when enabled**:

1. `attemptInit()` calls `isRenderWorkerEnabled()` /
   `isRenderWorkerSupported(mcanvas)`. If both are true, it calls
   `tryStartRenderWorker(mcanvas)` *before* creating the main-thread `Module`.
2. `setupRenderWorker()` calls `mcanvas.transferControlToOffscreen()` and posts
   the resulting `OffscreenCanvas` (as a transferable) to a new
   `projectm-render-worker.js` Worker, along with the WASM script URL, initial
   canvas size, and the resolved `targetFps`/`governor`/`meshQuality` config
   (read from `?targetFps=`/`?governor=`/`?meshQuality=`/`localStorage` on the
   main thread, since a Worker has no `localStorage`).
3. The worker `importScripts()`s the same `projectm-v.030-thread.1ijs`, calls
   `createModule({ canvas: offscreenCanvas })`, then `_start_render()`,
   `_set_target_fps()`, `_set_quality_governor()`, and `_set_mesh()` — the same
   calls `attemptInit()`/`projectm-fps-governor.js`/`projectm-mesh-quality.js`
   make on the main thread today.
4. On success (`{ type: 'ready' }`), `attemptInit()` sets `renderWorkerHandle`
   and returns early, skipping the main-thread `Module` creation entirely. On
   `{ type: 'unsupported', ... }` (e.g. `importScripts` or module init failed),
   it falls through to the normal main-thread path unchanged.

**What's forwarded from the main thread** (per the "main thread forwards PCM
commands and UI resize/events only" requirement):

- **PCM**: `setupExternalAudioReceiver()`'s `onFeed` hook now branches on
  `renderWorkerHandle`. When active, PCM is written into a
  `SharedArrayBuffer`-backed ring buffer (`createPcmRing()` in
  `projectm-render-worker-host.js`) that the worker drains every 16ms and feeds
  to `_projectm_pcm_add_float_wrapper` using its *own* WASM heap. `SHARED_MEMORY=1`
  is already enabled in the build, but `SharedArrayBuffer` additionally requires
  cross-origin isolation (COOP/COEP headers) at runtime — `createPcmRing()`
  checks `crossOriginIsolated` and returns `null` if unavailable, in which case
  PCM falls back to per-chunk `postMessage` (`{ type: 'pcm', buffer, channels }`,
  transferring the `Float32Array`'s buffer).
- **Resize**: `syncModuleSize()` and the `ResizeObserver` callback now call
  `renderWorkerHandle.postResize(w, h)` instead of `Module._set_window_size()`
  directly. `mcanvas.width`/`.height`/CSS size are still set on the main thread
  (per spec, setting `.width`/`.height` on a canvas after
  `transferControlToOffscreen()` still resizes the transferred bitmap).
- **Preset lock toggle**: `lockPreset()` calls
  `renderWorkerHandle.ccallVoid('set_preset_locked', ['number'], [...])`, a thin
  generic `ccall` forwarder (`{ type: 'ccall', name, returnType, argTypes, args }`)
  that the worker executes against its own `Module.ccall`.

**Known limitations of the render-worker topology**:

- Preset loading works: it is a VFS write plus a call, so it crosses as a
  `preset` message (`projectm-render-worker-types.ts`) and the worker performs
  both steps on its side. `ProjectMContext.loadPresetUrl()` /
  `loadPresetFile()` / `addPreset()` and `fetchApiPreset({ writeBytes })` are
  topology-agnostic.
- Still main-thread-only: the FBO-format degraded-mode banner
  (`projectm-fbo-format.js`), the on-screen perf HUD (`projectm-perf.js`), the
  preset dev tools and the experimental bridge. All four read engine state
  through a module object on the page and drive the DOM from it; in worker mode
  they stay unbuilt rather than throwing, and `?renderWorker=0` brings them
  back. Porting them onto `RenderTransport` is what remains of making
  `projectm-core.html` fully topology-agnostic.
- **Nested OpenMP/pthread workers** (confirmed working on Chromium, 2026-09;
  see the browser matrix below): the WASM module is built with
  `-pthread -fopenmp` and `PTHREAD_POOL_SIZE='navigator.hardwareConcurrency'`.
  When this module is instantiated *inside* `projectm-render-worker.js`, its
  pthread pool Workers become **nested Workers** (Worker-within-Worker).
  Chrome and Firefox support `new Worker()` from within a
  `DedicatedWorkerGlobalScope`; Safari's support for nested Workers has
  historically lagged. This is the "Verify OpenMP/pthread workers still
  function from render worker" item from the issue and **could not be checked
  here** (no browser). If nested Workers fail to spawn on a given browser,
  `MilkdropPreset::InitializePreset()`'s `m_perPixelContextPool`-based OpenMP
  parallelism would silently fall back to serial execution inside the worker
  (OpenMP degrades to single-threaded if `omp_get_max_threads()` workers can't
  be created) rather than crashing — but this needs confirming on Safari.
- `requestAnimationFrame` inside the worker: Emscripten's
  `emscripten_set_main_loop` (used by `_start_render`'s main loop) calls
  `requestAnimationFrame` when available in the worker's global scope (Chrome
  105+/Firefox support this for workers that own an `OffscreenCanvas`) and
  falls back to `setTimeout`-based timing otherwise — this fallback is handled
  by the Emscripten runtime itself, so no extra code was needed here, but the
  resulting frame pacing on a `setTimeout` fallback has not been measured.

**Browser matrix tested**: headless Chromium with SwiftShader (software GL),
2026-09, via `scripts/test_audio_reactivity_wasm.mjs`. The render-worker
topology boots, creates its GL context on the transferred `OffscreenCanvas`,
renders frames, and fully drains the shared PCM ring with zero overruns — the
first time this path has been observed working at all. The nested-Worker
question below is therefore answered for Chromium; Safari and Firefox remain
unverified. To test by hand:

1. Serve `html/` (needs to be served with `Cross-Origin-Opener-Policy: same-origin`
   and `Cross-Origin-Embedder-Policy: require-corp` for the SharedArrayBuffer PCM
   ring to activate; without those headers, PCM still works via the
   `postMessage` fallback).
2. Desktop Chrome (the default now; `?renderWorker=1` pins it): open DevTools Performance tab, confirm the
   main thread is mostly idle while `projectm-render-worker.js` shows
   `_render_frame`/GL activity; confirm visuals react to
   `startLocalProjectMTestSender()`.
3. Firefox: same as above (`OffscreenCanvas`/`transferControlToOffscreen`
   supported since Firefox 105).
4. Safari: `transferControlToOffscreen()` support and nested-Worker behavior
   for the OpenMP pool are the main unknowns — check the console for
   `{ type: 'unsupported' }`/`{ type: 'error' }` messages from
   `projectm-render-worker-host.js`'s `onUnsupported`/`onError` callbacks (logged
   via `console.warn`/`console.error`), which should trigger the main-thread
   fallback.
5. With `?renderWorker=0`: confirm the main-thread path still behaves as it
   always did, including the dev panels, which only exist there.

**Perf numbers**: the headline claim — that the embed holds frame rate against a
busy host page — has *not* been measured. What has been verified is correctness:
the worker boots, renders, and drains the ring with no overruns under software
GL. Measuring the isolation benefit needs a real GPU and a synthetic
main-thread hog on the host page.

**Drive-by fix**: `scripts/build_projectm.sh` and `scripts/colab_build.sh`'s
`EXPORTED_FUNCTIONS` lists were missing `_set_target_fps`,
`_set_quality_governor`, `_get_quality_tier`, `_dual_fbo_get_format`, and the
other functions added in the 60 FPS/quality-governor and FBO-format work —
`scripts/build_wasm_smoke_wrapper.sh` and `CMakeLists.txt`'s
`PROJECTM_WASM_EXPORTED_FUNCTIONS` already had them. Without this, the render
worker's `if (Module._set_target_fps)`/etc. guards would silently no-op on
builds produced by those two scripts. Synced all three `EXPORTED_FUNCTIONS`
lists.

### Part B: SIMD audio hot paths

#### `PCM::CopyNewWaveformData` — contiguous circular-buffer copy (low risk, portable)

`src/libprojectM/Audio/PCM.cpp`'s `CopyNewWaveformData()` previously copied the
576-sample circular waveform buffer element-by-element with
`destination[i] = source[(bufferStartIndex + i) % AudioBufferSamples]` (an
OpenMP-parallelized scalar loop). The per-element `%` defeats autovectorization
on every target, wasm included.

Replaced with at most two `std::copy()` calls split at the wrap point
(`source.begin() + bufferStartIndex .. source.end()` then
`source.begin() .. source.begin() + bufferStartIndex`, or a single full-range
copy when `bufferStartIndex == 0`). This is portable (no `wasm_simd128.h`
needed), lets the compiler/`libc` use `memcpy`/`memmove`/autovectorized loops on
both native and wasm builds, and removes the OpenMP parallel-for entirely (576
elements is too small to benefit from thread dispatch overhead anyway).

#### `WaveformAligner::ResampleOctaves` — explicit `wasm_simd128.h` pass with scalar fallback

`src/libprojectM/Audio/WaveformAligner.cpp`'s `ResampleOctaves()` downsamples
each mip level by averaging adjacent sample pairs:
`dst[sample] = 0.5f * (src[2*sample] + src[2*sample+1])`. Added a
`#if defined(__wasm_simd128__)` path that processes four destination samples
(eight source samples) per iteration: loads two `v128_t`s, uses
`wasm_i32x4_shuffle` to de-interleave the even/odd lanes (the even/odd source
samples), adds them, and multiplies by `wasm_f32x4_splat(0.5f)`. Any remaining
samples (when the octave's sample count isn't a multiple of 4), and the entire
loop on builds without `__wasm_simd128__` (native, this environment's only
buildable/testable target), fall back to the original scalar expression
unchanged.

#### `MilkdropFFT.cpp` butterfly (Step 2) — analyzed, not changed

`MilkdropFFT::TimeToFrequencyDomain()`'s Step 2 (the Cooley-Tukey butterfly) has
a sequential twiddle-factor recurrence (`w *= wp` each iteration of the `m`
loop), which is inherently serial as written — vectorizing it correctly
requires precomputing a twiddle-factor table per stage so the `m` loop becomes
data-parallel. That's an algorithmic restructuring of FFT-correctness-critical
code, and `tests/libprojectM/` has no FFT unit test to validate the result
against (only `WaveformAlignerTest.cpp` exists for `Audio/`). Given the risk of
silently producing incorrect spectrum data with no test to catch it, this was
**deferred** rather than attempted in this pass. Steps 1 and 3 of the same
function are already OpenMP-parallelized and were left as-is.

#### `Loudness::SumBand` — analyzed, not changed

`SumBand()` reduces ~`SpectrumSamples/6` (~85) elements per band (3 bands/frame)
under an `#pragma omp parallel for reduction(+:m_current)`. Two reasons this was
not also given a `wasm_simd128.h` path:

1. The wasm build already enables `-fopenmp` alongside `-pthread`
   (`build_projectm.sh`/`colab_build.sh`/`build_wasm_smoke_wrapper.sh` all pass
   `-fopenmp`), so `PRJM_ENABLE_OPENMP` is defined and `SumBand` already takes
   the OpenMP-reduction path on wasm — a `wasm_simd128.h` path would only be
   reachable in a non-OpenMP wasm build, which none of the build scripts produce.
2. At ~85 elements, a 4-wide SIMD horizontal-sum loop saves at most ~21
   iterations of scalar add — likely below the noise floor of per-frame timing,
   especially compared to the FFT/PCM/resample work above.

### Verification performed

- `cmake --build cmake-build-verify --target projectM-unittest` succeeds with
  the `PCM.cpp`/`WaveformAligner.cpp` changes (native build, so the
  `__wasm_simd128__` branch is not compiled/tested here — only the scalar
  fallback path is exercised).
- `./cmake-build-verify/tests/libprojectM/Debug/projectM-unittest`: all 187
  tests pass, including `projectMWaveformAligner.AlignDelta`, which exercises
  `ResampleOctaves()` (via `Align()`) with the new scalar-fallback code path.
- `node --check` on `html/projectm-render-worker.js`,
  `html/projectm-render-worker-host.js`, the modified
  `html/projectm-core.html` `<script type="module">` body, and
  `html/projectm-external-pcm.js` (new `defaultFeedPCMToModule` export) — all
  syntactically valid ES modules.
- **Not measured in this environment** (no GPU/display/browser): input-to-visual
  latency and frame p95 before/after, the `?renderWorker=1` path end-to-end, and
  whether the `wasm_simd128.h` branch in `ResampleOctaves()` actually compiles
  and produces SIMD opcodes under `em++` (no Emscripten toolchain available in
  this environment to run `wasm-objdump`/`-S` — the `#if defined(__wasm_simd128__)`
  guard ensures it is simply not compiled here, with no effect on the native
  build or its tests).
