#!/usr/bin/env bash
# Fails when a unit test includes a glad header directly.
#
# libprojectM's renderer headers pull in <glad/gles2.h> under USE_GLES
# (Emscripten, Android, ENABLE_GLES), and glad refuses to see <glad/gl.h> in the
# same translation unit, so a direct include breaks the Emscripten test build
# while every desktop job stays green. Tests include tests/libprojectM/TestGl.hpp
# instead. HeadlessGlContext.cpp is exempt: it is desktop-only and includes no
# renderer header.
set -euo pipefail

cd "$(dirname "$0")/.."

offenders=$(grep -rlE '^[[:space:]]*#[[:space:]]*include[[:space:]]*[<"]glad/' tests/libprojectM \
    --include='*.cpp' --include='*.hpp' --include='*.h' \
    | grep -vE '^tests/libprojectM/(TestGl\.hpp|HeadlessGlContext\.cpp)$' || true)

if [ -n "$offenders" ]; then
    echo "Include \"TestGl.hpp\" instead of a glad header in:" >&2
    echo "$offenders" | sed 's/^/  /' >&2
    exit 1
fi
echo "Test GL includes OK."
