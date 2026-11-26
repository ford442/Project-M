add_library(hlslparser OBJECT
        src/CodeWriter.cpp
        src/CodeWriter.h
        src/Engine.cpp
        src/Engine.h
        src/GLSLGenerator.cpp
        src/GLSLGenerator.h
        src/HLSLParser.cpp
        src/HLSLParser.h
        src/HLSLTokenizer.cpp
        src/HLSLTokenizer.h
        src/HLSLTree.cpp
        src/HLSLTree.h
        )

target_link_libraries(hlslparser
        PRIVATE
        projectM_api # For projectM_cxx_export.h, required by Logging.hpp
        )

target_include_directories(hlslparser
        PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/src
        ${CMAKE_SOURCE_DIR}/src
        )

# The WGSL generator (Phase C of the WebGPU backend, docs/adr/0002-wgsl-shader-path.md).
# Off in the Emscripten build until a WebGPU flavor exists, so the WebGL 2 bundle does
# not carry it.
if(ENABLE_WGSL_EMIT)
    target_sources(hlslparser
            PRIVATE
            src/WGSLGenerator.cpp
            src/WGSLGenerator.h
            )
    target_compile_definitions(hlslparser
            PUBLIC
            PROJECTM_WGSL_EMIT=1
            )
endif()

set_target_properties(hlslparser PROPERTIES
        FOLDER libprojectM
        )
