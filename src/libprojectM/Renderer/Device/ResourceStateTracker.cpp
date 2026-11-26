#include "Renderer/Device/ResourceStateTracker.hpp"

#include <Logging.hpp>

#include <iterator>

namespace libprojectM {
namespace Renderer {
namespace Device {

namespace {

auto PointName(AttachmentPoint point) -> std::string
{
    if (IsColorAttachment(point))
    {
        return "Color" + std::to_string(static_cast<int>(point));
    }
    switch (point)
    {
        case AttachmentPoint::Depth:
            return "Depth";
        case AttachmentPoint::Stencil:
            return "Stencil";
        case AttachmentPoint::DepthStencil:
            return "DepthStencil";
        default:
            return "Back";
    }
}

} // namespace

void ResourceStateTracker::SetEnabled(bool enabled)
{
    *this = ResourceStateTracker();
    m_enabled = enabled;
}

void ResourceStateTracker::OnBindRenderTarget(TargetBinding binding, RenderTargetHandle target)
{
    if (!m_enabled)
    {
        return;
    }
    if (binding != TargetBinding::Read && m_inPass && target != m_passTarget)
    {
        ReportPassViolation("draw target changed to " + std::to_string(target.id) + " inside " + PassName());
    }
    if (binding != TargetBinding::Read)
    {
        m_drawTarget = target;
    }
    if (binding != TargetBinding::Draw)
    {
        m_readTarget = target;
    }
}

void ResourceStateTracker::OnBeginRenderPass(const RenderPassDesc& pass)
{
    if (!m_enabled)
    {
        return;
    }
    m_inPass = true;
    m_passTarget = pass.target;
    m_passLabel = pass.label != nullptr ? pass.label : "";
    m_passCount++;
}

void ResourceStateTracker::OnEndRenderPass()
{
    m_inPass = false;
}

void ResourceStateTracker::OnClear()
{
    if (m_enabled && !m_inPass)
    {
        ReportPassViolation("clear of render target " + std::to_string(m_drawTarget.id) + " outside a render pass");
    }
}

void ResourceStateTracker::OnReadPixels()
{
    if (m_enabled && m_inPass)
    {
        ReportPassViolation("readback from render target " + std::to_string(m_readTarget.id) + " inside " + PassName());
    }
}

void ResourceStateTracker::OnPassViolation(const std::string& message)
{
    if (m_enabled)
    {
        ReportPassViolation(message);
    }
}

void ResourceStateTracker::OnAttach(TargetBinding binding, AttachmentPoint point, TextureHandle texture)
{
    if (!m_enabled)
    {
        return;
    }
    const auto target = binding == TargetBinding::Read ? m_readTarget : m_drawTarget;
    if (!target.Valid())
    {
        return;
    }
    if (m_inPass && target == m_passTarget)
    {
        ReportPassViolation("attachment " + PointName(point) + " of render target " + std::to_string(target.id) + " changed inside " + PassName());
    }
    auto& attachments = m_attachments[target.id];
    if (texture.Valid())
    {
        attachments[point] = texture;
    }
    else
    {
        attachments.erase(point);
    }
}

void ResourceStateTracker::OnBindTexture(int unit, TextureTarget target, TextureHandle texture)
{
    if (!m_enabled || unit < 0 || unit >= MaxTextureUnits)
    {
        return;
    }
    (target == TextureTarget::Texture3D ? m_units3D : m_units2D).at(unit) = texture;
}

void ResourceStateTracker::OnSetProgram(ProgramHandle program)
{
    if (!m_enabled)
    {
        return;
    }
    m_program = program;
}

void ResourceStateTracker::OnProgramLinked(ProgramHandle program, const std::vector<int>& samplerLocations)
{
    if (!m_enabled)
    {
        return;
    }
    auto& units = m_samplerUnits[program.id];
    units.clear();
    for (const int location : samplerLocations)
    {
        // An unassigned sampler uniform reads unit 0.
        units[location] = 0;
    }
}

void ResourceStateTracker::OnSetUniformInt(int location, int count, const int* values)
{
    if (!m_enabled || !m_program.Valid() || values == nullptr)
    {
        return;
    }
    const auto program = m_samplerUnits.find(m_program.id);
    if (program == m_samplerUnits.end())
    {
        return;
    }
    // Sampler arrays occupy consecutive locations.
    for (int element = 0; element < count; element++)
    {
        const auto sampler = program->second.find(location + element);
        if (sampler != program->second.end())
        {
            sampler->second = values[element];
        }
    }
}

void ResourceStateTracker::OnDraw()
{
    if (!m_enabled)
    {
        return;
    }
    if (!m_inPass)
    {
        ReportPassViolation("draw with program " + std::to_string(m_program.id) + " into render target " + std::to_string(m_drawTarget.id) + " outside a render pass");
    }

    const auto* attachments = AttachmentsOf(m_drawTarget);
    const auto* sampled = SampledUnits();

    if (sampled != nullptr)
    {
        for (const auto& [location, unit] : *sampled)
        {
            if (unit < 0 || unit >= MaxTextureUnits)
            {
                continue;
            }
            for (const auto texture : {m_units2D.at(unit), m_units3D.at(unit)})
            {
                if (!texture.Valid())
                {
                    continue;
                }
                if (attachments != nullptr)
                {
                    for (const auto& [point, attached] : *attachments)
                    {
                        if (attached == texture)
                        {
                            ReportHazard("draw with program " + std::to_string(m_program.id) + " samples texture " +
                                         std::to_string(texture.id) + " on unit " + std::to_string(unit) +
                                         " while it is attached to render target " + std::to_string(m_drawTarget.id) +
                                         " (" + PointName(point) + ")");
                        }
                    }
                }
                m_states[texture.id] = ResourceState::ShaderResource;
            }
        }
    }

    if (attachments != nullptr)
    {
        for (const auto& attachment : *attachments)
        {
            m_states[attachment.second.id] = ResourceState::RenderTarget;
        }
    }
}

void ResourceStateTracker::OnBlit()
{
    if (!m_enabled)
    {
        return;
    }
    if (m_inPass)
    {
        ReportPassViolation("blit into render target " + std::to_string(m_drawTarget.id) + " inside " + PassName());
    }
    const auto* source = AttachmentsOf(m_readTarget);
    const auto* destination = AttachmentsOf(m_drawTarget);
    TextureHandle sourceTexture;
    if (source != nullptr)
    {
        const auto color0 = source->find(AttachmentPoint::Color0);
        if (color0 != source->end())
        {
            sourceTexture = color0->second;
        }
    }
    if (destination != nullptr)
    {
        for (const auto& [point, texture] : *destination)
        {
            if (sourceTexture.Valid() && texture == sourceTexture)
            {
                ReportHazard("blit reads texture " + std::to_string(texture.id) + " while writing it through render target " +
                             std::to_string(m_drawTarget.id) + " (" + PointName(point) + ")");
            }
            if (IsColorAttachment(point))
            {
                m_states[texture.id] = ResourceState::CopyDestination;
            }
        }
    }
    if (sourceTexture.Valid())
    {
        m_states[sourceTexture.id] = ResourceState::CopySource;
    }
}

void ResourceStateTracker::OnCopyToTexture(int unit)
{
    if (!m_enabled || unit < 0 || unit >= MaxTextureUnits)
    {
        return;
    }
    if (m_inPass)
    {
        ReportPassViolation("copy into the texture on unit " + std::to_string(unit) + " inside " + PassName());
    }
    const auto destination = m_units2D.at(unit);
    const auto* source = AttachmentsOf(m_readTarget);
    if (source != nullptr)
    {
        for (const auto& [point, texture] : *source)
        {
            if (texture == destination)
            {
                ReportHazard("copy into texture " + std::to_string(texture.id) + " reads it through render target " +
                             std::to_string(m_readTarget.id) + " (" + PointName(point) + ")");
            }
            if (point == AttachmentPoint::Color0)
            {
                m_states[texture.id] = ResourceState::CopySource;
            }
        }
    }
    if (destination.Valid())
    {
        m_states[destination.id] = ResourceState::CopyDestination;
    }
}

void ResourceStateTracker::OnDestroyTexture(TextureHandle texture)
{
    if (!m_enabled || !texture.Valid())
    {
        return;
    }
    m_states.erase(texture.id);
    for (auto& unit : m_units2D)
    {
        if (unit == texture)
        {
            unit = {};
        }
    }
    for (auto& unit : m_units3D)
    {
        if (unit == texture)
        {
            unit = {};
        }
    }
    // GL detaches a deleted texture only from the bound targets, but a name is not reused
    // while it is still attached anywhere, so forgetting the attachment is safe either way.
    for (auto& [target, attachments] : m_attachments)
    {
        for (auto it = attachments.begin(); it != attachments.end();)
        {
            it = it->second == texture ? attachments.erase(it) : std::next(it);
        }
    }
}

void ResourceStateTracker::OnDestroyRenderTarget(RenderTargetHandle target)
{
    if (!m_enabled || !target.Valid())
    {
        return;
    }
    m_attachments.erase(target.id);
    if (m_drawTarget == target)
    {
        m_drawTarget = {};
    }
    if (m_readTarget == target)
    {
        m_readTarget = {};
    }
}

void ResourceStateTracker::OnDestroyProgram(ProgramHandle program)
{
    if (!m_enabled || !program.Valid())
    {
        return;
    }
    m_samplerUnits.erase(program.id);
    if (m_program == program)
    {
        m_program = {};
    }
}

auto ResourceStateTracker::StateOf(TextureHandle texture) const -> ResourceState
{
    const auto state = m_states.find(texture.id);
    return state == m_states.end() ? ResourceState::Undefined : state->second;
}

void ResourceStateTracker::ResetHazards()
{
    m_hazardCount = 0;
    m_hazardMessages.clear();
    m_reported.clear();
}

void ResourceStateTracker::ResetPassViolations()
{
    m_passViolationCount = 0;
    m_passViolationMessages.clear();
    m_reportedPassViolations.clear();
}

auto ResourceStateTracker::PassName() const -> std::string
{
    return "render pass " + (m_passLabel.empty() ? std::string("on target ") + std::to_string(m_passTarget.id) : m_passLabel);
}

void ResourceStateTracker::ReportPassViolation(const std::string& message)
{
    m_passViolationCount++;
    if (m_reportedPassViolations.insert(message).second)
    {
        LOG_WARN("[RenderDevice] Pass violation: " + message);
        if (m_passViolationMessages.size() < MaxHazardMessages)
        {
            m_passViolationMessages.push_back(message);
        }
    }
}

auto ResourceStateTracker::SampledUnits() const -> const std::map<int, int>*
{
    if (!m_program.Valid())
    {
        return nullptr;
    }
    const auto program = m_samplerUnits.find(m_program.id);
    return program == m_samplerUnits.end() ? nullptr : &program->second;
}

auto ResourceStateTracker::AttachmentsOf(RenderTargetHandle target) const -> const Attachments*
{
    if (!target.Valid())
    {
        return nullptr;
    }
    const auto attachments = m_attachments.find(target.id);
    return attachments == m_attachments.end() ? nullptr : &attachments->second;
}

void ResourceStateTracker::ReportHazard(const std::string& message)
{
    m_hazardCount++;
    if (m_reported.insert(message).second)
    {
        LOG_WARN("[RenderDevice] Feedback hazard: " + message);
        if (m_hazardMessages.size() < MaxHazardMessages)
        {
            m_hazardMessages.push_back(message);
        }
    }
}

} // namespace Device
} // namespace Renderer
} // namespace libprojectM
