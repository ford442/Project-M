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
#include <optional>
#include <span>
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
     * @brief Starts a render pass: binds its target, sets the viewport and applies the load op.
     *
     * Every draw and clear happens inside a pass, and passes do not nest: EndRenderPass() ends
     * it. Inside a pass the target and its attachments are fixed, its attachments must not be
     * sampled, and copies, blits and readbacks are not allowed (they are WebGPU encoder
     * commands, not pass commands). The validation layer reports each of these as a pass
     * violation; see ResourceStateTracker.
     */
    virtual void BeginRenderPass(const RenderPassDesc& pass) = 0;

    /**
     * @brief Ends the current render pass. Its attachments may be sampled from here on.
     */
    virtual void EndRenderPass() = 0;

    /**
     * @brief The open render pass, or nullptr. Code that has to render elsewhere while its
     *        caller's pass is open ends it and later begins RenderPassDesc::Resumed().
     */
    [[nodiscard]] virtual auto CurrentRenderPass() const -> const RenderPassDesc* = 0;

    /**
     * @brief Binds a render target outside a pass: for attachment changes, read sources of
     *        copies and blits, and blit destinations. Draws need BeginRenderPass().
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
    virtual void SetDrawBuffers(std::span<const AttachmentPoint> points) = 0;

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
     * @brief GL only: the width of line primitives. Ignored elsewhere (WebGPU lines are 1 px).
     */
    virtual void SetLineWidth(float width) = 0;

    /**
     * @brief Asks for the highest-quality derivatives and mipmap generation (GL hints).
     */
    virtual void SetNicestQualityHints() = 0;

    /**
     * @brief Sets the colour a Clear() of the colour buffer writes.
     */
    virtual void SetClearColor(const std::array<float, 4>& color) = 0;

    /**
     * @brief Clears the bound draw target. Clears every channel and the whole depth buffer,
     *        whatever the current pipeline's write masks say.
     */
    virtual void Clear(uint8_t clearMask) = 0;

    /**
     * @brief Clears one color draw buffer of the bound draw target, ignoring the clear color.
     *
     * Only the channels @a writeMask enables (red, green, blue, alpha) change.
     */
    virtual void ClearColorAttachment(int drawBuffer, const std::array<float, 4>& color,
                                      const std::array<bool, 4>& writeMask = {true, true, true, true}) = 0;

    // ---- Pipelines and uniforms -------------------------------------------------------

    /**
     * @brief Makes a pipeline current: its program, blending, culling, depth state, colour
     *        write masks and topology apply to the following draws.
     *
     * An invalid or destroyed handle is ignored (and logged once).
     */
    virtual void SetPipeline(PipelineHandle pipeline) = 0;

    /**
     * @brief Makes a program current without the rest of a pipeline, for uniform setup
     *        outside a draw (e.g. right after linking); an invalid handle unbinds.
     *
     * A draw needs SetPipeline().
     */
    virtual void SetProgram(ProgramHandle program) = 0;

    /**
     * @brief Sets a uniform of the current program. Negative locations are ignored.
     * @param count Array elements (1 for a single value).
     * @param data @a count values of @a type, matrices column-major.
     */
    virtual void SetUniform(int location, UniformType type, int count, const void* data) = 0;

    /**
     * @brief Binds @a size bytes of a uniform buffer, starting at @a offset, to uniform block
     *        slot @a slot. Programs read it through the block bound to that slot
     *        (IRenderDevice::BindUniformBlock()).
     *
     * @a offset must be a multiple of IRenderDevice::UniformBufferOffsetAlignment(). An invalid
     * handle unbinds the slot. The binding is not pipeline state and survives SetPipeline();
     * ResetPipelineState() unbinds every slot bound since the last reset.
     */
    virtual void BindUniformBuffer(int slot, BufferHandle buffer, size_t offset, size_t size) = 0;

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
     * @brief Draws @a count vertices of the bound vertex array, in order, as the current
     *        pipeline's topology. Does nothing without a current pipeline.
     */
    virtual void Draw(int first, int count) = 0;

    /**
     * @brief Draws @a count 32-bit indices from the bound vertex array's index buffer, as the
     *        current pipeline's topology. Does nothing without a current pipeline.
     */
    virtual void DrawIndexed(int count) = 0;

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

    /**
     * @brief Forgets which pipeline state the backend last applied, so the next SetPipeline()
     *        applies all of it.
     *
     * Backends that filter redundant state changes (GL) must not trust their record after
     * someone else used the context. ScopedDevice calls it when it installs a device and when
     * it hands the context back, so engine entry points and the code around them need not.
     */
    virtual void InvalidateState() = 0;

    /**
     * @brief Puts pipeline state back to its defaults: no program, blending, culling and depth
     *        testing off, depth writes and every colour channel on, no line smoothing.
     *
     * The state the renderer left a host's context in before pipelines existed. Called at the
     * end of each frame; a backend without global state (WebGPU) does nothing.
     */
    virtual void ResetPipelineState() = 0;
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

    /**
     * @brief The alignment a uniform buffer range passed to ICommandList::BindUniformBuffer()
     *        must start at, in bytes (GL_UNIFORM_BUFFER_OFFSET_ALIGNMENT; 256 on WebGPU).
     */
    [[nodiscard]] virtual auto UniformBufferOffsetAlignment() -> size_t = 0;

    // ---- Textures and samplers --------------------------------------------------------

    /**
     * @brief Allocates a texture and uploads @a data (may be nullptr) in the format's layout.
     */
    [[nodiscard]] virtual auto CreateTexture(const TextureDesc& desc, const void* data) -> TextureHandle = 0;

    /**
     * @brief Re-specifies a texture's storage from @a desc and uploads @a data (may be nullptr).
     */
    virtual void UpdateTexture(TextureHandle texture, const TextureDesc& desc, const void* data) = 0;

    /**
     * @brief Uploads @a data over a texture's whole image without re-specifying its storage.
     *
     * For textures rewritten every frame (live camera/video slots): unlike UpdateTexture() the
     * driver keeps the allocation. @a desc must match the texture's current size and format, and
     * @a data must hold a full image in that layout.
     */
    virtual void WriteTexture(TextureHandle texture, const TextureDesc& desc, const void* data) = 0;

    virtual void DestroyTexture(TextureHandle texture) = 0;

    [[nodiscard]] virtual auto CreateSampler(const TextureSampling& sampling) -> SamplerHandle = 0;
    virtual void SetSamplerFilter(SamplerHandle sampler, FilterMode filter) = 0;
    virtual void SetSamplerWrap(SamplerHandle sampler, WrapMode wrap) = 0;
    virtual void DestroySampler(SamplerHandle sampler) = 0;

    // ---- Buffers and vertex arrays ---------------------------------------------------

    [[nodiscard]] virtual auto CreateBuffer() -> BufferHandle = 0;
    virtual void DestroyBuffer(BufferHandle buffer) = 0;

    /**
     * @brief Creates a buffer with @a bytes of uniform storage (contents undefined), written with
     *        WriteBuffer() and bound with ICommandList::BindUniformBuffer().
     */
    [[nodiscard]] virtual auto CreateUniformBuffer(size_t bytes) -> BufferHandle = 0;

    /**
     * @brief Copies @a bytes of @a data into a buffer at @a offset, ordered before the commands
     *        issued after it (WebGPU's queue.writeBuffer()). Leaves no buffer bound for any kind.
     */
    virtual void WriteBuffer(BufferHandle buffer, size_t offset, const void* data, size_t bytes) = 0;

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

    /**
     * @brief Destroys a program and every pipeline created with it.
     */
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

    /**
     * @brief Makes a linked program's uniform block @a name read from uniform buffer slot @a slot.
     * @return false if the program has no active block of that name (nothing to bind).
     *
     * GLSL 3.30 / ESSL 3.00 cannot say layout(binding = n), so the GL backend does this after
     * each link; a relink forgets it.
     */
    virtual auto BindUniformBlock(ProgramHandle program, const char* name, int slot) -> bool = 0;

    // ---- Pipelines -------------------------------------------------------------------

    /**
     * @brief The pipeline for @a desc. Equal descriptions get the same handle (the device
     *        keeps a cache keyed by Hash(desc)), so callers may ask every frame.
     *
     * The pipeline lives until its program is destroyed. An invalid program gives an invalid handle.
     */
    [[nodiscard]] virtual auto CreatePipeline(const PipelineDesc& desc) -> PipelineHandle = 0;

    /**
     * @brief The description a pipeline was created from, or nullptr for an unknown handle.
     */
    [[nodiscard]] virtual auto Pipeline(PipelineHandle pipeline) const -> const PipelineDesc* = 0;

    /**
     * @brief How many pipelines the device holds (for tests and the perf HUD).
     */
    [[nodiscard]] virtual auto PipelineCount() const -> size_t = 0;

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

/**
 * @brief Makes the pipeline for @a desc current on @a device (created on first use, cached after).
 */
inline void SetPipeline(IRenderDevice& device, const PipelineDesc& desc)
{
    device.Commands().SetPipeline(device.CreatePipeline(desc));
}

/**
 * @brief SetPipeline() on the current device.
 */
inline void SetPipeline(const PipelineDesc& desc)
{
    SetPipeline(Current(), desc);
}

/**
 * @brief Ends the open render pass for its lifetime and resumes it (RenderPassDesc::Resumed())
 *        when it goes out of scope. Does nothing if no pass is open.
 *
 * For code that renders into targets of its own in the middle of its caller's pass, such as a
 * preset's extra shader passes: on WebGPU that is ending the pass encoder and beginning a new
 * one that loads the contents.
 */
class ScopedPassInterruption
{
public:
    explicit ScopedPassInterruption(ICommandList& commands)
        : m_commands(commands)
    {
        if (const auto* pass = commands.CurrentRenderPass())
        {
            m_resume = pass->Resumed();
            commands.EndRenderPass();
        }
    }

    ~ScopedPassInterruption()
    {
        if (m_resume)
        {
            m_commands.BeginRenderPass(*m_resume);
        }
    }

    ScopedPassInterruption(const ScopedPassInterruption&) = delete;
    ScopedPassInterruption(ScopedPassInterruption&&) = delete;
    auto operator=(const ScopedPassInterruption&) -> ScopedPassInterruption& = delete;
    auto operator=(ScopedPassInterruption&&) -> ScopedPassInterruption& = delete;

private:
    ICommandList& m_commands;
    std::optional<RenderPassDesc> m_resume;
};

/**
 * @brief Calls ICommandList::ResetPipelineState() on the current device's command list when it
 *        goes out of scope.
 *
 * Entry points that draw hold one, so the host's GL code finds GL's default blend, depth and
 * cull state afterwards, whatever pipeline drew last.
 */
class ScopedPipelineReset
{
public:
    ScopedPipelineReset()
        : m_commands(Commands())
    {
    }

    ~ScopedPipelineReset()
    {
        m_commands.ResetPipelineState();
    }

    ScopedPipelineReset(const ScopedPipelineReset&) = delete;
    ScopedPipelineReset(ScopedPipelineReset&&) = delete;
    auto operator=(const ScopedPipelineReset&) -> ScopedPipelineReset& = delete;
    auto operator=(ScopedPipelineReset&&) -> ScopedPipelineReset& = delete;

private:
    ICommandList& m_commands;
};

} // namespace Device
} // namespace Renderer
} // namespace libprojectM
