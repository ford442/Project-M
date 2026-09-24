#!/usr/bin/env bash
# ================================================
# check_no_asyncify.sh
#
# Asserts a linked WASM bundle carries no Asyncify runtime. The build dropped
# ASYNCIFY when preset loading moved to a per-host prepare thread
# (src/wasm/WasmPresetPrepare.cpp): nothing suspends the wasm stack any more,
# so neither the -s ASYNCIFY setting nor the `Asyncify` JS glue may come back.
# ASYNCIFY and -fwasm-exceptions do not mix (a function that is both
# instrumented and contains a try/catch fails to compile), and an emscripten_sleep()
# reintroduced without ASYNCIFY aborts at runtime, so either regression is
# worth failing the build over.
#
# Usage:
#   scripts/check_no_asyncify.sh cmake-build/wasm-smoke/projectm-v.030-thread.js
#
# Exit codes:
#   0 - no Asyncify in the glue or the wasm
#   1 - Asyncify found, or the bundle is missing
# ================================================
set -euo pipefail

glue="${1:?usage: $0 <projectm-v.NNN-thread.js>}"
wasm="${glue%.js}.wasm"

for file in "$glue" "$wasm"; do
    if [[ ! -s "$file" ]]; then
        echo "check_no_asyncify.sh: missing $file" >&2
        exit 1
    fi
done

status=0
glue_hits=$( (grep -o 'Asyncify' "$glue" || true) | wc -l)
if [[ "$glue_hits" -ne 0 ]]; then
    echo "ERROR: $glue references the Asyncify runtime $glue_hits time(s); ASYNCIFY is back in the link." >&2
    status=1
fi
# The instrumented wasm imports/exports asyncify_start_unwind & co.
wasm_hits=$(grep -c 'asyncify_' "$wasm" || true)
if [[ "$wasm_hits" -ne 0 ]]; then
    echo "ERROR: $wasm contains asyncify_* symbols; ASYNCIFY is back in the link." >&2
    status=1
fi

if [[ "$status" -eq 0 ]]; then
    echo "OK: no Asyncify in $(basename "$glue") / $(basename "$wasm")"
fi
exit "$status"
