#!/usr/bin/env bash
# Prepare WASM + iconv artifacts at the repo root (and pm/ mirror) before deploy.py.
#
# Usage:
#   source /path/to/emsdk/emsdk_env.sh
#   PROJECTM_WASM_VERSION=038 scripts/prepare_deploy_bundle.sh
#
# Then:
#   export DEPLOY_TOKEN=...
#   python deploy.py
#   scripts/verify_deploy_urls.sh https://projectm.1ink.us/
#
# By default this rebuilds before staging: scripts/build_wasm_install.sh
# (incremental configure + build + install of the static libs) and then
# scripts/build_wasm_smoke_wrapper.sh (the final link). Both are cheap when
# nothing changed, and together they make "deployed a bundle older than its
# sources" impossible, which is the point: the golden gate runs in CI, not on
# the machine that runs deploy.py.
#
# PROJECTM_DEPLOY_REUSE_BUILD=1 skips the rebuild (no emsdk needed) and stages
# the existing $OUT_DIR outputs, but only if the source fingerprint recorded
# next to them (projectm-v.030-thread.build-id) matches this tree; see
# scripts/wasm_source_fingerprint.sh.

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR="${INSTALL_DIR:-"$PROJECT_ROOT/install"}"
CMAKE_BUILD_DIR="${CMAKE_BUILD_DIR:-"$PROJECT_ROOT/cmake-build-wasm"}"
OUT_DIR="${OUT_DIR:-"$PROJECT_ROOT/cmake-build/wasm-smoke"}"
PROJECTM_WASM_VERSION="${PROJECTM_WASM_VERSION:-037}"
# Must match scripts/build_wasm_smoke_wrapper.sh output and PROJECTM_WASM_SMOKE_BUNDLE.
SMOKE_BUNDLE="projectm-v.030-thread"

bundle="projectm-v.${PROJECTM_WASM_VERSION}-thread"
# Always stage from the smoke-tag outputs produced by build_wasm_smoke_wrapper.sh.
# Preferring a previously-renamed ${bundle}.* in OUT_DIR silently redeploys a stale
# binary after a fresh 030 rebuild (missed breadcrumbs / fixes during diagnosis).
src_js="$OUT_DIR/${SMOKE_BUNDLE}.js"
src_wasm="$OUT_DIR/${SMOKE_BUNDLE}.wasm"
src_worker="$OUT_DIR/${SMOKE_BUNDLE}.worker.js"
src_symbols="$OUT_DIR/${SMOKE_BUNDLE}.js.symbols"
src_build_id="$OUT_DIR/${SMOKE_BUNDLE}.build-id"

if [[ "${PROJECTM_DEPLOY_REUSE_BUILD:-0}" == "1" ]]; then
    expected_id="$("$PROJECT_ROOT/scripts/wasm_source_fingerprint.sh")"
    recorded_id="$(cat "$src_build_id" 2>/dev/null || true)"
    if [[ "$recorded_id" != "$expected_id" ]]; then
        echo "ERROR: $OUT_DIR was not built from this tree; refusing to deploy it." >&2
        echo "  recorded build-id: ${recorded_id:-<none>}" >&2
        echo "  this tree:         $expected_id" >&2
        echo "Rebuild (drop PROJECTM_DEPLOY_REUSE_BUILD=1, with emsdk activated) and re-run." >&2
        exit 1
    fi
    echo "Reusing $OUT_DIR (build-id $recorded_id matches this tree)" >&2
else
    if ! command -v em++ >/dev/null 2>&1 && ! command -v emcc >/dev/null 2>&1; then
        echo "ERROR: em++/emcc not on PATH; cannot rebuild before staging." >&2
        echo "Activate emsdk first (source /path/to/emsdk/emsdk_env.sh), or set" >&2
        echo "PROJECTM_DEPLOY_REUSE_BUILD=1 to stage an up-to-date existing build." >&2
        exit 1
    fi
    INSTALL_DIR="$INSTALL_DIR" CMAKE_BUILD_DIR="$CMAKE_BUILD_DIR" \
        bash "$PROJECT_ROOT/scripts/build_wasm_install.sh"
    INSTALL_DIR="$INSTALL_DIR" CMAKE_BUILD_DIR="$CMAKE_BUILD_DIR" OUT_DIR="$OUT_DIR" \
        bash "$PROJECT_ROOT/scripts/build_wasm_smoke_wrapper.sh"
fi

if [[ ! -s "$src_js" || ! -s "$src_wasm" || ! -s "$src_build_id" ]]; then
    echo "ERROR: expected $src_js, $src_wasm and $src_build_id" >&2
    exit 1
fi

dest_js="$PROJECT_ROOT/${bundle}.js"
dest_wasm="$PROJECT_ROOT/${bundle}.wasm"
dest_worker="$PROJECT_ROOT/${bundle}.worker.js"
dest_1ijs="$PROJECT_ROOT/${bundle}.1ijs"
dest_3ijs="$PROJECT_ROOT/${bundle}.3ijs"
dest_pm="$PROJECT_ROOT/pm"

cp -f "$src_js" "$dest_js"
cp -f "$src_wasm" "$dest_wasm"
# Function-index -> name map for symbolizing "wasm-function[N]" frames from
# this exact .wasm. Not uploaded (deploy.py's globs do not match it) and not in
# git (.gitignore): keep it with the release notes for the version you deploy.
if [[ -s "$src_symbols" ]]; then
    cp -f "$src_symbols" "$PROJECT_ROOT/${bundle}.symbols"
fi
# deploy.py compares this with the tree it deploys from (same fingerprint).
cp -f "$src_build_id" "$PROJECT_ROOT/${bundle}.build-id"
if [[ -s "$src_worker" ]]; then
    cp -f "$src_worker" "$dest_worker"
fi

# Emscripten bakes the output basename into locateFile("….wasm"). Renaming the
# file alone leaves the glue fetching the smoke tag under ./pm/, which soft-404s
# as UTF-16 HTML (magic 3c 00 21 00) and aborts WebAssembly.instantiate.
rewrite_smoke_bundle_refs() {
    local file="$1"
    [[ -s "$file" ]] || return 0
    if [[ "$bundle" == "$SMOKE_BUNDLE" ]]; then
        return 0
    fi
    if ! grep -q "$SMOKE_BUNDLE" "$file"; then
        # Already rewritten, or a hand-built artifact that used the deploy name.
        # worker.js / ww.js often only reference the main glue URL, not the .wasm name.
        if ! grep -q "${bundle}.wasm" "$file" && [[ "$file" == *.js ]] && [[ "$file" != *worker.js ]] && [[ "$file" != *.ww.js ]]; then
            echo "ERROR: $file has neither $SMOKE_BUNDLE nor ${bundle}.wasm refs" >&2
            exit 1
        fi
        return 0
    fi
    python3 - "$file" "$SMOKE_BUNDLE" "$bundle" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
smoke, target = sys.argv[2], sys.argv[3]
text = path.read_text(encoding="utf-8")
updated = text.replace(smoke, target)
if updated == text:
    raise SystemExit(f"rewrite produced no changes in {path}")
if smoke in updated:
    raise SystemExit(f"smoke bundle refs remain in {path}")
if f"{target}.wasm" not in updated and path.suffix == ".js":
    raise SystemExit(f"expected {target}.wasm reference missing in {path}")
path.write_text(updated, encoding="utf-8")
print(f"Rewrote {smoke} -> {target} in {path.name}")
PY
}

rewrite_smoke_bundle_refs "$dest_js"
if [[ -s "$dest_worker" ]]; then
    rewrite_smoke_bundle_refs "$dest_worker"
fi

iconv -f UTF-8 -t UTF-16 "$dest_js" -o "$dest_1ijs"
iconv -f UTF-8 -t UTF-32 "$dest_js" -o "$dest_3ijs"

mkdir -p "$dest_pm"
for artifact in "$dest_js" "$dest_wasm" "$dest_1ijs" "$dest_3ijs"; do
    cp -f "$artifact" "$dest_pm/"
done
if [[ -s "$dest_worker" ]]; then
    cp -f "$dest_worker" "$dest_pm/"
fi

echo "Prepared deploy artifacts for ${bundle}:"
ls -lh "$dest_js" "$dest_wasm" "$dest_1ijs" "$dest_3ijs"
if [[ -s "$dest_worker" ]]; then
    ls -lh "$dest_worker"
else
    echo "(no separate ${bundle}.worker.js — pthread reuses main glue)"
fi
echo "pm/ mirror:"
ls -lh "$dest_pm/${bundle}."*
