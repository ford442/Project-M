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
#   5. assign ANY other property of one of those globals (`window.foo = ...`,
#      `globalThis['foo'] = ...`) unless the file/name pair is listed in
#      PAGE_GLOBAL_ALLOWLIST below, with the reason it has to be a page global
#      (the WASM glue reads it by name, it is a once-per-page guard, ...).
#      projectm-core.html's inline script wrote seven such names that rules 1-4
#      could not see; the list is the ratchet: it only shrinks.
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

# file|name pairs rule 5 lets through. Each says why the name must be a page
# global; remove the line when the write goes away.
PAGE_GLOBAL_ALLOWLIST=(
    # bootProjectMSharedModule() publishes the shared Module for legacy readers
    # (contexts on it claim the slot through claimGlobal()).
    "html/projectm-context-boot.js|Module"
    # In-flight depth-module load, shared with the B3HD hosts' own loader.
    "html/projectm-experimental-bridge.js|__pmDepthModuleLoading"
    # The PCM ring writer the WASM glue's worklet handler (EM_JS) prefers.
    "html/projectm-pcm-ring.js|projectMWritePcmRing"
    # The current preset, read back by context-loss recovery and the WASM glue.
    "html/projectm-presets.js|currentPresetName"
    "html/projectm-presets.js|currentPresetPath"
    # Once-per-page guards and the merged song catalog of the song loader.
    "html/projectm-song-loader.js|__projectMSongCatalog"
    "html/projectm-song-loader.js|__projectMSongLoaderInstalled"
    # FLAC decoder helpers the WASM glue's EM_JS calls by name, and the
    # weeks-on-fire paths it reads.
    "html/projectm-weeks-on-fire.js|resolveFlacDecoderUrl"
    "html/projectm-weeks-on-fire.js|ensureWeeksFlacDecoderFrame"
    "html/projectm-weeks-on-fire.js|openWeeksFlacDecoder"
    "html/projectm-weeks-on-fire.js|__projectMWeeksOnFire"
    "html/projectm-weeks-on-fire.js|__projectMWeeksPaths"
    # The shared AudioContext / worklet node the C++ side (EM_JS) reads, and the
    # song-load state the smoke tests poll.
    "html/projectm-worklet-playback.js|projectMAudioContext_Global_Cpp"
    "html/projectm-worklet-playback.js|projectMWorkletNode_Global_Cpp"
    "html/projectm-worklet-playback.js|projectMSongLoadState"
    "html/projectm-worklet-playback.js|__projectMSongLoadToken"
    # panel2's inline onclick= handlers and console handles. Goes away when the
    # page moves to data-action buttons like projectm-core.html did.
    "html/projectm_panel2.1ink|hidePanel"
    "html/projectm_panel2.1ink|showPanel"
    "html/projectm_panel2.1ink|lockPreset"
    "html/projectm_panel2.1ink|startChangeSong"
    "html/projectm_panel2.1ink|randomPreset"
    "html/projectm_panel2.1ink|randomCustom"
    "html/projectm_panel2.1ink|fullWindow"
    "html/projectm_panel2.1ink|toggleFullscreen"
    "html/projectm_panel2.1ink|updatePresetDisplay"
    "html/projectm_panel2.1ink|currentPresetName"
    "html/projectm_panel2.1ink|Module"
    "html/projectm_panel2.1ink|projectMContext"
    "html/projectm_panel2.1ink|_pmStartupPresetsLoaded"
)
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

# Rule 5's pattern: a direct property of a page global, dot or bracket form.
# `\)?` catches the JSDoc-cast form `/** @type {any} */ (globalThis).x =`, and
# `([^=>]|$)` an assignment whose value starts on the next line.
ANY_GLOBAL_WRITE="${GLOBAL_OBJ}\\)?(\\??\\.[A-Za-z_\$][A-Za-z0-9_\$]*|\\[['\"][^'\"]+['\"]\\])[[:space:]]*=([^=>]|$)"

declare -A ALLOWLIST_USED=()

is_allowlisted_write() {
    local entry="$1|$2" allowed
    for allowed in "${PAGE_GLOBAL_ALLOWLIST[@]}"; do
        if [[ "$entry" == "$allowed" ]]; then
            ALLOWLIST_USED["$entry"]=1
            return 0
        fi
    done
    return 1
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

    # Rule 5. Names rules 1-3 already report are skipped here.
    while IFS= read -r hit; do
        [[ -z "$hit" ]] && continue
        while IFS= read -r name; do
            [[ -z "$name" ]] && continue
            [[ "$name" =~ ^pm ]] && continue
            [[ "$name" =~ ^${LEGACY_NAMES}$ || "$name" == "BroadcastChannel" ]] && continue
            if ! is_allowlisted_write "$file" "$name"; then
                echo "FAIL: $file assigns the page global '$name' (not in PAGE_GLOBAL_ALLOWLIST):" >&2
                echo "  $hit" >&2
                failed=1
            fi
        done < <(echo "$hit" | grep -oE "${ANY_GLOBAL_WRITE}" | sed -E "s/^${GLOBAL_OBJ}\\)?(\\??\\.|\\[['\"])([^'\"[:space:]=]+).*/\\3/")
    done < <(grep -nE "${ANY_GLOBAL_WRITE}" "$file" \
        | sed -E 's#/\*\*? @type \{[^}]*\} \*/ ##g' \
        | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' || true)
done

# The allowlist only shrinks: an entry whose write is gone must go too.
for allowed in "${PAGE_GLOBAL_ALLOWLIST[@]}"; do
    if [[ -f "${allowed%%|*}" && -z "${ALLOWLIST_USED[$allowed]:-}" ]]; then
        echo "FAIL: PAGE_GLOBAL_ALLOWLIST entry '$allowed' matches no write any more; delete it." >&2
        failed=1
    fi
done

if [[ "$failed" -ne 0 ]]; then
    echo "" >&2
    echo "Page-global writes belong in html/projectm-legacy-globals.js (opt-in convenience API)" >&2
    echo "or, if the engine or another page reads the name, in PAGE_GLOBAL_ALLOWLIST with a reason," >&2
    echo "or behind subscribeWasmCallback() in html/projectm-wasm-callbacks.js (engine callbacks)." >&2
    echo "See html/README.md, \"Page globals\"." >&2
    exit 1
fi

echo "OK: no page-global writes outside the legacy shim / callback bus ($checked files checked)."
