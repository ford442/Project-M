#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR="${INSTALL_DIR:-"$PROJECT_ROOT/install"}"
OUT_DIR="${OUT_DIR:-"$PROJECT_ROOT/cmake-build/wasm-smoke"}"
CMAKE_BUILD_DIR="${CMAKE_BUILD_DIR:-}"

# shellcheck source=wasm_link_common.inc.sh
source "$PROJECT_ROOT/scripts/wasm_link_common.inc.sh"

projectm_resolve_cmake_build_dir() {
    local candidate static_shaders_header
    if [[ -n "$CMAKE_BUILD_DIR" ]]; then
        static_shaders_header="$CMAKE_BUILD_DIR/src/libprojectM/MilkdropPreset/MilkdropStaticShaders.hpp"
        if [[ -f "$static_shaders_header" ]]; then
            echo "$CMAKE_BUILD_DIR"
            return 0
        fi
        echo "ERROR: CMAKE_BUILD_DIR=$CMAKE_BUILD_DIR but generated header not found:" >&2
        echo "  $static_shaders_header" >&2
        echo "Run INSTALL_DIR=$INSTALL_DIR CMAKE_BUILD_DIR=$CMAKE_BUILD_DIR scripts/build_wasm_install.sh first." >&2
        return 1
    fi

    for candidate in \
        "$PROJECT_ROOT/cmake-build-wasm" \
        "$PROJECT_ROOT/cmake-build" \
        "$PROJECT_ROOT/build"; do
        static_shaders_header="$candidate/src/libprojectM/MilkdropPreset/MilkdropStaticShaders.hpp"
        if [[ -f "$static_shaders_header" ]]; then
            echo "$candidate"
            return 0
        fi
    done

    echo "ERROR: could not find generated MilkdropStaticShaders.hpp under a CMake build dir." >&2
    echo "Set CMAKE_BUILD_DIR to the Emscripten build directory (e.g. cmake-build-wasm)." >&2
    echo "Run scripts/build_wasm_install.sh first." >&2
    return 1
}

CMAKE_BUILD_DIR="$(projectm_resolve_cmake_build_dir)"
LIBPROJECTM_GENERATED_INCLUDE="$CMAKE_BUILD_DIR/src/libprojectM"
LIBPROJECTM_SOURCE_INCLUDE="$PROJECT_ROOT/src/libprojectM"
# projectM-4/projectM_cxx_export.h, which libprojectM's internal headers (the
# wrapper logs through Logging.hpp) include; not installed without
# ENABLE_CXX_INTERFACE.
LIBPROJECTM_GENERATED_API_INCLUDE="$CMAKE_BUILD_DIR/src/api/include"

projectm_wasm_wrapper_include_args() {
    local -n _out=$1
    _out=(
        -I "$INSTALL_DIR/include"
        -I "$PROJECT_ROOT"
        -I "$PROJECT_ROOT/cmake/generated"
        -I "$PROJECT_ROOT/omp"
        -I "$LIBPROJECTM_SOURCE_INCLUDE"
        -I "$LIBPROJECTM_GENERATED_INCLUDE"
        -I "$LIBPROJECTM_GENERATED_API_INCLUDE"
        -I "$PROJECT_ROOT/vendor/hlslparser/src"
        -I "$PROJECT_ROOT/vendor/glad/include"
        -I "$PROJECT_ROOT/vendor"
        -DUSE_GLES
    )
}

mkdir -p "$OUT_DIR"

projectm_lib="$INSTALL_DIR/lib/libprojectM-4.a"
playlist_lib="$INSTALL_DIR/lib/libprojectM-4-playlist.a"

if [[ ! -f "$projectm_lib" ]]; then
    echo "Missing projectM static library: $projectm_lib" >&2
    exit 1
fi

if [[ ! -f "$playlist_lib" ]]; then
    echo "Missing projectM playlist static library: $playlist_lib" >&2
    exit 1
fi

libomp_path="$(projectm_wasm_libomp_args "$PROJECT_ROOT")"
libomp_args=()
if [[ -n "$libomp_path" ]]; then
    libomp_args+=("$libomp_path")
else
    echo "Warning: libomp.a not found; OpenMP runtime will not be linked" >&2
fi

# Test hooks (the `debug` exports of cmake/WasmApiManifest.cmake: is_preset_ready,
# live_playlist_count, ...) are exported by default here, because the smoke and
# golden harnesses drive them. A bundle built with them is not deployable: its
# build-id says so, and scripts/prepare_deploy_bundle.sh links with
# PROJECTM_WASM_DEBUG_EXPORTS=0.
export PROJECTM_WASM_DEBUG_EXPORTS="${PROJECTM_WASM_DEBUG_EXPORTS:-1}"

common_args=()
projectm_wasm_common_link_args common_args

simd_compile_args=()
projectm_wasm_simd_compile_args simd_compile_args

wrapper_compile_args=()
projectm_wasm_wrapper_compile_args wrapper_compile_args

wrapper_include_args=()
projectm_wasm_wrapper_include_args wrapper_include_args

# src/wasm warning ratchet: -Wall -Wextra always, -Werror when
# PROJECTM_WASM_WERROR=1 (CI; the wasm counterpart of ENABLE_WERROR_RATCHET).
# -Winvalid-pp-token is off because it only ever fires on JavaScript: a '' or
# "" literal inside an EM_JS/EM_ASM body tokenizes as an empty C char constant.
wrapper_warning_args=(-Wall -Wextra -Wno-invalid-pp-token)
if [[ "${PROJECTM_WASM_WERROR:-0}" == "1" ]]; then
    wrapper_warning_args+=(-Werror)
fi

# WASM host wrapper translation units. projectM_emscripten.cpp was split into
# focused TUs (see docs/EMSCRIPTEN.md "Where to add a WASM export"); all of them
# must be passed to the final em++ link. Header-only pieces (WasmGraphics.hpp,
# ProjectMWasmInternal.hpp) are #included, not listed here.
wrapper_sources=(
    "$PROJECT_ROOT/src/wasm/projectM_emscripten.cpp"
    "$PROJECT_ROOT/src/wasm/WasmHost.cpp"
    "$PROJECT_ROOT/src/wasm/WasmRenderLoop.cpp"
    "$PROJECT_ROOT/src/wasm/WasmShaderCache.cpp"
    "$PROJECT_ROOT/src/wasm/WasmRenderPathOverrides.cpp"
    "$PROJECT_ROOT/src/wasm/WasmWebGLContext.cpp"
    "$PROJECT_ROOT/src/wasm/WasmDualFbo.cpp"
    "$PROJECT_ROOT/src/wasm/WasmAudioBridge.cpp"
    "$PROJECT_ROOT/src/wasm/WasmPcmRing.cpp"
    "$PROJECT_ROOT/src/wasm/WasmPerfGovernor.cpp"
    "$PROJECT_ROOT/src/wasm/WasmPlaylistBridge.cpp"
    "$PROJECT_ROOT/src/wasm/WasmPresetPrepare.cpp"
    "$PROJECT_ROOT/src/wasm/WasmRhythm.cpp"
    "$PROJECT_ROOT/src/wasm/WasmJsBindings.cpp"
    "$PROJECT_ROOT/src/wasm/WasmDeterminism.cpp"
    "$PROJECT_ROOT/src/wasm/WasmPresent.cpp"
)

# Prefer em++ so the final link always pulls in libc++ / libc++abi. Linking the
# C++ wrapper + libprojectM with plain emcc can omit the C++ runtime (undefined
# __cxa_*, std::string, etc.) when DEFAULT_TO_CXX is off (e.g. STRICT, or
# Emscripten versions that do not default it on for emcc).
emxx_cmd=()
if command -v em++ >/dev/null 2>&1; then
    emxx_cmd=(em++)
elif command -v emcc >/dev/null 2>&1; then
    echo "Warning: em++ not found; falling back to emcc -sDEFAULT_TO_CXX=1" >&2
    emxx_cmd=(emcc -s DEFAULT_TO_CXX=1)
else
    echo "ERROR: neither em++ nor emcc found on PATH." >&2
    echo "Activate the Emscripten SDK first, e.g.:" >&2
    echo "  source /path/to/emsdk/emsdk_env.sh" >&2
    exit 1
fi

# Non-deployable link flavors (docs/EMSCRIPTEN.md "Link flavors"). Each one
# tags the build-id below, so prepare_deploy_bundle.sh / deploy.py refuse it.
#  - PROJECTM_WASM_GL_DEBUG=1: GL_TRACK_ERRORS=1 + GL_ASSERTIONS=1, so a bad
#    context attribute or GL call is reported instead of a black canvas.
#  - PROJECTM_WASM_EXPLICIT_SWAP=1: OFFSCREEN_FRAMEBUFFER=1, the only way the
#    pinned Emscripten honours explicitSwapControl without OFFSCREENCANVAS_SUPPORT
#    (which must stay off — it proxies GL off the render worker). FBO 0 becomes
#    an offscreen back buffer and render_frame()'s emscripten_webgl_commit_frame()
#    blits it to the canvas. The define lets the wrapper refuse explicit swap
#    with init code 9 in every other build.
flavor_compile_args=()
flavor_link_args=()
build_id_suffix=""
if [[ "$PROJECTM_WASM_DEBUG_EXPORTS" == "1" ]]; then
    build_id_suffix+="+debug-exports"
fi
if [[ "${PROJECTM_WASM_GL_DEBUG:-0}" == "1" ]]; then
    flavor_link_args+=(-sGL_TRACK_ERRORS=1 -sGL_ASSERTIONS=1)
    build_id_suffix+="+gl-debug"
fi
if [[ "${PROJECTM_WASM_EXPLICIT_SWAP:-0}" == "1" ]]; then
    flavor_compile_args+=(-DPROJECTM_WASM_OFFSCREEN_FRAMEBUFFER=1)
    flavor_link_args+=(-sOFFSCREEN_FRAMEBUFFER=1)
    build_id_suffix+="+explicit-swap"
fi

# The wrapper TUs are compiled to objects first, all at once, then linked in
# one em++ call. (One em++ call over the sources compiled them one after the
# other.) With LTO (PROJECTM_WASM_LTO=1, see cmake/EmscriptenWasmFlags.cmake)
# the static libs are LLVM bitcode and the link optimises across them; the
# wrapper objects stay native wasm even then: Emscripten 6.0.6 does not register
# EM_JS functions defined in bitcode as JS imports, so an -flto compile of
# WasmJsBindings.cpp & co. would leave every EM_JS call an undefined symbol.
obj_dir="$OUT_DIR/obj"
mkdir -p "$obj_dir"
wrapper_inputs=()
compile_pids=()
for src in "${wrapper_sources[@]}"; do
    obj="$obj_dir/$(basename "${src%.cpp}").o"
    "${emxx_cmd[@]}" -c "$src" \
        "${wrapper_include_args[@]}" \
        "${wrapper_warning_args[@]}" \
        "${wrapper_compile_args[@]}" \
        "${flavor_compile_args[@]}" \
        -o "$obj" &
    compile_pids+=("$!")
    wrapper_inputs+=("$obj")
done
# A bare `wait` returns 0 whatever the jobs did; check each one.
compile_failed=0
for pid in "${compile_pids[@]}"; do
    wait "$pid" || compile_failed=1
done
if [[ "$compile_failed" -ne 0 ]]; then
    echo "ERROR: a wrapper translation unit failed to compile" >&2
    exit 1
fi

# Extra em++ link flags, whitespace-separated — e.g. the debug CI leg's
# "-sASSERTIONS=2 -sSAFE_HEAP=1 -sSTACK_OVERFLOW_CHECK=2".
extra_link_args=()
read -r -a extra_link_args <<< "${PROJECTM_WASM_EXTRA_LINK_FLAGS:-}"

"${emxx_cmd[@]}" "${wrapper_inputs[@]}" \
    "${wrapper_warning_args[@]}" \
    "${simd_compile_args[@]}" \
    "${common_args[@]}" \
    "${flavor_link_args[@]}" \
    "${extra_link_args[@]}" \
    -s INVOKE_RUN=0 \
    "${libomp_args[@]}" \
    -o "$OUT_DIR/projectm-v.030-thread.js" \
    "$projectm_lib" \
    "$playlist_lib"

test -s "$OUT_DIR/projectm-v.030-thread.js"
test -s "$OUT_DIR/projectm-v.030-thread.wasm"

# What this bundle was built from; scripts/prepare_deploy_bundle.sh compares it
# with the tree it is about to deploy. Written last, so a failed link leaves the
# previous (now mismatching) id behind rather than a fresh one.
echo "$("$PROJECT_ROOT/scripts/wasm_source_fingerprint.sh")${build_id_suffix}" > "$OUT_DIR/projectm-v.030-thread.build-id"
