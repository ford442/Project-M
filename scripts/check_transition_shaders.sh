#!/usr/bin/env bash
# Validates every built-in preset transition shader the same way
# TransitionShaderManager::CompileTransitionShader() assembles it at runtime:
#
#   <version header> + TransitionShaderHeaderGlsl330.frag + <shader body> +
#   TransitionShaderMainGlsl330.frag
#
# Each shader is checked twice — once as desktop GLSL (#version 330, the native
# build) and once as GLSL ES (#version 300 es, the Emscripten/WebGL2 build) — so a
# construct that is legal on desktop but illegal on WebGL2 (the sampler-in-ternary
# class of bug that silently dropped the Circle transition from the pool) fails
# here instead of quietly shrinking the transition pool in the browser.
#
# Requires glslangValidator (Debian/Ubuntu: apt-get install glslang-tools).
# Exits 0 and skips if the validator is unavailable, so it is safe to call from
# environments that do not have it installed.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHADER_DIR="$PROJECT_ROOT/src/libprojectM/Renderer/TransitionShaders"

if ! command -v glslangValidator >/dev/null 2>&1; then
    echo "SKIP: glslangValidator not found (install glslang-tools to run this check)."
    exit 0
fi

if [[ ! -d "$SHADER_DIR" ]]; then
    echo "ERROR: transition shader directory not found: $SHADER_DIR" >&2
    exit 1
fi

HEADER="$SHADER_DIR/TransitionShaderHeaderGlsl330.frag"
MAIN="$SHADER_DIR/TransitionShaderMainGlsl330.frag"
VERTEX="$SHADER_DIR/TransitionVertexShaderGlsl330.vert"

for required in "$HEADER" "$MAIN" "$VERTEX"; do
    if [[ ! -f "$required" ]]; then
        echo "ERROR: missing shader fragment: $required" >&2
        exit 1
    fi
done

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Mirrors the two version headers in TransitionShaderManager::CompileTransitionShader().
DESKTOP_HEADER='#version 330
'
GLES_HEADER='#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
'

failures=0
checked=0

validate() {
    local label="$1"
    local stage="$2"
    local source_file="$3"

    local output
    if ! output="$(glslangValidator -S "$stage" "$source_file" 2>&1)"; then
        echo "FAIL: $label"
        echo "$output" | sed 's/^/    /'
        failures=$((failures + 1))
        return
    fi
    checked=$((checked + 1))
}

build_and_validate_fragment() {
    local body_file="$1"
    local profile="$2"
    local version_header="$3"

    local name
    name="$(basename "$body_file" .frag)"
    local assembled="$WORK_DIR/${name}.${profile}.frag"

    {
        printf '%s\n' "$version_header"
        cat "$HEADER"
        printf '\n'
        cat "$body_file"
        printf '\n'
        cat "$MAIN"
    } >"$assembled"

    validate "$name [$profile]" frag "$assembled"
}

shader_bodies=()
while IFS= read -r shader; do
    shader_bodies+=("$shader")
done < <(find "$SHADER_DIR" -maxdepth 1 -name 'TransitionShaderBuiltIn*.frag' | sort)

if [[ ${#shader_bodies[@]} -eq 0 ]]; then
    echo "ERROR: no built-in transition shaders found in $SHADER_DIR" >&2
    exit 1
fi

echo "Validating ${#shader_bodies[@]} built-in transition shaders (desktop GLSL 330 + GLSL ES 300)..."

for shader in "${shader_bodies[@]}"; do
    build_and_validate_fragment "$shader" "gl330" "$DESKTOP_HEADER"
    build_and_validate_fragment "$shader" "gles300" "$GLES_HEADER"
done

# The shared vertex shader gets the same treatment.
for profile in gl330 gles300; do
    version_header="$DESKTOP_HEADER"
    if [[ "$profile" == "gles300" ]]; then
        version_header="$GLES_HEADER"
    fi
    assembled="$WORK_DIR/TransitionVertexShader.${profile}.vert"
    {
        printf '%s\n' "$version_header"
        cat "$VERTEX"
    } >"$assembled"
    validate "TransitionVertexShaderGlsl330 [$profile]" vert "$assembled"
done

if [[ $failures -gt 0 ]]; then
    echo
    echo "$failures shader compilation(s) failed."
    exit 1
fi

echo "OK: $checked shader compilations succeeded."
