# ENABLE_FUZZING: instrument the whole build for libFuzzer (tests/fuzz/, docs/FUZZING.md).
#
# Included from the root CMakeLists.txt before vendor/ and src/ are added, so every library
# the fuzz targets link (libprojectM's object libraries, hlslparser, projectm-eval) is built
# with coverage feedback and ASan + UBSan, not just the harness translation units.
#
# -fsanitize=fuzzer-no-link adds the coverage instrumentation without libFuzzer's main();
# the fuzz executables add -fsanitize=fuzzer at link time (tests/fuzz/CMakeLists.txt).
# -fno-sanitize-recover=all makes a UBSan report abort, so libFuzzer records it as a crash
# instead of printing it and carrying on.

if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang" OR NOT CMAKE_C_COMPILER_ID MATCHES "Clang")
    message(FATAL_ERROR
            "ENABLE_FUZZING needs clang for both C and C++ (libFuzzer ships with it), but the compilers are "
            "${CMAKE_C_COMPILER_ID} / ${CMAKE_CXX_COMPILER_ID}.\n"
            "  Configure with: -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++\n"
            "Without ENABLE_FUZZING, BUILD_TESTING still builds the fuzz targets as plain replay binaries "
            "that run the regression corpus under ctest (any compiler).")
endif()
if(ENABLE_EMSCRIPTEN OR ANDROID)
    message(FATAL_ERROR "ENABLE_FUZZING is for host builds only (not Emscripten or Android).")
endif()

set(PROJECTM_FUZZ_SANITIZERS "address,undefined" CACHE STRING
        "Sanitizers added to every target when ENABLE_FUZZING is on (passed to -fsanitize=).")

add_compile_options(
        -fsanitize=fuzzer-no-link,${PROJECTM_FUZZ_SANITIZERS}
        -fno-sanitize-recover=all
        -fno-omit-frame-pointer
        -g
)
add_link_options(
        -fsanitize=${PROJECTM_FUZZ_SANITIZERS}
)

# Fuzzing needs the vendored evaluator: an installed projectM-eval is not instrumented, so
# the eval target would fuzz blind.
if(ENABLE_SYSTEM_PROJECTM_EVAL)
    message(STATUS "ENABLE_FUZZING: forcing ENABLE_SYSTEM_PROJECTM_EVAL=OFF so projectm-eval is instrumented.")
    set(ENABLE_SYSTEM_PROJECTM_EVAL OFF CACHE BOOL "Enable use of a system-installed/external projectM-eval library" FORCE)
endif()
