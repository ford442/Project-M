/**
 * @file GlEnums.hpp
 * @brief Maps the device seam's neutral values onto OpenGL / GLES 3 / WebGL 2 enums.
 */
#pragma once

#include "Renderer/Device/DeviceTypes.hpp"
#include "Renderer/OpenGL.h"

namespace libprojectM {
namespace Renderer {
namespace Device {
namespace Gl {

/**
 * @brief The (internal format, format, type) triple a texture format is allocated and uploaded with.
 */
struct GlTextureFormat {
    GLint internalFormat{};
    GLenum format{};
    GLenum type{};
};

auto ToGl(TextureTarget target) -> GLenum;
auto ToGl(TextureFormat format, PixelOrder order) -> GlTextureFormat;
auto ToGl(FilterMode filter) -> GLint;
auto ToGl(WrapMode wrap) -> GLint;
auto ToGl(BufferUsage usage) -> GLenum;
auto ToGl(BufferKind kind) -> GLenum;
auto ToGl(PrimitiveType primitive) -> GLenum;
auto ToGl(BlendFactor factor) -> GLenum;
auto ToGl(TargetBinding binding) -> GLenum;
auto ToGl(AttachmentPoint point) -> GLenum;

/**
 * @brief The GL capability, or GL_NONE where this GL flavor has no such switch.
 */
auto ToGl(Capability capability) -> GLenum;

/**
 * @brief The query that reports the target bound at @a binding.
 */
auto BindingQuery(TargetBinding binding) -> GLenum;

/**
 * @brief The neutral factor for a GL blend factor; unknown values map to One.
 */
auto BlendFactorFromGl(GLenum factor) -> BlendFactor;

} // namespace Gl
} // namespace Device
} // namespace Renderer
} // namespace libprojectM
