# Signature Series — Batch 2 (2026-07)

Second Signature Series drop: four lane-aligned presets expanding the batch-1
workflow with northern-lights orbital, rainy Watershed, firefly Redwood, and
galaxy swarm Candy World variants.

Companion: [`SIGNATURE_SERIES_WORKFLOW.md`](SIGNATURE_SERIES_WORKFLOW.md) ·
briefs: [`grok_agent/signature_series_briefs.md`](../grok_agent/signature_series_briefs.md)

## Release summary

| Preset | Lane | Tier | Transpile | Capture |
|--------|------|------|-----------|---------|
| `orbital_rave_aurora.milk` | Zephyr Orbital | medium | pass | pending CI |
| `cinematic_pedal_steel_rain.milk` | Watershed | light | pass | pending CI |
| `redwood_dreams_firefly.milk` | Redwood | light | pass | pending CI |
| `shader_swarm_galaxy.milk` | Candy World | medium | pass | pending CI |

All four pass `scripts/kimi_validate_preset.sh` and static audit with zero errors.
Screenshot baselines will be captured by the nightly `preset_screenshots` workflow and
the Emscripten CI smoke capture job.

## Creative notes

### orbital_rave_aurora

Slower cousin of `orbital_rave_zephyr.milk`: cyan/teal aurora curtains in the warp
tunnel, `mid_att` shifts palette, subtle treble shimmer in composite.

### cinematic_pedal_steel_rain

Rain-on-window refraction in warp (UV ripple), sparse drop speckles in composite,
warm `mid_att` grade — pairs with Watershed ambient sets.

### redwood_dreams_firefly

Canopy drift from `redwood_dreams_canopy.milk` plus treble-driven firefly sparks
(procedural grid twinkles in composite).

### shader_swarm_galaxy

Spiral-offset swarm in deep blues; `shader_swarm_candy.milk` palette shifted toward
space/galaxy tones with core glow in composite.

## Corpus hygiene (same release)

### Quarantined (4)

Moved to `custom_milk_quarantine/` — redundant `fractal_echo_*` variants that failed
the June 2026 WASM capture baseline. See [`custom_milk_quarantine/README.md`](../custom_milk_quarantine/README.md).

### Hardened (3)

Fixed `[preset00]` / `MILKDROP_PRESET_VERSION` header ordering in `milk013.milk`,
`milk014.milk`, `milk015.milk`.

### Stale capture baseline pruned

`screenshots/custom_milk_baseline/capture_report.json` no longer marks curated presets
as `broken` from the pre–shader-cache engine. Entries without a fresh capture show
`unknown` in the picker until CI re-runs capture.

## Promotion gate

New presets and draft → curated promotions use:

```bash
node scripts/promote_preset.mjs presets/drafts/my_preset.milk --skip-capture-check
node scripts/generate_custom_preset_manifest.mjs
```

## weeks_presets audit

Latest static audit (426 community presets, 0 errors):

- [`docs/PRESET_AUDIT.md`](PRESET_AUDIT.md)
- [`docs/preset_audit_report.json`](preset_audit_report.json)

Heavy tier: 281 / 426 — follow-up upgrades tracked separately; audit is advisory for
this corpus (see `.github/workflows/preset_audit.yml`).

## Screenshots

Pending automated capture. After the next Emscripten CI run or nightly screenshot job,
expect PNGs under `screenshots/custom_milk_baseline/` for each batch-2 file.
