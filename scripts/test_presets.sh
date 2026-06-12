#!/bin/bash
# ================================================
# test_presets.sh
#
# Builds and runs the PresetCompat test harness (tests/libprojectM/PresetCompatTest.cpp),
# which parses preset files and transpiles their warp/composite shaders from HLSL to GLSL
# without requiring an OpenGL context. This is a fast, GPU-free way to check that a
# directory of Milkdrop presets is at least syntactically compatible with this fork.
#
# By default, the harness always tests presets/tests/ and custom_milk_fixed/.
# Pass a directory as the first argument to additionally test an arbitrary preset
# collection (e.g. a directory of community presets).
#
# Usage:
#   scripts/test_presets.sh [<preset-dir>] [<build-dir>]
#
# Examples:
#   scripts/test_presets.sh
#   scripts/test_presets.sh ~/weeks_presets
#   scripts/test_presets.sh ~/weeks_presets cmake-build
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${2:-${PROJECT_ROOT}/cmake-build}"
PRESET_DIR="${1:-}"

if [ -n "${PRESET_DIR}" ]; then
    if [ ! -d "${PRESET_DIR}" ]; then
        echo "error: preset directory '${PRESET_DIR}' does not exist" >&2
        exit 1
    fi
    export PROJECTM_PRESET_COMPAT_DIR="$(cd "${PRESET_DIR}" && pwd)"
    echo "Testing additional preset directory: ${PROJECTM_PRESET_COMPAT_DIR}"
fi

if [ ! -d "${BUILD_DIR}" ]; then
    echo "error: build directory '${BUILD_DIR}' does not exist. Configure it first, e.g.:" >&2
    echo "  cmake -G \"Ninja Multi-Config\" -S . -B ${BUILD_DIR} -DBUILD_TESTING=ON" >&2
    exit 1
fi

cmake --build "${BUILD_DIR}" --target projectM-unittest --config Debug

UNITTEST_BIN="${BUILD_DIR}/tests/libprojectM/Debug/projectM-unittest"
if [ ! -x "${UNITTEST_BIN}" ]; then
    UNITTEST_BIN="${BUILD_DIR}/tests/libprojectM/projectM-unittest"
fi

# custom_milk_fixed/ is opt-in (see PresetCompatTest.cpp) since it currently contains some
# presets with known format issues; this script always includes it in the report.
PROJECTM_TEST_CUSTOM_MILK_FIXED=1 "${UNITTEST_BIN}" --gtest_filter="*PresetCompat*"
