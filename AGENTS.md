# projectM Agent Guide

This document provides essential context for AI coding agents working on the projectM codebase. projectM is an open-source C++20 library that reimplements the Winamp Milkdrop music visualizer as a modern, cross-platform, reusable library.

**License:** GNU Lesser General Public License 2.1 (LGPL-2.1-only)
**Version:** 4.2.0 (as of `CMakeLists.txt`)
**Repository:** https://github.com/projectM-visualizer/projectm

---

## Project Overview

projectM reads audio PCM data, analyzes it (FFT, beat detection), and renders mesmerizing visuals using OpenGL. The core deliverable is **libprojectM** — a shared or static library with a stable C API. End-user frontends (SDL2, Steam, Qt, etc.) live in separate repositories; this repo contains only the library, a playlist management library, an SDL2-based developer test UI, and the test suite.

Supported platforms: Windows, Linux, macOS (including iOS/tvOS), BSD, Android, and WebGL/WASM via Emscripten. Supported architectures: i686, x86_64, armv7, aarch64, WASM.

---

## Repository Structure

```
├── cmake/                  # CMake modules and helper scripts
├── docs/                   # Sphinx/Doxygen documentation sources
├── presets/                # Preset data: tests/ (parser fixtures, CMake-installed), custom/ (curated
│                           # corpus), weeks/ (community corpus), quarantine/, drafts/. Deployed as
│                           # custom_milk_fixed/ and weeks_presets/ (deploy.py DEPLOY_PRESET_DIRS)
├── scripts/                # Build and upload helper shell scripts
├── src/
│   ├── api/                # C API headers (projectM-4/*.h) + export header generation
│   ├── libprojectM/        # Core visualization library
│   │   ├── Audio/          # PCM, FFT, loudness, beat detection, waveform alignment
│   │   ├── MilkdropPreset/ # Preset parsing, Milkdrop equation/shader evaluation, waveforms
│   │   ├── Renderer/       # Rendering, textures, shader cache, transitions
│   │   │   ├── Device/     # The render-device seam (IRenderDevice/ICommandList); Device/Gl/ is the
│   │   │   │               # only GL backend code (docs/RENDER_DEVICE.md)
│   │   │   └── Platform/   # GL context/loader glue
│   │   ├── UserSprites/    # User sprite rendering
│   │   ├── ProjectM.hpp    # Main C++ class
│   │   └── ProjectMCWrapper.cpp  # C API implementation
│   ├── playlist/           # Playlist management library (C API + C++ implementation)
│   └── sdl-test-ui/        # SDL2-based developer test application
├── tests/
│   ├── libprojectM/        # Unit tests for core library (Google Test)
│   ├── playlist/           # Unit tests for playlist library (Google Test)
│   └── cxx-interface/      # Integration test for installed C++ headers
├── vendor/                 # Bundled third-party code
│   ├── glad/               # OpenGL function loader
│   ├── glm/                # OpenGL Mathematics (optional system override)
│   ├── hlslparser/         # HLSL parser for shaders
│   ├── projectm-eval/      # Milkdrop expression evaluator (Git submodule)
│   └── stb_image/          # Image loading
├── src/wasm/                # Emscripten host wrapper (all TUs, see docs/EMSCRIPTEN.md)
│   ├── projectM_emscripten.cpp # WASM host wrapper: engine lifecycle + main()
│   ├── WasmHost.hpp/.cpp       # Per-instance WasmHost struct + host registry + create/set/destroy_host
│   ├── ProjectMWasmInternal.hpp # Shared WASM host includes + cross-TU state
│   ├── WasmRenderLoop.cpp      # Main loop, start_render/render_frame/set_window_size
│   ├── WasmShaderCache.cpp     # Transpiled-GLSL cache hooks + shader_cache_* exports
│   ├── WasmRenderPathOverrides.cpp # ?blurPath / ?copyPath / ?perPixelEval switches
│   ├── WasmGraphics.hpp        # Dual-FBO manager, GL state guard, compositing shader
│   ├── WasmWebGLContext.cpp    # WebGL context create/destroy + canvas selectors
│   ├── WasmDualFbo.cpp         # dual_fbo_* / transition_* exports
│   ├── WasmAudioBridge.cpp     # Audio worklet + stream analyser + PCM feed
│   ├── WasmPerfGovernor.cpp    # Perf HUD + adaptive quality governor + OpenMP info
│   ├── WasmRhythm.cpp          # Tempo/beat readouts, musical preset scheduling, beat events
│   ├── WasmPlaylistBridge.cpp  # Preset callbacks + playlist path helpers
│   ├── WasmPresetPrepare.cpp   # Per-host preset prepare thread (no ASYNCIFY)
│   ├── WasmPresent.cpp         # Flash-limiter switches, per-host frame capture, commit counter
│   └── WasmJsBindings.cpp      # EM_JS glue: VFS/song bootstrap + host-page notifications (no DOM, no network)
├── CMakeLists.txt          # Root build configuration
├── vcpkg.json              # vcpkg dependency manifest
├── features.cmake          # Compiler flags, filesystem support, config.h generation
└── config.h.cmake.in       # Template for generated build-config header
```

The WASM host wrapper is split into focused translation units sharing
`ProjectMWasmInternal.hpp`. For where to add a new `EMSCRIPTEN_KEEPALIVE`
export, see [`docs/EMSCRIPTEN.md`](docs/EMSCRIPTEN.md#where-to-add-a-wasm-export).

---

## Binary artifacts: what lives in git

Keep the repo root source-focused. Policy for binary/build artifacts:

- **Never commit built WASM bundles** (`projectm-v.*-thread.{js,wasm,1ijs,3ijs,worker.js}`,
  `pm/projectm-v.*-thread.*`, `pm/builds.json*`). These are build+deploy output — produced by
  `scripts/build_wasm.sh --stage` and uploaded via `deploy.py`, never checked in.
  Only UTF-8 `.js` glue is deployed now; hosts find each build through the
  `pm/builds.json` manifest (see [`docs/adr/0001-wasm-and-media-hosting.md`](docs/adr/0001-wasm-and-media-hosting.md)
  for the manifest, `.htaccess` headers, song indexes, and the header checks).
  `.gitignore` matches any version (`projectm-v.*-thread.*`), not just one. The
  canonical current version is `PROJECTM_WASM_BUNDLE` in `html/projectm-init.js`
  (also the default in `scripts/verify_deploy_urls.sh` and
  `scripts/prepare_deploy_bundle.sh`'s `PROJECTM_WASM_VERSION`) — update all three
  together when bumping the bundle version. (`scripts/build_wasm_smoke_wrapper.sh`
  and the CI smoke-test workflows intentionally hardcode an internal-only tag,
  unrelated to the deployed version — `prepare_deploy_bundle.sh` renames its output
  **and rewrites** embedded `projectm-v.030-thread.wasm` strings in the glue JS;
  renaming files alone leaves `locateFile` fetching a missing `./pm/…030…wasm`.)
- **CMake install-prefix directories** (`install/`, `install-wasm/`, `cmake-build*/`,
  `build/`) are regenerated by the build; never commit them. All are gitignored.
- **The one deliberately-committed prebuilt binary** is `omp/omp.zip` (prebuilt
  `libomp.a` + `omp.h` for the Emscripten OpenMP build, zipped to dodge the `*.a`
  gitignore rule — see `omp/README.md` and `cmake/EmscriptenOpenMP.cmake`). Do not
  duplicate it at the repo root; `omp/` is the only tracked copy.
- Everything else under version control should be source, docs, small text/config
  fixtures, or `.gitkeep` placeholders (e.g. `benchmark-results/.gitkeep`).

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Language | C++20, strict (`-std=c++20`, `CMAKE_CXX_EXTENSIONS OFF`), the same standard the `src/wasm/` wrapper TUs use. `cmake/FilesystemSupport.cmake` only raises the standard to 17 for `std::filesystem` when it is lower. Defaulted `operator==`, `std::span` and designated initializers are available |
| Build System | CMake >= 3.21 |
| Graphics | OpenGL Core 3.3 or OpenGL ES 3.2 |
| Math | GLM (bundled or system) |
| Expression Eval | projectM-eval (bundled submodule or system) |
| Test UI | SDL2 (optional) |
| Testing | Google Test (optional) |
| Documentation | Doxygen + Sphinx + Breathe + Exhale (optional) |
| Dependency Mgr | vcpkg (recommended, especially on Windows) |

---

## Build System & Commands

### Prerequisites

- CMake 3.21 or higher
- A working C++20 toolchain
- OpenGL (desktop) or GLES3 (embedded/Android/Emscripten) development libraries
- Git (to clone and update submodules)

Optional:
- `ninja-build` (recommended over Make)
- `libsdl2-dev` (for the test UI)
- `libgtest-dev`, `libgmock-dev` (for tests). On Linux `tests/libprojectM` also needs
  `libsdl2-dev`: the GPU tests open a real GL context through `HeadlessGlContext` (an SDL
  hidden window), and CMake requires SDL2 when `BUILD_TESTING=ON`. On other platforms
  those tests compile and skip.
- `libglm-dev` (if `ENABLE_SYSTEM_GLM=ON`)

### Quick Build (Linux)

```bash
# Initialize the expression-evaluator submodule
git submodule init
git submodule update

mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local ..
cmake --build . --parallel
sudo cmake --build . --target install
```

### Important CMake Options

| Option | Default | Description |
|--------|---------|-------------|
| `BUILD_SHARED_LIBS` | `ON` | Build as shared libraries. Set `OFF` for static. |
| `BUILD_TESTING` | `OFF` | Build the unit test suite. |
| `ENABLE_PLAYLIST` | `ON` | Build the playlist management library. |
| `ENABLE_SDL_UI` | `OFF` | Build the SDL2 developer test UI (`projectM-Test-UI`). |
| `ENABLE_GLES` | `OFF` | Use OpenGL ES 3 instead of OpenGL Core. Forced `ON` on Android/Emscripten. Sets the `USE_GLES` define (`config.h`, glad) from this one value. |
| `ENABLE_EMSCRIPTEN` | auto | Set automatically when using Emscripten toolchain. |
| `ENABLE_CXX_INTERFACE` | `OFF` | **Experimental/unsupported.** Export C++ symbols for `ProjectM` and `PCM` classes. |
| `ENABLE_SYSTEM_GLM` | `OFF` | Use system-installed GLM instead of bundled. |
| `ENABLE_SYSTEM_PROJECTM_EVAL` | `ON` | Use system-installed projectM-eval instead of submodule (falls back to the submodule when none is found). **An installed projectM-eval compiles the GPU per-pixel path out** (every preset evaluates per-pixel code on the CPU): the compiler walks the evaluator's internal expression tree, which only the vendored sources expose. On a machine with projectM-eval installed, pass `-DENABLE_SYSTEM_PROJECTM_EVAL=OFF` for a GPU-capable build and to run the `PerPixelGlslLowering`/`PerPixelGpuRender` tests (they skip otherwise). CI and Emscripten builds find no installed copy and use the submodule. See `docs/GPU_PERPIXEL_EVAL.md`. |
| `ENABLE_BOOST_FILESYSTEM` | `OFF` | Force `boost::filesystem` even if `std::filesystem` is available. |
| `ENABLE_OPENMP` | `OFF` | Enable OpenMP parallelization in performance-critical sections. |
| `ENABLE_HDR_RENDERING` | `OFF` | Enable 16-bit float (GL_RGBA16F) framebuffer + Reinhard tone-mapping. |
| `ENABLE_HDR_P3` | `OFF` | Enable Display-P3 wide-gamut output (requires HDR rendering). |
| `ENABLE_SRGB_FRAMEBUFFER` | `OFF` | Enable hardware sRGB encode/decode (SDR only, incompatible with HDR). |
| `ENABLE_VERBOSE_LOGGING` | `OFF` | Compile `TRACE`/`DEBUG` log levels into release builds (hurts performance). |
| `ENABLE_DEBUG_POSTFIX` | `ON` | Append `d` to debug binary names. |
| `ENABLE_MACOS_FRAMEWORK` | `OFF` | Build macOS Framework bundles instead of plain dylibs. |
| `ENABLE_INSTALL` | `OFF` | Enable install targets when built as a CMake sub-project. |
| `ENABLE_WERROR_RATCHET` | `OFF` | Warnings as errors in the warning-clean directories (today `src/libprojectM/MilkdropPreset`). CI turns it on. |
| `PROJECTM_WASM_LTO` | `OFF` | **Emscripten only.** Build the static libs as LLVM bitcode for whole-program LTO (`scripts/build_wasm.sh --lto`). The only LTO switch: the wrapper link reads it from the build dir and refuses a disagreeing `PROJECTM_WASM_LTO` env var. |

### Using vcpkg (especially on Windows)

The repository includes `vcpkg.json`. Pass the vcpkg toolchain file when configuring:

```bash
cmake -G "Ninja" -DCMAKE_TOOLCHAIN_FILE=<path-to-vcpkg>/scripts/buildsystems/vcpkg.cmake -S <src> -B <build>
```

---

## Code Organization

### `src/api/`
Defines the stable **C API** used by all language bindings and frontends. Headers are installed under `include/projectM-4/`. Key headers:
- `projectM.h` — Convenience umbrella header
- `core.h`, `audio.h`, `render_opengl.h`, `callbacks.h`, `parameters.h`, `touch.h`, `user_sprites.h`
- `preset_prepare.h` — fork extension: load a preset in steps (begin on the render thread, prepare
  on any thread, load on the render thread) and the `KHR_parallel_shader_compile` switch; used by
  the WASM host's prepare thread
- `rhythm.h` — fork extension: tempo/beat/bar/section info, tempo hint, preset switching on bars or
  sections, transitions in beats, beat-aligned hard cuts (see `docs/AUDIO_PIPELINE.md`)
- `texture_reload.h` — fork extension: `projectm_reload_texture()` re-reads a loaded texture's file
  in place, so running presets sample a rewritten image without a reload (the experimental depth
  map; see `docs/EXPERIMENTAL_PRESET_HOOKS.md`)

Export headers (`projectM_export.h`, `projectM_cxx_export.h`) are generated by CMake.

### `src/libprojectM/`
The core visualization engine. It is subdivided into:
- **Audio/** — `PCM`, `MilkdropFFT`, `Loudness`, `WaveformAligner`, `FrameAudioData`, `RhythmAnalyzer` (tempo, beat phase, onsets, sections → the `pm_*` preset variables). Handles all audio ingestion and feature extraction.
- **MilkdropPreset/** — Preset factory, file parser, HLSL/GLSL shader generation, equation evaluation, custom waveforms, and the Milkdrop preset format implementation.
- **Renderer/** — `Renderer`, `RenderContext`, texture managers, shader cache, transition shaders, and platform abstractions.
  Everything draws through `Renderer/Device/` (`Device::Current()`, `Device::Commands()`); only
  `Renderer/Device/Gl/` and `Renderer/Platform/` call GL. See [`docs/RENDER_DEVICE.md`](docs/RENDER_DEVICE.md).
- **UserSprites/** — `SpriteManager` and shaders for user-provided sprite overlays.
- **ProjectM.hpp/cpp** — The main orchestrator class. Owns the audio pipeline, preset manager, renderer, and time keeper.
- **ProjectMCWrapper.cpp** — Thin C wrappers around the C++ `ProjectM` and `PCM` classes.

### `src/playlist/`
A separate library (`libprojectM-playlist`) for managing preset playlists: filtering, item metadata, playback order, and callbacks. It has its own C API in `src/playlist/api/projectM-4/`.

### `src/sdl-test-ui/`
A minimal SDL2 application (`projectM-Test-UI`) for manual developer testing. It is **not installed** and is not an end-user frontend. Requires `ENABLE_SDL_UI=ON`.

### `vendor/`
Third-party code that is compiled as part of the project:
- `glad` — OpenGL loader
- `glm` — Header-only math library (skipped if `ENABLE_SYSTEM_GLM=ON`)
- `hlslparser` — HLSL-to-GLSL transpiler helpers
- `projectm-eval` — Expression evaluator for Milkdrop equations (skipped if system package found and `ENABLE_SYSTEM_PROJECTM_EVAL=ON`)
- `stb_image` — Image decoding

---

## Development Conventions

### Build Discipline
- **Always build out-of-tree.** Never run CMake directly in the source root. Use a subdirectory like `build/` or `cmake-build/`.
- The source tree is treated as read-only; all generated files belong in `CMAKE_BINARY_DIR`.

### Code Formatting
- A `.clang-format` file is provided at the repository root. **Run `clang-format` before committing.**
- Based on `LLVM` style with customizations:
  - Indent: 4 spaces (no tabs)
  - No column limit (`ColumnLimit: 0`)
  - Braces on new lines after classes, functions, enums, and control statements (Allman-style)
  - Pointer alignment: left (`int* ptr`)
  - Short functions/lambdas: allowed on single line; other blocks: never
- `scripts/check_cpp_format.sh` runs `clang-format --dry-run -Werror` over a
  fixed, growing list of directories (currently `src/wasm/`, `src/libprojectM/Audio/`,
  `src/libprojectM/Renderer/Platform/`, `tests/cxx-interface/`) and runs in
  its own `cpp_format_gate.yml` workflow. It is deliberately not
  repo-wide yet: most of `src/libprojectM/` and `src/playlist/` are not
  clang-format clean, and a repo-wide reformat in one commit would drown
  every other diff in noise. Widen the list one reformatted directory at a
  time instead of doing it all at once.
- JavaScript has its own gate: `npm run format:check` (`scripts/check_web_format.sh`)
  runs Prettier (`.prettierrc.json`) over a growing PATHS list in that script, and
  `web_lint_gate.yml` runs it. Same rollout as the C++ one: reformat one directory
  in a commit that does nothing else, add that SHA to `.git-blame-ignore-revs`,
  then add the directory to PATHS. `.editorconfig` holds the editor defaults.
- **`EM_JS`/`EM_ASYNC_JS`/`EM_ASM*` macro bodies in `src/wasm/` are wrapped in
  `// clang-format off` / `// clang-format on`.** Those bodies are literal
  JavaScript, not C++; clang-format tokenizes `===`/`!==` as separate `==`
  and `=` operators (C++ has no triple-equals) and re-spaces them into
  `== =` / `!= =`, silently breaking the JS. Never remove those guards or
  run `clang-format -i` across an `EM_JS`/`EM_ASM` body — reformat only the
  surrounding C++.
- `src/wasm/` was mechanically reformatted to `.clang-format` in a single
  commit recorded in `.git-blame-ignore-revs`. Configure
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` (or pass
  `--ignore-revs-file` to `git blame` directly) so that commit doesn't
  attribute unrelated lines to the reformat.

### Warnings ratchet
- `-DENABLE_WERROR_RATCHET=ON` (set by `build_linux.yml`) adds `-Werror` to the
  directories that build warning-free under the project's `-Wall -Wextra -Wshadow`
  set: today `src/libprojectM/MilkdropPreset`. `src/wasm/` gets `-Wall -Wextra`
  on every wrapper build and `-Werror` with `PROJECTM_WASM_WERROR=1` (set by
  `build_emscripten.yml`); `-Winvalid-pp-token` is off there because it only
  fires on JavaScript literals inside `EM_JS` bodies. Widen one clean directory at
  a time, like `check_cpp_format.sh`.

### Render-device seam
- No direct GL outside `src/libprojectM/Renderer/Device/Gl/` and
  `src/libprojectM/Renderer/Platform/`: no `gl*(` call, no `Renderer/OpenGL.h` or
  glad include. Add what you need to `IRenderDevice`/`ICommandList` and implement it
  in `GlDevice` (see [`docs/RENDER_DEVICE.md`](docs/RENDER_DEVICE.md)).
  `scripts/check_gl_seam.sh` enforces it over its `PATHS` list (`src/libprojectM`,
  `src/wasm`), and `cpp_format_gate.yml` runs it. Comments are ignored, but string
  literals are not.
- Handles are values whose id is the GL name on the GL backend, and
  `RenderTargetHandle{0}` is the default framebuffer. Resource wrappers capture
  `Device::Current()` when they are constructed.
- `PROJECTM_DEVICE_VALIDATION=1` turns on `ResourceStateTracker`, which logs each
  distinct feedback hazard (a texture sampled while attached to the draw target, or a
  blit or copy that reads what it writes) once, as `[RenderDevice] Feedback hazard: ...`.
  It is off by default.
- Device changes must stay bit-identical unless they mean to change output. Check
  with the WASM goldens and `PresetCompat`, plus a before/after render of the preset
  corpora if the change touches draw order.

### Static Analysis
- A `.clang-tidy` file is provided. It enables checks from:
  - `readability-*`
  - `cppcoreguidelines-*`
  - `bugprone-*`
  - `modernize-*`
  - `performance-*`
  - `misc-*`
- Disabled checks include `magic-numbers`, `owning-memory`, `pro-bounds-pointer-arithmetic`, and `easily-swappable-parameters`.
- `scripts/check_cpp_tidy.sh` runs a narrower check list
  (`bugprone-*` minus `easily-swappable-parameters`, `performance-*` minus
  `no-int-to-ptr`/`enum-size`, `modernize-use-nullptr`,
  `readability-braces-around-statements`) over `src/wasm/` only. It is a
  **hard gate** in `build_emscripten.yml`. It reads the `src/wasm/` command
  lines from the Emscripten build dir's `compile_commands.json` (the
  `projectM_wasm` target) and adds only what `em++` would: the wasm32 target
  and the emsdk sysroot. It needs clang-tidy >= 22
  (Ubuntu's clang-tidy-18 cannot parse emsdk's libc++; CI pins
  `clang-tidy==22.1.8` from PyPI via `pipx`), `em++` on PATH, a built
  Emscripten CMake dir configured with `CMAKE_EXPORT_COMPILE_COMMANDS=ON`
  (`scripts/build_wasm_install.sh` does). Locally it skips when a
  prerequisite is missing; `CPP_TIDY_REQUIRED=1` makes that fatal. Widen the
  check list and the directory coverage together, gradually, same reasoning
  as `check_cpp_format.sh`'s PATHS list.

### Sanitizers
- `build_linux.yml`'s `sanitizers` job builds Debug with
  `-fsanitize=undefined,address` (static libs) and runs the full `ctest`
  suite, including `PresetCompat` over `presets/tests/`, with
  `UBSAN_OPTIONS=halt_on_error=1` and leak detection on. Reproduce locally by
  passing the same `CMAKE_{C,CXX}_FLAGS` / `CMAKE_{EXE,SHARED}_LINKER_FLAGS`
  as that job. `*BenchTest.*` is filtered out there (wall-clock budgets).
  LSan suppressions live in `tests/sanitizers/lsan.supp`; do not add one
  without a comment naming the third-party library and why.
  TSAN is not wired up yet (OpenMP needs suppressions).

### Naming Conventions (enforced by `.clang-tidy`)
| Entity | Style | Example |
|--------|-------|---------|
| Classes / Structs | `CamelCase` | `class PresetFactory` |
| Methods / Functions | `CamelCase` | `void LoadPreset()` |
| Global functions with C API | `projectm_` prefix | `projectm_load_preset()` |
| Variables / Parameters | `camelBack` | `int sampleCount` |
| Private / Protected members | `m_` + `camelBack` | `int m_sampleCount` |
| Macros | `UPPER_CASE` | `#define ENABLE_FOO` |

### Symbol Visibility
- Default visibility is **hidden** for both C and C++ (`CMAKE_C_VISIBILITY_PRESET hidden`, `CMAKE_CXX_VISIBILITY_PRESET hidden`).
- Only symbols explicitly annotated with `PROJECTM_API` / `PROJECTM_CXX_EXPORT` are exported from shared libraries.
- If `ENABLE_CXX_INTERFACE=OFF` (the default), C++ symbols are **not** exported and `ProjectMCWrapper.cpp` is the only exported compilation unit.

### Logging
- The project uses an internal logging framework (see `Logging.hpp`).
- `TRACE` and `DEBUG` levels are stripped in release builds unless `ENABLE_VERBOSE_LOGGING=ON`.
- Prefer the project's logging macros over `printf` or `std::cout`.
- `src/wasm/` logs with `WASM_LOG_INFO/WARN/ERROR` (`WasmLog.hpp`), which go through `Logging` to
  the browser console and `globalThis.pmOnLog(level, message)`. `scripts/check_wasm_no_printf.sh`
  (in `cpp_format_gate.yml`) fails any `printf`/`fprintf` there.

---

## Testing Instructions

### Enabling Tests

```bash
cmake -DBUILD_TESTING=ON ...
cmake --build . --parallel
```

### Running Tests

```bash
# Run all tests via CTest
ctest --test-dir <build-dir> --verbose --build-config <Debug|Release>
```

### Test Suites

| Directory | Framework | Coverage |
|-----------|-----------|----------|
| `tests/libprojectM/` | Google Test | HLSL parser, logging, preset file parser, waveform aligner, preset compat, shader cache, temporal flash limiter (`FlashLimiterTest`, GPU, see `docs/FLASH_LIMITER.md`), the color output contract (`ColorOutputTest`, GPU: canvas alpha opaque or valid premultiplied, Display-P3 encode order; see `docs/EMSCRIPTEN.md` "Canvas alpha"), GPU-timer stage markers (`PerfGpuStageTest`: where each Y-flip falls), the render-device seam (`RenderDeviceTest`: the feedback-hazard tracker without GL, `GlDevice` clear/readback, state capture/restore and a real feedback draw on GPU), the user-sprite C API (`UserSpriteApiTest`, GPU) and the experimental `pm_depth` sampler plus `projectm_reload_texture()` (`ExperimentalDepthSamplerTest`: header parsing and rewrite without GL, in-place reload on GPU), GPU per-pixel lowering and CPU-vs-GPU render (need SDL2 + a display or `xvfb-run` on Linux, and a vendored projectM-eval, see `ENABLE_SYSTEM_PROJECTM_EVAL`) |
| `tests/playlist/` | Google Test | Playlist API, filter logic, item handling |
| `tests/cxx-interface/` | CMake compile test | Verifies installed C++ headers can be consumed by an external project |

The CI builds both `Debug` and `Release` configurations and runs `ctest` for each.

### Browser host-layer tests (`tests/web/`)

`html/` (the browser host modules) and `packages/web/` (the publishable embed
SDK) are an npm workspace rooted at the repo's own `package.json`. From the
repo root:

```bash
npm install               # installs html/'s devDependencies once, hoisted
npm test                  # every tests/web/*.test.mjs (coverage-gated, see
                           # scripts/test_web_embed.sh) + the packages/web build
npm run typecheck         # tsc over html/'s three tsconfigs (DOM, worker, AudioWorklet)
npm run lint              # ESLint (eslint.config.mjs) over html/, packages/web/src, tests/web
npm run format:check      # Prettier over scripts/check_web_format.sh's PATHS list
```

`scripts/test_web_embed.sh` and `scripts/check_html_types.sh` still work
standalone (each falls back to installing its own dependencies if the root
workspace hasn't been installed yet) and are what CI (`web_host_tests.yml`)
actually runs `npm test` / `npm run typecheck` through. `web_lint_gate.yml` runs
lint, format and typecheck with no `paths:` filter, so it can be a required check.

ESLint is type-aware: each file group is parsed with the tsconfig program that
type-checks it, so the set of linted files and the set of type-checked files is
the same. The rules are the ones the host layer was bitten by:
`no-floating-promises`, `no-misused-promises`, `require-await`,
`no-unused-vars`, plus two `no-restricted-syntax` bans — assigning `window.*`
anywhere but `projectm-globals.js` (publish through `claimGlobal()`), and
`innerHTML`/`outerHTML` from anything but a constant string. A justified
exception carries an `eslint-disable-next-line` with the reason; an unused
disable is itself an error. `scripts/check_host_globals.sh` is the name-aware
version of the `window.*` rule (it also scans `html/context/` and `html/worklets/`).

Every `.js` that deploys is in a program, including what used to be inline page
script: `projectm-core.html` and `projectm_panel2.1ink` boot the shared page
shell (`html/projectm-app-shell.js` + `projectm-app-shell-ui.js`) with a
four-line `<script type="module">`, the redirect stubs load
`projectm-redirect-stub.js`, and `tests/web/page-modules.test.mjs` fails any
deployed page whose inline script grows past ten lines.

#### What the suite gates

`scripts/test_web_embed.sh` fails a change for exactly three reasons, and says
which:

1. **A test failed.**
2. **Coverage dropped below the floor.** The floor lives in that script as
   `COVERAGE_LINES_MIN` / `COVERAGE_BRANCHES_MIN` / `COVERAGE_FUNCTIONS_MIN`.
   Raise them as coverage improves; never lower them to make a PR pass. The run
   passes `--test-coverage-exclude='tests/**'`, which is load-bearing: without
   it node <= 22 folds the test files (~100% covered by definition) into the
   "all files" row and node >= 23 does not, so the same tree scored 74.97% in
   CI and 64.91% locally. The number now means "coverage of `html/`" on any
   node version. `--test-coverage-exclude='html/flac-player/vendor/**'` keeps
   the vendored buffer polyfill, which the flac boot test loads, out of it too. `web_host_tests.yml` pins the node major the floor was
   measured on.
3. **`tests/web/untested-modules.txt` is out of date.** A coverage floor can
   only score files the suite imported, so a module with *no* tests is
   invisible to it — and deleting a module's last test *raises* coverage. That
   ledger lists the `html/` modules no test loads, with a reason each. It only
   shrinks: writing the first test for a listed module means deleting its line,
   and a module that falls out of the suite must be given a test or an entry
   explaining why not.

#### The render-worker wire protocol

`projectm-render-worker-types.ts` is the only place the OffscreenCanvas
render-worker's wire format is written down, and it has two implementations —
`projectm-render-worker-host.js` on the main thread and
`projectm-render-worker.js` in the worker. Three test files hold that together:

- `tests/web/projectm-render-worker-host.test.mjs` — the host half:
  `isRenderWorkerSupported`/`isRenderWorkerEnabled`, `setupRenderWorker()`'s
  message dispatch, ccall bridging and PCM handoff.
- `tests/web/projectm-render-worker.test.mjs` — the worker half. The worker is
  a *classic*, non-module Worker script: it assigns to the bare `self` global
  and expects `importScripts()` to define a global `createModule`, neither of
  which survives being imported under Node's ESM loader (`html/`'s
  `package.json` sets `"type": "module"`). `node:vm` is the way in — evaluating
  the source in a context whose global carries `self`, `importScripts`,
  `performance` and `setInterval` reproduces the classic-worker scope closely
  enough to drive the real `onmessage` handler, with no production refactor and
  no browser. Two things to know when extending it: objects built inside the vm
  carry that context's `Object.prototype`, so copy them (`{ ...message }`)
  before `assert.deepEqual`; and inject this realm's `SharedArrayBuffer` and
  `Atomics` into the sandbox, or the worker's `instanceof SharedArrayBuffer`
  check on the ring descriptor never matches.
- The last test in that file reads all three sources and asserts each message
  type declared in the union types is both posted by one side and handled by
  the other, so a type renamed on one side is a red test rather than a silent
  postMessage that goes nowhere.

#### The WASM glue stays out of the page

`tests/web/wasm-glue-dom.test.mjs` reads the `EM_JS`/`EM_ASM` bodies in `src/wasm/` and fails on
`XMLHttpRequest`, `innerHTML`, `#stat`/`#milkPath` or any hard-coded selector lookup, then runs the
bodies in Node against a `document` that throws on any access. Fetching presets, textures and songs
and writing status text belong to the host page (`html/projectm-presets.js`,
`projectm-textures.js`, `projectm-weeks-on-fire.js`); the engine reports through the callback bus
(`pmOnPresetSwitchFailed`, ...). `tests/wasm-smoke/host_contract_names.mjs` repeats the selector
check against the linked glue in CI.

#### IndexedDB and DOM in Node

`tests/web/helpers/fake-indexeddb.mjs` and `tests/web/helpers/fake-dom.mjs` are
the stand-ins for the two browser APIs the host layer cannot avoid. The
IndexedDB fake models the parts `projectm-preset-cache.js` and
`projectm-shader-cache.js` actually depend on — asynchronous requests, requests
queued from inside another request's `onsuccess` landing before `oncomplete`,
cursors that terminate on a null result. The DOM fake resolves selectors
lazily (asking for one mints and remembers an element) and installs a
hand-driven `performance.now()`, because `projectm-perf.js` throttles its HUD
to one repaint per 200 ms and against the real clock that makes the test depend
on how long the process took to get there.

GPU tests include `tests/libprojectM/TestGl.hpp`, never `<glad/gl.h>` directly: under
`USE_GLES` (Emscripten, Android) the renderer headers bring in `<glad/gles2.h>`, and glad
rejects both in one translation unit, which breaks only the Emscripten job.
`scripts/check_test_gl_includes.sh` (run by `cpp_format_gate.yml`) enforces it. Test code
must also build with MSVC: no `M_PI`, `setenv` or other POSIX-only names.

### Preset Compatibility Harness

`tests/libprojectM/PresetCompatTest.cpp` parses every `.milk` preset in `presets/tests/` and
(optionally) `presets/custom/` and transpiles its warp/composite shaders from HLSL to GLSL,
without requiring an OpenGL context. It reports the file path and error message for any preset
that fails to parse or transpile.

```bash
# Run only the preset compatibility tests (presets/tests/ only)
ctest --test-dir <build-dir> -R PresetCompat --build-config Debug --verbose

# Or build + run directly, including presets/custom/ and optionally checking an
# additional preset directory
scripts/test_presets.sh [<preset-dir>] [<build-dir>]
```

`presets/custom/` currently contains some presets with known shader-format issues, so it is
opt-in via `PROJECTM_TEST_CUSTOM_MILK_FIXED=1` (set automatically by
`scripts/test_presets.sh` and the nightly `preset_compat.yml` workflow) to avoid breaking the
default `projectM-unittest` CTest run used by the main CI build.

To check an arbitrary preset collection without using the script, build `projectM-unittest`
and set `PROJECTM_PRESET_COMPAT_DIR` to its path before running the binary with
`--gtest_filter=*PresetCompat*`.

A parse/transpile pass does not mean a preset runs: `presets/custom/milk013`–`milk015` have
`per_frame` code without `;` between statements, pass `PresetCompat`, and fail in the engine
with `[PerFrameContext] Could not compile per-frame code ... unexpected VAR(L2 C1)` (on every
build, not a regression). Keep them out of the CI screenshot smoke list in `build_emscripten.yml`
until the preset is repaired; see `docs/agents/kimi_preset_authoring_plan.md`.

---

## CI & Deployment

GitHub Actions workflows are in `.github/workflows/`:
- `build_linux.yml` — Ubuntu 22.04/24.04 matrix (shared/static × stl/boost filesystem), runs unit tests and C++ interface test
- `build_windows.yml` — Visual Studio / Ninja builds with vcpkg
- `build_osx.yml` — macOS shared/static builds, with/without framework
- `build_emscripten.yml` — Emscripten WASM build
- `build_android.yml` — Android NDK build (arm64-v8a, armeabi-v7a, x86_64)
- `push_release.yml` — Release artifact publishing
- `upstream_sync_reminder.yml` — monthly upstream drift report + tracking issue (see [`docs/UPSTREAM_SYNC.md`](docs/UPSTREAM_SYNC.md))
- `web_lint_gate.yml` — ESLint + Prettier + typecheck over the browser host layer; no `paths:` filter, meant to be required

Conventions shared by the push/PR workflows:
- Each has a `concurrency` group per workflow + ref: a newer push to a branch or PR cancels the
  run in flight. Runs on `main` and on tags are never cancelled (each merge needs a full result).
- `build_windows.yml` keeps vcpkg's binary cache in `vcpkg-bincache/` (the vcpkg `files`
  provider, persisted with `actions/cache`; only `main` saves it, PRs restore). The fork has no
  token for the upstream NuGet feed, so do not put `nuget` back in `VCPKG_BINARY_SOURCES`.
- A `paths:` filter makes a workflow unusable as a *required* check (a PR that skips it waits
  forever), so the path-filtered gates (`cpp_format_gate`, `host_layer_gate`, `web_host_tests`)
  must lose their filters before they are required in branch protection.

### Upstream maintenance (fork)

This tree tracks [projectM-visualizer/projectm](https://github.com/projectM-visualizer/projectm).
`main` is the fork (develop here). `master` is a read-only mirror of upstream `master`;
refresh it with `./scripts/sync_upstream_master.sh` and do not commit on it or merge it
into `main`. Run `./scripts/upstream_sync_check.sh` before large refactors or when
upstream ships a release. Deliberate divergences (WASM glue, OpenMP, AI presets) are
documented in `docs/UPSTREAM_SYNC.md`.

### Packaging Outputs
- CMake config files: `projectM4Config.cmake`, `projectM4Targets.cmake`
- pkg-config `.pc` files on UNIX (not for macOS frameworks)
- macOS Framework bundles when `ENABLE_MACOS_FRAMEWORK=ON`
- CPack configuration is included in the root `CMakeLists.txt`

### WASM Bundle Deployment

`deploy.py` uploads the compiled WASM/JS bundle to `storage.noahcohn.com` /
`projectm.1ink.us/`. `--with-presets` also uploads the preset corpora under the
names the site fetches them by (`presets/custom/` → `custom_milk_fixed/`,
`presets/weeks/` → `weeks_presets/`). It requires `DEPLOY_TOKEN` as an environment variable (no default —
see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for usage and token rotation).

**One build command.** `scripts/build_wasm.sh` (libraries, wrapper link, bundle checks; `--stage`
also stages for `deploy.py`) is what CI, `scripts/colab_build.sh` and local deploys run, so the
deployed binary is the one CI tested. Nothing may rewrite the bundle after the link (no wasm-opt
pass, no minifier): see `docs/EMSCRIPTEN.md` "Building the bundle". The bundle is the
`projectM_wasm` CMake target (`src/wasm/CMakeLists.txt`, Emscripten only, not in `ALL`); its TUs
compile with the libraries' `config.h` and compile definitions, and the shell script only picks
the link flavor and copies the output.

**It refuses a stale bundle.** Staging writes `<bundle>.build-id`: a source fingerprint plus the
sha256 of the linked `.wasm` and `.js`. `deploy.py` fails if the fingerprint does not match the tree
it runs from (`--allow-stale-wasm` overrides) or if any staged copy, `.br`/`.gz` included, does not
match those hashes (not overridable). `python deploy.py --check-bundle` runs both checks offline.
Staging also writes `<bundle>.symbols` (not uploaded, gitignored) for symbolizing production stack
traces; keep it per deployed version. See `docs/EMSCRIPTEN.md` "Deploy staleness guard".

**Browser floor: Safari 16.4 / Chrome 91 / Firefox 89.** The bundle uses SIMD128 but not Relaxed
SIMD (which Safari cannot compile); `scripts/check_wasm_bundle_features.sh` gates that in CI.
See `docs/EMSCRIPTEN.md` "Wasm feature floor".

**Cross-origin isolation headers are required.** This build is compiled with
`-s SHARED_MEMORY=1 -pthread`, so the hosting server *must* send
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
(or `credentialless`) — otherwise `SharedArrayBuffer`/pthreads are unavailable and the
module fails to start (reported client-side as init error code `4`). After deploying, run
`scripts/check_coop_coep.sh <url>` to verify. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#cross-origin-isolation-coopcoep) for example
nginx/Caddy/Cloudflare configs and the cross-origin-iframe/postMessage impact.

---

## Security Considerations

- **C API is the supported integration surface.** The C++ interface (`ENABLE_CXX_INTERFACE`) is explicitly discouraged because using C++ STL types across shared-library boundaries is unsafe unless every component is built with the exact same toolchain and C++ standard library. If you must expose C++ symbols, understand the ABI risks.
- Preset files are parsed from user-provided content. The parser should be resilient to malformed input, but any changes to preset parsing or expression evaluation should be reviewed for potential memory-safety issues (buffer overruns, use-after-free) because preset data is externally supplied.
- The SDL2 test UI is for development only; do not ship it as a production frontend.

---

## Cursor Cloud specific instructions

### One-time system packages (Ubuntu)

Cloud VMs need these packages before the first CMake configure (match `.github/workflows/build_linux.yml`):

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential g++ ninja-build \
  libgl1-mesa-dev mesa-common-dev libglu1-mesa-dev \
  libsdl2-dev libglm-dev libgtest-dev libgmock-dev
```

Optional for GUI demos: `xvfb`, `scrot`.

### Submodule and dependency refresh (automatic on VM startup)

Run after every pull:

```bash
git submodule update --init --recursive
```

The `vendor/projectm-eval` submodule is required when no system `projectM-eval` package is installed (typical on Ubuntu).

### Compiler selection

The default `/usr/bin/c++` on this image is **Clang**, which fails to link against `libstdc++` unless configured carefully. Use GCC explicitly:

```bash
cmake -G "Ninja Multi-Config" -S . -B cmake-build \
  -DCMAKE_CXX_COMPILER=g++ \
  -DCMAKE_C_COMPILER=gcc \
  -DBUILD_TESTING=ON \
  -DENABLE_SDL_UI=ON
```

No `-include atomic` is needed: every header that uses `std::atomic` (including `src/libprojectM/Audio/PCM.hpp`) includes `<atomic>` itself. Older instructions passed `-DCMAKE_CXX_FLAGS="-include atomic"`; drop it.

### Build, test, and install

```bash
cmake --build cmake-build --config Debug --parallel
ctest --test-dir cmake-build --verbose --build-config Debug
cmake --build cmake-build --config Debug --target install
```

`scripts/check_cpp_format.sh` is a CI-enforced format gate over the directory
list documented above (see "Code Formatting"); everywhere else, formatting is
still manual via `clang-format` (see above).

### C++ interface smoke test (optional, matches Linux CI)

```bash
cmake -G "Ninja Multi-Config" \
  -S tests/cxx-interface -B cmake-build-cxx-api \
  -DCMAKE_CXX_COMPILER=g++ -DCMAKE_C_COMPILER=gcc \
  -DprojectM4_DIR="$PWD/install/lib/cmake/projectM4"
cmake --build cmake-build-cxx-api --config Debug
```

### Emscripten smoke test (matches WASM CI)

Build with the same command as `.github/workflows/build_emscripten.yml`, then run its browser smoke:

```bash
source /path/to/emsdk/emsdk_env.sh
scripts/build_wasm.sh            # -> cmake-build/wasm-smoke/projectm-v.030-thread.{js,wasm}
npm install --no-save --no-package-lock playwright
npx playwright install chromium
node tests/wasm-smoke/run.mjs cmake-build/wasm-smoke/projectm-v.030-thread.js presets/tests/000-empty.milk
# runtime-checks flavor (ASSERTIONS=2, SAFE_HEAP, STACK_OVERFLOW_CHECK=2) + the host churn test:
scripts/build_wasm.sh --link-only --debug
node tests/wasm-smoke/host_churn.mjs --module cmake-build/wasm-smoke-debug/projectm-v.030-thread.js
```

### Running the SDL2 developer test UI

The binary is **not installed**; run it from the build tree:

```bash
cd cmake-build
ln -sfn ../presets/tests presets/tests   # Debug builds use DATADIR_PATH "."
cp ../src/sdl-test-ui/config.inp config.inp
./src/sdl-test-ui/Debug/projectM-Test-UI
```

Requires `DISPLAY` and OpenGL (Mesa llvmpipe software rendering works). No ALSA/PulseAudio device is needed — the UI falls back to synthetic PCM when capture fails. Keys: `Left`/`Right` preset, `Space` lock, `f` fullscreen, `q` quit.

The UI's default framebuffer matches the browser canvas: no alpha channel requested, no depth, no stencil, no MSAA (it logs the real values at startup), and a GLES build asks for OpenGL ES 3.0 like WebGL 2 (`PROJECTM_UI_GLES32=1` for 3.2). Opt in, like `?aa=1` / `?depth=1` on the canvas, with `PROJECTM_UI_AA=1` (4x MSAA) and `PROJECTM_UI_DEPTH=1` (24-bit depth + 8-bit stencil); see `docs/EMSCRIPTEN.md` "The SDL test UI's framebuffer".

### Services

This repo has **no long-running backend services**. CI-style verification is headless `ctest`; visual verification is the optional `projectM-Test-UI` binary above.
