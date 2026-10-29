# The browser bundle: the src/wasm/ host wrapper linked with libprojectM and the
# playlist library into projectm-v.030-thread.{js,wasm} (+ .js.symbols).
#
#   cmake --build <emscripten build dir> --target projectM_wasm
#
# scripts/build_wasm_smoke_wrapper.sh (via scripts/build_wasm.sh) drives this
# target, copies the output to OUT_DIR and writes the .build-id. The output is
# byte-identical to the hand-written em++ link this target replaced. The wrapper TUs
# get exactly the compile flags below, not the root directory's: they include
# libprojectM's internal headers, so they share its preprocessor state (config.h,
# the object libraries' compile definitions, NDEBUG from the build type) and its
# language standard, but not its warning set, visibility or PIC settings, which
# the bundle has never been built with.
#
# Link flavors, all wrapper-only (the libraries are untouched):
#   PROJECTM_WASM_EXPLICIT_SWAP      OFFSCREEN_FRAMEBUFFER, for explicitSwapControl hosts (never deployed)
#   PROJECTM_WASM_GL_DEBUG           GL_TRACK_ERRORS=1 + GL_ASSERTIONS=1 (never deployed)
#   PROJECTM_WASM_DEBUG              ASSERTIONS=2, SAFE_HEAP, STACK_OVERFLOW_CHECK=2 (never deployed)
#   PROJECTM_WASM_EXTRA_LINK_FLAGS   appended verbatim (e.g. -sINITIAL_MEMORY=16mb for measure-heap)
#   PROJECTM_WASM_WERROR             -Werror on the wrapper TUs (CI)

option(PROJECTM_WASM_EXPLICIT_SWAP "Link the explicit-swap (OFFSCREEN_FRAMEBUFFER) flavor of the bundle." OFF)
option(PROJECTM_WASM_GL_DEBUG "Link the bundle with GL error tracking and GL assertions." OFF)
option(PROJECTM_WASM_DEBUG "Link the bundle with ASSERTIONS=2, SAFE_HEAP and STACK_OVERFLOW_CHECK=2." OFF)
option(PROJECTM_WASM_WERROR "Treat warnings in the src/wasm/ wrapper as errors." OFF)
set(PROJECTM_WASM_EXTRA_LINK_FLAGS "" CACHE STRING "Extra emcc flags for the bundle link, space-separated.")

# Link order matters for a bit-identical bundle: keep it.
set(PROJECTM_WASM_WRAPPER_SOURCES
        projectM_emscripten.cpp
        WasmHost.cpp
        WasmRenderLoop.cpp
        WasmShaderCache.cpp
        WasmRenderPathOverrides.cpp
        WasmWebGLContext.cpp
        WasmDualFbo.cpp
        WasmAudioBridge.cpp
        WasmPcmRing.cpp
        WasmPerfGovernor.cpp
        WasmPlaylistBridge.cpp
        WasmPresetPrepare.cpp
        WasmRhythm.cpp
        WasmJsBindings.cpp
        WasmDeterminism.cpp
        WasmPresent.cpp
        WasmLog.cpp
        )

# Not in ALL: scripts/build_wasm_install.sh builds and installs the libraries,
# then scripts/build_wasm_smoke_wrapper.sh builds this target once the link
# flavor is chosen.
add_executable(projectM_wasm EXCLUDE_FROM_ALL ${PROJECTM_WASM_WRAPPER_SOURCES})

# Drop what the target inherited from the root directory (the libraries' warning
# set, and projectm_apply_emscripten_lib_{compile,link}_flags()).
set_target_properties(projectM_wasm PROPERTIES
        COMPILE_OPTIONS ""
        COMPILE_DEFINITIONS ""
        INCLUDE_DIRECTORIES ""
        LINK_OPTIONS ""
        OUTPUT_NAME "projectm-v.030-thread"
        SUFFIX ".js"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
        POSITION_INDEPENDENT_CODE OFF
        VISIBILITY_INLINES_HIDDEN OFF
        # scripts/check_cpp_tidy.sh reads these TUs' command lines.
        EXPORT_COMPILE_COMMANDS ON
        )
# No visibility flag at all. Even -fvisibility=default (what "default" emits)
# changes the objects compared with passing nothing.
set_property(TARGET projectM_wasm PROPERTY CXX_VISIBILITY_PRESET)

# features.cmake's add_definitions(-include config.h) reaches every target in the
# tree, this one included, and cannot be reset per target; config.h is found here.
target_include_directories(projectM_wasm PRIVATE
        "${PROJECTM_BINARY_DIR}/include"
        "${PROJECTM_SOURCE_DIR}/src/api/include"
        "${PROJECTM_BINARY_DIR}/src/api/include"
        "${PROJECTM_SOURCE_DIR}/src/playlist/api"
        "${PROJECTM_BINARY_DIR}/src/playlist/include"
        "${PROJECTM_SOURCE_DIR}"
        "${PROJECTM_SOURCE_DIR}/cmake/generated"
        "${PROJECTM_SOURCE_DIR}/omp"
        "${PROJECTM_SOURCE_DIR}/src/libprojectM"
        "${PROJECTM_BINARY_DIR}/src/libprojectM"
        "${PROJECTM_SOURCE_DIR}/vendor/hlslparser/src"
        "${PROJECTM_SOURCE_DIR}/vendor/glad/include"
        "${PROJECTM_SOURCE_DIR}/vendor"
        )

# The libraries' preprocessor state: what every libprojectM TU sees.
target_compile_definitions(projectM_wasm PRIVATE
        $<TARGET_PROPERTY:projectM_main,COMPILE_DEFINITIONS>
        $<TARGET_PROPERTY:Audio,COMPILE_DEFINITIONS>
        $<TARGET_PROPERTY:MilkdropPreset,COMPILE_DEFINITIONS>
        $<TARGET_PROPERTY:Renderer,COMPILE_DEFINITIONS>
        $<TARGET_PROPERTY:UserSprites,COMPILE_DEFINITIONS>
        $<$<BOOL:${PROJECTM_WASM_EXPLICIT_SWAP}>:PROJECTM_WASM_OFFSCREEN_FRAMEBUFFER=1>
        )

# Always -O3, whatever the build type: the wrapper never had a Debug build.
# No -flto, even in an LTO build: emsdk drops EM_JS functions defined in bitcode,
# so the wrapper TUs compile natively and only the link is LTO.
target_compile_options(projectM_wasm PRIVATE
        -Wall
        -Wextra
        # Only fires on JavaScript literals inside EM_JS bodies.
        -Wno-invalid-pp-token
        $<$<BOOL:${PROJECTM_WASM_WERROR}>:-Werror>
        ${PROJECTM_WASM_SIMD_COMPILE_FLAGS}
        ${PROJECTM_WASM_CODEGEN_COMPILE_FLAGS}
        -O3
        -pthread
        -fopenmp=libomp
        ${PROJECTM_WASM_EXCEPTION_ARGS}
        )

set(_projectm_wasm_link_s "")
foreach(_setting IN LISTS PROJECTM_WASM_SHARED_S_LINK_SETTINGS PROJECTM_WASM_WRAPPER_ONLY_S_LINK_SETTINGS)
    if(NOT _setting MATCHES "=")
        set(_setting "${_setting}=1")
    endif()
    list(APPEND _projectm_wasm_link_s "SHELL:-s ${_setting}")
endforeach()

separate_arguments(_projectm_wasm_extra_link UNIX_COMMAND "${PROJECTM_WASM_EXTRA_LINK_FLAGS}")

target_link_options(projectM_wasm PRIVATE
        $<$<BOOL:${PROJECTM_WASM_LTO}>:-flto>
        ${PROJECTM_WASM_SHARED_PLAIN_LINK_ARGS}
        ${PROJECTM_WASM_EXCEPTION_ARGS}
        ${_projectm_wasm_link_s}
        "SHELL:-s PTHREAD_POOL_SIZE=${PROJECTM_WASM_PTHREAD_POOL_SIZE}"
        "SHELL:-s EXPORTED_FUNCTIONS=${PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS_STR}"
        "SHELL:-s EXPORTED_RUNTIME_METHODS=${PROJECTM_WASM_WRAPPER_EXPORTED_RUNTIME_METHODS_STR}"
        "SHELL:--pre-js ${PROJECTM_WASM_PTHREAD_SCRIPT_URL_PRE_JS}"
        # <out>.js.symbols: wasm function index -> name, for symbolizing a
        # production "wasm-function[1234]" frame. The .wasm is byte-identical
        # with or without it (no name section is kept).
        --emit-symbol-map
        ${PROJECTM_WASM_SIMD_COMPILE_FLAGS}
        ${PROJECTM_WASM_CODEGEN_COMPILE_FLAGS}
        $<$<BOOL:${PROJECTM_WASM_GL_DEBUG}>:-sGL_TRACK_ERRORS=1>
        $<$<BOOL:${PROJECTM_WASM_GL_DEBUG}>:-sGL_ASSERTIONS=1>
        $<$<BOOL:${PROJECTM_WASM_EXPLICIT_SWAP}>:-sOFFSCREEN_FRAMEBUFFER=1>
        $<$<BOOL:${PROJECTM_WASM_DEBUG}>:-sASSERTIONS=2>
        $<$<BOOL:${PROJECTM_WASM_DEBUG}>:-sSAFE_HEAP=1>
        $<$<BOOL:${PROJECTM_WASM_DEBUG}>:-sSTACK_OVERFLOW_CHECK=2>
        ${_projectm_wasm_extra_link}
        )

# The archives themselves, in the order the shell link always used (libomp,
# libprojectM, playlist), rather than the targets: target linking would add
# their transitive usage requirements and reorder the inputs.
set(_projectm_wasm_link_inputs "")
if(TARGET projectm_emscripten_libomp)
    list(APPEND _projectm_wasm_link_inputs "$<TARGET_FILE:projectm_emscripten_libomp>")
endif()
list(APPEND _projectm_wasm_link_inputs
        "$<TARGET_FILE:projectM>"
        "$<TARGET_FILE:projectM_playlist>"
        )
target_link_libraries(projectM_wasm PRIVATE ${_projectm_wasm_link_inputs})
add_dependencies(projectM_wasm projectM projectM_playlist)
set_property(TARGET projectM_wasm APPEND PROPERTY LINK_DEPENDS
        "${PROJECTM_WASM_PTHREAD_SCRIPT_URL_PRE_JS}"
        )
