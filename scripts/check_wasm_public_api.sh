#!/usr/bin/env bash
# Gate the *public* WASM API surface of the @projectm/web package.
#
# cmake/WasmApiManifest.cmake tags every export public | internal | runtime, but
# until now nothing read the tier: an internal symbol could become a de-facto
# public API by being used, and a public one could be renamed or have its
# signature changed without anything noticing.
#
# This script extracts the `public` entries and diffs them against the checked-in
# baseline (packages/web/wasm-public-api.baseline), which also records the
# package version the surface was last blessed at.
#
#   - added symbols        -> allowed, no version requirement
#   - removed symbols      -> breaking
#   - changed signature    -> breaking (return type, args, or ccall/direct binding,
#                             since all three change how an embedder calls it)
#
# A breaking change requires a version bump in packages/web/package.json:
# a major bump at >= 1.0.0, or a minor bump pre-1.0 (semver's 0.x convention,
# where the minor is the breaking position).
#
# Usage:
#   scripts/check_wasm_public_api.sh            # verify (CI)
#   scripts/check_wasm_public_api.sh --update   # re-bless the surface
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$PROJECT_ROOT/cmake/WasmApiManifest.cmake"
BASELINE="$PROJECT_ROOT/packages/web/wasm-public-api.baseline"
PKG_JSON="$PROJECT_ROOT/packages/web/package.json"

UPDATE=0
if [[ "${1:-}" == "--update" ]]; then
    UPDATE=1
elif [[ $# -gt 0 ]]; then
    echo "Usage: $0 [--update]" >&2
    exit 2
fi

# --- current surface --------------------------------------------------------
# Manifest entries are `"name|visibility|binding|returns|args|doc"`; the doc
# field is deliberately dropped, so a prose edit is not an API change.
current="$(awk -F'|' '
    /^[[:space:]]*"[a-zA-Z_][a-zA-Z0-9_]*\|/ {
        name = $1
        sub(/^[[:space:]]*"/, "", name)
        if ($2 != "public") next
        printf "%s(%s) -> %s [%s]\n", name, $5, $4, $3
    }
' "$MANIFEST" | LC_ALL=C sort)"

if [[ -z "$current" ]]; then
    echo "ERROR: parsed zero public entries from $MANIFEST — parser or manifest format changed." >&2
    exit 1
fi

pkg_version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PKG_JSON" | head -1)"
if [[ -z "$pkg_version" ]]; then
    echo "ERROR: cannot read version from $PKG_JSON" >&2
    exit 1
fi

write_baseline() {
    {
        echo "# @projectm/web public WASM API surface."
        echo "# Generated from cmake/WasmApiManifest.cmake by scripts/check_wasm_public_api.sh."
        echo "# Do not edit by hand: run scripts/check_wasm_public_api.sh --update."
        echo "# package-version: $pkg_version"
        echo "$current"
    } > "$BASELINE"
}

if [[ ! -f "$BASELINE" ]]; then
    if [[ "$UPDATE" -eq 1 ]]; then
        write_baseline
        echo "Created $BASELINE at version $pkg_version ($(echo "$current" | wc -l) public symbols)."
        exit 0
    fi
    echo "ERROR: $BASELINE is missing. Run: scripts/check_wasm_public_api.sh --update" >&2
    exit 1
fi

baseline_version="$(sed -n 's/^# package-version:[[:space:]]*//p' "$BASELINE" | head -1)"
baseline_surface="$(grep -v '^#' "$BASELINE" | grep -v '^[[:space:]]*$' | LC_ALL=C sort)"

if [[ "$current" == "$baseline_surface" ]]; then
    if [[ "$UPDATE" -eq 1 && "$baseline_version" != "$pkg_version" ]]; then
        write_baseline
        echo "Public WASM API surface unchanged; baseline version updated to $pkg_version."
        exit 0
    fi
    echo "Public WASM API surface matches $BASELINE ($(echo "$current" | wc -l) symbols, v$baseline_version)."
    exit 0
fi

# --- classify the diff ------------------------------------------------------
added="$(comm -23 <(echo "$current") <(echo "$baseline_surface"))"
removed="$(comm -13 <(echo "$current") <(echo "$baseline_surface"))"

# A signature change shows up as a removed line and an added line with the same
# symbol name; split those out so the report distinguishes them from real
# additions and removals.
names_of() { sed 's/(.*//' | LC_ALL=C sort -u; }
added_names="$(echo "$added" | grep -v '^$' | names_of || true)"
removed_names="$(echo "$removed" | grep -v '^$' | names_of || true)"
changed_names="$(comm -12 <(echo "$added_names") <(echo "$removed_names"))"

pure_added="$(comm -23 <(echo "$added_names") <(echo "$changed_names") | grep -v '^$' || true)"
pure_removed="$(comm -23 <(echo "$removed_names") <(echo "$changed_names") | grep -v '^$' || true)"
changed_names="$(echo "$changed_names" | grep -v '^$' || true)"

echo "Public WASM API surface differs from $BASELINE (baseline v$baseline_version, package v$pkg_version):"
[[ -n "$pure_added" ]] && { echo "  added:"; echo "$pure_added" | sed 's/^/    + /'; }
[[ -n "$pure_removed" ]] && { echo "  removed:"; echo "$pure_removed" | sed 's/^/    - /'; }
if [[ -n "$changed_names" ]]; then
    echo "  signature changed:"
    while IFS= read -r name; do
        echo "    ~ $name"
        echo "$removed" | grep "^$name(" | sed 's/^/        was: /'
        echo "$current" | grep "^$name(" | sed 's/^/        now: /'
    done <<< "$changed_names"
fi

breaking=0
[[ -n "$pure_removed" || -n "$changed_names" ]] && breaking=1

if [[ "$breaking" -eq 0 ]]; then
    if [[ "$UPDATE" -eq 1 ]]; then
        write_baseline
        echo "Additive change accepted; baseline re-blessed at v$pkg_version."
        exit 0
    fi
    echo "" >&2
    echo "Additive change — no version bump required, but the baseline must be updated." >&2
    echo "Run: scripts/check_wasm_public_api.sh --update" >&2
    exit 1
fi

# --- breaking change: require a version bump --------------------------------
IFS='.' read -r b_major b_minor _ <<< "$baseline_version"
IFS='.' read -r p_major p_minor _ <<< "$pkg_version"

if [[ "$b_major" -eq 0 ]]; then
    bumped=$(( p_major > b_major || (p_major == b_major && p_minor > b_minor) ))
    requirement="a minor bump (pre-1.0, so the minor is the breaking position): >= 0.$((b_minor + 1)).0"
else
    bumped=$(( p_major > b_major ))
    requirement="a major bump: >= $((b_major + 1)).0.0"
fi

if [[ "$bumped" -ne 1 ]]; then
    echo "" >&2
    echo "BREAKING public API change with no version bump." >&2
    echo "packages/web/package.json is still $pkg_version; this needs $requirement." >&2
    echo "Bump it, then run: scripts/check_wasm_public_api.sh --update" >&2
    exit 1
fi

if [[ "$UPDATE" -eq 1 ]]; then
    write_baseline
    echo "Breaking change accepted at v$pkg_version (was v$baseline_version); baseline re-blessed."
    exit 0
fi

echo "" >&2
echo "Breaking change is version-bumped ($baseline_version -> $pkg_version), but the baseline is stale." >&2
echo "Run: scripts/check_wasm_public_api.sh --update" >&2
exit 1
