#!/usr/bin/env bash
# ================================================
# check_core_host_public_api.sh
#
# Guards the host-layer migration (Epic #163): public engine ops on every
# first-party host under html/ must go through the generated WASM API
# (html/generated/projectm-wasm-api.js) or ProjectMContext /
# <project-m-visualizer>, NOT through raw `Module._<sym>` / `Module.ccall(...)`
# calls. `projectm.1ink`, `projectm_new.1ink`, and `projectm_panel.1ink` are
# redirect stubs (see html/README.md ".1ink Deprecation Path") and trivially
# pass since they make no Module calls at all.
#
# Render-worker / perf internals that legitimately proxy ccalls through the
# render-worker handle (renderWorkerHandle.ccallVoid(...)) are NOT matched here
# because they do not touch the `Module` object directly.
#
# Usage:
#   scripts/check_core_host_public_api.sh
#
# Exit codes:
#   0 - no disallowed raw public-API calls found on any gated host
#   1 - disallowed raw `Module._`/`Module.ccall` public-API calls found
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Every first-party host under html/ must stay clean of raw Module._ /
# Module.ccall public-API calls. Add new hosts here as they are created.
HOSTS=(
    "$PROJECT_ROOT/html/projectm-core.html"
    "$PROJECT_ROOT/html/embed-demo.html"
    "$PROJECT_ROOT/html/embed-multi-iframe.html"
    "$PROJECT_ROOT/html/embed-multi-same-module.html"
    "$PROJECT_ROOT/html/projectm_panel2.1ink"
    "$PROJECT_ROOT/html/projectm_panel.1ink"
    "$PROJECT_ROOT/html/projectm.1ink"
    "$PROJECT_ROOT/html/projectm_new.1ink"
    "$PROJECT_ROOT/html/projectm_test.1ink"
)

# Allowlist of raw `Module._*` symbols that may remain temporarily. These are
# worker/perf/lifecycle internals, not public engine ops. Keep this list SMALL
# and shrinking. Public engine ops (set_window_size, set_aspect_correction,
# set_transparency_*, set_preset_locked, start_render, load_preset_file,
# add_preset_file, switch_preset, set_mesh, set_target_fps, ...) must NOT be
# added here — route them through the generated API or ProjectMContext.
ALLOWLIST_REGEX='Module\._(init)\b'

failed=0

for host in "${HOSTS[@]}"; do
    rel="${host#"$PROJECT_ROOT/"}"

    if [[ ! -f "$host" ]]; then
        echo "ERROR: gated host not found: $rel" >&2
        failed=1
        continue
    fi

    # Match direct raw public-API calls on the Module object:
    #   Module._<something>       (property/function access, not in a comment)
    #   Module.ccall(...)
    # We strip comment-only lines first, then drop allowlisted symbols.
    violations="$(
        grep -nE 'Module\._[A-Za-z]|Module\.ccall' "$host" \
            | grep -vE '^\s*[0-9]+:\s*//' \
            | grep -vE '//.*Module\._init' \
            | grep -vE "$ALLOWLIST_REGEX" \
            || true
    )"

    if [[ -n "$violations" ]]; then
        echo "FAIL: $rel contains raw Module._/Module.ccall public-API calls." >&2
        echo "Route public engine ops through html/generated/projectm-wasm-api.js or ProjectMContext." >&2
        echo "" >&2
        echo "$violations" >&2
        echo "" >&2
        failed=1
    else
        echo "OK: $rel has no raw Module._/Module.ccall public-API calls."
    fi
done

if [[ "$failed" -ne 0 ]]; then
    exit 1
fi
