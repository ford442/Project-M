# EmscriptenOpenMP.cmake — see also cmake/EmscriptenWasmFlags.cmake (SIMD/thread flags for the
# projectM_emscripten.cpp wrapper link) and docs/PERFORMANCE.md.
#
# Configures OpenMP for WebAssembly/Emscripten builds using the bundled
# libomp.a and omp/omp.h shipped in the repository root (see docs/openmp.md).
#
# Emscripten's find_package(OpenMP) does not work the same way as on native
# platforms, but the compile flags (-fopenmp -pthread) are already added in the
# ENABLE_EMSCRIPTEN block of the root CMakeLists.txt. This module wires up the
# PRJM_ENABLE_OPENMP compile definition and libomp.a linking so the existing
# #pragma omp parallel for regions in libprojectM are actually emitted.

function(projectm_configure_emscripten_openmp)
    if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
        return()
    endif()

    set(_libomp_candidates
            "${PROJECTM_SOURCE_DIR}/libomp.a"
            "${PROJECTM_SOURCE_DIR}/omp/libomp.a"
            )
    set(_omp_include_candidates
            "${PROJECTM_SOURCE_DIR}/omp"
            "${PROJECTM_SOURCE_DIR}"
            )

    set(_libomp "")
    foreach(_candidate IN LISTS _libomp_candidates)
        if(EXISTS "${_candidate}")
            set(_libomp "${_candidate}")
            break()
        endif()
    endforeach()

    set(_omp_include "")
    foreach(_candidate IN LISTS _omp_include_candidates)
        if(EXISTS "${_candidate}/omp.h")
            set(_omp_include "${_candidate}")
            break()
        endif()
    endforeach()

    if(NOT _libomp OR NOT _omp_include)
        message(STATUS "Emscripten OpenMP: libomp.a or omp.h not found; PRJM_ENABLE_OPENMP will be OFF")
        message(STATUS "  Build libomp with: scripts/build_libomp_emscripten.sh")
        return()
    endif()

    message(STATUS "Emscripten OpenMP: using ${_libomp}")
    message(STATUS "Emscripten OpenMP: include dir ${_omp_include}")

    # Pretend find_package(OpenMP) succeeded so sub-target CMakeLists that gate
    # on OpenMP_CXX_FOUND will define PRJM_ENABLE_OPENMP.
    set(OpenMP_CXX_FOUND TRUE PARENT_SCOPE)
    set(OpenMP_CXX_VERSION "5.0" PARENT_SCOPE)

    if(NOT TARGET OpenMP::OpenMP_CXX)
        add_library(projectm_emscripten_libomp STATIC IMPORTED GLOBAL)
        set_target_properties(projectm_emscripten_libomp PROPERTIES
                IMPORTED_LOCATION "${_libomp}"
                INTERFACE_INCLUDE_DIRECTORIES "${_omp_include}"
                INTERFACE_COMPILE_OPTIONS "-fopenmp=libomp"
                )

        add_library(OpenMP::OpenMP_CXX INTERFACE IMPORTED GLOBAL)
        set_target_properties(OpenMP::OpenMP_CXX PROPERTIES
                INTERFACE_LINK_LIBRARIES projectm_emscripten_libomp
                INTERFACE_COMPILE_OPTIONS "-fopenmp=libomp"
                INTERFACE_INCLUDE_DIRECTORIES "${_omp_include}"
                )
    endif()

    # Link libomp into every static lib built via emcc.
    add_link_options("SHELL:-fopenmp=libomp" "SHELL:${_libomp}")

    set(PROJECTM_EMSCRIPTEN_OPENMP_AVAILABLE TRUE PARENT_SCOPE)
    set(PROJECTM_EMSCRIPTEN_LIBOMP "${_libomp}" PARENT_SCOPE)
    set(PROJECTM_EMSCRIPTEN_OMP_INCLUDE "${_omp_include}" PARENT_SCOPE)
endfunction()
