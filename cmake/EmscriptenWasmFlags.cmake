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

# Threads the wasm module runs besides the main runtime thread, all pthreads (no
# emscripten_wasm_worker_* API is used):
#   - the OpenMP team: omp_set_num_threads(kWasmOpenMpThreads) in
#     projectM_emscripten.cpp, i.e. kWasmOpenMpThreads - 1 helper threads;
#   - one preset prepare thread per WasmHost (src/wasm/WasmPresetPrepare.cpp),
#     at most kMaxHosts of them.
# PTHREAD_POOL_SIZE pre-spawns a Worker for each. A pthread_create() with the
# pool empty still works, but its Worker is created lazily and the thread only
# starts once the creating thread yields; OpenMP barriers waiting on such a
# thread from the main thread hung the 033/034 bundles (docs/PERFORMANCE.md),
# so the pool must cover everything that can run at once.
set(PROJECTM_WASM_OPENMP_THREADS "4" CACHE STRING
    "OpenMP team size (omp_set_num_threads). Drives kWasmOpenMpThreads in cmake/generated/ProjectMWasmBuildConfig.hpp.")
set(PROJECTM_WASM_PRESET_PREPARE_THREADS "2" CACHE STRING
    "Preset prepare threads, one per WasmHost: must be >= kMaxHosts in src/wasm/WasmHost.hpp.")
math(EXPR _projectm_wasm_default_pool_size "${PROJECTM_WASM_OPENMP_THREADS} - 1 + ${PROJECTM_WASM_PRESET_PREPARE_THREADS}")
set(PROJECTM_WASM_PTHREAD_POOL_SIZE "${_projectm_wasm_default_pool_size}" CACHE STRING
    "Pre-spawned pthread Workers (PTHREAD_POOL_SIZE): OpenMP helpers plus preset prepare threads. Drives kWasmPthreadPoolSize in cmake/generated/ProjectMWasmBuildConfig.hpp.")

# C++ exception ABI: native Wasm exception handling (-fwasm-exceptions), for
# every TU (libprojectM-4.a, the playlist lib, the wrapper) — the ABI is baked
# into each object file, so libs and wrapper must agree or the link fails
# (undefined __cpp_exception / __gxx_wasm_personality_v0). Emscripten 6.0.6
# emits the legacy EH encoding (try/catch, not try_table): Chrome 95, Firefox
# 100, Safari 15.2 — below the SharedArrayBuffer floor this build already has.
# -6.7% .wasm / -6.0% JS glue against the JS-trampoline ABI
# (NO_DISABLE_EXCEPTION_CATCHING), which is no longer selectable: it only
# existed because ASYNCIFY cannot instrument a function containing a native
# try/catch, and the build has no ASYNCIFY since preset loading moved to a
# prepare thread (src/wasm/WasmPresetPrepare.cpp).
# Verification: tests/wasm-smoke/index.html "known-bad preset" step, which fails
# when a thrown MilkdropPresetLoadException is not caught.
if(DEFINED PROJECTM_WASM_EXCEPTIONS AND NOT PROJECTM_WASM_EXCEPTIONS STREQUAL "wasm")
    message(FATAL_ERROR "PROJECTM_WASM_EXCEPTIONS=${PROJECTM_WASM_EXCEPTIONS} is no longer supported: "
            "every WASM TU is built with -fwasm-exceptions.")
endif()
set(PROJECTM_WASM_EXCEPTION_ARGS -fwasm-exceptions)

# Link-time optimisation for the whole program: libprojectM-4.a and the
# playlist lib are compiled to LLVM bitcode (-flto) and the final wrapper link
# optimises across them and the wrapper TUs. The static libs and the wrapper
# link must use the same setting (a bitcode archive only links with -flto).
# The wrapper link reads the same choice from the PROJECTM_WASM_LTO environment
# variable. Size/link-time numbers: docs/PERFORMANCE.md ("Whole-program LTO").
set(PROJECTM_WASM_LTO OFF CACHE BOOL "Compile the WASM static libraries to LLVM bitcode (-flto); link the bundle with PROJECTM_WASM_LTO=1.")

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
        _set_render_path_overrides
        _get_render_path_overrides
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
        _live_playlist_count
        _get_main_loop_timing_mode
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

# Wasm feature flags shared by the lib build and the wrapper TU link.
#
# The feature floor is what every target browser compiles, because an engine
# that lacks one feature used anywhere in the module rejects the whole module
# (it surfaces as an init failure, not a missing code path). Fixed-width SIMD
# (-msimd128): Chrome 91, Firefox 89, Safari 16.4. No -mrelaxed-simd: Safari
# still ships Relaxed SIMD only behind a JavaScriptCore flag, and all it bought
# was 34 compiler-contracted f32x4/f64x2.relaxed_madd sites, none of them in
# the per-pixel mesh loop (preset per-frame bookkeeping, one-off noise-texture
# generation, stb_image decode). Keeping it would have meant a second bundle
# tier plus a probing loader for no measurable win; see docs/EMSCRIPTEN.md
# "Wasm feature floor". scripts/check_wasm_bundle_features.sh gates the built
# bundle against it.
set(PROJECTM_WASM_SIMD_COMPILE_FLAGS
        -msimd128
        -mmutable-globals
        -mbulk-memory
        -matomics
        -mnontrapping-fptoint
        -msign-ext
        -fno-strict-aliasing
        -fno-math-errno
        )

# Plain emcc arguments shared by lib link (CMake) and wrapper link (shell).
# The wrapper TUs are compiled and linked in one em++ call, so -O3 here is also
# their compile optimisation level. Not here, because they did nothing:
# -mtune=wasm32 (clang ignores it for wasm; 114 "argument unused" warnings per
# lib build) and -rtlib=compiler-rt-mt (emcc picks libcompiler_rt-mt from
# -pthread itself and never reads -rtlib).
set(PROJECTM_WASM_SHARED_PLAIN_LINK_ARGS
        -std=c++20
        -O3
        -pthread
        -fopenmp=libomp
        )

# -s settings shared by lib link and wrapper link.
# No WASM_WORKERS: every thread is a pthread (OpenMP, the preset prepare
# threads); nothing calls the emscripten_wasm_worker_* API.
# No ASYNCIFY: nothing suspends the wasm stack any more. The one yield it was
# for (emscripten_sleep(0) before a preset compile) is gone; preset loads are
# prepared on a pthread while the render loop keeps running.
set(PROJECTM_WASM_SHARED_S_LINK_SETTINGS
        "SHARED_MEMORY=1"
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
        # No GL_POOL_TEMP_BUFFERS / GL_MAX_TEMP_BUFFER_SIZE: with the fixed heap
        # below (maximum under 2 GB) the WebGL2 garbage-free upload APIs are on,
        # glUniform*v reads HEAPF32 by offset, and neither setting reaches the
        # glue any more (linked both ways: byte-identical .js and .wasm).
        "GL_TRACK_ERRORS=0"
        # libprojectM's GLResolver (Renderer/Platform/GLResolver.cpp) resolves GL
        # entry points through emscripten_webgl{,2}_get_proc_address() on the
        # Emscripten path. Those are stubbed out of the GL library unless this is
        # set, and the link fails with "Undefined symbol:
        # emscripten_webgl2_get_proc_address()".
        "GL_ENABLE_GET_PROC_ADDRESS=1"
        # Fixed heap. Measured high-water (tests/wasm-smoke/measure-heap.mjs on
        # a -sINITIAL_MEMORY=16mb relink, 2026-09-25): 19.25 MiB including the
        # runtime and pthread stacks, identical at 1920x1080 and 3840x2160, for
        # the empty preset, per-pixel, composite-shader and the heaviest
        # custom_milk_fixed presets, across a dual-FBO transition. Framebuffers
        # and textures are GPU memory, not heap. 256 MB is ~13x that and the
        # same initial reservation as before, so nothing that fit then fails now.
        # What growth cost (docs/EMSCRIPTEN.md "Heap model"):
        #  - MAXIMUM_MEMORY=4gb made the browser reserve 4 GB of address space
        #    for the shared memory up front, which low-memory mobile refuses;
        #  - with pthreads, every JS access to the heap went through a
        #    growMemViews() check (303 call sites in the glue, GL calls
        #    included; emcc -Wpthreads-mem-growth);
        #  - a maximum over 2 GB turned off WebGL2's garbage-free upload APIs
        #    (tools/link.py, Firefox < 151), so glUniform*v allocated a
        #    subarray per call.
        "ALLOW_MEMORY_GROWTH=0"
        "INITIAL_MEMORY=256mb"
        "MALLOC=mimalloc"
        "FORCE_FILESYSTEM=1"
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
# The optimisation level comes from CMAKE_BUILD_TYPE (the root CMakeLists.txt
# defaults it to Release for Emscripten): forcing -O3 here used to override
# Debug's -O0. No -s SHARED_MEMORY=1 either: -s settings are link settings, and
# -pthread already selects the shared-memory compile (-matomics -mbulk-memory).
function(projectm_apply_emscripten_lib_compile_flags)
    add_compile_options(
            ${PROJECTM_WASM_EXCEPTION_ARGS}
            ${PROJECTM_WASM_SIMD_COMPILE_FLAGS}
            -fopenmp=libomp
            -pthread
            )
    if(PROJECTM_WASM_LTO)
        add_compile_options(-flto)
    endif()
endfunction()

# Applies link flags for building libprojectM static libraries with emcc.
function(projectm_apply_emscripten_lib_link_flags)
    _projectm_wasm_expand_s_link_settings(PROJECTM_WASM_SHARED_S_LINK_SETTINGS _shared_s_args)

    set(_all_link_args ${PROJECTM_WASM_SHARED_PLAIN_LINK_ARGS} ${PROJECTM_WASM_EXCEPTION_ARGS} ${_shared_s_args} ${PROJECTM_WASM_SIMD_COMPILE_FLAGS})
    if(PROJECTM_WASM_LTO)
        list(APPEND _all_link_args -flto)
    endif()
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
