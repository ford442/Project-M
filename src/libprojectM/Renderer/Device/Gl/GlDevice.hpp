/**
 * @file GlDevice.hpp
 * @brief The OpenGL 3.3 / GLES 3 / WebGL 2 render device.
 *
 * Every method issues the GL calls the renderer issued before the device seam existed, in
 * the same order, so output is bit-identical. Queries go to the context; nothing is cached,
 * because projectM shares its context with the host application.
 */
#pragma once

#include "Renderer/Device/RenderDevice.hpp"
#include "Renderer/Device/ResourceStateTracker.hpp"

namespace libprojectM {
namespace Renderer {
namespace Device {
namespace Gl {

/**
 * @brief Immediate-mode GL command list.
 */
class GlCommandList final : public ICommandList
{
public:
    explicit GlCommandList(ResourceStateTracker& tracker);

    void BeginPass(const RenderPassDesc& pass) override;
    void EndPass() override;
    void BindRenderTarget(TargetBinding binding, RenderTargetHandle target) override;
    auto BoundRenderTarget(TargetBinding binding) -> RenderTargetHandle override;
    void AttachTexture(TargetBinding binding, AttachmentPoint point, TextureHandle texture) override;
    void SetDrawBuffers(const std::vector<AttachmentPoint>& points) override;
    void SetReadBuffer(AttachmentPoint point) override;
    auto CheckRenderTarget(TargetBinding binding) -> RenderTargetStatus override;

    void SetViewport(const Rect& viewport) override;
    auto Viewport() -> Rect override;
    void SetScissor(const Rect& box) override;
    void SetEnabled(Capability capability, bool enabled) override;
    auto IsEnabled(Capability capability) -> bool override;
    void SetBlendFunction(BlendFactor source, BlendFactor destination) override;
    void SetBlendFunction(const BlendFunction& function) override;
    auto GetBlendFunction() -> BlendFunction override;
    void SetDepthMask(bool writeEnabled) override;
    auto DepthMask() -> bool override;
    void SetColorMask(bool red, bool green, bool blue, bool alpha) override;
    void SetDrawBufferWriteMask(int drawBuffer, bool writeEnabled) override;
    void SetCullMode(FrontFace frontFace, CullFace cullFace) override;
    void SetLineWidth(float width) override;
    void SetNicestQualityHints() override;
    void SetClearColor(const std::array<float, 4>& color) override;
    void Clear(uint8_t clearMask) override;
    void ClearColorAttachment(int drawBuffer, const std::array<float, 4>& color) override;

    void SetProgram(ProgramHandle program) override;
    void SetUniform(int location, UniformType type, int count, const void* data) override;

    void BindTexture(int unit, TextureTarget target, TextureHandle texture) override;
    auto BoundTexture2D() -> TextureHandle override;
    void BindSampler(int unit, SamplerHandle sampler) override;
    void SetActiveTextureUnit(int unit) override;
    auto ActiveTextureUnit() -> int override;
    void SetBoundTextureFilter(int unit, TextureTarget target, FilterMode filter) override;
    void SetBoundTextureWrap(int unit, TextureTarget target, WrapMode wrap) override;
    void SetBoundTextureMaxAnisotropy(int unit, TextureTarget target, float maxAnisotropy) override;
    void CopyToBoundTexture(int unit, int width, int height) override;

    void BindVertexArray(VertexArrayHandle vertexArray) override;
    void BindBuffer(BufferKind kind, BufferHandle buffer) override;
    void UploadBoundBuffer(BufferKind kind, const void* data, size_t bytes, BufferUsage usage, bool reallocate) override;
    void SetVertexAttributeLayout(int index, const VertexAttributeLayout& layout) override;
    void SetVertexAttributeEnabled(int index, bool enabled) override;
    void SetConstantVertexAttribute(int index, const std::array<float, 4>& value) override;
    void Draw(PrimitiveType primitive, int first, int count) override;
    void DrawIndexed(PrimitiveType primitive, int count) override;

    void Blit(const Rect& source, const Rect& destination, FilterMode filter) override;
    void ReadPixels(const Rect& area, void* destination) override;

    auto CaptureState() -> StateSnapshot override;
    void RestoreState(const StateSnapshot& state) override;

private:
    ResourceStateTracker& m_tracker;
};

/**
 * @brief The GL render device. Stateless apart from the (optional) validation tracker.
 */
class GlDevice final : public IRenderDevice
{
public:
    /**
     * @brief Creates the device. PROJECTM_DEVICE_VALIDATION=1 starts it with validation on.
     */
    GlDevice();

    auto Commands() -> ICommandList& override;
    auto Validation() -> ResourceStateTracker& override;

    auto ShadingLanguageVersionString() -> std::string override;
    auto SupportsParallelShaderCompile() -> bool override;
    auto MaxTextureAnisotropy() -> float override;

    auto CreateTexture(const TextureDesc& desc, const void* data) -> TextureHandle override;
    void UpdateTexture(TextureHandle texture, const TextureDesc& desc, const void* data) override;
    void DestroyTexture(TextureHandle texture) override;

    auto CreateSampler(const TextureSampling& sampling) -> SamplerHandle override;
    void SetSamplerFilter(SamplerHandle sampler, FilterMode filter) override;
    void SetSamplerWrap(SamplerHandle sampler, WrapMode wrap) override;
    void DestroySampler(SamplerHandle sampler) override;

    auto CreateBuffer() -> BufferHandle override;
    void DestroyBuffer(BufferHandle buffer) override;
    void ReadBoundBuffer(BufferKind kind, size_t bytes, void* destination) override;

    auto CreateVertexArray() -> VertexArrayHandle override;
    void DestroyVertexArray(VertexArrayHandle vertexArray) override;

    auto CreateRenderTarget() -> RenderTargetHandle override;
    void DestroyRenderTarget(RenderTargetHandle target) override;

    auto CreateProgram() -> ProgramHandle override;
    void DestroyProgram(ProgramHandle program) override;
    auto BeginCompileProgram(ProgramHandle program,
                             const std::string& vertexSource,
                             const std::string& fragmentSource) -> PendingProgram override;
    auto IsProgramCompileComplete(ProgramHandle program) -> bool override;
    auto FinishCompileProgram(ProgramHandle program, const PendingProgram& pending) -> ProgramCompileResult override;
    void AbandonCompileProgram(ProgramHandle program, const PendingProgram& pending) override;
    auto ValidateProgram(ProgramHandle program, std::string& log) -> bool override;
    auto UniformLocation(ProgramHandle program, const char* name) -> int override;
    auto AttributeLocation(ProgramHandle program, const char* name) -> int override;

    auto CreateFence() -> FenceHandle override;
    auto PollFence(FenceHandle fence) -> FenceStatus override;
    void DestroyFence(FenceHandle fence) override;

private:
    /**
     * @brief Tells the tracker which uniform locations of a linked program are samplers.
     */
    void RegisterSamplerUniforms(ProgramHandle program);

    ResourceStateTracker m_tracker;
    GlCommandList m_commands{m_tracker};
};

} // namespace Gl
} // namespace Device
} // namespace Renderer
} // namespace libprojectM
