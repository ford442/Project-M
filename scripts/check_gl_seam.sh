#!/usr/bin/env bash
# ================================================
# check_gl_seam.sh
#
# Guards the render-device seam (docs/RENDER_DEVICE.md): outside
# src/libprojectM/Renderer/Device/Gl/ and src/libprojectM/Renderer/Platform/,
# nothing calls OpenGL directly or includes a GL header. Everything draws
# through Renderer::Device's IRenderDevice / ICommandList, so a second backend
# (WebGPU) only has to implement that interface.
#
# A file fails when, outside comments, it has
#   - a call that looks like a GL entry point: \bgl[A-Z]\w*\( , or
#   - an #include of Renderer/OpenGL.h or a glad header.
# String literals are not stripped; spell a GL function's name without the
# call parentheses in a message.
#
# Ratcheted like check_cpp_format.sh: PATHS lists the directories that are
# already clean. Add a directory once it is, never before, or this gate goes
# red for everyone.
#
# Usage:
#   scripts/check_gl_seam.sh
#
# Exit codes:
#   0 - no direct GL use under PATHS outside the exempt directories
#   1 - at least one offending line (listed on stderr)
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Directories that must not touch GL directly. Widen per directory.
PATHS=(
    "src/libprojectM"
    "src/wasm"
)

# The GL backend and the platform layer (context creation, loader) are the seam.
EXEMPT_RE='^src/libprojectM/Renderer/(Device/Gl|Platform)/|^src/libprojectM/Renderer/OpenGL\.h$'

CALL_RE='\bgl[A-Z][A-Za-z0-9_]*[[:space:]]*\('
INCLUDE_RE='^[[:space:]]*#[[:space:]]*include[[:space:]]*[<"](Renderer/OpenGL\.h|OpenGL\.h|glad/)'

files=()
while IFS= read -r -d '' f; do
    if [[ ! "$f" =~ $EXEMPT_RE ]]; then
        files+=("$f")
    fi
done < <(find "${PATHS[@]}" -type f \( -name '*.cpp' -o -name '*.hpp' -o -name '*.h' -o -name '*.c' -o -name '*.cc' -o -name '*.in' \) -print0 | sort -z)

if [[ ${#files[@]} -eq 0 ]]; then
    echo "check_gl_seam.sh: no C++ files found under: ${PATHS[*]}" >&2
    exit 1
fi

# Drops /* */ block comments (also across lines) and // line comments, keeping
# line numbers. A "//" inside a string literal cuts the rest of that line, which
# can only hide a match, never invent one.
strip_comments() {
    awk '
    {
        line = $0
        out = ""
        while (length(line) > 0) {
            if (inBlock) {
                end = index(line, "*/")
                if (end == 0) { line = ""; break }
                line = substr(line, end + 2)
                inBlock = 0
                continue
            }
            blockStart = index(line, "/*")
            lineStart = index(line, "//")
            if (lineStart > 0 && (blockStart == 0 || lineStart < blockStart)) {
                out = out substr(line, 1, lineStart - 1)
                line = ""
                break
            }
            if (blockStart > 0) {
                out = out substr(line, 1, blockStart - 1)
                line = substr(line, blockStart + 2)
                inBlock = 1
                continue
            }
            out = out line
            line = ""
        }
        print out
    }' "$1"
}

offenders=0
for f in "${files[@]}"; do
    matches=$(strip_comments "$f" | grep -nE "$CALL_RE|$INCLUDE_RE" || true)
    if [[ -n "$matches" ]]; then
        while IFS= read -r match; do
            echo "$f:$match" >&2
        done <<<"$matches"
        offenders=1
    fi
done

if [[ "$offenders" -ne 0 ]]; then
    echo "" >&2
    echo "check_gl_seam.sh: direct OpenGL use outside Renderer/Device/Gl and Renderer/Platform." >&2
    echo "Go through Renderer::Device (Device::Current() / Device::Commands()); see docs/RENDER_DEVICE.md." >&2
    exit 1
fi

echo "GL seam OK: ${#files[@]} file(s) under ${PATHS[*]} make no direct GL calls."
