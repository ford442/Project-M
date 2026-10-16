#!/usr/bin/env bash
# Verify deployed WASM + host assets return real artifacts (not HTML soft-404s).
#
# Usage:
#   scripts/verify_deploy_urls.sh [BASE_URL] [BUNDLE projectm-v.039-thread]
#
# Example:
#   scripts/verify_deploy_urls.sh https://projectm.1ink.us/ projectm-v.039-thread

set -euo pipefail

BASE_URL="${1:-https://projectm.1ink.us/}"
BUNDLE="${2:-projectm-v.039-thread}"
BASE_URL="${BASE_URL%/}"
SMOKE_BUNDLE="projectm-v.030-thread"

BODY="$(mktemp "${TMPDIR:-/tmp}/projectm-verify.XXXXXX")"
RAW_BODY="$(mktemp "${TMPDIR:-/tmp}/projectm-verify-raw.XXXXXX")"
RAW_HEADERS="$(mktemp "${TMPDIR:-/tmp}/projectm-verify-hdr.XXXXXX")"
trap 'rm -f "$BODY" "$RAW_BODY" "$RAW_HEADERS"' EXIT

# What a browser sends. fetch_url() below sends no Accept-Encoding, so the server
# answers identity and never exercises mod_deflate; check_transport() asks for
# compression the way Chrome does and inspects the bytes undecoded.
BROWSER_UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
TRANSPORT_NOTE=""

failures=0

fetch_url() {
    # $1 = url, writes body to $BODY, prints "STATUS|CONTENT_TYPE"
    local fetch_url="$1"
    curl -sS -L --max-redirs 5 -o "$BODY" -w "%{http_code}|%{content_type}" "$fetch_url" || echo "000|"
}

# check_transport REL URL
# For JS/WASM artifacts: fetch like a browser WITHOUT letting curl decode, then assert
#   - at most one Content-Encoding layer (a second one is ERR_CONTENT_DECODING_FAILED),
#   - the declared encoding really decodes (truncated/corrupt gzip is the same error),
#   - the decoded body is not itself still compressed (double gzip),
#   - the decoded body starts with the right bytes (ASCII JS, \0asm, UTF-16/32 BOM),
#   - .js is served as a JavaScript MIME type with charset=utf-8.
# Sets TRANSPORT_NOTE on success.
check_transport() {
    local rel="$1" url="$2"
    TRANSPORT_NOTE=""
    case "$rel" in
        *.js | *.wasm | *.1ijs | *.3ijs) ;;
        *) return 0 ;;
    esac

    if ! curl -sS -L --max-redirs 5 -A "$BROWSER_UA" -H 'Accept-Encoding: gzip, deflate' \
        -D "$RAW_HEADERS" -o "$RAW_BODY" "$url"; then
        echo "  ✗ $rel -> transport fetch failed"
        return 1
    fi

    local out rc=0
    out="$(python3 -I - "$rel" "$RAW_HEADERS" "$RAW_BODY" <<'PY'
import gzip, pathlib, re, sys, zlib

rel, hdr_path, body_path = sys.argv[1:4]
raw = pathlib.Path(body_path).read_bytes()
text = pathlib.Path(hdr_path).read_text("latin-1").replace("\r", "")
blocks = [b for b in text.split("\n\n") if b.strip()]
headers = {}
for line in blocks[-1].split("\n")[1:]:
    if ":" in line:
        name, value = line.split(":", 1)
        headers.setdefault(name.strip().lower(), []).append(value.strip())


def fail(message):
    print(message)
    sys.exit(1)


encodings = [t.strip().lower() for v in headers.get("content-encoding", []) for t in v.split(",")]
encodings = [t for t in encodings if t and t != "identity"]
if len(encodings) > 1:
    fail(f"{len(encodings)} Content-Encoding layers ({', '.join(encodings)}); browsers fail with ERR_CONTENT_DECODING_FAILED")

body = raw
for enc in reversed(encodings):
    try:
        if enc in ("gzip", "x-gzip"):
            body = gzip.decompress(body)
        elif enc == "deflate":
            try:
                body = zlib.decompress(body)
            except zlib.error:
                body = zlib.decompress(body, -zlib.MAX_WBITS)
        else:
            fail(f"unexpected Content-Encoding '{enc}' (only gzip/deflate were offered)")
    except (OSError, EOFError, zlib.error) as exc:
        fail(f"Content-Encoding {enc} body does not decode ({exc}); browsers fail with ERR_CONTENT_DECODING_FAILED")

if body[:2] == b"\x1f\x8b":
    fail("body is still gzip after removing Content-Encoding (compressed twice, or a .gz stored under this name)")

if rel.endswith(".wasm"):
    if body[:4] != b"\0asm":
        fail(f"decoded body is not WASM (starts {body[:4].hex()})")
elif rel.endswith(".1ijs"):
    if body[:2] != b"\xff\xfe" or body[:4] == b"\xff\xfe\0\0":
        fail(f"decoded body is not UTF-16 LE with BOM (starts {body[:4].hex()})")
elif rel.endswith(".3ijs"):
    if body[:4] != b"\xff\xfe\0\0":
        fail(f"decoded body is not UTF-32 LE with BOM (starts {body[:4].hex()})")
else:
    head = body[:64]
    if not head or b"\0" in head or any(b >= 0x80 for b in head) or head.lstrip().startswith(b"<"):
        fail(f"decoded body does not start with ASCII JavaScript (starts {head[:16].hex()})")
    ctype = (headers.get("content-type") or [""])[-1].lower()
    if not re.match(r"^(text|application)/javascript\b", ctype) or "charset=utf-8" not in ctype:
        fail(f"Content-Type is '{ctype or '<missing>'}', expected text/javascript; charset=utf-8")

print("encoding=" + ("+".join(encodings) if encodings else "identity"))
PY
    )" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
        echo "  ✗ $rel -> $out"
        return 1
    fi
    TRANSPORT_NOTE=" [$out]"
    return 0
}

check_one() {
    local rel="$1"
    local kind="$2" # required | optional-worker | optional-js | legacy-glue
    local url="${BASE_URL}/${rel}"
    local meta status ctype

    # UTF-16/32 glue is no longer deployed (prepare_deploy_bundle.sh); html/.htaccess
    # redirects these URLs to the UTF-8 .js. Accept that redirect, a legacy file
    # that still works, or nothing at all.
    if [[ "$kind" == "legacy-glue" ]]; then
        local head_meta head_status location
        head_meta="$(curl -sS -o /dev/null -w "%{http_code}|%{redirect_url}" "$url" || echo "000|")"
        head_status="${head_meta%%|*}"
        location="${head_meta#*|}"
        if [[ "$head_status" == "301" || "$head_status" == "308" ]]; then
            if [[ "$location" == *"/${rel%.*}.js" ]]; then
                echo "  ✓ $rel -> $head_status to the UTF-8 glue"
                return 0
            fi
            echo "  ✗ $rel -> $head_status to $location (expected ${rel%.*}.js)"
            return 1
        fi
        if [[ "$head_status" != "200" ]]; then
            echo "  ~ $rel -> HTTP $head_status (legacy glue not deployed; fine)"
            return 0
        fi
    fi

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
            local bom coop coep
            bom="$(python3 -c "from pathlib import Path; print(Path(r'''$BODY''').read_bytes()[:2].hex())")"
            # deploy.py ships .1ink hosts as UTF-8 + BOM (older deploys: UTF-16 LE + BOM).
            # A BOM decides the encoding before the header charset; without one the
            # page is at the mercy of the header.
            if [[ "$rel" == *.1ink ]]; then
                if [[ "$bom" != "fffe" && "$bom" != "feff" && "$bom" != "efbb" ]]; then
                    echo "  ✗ $rel -> no BOM (got $bom); the Content-Type charset ($ctype) decides how it decodes"
                    return 1
                fi
            elif grep -qi 'charset=utf-16' <<<"$ctype"; then
                if [[ "$bom" != "fffe" && "$bom" != "feff" ]]; then
                    echo "  ✗ $rel -> Content-Type claims utf-16 ($ctype) but body BOM is $bom (expected fffe)"
                    return 1
                fi
            fi
            headers="$(curl -sS -D - -o /dev/null "$url" | tr -d '\r')"
            coop="$(grep -i '^cross-origin-opener-policy:' <<<"$headers" || true)"
            coep="$(grep -i '^cross-origin-embedder-policy:' <<<"$headers" || true)"
            if ! grep -qi 'same-origin' <<<"$coop"; then
                echo "  ✗ $rel -> missing Cross-Origin-Opener-Policy: same-origin (pthread WASM requires COOP/COEP)"
                return 1
            fi
            if ! grep -qiE 'require-corp|credentialless' <<<"$coep"; then
                echo "  ✗ $rel -> missing Cross-Origin-Embedder-Policy (pthread WASM requires COOP/COEP)"
                return 1
            fi
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

    check_transport "$rel" "$url" || return 1

    echo "  ✓ $rel -> HTTP $status ($ctype)${TRANSPORT_NOTE}"
    return 0
}

required_paths=(
    "${BUNDLE}.wasm"
    "pm/${BUNDLE}.wasm"
    "pm/${BUNDLE}.js"
    "projectm-init.js"
    "projectm-wasm-manifest.js"
    "projectm-wasm-default-redirect.js"
    "projectm_panel2.1ink"
    "1ink.1ink"
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

if ! check_one "${BUNDLE}.js" optional-js; then
    failures=$((failures + 1))
fi

for rel in "${BUNDLE}.1ijs" "${BUNDLE}.3ijs" "pm/${BUNDLE}.1ijs" "pm/${BUNDLE}.3ijs"; do
    if ! check_one "$rel" legacy-glue; then
        failures=$((failures + 1))
    fi
done

echo
echo "Headers, pm/builds.json and songs/ are checked by scripts/check_production_headers.mjs."

echo
if [[ "$failures" -gt 0 ]]; then
    echo "$failures URL check(s) failed. A missing .js/.wasm under pm/ often"
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
