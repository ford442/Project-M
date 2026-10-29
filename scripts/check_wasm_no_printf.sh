#!/usr/bin/env bash
# ================================================
# check_wasm_no_printf.sh
#
# src/wasm/ logs through libprojectM's Logging (WASM_LOG_* in WasmLog.hpp),
# so the host's log callback (globalThis.pmOnLog) sees every message, not only
# the browser console. A file fails when, outside comments, it calls printf,
# fprintf, puts or std::cout/std::cerr. src/wasm/WasmLog.cpp, the console sink
# itself, is exempt.
#
# Usage:
#   scripts/check_wasm_no_printf.sh
#
# Exit codes:
#   0 - no direct console output under src/wasm/ outside WasmLog.cpp
#   1 - at least one offending line (listed on stderr)
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

offenders=$(
    grep -rnE '(^|[^[:alnum:]_])(f?printf|puts)[[:space:]]*\(|std::(cout|cerr)' \
        --include='*.cpp' --include='*.hpp' --include='*.h' src/wasm |
        grep -v '^src/wasm/WasmLog\.cpp:' |
        grep -vE '^[^:]+:[0-9]+:[[:space:]]*//' || true
)

if [[ -n "$offenders" ]]; then
    echo "Direct console output in src/wasm/ (use WASM_LOG_INFO/WARN/ERROR from WasmLog.hpp):" >&2
    echo "$offenders" >&2
    exit 1
fi
echo "src/wasm/ logs through WasmLog.hpp only."
