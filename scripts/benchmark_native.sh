#!/usr/bin/env bash
# Native preset/audio/OpenMP microbenchmarks (no browser required).
#
# Usage:
#   scripts/benchmark_native.sh [build-dir]
#   scripts/benchmark_native.sh cmake-build --json-out benchmark-results/native.json
#
# Runs gtest filters:
#   OpenMPBenchTest.FftThroughput
#   PresetPerfBenchTest.ParseThroughput
#   PCMAudioBenchTest.UpdateFrameAudioDataThroughput

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BUILD_DIR="${PROJECT_ROOT}/cmake-build"
JSON_OUT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json-out) JSON_OUT="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,12p' "$0"
            exit 0
            ;;
        *)
            if [[ "$1" != --* ]]; then
                BUILD_DIR="$1"
            else
                echo "Unknown option: $1" >&2
                exit 2
            fi
            shift
            ;;
    esac
done

# Ninja Multi-Config vs single-config
UNITTEST=""
for candidate in \
    "$BUILD_DIR/tests/libprojectM/Debug/projectM-unittest" \
    "$BUILD_DIR/tests/libprojectM/Release/projectM-unittest" \
    "$BUILD_DIR/tests/libprojectM/projectM-unittest"
do
    if [[ -x "$candidate" ]]; then
        UNITTEST="$candidate"
        break
    fi
done

if [[ -z "$UNITTEST" ]]; then
    echo "projectM-unittest not found under $BUILD_DIR — build with -DBUILD_TESTING=ON" >&2
    exit 1
fi

FILTER='OpenMPBenchTest.FftThroughput:PresetPerfBenchTest.ParseThroughput:PCMAudioBenchTest.UpdateFrameAudioDataThroughput'
LOG="$(mktemp)"
"$UNITTEST" --gtest_filter="$FILTER" --gtest_brief=1 2>&1 | tee "$LOG"

python3 - "$LOG" "$JSON_OUT" <<'PY'
import json, re, sys
from datetime import datetime, timezone

log_path, json_out = sys.argv[1], sys.argv[2]
text = open(log_path).read()

def parse_fft():
    m = re.search(
        r"\[OpenMPBench\] compiled=(\w+) maxThreads=(\d+) fftTotalMs=([\d.]+) fftMsPerIter=([\d.eE+-]+)",
        text,
    )
    if not m:
        return None
    return {
        "compiled": m.group(1) in ("true", "1"),
        "maxThreads": int(m.group(2)),
        "fftTotalMs": float(m.group(3)),
        "fftMsPerIter": float(m.group(4)),
    }

def parse_presets():
    rows = []
    for m in re.finditer(
        r"\[PresetPerfBench\] preset=(\S+) openmp=(\w+) maxThreads=(\d+) parseMsPerIter=([\d.]+)",
        text,
    ):
        rows.append({
            "preset": m.group(1),
            "parseMsPerIter": float(m.group(4)),
        })
    return rows

def parse_audio():
    m = re.search(
        r"\[PCMAudioBench\] compiled=(\w+) maxThreads=(\d+) frames=(\d+) audioUpdateTotalMs=([\d.]+) audioUpdateMsPerFrame=([\d.eE+-]+)",
        text,
    )
    if not m:
        return None
    return {
        "compiled": m.group(1) in ("true", "1"),
        "maxThreads": int(m.group(2)),
        "frames": int(m.group(3)),
        "audioUpdateTotalMs": float(m.group(4)),
        "audioUpdateMsPerFrame": float(m.group(5)),
    }

report = {
    "kind": "native-benchmark",
    "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "fft": parse_fft(),
    "presetParse": parse_presets(),
    "audioPipeline": parse_audio(),
}
print(json.dumps(report, indent=2))
if json_out:
    open(json_out, "w").write(json.dumps(report, indent=2) + "\n")
    print(f"Wrote {json_out}", file=sys.stderr)
PY

rm -f "$LOG"
