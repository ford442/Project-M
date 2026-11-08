#!/usr/bin/env bash
# Links the browser bundle (cmake-build/wasm-smoke/projectm-v.030-thread.{js,wasm})
# by building the projectM_wasm CMake target (src/wasm/CMakeLists.txt) in the
# Emscripten build dir scripts/build_wasm_install.sh configured, then copies it to
# OUT_DIR and writes the .build-id. Normally run through scripts/build_wasm.sh;
# see docs/EMSCRIPTEN.md ("Building the bundle").
#
# Everything about how the wrapper compiles and links lives in
# src/wasm/CMakeLists.txt. This script only picks the flavor (cache options,
# reset on every run so a flavor never leaks into the next link) and reads back
# what the build dir was configured with (LTO, NDEBUG) for the build-id.
#
# Env: CMAKE_BUILD_DIR, OUT_DIR; flavors (never deployed, they tag the
# build-id): PROJECTM_WASM_DEBUG=1 (ASSERTIONS=2 + SAFE_HEAP +
# STACK_OVERFLOW_CHECK=2), PROJECTM_WASM_GL_DEBUG=1, PROJECTM_WASM_EXPLICIT_SWAP=1;
# PROJECTM_WASM_EXTRA_LINK_FLAGS, PROJECTM_WASM_WERROR=1. INSTALL_DIR is not
# read: the target links the libraries from the build tree.
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR="${INSTALL_DIR:-"$PROJECT_ROOT/install"}"
OUT_DIR="${OUT_DIR:-"$PROJECT_ROOT/cmake-build/wasm-smoke"}"
CMAKE_BUILD_DIR="${CMAKE_BUILD_DIR:-}"

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

if ! command -v em++ >/dev/null 2>&1; then
    echo "ERROR: em++ not found on PATH. Activate the Emscripten SDK first, e.g.:" >&2
    echo "  source /path/to/emsdk/emsdk_env.sh" >&2
    exit 1
fi

cache_value() {
    sed -n "s/^$1:[A-Z]*=//p" "$CMAKE_BUILD_DIR/CMakeCache.txt" | head -n1
}
on_off() { [[ "${1:-0}" == "1" ]] && echo ON || echo OFF; }

# LTO has one switch, the libraries' CMake configure (scripts/build_wasm.sh
# --lto). Refuse a PROJECTM_WASM_LTO in the environment that disagrees.
case "$(cache_value PROJECTM_WASM_LTO)" in
    ON | TRUE | 1) lib_lto=1 ;;
    *) lib_lto=0 ;;
esac
if [[ -n "${PROJECTM_WASM_LTO:-}" && "${PROJECTM_WASM_LTO}" != "$lib_lto" ]]; then
    echo "ERROR: PROJECTM_WASM_LTO=${PROJECTM_WASM_LTO}, but $CMAKE_BUILD_DIR was configured with PROJECTM_WASM_LTO=$lib_lto." >&2
    echo "LTO is chosen when the libraries are configured: scripts/build_wasm.sh [--lto]." >&2
    exit 1
fi

# Non-deployable link flavors (docs/EMSCRIPTEN.md "Link flavors"); each one
# tags the build-id below, so prepare_deploy_bundle.sh / deploy.py refuse it.
build_id_suffix=""
[[ "${PROJECTM_WASM_GL_DEBUG:-0}" == "1" ]] && build_id_suffix+="+gl-debug"
[[ "${PROJECTM_WASM_EXPLICIT_SWAP:-0}" == "1" ]] && build_id_suffix+="+explicit-swap"
[[ "${PROJECTM_WASM_DEBUG:-0}" == "1" ]] && build_id_suffix+="+debug"

cmake "$CMAKE_BUILD_DIR" \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
    -DPROJECTM_WASM_GL_DEBUG="$(on_off "${PROJECTM_WASM_GL_DEBUG:-0}")" \
    -DPROJECTM_WASM_EXPLICIT_SWAP="$(on_off "${PROJECTM_WASM_EXPLICIT_SWAP:-0}")" \
    -DPROJECTM_WASM_DEBUG="$(on_off "${PROJECTM_WASM_DEBUG:-0}")" \
    -DPROJECTM_WASM_WERROR="$(on_off "${PROJECTM_WASM_WERROR:-0}")" \
    -DPROJECTM_WASM_EXTRA_LINK_FLAGS="${PROJECTM_WASM_EXTRA_LINK_FLAGS:-}" \
    >/dev/null
cmake --build "$CMAKE_BUILD_DIR" --target projectM_wasm --parallel

built_dir="$CMAKE_BUILD_DIR/src/wasm"
mkdir -p "$OUT_DIR"
for ext in js wasm js.symbols; do
    test -s "$built_dir/projectm-v.030-thread.$ext"
    cp -f "$built_dir/projectm-v.030-thread.$ext" "$OUT_DIR/"
done

# NDEBUG as the wrapper TUs were really compiled (the build type decides it).
lib_ndebug=0
if grep -q -- '-DNDEBUG' <<< "$(python3 - "$CMAKE_BUILD_DIR/compile_commands.json" <<'PY'
import json, sys
for entry in json.load(open(sys.argv[1])):
    if entry["file"].endswith("src/wasm/WasmHost.cpp"):
        print(entry.get("command") or " ".join(entry.get("arguments", [])))
        break
PY
)"; then
    lib_ndebug=1
fi

# What this bundle was built from, and what it is. Line 1 is the source
# fingerprint (+flavor tags), which scripts/prepare_deploy_bundle.sh and
# deploy.py compare with the tree they deploy; the rest are key=value facts:
# the binary hashes (deploy.py checks every staged copy and .br/.gz sibling
# against them; two builds of one tree with one emsdk give the same ones) and
# the build settings scripts/check_wasm_bundle_features.sh asserts. Written
# last, so a failed link leaves the previous (now mismatching) id behind.
{
    echo "$("$PROJECT_ROOT/scripts/wasm_source_fingerprint.sh")${build_id_suffix}"
    echo "wasm-sha256=$(sha256sum "$OUT_DIR/projectm-v.030-thread.wasm" | cut -d' ' -f1)"
    echo "js-sha256=$(sha256sum "$OUT_DIR/projectm-v.030-thread.js" | cut -d' ' -f1)"
    echo "lto-libs=$lib_lto"
    echo "lto-link=$lib_lto"
    echo "ndebug=$lib_ndebug"
    echo "emcc=$(em++ --version 2>/dev/null | head -n1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
} > "$OUT_DIR/projectm-v.030-thread.build-id"
