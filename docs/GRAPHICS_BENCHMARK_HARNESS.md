# Graphics benchmark & golden-image harness

Reproducible frames for the projectM WASM renderer, and a frame-budget record
that can say whether a change made things slower.

Companion to [`GRAPHICS_PERF_RECOVERY_PLAN.md`](GRAPHICS_PERF_RECOVERY_PLAN.md),
which tracks [#174](https://github.com/ford442/Project-M/issues/174). That plan's
standing caveat was that **no sub-issue had a measured before/after** — every
finding in it was reached by reading and writing the tree. This is the machinery
for changing that.

---

## Why this exists

Two open projects — [#227](https://github.com/ford442/Project-M/issues/227)
(WebGPU backend) and [#229](https://github.com/ford442/Project-M/issues/229)
(Milkdrop 2 multi-pass shaders) — are both *"rewrite the renderer and keep it
looking the same"*. Without a golden-image gate the only regression detector is
somebody noticing a preset looks off, weeks later. And the rest of #174's backlog
is blocked on being able to measure at all.

---

## The hard part: making a frame reproducible

A Milkdrop frame is a function of **(preset, audio history, frame index, RNG,
time)**. All five have to be pinned, or a golden image is a photograph of one
run rather than a description of the renderer.

| Input | How it is pinned | Where |
|---|---|---|
| Preset | One preset per page load, written into MEMFS. | `deterministic_capture.html` |
| Audio | `generateDeterministicBlock(frameIndex)` — every sample a pure function of its absolute index — one block per rendered frame, through the WASM PCM ring. | `html/projectm-synthetic-audio.js` |
| Frame index | The RAF main loop is **paused**; the harness calls `render_frame()` itself, once per audio block. | `set_render_loop_paused()` |
| RNG | `projectm_set_deterministic_seed()` before `init()`. | `src/libprojectM/RandomSeed.cpp` |
| Time | Virtual clock: frame N happens at exactly N/fps, pushed into the engine via `projectm_set_frame_time()`. | `src/wasm/WasmDeterminism.cpp` |

Three of those deserve their reasoning spelled out, because each replaced
something that looked like it already worked.

**Audio was the one that had to be fixed first.** Before the SAB PCM ring
([#235](https://github.com/ford442/Project-M/issues/235)) landed, audio reached
the engine sampled per animation frame, so how much audio a frame had seen was a
function of how the machine scheduled the browser. You cannot golden-image a
renderer whose input varies with frame timing. The ring made ingest frame-exact;
this harness supplies a schedule that is a pure function of the frame index, so
"the audio history behind frame 300" is now a fixed thing.

**Frames are pumped, not animated.** `start_render()` registers an Emscripten
main loop driven by `requestAnimationFrame`. Under RAF, "frame 300" is a
different amount of accumulated feedback on every run and every machine — and
the Milkdrop feedback buffer accumulates, so that difference is permanent, not
transient. The capture pauses the loop straight after `start_render()` and drives
`render_frame()` directly.

**RNG seeds do not depend on call ordering.** `RandomSeed::Get(domain)` is a pure
function of (host seed, call-site name). The obvious alternative — one global
generator handing out successive values — makes every seed depend on how many
draws happened before it, so adding a log line or a lazily-constructed object
silently reshuffles the whole set and invalidates every golden. The cost is that
two objects in the same domain (the two `PresetState`s alive during a crossfade)
draw the same values; for a harness rendering one preset per page that is the
behaviour you want.

### What is *not* pinned

- **The GPU.** Same inputs on two drivers still differ in low bits. That is why
  the golden comparison is perceptual (below) and why goldens are produced by one
  known rasterizer.
- **libc `rand()`.** `MilkdropShader`'s per-frame `rand_frame` uniform draws from
  it. `projectm_set_deterministic_seed()` calls `srand()`, which pins the stream,
  but a single global sequence only reproduces when the sequence of draws from it
  is identical. True for a deterministic single-engine frame schedule; not true
  if two engines render interleaved in one process.
- **OpenMP thread count.** `MilkdropNoise` seeds per thread index, so the noise
  textures are reproducible for a fixed thread count and change if the pool size
  changes. Pin threads when regenerating goldens.

---

## Two gates, two runners

Getting this backwards produces a perf gate that flaps and gets disabled within a
month, so it is worth being explicit:

| | Golden images | Frame budget |
|---|---|---|
| Question | Did the picture change? | Did it get slower? |
| Runner | Hosted, software GL (ANGLE/SwiftShader) | Real GPU (self-hosted or nightly) |
| Runs | Every PR, blocking | Nightly / on demand |
| Why | SwiftShader is deterministic and free. Its **timings are meaningless**. | Only real GL produces numbers worth comparing. |
| Workflow | `build_emscripten.yml` (where the WASM bundle already exists) | `graphics_perf_bench.yml` |

`compareBenchmarks()` enforces the split in code, not just in documentation: a
record marked `softwareGl`, or a comparison across two different runners, is
reported and **never gates**.

---

## Running it

Everything below assumes an Emscripten build has produced a smoke bundle:

```bash
emcmake cmake -S . -B cmake-build -DCMAKE_INSTALL_PREFIX="$PWD/install" -DENABLE_WASM_TRANSITIONS=ON
emmake cmake --build cmake-build --parallel
(cd cmake-build && emmake make install)
ENABLE_WASM_TRANSITIONS=ON INSTALL_DIR="$PWD/install" OUT_DIR="$PWD/cmake-build/wasm-smoke" \
  scripts/build_wasm_smoke_wrapper.sh
```

### Harness unit tests (no browser, no toolchain)

```bash
scripts/test_graphics_harness.sh
```

Covers PNG round-tripping, the perceptual diff and its tolerances, the
frame-budget percentiles and the regression gate, and the deterministic audio
schedule. These decide whether a PR goes red, so they are tested like production
code.

### Determinism self-check — run this before trusting anything else

```bash
node tests/wasm-smoke/golden_images.mjs \
  --module cmake-build/wasm-smoke/projectm-v.030-thread.js --self-check
```

Captures every preset twice in one browser and requires **byte-identical**
output. Not a tolerance — zero differing pixels. If this fails, some frame input
is still unpinned and every golden comparison is noise.

### Golden images

```bash
# Compare against the committed goldens (this is the gate)
node tests/wasm-smoke/golden_images.mjs --module cmake-build/wasm-smoke/projectm-v.030-thread.js

# Regenerate them (review the PNGs before committing — --update accepts whatever rendered)
node tests/wasm-smoke/golden_images.mjs --module ... --update

# One preset, on the machine's real GL, for a local look
node tests/wasm-smoke/golden_images.mjs --module ... --gpu --preset presets/tests/110-per_pixel.milk
```

Failures write a `golden | actual | diff` triptych to `benchmark-results/golden/`
and CI uploads it as an artifact. Reviewing a visualizer change without seeing
the pixels is guesswork.

`PROJECTM_CHROMIUM_EXECUTABLE` overrides the browser binary, for environments
that ship a Chromium other than the one Playwright pins.

### Frame budget

```bash
node scripts/benchmark_presets_wasm.mjs cmake-build/wasm-smoke/projectm-v.030-thread.js \
  --audio-load --out benchmark-results/preset-benchmark.json
node scripts/record_frame_budget.mjs --input benchmark-results/preset-benchmark.json --runner my-gpu-box
node scripts/compare_benchmark_results.mjs \
  --base benchmark-results/<base-sha>.json --head benchmark-results/<head-sha>.json
```

`record_frame_budget.mjs` projects the benchmark page's rich output onto the
narrow, stable shape the gate reads, keyed by commit, so `benchmark-results/`
accumulates one record per commit.

---

## How the comparison decides

**Golden images** — two numbers, failing different regressions:

- `ssim` (structural similarity) catches *the picture changed*: a flip, a shifted
  mesh, a dropped blur pass, a preset that stopped reacting. Insensitive to
  uniform small shifts in level.
- `differingFraction` (share of pixels off by more than `pixelThreshold` on any
  channel) catches localized damage that a whole-image SSIM average dilutes.

Both must pass. Tolerances live in `tests/wasm-smoke/golden/manifest.json`. Byte
equality is deliberately **not** the cross-machine gate — a byte-exact gate on a
visualizer goes red on its first driver bump and is switched off a week later.
It *is* the same-machine determinism gate, where it is exactly right.

**Frame budget** — relative, one-sided, on p95:

- Fails when p95 rises more than `--max-regression-pct` (default 15%) against the
  base run **on the same runner**.
- A delta under `--min-absolute-delta-ms` (default 0.5 ms) is called unchanged
  whatever the percentage: 0.30 → 0.36 ms is +20% and means nothing.
- p95, not mean (the mean hides the stalls that make a visualizer look broken)
  and not p99 (on a few hundred frames that is one sample).
- Never an absolute target. CI runners are too noisy; an absolute gate is red on
  arrival.

---

## Acceptance criteria, and where each is checked

| Criterion | Where | Measured |
|---|---|---|
| Two consecutive runs on an unchanged commit produce byte-identical captures under software GL | `--self-check`, blocking in `build_emscripten.yml` | Yes — all 13 presets, both frames, 0 differing pixels |
| A deliberately introduced one-pixel Y-flip in `CopyTexture` fails the gate | Property tested directly in `tests/graphics-harness/image-diff.test.mjs` ("a one-pixel horizontal shift", "a vertical flip"); end to end by the golden gate | Yes — a one-pixel Y offset in `TryBlit()`'s destination rectangle failed 22 of 26 checks (exit 1); a clean rebuild then matched every golden at ssim 1.00000 |
| `benchmark-results/` accumulates per-commit JSON | `scripts/record_frame_budget.mjs`, run nightly | Plumbing exercised on software GL; a *gateable* baseline still needs a GPU runner |
| A PR regressing p95 by >15% is red, with a table showing which presets moved | `scripts/compare_benchmark_results.mjs`, tested in `frame-budget.test.mjs` | Unit-tested; not yet exercised against two real GPU records |

The four checks that survived the injected Y-offset were the sparsest presets
(a thin waveform on black) at frame 300, where a one-pixel shift moves less than
0.2% of the pixels. Nothing about the gate is wrong there — it is the honest
sensitivity floor of a perceptual comparison on a near-empty frame, and it is
the reason the manifest pairs SSIM with a differing-pixel fraction instead of
trusting either alone.

---

## The goldens

`tests/wasm-smoke/golden/images/` holds 26 PNGs — 13 presets at frames 60 and
300 — captured on ANGLE/SwiftShader from an Emscripten build of this tree. The
CI step gates against them; it only falls back to uploading a candidate set as
the `golden-images-bootstrap` artifact when that directory is empty.

Regenerate on the same runner kind that produced the originals (software GL),
and re-review whenever a change legitimately alters output — `--update` accepts
whatever rendered, including a regression.

### What the first capture cost

The determinism claims above were written against the code; capturing the set
found four things that reading could not, all of which produced a
plausible-looking image rather than an error:

1. **The preset never loaded.** `load_preset_file()` yields to the browser
   (`emscripten_sleep(0)`) before it compiles shaders, so under ASYNCIFY the
   `ccall` returns with the load only started. The settle loop pumped frames
   synchronously and never let the continuation run, so every capture died at
   "Preset not ready after 30 settle frames". The page now waits for the load to
   complete — in event-loop turns, rendering nothing, so the settle count stays
   fixed.
2. **No audio reached the engine.** The host-side ring writer reads
   `Module.HEAPF32.buffer`, and `HEAPF32` was not in `EXPORTED_RUNTIME_METHODS`;
   `readPcmRingDescriptor()` returned null, the direct fallback needed the same
   view, and `feedPcmToModule()` silently dropped every block. Since
   [#235](https://github.com/ford442/Project-M/issues/235) made the ring the only
   ingest, that view is part of the host API. The capture page now asserts one
   fed block per rendered frame rather than trusting the wiring.
3. **The engine's clock was still real at preset-load time.** `TimeKeeper` only
   adopts the virtual clock inside `RenderFrame()`, and `StartPreset()` stamps
   the *current* `m_currentTime` as the preset's start. Loading before any frame
   had run therefore anchored `time` (and the transition's progress) to however
   long shader compilation took — the single largest source of run-to-run
   divergence, and invisible until audio was flowing to make the renderer react.
   The page pumps one priming frame before the load, then restarts the count.
4. **Every capture was a picture of a crossfade.** The default (soft) cut left a
   transition running through the capture frames, so each golden showed the
   default preset blending into the subject. The page loads with a hard cut;
   `load_preset_file_hard` had to be added to the exported API to allow it.

With those four fixed, all 13 presets are byte-identical across two runs.

---

## Files

| Path | What |
|---|---|
| `tests/wasm-smoke/deterministic_capture.html` | The reproducible-frame capture page |
| `tests/wasm-smoke/golden_images.mjs` | Golden gate runner (`--self-check`, `--update`, `--gpu`) |
| `tests/wasm-smoke/golden/manifest.json` | Preset set, capture frames, tolerances |
| `tests/wasm-smoke/lib/png.mjs` | Dependency-free PNG read/write |
| `tests/wasm-smoke/lib/image-diff.mjs` | SSIM + per-pixel diff, tolerance policy, triptychs |
| `tests/wasm-smoke/lib/frame-budget.mjs` | Percentiles, the regression gate, the Markdown table |
| `tests/wasm-smoke/lib/harness-runtime.mjs` | Static server (COOP/COEP), Chromium launch modes |
| `scripts/record_frame_budget.mjs` | Benchmark run → per-commit record |
| `scripts/compare_benchmark_results.mjs` | Base vs head → table + exit code |
| `scripts/test_graphics_harness.sh` | Harness unit tests + manifest validation |
| `src/libprojectM/RandomSeed.{hpp,cpp}` | Process-global RNG seed policy |
| `src/wasm/WasmDeterminism.cpp` | Virtual clock, seed switch, main-loop pause |
