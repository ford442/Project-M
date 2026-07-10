#!/usr/bin/env bash
# Prepare WASM + iconv artifacts at the repo root (and pm/ mirror) before deploy.py.
#
# Usage:
#   # First-time / after C++ changes: build and install Emscripten static libs
#   source /path/to/emsdk/emsdk_env.sh
#   INSTALL_DIR=install scripts/build_wasm_install.sh
#
#   # Then stage deploy artifacts
#   PROJECTM_WASM_VERSION=034 \
#     INSTALL_DIR=install OUT_DIR=cmake-build/wasm-smoke \
#     scripts/prepare_deploy_bundle.sh
#
# Then:
#   export DEPLOY_TOKEN=...
#   python deploy.py
#   scripts/verify_deploy_urls.sh https://projectm.1ink.us/

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR="${INSTALL_DIR:-"$PROJECT_ROOT/install"}"
OUT_DIR="${OUT_DIR:-"$PROJECT_ROOT/cmake-build/wasm-smoke"}"
PROJECTM_WASM_VERSION="${PROJECTM_WASM_VERSION:-034}"

projectm_lib="$INSTALL_DIR/lib/libprojectM-4.a"
playlist_lib="$INSTALL_DIR/lib/libprojectM-4-playlist.a"

if [[ ! -s "$projectm_lib" || ! -s "$playlist_lib" ]]; then
    echo "Missing Emscripten static libraries under $INSTALL_DIR/lib/" >&2
    echo "Run the WASM install step first (requires emcc):" >&2
    echo "  source /path/to/emsdk/emsdk_env.sh" >&2
    echo "  INSTALL_DIR=$INSTALL_DIR scripts/build_wasm_install.sh" >&2
    echo >&2
    echo "Or, if you already built elsewhere, point INSTALL_DIR at that prefix." >&2
    if [[ "${PROJECTM_AUTO_BUILD_WASM:-0}" == "1" ]]; then
        INSTALL_DIR="$INSTALL_DIR" bash "$PROJECT_ROOT/scripts/build_wasm_install.sh"
    else
        exit 1
    fi
fi

bundle="projectm-v.${PROJECTM_WASM_VERSION}-thread"
src_js="$OUT_DIR/${bundle}.js"
src_wasm="$OUT_DIR/${bundle}.wasm"
src_worker="$OUT_DIR/${bundle}.worker.js"

if [[ ! -s "$src_js" || ! -s "$src_wasm" ]]; then
    echo "Missing smoke build outputs in $OUT_DIR — running build_wasm_smoke_wrapper.sh" >&2
    INSTALL_DIR="$INSTALL_DIR" OUT_DIR="$OUT_DIR" \
        bash "$PROJECT_ROOT/scripts/build_wasm_smoke_wrapper.sh"
    # build script still emits projectm-v.030-thread.* — rename if version differs.
    if [[ "$bundle" != "projectm-v.030-thread" && -s "$OUT_DIR/projectm-v.030-thread.js" ]]; then
        for ext in js wasm worker.js; do
            if [[ -f "$OUT_DIR/projectm-v.030-thread.$ext" ]]; then
                mv -f "$OUT_DIR/projectm-v.030-thread.$ext" "$OUT_DIR/${bundle}.$ext"
            fi
        done
        src_js="$OUT_DIR/${bundle}.js"
        src_wasm="$OUT_DIR/${bundle}.wasm"
        src_worker="$OUT_DIR/${bundle}.worker.js"
    fi
fi

if [[ ! -s "$src_js" || ! -s "$src_wasm" ]]; then
    echo "ERROR: expected $src_js and $src_wasm after smoke build" >&2
    exit 1
fi

dest_js="$PROJECT_ROOT/${bundle}.js"
dest_wasm="$PROJECT_ROOT/${bundle}.wasm"
dest_worker="$PROJECT_ROOT/${bundle}.worker.js"
dest_1ijs="$PROJECT_ROOT/${bundle}.1ijs"
dest_3ijs="$PROJECT_ROOT/${bundle}.3ijs"
dest_pm="$PROJECT_ROOT/pm"

cp -f "$src_js" "$dest_js"
cp -f "$src_wasm" "$dest_wasm"
if [[ -s "$src_worker" ]]; then
    cp -f "$src_worker" "$dest_worker"
fi

iconv -f UTF-8 -t UTF-16 "$dest_js" -o "$dest_1ijs"
iconv -f UTF-8 -t UTF-32 "$dest_js" -o "$dest_3ijs"

mkdir -p "$dest_pm"
for artifact in "$dest_wasm" "$dest_1ijs" "$dest_3ijs"; do
    cp -f "$artifact" "$dest_pm/"
done
if [[ -s "$dest_worker" ]]; then
    cp -f "$dest_worker" "$dest_pm/"
fi

echo "Prepared deploy artifacts for ${bundle}:"
ls -lh "$dest_wasm" "$dest_1ijs" "$dest_3ijs" ${dest_worker:+"$dest_worker"}
echo "pm/ mirror:"
ls -lh "$dest_pm/${bundle}."*
