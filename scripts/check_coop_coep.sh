#!/bin/bash
# ================================================
# check_coop_coep.sh
#
# Verifies that a deployed page sends the Cross-Origin-Opener-Policy (COOP) and
# Cross-Origin-Embedder-Policy (COEP) headers required for SharedArrayBuffer /
# pthreads / WASM_WORKERS (see CMakeLists.txt's `-s SHARED_MEMORY=1 -pthread
# -s WASM_WORKERS=1` flags and docs/DEPLOYMENT.md).
#
# Without these headers, `window.crossOriginIsolated` is false in the browser and
# this pthread-enabled WASM build cannot run.
#
# Usage:
#   scripts/check_coop_coep.sh [URL]
#
# Examples:
#   scripts/check_coop_coep.sh
#   scripts/check_coop_coep.sh https://staging.projectm.1ink.us/
#
# Exit codes:
#   0 - both headers present with an accepted value
#   1 - one or both headers missing or have an unexpected value
#   2 - curl request failed
# ================================================

set -u

URL="${1:-https://projectm.1ink.us/}"

echo "Checking COOP/COEP headers on: ${URL}"

headers=$(curl -sS -D - -o /dev/null "${URL}")
status=$?

if [ "${status}" -ne 0 ]; then
    echo "ERROR: curl failed to fetch ${URL} (exit code ${status})"
    exit 2
fi

coop=$(echo "${headers}" | grep -i '^cross-origin-opener-policy:' | tr -d '\r')
coep=$(echo "${headers}" | grep -i '^cross-origin-embedder-policy:' | tr -d '\r')

ok=1

if echo "${coop}" | grep -qi 'same-origin'; then
    echo "  OK   ${coop}"
else
    echo "  FAIL Cross-Origin-Opener-Policy: same-origin not found (got: '${coop:-<missing>}')"
    ok=0
fi

if echo "${coep}" | grep -qiE 'require-corp|credentialless'; then
    echo "  OK   ${coep}"
else
    echo "  FAIL Cross-Origin-Embedder-Policy: require-corp or credentialless not found (got: '${coep:-<missing>}')"
    ok=0
fi

if [ "${ok}" -eq 1 ]; then
    echo "Cross-origin isolation headers OK."
    exit 0
else
    echo "Cross-origin isolation headers missing or incorrect. See docs/DEPLOYMENT.md."
    exit 1
fi
