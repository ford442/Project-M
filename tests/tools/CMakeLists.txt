if(NOT TARGET projectm-render)
    return()
endif()

# Issue acceptance check: 10 s of FLAC rendered twice gives the same pixels.
add_test(NAME ProjectmRenderDeterministic
        COMMAND ${CMAKE_COMMAND}
        -DRENDER=$<TARGET_FILE:projectm-render>
        -DPRESET=${PROJECTM_SOURCE_DIR}/presets/tests/300-beatdetect-bassmidtreb.milk
        -DAUDIO=${CMAKE_CURRENT_SOURCE_DIR}/data/beat-10s.flac
        -P ${CMAKE_CURRENT_SOURCE_DIR}/RenderTwice.cmake
        )
