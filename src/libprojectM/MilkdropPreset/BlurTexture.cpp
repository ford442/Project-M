#include "BlurTexture.hpp"

#include "PerFrameContext.hpp"
#include "PresetState.hpp"

#include "MilkdropStaticShaders.hpp"

#include <Renderer/BlendMode.hpp>
#include <Renderer/Point.hpp>
#include <Renderer/ShaderCache.hpp>

#include <array>
#include <cstdlib>

// Not defined by every GLES2-era header, but valid on every target we render blur on.
#ifndef GL_RGB8
#define GL_RGB8 0x8051
#endif

namespace libprojectM {
namespace MilkdropPreset {

BlurTexture::BlurTexture()
    : m_blurMesh(Renderer::VertexBufferUsage::StaticDraw, false, true)
    , m_blurSampler(std::make_shared<Renderer::Sampler>(GL_CLAMP_TO_EDGE, GL_LINEAR))
{
    // Scratch color attachment for the legacy copy path. Zero-sized here, so it costs no
    // VRAM unless EnsureRenderTarget() actually falls back to it.
#ifdef PROJECTM_HDR_RENDERING
    m_blurFramebuffer.CreateColorAttachment(0, 0, GL_RGBA16F, GL_RGBA, GL_HALF_FLOAT);
#else
    m_blurFramebuffer.CreateColorAttachment(0, 0);
#endif

    // Initialize blur mesh with a single fullscreen quad.
    m_blurMesh.SetRenderPrimitiveType(Renderer::Mesh::PrimitiveType::TriangleStrip);

    m_blurMesh.Vertices().Set({{-1.0f, -1.0f},
                               {1.0f, -1.0f},
                               {-1.0f, 1.0f},
                               {1.0f, 1.0f}});

    m_blurMesh.UVs().Set({{0.0, 0.0},
                          {1.0, 0.0},
                          {0.0, 1.0},
                          {1.0, 1.0}});

    m_blurMesh.Update();

    // Initialize with empty textures.
    for (size_t i = 0; i < m_blurTextures.size(); i++)
    {
        std::string textureName;
        if (i % 2 == 1)
        {
            textureName = "blur" + std::to_string(i / 2 + 1);
        }

        m_blurTextures[i] = std::make_shared<Renderer::Texture>(textureName, 0, GL_TEXTURE_2D, 0, 0, false);
    }
}

BlurTexture::~BlurTexture()
{
    if (m_directFramebufferId != 0)
    {
        glDeleteFramebuffers(1, &m_directFramebufferId);
        m_directFramebufferId = 0;
    }
}

void BlurTexture::Initialize(const Renderer::RenderContext& renderContext)
{
    auto staticShaders = libprojectM::MilkdropPreset::MilkdropStaticShaders::Get();

    // Load/compile shader sources
    auto blur1Shader = renderContext.shaderCache->Get("milkdrop_blur1");
    if (!blur1Shader)
    {
        blur1Shader = std::make_shared<Renderer::Shader>();
        blur1Shader->CompileProgram(staticShaders->GetBlurVertexShader(),
                                    staticShaders->GetBlur1FragmentShader());
        renderContext.shaderCache->Insert("milkdrop_blur1", blur1Shader);
    }

    auto blur2Shader = renderContext.shaderCache->Get("milkdrop_blur2");
    if (!blur2Shader)
    {
        blur2Shader = std::make_shared<Renderer::Shader>();
        blur2Shader->CompileProgram(staticShaders->GetBlurVertexShader(),
                                    staticShaders->GetBlur2FragmentShader());
        renderContext.shaderCache->Insert("milkdrop_blur2", blur2Shader);
    }

    m_blur1Shader = blur1Shader;
    m_blur2Shader = blur2Shader;
}

void BlurTexture::SetRequiredBlurLevel(BlurTexture::BlurLevel level)
{
    m_blurLevel = std::max(level, m_blurLevel);
}

void BlurTexture::SetLevelCap(int cap)
{
    m_levelCap = cap;
}

auto BlurTexture::EffectiveLevel(BlurTexture::BlurLevel requested) const -> BlurTexture::BlurLevel
{
    if (m_levelCap < 0)
    {
        return requested;
    }
    return std::min(requested, static_cast<BlurLevel>(m_levelCap));
}

auto BlurTexture::GetDescriptorsForBlurLevel(BlurTexture::BlurLevel blurLevel) const -> std::vector<Renderer::TextureSamplerDescriptor>
{
    std::vector<Renderer::TextureSamplerDescriptor> descriptors;
    blurLevel = EffectiveLevel(blurLevel);

    if (blurLevel == BlurLevel::Blur3)
    {
        descriptors.emplace_back(m_blurTextures[1], m_blurSampler, m_blurTextures[1]->Name(), std::string());
        descriptors.emplace_back(m_blurTextures[3], m_blurSampler, m_blurTextures[3]->Name(), std::string());
        descriptors.emplace_back(m_blurTextures[5], m_blurSampler, m_blurTextures[5]->Name(), std::string());
    }
    if (blurLevel == BlurLevel::Blur2)
    {
        descriptors.emplace_back(m_blurTextures[1], m_blurSampler, m_blurTextures[1]->Name(), std::string());
        descriptors.emplace_back(m_blurTextures[3], m_blurSampler, m_blurTextures[3]->Name(), std::string());
    }
    if (blurLevel == BlurLevel::Blur1)
    {
        descriptors.emplace_back(m_blurTextures[1], m_blurSampler, m_blurTextures[1]->Name(), std::string());
    }

    return descriptors;
}

void BlurTexture::Update(const Renderer::Texture& sourceTexture, const PerFrameContext& perFrameContext)
{
    if (m_blurLevel == BlurLevel::None)
    {
        return;
    }

    if (sourceTexture.Width() == 0 ||
        sourceTexture.Height() == 0)
    {
        return;
    }

    AllocateTextures(sourceTexture);

    if (!EnsureRenderTarget())
    {
        return;
    }

    unsigned int const passes = static_cast<int>(EffectiveLevel(m_blurLevel)) * 2;
    auto const blur1EdgeDarken = static_cast<float>(*perFrameContext.blur1_edge_darken);

    const std::array<float, 8> weights = {4.0f, 3.8f, 3.5f, 2.9f, 1.9f, 1.2f, 0.7f, 0.3f}; //<- user can specify these

    Values blurMin;
    Values blurMax;
    GetSafeBlurMinMaxValues(perFrameContext, blurMin, blurMax);

    std::array<float, 3> scale{};
    std::array<float, 3> bias{};

    // figure out the progressive scale & bias needed, at each step,
    // to go from one [min..max] range to the next.
    scale[0] = 1.0f / (blurMax[0] - blurMin[0]);
    bias[0] = -blurMin[0] * scale[0];
    float tempMin = (blurMin[1] - blurMin[0]) / (blurMax[0] - blurMin[0]);
    float tempMax = (blurMax[1] - blurMin[0]) / (blurMax[0] - blurMin[0]);
    scale[1] = 1.0f / (tempMax - tempMin);
    bias[1] = -tempMin * scale[1];
    tempMin = (blurMin[2] - blurMin[1]) / (blurMax[1] - blurMin[1]);
    tempMax = (blurMax[2] - blurMin[1]) / (blurMax[1] - blurMin[1]);
    scale[2] = 1.0f / (tempMax - tempMin);
    bias[2] = -tempMin * scale[2];

    // Remember previously bound framebuffer
    GLint origReadFramebuffer;
    GLint origDrawFramebuffer;
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &origReadFramebuffer);
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &origDrawFramebuffer);

    if (m_renderPath == RenderPath::Copy)
    {
        m_blurFramebuffer.Bind(0);
    }

    Renderer::BlendMode::Set(true, Renderer::BlendMode::Function::One, Renderer::BlendMode::Function::Zero);

    for (unsigned int pass = 0; pass < passes; pass++)
    {
        if (m_blurTextures[pass]->TextureID() == 0)
        {
            continue;
        }

        // set pixel shader
        std::shared_ptr<Renderer::Shader> blurShader;
        if ((pass % 2) == 0)
        {
            blurShader = m_blur1Shader.lock();
        }
        else
        {
            blurShader = m_blur2Shader.lock();
        }
        if (!blurShader)
        {
            return;
        }

        blurShader->Bind();
        blurShader->SetUniformInt("texture_sampler", 0);

        // Point the framebuffer at this pass' destination texture (direct path) or at the
        // shared scratch attachment (copy fallback), and size the viewport to match.
        BindPassTarget(pass);

        // hook up correct source texture - assume there is only one, at stage 0
        if (pass == 0)
        {
            sourceTexture.Bind(0);
            blurShader->SetUniformInt("flipVertical", 1);
        }
        else
        {
            m_blurTextures[pass - 1]->Bind(0);
            blurShader->SetUniformInt("flipVertical", 0);
        }
        m_blurSampler->Bind(0);

        float srcWidth = static_cast<float>((pass == 0) ? sourceTexture.Width() : m_blurTextures[pass - 1]->Width());
        float srcHeight = static_cast<float>((pass == 0) ? sourceTexture.Height() : m_blurTextures[pass - 1]->Height());

        float scaleNow = scale[pass / 2];
        float biasNow = bias[pass / 2];

        // set constants
        if (pass % 2 == 0)
        {
            // pass 1 (long horizontal pass)
            //-------------------------------------
            const float w1 = weights[0] + weights[1];
            const float w2 = weights[2] + weights[3];
            const float w3 = weights[4] + weights[5];
            const float w4 = weights[6] + weights[7];
            const float d1 = 0 + 2 * weights[1] / w1;
            const float d2 = 2 + 2 * weights[3] / w2;
            const float d3 = 4 + 2 * weights[5] / w3;
            const float d4 = 6 + 2 * weights[7] / w4;
            const float w_div = 0.5f / (w1 + w2 + w3 + w4);
            //-------------------------------------
            //float4 _c0; // source texsize (.xy), and inverse (.zw)
            //float4 _c1; // w1..w4
            //float4 _c2; // d1..d4
            //float4 _c3; // scale, bias, w_div, 0
            //-------------------------------------
            blurShader->SetUniformFloat4("_c0", {srcWidth, srcHeight, 1.0f / srcWidth, 1.0f / srcHeight});
            blurShader->SetUniformFloat4("_c1", {w1, w2, w3, w4});
            blurShader->SetUniformFloat4("_c2", {d1, d2, d3, d4});
            blurShader->SetUniformFloat4("_c3", {scaleNow, biasNow, w_div, 0.0});
        }
        else
        {
            // pass 2 (short vertical pass)
            //-------------------------------------
            const float w1 = weights[0] + weights[1] + weights[2] + weights[3];
            const float w2 = weights[4] + weights[5] + weights[6] + weights[7];
            const float d1 = 0 + 2 * ((weights[2] + weights[3]) / w1);
            const float d2 = 2 + 2 * ((weights[6] + weights[7]) / w2);
            const float w_div = 1.0f / ((w1 + w2) * 2);
            //-------------------------------------
            //float4 _c0; // source texsize (.xy), and inverse (.zw)
            //float4 _c5; // w1,w2,d1,d2
            //float4 _c6; // w_div, edge_darken_c1, edge_darken_c2, edge_darken_c3
            //-------------------------------------
            blurShader->SetUniformFloat4("_c0", {srcWidth, srcHeight, 1.0f / srcWidth, 1.0f / srcHeight});
            blurShader->SetUniformFloat4("_c5", {w1, w2, d1, d2});
            // note: only do this first time; if you do it many times,
            // then the super-blurred levels will have big black lines along the top & left sides.
            if (pass == 1)
            {
                // Darken edges
                blurShader->SetUniformFloat4("_c6", {w_div, (1 - blur1EdgeDarken), blur1EdgeDarken, 5.0f});
            }
            else
            {
                // Don't darken
                blurShader->SetUniformFloat4("_c6", {w_div, 1.0f, 0.0f, 5.0f});
            }
        }

        // Draw fullscreen quad
        m_blurMesh.Draw();

        if (m_renderPath == RenderPath::Copy)
        {
            // Legacy fallback: the pass rendered into the scratch attachment, so the result
            // still has to be copied into the blur texture.
            m_blurTextures[pass]->Bind(0);
            glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 0, 0, m_blurTextures[pass]->Width(), m_blurTextures[pass]->Height());
            m_blurTextures[pass]->Unbind(0);
        }
    }

    Renderer::Mesh::Unbind();
    Renderer::BlendMode::Set(false, Renderer::BlendMode::Function::SourceAlpha, Renderer::BlendMode::Function::OneMinusSourceAlpha);

    // Bind previous framebuffer and reset viewport size
    glBindFramebuffer(GL_READ_FRAMEBUFFER, origReadFramebuffer);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, origDrawFramebuffer);
    glViewport(0, 0, sourceTexture.Width(), sourceTexture.Height());

    Renderer::Shader::Unbind();
}

namespace {

/**
 * @brief Returns true if the legacy copy path was requested via the environment.
 *
 * Ablation switch for benchmarking: setting PROJECTM_BLUR_COPY_PATH=1 restores the
 * render-to-scratch + glCopyTexSubImage2D behaviour, so the direct path can be A/B'd
 * against it on a single build. See docs/GRAPHICS_PERF_RECOVERY_PLAN.md.
 */
auto CopyPathForcedByEnvironment() -> bool
{
    const char* const value = std::getenv("PROJECTM_BLUR_COPY_PATH");
    return value != nullptr && value[0] == '1' && value[1] == '\0';
}

} // namespace

auto BlurTexture::EnsureRenderTarget() -> bool
{
    if (!m_blurTextures[0] || m_blurTextures[0]->TextureID() == 0)
    {
        return false;
    }

    GLint origReadFramebuffer{};
    GLint origDrawFramebuffer{};

    if (m_renderPath == RenderPath::Undecided && CopyPathForcedByEnvironment())
    {
        m_renderPath = RenderPath::Copy;
    }

    if (m_renderPath == RenderPath::Undecided)
    {
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &origReadFramebuffer);
        glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &origDrawFramebuffer);

        glGenFramebuffers(1, &m_directFramebufferId);
        glBindFramebuffer(GL_FRAMEBUFFER, m_directFramebufferId);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                               m_blurTextures[0]->TextureID(), 0);

        // Probe once: if the blur texture format isn't color-renderable on this driver,
        // keep the old render-to-scratch-then-copy behaviour instead of losing the blur.
        const bool complete = glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;

        glBindFramebuffer(GL_READ_FRAMEBUFFER, origReadFramebuffer);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, origDrawFramebuffer);

        if (complete)
        {
            m_renderPath = RenderPath::Direct;
        }
        else
        {
            m_renderPath = RenderPath::Copy;
            glDeleteFramebuffers(1, &m_directFramebufferId);
            m_directFramebufferId = 0;
        }
    }

    if (m_renderPath == RenderPath::Copy)
    {
        // The scratch attachment must be at least as large as the first (largest) blur texture.
        m_blurFramebuffer.SetSize(m_blurTextures[0]->Width(), m_blurTextures[0]->Height());
    }

    return true;
}

void BlurTexture::BindPassTarget(size_t pass)
{
    const auto& texture = m_blurTextures[pass];

    if (m_renderPath == RenderPath::Direct)
    {
        glBindFramebuffer(GL_FRAMEBUFFER, m_directFramebufferId);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                               texture->TextureID(), 0);
    }

    glViewport(0, 0, texture->Width(), texture->Height());
}

void BlurTexture::Bind(GLint& unit, Renderer::Shader& shader) const
{
    for (size_t i = 0; i < static_cast<size_t>(EffectiveLevel(m_blurLevel)) * 2; i++)
    {
        if (i % 2 == 1)
        {
            m_blurTextures[i]->Bind(unit, m_blurSampler);
            shader.SetUniformInt(std::string("sampler_blur" + std::to_string(i / 2 + 1)).c_str(), unit);
            unit++;
        }
    }
}

void BlurTexture::GetSafeBlurMinMaxValues(const PerFrameContext& perFrameContext,
                                          Values& blurMin,
                                          Values& blurMax)
{
    blurMin[0] = static_cast<float>(*perFrameContext.blur1_min);
    blurMin[1] = static_cast<float>(*perFrameContext.blur2_min);
    blurMin[2] = static_cast<float>(*perFrameContext.blur3_min);
    blurMax[0] = static_cast<float>(*perFrameContext.blur1_max);
    blurMax[1] = static_cast<float>(*perFrameContext.blur2_max);
    blurMax[2] = static_cast<float>(*perFrameContext.blur3_max);

    // check that precision isn't wasted in later blur passes [...min-max gap can't grow!]
    // also, if min-max are close to each other, push them apart:
    const float fMinDist = 0.1f;
    if (blurMax[0] - blurMin[0] < fMinDist)
    {
        float avg = (blurMin[0] + blurMax[0]) * 0.5f;
        blurMin[0] = avg - fMinDist * 0.5f;
        blurMax[0] = avg - fMinDist * 0.5f;
    }
    blurMax[1] = std::min(blurMax[0], blurMax[1]);
    blurMin[1] = std::max(blurMin[0], blurMin[1]);
    if (blurMax[1] - blurMin[1] < fMinDist)
    {
        float avg = (blurMin[1] + blurMax[1]) * 0.5f;
        blurMin[1] = avg - fMinDist * 0.5f;
        blurMax[1] = avg - fMinDist * 0.5f;
    }
    blurMax[2] = std::min(blurMax[1], blurMax[2]);
    blurMin[2] = std::max(blurMin[1], blurMin[2]);
    if (blurMax[2] - blurMin[2] < fMinDist)
    {
        float avg = (blurMin[2] + blurMax[2]) * 0.5f;
        blurMin[2] = avg - fMinDist * 0.5f;
        blurMax[2] = avg - fMinDist * 0.5f;
    }
}

void BlurTexture::AllocateTextures(const Renderer::Texture& sourceTexture)
{
    int width = sourceTexture.Width();
    int height = sourceTexture.Height();

    if (m_blurTextures[0] != nullptr &&
        width > 0 &&
        height > 0 &&
        width == m_sourceTextureWidth &&
        height == m_sourceTextureHeight)
    {
        // Size unchanged, return.
        return;
    }

    for (size_t i = 0; i < m_blurTextures.size(); i++)
    {
        // main VS = 1024
        // blur0 = 512
        // blur1 = 256  <-  user sees this as "blur1"
        // blur2 = 128
        // blur3 = 128  <-  user sees this as "blur2"
        // blur4 =  64
        // blur5 =  64  <-  user sees this as "blur3"
        if (!(i & 1) || (i < 2))
        {
            width = std::max(16, width / 2);
            height = std::max(16, height / 2);
        }
        int width2 = ((width + 3) / 16) * 16;
        int height2 = ((height + 3) / 4) * 4;

        std::string textureName;
        if (i % 2 == 1)
        {
            textureName = "blur" + std::to_string(i / 2 + 1);
        }

        // This will automatically replace any old texture.
        // The formats are explicitly sized: the blur textures are used as color attachments,
        // and unsized internal formats are not guaranteed to be color-renderable.
#ifdef PROJECTM_HDR_RENDERING
        m_blurTextures[i] = std::make_shared<Renderer::Texture>(textureName, GL_TEXTURE_2D, width2, height2, 0, GL_RGBA16F, GL_RGBA, GL_HALF_FLOAT, false);
#else
        m_blurTextures[i] = std::make_shared<Renderer::Texture>(textureName, GL_TEXTURE_2D, width2, height2, 0, GL_RGB8, GL_RGB, GL_UNSIGNED_BYTE, false);
#endif
    }

    m_sourceTextureWidth = sourceTexture.Width();
    m_sourceTextureHeight = sourceTexture.Height();
}

} // namespace MilkdropPreset
} // namespace libprojectM
