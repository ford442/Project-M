# Quarantined presets

Presets moved out of `custom_milk_fixed/` because they failed the June 2026 WASM
screenshot baseline (`preset_switch_failed`) and are redundant with working
siblings in the curated corpus.

| File | Reason |
|------|--------|
| `custom_fractal_echo_copilot_gpt54.milk` | Runtime switch failure; superseded by `custom_fractal_echo_gemini.milk` |
| `custom_fractal_echo_granite.milk` | Runtime switch failure; granite look covered by `milk012.milk` |
| `fractal_echo_kimi.milk` | Runtime switch failure; tunnel family covered by `fractal_tunnel_grok.milk` |
| `fractal_echo_gptoss120b.milk` | Runtime switch failure; redundant fractal_echo variant |

All four pass `scripts/kimi_validate_preset.sh` (parse + transpile). Re-promote via
`scripts/promote_preset.mjs` after a successful WASM capture on current engine builds.

## July 2026 — misfiled shader bodies

`scripts/audit_presets.mjs` gained an `hlsl-in-equations` check after its parser was
taught to read backtick-delimited *equation* blocks (previously only shader blocks
were parsed, so whatever sat inside a `per_pixel_1=\`...\`` block was invisible to
every check). It found five curated presets whose visual program was stored under
`per_pixel_*` as HLSL. per_pixel equations are a scalar expression language with no
types and no `ret` output, so those bodies never execute and the presets render
blank or as a bare feedback wash.

Two were repaired in place — `milk009.milk` and `milk010.milk` had no competing
`comp_1`, so their body was moved verbatim into the section their `PSVERSION_COMP=3`
already declared. The three below need an authoring decision rather than a
mechanical move, so they are parked here:

| File | Reason |
|------|--------|
| `milk002_variant.milk` | Whole program is HLSL (`ret = float3(...)`) filed under `per_pixel_*`, and the file has no shader blocks. Documented as the "MilkDrop 1.x per_pixel counterpart" of `milk002.milk`, but HLSL cannot run as 1.x equations — it was never a working 1.x preset. Either rewrite the body as genuine scalar per_pixel equations (restoring the intended 1.x coverage) or drop it as a duplicate of `milk002.milk`. |
| `milk003_variant.milk` | Same defect and same choice, against `milk003.milk`. |
| `milk011_optimized.milk` | The planet/ring/particle scene program is filed under `per_pixel_1` while a *different* bloom/vignette program occupies `comp_1`, so the scene never renders. The working original `milk011.milk` carries that same scene correctly in `comp_1`. Rebuilding means composing the scene with the bloom pass, which is a visual judgement — needs a capture-verified pass, not a textual merge. |

`milk001_variant.milk` was checked and is **not** affected: it carries a real
`warp_1` shader and scalar per_frame equations.
