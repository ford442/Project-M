# Fuzz targets for the untrusted-input surface (docs/FUZZING.md).
#
# Two builds of the same four LLVMFuzzerTestOneInput() harnesses:
#  - ENABLE_FUZZING=ON (clang): libFuzzer binaries, everything instrumented with ASan + UBSan
#    (cmake/FuzzingFlags.cmake). fuzz_smoke.yml / fuzz_nightly.yml run these.
#  - BUILD_TESTING=ON without ENABLE_FUZZING (any compiler, MSVC included): the harnesses
#    linked with FuzzReplayMain.cpp, which just runs each input once. The ordinary Debug,
#    Release and sanitizer CI jobs replay the regression corpus through them.
#
# Either way ctest gets one FuzzRegression.<target> test per target that replays
# regressions/<target>/ (every fixed crasher) plus the target's checked-in seeds.

set(PROJECTM_FUZZ_TARGETS
        fuzz_preset_parser
        fuzz_hlsl_transpile
        fuzz_eval_compile
        fuzz_shader_passes
        )

if(NOT ENABLE_FUZZING)
    add_library(projectM_fuzz_replay_main OBJECT FuzzReplayMain.cpp)
endif()

if(ENABLE_FUZZING AND TARGET projectM_eval)
    # Known, not yet fixed: the evaluator casts doubles to integers unchecked for %, |, &, loop()
    # counts and megabuf indices (TreeFunctions.c), so "x % 1e308" is a float-cast-overflow
    # within seconds of fuzzing. The result is the platform's (x86: INT_MIN, wasm: saturated),
    # not a memory error; changing it changes evaluator semantics, which the GPU per-pixel path
    # mirrors, so it is fixed in the fork, not here (docs/FUZZING.md "Known findings"). Every
    # other UBSan check, and ASan, stays on for projectm-eval.
    target_compile_options(projectM_eval PRIVATE -fno-sanitize=float-cast-overflow)
endif()

find_package(OpenGL REQUIRED)

foreach(_target IN LISTS PROJECTM_FUZZ_TARGETS)
    add_executable(${_target}
            ${_target}.cpp
            FuzzShaderTranspile.hpp

            # Same object set as projectM-unittest: the harnesses reach internal C++ classes,
            # which the shared library does not export.
            $<TARGET_OBJECTS:Audio>
            $<TARGET_OBJECTS:MilkdropPreset>
            $<TARGET_OBJECTS:Renderer>
            $<TARGET_OBJECTS:UserSprites>
            $<TARGET_OBJECTS:hlslparser>
            $<TARGET_OBJECTS:stb_image>
            $<TARGET_OBJECTS:projectM_main>
            )

    target_include_directories(${_target}
            PRIVATE
            "${PROJECTM_SOURCE_DIR}/src/libprojectM"
            "${PROJECTM_SOURCE_DIR}/vendor/hlslparser/src"
            )

    target_link_libraries(${_target}
            PRIVATE
            projectM_main
            projectM::Eval
            glad
            OpenGL::GL
            )

    if(ENABLE_FUZZING)
        target_link_options(${_target} PRIVATE -fsanitize=fuzzer)
    else()
        target_sources(${_target} PRIVATE $<TARGET_OBJECTS:projectM_fuzz_replay_main>)
    endif()

    set_target_properties(${_target} PROPERTIES FOLDER "Tests/Fuzz")
endforeach()

# Seeds replayed by ctest next to the regression corpus. The .milk targets take whole presets;
# the HLSL and eval targets take extracted blocks, which tests/fuzz/extract_seeds.py writes at
# fuzz time (CI), so ctest replays only their regressions/ and seeds/ directories.
set(_fuzz_milk_seeds
        "${PROJECTM_SOURCE_DIR}/presets/tests"
        "${PROJECTM_SOURCE_DIR}/tests/libprojectM/data/PresetFileParser"
        "${PROJECTM_SOURCE_DIR}/tests/libprojectM/data/PresetCompat"
        )
set(FUZZ_SEEDS_fuzz_preset_parser ${_fuzz_milk_seeds})
set(FUZZ_SEEDS_fuzz_shader_passes ${_fuzz_milk_seeds})
set(FUZZ_SEEDS_fuzz_hlsl_transpile "${CMAKE_CURRENT_SOURCE_DIR}/seeds/fuzz_hlsl_transpile")
set(FUZZ_SEEDS_fuzz_eval_compile "${CMAKE_CURRENT_SOURCE_DIR}/seeds/fuzz_eval_compile")

foreach(_target IN LISTS PROJECTM_FUZZ_TARGETS)
    set(_inputs "${CMAKE_CURRENT_SOURCE_DIR}/regressions/${_target}" ${FUZZ_SEEDS_${_target}})
    if(ENABLE_FUZZING)
        # -runs=0: execute every input in the given corpus directories once, fuzz nothing.
        add_test(NAME FuzzRegression.${_target}
                COMMAND ${_target} -runs=0 ${_inputs})
    else()
        add_test(NAME FuzzRegression.${_target}
                COMMAND ${_target} ${_inputs})
    endif()
    set_tests_properties(FuzzRegression.${_target} PROPERTIES
            LABELS "fuzz"
            # The third-party leak suppressions the sanitizer CI job uses (each entry says why).
            ENVIRONMENT "LSAN_OPTIONS=suppressions=${PROJECTM_SOURCE_DIR}/tests/sanitizers/lsan.supp:print_suppressions=0")
endforeach()
