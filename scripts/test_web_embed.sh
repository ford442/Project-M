#!/usr/bin/env bash
# Node unit tests for the browser host layer (no browser/WASM required).
#
# Runs EVERY tests/web/*.test.mjs. Do not go back to an explicit file list:
# an enumerated list silently drops new suites, which is how
# preset-picker.test.mjs stayed red against a changed
# fetchCustomPresetManifest() contract without anything noticing.
#
# Three gates, in order, so a failure says which one broke:
#   1. the tests themselves;
#   2. a coverage floor over html/ (never lower it);
#   3. the tests/web/untested-modules.txt ledger, which catches the modules
#      a coverage floor structurally cannot see.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Build the embed SDK BEFORE the suite: tests/web/projectm-web-package.test.mjs
# asserts against packages/web/dist (exports map, the run-time-only render
# worker, import.meta.url depth), so a stale or absent dist would make it pass
# on yesterday's output or fail for the wrong reason.
echo "Building packages/web..."
(cd packages/web && node scripts/build.mjs)
echo ""

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
#   node --experimental-test-coverage --test-coverage-exclude='tests/**' \
#       --test tests/web/*.test.mjs
# and read the "all files" row of the printed report to see the current
# numbers before raising these.
#
# --test-coverage-exclude='tests/**' is load-bearing, not cosmetic. Without
# it, node <= 22 counts the test files themselves — which are ~100% covered
# by definition, since running them is what covers them — into the "all
# files" row, inflating it by roughly ten points, while node >= 23 leaves
# them out. That made the same unchanged tree read as 74.97% in CI and
# 64.91% locally, so the floor measured the node version as much as the code.
# Excluding them explicitly makes the number mean "coverage of html/" on
# every version. packages/** is excluded for the same reason: the package test
# imports the minified bundle, and letting a 44 kB generated artifact into the
# "all files" row would make the floor measure the bundler.
COVERAGE_LINES_MIN=71.5
COVERAGE_BRANCHES_MIN=79.5
COVERAGE_FUNCTIONS_MIN=64.5

# Modules the run is expected NOT to load; see the file's header.
UNTESTED_LEDGER="tests/web/untested-modules.txt"

LCOV_FILE="$(mktemp -t projectm-host-coverage.XXXXXX.lcov)"
trap 'rm -f "$LCOV_FILE"' EXIT

echo "Running ${#tests[@]} host-layer test file(s)..."
test_status=0
node --experimental-test-coverage \
    --test-coverage-exclude='tests/**' \
    --test-coverage-exclude='packages/**' \
    --test-coverage-lines="$COVERAGE_LINES_MIN" \
    --test-coverage-branches="$COVERAGE_BRANCHES_MIN" \
    --test-coverage-functions="$COVERAGE_FUNCTIONS_MIN" \
    --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter=lcov --test-reporter-destination="$LCOV_FILE" \
    --test "${tests[@]}" || test_status=$?

# ---------------------------------------------------------------------------
# Untested-module ledger.
#
# The coverage floor above can only score files the suite imported, so a
# module with no tests at all does not appear in the report and cannot drag
# the number down. Deleting every test for a module would likewise *raise*
# coverage. Compare the loaded set against the checked-in ledger so both
# directions are visible.
# ---------------------------------------------------------------------------
loaded_modules="$(sed -n 's|^SF:||p' "$LCOV_FILE" | sed "s|^$PROJECT_ROOT/||" | grep '^html/' | sort -u || true)"
all_modules="$(find html -name '*.js' \
    -not -path 'html/flac-decode/*' \
    -not -path 'html/node_modules/*' \
    -not -name 'bundle.*.js' | sort)"
untested_modules="$(comm -23 <(echo "$all_modules") <(echo "$loaded_modules"))"
expected_untested="$(grep -v '^[[:space:]]*#' "$UNTESTED_LEDGER" | grep -v '^[[:space:]]*$' | sort -u)"

ledger_status=0
newly_untested="$(comm -23 <(echo "$untested_modules") <(echo "$expected_untested"))"
newly_tested="$(comm -13 <(echo "$untested_modules") <(echo "$expected_untested"))"

if [[ -n "$newly_untested" ]]; then
    echo "" >&2
    echo "No test loads these html/ modules, and they are not in $UNTESTED_LEDGER:" >&2
    echo "$newly_untested" | sed 's/^/  /' >&2
    echo "Add a test under tests/web/, or add the module to the ledger with a reason." >&2
    ledger_status=1
fi

if [[ -n "$newly_tested" ]]; then
    echo "" >&2
    echo "These modules are now covered by tests but still listed in $UNTESTED_LEDGER:" >&2
    echo "$newly_tested" | sed 's/^/  /' >&2
    echo "Delete their lines — the ledger only shrinks." >&2
    ledger_status=1
fi

if [[ "$test_status" -ne 0 ]]; then
    echo "" >&2
    echo "Host-layer tests or the coverage floor failed (see above)." >&2
    exit "$test_status"
fi
if [[ "$ledger_status" -ne 0 ]]; then
    exit "$ledger_status"
fi

echo "Host-layer suite clean: coverage floor met, $UNTESTED_LEDGER up to date."

# Public WASM API surface vs. the blessed baseline (see the script's header).
scripts/check_wasm_public_api.sh
