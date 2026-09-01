#!/usr/bin/env bash
# Node unit tests for the browser host layer (no browser/WASM required).
#
# Runs EVERY tests/web/*.test.mjs. Do not go back to an explicit file list:
# an enumerated list silently drops new suites, which is how
# preset-picker.test.mjs stayed red against a changed
# fetchCustomPresetManifest() contract without anything noticing.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

shopt -s nullglob
tests=(tests/web/*.test.mjs)
shopt -u nullglob

if [[ ${#tests[@]} -eq 0 ]]; then
    echo "No tests found under tests/web/ — expected at least one *.test.mjs" >&2
    exit 1
fi

echo "Running ${#tests[@]} host-layer test file(s)..."
node --test "${tests[@]}"

(cd packages/web && node scripts/build.mjs)
