// WasmGraphics.hpp
//
// Dual ping-pong FBO architecture, RAII render-state guard, and the fullscreen
// compositing/crossfade shader used by the WASM preset-transition system.
//
// Declarations only; the implementation is in WasmGraphics.cpp. The class
// definitions stay in a header because WasmHost holds one DualPingPongFramebuffer
// and one CompositingBlendShader by value per host, and the render loop
// (WasmRenderLoop.cpp) and the dual-FBO exports (WasmDualFbo.cpp) both use them.
//
// Everything here draws through libprojectM's render device (see
// docs/RENDER_DEVICE.md), not GL directly: the same seam the engine uses, so a
// second backend covers the host layer too.
#pragma once

#include <Renderer/Device/RenderDevice.hpp>

#include <array>
#include <memory>
#include <utility>

namespace libprojectM {
namespace Renderer {
class Point;
class Shader;
class VertexArray;
template<class VT>
class VertexBuffer;
} // namespace Renderer
} // namespace libprojectM

struct WasmContextCaps;

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
    ~DualPingPongFramebuffer();

    DualPingPongFramebuffer(const DualPingPongFramebuffer&) = delete;
    DualPingPongFramebuffer& operator=(const DualPingPongFramebuffer&) = delete;

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
    void DetectFormat(const WasmContextCaps& caps, int precisionMode = 0);

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
    bool AllocatePresetA(int width, int height);

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
    bool AllocatePresetB(int width, int height);

    /**
     * @brief Releases the Preset B FBOs without affecting Preset A.
     *
     * Call when a transition is cancelled or after PromoteBtoA() has
     * transferred ownership.
     */
    void ReleasePresetB();

    /**
     * @brief Releases the Preset A FBOs without affecting Preset B.
     *
     * Preset A is pure crossfade scratch: steady-state playback renders straight
     * to the default framebuffer (see ShouldUseDualFboCompositor()), so between
     * transitions nothing samples these surfaces and they can be reclaimed.
     * Width()/Height() are deliberately preserved so a later
     * dual_fbo_begin_transition() can re-allocate at the right size.
     */
    void ReleasePresetA();

    /**
     * @brief Releases all allocated FBOs. Called automatically by the destructor.
     */
    void ReleaseAll();

    /**
     * @brief Promotes Preset B's FBOs into the Preset A slots after a transition completes.
     *
     * Old Preset A FBOs are deleted; Preset B's FBOs take their place.
     * After this call Preset B is no longer allocated and Preset A holds the
     * former Preset B resources.
     */
    void PromoteBtoA();

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
    void Resize(int width, int height);

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
    //! The texture description for the detected float format.
    RenderDevice::TextureDesc GetTextureDesc(int width, int height) const;

    //! Creates the FBO and colour texture at a slot; false if the framebuffer is incomplete.
    bool CreateFBO(int index, int width, int height);

    //! CreateFBO(), and on an incomplete float framebuffer, RGBA8 from then on.
    bool CreateFBOWithFallback(int index, int width, int height);

    //! Deletes the FBO and texture at a slot and resets both handles.
    void ReleaseFBO(int index);

    //! Re-specifies a slot's texture at new dimensions and re-attaches it.
    void ResizeFBOTexture(int index, int width, int height);

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
    explicit RenderStateGuard(const RenderDevice::StateSnapshot* baseline = nullptr);
    ~RenderStateGuard();

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
void reset_render_state_between_pipelines();

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
    CompositingBlendShader();
    CompositingBlendShader(const CompositingBlendShader&) = delete;
    CompositingBlendShader& operator=(const CompositingBlendShader&) = delete;

    // Owners call Release() while the GL context is still current (see
    // destruct() in projectM_emscripten.cpp); by then this is a no-op. It is
    // only a backstop for a host freed without going through destruct().
    ~CompositingBlendShader();

    /**
     * @brief Compiles shaders, links program, and uploads the fullscreen quad geometry.
     *
     * Safe to call again (start_render() runs once per render start): the
     * previous program, VAO and VBO are released first rather than leaked.
     *
     * @return true on success; false if compiling or linking failed (program stays uninitialised).
     */
    bool Init();

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
              bool transparencyMode = false, float transparencyThreshold = 0.01f);

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
    void Release();

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
