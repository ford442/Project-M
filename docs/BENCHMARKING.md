# Preset-focused benchmarking

Repeatable performance measurements for **preset loading**, **per-frame / per-pixel
cost**, **preset switch time**, and **audio pipeline** load — in both **native**
gtest and **WASM/Playwright** environments.

Primary entry point: **`./optimize.sh`** (wasm-opt + benchmark modes).

Related: [`docs/PERFORMANCE.md`](PERFORMANCE.md) (HUD, OpenMP notes), issue
[#117](https://github.com/ford442/Project-M/issues/117).

## Quick reference

| Goal | Command |
|------|---------|
| Shrink WASM binary | `./optimize.sh` |
| Full WASM preset suite | `./optimize.sh --bench wasm` |
| WASM + audio PCM load | `./optimize.sh --bench wasm --audio-load` |
| Native parse + FFT + audio | `./optimize.sh --bench native` |
| Preset parse only | `./optimize.sh --bench parse` |
| Audio pipeline only | `./optimize.sh --bench audio` |
| OpenMP on vs off FFT | `./optimize.sh --bench openmp` |
| Everything | `./optimize.sh --bench all` |
| Save baseline | `./optimize.sh --bench wasm --baseline benchmark-results/wasm-baseline.json` |
| Compare to baseline | `./optimize.sh --bench wasm --compare benchmark-results/wasm-baseline.json` |

Results land in `benchmark-results/` (gitignored except `.gitkeep`).

## Prerequisites

### Native benchmarks

```bash
cmake -G "Ninja Multi-Config" -S . -B cmake-build \
  -DCMAKE_CXX_COMPILER=g++ -DCMAKE_C_COMPILER=gcc \
  -DCMAKE_CXX_FLAGS="-include atomic" \
  -DBUILD_TESTING=ON -DENABLE_OPENMP=ON
cmake --build cmake-build --config Release --target projectM-unittest
./optimize.sh --bench native --build-dir cmake-build
```

### WASM benchmarks

```bash
# Emscripten smoke wrapper (see scripts/build_wasm_smoke_wrapper.sh)
ENABLE_WASM_TRANSITIONS=ON INSTALL_DIR="$PWD/install" \
  OUT_DIR="$PWD/cmake-build/wasm-smoke" scripts/build_wasm_smoke_wrapper.sh

npm install --no-save playwright   # once
npx playwright install chromium  # once

./optimize.sh --bench wasm
# or explicitly:
node scripts/benchmark_presets_wasm.mjs cmake-build/wasm-smoke/projectm-v.030-thread.js
```

Requires **COOP/COEP** headers — the Playwright harness serves files with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.

## Benchmark modes

### 1. WASM preset render (`--bench wasm`)

**Harness:** `tests/wasm-smoke/benchmark.html` + `scripts/benchmark_presets_wasm.mjs`

**Preset list:** `presets/benchmark_curated.json` (override with `PROJECTM_BENCH_MANIFEST`)

Per preset, collects:

| Metric | Source |
|--------|--------|
| **FPS / totalMs** | `projectm_perf` via `set_perf_hud(1)` |
| **perFrameEvalMs** | Per-frame equation eval |
| **perPixelEvalMs** | Per-pixel mesh + warp |
| **audioMs** | `PCM::UpdateFrameAudioData` |
| **blurMs / compositeMs / gpuMs** | Remaining render stages |
| **loadCallMs** | `load_preset_file` sync call time |
| **switchReadyMs** | Until `is_preset_ready()` (shader compile + first frame) |
| **openmp** | `_get_omp_enabled`, thread counts |

With `--audio-load`, each frame feeds synthetic 120 BPM beat PCM
(`html/projectm-synthetic-audio.js`) so **audioMs** reflects load.

### 2. Native preset parse (`--bench parse`)

**Test:** `PresetPerfBenchTest.ParseThroughput`

Measures `PresetFileParser::Read` + shader code extraction per iteration (no GL).

Log line: `[PresetPerfBench] preset=… parseMsPerIter=…`

### 3. Native audio pipeline (`--bench audio`)

**Test:** `PCMAudioBenchTest.UpdateFrameAudioDataThroughput`

Feeds 576-sample sine each frame; times `PCM::UpdateFrameAudioData` (FFT + loudness + align).

Log line: `[PCMAudioBench] audioUpdateMsPerFrame=…`

### 4. Native OpenMP FFT (`--bench openmp`)

**Script:** `scripts/benchmark_openmp_native.sh`

Builds two trees (`ENABLE_OPENMP=ON` vs `OFF`), runs `OpenMPBenchTest.FftThroughput`, prints JSON speedup.

### 5. Interactive / single-preset (browser)

**B3HD demo** (`html/projectm-core.html`):

```
?perfhud=1                              # on-screen breakdown
?benchmark=1&frames=500&preset=/presets/foo.milk
?audioTest=1                            # synthetic PCM panel
```

Chrome DevTools:

1. **Performance** tab — record while `?perfhud=1` is on; correlate with HUD bars.
2. **Console** — `[projectM benchmark]` JSON from `?benchmark=1`.
3. **Memory** — optional heap snapshots during long benchmark runs.

Emscripten profiling: build with `-g` / source maps; use browser stack samples on
`render_frame` hot paths. The fork's `projectm_perf` timers are lower overhead than
full `-s PROFILING_FUNCS` for preset A/B work.

## Curated preset manifest

Edit `presets/benchmark_curated.json`:

```json
{
  "targetFps": 60,
  "framesPerPreset": 300,
  "warmupFrames": 30,
  "audioBench": { "enabled": false },
  "presets": [
    { "path": "presets/tests/110-per_pixel.milk", "tier": "medium" },
    { "path": "custom_milk_fixed/milk011_optimized.milk", "tier": "heavy" }
  ]
}
```

Add presets you upgrade; re-run baseline after intentional changes.

## Before / after workflow (OpenMP, SIMD, preset upgrades)

```bash
# 1. Baseline before change
./optimize.sh --skip-opt --bench wasm \
  --baseline benchmark-results/before-openmp.json
./optimize.sh --bench native \
  && cp benchmark-results/preset-benchmark-native.json benchmark-results/before-native.json

# 2. Apply optimization (e.g. OpenMP pragma, SIMD flags, preset GPU migration)

# 3. Compare
./optimize.sh --skip-opt --bench wasm \
  --compare benchmark-results/before-openmp.json

# 4. Document in PR: fps median delta, perPixelEvalMs delta, switchReadyMs delta
```

Compare output highlights:

- `fpsDelta` / `totalMsDelta` per preset
- `perPixelDelta` — equation cost changes
- `switchReadyDelta` — load/compile regressions

**Acceptance hints** (from Signature Series workflow):

- Median FPS ≥ 55 on 1280×720 for `tier: heavy` presets in manifest
- `switchReadyMs` median < 3000 ms on software GL (SwiftShader)
- No preset `metTargetFps: false` after upgrade

## File map

| File | Role |
|------|------|
| `optimize.sh` | wasm-opt + `--bench` orchestration |
| `scripts/benchmark_presets_wasm.mjs` | Playwright WASM runner |
| `scripts/benchmark_native.sh` | Native gtest JSON report |
| `scripts/benchmark_openmp_native.sh` | OpenMP A/B FFT |
| `tests/wasm-smoke/benchmark.html` | In-browser benchmark page |
| `html/projectm-perf.js` | HUD + `?benchmark=1` on core demo |
| `html/projectm-synthetic-audio.js` | PCM generators for audio-load mode |
| `presets/benchmark_curated.json` | Preset suite definition |
| `tests/libprojectM/PresetPerfBenchTest.cpp` | Parse throughput |
| `tests/libprojectM/PCMAudioBenchTest.cpp` | Audio update throughput |
| `tests/libprojectM/OpenMPBenchTest.cpp` | FFT throughput |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing WASM bundle` | Run `build_wasm_smoke_wrapper.sh` |
| Playwright timeout | Reduce `framesPerPreset` or preset count |
| `projectM-unittest not found` | `-DBUILD_TESTING=ON` + build target |
| All `audioMs` ≈ 0 | Use `--audio-load` or `?audioTest=1` |
| SwiftShader slow | Expected; compare relative before/after, not absolute FPS vs GPU |
