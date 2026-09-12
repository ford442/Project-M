# Project-M: Development Guidelines for Claude Code

## Project Overview

**projectM** is an open-source music visualizer that reimplements the legendary Winamp MilkDrop visualizer as a modern, cross-platform reusable library. It reads audio input and produces mesmerizing visuals by detecting tempo and rendering advanced equations.

This repository contains **libprojectM**, the core visualization library that can be compiled to multiple platforms including:
- Windows, macOS, Linux (native)
- WebAssembly via Emscripten
- Android
- iOS (experimental)

## Which doc should I read first?

| If you're... | Read this first |
|---|---|
| Doing any C++/CMake/build/test work | [`AGENTS.md`](AGENTS.md) — canonical build, style, and testing reference |
| Touching `projectM_emscripten.cpp` or the WASM build | This file's [WASM Port Status](#wasm-port-status) section, then [`docs/EMSCRIPTEN.md`](docs/EMSCRIPTEN.md) |
| Editing `html/*.js`/`*.html` demo pages | [`html/README.md`](html/README.md) (architecture) and [`html/REFACTORING_NOTES.md`](html/REFACTORING_NOTES.md) |
| Creating/upgrading `.milk` presets (Kimi/Codex/Grok) | [`docs/kimi_preset_authoring_plan.md`](docs/kimi_preset_authoring_plan.md) |
| Picking up a task from a human/another agent | [`grok_agent/README.md`](grok_agent/README.md) |

This file (`claude.md`) is a WASM-focused supplement to `AGENTS.md` — it does not duplicate
build/style/testing rules. When in doubt, `AGENTS.md` wins.

## Repository Structure

```
Project-M/
├── src/
│   ├── api/              # Public C API
│   ├── libprojectM/      # Core visualization engine
│   ├── playlist/         # Playlist management
│   └── sdl-test-ui/      # SDL2 test UI
├── presets/              # Visualization presets (.milk files)
├── custom_milk_fixed/    # Curated AI-authored preset regression set
├── html/                 # WASM demo hosts + shared browser modules (see html/README.md)
├── src/wasm/                 # Emscripten host wrapper (all TUs, see split below)
│   ├── projectM_emscripten.cpp  # WASM host: engine lifecycle (init/rebind/destruct)
│   ├── WasmHost.hpp/.cpp        # Per-instance WasmHost struct + host registry + create/set/destroy_host
│   ├── ProjectMWasmInternal.hpp # Shared WASM host includes + cross-TU state
│   ├── WasmRenderLoop.cpp       # Main loop, start_render/render_frame/set_window_size
│   ├── WasmShaderCache.cpp      # Transpiled-GLSL cache hooks + shader_cache_* exports
│   ├── WasmRenderPathOverrides.cpp # ?blurPath / ?copyPath / ?fboPrecision switches
│   ├── WasmGraphics.hpp         # Dual-FBO manager, GL state guard, compositing shader
│   ├── WasmWebGLContext.cpp     # WebGL context create/destroy + canvas selectors
│   ├── WasmDualFbo.cpp          # dual_fbo_* / transition_* exports
│   ├── WasmAudioBridge.cpp      # Audio worklet + stream analyser + PCM feed
│   ├── WasmPerfGovernor.cpp     # Perf HUD + adaptive quality governor + OpenMP info
│   ├── WasmPlaylistBridge.cpp   # Preset callbacks + playlist path helpers
│   └── WasmJsBindings.cpp       # EM_JS DOM/VFS bootstrap + host-page notifications
├── projectm_audio_processor.js  # Web Audio Worklet for audio processing
├── CMakeLists.txt        # Build configuration
└── docs/
    ├── EMSCRIPTEN.md     # WASM-specific documentation
    └── ...                # Preset guides, Kimi runbook, plans
```

## Key Development Areas

### C++ Code
- **Main Files**: `src/wasm/projectM_emscripten.cpp`, `src/libprojectM/`
- **Language**: **C++20** (enforced by CMake — see `AGENTS.md` Technology Stack)
- **Build System**: CMake (see `AGENTS.md` Build System & Commands; do not duplicate here)
- **Code Style**: Follow `.clang-format` and `.clang-tidy` configs (see `AGENTS.md`)

### WASM/JavaScript Integration
- **Emscripten exports**: the WASM host wrapper exports C functions via
  `EMSCRIPTEN_KEEPALIVE` + an explicit `EXPORTED_FUNCTIONS` list generated from
  `cmake/EmscriptenWasmFlags.cmake` (no `EMSCRIPTEN_BINDINGS`/embind block).
  Grep `EMSCRIPTEN_KEEPALIVE` to find all exports.
- **Host source layout**: the wrapper is split across focused TUs sharing
  `ProjectMWasmInternal.hpp` — `projectM_emscripten.cpp` (engine lifecycle),
  `WasmRenderLoop.cpp` (main loop + `render_frame()`), `WasmShaderCache.cpp`,
  `WasmRenderPathOverrides.cpp`,
  `WasmWebGLContext.cpp` (WebGL context + canvas selectors),
  `WasmGraphics.hpp` / `WasmDualFbo.cpp` (dual-FBO transitions),
  `WasmAudioBridge.cpp`, `WasmPerfGovernor.cpp`, `WasmPlaylistBridge.cpp`,
  `WasmJsBindings.cpp`. **Where to add a WASM export:** see
  [`docs/EMSCRIPTEN.md`](docs/EMSCRIPTEN.md#where-to-add-a-wasm-export). Put the
  export in the TU that owns the concern, register it in the CMake export list +
  `cmake/WasmApiManifest.cmake`, add new `.cpp` files to `wrapper_sources` in
  `scripts/build_wasm_smoke_wrapper.sh`, and rerun `scripts/sync_wasm_link_common.sh`.
- **Audio Processing**: `projectm_audio_processor.js` (Web Audio Worklet) — receives raw
  per-channel `Float32Array` data via `postMessage` (not an `AudioBuffer`) and batches
  samples before calling into WASM.
- **Shared HTML modules** (`html/`): `projectm-init.js` (bootstrap), `projectm-presets.js`
  (preset fetch/VFS/load), `projectm-external-pcm.js` (external MOD/FLAC PCM bridge,
  origin allowlist), `projectm-transitions.js` (dual-FBO transition readiness). See
  `html/README.md` for the target architecture.

## WASM Port Status

### Completed fixes (do not re-report these)

| Fix | Commit(s) | Issue |
|---|---|---|
| `stringToNewUTF8` leak in `js_get_random_preset_path` | `7ebfbc8d4` | #74 (closed) |
| `init()` reinit safety: tear down stale EGL/WebGL context/surface/display before recreating | `4f5a4952f` | #58 (closed) |
| `eglChooseConfig()` result checked before use; reports init error via `js_report_init_error` | `4f5a4952f` | #58 (closed) |
| `projectm_audio_processor.js` no longer accesses non-existent `AudioBuffer.length`; uses per-channel `Float32Array` + `mainChannelData[0].length` | `4f5a4952f` | #58 (closed) |
| Init/WebGL failures surfaced to UI with recovery overlay (`js_report_init_error`/`js_report_init_success`) | `faab5ad26` | #79 (closed) |
| Frame-time profiling HUD + benchmark harness | `5345d3360` | #80 (closed) |
| Default 60 FPS + adaptive quality governor | `9e2cdb4e6` | #82 (closed) |
| RGBA16F FBO preferred + blur/echo Milkdrop parity audit | `5a65ddb45` | #83 (closed) |
| Shared external-PCM bridge module (`html/projectm-external-pcm.js`) | (see #73) | #73 (closed) |
| HTML host consolidation into shared modules (`html/projectm-*.js`) | — | #78 (closed) |
| Emscripten main `renderLoop()` now routes through dual-FBO `render_frame()` compositor (blit to canvas) | `9172332a2`, `0436b9d26` (OffscreenCanvas/render worker) | #95 (closed) |
| WebGL context loss detection + graceful recovery overlay + re-init in demo pages | `0436b9d26` + context-loss module | #93 (closed) |
| Document/enforce COOP/COEP cross-origin isolation headers (DEPLOYMENT.md + examples + check script) | recent docs updates + `0436b9d26` | #94 (closed) |
| Remove hardcoded `DEPLOY_TOKEN` default from `deploy.py` (require env, fail fast) | (deploy.py cleanup) | #88 (closed) |
| Unified Web Audio bootstrap: AudioContext resume gate / autoplay policy UX | (audio bootstrap work) | #91 (closed) |

### Open issues (verified via GitHub, current as of 2026-07-18)

All issues previously tracked here (#103, #104, #90, #116, #92, #100) are now
**closed** — see "Completed fixes" above. No open WASM-port issues are tracked in
this file as of this writing; check `gh issue list` / the GitHub issue tracker for
anything filed since.

When fixing an open issue, close the loop by updating this table (move the row to
"Completed fixes" with the commit hash, or remove it if superseded) rather than
leaving it stale again.

## WASM Build Flags (current, from `cmake/EmscriptenWasmFlags.cmake`)

The authoritative flag list is `cmake/EmscriptenWasmFlags.cmake` (included by the
`ENABLE_EMSCRIPTEN` block in `CMakeLists.txt` and regenerated into
`scripts/wasm_link_common.inc.sh`). After editing the module, run
`scripts/sync_wasm_link_common.sh`.
As of this writing, the Emscripten target uses:

- `-s MIN_WEBGL_VERSION=2 -s MAX_WEBGL_VERSION=2 -s USE_WEBGL2=1`
- `-s FULL_ES2=0 -s FULL_ES3=1` (ES2 emulation is **off**; do not document `FULL_ES2=1`)
- `-s SHARED_MEMORY=1 -s WASM_WORKERS=1 -pthread`
- `-s ALLOW_MEMORY_GROWTH=1 -sMALLOC='mimalloc' -sMAXIMUM_MEMORY=4gb -sINITIAL_MEMORY=256mb`
- `-s NO_DISABLE_EXCEPTION_CATCHING`
- `-s FORCE_FILESYSTEM=1 -s ASYNCIFY=1` (plus `-s ASYNCIFY_STACK_SIZE=65536` when
  `ENABLE_WASM_TRANSITIONS=ON`, the default)
- `-s EXPORTED_RUNTIME_METHODS='ccall,cwrap'` (wrapper link also exports `FS`) and an explicit `EXPORTED_FUNCTIONS` list
- `PTHREAD_POOL_SIZE=4` aligned with `kWasmPthreadPoolSize` in `cmake/generated/ProjectMWasmBuildConfig.hpp`

There is no `-sUSE_SDL=2` in the Emscripten build (SDL2 is only used by the native
`projectM-Test-UI`, gated behind `ENABLE_SDL_UI`).

## Build, Test, and Workflow

Build/test/lint commands live in `AGENTS.md` — in particular the "Cursor Cloud specific
instructions" section (GCC + `-include atomic` workaround, `cmake-build` layout) and
"Testing Instructions" (CTest, `PresetCompat` harness). Use those verbatim; this file
only adds WASM-specific notes:

- WASM-specific testing requires serving files over HTTP due to browser security policies
  (see `AGENTS.md` "Emscripten smoke test" for the Playwright-based headless flow).
- `.milk` preset changes: validate with `scripts/kimi_validate_preset.sh <preset.milk>`
  (see [`docs/kimi_preset_authoring_plan.md`](docs/kimi_preset_authoring_plan.md)).

## Common Tasks

### Adding a New Emscripten Export
1. Define the function with `EMSCRIPTEN_KEEPALIVE` in the WASM host TU that owns
   the concern (audio → `WasmAudioBridge.cpp`, WebGL/canvas →
   `WasmWebGLContext.cpp`, dual-FBO/transitions →
   `WasmDualFbo.cpp`, per-frame/render loop → `WasmRenderLoop.cpp`,
   shader cache → `WasmShaderCache.cpp`, perf/governor → `WasmPerfGovernor.cpp`,
   playlist → `WasmPlaylistBridge.cpp`, EM_JS DOM glue → `WasmJsBindings.cpp`,
   otherwise `projectM_emscripten.cpp`). Cross-TU state goes in `ProjectMWasmInternal.hpp`.
2. Add its name (prefixed with `_`) to `PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS` in
   `cmake/EmscriptenWasmFlags.cmake`, then run `scripts/sync_wasm_link_common.sh`
   (regenerates `wasm_link_common.inc.sh` and `ProjectMWasmBuildConfig.hpp`)
3. Call it from JS via `Module.ccall`/`Module.cwrap`

### Debugging WASM Build Issues
- Check Emscripten version compatibility
- Review browser console for WebGL errors
- Use `-g4` for debug symbols in WASM
- Test with `emrun` for better error messages

### Adding Web Audio Features
1. Extend `projectm_audio_processor.js` (operates on per-channel `Float32Array`, not `AudioBuffer`)
2. Add a message handler in the worklet's `port.onmessage`
3. Update C++ `js_*` EM_JS functions to trigger new JS code
4. Add the new export to `PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS` in
   `cmake/EmscriptenWasmFlags.cmake` (and regenerate `wasm_link_common.inc.sh`) if called from C++

### Creating or Upgrading `.milk` Presets (Kimi/agent pipeline)
Follow [`docs/kimi_preset_authoring_plan.md`](docs/kimi_preset_authoring_plan.md) — the
canonical runbook for create/upgrade/fix-shader-error loops. Validate any preset with
`scripts/kimi_validate_preset.sh <preset.milk>` (exits non-zero on parse/transpile
failure) before considering a preset change done.

## Important Notes

- **WASM Memory**: Emscripten uses a linear memory model with `ALLOW_MEMORY_GROWTH=1` and
  `mimalloc`. Monitor memory growth for long-running sessions.
- **Audio Context**: WebAudio API requires user interaction to start (autoplay policy) —
  see issue #91 for the unified bootstrap effort.
- **WebGL Compatibility**: Target is WebGL2/GLES3 (`FULL_ES2=0`); not all features work in
  all browsers/devices. See issue #93 for context-loss recovery work.
- **Performance**: Profile in browser DevTools and with the in-app perf HUD
  (`js_perf_*`/`js_governor_*` functions); WASM overhead is significant for real-time graphics.

## Useful References

- [Emscripten Documentation](https://emscripten.org/docs/)
- [WebGL 2.0 Spec](https://www.khronos.org/webgl/wiki/Getting_Started_with_WebGL)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [projectM WASM/Emscripten Documentation](docs/EMSCRIPTEN.md)
- [GLSL MilkDrop Preset Format](https://github.com/projectM-visualizer/projectm/wiki)
- `AGENTS.md` — canonical build/style/test reference
- `html/README.md` — HTML host architecture (issue #78)
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — WASM bundle deploy flow, `DEPLOY_TOKEN` setup/rotation (issue #88)
