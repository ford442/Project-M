#!/usr/bin/env bash
# Verify WASM artifacts generated from cmake/EmscriptenWasmFlags.cmake are committed.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Every file cmake/GenerateWasmLinkCommon.cmake writes, with the source it is
# generated from (for the error message).
GENERATED=(
    "scripts/wasm_link_common.inc.sh|cmake/EmscriptenWasmFlags.cmake"
    "cmake/generated/ProjectMWasmBuildConfig.hpp|cmake/EmscriptenWasmFlags.cmake"
    "cmake/generated/ProjectMWasmInitErrors.hpp|cmake/WasmApiManifest.cmake"
    "html/generated/projectm-wasm-api.ts|cmake/WasmApiManifest.cmake"
    "html/generated/projectm-wasm-api.js|cmake/WasmApiManifest.cmake"
    "html/generated/projectm-init-error-codes.js|cmake/WasmApiManifest.cmake"
)

SNAPSHOT_DIR="$(mktemp -d)"
trap 'rm -rf "$SNAPSHOT_DIR"' EXIT

for entry in "${GENERATED[@]}"; do
    file="${entry%%|*}"
    mkdir -p "$SNAPSHOT_DIR/$(dirname "$file")"
    if [[ -f "$PROJECT_ROOT/$file" ]]; then
        cp "$PROJECT_ROOT/$file" "$SNAPSHOT_DIR/$file"
    fi
done

"$PROJECT_ROOT/scripts/sync_wasm_link_common.sh"

failed=0
for entry in "${GENERATED[@]}"; do
    file="${entry%%|*}"
    source_file="${entry##*|}"
    if [[ ! -f "$SNAPSHOT_DIR/$file" ]] || ! diff -q "$SNAPSHOT_DIR/$file" "$PROJECT_ROOT/$file" >/dev/null; then
        echo "ERROR: $file is out of sync with $source_file" >&2
        failed=1
    fi
done

if grep -nE 'ASYNCIFY' "$PROJECT_ROOT/cmake/EmscriptenWasmFlags.cmake" "$PROJECT_ROOT/scripts/wasm_link_common.inc.sh" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#'; then
    echo "ERROR: an ASYNCIFY setting is back in cmake/EmscriptenWasmFlags.cmake or scripts/wasm_link_common.inc.sh" >&2
    failed=1
fi

if [[ "$failed" -ne 0 ]]; then
    echo "Run: scripts/sync_wasm_link_common.sh" >&2
    exit 1
fi

echo "WASM link artifacts are in sync with cmake/EmscriptenWasmFlags.cmake"
