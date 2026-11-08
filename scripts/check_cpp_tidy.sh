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
# Compile flags come from <build dir>/compile_commands.json: the src/wasm/
# TUs are the projectM_wasm CMake target (src/wasm/CMakeLists.txt), so the
# database has their real em++ command lines. em++ adds the wasm32 target and
# the emsdk sysroot itself, which clang-tidy's driver does not know, so those
# are passed as extra arguments.
#
# clang-tidy version: emsdk's libc++ headers need a recent Clang front end
# (clang-tidy 18 fails on __builtin_clzg / __GCC_DESTRUCTIVE_SIZE and crashes
# in bugprone-implicit-widening-of-multiplication-result). CI pins
# clang-tidy from PyPI (see build_emscripten.yml); locally:
#   python3 -m pip install clang-tidy==22.1.8
#
# Needs:
#   - em++ on PATH (source emsdk_env.sh), for the sysroot
#   - an Emscripten CMake build dir with generated headers
#     (src/libprojectM/MilkdropPreset/MilkdropStaticShaders.hpp etc.) and a
#     compile_commands.json (scripts/build_wasm_install.sh turns it on)
#
# Usage:
#   scripts/check_cpp_tidy.sh [cmake build dir]
#   (defaults to $PROJECT_ROOT/cmake-build, matching build_emscripten.yml)
#
# Environment:
#   CLANG_TIDY         clang-tidy binary to use
#   CPP_TIDY_REQUIRED  set to 1 to fail instead of skipping when a
#                      prerequisite is missing (CI sets this)
#
# Exit codes:
#   0 - every checked file is clean, or a prerequisite is missing and
#       CPP_TIDY_REQUIRED is not 1
#   1 - clang-tidy found a diagnostic, or a prerequisite is missing and
#       CPP_TIDY_REQUIRED=1
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

BUILD_DIR="${1:-$PROJECT_ROOT/cmake-build}"
MIN_CLANG_TIDY_MAJOR=22

missing_prerequisite() {
    echo "check_cpp_tidy.sh: $*" >&2
    if [[ "${CPP_TIDY_REQUIRED:-0}" == "1" ]]; then
        exit 1
    fi
    echo "check_cpp_tidy.sh: skipping (set CPP_TIDY_REQUIRED=1 to make this fatal)." >&2
    exit 0
}

clang_tidy_major() {
    "$1" --version 2>/dev/null | sed -n 's/.*version \([0-9][0-9]*\)\..*/\1/p' | head -n1
}

if [[ -n "${CLANG_TIDY:-}" ]]; then
    major="$(clang_tidy_major "$CLANG_TIDY")"
    if [[ -z "$major" || "$major" -lt "$MIN_CLANG_TIDY_MAJOR" ]]; then
        missing_prerequisite "CLANG_TIDY=$CLANG_TIDY is not clang-tidy >= $MIN_CLANG_TIDY_MAJOR."
    fi
else
    for candidate in clang-tidy clang-tidy-24 clang-tidy-23 clang-tidy-22; do
        if command -v "$candidate" >/dev/null 2>&1; then
            major="$(clang_tidy_major "$candidate")"
            if [[ -n "$major" && "$major" -ge "$MIN_CLANG_TIDY_MAJOR" ]]; then
                CLANG_TIDY="$candidate"
                break
            fi
        fi
    done
    if [[ -z "${CLANG_TIDY:-}" ]]; then
        missing_prerequisite "no clang-tidy >= $MIN_CLANG_TIDY_MAJOR on PATH (python3 -m pip install clang-tidy==22.1.8)."
    fi
fi

if ! command -v em++ >/dev/null 2>&1; then
    missing_prerequisite "em++ not on PATH; source emsdk_env.sh first."
fi
SYSROOT="$(em++ --cflags | tr ' ' '\n' | sed -n 's/^--sysroot=//p' | head -n1)"
if [[ -z "$SYSROOT" || ! -d "$SYSROOT" ]]; then
    missing_prerequisite "could not determine the emsdk sysroot from 'em++ --cflags'."
fi

if [[ ! -f "$BUILD_DIR/src/libprojectM/MilkdropPreset/MilkdropStaticShaders.hpp" ]]; then
    missing_prerequisite "no configured+built Emscripten build dir at $BUILD_DIR (generated headers missing)."
fi
if [[ ! -s "$BUILD_DIR/compile_commands.json" ]] || ! grep -q 'src/wasm/WasmHost.cpp' "$BUILD_DIR/compile_commands.json"; then
    missing_prerequisite "$BUILD_DIR/compile_commands.json has no src/wasm/ entries (configure with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON; scripts/build_wasm_install.sh does)."
fi

# Narrow, hand-picked check list — deliberately not the full .clang-tidy
# groups. -checks= on the command line resets the effective list (the
# leading -* disables everything .clang-tidy would otherwise enable) before
# re-enabling just these. Excluded from the groups:
#   bugprone-easily-swappable-parameters - also off in .clang-tidy; every
#       (width, height) / EMSCRIPTEN_KEEPALIVE int-parameter export trips it.
#   performance-no-int-to-ptr - JS hands engine handles and heap offsets
#       across the boundary as integers; the casts are the contract.
#   performance-enum-size - int-backed enums mirror GL/JS integer values.
CHECKS='-*,bugprone-*,-bugprone-easily-swappable-parameters,performance-*,-performance-no-int-to-ptr,-performance-enum-size,modernize-use-nullptr,readability-braces-around-statements'

# Only report diagnostics in src/wasm/ (clang-tidy 22 defaults the header
# filter to every header, which would drag in vendor/ and the sysroot).
HEADER_FILTER='/src/wasm/'

# What em++ adds on top of the database's command lines.
EXTRA_ARGS=(
    --extra-arg=--target=wasm32-unknown-emscripten
    "--extra-arg=--sysroot=$SYSROOT"
    "--extra-arg=-isystem$SYSROOT/include/compat"
    "--extra-arg=-isystem$SYSROOT/include/c++/v1"
    --extra-arg=-D__EMSCRIPTEN__
)

shopt -s nullglob
files=(src/wasm/*.cpp)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
    echo "check_cpp_tidy.sh: no .cpp files found under src/wasm/" >&2
    exit 1
fi

echo "Running $CLANG_TIDY ($("$CLANG_TIDY" --version | sed -n 's/.*version \([0-9.]*\).*/\1/p' | head -n1)) over ${#files[@]} file(s) in src/wasm/"
echo "  checks: $CHECKS"

failed=0
for f in "${files[@]}"; do
    if ! "$CLANG_TIDY" --quiet --header-filter="$HEADER_FILTER" --checks="$CHECKS" \
        --warnings-as-errors='*' -p "$BUILD_DIR" "${EXTRA_ARGS[@]}" "$f"; then
        failed=1
    fi
done

if [[ "$failed" -ne 0 ]]; then
    echo "" >&2
    echo "check_cpp_tidy.sh: clang-tidy found issues in one or more files above." >&2
    exit 1
fi

echo "clang-tidy clean over src/wasm/ for: $CHECKS"
