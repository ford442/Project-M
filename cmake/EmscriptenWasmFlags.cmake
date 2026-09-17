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

# C++ exception ABI. It is baked into every object file, so libprojectM-4.a, the
# playlist lib and the wrapper TUs must all be built with the same value — a
# link-only switch is not possible. The shell wrapper link reads the same choice
# from the PROJECTM_WASM_EXCEPTIONS environment variable.
#   wasm  -fwasm-exceptions (native Wasm exception handling). Default. Emscripten
#         6.0.6 emits the legacy EH encoding (try/catch, not try_table): Chrome 95,
#         Firefox 100, Safari 15.2 — below the SharedArrayBuffer floor this build
#         already has. -6.7% .wasm / -6.0% JS glue vs js, and no invoke_* JS
#         trampoline around every call that may throw.
#         emcc warns "ASYNCIFY=1 is not compatible with -fwasm-exceptions": a
#         function that is both Asyncify-instrumented and contains a try/catch
#         fails to *compile*. It is fine here because ASYNCIFY_ONLY
#         (cmake/wasm_asyncify_only.txt) instruments only the three
#         load_preset_file* frames, none of which has a try — keep it that way.
#   js    -s NO_DISABLE_EXCEPTION_CATCHING=1 (JS-based invoke_* trampolines). The
#         previous default ABI; kept selectable for bisecting.
# A mismatch between libs and wrapper fails at link time, not at runtime
# (undefined __resumeException, or __cpp_exception / __gxx_wasm_personality_v0).
# Verification: tests/wasm-smoke/index.html "known-bad preset" step, which fails
# when a thrown MilkdropPresetLoadException is not caught.
set(PROJECTM_WASM_EXCEPTIONS "wasm" CACHE STRING
    "C++ exception ABI for every WASM TU: js (NO_DISABLE_EXCEPTION_CATCHING) or wasm (-fwasm-exceptions).")
set_property(CACHE PROJECTM_WASM_EXCEPTIONS PROPERTY STRINGS js wasm)
set(PROJECTM_WASM_EXCEPTION_ARGS_JS -s NO_DISABLE_EXCEPTION_CATCHING=1)
set(PROJECTM_WASM_EXCEPTION_ARGS_WASM -fwasm-exceptions)
if(PROJECTM_WASM_EXCEPTIONS STREQUAL "js")
    set(PROJECTM_WASM_EXCEPTION_ARGS ${PROJECTM_WASM_EXCEPTION_ARGS_JS})
elseif(PROJECTM_WASM_EXCEPTIONS STREQUAL "wasm")
    set(PROJECTM_WASM_EXCEPTION_ARGS ${PROJECTM_WASM_EXCEPTION_ARGS_WASM})
else()
    message(FATAL_ERROR "PROJECTM_WASM_EXCEPTIONS must be js or wasm, got '${PROJECTM_WASM_EXCEPTIONS}'")
endif()

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
        _set_canvas_selectors
        _set_context_config
        _init_with_canvases
        _rebind_canvases
        _create_host
        _set_active_host
        _get_active_host
        _destroy_host
        _host_count
        _max_host_count
        _load_preset_file
        _load_preset_file_hard
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
        _pcm_ring_init
        _pcm_ring_shutdown
        _pcm_ring_drain
        _get_pcm_ring_header_ptr
        _get_pcm_ring_data_ptr
        _get_pcm_ring_capacity_frames
        _get_pcm_ring_index_modulus
        _get_pcm_ring_write_index
        _get_pcm_ring_read_index
        _get_pcm_ring_overruns
        _attach_worklet_ingest
        _connect_media_element_source
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
        _get_governor_render_scale
        _get_governor_blur_cap
        _is_preset_ready
        _get_rendered_frame_count
        _preset_switch_failed
        _get_omp_enabled
        _get_omp_max_threads
        _get_omp_thread_count_in_parallel
        _get_omp_blocktime
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
        _dual_fbo_is_preset_a_allocated
        _dual_fbo_is_preset_b_allocated
        _dual_fbo_set_idle_release_seconds
        _dual_fbo_get_idle_release_seconds
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
        _set_deterministic_seed
        _is_deterministic_seed
        _set_deterministic_clock
        _is_deterministic_clock
        _deterministic_now_ms
        _deterministic_frame_index
        _set_render_loop_paused
        )

list(JOIN PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS "," PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS_STR)

# EXPORTED_RUNTIME_METHODS shared by CMake lib link and shell wrapper link.
set(PROJECTM_WASM_EXPORTED_RUNTIME_METHODS
        ccall
        cwrap
        # The host-side PCM ring writer (html/projectm-pcm-ring.js) reaches the
        # ring through Module.HEAPF32.buffer. Emscripten stopped exporting the
        # HEAP views by default, and its absence is silent: readPcmRingDescriptor()
        # returns null, feedPcmToModule() falls through to a direct path that also
        # needs HEAPF32, and every synthetic/external PCM write is dropped with the
        # engine rendering to silence. Since #235 made the ring the only ingest,
        # this view is part of the host API, not a debugging convenience.
        HEAPF32
        )

# Extra runtime methods for the final browser wrapper link (VFS preset loading).
set(PROJECTM_WASM_WRAPPER_EXPORTED_RUNTIME_METHODS_EXTRA
        FS
        # How the OffscreenCanvas render worker gives the engine its canvas.
        # emscripten_webgl_create_context() resolves "#mcanvas" through
        # findEventTarget(), which checks specialHTMLTargets before
        # document.querySelector() — and a worker has no document at all, so
        # without this the context creation fails and _start_render() then
        # traps on a null function pointer. See html/projectm-render-worker.js.
        specialHTMLTargets
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
        # No GL emulation layer. FULL_ES3=1 forced FULL_ES2=1 (tools/link.py),
        # which only adds client-side vertex-array emulation and the
        # glMapBufferRange / glGetBufferSubData shims; libprojectM draws from
        # bound VBOs/EBOs only and calls neither. glBlitFramebuffer
        # (CopyTexture::TryBlit's Y-flip) is a plain passthrough either way.
        # Verified with FULL_ES3=0: all 26 goldens byte-identical, smoke incl.
        # dual-FBO soft cut, blur3 + warp/no-composite A/B with ?copyPath=shader.
        "FULL_ES2=0"
        "FULL_ES3=0"
        # GL_MAX_TEMP_BUFFER_SIZE is gone: it only sizes the FULL_ES2 temp-VBO
        # rings for client-side arrays, and the value no longer appears in the
        # glue. GL_POOL_TEMP_BUFFERS is still live, because MAXIMUM_MEMORY=4gb
        # with the default MIN_FIREFOX_VERSION turns off WebGL2's garbage-free
        # upload APIs (tools/link.py). 0 = glUniform*v passes a HEAPF32 subarray
        # view; 1 (Emscripten default) copies small arrays into pooled typed
        # arrays. Both render identically; which is faster needs a GPU
        # ?benchmark=1 run, so this stays at its previous value.
        "GL_POOL_TEMP_BUFFERS=0"
        "GL_TRACK_ERRORS=0"
        # libprojectM's GLResolver (Renderer/Platform/GLResolver.cpp) resolves GL
        # entry points through emscripten_webgl{,2}_get_proc_address() on the
        # Emscripten path. Those are stubbed out of the GL library unless this is
        # set, and the link fails with "Undefined symbol:
        # emscripten_webgl2_get_proc_address()".
        "GL_ENABLE_GET_PROC_ADDRESS=1"
        "ALLOW_MEMORY_GROWTH=1"
        "MALLOC=mimalloc"
        "MAXIMUM_MEMORY=4gb"
        "INITIAL_MEMORY=256mb"
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
# DEFAULT_TO_CXX=1 keeps libc++ linked even if the driver is plain emcc (not em++).
set(PROJECTM_WASM_WRAPPER_ONLY_S_LINK_SETTINGS
        "ENVIRONMENT=web,worker"
        "EXPORT_NAME=createModule"
        "MODULARIZE=1"
        "DEFAULT_TO_CXX=1"
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
    string(JOIN " " _exception_args ${PROJECTM_WASM_EXCEPTION_ARGS})
    add_compile_options(
            "SHELL:-O3 -mtune=wasm32 "
            "SHELL:${_exception_args} -s SHARED_MEMORY=1 -s WASM_WORKERS=1 "
            "SHELL:-msimd128 -mrelaxed-simd -fopenmp=libomp -mmutable-globals -mbulk-memory -matomics -mnontrapping-fptoint -msign-ext -fno-strict-aliasing -fno-math-errno -pthread"
            )
endfunction()

# Applies link flags for building libprojectM static libraries with emcc.
function(projectm_apply_emscripten_lib_link_flags)
    _projectm_wasm_expand_s_link_settings(PROJECTM_WASM_SHARED_S_LINK_SETTINGS _shared_s_args)
    _projectm_wasm_expand_s_link_settings(PROJECTM_WASM_LIB_ONLY_S_LINK_SETTINGS _lib_s_args)

    set(_all_link_args ${PROJECTM_WASM_SHARED_PLAIN_LINK_ARGS} ${PROJECTM_WASM_EXCEPTION_ARGS} ${_shared_s_args} ${_lib_s_args} ${PROJECTM_WASM_SIMD_COMPILE_FLAGS})
    string(JOIN " " _shell_args ${_all_link_args})
    string(APPEND _shell_args " -s PTHREAD_POOL_SIZE=${PROJECTM_WASM_PTHREAD_POOL_SIZE}")
    string(APPEND _shell_args " -s EXPORTED_RUNTIME_METHODS='${PROJECTM_WASM_EXPORTED_RUNTIME_METHODS_STR}'")
    # No EXPORTED_FUNCTIONS here. CMake never links the browser bundle (that is
    # scripts/build_wasm_smoke_wrapper.sh); the only executables these options
    # reach are the unit tests, which do not contain the wrapper's
    # EMSCRIPTEN_KEEPALIVE symbols. Emscripten 6.x rejects the link with
    # "symbol exported via --export not found: init" for every missing name.
    string(APPEND _shell_args " --pre-js ${PROJECTM_WASM_PTHREAD_SCRIPT_URL_PRE_JS}")
    add_link_options("SHELL:${_shell_args}")
endfunction()

# Absolute path to the --pre-js that restores Module.mainScriptUrlOrBlob, so the
# OffscreenCanvas render worker can tell the pthread pool which script to load.
# See src/wasm/pthread_script_url.pre.js.
set(PROJECTM_WASM_PTHREAD_SCRIPT_URL_PRE_JS "${CMAKE_CURRENT_LIST_DIR}/../src/wasm/pthread_script_url.pre.js")

# Absolute path to the ASYNCIFY_ONLY symbol list (one name per line).
# Sleep in load_preset_file_impl is unconditional, so this applies whenever
# ASYNCIFY=1 is on (shared WASM link settings) — not only when transitions are ON.
set(PROJECTM_WASM_ASYNCIFY_ONLY_FILE "${CMAKE_CURRENT_LIST_DIR}/wasm_asyncify_only.txt")

# Applies ASYNCIFY_ONLY (always) and ASYNCIFY_STACK_SIZE when dual-pipeline
# transitions are enabled.
function(projectm_apply_emscripten_wasm_transition_flags)
    # Restrict Asyncify instrumentation to the preset-load yield stack (Option B).
    # emcc requires an absolute path for @file list inputs.
    add_link_options("SHELL:-s ASYNCIFY_ONLY=@${PROJECTM_WASM_ASYNCIFY_ONLY_FILE}")
    if(ENABLE_WASM_TRANSITIONS)
        add_link_options("SHELL:-s ASYNCIFY_STACK_SIZE=65536")
    endif()
endfunction()
