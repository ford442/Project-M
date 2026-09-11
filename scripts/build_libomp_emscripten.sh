#!/usr/bin/env bash
# Build LLVM libomp.a for Emscripten/WebAssembly.
#
# Prerequisites:
#   - Emscripten SDK activated (source emsdk_env.sh)
#   - LLVM OpenMP sources (default: clone llvm-project/openmp next to emsdk)
#
# Usage:
#   EMSDK_ROOT=~/emsdk LLVM_OPENMP_SRC=~/llvm-openmp \
#     scripts/build_libomp_emscripten.sh
#
# Output:
#   ${PROJECT_ROOT}/libomp.a  (and omp/omp.h is already in the repo)

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
EMSDK_ROOT="${EMSDK_ROOT:-${EMSDK:-${EMSCRIPTEN:-}}}"
LLVM_OPENMP_SRC="${LLVM_OPENMP_SRC:-}"
BUILD_DIR="${BUILD_DIR:-$PROJECT_ROOT/cmake-build-libomp}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

# emcc sits at <emsdk>/upstream/emscripten/emcc, but that layout has changed
# across SDK versions — walk up from wherever it is until emsdk_env.sh appears
# rather than assuming a fixed number of levels.
if [[ -z "$EMSDK_ROOT" ]] && command -v emcc >/dev/null 2>&1; then
    candidate="$(cd "$(dirname "$(command -v emcc)")" && pwd)"
    while [[ "$candidate" != "/" ]]; do
        if [[ -f "$candidate/emsdk_env.sh" ]]; then
            EMSDK_ROOT="$candidate"
            break
        fi
        candidate="$(dirname "$candidate")"
    done
fi

if [[ -z "$EMSDK_ROOT" ]]; then
    for candidate in "${HOME}/emsdk" "/emsdk" "/content/build_space/emsdk"; do
        if [[ -f "$candidate/emsdk_env.sh" ]]; then
            EMSDK_ROOT="$candidate"
            break
        fi
    done
fi

if [[ -z "$EMSDK_ROOT" || ! -f "$EMSDK_ROOT/emsdk_env.sh" ]]; then
    echo "Error: set EMSDK_ROOT to your emsdk directory (contains emsdk_env.sh)" >&2
    exit 1
fi

# shellcheck disable=SC1090
source "$EMSDK_ROOT/emsdk_env.sh"

if [[ -z "$LLVM_OPENMP_SRC" ]]; then
    LLVM_OPENMP_SRC="$PROJECT_ROOT/vendor/llvm-openmp"
fi

if [[ ! -f "$LLVM_OPENMP_SRC/CMakeLists.txt" ]]; then
    echo "=== Cloning LLVM OpenMP runtime ==="
    git clone --depth 1 --branch llvmorg-19.1.0 \
        https://github.com/llvm/llvm-project.git "$PROJECT_ROOT/vendor/llvm-project"
    LLVM_OPENMP_SRC="$PROJECT_ROOT/vendor/llvm-project/openmp"
fi

echo "=== Configuring libomp for wasm32 ==="
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

emcmake cmake -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DOPENMP_STANDALONE_BUILD=ON \
    -DOPENMP_ENABLE_LIBOMPTARGET=OFF \
    -DLIBOMP_HAVE_OMPT_SUPPORT=OFF \
    -DLIBOMP_OMPT_SUPPORT=OFF \
    -DLIBOMP_OMPD_SUPPORT=OFF \
    -DLIBOMP_USE_DEBUGGER=OFF \
    -DLIBOMP_FORTRAN_MODULES=OFF \
    -DLIBOMP_ENABLE_SHARED=OFF \
    -DLIBOMP_ARCH=wasm32 \
    -DOPENMP_ENABLE_LIBOMPTARGET_PROFILING=OFF \
    "$LLVM_OPENMP_SRC"

echo "=== Building libomp ==="
emmake ninja -j"$JOBS"

LIBOMP_BUILT="$BUILD_DIR/runtime/src/libomp.a"
if [[ ! -f "$LIBOMP_BUILT" ]]; then
    echo "Error: expected $LIBOMP_BUILT" >&2
    exit 1
fi

cp -f "$LIBOMP_BUILT" "$PROJECT_ROOT/libomp.a"
echo "=== Installed $PROJECT_ROOT/libomp.a ($(wc -c < "$PROJECT_ROOT/libomp.a") bytes) ==="

if [[ ! -f "$PROJECT_ROOT/omp/omp.h" && -f "$LLVM_OPENMP_SRC/runtime/src/include/omp.h" ]]; then
    mkdir -p "$PROJECT_ROOT/omp"
    cp -f "$LLVM_OPENMP_SRC/runtime/src/include/omp.h" "$PROJECT_ROOT/omp/omp.h"
fi

echo "Done. Reconfigure the Emscripten CMake build to pick up PRJM_ENABLE_OPENMP."
