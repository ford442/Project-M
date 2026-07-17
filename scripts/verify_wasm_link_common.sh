#!/usr/bin/env bash
# Verify WASM artifacts generated from cmake/EmscriptenWasmFlags.cmake are committed.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INC="$PROJECT_ROOT/scripts/wasm_link_common.inc.sh"
HEADER="$PROJECT_ROOT/cmake/generated/ProjectMWasmBuildConfig.hpp"
TMP_INC="$(mktemp)"
TMP_HEADER="$(mktemp)"

cp "$INC" "$TMP_INC"
if [[ -f "$HEADER" ]]; then
    cp "$HEADER" "$TMP_HEADER"
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

rm -f "$TMP_INC" "$TMP_HEADER"

if [[ "$failed" -ne 0 ]]; then
    echo "Run: scripts/sync_wasm_link_common.sh" >&2
    exit 1
fi

echo "WASM link artifacts are in sync with cmake/EmscriptenWasmFlags.cmake"
