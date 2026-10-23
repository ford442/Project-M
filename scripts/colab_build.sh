#!/usr/bin/env bash
set -euo pipefail

# Colab-friendly Project-M WASM build script (aligned with CI / docs/DEPLOYMENT.md).
#
# Usage in Colab:
#   %%bash
#   /content/build_space/projectm/scripts/colab_build.sh
#
# Builds and stages exactly what CI builds: scripts/build_wasm.sh --stage.
#
# Optional env:
#   PROJECT_ROOT, EMSDK_ROOT, REPO_URL, INSTALL_DIR, CMAKE_BUILD_DIR,
#   PROJECTM_WASM_VERSION, ENABLE_OPENMP, BUILD_JOBS, JVM_HEAP_SIZE,
#   PROJECTM_WASM_LTO (1 for an LTO build, i.e. build_wasm.sh --lto)
#
# RUN_OPTIMIZE is gone: it ran wasm-opt (and a WasmEdge AOT pass browsers cannot
# use) over the bundle after it had been staged and precompressed, so the
# deployed .wasm, its .br/.gz and its build-id disagreed. The link already runs
# wasm-opt -O3; see scripts/build_wasm.sh.

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
ENABLE_OPENMP="${ENABLE_OPENMP:-ON}"
if [ "${RUN_OPTIMIZE:-0}" = "1" ]; then
    echo "Error: RUN_OPTIMIZE was removed (it rewrote the staged bundle after its hashes were taken); unset it." >&2
    exit 1
fi

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
    echo "Install emsdk 6.0.6 (the version CI pins) and set EMSDK_ROOT." >&2
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

echo "=== Building and staging ${bundle} (scripts/build_wasm.sh --stage) ==="
build_args=(--stage --version "$PROJECTM_WASM_VERSION")
if [ "${PROJECTM_WASM_LTO:-0}" = "1" ]; then
    build_args+=(--lto)
fi
env -u PROJECTM_WASM_LTO \
    PROJECT_ROOT="$PROJECT_ROOT" \
    INSTALL_DIR="$INSTALL_DIR" \
    CMAKE_BUILD_DIR="$CMAKE_BUILD_DIR" \
    OUT_DIR="$OUT_DIR" \
    ENABLE_OPENMP="$ENABLE_OPENMP" \
    BUILD_TESTING=OFF \
    bash "$PROJECT_ROOT/scripts/build_wasm.sh" "${build_args[@]}"

echo "=== Colab build complete ==="
echo "Bundle: ${bundle}"
artifact_list=(
    "$PROJECT_ROOT/${bundle}.js"
    "$PROJECT_ROOT/${bundle}.wasm"
    "$PROJECT_ROOT/${bundle}.build-id"
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
