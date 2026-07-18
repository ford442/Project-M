#!/usr/bin/env bash
# Verify WASM artifacts generated from cmake/EmscriptenWasmFlags.cmake are committed.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INC="$PROJECT_ROOT/scripts/wasm_link_common.inc.sh"
HEADER="$PROJECT_ROOT/cmake/generated/ProjectMWasmBuildConfig.hpp"
TS_API="$PROJECT_ROOT/html/generated/projectm-wasm-api.ts"
JS_API="$PROJECT_ROOT/html/generated/projectm-wasm-api.js"
TMP_INC="$(mktemp)"
TMP_HEADER="$(mktemp)"
TMP_TS="$(mktemp)"
TMP_JS="$(mktemp)"

cp "$INC" "$TMP_INC"
if [[ -f "$HEADER" ]]; then
    cp "$HEADER" "$TMP_HEADER"
fi
if [[ -f "$TS_API" ]]; then
    cp "$TS_API" "$TMP_TS"
fi
if [[ -f "$JS_API" ]]; then
    cp "$JS_API" "$TMP_JS"
fi

"$PROJECT_ROOT/scripts/sync_wasm_link_common.sh"

failed=0
if ! diff -q "$TMP_INC" "$INC" >/dev/null; then
    echo "ERROR: $INC is out of sync with cmake/EmscriptenWasmFlags.cmake" >&2
    failed=1
fi

if ! diff -q "$TMP_HEADER" "$HEADER" >/dev/null; then
    echo "ERROR: $HEADER is out of sync with cmake/EmscriptenWasmFlags.cmake" >&2
    failed=1
fi

if ! diff -q "$TMP_TS" "$TS_API" >/dev/null; then
    echo "ERROR: $TS_API is out of sync with cmake/WasmApiManifest.cmake" >&2
    failed=1
fi

if ! diff -q "$TMP_JS" "$JS_API" >/dev/null; then
    echo "ERROR: $JS_API is out of sync with cmake/WasmApiManifest.cmake" >&2
    failed=1
fi

rm -f "$TMP_INC" "$TMP_HEADER" "$TMP_TS" "$TMP_JS"

if [[ "$failed" -ne 0 ]]; then
    echo "Run: scripts/sync_wasm_link_common.sh" >&2
    exit 1
fi

echo "WASM link artifacts are in sync with cmake/EmscriptenWasmFlags.cmake"
