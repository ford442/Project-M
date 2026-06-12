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

### Phase A — Create new preset

```bash
# 1. Start from brief (human or Designer agent output)
kimi "Read docs/milk011_creative_brief.md and docs/WRITING_NEW_MILK_PRESETS_GUIDE.md.
     Create custom_milk_fixed/<name>.milk implementing the brief.
     Use MILKDROP_PRESET_VERSION=200, PSVERSION_WARP=3, PSVERSION_COMP=3.
     Limit q1-q12 bridges; document audio mapping in preset comments."

# 2. Validate parse + transpile (after #77 harness lands)
scripts/test_presets.sh custom_milk_fixed/<name>.milk
# or: ctest -R PresetCompat --preset path/to/file.milk

# 3. Browser smoke (WASM)
# Serve html/projectm-core.html + load via FS or API
```

### Phase B — Upgrade existing preset

```bash
kimi "Upgrade weeks_presets/<subdir>/<file>.milk for projectM WASM compatibility:
     - Replace unsupported HLSL (texture arrays, dynamic loops) with GLES3-safe patterns
     - Fix preprocessor: use #define/#if/#else/#endif only (no #ifdef unless parser supports it)
     - Clamp decay/zoom to stable ranges; add fDecay>=0.9 if feedback blows out
     - Preserve visual intent; output a short CHANGELOG comment at top of file
     Read docs/WRITING_NEW_MILK_PRESETS_GUIDE.md section 9 (pitfalls)."
```

### Phase C — Shader-error fix loop

When a preset fails at runtime:

1. Capture error from browser `#stat`, console, or parser test output  
2. Kimi reads only the failing section (`warp_`, `comp_`, `per_pixel_`, `per_frame_`)  
3. Apply minimal diff; re-run `scripts/test_presets.sh`  
4. Repeat until pass  

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

1. Copy to VFS path: `/presets/<name>.milk` via `Module.FS.writeFile`  
2. Or upload to `storage.noahcohn.com` API (production path in `html/projectm-presets.js`)  
3. Load: `Module.ccall('load_preset_file', null, ['string'], ['/presets/<name>.milk'])`  
4. With transitions: `startTransitionWhenReady({ module: Module })` from `projectm-external-pcm.js`  

---

## 9. Deliverables for each Kimi session

1. Changed `.milk` file(s) with header comment: author, date, intent  
2. One-line summary for GitHub issue/PR  
3. Validator output (pass/fail)  
4. Optional: before/after screenshot note for visual upgrades  

---

## 10. Related GitHub issues

- Preset compat harness: ford442/Project-M#77  
- HTML module extraction: #78  
- FBO/blur fidelity (affects feedback presets): #83  
- Kimi pipeline automation: (see issue created from this plan)

---

*Last updated: 2026-06-12 — maintain alongside `WRITING_NEW_MILK_PRESETS_GUIDE.md`.*