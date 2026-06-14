#!/bin/bash
# ================================================
# kimi_validate_preset.sh
#
# Validates a single .milk preset file by running the PresetCompat test harness
# (tests/libprojectM/PresetCompatTest.cpp) against it in isolation. This parses the
# preset and transpiles its warp/composite shaders from HLSL to GLSL without requiring
# an OpenGL context — a fast, GPU-free smoke check for Kimi (or any agent) loops.
#
# Exit codes:
#   0  - preset parsed and all warp/composite shaders transpiled successfully
#   1  - preset failed to parse or a shader failed to transpile (see log for details)
#   2  - usage / environment error (bad args, missing build dir, etc.)
#
# Usage:
#   scripts/kimi_validate_preset.sh <preset.milk> [<build-dir>]
#
# Examples:
#   scripts/kimi_validate_preset.sh presets/tests/000-empty.milk
#   scripts/kimi_validate_preset.sh custom_milk_fixed/milk011.milk cmake-build-verify
#
# See also: scripts/test_presets.sh (validates an entire directory of presets) and
# docs/kimi_preset_authoring_plan.md (Kimi CLI runbook for preset authoring).
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRESET_FILE="${1:-}"
BUILD_DIR="${2:-${PROJECT_ROOT}/cmake-build-verify}"

if [ -z "${PRESET_FILE}" ]; then
    echo "usage: $(basename "$0") <preset.milk> [<build-dir>]" >&2
    exit 2
fi

if [ ! -f "${PRESET_FILE}" ]; then
    echo "error: preset file '${PRESET_FILE}' does not exist" >&2
    exit 2
fi

case "${PRESET_FILE}" in
    *.milk) ;;
    *)
        echo "error: '${PRESET_FILE}' is not a .milk file" >&2
        exit 2
        ;;
esac

PRESET_FILE="$(cd "$(dirname "${PRESET_FILE}")" && pwd)/$(basename "${PRESET_FILE}")"

if [ ! -d "${BUILD_DIR}" ]; then
    echo "error: build directory '${BUILD_DIR}' does not exist. Configure it first, e.g.:" >&2
    echo "  cmake -G \"Ninja Multi-Config\" -S . -B ${BUILD_DIR} -DBUILD_TESTING=ON" >&2
    exit 2
fi

cmake --build "${BUILD_DIR}" --target projectM-unittest --config Debug

UNITTEST_BIN="${BUILD_DIR}/tests/libprojectM/Debug/projectM-unittest"
if [ ! -x "${UNITTEST_BIN}" ]; then
    UNITTEST_BIN="${BUILD_DIR}/tests/libprojectM/projectM-unittest"
fi

if [ ! -x "${UNITTEST_BIN}" ]; then
    echo "error: could not find built projectM-unittest binary under '${BUILD_DIR}'" >&2
    exit 2
fi

# PresetCompatTest.cpp's "ExtraPresetDir" instantiation scans PROJECTM_PRESET_COMPAT_DIR
# for *.milk files and runs PresetCompat.ParseAndTranspile against each one. Stage the
# single target preset in an isolated temp directory so only it is exercised.
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

cp "${PRESET_FILE}" "${WORKDIR}/"

echo "=== Validating $(basename "${PRESET_FILE}") (parse + HLSL->GLSL transpile) ==="
PROJECTM_PRESET_COMPAT_DIR="${WORKDIR}" "${UNITTEST_BIN}" --gtest_filter="*ExtraPresetDir*"
