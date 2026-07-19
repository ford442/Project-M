#!/usr/bin/env bash
set -euo pipefail

# Colab-friendly Project-M WASM build script (aligned with CI / docs/DEPLOYMENT.md).
#
# Usage in Colab:
#   %%bash
#   /content/build_space/projectm/scripts/colab_build.sh
#
# Optional env:
#   PROJECT_ROOT, EMSDK_ROOT, REPO_URL, INSTALL_DIR, CMAKE_BUILD_DIR,
#   PROJECTM_WASM_VERSION, ENABLE_WASM_TRANSITIONS, ENABLE_OPENMP,
#   BUILD_JOBS, JVM_HEAP_SIZE, RUN_OPTIMIZE (1 to run optimize.sh)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT_ROOT="${PROJECT_ROOT:-/content/build_space/projectm}"
EMSDK_ROOT="${EMSDK_ROOT:-/content/build_space/emsdk}"
EMSDK_ENV="${EMSDK_ROOT}/emsdk_env.sh"
REPO_URL="${REPO_URL:-https://github.com/ford442/Project-M.git}"
INSTALL_DIR="${INSTALL_DIR:-${PROJECT_ROOT}/install}"
CMAKE_BUILD_DIR="${CMAKE_BUILD_DIR:-${PROJECT_ROOT}/cmake-build-wasm}"
OUT_DIR="${OUT_DIR:-${PROJECT_ROOT}/cmake-build/wasm-smoke}"
BUILD_JOBS="${BUILD_JOBS:-8}"
JVM_HEAP_SIZE="${JVM_HEAP_SIZE:-8g}"
ENABLE_WASM_TRANSITIONS="${ENABLE_WASM_TRANSITIONS:-ON}"
ENABLE_OPENMP="${ENABLE_OPENMP:-ON}"
RUN_OPTIMIZE="${RUN_OPTIMIZE:-0}"

# Match .github/workflows/build_emscripten.yml package set.
PACKAGES=(
    build-essential
    cmake
    git
    libgl1-mesa-dev
    libglm-dev
    libsdl2-dev
    mesa-common-dev
    ninja-build
)

read_projectm_wasm_version() {
    local version_js="$1"
    sed -n "s/^export const PROJECTM_WASM_VERSION = '\([0-9][0-9][0-9]\)';/\1/p" \
        "$version_js" | head -n1
}

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
    git clone --recursive "$REPO_URL" "$PROJECT_ROOT"
else
    echo "=== Updating Project-M repository ==="
    git pull --recurse-submodules
    git submodule update --init --recursive
fi

if [ ! -f "$EMSDK_ENV" ]; then
    echo "Error: Emscripten env script not found at $EMSDK_ENV" >&2
    echo "Install emsdk 3.1.53 (recommended) and set EMSDK_ROOT." >&2
    exit 1
fi

export JVM_HEAP_SIZE="$JVM_HEAP_SIZE"
export CMAKE_BUILD_PARALLEL_LEVEL="$BUILD_JOBS"
# shellcheck disable=SC1090
source "$EMSDK_ENV"
export EMSDK_ROOT="${EMSDK_ROOT:-${EMSDK:-}}"

if ! command -v emcc >/dev/null 2>&1; then
    echo "Error: emcc not on PATH after sourcing $EMSDK_ENV" >&2
    exit 1
fi

echo "=== Emscripten toolchain ==="
emcc -v | head -n1

version_js="$PROJECT_ROOT/html/projectm-wasm-version.js"
if [ -z "${PROJECTM_WASM_VERSION:-}" ]; then
    PROJECTM_WASM_VERSION="$(read_projectm_wasm_version "$version_js")"
fi
if [ -z "$PROJECTM_WASM_VERSION" ]; then
    echo "Error: could not read PROJECTM_WASM_VERSION from $version_js" >&2
    exit 1
fi
bundle="projectm-v.${PROJECTM_WASM_VERSION}-thread"

echo "=== Building libprojectM static libraries (install -> $INSTALL_DIR) ==="
PROJECT_ROOT="$PROJECT_ROOT" \
    INSTALL_DIR="$INSTALL_DIR" \
    CMAKE_BUILD_DIR="$CMAKE_BUILD_DIR" \
    ENABLE_WASM_TRANSITIONS="$ENABLE_WASM_TRANSITIONS" \
    ENABLE_OPENMP="$ENABLE_OPENMP" \
    BUILD_TESTING=OFF \
    bash "$PROJECT_ROOT/scripts/build_wasm_install.sh"

echo "=== Building final WASM/JS wrapper ==="
PROJECT_ROOT="$PROJECT_ROOT" \
    INSTALL_DIR="$INSTALL_DIR" \
    CMAKE_BUILD_DIR="$CMAKE_BUILD_DIR" \
    OUT_DIR="$OUT_DIR" \
    ENABLE_WASM_TRANSITIONS="$ENABLE_WASM_TRANSITIONS" \
    bash "$PROJECT_ROOT/scripts/build_wasm_smoke_wrapper.sh"

echo "=== Staging deploy artifacts (${bundle}) ==="
PROJECT_ROOT="$PROJECT_ROOT" \
    INSTALL_DIR="$INSTALL_DIR" \
    OUT_DIR="$OUT_DIR" \
    PROJECTM_WASM_VERSION="$PROJECTM_WASM_VERSION" \
    bash "$PROJECT_ROOT/scripts/prepare_deploy_bundle.sh"

if [ "$RUN_OPTIMIZE" = "1" ]; then
    echo "=== Running optimize.sh (optional wasm-opt) ==="
    bash "$PROJECT_ROOT/optimize.sh" \
        "$PROJECT_ROOT/${bundle}.wasm" || echo "Warning: optimize.sh returned non-zero"
    # Re-run iconv if optimize.sh rewrote the JS glue.
    if [ -s "$PROJECT_ROOT/${bundle}.js" ]; then
        iconv -f UTF-8 -t UTF-16 "$PROJECT_ROOT/${bundle}.js" -o "$PROJECT_ROOT/${bundle}.1ijs"
        iconv -f UTF-8 -t UTF-32 "$PROJECT_ROOT/${bundle}.js" -o "$PROJECT_ROOT/${bundle}.3ijs"
        cp -f "$PROJECT_ROOT/${bundle}.wasm" "$PROJECT_ROOT/pm/"
        cp -f "$PROJECT_ROOT/${bundle}.1ijs" "$PROJECT_ROOT/pm/"
        cp -f "$PROJECT_ROOT/${bundle}.3ijs" "$PROJECT_ROOT/pm/"
        if [ -s "$PROJECT_ROOT/${bundle}.worker.js" ]; then
            cp -f "$PROJECT_ROOT/${bundle}.worker.js" "$PROJECT_ROOT/pm/"
        fi
    fi
fi

echo "=== Colab build complete ==="
echo "Bundle: ${bundle}"
artifact_list=(
    "$PROJECT_ROOT/${bundle}.wasm"
    "$PROJECT_ROOT/${bundle}.1ijs"
    "$PROJECT_ROOT/${bundle}.3ijs"
)
if [ -s "$PROJECT_ROOT/${bundle}.worker.js" ]; then
    artifact_list+=("$PROJECT_ROOT/${bundle}.worker.js")
fi
ls -lh "${artifact_list[@]}"
echo "pm/ mirror:"
ls -lh "$PROJECT_ROOT/pm/${bundle}."* 2>/dev/null || true
echo
echo "Deploy with:"
echo "  export DEPLOY_TOKEN=... && python3 $PROJECT_ROOT/deploy.py"
echo "or:"
echo "  PROJECT_ROOT=$PROJECT_ROOT bash $PROJECT_ROOT/scripts/colab_deploy.sh"
