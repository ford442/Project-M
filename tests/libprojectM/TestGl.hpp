#pragma once

/**
 * @file TestGl.hpp
 * @brief The one GL header tests include.
 *
 * Use this, not <glad/gl.h>: libprojectM's renderer headers pull in <glad/gles2.h> when
 * USE_GLES is defined (Emscripten, Android, ENABLE_GLES), and glad refuses to see both in
 * one translation unit. Renderer/OpenGL.h already picks the right one for the build.
 */
#include <Renderer/OpenGL.h>
