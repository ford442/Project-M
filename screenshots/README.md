# screenshots/

Preset capture output. The images are not tracked (they were 24 MB of PNGs). Regenerate them
locally, or download the nightly run's artifact:

- `node scripts/capture_custom_milk_screenshots.mjs --out screenshots/custom_milk_baseline`
  writes the PNGs and `capture_report.json` (see that script for `--diff` / `--update-golden`).
- `.github/workflows/nightly_preset_screenshots.yml` uploads `screenshots/nightly/` as a
  workflow artifact every night.

Only the `capture_report.json` files are tracked, because
`scripts/generate_custom_preset_manifest.mjs` and `scripts/promote_preset.mjs` read the
baseline one. The images from before they were untracked are still in git history
(`git log -- 'screenshots/*.png'`).
