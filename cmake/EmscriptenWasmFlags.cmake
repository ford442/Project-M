# EmscriptenWasmFlags.cmake
#
# Single source of truth for Emscripten WASM build flags used by:
#   - CMake ENABLE_EMSCRIPTEN block (libprojectM static library build)
#   - scripts/wasm_link_common.inc.sh (final projectM_emscripten.cpp wrapper link)
#   - cmake/generated/ProjectMWasmBuildConfig.hpp (OpenMP / pthread pool cap)
#
# After editing this file (or cmake/WasmApiManifest.cmake), regenerate derived artifacts:
#   scripts/sync_wasm_link_common.sh
#
# CI verifies generated files via scripts/verify_wasm_link_common.sh
# and types via scripts/check_html_types.sh.

include("${CMAKE_CURRENT_LIST_DIR}/WasmApiManifest.cmake")

set(PROJECTM_WASM_PTHREAD_POOL_SIZE "4" CACHE STRING
    "Pre-spawned pthread Workers (PTHREAD_POOL_SIZE). Drives kWasmPthreadPoolSize in cmake/generated/ProjectMWasmBuildConfig.hpp.")

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
        _set_transparency_mode
        _get_transparency_mode
        _set_transparency_threshold
        _get_transparency_threshold
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
        _shader_cache_begin_load
        _shader_cache_import_glsl
        _shader_cache_end_load
        _get_glsl_generator_version
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

# EXPORTED_RUNTIME_METHODS shared by CMake lib link and shell wrapper link.
set(PROJECTM_WASM_EXPORTED_RUNTIME_METHODS
        ccall
        cwrap
        )

# Extra runtime methods for the final browser wrapper link (VFS preset loading).
set(PROJECTM_WASM_WRAPPER_EXPORTED_RUNTIME_METHODS_EXTRA
        FS
        )

set(_PROJECTM_WASM_EXPORTED_RUNTIME_METHODS_ALL ${PROJECTM_WASM_EXPORTED_RUNTIME_METHODS} ${PROJECTM_WASM_WRAPPER_EXPORTED_RUNTIME_METHODS_EXTRA})
list(JOIN PROJECTM_WASM_EXPORTED_RUNTIME_METHODS "," PROJECTM_WASM_EXPORTED_RUNTIME_METHODS_STR)
list(JOIN _PROJECTM_WASM_EXPORTED_RUNTIME_METHODS_ALL "," PROJECTM_WASM_WRAPPER_EXPORTED_RUNTIME_METHODS_STR)

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

# Plain emcc arguments shared by lib link (CMake) and wrapper link (shell).
set(PROJECTM_WASM_SHARED_PLAIN_LINK_ARGS
        -std=c++20
        -O3
        -rtlib=compiler-rt-mt
        -mtune=wasm32
        -pthread
        -fopenmp=libomp
        -fno-math-errno
        )

# -s settings shared by lib link and wrapper link.
set(PROJECTM_WASM_SHARED_S_LINK_SETTINGS
        "SHARED_MEMORY=1"
        "WASM_WORKERS=1"
        "MIN_WEBGL_VERSION=2"
        "MAX_WEBGL_VERSION=2"
        "USE_WEBGL2=1"
        "FULL_ES2=0"
        "FULL_ES3=1"
        "GL_POOL_TEMP_BUFFERS=0"
        "GL_MAX_TEMP_BUFFER_SIZE=33177600"
        "GL_TRACK_ERRORS=0"
        "NO_DISABLE_EXCEPTION_CATCHING=1"
        "ALLOW_MEMORY_GROWTH=1"
        "MALLOC=mimalloc"
        "MAXIMUM_MEMORY=4gb"
        "INITIAL_MEMORY=1024mb"
        "FORCE_FILESYSTEM=1"
        "ASYNCIFY=1"
        )

# -s settings applied only when linking libprojectM via CMake (not the shell wrapper).
set(PROJECTM_WASM_LIB_ONLY_S_LINK_SETTINGS
        "TRUSTED_TYPES=1"
        "WASM_BIGINT=1"
        "AUDIO_WORKLET=1"
        )

# -s settings applied only on the final projectM_emscripten.cpp wrapper link (shell).
set(PROJECTM_WASM_WRAPPER_ONLY_S_LINK_SETTINGS
        "ENVIRONMENT=web,worker"
        "EXPORT_NAME=createModule"
        "MODULARIZE=1"
        )

function(_projectm_wasm_expand_s_link_settings settings_list out_var)
    set(_expanded "")
    foreach(_setting IN LISTS ${settings_list})
        if(_setting MATCHES "^([^=]+)=(.*)$")
            list(APPEND _expanded "-s" "${CMAKE_MATCH_1}=${CMAKE_MATCH_2}")
        else()
            list(APPEND _expanded "-s" "${_setting}=1")
        endif()
    endforeach()
    set(${out_var} "${_expanded}" PARENT_SCOPE)
endfunction()

# Applies compile flags for building libprojectM static libraries with emcc.
function(projectm_apply_emscripten_lib_compile_flags)
    add_compile_options(
            "SHELL:-O3 -mtune=wasm32 "
            "SHELL:-s NO_DISABLE_EXCEPTION_CATCHING -s SHARED_MEMORY=1 -s WASM_WORKERS=1 "
            "SHELL:-msimd128 -mrelaxed-simd -fopenmp=libomp -mmutable-globals -mbulk-memory -matomics -mnontrapping-fptoint -msign-ext -fno-strict-aliasing -fno-math-errno -pthread"
            )
endfunction()

# Applies link flags for building libprojectM static libraries with emcc.
function(projectm_apply_emscripten_lib_link_flags)
    _projectm_wasm_expand_s_link_settings(PROJECTM_WASM_SHARED_S_LINK_SETTINGS _shared_s_args)
    _projectm_wasm_expand_s_link_settings(PROJECTM_WASM_LIB_ONLY_S_LINK_SETTINGS _lib_s_args)

    set(_all_link_args ${PROJECTM_WASM_SHARED_PLAIN_LINK_ARGS} ${_shared_s_args} ${_lib_s_args} ${PROJECTM_WASM_SIMD_COMPILE_FLAGS})
    string(JOIN " " _shell_args ${_all_link_args})
    string(APPEND _shell_args " -s PTHREAD_POOL_SIZE=${PROJECTM_WASM_PTHREAD_POOL_SIZE}")
    string(APPEND _shell_args " -s EXPORTED_RUNTIME_METHODS='${PROJECTM_WASM_EXPORTED_RUNTIME_METHODS_STR}'")
    string(APPEND _shell_args " -s EXPORTED_FUNCTIONS='${PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS_STR}'")
    add_link_options("SHELL:${_shell_args}")
endfunction()

# Applies ASYNCIFY stack tuning when dual-pipeline transitions are enabled.
function(projectm_apply_emscripten_wasm_transition_flags)
    if(ENABLE_WASM_TRANSITIONS)
        add_link_options("SHELL:-s ASYNCIFY_STACK_SIZE=65536")
    endif()
endfunction()
