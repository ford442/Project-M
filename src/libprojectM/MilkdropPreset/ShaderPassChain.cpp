#include "ShaderPassChain.hpp"

#include "PresetState.hpp"

#include <Renderer/Device/RenderDevice.hpp>

namespace libprojectM {
namespace MilkdropPreset {

ShaderPassChain::ShaderPassChain(MilkdropShader::ShaderType type)
    : m_type(type)
{
}

void ShaderPassChain::Load(const std::vector<std::string>& passCode)
{
    m_passes.clear();
    for (const auto& code : passCode)
    {
        auto pass = std::make_unique<MilkdropShader>(m_type);
        pass->SetExtraPass();
        pass->SetPassIndex(static_cast<int>(m_passes.size()));
        pass->LoadCode(code);
        m_passes.push_back(std::move(pass));
    }
}

void ShaderPassChain::Clear()
{
    m_passes.clear();
    m_targets.reset();
}

auto ShaderPassChain::Count() const -> int
{
    return static_cast<int>(m_passes.size());
}

void ShaderPassChain::Compile(PresetState& presetState)
{
    for (auto& pass : m_passes)
    {
        pass->LoadTexturesAndCompile(presetState);
    }
}

auto ShaderPassChain::IsCompilePending() const -> bool
{
    for (const auto& pass : m_passes)
    {
        if (pass->IsCompilePending())
        {
            return true;
        }
    }
    return false;
}

auto ShaderPassChain::IsCompileComplete() const -> bool
{
    for (const auto& pass : m_passes)
    {
        if (!pass->IsCompileComplete())
        {
            return false;
        }
    }
    return true;
}

void ShaderPassChain::FinishCompile(PresetState& presetState)
{
    for (auto& pass : m_passes)
    {
        pass->FinishCompile(presetState);
    }
}

auto ShaderPassChain::Render(const PresetState& presetState, const PerFrameContext& perFrameContext,
                             const DrawFunction& draw) -> std::shared_ptr<Renderer::Texture>
{
    if (m_passes.empty())
    {
        return nullptr;
    }

    // The caller's pass (the warp or composite draw) resumes, with its contents, afterwards.
    auto& commands = Renderer::Device::Commands();
    const Renderer::Device::ScopedPassInterruption interruption(commands);

    const int width = presetState.renderContext.viewportSizeX;
    const int height = presetState.renderContext.viewportSizeY;
    if (!m_targets)
    {
        // The same color format as the preset's own framebuffers.
        m_targets = std::make_unique<Renderer::Framebuffer>(2);
        m_targets->CreateColorAttachment(0, 0);
        m_targets->CreateColorAttachment(1, 0);
    }
    m_targets->SetSize(width, height);

    // Pass N draws into target N % 2 and samples the other one, never the one it draws to.
    std::shared_ptr<Renderer::Texture> lastPass;
    for (size_t index = 0; index < m_passes.size(); index++)
    {
        const int target = static_cast<int>(index % 2);
        m_targets->BeginRenderPass(target, "extra shader pass", Renderer::Device::TargetBinding::Draw,
                                   Renderer::Device::Rect{0, 0, width, height});

        auto& pass = *m_passes.at(index);
        pass.SetLastPassTexture(lastPass);
        pass.LoadVariables(presetState, perFrameContext);
        draw(pass);
        Renderer::Framebuffer::EndRenderPass();

        lastPass = m_targets->GetColorAttachmentTexture(target, 0);
    }

    return lastPass;
}

} // namespace MilkdropPreset
} // namespace libprojectM
