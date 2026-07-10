#include "PerPixelMesh.hpp"

#include "MilkdropShader.hpp"
#include "MilkdropStaticShaders.hpp"
#include "PerFrameContext.hpp"
#include "PerPixelContext.hpp"
#include "PresetState.hpp"

#include <Logging.hpp>
#include <Renderer/BlendMode.hpp>
#include <Renderer/ShaderCache.hpp>

#include <algorithm>
#include <cmath>
#include <cstddef>

#ifdef PRJM_ENABLE_OPENMP
#include <omp.h>
#endif

namespace libprojectM {
namespace MilkdropPreset {

PerPixelMesh::PerPixelMesh()
    : m_warpMesh(Renderer::VertexBufferUsage::StreamDraw)
{
    m_warpMesh.SetRenderPrimitiveType(Renderer::Mesh::PrimitiveType::Triangles);

    m_warpMesh.Bind();
    m_radiusAngleBuffer.Bind();
    m_zoomRotWarpBuffer.Bind();
    m_centerBuffer.Bind();
    m_distanceBuffer.Bind();
    m_stretchBuffer.Bind();

    m_radiusAngleBuffer.InitializeAttributePointer(3);
    m_zoomRotWarpBuffer.InitializeAttributePointer(4);
    m_centerBuffer.InitializeAttributePointer(5);
    m_distanceBuffer.InitializeAttributePointer(6);
    m_stretchBuffer.InitializeAttributePointer(7);

    Renderer::VertexBuffer<Renderer::Point>::SetEnableAttributeArray(3, true);
    Renderer::VertexBuffer<Renderer::Point>::SetEnableAttributeArray(4, true);
    Renderer::VertexBuffer<Renderer::Point>::SetEnableAttributeArray(5, true);
    Renderer::VertexBuffer<Renderer::Point>::SetEnableAttributeArray(6, true);
    Renderer::VertexBuffer<Renderer::Point>::SetEnableAttributeArray(7, true);

    Renderer::Mesh::Unbind();
}

void PerPixelMesh::LoadWarpShader(const PresetState& presetState)
{
    // Compile warp shader if preset specifies one.
    if (presetState.warpShaderVersion > 0)
    {
        if (!presetState.warpShader.empty())
        {
            try
            {
                m_warpShader = std::make_unique<MilkdropShader>(MilkdropShader::ShaderType::WarpShader);
                m_warpShader->LoadCode(presetState.warpShader);
                LOG_DEBUG("[PerPixelMesh] Successfully loaded preset warp shader code.");
            }
            catch (Renderer::ShaderException& ex)
            {
                LOG_ERROR("[PerPixelMesh] Error loading warp shader code:" + ex.message());
                LOG_DEBUG("[PerPixelMesh] Warp shader code:\n" + presetState.warpShader);
                m_warpShader.reset();
            }
        }
    }
}

void PerPixelMesh::CompileWarpShader(PresetState& presetState)
{
    if (m_warpShader)
    {
        try
        {
            m_warpShader->LoadTexturesAndCompile(presetState);
            LOG_DEBUG("[PerPixelMesh] Successfully compiled warp shader code.");
        }
        catch (Renderer::ShaderException&)
        {
            LOG_ERROR("[PerPixelMesh] Error compiling warp shader code.");
            m_warpShader.reset();
        }
    }
}

void PerPixelMesh::Draw(const PresetState& presetState,
                        const PerFrameContext& perFrameContext,
                        PerPixelContext& perPixelContext,
                        const std::vector<std::unique_ptr<PerPixelContext>>& perPixelContextPool)
{
    if (presetState.renderContext.viewportSizeX == 0 ||
        presetState.renderContext.viewportSizeY == 0 ||
        presetState.renderContext.perPixelMeshX == 0 ||
        presetState.renderContext.perPixelMeshY == 0)
    {
        return;
    }

    // Initialize or recreate the mesh (if grid size changed)
    InitializeMesh(presetState);

    // Calculate the dynamic movement values
    CalculateMesh(presetState, perFrameContext, perPixelContext, perPixelContextPool);

    // Render the resulting mesh.
    WarpedBlit(presetState, perFrameContext);
}

void PerPixelMesh::InitializeMesh(const PresetState& presetState)
{
    if (m_gridSizeX != presetState.renderContext.perPixelMeshX ||
        m_gridSizeY != presetState.renderContext.perPixelMeshY)
    {
        m_gridSizeX = presetState.renderContext.perPixelMeshX;
        m_gridSizeY = presetState.renderContext.perPixelMeshY;

        // Grid size has changed, resize buffers accordingly
        const size_t vertexCount = (m_gridSizeX + 1) * (m_gridSizeY + 1);

        m_warpMesh.SetVertexCount(vertexCount);
        m_radiusAngleBuffer.Resize(vertexCount);
        m_zoomRotWarpBuffer.Resize(vertexCount);
        m_centerBuffer.Resize(vertexCount);
        m_distanceBuffer.Resize(vertexCount);
        m_stretchBuffer.Resize(vertexCount);

        m_warpMesh.Indices().Resize(m_gridSizeX * m_gridSizeY * 6);
    }
    else if (m_viewportWidth == presetState.renderContext.viewportSizeX &&
             m_viewportHeight == presetState.renderContext.viewportSizeY)
    {
        // Nothing changed, just go on to the dynamic calculation.
        return;
    }

    const float aspectX = presetState.renderContext.aspectX;
    const float aspectY = presetState.renderContext.aspectY;

    // Either viewport size or mesh size changed, reinitialize the vertices.
    auto& vertices = m_warpMesh.Vertices();
#ifdef PRJM_ENABLE_OPENMP
#pragma omp parallel for collapse(2) schedule(static)
#endif
    for (int gridY = 0; gridY <= m_gridSizeY; gridY++)
    {
        for (int gridX = 0; gridX <= m_gridSizeX; gridX++)
        {
            const int vertexIndex = gridY * (m_gridSizeX + 1) + gridX;
            const float x = static_cast<float>(gridX) / static_cast<float>(m_gridSizeX) * 2.0f - 1.0f;
            const float y = static_cast<float>(gridY) / static_cast<float>(m_gridSizeY) * 2.0f - 1.0f;
            vertices[vertexIndex] = {x, y};

            // Milkdrop uses sqrtf, but hypotf is probably safer.
            m_radiusAngleBuffer[vertexIndex].radius = hypotf(x * aspectX, y * aspectY);
            if (gridY == m_gridSizeY / 2 && gridX == m_gridSizeX / 2)
            {
                m_radiusAngleBuffer[vertexIndex].angle = 0.0f;
            }
            else
            {
                m_radiusAngleBuffer[vertexIndex].angle = atan2f(y * aspectY, x * aspectX);
            }
        }
    }

    // Generate triangle lists for drawing the main warp mesh.
    // Flatten (quadrant, slice, gridX) -> cellIndex so each thread writes a
    // disjoint 6-index slice of m_warpMesh.Indices().
    const int halfGridX = m_gridSizeX / 2;
    const int halfGridY = m_gridSizeY / 2;
    const int cellsPerQuadrant = halfGridX * halfGridY;
    const int totalCells = 4 * cellsPerQuadrant;

#ifdef PRJM_ENABLE_OPENMP
#pragma omp parallel for schedule(static)
#endif
    for (int cellIndex = 0; cellIndex < totalCells; cellIndex++)
    {
        const int quadrant = cellIndex / cellsPerQuadrant;
        const int local = cellIndex % cellsPerQuadrant;
        const int slice = local / halfGridX;
        const int gridX = local % halfGridX;
        const int vertexListIndex = cellIndex * 6;

        int xReference = gridX;
        int yReference = slice;

        if ((quadrant & 1) != 0)
        {
            xReference = m_gridSizeX - 1 - xReference;
        }
        if ((quadrant & 2) != 0)
        {
            yReference = m_gridSizeY - 1 - yReference;
        }

        int const vertex = xReference + yReference * (m_gridSizeX + 1);

        // 0 - 1      3
        //   /      /
        // 2      4 - 5
        auto& indices = m_warpMesh.Indices();
        indices[vertexListIndex + 0] = vertex;
        indices[vertexListIndex + 1] = vertex + 1;
        indices[vertexListIndex + 2] = vertex + m_gridSizeX + 1;
        indices[vertexListIndex + 3] = vertex + 1;
        indices[vertexListIndex + 4] = vertex + m_gridSizeX + 1;
        indices[vertexListIndex + 5] = vertex + m_gridSizeX + 2;
    }
}

void PerPixelMesh::CalculateMesh(const PresetState& presetState, const PerFrameContext& perFrameContext,
                                 PerPixelContext& perPixelContext,
                                 const std::vector<std::unique_ptr<PerPixelContext>>& perPixelContextPool)
{
    // Cache some per-frame values as floats
    float zoom = static_cast<float>(*perFrameContext.zoom);
    float zoomExp = static_cast<float>(*perFrameContext.zoomexp);
    float rot = static_cast<float>(*perFrameContext.rot);
    float warp = static_cast<float>(*perFrameContext.warp);
    float cx = static_cast<float>(*perFrameContext.cx);
    float cy = static_cast<float>(*perFrameContext.cy);
    float dx = static_cast<float>(*perFrameContext.dx);
    float dy = static_cast<float>(*perFrameContext.dy);
    float sx = static_cast<float>(*perFrameContext.sx);
    float sy = static_cast<float>(*perFrameContext.sy);

    // Can't make this multithreaded as per-pixel code may use gmegabuf or regXX vars.
    auto& vertices = m_warpMesh.Vertices();

    // When no per-pixel code is active, we can safely parallelize the mesh calculation
    if (!perPixelContext.perPixelCodeHandle)
    {
        const int vertexCount = (m_gridSizeX + 1) * (m_gridSizeY + 1);

#ifdef PRJM_ENABLE_OPENMP
#pragma omp parallel for schedule(static)
#endif
        for (int vertex = 0; vertex < vertexCount; vertex++)
        {
            int y = vertex / (m_gridSizeX + 1);
            int x = vertex % (m_gridSizeX + 1);

            auto& curVertex = vertices[vertex];
            auto& curRadiusAngle = m_radiusAngleBuffer[vertex];
            auto& curZoomRotWarp = m_zoomRotWarpBuffer[vertex];
            auto& curCenter = m_centerBuffer[vertex];
            auto& curDistance = m_distanceBuffer[vertex];
            auto& curStretch = m_stretchBuffer[vertex];

            curZoomRotWarp.zoom = zoom;
            curZoomRotWarp.zoomExp = zoomExp;
            curZoomRotWarp.rot = rot;
            curZoomRotWarp.warp = warp;
            curCenter = {cx, cy};
            curDistance = {dx, dy};
            curStretch = {sx, sy};
        }
    }
    else
    {
        // Per-pixel code is active. Each vertex only reads its own static grid
        // data (vertices[]/m_radiusAngleBuffer[]) and per-frame values, and
        // writes to its own output slot, so the loop can run in parallel as
        // long as each thread uses its own eval context (q1..q32, x, y, rad,
        // ang, zoom, etc. are registered per-context). gmegabuf/reg vars are
        // shared across contexts and protected by EvalLibMutex.
        const int vertexCount = (m_gridSizeX + 1) * (m_gridSizeY + 1);

#ifdef PRJM_ENABLE_OPENMP
#pragma omp parallel for schedule(static)
#endif
        for (int vertex = 0; vertex < vertexCount; vertex++)
        {
#ifdef PRJM_ENABLE_OPENMP
            const int threadIndex = omp_get_thread_num();
#else
            const int threadIndex = 0;
#endif
            PerPixelContext* threadContext = &perPixelContext;
            if (threadIndex > 0 && static_cast<std::size_t>(threadIndex - 1) < perPixelContextPool.size())
            {
                threadContext = perPixelContextPool[threadIndex - 1].get();
            }
            PerPixelContext& ctx = *threadContext;

            auto& curVertex = vertices[vertex];
            auto& curRadiusAngle = m_radiusAngleBuffer[vertex];
            auto& curZoomRotWarp = m_zoomRotWarpBuffer[vertex];
            auto& curCenter = m_centerBuffer[vertex];
            auto& curDistance = m_distanceBuffer[vertex];
            auto& curStretch = m_stretchBuffer[vertex];

            // Execute per-vertex/per-pixel code if the preset uses it.
            *ctx.x = static_cast<double>(curVertex.X() * 0.5f * presetState.renderContext.aspectX + 0.5f);
            *ctx.y = static_cast<double>(curVertex.Y() * 0.5f * presetState.renderContext.aspectY + 0.5f);
            *ctx.rad = static_cast<double>(curRadiusAngle.radius);
            *ctx.ang = static_cast<double>(-curRadiusAngle.angle);
            *ctx.zoom = static_cast<double>(*perFrameContext.zoom);
            *ctx.zoomexp = static_cast<double>(*perFrameContext.zoomexp);
            *ctx.rot = static_cast<double>(*perFrameContext.rot);
            *ctx.warp = static_cast<double>(*perFrameContext.warp);
            *ctx.cx = static_cast<double>(*perFrameContext.cx);
            *ctx.cy = static_cast<double>(*perFrameContext.cy);
            *ctx.dx = static_cast<double>(*perFrameContext.dx);
            *ctx.dy = static_cast<double>(*perFrameContext.dy);
            *ctx.sx = static_cast<double>(*perFrameContext.sx);
            *ctx.sy = static_cast<double>(*perFrameContext.sy);

            ctx.ExecutePerPixelCode();

            curZoomRotWarp.zoom = static_cast<float>(*ctx.zoom);
            curZoomRotWarp.zoomExp = static_cast<float>(*ctx.zoomexp);
            curZoomRotWarp.rot = static_cast<float>(*ctx.rot);
            curZoomRotWarp.warp = static_cast<float>(*ctx.warp);
            curCenter = {static_cast<float>(*ctx.cx),
                         static_cast<float>(*ctx.cy)};
            curDistance = {static_cast<float>(*ctx.dx),
                           static_cast<float>(*ctx.dy)};
            curStretch = {static_cast<float>(*ctx.sx),
                          static_cast<float>(*ctx.sy)};
        }
    }

    m_warpMesh.Update();
    m_radiusAngleBuffer.Update();
    m_zoomRotWarpBuffer.Update();
    m_centerBuffer.Update();
    m_distanceBuffer.Update();
    m_stretchBuffer.Update();
}

void PerPixelMesh::WarpedBlit(const PresetState& presetState,
                              const PerFrameContext& perFrameContext)
{
    // Warp stuff
    float const warpTime = presetState.renderContext.time * presetState.warpAnimSpeed;
    float const warpScaleInverse = 1.0f / presetState.warpScale;
    glm::vec4 const warpFactors{
        11.68f + 4.0f * cosf(warpTime * 1.413f + 10),
        8.77f + 3.0f * cosf(warpTime * 1.113f + 7),
        10.54f + 3.0f * cosf(warpTime * 1.233f + 3),
        11.49f + 4.0f * cosf(warpTime * 0.933f + 5),
    };

    // Texel alignment
    glm::vec2 const texelOffsets{presetState.renderContext.texelOffsetX / static_cast<float>(presetState.renderContext.viewportSizeX),
                                 presetState.renderContext.texelOffsetY / static_cast<float>(presetState.renderContext.viewportSizeY)};

    // Decay
    float decay = std::min(static_cast<float>(*perFrameContext.decay), 1.0f);

    // No blending between presets here, so we make sure blending is disabled.
    Renderer::BlendMode::SetBlendActive(false);

    if (!m_warpShader)
    {
        auto perPixelMeshShader = GetDefaultWarpShader(presetState);
        perPixelMeshShader->Bind();
        perPixelMeshShader->SetUniformMat4x4("vertex_transformation", PresetState::orthogonalProjection);
        perPixelMeshShader->SetUniformInt("texture_sampler", 0);
        perPixelMeshShader->SetUniformFloat4("aspect", {presetState.renderContext.aspectX,
                                                        presetState.renderContext.aspectY,
                                                        presetState.renderContext.invAspectX,
                                                        presetState.renderContext.invAspectY});
        perPixelMeshShader->SetUniformFloat("warpTime", warpTime);
        perPixelMeshShader->SetUniformFloat("warpScaleInverse", warpScaleInverse);
        perPixelMeshShader->SetUniformFloat4("warpFactors", warpFactors);
        perPixelMeshShader->SetUniformFloat2("texelOffset", texelOffsets);
        perPixelMeshShader->SetUniformFloat("decay", decay);
    }
    else
    {
        m_warpShader->LoadVariables(presetState, perFrameContext);
        auto& shader = m_warpShader->Shader();
        shader.SetUniformFloat4("aspect", {presetState.renderContext.aspectX,
                                           presetState.renderContext.aspectY,
                                           presetState.renderContext.invAspectX,
                                           presetState.renderContext.invAspectY});
        shader.SetUniformFloat("warpTime", warpTime);
        shader.SetUniformFloat("warpScaleInverse", warpScaleInverse);
        shader.SetUniformFloat4("warpFactors", warpFactors);
        shader.SetUniformFloat2("texelOffset", texelOffsets);
        shader.SetUniformFloat("decay", decay);
    }

    assert(!presetState.mainTexture.expired());
    presetState.mainTexture.lock()->Bind(0);

    // Set wrap mode and bind the sampler to get interpolation right.
    if (*perFrameContext.wrap > 0.0001f)
    {
        m_perPixelSampler.WrapMode(GL_REPEAT);
    }
    else
    {
        m_perPixelSampler.WrapMode(GL_CLAMP_TO_EDGE);
    }
    m_perPixelSampler.Bind(0);

    m_warpMesh.Draw();

    Renderer::Mesh::Unbind();
    Renderer::Sampler::Unbind(0);
    Renderer::Shader::Unbind();
}

auto PerPixelMesh::GetDefaultWarpShader(const PresetState& presetState) -> std::shared_ptr<Renderer::Shader>
{
    auto perPixelMeshShader = m_perPixelMeshShader.lock();
    if (perPixelMeshShader)
    {
        return perPixelMeshShader;
    }

    perPixelMeshShader = presetState.renderContext.shaderCache->Get("milkdrop_default_warp_shader");
    if (perPixelMeshShader)
    {
        return perPixelMeshShader;
    }

    auto staticShaders = libprojectM::MilkdropPreset::MilkdropStaticShaders::Get();

    perPixelMeshShader = std::make_shared<Renderer::Shader>();
    perPixelMeshShader->CompileProgram(staticShaders->GetPresetWarpVertexShader(),
                                       staticShaders->GetPresetWarpFragmentShader());

    presetState.renderContext.shaderCache->Insert("milkdrop_default_warp_shader", perPixelMeshShader);
    m_perPixelMeshShader = perPixelMeshShader;

    return perPixelMeshShader;
}

} // namespace MilkdropPreset
} // namespace libprojectM
