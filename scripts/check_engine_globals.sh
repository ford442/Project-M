#!/usr/bin/env bash
# ================================================
# check_engine_globals.sh
#
# Guards "one engine, no process globals" (EngineContext, see
# src/libprojectM/EngineContext.hpp): state that belongs to an engine lives in
# its EngineContext, not at namespace scope, so two ProjectM instances never
# share it.
#
# Reads the compiled objects instead of the sources: every writable object with
# static storage duration -- namespace-scope variables, static members and
# function-local statics, thread_local included -- lands in a data/bss section,
# and nm lists it there (types b/B/d/D/u). Read-only constants land in rodata
# and are not listed. A symbol fails unless a pattern in
# scripts/engine_globals_allowlist.txt matches it; each pattern there carries
# the reason it is not engine state.
#
# Needs a built tree: pass the CMake build dir (default: cmake-build).
#
# Usage:
#   scripts/check_engine_globals.sh [<build-dir>]
#
# Exit codes:
#   0 - every writable static in libprojectM is allowlisted
#   1 - at least one symbol is not (listed on stderr)
#   2 - no objects found under <build-dir>/src/libprojectM, or nm missing
# ================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${1:-${ROOT}/cmake-build}"
ALLOWLIST="${ROOT}/scripts/engine_globals_allowlist.txt"
OBJECT_DIR="${BUILD_DIR}/src/libprojectM"

if ! command -v nm >/dev/null 2>&1; then
    echo "check_engine_globals: nm not found" >&2
    exit 2
fi

mapfile -t OBJECTS < <(find "${OBJECT_DIR}" -name '*.o' -o -name '*.obj' 2>/dev/null | sort)
if [[ ${#OBJECTS[@]} -eq 0 ]]; then
    echo "check_engine_globals: no object files under ${OBJECT_DIR}; build libprojectM first" >&2
    exit 2
fi

# Patterns: one extended regex per line, '#' starts the reason / a comment.
PATTERNS="$(sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "${ALLOWLIST}")"

# Compiler-generated data that is not program state: RTTI, vtables, guard
# variables, EH personality refs, compound-literal constants.
GENERATED='^(typeinfo|typeinfo name|vtable|construction vtable|VTT|guard variable|DW\.ref\.|C\.[0-9]+\.[0-9]+$|std::|__gnu_cxx::|__cxx)'

failures=0
checked=0
while IFS=$'\t' read -r object symbol; do
    checked=$((checked + 1))
    if [[ "${symbol}" =~ ${GENERATED} ]]; then
        continue
    fi
    if [[ -n "${PATTERNS}" ]] && grep -Eq -- "${PATTERNS//$'\n'/|}" <<<"${symbol}"; then
        continue
    fi
    echo "${object#"${OBJECT_DIR}/"}: ${symbol}" >&2
    failures=$((failures + 1))
done < <(for object in "${OBJECTS[@]}"; do
    nm -C "${object}" 2>/dev/null | awk -v object="${object}" '
        $2 ~ /^[bBdDu]$/ { sub(/^[^ ]* [^ ]* /, ""); print object "\t" $0 }'
done | sort -u)

if [[ ${failures} -gt 0 ]]; then
    echo "check_engine_globals: ${failures} writable static(s) above are not in" \
        "scripts/engine_globals_allowlist.txt. Move engine state into EngineContext," \
        "or allowlist the symbol with the reason it is process-wide." >&2
    exit 1
fi
echo "Engine globals OK: ${#OBJECTS[@]} object(s), ${checked} writable static(s), all allowlisted."
