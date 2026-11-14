[![Windows Build Status](https://github.com/ford442/Project-M/actions/workflows/build_windows.yml/badge.svg?branch=main)](https://github.com/ford442/Project-M/actions/workflows/build_windows.yml)
[![Linux Build Status](https://github.com/ford442/Project-M/actions/workflows/build_linux.yml/badge.svg?branch=main)](https://github.com/ford442/Project-M/actions/workflows/build_linux.yml)
[![macOS Build Status](https://github.com/ford442/Project-M/actions/workflows/build_osx.yml/badge.svg?branch=main)](https://github.com/ford442/Project-M/actions/workflows/build_osx.yml)
[![Emscripten Build & Test Status](https://github.com/ford442/Project-M/actions/workflows/build_emscripten.yml/badge.svg?branch=main)](https://github.com/ford442/Project-M/actions/workflows/build_emscripten.yml)
[![Android Build Status](https://github.com/ford442/Project-M/actions/workflows/build_android.yml/badge.svg?branch=main)](https://github.com/ford442/Project-M/actions/workflows/build_android.yml)

![Logo](docs/web/logo.png)

# Project-M: projectM in the browser, and a few things besides

**This is a fork.** `ford442/Project-M` tracks the official
[projectM](https://github.com/projectM-visualizer/projectm) (`projectM-visualizer/projectm`), the open-source C++
reimplementation of the Winamp [Milkdrop](https://en.wikipedia.org/wiki/MilkDrop) music visualizer by Geiss. It reads audio
PCM, analyzes it (FFT, beat detection) and renders Milkdrop presets (equations plus pixel shaders) with OpenGL. Upstream's
library, C API and playlist library are all still here; this fork adds a WebAssembly build with a browser host and a handful
of library features. For end-user applications, preset packs and the project's history, see the
[upstream README](https://github.com/projectM-visualizer/projectm#readme).

`main` is where the fork is developed; `master` is a read-only mirror of upstream. How the two are kept in step, and which
differences are deliberate, is in [`docs/UPSTREAM_SYNC.md`](docs/UPSTREAM_SYNC.md).

## What this fork adds

- **Browser / WASM host.** [`src/wasm/`](src/wasm) is the Emscripten wrapper (multiple engines per module, per-host WebGL
  contexts, preset preparation on a pthread, SharedArrayBuffer audio ingest); [`html/`](html) is the host layer, the ES modules
  that boot it, size the canvas, feed audio and build the demo pages ([`docs/HOST_LAYER.md`](docs/HOST_LAYER.md),
  [`docs/WASM_JS_API.md`](docs/WASM_JS_API.md)).
- **`@projectm/web`**, an embeddable SDK in [`packages/web/`](packages/web): a `<project-m-visualizer>` custom element and a
  typed context API over the same modules ([README](packages/web/README.md)).
- **C API extensions** in `src/api/include/projectM-4/`: `rhythm.h` (tempo, beat, bar and section info, `pm_*` preset
  variables, beat-aligned preset switching), `live_input.h` (live textures, host values for per-frame variables),
  `preset_prepare.h` (staged preset loading), `offline_render.h`, `texture_reload.h`, `projectm_perf.h`.
- **Offline renderer.** `projectm-render` (`-DENABLE_RENDER_TOOL=ON`, Linux/BSD) renders a preset plus audio on a virtual
  clock into raw frames or a pixel hash, deterministically ([`docs/OFFLINE_RENDER.md`](docs/OFFLINE_RENDER.md)).
- **Render-device seam and `EngineContext`.** All GL sits behind `Renderer/Device` (`IRenderDevice`), groundwork for another
  backend ([`docs/RENDER_DEVICE.md`](docs/RENDER_DEVICE.md)); per-engine state (seed, perf timers, log callback) lives in an
  `EngineContext`, so engines run side by side without sharing it.
- **Performance work:** GPU evaluation of per-pixel equations ([`docs/GPU_PERPIXEL_EVAL.md`](docs/GPU_PERPIXEL_EVAL.md)),
  OpenMP and SIMD, a flash limiter, transition shaders, a frame-time HUD and benchmarks ([`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)).
- **Preset corpora** in [`presets/`](presets): `tests/` (parser fixtures), `custom/` (curated), `weeks/` (community), plus
  `quarantine/` and `experimental/`, with a GPU-free static audit (`scripts/audit_presets.mjs`, [`docs/PRESET_AUDIT.md`](docs/PRESET_AUDIT.md)).
- **`vendor/projectm-eval` is a fork too:** [`ford442/projectm-eval`](https://github.com/ford442/projectm-eval), branch
  `context-rng` (upstream 1.0.7 plus a per-context `rand()` stream).

## Live site

The deployed browser build is served from **https://projectm.1ink.us/** (the `prod` target of `deploy.py`); `deploy.py` also
publishes to staging hosts at `test.1ink.us/projectm.1ink.us/` and `go.1ink.us/projectm.1ink.us/`
([`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)). The bundle is threaded, so the page must be served with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Browser floor: Safari 16.4,
Chrome 91, Firefox 89. Which bundle is current and what changed in each is in [`CHANGELOG.md`](CHANGELOG.md).

## Building

```bash
git clone https://github.com/ford442/Project-M.git && cd Project-M
git submodule update --init --recursive      # vendor/projectm-eval is the fork, see above

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
cmake --build build --parallel
```

On Linux `BUILD_TESTING=ON` also needs `libsdl2-dev`. If a system projectM-eval is installed, add
`-DENABLE_SYSTEM_PROJECTM_EVAL=OFF`: an installed upstream copy lacks the per-context `rand()` stream and compiles the GPU
per-pixel path out. An older clone whose `vendor/projectm-eval` still points at upstream needs
`git submodule sync vendor/projectm-eval && git submodule update --init vendor/projectm-eval`; the configure step stops and
says so. Dependencies, options and other platforms: [`docs/BUILDING.md`](docs/BUILDING.md), [`docs/BUILDING-cmake.md`](docs/BUILDING-cmake.md).
The WebAssembly bundle is built with `scripts/build_wasm.sh` under Emscripten SDK **6.0.6**, the version CI pins and the only
one the golden images are verified against ([`docs/EMSCRIPTEN.md`](docs/EMSCRIPTEN.md), "Building the bundle").

## Testing

```bash
ctest --test-dir build --build-config Release     # C++ unit tests (GPU tests need a display or xvfb-run)
scripts/test_presets.sh                            # parse and transpile the preset corpora
npm install && npm test                            # browser host layer and @projectm/web (also: npm run lint, npm run typecheck)
node tests/wasm-smoke/run.mjs <glue.js> <preset>   # headless-browser smoke test of a built bundle
```

[`AGENTS.md`](AGENTS.md) is the full reference for build options, test suites, CI gates and conventions.

## Using the library

At its core this is **libprojectM**, a C library with a stable C API (`projectM-4/*.h`) that parses presets, analyzes PCM audio
and renders with OpenGL Core 3.3 or OpenGL ES 3, into a dedicated context or a texture. Upstream's
[developer wiki](https://github.com/projectM-visualizer/projectm/wiki#integrating-projectm-into-applications) covers
integration; the fork's additions are documented in [`docs/`](docs). Upstream's README also lists a
[Rust crate](https://crates.io/crates/projectm), a [GStreamer plugin](https://github.com/projectM-visualizer/gst-projectm/)
and the [Milkdrop expression library](https://github.com/projectM-visualizer/projectm-eval) that the evaluator fork is based on.
libprojectM does not bundle presets: this repo's `presets/` serve tests, the demo site and authoring, and upstream's packs
live in [separate repositories](https://github.com/projectM-visualizer/projectm#presets).

## Documentation

| Topic | Start at |
|---|---|
| Build and test | [`AGENTS.md`](AGENTS.md), [`docs/BUILDING.md`](docs/BUILDING.md), [`docs/EMSCRIPTEN.md`](docs/EMSCRIPTEN.md) |
| Releases and versions | [`CHANGELOG.md`](CHANGELOG.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), [`docs/adr/0001-wasm-and-media-hosting.md`](docs/adr/0001-wasm-and-media-hosting.md) |
| Browser host and SDK | [`docs/HOST_LAYER.md`](docs/HOST_LAYER.md), [`docs/WASM_JS_API.md`](docs/WASM_JS_API.md), [`html/README.md`](html/README.md), [`packages/web/README.md`](packages/web/README.md) |
| Engine | [`docs/AUDIO_PIPELINE.md`](docs/AUDIO_PIPELINE.md), [`docs/RENDER_DEVICE.md`](docs/RENDER_DEVICE.md), [`docs/LIVE_INPUT.md`](docs/LIVE_INPUT.md), [`docs/OFFLINE_RENDER.md`](docs/OFFLINE_RENDER.md), [`docs/transition_shaders.md`](docs/transition_shaders.md) |
| Performance | [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md), [`docs/BENCHMARKING.md`](docs/BENCHMARKING.md), [`docs/GRAPHICS_BENCHMARK_HARNESS.md`](docs/GRAPHICS_BENCHMARK_HARNESS.md), [`docs/GPU_PERPIXEL_EVAL.md`](docs/GPU_PERPIXEL_EVAL.md), [`docs/openmp.md`](docs/openmp.md) |
| Presets | [`docs/MILK_PRESET_GUIDE.md`](docs/MILK_PRESET_GUIDE.md), [`docs/WRITING_NEW_MILK_PRESETS_GUIDE.md`](docs/WRITING_NEW_MILK_PRESETS_GUIDE.md), [`docs/PRESET_AUDIT.md`](docs/PRESET_AUDIT.md), [`docs/PRESET_ROADMAP.md`](docs/PRESET_ROADMAP.md) |
| Upstream and the eval fork | [`docs/UPSTREAM_SYNC.md`](docs/UPSTREAM_SYNC.md) |
| Coding agents | [`claude.md`](claude.md), [`docs/agents/`](docs/agents) |
| Historical | [`docs/archive/`](docs/archive) |

## Help and contributing

Issues and pull requests for this fork go to [ford442/Project-M](https://github.com/ford442/Project-M/issues). If a problem
also reproduces on upstream's `master`, or concerns the core library or C API as upstream ships them, report it to the
[projectM issue tracker](https://github.com/projectM-visualizer/projectm/issues) too. The upstream community is on
[Discord](https://discord.gg/N9DyQfCH4j). Read [`AGENTS.md`](AGENTS.md) before sending code, and add user-visible changes to
[`CHANGELOG.md`](CHANGELOG.md).

## Credits and license

projectM is the work of the [projectM team and contributors](AUTHORS.txt); Milkdrop is by Ryan Geiss. The upstream project and
its authors are the origin of everything under `src/libprojectM`, and this fork's additions build on it.

Released under the [GNU Lesser General Public License 2.1](LICENSE.txt) (`LGPL-2.1-only`), which keeps changes open while
allowing libprojectM to be used from closed-source applications as a shared library, provided the license terms are met.
Third-party code under `vendor/` carries its own licenses; check them before redistributing.
