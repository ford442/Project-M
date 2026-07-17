#!/usr/bin/env bash
# Regenerate WASM artifacts from cmake/EmscriptenWasmFlags.cmake:
#   - scripts/wasm_link_common.inc.sh
#   - cmake/generated/ProjectMWasmBuildConfig.hpp
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cmake -P "$PROJECT_ROOT/cmake/GenerateWasmLinkCommon.cmake"
