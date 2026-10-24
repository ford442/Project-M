#!/usr/bin/env bash
# build_wasm.sh — the one way to build the WASM bundle.
#
# CI (.github/workflows/build_emscripten.yml), Colab (scripts/colab_build.sh)
# and local builds all run this, so the bundle that was smoke- and golden-tested
# is the one that gets deployed:
#
#   1. scripts/build_wasm_install.sh      configure + build + install the static
#                                         libraries (incremental; CMake decides LTO)
#   2. scripts/build_wasm_smoke_wrapper.sh link the src/wasm/ wrapper into
#                                         projectm-v.030-thread.{js,wasm} and record
#                                         its .build-id (source fingerprint, binary
#                                         sha256s, build settings)
#   3. scripts/check_wasm_bundle_features.sh feature floor, stack sizes, NDEBUG,
#                                         LTO agreement
#   4. scripts/prepare_deploy_bundle.sh   (--stage only) copy that exact binary to the
#                                         repo root and pm/, rename the glue, write
#                                         pm/builds.json + .br/.gz
#
# Nothing rewrites the binary after step 2. The link already runs wasm-opt -O3
# (Emscripten does at -O3); a second post-link pass saved 604 B (0.04%) and
# shipped a binary no gate had seen, so there is none (docs/EMSCRIPTEN.md
# "Building the bundle").
#
# Usage:
#   source /path/to/emsdk/emsdk_env.sh
#   scripts/build_wasm.sh [--lto] [--debug] [--stage] [--link-only] [--version NNN]
#
#   --lto        whole-program LTO: the libraries are compiled to bitcode and the
#                link optimises across them (cmake/EmscriptenWasmFlags.cmake).
#                Switching it in an existing build dir rebuilds the libraries.
#   --debug      the runtime-checks link flavor (ASSERTIONS=2, SAFE_HEAP,
#                STACK_OVERFLOW_CHECK=2); never deployable. OUT_DIR defaults to
#                cmake-build/wasm-smoke-debug so it does not replace the release link.
#   --stage      also stage the bundle for deploy.py (refused with --debug or any
#                other flavor).
#   --link-only  relink against the libraries already in INSTALL_DIR (e.g. a second
#                link flavor in CI).
#   --version    deploy version for --stage (default: PROJECTM_WASM_VERSION, else
#                prepare_deploy_bundle.sh's default).
#
# Env: INSTALL_DIR (install), CMAKE_BUILD_DIR (cmake-build-wasm), OUT_DIR
# (cmake-build/wasm-smoke), and everything the three scripts read:
# BUILD_TESTING, GTEST_DIR, ENABLE_OPENMP, CMAKE_BUILD_TYPE (libraries);
# PROJECTM_WASM_WERROR, PROJECTM_WASM_GL_DEBUG, PROJECTM_WASM_EXPLICIT_SWAP,
# PROJECTM_WASM_EXTRA_LINK_FLAGS (link); PROJECTM_BUILDS_MERGE_URL,
# PROJECTM_BUILDS_ARGS (staging).

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

lto=0
debug=0
stage=0
link_only=0
version="${PROJECTM_WASM_VERSION:-}"

usage() {
    sed -n '2,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^set -euo pipefail/d'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --lto) lto=1 ;;
        --debug) debug=1 ;;
        --stage) stage=1 ;;
        --link-only) link_only=1 ;;
        --version)
            version="${2:?--version needs a value, e.g. 039}"
            shift
            ;;
        --version=*) version="${1#--version=}" ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "build_wasm.sh: unknown argument: $1 (see --help)" >&2
            exit 2
            ;;
    esac
    shift
done

if [[ "$stage" == "1" && ( "$debug" == "1" || "${PROJECTM_WASM_GL_DEBUG:-0}" == "1" || "${PROJECTM_WASM_EXPLICIT_SWAP:-0}" == "1" || -n "${PROJECTM_WASM_EXTRA_LINK_FLAGS:-}" ) ]]; then
    echo "build_wasm.sh: --stage builds the deployable bundle; drop --debug and the PROJECTM_WASM_GL_DEBUG /" >&2
    echo "PROJECTM_WASM_EXPLICIT_SWAP / PROJECTM_WASM_EXTRA_LINK_FLAGS link flavors." >&2
    exit 2
fi
if [[ -n "${PROJECTM_WASM_LTO:-}" && "${PROJECTM_WASM_LTO}" != "$lto" && "$link_only" == "0" ]]; then
    echo "build_wasm.sh: PROJECTM_WASM_LTO=${PROJECTM_WASM_LTO} in the environment; use --lto instead." >&2
    exit 2
fi

if ! command -v em++ >/dev/null 2>&1; then
    echo "build_wasm.sh: em++ not on PATH. Activate emsdk first: source /path/to/emsdk/emsdk_env.sh" >&2
    echo "(6.0.6 is the version CI pins; see docs/EMSCRIPTEN.md)" >&2
    exit 1
fi

export PROJECT_ROOT
export INSTALL_DIR="${INSTALL_DIR:-$PROJECT_ROOT/install}"
export CMAKE_BUILD_DIR="${CMAKE_BUILD_DIR:-$PROJECT_ROOT/cmake-build-wasm}"
if [[ -z "${OUT_DIR:-}" ]]; then
    if [[ "$debug" == "1" ]]; then
        OUT_DIR="$PROJECT_ROOT/cmake-build/wasm-smoke-debug"
    else
        OUT_DIR="$PROJECT_ROOT/cmake-build/wasm-smoke"
    fi
fi
export OUT_DIR

if [[ "$link_only" == "0" ]]; then
    echo "=== [1/3] Static libraries (LTO=$lto) -> $INSTALL_DIR ===" >&2
    PROJECTM_WASM_LTO="$lto" bash "$PROJECT_ROOT/scripts/build_wasm_install.sh"
fi

echo "=== [2/3] Wrapper link -> $OUT_DIR ===" >&2
# The link takes LTO from the libraries; nothing to pass.
env -u PROJECTM_WASM_LTO PROJECTM_WASM_DEBUG="$debug" \
    bash "$PROJECT_ROOT/scripts/build_wasm_smoke_wrapper.sh"

echo "=== [3/3] Bundle checks ===" >&2
bash "$PROJECT_ROOT/scripts/check_wasm_bundle_features.sh" "$OUT_DIR/projectm-v.030-thread.wasm"

if [[ "$stage" == "1" ]]; then
    echo "=== Staging for deploy.py ===" >&2
    stage_env=(PROJECTM_DEPLOY_REUSE_BUILD=1)
    if [[ -n "$version" ]]; then
        stage_env+=(PROJECTM_WASM_VERSION="$version")
    fi
    env "${stage_env[@]}" bash "$PROJECT_ROOT/scripts/prepare_deploy_bundle.sh"
fi

echo "Built $OUT_DIR/projectm-v.030-thread.{js,wasm}:" >&2
cat "$OUT_DIR/projectm-v.030-thread.build-id" >&2
