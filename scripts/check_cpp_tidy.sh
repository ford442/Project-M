#!/usr/bin/env bash
# ================================================
# check_cpp_tidy.sh
#
# clang-tidy over src/wasm/ only, with a check list narrower than the
# repo's .clang-tidy (which enables readability-*, cppcoreguidelines-*,
# bugprone-*, modernize-*, performance-*, misc-* repo-wide but is not run
# anywhere in CI). A repo-wide run on day one buries real findings under a
# huge first diff, same reasoning as scripts/check_cpp_format.sh's
# per-directory PATHS list. Start narrow, widen the check list and the
# directory coverage together as each is cleared.
#
# Needs a compile_commands.json covering the Emscripten TUs
# (CMAKE_EXPORT_COMPILE_COMMANDS=ON on an emcmake-configured build — see
# build_emscripten.yml's "Configure Build" step) because src/wasm/ only
# compiles under ENABLE_EMSCRIPTEN=ON, which requires the emsdk toolchain.
# There is no native fallback: this script can only run where emcc is on
# PATH and the project has been configured/built with it.
#
# Usage:
#   scripts/check_cpp_tidy.sh [path/to/compile_commands.json dir]
#   (defaults to $PROJECT_ROOT/cmake-build, matching build_emscripten.yml)
#
# Exit codes:
#   0 - clang-tidy is unavailable, or compile_commands.json is missing
#       (nothing to check — see the note above on why this can't run
#       everywhere), or every checked file is clean
#   1 - clang-tidy found a diagnostic in the narrow check list
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

BUILD_DIR="${1:-$PROJECT_ROOT/cmake-build}"
COMPILE_COMMANDS="$BUILD_DIR/compile_commands.json"

CLANG_TIDY="${CLANG_TIDY:-}"
if [[ -z "$CLANG_TIDY" ]]; then
    for candidate in clang-tidy-18 clang-tidy-17 clang-tidy-16 clang-tidy; do
        if command -v "$candidate" >/dev/null 2>&1; then
            CLANG_TIDY="$candidate"
            break
        fi
    done
fi
if [[ -z "$CLANG_TIDY" ]]; then
    echo "check_cpp_tidy.sh: no clang-tidy binary found on PATH, skipping." >&2
    exit 0
fi

if [[ ! -f "$COMPILE_COMMANDS" ]]; then
    echo "check_cpp_tidy.sh: no compile_commands.json at $COMPILE_COMMANDS, skipping." >&2
    echo "  Configure an Emscripten build with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON first" >&2
    echo "  (see the 'Configure Build' step in .github/workflows/build_emscripten.yml)." >&2
    exit 0
fi

# Narrow, hand-picked check list — deliberately not the full .clang-tidy
# groups. -checks= on the command line resets the effective list (the
# leading -* disables everything .clang-tidy would otherwise enable) before
# re-enabling just these.
CHECKS='-*,bugprone-*,performance-*,modernize-use-nullptr,readability-braces-around-statements'

shopt -s nullglob
files=(src/wasm/*.cpp)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
    echo "check_cpp_tidy.sh: no .cpp files found under src/wasm/" >&2
    exit 1
fi

echo "Running $CLANG_TIDY over ${#files[@]} file(s) in src/wasm/ (checks: $CHECKS)..."

failed=0
for f in "${files[@]}"; do
    if ! "$CLANG_TIDY" -p "$BUILD_DIR" --checks="$CHECKS" --warnings-as-errors="$CHECKS" "$f"; then
        failed=1
    fi
done

if [[ "$failed" -ne 0 ]]; then
    echo "" >&2
    echo "check_cpp_tidy.sh: clang-tidy found issues in one or more files above." >&2
    exit 1
fi

echo "clang-tidy clean over src/wasm/ for: $CHECKS"
