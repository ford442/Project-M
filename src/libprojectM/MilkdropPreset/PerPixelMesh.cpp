#include "PerPixelMesh.hpp"

#include "MilkdropShader.hpp"
#include "MilkdropStaticShaders.hpp"
#include "PerFrameContext.hpp"
#include "PerPixelContext.hpp"
#include "PerPixelGlslLowering.hpp"
#include "PresetState.hpp"

#include <Logging.hpp>
#include <OpenMpConfig.hpp>
#include <Renderer/BlendMode.hpp>
#include <Renderer/ShaderCache.hpp>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <functional>

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
    auto source = SelectWarpShaderSource(presetState.warpShaderVersion, presetState.warpShader);
    if (!source)
    {
        LoadWarpShader(std::nullopt);
        return;
    }
    PreparedMilkdropShader shader;
    shader.source = std::move(*source);
    LoadWarpShader(std::move(shader));
}

void PerPixelMesh::LoadWarpShader(std::optional<PreparedMilkdropShader> prepared)
{
    if (!prepared)
    {
        m_warpShader.reset();
        return;
    }
    m_warpShader = std::make_unique<MilkdropShader>(MilkdropShader::ShaderType::WarpShader);
    m_warpShader->LoadPrepared(std::move(*prepared));
}

auto PerPixelMesh::SelectWarpShaderSource(int warpShaderVersion, const std::string& warpShader) -> std::optional<MilkdropShaderSource>
{
    // Compile warp shader if preset specifies one.
    if (warpShaderVersion <= 0 || warpShader.empty())
    {
        return std::nullopt;
    }

    try
    {
        auto source = MilkdropShader::AnalyzeCode(MilkdropShader::ShaderType::WarpShader, warpShader);
        LOG_DEBUG("[PerPixelMesh] Successfully loaded preset warp shader code.");
        return source;
    }
    catch (Renderer::ShaderException& ex)
    {
        LOG_ERROR("[PerPixelMesh] Error loading warp shader code:" + ex.message());
        LOG_DEBUG("[PerPixelMesh] Warp shader code:\n" + warpShader);
        return std::nullopt;
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

auto PerPixelMesh::IsWarpShaderCompilePending() const -> bool
{
    return m_warpShader && m_warpShader->IsCompilePending();
}

auto PerPixelMesh::IsWarpShaderCompileComplete() const -> bool
{
    return !m_warpShader || m_warpShader->IsCompileComplete();
}

void PerPixelMesh::FinishWarpShader(PresetState& presetState)
{
    if (!IsWarpShaderCompilePending())
    {
        return;
    }

    try
    {
        m_warpShader->FinishCompile(presetState);
        LOG_DEBUG("[PerPixelMesh] Successfully compiled warp shader code.");
    }
    catch (Renderer::ShaderException&)
    {
        LOG_ERROR("[PerPixelMesh] Error compiling warp shader code.");
        m_warpShader.reset();
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
#pragma omp parallel for collapse(2) schedule(static) if(((m_gridSizeX + 1) * (m_gridSizeY + 1)) >= libprojectM::OpenMp::kMinPerPixelMeshVerts)
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
#pragma omp parallel for schedule(static) if(totalCells >= libprojectM::OpenMp::kMinPerPixelMeshVerts)
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

    if (UsesGpuPerPixel(presetState))
    {
        // The equations were compiled into the warp vertex shader, so the ten transform
        // channels are produced per vertex on the GPU. Nothing per-vertex is left to
        // compute or upload here; WarpedBlit() passes the per-frame seeds as uniforms.
        m_warpMesh.Update();
        m_radiusAngleBuffer.Update();
        return;
    }

    // When no per-pixel code is active, we can safely parallelize the mesh calculation
    if (!perPixelContext.perPixelCodeHandle)
    {
        const int vertexCount = (m_gridSizeX + 1) * (m_gridSizeY + 1);

#ifdef PRJM_ENABLE_OPENMP
#pragma omp parallel for schedule(static) if(vertexCount >= libprojectM::OpenMp::kMinPerPixelMeshVerts)
#endif
        for (int vertex = 0; vertex < vertexCount; vertex++)
        {
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
#pragma omp parallel for schedule(static) if(vertexCount >= libprojectM::OpenMp::kMinPerPixelMeshVerts)
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
        // The default warp path skips the pre-warp CopyTexture flip, so the
        // main texture is supplied un-flipped.  Signal the fragment shader to
        // fold the V-flip into the sample coordinate instead.
        perPixelMeshShader->SetUniformInt("u_flipMainTex", 1);
        SetPerPixelUniforms(*perPixelMeshShader, presetState, perFrameContext);
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
        SetPerPixelUniforms(shader, presetState, perFrameContext);
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

auto PerPixelMesh::HasCustomWarpShader() const -> bool
{
    return m_warpShader != nullptr;
}

auto PerPixelMesh::UsesGpuPerPixel(const PresetState& presetState) -> bool
{
    return !presetState.perPixelGpuGlsl.empty();
}

auto PerPixelMesh::WarpShaderCacheKey(const PresetState& presetState) -> std::string
{
    if (!UsesGpuPerPixel(presetState))
    {
        return "milkdrop_default_warp_shader";
    }

    // Every preset on the GPU path has its own vertex shader, so the program cache must
    // be keyed by the generated code and not by the name of the default warp shader.
    const auto hash = std::hash<std::string>{}(presetState.perPixelGpuGlsl);
    return "milkdrop_default_warp_shader_gpu_" + std::to_string(hash);
}

auto PerPixelMesh::GetDefaultWarpShader(const PresetState& presetState) -> std::shared_ptr<Renderer::Shader>
{
    const auto cacheKey = WarpShaderCacheKey(presetState);

    auto perPixelMeshShader = m_perPixelMeshShader.lock();
    if (perPixelMeshShader && cacheKey == m_perPixelMeshShaderKey)
    {
        return perPixelMeshShader;
    }

    perPixelMeshShader = presetState.renderContext.shaderCache->Get(cacheKey);
    if (perPixelMeshShader)
    {
        m_perPixelMeshShader = perPixelMeshShader;
        m_perPixelMeshShaderKey = cacheKey;
        return perPixelMeshShader;
    }

    auto staticShaders = libprojectM::MilkdropPreset::MilkdropStaticShaders::Get();

    perPixelMeshShader = std::make_shared<Renderer::Shader>();
    perPixelMeshShader->CompileProgram(
        PerPixelGlslLowering::ComposeWarpVertexShader(presetState.perPixelGpuGlsl),
        staticShaders->GetPresetWarpFragmentShader());

    presetState.renderContext.shaderCache->Insert(cacheKey, perPixelMeshShader);
    m_perPixelMeshShader = perPixelMeshShader;
    m_perPixelMeshShaderKey = cacheKey;

    return perPixelMeshShader;
}

void PerPixelMesh::SetPerPixelUniforms(const Renderer::Shader& shader,
                                       const PresetState& presetState,
                                       const PerFrameContext& perFrameContext)
{
    if (!UsesGpuPerPixel(presetState))
    {
        return;
    }

    shader.SetUniformFloat4("u_pp_seed_transforms",
                            {static_cast<float>(*perFrameContext.zoom),
                             static_cast<float>(*perFrameContext.zoomexp),
                             static_cast<float>(*perFrameContext.rot),
                             static_cast<float>(*perFrameContext.warp)});
    shader.SetUniformFloat2("u_pp_seed_center",
                            {static_cast<float>(*perFrameContext.cx),
                             static_cast<float>(*perFrameContext.cy)});
    shader.SetUniformFloat2("u_pp_seed_distance",
                            {static_cast<float>(*perFrameContext.dx),
                             static_cast<float>(*perFrameContext.dy)});
    shader.SetUniformFloat2("u_pp_seed_stretch",
                            {static_cast<float>(*perFrameContext.sx),
                             static_cast<float>(*perFrameContext.sy)});

    // Only the scalars the generated code actually reads were declared, so anything
    // not in the mask has no uniform to set. SetUniformFloat() tolerates a missing
    // location anyway; the mask just avoids the lookups.
    const auto uniforms = presetState.perPixelGpuUniforms;
    const struct
    {
        std::uint32_t flag;
        const char* name;
        float value;
    } scalars[] = {
        {PerPixelGlslLowering::UniformTime, "u_pp_time", static_cast<float>(*perFrameContext.time)},
        {PerPixelGlslLowering::UniformFps, "u_pp_fps", static_cast<float>(*perFrameContext.fps)},
        {PerPixelGlslLowering::UniformFrame, "u_pp_frame", static_cast<float>(*perFrameContext.frame)},
        {PerPixelGlslLowering::UniformProgress, "u_pp_progress", static_cast<float>(*perFrameContext.progress)},
        {PerPixelGlslLowering::UniformBass, "u_pp_bass", static_cast<float>(*perFrameContext.bass)},
        {PerPixelGlslLowering::UniformMid, "u_pp_mid", static_cast<float>(*perFrameContext.mid)},
        {PerPixelGlslLowering::UniformTreb, "u_pp_treb", static_cast<float>(*perFrameContext.treb)},
        {PerPixelGlslLowering::UniformBassAtt, "u_pp_bass_att", static_cast<float>(*perFrameContext.bass_att)},
        {PerPixelGlslLowering::UniformMidAtt, "u_pp_mid_att", static_cast<float>(*perFrameContext.mid_att)},
        {PerPixelGlslLowering::UniformTrebAtt, "u_pp_treb_att", static_cast<float>(*perFrameContext.treb_att)},
        {PerPixelGlslLowering::UniformMeshX, "u_pp_meshx", static_cast<float>(presetState.renderContext.perPixelMeshX)},
        {PerPixelGlslLowering::UniformMeshY, "u_pp_meshy", static_cast<float>(presetState.renderContext.perPixelMeshY)},
        {PerPixelGlslLowering::UniformPixelsX, "u_pp_pixelsx", static_cast<float>(presetState.renderContext.viewportSizeX)},
        {PerPixelGlslLowering::UniformPixelsY, "u_pp_pixelsy", static_cast<float>(presetState.renderContext.viewportSizeY)},
        {PerPixelGlslLowering::UniformAspectX, "u_pp_aspectx", presetState.renderContext.aspectX},
        {PerPixelGlslLowering::UniformAspectY, "u_pp_aspecty", presetState.renderContext.aspectY},
    };

    for (const auto& scalar : scalars)
    {
        if ((uniforms & scalar.flag) != 0u)
        {
            shader.SetUniformFloat(scalar.name, scalar.value);
        }
    }

    for (int vector = 0; vector < QVarCount / 4; vector++)
    {
        if ((presetState.perPixelGpuQVectors & (1u << static_cast<std::uint32_t>(vector))) == 0u)
        {
            continue;
        }
        const std::string name = "u_pp_q[" + std::to_string(vector) + "]";
        shader.SetUniformFloat4(name.c_str(),
                                {static_cast<float>(*perFrameContext.q_vars[vector * 4 + 0]),
                                 static_cast<float>(*perFrameContext.q_vars[vector * 4 + 1]),
                                 static_cast<float>(*perFrameContext.q_vars[vector * 4 + 2]),
                                 static_cast<float>(*perFrameContext.q_vars[vector * 4 + 3])});
    }
}

} // namespace MilkdropPreset
} // namespace libprojectM
