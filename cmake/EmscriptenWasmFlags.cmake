# EmscriptenWasmFlags.cmake
#
# Single source of truth for Emscripten WASM build flags used by:
#   - CMake ENABLE_EMSCRIPTEN block (libprojectM static library build)
#   - scripts/wasm_link_common.inc.sh (final projectM_emscripten.cpp wrapper link)
#   - scripts/build_wasm_smoke_wrapper.sh, colab_build.sh, build_projectm.sh
#
# After editing this file, regenerate the shell include:
#   scripts/sync_wasm_link_common.sh
#
# CI verifies the generated file is up to date via scripts/verify_wasm_link_common.sh.

set(PROJECTM_WASM_PTHREAD_POOL_SIZE "4" CACHE STRING
    "Pre-spawned pthread Workers (PTHREAD_POOL_SIZE). Must match kWasmPthreadPoolSize in projectM_emscripten.cpp.")

# Browser wrapper exports (projectM_emscripten.cpp final emcc link).
# Every EMSCRIPTEN_KEEPALIVE symbol plus legacy add_audio_data and runtime helpers.
set(PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS
        _malloc
        _free
        _main
        _add_audio_data
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
        _pm_handle_context_loss
        _dual_fbo_begin_transition
        _dual_fbo_end_transition
        _dual_fbo_cancel_transition
        _dual_fbo_swap_preset_a
        _dual_fbo_swap_preset_b
        _dual_fbo_get_a_read_fbo
        _dual_fbo_get_a_write_fbo
        _dual_fbo_get_a_read_tex
        _dual_fbo_get_a_write_tex
        _dual_fbo_get_b_read_fbo
        _dual_fbo_get_b_write_fbo
        _dual_fbo_get_b_read_tex
        _dual_fbo_get_b_write_tex
        _dual_fbo_is_preset_b_allocated
        _dual_fbo_is_preset_b_ready
        _dual_fbo_get_format
        _dual_fbo_render_preset_a
        _dual_fbo_render_preset_b
        _transition_start
        _transition_cancel
        _transition_is_active
        _transition_get_blend
        _transition_set_duration
        _transition_get_duration
        )

list(JOIN PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS "," PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS_STR)

# SIMD + atomics flags shared by the lib build and the wrapper TU link.
set(PROJECTM_WASM_SIMD_COMPILE_FLAGS
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

# Applies compile flags for building libprojectM static libraries with emcc.
function(projectm_apply_emscripten_lib_compile_flags)
    add_compile_options(
            "SHELL:-O3 -mtune=wasm32 "
            "SHELL:-s NO_DISABLE_EXCEPTION_CATCHING -s SHARED_MEMORY=1 -s WASM_WORKERS=1 "
            "SHELL:-msimd128 -mrelaxed-simd -fopenmp=libomp -mmutable-globals -mbulk-memory -matomics -mnontrapping-fptoint -msign-ext -fno-strict-aliasing -fno-math-errno -pthread"
            )
endfunction()

# Applies link flags for building libprojectM static libraries with emcc.
# EXPORTED_FUNCTIONS here only affects final executables; the browser bundle is
# linked separately via scripts/build_wasm_smoke_wrapper.sh.
function(projectm_apply_emscripten_lib_link_flags)
    add_link_options(
            "SHELL:-std=c++20 -O3 -rtlib=compiler-rt-mt -mtune=wasm32 -s SHARED_MEMORY=1 -s WASM_WORKERS=1 -pthread "
            "SHELL:-s PTHREAD_POOL_SIZE=${PROJECTM_WASM_PTHREAD_POOL_SIZE} "
            "SHELL:-s MIN_WEBGL_VERSION=2 "
            "SHELL:-s MAX_WEBGL_VERSION=2 "
            "SHELL:-s USE_WEBGL2=1 -s FULL_ES2=0 -s FULL_ES3=1 -s GL_POOL_TEMP_BUFFERS=0 -s GL_MAX_TEMP_BUFFER_SIZE=33177600 -s GL_TRACK_ERRORS=0 "
            "SHELL:-s NO_DISABLE_EXCEPTION_CATCHING -s ALLOW_MEMORY_GROWTH=1 -sMALLOC='mimalloc' -sMAXIMUM_MEMORY=4gb -sINITIAL_MEMORY=1024mb "
            "SHELL:-msimd128 -mrelaxed-simd -fopenmp=libomp -mmutable-globals -mbulk-memory -matomics -mnontrapping-fptoint -msign-ext -fno-strict-aliasing "
            "SHELL:--typed-function-references --enable-reference-types -fno-math-errno "
            "SHELL:-s TRUSTED_TYPES=1 -s WASM_BIGINT=1 -sAUDIO_WORKLET=1 "
            "SHELL:-s FORCE_FILESYSTEM=1 -s ASYNCIFY=1 -s EXPORTED_RUNTIME_METHODS='ccall,cwrap' -s EXPORTED_FUNCTIONS='${PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS_STR}'"
            )
endfunction()

# Applies ASYNCIFY stack tuning when dual-pipeline transitions are enabled.
function(projectm_apply_emscripten_wasm_transition_flags)
    if(ENABLE_WASM_TRANSITIONS)
        add_link_options("SHELL:-s ASYNCIFY_STACK_SIZE=65536")
    endif()
endfunction()
