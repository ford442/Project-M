# Renders every preset in PRESET_DIR with the device validation layer on (B1.5,
# docs/RENDER_DEVICE.md "Render passes") and fails on any "[RenderDevice] Pass violation":
# a draw or clear outside a render pass, a copy inside one, a nested pass, or a target or
# attachment change while one is open. Each preset also soft-cuts to the next one, so the
# transition passes run, and renders again on the copy-shader and blur-copy paths.
# Called by ctest with -DRENDER, -DPRESET_DIR and -DAUDIO.

file(GLOB presets "${PRESET_DIR}/*.milk")
list(SORT presets)
list(LENGTH presets count)
if(count EQUAL 0)
    message(FATAL_ERROR "no presets in ${PRESET_DIR}")
endif()

set(ENV{PROJECTM_DEVICE_VALIDATION} 1)
set(violations "")
set(previous "")
foreach(variant default copypaths)
    if(variant STREQUAL "copypaths")
        set(ENV{PROJECTM_COPY_SHADER_PATH} 1)
        set(ENV{PROJECTM_BLUR_COPY_PATH} 1)
    endif()
    list(GET presets -1 previous)
    foreach(preset IN LISTS presets)
        execute_process(
                COMMAND "${RENDER}" --preset "${previous}" --then "${preset}" --audio "${AUDIO}"
                --duration 0.4 --width 96 --height 64 --fps 30 --seed 1 --hash --log
                OUTPUT_VARIABLE output
                ERROR_VARIABLE errors
                RESULT_VARIABLE result
        )
        if(NOT result EQUAL 0)
            message(FATAL_ERROR "projectm-render failed on ${previous} -> ${preset} (${result}):\n${errors}")
        endif()
        string(REGEX MATCHALL "\\[RenderDevice\\] Pass violation: [^\n]*" found "${errors}")
        foreach(line IN LISTS found)
            list(APPEND violations "${variant} ${preset}: ${line}")
        endforeach()
        set(previous "${preset}")
    endforeach()
endforeach()

list(LENGTH violations violationCount)
if(violationCount GREATER 0)
    list(JOIN violations "\n  " text)
    message(FATAL_ERROR "${violationCount} pass violation(s):\n  ${text}")
endif()
message(STATUS "${count} presets x 2 render paths, with transitions: no pass violations")
