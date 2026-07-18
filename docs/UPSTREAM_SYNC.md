# Upstream sync (projectM-visualizer/projectm)

This fork (`ford442/Project-M`) tracks **[projectM-visualizer/projectm](https://github.com/projectM-visualizer/projectm)** for
library fixes, Milkdrop compatibility, rendering, audio, and WASM work — while keeping
significant custom additions (B3HD demo, AI preset pipeline, OpenMP/SIMD, experimental
integrations).

Tracked in issue [#116](https://github.com/ford442/Project-M/issues/116) (Preset Modernization M3).

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

Optional: add a read-only remote (do **not** push to it):

```bash
git remote add upstream https://github.com/projectM-visualizer/projectm.git
git fetch upstream master
```

The script works **without** configuring `upstream` — it fetches to `refs/remotes/upstream-sync/master`.

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
| **OpenMP + SIMD** | `ENABLE_OPENMP`, `cmake/EmscriptenOpenMP.cmake`, wasm `-msimd128`, parallel per-pixel / PCM | Typically off / not wasm-tuned |
| **Preset corpus** | `custom_milk_fixed/`, `weeks_presets/`, Signature Series, `grok_agent/` | Upstream preset packs are separate repos |
| **Demo UI** | B3HD panel, preset library, FLAC/MOD PCM bridge, `?audioTest=1`, featured pack | SDL test UI only in tree |
| **Experimental** | Depth Anything / Transformers.js / glTF hooks in `projectm.1ink`, `projectm_new.1ink` (not in slim `projectm-core.html`) | Not present |
| **AI authoring** | `scripts/audit_presets.mjs`, `kimi_*`, `toml_to_milk.mjs`, capture baselines | Not present |
| **Deployment** | `deploy.py`, COOP/COEP docs, custom CDN paths | N/A |
| **Remote** | `origin` → `ford442/Project-M` | `projectM-visualizer/projectm` |

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
| 2026-07-18 | `76c8ff7e8` HLSLParser preprocessor stack | **Backported** | On `main`; `&& !isCodeActive.empty()` guard in `vendor/hlslparser/src/HLSLParser.cpp`; verified HLSLParser gtests |
| 2026-07-18 | `83292ed44` MilkdropShader sampler-in-comments | **Backported** | On `main` via `ShaderTranspiler` + `Utils::StripComments`; `MilkdropShaderCommentParsingTest` green |
| 2026-07-18 | `98101f56f` Detach FBO textures before delete | **Backported** | On `main`; detach→resize→reattach in `Framebuffer::SetSize()`, FBO-first teardown in destructor |
| 2026-07-18 | `7778852ff` projectm-eval 1.0.6 | **Backported** | Submodule at `da885dc` (v1.0.6), matches upstream pointer |
| 2026-07-18 | `149bfc439` CI actions v4→v7 | **Deferred** | Low library impact; cherry-pick when touching workflows |
| 2026-07-18 | GLAD + `projectm_create_with_opengl_load_proc` | **Rejected** | Desktop-only; fork already ships GLAD + resolver; no WASM value |
| 2026-07-18 | `2f2441413` libprojectM 4.2.0 version bump | **Deferred** | Metadata-only upstream commit; no functional delta since merge-base |

*Update this table after each sync review.*

### Latest sync snapshot (2026-07-18)

```
Merge-base: 4d2849333 (2026-05-08)
Upstream since merge-base: 2 commits (4.2.0 version bump, CI actions v4→v7)
Fork-only since merge-base: 3727 commits
Upstream release: v4.1.7 (2026-07-14)
```

Verification on this review (Debug build, GCC 13):

- `ctest -R PresetCompat` — pass (`presets/tests/`)
- `projectM-unittest` — pass (incl. `HLSLParser` + `SamplerParsing` suites, 30 tests)
- No Renderer/Emscripten code changes required; WASM smoke not re-run (no delta)

## GitHub Action

`.github/workflows/upstream_sync_reminder.yml` runs monthly, executes the check script, uploads a
report artifact, and opens a GitHub issue (label `upstream-sync`) when upstream is ahead of the
merge-base or a new upstream release landed since the last run.

## Related

- [`AGENTS.md`](../AGENTS.md) — build/test reference
- [`docs/PRESET_ROADMAP.md`](PRESET_ROADMAP.md) — issue #116
- [`docs/EMSCRIPTEN.md`](EMSCRIPTEN.md) — WASM-only behavior
- [`docs/PERFORMANCE.md`](PERFORMANCE.md) — OpenMP/SIMD fork work
