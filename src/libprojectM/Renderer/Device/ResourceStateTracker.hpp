/**
 * @file ResourceStateTracker.hpp
 * @brief Optional validation layer: tracks how textures are used and reports feedback hazards.
 */
#pragma once

#include "Renderer/Device/DeviceTypes.hpp"

#include <array>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace libprojectM {
namespace Renderer {
namespace Device {

/**
 * @brief Follows render targets, texture bindings and draws, and records each texture's
 *        ResourceState and every draw or copy that reads a texture it also writes.
 *
 * Reading a texture in the pass that renders to it is undefined on GL and a validation
 * error on WebGPU. Backends call the On*() hooks; each returns at once while the tracker is
 * disabled, which is the default (set PROJECTM_DEVICE_VALIDATION=1, or call SetEnabled()).
 * Programs linked while it was disabled are not checked, because the tracker learns which
 * units a program samples from its sampler uniforms at link time.
 *
 * Not thread-safe: enable it only while one thread renders.
 */
class ResourceStateTracker
{
public:
    /**
     * @brief Turns tracking on or off. Either way forgets everything recorded so far.
     */
    void SetEnabled(bool enabled);

    [[nodiscard]] auto Enabled() const -> bool
    {
        return m_enabled;
    }

    // ---- Hooks, called by backends -----------------------------------------------------

    void OnBindRenderTarget(TargetBinding binding, RenderTargetHandle target);
    void OnEndPass();
    void OnAttach(TargetBinding binding, AttachmentPoint point, TextureHandle texture);
    void OnBindTexture(int unit, TextureTarget target, TextureHandle texture);
    void OnSetProgram(ProgramHandle program);

    /**
     * @brief Registers the sampler uniform locations of a freshly linked program.
     */
    void OnProgramLinked(ProgramHandle program, const std::vector<int>& samplerLocations);

    /**
     * @brief Records integer uniforms, which assign units to sampler uniforms.
     */
    void OnSetUniformInt(int location, int count, const int* values);

    void OnDraw();
    void OnBlit();
    void OnCopyToTexture(int unit);

    void OnDestroyTexture(TextureHandle texture);
    void OnDestroyRenderTarget(RenderTargetHandle target);
    void OnDestroyProgram(ProgramHandle program);

    // ---- Queries ------------------------------------------------------------------

    /**
     * @brief The last recorded use of a texture.
     */
    [[nodiscard]] auto StateOf(TextureHandle texture) const -> ResourceState;

    /**
     * @brief Hazards seen since the tracker was enabled or the count was reset.
     */
    [[nodiscard]] auto HazardCount() const -> uint64_t
    {
        return m_hazardCount;
    }

    /**
     * @brief Distinct hazard descriptions, at most MaxHazardMessages.
     */
    [[nodiscard]] auto HazardMessages() const -> const std::vector<std::string>&
    {
        return m_hazardMessages;
    }

    void ResetHazards();

    static constexpr size_t MaxHazardMessages{32};
    static constexpr int MaxTextureUnits{32};

private:
    using Attachments = std::map<AttachmentPoint, TextureHandle>;

    /**
     * @brief Units the current program samples, or nullptr if the program is unknown.
     */
    [[nodiscard]] auto SampledUnits() const -> const std::map<int, int>*;

    [[nodiscard]] auto AttachmentsOf(RenderTargetHandle target) const -> const Attachments*;

    void ReportHazard(const std::string& message);

    bool m_enabled{false};

    RenderTargetHandle m_drawTarget;
    RenderTargetHandle m_readTarget;
    std::unordered_map<uint32_t, Attachments> m_attachments; //!< By render target id.

    std::array<TextureHandle, MaxTextureUnits> m_units2D{};
    std::array<TextureHandle, MaxTextureUnits> m_units3D{};

    ProgramHandle m_program;
    std::unordered_map<uint32_t, std::map<int, int>> m_samplerUnits; //!< Program -> sampler location -> unit.

    std::unordered_map<uint32_t, ResourceState> m_states; //!< By texture id.

    uint64_t m_hazardCount{};
    std::vector<std::string> m_hazardMessages;
    std::set<std::string> m_reported;
};

} // namespace Device
} // namespace Renderer
} // namespace libprojectM
