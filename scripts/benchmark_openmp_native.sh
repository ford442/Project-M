#!/usr/bin/env bash
# Compare native OpenMP on vs off using the OpenMPBenchTest gtest.
#
# Usage:
#   scripts/benchmark_openmp_native.sh [build-dir]

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BUILD_ROOT="${1:-$PROJECT_ROOT/cmake-build-openmp-bench}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

mkdir -p "$BUILD_ROOT"

CXX="${CXX:-g++}"
CC="${CC:-gcc}"

common_cmake_args=(
    -G Ninja
    -S "$PROJECT_ROOT"
    -DCMAKE_CXX_COMPILER="$CXX"
    -DCMAKE_C_COMPILER="$CC"
    -DCMAKE_CXX_FLAGS="-include atomic"
    -DCMAKE_BUILD_TYPE=Release
    -DBUILD_TESTING=ON
    -DENABLE_SDL_UI=OFF
    -DENABLE_PLAYLIST=OFF
)

run_bench() {
    local label="$1"
    local openmp_flag="$2"
    local dir="$BUILD_ROOT/$label"
    cmake "${common_cmake_args[@]}" \
        -B "$dir" \
        -DENABLE_OPENMP="$openmp_flag"
    cmake --build "$dir" --target projectM-unittest -j"$JOBS"
    "$dir/tests/libprojectM/projectM-unittest" \
        --gtest_filter='OpenMPBenchTest.FftThroughput:OpenMPInfoTest.*:PresetPerfBenchTest.ParseThroughput' \
        --gtest_brief=1
}

echo "=== OpenMP ON ===" >&2
run_bench omp-on ON | tee "$BUILD_ROOT/omp-on.log"
echo "=== OpenMP OFF ===" >&2
run_bench omp-off OFF | tee "$BUILD_ROOT/omp-off.log"

python3 - <<'PY' "$BUILD_ROOT/omp-on.log" "$BUILD_ROOT/omp-off.log"
import re, sys, json
def parse(path):
    text = open(path).read()
    m = re.search(r"\[OpenMPBench\] compiled=(\w+) maxThreads=(\d+) fftTotalMs=([\d.]+) fftMsPerIter=([\d.eE+-]+)", text)
    if not m:
        raise SystemExit(f"no bench line in {path}")
    return {
        "compiled": m.group(1) in ("true", "1"),
        "maxThreads": int(m.group(2)),
        "fftTotalMs": float(m.group(3)),
        "fftMsPerIter": float(m.group(4)),
    }
on, off = parse(sys.argv[1]), parse(sys.argv[2])
speedup = off["fftTotalMs"] / on["fftTotalMs"] if on["fftTotalMs"] > 0 else 1.0
print(json.dumps({"openmpOn": on, "openmpOff": off, "fftSpeedup": round(speedup, 3)}, indent=2))
PY
