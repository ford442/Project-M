#!/usr/bin/env bash
# Runs the libFuzzer targets in tests/fuzz/ for a fixed time each (docs/FUZZING.md).
#
#   scripts/fuzz_run.sh <build-dir> <seconds-per-target> <work-dir> [<target> ...]
#
# <build-dir> must be configured with -DENABLE_FUZZING=ON and have the targets built.
# <work-dir> gets:
#   corpus/<target>/     the working corpus: seeds from tests/fuzz/extract_seeds.py plus
#                        whatever the fuzzer adds. Kept between runs (fuzz_nightly.yml caches it).
#   artifacts/<target>/  crash-*, leak-*, timeout-*, oom-* inputs, one per finding
#   logs/<target>.log    the full libFuzzer output
# The targets run in parallel, one process each. The regression corpus
# (tests/fuzz/regressions/<target>/) is passed as a read-only corpus, so every run replays it.
#
# Exits 1 if any target produced a finding, 2 on a usage or setup error.
# FUZZ_EXTRA_ARGS is appended to every libFuzzer command line (e.g. "-fork=4 -ignore_crashes=1").
# FUZZ_MINIMIZE_CORPUS=1 merges each corpus into a minimal one afterwards (-merge=1), which
# keeps a corpus carried between runs (fuzz_nightly.yml's cache) from growing without bound.

set -euo pipefail

if [[ $# -lt 3 ]]; then
    sed -n '2,17p' "$0" >&2
    exit 2
fi

BUILD_DIR=$1
SECONDS_PER_TARGET=$2
WORK_DIR=$3
shift 3

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FUZZ_SRC="$REPO/tests/fuzz"
ALL_TARGETS=(fuzz_preset_parser fuzz_hlsl_transpile fuzz_eval_compile fuzz_shader_passes)
TARGETS=("$@")
if [[ ${#TARGETS[@]} -eq 0 ]]; then
    TARGETS=("${ALL_TARGETS[@]}")
fi

dictionary_for() {
    case $1 in
        fuzz_preset_parser | fuzz_shader_passes) echo milk ;;
        fuzz_hlsl_transpile) echo hlsl ;;
        fuzz_eval_compile) echo eval ;;
        *) return 1 ;;
    esac
}

max_len_for() {
    case $1 in
        fuzz_eval_compile) echo 16384 ;; # The harness ignores anything longer.
        *) echo 65536 ;;
    esac
}

for target in "${TARGETS[@]}"; do
    if ! dictionary_for "$target" >/dev/null; then
        echo "fuzz_run: unknown target '$target' (known: ${ALL_TARGETS[*]})" >&2
        exit 2
    fi
    if [[ ! -x "$BUILD_DIR/tests/fuzz/$target" ]]; then
        echo "fuzz_run: $BUILD_DIR/tests/fuzz/$target is missing; configure with -DENABLE_FUZZING=ON and build it" >&2
        exit 2
    fi
done

mkdir -p "$WORK_DIR/corpus" "$WORK_DIR/artifacts" "$WORK_DIR/logs"
python3 "$FUZZ_SRC/extract_seeds.py" "$WORK_DIR/corpus" >/dev/null

# Each target writes to its own log; ASan symbolizes through llvm-symbolizer when it is on PATH.
export ASAN_OPTIONS="${ASAN_OPTIONS:-abort_on_error=1:detect_leaks=1:symbolize=1}"
export UBSAN_OPTIONS="${UBSAN_OPTIONS:-print_stacktrace=1:halt_on_error=1}"
# The same third-party leak suppressions as the sanitizer CI job (each entry says why).
export LSAN_OPTIONS="${LSAN_OPTIONS:-suppressions=$REPO/tests/sanitizers/lsan.supp:print_suppressions=0}"

declare -A pids
for target in "${TARGETS[@]}"; do
    mkdir -p "$WORK_DIR/artifacts/$target" "$WORK_DIR/corpus/$target"
    # shellcheck disable=SC2086 # FUZZ_EXTRA_ARGS is a list of flags.
    "$BUILD_DIR/tests/fuzz/$target" \
        "$WORK_DIR/corpus/$target" \
        "$FUZZ_SRC/regressions/$target" \
        -dict="$FUZZ_SRC/dictionaries/$(dictionary_for "$target").dict" \
        -max_total_time="$SECONDS_PER_TARGET" \
        -max_len="$(max_len_for "$target")" \
        -timeout=10 \
        -rss_limit_mb=2048 \
        -print_final_stats=1 \
        -artifact_prefix="$WORK_DIR/artifacts/$target/" \
        ${FUZZ_EXTRA_ARGS:-} \
        >"$WORK_DIR/logs/$target.log" 2>&1 &
    pids[$target]=$!
done

failed=()
for target in "${TARGETS[@]}"; do
    if wait "${pids[$target]}"; then
        status=0
    else
        status=$?
    fi
    findings=$(find "$WORK_DIR/artifacts/$target" -type f | wc -l)
    execs=$(grep -m1 -o 'stat::number_of_executed_units: [0-9]*' "$WORK_DIR/logs/$target.log" | grep -o '[0-9]*$' || echo '?')
    corpus=$(find "$WORK_DIR/corpus/$target" -type f | wc -l)
    echo "fuzz_run: $target exit=$status executions=$execs corpus=$corpus findings=$findings"
    if [[ $status -ne 0 || $findings -ne 0 ]]; then
        failed+=("$target")
        grep -E -m5 'ERROR: |runtime error:|SUMMARY: |Test unit written' "$WORK_DIR/logs/$target.log" | sed 's/^/    /' || true
    fi
done

if [[ ${FUZZ_MINIMIZE_CORPUS:-0} == 1 ]]; then
    for target in "${TARGETS[@]}"; do
        minimized="$WORK_DIR/corpus/$target.min"
        rm -rf "$minimized"
        mkdir -p "$minimized"
        if "$BUILD_DIR/tests/fuzz/$target" -merge=1 -timeout=10 -rss_limit_mb=2048 -max_len="$(max_len_for "$target")" \
            "$minimized" "$WORK_DIR/corpus/$target" >"$WORK_DIR/logs/$target.merge.log" 2>&1; then
            before=$(find "$WORK_DIR/corpus/$target" -type f | wc -l)
            rm -rf "$WORK_DIR/corpus/$target"
            mv "$minimized" "$WORK_DIR/corpus/$target"
            echo "fuzz_run: $target corpus minimized $before -> $(find "$WORK_DIR/corpus/$target" -type f | wc -l)"
        else
            echo "fuzz_run: $target corpus merge failed, keeping the full corpus (see logs/$target.merge.log)" >&2
            rm -rf "$minimized"
        fi
    done
fi

if [[ ${#failed[@]} -ne 0 ]]; then
    echo "fuzz_run: findings in ${failed[*]}; inputs are in $WORK_DIR/artifacts/, logs in $WORK_DIR/logs/" >&2
    echo "fuzz_run: reproduce with $BUILD_DIR/tests/fuzz/<target> <input>; once fixed, add the input to tests/fuzz/regressions/<target>/" >&2
    exit 1
fi
echo "fuzz_run: no findings"
