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
# Why this does not use compile_commands.json: src/wasm/*.cpp is compiled by
# scripts/build_wasm_smoke_wrapper.sh, not by CMake, so the Emscripten
# build's compile_commands.json has no entry for any of these files.
# clang-tidy then silently borrowed the flags of a neighbouring libprojectM
# TU (em++ with no --target), and every file failed with
# "unknown target CPU 'wasm32'" before a single check ran. Instead the
# compile flags are spelled out below, mirroring the wrapper's include list
# plus the wasm32 target and emsdk sysroot that em++ would add.
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
#     (src/libprojectM/MilkdropPreset/MilkdropStaticShaders.hpp etc.)
#   - an install prefix with include/projectM-4/ (INSTALL_DIR)
#
# Usage:
#   scripts/check_cpp_tidy.sh [cmake build dir]
#   (defaults to $PROJECT_ROOT/cmake-build, matching build_emscripten.yml)
#
# Environment:
#   INSTALL_DIR        install prefix (default: $PROJECT_ROOT/install)
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
INSTALL_DIR="${INSTALL_DIR:-$PROJECT_ROOT/install}"
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
if [[ ! -d "$INSTALL_DIR/include/projectM-4" ]]; then
    missing_prerequisite "no installed projectM-4 headers under $INSTALL_DIR/include (set INSTALL_DIR)."
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

# Keep in sync with projectm_wasm_wrapper_include_args in
# scripts/build_wasm_smoke_wrapper.sh.
COMPILE_ARGS=(
    -x c++
    -std=c++20
    --target=wasm32-unknown-emscripten
    "--sysroot=$SYSROOT"
    -isystem "$SYSROOT/include/compat"
    -isystem "$SYSROOT/include/c++/v1"
    -D__EMSCRIPTEN__
    -pthread
    -fopenmp
    -msimd128
    -I "$INSTALL_DIR/include"
    -I "$PROJECT_ROOT"
    -I "$PROJECT_ROOT/cmake/generated"
    -I "$PROJECT_ROOT/omp"
    -I "$PROJECT_ROOT/src/libprojectM"
    -I "$BUILD_DIR/src/libprojectM"
    -I "$PROJECT_ROOT/vendor/hlslparser/src"
    -I "$PROJECT_ROOT/vendor/glad/include"
    -I "$PROJECT_ROOT/vendor"
    -DUSE_GLES
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
        --warnings-as-errors='*' "$f" -- "${COMPILE_ARGS[@]}"; then
        failed=1
    fi
done

if [[ "$failed" -ne 0 ]]; then
    echo "" >&2
    echo "check_cpp_tidy.sh: clang-tidy found issues in one or more files above." >&2
    exit 1
fi

echo "clang-tidy clean over src/wasm/ for: $CHECKS"
