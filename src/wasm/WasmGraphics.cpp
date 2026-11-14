// WasmGraphics.cpp
//
// Implementation of the dual ping-pong FBO manager, the render-state guard and
// the compositing shader declared in WasmGraphics.hpp.
#include "WasmGraphics.hpp"

#include "WasmCompositorShader.hpp"
#include "WasmLog.hpp"
#include "WasmWebGLContext.hpp"

#include <Renderer/Point.hpp>
#include <Renderer/Shader.hpp>
#include <Renderer/VertexArray.hpp>
#include <Renderer/VertexBuffer.hpp>

#include <utility>

// =============================================================================
// DualPingPongFramebuffer
// =============================================================================

DualPingPongFramebuffer::~DualPingPongFramebuffer()
{
    ReleaseAll();
}

void DualPingPongFramebuffer::DetectFormat(const WasmContextCaps& caps, int precisionMode)
{
    m_filter = RenderDevice::FilterMode::Linear;
    if (precisionMode == static_cast<int>(FboFloatFormat::RGBA8))
    {
        m_format = FboFloatFormat::RGBA8;
        WASM_LOG_WARN("DualFBO: Forced GL_RGBA8 (fboPrecision=byte); output is dithered/clamped.");
        return;
    }
    // In WebGL 2, EXT_color_buffer_float makes both RGBA16F and RGBA32F
    // renderable; EXT_color_buffer_half_float covers RGBA16F alone.
    const bool halfRenderable = caps.floatColorBuffer || caps.halfFloatColorBuffer;

    if (precisionMode == static_cast<int>(FboFloatFormat::RGBA32F) && caps.floatColorBuffer)
    {
        m_format = FboFloatFormat::RGBA32F;
        // RGBA32F is not filterable in core WebGL 2. A GL_LINEAR sampler on
        // it without this extension makes the texture incomplete, and an
        // incomplete texture samples as black. The compositor draws the
        // FBOs 1:1 onto the canvas, so GL_NEAREST loses nothing there.
        if (!caps.floatLinear)
        {
            m_filter = RenderDevice::FilterMode::Nearest;
            WASM_LOG_INFO("DualFBO: Using GL_RGBA32F float textures (high-precision opt-in), GL_NEAREST: OES_texture_float_linear unavailable.");
        }
        else
        {
            WASM_LOG_INFO("DualFBO: Using GL_RGBA32F float textures (high-precision opt-in).");
        }
    }
    else if (halfRenderable)
    {
        m_format = FboFloatFormat::RGBA16F;
        WASM_LOG_INFO("DualFBO: Using GL_RGBA16F half-float textures (default).");
    }
    else
    {
        m_format = FboFloatFormat::RGBA8;
        WASM_LOG_WARN("DualFBO: Float textures unavailable, falling back to GL_RGBA8 (degraded mode).");
        WASM_LOG_WARN("DualFBO: transitions crossfade at 8 bits (dithered/clamped in CompositingBlendShader).");
        WASM_LOG_WARN("DualFBO: Host page can query this via Module._dual_fbo_get_format() (2 == RGBA8).");
    }
}

bool DualPingPongFramebuffer::AllocatePresetA(int width, int height)
{
    if (m_presetAAllocated)
    {
        Resize(width, height);
        return true;
    }

    m_width = width;
    m_height = height;

    if (!CreateFBOWithFallback(kARead, width, height) || !CreateFBOWithFallback(kAWrite, width, height))
    {
        ReleaseFBO(kARead);
        ReleaseFBO(kAWrite);
        WASM_LOG_ERROR("DualFBO: Failed to allocate Preset A FBOs.");
        return false;
    }

    m_presetAAllocated = true;
    WASM_LOG_INFO("DualFBO: Preset A FBOs allocated (%dx%d).", width, height);
    return true;
}

bool DualPingPongFramebuffer::AllocatePresetB(int width, int height)
{
    if (m_presetBAllocated)
    {
        return true;
    }

    if (!CreateFBOWithFallback(kBRead, width, height) || !CreateFBOWithFallback(kBWrite, width, height))
    {
        ReleaseFBO(kBRead);
        ReleaseFBO(kBWrite);
        WASM_LOG_ERROR("DualFBO: Failed to allocate Preset B FBOs.");
        return false;
    }

    m_presetBAllocated = true;
    WASM_LOG_INFO("DualFBO: Preset B FBOs allocated (%dx%d).", width, height);
    return true;
}

void DualPingPongFramebuffer::ReleasePresetB()
{
    if (!m_presetBAllocated)
    {
        return;
    }
    ReleaseFBO(kBRead);
    ReleaseFBO(kBWrite);
    m_presetBAllocated = false;
    WASM_LOG_INFO("DualFBO: Preset B FBOs released.");
}

void DualPingPongFramebuffer::ReleasePresetA()
{
    if (!m_presetAAllocated)
    {
        return;
    }
    ReleaseFBO(kARead);
    ReleaseFBO(kAWrite);
    m_presetAAllocated = false;
    WASM_LOG_INFO("DualFBO: Preset A FBOs released.");
}

void DualPingPongFramebuffer::ReleaseAll()
{
    ReleasePresetB();
    ReleasePresetA();
}

void DualPingPongFramebuffer::PromoteBtoA()
{
    if (!m_presetBAllocated)
    {
        return;
    }

    // Release old Preset A resources.
    if (m_presetAAllocated)
    {
        ReleaseFBO(kARead);
        ReleaseFBO(kAWrite);
    }

    // Move Preset B into Preset A slots (transfer ownership).
    m_fbos[kARead] = m_fbos[kBRead];
    m_fbos[kAWrite] = m_fbos[kBWrite];
    m_textures[kARead] = m_textures[kBRead];
    m_textures[kAWrite] = m_textures[kBWrite];

    // Clear Preset B slots (ownership transferred; do not delete).
    m_fbos[kBRead] = {};
    m_fbos[kBWrite] = {};
    m_textures[kBRead] = {};
    m_textures[kBWrite] = {};

    m_presetAAllocated = true;
    m_presetBAllocated = false;
    WASM_LOG_INFO("DualFBO: Preset B promoted to Preset A.");
}

void DualPingPongFramebuffer::Resize(int width, int height)
{
    if (width == m_width && height == m_height)
    {
        return;
    }

    m_width = width;
    m_height = height;

    if (m_presetAAllocated)
    {
        ResizeFBOTexture(kARead, width, height);
        ResizeFBOTexture(kAWrite, width, height);
    }
    if (m_presetBAllocated)
    {
        ResizeFBOTexture(kBRead, width, height);
        ResizeFBOTexture(kBWrite, width, height);
    }

    WASM_LOG_INFO("DualFBO: Resized to %dx%d.", width, height);
}

RenderDevice::TextureDesc DualPingPongFramebuffer::GetTextureDesc(int width, int height) const
{
    RenderDevice::TextureDesc desc;
    desc.width = width;
    desc.height = height;
    switch (m_format)
    {
        case FboFloatFormat::RGBA32F:
            desc.format = RenderDevice::TextureFormat::RGBA32F;
            break;
        case FboFloatFormat::RGBA16F:
            desc.format = RenderDevice::TextureFormat::RGBA16F;
            break;
        case FboFloatFormat::RGBA8:
            desc.format = RenderDevice::TextureFormat::RGBA8;
            break;
        default:
            WASM_LOG_ERROR("DualFBO: Unknown FboFloatFormat; falling back to GL_RGBA8.");
            desc.format = RenderDevice::TextureFormat::RGBA8;
            break;
    }
    // The filter DetectFormat() chose, edge clamp.
    desc.sampling = RenderDevice::TextureSampling{m_filter, RenderDevice::WrapMode::ClampToEdge};
    return desc;
}

/**
 * Creates a single FBO with a colour texture attachment at the given slot
 * (kARead, kAWrite, kBRead or kBWrite). False if the framebuffer status check
 * failed; the slot is left empty then.
 */
bool DualPingPongFramebuffer::CreateFBO(int index, int width, int height)
{
    using RenderDevice::TargetBinding;
    auto& device = RenderDevice::Current();
    auto& commands = device.Commands();

    m_textures[index] = device.CreateTexture(GetTextureDesc(width, height), nullptr);

    m_fbos[index] = device.CreateRenderTarget();
    commands.BindRenderTarget(TargetBinding::ReadDraw, m_fbos[index]);
    commands.AttachTexture(TargetBinding::ReadDraw, RenderDevice::AttachmentPoint::Color0, m_textures[index]);

    const auto status = commands.CheckRenderTarget(TargetBinding::ReadDraw);
    commands.BindRenderTarget(TargetBinding::ReadDraw, {});

    if (!status.complete)
    {
        WASM_LOG_ERROR("DualFBO: Framebuffer slot %d incomplete (status=0x%x).",
                       index, status.code);
        device.DestroyTexture(m_textures[index]);
        device.DestroyRenderTarget(m_fbos[index]);
        m_textures[index] = {};
        m_fbos[index] = {};
        return false;
    }

    return true;
}

/**
 * CreateFBO(), and if a float format turns out not to be renderable after all,
 * CreateFBO() again in GL_RGBA8.
 *
 * DetectFormat() only knows which extensions the context reported; a driver
 * can still refuse the framebuffer (GL_FRAMEBUFFER_UNSUPPORTED). Rather than
 * lose the transition, the manager switches to RGBA8 for good: slots that
 * already hold float textures are re-specified in RGBA8 too, so the pairs
 * stay alike, and the compositor dithers from here on (it reads GetFormat()
 * every frame; so does get_context_snapshot()).
 */
bool DualPingPongFramebuffer::CreateFBOWithFallback(int index, int width, int height)
{
    if (CreateFBO(index, width, height))
    {
        return true;
    }
    if (m_format == FboFloatFormat::RGBA8)
    {
        return false;
    }
    WASM_LOG_WARN("DualFBO: %s framebuffer incomplete; falling back to GL_RGBA8 (dithered).",
                  m_format == FboFloatFormat::RGBA32F ? "GL_RGBA32F" : "GL_RGBA16F");
    m_format = FboFloatFormat::RGBA8;
    m_filter = RenderDevice::FilterMode::Linear;
    for (int slot = 0; slot < 4; ++slot)
    {
        ResizeFBOTexture(slot, m_width, m_height);
    }
    return CreateFBO(index, width, height);
}

void DualPingPongFramebuffer::ReleaseFBO(int index)
{
    auto& device = RenderDevice::Current();
    device.DestroyRenderTarget(m_fbos[index]);
    m_fbos[index] = {};
    device.DestroyTexture(m_textures[index]);
    m_textures[index] = {};
}

/**
 * Reallocates the colour texture for a slot at new dimensions. The FBO handle
 * itself is reused; only the texture storage is replaced and re-attached.
 */
void DualPingPongFramebuffer::ResizeFBOTexture(int index, int width, int height)
{
    if (!m_textures[index].Valid())
    {
        return;
    }
    using RenderDevice::TargetBinding;
    auto& device = RenderDevice::Current();
    auto& commands = device.Commands();
    device.UpdateTexture(m_textures[index], GetTextureDesc(width, height), nullptr);

    // Re-attach the resized texture to the FBO.
    commands.BindRenderTarget(TargetBinding::ReadDraw, m_fbos[index]);
    commands.AttachTexture(TargetBinding::ReadDraw, RenderDevice::AttachmentPoint::Color0, m_textures[index]);
    commands.BindRenderTarget(TargetBinding::ReadDraw, {});
}

// =============================================================================
// RenderStateGuard and the between-pipelines reset
// =============================================================================

RenderStateGuard::RenderStateGuard(const RenderDevice::StateSnapshot* baseline)
    : m_restore(baseline != nullptr ? *baseline : RenderDevice::Commands().CaptureState())
{
}

RenderStateGuard::~RenderStateGuard()
{
    RenderDevice::Commands().RestoreState(m_restore);
}

void reset_render_state_between_pipelines()
{
    // Covers all texture units accessed by projectM shaders (warp, composite, blur, etc.).
    static constexpr int kMaxProjectMTextureUnits = 8;

    auto& commands = RenderDevice::Commands();

    // Disable blending; reset to opaque replace mode.
    commands.SetEnabled(RenderDevice::Capability::Blend, false);
    commands.SetBlendFunction(RenderDevice::BlendFactor::One, RenderDevice::BlendFactor::Zero);

    // Unbind textures on the first kMaxProjectMTextureUnits units.
    for (int unit = 0; unit < kMaxProjectMTextureUnits; ++unit)
    {
        commands.BindTexture(unit, RenderDevice::TextureTarget::Texture2D, {});
    }
    commands.SetActiveTextureUnit(0); // Leave active unit at 0 as a clean default.

    // Reset depth mask.
    commands.SetDepthMask(true);

    // Unbind any FBO (render to default framebuffer).
    commands.BindRenderTarget(RenderDevice::TargetBinding::ReadDraw, {});
}

// =============================================================================
// CompositingBlendShader
// =============================================================================

// Out of line so the header can hold the unique_ptrs to incomplete types.
CompositingBlendShader::CompositingBlendShader() = default;

CompositingBlendShader::~CompositingBlendShader()
{
    Release();
}

bool CompositingBlendShader::Init()
{
    Release();

    // Sources and the alpha contract: WasmCompositorShader.hpp.
    auto program = std::make_unique<libprojectM::Renderer::Shader>();
    try
    {
        program->CompileProgram(kCompositorVertexShader, kCompositorFragmentShader);
    }
    catch (const libprojectM::Renderer::ShaderException& ex)
    {
        WASM_LOG_ERROR("CompositingBlendShader: %s", ex.message().c_str());
        return false;
    }
    m_program = std::move(program);

    // Fullscreen triangle-strip quad in NDC (CCW winding):
    //   (-1,-1)  (1,-1)  (-1,1)  (1,1)
    m_vao = std::make_unique<libprojectM::Renderer::VertexArray>();
    m_vbo = std::make_unique<libprojectM::Renderer::VertexBuffer<libprojectM::Renderer::Point>>(
        libprojectM::Renderer::VertexBufferUsage::StaticDraw);
    m_vbo->Set({{-1.0f, -1.0f}, {1.0f, -1.0f}, {-1.0f, 1.0f}, {1.0f, 1.0f}});

    const int positionLocation = m_program->AttributeLocation("aPosition");
    m_vao->Bind();
    m_vbo->Update();
    if (positionLocation >= 0)
    {
        libprojectM::Renderer::VertexBuffer<libprojectM::Renderer::Point>::SetEnableAttributeArray(positionLocation, true);
        m_vbo->InitializeAttributePointer(positionLocation);
    }
    libprojectM::Renderer::VertexArray::Unbind();
    libprojectM::Renderer::VertexBuffer<libprojectM::Renderer::Point>::Unbind();

    m_initialized = true;
    WASM_LOG_INFO("CompositingBlendShader: initialized successfully.");
    return true;
}

void CompositingBlendShader::Draw(RenderDevice::TextureHandle texA, RenderDevice::TextureHandle texB, float blend, int width, int height, bool dither,
                                  bool transparencyMode, float transparencyThreshold)
{
    if (!m_initialized || !m_program)
    {
        return;
    }

    using RenderDevice::Capability;
    constexpr auto texture2D = RenderDevice::TextureTarget::Texture2D;
    auto& commands = RenderDevice::Commands();

    // Render to the default framebuffer (browser canvas).
    commands.BeginPass({{}, RenderDevice::TargetBinding::ReadDraw, RenderDevice::Rect{0, 0, width, height}});
    commands.SetEnabled(Capability::Blend, false);
    commands.SetEnabled(Capability::DepthTest, false);
    commands.SetDepthMask(false);
    commands.SetEnabled(Capability::ScissorTest, false);

    m_program->Bind();

    commands.BindTexture(0, texture2D, texA);
    m_program->SetUniformInt("uTexA", 0);

    // Fall back to texA when texB is invalid (no-transition blit).
    commands.BindTexture(1, texture2D, texB.Valid() ? texB : texA);
    m_program->SetUniformInt("uTexB", 1);

    m_program->SetUniformFloat("uBlend", blend);
    m_program->SetUniformFloat("uDither", dither ? 1.0f : 0.0f);
    m_program->SetUniformInt("u_transparencyEnabled", transparencyMode ? 1 : 0);
    m_program->SetUniformFloat("u_transparencyThreshold", transparencyThreshold);

    m_vao->Bind();
    commands.Draw(RenderDevice::PrimitiveType::TriangleStrip, 0, 4);
    libprojectM::Renderer::VertexArray::Unbind();
    commands.EndPass();

    // Clean up texture bindings.
    commands.BindTexture(1, texture2D, {});
    commands.BindTexture(0, texture2D, {});

    libprojectM::Renderer::Shader::Unbind();
}

void CompositingBlendShader::Release()
{
    m_program.reset();
    m_vbo.reset();
    m_vao.reset();
    m_initialized = false;
}
