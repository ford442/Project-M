# Changelog

User-visible and integrator-visible changes to this fork (`ford442/Project-M`), newest first and
keyed by **WASM bundle version**. Add an entry under "Unreleased" with the change that causes it
(see `AGENTS.md`, "Changelog").

## Versions

Three unrelated version numbers live in this repo. Do not read one as another.

| Number | Versions | Lives in | Bumped when |
|---|---|---|---|
| **WASM bundle**, `039` | the deployed browser build `projectm-v.<ver>-thread.{js,wasm}` and the host JS shipped with it | `PROJECTM_WASM_VERSION` in `html/projectm-wasm-version.js` (plus the defaults in `scripts/prepare_deploy_bundle.sh` and `scripts/verify_deploy_urls.sh`, checked by `scripts/verify_wasm_version_sync.sh`) | by hand, when a new bundle is cut for deployment. The host default (`PROJECTM_WASM_DEFAULT_VERSION`, or `default` in `pm/builds.json`) may lag the newest bundle while it has known regressions |
| **libprojectM**, `4.2.0` | the C library and C API (`projectM-4`) | `project(... VERSION 4.2.0)` in the root `CMakeLists.txt` | in practice only when upstream's changes: 4.2.0 arrived with upstream's own commit `2f2441413` (2026-07-15). The fork's C API additions are not versioned separately |
| **`@projectm/web`**, `0.3.0` | the npm embed SDK in `packages/web/` | `version` in `packages/web/package.json` | by hand; publishing runs from a `web-v<version>` tag (`.github/workflows/publish_web_package.yml`), which refuses a tag that disagrees with `package.json` |

Which shipped with which, as far as the repo can tell (a bundle is listed with the SDK version that
was in `packages/web/package.json` when the bundle was registered):

| Bundle | Registered | libprojectM | `@projectm/web` |
|---|---|---|---|
| 035 | in the tree by 2026-07-18 | 4.2.0 | 0.1.0 |
| 036 | 2026-08-14 | 4.2.0 | 0.1.0 |
| 037 | 2026-09-12 | 4.2.0 | 0.1.0 |
| 038 | 2026-09-26 | 4.2.0 | 0.2.0 |
| 039 | 2026-10-08 | 4.2.0 | 0.2.0 |
| (next) | not yet cut | 4.2.0 | 0.3.0 (since 2026-10-29) |

Caveats. The repo has no `web-v*` tags, so it cannot say which SDK version reached npm. Its `v*` tags
are upstream's (newest `v4.1.0`); the fork cuts none. It does not record which commit a deployed bundle
was built from (the staged `.build-id` is not committed), so an entry below belongs to the first bundle
whose registration commit comes after it on `main`: "in the tree when that bundle was registered". 030 to
034 predate this file; see `git log -- html/projectm-wasm-version.js`.

## Unreleased (after 039, up to 2026-11-08; the next bundle is not cut)

Engine and C API
- **Live input** (#348): live textures by name (`projectm_texture_slot_*`) and host values for per-frame
  variables (`projectm_eval_set/clear`), in both browser topologies, `?liveTex=1`. `docs/LIVE_INPUT.md`.
- **Offline rendering** (#341): `projectm_render_offline_frame()` renders on a virtual clock, and the headless EGL
  tool `projectm-render` (`-DENABLE_RENDER_TOOL=ON`) drives it. Same seed, presets, audio and frame times give the
  same pixels. `docs/OFFLINE_RENDER.md`.
- **Per-engine state** (#333, #341): `EngineContext` owns random streams, perf timers, shader-cache hooks and the log
  callback; `projectm_set_seed()` seeds one engine; `rand()` in presets follows it. `vendor/projectm-eval` is now the
  fork `ford442/projectm-eval` (branch `context-rng`); old clones need `git submodule sync vendor/projectm-eval`
  (`docs/UPSTREAM_SYNC.md`).
- **Engine safety** (#326 to #332): every C API export is guarded and null-checked, saturating float-to-int casts,
  generation-tagged host handles with validated sprite wrappers (`@projectm/web` 0.3.0), RGBA8 fallback for
  incomplete framebuffers, a PCM lock, owned prepare jobs.
- **Render-device seam** (#308): all GL behind `Renderer/Device` (WebGPU groundwork, bit-identical output).
  `docs/RENDER_DEVICE.md`.
- **Render-device pipelines** (#354 B1): each draw sets an immutable `PipelineDesc` (program, blend, cull, depth,
  write masks, line smoothing, vertex layout, topology), cached by hash; `Draw()`/`DrawIndexed()` take no primitive,
  and GL calls for state already applied are skipped. `BlendMode` and the stateful blend/depth/mask/cull calls are
  gone. The waveform, custom-wave and transition paths no longer allocate every frame. Output is pixel-identical.
  After `projectm_opengl_render_frame()` and `projectm_opengl_burn_texture()` the host finds GL's default
  blend/depth/cull state and program 0 (before, the last blend function and program stayed bound).
- **Shader passes in `.milk` presets** (#229): `warp_nPasses`/`comp_nPasses` (at most 3 shaders per stage) run
  `warp_passK_`/`comp_passK_` shaders before the stage's own, which read the previous pass as `sampler_lastpass`
  (`iLastPassTex`, `GetLastPass(uv)`) and know their number as `iPass`. A count over 3 or a declared pass without code
  fails the load (switch-failed callback), a pass that fails to compile puts the stage on its default shader, and
  presets without the key render exactly as before. `docs/MILK_SHADER_PASSES.md`.
- **Two transitions and a host wipe mask** (#229): `Shatter` (the old frame breaks into falling glass shards) and
  `StarWipe` (a star iris whose points bass pumps) join the random pool. The `Masked` blend mode reads a host's
  grayscale `/textures/pm_wipe_mask.png` (or a live texture `pm_wipe_mask`) as its reveal order, falling back to its
  noise. `docs/transition_shaders.md`; GIFs in `docs/images/transitions/`.
- User sprites from the embed SDK, an experimental `pm_depth` sampler, `projectm_reload_texture()` (#308, stacked #309).
- Beat-locked preset switching with latency compensation (#345).
- This branch (`p0-main-green`): `projectm_perf_enter_gpu_stage()` takes an `int` (out-of-range values are
  refused instead of being an invalid enum value); the installed C++ interface target exports `cxx_std_20`
  when `ENABLE_CXX_INTERFACE=ON`. A preset whose preparation finishes after the WebGL context is lost but
  before the page has handled the loss is no longer activated on the lost context (that aborted the runtime
  with `std::terminate`); it stays queued until the context is back.

Browser host and hosting
- **Host lifecycle** (#353 Track 1): the page's AudioContext and worklet now have owners. Each live
  `ProjectMContext` (and the page shell) holds the audio graph, and the last one to go disconnects the
  worklet and closes the AudioContext it created. A new `audioContext` option injects one the
  embedder owns, which is never closed. A hidden or frozen page pauses the engine's render loop and
  resumes it on show or bfcache restore, and a Screen Wake Lock is held while audio plays
  (`wakeLock: false` opts out). Context-loss recovery replays a per-context record (preset, mesh
  quality, flash limit, preset lock, `eval_set` values, live-texture slots, sprites under their
  original ids) instead of reloading the page-global `currentPresetPath`. The two `localStorage`
  calls that threw with storage blocked are guarded.
- **Builds load from a manifest** (#290): `pm/builds.json`, UTF-8 `.js` glue only (`.1ijs`/`.3ijs` redirect), per-folder
  song indexes, `.htaccess` headers. `docs/adr/0001-wasm-and-media-hosting.md`.
- Per-host WebGL context contract (`create_host_with_config()`, distinct init codes), per-engine events, and the
  present pass: opt-in temporal flash limiter, `captureFrame`, commit counter (#290).
- Opaque canvas by default; transparency is valid premultiplied output; `get_context_snapshot()` (#308, stacked on #307).
- Tab/system audio capture via `getDisplayMedia` (#283); API presets load through the render-worker transport.
- Canvas renders sharply on HiDPI screens (#320); the audio button no longer sits under the FLAC player (#319).
- Host layer: one owner per piece of state (#343). SDK build finds URL assets instead of listing them.

Build, CI and docs
- One WASM build entry, `scripts/build_wasm.sh` (#308); the bundle is the `projectM_wasm` CMake target (#347).
- Main CI repaired (#306, #321); hazard inventory over the preset corpora (#344); upstream sync of 2026-11-06 (#346);
  WebGL extension allow-list and WASM logging through `Logging` (#347).
- This branch: workflows pinned to commit SHAs with Dependabot, least-privilege `permissions`, per-job timeouts;
  `push_release.yml` removed; `graphics_perf_bench.yml` manual only; the nightly capture fails on unlisted failures;
  README rewritten for the fork; stale docs regenerated or archived (`docs/archive/README.md`).
- **Fuzzing** (#351): four libFuzzer targets for the untrusted-input surface in `tests/fuzz/` (preset parser,
  HLSL transpiler, expression evaluator, shader passes), `-DENABLE_FUZZING=ON` (clang, ASan + UBSan);
  `fuzz_smoke.yml` (60 s per target on every push/PR, no `paths:` filter) and `fuzz_nightly.yml` (30 min per
  target, corpus cached, findings uploaded). Fixed crashers live in `tests/fuzz/regressions/` and every
  `BUILD_TESTING` build replays them under ctest (`FuzzRegression.*`). `docs/FUZZING.md`.
- **hlslparser fixes found by fuzzing** (#351), each reachable from a preset file in every build: a shader
  identifier longer than 255 characters overflowed the tokenizer's fixed buffer (memory corruption on
  preset load); an empty `()`/`{}` expression and a `#define` that failed to parse dereferenced null; and three inputs hung preset loading
  forever (`#if`/`#ifdef` before an unterminated comment, a NUL inside a `#define`, a self-referencing or
  cyclic macro). All six are now ordinary transpile errors. `docs/FUZZING.md` "Findings so far".

## 039 (registered 2026-10-08, host default)

- Musical time (#277): `RhythmAnalyzer`, the `pm_*` preset variables (tempo, beat phase, onsets, sections), the
  rhythm C API (`rhythm.h`) and beat-aligned preset scheduling. `docs/AUDIO_PIPELINE.md`.
- Per-stage GPU timers and a worker-mode perf HUD (#276); the hardware-baseline preset set.
- FLAC player: STREAMINFO-coded FLACs decode (#279); one real-time PCM producer into projectM (#280).
- API preset loading fixed in worker mode (#281).
- Upstream sync (#278): 22 upstream commits (projectm-eval 1.0.7, HLSL parser and untrusted-input fixes, GLM 1.0.3).

## 038 (2026-09-26)

- Presets prepare off the GL thread on a per-host pthread, ASYNCIFY is gone, and the HTML host is restartable (#264); new `preset_prepare.h`.
- GPU per-pixel evaluation: `per_pixel` equations compile into the warp vertex shader (#254), Phase 1.5 raises coverage
  from 186 to 227 presets (#266). `docs/GPU_PERPIXEL_EVAL.md`.
- Toolchain: emsdk 6.0.6 in CI, `FULL_ES3=0`, `-fwasm-exceptions`, fixed heap, and a deploy staleness guard (#252, #265).
- C++ hygiene gates: clang-tidy hard gate, ASan/UBSan job (#253).

## 037 (2026-09-12)

- The SAB PCM ring is the only audio ingest path (#241).
- libomp no longer spins between frames (the 032 to 036 audio and framerate regression, #223); the host moved to
  `src/wasm/` and `.1ink` pages were deprecated (#231); the wrapper was split into focused TUs.
- Deterministic frame capture, golden-image gate and frame-budget records (#242). The dual-FBO preset A pair is
  reclaimed when idle; blit-based texture resolves (#214, #217).
- Multi-engine hosts (`create_host` / `set_active_host`, two engines in one Module) and host-driven WebGL context config (`set_context_config`; JS, not URL scraping in C++, decides antialias, preserveDrawingBuffer, power preference and dual-FBO precision).

## 036 (2026-08-14)

- Governor v2: mesh, blur-cap and render-scale tiers, MSAA opt-in (#212); blur resolution follows the tiers (#213).
- Crossfade-gated benchmark mode for the dual-FBO format A/B (#215, #216).
- The host default (`PROJECTM_WASM_DEFAULT_VERSION`) was set to 032 on 2026-08-19 and stayed there until 039.

## 035 (in the tree by 2026-07-18; default `?wasm=` on projectm.1ink.us from 2026-08-10, #211)

- WASM version picker (`?wasm=<ver>`), `prod` deploy target, COOP/COEP fixes (2026-08-06).
- Deploy renames a bundle and rewrites the smoke-tag `locateFile` string in the glue (#209).
- FLAC playback waits for the AudioWorklet (#210); `glHint` deferred until after GLAD init.
- Earlier in the same window: `@projectm/web` 0.1.0 (2026-07-18), AudioSourceRouter, `?mode=weeks_on_fire`.
