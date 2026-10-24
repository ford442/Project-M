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
#      route);
#   5. assign a `projectM*` / `__projectM*` / `__pm*` name on one of them,
#      unless OWNED_GLOBALS below names that file as the name's one writer.
#      These are the page-scoped slots the baked engine glue reads or writes
#      by name (the AudioContext, the worklet node, the song-load state, the
#      weeks-on-fire flag) plus a few page-once guards. Each has exactly one
#      host-side owner; anything else that needs the value imports the owner.
#      Per-context state belongs on the ProjectMContext, not here.
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
        # Only the subdirectories that exist: a failing find would end the list
        # here under `set -e` and leave the host pages below unscanned.
        for subdir in html/context html/worklets; do
            if [[ -d "$subdir" ]]; then
                find "$subdir" -maxdepth 1 -type f -name '*.js'
            fi
        done
        find html -maxdepth 1 -type f \( -name '*.html' -o -name '*.1ink' \)
    } | sort -u
)

GLOBAL_OBJ='(window|globalThis|windowRef|self)\)?'
LEGACY_NAMES='(cycleAudioPlayer|closeAudioPlayer|flacPlayer|modPlayer|openFlacPlayer|openModPlayer)'

# name: extended regex. Each matches an *assignment* (`=` not followed by
# another `=`), so reads such as `window.pmGetFboFormat()` and comparisons are
# fine.
declare -A RULES=(
    ["assigns a window.pm* global"]="${GLOBAL_OBJ}(\\??\\.pm[A-Za-z0-9_]*|\\[['\"]pm[A-Za-z0-9_]*['\"]\\])[[:space:]]*=([^=>]|$)"
    ["defines a pm* property on a page global"]="defineProperty\\([[:space:]]*${GLOBAL_OBJ}[[:space:]]*,[[:space:]]*['\"]pm[A-Za-z0-9_]*['\"]"
    ["assigns a legacy popup-player global"]="${GLOBAL_OBJ}\\??\\.${LEGACY_NAMES}[[:space:]]*=([^=>]|$)"
    ["monkey-patches BroadcastChannel"]="${GLOBAL_OBJ}\\??\\.BroadcastChannel[[:space:]]*=([^=>]|$)"
    ["claims a pm* global by literal name"]="claimGlobal\\([^,()]+,[[:space:]]*['\"]pm[A-Za-z0-9_]*['\"]"
)

# Rule 5's ownership table: "<global name> <the one file that may assign it>".
# Add a line only for a slot the engine glue shares by name or a page-once
# guard; say which in the comment.
OWNED_GLOBALS=(
    # Read by the engine's audio EM_JS (src/wasm/WasmAudioBridge.cpp).
    "projectMAudioContext_Global_Cpp html/projectm-worklet-playback.js"
    "projectMWorkletNode_Global_Cpp html/projectm-worklet-playback.js"
    # Also written by js_load_song_into_worklet; read via getSongLoadState().
    "projectMSongLoadState html/projectm-worklet-playback.js"
    # Read by src/wasm/WasmJsBindings.cpp at module start.
    "__projectMWeeksOnFire html/projectm-weeks-on-fire.js"
    # Console readouts, never read by code.
    "__projectMWeeksPaths html/projectm-weeks-on-fire.js"
    "__projectMSongCatalog html/projectm-song-loader.js"
    # Page-once guard: the interceptor wraps the page's 'sng' channel, and the
    # module can be loaded twice under different ?v= URLs.
    "__projectMSongLoaderInstalled html/projectm-song-loader.js"
)

owner_of() {
    local name="$1" entry
    for entry in "${OWNED_GLOBALS[@]}"; do
        if [[ "${entry%% *}" == "$name" ]]; then
            echo "${entry#* }"
            return 0
        fi
    done
    return 1
}

OWNED_PATTERN="${GLOBAL_OBJ}(\\??\\.|\\[['\"])((__)?projectM[A-Za-z0-9_]*|__pm[A-Za-z0-9_]*)(['\"]\\])?[[:space:]]*=([^=>]|$)"

# Drops same-line /* ... */ blocks (JSDoc casts such as
# `/** @type {any} */ (globalThis).x = ...`) so the line is judged by its code,
# not dropped as a comment line. Line numbers are unchanged.
strip_inline_comments() {
    sed -E 's#/\*([^*]|\*+[^*/])*\*+/##g' "$1"
}

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
            strip_inline_comments "$file" \
                | grep -nE "${RULES[$rule]}" \
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

# Rule 5 runs over every file, the shim and the bus included: owning a slot is
# per name, not per file.
for file in "${FILES[@]}"; do
    [[ "$file" == "html/projectm-render-worker.js" ]] && continue
    while IFS= read -r hit; do
        [[ -z "$hit" ]] && continue
        name="$(grep -oE "((__)?projectM[A-Za-z0-9_]*|__pm[A-Za-z0-9_]*)" <<<"${hit#*:}" | head -n1)"
        owner="$(owner_of "$name" || true)"
        if [[ "$owner" != "$file" ]]; then
            echo "FAIL: $file assigns page global $name (owner: ${owner:-none -- add one to OWNED_GLOBALS or keep it in module/context state}):" >&2
            echo "  $hit" >&2
            failed=1
        fi
    done < <(
        strip_inline_comments "$file" \
            | grep -nE "$OWNED_PATTERN" \
            | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' \
            || true
    )
done

if [[ "$failed" -ne 0 ]]; then
    echo "" >&2
    echo "Page-global writes belong in html/projectm-legacy-globals.js (opt-in convenience API)" >&2
    echo "or behind subscribeWasmCallback() in html/projectm-wasm-callbacks.js (engine callbacks)." >&2
    echo "See html/README.md, \"Page globals\"." >&2
    exit 1
fi

echo "OK: no page-global writes outside the legacy shim / callback bus ($checked files checked)."
