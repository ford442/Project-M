#!/usr/bin/env bash
# wasm_source_fingerprint.sh
#
# Prints one hash covering everything that goes into the WASM bundle: the
# working-tree contents (not just the committed index) of the C++ sources, the
# vendored libraries, the build scripts and CMake files, the submodule commits
# and the env knobs the link reads. Not the emcc version: the deploy check must
# work on a machine without emsdk on PATH.
#
# scripts/build_wasm_smoke_wrapper.sh records it next to its outputs
# (projectm-v.030-thread.build-id); scripts/prepare_deploy_bundle.sh refuses to
# stage outputs whose recorded fingerprint differs from the tree being deployed.
# Deploying a bundle older than its sources is the worst failure this repo has:
# the golden gate runs in CI, not on the machine that runs deploy.py.
#
# Usage: scripts/wasm_source_fingerprint.sh

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$PROJECT_ROOT"

inputs=(
    CMakeLists.txt
    features.cmake
    config.h.cmake.in
    cmake
    src
    vendor
    omp
    scripts/wasm_link_common.inc.sh
    scripts/build_wasm_install.sh
    scripts/build_wasm_smoke_wrapper.sh
)

{
    # Tracked and untracked-but-not-ignored files, hashed by content.
    # A submodule is listed as one directory entry; it is covered below.
    { git ls-files -z -- "${inputs[@]}"; git ls-files -z -o --exclude-standard -- "${inputs[@]}"; } |
        sort -z |
        while IFS= read -r -d '' file; do
            if [[ -f "$file" ]]; then printf '%s\0' "$file"; fi
        done |
        xargs -0 -r sha1sum
    git submodule status --recursive -- vendor 2>/dev/null || true
    echo "PROJECTM_WASM_LTO=${PROJECTM_WASM_LTO:-0}"
    echo "PROJECTM_WASM_PTHREAD_POOL_SIZE=${PROJECTM_WASM_PTHREAD_POOL_SIZE:-}"
    echo "PROJECTM_WASM_EXTRA_LINK_FLAGS=${PROJECTM_WASM_EXTRA_LINK_FLAGS:-}"
} | sha1sum | cut -d' ' -f1
