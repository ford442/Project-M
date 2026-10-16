#!/usr/bin/env bash
# One-time conversion of WASM builds that were only ever deployed with UTF-16
# `.1ijs` glue (030b, 032, 033, 034) into the UTF-8 `pm/…js` layout every
# other build uses. After this, scripts/generate_wasm_builds_manifest.mjs lists
# them, html/.htaccess redirects their old `.1ijs` URLs to the `.js`, and no
# host needs to load UTF-16 JavaScript again.
#
# The glue text is unchanged (iconv only), so the `.js` still matches the
# `.wasm` it shipped with; that `.wasm` is downloaded next to it, which also
# moves 030b/032 (deployed only at the site root) under pm/.
#
# Usage:
#   scripts/transcode_legacy_glue.sh [site-url] [root] [version ...]
#   scripts/transcode_legacy_glue.sh https://projectm.1ink.us . 030b 032 033 034
# Then:
#   node scripts/generate_wasm_builds_manifest.mjs --merge https://projectm.1ink.us/pm/builds.json --precompress
#   python deploy.py --dry-run   # pm/projectm-v.0{30b,32,33,34}-thread.{js,wasm} are listed

set -euo pipefail

SITE="${1:-https://projectm.1ink.us}"
SITE="${SITE%/}"
ROOT="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
shift $(( $# > 2 ? 2 : $# ))
VERSIONS=("$@")
if [[ ${#VERSIONS[@]} -eq 0 ]]; then
    VERSIONS=(030b 032 033 034)
fi

command -v iconv >/dev/null || { echo "ERROR: iconv not found" >&2; exit 1; }
mkdir -p "$ROOT/pm"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/projectm-transcode.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# fetch REL OUT -> 0 when the site serves REL itself (200, not a 302 to the 404 page)
fetch() {
    local code
    code="$(curl -sS -o "$2" -w '%{http_code}' "$SITE/$1" || echo 000)"
    [[ "$code" == "200" ]]
}

failures=0
for version in "${VERSIONS[@]}"; do
    bundle="projectm-v.${version}-thread"
    src=""
    for rel in "pm/$bundle.1ijs" "$bundle.1ijs"; do
        if fetch "$rel" "$tmp/$bundle.1ijs"; then src="$rel"; break; fi
    done
    if [[ -z "$src" ]]; then
        echo "✗ $version: no $bundle.1ijs on $SITE (pm/ or root)"; failures=$((failures + 1)); continue
    fi
    if [[ "$(head -c 2 "$tmp/$bundle.1ijs" | od -An -tx1 | tr -d ' ')" != "fffe" ]]; then
        echo "✗ $version: $src is not UTF-16 LE with BOM"; failures=$((failures + 1)); continue
    fi
    wasm_src=""
    for rel in "${src%"$bundle.1ijs"}$bundle.wasm" "pm/$bundle.wasm" "$bundle.wasm"; do
        if fetch "$rel" "$tmp/$bundle.wasm" && [[ "$(head -c 4 "$tmp/$bundle.wasm" | od -An -tx1 | tr -d ' ')" == "0061736d" ]]; then
            wasm_src="$rel"; break
        fi
    done
    if [[ -z "$wasm_src" ]]; then
        echo "✗ $version: no $bundle.wasm next to $src"; failures=$((failures + 1)); continue
    fi

    iconv -f UTF-16 -t UTF-8 "$tmp/$bundle.1ijs" > "$tmp/$bundle.js"
    if LC_ALL=C grep -q -P '[^\x00-\x7F]' "$tmp/$bundle.js"; then
        echo "✗ $version: transcoded glue is not pure ASCII; inspect it before deploying"; failures=$((failures + 1)); continue
    fi
    if ! grep -q "$bundle.wasm" "$tmp/$bundle.js"; then
        echo "✗ $version: glue does not reference $bundle.wasm"; failures=$((failures + 1)); continue
    fi
    cp -f "$tmp/$bundle.js" "$ROOT/pm/$bundle.js"
    cp -f "$tmp/$bundle.wasm" "$ROOT/pm/$bundle.wasm"
    echo "✓ $version: $src -> pm/$bundle.js ($(wc -c < "$ROOT/pm/$bundle.js") bytes), wasm from $wasm_src"
done

exit $(( failures > 0 ? 1 : 0 ))
