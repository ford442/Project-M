#!/usr/bin/env bash
# Post-build WASM optimization + preset performance benchmarking.
#
# Default: wasm-opt + optional wasmedge AOT + terser JS minify on the built bundle.
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
#   PROJECTM_SKIP_WASMEDGE=1    skip wasmedgec / wasmedge compile
#   PROJECTM_SKIP_TERSER=1      skip JS minification
#   PROJECTM_INSTALL_WASMEDGE=0 do not auto-install wasmedge if missing
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
            sed -n '2,36p' "$0"
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

ensure_wasmedge() {
    if command -v wasmedge >/dev/null 2>&1 || command -v wasmedgec >/dev/null 2>&1; then
        return 0
    fi
    if [[ -f "${HOME}/.wasmedge/env" ]]; then
        # shellcheck disable=SC1091
        source "${HOME}/.wasmedge/env"
    fi
    if command -v wasmedge >/dev/null 2>&1 || command -v wasmedgec >/dev/null 2>&1; then
        return 0
    fi
    if [[ "${PROJECTM_INSTALL_WASMEDGE:-1}" != "1" ]]; then
        return 1
    fi
    echo "wasmedge not found; installing via official install.sh ..."
    if curl -sSf https://raw.githubusercontent.com/WasmEdge/WasmEdge/master/utils/install.sh | bash; then
        if [[ -f "${HOME}/.wasmedge/env" ]]; then
            # shellcheck disable=SC1091
            source "${HOME}/.wasmedge/env"
        fi
    fi
    if command -v wasmedge >/dev/null 2>&1 || command -v wasmedgec >/dev/null 2>&1; then
        echo "wasmedge found"
        return 0
    fi
    echo "wasmedge still not found; skipping AOT optimize" >&2
    return 1
}

run_wasmedge_opt() {
    local wasm="$1"
    local tmp="${wasm}.wasmedge.tmp"
    rm -f "$tmp"
    echo "Optimizing WASM (wasmedge)..."
    if command -v wasmedgec >/dev/null 2>&1; then
        wasmedgec --optimize=3 --enable-all "$wasm" "$tmp" || true
    elif command -v wasmedge >/dev/null 2>&1; then
        wasmedge compile --optimize 3 "$wasm" "$tmp" || true
    fi
    if [[ -f "$tmp" && -s "$tmp" ]]; then
        mv "$tmp" "$wasm"
        echo "wasmedge: wrote $wasm"
    else
        rm -f "$tmp"
        echo "wasmedge optimize failed; leaving original binary." >&2
    fi
}

minify_js() {
    local src="$1"
    [[ -f "$src" ]] || return 0
    local tmp="${src}.terser.tmp"
    echo "Minifying JS: $src"
    if terser "$src" -o "$tmp" \
        --compress defaults=false,dead_code=true,unused=true,loops=true,conditionals=true \
        --mangle reserved=['Module','FS','GL'] \
        --comments false; then
        mv "$tmp" "$src"
        echo "terser: wrote $src"
    else
        rm -f "$tmp"
        echo "terser failed for $src; leaving original." >&2
    fi
}

echo "=== projectM optimize / benchmark ==="
echo "WASM: $PROJECTM_WASM_WASM"
echo "JS:   $PROJECTM_WASM_JS"

if [[ "$SKIP_OPT" -eq 0 && -f "$PROJECTM_WASM_WASM" ]]; then
    WASM_BEFORE=$(stat -c%s "$PROJECTM_WASM_WASM")
    WASM_OPT=""
    if [[ -n "${EMSDK:-}" && -x "${EMSDK}/upstream/bin/wasm-opt" ]]; then
        WASM_OPT="${EMSDK}/upstream/bin/wasm-opt"
    elif [[ -n "${EMSDK_ROOT:-}" && -x "${EMSDK_ROOT}/upstream/bin/wasm-opt" ]]; then
        WASM_OPT="${EMSDK_ROOT}/upstream/bin/wasm-opt"
    elif command -v wasm-opt >/dev/null 2>&1; then
        WASM_OPT="$(command -v wasm-opt)"
    fi
    # --all-features is required: emcc builds with -mrelaxed-simd (opcode 261 =
    # f32x4.relaxed_madd) plus sign-ext / atomics / bulk-memory. Classic
    # --enable-simd alone cannot parse that binary.
    if [[ "${PROJECTM_SKIP_WASM_OPT:-0}" != "1" && -n "$WASM_OPT" ]]; then
        TMP_WASM="${PROJECTM_WASM_WASM}.opt.tmp"
        echo "Running $WASM_OPT -O3 --all-features ..."
        if ! "$WASM_OPT" -O3 --all-features \
            "$PROJECTM_WASM_WASM" -o "$TMP_WASM"; then
            echo "wasm-opt failed (need Binaryen that supports --all-features / relaxed SIMD). Leaving original binary." >&2
            rm -f "$TMP_WASM"
        else
            mv "$TMP_WASM" "$PROJECTM_WASM_WASM"
            WASM_AFTER=$(stat -c%s "$PROJECTM_WASM_WASM")
            echo "wasm-opt: ${WASM_BEFORE} -> ${WASM_AFTER} bytes ($(( WASM_BEFORE - WASM_AFTER )) saved)"
        fi
    else
        echo "wasm-opt skipped (not installed or PROJECTM_SKIP_WASM_OPT=1)"
    fi

    if [[ "${PROJECTM_SKIP_WASMEDGE:-0}" != "1" ]]; then
        if ensure_wasmedge; then
            run_wasmedge_opt "$PROJECTM_WASM_WASM"
        fi
    else
        echo "wasmedge skipped (PROJECTM_SKIP_WASMEDGE=1)"
    fi
elif [[ ! -f "$PROJECTM_WASM_WASM" ]]; then
    echo "Note: WASM binary not found; skipping wasm-opt / wasmedge"
fi

if [[ "$SKIP_OPT" -eq 0 ]]; then
    if [[ "${PROJECTM_SKIP_TERSER:-0}" != "1" ]]; then
        if command -v terser >/dev/null 2>&1; then
            echo "terser found"
            minify_js "$PROJECTM_WASM_JS"
            minify_js "${PROJECTM_WASM_JS%.js}.worker.js"
        else
            echo "terser not found - skipping JS minification"
        fi
    else
        echo "terser skipped (PROJECTM_SKIP_TERSER=1)"
    fi
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
