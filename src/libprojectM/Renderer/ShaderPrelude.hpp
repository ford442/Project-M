#pragma once

namespace libprojectM {
namespace Renderer {

/**
 * The #version line and default precisions every built-in GLSL shader starts with.
 * GLES 3.0 fragment shaders have no default float precision, and sampler3D has no default
 * precision in any GLES stage, so the GLES prelude declares them all.
 */
constexpr char kShaderPreludeGles[] = "#version 300 es\n\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp sampler3D;\n";
constexpr char kShaderPreludeCore[] = "#version 330\n\n";

/**
 * The prelude for the API this build targets (USE_GLES).
 */
#ifdef USE_GLES
constexpr const char* kShaderPrelude = kShaderPreludeGles;
#else
constexpr const char* kShaderPrelude = kShaderPreludeCore;
#endif

} // namespace Renderer
} // namespace libprojectM
