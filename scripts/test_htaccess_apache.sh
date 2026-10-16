#!/usr/bin/env bash
# Serve html/.htaccess from a local Apache configured like DreamHost's shared
# hosting, then run scripts/check_production_headers.mjs against it.
#
# The server config reproduces what production does on its own, which the
# .htaccess has to override: on-the-fly mod_deflate for JS/JSON/WASM/HTML,
# `Vary: User-Agent`, `.js` as application/x-javascript, auto-indexes
# everywhere, a two-day mod_expires default, and DreamHost's ErrorDocument
# redirect for missing files.
#
# Usage:
#   scripts/test_htaccess_apache.sh [<site-dir>|--fixture] [port] [check args...]
#     <site-dir>  a staged deploy tree: pm/ (builds.json + bundles, as written by
#                 generate_wasm_builds_manifest.mjs --precompress), songs/
#                 (index.json/index.html + at least one .flac). The script copies
#                 html/.htaccess and html/projectm_panel2.1ink (as 1ink.1ink,
#                 UTF-8 + BOM like deploy.py) into it.
#     --fixture   (the default) stage a throwaway site instead: a stand-in build
#                 999 (tiny glue + wasm, plus a legacy .1ijs), the FLAC test
#                 fixtures as songs/, and both manifests from the real
#                 generators. No WASM build needed; this is what CI runs.
#
# Needs apache2 (Debian/Ubuntu layout: /usr/sbin/apache2, /usr/lib/apache2/modules).

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_ARG="${1:---fixture}"
PORT="${2:-18081}"
APACHE_BIN="${APACHE_BIN:-/usr/sbin/apache2}"
# HTACCESS=<file> tests another version (e.g. the one deployed today).
HTACCESS="${HTACCESS:-$PROJECT_ROOT/html/.htaccess}"
MODULES="${APACHE_MODULES:-/usr/lib/apache2/modules}"

[[ -x "$APACHE_BIN" ]] || { echo "SKIP: $APACHE_BIN not found (apt-get install apache2)" >&2; exit 77; }

RUN="$(mktemp -d "${TMPDIR:-/tmp}/projectm-apache.XXXXXX")"
cleanup() {
    if [[ -f "$RUN/httpd.pid" ]]; then kill "$(cat "$RUN/httpd.pid")" 2>/dev/null || true; fi
    sleep 0.3
    rm -rf "$RUN"
}
trap cleanup EXIT

check_args=("${@:3}")
if [[ "$SITE_ARG" == "--fixture" ]]; then
    SITE="$RUN/site"
    mkdir -p "$SITE/pm" "$SITE/songs"
    bundle="projectm-v.999-thread"
    {
        printf 'var createModule=(()=>{});'
        for name in init render_frame set_rhythm_events; do
            printf 'var _%s=Module["_%s"]=wasmExports["%s"];' "$name" "$name" "${name:0:2}"
        done
        # Enough text for the compressors to have something to do.
        for i in $(seq 200); do printf 'function f%d(){return %d}' "$i" "$i"; done
        printf 'var wasmBinaryFile="%s.wasm";\n' "$bundle"
    } > "$SITE/pm/$bundle.js"
    { printf '\0asm\1\0\0\0'; head -c 4096 /dev/zero; } > "$SITE/pm/$bundle.wasm"
    iconv -f UTF-8 -t UTF-16 "$SITE/pm/$bundle.js" > "$SITE/pm/$bundle.1ijs"
    cp "$PROJECT_ROOT"/tests/web/fixtures/flac/*.flac "$SITE/songs/"
    node "$PROJECT_ROOT/scripts/generate_wasm_builds_manifest.mjs" --root "$SITE" --default 999 --precompress >/dev/null
    node "$PROJECT_ROOT/scripts/generate_songs_manifest.mjs" --dir "$SITE/songs" >/dev/null
    [[ ${#check_args[@]} -gt 0 ]] || check_args=(--builds 999)
else
    SITE="$(cd "$SITE_ARG" && pwd)"
fi

cp -f "$HTACCESS" "$SITE/.htaccess"
python3 -I - "$PROJECT_ROOT/html/projectm_panel2.1ink" "$SITE/1ink.1ink" <<'PY'
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_bytes().decode("utf-8-sig")
pathlib.Path(sys.argv[2]).write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
PY
# DreamHost's 404 page lives on another host; a local stand-in keeps the
# redirect shape (302 to an HTML page) without leaving the machine.
echo '<html><body>404</body></html>' > "$SITE/404.1ink"

cat > "$RUN/httpd.conf" <<CONF
ServerRoot "$RUN"
PidFile "$RUN/httpd.pid"
ErrorLog "$RUN/error.log"
LogLevel warn
Listen 127.0.0.1:$PORT
ServerName localhost
LoadModule mpm_event_module $MODULES/mod_mpm_event.so
LoadModule authz_core_module $MODULES/mod_authz_core.so
LoadModule dir_module $MODULES/mod_dir.so
LoadModule mime_module $MODULES/mod_mime.so
LoadModule rewrite_module $MODULES/mod_rewrite.so
LoadModule headers_module $MODULES/mod_headers.so
LoadModule filter_module $MODULES/mod_filter.so
LoadModule deflate_module $MODULES/mod_deflate.so
LoadModule setenvif_module $MODULES/mod_setenvif.so
LoadModule autoindex_module $MODULES/mod_autoindex.so
LoadModule expires_module $MODULES/mod_expires.so
TypesConfig /etc/mime.types
DocumentRoot "$SITE"
DirectoryIndex index.html
ErrorDocument 404 http://127.0.0.1:$PORT/404.1ink
<Directory "$SITE">
    Options +Indexes +FollowSymLinks
    AllowOverride All
    Require all granted
</Directory>
# --- DreamHost-like server defaults the .htaccess must override ---
AddType application/x-javascript .js
AddEncoding x-gzip .gz
AddOutputFilterByType DEFLATE text/html text/plain text/javascript application/javascript application/x-javascript application/json application/wasm
Header append Vary User-Agent
ExpiresActive On
ExpiresDefault "access plus 2 days"
ExpiresByType text/html "access plus 10 minutes"
CONF

"$APACHE_BIN" -f "$RUN/httpd.conf" -k start
for _ in $(seq 50); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
    sleep 0.1
done

status=0
node "$PROJECT_ROOT/scripts/check_production_headers.mjs" "http://127.0.0.1:$PORT" "${check_args[@]}" || status=$?
if [[ -s "$RUN/error.log" ]] && grep -v "AH00558\|AH00489\|AH00094\|AH02155\|caught SIGTERM" "$RUN/error.log" | grep -q .; then
    echo "--- apache error.log"
    cat "$RUN/error.log"
fi
exit "$status"
