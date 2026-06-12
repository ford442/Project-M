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
