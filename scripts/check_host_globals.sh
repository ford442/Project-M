#!/usr/bin/env bash
# ================================================
# check_host_globals.sh
#
# Guards the "no page-global clobbering" rule for the browser host layer
# (html/README.md, "Page globals"): with two ProjectMContexts on one page, or
# one that is destroyed and started again, a plain `window.pmX = fn` write is a
# bug -- the second writer silently replaces the first, and the first one's
# teardown then nulls the slot the second is using.
#
# Two things are allowed to touch page globals, and nothing else:
#
#   html/projectm-legacy-globals.js   the opt-in shim for the convenience API
#                                     (`window.pmSetTargetFps`, the popup-player
#                                     `cycleAudioPlayer`/`flacPlayer` names, the
#                                     `BroadcastChannel` patch). Only pages that
#                                     still need those import it.
#   html/projectm-wasm-callbacks.js   the WASM -> host callback bus. The engine
#                                     looks up `pmOnPerfFrame` etc. by name, so
#                                     they cannot be opt-in; the bus installs
#                                     each name once and fans out. It (and
#                                     projectm-globals.js) write through
#                                     claimGlobal() with a *variable* name, so
#                                     the patterns below never see a literal.
#
# Every other html/projectm-*.js, and every first-party host page, must not:
#
#   1. assign `window.pm* / globalThis.pm* / windowRef.pm* / self.pm*` (dot or
#      bracket form), or defineProperty a `pm*` name on one of them;
#   2. assign the legacy popup-player names (cycleAudioPlayer, closeAudioPlayer,
#      flacPlayer, modPlayer, openFlacPlayer, openModPlayer) on one of them;
#   3. assign `<global>.BroadcastChannel = ...` (monkey-patching a platform
#      constructor affects every script on the page);
#   4. call claimGlobal() with a literal `pm*` name (that is rule 1 by another
#      route).
#
# To listen to an engine callback use subscribeWasmCallback() from
# projectm-wasm-callbacks.js. To publish a convenience name, add an installer to
# projectm-legacy-globals.js.
#
# Explicit exceptions (each is a separate global scope, not the page):
#
#   html/projectm-render-worker.js    A classic Worker script: it cannot import
#                                     the ES module bus, and its `self` is the
#                                     worker's own scope, which holds exactly
#                                     one engine.
#
# Usage:
#   scripts/check_host_globals.sh
#
# Exit codes:
#   0 - no page-global writes outside the allowed modules
#   1 - at least one violation
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

ALLOWED_FILES=(
    "html/projectm-legacy-globals.js"
    "html/projectm-wasm-callbacks.js"
    "html/projectm-globals.js"
    "html/projectm-render-worker.js"
)

# Modules under html/, plus the first-party host pages (their inline scripts
# were the original source of these writes). Vendored bundles are not ours.
mapfile -t FILES < <(
    {
        find html -maxdepth 1 -type f -name 'projectm-*.js'
        find html -maxdepth 1 -type f \( -name '*.html' -o -name '*.1ink' \)
    } | sort -u
)

GLOBAL_OBJ='(window|globalThis|windowRef|self)'
LEGACY_NAMES='(cycleAudioPlayer|closeAudioPlayer|flacPlayer|modPlayer|openFlacPlayer|openModPlayer)'

# name: extended regex. Each matches an *assignment* (`=` not followed by
# another `=`), so reads such as `window.pmGetFboFormat()` and comparisons are
# fine.
declare -A RULES=(
    ["assigns a window.pm* global"]="${GLOBAL_OBJ}(\\??\\.pm[A-Za-z0-9_]*|\\[['\"]pm[A-Za-z0-9_]*['\"]\\])[[:space:]]*=[^=>]"
    ["defines a pm* property on a page global"]="defineProperty\\([[:space:]]*${GLOBAL_OBJ}[[:space:]]*,[[:space:]]*['\"]pm[A-Za-z0-9_]*['\"]"
    ["assigns a legacy popup-player global"]="${GLOBAL_OBJ}\\??\\.${LEGACY_NAMES}[[:space:]]*=[^=>]"
    ["monkey-patches BroadcastChannel"]="${GLOBAL_OBJ}\\??\\.BroadcastChannel[[:space:]]*=[^=>]"
    ["claims a pm* global by literal name"]="claimGlobal\\([^,()]+,[[:space:]]*['\"]pm[A-Za-z0-9_]*['\"]"
)

is_allowed() {
    local file="$1" allowed
    for allowed in "${ALLOWED_FILES[@]}"; do
        [[ "$file" == "$allowed" ]] && return 0
    done
    return 1
}

failed=0
checked=0

for file in "${FILES[@]}"; do
    if is_allowed "$file"; then
        continue
    fi
    checked=$((checked + 1))

    for rule in "${!RULES[@]}"; do
        # Drop comment-only lines (// ..., * ..., /* ...) so prose that shows an
        # assignment as an example is not a violation.
        hits="$(
            grep -nE "${RULES[$rule]}" "$file" \
                | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' \
                || true
        )"
        if [[ -n "$hits" ]]; then
            echo "FAIL: $file $rule:" >&2
            echo "$hits" | sed 's/^/  /' >&2
            failed=1
        fi
    done
done

if [[ "$failed" -ne 0 ]]; then
    echo "" >&2
    echo "Page-global writes belong in html/projectm-legacy-globals.js (opt-in convenience API)" >&2
    echo "or behind subscribeWasmCallback() in html/projectm-wasm-callbacks.js (engine callbacks)." >&2
    echo "See html/README.md, \"Page globals\"." >&2
    exit 1
fi

echo "OK: no page-global writes outside the legacy shim / callback bus ($checked files checked)."
