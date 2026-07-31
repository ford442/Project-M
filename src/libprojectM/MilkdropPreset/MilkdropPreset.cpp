/**
 * projectM -- Milkdrop-esque visualisation SDK
 * Copyright (C)2003-2004 projectM Team
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 * See 'LICENSE.txt' included within this release
 *
 */

#include "MilkdropPreset.hpp"

#include "Factory.hpp"
#include "MilkdropPresetExceptions.hpp"
#include "PresetFileParser.hpp"

#include <Logging.hpp>
#include <PerfTimers.hpp>

#include <algorithm>

#ifdef PRJM_ENABLE_OPENMP
#include <omp.h>
#endif

namespace libprojectM {
namespace MilkdropPreset {

MilkdropPreset::MilkdropPreset(const std::string& absoluteFilePath)
    : m_absoluteFilePath(absoluteFilePath)
    , m_perFrameContext(m_state.globalMemory, &m_state.globalRegisters)
    , m_perPixelContext(m_state.globalMemory, &m_state.globalRegisters)
    , m_motionVectors(m_state)
    , m_waveform(m_state)
    , m_darkenCenter(m_state)
    , m_border(m_state)
{
    Load(absoluteFilePath);
}

MilkdropPreset::MilkdropPreset(std::istream& presetData)
    : m_perFrameContext(m_state.globalMemory, &m_state.globalRegisters)
    , m_perPixelContext(m_state.globalMemory, &m_state.globalRegisters)
    , m_motionVectors(m_state)
    , m_waveform(m_state)
    , m_darkenCenter(m_state)
    , m_border(m_state)
{
    Load(presetData);
}

void MilkdropPreset::Initialize(const Renderer::RenderContext& renderContext)
{
    assert(renderContext.textureManager);
    m_state.renderContext = renderContext;
    m_state.blurTexture.Initialize(renderContext);
    m_state.LoadShaders();

    // Initialize variables and code now we have a proper render state.
    CompileCodeAndRunInitExpressions();

    // Update framebuffer and texture sizes if needed
    m_framebuffer.SetSize(renderContext.viewportSizeX, renderContext.viewportSizeY);
    m_motionVectorUVMap->SetSize(renderContext.viewportSizeX, renderContext.viewportSizeY);
    if (m_state.mainTexture.expired())
    {
        m_state.mainTexture = m_framebuffer.GetColorAttachmentTexture(1, 0);
    }

    m_perPixelMesh.CompileWarpShader(m_state);
    m_finalComposite.CompileCompositeShader(m_state);
}

void MilkdropPreset::RenderFrame(const libprojectM::Audio::FrameAudioData& audioData, const Renderer::RenderContext& renderContext)
{
    m_state.audioData = audioData;
    m_state.renderContext = renderContext;

    // Update framebuffer and u/v texture size if needed
    if (m_framebuffer.SetSize(renderContext.viewportSizeX, renderContext.viewportSizeY))
    {
        m_motionVectorUVMap->SetSize(renderContext.viewportSizeX, renderContext.viewportSizeY);
        m_isFirstFrame = true;
    }

    m_state.mainTexture = m_framebuffer.GetColorAttachmentTexture(m_previousFrameBuffer, 0);

    // First evaluate per-frame code
    {
        PROJECTM_PERF_SCOPE(PerFrameEval);
        PerFrameUpdate();
    }

    glViewport(0, 0, renderContext.viewportSizeX, renderContext.viewportSizeY);

    m_framebuffer.Bind(m_previousFrameBuffer);
    // Motion vector field. Drawn to the previous frame texture before warping it.
    // Only do it after drawing one frame after init or resize.
    if (!m_isFirstFrame)
    {
        m_motionVectors.Draw(m_perFrameContext, m_motionVectorUVMap->Texture());
    }

    // y-flip the previous frame and assign the flipped texture as "main".
    // When the preset uses only the default warp shader the fragment shader
    // can fold the flip into the sample coordinate (u_flipMainTex = 1), so
    // we skip this fullscreen CopyTexture pass entirely and hand the raw
    // (un-flipped) texture to the warp draw.  Custom HLSL warp shaders
    // expect Milkdrop UV convention (v=0 at top) via sampler_main, so the
    // pre-flip is still needed for those presets.
    if (m_perPixelMesh.HasCustomWarpShader())
    {
        m_flipTexture.Draw(*renderContext.shaderCache, m_framebuffer.GetColorAttachmentTexture(m_previousFrameBuffer, 0), nullptr, true, false);
        m_state.mainTexture = m_flipTexture.Texture();
    }
    else
    {
        m_state.mainTexture = m_framebuffer.GetColorAttachmentTexture(m_previousFrameBuffer, 0);
    }

    // We now draw to the current framebuffer.
    m_framebuffer.Bind(m_currentFrameBuffer);

    // Add motion vector u/v texture for the warp mesh draw and clean both buffers.
    m_framebuffer.SetAttachment(m_currentFrameBuffer, 1, m_motionVectorUVMap);

    // Draw previous frame image warped via per-pixel mesh and warp shader
    {
        PROJECTM_PERF_SCOPE(PerPixelEval);
        m_perPixelMesh.Draw(m_state, m_perFrameContext, m_perPixelContext, m_perPixelContextPool);
    }

    // Remove the u/v texture from the framebuffer.
    m_framebuffer.RemoveColorAttachment(m_currentFrameBuffer, 1);

    // Update blur textures
    {
        PROJECTM_PERF_SCOPE(Blur);
        const auto warpedImage = m_framebuffer.GetColorAttachmentTexture(m_previousFrameBuffer, 0);
        assert(warpedImage.get());
        m_state.blurTexture.Update(*warpedImage, m_perFrameContext);
    }

    // Draw audio-data-related stuff
    {
        PROJECTM_PERF_SCOPE(WaveformsShapes);
        for (auto& shape : m_customShapes)
        {
            shape->Draw();
        }
        for (auto& wave : m_customWaveforms)
        {
            wave->Draw(m_perFrameContext);
        }
        m_waveform.Draw(m_perFrameContext);

        // Done in DrawSprites() in Milkdrop
        if (*m_perFrameContext.darken_center > 0)
        {
            m_darkenCenter.Draw();
        }
        m_border.Draw(m_perFrameContext);
    }

    // y-flip the image for final compositing again
    {
        PROJECTM_PERF_SCOPE(Composite);
        m_flipTexture.Draw(*renderContext.shaderCache, m_framebuffer.GetColorAttachmentTexture(m_currentFrameBuffer, 0), nullptr, true, false);
        m_state.mainTexture = m_flipTexture.Texture();

        // We no longer need the previous frame image, use it to render the final composite.
        m_framebuffer.BindRead(m_currentFrameBuffer);
        m_framebuffer.BindDraw(m_previousFrameBuffer);

        m_finalComposite.Draw(m_state, m_perFrameContext);

        if (!m_finalComposite.HasCompositeShader())
        {
            // Flip texture again in "previous" framebuffer as old-school effects are still upside down.
            m_flipTexture.Draw(*renderContext.shaderCache, m_framebuffer.GetColorAttachmentTexture(m_previousFrameBuffer, 0), m_framebuffer, m_previousFrameBuffer, true, false);
        }
    }

    // Swap framebuffer IDs for the next frame.
    // This ping-pong swap makes the just-rendered frame available as the
    // "previous frame" texture for feedback/warp effects in the next cycle.
    std::swap(m_currentFrameBuffer, m_previousFrameBuffer);

    m_isFirstFrame = false;
}

auto MilkdropPreset::OutputTexture() const -> std::shared_ptr<Renderer::Texture>
{
    // the composited image is always stored in the "current" framebuffer after a frame is rendered.
    return m_framebuffer.GetColorAttachmentTexture(m_currentFrameBuffer, 0);
}

void MilkdropPreset::DrawInitialImage(const std::shared_ptr<Renderer::Texture>& image, const Renderer::RenderContext& renderContext)
{
    m_framebuffer.SetSize(renderContext.viewportSizeX, renderContext.viewportSizeY);

    // Render to previous framebuffer, as this is the image used to draw the next frame on.
    m_flipTexture.Draw(*renderContext.shaderCache, image, m_framebuffer, m_previousFrameBuffer);
}

void MilkdropPreset::BindFramebuffer()
{
    if (m_framebuffer.Width() > 0 && m_framebuffer.Height() > 0)
    {
        m_framebuffer.BindDraw(m_previousFrameBuffer);
    }
}

void MilkdropPreset::BindOutputForRead()
{
    // Bind the framebuffer that holds the most recently composited frame as
    // the OpenGL read framebuffer.  This lets the caller use glBlitFramebuffer
    // to copy the output to the target without a shader quad draw.
    // OutputTexture() returns GetColorAttachmentTexture(m_currentFrameBuffer, 0),
    // so the matching read bind uses the same index.
    m_framebuffer.BindRead(m_currentFrameBuffer);
}

void MilkdropPreset::PerFrameUpdate()
{
    m_perFrameContext.LoadStateVariables(m_state);
    m_perPixelContext.LoadStateReadOnlyVariables(m_state, m_perFrameContext);

    m_perFrameContext.ExecutePerFrameCode();

    m_perPixelContext.LoadPerFrameQVariables(m_state, m_perFrameContext);

    // Broadcast the per-frame read-only and Q variables to the additional
    // per-thread per-pixel contexts used by the parallel mesh evaluation loop.
    for (auto& perPixelContext : m_perPixelContextPool)
    {
        perPixelContext->CopyFrameStateFrom(m_perPixelContext);
    }

    // Clamp gamma and echo zoom values
    *m_perFrameContext.gamma = std::max(0.0, std::min(8.0, *m_perFrameContext.gamma));
    *m_perFrameContext.echo_zoom = std::max(0.001, std::min(1000.0, *m_perFrameContext.echo_zoom));

    // Write the (possibly preset-modified) gamma/video echo values back to the
    // preset state, as VideoEcho::Draw() and FinalComposite read these from
    // m_state rather than the per-frame eval context. Without this, presets
    // that animate "gamma", "echo_zoom", "echo_alpha" or "echo_orient" in
    // per_frame code (very common in Milkdrop2 presets) would always render
    // with the preset file's static fGammaAdj/fVideoEcho* header values.
    m_state.gammaAdj = static_cast<float>(*m_perFrameContext.gamma);
    m_state.videoEchoZoom = static_cast<float>(*m_perFrameContext.echo_zoom);
    m_state.videoEchoAlpha = static_cast<float>(*m_perFrameContext.echo_alpha);
    m_state.videoEchoOrientation = static_cast<int>(*m_perFrameContext.echo_orient);
}

void MilkdropPreset::Load(const std::string& pathname)
{
    LOG_DEBUG("[MilkdropPreset] Loading preset from file \"" + pathname + "\".")

    SetFilename(ParseFilename(pathname));

    PresetFileParser parser;

    if (!parser.Read(pathname))
    {
        const std::string error = "[MilkdropPreset] Could not parse preset file \"" + pathname + "\".";
        LOG_ERROR(error)
        throw MilkdropPresetLoadException(error);
    }

    InitializePreset(parser);
}

void MilkdropPreset::Load(std::istream& stream)
{
    LOG_DEBUG("[MilkdropPreset] Loading preset from stream.");

    PresetFileParser parser;

    if (!parser.Read(stream))
    {
        const std::string error = "[MilkdropPreset] Could not parse preset data.";
        LOG_ERROR(error)
        throw MilkdropPresetLoadException(error);
    }

    InitializePreset(parser);
}

void MilkdropPreset::InitializePreset(PresetFileParser& parsedFile)
{
    // Create the offscreen rendering surfaces.
    // MilkdropPreset uses a ping-pong framebuffer pair:
    //   - m_framebuffer[0] = current frame render target
    //   - m_framebuffer[1] = previous frame (used for feedback/warp effects)
    // After each frame they are swapped with std::swap().
    // Using GL_RGBA + GL_UNSIGNED_BYTE for broad GLES/Emscripten compatibility.
    m_motionVectorUVMap = std::make_shared<Renderer::TextureAttachment>(GL_RG16F, GL_RG, GL_FLOAT, 0, 0);
    m_framebuffer.CreateColorAttachment(0, 0); // Main image 1 (current)
    m_framebuffer.CreateColorAttachment(1, 0); // Main image 2 (previous)

    Renderer::Framebuffer::Unbind();

    // Load global init variables into the state
    m_state.Initialize(parsedFile);

    // Register code context variables
    m_perFrameContext.RegisterBuiltinVariables();
    m_perPixelContext.RegisterBuiltinVariables();

    // Create one additional per-pixel evaluation context per extra OpenMP
    // worker thread (threads 1..N-1). projectm-eval contexts are not
    // re-entrant, so PerPixelMesh::CalculateMesh() needs a dedicated context
    // per thread to evaluate per-pixel code in parallel. All contexts share
    // the gmegabuf/reg vars via m_state.globalMemory/m_state.globalRegisters,
    // which is protected by EvalLibMutex.
    m_perPixelContextPool.clear();
#ifdef PRJM_ENABLE_OPENMP
    const int threadCount = std::max(1, omp_get_max_threads());
    m_perPixelContextPool.reserve(threadCount - 1);
    for (int i = 1; i < threadCount; i++)
    {
        auto perPixelContext = std::make_unique<PerPixelContext>(m_state.globalMemory, &m_state.globalRegisters);
        perPixelContext->RegisterBuiltinVariables();
        m_perPixelContextPool.push_back(std::move(perPixelContext));
    }
#endif

    // Custom waveforms:
    for (int i = 0; i < CustomWaveformCount; i++)
    {
        auto wave = std::make_unique<CustomWaveform>(m_state);
        wave->Initialize(parsedFile, i);
        m_customWaveforms[i] = std::move(wave);
    }

    // Custom shapes:
    for (int i = 0; i < CustomShapeCount; i++)
    {
        auto shape = std::make_unique<CustomShape>(m_state);
        shape->Initialize(parsedFile, i);
        m_customShapes[i] = std::move(shape);
    }

    // Preload shaders
    LoadShaderCode();
}

void MilkdropPreset::CompileCodeAndRunInitExpressions()
{
    // Per-frame init and code
    m_perFrameContext.LoadStateVariables(m_state);
    m_perFrameContext.EvaluateInitCode(m_state);
    m_perFrameContext.CompilePerFrameCode(m_state.perFrameCode);

    // Per-vertex code
    m_perPixelContext.CompilePerPixelCode(m_state.perPixelCode);
    for (auto& perPixelContext : m_perPixelContextPool)
    {
        perPixelContext->CompilePerPixelCode(m_state.perPixelCode);
    }

    for (int i = 0; i < CustomWaveformCount; i++)
    {
        auto& wave = m_customWaveforms[i];
        wave->CompileCodeAndRunInitExpressions(m_perFrameContext);
    }

    for (int i = 0; i < CustomShapeCount; i++)
    {
        auto& shape = m_customShapes[i];
        shape->CompileCodeAndRunInitExpressions();
    }
}

void MilkdropPreset::LoadShaderCode()
{
    m_perPixelMesh.LoadWarpShader(m_state);
    m_finalComposite.LoadCompositeShader(m_state);
}

auto MilkdropPreset::ParseFilename(const std::string& filename) -> std::string
{
    const std::size_t start = filename.find_last_of('/');

    if (start == std::string::npos || start >= (filename.length() - 1))
    {
        return "";
    }

    return filename.substr(start + 1, filename.length());
}


} // namespace MilkdropPreset
} // namespace libprojectM
