#!/usr/bin/env bash
# ================================================
# check_core_host_public_api.sh
#
# Guards the migration of html/projectm-core.html to the shared host layer.
#
# The core shell must drive all public engine operations through the generated
# WASM API (html/generated/projectm-wasm-api.js) or through ProjectMContext /
# <project-m-visualizer>, NOT through raw `Module._<sym>` / `Module.ccall(...)`
# calls. This gate fails if projectm-core.html reintroduces raw public-API
# calls outside the temporary allowlist below.
#
# Render-worker / perf internals that legitimately proxy ccalls through the
# render-worker handle (renderWorkerHandle.ccallVoid(...)) are NOT matched here
# because they do not touch the `Module` object directly.
#
# Usage:
#   scripts/check_core_host_public_api.sh
#
# Exit codes:
#   0 - no disallowed raw public-API calls found
#   1 - disallowed raw `Module._`/`Module.ccall` public-API calls found
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_HOST="$PROJECT_ROOT/html/projectm-core.html"

if [[ ! -f "$CORE_HOST" ]]; then
    echo "ERROR: core host not found: $CORE_HOST" >&2
    exit 1
fi

# Allowlist of raw `Module._*` symbols that may remain temporarily. These are
# worker/perf/lifecycle internals, not public engine ops. Keep this list SMALL
# and shrinking. Public engine ops (set_window_size, set_aspect_correction,
# set_transparency_*, set_preset_locked, start_render, load_preset_file,
# add_preset_file, switch_preset, set_mesh, set_target_fps, ...) must NOT be
# added here — route them through the generated API or ProjectMContext.
ALLOWLIST_REGEX='Module\._(init)\b'

# Match direct raw public-API calls on the Module object:
#   Module._<something>       (property/function access, not in a comment)
#   Module.ccall(...)
# We strip comment-only lines first, then drop allowlisted symbols.
violations="$(
    grep -nE 'Module\._[A-Za-z]|Module\.ccall' "$CORE_HOST" \
        | grep -vE '^\s*[0-9]+:\s*//' \
        | grep -vE '//.*Module\._init' \
        | grep -vE "$ALLOWLIST_REGEX" \
        || true
)"

if [[ -n "$violations" ]]; then
    echo "FAIL: html/projectm-core.html contains raw Module._/Module.ccall public-API calls." >&2
    echo "Route public engine ops through html/generated/projectm-wasm-api.js or ProjectMContext." >&2
    echo "" >&2
    echo "$violations" >&2
    exit 1
fi

echo "OK: html/projectm-core.html has no raw Module._/Module.ccall public-API calls."
