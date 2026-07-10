#!/usr/bin/env bash
# Configure, build, and install libprojectM static libraries for Emscripten.
#
# Produces install/lib/libprojectM-4.a and install/lib/libprojectM-4-playlist.a,
# which scripts/build_wasm_smoke_wrapper.sh links into the browser bundle.
#
# Prerequisites:
#   - Emscripten SDK activated (source /path/to/emsdk/emsdk_env.sh)
#   - git submodules initialized (vendor/projectm-eval)
#
# Usage:
#   source /path/to/emsdk/emsdk_env.sh
#   INSTALL_DIR=install CMAKE_BUILD_DIR=cmake-build-wasm \
#     scripts/build_wasm_install.sh
#
# Then:
#   PROJECTM_WASM_VERSION=034 INSTALL_DIR=install \
#     OUT_DIR=cmake-build/wasm-smoke scripts/prepare_deploy_bundle.sh

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR="${INSTALL_DIR:-"$PROJECT_ROOT/install"}"
CMAKE_BUILD_DIR="${CMAKE_BUILD_DIR:-"$PROJECT_ROOT/cmake-build-wasm"}"
BUILD_TESTING="${BUILD_TESTING:-OFF}"
ENABLE_WASM_TRANSITIONS="${ENABLE_WASM_TRANSITIONS:-ON}"
ENABLE_OPENMP="${ENABLE_OPENMP:-ON}"
GTEST_DIR="${GTEST_DIR:-}"

if ! command -v emcc >/dev/null 2>&1; then
    cat >&2 <<'EOF'
ERROR: emcc not found. Activate the Emscripten SDK first, e.g.:

  source /path/to/emsdk/emsdk_env.sh
  emcc -v

Recommended SDK: 3.1.53 (see docs/EMSCRIPTEN.md).
EOF
    exit 1
fi

projectm_lib="$INSTALL_DIR/lib/libprojectM-4.a"
playlist_lib="$INSTALL_DIR/lib/libprojectM-4-playlist.a"
if [[ -s "$projectm_lib" && -s "$playlist_lib" ]]; then
    echo "WASM static libraries already present:"
    ls -lh "$projectm_lib" "$playlist_lib"
    exit 0
fi

cd "$PROJECT_ROOT"
git submodule update --init --recursive

if [[ "$ENABLE_OPENMP" == "ON" && ! -f "$PROJECT_ROOT/libomp.a" ]]; then
    echo "=== Building libomp.a for Emscripten ===" >&2
    bash "$PROJECT_ROOT/scripts/build_libomp_emscripten.sh"
fi

cmake_args=(
    -G Ninja
    -S "$PROJECT_ROOT"
    -B "$CMAKE_BUILD_DIR"
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR"
    -DBUILD_TESTING="$BUILD_TESTING"
    -DENABLE_OPENMP="$ENABLE_OPENMP"
    -DENABLE_WASM_TRANSITIONS="$ENABLE_WASM_TRANSITIONS"
)

if [[ -n "$GTEST_DIR" ]]; then
    cmake_args+=(-DGTest_DIR="$GTEST_DIR")
fi

echo "=== Configuring Emscripten build (install -> $INSTALL_DIR) ===" >&2
emcmake cmake "${cmake_args[@]}"

echo "=== Building and installing libprojectM ===" >&2
cmake --build "$CMAKE_BUILD_DIR" --parallel
cmake --install "$CMAKE_BUILD_DIR"

for required in "$projectm_lib" "$playlist_lib"; do
    if [[ ! -s "$required" ]]; then
        echo "ERROR: expected $required after install" >&2
        exit 1
    fi
done

echo "Installed WASM static libraries:"
ls -lh "$projectm_lib" "$playlist_lib"
