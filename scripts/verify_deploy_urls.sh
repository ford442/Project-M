#!/usr/bin/env bash
# Verify deployed WASM + host assets return 200 (not HTML 404 pages).
#
# Usage:
#   scripts/verify_deploy_urls.sh [BASE_URL] [BUNDLE projectm-v.034-thread]
#
# Example:
#   scripts/verify_deploy_urls.sh https://projectm.1ink.us/ projectm-v.034-thread

set -euo pipefail

BASE_URL="${1:-https://projectm.1ink.us/}"
BUNDLE="${2:-projectm-v.035-thread}"
BASE_URL="${BASE_URL%/}"

paths=(
    "${BUNDLE}.wasm"
    "${BUNDLE}.1ijs"
    "${BUNDLE}.3ijs"
    "pm/${BUNDLE}.wasm"
    "pm/${BUNDLE}.1ijs"
    "pm/${BUNDLE}.3ijs"
    "${BUNDLE}.worker.js"
    "pm/${BUNDLE}.worker.js"
    "projectm-init.js"
    "projectm_panel2.1ink"
    "projectm-audio-bootstrap.js"
    "projectm-external-pcm.js"
    "projectm-presets.js"
)

failures=0
for rel in "${paths[@]}"; do
    url="${BASE_URL}/${rel}"
    status=$(curl -sS -o /dev/null -w "%{http_code}" -I "$url" || echo "000")
    # worker.js is optional on newer Emscripten (pthread reuses the main .1ijs),
    # but a 302/HTML redirect still indicates a broken host config.
    if [[ "$status" == "404" && ( "$rel" == *".worker.js" ) ]]; then
        echo "  ~ $rel -> HTTP $status (optional for pthread-main-script builds)"
        continue
    fi
    if [[ "$status" != "200" ]]; then
        echo "  ✗ $rel -> HTTP $status"
        failures=$((failures + 1))
    else
        echo "  ✓ $rel -> HTTP $status"
    fi
done

echo
if [[ "$failures" -gt 0 ]]; then
    echo "$failures required URL(s) failed. A missing .1ijs/.wasm under pm/ often"
    echo "shows in the browser as 'Unexpected token <' because Apache serves HTML 404."
    exit 1
fi

echo "All required deploy URLs look good."
