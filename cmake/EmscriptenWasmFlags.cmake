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
#     at most PROJECTM_WASM_MAX_HOSTS of them.
# PTHREAD_POOL_SIZE pre-spawns a Worker for each. A pthread_create() with the
# pool empty still works, but its Worker is created lazily and the thread only
# starts once the creating thread yields; OpenMP barriers waiting on such a
# thread from the main thread hung the 033/034 bundles (docs/PERFORMANCE.md),
# so the pool must cover everything that can run at once.
#
# These are constants, not options. The same three numbers are compiled into
# the wrapper (cmake/generated/ProjectMWasmBuildConfig.hpp, committed, with a
# static_assert that the pool covers both) and written into the link
# (scripts/wasm_link_common.inc.sh). Overriding one at configure or link time
# used to change the link but not the header, so the static_assert checked a
# pool the bundle did not have; a pool smaller than the threads brings the
# lazy-Worker hang above back. To change them, edit them here and run
# scripts/sync_wasm_link_common.sh.
set(PROJECTM_WASM_OPENMP_THREADS 4)          # OpenMP team size (omp_set_num_threads).
# Engines one Module can run at once (kMaxHosts, src/wasm/WasmHost.hpp). Each
# host owns a preset prepare thread, so the pool is derived from it: raising it
# costs one pre-spawned Worker (and its 512 KB stack) per host, not a rebuild
# of anything else. Every host gets its own engine, PCM ring and context; the
# one AudioWorklet fans each quantum out to every host's ring.
set(PROJECTM_WASM_MAX_HOSTS 4)
set(PROJECTM_WASM_PRESET_PREPARE_THREADS ${PROJECTM_WASM_MAX_HOSTS})  # One per WasmHost.
math(EXPR PROJECTM_WASM_PTHREAD_POOL_SIZE "${PROJECTM_WASM_OPENMP_THREADS} - 1 + ${PROJECTM_WASM_PRESET_PREPARE_THREADS}")
foreach(_projectm_wasm_constant IN ITEMS PROJECTM_WASM_OPENMP_THREADS PROJECTM_WASM_MAX_HOSTS PROJECTM_WASM_PRESET_PREPARE_THREADS PROJECTM_WASM_PTHREAD_POOL_SIZE)
    # Build dirs configured before this was a constant still carry the old
    # cache entry; that is fine as long as it agrees.
    if(DEFINED CACHE{${_projectm_wasm_constant}} AND NOT "$CACHE{${_projectm_wasm_constant}}" STREQUAL "${${_projectm_wasm_constant}}")
        message(FATAL_ERROR "${_projectm_wasm_constant}=$CACHE{${_projectm_wasm_constant}} is no longer configurable "
                "(this tree's value is ${${_projectm_wasm_constant}}). Edit cmake/EmscriptenWasmFlags.cmake "
                "and run scripts/sync_wasm_link_common.sh, or remove the cache entry.")
    endif()
endforeach()

# Stack sizes. Emscripten's default is 64 KB for the main thread and for every
# pthread, and the preset prepare thread runs the recursive-descent HLSL parser
# and the projectM-eval parser on its stack (deeply nested preset code recurses
# per nesting level). 1 MB / 512 KB is generous against that and cheap against
# the fixed 256 MB heap (pool of PTHREAD_POOL_SIZE threads: 2.5 MB of stacks).
# scripts/check_wasm_bundle_features.sh checks the linked glue carries both.
set(PROJECTM_WASM_STACK_SIZE 1048576)
set(PROJECTM_WASM_PTHREAD_STACK_SIZE 524288)

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
# There is one switch: this cache variable (scripts/build_wasm.sh --lto sets
# it). The projectM_wasm target (src/wasm/CMakeLists.txt) links with -flto
# exactly when it is ON, and scripts/build_wasm_smoke_wrapper.sh refuses a
# PROJECTM_WASM_LTO in its environment that disagrees. Size/link-time numbers: docs/PERFORMANCE.md ("Whole-program LTO").
set(PROJECTM_WASM_LTO OFF CACHE BOOL "Compile the WASM static libraries to LLVM bitcode (-flto); link the bundle with PROJECTM_WASM_LTO=1.")

# Browser wrapper exports: PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS is derived
# from cmake/WasmApiManifest.cmake (included above), the only list of exports.
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
        # captureFrame() copies the frame's RGBA8 pixels out of the heap
        # (html/projectm-frame-capture.js, html/projectm-render-worker.js).
        HEAPU8
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
        )

# Code generation semantics shared by every WASM TU (libs and wrapper). These
# change what the optimiser may assume, not which instructions exist, which is
# why they are not with the feature flags above.
#  - -fno-math-errno: nothing reads errno after a libm call, so sqrt/floor & co.
#    compile to single wasm instructions instead of libc calls.
#  - -fno-strict-aliasing: a safety net, not a known fix. Clang accepts
#    -Wstrict-aliasing but never emits it, so the audit was a native GCC -O3
#    build of libprojectM, the playlist and the vendored libs with
#    -fstrict-aliasing -Wstrict-aliasing=2 (2026-10-23): no warnings. The only
#    wasm-only pointer reinterpretation, WaveformAligner.cpp's SIMD path, goes
#    through wasm_v128_load/store, which are may_alias by definition. It stays
#    because GCC only sees puns through the address of a named object, the
#    Emscripten-only code is not in that build, and nothing measured says
#    strict aliasing would buy the bundle anything. Dropping it needs the
#    golden-image gate run against a build without it.
set(PROJECTM_WASM_CODEGEN_COMPILE_FLAGS
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
        "STACK_SIZE=${PROJECTM_WASM_STACK_SIZE}"
        "DEFAULT_PTHREAD_STACK_SIZE=${PROJECTM_WASM_PTHREAD_STACK_SIZE}"
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
        # Production default. A failed GL call (e.g. from a bad context
        # attribute) shows as a black canvas; relink with PROJECTM_WASM_GL_DEBUG=1
        # (scripts/build_wasm_smoke_wrapper.sh) for GL_TRACK_ERRORS=1 +
        # GL_ASSERTIONS=1. That flavor is never deployed.
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
        # presets/custom presets, across a dual-FBO transition. Framebuffers
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
        # A failed allocation returns null (and operator new throws
        # std::bad_alloc) instead of aborting the whole Module: every wrapper
        # export catches it at its exception barrier (WasmApiBarrier.hpp) and
        # records it as that host's last error, so one engine running out of
        # heap does not take the other hosts in the Module down with it.
        "ABORTING_MALLOC=0"
        # The JS FS API: textures, songs and the test pages still write MEMFS
        # through it. Presets no longer need it (load_preset_data()). Dropping
        # it saves 124 B gzipped; MEMFS stays linked for libprojectM's stdio
        # (docs/EMSCRIPTEN.md "Presets by buffer").
        "FORCE_FILESYSTEM=1"
        # OFFSCREENCANVAS_SUPPORT is intentionally unset: it proxies GL from a
        # pthread back to the main thread, which undoes the OffscreenCanvas render
        # worker (that worker owns its module and registers the transferred
        # canvas on specialHTMLTargets['#mcanvas'] instead). Do not "fix" this.
        # OFFSCREEN_FRAMEBUFFER is unset too; explicitSwapControl needs it, so
        # manual present is a separate flavor (PROJECTM_WASM_EXPLICIT_SWAP=1 on
        # scripts/build_wasm_smoke_wrapper.sh), not the deployed bundle.
        )

# -s settings applied only on the final projectM_emscripten.cpp wrapper link (shell).
# DEFAULT_TO_CXX=1 keeps libc++ linked even if the driver is plain emcc (not em++).
set(PROJECTM_WASM_WRAPPER_ONLY_S_LINK_SETTINGS
        "ENVIRONMENT=web,worker"
        "EXPORT_NAME=createModule"
        "MODULARIZE=1"
        "DEFAULT_TO_CXX=1"
        # main() only registers the module; hosts call init()/create_host*()
        # themselves once they have set up the canvas and the VFS.
        "INVOKE_RUN=0"
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
            ${PROJECTM_WASM_CODEGEN_COMPILE_FLAGS}
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

    set(_all_link_args ${PROJECTM_WASM_SHARED_PLAIN_LINK_ARGS} ${PROJECTM_WASM_EXCEPTION_ARGS} ${_shared_s_args}
        ${PROJECTM_WASM_SIMD_COMPILE_FLAGS} ${PROJECTM_WASM_CODEGEN_COMPILE_FLAGS})
    if(PROJECTM_WASM_LTO)
        list(APPEND _all_link_args -flto)
    endif()
    string(JOIN " " _shell_args ${_all_link_args})
    string(APPEND _shell_args " -s PTHREAD_POOL_SIZE=${PROJECTM_WASM_PTHREAD_POOL_SIZE}")
    string(APPEND _shell_args " -s EXPORTED_RUNTIME_METHODS='${PROJECTM_WASM_EXPORTED_RUNTIME_METHODS_STR}'")
    # No EXPORTED_FUNCTIONS here. The browser bundle (projectM_wasm,
    # src/wasm/CMakeLists.txt) resets these options and sets its own; the other
    # executables they reach are the unit tests, which do not contain the wrapper's
    # EMSCRIPTEN_KEEPALIVE symbols. Emscripten 6.x rejects the link with
    # "symbol exported via --export not found: init" for every missing name.
    string(APPEND _shell_args " --pre-js ${PROJECTM_WASM_PTHREAD_SCRIPT_URL_PRE_JS}")
    add_link_options("SHELL:${_shell_args}")
endfunction()

# Absolute path to the --pre-js that restores Module.mainScriptUrlOrBlob, so the
# OffscreenCanvas render worker can tell the pthread pool which script to load.
# See src/wasm/pthread_script_url.pre.js.
set(PROJECTM_WASM_PTHREAD_SCRIPT_URL_PRE_JS "${CMAKE_CURRENT_LIST_DIR}/../src/wasm/pthread_script_url.pre.js")
