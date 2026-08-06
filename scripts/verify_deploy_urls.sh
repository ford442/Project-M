#!/usr/bin/env bash
# Verify deployed WASM + host assets return real artifacts (not HTML soft-404s).
#
# Usage:
#   scripts/verify_deploy_urls.sh [BASE_URL] [BUNDLE projectm-v.035-thread]
#
# Example:
#   scripts/verify_deploy_urls.sh https://projectm.1ink.us/ projectm-v.035-thread

set -euo pipefail

BASE_URL="${1:-https://projectm.1ink.us/}"
BUNDLE="${2:-projectm-v.035-thread}"
BASE_URL="${BASE_URL%/}"
SMOKE_BUNDLE="projectm-v.030-thread"

BODY="$(mktemp "${TMPDIR:-/tmp}/projectm-verify.XXXXXX")"
trap 'rm -f "$BODY"' EXIT

failures=0

fetch_url() {
    # $1 = url, writes body to $BODY, prints "STATUS|CONTENT_TYPE"
    local fetch_url="$1"
    curl -sS -L --max-redirs 5 -o "$BODY" -w "%{http_code}|%{content_type}" "$fetch_url" || echo "000|"
}

check_one() {
    local rel="$1"
    local kind="$2" # required | optional-worker | optional-js
    local url="${BASE_URL}/${rel}"
    local meta status ctype

    meta="$(fetch_url "$url" || echo "000|")"
    status="${meta%%|*}"
    ctype="${meta#*|}"

    if [[ "$kind" == "optional-worker" ]]; then
        if [[ "$status" != "200" ]] || grep -qi 'text/html' <<<"$ctype"; then
            echo "  ~ $rel -> HTTP $status ($ctype) (optional for pthread-main-script builds)"
            return 0
        fi
    fi

    if [[ "$kind" == "optional-js" ]]; then
        if [[ "$status" != "200" ]] || grep -qi 'text/html' <<<"$ctype"; then
            echo "  ~ $rel -> HTTP $status ($ctype) (optional UTF-8 glue)"
            return 0
        fi
    fi

    if [[ "$status" != "200" ]]; then
        echo "  ✗ $rel -> HTTP $status"
        return 1
    fi

    # Soft-404 HTML is OK only for real host pages.
    if grep -qi 'text/html' <<<"$ctype"; then
        if [[ "$rel" == *.1ink || "$rel" == *.html ]]; then
            echo "  ✓ $rel -> HTTP $status ($ctype)"
            return 0
        fi
        echo "  ✗ $rel -> HTTP $status but Content-Type is HTML ($ctype)"
        return 1
    fi

    if [[ "$rel" == *.wasm ]]; then
        local magic
        magic="$(python3 -c "from pathlib import Path; print(Path(r'''$BODY''').read_bytes()[:4].hex())")"
        if [[ "$magic" != "0061736d" ]]; then
            echo "  ✗ $rel -> missing WASM magic 00 61 73 6d (got $magic); often a UTF-16 HTML 404"
            return 1
        fi
        if ! grep -qiE 'application/wasm|application/octet-stream' <<<"$ctype"; then
            echo "  ✗ $rel -> unexpected Content-Type for wasm: $ctype"
            return 1
        fi
    fi

    if [[ "$rel" == "${BUNDLE}.js" || "$rel" == "pm/${BUNDLE}.js" ]]; then
        if grep -q "$SMOKE_BUNDLE" "$BODY" && [[ "$BUNDLE" != "$SMOKE_BUNDLE" ]]; then
            echo "  ✗ $rel -> still embeds $SMOKE_BUNDLE (locateFile will 404 under pm/)"
            return 1
        fi
        if ! grep -q "${BUNDLE}.wasm" "$BODY"; then
            echo "  ✗ $rel -> missing ${BUNDLE}.wasm reference"
            return 1
        fi
    fi

    if [[ "$rel" == "${BUNDLE}.1ijs" || "$rel" == "pm/${BUNDLE}.1ijs" ]]; then
        local py_rc=0
        python3 - "$BODY" "$BUNDLE" "$SMOKE_BUNDLE" <<'PY' || py_rc=$?
import pathlib, sys
raw = pathlib.Path(sys.argv[1]).read_bytes()
bundle, smoke = sys.argv[2], sys.argv[3]
if raw.startswith(b"\xff\xfe"):
    text = raw.decode("utf-16")
elif len(raw) > 4 and raw[1] == 0 and raw[3] == 0:
    text = raw.decode("utf-16-le")
else:
    text = raw.decode("utf-8", errors="replace")
if smoke in text and bundle != smoke:
    raise SystemExit(1)
if f"{bundle}.wasm" not in text:
    raise SystemExit(2)
PY
        if [[ "$py_rc" -eq 1 ]]; then
            echo "  ✗ $rel -> still embeds $SMOKE_BUNDLE (locateFile will 404 under pm/)"
            return 1
        fi
        if [[ "$py_rc" -ne 0 ]]; then
            echo "  ✗ $rel -> missing ${BUNDLE}.wasm reference"
            return 1
        fi
    fi

    echo "  ✓ $rel -> HTTP $status ($ctype)"
    return 0
}

required_paths=(
    "${BUNDLE}.wasm"
    "${BUNDLE}.1ijs"
    "${BUNDLE}.3ijs"
    "pm/${BUNDLE}.wasm"
    "pm/${BUNDLE}.1ijs"
    "pm/${BUNDLE}.3ijs"
    "projectm-init.js"
    "projectm_panel2.1ink"
    "projectm-audio-bootstrap.js"
    "projectm-external-pcm.js"
    "projectm-presets.js"
)

for rel in "${required_paths[@]}"; do
    if ! check_one "$rel" required; then
        failures=$((failures + 1))
    fi
done

for rel in "${BUNDLE}.worker.js" "pm/${BUNDLE}.worker.js"; do
    if ! check_one "$rel" optional-worker; then
        failures=$((failures + 1))
    fi
done

for rel in "${BUNDLE}.js" "pm/${BUNDLE}.js"; do
    if ! check_one "$rel" optional-js; then
        failures=$((failures + 1))
    fi
done

echo
if [[ "$failures" -gt 0 ]]; then
    echo "$failures URL check(s) failed. A missing .1ijs/.wasm under pm/ often"
    echo "shows in the browser as 'Unexpected token <' or WASM magic 3c 00 21 00"
    echo "(UTF-16 HTML ErrorDocument) because Apache soft-404s missing files."
    echo
    echo "If the glue still embeds ${SMOKE_BUNDLE}.wasm after a version rename:"
    echo "  scripts/prepare_deploy_bundle.sh   # renames files AND rewrites glue strings"
    echo "  python deploy.py --dry-run"
    echo "  export DEPLOY_TOKEN=... && python deploy.py"
    exit 1
fi

echo "All required deploy URLs look good."
