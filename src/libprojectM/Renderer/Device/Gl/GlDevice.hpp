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

#include <atomic>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace libprojectM {
namespace Renderer {
namespace Device {
namespace Gl {

/**
 * @brief Immediate-mode GL command list.
 */
class GlDevice;

class GlCommandList final : public ICommandList
{
public:
    GlCommandList(GlDevice& device, ResourceStateTracker& tracker);

    void BeginRenderPass(const RenderPassDesc& pass) override;
    void EndRenderPass() override;
    auto CurrentRenderPass() const -> const RenderPassDesc* override;
    void BindRenderTarget(TargetBinding binding, RenderTargetHandle target) override;
    auto BoundRenderTarget(TargetBinding binding) -> RenderTargetHandle override;
    void AttachTexture(TargetBinding binding, AttachmentPoint point, TextureHandle texture) override;
    void SetDrawBuffers(std::span<const AttachmentPoint> points) override;
    void SetReadBuffer(AttachmentPoint point) override;
    auto CheckRenderTarget(TargetBinding binding) -> RenderTargetStatus override;

    void SetViewport(const Rect& viewport) override;
    auto Viewport() -> Rect override;
    void SetScissor(const Rect& box) override;
    void SetEnabled(Capability capability, bool enabled) override;
    auto IsEnabled(Capability capability) -> bool override;
    void SetLineWidth(float width) override;
    void SetNicestQualityHints() override;
    void SetClearColor(const std::array<float, 4>& color) override;
    void Clear(uint8_t clearMask) override;
    void ClearColorAttachment(int drawBuffer, const std::array<float, 4>& color, const std::array<bool, 4>& writeMask) override;

    void SetPipeline(PipelineHandle pipeline) override;
    void SetProgram(ProgramHandle program) override;
    void SetUniform(int location, UniformType type, int count, const void* data) override;
    void BindUniformBuffer(int slot, BufferHandle buffer, size_t offset, size_t size) override;
    void SetBindGroup(BindGroupHandle group, std::span<const uint32_t> dynamicOffsets) override;

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
    void Draw(int first, int count) override;
    void DrawIndexed(int count) override;

    void Blit(const Rect& source, const Rect& destination, FilterMode filter) override;
    void ReadPixels(const Rect& area, void* destination) override;

    auto CaptureState() -> StateSnapshot override;
    void RestoreState(const StateSnapshot& state) override;
    void InvalidateState() override;
    void ResetPipelineState() override;

    /**
     * @brief The device destroyed @a program: forget it as the current one.
     */
    void OnProgramDestroyed(ProgramHandle program);

    /**
     * @brief The device bound and unbound a texture on the active unit (texture uploads), or
     *        deleted one: forget what that unit, or every unit holding @a deleted, has bound.
     */
    void OnTextureBindingDisturbed(TextureTarget target);
    void OnTextureDeleted(TextureHandle deleted);
    void OnSamplerDeleted(SamplerHandle deleted);

private:
    /**
     * @brief The fixed-function state the last SetPipeline() put on the context.
     */
    struct AppliedState {
        ProgramHandle program;
        BlendState blend;
        RasterState raster;
        DepthStencilState depthStencil;
        std::array<bool, 4> colorMask{true, true, true, true}; //!< Applied to every draw buffer.
    };

    /**
     * @brief Puts @a desc's state on the context, skipping what is already there.
     */
    void Apply(const PipelineDesc& desc);
    void ApplyProgram(ProgramHandle program, bool known);
    void ApplyColorMask(const std::array<bool, 4>& mask, bool known);
    void ApplyDepthWrite(bool enabled, bool known);

    /**
     * @brief With validation on, drains glGetError() and logs each distinct error once,
     *        as "[RenderDevice] GL error ... after <operation>". A no-op otherwise, so
     *        release paths never pay for the round trip (a sync point under WebGL).
     */
    void ReportGlErrors(const char* operation);

    GlDevice& m_device;
    ResourceStateTracker& m_tracker;
    std::set<std::string> m_reportedGlErrors; //!< "<operation>:<code>" pairs already logged.

    AppliedState m_applied;                 //!< Valid while m_stateKnown.
    std::atomic<bool> m_stateKnown{false};  //!< Cleared from any thread by InvalidateState().
    bool m_hasPipeline{false};              //!< A draw has a pipeline (topology) to use.
    PrimitiveType m_topology{PrimitiveType::Triangles};
    bool m_reportedMissingPipeline{false};
    bool m_reportedUnknownPipeline{false};
    uint32_t m_boundUniformSlots{}; //!< Bit n: slot n had a buffer bound since the last reset.

    /**
     * @brief What a texture unit has bound, as far as this command list knows; SetBindGroup()
     *        skips bindings that are already there.
     */
    struct UnitBinding {
        std::optional<TextureHandle> texture2D;
        std::optional<TextureHandle> texture3D;
        std::optional<SamplerHandle> sampler;
    };
    static constexpr int TrackedUnits = 32;
    void ForgetUnitBindingsIfInvalidated();
    std::array<UnitBinding, TrackedUnits> m_units{};
    int m_activeUnit{-1};                  //!< -1: unknown.
    std::atomic<bool> m_unitsKnown{false}; //!< Cleared from any thread by InvalidateState().
    std::optional<RenderPassDesc> m_pass; //!< The open render pass.
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
    auto UniformBufferOffsetAlignment() -> size_t override;

    auto CreateTexture(const TextureDesc& desc, const void* data) -> TextureHandle override;
    void UpdateTexture(TextureHandle texture, const TextureDesc& desc, const void* data) override;
    void WriteTexture(TextureHandle texture, const TextureDesc& desc, const void* data) override;
    void DestroyTexture(TextureHandle texture) override;

    auto CreateSampler(const TextureSampling& sampling) -> SamplerHandle override;
    void SetSamplerFilter(SamplerHandle sampler, FilterMode filter) override;
    void SetSamplerWrap(SamplerHandle sampler, WrapMode wrap) override;
    void DestroySampler(SamplerHandle sampler) override;

    auto CreateBuffer() -> BufferHandle override;
    void DestroyBuffer(BufferHandle buffer) override;
    auto CreateUniformBuffer(size_t bytes) -> BufferHandle override;
    void WriteBuffer(BufferHandle buffer, size_t offset, const void* data, size_t bytes) override;
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
    auto BindUniformBlock(ProgramHandle program, const char* name, int slot) -> bool override;

    auto CreatePipeline(const PipelineDesc& desc) -> PipelineHandle override;
    auto Pipeline(PipelineHandle pipeline) const -> const PipelineDesc* override;
    auto PipelineCount() const -> size_t override;

    auto CreateBindGroup(const BindGroupDesc& desc) -> BindGroupHandle override;
    void DestroyBindGroup(BindGroupHandle group) override;
    auto BindGroup(BindGroupHandle group) const -> const BindGroupDesc* override;
    auto BindGroupCount() const -> size_t override;

    auto CreateFence() -> FenceHandle override;
    auto PollFence(FenceHandle fence) -> FenceStatus override;
    void DestroyFence(FenceHandle fence) override;

private:
    /**
     * @brief Tells the tracker which uniform locations of a linked program are samplers.
     */
    void RegisterSamplerUniforms(ProgramHandle program);

    ResourceStateTracker m_tracker;
    GlCommandList m_commands{*this, m_tracker};

    //! Pipelines by id. Ids are never reused, so a stale handle finds nothing. Render thread only,
    //! like the programs they belong to (a prepare job holds no GL objects, see preset_prepare.h).
    std::unordered_map<uint32_t, PipelineDesc> m_pipelines;
    std::unordered_multimap<size_t, uint32_t> m_pipelinesByHash; //!< Hash(desc) to ids.
    uint32_t m_nextPipelineId{1};

    std::unordered_map<uint32_t, BindGroupDesc> m_bindGroups; //!< By id; ids are never reused.
    uint32_t m_nextBindGroupId{1};
};

} // namespace Gl
} // namespace Device
} // namespace Renderer
} // namespace libprojectM
