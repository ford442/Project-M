#!/bin/bash
set -euo pipefail

# Colab-friendly Project-M build script.
# Usage in Colab:
# %%bash
# /content/build_space/projectm/scripts/colab_build.sh

PROJECT_ROOT="${PROJECT_ROOT:-/content/build_space/projectm}"
EMSDK_ROOT="${EMSDK_ROOT:-/content/build_space/emsdk}"
EMSDK_ENV="${EMSDK_ROOT}/emsdk_env.sh"
JVM_HEAP_SIZE="${JVM_HEAP_SIZE:-8g}"
BUILD_JOBS="${BUILD_JOBS:-8}"

PACKAGES=(bison flex cmake-curses-gui qtbase5-dev llvm-dev libvisual-0.4-dev ninja-build)

if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
else
    echo "Error: need root or sudo to install packages." >&2
    exit 1
fi

install_if_missing() {
    local pkg="$1"
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
        echo "Installing missing package: $pkg"
        $SUDO apt-get install -y "$pkg"
    else
        echo "Package already installed: $pkg"
    fi
}

echo "=== Installing required system packages if missing ==="
if ! command -v dpkg-query >/dev/null 2>&1; then
    echo "Error: dpkg-query not available. Cannot detect installed packages." >&2
    exit 1
fi

MISSING=0
for pkg in "${PACKAGES[@]}"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
        MISSING=1
        break
    fi
done

if [ "$MISSING" -eq 1 ]; then
    $SUDO apt-get update -y
    for pkg in "${PACKAGES[@]}"; do
        install_if_missing "$pkg"
    done
else
    echo "All required packages already installed."
fi

mkdir -p "$PROJECT_ROOT"
cd "$PROJECT_ROOT"

if [ ! -d .git ]; then
    echo "=== Cloning Project-M repository ==="
    git clone --recursive https://github.com/ford442/Project-M.git "$PROJECT_ROOT"
else
    echo "=== Updating Project-M repository ==="
    git pull --recurse-submodules
    git submodule update --init --recursive
fi

if [ ! -f "$EMSDK_ENV" ]; then
    echo "Error: Emscripten env script not found at $EMSDK_ENV" >&2
    exit 1
fi

export JVM_HEAP_SIZE="$JVM_HEAP_SIZE"
source "$EMSDK_ENV"

echo "=== Building projectm-eval ==="
cd "$PROJECT_ROOT/vendor/projectm-eval"
rm -rf build
mkdir -p build
cd build
cmake ..
make install -j"$BUILD_JOBS"

echo "=== Building main Project-M with emcmake ==="
cd "$PROJECT_ROOT"
rm -rf build
mkdir -p build
cd build
source "$EMSDK_ENV"
emcmake cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/usr/local \
    -DSDL_PTHREADS=1 \
    -DUSE_PTHREADS=1 \
    -DBOOST_HAS_THREADS=1 \
    -DBOOST_UBLAS_USE_LONG_DOUBLE=1 \
    -DBOOST_UBLAS_NDEBUG=1 \
    -DENABLE_EMSCRIPTEN=1 \
    -DENABLE_GLES=1 \
    -DBUILD_SHARED_LIBS=0 \
    -DENABLE_CXX_INTERFACE=1 \
    -DENABLE_OPENMP=ON \
    -DCMAKE_MODULE_PATH="/usr/local/lib/cmake/projectM-Eval/"

emmake cmake --build . --target install --config Release -j"$BUILD_JOBS"

echo "=== Building final WASM/JS wrapper ==="
cd "$PROJECT_ROOT"
export JVM_HEAP_SIZE="$JVM_HEAP_SIZE"
source "$EMSDK_ENV"
INSTALL_DIR=/usr/local OUT_DIR="$PROJECT_ROOT" PROJECT_ROOT="$PROJECT_ROOT" \
    bash "$PROJECT_ROOT/scripts/build_wasm_smoke_wrapper.sh"

echo "=== Running optimize.sh and creating UTF-16/UTF-32 versions ==="
bash "$PROJECT_ROOT/optimize.sh" || echo "Warning: optimize.sh returned non-zero"
iconv -f UTF-8 -t UTF-16 "$PROJECT_ROOT/projectm-v.030-thread.js" -o "$PROJECT_ROOT/projectm-v.030-thread.1ijs"
iconv -f UTF-8 -t UTF-32 "$PROJECT_ROOT/projectm-v.030-thread.js" -o "$PROJECT_ROOT/projectm-v.030-thread.3ijs"

echo "=== Colab build complete ==="
echo "Output files: $PROJECT_ROOT/projectm-v.030-thread.js, .1ijs, .3ijs"
