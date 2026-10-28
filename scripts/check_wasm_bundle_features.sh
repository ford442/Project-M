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
# And that the bundle was built the way scripts/build_wasm.sh builds it:
#   - Stack sizes: the main thread's STACK_SIZE (read from the module's stack
#     bounds) and DEFAULT_PTHREAD_STACK_SIZE (passed to every pthread by the
#     glue) are the kWasmStackSize / kWasmPthreadStackSize of
#     cmake/generated/ProjectMWasmBuildConfig.hpp, not Emscripten's 64 KB.
#   - NDEBUG in every TU: the build-id says the libraries and the wrapper were
#     compiled with it (ndebug=1), and no TU left an assert() behind: the
#     symbol map (<bundle>.js.symbols, or <bundle>.symbols when staged) has no
#     __assert_fail. libprojectM, hlslparser and projectm-eval have asserts, so
#     one TU without NDEBUG links it.
#   - LTO: the libraries and the link agree (build-id lto-libs= / lto-link=).
# The build-id and symbol map are found next to the .wasm.
#
# Needs Binaryen's wasm-dis (bundled with emsdk at $EMSDK/upstream/bin).
#
# Usage:
#   scripts/check_wasm_bundle_features.sh cmake-build/wasm-smoke/projectm-v.030-thread.wasm
#
# Exit status:
#   0 - bundle is inside the floor and built as above
#   1 - a rejected feature is used, a build check failed, or a file is missing
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

# ---- Build checks ----------------------------------------------------------
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_header="$project_root/cmake/generated/ProjectMWasmBuildConfig.hpp"
config_value() {
    sed -n "s/^constexpr int $1 = \([0-9]*\);/\1/p" "$config_header"
}
want_stack="$(config_value kWasmStackSize)"
want_pthread_stack="$(config_value kWasmPthreadStackSize)"

base="${wasm%.wasm}"
glue="$base.js"
build_id="$base.build-id"
symbols=""
for candidate in "$base.js.symbols" "$base.symbols"; do
    if [[ -s "$candidate" ]]; then
        symbols="$candidate"
        break
    fi
done
for required in "$glue" "$build_id" "$symbols"; do
    if [[ -z "$required" || ! -s "$required" ]]; then
        echo "ERROR: ${required:-$base.js.symbols} is missing; build the bundle with scripts/build_wasm.sh." >&2
        exit 1
    fi
done
build_fact() {
    sed -n "s/^$1=//p" "$build_id" | head -n1
}

# Main thread: the start-up code sets the stack base (the stack pointer's
# initial value, global 0) and then the stack end; STACK_SIZE is the difference.
stack_pointer=$(sed -n 's/^ (global \$global\$0 (mut i32) (i32.const \([0-9]*\)))$/\1/p' "$wat" | head -n1)
stack_end=""
if [[ -n "$stack_pointer" ]]; then
    stack_end=$(grep -A4 "^   (i32.const $stack_pointer)\$" "$wat" | sed -n 's/^   (i32.const \([0-9]*\))$/\1/p' | grep -vx "$stack_pointer" | head -n1)
fi
if [[ -z "$stack_end" ]]; then
    echo "ERROR: could not find the main stack bounds in $(basename "$wasm") (Emscripten changed its start-up code?)." >&2
    failed=1
elif (( stack_pointer - stack_end != want_stack )); then
    echo "ERROR: main thread stack is $((stack_pointer - stack_end)) bytes, expected STACK_SIZE=$want_stack." >&2
    failed=1
fi

# pthreads: the main thread's _emscripten_thread_init() call passes
# DEFAULT_PTHREAD_STACK_SIZE (5th argument); a worker's own call passes 0.
pthread_stack=$(grep -oE '_emscripten_thread_init\([^)]*\)' "$glue" | awk -F, '{print $5}' | sort -n | tail -n1)
if [[ "$pthread_stack" != "$want_pthread_stack" ]]; then
    echo "ERROR: pthread stack is ${pthread_stack:-unknown} bytes, expected DEFAULT_PTHREAD_STACK_SIZE=$want_pthread_stack." >&2
    failed=1
fi

if [[ "$(build_fact ndebug)" != "1" ]]; then
    echo "ERROR: $(basename "$build_id") says the TUs were compiled without NDEBUG (ndebug=$(build_fact ndebug)); build the libraries as Release." >&2
    failed=1
fi
# The +debug flavor (scripts/build_wasm.sh --debug) links ASSERTIONS=2, which
# brings Emscripten's own asserting libc; that flavor is never deployed.
if [[ "$(head -n1 "$build_id")" == *+debug* ]]; then
    echo "note: $(basename "$build_id") is the +debug flavor; __assert_fail from Emscripten's ASSERTIONS libc is expected"
elif grep -qE '^[0-9]+:__assert_fail$' "$symbols"; then
    echo "ERROR: $(basename "$wasm") links __assert_fail: some TU kept its assert()s (compiled without NDEBUG)." >&2
    failed=1
fi

lto_libs="$(build_fact lto-libs)"
lto_link="$(build_fact lto-link)"
if [[ -z "$lto_libs" || "$lto_libs" != "$lto_link" ]]; then
    echo "ERROR: LTO state disagrees: libraries lto-libs=${lto_libs:-?}, link lto-link=${lto_link:-?} ($(basename "$build_id"))." >&2
    failed=1
fi

if [[ "$failed" -eq 0 ]]; then
    echo "OK: $(basename "$wasm") build: stack ${want_stack}/${want_pthread_stack} B (main/pthread), NDEBUG, LTO=${lto_libs} on both sides"
fi
exit "$failed"
