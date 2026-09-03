#!/usr/bin/env bash
# Unit tests for the graphics golden-image / frame-budget harness.
#
# These cover the pure parts — PNG round-tripping, the perceptual diff and its
# tolerance policy, the frame-budget percentiles and the regression gate, and
# the deterministic audio schedule. No browser, no GPU, no WASM bundle: they run
# on any runner in a second, and they are what decides whether a PR goes red, so
# they are gated on every push rather than nightly.
#
# The parts that DO need a browser (tests/wasm-smoke/golden_images.mjs) run in
# .github/workflows/graphics_golden_gate.yml once a WASM bundle is available.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

shopt -s nullglob
tests=(tests/graphics-harness/*.test.mjs)
shopt -u nullglob

if [[ ${#tests[@]} -eq 0 ]]; then
    echo "No tests found under tests/graphics-harness/ — expected at least one *.test.mjs" >&2
    exit 1
fi

echo "Running ${#tests[@]} graphics-harness test file(s)..."
node --test "${tests[@]}"

# The golden manifest is data the gate reads at runtime; a typo'd preset path
# would only surface in CI, on a runner that has a WASM bundle.
node --input-type=module -e '
import { readFileSync, existsSync } from "node:fs";
const manifest = JSON.parse(readFileSync("tests/wasm-smoke/golden/manifest.json", "utf8"));
const missing = manifest.presets.filter((entry) => !existsSync(entry.path));
if (missing.length > 0) {
    console.error("Golden manifest references presets that do not exist:");
    for (const entry of missing) console.error("  " + entry.path);
    process.exit(1);
}
const frames = manifest.captureFrames ?? [];
const settle = manifest.settleFrames ?? 0;
const early = frames.filter((frame) => frame < settle);
if (early.length > 0) {
    console.error(`Capture frames ${early.join(", ")} are below settleFrames (${settle}) and can never be reached.`);
    process.exit(1);
}
console.log(`Golden manifest OK: ${manifest.presets.length} preset(s), frames [${frames.join(", ")}].`);
'
