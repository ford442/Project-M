#!/usr/bin/env bash
# Regenerate WASM artifacts from cmake/EmscriptenWasmFlags.cmake and WasmApiManifest.cmake:
#   - scripts/wasm_link_common.inc.sh
#   - cmake/generated/ProjectMWasmBuildConfig.hpp
#   - html/generated/projectm-wasm-api.js (+ the .d.ts that re-exports packages/types/src/wasm-api.d.ts)
#   - packages/types/src/wasm-api.d.ts (the declarations: HostHandle, ProjectMError, WasmApiCalls)
#   - src/wasm/generated/WasmApiImpl.hpp, WasmApiExports.cpp (the export barriers and compat shims)
#   - src/wasm/generated/WasmApiErrors.hpp (enum class WasmApiError)
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cmake -P "$PROJECT_ROOT/cmake/GenerateWasmLinkCommon.cmake"
