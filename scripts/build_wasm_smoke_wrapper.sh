#!/usr/bin/env bash
# Links the browser bundle (cmake-build/wasm-smoke/projectm-v.030-thread.{js,wasm})
# from the src/wasm/ wrapper TUs and the static libraries scripts/build_wasm_install.sh
# installed. Normally run through scripts/build_wasm.sh, which builds the
# libraries first; see docs/EMSCRIPTEN.md ("Building the bundle").
#
# The wrapper TUs are compiled the way the libraries were: the arguments come
# from <CMAKE_BUILD_DIR>/projectm-wasm-wrapper-flags.txt, which the CMake
# configure writes (config.h, compile definitions, NDEBUG, LTO). There is no LTO
# switch here; the link follows the libraries.
#
# Env: INSTALL_DIR, CMAKE_BUILD_DIR, OUT_DIR; flavors (never deployed, they tag
# the build-id): PROJECTM_WASM_DEBUG=1 (ASSERTIONS=2 + SAFE_HEAP +
# STACK_OVERFLOW_CHECK=2), PROJECTM_WASM_GL_DEBUG=1, PROJECTM_WASM_EXPLICIT_SWAP=1;
# PROJECTM_WASM_EXTRA_LINK_FLAGS, PROJECTM_WASM_WERROR=1.
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

projectm_wasm_wrapper_include_args() {
    local -n _out=$1
    _out=(
        -I "$INSTALL_DIR/include"
        -I "$PROJECT_ROOT"
        -I "$PROJECT_ROOT/cmake/generated"
        -I "$PROJECT_ROOT/omp"
        -I "$LIBPROJECTM_SOURCE_INCLUDE"
        -I "$LIBPROJECTM_GENERATED_INCLUDE"
        # projectM_cxx_export.h, for Logging.hpp (WasmLog.cpp).
        -I "$CMAKE_BUILD_DIR/src/api/include"
        -I "$PROJECT_ROOT/vendor/hlslparser/src"
        -I "$PROJECT_ROOT/vendor/glad/include"
        -I "$PROJECT_ROOT/vendor"
    )
}

# How the libraries were compiled (cmake/EmscriptenWasmFlags.cmake,
# projectm_write_emscripten_wrapper_flags()): one argument per line.
wrapper_flags_file="$CMAKE_BUILD_DIR/projectm-wasm-wrapper-flags.txt"
if [[ ! -s "$wrapper_flags_file" ]]; then
    echo "ERROR: $wrapper_flags_file is missing; this build dir was configured by an older tree." >&2
    echo "Re-run scripts/build_wasm.sh (or scripts/build_wasm_install.sh) to reconfigure it." >&2
    exit 1
fi
lib_compile_args=()
lib_lto=""
lib_ndebug=0
while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
        "" | "-D") ;; # a definition that evaluated to nothing
        -DPROJECTM_WASM_LIB_LTO=*) lib_lto="${line#-DPROJECTM_WASM_LIB_LTO=}" ;;
        -DNDEBUG)
            lib_ndebug=1
            lib_compile_args+=("$line")
            ;;
        *) lib_compile_args+=("$line") ;;
    esac
done < "$wrapper_flags_file"
if [[ "$lib_lto" != "0" && "$lib_lto" != "1" ]]; then
    echo "ERROR: $wrapper_flags_file does not record PROJECTM_WASM_LIB_LTO" >&2
    exit 1
fi

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

# LTO has one switch, the libraries' CMake configure. Check the archives say
# the same (LLVM bitcode members with LTO, wasm objects without), so libraries
# installed from a different build dir than CMAKE_BUILD_DIR cannot slip by, and
# refuse a PROJECTM_WASM_LTO in the environment that disagrees.
archive_member_kind() {
    python3 - "$1" <<'PY'
import sys
data = open(sys.argv[1], "rb").read()
bitcode = data.count(b"BC\xc0\xde")
wasm = data.count(b"\x00asm\x01\x00\x00\x00")
print("bitcode" if bitcode and not wasm else "wasm" if wasm and not bitcode else "mixed" if wasm else "unknown")
PY
}
expected_kind=$([[ "$lib_lto" == "1" ]] && echo bitcode || echo wasm)
for lib in "$projectm_lib" "$playlist_lib"; do
    kind="$(archive_member_kind "$lib")"
    if [[ "$kind" != "$expected_kind" ]]; then
        echo "ERROR: $lib holds $kind objects, but $wrapper_flags_file says PROJECTM_WASM_LTO=$lib_lto ($expected_kind)." >&2
        echo "INSTALL_DIR and CMAKE_BUILD_DIR must come from the same scripts/build_wasm.sh run." >&2
        exit 1
    fi
done
if [[ -n "${PROJECTM_WASM_LTO:-}" && "${PROJECTM_WASM_LTO}" != "$lib_lto" ]]; then
    echo "ERROR: PROJECTM_WASM_LTO=${PROJECTM_WASM_LTO}, but the libraries in $INSTALL_DIR were built with PROJECTM_WASM_LTO=$lib_lto." >&2
    echo "LTO is chosen when the libraries are configured: scripts/build_wasm.sh [--lto]." >&2
    exit 1
fi
export PROJECTM_WASM_LTO="$lib_lto"

libomp_path="$(projectm_wasm_libomp_args "$PROJECT_ROOT")"
libomp_args=()
if [[ -n "$libomp_path" ]]; then
    libomp_args+=("$libomp_path")
else
    echo "Warning: libomp.a not found; OpenMP runtime will not be linked" >&2
fi

common_args=()
projectm_wasm_common_link_args common_args

simd_compile_args=()
projectm_wasm_simd_compile_args simd_compile_args
codegen_compile_args=()
projectm_wasm_codegen_compile_args codegen_compile_args

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
    "$PROJECT_ROOT/src/wasm/WasmLog.cpp"
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
if [[ "${PROJECTM_WASM_GL_DEBUG:-0}" == "1" ]]; then
    flavor_link_args+=(-sGL_TRACK_ERRORS=1 -sGL_ASSERTIONS=1)
    build_id_suffix+="+gl-debug"
fi
if [[ "${PROJECTM_WASM_EXPLICIT_SWAP:-0}" == "1" ]]; then
    flavor_compile_args+=(-DPROJECTM_WASM_OFFSCREEN_FRAMEBUFFER=1)
    flavor_link_args+=(-sOFFSCREEN_FRAMEBUFFER=1)
    build_id_suffix+="+explicit-swap"
fi
#  - PROJECTM_WASM_DEBUG=1: Emscripten's runtime checks. SAFE_HEAP traps on a
#    null or wild pointer, STACK_OVERFLOW_CHECK=2 on a thread overrunning its
#    stack (the prepare thread's recursive parsers), ASSERTIONS=2 on misuse of
#    the runtime (pthread pool exhaustion included).
if [[ "${PROJECTM_WASM_DEBUG:-0}" == "1" ]]; then
    flavor_link_args+=(-sASSERTIONS=2 -sSAFE_HEAP=1 -sSTACK_OVERFLOW_CHECK=2)
    build_id_suffix+="+debug"
fi

# LTO (PROJECTM_WASM_LTO=1, see cmake/EmscriptenWasmFlags.cmake): the static
# libs are LLVM bitcode and the link optimises across them. The wrapper TUs are
# still compiled to native wasm objects first: Emscripten 6.0.6 does not register
# EM_JS functions defined in bitcode as JS imports, so an -flto compile of
# WasmJsBindings.cpp & co. leaves every EM_JS call an undefined symbol at link.
wrapper_inputs=("${wrapper_sources[@]}")
if [[ "${PROJECTM_WASM_LTO:-0}" == "1" ]]; then
    obj_dir="$OUT_DIR/obj"
    mkdir -p "$obj_dir"
    # Compile flags only: not -flto (native objects, above), and not the link
    # settings (-s X=Y, --pre-js, --emit-symbol-map), which em++ rejects under
    # -Werror at -c ("linker setting ignored during compilation").
    compile_args=()
    skip_next=0
    for arg in "${common_args[@]}"; do
        if [[ "$skip_next" == "1" ]]; then
            skip_next=0
            continue
        fi
        case "$arg" in
            -flto | --emit-symbol-map | -s[A-Z]*) ;; # not -std=
            -s | --pre-js) skip_next=1 ;;
            *) compile_args+=("$arg") ;;
        esac
    done
    wrapper_inputs=()
    compile_pids=()
    for src in "${wrapper_sources[@]}"; do
        obj="$obj_dir/$(basename "${src%.cpp}").o"
        "${emxx_cmd[@]}" -c "$src" \
            "${wrapper_include_args[@]}" \
            "${lib_compile_args[@]}" \
            "${wrapper_warning_args[@]}" \
            "${simd_compile_args[@]}" \
            "${codegen_compile_args[@]}" \
            "${flavor_compile_args[@]}" \
            "${compile_args[@]}" \
            -o "$obj" &
        compile_pids+=("$!")
        wrapper_inputs+=("$obj")
    done
    # A bare `wait` returns 0 whatever the jobs did; check each one.
    for pid in "${compile_pids[@]}"; do
        wait "$pid"
    done
fi

# Extra em++ link flags, whitespace-separated — e.g. the debug CI leg's
# "-sASSERTIONS=2 -sSAFE_HEAP=1 -sSTACK_OVERFLOW_CHECK=2".
extra_link_args=()
read -r -a extra_link_args <<< "${PROJECTM_WASM_EXTRA_LINK_FLAGS:-}"

"${emxx_cmd[@]}" "${wrapper_inputs[@]}" \
    "${wrapper_include_args[@]}" \
    "${lib_compile_args[@]}" \
    "${wrapper_warning_args[@]}" \
    "${simd_compile_args[@]}" \
    "${codegen_compile_args[@]}" \
    "${common_args[@]}" \
    "${flavor_compile_args[@]}" \
    "${flavor_link_args[@]}" \
    "${extra_link_args[@]}" \
    "${libomp_args[@]}" \
    -o "$OUT_DIR/projectm-v.030-thread.js" \
    "$projectm_lib" \
    "$playlist_lib"

test -s "$OUT_DIR/projectm-v.030-thread.js"
test -s "$OUT_DIR/projectm-v.030-thread.wasm"

# What this bundle was built from, and what it is. Line 1 is the source
# fingerprint (+flavor tags), which scripts/prepare_deploy_bundle.sh and
# deploy.py compare with the tree they deploy; the rest are key=value facts:
# the binary hashes (deploy.py checks every staged copy and .br/.gz sibling
# against them; two builds of one tree with one emsdk give the same ones) and
# the build settings scripts/check_wasm_bundle_features.sh asserts. Written
# last, so a failed link leaves the previous (now mismatching) id behind.
{
    echo "$("$PROJECT_ROOT/scripts/wasm_source_fingerprint.sh")${build_id_suffix}"
    echo "wasm-sha256=$(sha256sum "$OUT_DIR/projectm-v.030-thread.wasm" | cut -d' ' -f1)"
    echo "js-sha256=$(sha256sum "$OUT_DIR/projectm-v.030-thread.js" | cut -d' ' -f1)"
    echo "lto-libs=$lib_lto"
    echo "lto-link=$PROJECTM_WASM_LTO"
    echo "ndebug=$lib_ndebug"
    echo "emcc=$("${emxx_cmd[0]}" --version 2>/dev/null | head -n1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
} > "$OUT_DIR/projectm-v.030-thread.build-id"
