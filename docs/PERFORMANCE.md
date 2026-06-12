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
