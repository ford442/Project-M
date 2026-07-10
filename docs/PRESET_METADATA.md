# Preset metadata format

Presets in the B3HD demo are indexed for search, filtering, quality-weighted random
selection, and the **Featured / Signature** pack. Metadata can live in **header
comments** (preferred), an optional **sidecar JSON**, or be merged from the static
audit report at manifest build time.

## Header comments (in `.milk`)

Place before `MILKDROP_PRESET_VERSION`:

```milk
// Signature Series | orbital_rave | Zephyr Orbital
// tags: rave, orbital, bass-reactive, signature
// tier: medium
// reactivity: high
// author: projectM-signature-batch-2026-07
// version: 1
// project: zephyr-orbital
// featured: true
// music: uptempo electronic
```

| Field | Values | Used for |
|-------|--------|----------|
| `tags` | comma-separated lowercase tokens | Search, filter chips |
| `tier` | `light`, `medium`, `heavy` | Performance filter; overrides audit heuristic when set |
| `reactivity` | `none`, `low`, `medium`, `high` | Audio-reactivity filter |
| `author` | free text | Display, attribution |
| `version` | semver or integer | Cache invalidation |
| `project` | lane id (`zephyr-orbital`, `watershed`, …) | Featured pack grouping |
| `featured` | `true` / `false` | Featured pack membership hint |
| `music` | free text | Description / search |

The first non-metadata `//` line (or `Signature Series | …` line) becomes the picker
**label** when it reads like a title.

## Sidecar JSON (optional)

`custom_milk_fixed/my_preset.milk.meta.json`:

```json
{
  "tags": ["nebula", "signature"],
  "tier": "medium",
  "reactivity": "high",
  "author": "human",
  "version": 2,
  "project": "zephyr-orbital",
  "featured": true,
  "weight": 10,
  "label": "Nebula Core"
}
```

Sidecar fields override header comments. `weight` (1–20) tunes quality-weighted random
selection in the demo.

## Generated catalog fields

`scripts/generate_custom_preset_manifest.mjs` and `scripts/build_featured_pack.mjs`
emit entries like:

```json
{
  "file": "milk011.milk",
  "label": "Nebula Core WASM upgrade v2",
  "status": "ok",
  "meanRgb": 2.57,
  "tags": ["signature", "nebula"],
  "tier": "medium",
  "reactivity": "high",
  "author": "kimi",
  "version": 1,
  "project": null,
  "featured": true,
  "weight": 12
}
```

- **`status`**: `ok` | `broken` | `unknown` — from screenshot capture baseline
- **`tier` / `reactivity`**: header → sidecar → `docs/preset_audit_report.json` → heuristic
- **`weight`**: computed for weighted random (higher = more likely on “Random ✓”)

## Demo consumption

| File | Role |
|------|------|
| `html/custom_presets_manifest.json` | Full `custom_milk_fixed/` catalog |
| `html/featured_pack_manifest.json` | Curated 30–50 showcase presets (custom + optional weeks) |
| `html/projectm-preset-library.js` | Filter, favorites, weighted pick, cache |
| `html/projectm-preset-picker.js` | Browser UI |

Enable enhanced picker: `?presetLibrary=1` (default ON when manifest includes `schemaVersion` ≥ 2).

Favorites persist in `localStorage` (`projectm:presetFavorites`). Featured pack bytes
cache in IndexedDB (`projectm-preset-cache`).

## Maintenance

```bash
# Regenerate catalogs after adding/editing presets
node scripts/generate_custom_preset_manifest.mjs
node scripts/build_featured_pack.mjs

# Optional: refresh audit tiers first
node scripts/audit_presets.mjs custom_milk_fixed --json docs/preset_audit_report.json
```
