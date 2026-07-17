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
| `per_pixel_eval_ms` | Per-pixel mesh evaluation and warp draw (`PerPixelMesh::Draw`, `PerPixelContext`). |
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

Append the following query parameters to `projectm-core.html`:

```
?benchmark=1&frames=500&preset=/presets/some_preset.milk
```

- `benchmark=1` — required to enable benchmark mode.
- `frames` — number of frames to sample (default 500).
- `preset` — optional VFS path to a preset to load before sampling (via
  `Module.ccall('load_preset_file', ...)`). If omitted, the currently active/idle preset is used.

Once `frames` samples have been collected, `projectm-perf.js`:

1. Logs a JSON summary to the console, prefixed with `[projectM benchmark]`.
2. Posts the same object via `window.postMessage({ type: 'pm-benchmark-result', result }, '*')`,
   so an automated test harness (e.g. Puppeteer/Playwright) can capture it without scraping the
   console.

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
now **48×36** (1813 vertices), up from the previous 32×24 (792 vertices), matching the resolution
commonly used by MilkDrop 2 presets and removing the straight-line artifacts visible in strong
warp/zoom/rotation presets at 32×24.

To keep this affordable on the additional ~2.3x vertices, `PerPixelMesh::CalculateMesh()` runs the
per-pixel evaluation loop with `#pragma omp parallel for` when built with `ENABLE_OPENMP=ON`.
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

- `'high'` → 48×36 (default)
- `'low'` → 32×24 (previous default, used as the fallback on `navigator.hardwareConcurrency < 4`)
- `'auto'` (default) picks between the two based on `navigator.hardwareConcurrency`

The choice is persisted in `localStorage.meshQuality` and can be overridden per page load with
`?meshQuality=high|low|auto`, or changed at runtime via `window.pmSetMeshQuality(quality)`.

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

The WASM render loop already drives `renderLoop()` via
`emscripten_set_main_loop((void (*)())renderLoop, 0, 0)` with
`emscripten_set_main_loop_timing(EM_TIMING_RAF, 1)` (`projectM_emscripten.cpp`), i.e. it is already
vsync/`requestAnimationFrame`-driven, uncapped by a fixed timer. No change was needed here; this
section documents that the acceptance criterion was already satisfied.
`emscripten_request_animation_frame_loop` was considered but not adopted — the existing
`emscripten_set_main_loop` + `EM_TIMING_RAF` combination already provides rAF-paced callbacks
without the API and lifecycle changes that switching would require.

### Adaptive quality governor (WASM, v1)

Implemented in `projectM_emscripten.cpp` as `UpdateQualityGovernor()`, called once per frame from
`renderLoop()` with the wall-clock time of the whole render (measured via `emscripten_get_now()`,
always-on, independent of `g_perfHudEnabled`). v1 is intentionally minimal — it only steps the
per-pixel mesh resolution between two tiers (matching `html/projectm-mesh-quality.js`):

- **Tier 0 (high)**: 48×36 mesh (the new default, see above).
- **Tier 1 (low)**: 32×24 mesh.

Thresholds, relative to a budget of `1000 / targetFps` ms (≈16.7 ms at the default 60 fps):

- **Step down** a tier after **30 consecutive frames** (~0.5 s @ 60 fps) where the frame time
  exceeds **1.5×** budget (~25 ms).
- **Step up** a tier after **120 consecutive frames** (~2 s @ 60 fps) where the frame time is
  under **0.8×** budget (~13.3 ms).
- Frames within **10 frames** after a preset finishes loading (`app_data.loading` transitioning
  `true` → `false`) are excluded from both counters, so a single slow ASYNCIFY preset-compile
  spike cannot trigger a permanent downgrade. Frames while `app_data.loading == true` are skipped
  entirely (pre-existing `renderLoop()` early return).

On startup, the governor's tier is lazily synced from whatever mesh size
`html/projectm-mesh-quality.js` already applied (`projectm_get_mesh_size`), so the two systems
don't fight each other.

Full multi-subsystem governance (blur passes, FBO resolution, etc.) is out of scope for v1 — see
`html/projectm-fps-governor.js` and `UpdateQualityGovernor()` for where to extend it.

### Exported controls

New WASM exports (`projectM_emscripten.cpp`, wired up in `CMakeLists.txt` and
`scripts/build_wasm_smoke_wrapper.sh`):

- `Module._set_target_fps(fps)` — sets `m_targetFps` (`projectm_set_fps`) and the governor's
  budget reference. Resets the governor's consecutive-frame counters.
- `Module._set_quality_governor(enabled)` — enables/disables automatic tier changes without
  affecting the current tier.
- `Module._get_quality_tier()` — returns the current tier (0 = high/48×36, 1 = low/32×24).

`html/projectm-fps-governor.js` (`setupFpsGovernor(Module)`, called from `projectm-core.html`)
applies `?targetFps=`/`?governor=0|1` query params or `localStorage.targetFps` /
`localStorage.qualityGovernor`, and exposes `window.pmSetTargetFps(fps)`,
`window.pmSetQualityGovernorEnabled(enabled)`, and `window.pmGetQualityTier()` for host UIs.
`window.pmOnGovernorTierChange(tier)`, if defined by the host page, is called whenever the
governor changes tiers.

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

- Build success/failure (including compatibility with `ENABLE_WASM_TRANSITIONS`'s
  `ASYNCIFY_STACK_SIZE` tuning).
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

These two showed real size wins but touch code paths (GL emulation, JS minification of pthread /
audio-worklet glue) that cannot be regression-tested without a browser. Per "keep only measurable
wins", they are **not** adopted in this pass — flagged here so a follow-up with display access can
verify and land them.

| Flag change | `.wasm` size | `.js` size | Link time | Risk / what to verify |
|---|---|---|---|---|
| `-s FULL_ES3=0` (was `=1`), combined with `-flto` | 2,024,444 B (-104 B vs. `-flto` alone) | 222,926 B (**-10,365 B / -4.4%**) | 30.6 s | With `MIN_WEBGL_VERSION=2`/`MAX_WEBGL_VERSION=2` (native WebGL2), `FULL_ES3=1`'s additional ES3-emulation-on-top-of-WebGL2 code may be largely redundant — build links cleanly with no undefined-symbol errors. **Needs verification**: render a frame in-browser (dual-FBO ping-pong, blur chain, transitions) to confirm no GL call relies on `FULL_ES3`-only emulation paths. If confirmed safe, re-check whether `GL_MAX_TEMP_BUFFER_SIZE=33177600` / `GL_POOL_TEMP_BUFFERS=0` are still needed (per the original issue's note) — both are currently sized for the `FULL_ES3=1` temp-buffer emulation path. |
| `--closure 1`, combined with `-flto` | 2,024,548 B (unchanged) | 96,042 B (**-137,249 B / -58.8%**) | 47.8 s (+22.4 s vs. baseline) | Largest single win measured, but Closure Compiler's advanced renaming/minification is the highest-risk change here: must verify `MODULARIZE=1`/`EXPORT_NAME=createModule`, all `EXPORTED_FUNCTIONS`/`EXPORTED_RUNTIME_METHODS`, the `EM_JS`/`EM_ASM` glue (e.g. `window.pmOnPerfFrame`, `window.pmGetFboFormat`, etc. from `html/projectm-*.js`), `AUDIO_WORKLET=1`, and the pthread Worker bootstrap all still function in-browser. **Needs verification**: full smoke test of audio playback, preset transitions, and all `window.pm*` hooks with `--closure 1` enabled. |

### Analyzed, not changed (high risk / needs dedicated effort)

| Candidate | Finding |
|---|---|
| `-s ASYNCIFY=1` | Removing or restructuring this is **not** a flag flip — `ENABLE_WASM_TRANSITIONS` (`ASYNCIFY_STACK_SIZE=65536`) depends on ASYNCIFY for non-blocking shader compilation and concurrent preset loading during transitions (see "Phase 4/5" comments in `projectM_emscripten.cpp`). Replacing it with `-s JSPI=1` for preset loading only, while keeping the render loop ASYNCIFY-free, is a real refactor (separate render vs. load call graphs) requiring its own design + in-browser testing of transitions. Deferred as its own follow-up, not bundled into this flag-audit pass. |
| `NO_DISABLE_EXCEPTION_CATCHING` → `-fwasm-exceptions` | Changes the exception-handling ABI for **every** translation unit, including the prebuilt static libraries — this requires a full rebuild of `libprojectM-4.a`/`libprojectM-4-playlist.a` with the new flag (not a link-only change like the items above), plus in-browser verification that thrown `MilkdropPresetLoadException`/parser errors during preset loading are still caught correctly by `projectM_emscripten.cpp`'s error-surfacing path. All evergreen browsers now support native WASM exceptions, so this is likely a real win, but the rebuild + verification cost puts it out of scope for this pass. |
| `-sINITIAL_MEMORY=1024mb` | Right-sizing this requires the *actual* peak heap usage at runtime (with `ALLOW_MEMORY_GROWTH=1` already set, this only controls the initial allocation, trading startup `memory.grow` calls vs. up-front allocation). Static analysis of the `.wasm`/`.a` files cannot determine runtime heap peaks. **Needs**: run with `?benchmark=1` plus a browser memory profiler (e.g. Chrome `performance.memory` or `--enable-precise-memory-info`) across a few presets, then pick the smallest `INITIAL_MEMORY` that avoids `memory.grow` during steady-state playback. |
| `GL_MAX_TEMP_BUFFER_SIZE=33177600` / `GL_POOL_TEMP_BUFFERS=0` | Tied to the `FULL_ES3` decision above — re-evaluate together once `FULL_ES3=0` is verified in-browser. |

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

### Part A: OffscreenCanvas render worker (opt-in, default OFF)

Added `html/projectm-render-worker.js` (runs in a dedicated Worker) and
`html/projectm-render-worker-host.js` (main-thread bridge), wired into
`html/projectm-core.html`'s `attemptInit()`.

**Disabled by default** — enable with `?renderWorker=1` or
`localStorage.renderWorker = '1'`. This was a deliberate scoping decision: this
environment has no browser/display, so none of Part A's "Verify" steps (worker
render path, Safari/Firefox fallback, audio reactivity after migration) can be
exercised here. Keeping it opt-in with feature detection means:

- Browsers without `OffscreenCanvas`/`transferControlToOffscreen`/`Worker` are
  completely unaffected (the existing main-thread path is untouched and remains
  the default for 100% of current users).
- Browsers *with* OffscreenCanvas support also get the unchanged main-thread
  path by default, until the opt-in path has been verified in real browsers.

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

**Known limitations of this opt-in path (not yet wired)**:

- Startup/random preset loading (`projectm-presets.js`'s
  `loadStartupApiPresets`/`loadRandomApiPreset`), the FBO-format degraded-mode
  banner (`projectm-fbo-format.js`), and the on-screen perf HUD
  (`projectm-perf.js`) all call `Module.*` directly *and* manipulate the DOM —
  neither is available to the worker's `Module` instance. In render-worker mode,
  the worker renders with whatever preset(s) `_init()`/`main()` load by default;
  these richer UI integrations are a follow-up once the core worker path is
  verified in-browser.
- **Nested OpenMP/pthread workers**: the WASM module is built with
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

**Browser matrix tested**: none — no browser/display is available in this
environment. To test:

1. Serve `html/` (needs to be served with `Cross-Origin-Opener-Policy: same-origin`
   and `Cross-Origin-Embedder-Policy: require-corp` for the SharedArrayBuffer PCM
   ring to activate; without those headers, PCM still works via the
   `postMessage` fallback).
2. Desktop Chrome, `?renderWorker=1`: open DevTools Performance tab, confirm the
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
5. Without `?renderWorker=1` (default): confirm behavior is bit-for-bit
   identical to before this change (no new network requests, no new Workers).

**Perf numbers**: not measured (no browser). The new files add
`html/projectm-render-worker.js` (~5 KB) and
`html/projectm-render-worker-host.js` (~5 KB), loaded only when
`?renderWorker=1` is set — zero added bytes/requests for the default path.

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
