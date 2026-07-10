#!/usr/bin/env bash
# Post-build WASM optimization + preset performance benchmarking.
#
# Default: wasm-opt on the built .wasm bundle.
#
# Benchmark modes (repeatable, preset-focused):
#   wasm    — browser Playwright harness (per-frame breakdown, preset switch time)
#   native  — gtest: FFT, preset parse, audio pipeline (no GL)
#   parse   — native preset file parse throughput only
#   audio   — native PCM::UpdateFrameAudioData throughput only
#   openmp  — native OpenMP on vs off FFT comparison (separate build dirs)
#   all     — wasm + native (+ openmp if time permits)
#
# Usage:
#   ./optimize.sh [path/to/projectm-v.030-thread.wasm|.js]
#   ./optimize.sh --bench wasm
#   ./optimize.sh --bench native
#   ./optimize.sh --bench all
#   ./optimize.sh --bench wasm --baseline benchmark-results/wasm-baseline.json
#   ./optimize.sh --bench wasm --compare benchmark-results/wasm-baseline.json
#   ./optimize.sh --bench wasm --audio-load          # WASM with synthetic PCM each frame
#   ./optimize.sh --skip-opt --bench native
#
# Environment:
#   PROJECT_ROOT              repo root
#   PROJECTM_WASM_JS / WASM     wrapper paths
#   PROJECTM_SKIP_WASM_OPT=1    skip wasm-opt
#   PROJECTM_BENCH_MANIFEST     override presets/benchmark_curated.json
#
# See docs/BENCHMARKING.md for full workflow and before/after comparisons.

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
DEFAULT_JS="${PROJECT_ROOT}/projectm-v.030-thread.js"
DEFAULT_WASM="${PROJECT_ROOT}/projectm-v.030-thread.wasm"
RESULTS_DIR="${PROJECT_ROOT}/benchmark-results"

RUN_BENCH=0
BENCH_MODE="wasm"
BASELINE_OUT=""
COMPARE_BASELINE=""
SKIP_OPT=0
AUDIO_LOAD=0
WASM_INPUT=""
BUILD_DIR="${PROJECT_ROOT}/cmake-build"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --bench)
            RUN_BENCH=1
            if [[ $# -ge 2 && "$2" != --* ]]; then
                case "$2" in
                    wasm|native|parse|audio|openmp|all) BENCH_MODE="$2"; shift 2 ;;
                    *) shift ;;
                esac
            else
                shift
            fi
            ;;
        --bench=*) RUN_BENCH=1; BENCH_MODE="${1#--bench=}"; shift ;;
        --baseline) BASELINE_OUT="$2"; RUN_BENCH=1; shift 2 ;;
        --compare) COMPARE_BASELINE="$2"; RUN_BENCH=1; shift 2 ;;
        --audio-load) AUDIO_LOAD=1; shift ;;
        --skip-opt) SKIP_OPT=1; shift ;;
        --build-dir) BUILD_DIR="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,32p' "$0"
            exit 0
            ;;
        *)
            if [[ -z "$WASM_INPUT" ]]; then
                WASM_INPUT="$1"
            else
                echo "Unexpected argument: $1" >&2
                exit 2
            fi
            shift
            ;;
    esac
done

if [[ -n "$WASM_INPUT" ]]; then
    if [[ "$WASM_INPUT" == *.js ]]; then
        PROJECTM_WASM_JS="$WASM_INPUT"
        PROJECTM_WASM_WASM="${WASM_INPUT%.js}.wasm"
    else
        PROJECTM_WASM_WASM="$WASM_INPUT"
        PROJECTM_WASM_JS="${WASM_INPUT%.wasm}.js"
    fi
else
    PROJECTM_WASM_JS="${PROJECTM_WASM_JS:-$DEFAULT_JS}"
    PROJECTM_WASM_WASM="${PROJECTM_WASM_WASM:-$DEFAULT_WASM}"
fi

if [[ ! -f "$PROJECTM_WASM_WASM" ]]; then
    ALT_WASM="${PROJECT_ROOT}/cmake-build/wasm-smoke/projectm-v.030-thread.wasm"
    ALT_JS="${PROJECT_ROOT}/cmake-build/wasm-smoke/projectm-v.030-thread.js"
    if [[ -f "$ALT_WASM" ]]; then
        PROJECTM_WASM_WASM="$ALT_WASM"
        PROJECTM_WASM_JS="$ALT_JS"
    fi
fi

mkdir -p "$RESULTS_DIR"

run_wasm_bench() {
    if [[ ! -f "$PROJECTM_WASM_JS" ]]; then
        echo "Error: WASM JS missing: $PROJECTM_WASM_JS" >&2
        exit 1
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo "Error: node required for WASM benchmarks" >&2
        exit 1
    fi
    local args=("$PROJECT_ROOT/scripts/benchmark_presets_wasm.mjs" "$PROJECTM_WASM_JS")
    [[ "$AUDIO_LOAD" -eq 1 ]] && args+=(--audio-load)
    if [[ -n "$BASELINE_OUT" ]]; then
        args+=(--baseline "$BASELINE_OUT")
    elif [[ -n "$COMPARE_BASELINE" ]]; then
        args+=(--compare "$COMPARE_BASELINE")
    else
        args+=(--out "$RESULTS_DIR/preset-benchmark-wasm.json")
    fi
    echo "=== WASM preset benchmark (Playwright) ==="
    PROJECTM_SMOKE_ROOT="$PROJECT_ROOT" node "${args[@]}"
}

run_native_bench() {
    local filter="OpenMPBenchTest.FftThroughput:PresetPerfBenchTest.ParseThroughput:PCMAudioBenchTest.UpdateFrameAudioDataThroughput"
    case "$BENCH_MODE" in
        parse) filter="PresetPerfBenchTest.ParseThroughput" ;;
        audio) filter="PCMAudioBenchTest.UpdateFrameAudioDataThroughput" ;;
    esac
    echo "=== Native benchmark (gtest: $filter) ==="
    chmod +x "$PROJECT_ROOT/scripts/benchmark_native.sh"
    if [[ "$BENCH_MODE" == "native" || "$BENCH_MODE" == "all" ]]; then
        "$PROJECT_ROOT/scripts/benchmark_native.sh" "$BUILD_DIR" \
            --json-out "$RESULTS_DIR/preset-benchmark-native.json"
    else
        local unittest=""
        for c in \
            "$BUILD_DIR/tests/libprojectM/Debug/projectM-unittest" \
            "$BUILD_DIR/tests/libprojectM/Release/projectM-unittest" \
            "$BUILD_DIR/tests/libprojectM/projectM-unittest"
        do
            [[ -x "$c" ]] && unittest="$c" && break
        done
        [[ -z "$unittest" ]] && { echo "Build projectM-unittest first" >&2; exit 1; }
        "$unittest" --gtest_filter="$filter" --gtest_brief=1
    fi
}

run_openmp_bench() {
    echo "=== OpenMP on vs off (native FFT) ==="
    chmod +x "$PROJECT_ROOT/scripts/benchmark_openmp_native.sh"
    "$PROJECT_ROOT/scripts/benchmark_openmp_native.sh" "$PROJECT_ROOT/cmake-build-openmp-bench" \
        | tee "$RESULTS_DIR/openmp-compare.json"
}

echo "=== projectM optimize / benchmark ==="
echo "WASM: $PROJECTM_WASM_WASM"
echo "JS:   $PROJECTM_WASM_JS"

if [[ "$SKIP_OPT" -eq 0 && -f "$PROJECTM_WASM_WASM" ]]; then
    WASM_BEFORE=$(stat -c%s "$PROJECTM_WASM_WASM")
    if [[ "${PROJECTM_SKIP_WASM_OPT:-0}" != "1" ]] && command -v wasm-opt >/dev/null 2>&1; then
        TMP_WASM="${PROJECTM_WASM_WASM}.opt.tmp"
        echo "Running wasm-opt -O3 --enable-simd ..."
        wasm-opt -O3 --enable-simd --enable-threads --enable-bulk-memory \
            --enable-mutable-globals --enable-nontrapping-float-to-int \
            "$PROJECTM_WASM_WASM" -o "$TMP_WASM"
        mv "$TMP_WASM" "$PROJECTM_WASM_WASM"
        WASM_AFTER=$(stat -c%s "$PROJECTM_WASM_WASM")
        echo "wasm-opt: ${WASM_BEFORE} -> ${WASM_AFTER} bytes ($(( WASM_BEFORE - WASM_AFTER )) saved)"
    else
        echo "wasm-opt skipped (not installed or PROJECTM_SKIP_WASM_OPT=1)"
    fi
elif [[ ! -f "$PROJECTM_WASM_WASM" ]]; then
    echo "Note: WASM binary not found; skipping wasm-opt"
fi

if [[ "$RUN_BENCH" -eq 1 ]]; then
    case "$BENCH_MODE" in
        wasm) run_wasm_bench ;;
        native|parse|audio) run_native_bench ;;
        openmp) run_openmp_bench ;;
        all)
            run_native_bench
            run_openmp_bench || true
            run_wasm_bench
            ;;
        *)
            echo "Unknown bench mode: $BENCH_MODE (use wasm|native|parse|audio|openmp|all)" >&2
            exit 2
            ;;
    esac
fi

echo "=== Done ==="
[[ "$RUN_BENCH" -eq 1 ]] && echo "Results directory: $RESULTS_DIR"
