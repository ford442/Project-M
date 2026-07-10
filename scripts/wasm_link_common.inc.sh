# wasm_link_common.inc.sh
# Shared Emscripten link flags for projectm-v.030-thread.js builds.
# Source from build_wasm_smoke_wrapper.sh, build_projectm.sh, colab_build.sh:
#   source "$(dirname "${BASH_SOURCE[0]}")/wasm_link_common.inc.sh"

# shellcheck disable=SC2034  # consumed by sourcing scripts
PROJECTM_WASM_EXPORTED_FUNCTIONS=(
    _add_audio_data
    _main
    _pl
    _destruct
    _get_projectm_handle
    _init
    _load_preset_file
    _switch_preset
    _set_aspect_correction
    _render_frame
    _start_render
    _set_window_size
    _set_mesh
    _add_preset_path
    _add_existing_vfs_presets
    _add_preset_file
    _add_custom_milk_paths
    _projectm_pcm_add_float_wrapper
    _create_sprite
    _stop_worklet_playback
    _set_audio_source_to_stream
    _set_preset_locked
    _dual_fbo_begin_transition
    _dual_fbo_is_preset_b_allocated
    _dual_fbo_is_preset_b_ready
    _dual_fbo_get_format
    _transition_start
    _transition_is_active
    _transition_set_duration
    _transition_get_duration
    _set_perf_hud
    _set_target_fps
    _set_quality_governor
    _get_quality_tier
    _is_preset_ready
    _get_rendered_frame_count
    _preset_switch_failed
    _get_omp_enabled
    _get_omp_max_threads
    _get_omp_thread_count_in_parallel
)

projectm_wasm_join_exported_functions() {
    local IFS=,
    echo "${PROJECTM_WASM_EXPORTED_FUNCTIONS[*]}"
}

# SIMD + atomics compile flags for the final emcc link of projectM_emscripten.cpp.
# Must stay in sync with ENABLE_EMSCRIPTEN add_compile_options in CMakeLists.txt so
# the wrapper TU and prebuilt libprojectM-4.a agree on wasm32 feature levels.
projectm_wasm_simd_compile_args() {
    local -n _out=$1
    _out=(
        -msimd128
        -mrelaxed-simd
        -mmutable-globals
        -mbulk-memory
        -matomics
        -mnontrapping-fptoint
        -msign-ext
        -fno-strict-aliasing
        -fno-math-errno
    )
}

# Common emcc arguments (array). Caller may append lib paths and -o.
# Optional env overrides:
#   PROJECTM_WASM_LTO=1              add -flto to the final wrapper link (link-time only)
#   PROJECTM_WASM_PTHREAD_POOL_SIZE  pre-spawned pthread Workers (default 4)
#   ENABLE_WASM_TRANSITIONS=ON       (default) adds ASYNCIFY_STACK_SIZE
projectm_wasm_pthread_pool_size() {
    echo "${PROJECTM_WASM_PTHREAD_POOL_SIZE:-4}"
}

projectm_wasm_common_link_args() {
    local -n _out=$1
    local pthread_pool_size
    pthread_pool_size="$(projectm_wasm_pthread_pool_size)"
    local transition_args=()
    if [[ "${ENABLE_WASM_TRANSITIONS:-ON}" == "ON" ]]; then
        transition_args+=("-s" "ASYNCIFY_STACK_SIZE=65536")
    fi

    local lto_args=()
    if [[ "${PROJECTM_WASM_LTO:-0}" == "1" ]]; then
        lto_args+=("-flto")
    fi

    local simd_args=()
    projectm_wasm_simd_compile_args simd_args

    _out=(
        -O3
        "${lto_args[@]}"
        "${simd_args[@]}"
        -l embind
        -pthread
        -fopenmp=libomp
        -s ALLOW_MEMORY_GROWTH=1
        -s NO_DISABLE_EXCEPTION_CATCHING=1
        -s ENVIRONMENT=web,worker
        -s SHARED_MEMORY=1
        -s EXPORTED_FUNCTIONS="$(projectm_wasm_join_exported_functions)"
        -s EXPORTED_RUNTIME_METHODS=ccall,FS
        -s EXPORT_NAME=createModule
        -s "PTHREAD_POOL_SIZE=${pthread_pool_size}"
        -s FULL_ES2=0
        -s FULL_ES3=1
        -s MIN_WEBGL_VERSION=2
        -s MAX_WEBGL_VERSION=2
        -s MODULARIZE=1
        -s ASYNCIFY=1
        "${transition_args[@]}"
        -s FORCE_FILESYSTEM=1
    )
}

projectm_wasm_libomp_args() {
    local root="${1:-}"
    if [[ -f "$root/libomp.a" ]]; then
        echo "$root/libomp.a"
    elif [[ -f "$root/omp/libomp.a" ]]; then
        echo "$root/omp/libomp.a"
    fi
}
