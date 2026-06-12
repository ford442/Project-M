#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR="${INSTALL_DIR:-"$PROJECT_ROOT/install"}"
OUT_DIR="${OUT_DIR:-"$PROJECT_ROOT/cmake-build/wasm-smoke"}"

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

libomp_args=()
if [[ -f "$PROJECT_ROOT/libomp.a" ]]; then
    libomp_args+=("$PROJECT_ROOT/libomp.a")
fi

transition_args=()
if [[ "${ENABLE_WASM_TRANSITIONS:-ON}" == "ON" ]]; then
    transition_args+=("-s" "ASYNCIFY_STACK_SIZE=65536")
fi

emcc "$PROJECT_ROOT/projectM_emscripten.cpp" \
    -I "$INSTALL_DIR/include" \
    -I "$PROJECT_ROOT" \
    -O3 \
    -l embind \
    -pthread \
    -fopenmp \
    "${libomp_args[@]}" \
    -o "$OUT_DIR/projectm-v.030-thread.js" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s NO_DISABLE_EXCEPTION_CATCHING=1 \
    -s ENVIRONMENT=web,worker \
    -s SHARED_MEMORY=1 \
    -s EXPORTED_FUNCTIONS=_add_audio_data,_main,_pl,_destruct,_get_projectm_handle,_init,_load_preset_file,_switch_preset,_set_aspect_correction,_render_frame,_start_render,_set_window_size,_set_mesh,_add_preset_path,_add_existing_vfs_presets,_add_preset_file,_add_custom_milk_paths,_projectm_pcm_add_float_wrapper,_create_sprite,_stop_worklet_playback,_set_audio_source_to_stream,_set_preset_locked,_dual_fbo_begin_transition,_dual_fbo_is_preset_b_allocated,_dual_fbo_is_preset_b_ready,_transition_start,_transition_is_active,_set_perf_hud \
    -s EXPORTED_RUNTIME_METHODS=ccall,FS \
    -s EXPORT_NAME=createModule \
    -s INVOKE_RUN=0 \
    -s MODULARIZE=1 \
    -s PTHREAD_POOL_SIZE=4 \
    -s FULL_ES2=0 \
    -s FULL_ES3=1 \
    -s MIN_WEBGL_VERSION=2 \
    -s MAX_WEBGL_VERSION=2 \
    -s ASYNCIFY=1 \
    "${transition_args[@]}" \
    -s FORCE_FILESYSTEM=1 \
    "$projectm_lib" \
    "$playlist_lib"

test -s "$OUT_DIR/projectm-v.030-thread.js"
test -s "$OUT_DIR/projectm-v.030-thread.wasm"
