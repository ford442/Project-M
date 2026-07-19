#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR="${INSTALL_DIR:-"$PROJECT_ROOT/install"}"
OUT_DIR="${OUT_DIR:-"$PROJECT_ROOT/cmake-build/wasm-smoke"}"
CMAKE_BUILD_DIR="${CMAKE_BUILD_DIR:-}"

# shellcheck source=wasm_link_common.inc.sh
source "$PROJECT_ROOT/scripts/wasm_link_common.inc.sh"

projectm_resolve_cmake_build_dir() {
    local candidate static_shaders_header
    if [[ -n "$CMAKE_BUILD_DIR" ]]; then
        static_shaders_header="$CMAKE_BUILD_DIR/src/libprojectM/MilkdropPreset/MilkdropStaticShaders.hpp"
        if [[ -f "$static_shaders_header" ]]; then
            echo "$CMAKE_BUILD_DIR"
            return 0
        fi
        echo "ERROR: CMAKE_BUILD_DIR=$CMAKE_BUILD_DIR but generated header not found:" >&2
        echo "  $static_shaders_header" >&2
        echo "Run INSTALL_DIR=$INSTALL_DIR CMAKE_BUILD_DIR=$CMAKE_BUILD_DIR scripts/build_wasm_install.sh first." >&2
        return 1
    fi

    for candidate in \
        "$PROJECT_ROOT/cmake-build-wasm" \
        "$PROJECT_ROOT/cmake-build" \
        "$PROJECT_ROOT/build"; do
        static_shaders_header="$candidate/src/libprojectM/MilkdropPreset/MilkdropStaticShaders.hpp"
        if [[ -f "$static_shaders_header" ]]; then
            echo "$candidate"
            return 0
        fi
    done

    echo "ERROR: could not find generated MilkdropStaticShaders.hpp under a CMake build dir." >&2
    echo "Set CMAKE_BUILD_DIR to the Emscripten build directory (e.g. cmake-build-wasm)." >&2
    echo "Run scripts/build_wasm_install.sh first." >&2
    return 1
}

CMAKE_BUILD_DIR="$(projectm_resolve_cmake_build_dir)"
LIBPROJECTM_GENERATED_INCLUDE="$CMAKE_BUILD_DIR/src/libprojectM"
LIBPROJECTM_SOURCE_INCLUDE="$PROJECT_ROOT/src/libprojectM"

mkdir -p "$OUT_DIR"

projectm_lib="$INSTALL_DIR/lib/libprojectM-4.a"
playlist_lib="$INSTALL_DIR/lib/libprojectM-4-playlist.a"

if [[ ! -f "$projectm_lib" ]]; then
    echo "Missing projectM static library: $projectm_lib" >&2
    exit 1
fi

if [[ ! -f "$playlist_lib" ]]; then
    echo "Missing projectM playlist static library: $playlist_lib" >&2
    exit 1
fi

libomp_path="$(projectm_wasm_libomp_args "$PROJECT_ROOT")"
libomp_args=()
if [[ -n "$libomp_path" ]]; then
    libomp_args+=("$libomp_path")
else
    echo "Warning: libomp.a not found; OpenMP runtime will not be linked" >&2
fi

common_args=()
projectm_wasm_common_link_args common_args

simd_compile_args=()
projectm_wasm_simd_compile_args simd_compile_args

# Note: no -flto here by default. projectM_emscripten.cpp is the only LTO/bitcode TU
# in this link; libprojectM-4.a is built without LTO. Set PROJECTM_WASM_LTO=1 to try
# link-time-only LTO (see docs/PERFORMANCE.md).
emcc "$PROJECT_ROOT/projectM_emscripten.cpp" \
    -I "$INSTALL_DIR/include" \
    -I "$PROJECT_ROOT" \
    -I "$PROJECT_ROOT/cmake/generated" \
    -I "$PROJECT_ROOT/omp" \
    -I "$LIBPROJECTM_SOURCE_INCLUDE" \
    -I "$LIBPROJECTM_GENERATED_INCLUDE" \
    "${simd_compile_args[@]}" \
    "${common_args[@]}" \
    -s INVOKE_RUN=0 \
    "${libomp_args[@]}" \
    -o "$OUT_DIR/projectm-v.030-thread.js" \
    "$projectm_lib" \
    "$playlist_lib"

test -s "$OUT_DIR/projectm-v.030-thread.js"
test -s "$OUT_DIR/projectm-v.030-thread.wasm"
