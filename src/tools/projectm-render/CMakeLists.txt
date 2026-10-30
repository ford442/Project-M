# Headless offline renderer (docs/OFFLINE_RENDER.md). Needs EGL, so Linux and the BSDs only.
if(NOT ENABLE_RENDER_TOOL)
    return()
endif()
if(ENABLE_EMSCRIPTEN OR WIN32 OR APPLE OR CMAKE_SYSTEM_NAME STREQUAL Android)
    message(WARNING "ENABLE_RENDER_TOOL needs EGL on Linux or a BSD; projectm-render is not built.")
    return()
endif()

find_package(OpenGL REQUIRED COMPONENTS EGL)

add_executable(projectm-render
        main.cpp
        )

target_include_directories(projectm-render SYSTEM
        PRIVATE
        "${PROJECTM_SOURCE_DIR}/vendor/dr_libs"
        )

if(USE_GLES)
    target_compile_definitions(projectm-render PRIVATE USE_GLES)
endif()

target_link_libraries(projectm-render
        PRIVATE
        libprojectM::projectM
        OpenGL::EGL
        glad
        ${CMAKE_DL_LIBS}
        )

if(ENABLE_INSTALL)
    install(TARGETS projectm-render
            RUNTIME DESTINATION "${PROJECTM_RUNTIME_DIR}"
            COMPONENT Runtime
            )
endif()
