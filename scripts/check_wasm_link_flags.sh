#!/usr/bin/env bash
# check_wasm_link_flags.sh — the WASM build's compile and link flags, per flavor,
# against committed snapshots (tests/wasm-smoke/link-flags/<flavor>.txt), so any
# change to what the bundle is built with shows up as a diff in review.
#
#   scripts/check_wasm_link_flags.sh <emscripten-build-dir>            # compare (CI)
#   scripts/check_wasm_link_flags.sh <emscripten-build-dir> --update   # rewrite the snapshots
#
# The build dir is the one scripts/build_wasm.sh configured (Ninja). For each
# flavor the script re-runs CMake's configure with that flavor's cache options
# and asks Ninja for the commands it would run (`ninja -t commands`): nothing is
# compiled or linked. Each snapshot holds three command lines, one argument per
# line (a `-s` and its setting together):
#   - a wrapper TU's compile (src/wasm/WasmHost.cpp),
#   - a library TU's compile (src/libprojectM/ProjectM.cpp),
#   - the bundle link (projectM_wasm).
# Paths are rewritten to <src>/<build>, the compiler to its basename, and the
# EXPORTED_FUNCTIONS list (cmake/WasmApiManifest.cmake, checked by
# scripts/check_wasm_api_dts.mjs) to a placeholder, so adding an export does not
# touch a snapshot. The cache options the build dir had are put back at the end.
#
# Flavors (docs/EMSCRIPTEN.md "Build flavors"):
#   release        the deployed bundle
#   profile        PROJECTM_WASM_PROFILE + PROJECTM_WASM_DEBUG_INFO (scripts/build_wasm.sh --flavor profile)
#   debug          PROJECTM_WASM_DEBUG (--flavor debug)
#   gl-debug       PROJECTM_WASM_GL_DEBUG
#   explicit-swap  PROJECTM_WASM_EXPLICIT_SWAP
#   dlmalloc       PROJECTM_WASM_MALLOC=dlmalloc
#   lto            PROJECTM_WASM_LTO (--lto)
#
# Needs cmake and ninja; emsdk only in the sense that the build dir was
# configured with it (the compiler is not run).
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_DIR="$PROJECT_ROOT/tests/wasm-smoke/link-flags"

build_dir="${1:?usage: scripts/check_wasm_link_flags.sh <emscripten-build-dir> [--update]}"
update=0
[[ "${2:-}" == "--update" ]] && update=1
build_dir="$(cd "$build_dir" && pwd)"

if [[ ! -f "$build_dir/CMakeCache.txt" || ! -f "$build_dir/build.ninja" ]]; then
    echo "check_wasm_link_flags: $build_dir is not a configured Ninja build dir (run scripts/build_wasm.sh first)." >&2
    exit 2
fi
if ! grep -q '^ENABLE_EMSCRIPTEN:[A-Z]*=ON' "$build_dir/CMakeCache.txt"; then
    echo "check_wasm_link_flags: $build_dir is not an Emscripten build dir." >&2
    exit 2
fi
command -v ninja >/dev/null || { echo "check_wasm_link_flags: ninja not on PATH" >&2; exit 2; }

cache_value() {
    sed -n "s/^$1:[A-Z]*=//p" "$build_dir/CMakeCache.txt" | head -n1
}

# The cache options a flavor sets; every flavor sets all of them.
FLAVOR_OPTIONS=(PROJECTM_WASM_PROFILE PROJECTM_WASM_DEBUG_INFO PROJECTM_WASM_DEBUG PROJECTM_WASM_GL_DEBUG
    PROJECTM_WASM_EXPLICIT_SWAP PROJECTM_WASM_LTO)
saved=()
for option in "${FLAVOR_OPTIONS[@]}" PROJECTM_WASM_MALLOC PROJECTM_WASM_EXTRA_LINK_FLAGS PROJECTM_WASM_WERROR; do
    saved+=("-D$option=$(cache_value "$option")")
done
restore() {
    cmake "$build_dir" "${saved[@]}" >/dev/null 2>&1 || echo "check_wasm_link_flags: could not restore $build_dir's cache options" >&2
}
trap restore EXIT

flavor_args() {
    local on=()
    case "$1" in
        release) ;;
        profile) on=(PROJECTM_WASM_PROFILE PROJECTM_WASM_DEBUG_INFO) ;;
        debug) on=(PROJECTM_WASM_DEBUG) ;;
        gl-debug) on=(PROJECTM_WASM_GL_DEBUG) ;;
        explicit-swap) on=(PROJECTM_WASM_EXPLICIT_SWAP) ;;
        dlmalloc) ;;
        lto) on=(PROJECTM_WASM_LTO) ;;
        *) echo "unknown flavor $1" >&2; return 1 ;;
    esac
    local option value
    for option in "${FLAVOR_OPTIONS[@]}"; do
        value=OFF
        [[ " ${on[*]-} " == *" $option "* ]] && value=ON
        printf '%s\n' "-D$option=$value"
    done
    if [[ "$1" == "dlmalloc" ]]; then
        printf '%s\n' "-DPROJECTM_WASM_MALLOC=dlmalloc"
    else
        printf '%s\n' "-DPROJECTM_WASM_MALLOC=mimalloc"
    fi
    # Neither is a flavor: CI's -Werror and a measurement's extra link flags stay out.
    printf '%s\n' "-DPROJECTM_WASM_EXTRA_LINK_FLAGS=" "-DPROJECTM_WASM_WERROR=OFF"
}

# One command line → one argument per line, normalized.
NORMALIZE_PY="$(cat <<'PY'
import shlex, sys
root, build, line = sys.argv[1], sys.argv[2], sys.argv[3].strip()
# Ninja wraps link commands as ": && <cmd> && :".
parts = [p.strip() for p in line.split('&&')]
cmd = next(p for p in parts if p and p != ':')
args = shlex.split(cmd)
out = []
skip_next = False
for i, arg in enumerate(args):
    if skip_next:
        skip_next = False
        continue
    if i == 0:
        out.append(arg.rsplit('/', 1)[-1])
        continue
    # Dependency-file and output bookkeeping of a compile: not a flag.
    if arg in ('-MD',):
        continue
    if arg in ('-MT', '-MF', '-o', '-c'):
        skip_next = True
        continue
    arg = arg.replace(build, '<build>').replace(root, '<src>')
    # cmake/EmscriptenOpenMP.cmake takes libomp.a from the repo root (CI builds
    # it there) or omp/ (unpacked from omp/omp.zip): the same archive.
    if arg.endswith('/libomp.a'):
        arg = '<libomp.a>'
    if arg.startswith('EXPORTED_FUNCTIONS='):
        arg = 'EXPORTED_FUNCTIONS=<cmake/WasmApiManifest.cmake>'
    if out and out[-1] == '-s':
        out[-1] = f'-s {arg}'
    elif arg == '':
        continue
    else:
        out.append(arg)
print('\n'.join(out))
PY
)"
normalize() {
    python3 -c "$NORMALIZE_PY" "$PROJECT_ROOT" "$build_dir" "$1"
}

# `ninja -t commands <target>` lists every command, inputs first; pick ours.
commands_for() {
    ninja -C "$build_dir" -t commands "$1" 2>/dev/null
}

render_flavor() {
    local flavor="$1"
    mapfile -t args < <(flavor_args "$flavor")
    cmake "$build_dir" "${args[@]}" >/dev/null
    local bundle="src/wasm/projectm-v.030-thread.js"
    local all
    all="$(commands_for "$bundle")"
    local wrapper_compile library_compile link
    wrapper_compile="$(grep -F -- '/src/wasm/WasmHost.cpp' <<<"$all" | grep -F -- ' -c ' | tail -n1)"
    library_compile="$(grep -F -- '/src/libprojectM/ProjectM.cpp' <<<"$all" | grep -F -- ' -c ' | tail -n1)"
    link="$(grep -F -- '-o src/wasm/projectm-v.030-thread.js' <<<"$all" | tail -n1)"
    for name in wrapper_compile library_compile link; do
        if [[ -z "${!name}" ]]; then
            echo "check_wasm_link_flags: no $name command for $flavor in $build_dir (Ninja's command list changed?)" >&2
            return 1
        fi
    done
    echo "# Generated by scripts/check_wasm_link_flags.sh --update. Flavor: $flavor"
    echo "# The flags this flavor is built with; a diff here is a change to the bundle's build."
    echo
    echo "## wrapper compile (src/wasm/WasmHost.cpp)"
    normalize "$wrapper_compile"
    echo
    echo "## library compile (src/libprojectM/ProjectM.cpp)"
    normalize "$library_compile"
    echo
    echo "## bundle link (projectM_wasm)"
    # The object and archive inputs are listed as such, in link order.
    normalize "$link"
}

FLAVORS=(release profile debug gl-debug explicit-swap dlmalloc lto)
mkdir -p "$SNAPSHOT_DIR"
failed=0
for flavor in "${FLAVORS[@]}"; do
    snapshot="$SNAPSHOT_DIR/$flavor.txt"
    current="$(render_flavor "$flavor")"
    if [[ "$update" == "1" ]]; then
        printf '%s\n' "$current" > "$snapshot"
        echo "wrote ${snapshot#"$PROJECT_ROOT"/}"
    elif [[ ! -f "$snapshot" ]]; then
        echo "FAIL: ${snapshot#"$PROJECT_ROOT"/} is missing" >&2
        failed=1
    elif ! diff -u "$snapshot" <(printf '%s\n' "$current") > /dev/null; then
        echo "FAIL: $flavor flags differ from ${snapshot#"$PROJECT_ROOT"/}:" >&2
        diff -u "$snapshot" <(printf '%s\n' "$current") | sed -n '3,$p' >&2 || true
        failed=1
    else
        echo "ok   $flavor"
    fi
done
# Stale snapshots for flavors this script no longer renders.
for snapshot in "$SNAPSHOT_DIR"/*.txt; do
    name="$(basename "$snapshot" .txt)"
    if [[ " ${FLAVORS[*]} " != *" $name "* ]]; then
        echo "FAIL: ${snapshot#"$PROJECT_ROOT"/} has no flavor; delete it" >&2
        failed=1
    fi
done

if [[ "$failed" != "0" ]]; then
    echo >&2
    echo "The WASM build flags changed. If that is intended, run" >&2
    echo "  scripts/check_wasm_link_flags.sh <build-dir> --update" >&2
    echo "and commit tests/wasm-smoke/link-flags/ with the change (docs/EMSCRIPTEN.md \"Flag matrix\")." >&2
    exit 1
fi
[[ "$update" == "1" ]] || echo "WASM build flags match tests/wasm-smoke/link-flags/ (${#FLAVORS[@]} flavors)"
