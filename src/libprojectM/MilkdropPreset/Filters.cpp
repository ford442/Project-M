#include "Filters.hpp"

#include <Renderer/Device/RenderDevice.hpp>
#include <Renderer/Shader.hpp>

using libprojectM::Renderer::Device::BlendFactor;

namespace libprojectM {
namespace MilkdropPreset {

Filters::Filters(const PresetState& presetState)
    : m_presetState(presetState)
    , m_filterMesh(Renderer::VertexBufferUsage::StaticDraw)
{
    m_filterMesh.SetRenderPrimitiveType(Renderer::Mesh::PrimitiveType::TriangleStrip);
    m_filterMesh.SetVertexCount(4);
}

void Filters::Draw()
{
    UpdateMesh();

    if (m_viewportWidth == 0 || m_viewportHeight == 0)
    {
        return;
    }

    auto shader = m_presetState.untexturedShader.lock();
    m_shader = shader.get();

    // The program has to be current for the uniforms; each draw below sets its own pipeline.
    shader->Bind();
    shader->SetUniformMat4x4("vertex_transformation", PresetState::orthogonalProjection);
    shader->SetUniformFloat("vertex_point_size", 1.0f);

    Renderer::Device::Commands().SetConstantVertexAttribute(1, {1.0, 1.0, 1.0, 1.0});

    if (m_presetState.brighten)
    {
        Brighten();
    }
    if (m_presetState.darken)
    {
        Darken();
    }
    if (m_presetState.solarize)
    {
        Solarize();
    }
    if (m_presetState.invert)
    {
        Invert();
    }

    Renderer::Mesh::Unbind();
    m_shader = nullptr;
}

void Filters::DrawBlended(BlendFactor source, BlendFactor destination)
{
    Renderer::Device::SetPipeline(m_filterMesh.Pipeline(*m_shader, Renderer::Device::BlendState::Factors(source, destination)));
    m_filterMesh.Draw();
}

void Filters::Brighten()
{
    DrawBlended(BlendFactor::OneMinusDestinationColor, BlendFactor::Zero);
    DrawBlended(BlendFactor::Zero, BlendFactor::DestinationColor);
    DrawBlended(BlendFactor::OneMinusDestinationColor, BlendFactor::Zero);
}

void Filters::Darken()
{
    DrawBlended(BlendFactor::Zero, BlendFactor::DestinationColor);
}

void Filters::Solarize()
{
    DrawBlended(BlendFactor::Zero, BlendFactor::OneMinusDestinationColor);
    DrawBlended(BlendFactor::DestinationColor, BlendFactor::One);
}

void Filters::Invert()
{
    DrawBlended(BlendFactor::OneMinusDestinationColor, BlendFactor::Zero);
}

void Filters::UpdateMesh()
{
    if (m_viewportWidth == m_presetState.renderContext.viewportSizeX &&
        m_viewportHeight == m_presetState.renderContext.viewportSizeY)
    {
        return;
    }

    m_viewportWidth = m_presetState.renderContext.viewportSizeX;
    m_viewportHeight = m_presetState.renderContext.viewportSizeY;

    float const fOnePlusInvWidth = 1.0f + 1.0f / static_cast<float>(m_viewportWidth);
    float const fOnePlusInvHeight = 1.0f + 1.0f / static_cast<float>(m_viewportHeight);
    m_filterMesh.Vertices().Set({{-fOnePlusInvWidth, fOnePlusInvHeight},
                                 {fOnePlusInvWidth, fOnePlusInvHeight},
                                 {-fOnePlusInvWidth, -fOnePlusInvHeight},
                                 {fOnePlusInvWidth, -fOnePlusInvHeight}});

    m_filterMesh.Update();
}

} // namespace MilkdropPreset
} // namespace libprojectM
