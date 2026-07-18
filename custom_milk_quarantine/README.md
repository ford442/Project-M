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
