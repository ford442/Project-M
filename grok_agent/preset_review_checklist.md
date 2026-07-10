# Preset review checklist (Signature Series)

Use when reviewing AI-generated `.milk` presets before merge.

## Format & parse

- [ ] `MILKDROP_PRESET_VERSION` and `[preset00]` present
- [ ] `PSVERSION` / `PSVERSION_WARP` / `PSVERSION_COMP` = 3 (or documented exception)
- [ ] Metadata header: Signature Series line, tags, author, project, music
- [ ] `scripts/kimi_validate_preset.sh <file>` exits 0
- [ ] `node scripts/audit_presets.mjs <file>` — zero `error` findings

## Performance (60fps WASM)

- [ ] Audit tier is `light` or `medium`; if `heavy`, custom `warp_` shader exists
- [ ] `per_pixel` is minimal (constants only) OR justified in metadata
- [ ] Warp/comp `tex2D` sample count reasonable (< 8 per fragment pass)
- [ ] No enormous shader bodies (> 80 lines) without benchmark justification

## Visual quality

- [ ] Clear focal motion (orbit, drift, or swarm) — not static noise
- [ ] Color palette matches brief / project lane
- [ ] No full-screen flat color or near-black idle state
- [ ] Audio reactivity visible within 10s of test audio

## Audio reactivity

- [ ] `bass_att` / `mid_att` / `treb_att` used intentionally (not all three identically)
- [ ] `q` bridge variables connect `per_frame` → shaders
- [ ] No hard-coded `time` only when audio-driven motion was requested

## Robustness

- [ ] No NaN sources (`sqrt(negative)`, `log(0)`)
- [ ] `decay` in sane range (0.85–0.99 typical)
- [ ] Preset loads in B3HD without `preset_switch_failed`

## Repo integration

- [ ] File lives in `custom_milk_fixed/` with correct `family_*` prefix
- [ ] Added to `presets/agent_manifest.json` → `signature_series.presets`
- [ ] `node scripts/generate_custom_preset_manifest.mjs` run (if using picker)
- [ ] Optional: screenshot in `screenshots/custom_milk_baseline/`

**Reviewer:** _______________  
**Date:** _______________  
**Preset:** _______________
