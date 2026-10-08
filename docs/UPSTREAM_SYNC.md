# Upstream sync (projectM-visualizer/projectm)

This fork (`ford442/Project-M`) tracks **[projectM-visualizer/projectm](https://github.com/projectM-visualizer/projectm)** for
library fixes, Milkdrop compatibility, rendering, audio, and WASM work — while keeping
significant custom additions (B3HD demo, AI preset pipeline, OpenMP/SIMD, experimental
integrations).

Tracked in issue [#116](https://github.com/ford442/Project-M/issues/116) (Preset Modernization M3).

## Branch layout

| Branch | Role |
|--------|------|
| **`main`** | Fork development. Cherry-pick selected upstream fixes here. Do **not** merge `master` into `main`, rebase `main` onto `master`, or use GitHub “Sync fork” on `main`. |
| **`master`** | Read-only mirror of `projectM-visualizer/projectm` `master`. Refresh it to see the next upstream changes. Do **not** commit on it. |

### Refresh the upstream mirror

```bash
./scripts/sync_upstream_master.sh
```

Equivalent:

```bash
git fetch upstream
git push origin upstream/master:master
```

`upstream` is the parent repo (`projectM-visualizer/projectm`). Its push URL is set to `DISABLE` so a stray `git push upstream` cannot overwrite the original.

To inspect what upstream gained since the last fork review (still compared against **`main`**, not merged):

```bash
git log --oneline main..master
./scripts/upstream_sync_check.sh
```

Then cherry-pick onto a branch off `main` as usual. Never fast-forward `main` to `master`.

## Cadence

| Trigger | Action |
|---------|--------|
| **Every ~5 weeks** | Run `scripts/upstream_sync_check.sh` (GitHub Action fires on the 1st of each month) |
| **Upstream release** (`v4.x.x` tag) | Run check within a week; read release notes |
| **Before large fork refactors** | Re-run check to avoid duplicating upstream fixes |

Target review time: **30–60 minutes**. Only deep-merge when a backport is approved.

## Quick start

```bash
# One-shot report (stdout)
./scripts/upstream_sync_check.sh

# Markdown report (paste into issue #116 or a PR)
./scripts/upstream_sync_check.sh --markdown

# Exit non-zero if upstream has commits since merge-base (optional CI gate)
./scripts/upstream_sync_check.sh --check
```

The check script works **without** configuring `upstream` — it fetches to `refs/remotes/upstream-sync/master`. If the remote is missing, `scripts/sync_upstream_master.sh` adds it as read-only.

## Review checklist

For each sync period, scan upstream for:

### 1. Milkdrop compatibility
- [ ] `MilkdropPreset/` parser, equation evaluator glue, shader transpiler
- [ ] `vendor/hlslparser`, `vendor/projectm-eval` submodule bumps
- [ ] Preset compat / regression tests in `presets/tests/`

### 2. Shader / rendering
- [ ] `Renderer/`, FBO lifecycle, transitions, blur, sRGB/HDR paths
- [ ] GLES vs GL parity (fork uses GLES3 in WASM)

### 3. Audio / beat detection
- [ ] `Audio/PCM.cpp`, `Loudness.cpp`, `MilkdropFFT.cpp`, `WaveformAligner.cpp`
- [ ] C API: `projectm_set_beat_sensitivity`, PCM add functions

### 4. WASM / Emscripten
- [ ] Upstream `ENABLE_EMSCRIPTEN` / `projectM_emscripten` if added
- [ ] Compare with fork-only `projectM_emscripten.cpp`, `scripts/wasm_link_common.inc.sh`
- [ ] **Do not** blindly replace fork WASM glue — merge surgically

### 5. Preset authoring / equations
- [ ] New evaluator builtins, `projectm-eval` releases
- [ ] Documentation in `docs/` on preset format

### 6. CI / packaging
- [ ] CMake options, vcpkg baseline — low priority unless blocking security

Record findings in the **Backport log** (below) and open a fork PR per accepted change.

## Backport workflow

1. Run `upstream_sync_check.sh --markdown` → save output.
2. For each candidate commit: `git cherry-pick <sha>` on a branch **or** manual port if paths diverged.
3. Run fork verification:
   ```bash
   cmake --build cmake-build --config Debug --target projectM-unittest
   ctest --test-dir cmake-build -R PresetCompat --build-config Debug
   # WASM smoke if Emscripten-related:
   # scripts/build_wasm_smoke_wrapper.sh && node tests/wasm-smoke/run.mjs ...
   ```
4. Update the backport log with PR link and fork version.

Prefer **cherry-pick** for isolated fixes in `src/libprojectM/`. Avoid merging upstream `html/` or
`projectM_emscripten.cpp` wholesale.

## Deliberate divergences (do not “sync away”)

| Area | Fork behavior | Upstream |
|------|---------------|----------|
| **WASM host** | `projectM_emscripten.cpp`, `html/projectm-*.js`, dual-FBO transitions, perf HUD, quality governor | Minimal / different Emscripten entry |
| **Staged preset loading** | `projectM-4/preset_prepare.h` (`projectm_preset_prepare_*`, `projectm_load_prepared_preset`, `projectm_poll_pending_preset`), `PresetPrepareJob`, `MilkdropPreparedPreset`, speculative transpile in `MilkdropShader`, deferred link via `KHR_parallel_shader_compile`; `LoadPresetFile()` runs through the same job | Single synchronous `LoadPresetFile()` |
| **OpenMP + SIMD** | `ENABLE_OPENMP`, `cmake/EmscriptenOpenMP.cmake`, wasm `-msimd128`, parallel per-pixel / PCM | Typically off / not wasm-tuned |
| **Preset corpus** | `custom_milk_fixed/`, `weeks_presets/`, Signature Series, `grok_agent/` | Upstream preset packs are separate repos |
| **Demo UI** | B3HD panel, preset library, FLAC/MOD PCM bridge, `?audioTest=1`, featured pack | SDL test UI only in tree |
| **Experimental** | Depth Anything / Transformers.js / glTF hooks in `projectm.1ink`, `projectm_new.1ink` (not in slim `projectm-core.html`) | Not present |
| **AI authoring** | `scripts/audit_presets.mjs`, `kimi_*`, `toml_to_milk.mjs`, capture baselines | Not present |
| **Deployment** | `deploy.py`, COOP/COEP docs, custom CDN paths | N/A |
| **Remote / branches** | `origin` → `ford442/Project-M` (`main` = fork, `master` = upstream mirror) | `projectM-visualizer/projectm` (`master`) |

When upstream adds a feature the fork also wants (e.g. PCM thread safety), **port the fix** but keep
fork-specific surrounding code.

## Backport log

| Date | Upstream | Action | Fork PR / notes |
|------|----------|--------|-----------------|
| 2026-07-10 | `16f40af10` PCM mutex | Already present | `PCM::m_pcmMutex` in tree |
| 2026-07-10 | `76c8ff7e8` HLSLParser preprocessor stack | **Evaluate** | Compare `vendor/hlslparser` |
| 2026-07-10 | `83292ed44` MilkdropShader sampler-in-comments | **Evaluate** | Preset compat + hlslparser tests |
| 2026-07-10 | `98101f56f` Detach FBO textures before delete | **Evaluate** | `Renderer/` leak fix |
| 2026-07-10 | `7778852ff` projectm-eval 1.0.6 | **Evaluate** | `git submodule status vendor/projectm-eval` |
| 2026-07-10 | `149bfc439` CI actions v4→v7 | Skip / cherry-pick later | Low impact on library |
| 2026-07-10 | GLAD + `projectm_create_with_opengl_load_proc` | Skip for WASM | Native/desktop only |
| 2026-07-18 | `76c8ff7e8` HLSLParser preprocessor stack | **Backported** | On `main`; verified in [#142](https://github.com/ford442/Project-M/pull/142) |
| 2026-07-18 | `83292ed44` MilkdropShader sampler-in-comments | **Backported** | On `main`; verified in [#142](https://github.com/ford442/Project-M/pull/142) |
| 2026-07-18 | `98101f56f` Detach FBO textures before delete | **Backported** | On `main`; verified in [#142](https://github.com/ford442/Project-M/pull/142) |
| 2026-07-18 | `7778852ff` projectm-eval 1.0.6 | **Backported** | Submodule at `da885dc`; verified in [#142](https://github.com/ford442/Project-M/pull/142) |
| 2026-07-18 | `149bfc439` CI actions v4→v7 | **Deferred** | Low library impact; cherry-pick when touching workflows |
| 2026-07-18 | GLAD + `projectm_create_with_opengl_load_proc` | **Rejected** | Desktop-only; fork already ships GLAD + resolver; no WASM value |
| 2026-07-18 | `2f2441413` libprojectM 4.2.0 version bump | **Deferred** | Metadata-only upstream commit; no functional delta since merge-base |
| 2026-08-01 | `2f2441413` libprojectM 4.2.0 version bump | **Already present** | `CMakeLists.txt` is `VERSION 4.2.0`; no functional library delta |
| 2026-08-01 | `149bfc439` CI actions v4→v7 | **Deferred** | Native/upstream-shaped jobs already `@v7`; fork-only workflows still mixed v4/v7; no library impact |
| 2026-08-01 | `76c8ff7e8` / `83292ed44` / `98101f56f` / `7778852ff` | **Backported** | Unchanged since [#142](https://github.com/ford442/Project-M/pull/142) (HLSLParser stack, sampler-in-comments, FBO detach, projectm-eval 1.0.6) |
| 2026-08-01 | GLAD + `projectm_create_with_opengl_load_proc` | **Rejected** | Unchanged: desktop-only; fork already ships GLAD + resolver |
| 2026-10-08 | `1952761b9` projectm-eval 1.0.7 | **Backported** | Submodule at `22fb0cf`. 1.0.7 switches `!`/`==`/`!=`/`&&`/`||`/`/`/`/=`/`pow` from a 1e-300 to the ns-eel2 1e-5 epsilon; `PerPixelGlslLowering` emits the same comparisons (new differential test `ZeroAndEqualityTestsUseTheEvaluatorEpsilon`) |
| 2026-10-08 | `6f64807` custom waveform OOB read, `4fcb73e` stb_image decoder pointer guards, `c1469f0` self-referential shader macro loop | **Backported** | Clean cherry-picks; all three reachable from untrusted preset/texture input |
| 2026-10-08 | `0517660` HLSL `%` types + operator precedence, `a4e86cd` hlslparser number tokenizer (quadratic → linear) | **Backported** | `a4e86cd` test file merged by hand (fork has extra preprocessor tests) |
| 2026-10-08 | `494269e` beat detection from L+R | **Backported** | Ported by hand (context conflict); `RhythmAnalyzer` already reads L+R and is unaffected |
| 2026-10-08 | `dd89dfb` `projectm_pcm_get_max_samples()` returns 576 | **Backported** | No fork caller depended on 480 |
| 2026-10-08 | `411811b` log C API creation exceptions, `a03a37a` GLResolver app-managed EGL fallback, `e98fca8` GLES 3.0 minimum | **Backported** | `e98fca8` matches WebGL2 (GLES 3.0) |
| 2026-10-08 | `88f23c7` user sprite expression variable API | **Backported** | New C API; not exported to WASM yet |
| 2026-10-08 | `0550c3b` GLM 1.0.3, `2496241` vendored GLM target fix | **Backported** | Clean; WASM build verified by CI only |
| 2026-10-08 | `60376df` playlist wrapper arg, `397f15e` build metadata, `c3ae07d`, `359bf78`, `d896766`, `1e7ef78`, `fea4963` | **Backported** | Small CMake/vcpkg/CI/README fixes. `397f15e` also drops the fork's undefined `ENABLE_SHARED_LINKING` summary line |
| 2026-10-08 | `6dc41fa` / `bc78b7f` build-doc consolidation | **Skipped** | Fork removed `BUILDING*.md`/`EMSCRIPTEN.md` and keeps its own `AGENTS.md` + `docs/` |
| 2026-10-08 | `2fc0d00` PNG oxipng | **Skipped** | Fork deleted those `docs/web/` images |

*Update this table after each sync review.*

### Latest sync snapshot (2026-10-08)

```
Merge-base: 2f2441413 (2026-07-15, libprojectM 4.2.0)
Upstream master: e98fca8 (24 commits since merge-base)
Backported: 22 (1 hand-ported, 4 with merged test/CMake conflicts); skipped: 3 (docs, PNGs)
```

Verification on this review: Linux Debug build (gcc, `ENABLE_WERROR_RATCHET=ON`,
vendored projectm-eval) with full `ctest` under `xvfb-run` — `projectM-unittest`,
`PresetCompat`, `PerPixelGlslLowering`, `PerPixelGpuRender`, transitions and the playlist
tests. `scripts/check_cpp_format.sh` clean. No local Emscripten build or WASM smoke run
(no emsdk); CI's `build_emscripten.yml` covers GLM 1.0.3 and the GLES 3.0 loader change.

## GitHub Action

`.github/workflows/upstream_sync_reminder.yml` runs monthly, executes the check script, uploads a
report artifact, and opens a GitHub issue (label `upstream-sync`) when upstream is ahead of the
merge-base or a new upstream release landed since the last run.

## Related

- [`AGENTS.md`](../AGENTS.md) — build/test reference
- [`docs/PRESET_ROADMAP.md`](PRESET_ROADMAP.md) — issue #116
- [`docs/EMSCRIPTEN.md`](EMSCRIPTEN.md) — WASM-only behavior
- [`docs/PERFORMANCE.md`](PERFORMANCE.md) — OpenMP/SIMD fork work
