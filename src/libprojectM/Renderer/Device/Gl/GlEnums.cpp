#include "Renderer/Device/Gl/GlEnums.hpp"

// OpenGL ES might not define these, e.g. in the iOS and Emscripten SDKs. Every target that
// allocates the formats accepts the values.
#ifndef GL_STENCIL_INDEX
#define GL_STENCIL_INDEX 0x1901
#endif
#ifndef GL_RGB8
#define GL_RGB8 0x8051
#endif
#ifndef GL_BGRA
#define GL_BGRA 0x80E1
#endif

namespace libprojectM {
namespace Renderer {
namespace Device {
namespace Gl {

auto ToGl(TextureTarget target) -> GLenum
{
    return target == TextureTarget::Texture3D ? GL_TEXTURE_3D : GL_TEXTURE_2D;
}

auto ToGl(TextureFormat format, PixelOrder order) -> GlTextureFormat
{
    switch (format)
    {
        case TextureFormat::R:
            return {GL_RED, GL_RED, GL_UNSIGNED_BYTE};
        case TextureFormat::RG:
            return {GL_RG, GL_RG, GL_UNSIGNED_BYTE};
        case TextureFormat::RGB:
            return {GL_RGB, GL_RGB, GL_UNSIGNED_BYTE};
        case TextureFormat::RGBA:
        default:
            return {GL_RGBA, GL_RGBA, GL_UNSIGNED_BYTE};
        case TextureFormat::RGB8:
            return {GL_RGB8, GL_RGB, GL_UNSIGNED_BYTE};
        case TextureFormat::RGBA8:
            return {GL_RGBA8, order == PixelOrder::Bgra ? static_cast<GLenum>(GL_BGRA) : static_cast<GLenum>(GL_RGBA), GL_UNSIGNED_BYTE};
        case TextureFormat::SRGB8Alpha8:
            return {GL_SRGB8_ALPHA8, GL_RGBA, GL_UNSIGNED_BYTE};
        case TextureFormat::RG16F:
            return {GL_RG16F, GL_RG, GL_FLOAT};
        case TextureFormat::RGBA16F:
            return {GL_RGBA16F, GL_RGBA, GL_HALF_FLOAT};
        case TextureFormat::RGBA32F:
            return {GL_RGBA32F, GL_RGBA, GL_FLOAT};
        case TextureFormat::Depth24:
            return {GL_DEPTH_COMPONENT24, GL_DEPTH_COMPONENT, GL_FLOAT};
        case TextureFormat::Stencil8:
            return {GL_STENCIL_INDEX8, GL_STENCIL_INDEX, GL_UNSIGNED_BYTE};
        case TextureFormat::Depth24Stencil8:
            return {GL_DEPTH24_STENCIL8, GL_DEPTH_STENCIL, GL_UNSIGNED_INT_24_8};
    }
}

auto ToGl(FilterMode filter) -> GLint
{
    return filter == FilterMode::Linear ? GL_LINEAR : GL_NEAREST;
}

auto ToGl(WrapMode wrap) -> GLint
{
    return wrap == WrapMode::Repeat ? GL_REPEAT : GL_CLAMP_TO_EDGE;
}

auto ToGl(BufferUsage usage) -> GLenum
{
    switch (usage)
    {
        case BufferUsage::StreamDraw:
        default:
            return GL_STREAM_DRAW;
        case BufferUsage::StreamRead:
            return GL_STREAM_READ;
        case BufferUsage::StreamCopy:
            return GL_STREAM_COPY;
        case BufferUsage::StaticDraw:
            return GL_STATIC_DRAW;
        case BufferUsage::StaticRead:
            return GL_STATIC_READ;
        case BufferUsage::StaticCopy:
            return GL_STATIC_COPY;
        case BufferUsage::DynamicDraw:
            return GL_DYNAMIC_DRAW;
        case BufferUsage::DynamicRead:
            return GL_DYNAMIC_READ;
        case BufferUsage::DynamicCopy:
            return GL_DYNAMIC_COPY;
    }
}

auto ToGl(BufferKind kind) -> GLenum
{
    switch (kind)
    {
        case BufferKind::Vertex:
        default:
            return GL_ARRAY_BUFFER;
        case BufferKind::Index:
            return GL_ELEMENT_ARRAY_BUFFER;
        case BufferKind::PixelPack:
            return GL_PIXEL_PACK_BUFFER;
    }
}

auto ToGl(PrimitiveType primitive) -> GLenum
{
    switch (primitive)
    {
        case PrimitiveType::Points:
            return GL_POINTS;
        case PrimitiveType::Lines:
        default:
            return GL_LINES;
        case PrimitiveType::LineLoop:
            return GL_LINE_LOOP;
        case PrimitiveType::LineStrip:
            return GL_LINE_STRIP;
        case PrimitiveType::Triangles:
            return GL_TRIANGLES;
        case PrimitiveType::TriangleStrip:
            return GL_TRIANGLE_STRIP;
        case PrimitiveType::TriangleFan:
            return GL_TRIANGLE_FAN;
    }
}

auto ToGl(BlendFactor factor) -> GLenum
{
    switch (factor)
    {
        case BlendFactor::Zero:
            return GL_ZERO;
        case BlendFactor::One:
        default:
            // Dual-source factors (Source1*) are not supported and blend as One.
            return GL_ONE;
        case BlendFactor::SourceColor:
            return GL_SRC_COLOR;
        case BlendFactor::OneMinusSourceColor:
            return GL_ONE_MINUS_SRC_COLOR;
        case BlendFactor::DestinationColor:
            return GL_DST_COLOR;
        case BlendFactor::OneMinusDestinationColor:
            return GL_ONE_MINUS_DST_COLOR;
        case BlendFactor::SourceAlpha:
            return GL_SRC_ALPHA;
        case BlendFactor::OneMinusSourceAlpha:
            return GL_ONE_MINUS_SRC_ALPHA;
        case BlendFactor::DestinationAlpha:
            return GL_DST_ALPHA;
        case BlendFactor::OneMinusDestinationAlpha:
            return GL_ONE_MINUS_DST_ALPHA;
        case BlendFactor::ConstantColor:
            return GL_CONSTANT_COLOR;
        case BlendFactor::OneMinusConstantColor:
            return GL_ONE_MINUS_CONSTANT_COLOR;
        case BlendFactor::ConstantAlpha:
            return GL_CONSTANT_ALPHA;
        case BlendFactor::OneMinusConstantAlpha:
            return GL_ONE_MINUS_CONSTANT_ALPHA;
        case BlendFactor::SourceAlphaSaturate:
            return GL_SRC_ALPHA_SATURATE;
    }
}

auto BlendFactorFromGl(GLenum factor) -> BlendFactor
{
    switch (factor)
    {
        case GL_ZERO:
            return BlendFactor::Zero;
        case GL_ONE:
        default:
            return BlendFactor::One;
        case GL_SRC_COLOR:
            return BlendFactor::SourceColor;
        case GL_ONE_MINUS_SRC_COLOR:
            return BlendFactor::OneMinusSourceColor;
        case GL_DST_COLOR:
            return BlendFactor::DestinationColor;
        case GL_ONE_MINUS_DST_COLOR:
            return BlendFactor::OneMinusDestinationColor;
        case GL_SRC_ALPHA:
            return BlendFactor::SourceAlpha;
        case GL_ONE_MINUS_SRC_ALPHA:
            return BlendFactor::OneMinusSourceAlpha;
        case GL_DST_ALPHA:
            return BlendFactor::DestinationAlpha;
        case GL_ONE_MINUS_DST_ALPHA:
            return BlendFactor::OneMinusDestinationAlpha;
        case GL_CONSTANT_COLOR:
            return BlendFactor::ConstantColor;
        case GL_ONE_MINUS_CONSTANT_COLOR:
            return BlendFactor::OneMinusConstantColor;
        case GL_CONSTANT_ALPHA:
            return BlendFactor::ConstantAlpha;
        case GL_ONE_MINUS_CONSTANT_ALPHA:
            return BlendFactor::OneMinusConstantAlpha;
        case GL_SRC_ALPHA_SATURATE:
            return BlendFactor::SourceAlphaSaturate;
    }
}

auto ToGl(TargetBinding binding) -> GLenum
{
    switch (binding)
    {
        case TargetBinding::ReadDraw:
        default:
            return GL_FRAMEBUFFER;
        case TargetBinding::Read:
            return GL_READ_FRAMEBUFFER;
        case TargetBinding::Draw:
            return GL_DRAW_FRAMEBUFFER;
    }
}

auto BindingQuery(TargetBinding binding) -> GLenum
{
    switch (binding)
    {
        case TargetBinding::ReadDraw:
        default:
            return GL_FRAMEBUFFER_BINDING;
        case TargetBinding::Read:
            return GL_READ_FRAMEBUFFER_BINDING;
        case TargetBinding::Draw:
            return GL_DRAW_FRAMEBUFFER_BINDING;
    }
}

auto ToGl(AttachmentPoint point) -> GLenum
{
    if (IsColorAttachment(point))
    {
        return GL_COLOR_ATTACHMENT0 + static_cast<GLenum>(point);
    }
    switch (point)
    {
        case AttachmentPoint::Depth:
            return GL_DEPTH_ATTACHMENT;
        case AttachmentPoint::Stencil:
            return GL_STENCIL_ATTACHMENT;
        case AttachmentPoint::DepthStencil:
            return GL_DEPTH_STENCIL_ATTACHMENT;
        case AttachmentPoint::Back:
        default:
            return GL_BACK;
    }
}

auto ToGl(Capability capability) -> GLenum
{
    switch (capability)
    {
        case Capability::Blend:
        default:
            return GL_BLEND;
        case Capability::ScissorTest:
            return GL_SCISSOR_TEST;
        case Capability::CullFace:
            return GL_CULL_FACE;
        case Capability::DepthTest:
            return GL_DEPTH_TEST;
        case Capability::Dither:
            return GL_DITHER;
        case Capability::LineSmooth:
#ifdef USE_GLES
            return GL_NONE;
#else
            return GL_LINE_SMOOTH;
#endif
        case Capability::FramebufferSrgb:
#ifdef USE_GLES
            return GL_NONE;
#else
            return GL_FRAMEBUFFER_SRGB;
#endif
    }
}

} // namespace Gl
} // namespace Device
} // namespace Renderer
} // namespace libprojectM
