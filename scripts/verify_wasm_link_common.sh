#!/usr/bin/env bash
# Verify the WASM artifacts generated from cmake/EmscriptenWasmFlags.cmake and
# cmake/WasmApiManifest.cmake are committed and up to date.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INC="$PROJECT_ROOT/scripts/wasm_link_common.inc.sh"

# Every file scripts/sync_wasm_link_common.sh writes, and what it is generated from.
GENERATED=(
    "scripts/wasm_link_common.inc.sh|cmake/EmscriptenWasmFlags.cmake"
    "cmake/generated/ProjectMWasmBuildConfig.hpp|cmake/EmscriptenWasmFlags.cmake"
    "html/generated/projectm-wasm-api.ts|cmake/WasmApiManifest.cmake"
    "html/generated/projectm-wasm-api.js|cmake/WasmApiManifest.cmake"
    "src/wasm/generated/WasmApiImpl.hpp|cmake/WasmApiManifest.cmake"
    "src/wasm/generated/WasmApiExports.cpp|cmake/WasmApiManifest.cmake"
)

SNAPSHOT="$(mktemp -d)"
trap 'rm -rf "$SNAPSHOT"' EXIT
for entry in "${GENERATED[@]}"; do
    file="${entry%%|*}"
    mkdir -p "$SNAPSHOT/$(dirname "$file")"
    if [[ -f "$PROJECT_ROOT/$file" ]]; then
        cp "$PROJECT_ROOT/$file" "$SNAPSHOT/$file"
    else
        : > "$SNAPSHOT/$file"
    fi
done

"$PROJECT_ROOT/scripts/sync_wasm_link_common.sh"

failed=0
for entry in "${GENERATED[@]}"; do
    file="${entry%%|*}"
    source="${entry#*|}"
    if ! diff -q "$SNAPSHOT/$file" "$PROJECT_ROOT/$file" >/dev/null; then
        echo "ERROR: $file is out of sync with $source" >&2
        failed=1
    fi
done

# ASYNCIFY is gone from every link (preset loading runs on a prepare thread);
# the settings must not be reintroduced in the canonical flags or the generated
# wrapper link. scripts/check_no_asyncify.sh checks a built bundle.
if grep -nE 'ASYNCIFY' "$PROJECT_ROOT/cmake/EmscriptenWasmFlags.cmake" "$INC" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#'; then
    echo "ERROR: an ASYNCIFY setting is back in cmake/EmscriptenWasmFlags.cmake or $INC" >&2
    failed=1
fi

if [[ "$failed" -ne 0 ]]; then
    echo "Run: scripts/sync_wasm_link_common.sh" >&2
    exit 1
fi

echo "WASM generated artifacts are in sync with cmake/EmscriptenWasmFlags.cmake and cmake/WasmApiManifest.cmake"
