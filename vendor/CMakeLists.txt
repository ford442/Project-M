add_subdirectory(glad)
if(NOT ENABLE_SYSTEM_GLM)
    add_subdirectory(glm)
endif()
add_subdirectory(hlslparser)
if(NOT TARGET projectM::Eval)
    add_subdirectory(projectm-eval)

    # Only the vendored sources expose the evaluator's expression tree. A system or
    # vcpkg install ships api/projectm-eval.h alone, and the GPU per-pixel compiler
    # (docs/GPU_PERPIXEL_EVAL.md) needs CompilerTypes.h/TreeFunctions.h to walk it.
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/projectm-eval/projectm-eval/CompilerTypes.h"
       AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/projectm-eval/projectm-eval/TreeFunctions.h")
        set_property(GLOBAL PROPERTY PROJECTM_EVAL_INTERNAL_TREE TRUE)
    endif()
endif()
add_subdirectory(stb_image)
