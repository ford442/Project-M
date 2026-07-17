#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR="${INSTALL_DIR:-"$PROJECT_ROOT/install"}"
OUT_DIR="${OUT_DIR:-"$PROJECT_ROOT/cmake-build/wasm-smoke"}"

# shellcheck source=wasm_link_common.inc.sh
source "$PROJECT_ROOT/scripts/wasm_link_common.inc.sh"

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
    "${simd_compile_args[@]}" \
    "${common_args[@]}" \
    -s INVOKE_RUN=0 \
    "${libomp_args[@]}" \
    -o "$OUT_DIR/projectm-v.030-thread.js" \
    "$projectm_lib" \
    "$playlist_lib"

test -s "$OUT_DIR/projectm-v.030-thread.js"
test -s "$OUT_DIR/projectm-v.030-thread.wasm"
