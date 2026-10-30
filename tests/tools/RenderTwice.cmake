# Runs projectm-render twice over the same preset and audio and fails unless both runs print
# the same hash, and unless a different seed or no audio changes it (so the hash covers
# something that moves). Called by ctest with -DRENDER, -DPRESET and -DAUDIO.

function(render out_var)
    execute_process(
            COMMAND "${RENDER}" --preset "${PRESET}" --width 160 --height 90 --fps 30 --hash ${ARGN}
            OUTPUT_VARIABLE output
            ERROR_VARIABLE errors
            RESULT_VARIABLE result
            OUTPUT_STRIP_TRAILING_WHITESPACE
    )
    if(NOT result EQUAL 0)
        message(FATAL_ERROR "projectm-render ${ARGN} failed (${result}):\n${errors}")
    endif()
    message(STATUS "${ARGN}: ${output}")
    set(${out_var} "${output}" PARENT_SCOPE)
endfunction()

render(first --audio "${AUDIO}" --seed 1)
render(second --audio "${AUDIO}" --seed 1)
if(NOT first STREQUAL second)
    message(FATAL_ERROR "two renders of the same audio differ:\n  ${first}\n  ${second}")
endif()
if(NOT first MATCHES "^frames 300 ")
    message(FATAL_ERROR "expected 300 frames (10 s at 30 fps): ${first}")
endif()

render(silent --duration 10 --seed 1)
if(first STREQUAL silent)
    message(FATAL_ERROR "the audio did not change the render")
endif()
