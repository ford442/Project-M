// WasmGraphics.hpp
//
// Dual ping-pong FBO architecture, RAII render-state guard, and the fullscreen
// compositing/crossfade shader used by the WASM preset-transition system.
//
// These types are defined in a header (rather than a .cpp) because both the
// render loop in WasmRenderLoop.cpp and the dual-FBO C exports in
// WasmDualFbo.cpp operate on the active host's dualFbo / compositorShader
// instances (see WasmHost).
//
// Everything here draws through libprojectM's render device (see
// docs/RENDER_DEVICE.md), not GL directly: the same seam the engine uses, so a
// second backend covers the host layer too.
#pragma once

#include "ProjectMWasmInternal.hpp"
#include "WasmCompositorShader.hpp"
#include "WasmLog.hpp"
#include "WasmWebGLContext.hpp"

#include <Renderer/Device/RenderDevice.hpp>
#include <Renderer/Point.hpp>
#include <Renderer/Shader.hpp>
#include <Renderer/VertexArray.hpp>
#include <Renderer/VertexBuffer.hpp>

#include <array>
#include <memory>

namespace RenderDevice = libprojectM::Renderer::Device;

// =============================================================================
// Phase 2: Dual Ping-Pong FBO Architecture with Floating-Point Texture Support
// =============================================================================

/**
 * @brief Dual-FBO colour format — one numbering for both the precision a host
 *        asks for and the format it gets.
 *
 * set_context_config()'s `fboPrecision` argument takes these values as the
 * format to prefer (0 "half", 1 "high", 2 "byte"), and dual_fbo_get_format()
 * returns the one DetectFormat() picked, in the same numbering. The two used
 * to disagree (the getter returned 0 for RGBA32F and 1 for RGBA16F).
 *
 * Selection (DetectFormat(), from the extensions the context probed once at
 * creation, WasmContextCaps):
 *   RGBA16F – default whenever it is renderable: WebGL 2 plus either
 *             EXT_color_buffer_float or EXT_color_buffer_half_float. Always
 *             filterable in WebGL 2.
 *   RGBA32F – only when the host asks for it (fboPrecision "high") and
 *             EXT_color_buffer_float is present. Linear filtering needs
 *             OES_texture_float_linear; without it the textures are sampled
 *             GL_NEAREST (a linear filter would leave them incomplete, which
 *             samples as black).
 *   RGBA8   – last resort, or forced with fboPrecision "byte"; shaders must
 *             clamp output to [0,1]. Also where a float format ends up when a
 *             framebuffer with it turns out incomplete (CreateFBO()).
 *
 * What a float format buys here is limited: these textures receive frames
 * libprojectM already rendered through RGBA8 feedback, warp and composite
 * targets (ENABLE_HDR_RENDERING is off in the WASM build), so RGBA16F only
 * keeps the crossfade itself from adding a second 8-bit quantization. The
 * recursive-feedback banding lives upstream of this stage.
 */
enum class FboFloatFormat : int
{
    RGBA16F = 0, //!< GL_RGBA16F – default on capable GPUs (fboPrecision "half")
    RGBA32F = 1, //!< GL_RGBA32F – opt-in high precision (fboPrecision "high")
    RGBA8 = 2    //!< GL_RGBA8   – fallback; negative alpha corruption possible without clamping (fboPrecision "byte")
};

/**
 * @brief Dual ping-pong framebuffer manager for isolated preset transitions.
 *
 * Maintains four framebuffer objects so that two preset pipelines can render
 * concurrently without sharing any texture state:
 *
 *   Slot 0 (A_Read)  – Preset A feedback source (history texture)
 *   Slot 1 (A_Write) – Preset A render target   (current frame)
 *   Slot 2 (B_Read)  – Preset B feedback source [lazily allocated]
 *   Slot 3 (B_Write) – Preset B render target   [lazily allocated]
 *
 * Each frame the Read/Write roles within each preset are swapped (ping-pong),
 * giving each preset its own isolated feedback loop.
 *
 * Both preset pairs are transition-only scratch: steady-state playback renders
 * straight to the default framebuffer, so neither pair is allocated until
 * dual_fbo_begin_transition() asks for one, and both are reclaimed once the
 * crossfade finishes (Preset B immediately via PromoteBtoA(), Preset A after
 * the idle grace period enforced in render_frame()).
 */
class DualPingPongFramebuffer
{
public:
    static constexpr int kARead = 0;  //!< Preset A read  (history) slot
    static constexpr int kAWrite = 1; //!< Preset A write (current) slot
    static constexpr int kBRead = 2;  //!< Preset B read  (history) slot
    static constexpr int kBWrite = 3; //!< Preset B write (current) slot

    DualPingPongFramebuffer() = default;

    ~DualPingPongFramebuffer()
    {
        ReleaseAll();
    }

    /**
     * @brief Picks the FBO colour format from the context's float support.
     *
     * Call once after the WebGL context has been created and before any FBO
     * allocation. See FboFloatFormat for the selection rules.
     *
     * @param caps What the context offers, probed (and enabled) once when it was
     *        created; this class enables no extensions itself.
     * @param precisionMode The preferred format, as an FboFloatFormat value
     *        (set_context_config()'s fboPrecision).
     */
    void DetectFormat(const WasmContextCaps& caps, int precisionMode = 0)
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

    /**
     * @brief Allocates the Preset A ping-pong FBO pair.
     *
     * Called on demand from dual_fbo_begin_transition(), never eagerly from
     * start_render() – see the lazy-allocation rationale in docs/PERFORMANCE.md.
     * Requires that the WebGL context is ready and DetectFormat() has been
     * invoked. Safe to call again after a Resize() – dimensions are updated but
     * no re-allocation occurs.
     *
     * @param width  Framebuffer width in pixels.
     * @param height Framebuffer height in pixels.
     * @return true on success, false if FBO creation failed.
     */
    bool AllocatePresetA(int width, int height)
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

    /**
     * @brief Lazily allocates the Preset B ping-pong FBO pair.
     *
     * Call when a transition is initiated. Does nothing if Preset B is already
     * allocated.
     *
     * @param width  Framebuffer width in pixels.
     * @param height Framebuffer height in pixels.
     * @return true on success, false if FBO creation failed.
     */
    bool AllocatePresetB(int width, int height)
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

    /**
     * @brief Releases the Preset B FBOs without affecting Preset A.
     *
     * Call when a transition is cancelled or after PromoteBtoA() has
     * transferred ownership.
     */
    void ReleasePresetB()
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

    /**
     * @brief Releases the Preset A FBOs without affecting Preset B.
     *
     * Preset A is pure crossfade scratch: steady-state playback renders straight
     * to the default framebuffer (see ShouldUseDualFboCompositor()), so between
     * transitions nothing samples these surfaces and they can be reclaimed.
     * Width()/Height() are deliberately preserved so a later
     * dual_fbo_begin_transition() can re-allocate at the right size.
     */
    void ReleasePresetA()
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

    /**
     * @brief Releases all allocated FBOs. Called automatically by the destructor.
     */
    void ReleaseAll()
    {
        ReleasePresetB();
        ReleasePresetA();
    }

    /**
     * @brief Promotes Preset B's FBOs into the Preset A slots after a transition completes.
     *
     * Old Preset A FBOs are deleted; Preset B's FBOs take their place.
     * After this call Preset B is no longer allocated and Preset A holds the
     * former Preset B resources.
     */
    void PromoteBtoA()
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

    /**
     * @brief Swaps the Read/Write FBOs for Preset A (ping-pong).
     *
     * Call once per frame while Preset A is rendering so that the previous
     * frame's output becomes the new frame's history texture.
     */
    void SwapPresetA()
    {
        std::swap(m_fbos[kARead], m_fbos[kAWrite]);
        std::swap(m_textures[kARead], m_textures[kAWrite]);
    }

    /**
     * @brief Swaps the Read/Write FBOs for Preset B (ping-pong).
     *
     * Call once per frame during a transition.
     */
    void SwapPresetB()
    {
        std::swap(m_fbos[kBRead], m_fbos[kBWrite]);
        std::swap(m_textures[kBRead], m_textures[kBWrite]);
    }

    /**
     * @brief Resizes all allocated FBOs to new dimensions.
     *
     * Recreates all textures at the new size; existing framebuffer contents
     * are lost. The FBO handles themselves are reused.
     *
     * @param width  New framebuffer width in pixels.
     * @param height New framebuffer height in pixels.
     */
    void Resize(int width, int height)
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

    // -------------------------------------------------------------------------
    // Accessor functions – return device handles for use in render passes. On
    // the WebGL device a handle's id is the GL object name the C API takes.
    // -------------------------------------------------------------------------
    RenderDevice::RenderTargetHandle GetAReadFBO() const
    {
        return m_fbos[kARead];
    }
    RenderDevice::RenderTargetHandle GetAWriteFBO() const
    {
        return m_fbos[kAWrite];
    }
    RenderDevice::TextureHandle GetAReadTex() const
    {
        return m_textures[kARead];
    }
    RenderDevice::TextureHandle GetAWriteTex() const
    {
        return m_textures[kAWrite];
    }

    RenderDevice::RenderTargetHandle GetBReadFBO() const
    {
        return m_fbos[kBRead];
    }
    RenderDevice::RenderTargetHandle GetBWriteFBO() const
    {
        return m_fbos[kBWrite];
    }
    RenderDevice::TextureHandle GetBReadTex() const
    {
        return m_textures[kBRead];
    }
    RenderDevice::TextureHandle GetBWriteTex() const
    {
        return m_textures[kBWrite];
    }

    bool IsPresetAAllocated() const
    {
        return m_presetAAllocated;
    }
    bool IsPresetBAllocated() const
    {
        return m_presetBAllocated;
    }

    FboFloatFormat GetFormat() const
    {
        return m_format;
    }
    //! Linear, or Nearest when the format is not filterable here.
    RenderDevice::FilterMode GetFilter() const
    {
        return m_filter;
    }
    int Width() const
    {
        return m_width;
    }
    int Height() const
    {
        return m_height;
    }

private:
    // -------------------------------------------------------------------------
    // Helper: the texture description for the detected float format.
    // -------------------------------------------------------------------------
    RenderDevice::TextureDesc GetTextureDesc(int width, int height) const
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
     * @brief Creates a single FBO with a colour texture attachment at the given slot.
     *
     * @param index  Slot index (kARead, kAWrite, kBRead, or kBWrite).
     * @param width  Texture width in pixels.
     * @param height Texture height in pixels.
     * @return true on success; false if the framebuffer status check failed.
     */
    bool CreateFBO(int index, int width, int height)
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
     * @brief CreateFBO(), and if a float format turns out not to be renderable
     *        after all, CreateFBO() again in GL_RGBA8.
     *
     * DetectFormat() only knows which extensions the context reported; a driver
     * can still refuse the framebuffer (GL_FRAMEBUFFER_UNSUPPORTED). Rather than
     * lose the transition, the manager switches to RGBA8 for good: slots that
     * already hold float textures are re-specified in RGBA8 too, so the pairs
     * stay alike, and the compositor dithers from here on (it reads GetFormat()
     * every frame; so does get_context_snapshot()).
     */
    bool CreateFBOWithFallback(int index, int width, int height)
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

    /**
     * @brief Deletes the FBO and its texture at the given slot and resets handles to 0.
     */
    void ReleaseFBO(int index)
    {
        auto& device = RenderDevice::Current();
        device.DestroyRenderTarget(m_fbos[index]);
        m_fbos[index] = {};
        device.DestroyTexture(m_textures[index]);
        m_textures[index] = {};
    }

    /**
     * @brief Reallocates the colour texture for a slot at new dimensions.
     *
     * The FBO handle itself is reused; only the texture storage is replaced
     * and re-attached.
     */
    void ResizeFBOTexture(int index, int width, int height)
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

    std::array<RenderDevice::RenderTargetHandle, 4> m_fbos{}; //!< FBOs:     [A_Read, A_Write, B_Read, B_Write]
    std::array<RenderDevice::TextureHandle, 4> m_textures{};  //!< Textures: [A_Read, A_Write, B_Read, B_Write]

    int m_width = 0;  //!< Current FBO texture width in pixels
    int m_height = 0; //!< Current FBO texture height in pixels

    bool m_presetAAllocated = false; //!< Whether Preset A FBOs are currently allocated
    bool m_presetBAllocated = false; //!< Whether Preset B FBOs are currently allocated

    FboFloatFormat m_format = FboFloatFormat::RGBA8;                      //!< Detected colour format for textures
    RenderDevice::FilterMode m_filter = RenderDevice::FilterMode::Linear; //!< Nearest for RGBA32F without OES_texture_float_linear
};

// =============================================================================
// Phase 3: RenderStateGuard – RAII WebGL state restore for preset isolation
// =============================================================================

/**
 * @brief RAII guard that puts the host's render state back after a preset render.
 *
 * The state covered is RenderDevice::StateSnapshot: blend enable and function,
 * depth write mask, viewport, scissor enable and box, the active texture unit,
 * the 2D texture on unit 0 and the bound framebuffer.
 *
 * Given the host's baseline (WasmHost::glBaseline — captured by start_render()
 * and kept current by set_window_size()), it restores that on destruction and
 * queries nothing: the state before a preset render is always the state the
 * host itself established, so reading it back every frame bought nothing but a
 * dozen synchronous glGet* calls. Without a baseline (a caller outside the
 * render loop, or before start_render()) it falls back to snapshotting the
 * current state on construction.
 *
 * Usage:
 * @code
 *     {
 *         RenderStateGuard guard(H.glBaseline ? &*H.glBaseline : nullptr);
 *         // … render preset A …
 *     } // state restored here
 * @endcode
 */
class RenderStateGuard
{
public:
    explicit RenderStateGuard(const RenderDevice::StateSnapshot* baseline = nullptr)
        : m_restore(baseline != nullptr ? *baseline : RenderDevice::Commands().CaptureState())
    {
    }

    ~RenderStateGuard()
    {
        RenderDevice::Commands().RestoreState(m_restore);
    }

    // Non-copyable, non-movable.
    RenderStateGuard(const RenderStateGuard&) = delete;
    RenderStateGuard& operator=(const RenderStateGuard&) = delete;
    RenderStateGuard(RenderStateGuard&&) = delete;
    RenderStateGuard& operator=(RenderStateGuard&&) = delete;

private:
    RenderDevice::StateSnapshot m_restore;
};

/**
 * @brief Records a viewport + scissor change the host made itself in its baseline.
 */
inline void SetBaselineViewportAndScissor(RenderDevice::StateSnapshot& baseline, int width, int height)
{
    baseline.viewport = {0, 0, width, height};
    baseline.scissorBox = {0, 0, width, height};
}

/**
 * @brief Forcefully resets blend, texture, and FBO state between two
 *        preset pipeline phases.
 *
 * Call after finishing Preset A's draw and before starting Preset B's draw to
 * prevent Preset A's additive blend/texture state from contaminating Preset B.
 *
 * Resets:
 *   - Blending disabled (One, Zero – opaque replace mode)
 *   - Texture units 0-7 unbound (2D)
 *   - FBO unbound (default framebuffer)
 *   - Depth mask enabled (default)
 */
inline void reset_render_state_between_pipelines()
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
// Phase 5: Compositing Blend Shader
//
// A fullscreen quad shader that blends two preset FBO outputs (Preset A and
// Preset B) into the default framebuffer (browser canvas) using a smooth
// linear crossfade controlled by a [0.0, 1.0] blend factor.
//
// Usage:
//   g_compositorShader.Init();                                   // once, after GL context is ready
//   g_compositorShader.Draw(texA, texB, blend, width, height);   // every frame
// =============================================================================

/**
 * @brief Fullscreen compositing shader that blends two preset FBO textures.
 *
 * Compiles a GLSL ES 3.00 vertex + fragment shader pair, manages a fullscreen
 * triangle-strip VAO/VBO, and blits the result to FBO 0 (the browser canvas).
 *
 * blend == 0.0 → 100% Preset A (plain blit)
 * blend == 1.0 → 100% Preset B
 * 0 < blend < 1 → smooth crossfade
 */
class CompositingBlendShader
{
public:
    CompositingBlendShader() = default;
    CompositingBlendShader(const CompositingBlendShader&) = delete;
    CompositingBlendShader& operator=(const CompositingBlendShader&) = delete;

    // Owners call Release() while the GL context is still current (see
    // destruct() in projectM_emscripten.cpp); by then this is a no-op. It is
    // only a backstop for a host freed without going through destruct().
    ~CompositingBlendShader()
    {
        Release();
    }

    /**
     * @brief Compiles shaders, links program, and uploads the fullscreen quad geometry.
     *
     * Safe to call again (start_render() runs once per render start): the
     * previous program, VAO and VBO are released first rather than leaked.
     *
     * @return true on success; false if compiling or linking failed (program stays uninitialised).
     */
    bool Init()
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

    /**
     * @brief Blends texA and texB into the default framebuffer (screen).
     *
     * @param texA   Preset A Read texture.
     * @param texB   Preset B Read texture; pass an invalid handle when no transition is active.
     * @param blend  Mix factor: 0.0 = full A, 1.0 = full B.
     * @param width  Viewport width in pixels.
     * @param height Viewport height in pixels.
     * @param dither If true, applies an ordered dither + clamp to the output
     *               (use when the source textures are GL_RGBA8, see
     *               FboFloatFormat::RGBA8).
     */
    void Draw(RenderDevice::TextureHandle texA, RenderDevice::TextureHandle texB, float blend, int width, int height, bool dither = false,
              bool transparencyMode = false, float transparencyThreshold = 0.01f)
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

    bool IsInitialized() const
    {
        return m_initialized;
    }

    /**
     * @brief Deletes the program, VAO and VBO and returns to the uninitialised state.
     *
     * Must run while the context that created them is current: GL object ids
     * are global to the Emscripten GL layer, so deleting a stale id under
     * another context raises GL_INVALID_OPERATION there. Idempotent.
     */
    void Release()
    {
        m_program.reset();
        m_vbo.reset();
        m_vao.reset();
        m_initialized = false;
    }

private:
    bool m_initialized = false;
    std::unique_ptr<libprojectM::Renderer::Shader> m_program;
    std::unique_ptr<libprojectM::Renderer::VertexArray> m_vao;
    std::unique_ptr<libprojectM::Renderer::VertexBuffer<libprojectM::Renderer::Point>> m_vbo;
};

// The dual-FBO manager and compositing shader are per-instance state: each
// engine owns its own pair as members of WasmHost (see WasmHost.hpp). TUs reach
// the active host's instances via `auto& g_dualFbo = H.dualFbo;` aliases, so the
// class definitions above stay shared here while the instances are no longer
// process-global.
