#!/usr/bin/env bash
# Verify scripts/wasm_link_common.inc.sh matches cmake/EmscriptenWasmFlags.cmake.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INC="$PROJECT_ROOT/scripts/wasm_link_common.inc.sh"
TMP="$(mktemp)"

cp "$INC" "$TMP"
"$PROJECT_ROOT/scripts/sync_wasm_link_common.sh"

if ! diff -q "$TMP" "$INC" >/dev/null; then
    rm -f "$TMP"
    echo "ERROR: $INC is out of sync with cmake/EmscriptenWasmFlags.cmake" >&2
    echo "Run: scripts/sync_wasm_link_common.sh" >&2
    exit 1
fi

rm -f "$TMP"
echo "wasm_link_common.inc.sh is in sync with cmake/EmscriptenWasmFlags.cmake"
