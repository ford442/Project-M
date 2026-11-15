#!/usr/bin/env bash
# ================================================
# check_wasm_host_globals.sh
#
# Grep gate for #246 (WASM multi-instance Phase C): src/wasm/ must not grow
# back object-like macros that alias per-host WasmHost state, e.g.
#
#   #define pm (Host().appData.projectm_engine)
#   #define g_dualFbo (Host().dualFbo)
#
# Those rewrite every matching identifier in the TU — safe only while no EM_JS
# body, local, or address-of happens to spell the same token, and silently
# wrong the day one does. Per-host state is reached with
# `WasmHost& H = Host();` plus local references (`auto& pm =
# H.appData.projectm_engine;`) instead.
#
# Checked:
#   1. no `#define <name> (Host()...` alias macros at all;
#   2. no `#define pm` / `#define app_data` / `#define playlist`;
#   3. no `#define g_*` except the allowlist below;
#   4. ABI v2 (#352): no call to Host() (the host set_active_host() selected)
#      or SetActiveHost() outside the compat layer. Every export reaches its
#      host through a barrier (src/wasm/WasmApiBarrier.hpp) that resolves the
#      handle it was given, so nothing else may depend on which host is
#      active. The compat layer is the files in HOST_CALL_ALLOWED below: the
#      registry itself (whose ActiveHostHandle() is what every generated compat
#      shim forwards with) and the compat-only exports (set_canvas_selectors(),
#      init_with_canvases(), ...).
#   5. ABI v2 (#352 B): no writable static in src/wasm/ that is not in
#      scripts/wasm_globals_allowlist.txt. Read from the compiled objects (like
#      scripts/check_engine_globals.sh for libprojectM), so namespace-scope
#      variables, static members and function-local statics all count:
#      engine state lives on WasmHost or in libprojectM's EngineContext, and
#      what stays Module-wide says why in the allowlist. Needs the Emscripten
#      build dir (argument, or PROJECTM_WASM_BUILD_DIR) and llvm-nm (emsdk's,
#      found through EMSDK or em++ on PATH, or LLVM_NM). Without them the rule
#      is skipped with a notice; WASM_GLOBALS_REQUIRED=1 makes that fatal (CI).
#
# Allowlist (documented process-globals that are NOT per-host state):
#   g_mainLoopRegistered — one Emscripten main loop services every started
#                          host (WasmHost.hpp). It is a real variable, not a
#                          macro, so it never needs a #define; it is listed so
#                          the rule's one sanctioned global is spelled out.
#
# Usage:
#   scripts/check_wasm_host_globals.sh [<emscripten-build-dir>]
#
# Exit codes:
#   0 - no forbidden aliases, Host() calls or unlisted globals
#   1 - at least one found
#   2 - rule 5 required (WASM_GLOBALS_REQUIRED=1) but its prerequisites are missing
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

ALLOWED_G_DEFINES=(g_mainLoopRegistered)

HOST_CALL_ALLOWED=(
    src/wasm/WasmHost.hpp
    src/wasm/WasmHost.cpp
    src/wasm/WasmLegacyExports.cpp
)

status=0

report() {
    echo "ERROR: $1" >&2
    echo "$2" | sed 's/^/  /' >&2
    status=1
}

if hits=$(grep -rnE '^[[:space:]]*#[[:space:]]*define[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\(?[[:space:]]*Host\(\)' src/wasm/); then
    report "object-like macros aliasing Host() state in src/wasm/ (use WasmHost& H = Host(); + local references):" "$hits"
fi

if hits=$(grep -rnE '^[[:space:]]*#[[:space:]]*define[[:space:]]+(pm|app_data|playlist)\b' src/wasm/); then
    report "engine alias macros in src/wasm/:" "$hits"
fi

allow_re="$(IFS='|'; echo "${ALLOWED_G_DEFINES[*]}")"
if hits=$(grep -rnE '^[[:space:]]*#[[:space:]]*define[[:space:]]+g_[A-Za-z0-9_]*' src/wasm/ | grep -vE "#[[:space:]]*define[[:space:]]+(${allow_re})\b"); then
    report "#define g_* macros in src/wasm/ (only ${ALLOWED_G_DEFINES[*]} is allowed):" "$hits"
fi

# Rule 4. Comment lines are skipped; `Host()` as a whole token, so
# ResolveHost(), BindHost(), ImplicitDefaultHost() and `.Host()` members are not
# hits.
host_allow_re="$(IFS='|'; echo "${HOST_CALL_ALLOWED[*]}")"
if hits=$(grep -rnE '(^|[^A-Za-z0-9_.>:])(Host|SetActiveHost)[[:space:]]*\(' src/wasm/ \
        | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)' \
        | grep -vE "^(${host_allow_re}):"); then
    report "Host()/SetActiveHost() outside the compat layer (take a WasmHost& from the export's barrier, see WasmApiBarrier.hpp):" "$hits"
fi

# Rule 5.
BUILD_DIR="${1:-${PROJECTM_WASM_BUILD_DIR:-}}"
OBJECT_DIR="${BUILD_DIR:+${BUILD_DIR}/src/wasm/CMakeFiles/projectM_wasm.dir}"
ALLOWLIST="${PROJECT_ROOT}/scripts/wasm_globals_allowlist.txt"
find_llvm_nm() {
    if [[ -n "${LLVM_NM:-}" ]]; then echo "${LLVM_NM}"; return; fi
    if [[ -n "${EMSDK:-}" && -x "${EMSDK}/upstream/bin/llvm-nm" ]]; then echo "${EMSDK}/upstream/bin/llvm-nm"; return; fi
    local empp
    if empp="$(command -v em++ 2>/dev/null)"; then
        local candidate
        candidate="$(cd "$(dirname "$(readlink -f "${empp}")")/.." && pwd)/bin/llvm-nm"
        if [[ -x "${candidate}" ]]; then echo "${candidate}"; return; fi
    fi
    command -v llvm-nm 2>/dev/null || true
}
NM_BIN="$(find_llvm_nm)"
skip_reason=""
if [[ -z "${OBJECT_DIR}" ]]; then
    skip_reason="no Emscripten build dir given"
elif [[ ! -d "${OBJECT_DIR}" ]]; then
    skip_reason="${OBJECT_DIR} does not exist (build the projectM_wasm target first)"
elif [[ -z "${NM_BIN}" ]]; then
    skip_reason="llvm-nm not found (set LLVM_NM or EMSDK)"
fi
if [[ -n "${skip_reason}" ]]; then
    if [[ "${WASM_GLOBALS_REQUIRED:-0}" == "1" ]]; then
        echo "ERROR: rule 5 (writable statics) cannot run: ${skip_reason}" >&2
        exit 2
    fi
    echo "NOTE: rule 5 (writable statics) skipped: ${skip_reason}."
else
    mapfile -t objects < <(find "${OBJECT_DIR}" -name '*.o' | sort)
    if [[ ${#objects[@]} -eq 0 ]]; then
        echo "ERROR: no objects under ${OBJECT_DIR}" >&2
        exit 2
    fi
    patterns="$(sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "${ALLOWLIST}")"
    # What the compiler emits that is not program state. On wasm, llvm-nm types
    # constants as data too, so string literals, EH tables, EM_JS bodies, the
    # EM_ASM argument signatures (`::x`), RTTI and constants named k* are
    # filtered here; a mutable global named k* would be a naming bug anyway.
    generated='^(\.L|GCC_except_table|__em_js_|__em_asm|typeinfo|vtable|guard variable)|::x$|(^|::)k[A-Z][A-Za-z0-9]*(\.const)?$|^\.L_ZL'
    unlisted=""
    count=0
    while IFS=$'\t' read -r object symbol; do
        count=$((count + 1))
        [[ "${symbol}" =~ ${generated} ]] && continue
        if [[ -n "${patterns}" ]] && grep -Eq -- "${patterns//$'\n'/|}" <<<"${symbol}"; then
            continue
        fi
        unlisted+="${object#"${OBJECT_DIR}/"}: ${symbol}"$'\n'
    done < <(for object in "${objects[@]}"; do
        "${NM_BIN}" -C "${object}" 2>/dev/null | awk -v object="${object}" '
            $2 ~ /^[bBdDu]$/ { sub(/^[^ ]* [^ ]* /, ""); print object "\t" $0 }'
    done | sort -u)
    if [[ -n "${unlisted}" ]]; then
        report "writable statics in src/wasm/ not in scripts/wasm_globals_allowlist.txt (put engine state on WasmHost, or allowlist the symbol with the reason it is Module-wide):" "${unlisted%$'\n'}"
    else
        echo "OK: ${#objects[@]} src/wasm/ object(s), every writable static allowlisted."
    fi
fi

if [[ $status -eq 0 ]]; then
    echo "OK: src/wasm/ has no per-host alias macros (#246), and only the compat layer reads the active host (#352)."
fi
exit $status
