#!/usr/bin/env bash
# ================================================
# check_cpp_format.sh
#
# Guards C++ style with `clang-format --dry-run -Werror` against the
# repo-root .clang-format. Only src/wasm/ ~1,400 replacements away from
# compliant when this gate was added; two directories (src/wasm/, plus
# src/libprojectM/Renderer/Platform/ and tests/cxx-interface/, which were
# already compliant) are checked to start. The rest of src/ and tests/
# (excluding vendor/) is NOT yet compliant — a repo-wide clang-format run on
# day one would produce a reformat-everything PR that buries real diffs in
# git blame and review, same reasoning as the narrow clang-tidy check list.
#
# Widen PATHS below directory-by-directory as each is mechanically
# reformatted in its own commit (see AGENTS.md's
# .git-blame-ignore-revs note) — do not add a directory here until it is
# actually clean, or this gate goes red for everyone.
#
# Usage:
#   scripts/check_cpp_format.sh
#
# Exit codes:
#   0 - every file under PATHS matches .clang-format
#   1 - clang-format is not installed, or at least one file needs reformatting
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

CLANG_FORMAT="${CLANG_FORMAT:-}"
if [[ -z "$CLANG_FORMAT" ]]; then
    for candidate in clang-format-18 clang-format-17 clang-format-16 clang-format; do
        if command -v "$candidate" >/dev/null 2>&1; then
            CLANG_FORMAT="$candidate"
            break
        fi
    done
fi
if [[ -z "$CLANG_FORMAT" ]]; then
    echo "check_cpp_format.sh: no clang-format binary found on PATH" >&2
    exit 1
fi

# Directories already reformatted to match .clang-format. Widen this list
# per directory, never all at once.
PATHS=(
    "src/wasm"
    "src/libprojectM/Renderer/Platform"
    "tests/cxx-interface"
)

shopt -s nullglob globstar
files=()
for dir in "${PATHS[@]}"; do
    for f in "$dir"/**/*.cpp "$dir"/**/*.hpp "$dir"/**/*.h "$dir"/**/*.cc "$dir"/**/*.c \
             "$dir"/*.cpp "$dir"/*.hpp "$dir"/*.h "$dir"/*.cc "$dir"/*.c; do
        files+=("$f")
    done
done
shopt -u nullglob globstar

if [[ ${#files[@]} -eq 0 ]]; then
    echo "check_cpp_format.sh: no C++ files found under: ${PATHS[*]}" >&2
    exit 1
fi

echo "Checking ${#files[@]} file(s) with $CLANG_FORMAT against .clang-format..."

failed=0
for f in "${files[@]}"; do
    if ! "$CLANG_FORMAT" --dry-run -Werror --style=file "$f" 2>&1; then
        failed=1
    fi
done

if [[ "$failed" -ne 0 ]]; then
    echo "" >&2
    echo "check_cpp_format.sh: one or more files above are not clang-format clean." >&2
    echo "Run: $CLANG_FORMAT -i <file>" >&2
    exit 1
fi

echo "All ${#files[@]} file(s) are clang-format clean."
