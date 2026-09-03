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

# Coverage floor for the host-layer suite (html/*.js exercised by
# tests/web/*.test.mjs), reported by node's built-in V8-backed coverage.
# These are ratchets, not targets: raise them as coverage improves, never
# lower them to make a PR pass. Set at today's actual numbers minus a small
# margin so incidental float/version drift doesn't flip the gate red on an
# otherwise-unchanged suite.
#
#   node --experimental-test-coverage --test tests/web/*.test.mjs
# and read the "all files" row of the printed report to see the current
# numbers before raising these.
COVERAGE_LINES_MIN=71.7
COVERAGE_BRANCHES_MIN=78.6
COVERAGE_FUNCTIONS_MIN=67.2

echo "Running ${#tests[@]} host-layer test file(s)..."
node --experimental-test-coverage \
    --test-coverage-lines="$COVERAGE_LINES_MIN" \
    --test-coverage-branches="$COVERAGE_BRANCHES_MIN" \
    --test-coverage-functions="$COVERAGE_FUNCTIONS_MIN" \
    --test "${tests[@]}"

(cd packages/web && node scripts/build.mjs)
