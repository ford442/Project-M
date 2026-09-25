#!/usr/bin/env bash
#
# check_wasm_bundle_features.sh
#
# Asserts a linked WASM bundle stays inside the browser feature floor
# documented in docs/EMSCRIPTEN.md ("Wasm feature floor"). An engine rejects
# the *whole* module if any one instruction needs a feature it lacks, and that
# shows up as a generic init failure. Chromium (what CI's smoke and golden
# gates run on) supports every feature below, so no browser test would notice
# one creeping back in; this static check is the gate.
#
# Rejected today:
#   - Relaxed SIMD (*.relaxed_*): Safari ships it only behind a
#     JavaScriptCore flag. It comes back if -mrelaxed-simd returns to
#     cmake/EmscriptenWasmFlags.cmake or to any prebuilt archive the link pulls
#     in (omp/libomp.a included).
#   - Memory64: not in Safari.
#
# Needs Binaryen's wasm-dis (bundled with emsdk at $EMSDK/upstream/bin).
#
# Usage:
#   scripts/check_wasm_bundle_features.sh cmake-build/wasm-smoke/projectm-v.030-thread.wasm
#
# Exit status:
#   0 - bundle is inside the floor
#   1 - a rejected feature is used, or the bundle is missing
#   2 - wasm-dis not found

set -euo pipefail

wasm="${1:?usage: $0 <bundle.wasm>}"
if [[ ! -s "$wasm" ]]; then
    echo "check_wasm_bundle_features.sh: missing $wasm" >&2
    exit 1
fi

wasm_dis=""
for candidate in "${WASM_DIS:-}" "${EMSDK:+$EMSDK/upstream/bin/wasm-dis}" "$(command -v wasm-dis || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
        wasm_dis="$candidate"
        break
    fi
done
if [[ -z "$wasm_dis" ]]; then
    echo "check_wasm_bundle_features.sh: wasm-dis not found (activate emsdk or set WASM_DIS)" >&2
    exit 2
fi

wat="$(mktemp "${TMPDIR:-/tmp}/bundle-features.XXXXXX.wat")"
trap 'rm -f "$wat"' EXIT
"$wasm_dis" --all-features "$wasm" -o "$wat"

failed=0

relaxed=$( (grep -oE '\b[a-z0-9]+x[0-9]+\.relaxed_[a-z0-9_]+' "$wat" || true) | sort | uniq -c)
if [[ -n "$relaxed" ]]; then
    echo "ERROR: $(basename "$wasm") uses Relaxed SIMD, which Safari cannot compile:" >&2
    echo "$relaxed" >&2
    failed=1
fi

# Imported (pthreads: the glue creates it) or defined: "(memory $m i64 ...)".
if grep -qE '\(memory \$[^ ]+ i64' "$wat"; then
    echo "ERROR: $(basename "$wasm") declares a 64-bit memory (Memory64), which Safari cannot compile." >&2
    failed=1
fi

if [[ "$failed" -eq 0 ]]; then
    simd_ops=$( (grep -oE '\b[a-z0-9]+x[0-9]+\.[a-z_0-9]+' "$wat" || true) | wc -l)
    echo "OK: $(basename "$wasm") is inside the feature floor (SIMD128 ops: $simd_ops, relaxed: 0)"
fi
exit "$failed"
