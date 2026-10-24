/**
 * @file DeviceTypes.hpp
 * @brief Backend-neutral value types of the render-device seam: handles, formats, states.
 *
 * Nothing in here names a graphics API. Each backend maps these values onto its own
 * (Renderer/Device/Gl/GlEnums.cpp for OpenGL / WebGL 2). See docs/RENDER_DEVICE.md.
 */
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

namespace libprojectM {
namespace Renderer {
namespace Device {

/**
 * @brief A backend object, held by value.
 *
 * The id is backend-defined. On the GL backend it is the GL object name, so a handle and
 * the name a host passes through the C API (e.g. a target framebuffer) are the same number.
 * Id 0 is "no object"; for a RenderTargetHandle it is the default framebuffer.
 */
template<class Tag>
struct Handle {
    uint32_t id{};

    [[nodiscard]] constexpr auto Valid() const -> bool
    {
        return id != 0;
    }

    friend constexpr auto operator==(const Handle& lhs, const Handle& rhs) -> bool
    {
        return lhs.id == rhs.id;
    }

    friend constexpr auto operator!=(const Handle& lhs, const Handle& rhs) -> bool
    {
        return lhs.id != rhs.id;
    }
};

using TextureHandle = Handle<struct TextureTag>;
using SamplerHandle = Handle<struct SamplerTag>;
using BufferHandle = Handle<struct BufferTag>;
using VertexArrayHandle = Handle<struct VertexArrayTag>;
using RenderTargetHandle = Handle<struct RenderTargetTag>; //!< id 0: the default framebuffer.
using ProgramHandle = Handle<struct ProgramTag>;

/**
 * @brief A GPU fence, signalled once the commands issued before it have completed.
 */
struct FenceHandle {
    uintptr_t id{};

    [[nodiscard]] constexpr auto Valid() const -> bool
    {
        return id != 0;
    }
};

/**
 * @brief Texture dimensionality.
 */
enum class TextureTarget : uint8_t
{
    Texture2D,
    Texture3D
};

/**
 * @brief Texture storage format.
 *
 * The unsized formats (R, RG, RGB, RGBA) leave the precision to the driver, which picks
 * 8 bits per channel everywhere projectM runs; they are what images and the legacy color
 * attachments have always been allocated with. Every format has one upload layout (see
 * TextureDesc::dataOrder for the only variation).
 */
enum class TextureFormat : uint8_t
{
    R,               //!< Unsized red, 8-bit data.
    RG,              //!< Unsized red/green, 8-bit data.
    RGB,             //!< Unsized RGB, 8-bit data.
    RGBA,            //!< Unsized RGBA, 8-bit data.
    RGB8,            //!< Sized 8-bit RGB (color-renderable, unlike unsized RGB everywhere).
    RGBA8,           //!< Sized 8-bit RGBA.
    SRGB8Alpha8,     //!< 8-bit sRGB-encoded RGB with linear alpha.
    RG16F,           //!< 16-bit float red/green, float data.
    RGBA16F,         //!< 16-bit float RGBA, half-float data.
    RGBA32F,         //!< 32-bit float RGBA, float data.
    Depth24,         //!< 24-bit depth.
    Stencil8,        //!< 8-bit stencil.
    Depth24Stencil8, //!< Packed 24-bit depth + 8-bit stencil.
};

/**
 * @brief Channel order of texel data handed to a texture upload.
 */
enum class PixelOrder : uint8_t
{
    Rgba, //!< The format's natural order.
    Bgra  //!< Four 8-bit channels stored B, G, R, A (desktop GL only).
};

/**
 * @brief Texture filtering, used for both minification and magnification.
 */
enum class FilterMode : uint8_t
{
    Nearest,
    Linear
};

/**
 * @brief Texture coordinate wrapping, used for both axes.
 */
enum class WrapMode : uint8_t
{
    ClampToEdge,
    Repeat
};

/**
 * @brief Sampling parameters stored with a texture or in a sampler object.
 */
struct TextureSampling {
    FilterMode filter{FilterMode::Nearest};
    WrapMode wrap{WrapMode::ClampToEdge};
};

/**
 * @brief Everything needed to allocate (or re-specify) a texture.
 */
struct TextureDesc {
    TextureTarget target{TextureTarget::Texture2D};
    int width{};
    int height{};
    int depth{}; //!< Only used for 3D textures.
    TextureFormat format{TextureFormat::RGBA};
    PixelOrder dataOrder{PixelOrder::Rgba};
    std::optional<TextureSampling> sampling; //!< Stored with the texture if set.
};

/**
 * @brief How a buffer's contents are expected to change, a hint for the backend.
 */
enum class BufferUsage : uint8_t
{
    StreamDraw,  //!< Modified once and used at most a few times for drawing.
    StreamRead,  //!< Modified once and used at most a few times for reading back.
    StreamCopy,  //!< Modified once and used at most a few times for drawing and reading back.
    StaticDraw,  //!< Modified once and used many times for drawing.
    StaticRead,  //!< Modified once and used many times for reading back.
    StaticCopy,  //!< Modified once and used many times for drawing and reading back.
    DynamicDraw, //!< Modified repeatedly and used many times for drawing.
    DynamicRead, //!< Modified repeatedly and used many times for reading back.
    DynamicCopy  //!< Modified repeatedly and used many times for drawing and reading back.
};

/**
 * @brief What a buffer binding point holds.
 */
enum class BufferKind : uint8_t
{
    Vertex,   //!< Vertex attribute data.
    Index,    //!< 32-bit vertex indices.
    PixelPack //!< Destination of ReadPixels() for asynchronous readback.
};

/**
 * @brief Layout of one float vertex attribute in the bound vertex buffer.
 */
struct VertexAttributeLayout {
    int components{};  //!< 1 to 4 floats.
    int stride{};      //!< Bytes between consecutive vertices.
    size_t offset{};   //!< Byte offset of the first component.
};

/**
 * @brief Primitive assembly mode of a draw.
 */
enum class PrimitiveType : uint8_t
{
    Points,
    Lines,
    LineLoop,
    LineStrip,
    Triangles,
    TriangleStrip,
    TriangleFan
};

/**
 * @brief Blend equation factors (the equation is always "add").
 */
enum class BlendFactor : uint8_t
{
    Zero,
    One,
    SourceColor,
    OneMinusSourceColor,
    DestinationColor,
    OneMinusDestinationColor,
    SourceAlpha,
    OneMinusSourceAlpha,
    DestinationAlpha,
    OneMinusDestinationAlpha,
    ConstantColor,
    OneMinusConstantColor,
    ConstantAlpha,
    OneMinusConstantAlpha,
    SourceAlphaSaturate,
    Source1Color,
    OneMinusSource1Color,
    Source1Alpha,
    OneMinusSource1Alpha
};

/**
 * @brief Separate color and alpha blend factors.
 */
struct BlendFunction {
    BlendFactor sourceColor{BlendFactor::One};
    BlendFactor destinationColor{BlendFactor::Zero};
    BlendFactor sourceAlpha{BlendFactor::One};
    BlendFactor destinationAlpha{BlendFactor::Zero};
};

/**
 * @brief Fixed-function switches. Backends without one of them ignore it.
 */
enum class Capability : uint8_t
{
    Blend,
    ScissorTest,
    CullFace,
    DepthTest,
    Dither,          //!< GL only.
    LineSmooth,      //!< Desktop GL only; ignored on GLES/WebGL.
    FramebufferSrgb, //!< Desktop GL only; ignored on GLES/WebGL.
};

/**
 * @brief Winding that counts as front-facing.
 */
enum class FrontFace : uint8_t
{
    Clockwise,
    CounterClockwise
};

/**
 * @brief Faces removed when Capability::CullFace is enabled.
 */
enum class CullFace : uint8_t
{
    Front,
    Back
};

/**
 * @brief Which of a render target's bindings an operation applies to.
 */
enum class TargetBinding : uint8_t
{
    ReadDraw, //!< Both (binding sets both; a query reports the draw binding).
    Read,     //!< Source of ReadPixels(), Blit() and CopyToBoundTexture().
    Draw      //!< Destination of draws, clears and Blit().
};

/**
 * @brief A render target attachment slot.
 */
enum class AttachmentPoint : uint8_t
{
    Color0 = 0,
    Color1,
    Color2,
    Color3,
    Color4,
    Color5,
    Color6,
    Color7,
    Depth = 16,
    Stencil,
    DepthStencil,
    Back = 32 //!< The default framebuffer's back buffer (read/draw buffer selection only).
};

/**
 * @brief The color attachment slot with the given index (0-7).
 */
constexpr auto ColorAttachment(int index) -> AttachmentPoint
{
    return static_cast<AttachmentPoint>(static_cast<int>(AttachmentPoint::Color0) + index);
}

/**
 * @brief Whether a slot holds a color attachment.
 */
constexpr auto IsColorAttachment(AttachmentPoint point) -> bool
{
    return static_cast<int>(point) <= static_cast<int>(AttachmentPoint::Color7);
}

/**
 * @brief Buffers a Clear() call resets, combinable with |.
 */
enum ClearMask : uint8_t
{
    ClearColor = 1,
    ClearDepth = 2,
    ClearStencil = 4
};

/**
 * @brief How a render pass treats the target's previous contents.
 */
enum class LoadOp : uint8_t
{
    Load, //!< Keep them (Milkdrop's feedback passes depend on this).
    Clear //!< Replace them with RenderPassDesc::clearColor.
};

/**
 * @brief A pixel rectangle, origin bottom-left.
 */
struct Rect {
    int x{};
    int y{};
    int width{};
    int height{};

    friend constexpr auto operator==(const Rect& lhs, const Rect& rhs) -> bool
    {
        return lhs.x == rhs.x && lhs.y == rhs.y && lhs.width == rhs.width && lhs.height == rhs.height;
    }

    friend constexpr auto operator!=(const Rect& lhs, const Rect& rhs) -> bool
    {
        return !(lhs == rhs);
    }
};

/**
 * @brief Where a render pass draws.
 */
struct RenderPassDesc {
    RenderTargetHandle target;                //!< id 0: the default framebuffer.
    TargetBinding binding{TargetBinding::Draw}; //!< ReadDraw also makes it the read source.
    std::optional<Rect> viewport;             //!< Left unchanged if not set.
    LoadOp load{LoadOp::Load};
    std::array<float, 4> clearColor{};        //!< Used with LoadOp::Clear.
};

/**
 * @brief Result of checking a render target for completeness.
 */
struct RenderTargetStatus {
    bool complete{};
    uint32_t code{}; //!< Backend status code, for logs only.
};

/**
 * @brief State of a fence polled without waiting.
 */
enum class FenceStatus : uint8_t
{
    Signaled,
    Pending,
    Failed
};

/**
 * @brief Value types of the uniforms a program can be given.
 */
enum class UniformType : uint8_t
{
    Float,
    Float2,
    Float3,
    Float4,
    Int,
    Int2,
    Int3,
    Int4,
    Mat3x4,
    Mat4x4
};

/**
 * @brief Shader stage objects of a program compile that has been started.
 */
struct PendingProgram {
    uint32_t vertexStage{};
    uint32_t fragmentStage{};
};

/**
 * @brief Outcome of finishing a program compile.
 */
struct ProgramCompileResult {
    enum class Status : uint8_t
    {
        Ok,
        VertexCompileFailed,
        FragmentCompileFailed,
        LinkFailed
    };

    Status status{Status::Ok};
    std::string log; //!< The driver's info log for the failed stage or link.
};

/**
 * @brief The slice of pipeline state a host keeps stable around a render.
 *
 * Captured with ICommandList::CaptureState() and put back with RestoreState().
 */
struct StateSnapshot {
    bool blendEnabled{false};
    BlendFunction blendFunction;
    bool depthMask{true};
    Rect viewport;
    bool scissorEnabled{false};
    Rect scissorBox;
    int activeTextureUnit{0};       //!< GL only: the unit texture-parameter calls apply to.
    TextureHandle unit0Texture2D;   //!< The 2D texture bound on unit 0.
    RenderTargetHandle drawTarget; //!< The bound draw (and read) target.
};

/**
 * @brief How a texture was last used, as the validation layer sees it.
 *
 * WebGPU forbids sampling a texture in the pass that renders to it; on GL that is a
 * feedback loop with undefined results. ResourceStateTracker records these transitions so
 * a hazard shows up on the GL backend before a second backend exists.
 */
enum class ResourceState : uint8_t
{
    Undefined,      //!< Never used since creation.
    RenderTarget,   //!< Attached to the target of the last draw that touched it.
    ShaderResource, //!< Sampled by the last draw that touched it.
    CopySource,     //!< Read by a blit or copy.
    CopyDestination //!< Written by a blit or copy.
};

} // namespace Device
} // namespace Renderer
} // namespace libprojectM
