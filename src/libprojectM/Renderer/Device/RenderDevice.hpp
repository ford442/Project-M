/**
 * @file RenderDevice.hpp
 * @brief The render-device seam: every GPU call projectM makes goes through these two interfaces.
 *
 * IRenderDevice creates, uploads and destroys resources; ICommandList sets state and records
 * passes and draws. The only implementation today is Gl::GlDevice (OpenGL 3.3 / GLES 3 /
 * WebGL 2), which issues the same GL calls the renderer made before the seam existed. The
 * interface is shaped by what Milkdrop actually draws — fullscreen quads, the warp mesh,
 * waveform lines and points, the blur chain, sprites — not by any one API, so a WebGPU
 * backend can implement it later. See docs/RENDER_DEVICE.md.
 *
 * scripts/check_gl_seam.sh fails the build if a gl* call appears outside
 * Renderer/Device/Gl/ and Renderer/Platform/.
 */
#pragma once

#include "Renderer/Device/DeviceTypes.hpp"

#include <cstddef>
#include <string>
#include <vector>

namespace libprojectM {
namespace Renderer {
namespace Device {

class ResourceStateTracker;

/**
 * @brief State changes, passes, draws, copies and readback.
 *
 * Commands execute in order. On the GL backend they execute immediately, so a query
 * (IsEnabled(), BoundRenderTarget(), Viewport(), ...) answers from the context and sees
 * changes a host made outside projectM.
 */
class ICommandList
{
public:
    virtual ~ICommandList() = default;

    // ---- Passes and render targets ------------------------------------------------------

    /**
     * @brief Starts drawing into a target: binds it, sets the viewport and applies the load op.
     *
     * A pass lasts until the next BeginPass() or BindRenderTarget() on the draw binding, or
     * EndPass(). Textures attached to the pass target must not be sampled during the pass.
     */
    virtual void BeginPass(const RenderPassDesc& pass) = 0;

    /**
     * @brief Ends the current pass. Its attachments may be sampled from here on.
     */
    virtual void EndPass() = 0;

    /**
     * @brief Binds a render target without starting an explicit pass (stateful callers).
     */
    virtual void BindRenderTarget(TargetBinding binding, RenderTargetHandle target) = 0;

    /**
     * @brief The target bound to a binding point (ReadDraw reports the draw binding).
     */
    [[nodiscard]] virtual auto BoundRenderTarget(TargetBinding binding) -> RenderTargetHandle = 0;

    /**
     * @brief Attaches a 2D texture (level 0) to the target bound at @a binding; 0 detaches.
     */
    virtual void AttachTexture(TargetBinding binding, AttachmentPoint point, TextureHandle texture) = 0;

    /**
     * @brief Selects the attachments fragment outputs 0..n-1 write to, on the bound draw target.
     */
    virtual void SetDrawBuffers(const std::vector<AttachmentPoint>& points) = 0;

    /**
     * @brief Selects the attachment read by ReadPixels(), Blit() and CopyToBoundTexture().
     */
    virtual void SetReadBuffer(AttachmentPoint point) = 0;

    /**
     * @brief Checks whether the target bound at @a binding can be rendered to.
     */
    [[nodiscard]] virtual auto CheckRenderTarget(TargetBinding binding) -> RenderTargetStatus = 0;

    // ---- Fixed-function state ---------------------------------------------------------

    virtual void SetViewport(const Rect& viewport) = 0;
    [[nodiscard]] virtual auto Viewport() -> Rect = 0;
    virtual void SetScissor(const Rect& box) = 0;

    virtual void SetEnabled(Capability capability, bool enabled) = 0;
    [[nodiscard]] virtual auto IsEnabled(Capability capability) -> bool = 0;

    /**
     * @brief Sets the same factors for color and alpha.
     */
    virtual void SetBlendFunction(BlendFactor source, BlendFactor destination) = 0;
    virtual void SetBlendFunction(const BlendFunction& function) = 0;
    [[nodiscard]] virtual auto GetBlendFunction() -> BlendFunction = 0;

    virtual void SetDepthMask(bool writeEnabled) = 0;
    [[nodiscard]] virtual auto DepthMask() -> bool = 0;

    /**
     * @brief Enables or disables writes to each channel of every draw buffer.
     */
    virtual void SetColorMask(bool red, bool green, bool blue, bool alpha) = 0;

    /**
     * @brief Enables or disables all writes to one draw buffer.
     *
     * Where per-buffer masks are not available (GLES 3.1 and lower) this masks every buffer.
     */
    virtual void SetDrawBufferWriteMask(int drawBuffer, bool writeEnabled) = 0;

    virtual void SetCullMode(FrontFace frontFace, CullFace cullFace) = 0;
    virtual void SetLineWidth(float width) = 0;

    /**
     * @brief Asks for the highest-quality derivatives and mipmap generation (GL hints).
     */
    virtual void SetNicestQualityHints() = 0;

    virtual void SetClearColor(const std::array<float, 4>& color) = 0;
    virtual void Clear(uint8_t clearMask) = 0;

    /**
     * @brief Clears one color draw buffer of the bound draw target, ignoring the clear color.
     */
    virtual void ClearColorAttachment(int drawBuffer, const std::array<float, 4>& color) = 0;

    // ---- Programs and uniforms --------------------------------------------------------

    /**
     * @brief Makes a program current; an invalid handle unbinds.
     */
    virtual void SetProgram(ProgramHandle program) = 0;

    /**
     * @brief Sets a uniform of the current program. Negative locations are ignored.
     * @param count Array elements (1 for a single value).
     * @param data @a count values of @a type, matrices column-major.
     */
    virtual void SetUniform(int location, UniformType type, int count, const void* data) = 0;

    // ---- Textures and samplers --------------------------------------------------------

    /**
     * @brief Binds a texture to a unit; an invalid handle unbinds the unit's @a target.
     */
    virtual void BindTexture(int unit, TextureTarget target, TextureHandle texture) = 0;

    /**
     * @brief The 2D texture bound on the active unit.
     */
    [[nodiscard]] virtual auto BoundTexture2D() -> TextureHandle = 0;

    /**
     * @brief Binds a sampler object to a unit; an invalid handle leaves the texture's own sampling.
     */
    virtual void BindSampler(int unit, SamplerHandle sampler) = 0;

    /**
     * @brief The unit that texture-parameter and copy calls apply to on GL. Ignored elsewhere.
     */
    virtual void SetActiveTextureUnit(int unit) = 0;
    [[nodiscard]] virtual auto ActiveTextureUnit() -> int = 0;

    /**
     * @brief Changes the stored filtering of the texture bound to @a unit.
     */
    virtual void SetBoundTextureFilter(int unit, TextureTarget target, FilterMode filter) = 0;

    /**
     * @brief Changes the stored wrapping of the texture bound to @a unit.
     */
    virtual void SetBoundTextureWrap(int unit, TextureTarget target, WrapMode wrap) = 0;

    /**
     * @brief Sets the anisotropic filtering limit of the texture bound to @a unit.
     */
    virtual void SetBoundTextureMaxAnisotropy(int unit, TextureTarget target, float maxAnisotropy) = 0;

    /**
     * @brief Copies the bottom-left @a width x @a height pixels of the read target into the
     *        2D texture bound to @a unit, at its origin.
     */
    virtual void CopyToBoundTexture(int unit, int width, int height) = 0;

    // ---- Geometry and draws -----------------------------------------------------------

    virtual void BindVertexArray(VertexArrayHandle vertexArray) = 0;
    virtual void BindBuffer(BufferKind kind, BufferHandle buffer) = 0;

    /**
     * @brief Uploads data to the buffer bound for @a kind.
     * @param reallocate true to (re)allocate the storage at @a bytes, false to overwrite
     *                   the start of the existing storage.
     */
    virtual void UploadBoundBuffer(BufferKind kind, const void* data, size_t bytes, BufferUsage usage, bool reallocate) = 0;

    /**
     * @brief Describes attribute @a index of the bound vertex array as floats in the bound vertex buffer.
     */
    virtual void SetVertexAttributeLayout(int index, const VertexAttributeLayout& layout) = 0;
    virtual void SetVertexAttributeEnabled(int index, bool enabled) = 0;

    /**
     * @brief The value a disabled attribute array reads (e.g. a whole draw's color).
     */
    virtual void SetConstantVertexAttribute(int index, const std::array<float, 4>& value) = 0;

    /**
     * @brief Draws @a count vertices of the bound vertex array, in order.
     */
    virtual void Draw(PrimitiveType primitive, int first, int count) = 0;

    /**
     * @brief Draws @a count 32-bit indices from the bound vertex array's index buffer.
     */
    virtual void DrawIndexed(PrimitiveType primitive, int count) = 0;

    // ---- Copies and readback ----------------------------------------------------------

    /**
     * @brief Copies color from the read target to the draw target, scaling and flipping as
     *        the rectangles say (a negative-width rectangle mirrors). Ignores blending.
     */
    virtual void Blit(const Rect& source, const Rect& destination, FilterMode filter) = 0;

    /**
     * @brief Reads RGBA8 pixels from the read target, rows tightly packed, bottom row first.
     *
     * With a PixelPack buffer bound, @a destination is a byte offset into it (nullptr = 0)
     * and the read completes asynchronously; see IRenderDevice::CreateFence().
     */
    virtual void ReadPixels(const Rect& area, void* destination) = 0;

    // ---- Host state ------------------------------------------------------------------

    [[nodiscard]] virtual auto CaptureState() -> StateSnapshot = 0;
    virtual void RestoreState(const StateSnapshot& state) = 0;
};

/**
 * @brief Creates, uploads and destroys GPU resources; answers capability queries.
 *
 * Methods must be called with the backend's context current (on GL: the context projectM
 * was created in). Destroy*() of an invalid handle is a no-op.
 */
class IRenderDevice
{
public:
    virtual ~IRenderDevice() = default;

    /**
     * @brief The command list commands for this device are recorded into.
     */
    [[nodiscard]] virtual auto Commands() -> ICommandList& = 0;

    /**
     * @brief The validation layer, see ResourceStateTracker.
     */
    [[nodiscard]] virtual auto Validation() -> ResourceStateTracker& = 0;

    // ---- Capabilities ----------------------------------------------------------------

    /**
     * @brief The shading language version string the context reports, empty if none.
     */
    [[nodiscard]] virtual auto ShadingLanguageVersionString() -> std::string = 0;

    /**
     * @brief Whether programs can link on driver threads (KHR_parallel_shader_compile).
     */
    [[nodiscard]] virtual auto SupportsParallelShaderCompile() -> bool = 0;

    /**
     * @brief The largest anisotropic filtering limit, or 0 without anisotropic filtering.
     */
    [[nodiscard]] virtual auto MaxTextureAnisotropy() -> float = 0;

    // ---- Textures and samplers --------------------------------------------------------

    /**
     * @brief Allocates a texture and uploads @a data (may be nullptr) in the format's layout.
     */
    [[nodiscard]] virtual auto CreateTexture(const TextureDesc& desc, const void* data) -> TextureHandle = 0;

    /**
     * @brief Re-specifies a texture's storage from @a desc and uploads @a data (may be nullptr).
     */
    virtual void UpdateTexture(TextureHandle texture, const TextureDesc& desc, const void* data) = 0;

    virtual void DestroyTexture(TextureHandle texture) = 0;

    [[nodiscard]] virtual auto CreateSampler(const TextureSampling& sampling) -> SamplerHandle = 0;
    virtual void SetSamplerFilter(SamplerHandle sampler, FilterMode filter) = 0;
    virtual void SetSamplerWrap(SamplerHandle sampler, WrapMode wrap) = 0;
    virtual void DestroySampler(SamplerHandle sampler) = 0;

    // ---- Buffers and vertex arrays ---------------------------------------------------

    [[nodiscard]] virtual auto CreateBuffer() -> BufferHandle = 0;
    virtual void DestroyBuffer(BufferHandle buffer) = 0;

    /**
     * @brief Reads back the start of a buffer bound for @a kind, e.g. a finished PixelPack read.
     */
    virtual void ReadBoundBuffer(BufferKind kind, size_t bytes, void* destination) = 0;

    [[nodiscard]] virtual auto CreateVertexArray() -> VertexArrayHandle = 0;
    virtual void DestroyVertexArray(VertexArrayHandle vertexArray) = 0;

    // ---- Render targets -------------------------------------------------------------

    [[nodiscard]] virtual auto CreateRenderTarget() -> RenderTargetHandle = 0;
    virtual void DestroyRenderTarget(RenderTargetHandle target) = 0;

    // ---- Programs ------------------------------------------------------------------

    [[nodiscard]] virtual auto CreateProgram() -> ProgramHandle = 0;
    virtual void DestroyProgram(ProgramHandle program) = 0;

    /**
     * @brief Starts compiling and linking a program without waiting for the result.
     *
     * Nothing is read back, so with KHR_parallel_shader_compile the driver does the work on
     * its own threads. Call FinishCompileProgram() (or AbandonCompileProgram()) with the result.
     */
    [[nodiscard]] virtual auto BeginCompileProgram(ProgramHandle program,
                                                   const std::string& vertexSource,
                                                   const std::string& fragmentSource) -> PendingProgram = 0;

    /**
     * @brief Whether the driver has finished a started compile and link. Does not block.
     *        Only meaningful with SupportsParallelShaderCompile().
     */
    [[nodiscard]] virtual auto IsProgramCompileComplete(ProgramHandle program) -> bool = 0;

    /**
     * @brief Waits for a started compile, checks vertex stage, fragment stage and link in
     *        that order, and releases the stage objects.
     */
    [[nodiscard]] virtual auto FinishCompileProgram(ProgramHandle program, const PendingProgram& pending) -> ProgramCompileResult = 0;

    /**
     * @brief Releases the stage objects of a started compile without checking it.
     */
    virtual void AbandonCompileProgram(ProgramHandle program, const PendingProgram& pending) = 0;

    /**
     * @brief Checks whether the program can run in the current state.
     */
    [[nodiscard]] virtual auto ValidateProgram(ProgramHandle program, std::string& log) -> bool = 0;

    /**
     * @brief The location of an active uniform, or -1.
     */
    [[nodiscard]] virtual auto UniformLocation(ProgramHandle program, const char* name) -> int = 0;

    /**
     * @brief The location of an active vertex input, or -1.
     */
    [[nodiscard]] virtual auto AttributeLocation(ProgramHandle program, const char* name) -> int = 0;

    // ---- Fences ----------------------------------------------------------------------

    /**
     * @brief Inserts a fence after every command issued so far.
     */
    [[nodiscard]] virtual auto CreateFence() -> FenceHandle = 0;
    [[nodiscard]] virtual auto PollFence(FenceHandle fence) -> FenceStatus = 0;
    virtual void DestroyFence(FenceHandle fence) = 0;
};

/**
 * @brief The device this thread renders with.
 *
 * A device installed with ScopedDevice, else the process-wide GL device. Resource wrappers
 * (Texture, Shader, Framebuffer, ...) remember the device that created them.
 */
auto Current() -> IRenderDevice&;

/**
 * @brief Makes @a device this thread's current device until destroyed.
 */
class ScopedDevice
{
public:
    explicit ScopedDevice(IRenderDevice& device);
    ~ScopedDevice();

    ScopedDevice(const ScopedDevice&) = delete;
    auto operator=(const ScopedDevice&) -> ScopedDevice& = delete;
    ScopedDevice(ScopedDevice&&) = delete;
    auto operator=(ScopedDevice&&) -> ScopedDevice& = delete;

private:
    IRenderDevice* m_previous;
};

/**
 * @brief Shorthand for Current().Commands().
 */
inline auto Commands() -> ICommandList&
{
    return Current().Commands();
}

} // namespace Device
} // namespace Renderer
} // namespace libprojectM
