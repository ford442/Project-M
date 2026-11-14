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
- [ ] `vendor/hlslparser`, `vendor/projectm-eval` submodule bumps (the latter is the fork's own repo, see [projectm-eval fork](#projectm-eval-fork))
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
- [ ] New evaluator builtins, `projectm-eval` releases (merge them into the fork's `context-rng` branch, see [projectm-eval fork](#projectm-eval-fork))
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
| **Live input** | `projectM-4/live_input.h`: live textures (`projectm_texture_slot_*`, `TextureManager` live slots, `IRenderDevice::WriteTexture`) and host per-frame variables (`projectm_eval_set/clear`, applied in `MilkdropPreset::PerFrameUpdate()`); see `docs/LIVE_INPUT.md` | Textures only from files or the load callback; no way to set preset variables from the host |
| **Expression evaluator** | `vendor/projectm-eval` is the fork `ford442/projectm-eval`, branch `context-rng`: upstream 1.0.7 plus a per-context `rand()` stream and `projectm_eval_context_seed_rand()`. See [projectm-eval fork](#projectm-eval-fork) | `projectM-visualizer/projectm-eval` (shared static `rand()` stream) |
| **OpenMP + SIMD** | `ENABLE_OPENMP`, `cmake/EmscriptenOpenMP.cmake`, wasm `-msimd128`, parallel per-pixel / PCM | Typically off / not wasm-tuned |
| **Preset corpus** | `presets/custom/`, `presets/weeks/`, Signature Series, `docs/agents/grok/` | Upstream preset packs are separate repos |
| **Demo UI** | B3HD panel, preset library, FLAC/MOD PCM bridge, `?audioTest=1`, featured pack | SDL test UI only in tree |
| **Experimental** | Depth Anything / Transformers.js / glTF hooks in `projectm.1ink`, `projectm_new.1ink` (not in slim `projectm-core.html`) | Not present |
| **AI authoring** | `scripts/audit_presets.mjs`, `kimi_*`, `toml_to_milk.mjs`, capture baselines | Not present |
| **Deployment** | `deploy.py`, COOP/COEP docs, custom CDN paths | N/A |
| **Remote / branches** | `origin` → `ford442/Project-M` (`main` = fork, `master` = upstream mirror) | `projectM-visualizer/projectm` (`master`) |

When upstream adds a feature the fork also wants (e.g. PCM thread safety), **port the fix** but keep
fork-specific surrounding code.

## projectm-eval fork

`vendor/projectm-eval` is **not** upstream's repository. `.gitmodules` points it at the fork:

```ini
[submodule "vendor/projectm-eval"]
	path = vendor/projectm-eval
	url = https://github.com/ford442/projectm-eval.git
	branch = context-rng
```

The pin is whatever `git ls-tree HEAD vendor/projectm-eval` says. At the time of writing
(2026-11-13) that is `6f87e32` ("Give each context its own rand() stream"), a single commit on top
of upstream projectm-eval 1.0.7 (`22fb0cf`, "Bump version to 1.0.7"). The `branch = context-rng`
line only tells `git submodule update --remote` which branch to follow; the commit recorded in
this repo is what is checked out. It landed in [#341](https://github.com/ford442/Project-M/pull/341).

**What the fork adds.** Upstream's `rand()` drew from one static Mersenne Twister shared by every
evaluator context, so contexts on different threads raced on it and one context's draws shifted
another's. In the fork the stream lives in the compile context, and there is a new C API,
`projectm_eval_context_seed_rand(ctx, seed)` (`projectm-eval/api/projectm-eval.h`). Unseeded
contexts start from Milkdrop's default seed (`0x4141f00d`); expression nodes built without a
context fall back to a process-wide stream. libprojectM calls it from
`src/libprojectM/MilkdropPreset/EvalRandom.hpp` (`SeedEvalRandom()`), so `rand()` in preset code
follows the engine's seed (`projectm_set_seed()`, see `EngineContext`) and engines do not disturb
each other. An installed (system or vcpkg) projectM-eval does not have the symbol; with one,
`SeedEvalRandom()` compiles to a no-op and `rand()` stays on the single process-wide stream. The
default `ENABLE_SYSTEM_PROJECTM_EVAL=ON` falls back to the vendored sources when nothing is installed.

**Re-syncing with upstream.** Merge upstream into the fork's branch, then bump the submodule here:

```bash
cd vendor/projectm-eval
git remote add upstream https://github.com/projectM-visualizer/projectm-eval.git   # once
git fetch upstream --tags
git checkout context-rng
git merge <upstream release tag or commit>   # keep projectm_eval_context_seed_rand() and its tests
# build and run projectm-eval's own tests, then publish the branch (needs push access to the fork):
git push origin context-rng
cd ../..
git add vendor/projectm-eval                  # records the new merge commit as the pin
```

Then verify the way an upstream bump is verified (see "Backport workflow"), with the vendored
evaluator: configure with `-DENABLE_SYSTEM_PROJECTM_EVAL=OFF`, run the full `ctest`, including
`PerPixelGlslLowering` and `PerPixelGpuRender`, which only run against vendored sources. Evaluator
semantics are mirrored in the GPU per-pixel path (the 1.0.7 epsilon change needed a matching
change there, see the 2026-10-08 log row), so read upstream's changes to operators and builtins,
not just whether it merges cleanly. Record the bump in the Backport log below.

**An old clone whose submodule still points at upstream.** A clone made before the move has
`submodule.vendor/projectm-eval.url` in its `.git/config` set to
`https://github.com/projectM-visualizer/projectm-eval.git`. The fork's commit cannot be fetched from
there, so the submodule stays on an upstream commit (or empty) and the build fails. Re-read the URL
from `.gitmodules` and fetch the pinned commit:

```bash
git submodule sync vendor/projectm-eval
git submodule update --init vendor/projectm-eval
git submodule status vendor/projectm-eval   # no leading '+' or '-'
```

`vendor/CMakeLists.txt` now checks this at configure time (only when no external projectM-Eval is
used). It stops with a `FATAL_ERROR` that prints the same `git submodule sync` /
`git submodule update --init` instruction when the vendored `projectm-eval.h` has no
`projectm_eval_context_seed_rand`, and with `git submodule update --init --recursive` when the
directory is empty. Without the check, a stale submodule failed deep in the compile with
"projectm_eval_context_seed_rand was not declared".

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
| 2026-07-18 | `7778852ff` projectm-eval 1.0.6 | **Backported** | Submodule was at `da885dc` then (upstream's own repo); verified in [#142](https://github.com/ford442/Project-M/pull/142). Superseded by the fork pin, see [projectm-eval fork](#projectm-eval-fork) |
| 2026-07-18 | `149bfc439` CI actions v4→v7 | **Deferred** | Low library impact; cherry-pick when touching workflows |
| 2026-07-18 | GLAD + `projectm_create_with_opengl_load_proc` | **Rejected** | Desktop-only; fork already ships GLAD + resolver; no WASM value |
| 2026-07-18 | `2f2441413` libprojectM 4.2.0 version bump | **Deferred** | Metadata-only upstream commit; no functional delta since merge-base |
| 2026-08-01 | `2f2441413` libprojectM 4.2.0 version bump | **Already present** | `CMakeLists.txt` is `VERSION 4.2.0`; no functional library delta |
| 2026-08-01 | `149bfc439` CI actions v4→v7 | **Deferred** | Native/upstream-shaped jobs already `@v7`; fork-only workflows still mixed v4/v7; no library impact |
| 2026-08-01 | `76c8ff7e8` / `83292ed44` / `98101f56f` / `7778852ff` | **Backported** | Unchanged since [#142](https://github.com/ford442/Project-M/pull/142) (HLSLParser stack, sampler-in-comments, FBO detach, projectm-eval 1.0.6) |
| 2026-08-01 | GLAD + `projectm_create_with_opengl_load_proc` | **Rejected** | Unchanged: desktop-only; fork already ships GLAD + resolver |
| 2026-10-08 | `1952761b9` projectm-eval 1.0.7 | **Backported** | Submodule was at `22fb0cf` (upstream 1.0.7) at the time of this row; it is no longer the pin: since 2026-10-29 the submodule points at the fork commit `6f87e32`, one commit on top of `22fb0cf` ([projectm-eval fork](#projectm-eval-fork)). 1.0.7 switches `!`/`==`/`!=`/`&&`/`||`/`/`/`/=`/`pow` from a 1e-300 to the ns-eel2 1e-5 epsilon; `PerPixelGlslLowering` emits the same comparisons (new differential test `ZeroAndEqualityTestsUseTheEvaluatorEpsilon`) |
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
| 2026-10-29 | (fork change, not an upstream commit) `vendor/projectm-eval` moved to `ford442/projectm-eval` at `6f87e32` | **Fork divergence** | Landed in [#341](https://github.com/ford442/Project-M/pull/341). Gives each evaluator context its own `rand()` stream so engines can be seeded independently; see [projectm-eval fork](#projectm-eval-fork) |
| 2026-11-06 | `7b6b04d` VCS version only from projectM's own `.git` | **Backported** | Clean cherry-pick; `EXISTS` also matches the `.git` file of a worktree |
| 2026-11-06 | `349b7cc` README Android TV / Google TV section | **Skipped** | End-user README; fork keeps its own docs |

*Update this table after each sync review.*

### Latest sync snapshot (2026-11-06)

```
Merge-base: 2f2441413 (2026-07-15, libprojectM 4.2.0)
Upstream master: 349b7cc (26 commits since merge-base)
Backported: 22 (21 on 2026-10-08, 1 hand-ported, 4 with merged test/CMake conflicts; 7b6b04d on 2026-11-06); skipped: 4 (docs, PNGs, README)
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
