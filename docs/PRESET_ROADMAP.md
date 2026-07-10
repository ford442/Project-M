# Preset Modernization Roadmap

Living tracker for the effort to **curate, upgrade, and expand the preset library**,
building on the recent OpenMP + SIMD performance wins. The canonical discussion and
progress bar live in the GitHub epic
[#110 — Preset Modernization Roadmap](https://github.com/ford442/Project-M/issues/110);
this file is the in-repo companion so the plan travels with the code.

## Goals

- Harden and optimize current presets for reliability and **60fps in WASM**.
- Create a **systematic workflow** for high-quality new custom presets.
- Leverage AI/agent tools (`grok_agent/`, Kimi, Claude, etc.) for generation and review.
- Improve demo UX around presets (browsing, metadata, transitions).

## Effort Split

**70% upgrade / harden · 30% new creative.** When choosing what to pick up next,
default to the harden track unless a creative item is explicitly scheduled.

## Priority Legend

| Tag  | Meaning                       |
|------|-------------------------------|
| `P0` | Blocking foundation, do first |
| `P1` | High value, do next           |
| `P2` | Opportunistic / ongoing       |

## Milestones

### M1 — Harden & Baseline (`P0`)
Every high-value preset passes a smoke test at 60fps with no crashes; preset hot
paths are profiled and SIMD/OpenMP-optimized.
- #111 — Audit, upgrade and harden existing presets
- #112 — Extend OpenMP/SIMD to preset evaluation and rendering

### M2 — Verify & Tool (`P1`)
Audio reactivity verified, repeatable benchmarking in place, metadata/browser UX
shipped, Signature Series workflow documented with a first batch.
- #115 — Verify accurate audio data reactivity
- #117 — Enhance `optimize.sh` + preset-specific benchmarking/profiling
  — see [`BENCHMARKING.md`](BENCHMARKING.md)
- #114 — Preset metadata, tagging, search/browser improvements
- #113 — Systematic workflow + tooling for new custom presets (Signature Series)

### M3 — Explore & Maintain (`P2`)
Upstream sync cadence established, experimental feature prototypes evaluated.
- #116 — Monitor upstream `projectM-visualizer/projectm` and evaluate backports
  — see [`UPSTREAM_SYNC.md`](UPSTREAM_SYNC.md) + `scripts/upstream_sync_check.sh`
- #118 — Explore experimental features (Depth Anything, glTF, Transformers.js)
  — see [`EXPERIMENTAL_PRESET_HOOKS.md`](EXPERIMENTAL_PRESET_HOOKS.md)

## Tracked Sub-Issues

### Upgrade & Harden (70%)

| Issue | Area | Priority | Milestone |
|-------|------|----------|-----------|
| [#111](https://github.com/ford442/Project-M/issues/111) | Audit, upgrade & harden existing presets (`weeks_presets/` + `custom_milk_fixed/`) | `P0` | M1 |
| [#112](https://github.com/ford442/Project-M/issues/112) | Extend OpenMP pragmas + SIMD to preset evaluation and rendering | `P0` | M1 |
| [#115](https://github.com/ford442/Project-M/issues/115) | Verify accurate audio data reactivity (FFT, beat, waveform, per-frame eqs) | `P1` | M2 |
| [#117](https://github.com/ford442/Project-M/issues/117) | `optimize.sh` + preset benchmarking (`docs/BENCHMARKING.md`) | `P1` | M2 |
| [#114](https://github.com/ford442/Project-M/issues/114) | Preset metadata, tagging, search/browser improvements in demo UI | `P1` | M2 |
| [#116](https://github.com/ford442/Project-M/issues/116) | Monitor upstream projectM + evaluate backports | `P2` | M3 |

### New & Creative (30%)

| Issue | Area | Priority | Milestone |
|-------|------|----------|-----------|
| [#113](https://github.com/ford442/Project-M/issues/113) | Systematic workflow + tooling for new custom presets (Signature Series) | `P1` | M2 |
| [#118](https://github.com/ford442/Project-M/issues/118) | Explore experimental features (Depth Anything, glTF, Transformers.js) with presets | `P2` | M3 |

## Working Corpora & Tooling

The preset work operates over three corpora, described in
[`presets/agent_manifest.json`](../presets/agent_manifest.json):

- **`custom_milk_fixed/`** — curated AI-authored regression set (`milk0xx` + `fractal_echo_*`
  series). Opt-in via `PROJECTM_TEST_CUSTOM_MILK_FIXED=1`.
- **`weeks_presets/`** — large community corpus (~400 `.milk` files); validate via
  `PROJECTM_PRESET_COMPAT_DIR` before bulk upgrades.
- **`presets/tests/`** — small parser/shader fixtures covered by the default
  `projectM-unittest` `PresetCompat` run.

Author/validate/upgrade helpers:

- `scripts/audit_presets.mjs` — **GPU-free static reliability audit** (Node only, no
  build). Complements the compat harness by catching runtime hazards (division by
  zero, unbalanced `()`/`{}`/`[]` across equation and shader groups, literal NaN
  sources), tiering presets `light`/`medium`/`heavy`, and emitting metadata
  (description, author, audio-reactivity, PSVERSION). Run `--selftest` to verify the
  checker; gated per push by `.github/workflows/preset_audit.yml`. Latest run:
  [`docs/PRESET_AUDIT.md`](PRESET_AUDIT.md) / [`docs/preset_audit_report.json`](preset_audit_report.json).
- `scripts/kimi_validate_preset.sh` — validate a preset against the current build.
- `scripts/kimi_upgrade_preset.sh` — AI-assisted upgrade pass.
- `scripts/test_presets.sh` — batch smoke test.
- `scripts/generate_custom_preset_manifest.mjs` — regenerate the demo picker manifest (tags, tier, weight).
- `scripts/build_featured_pack.mjs` — curated Featured / Signature pack for B3HD (`html/featured_pack_manifest.json`).
- [`docs/PRESET_METADATA.md`](PRESET_METADATA.md) — header-comment + sidecar JSON metadata spec.
- `scripts/capture_custom_milk_screenshots.mjs` — capture reference screenshots.
- `grok_agent/` — agent plans, prompts, and review checklists for generation/review.

Authoring references: [`docs/WRITING_NEW_MILK_PRESETS_GUIDE.md`](WRITING_NEW_MILK_PRESETS_GUIDE.md),
[`docs/MILK_PRESET_GUIDE.md`](MILK_PRESET_GUIDE.md),
[`docs/kimi_preset_authoring_plan.md`](kimi_preset_authoring_plan.md), and the
`docs/milk0xx_creative_brief.md` worked examples.

New-preset pipeline: [`SIGNATURE_SERIES_WORKFLOW.md`](SIGNATURE_SERIES_WORKFLOW.md) (issue #113).

Audio reactivity verification: [`AUDIO_PIPELINE.md`](AUDIO_PIPELINE.md) (issue #115).

## Definition of Done (per harden issue)

- All high-value presets pass the smoke test at 60fps in the WASM/B3HD demo.
- No crashes, no NaNs, no obvious visual artifacts.
- Heavy per-pixel logic pushed to `shader_body` where feasible.
- Lightweight metadata/comments added (tags, performance tier, author).

## Maintenance

Update this file and the epic (#110) whenever a sub-issue changes state, a new
sub-issue is added, or the milestone/priority plan shifts. Keep the GitHub epic's
task list and this table in sync.
