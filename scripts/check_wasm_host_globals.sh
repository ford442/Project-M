#!/usr/bin/env bash
# ================================================
# check_wasm_host_globals.sh
#
# Grep gate for #246 (WASM multi-instance Phase C): src/wasm/ must not grow
# back object-like macros that alias per-host WasmHost state, e.g.
#
#   #define pm (Host().appData.projectm_engine)
#   #define g_dualFbo (Host().dualFbo)
#
# Those rewrite every matching identifier in the TU — safe only while no EM_JS
# body, local, or address-of happens to spell the same token, and silently
# wrong the day one does. Per-host state is reached with
# `WasmHost& H = Host();` plus local references (`auto& pm =
# H.appData.projectm_engine;`) instead.
#
# Checked:
#   1. no `#define <name> (Host()...` alias macros at all;
#   2. no `#define pm` / `#define app_data` / `#define playlist`;
#   3. no `#define g_*` except the allowlist below.
#
# Allowlist (documented process-globals that are NOT per-host state):
#   g_mainLoopRegistered — one Emscripten main loop services every started
#                          host (WasmHost.hpp). It is a real variable, not a
#                          macro, so it never needs a #define; it is listed so
#                          the rule's one sanctioned global is spelled out.
#
# Usage:
#   scripts/check_wasm_host_globals.sh
#
# Exit codes:
#   0 - no forbidden aliases
#   1 - at least one forbidden #define found
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

ALLOWED_G_DEFINES=(g_mainLoopRegistered)

status=0

report() {
    echo "ERROR: $1" >&2
    echo "$2" | sed 's/^/  /' >&2
    status=1
}

if hits=$(grep -rnE '^[[:space:]]*#[[:space:]]*define[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\(?[[:space:]]*Host\(\)' src/wasm/); then
    report "object-like macros aliasing Host() state in src/wasm/ (use WasmHost& H = Host(); + local references):" "$hits"
fi

if hits=$(grep -rnE '^[[:space:]]*#[[:space:]]*define[[:space:]]+(pm|app_data|playlist)\b' src/wasm/); then
    report "engine alias macros in src/wasm/:" "$hits"
fi

allow_re="$(IFS='|'; echo "${ALLOWED_G_DEFINES[*]}")"
if hits=$(grep -rnE '^[[:space:]]*#[[:space:]]*define[[:space:]]+g_[A-Za-z0-9_]*' src/wasm/ | grep -vE "#[[:space:]]*define[[:space:]]+(${allow_re})\b"); then
    report "#define g_* macros in src/wasm/ (only ${ALLOWED_G_DEFINES[*]} is allowed):" "$hits"
fi

if [[ $status -eq 0 ]]; then
    echo "OK: src/wasm/ has no per-host alias macros (#246)."
fi
exit $status
