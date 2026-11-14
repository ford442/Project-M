add_subdirectory(glad)
if(NOT ENABLE_SYSTEM_GLM)
    add_subdirectory(glm)
endif()
add_subdirectory(hlslparser)
if(NOT TARGET projectM::Eval)
    # The vendored projectm-eval is the fork ford442/projectm-eval (branch context-rng, see
    # .gitmodules and docs/UPSTREAM_SYNC.md "projectm-eval fork"): upstream plus a per-context rand()
    # stream, projectm_eval_context_seed_rand(), which MilkdropPreset/EvalRandom.hpp calls. A checkout
    # whose submodule is empty, or sits on an upstream commit, would otherwise fail deep in the compile
    # ("projectm_eval_context_seed_rand was not declared") or, for an empty directory, in add_subdirectory().
    # Fail here, with the fix, instead.
    set(_projectm_eval_header "${CMAKE_CURRENT_SOURCE_DIR}/projectm-eval/projectm-eval/api/projectm-eval.h")
    if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/projectm-eval/CMakeLists.txt")
        message(FATAL_ERROR "vendor/projectm-eval is empty and no external projectM-Eval was found.\n"
                "  Fetch the submodule:  git submodule update --init --recursive")
    endif()
    file(STRINGS "${_projectm_eval_header}" _projectm_eval_seed_rand REGEX "projectm_eval_context_seed_rand")
    if(NOT _projectm_eval_seed_rand)
        message(FATAL_ERROR "vendor/projectm-eval is not the commit this tree is pinned to: its API has no "
                "projectm_eval_context_seed_rand() (the per-context rand() stream, ford442/projectm-eval branch context-rng).\n"
                "  This is what an old clone looks like when its submodule 'origin' still points at "
                "projectM-visualizer/projectm-eval: the fork's commit cannot be fetched from there, so the "
                "checkout stays on an upstream commit.\n"
                "  Fix:  git submodule sync vendor/projectm-eval && git submodule update --init vendor/projectm-eval\n"
                "  Check: git submodule status vendor/projectm-eval   (no leading '+' or '-'; expected commit in 'git ls-tree HEAD vendor/projectm-eval')")
    endif()
    unset(_projectm_eval_seed_rand)
    unset(_projectm_eval_header)

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
