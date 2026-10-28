#pragma once

/**
 * @file TestGl.hpp
 * @brief The one GL header tests include.
 *
 * Use this, not <glad/gl.h>: Renderer/OpenGL.h picks <glad/gles2.h> when USE_GLES is
 * defined (Emscripten, Android, ENABLE_GLES), and glad refuses to see both in one
 * translation unit. Renderer headers themselves no longer include GL (everything draws
 * through Renderer::Device, docs/RENDER_DEVICE.md), so a test that calls gl* directly
 * includes this.
 */
#include <Renderer/OpenGL.h>
