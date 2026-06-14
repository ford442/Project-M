# Kimi CLI Preset Authoring & Upgrade Plan

> **Audience:** Kimi CLI (and compatible agents: Codex, Grok, Claude)  
> **Goal:** Reliably **create** and **upgrade** MilkDrop `.milk` presets for this fork's WASM build  
> **Runtime target:** projectM 4.1.x / ford442 WASM port (`PSVERSION_WARP=3`, `PSVERSION_COMP=3`, GLES3)

---

## 1. What Kimi Is Good At (use these strengths)

| Kimi strength | Apply to presets |
|---|---|
| Long-context file editing | Refactor multi-section `.milk` files (`per_frame`, `per_pixel`, warp/comp shaders) |
| CLI batch workflows | Lint/upgrade hundreds of files in `weeks_presets/`, `custom_milk_fixed/` |
| Structured prompts | Follow creative brief → implementation → validation loops |
| Diff-driven iteration | Fix shader compile errors from parser logs iteratively |

**Kimi should not** invent unsupported MilkDrop 3 features or desktop-only GL extensions. Always ground changes in `docs/WRITING_NEW_MILK_PRESETS_GUIDE.md`.

---

## 2. Repository map (read before editing)

| Path | Purpose |
|---|---|
| `docs/WRITING_NEW_MILK_PRESETS_GUIDE.md` | Canonical syntax, pitfalls, quick-start |
| `docs/milk011_creative_brief.md` | Example creative brief → preset breakdown |
| `docs/milk_kimi_swarm.md` | Multi-agent role prompts (Designer, Validator, etc.) |
| `presets/tests/` | Small fixtures for parser tests |
| `custom_milk_fixed/` | Curated AI/community presets (regression set) |
| `weeks_presets/` | Large preset corpus |
| `src/libprojectM/MilkdropPreset/` | Parser, shader transpile, eval |
| `vendor/hlslparser/` | HLSL → GLSL (limited preprocessor — see pitfalls) |

---

## 3. Standard Kimi CLI workflow

This fork provides two executable entrypoints for the loop below:

- **`scripts/kimi_validate_preset.sh <preset.milk> [<build-dir>]`** — parses a single
  preset and transpiles its `warp_`/`comp_` shaders HLSL→GLSL via the
  `PresetCompat.ParseAndTranspile` harness (issue #77). Exits `0` on success, non-zero
  with an actionable gtest failure log otherwise. Builds `projectM-unittest` if needed
  (default build dir: `cmake-build-verify`).
- **`scripts/kimi_upgrade_preset.sh <preset.milk> [<output-prompt-file>]`** — prints a
  ready-to-run Kimi prompt for upgrading a legacy preset, with the "10 Most Frequent
  Errors" checklist (`WRITING_NEW_MILK_PRESETS_GUIDE.md` §9) embedded so Kimi self-checks
  before handing back. Pipe directly into `kimi`, or save with the second argument.

### Phase A — Create new preset

```bash
# 1. Start from brief (human or Designer agent output). docs/milk011_creative_brief.md
#    ("Nebula Core") is the worked example: a creative brief broken into per_frame
#    bridge vars (q1-q12), per_pixel layers, shapecode/wavecode blocks, and an
#    audio-reactivity table — follow the same structure for new briefs.
kimi "Read docs/milk011_creative_brief.md and docs/WRITING_NEW_MILK_PRESETS_GUIDE.md.
     Create custom_milk_fixed/milk016.milk implementing a new creative brief in the
     same style as milk011 (per_frame bridge vars q1-q12, layered per_pixel,
     shapecode/wavecode where useful, audio-reactivity table as a header comment).
     Use MILKDROP_PRESET_VERSION=200, PSVERSION_WARP=3, PSVERSION_COMP=3.
     Limit q1-q12 bridges; document audio mapping in preset comments."

# 2. Validate parse + transpile
scripts/kimi_validate_preset.sh custom_milk_fixed/milk016.milk

# 3. Browser smoke (WASM)
# Serve html/projectm-core.html + load via FS or API (see section 8)
```

### Phase B — Upgrade existing preset

```bash
# 1. Generate the upgrade prompt (embeds the section 9 pitfall checklist) and run it
scripts/kimi_upgrade_preset.sh weeks_presets/<subdir>/<file>.milk | kimi

# 2. Validate the result
scripts/kimi_validate_preset.sh weeks_presets/<subdir>/<file>.milk
```

The generated prompt asks Kimi to:
- Replace unsupported HLSL (texture arrays, dynamic loops) with GLES3-safe patterns
- Fix preprocessor: use `#define`/`#if`/`#else`/`#endif` only (no `#ifdef` unless parser supports it)
- Clamp decay/zoom to stable ranges; add `fDecay>=0.9` if feedback blows out
- Preserve visual intent; output a short CHANGELOG comment at top of file
- Self-check against `WRITING_NEW_MILK_PRESETS_GUIDE.md` §9 (10 Most Frequent Errors)
  before finishing, then run `scripts/kimi_validate_preset.sh` itself and report pass/fail

### Phase C — Shader-error fix loop

When a preset fails to parse/transpile or breaks at runtime:

```bash
# 1. Reproduce and capture the failure (parser test output, or browser #stat/console)
scripts/kimi_validate_preset.sh custom_milk_fixed/milk011.milk > /tmp/validate.log || true

# 2. Hand the failing section + log to Kimi for a minimal, targeted fix
kimi "scripts/kimi_validate_preset.sh custom_milk_fixed/milk011.milk failed with the
     log below. Read only the failing warp_/comp_/per_pixel_/per_frame_ section named
     in the error, consult docs/WRITING_NEW_MILK_PRESETS_GUIDE.md section 4 (HLSL-9
     subset) and section 9 (pitfalls), and apply the minimal diff that fixes the
     reported error without changing unrelated lines.

     --- validator log ---
     $(cat /tmp/validate.log)"

# 3. Re-run the validator; repeat until exit 0
scripts/kimi_validate_preset.sh custom_milk_fixed/milk011.milk
```

---

## 4. Preset structure checklist (every new/upgrade)

- [ ] Header: `MILKDROP_PRESET_VERSION=200`, `PSVERSION_WARP=3`, `PSVERSION_COMP=3`
- [ ] `fDecay` in `[0.85, 0.995]` unless intentional melt
- [ ] `per_frame` sets `zoom`, `rot`, `decay` sanely before warp
- [ ] `q1`–`q12` documented; no more than needed
- [ ] Warp/comp shaders: HLSL 2.0/3.0 subset — no `sampler2DArray`, no `tex2Dlod` unless verified
- [ ] Custom waves/shapes: `samples` ≤ 512 for WASM perf
- [ ] No `#ifdef` chains unless validated (see hlslparser limits — issue #993 class bugs)
- [ ] File name ASCII-safe (playlist parser issue on Windows for Cyrillic names)

---

## 5. Kimi agent roles (from `milk_kimi_swarm.md`)

Run narrow agents sequentially:

1. **Preset Designer** → creative brief (markdown only)  
2. **HLSL Shader Architect** → `warp_` / `comp_` / `per_pixel_` blocks  
3. **Preset Validator** → run harness, list failures  
4. **Performance Optimizer** → reduce fbm octaves, mesh-friendly math  
5. **Knowledge Librarian** → update `docs/` if new pattern discovered  

**Coordinator rule:** Never merge agent outputs without Validator pass.

---

## 6. Upgrade rubric (old → WASM-safe)

| Symptom | Likely cause | Kimi fix |
|---|---|---|
| Black screen after load | Shader compile fail | Simplify warp/comp; check `ps_` version lines |
| Smearing / white flash | `fDecay` too high or RGBA8 FBO | Lower decay; clamp shader output `saturate()` |
| Preprocessor crash | `#ifdef` / empty `#define` | Rewrite to `#if defined()` or remove |
| Slow preset switch | Huge `per_pixel` or 4+ blur samples | Move heavy work to warp shader once per frame |
| Wrong colors | sRGB vs linear mismatch | Match Milkdrop `fGammaAdj` conventions |

---

## 7. CLI commands reference

```bash
# Find presets using risky preprocessor
rg '#ifdef|#ifndef' custom_milk_fixed weeks_presets --glob '*.milk'

# Find presets missing version header
rg -L 'PSVERSION_WARP' weeks_presets --glob '*.milk' | head

# Count per-preset equation lines (complexity proxy)
rg -c '^per_' weeks_presets --glob '*.milk' | sort -t: -k2 -n | tail

# Format check (no trailing CRLF issues)
file custom_milk_fixed/*.milk
```

---

## 8. Integration with browser demo

After Kimi edits a preset:

1. Fast local loop: open `html/projectm-core.html?localPresets=1` and use the **Local Preset Loader** to pick or drag-drop a `.milk` file. The page writes it to `/presets/local_<sanitized_name>.milk`, calls `load_preset_file`, and triggers `startTransitionWhenReady({ module: Module })`.  
2. Or upload to `storage.noahcohn.com` API (production path in `html/projectm-presets.js`)  
3. Load: `Module.ccall('load_preset_file', null, ['string'], ['/presets/<name>.milk'])`  
4. With transitions: `startTransitionWhenReady({ module: Module })` from `projectm-external-pcm.js`  

### Local preset guardrails

- Only `.milk` files are accepted.
- Local uploads are capped at 2MB to avoid WASM heap spikes.
- Failures surface in the page `#stat` element instead of silently failing.
- The last successful local preset filename is remembered in `localStorage`.

---

## 9. Screenshot validation (visual quality gates)

Use `scripts/capture_custom_milk_screenshots.mjs` (headless Chromium +
`tests/wasm-smoke/capture.html`) to catch a **visually broken** capture even
when the harness itself reports `ok: true` — e.g. a black screen, a stuck
startup preset, or a preset upgrade that silently regressed the visuals.

Every `capture_report.json` entry now records, per preset:

- `meanRgb` — average of the canvas's mean R/G/B (0-255). A near-black
  capture (shader failed, dual-FBO blit didn't reach the canvas, preset
  switch failed silently, etc.) will have a very low `meanRgb`.
- `nonBlackFraction` — fraction of pixels with any channel above a small
  noise threshold. Catches "mostly black with a tiny artifact" frames that a
  borderline `meanRgb` might miss.
- `presetDisplayName` — best-effort `presetname=...` parsed from the `.milk`
  source, for human-readable diff reports.

**Dark-frame gate:** if `meanRgb` is below `--dark-threshold` (default `5`),
the capture is marked `ok: false` and the script exits non-zero — unless
`--allow-dark` is passed (for presets that are intentionally near-black).

> **Rebuild the WASM bundle after engine changes.** The capture script renders
> with the **prebuilt** `projectm-v.030-thread.1ijs` + `.wasm` (+
> `.worker.js`) at the repo root, *not* a live build of
> `projectM_emscripten.cpp`. After any engine/renderer change (e.g. a
> `render_frame()` fix), rebuild the smoke wrapper and refresh the bundle
> before trusting captures:
>
> ```bash
> source /path/to/emsdk/emsdk_env.sh   # must be emsdk 3.1.53 — newer SDKs render all-black
> scripts/build_wasm_smoke_wrapper.sh   # -> cmake-build/wasm-smoke/projectm-v.030-thread.{js,wasm,worker.js}
> # then either copy to the repo root (js/wasm/worker.js, plus iconv'd .1ijs/.3ijs),
> # or point the script at the build dir:
> PROJECTM_WASM_JS=cmake-build/wasm-smoke/projectm-v.030-thread.js \
>   node scripts/capture_custom_milk_screenshots.mjs --preset custom_milk_fixed/milk012.milk
> ```
>
> See `docs/EMSCRIPTEN.md` → *Rebuilding the WASM smoke bundle* for the full,
> verified recipe (Emscripten SDK version requirement, `-flto` pitfall, the
> `projectm_opengl_render_frame_fbo()` fix, and the `.worker.js` gotcha) and
> env overrides.

### Workflow: validate a preset upgrade

```bash
# 1. Baseline before the Kimi upgrade
node scripts/capture_custom_milk_screenshots.mjs --out screenshots/custom_milk_baseline

# 2. Run the Kimi upgrade (Phase B above), then re-capture
node scripts/capture_custom_milk_screenshots.mjs --out screenshots/custom_milk_upgraded

# 3. Compare baseline vs upgraded — writes diff_report.json into the
#    second directory (or --out <dir> to choose where)
node scripts/capture_custom_milk_screenshots.mjs --diff screenshots/custom_milk_baseline screenshots/custom_milk_upgraded
```

`diff_report.json` contains, per preset file:

- `meanRgbDelta` — `{ r, g, b, mean }` deltas computed from each side's
  `capture_report.json` (no PNG decoding required).
- `pixelDiffPercent` — percentage of pixels that differ beyond a small
  threshold, computed by decoding both PNGs and running `pixelmatch`. This is
  **best-effort**: if `pixelmatch` isn't available or the PNGs are an
  unsupported format/size mismatch, `pixelDiffPercent` is `null` with a
  `pixelDiffNote`/`pixelDiffError` explaining why — mean-RGB deltas still work.
- `status: "missing_in_a"` / `"missing_in_b"` for presets only captured on
  one side.

A large `meanRgbDelta.mean` or `pixelDiffPercent` for a preset that *wasn't*
intentionally changed is a signal the upgrade regressed that preset's visuals.

### Golden images for manual review

```bash
node scripts/capture_custom_milk_screenshots.mjs --out screenshots/custom_milk_upgraded --update-golden
```

Copies the captured PNGs into `screenshots/golden/<out-dir-name>/` (e.g.
`screenshots/golden/custom_milk_upgraded/milk012.png`) so reviewers can flip
through known-good captures without re-running the harness.

### Current `custom_milk_fixed/` baseline status

`screenshots/custom_milk_baseline/capture_report.json` is a full
`custom_milk_fixed/*.milk` capture (23 presets, 60 frames, `--allow-dark`,
rebuilt `projectm-v.030-thread.1ijs`/`.wasm` at the repo root — emsdk 3.1.53,
no `-flto`, **with the `render_frame_fbo()` dual-FBO fix**, dated 2026-06-14;
see *Rebuilding the WASM smoke bundle* in `docs/EMSCRIPTEN.md`). As of this
capture:

- **9/23 pass** the quality gates (`milk008`–`milk012`, `milk011_optimized`,
  `milk016`, `custom_fractal_echo_gemini`, `fractal_tunnel_grok`).
- `milk012.milk` vs `000-empty.milk`: `meanRgb` 55.3 vs ~38-42 — clearly distinct ✓
- **Regression: `milk009`/`milk010`/`milk011`/`milk011_optimized` got much
  darker** after the dual-FBO fix — `meanRgb` dropped from ~80-92/11.15
  (old, pre-fix baseline) to 1.19/1.23/2.57/7.79. They only pass here because
  this capture used `--allow-dark`; without it they'd fail the default
  dark-frame gate (`meanRgb < 5`). The pre-fix baseline's "passing" values for
  these four were themselves an artifact of the broken render path (the
  canvas showed the *previous* frame's leftover content rather than these
  presets' actual output), so the new low values may be closer to these
  presets' true output — but they need visual review (e.g.
  `--update-golden`) to confirm they're not a *new* regression introduced by
  `render_frame_fbo()`. **Follow-up:** open `milk009`-`milk011`/
  `milk011_optimized` in a real browser via `projectm-core.html` and compare
  against the `screenshots/golden/` captures from before the fix.
- **14/23 fail with `presetSwitchFailed`-style errors** (`milk001`-`milk007`,
  `milk013`-`milk015`, `custom_fractal_echo_copilot_gpt54`,
  `custom_fractal_echo_granite`, `fractal_echo_gptoss120b`,
  `fractal_echo_kimi`) — unchanged from the pre-fix baseline (same preset
  set). With the new `is_preset_ready()`/`preset_switch_failed()`-based
  polling in `capture.html`, these now surface as `"Preset switch failed
  while waiting for readiness"` (capture times out) rather than a
  same-canvas/normal-looking frame. For `milk014`/`milk015` the browser
  console shows the real cause: `[PerFrameContext] Could not compile
  per-frame code: syntax error, unexpected VAR(L2 C1)` — a genuine
  `per_frame` syntax bug in those presets, not a render-pipeline issue.
  PresetCompat (transpile-only) passes for several of these, so this remains
  a **runtime-only** failure the screenshot gate catches that transpile
  checks cannot.

**To reach "zero quality-gate failures":**

1. ~~Rebuild the WASM bundle with the `render_frame()` fix~~ — done (see
   `docs/EMSCRIPTEN.md`); the dual-FBO compositor now actually reaches the
   canvas. This did **not** fix the 14 `presetSwitchFailed` cases (they have
   their own per-preset bugs, e.g. the `milk014`/`milk015` per_frame syntax
   error above) but did **not** regress them either.
2. Investigate the `milk009`-`milk011`/`milk011_optimized` darkening
   regression noted above before relying on their `meanRgb` values.
3. Run the Phase B upgrade loop (section 3) for `milk001`-`milk007`,
   `milk013`-`milk015`, and the `*_echo_*`/`fractal_*` files — fix the
   `per_frame`/shader compile errors reported by the browser console
   (captured in `consoleErrors` would require non-allow-dark runs; rerun with
   `--preset` for one file at a time to see the full `[browser:*]` log).
4. Re-run `node scripts/capture_custom_milk_screenshots.mjs --out
   screenshots/custom_milk_baseline` (without `--allow-dark`, once the
   milk009-011 darkening is resolved) and confirm `capture_report.json` has
   zero `ok: false` entries before wiring the full-matrix nightly job's
   results into a release/regression gate.

---

## 10. Deliverables for each Kimi session

1. Changed `.milk` file(s) with header comment: author, date, intent  
2. One-line summary for GitHub issue/PR  
3. Validator output (pass/fail) — paste the tail of `scripts/kimi_validate_preset.sh <file>`  
4. For visual upgrades: `capture_report.json`/`diff_report.json` from section 9
   (mean RGB deltas, `pixelDiffPercent`, and any dark-frame failures)

---

## 11. Related GitHub issues

- Preset compat harness: ford442/Project-M#77 — `scripts/kimi_validate_preset.sh` wraps
  this harness (`PresetCompat.ParseAndTranspile` via `PROJECTM_PRESET_COMPAT_DIR`)  
- HTML module extraction: #78  
- FBO/blur fidelity (affects feedback presets): #83  
- Kimi pipeline automation: (see issue created from this plan)

---

*Last updated: 2026-06-14 — maintain alongside `WRITING_NEW_MILK_PRESETS_GUIDE.md`.*
