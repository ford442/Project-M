#!/usr/bin/env bash
# Regenerate scripts/wasm_link_common.inc.sh from cmake/EmscriptenWasmFlags.cmake.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cmake -P "$PROJECT_ROOT/cmake/GenerateWasmLinkCommon.cmake"
