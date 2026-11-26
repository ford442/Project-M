#!/bin/bash
# ================================================
# check_wgsl_corpus.sh
#
# The WGSL corpus check of the WebGPU backend's shader path (Phase C,
# docs/adr/0002-wgsl-shader-path.md):
#
#   1. runs PresetCompatWgsl (tests/libprojectM/PresetCompatTest.cpp), which transpiles
#      every preset of presets/tests, presets/custom and presets/weeks to WGSL and writes
#      the modules to <out-dir>/<corpus>/<preset>.{warp,comp}[.passN].wgsl;
#   2. validates every module with naga (WGSL front end + validator, the same checks a
#      browser's WebGPU implementation makes before createShaderModule() succeeds);
#   3. compares the presets naga rejects with the "validate" lines of
#      tests/libprojectM/data/PresetCompat/wgsl_known_failures.txt. A new failure fails the
#      check, and so does a listed preset that now validates (the ledger only shrinks).
#
# A preset counts as valid when all of its modules validate.
#
# Usage:
#   scripts/check_wgsl_corpus.sh <build-dir> [<out-dir>]
#
# Environment:
#   NAGA                 naga binary (default: naga on PATH). Install the pinned version with
#                        cargo install naga-cli --version "${NAGA_VERSION}" --locked
#   NAGA_VERSION         The version CI pins (printed; a mismatch is a warning).
#   WGSL_NAGA_REQUIRED=1 Fail instead of skipping validation when naga is missing.
#   BUILD_CONFIG         Multi-config build configuration (default Debug).
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${1:?usage: $0 <build-dir> [<out-dir>]}"
OUT_DIR="${2:-${BUILD_DIR}/wgsl-corpus}"
BUILD_CONFIG="${BUILD_CONFIG:-Debug}"
NAGA="${NAGA:-naga}"
NAGA_VERSION="${NAGA_VERSION:-30.0.2}"
LEDGER="${PROJECT_ROOT}/tests/libprojectM/data/PresetCompat/wgsl_known_failures.txt"

UNITTEST=""
for candidate in \
    "${BUILD_DIR}/tests/libprojectM/${BUILD_CONFIG}/projectM-unittest" \
    "${BUILD_DIR}/tests/libprojectM/projectM-unittest"; do
    if [ -x "${candidate}" ]; then
        UNITTEST="${candidate}"
        break
    fi
done
if [ -z "${UNITTEST}" ]; then
    echo "error: projectM-unittest not found in ${BUILD_DIR} (configure with -DBUILD_TESTING=ON and build it)" >&2
    exit 1
fi

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

echo "== Transpiling the corpora to WGSL (PresetCompatWgsl)"
PROJECTM_WGSL_OUT_DIR="${OUT_DIR}" "${UNITTEST}" --gtest_filter='PresetCompatWgsl.*' --gtest_brief=1

if [ -z "$(find "${OUT_DIR}" -name '*.wgsl' -print -quit)" ]; then
    echo "error: no WGSL written to ${OUT_DIR}: is the build configured with ENABLE_WGSL_EMIT=ON?" >&2
    exit 1
fi

if ! command -v "${NAGA}" > /dev/null 2>&1; then
    if [ "${WGSL_NAGA_REQUIRED:-0}" = "1" ]; then
        echo "error: naga not found (cargo install naga-cli --version ${NAGA_VERSION} --locked)" >&2
        exit 1
    fi
    echo "naga not found: skipping validation (set WGSL_NAGA_REQUIRED=1 to make this fatal)."
    exit 0
fi

installed_version="$("${NAGA}" --version 2>/dev/null | awk '{print $NF}')"
echo "== Validating with naga ${installed_version}"
if [ "${installed_version}" != "${NAGA_VERSION}" ]; then
    echo "warning: naga ${installed_version} is not the pinned ${NAGA_VERSION}" >&2
fi

# One line per module: <status>\t<relative path>, validated in parallel.
VALIDATION="${OUT_DIR}/naga.tsv"
ERRORS_DIR="${OUT_DIR}/naga-errors"
mkdir -p "${ERRORS_DIR}"
export NAGA OUT_DIR ERRORS_DIR
(cd "${OUT_DIR}" && find . -name '*.wgsl' -print0 | sort -z |
    xargs -0 -P "$(nproc 2>/dev/null || echo 4)" -I{} bash -c '
        file="${1#./}"
        if "${NAGA}" "${OUT_DIR}/${file}" > /dev/null 2> "${ERRORS_DIR}/$(echo "${file}" | tr "/" "_").txt"; then
            rm -f "${ERRORS_DIR}/$(echo "${file}" | tr "/" "_").txt"
            printf "ok\t%s\n" "${file}"
        else
            printf "fail\t%s\n" "${file}"
        fi' _ {}) | sort -k2 > "${VALIDATION}"

# Module path -> preset id: "weeks/foo.comp.pass1.wgsl" -> "weeks/foo.milk".
preset_id() {
    sed -E 's/\.(warp|comp)(\.pass[0-9]+)?\.wgsl$/.milk/'
}

modules=$(wc -l < "${VALIDATION}")
failed_modules=$(grep -c '^fail' "${VALIDATION}" || true)
cut -f2 "${VALIDATION}" | preset_id | sort -u > "${OUT_DIR}/presets.txt"
grep '^fail' "${VALIDATION}" | cut -f2 | preset_id | sort -u > "${OUT_DIR}/invalid-presets.txt" || true
# "validate <id>  # reason"; ids are preset file names and may contain spaces.
grep -E '^[[:space:]]*validate[[:space:]]' "${LEDGER}" 2>/dev/null | sed -E 's/#.*//; s/^[[:space:]]*validate[[:space:]]+//; s/[[:space:]]+$//' | sort -u > "${OUT_DIR}/ledger-validate.txt" || true

echo "naga: ${modules} modules, ${failed_modules} rejected"
status=0
for corpus in tests custom weeks; do
    total=$(grep -c "^${corpus}/" "${OUT_DIR}/presets.txt" || true)
    invalid=$(grep -c "^${corpus}/" "${OUT_DIR}/invalid-presets.txt" || true)
    valid=$((total - invalid))
    if [ "${total}" -gt 0 ]; then
        rate=$(awk -v v="${valid}" -v t="${total}" 'BEGIN { printf "%.1f", 100 * v / t }')
        echo "  ${corpus}: ${valid}/${total} presets with shaders naga-valid (${rate}%)"
        if [ "${corpus}" = "custom" ] && awk -v v="${valid}" -v t="${total}" 'BEGIN { exit !(v / t < 0.95) }'; then
            echo "error: presets/custom is below the 95% bar" >&2
            status=1
        fi
    fi
done

new_failures=$(comm -23 "${OUT_DIR}/invalid-presets.txt" "${OUT_DIR}/ledger-validate.txt")
fixed=$(comm -13 "${OUT_DIR}/invalid-presets.txt" "${OUT_DIR}/ledger-validate.txt")
if [ -n "${new_failures}" ]; then
    echo "error: naga rejects the WGSL of presets wgsl_known_failures.txt does not list:" >&2
    while IFS= read -r id; do
        echo "  ${id}" >&2
        stem="${id%.milk}"
        for error in "${ERRORS_DIR}/$(echo "${stem}" | tr '/' '_')".*.txt; do
            [ -f "${error}" ] && sed -e 's/\x1b\[[0-9;]*m//g' "${error}" | head -n 8 | sed 's/^/      /' >&2
        done
    done <<< "${new_failures}"
    status=1
fi
if [ -n "${fixed}" ]; then
    echo "error: listed in wgsl_known_failures.txt but naga-valid now (delete their lines):" >&2
    echo "${fixed}" | sed 's/^/  /' >&2
    status=1
fi

[ "${status}" -eq 0 ] && echo "WGSL corpus check passed."
exit "${status}"
