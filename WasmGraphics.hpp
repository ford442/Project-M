// WasmGraphics.hpp
//
// Dual ping-pong FBO architecture, RAII GL state guard, and the fullscreen
// compositing/crossfade shader used by the WASM preset-transition system.
//
// These types are defined in a header (rather than a .cpp) because both the
// render loop in projectM_emscripten.cpp and the dual-FBO C exports in
// WasmDualFbo.cpp operate on the shared g_dualFbo / g_compositorShader
// instances. The instances themselves are defined once in WasmDualFbo.cpp.
#pragma once

#include "ProjectMWasmInternal.hpp"

// =============================================================================
// Phase 2: Dual Ping-Pong FBO Architecture with Floating-Point Texture Support
// =============================================================================

/**
 * @brief Available floating-point texture formats for FBO color attachments.
 *
 * Preference order:
 *   RGBA16F – 16-bit half-float per channel (requires EXT_color_buffer_half_float)
 *   RGBA32F – full 32-bit float per channel (requires EXT_color_buffer_float, optional on wasm)
 *   RGBA8   – 8-bit normalized (always available; shaders must clamp output to [0,1])
 */
enum class FboFloatFormat
{
    RGBA32F, //!< GL_RGBA32F – optional high-precision mode for recursive warp feedback loops
    RGBA16F, //!< GL_RGBA16F – default on capable GPUs (better bandwidth/VRAM tradeoff)
    RGBA8    //!< GL_RGBA8   – last resort; negative alpha corruption possible without clamping
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
 * Preset B FBOs are only allocated when a transition is actively initiated and
 * are released (or promoted to Preset A) when the transition completes.
 */
class DualPingPongFramebuffer
{
public:
    static constexpr int kARead  = 0; //!< Preset A read  (history) slot
    static constexpr int kAWrite = 1; //!< Preset A write (current) slot
    static constexpr int kBRead  = 2; //!< Preset B read  (history) slot
    static constexpr int kBWrite = 3; //!< Preset B write (current) slot

    DualPingPongFramebuffer() = default;

    ~DualPingPongFramebuffer()
    {
        ReleaseAll();
    }

    /**
     * @brief Detects the best available float texture format by probing WebGL extensions.
     *
     * Call once after the WebGL context has been made current and before any FBO
     * allocation. Default priority: GL_RGBA16F (EXT_color_buffer_half_float) >
     * GL_RGBA32F (EXT_color_buffer_float) > GL_RGBA8. If @p preferHighPrecision
     * is true, RGBA32F is preferred over RGBA16F.
     *
     * @param ctx The active Emscripten WebGL context handle.
     * @param preferHighPrecision Whether RGBA32F should be preferred over RGBA16F.
     */
    void DetectFormat(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx, bool preferHighPrecision = false)
    {
        const bool hasFloat = (emscripten_webgl_enable_extension(ctx, "EXT_color_buffer_float") == EM_TRUE);
        const bool hasHalfFloat = (emscripten_webgl_enable_extension(ctx, "EXT_color_buffer_half_float") == EM_TRUE);

        if (preferHighPrecision && hasFloat)
        {
            m_format = FboFloatFormat::RGBA32F;
            // Enable bilinear filtering on float textures when available.
            emscripten_webgl_enable_extension(ctx, "OES_texture_float_linear");
            printf("DualFBO: Using GL_RGBA32F float textures (high-precision opt-in).\n");
        }
        else if (hasHalfFloat)
        {
            m_format = FboFloatFormat::RGBA16F;
            emscripten_webgl_enable_extension(ctx, "OES_texture_half_float_linear");
            printf("DualFBO: Using GL_RGBA16F half-float textures (default).\n");
        }
        else if (hasFloat)
        {
            m_format = FboFloatFormat::RGBA32F;
            emscripten_webgl_enable_extension(ctx, "OES_texture_float_linear");
            printf("DualFBO: Using GL_RGBA32F float textures (RGBA16F unavailable).\n");
        }
        else
        {
            m_format = FboFloatFormat::RGBA8;
            printf("DualFBO: Float textures unavailable, falling back to GL_RGBA8 (degraded mode).\n");
            printf("DualFBO: WARNING – recursive warp/feedback presets may show banding; output is dithered/clamped in CompositingBlendShader.\n");
            printf("DualFBO: Host page can query this via Module._dual_fbo_get_format() (2 == RGBA8).\n");
        }
    }

    /**
     * @brief Allocates the Preset A ping-pong FBO pair.
     *
     * Must be called once after the WebGL context is ready and DetectFormat()
     * has been invoked. Safe to call again after a Resize() – dimensions are
     * updated but no re-allocation occurs.
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

        m_width  = width;
        m_height = height;

        if (!CreateFBO(kARead, width, height) || !CreateFBO(kAWrite, width, height))
        {
            ReleaseFBO(kARead);
            ReleaseFBO(kAWrite);
            fprintf(stderr, "DualFBO: Failed to allocate Preset A FBOs.\n");
            return false;
        }

        m_presetAAllocated = true;
        printf("DualFBO: Preset A FBOs allocated (%dx%d).\n", width, height);
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

        if (!CreateFBO(kBRead, width, height) || !CreateFBO(kBWrite, width, height))
        {
            ReleaseFBO(kBRead);
            ReleaseFBO(kBWrite);
            fprintf(stderr, "DualFBO: Failed to allocate Preset B FBOs.\n");
            return false;
        }

        m_presetBAllocated = true;
        printf("DualFBO: Preset B FBOs allocated (%dx%d).\n", width, height);
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
        printf("DualFBO: Preset B FBOs released.\n");
    }

    /**
     * @brief Releases all allocated FBOs. Called automatically by the destructor.
     */
    void ReleaseAll()
    {
        ReleasePresetB();
        if (m_presetAAllocated)
        {
            ReleaseFBO(kARead);
            ReleaseFBO(kAWrite);
            m_presetAAllocated = false;
            printf("DualFBO: Preset A FBOs released.\n");
        }
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
        m_fbos[kARead]      = m_fbos[kBRead];
        m_fbos[kAWrite]     = m_fbos[kBWrite];
        m_textures[kARead]  = m_textures[kBRead];
        m_textures[kAWrite] = m_textures[kBWrite];

        // Clear Preset B slots (ownership transferred; do not delete).
        m_fbos[kBRead]      = 0;
        m_fbos[kBWrite]     = 0;
        m_textures[kBRead]  = 0;
        m_textures[kBWrite] = 0;

        m_presetAAllocated = true;
        m_presetBAllocated = false;
        printf("DualFBO: Preset B promoted to Preset A.\n");
    }

    /**
     * @brief Swaps the Read/Write FBOs for Preset A (ping-pong).
     *
     * Call once per frame while Preset A is rendering so that the previous
     * frame's output becomes the new frame's history texture.
     */
    void SwapPresetA()
    {
        std::swap(m_fbos[kARead],      m_fbos[kAWrite]);
        std::swap(m_textures[kARead],  m_textures[kAWrite]);
    }

    /**
     * @brief Swaps the Read/Write FBOs for Preset B (ping-pong).
     *
     * Call once per frame during a transition.
     */
    void SwapPresetB()
    {
        std::swap(m_fbos[kBRead],      m_fbos[kBWrite]);
        std::swap(m_textures[kBRead],  m_textures[kBWrite]);
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

        m_width  = width;
        m_height = height;

        if (m_presetAAllocated)
        {
            ResizeFBOTexture(kARead,  width, height);
            ResizeFBOTexture(kAWrite, width, height);
        }
        if (m_presetBAllocated)
        {
            ResizeFBOTexture(kBRead,  width, height);
            ResizeFBOTexture(kBWrite, width, height);
        }

        printf("DualFBO: Resized to %dx%d.\n", width, height);
    }

    // -------------------------------------------------------------------------
    // Accessor functions – return raw OpenGL handles for use in render passes.
    // -------------------------------------------------------------------------
    GLuint GetAReadFBO()    const { return m_fbos[kARead]; }
    GLuint GetAWriteFBO()   const { return m_fbos[kAWrite]; }
    GLuint GetAReadTex()    const { return m_textures[kARead]; }
    GLuint GetAWriteTex()   const { return m_textures[kAWrite]; }

    GLuint GetBReadFBO()    const { return m_fbos[kBRead]; }
    GLuint GetBWriteFBO()   const { return m_fbos[kBWrite]; }
    GLuint GetBReadTex()    const { return m_textures[kBRead]; }
    GLuint GetBWriteTex()   const { return m_textures[kBWrite]; }

    bool IsPresetAAllocated() const { return m_presetAAllocated; }
    bool IsPresetBAllocated() const { return m_presetBAllocated; }

    FboFloatFormat GetFormat() const { return m_format; }
    int Width()  const { return m_width; }
    int Height() const { return m_height; }

private:
    // -------------------------------------------------------------------------
    // Helper: return the GL internal format for the detected float format.
    // -------------------------------------------------------------------------
    GLint GetGLInternalFormat() const
    {
        switch (m_format)
        {
            case FboFloatFormat::RGBA32F: return GL_RGBA32F;
            case FboFloatFormat::RGBA16F: return GL_RGBA16F;
            case FboFloatFormat::RGBA8:   return GL_RGBA8;
            default:
                fprintf(stderr, "DualFBO: Unknown FboFloatFormat; falling back to GL_RGBA8.\n");
                return GL_RGBA8;
        }
    }

    GLenum GetGLFormat() const { return GL_RGBA; }

    GLenum GetGLType() const
    {
        switch (m_format)
        {
            case FboFloatFormat::RGBA32F: return GL_FLOAT;
            case FboFloatFormat::RGBA16F: return GL_HALF_FLOAT;
            case FboFloatFormat::RGBA8:   return GL_UNSIGNED_BYTE;
            default:
                fprintf(stderr, "DualFBO: Unknown FboFloatFormat; falling back to GL_UNSIGNED_BYTE.\n");
                return GL_UNSIGNED_BYTE;
        }
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
        glGenTextures(1, &m_textures[index]);
        glBindTexture(GL_TEXTURE_2D, m_textures[index]);
        glTexImage2D(GL_TEXTURE_2D, 0,
                     GetGLInternalFormat(), width, height, 0,
                     GetGLFormat(), GetGLType(), nullptr);
        ConfigureTextureSampling(m_textures[index]);

        glGenFramebuffers(1, &m_fbos[index]);
        glBindFramebuffer(GL_FRAMEBUFFER, m_fbos[index]);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                               GL_TEXTURE_2D, m_textures[index], 0);

        GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);

        if (status != GL_FRAMEBUFFER_COMPLETE)
        {
            fprintf(stderr, "DualFBO: Framebuffer slot %d incomplete (status=0x%x).\n",
                    index, status);
            glDeleteTextures(1, &m_textures[index]);
            glDeleteFramebuffers(1, &m_fbos[index]);
            m_textures[index] = 0;
            m_fbos[index]     = 0;
            return false;
        }

        return true;
    }

    /**
     * @brief Deletes the FBO and its texture at the given slot and resets handles to 0.
     */
    void ReleaseFBO(int index)
    {
        if (m_fbos[index] != 0)
        {
            glDeleteFramebuffers(1, &m_fbos[index]);
            m_fbos[index] = 0;
        }
        if (m_textures[index] != 0)
        {
            glDeleteTextures(1, &m_textures[index]);
            m_textures[index] = 0;
        }
    }

    /**
     * @brief Reallocates the colour texture for a slot at new dimensions.
     *
     * The FBO handle itself is reused; only the texture storage is replaced
     * and re-attached.
     */
    void ResizeFBOTexture(int index, int width, int height)
    {
        if (m_textures[index] == 0)
        {
            return;
        }
        glBindTexture(GL_TEXTURE_2D, m_textures[index]);
        glTexImage2D(GL_TEXTURE_2D, 0,
                     GetGLInternalFormat(), width, height, 0,
                     GetGLFormat(), GetGLType(), nullptr);
        ConfigureTextureSampling(m_textures[index]);

        // Re-attach the resized texture to the FBO.
        glBindFramebuffer(GL_FRAMEBUFFER, m_fbos[index]);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                               GL_TEXTURE_2D, m_textures[index], 0);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }

    /**
     * @brief Sets the standard sampler parameters (linear filtering, edge clamp) on a
     *        currently-bound 2D texture. Assumes the texture is already bound.
     *
     * @param texId The texture whose parameters to configure (used only for clarity;
     *              the call operates on the currently bound GL_TEXTURE_2D target).
     */
    void ConfigureTextureSampling(GLuint texId)
    {
        (void)texId; // The texture must be bound before calling this helper.
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glBindTexture(GL_TEXTURE_2D, 0);
    }

    GLuint m_fbos[4]     = {0, 0, 0, 0}; //!< FBO IDs:     [A_Read, A_Write, B_Read, B_Write]
    GLuint m_textures[4] = {0, 0, 0, 0}; //!< Texture IDs: [A_Read, A_Write, B_Read, B_Write]

    int m_width  = 0; //!< Current FBO texture width in pixels
    int m_height = 0; //!< Current FBO texture height in pixels

    bool m_presetAAllocated = false; //!< Whether Preset A FBOs are currently allocated
    bool m_presetBAllocated = false; //!< Whether Preset B FBOs are currently allocated

    FboFloatFormat m_format = FboFloatFormat::RGBA8; //!< Detected colour format for textures
};

// =============================================================================
// Phase 3: GLStateGuard – RAII WebGL state save/restore for preset isolation
// =============================================================================

/**
 * @brief RAII guard that snapshots relevant WebGL state on construction and
 *        restores it on destruction.
 *
 * Usage:
 * @code
 *     {
 *         GLStateGuard guard;
 *         // … render preset A …
 *     } // state automatically restored here
 * @endcode
 *
 * Saved/restored state:
 *   - GL_BLEND enabled flag
 *   - Blend function (src/dst RGB + Alpha)
 *   - GL_DEPTH_WRITEMASK
 *   - GL_VIEWPORT
 *   - GL_SCISSOR_TEST enabled flag
 *   - GL_SCISSOR_BOX
 *   - GL_ACTIVE_TEXTURE unit
 *   - GL_TEXTURE_BINDING_2D on texture unit 0
 *   - GL_FRAMEBUFFER_BINDING
 */
class GLStateGuard
{
public:
    GLStateGuard()
    {
        // --- Blend state ---
        m_blendEnabled = glIsEnabled(GL_BLEND);
        glGetIntegerv(GL_BLEND_SRC_RGB,   &m_blendSrcRGB);
        glGetIntegerv(GL_BLEND_DST_RGB,   &m_blendDstRGB);
        glGetIntegerv(GL_BLEND_SRC_ALPHA, &m_blendSrcAlpha);
        glGetIntegerv(GL_BLEND_DST_ALPHA, &m_blendDstAlpha);

        // --- Depth mask ---
        glGetBooleanv(GL_DEPTH_WRITEMASK, &m_depthMask);

        // --- Viewport ---
        glGetIntegerv(GL_VIEWPORT, m_viewport);

        // --- Scissor ---
        m_scissorEnabled = glIsEnabled(GL_SCISSOR_TEST);
        glGetIntegerv(GL_SCISSOR_BOX, m_scissorBox);

        // --- Active texture unit ---
        glGetIntegerv(GL_ACTIVE_TEXTURE, &m_activeTexture);

        // --- Texture binding on unit 0 ---
        glActiveTexture(GL_TEXTURE0);
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &m_tex0Binding);
        // Restore the originally active texture unit immediately.
        glActiveTexture(static_cast<GLenum>(m_activeTexture));

        // --- FBO binding ---
        glGetIntegerv(GL_FRAMEBUFFER_BINDING, &m_fboBinding);
    }

    ~GLStateGuard()
    {
        // --- FBO binding ---
        glBindFramebuffer(GL_FRAMEBUFFER, static_cast<GLuint>(m_fboBinding));

        // --- Blend state ---
        if (m_blendEnabled)
            glEnable(GL_BLEND);
        else
            glDisable(GL_BLEND);
        glBlendFuncSeparate(static_cast<GLenum>(m_blendSrcRGB),
                            static_cast<GLenum>(m_blendDstRGB),
                            static_cast<GLenum>(m_blendSrcAlpha),
                            static_cast<GLenum>(m_blendDstAlpha));

        // --- Depth mask ---
        glDepthMask(m_depthMask);

        // --- Viewport ---
        glViewport(m_viewport[0], m_viewport[1], m_viewport[2], m_viewport[3]);

        // --- Scissor ---
        if (m_scissorEnabled)
            glEnable(GL_SCISSOR_TEST);
        else
            glDisable(GL_SCISSOR_TEST);
        glScissor(m_scissorBox[0], m_scissorBox[1], m_scissorBox[2], m_scissorBox[3]);

        // --- Texture unit 0 binding ---
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(m_tex0Binding));

        // --- Active texture unit ---
        glActiveTexture(static_cast<GLenum>(m_activeTexture));
    }

    // Non-copyable, non-movable.
    GLStateGuard(const GLStateGuard&)            = delete;
    GLStateGuard& operator=(const GLStateGuard&) = delete;
    GLStateGuard(GLStateGuard&&)                 = delete;
    GLStateGuard& operator=(GLStateGuard&&)      = delete;

private:
    GLboolean m_blendEnabled   = GL_FALSE;
    GLint     m_blendSrcRGB    = GL_ONE;
    GLint     m_blendDstRGB    = GL_ZERO;
    GLint     m_blendSrcAlpha  = GL_ONE;
    GLint     m_blendDstAlpha  = GL_ZERO;
    GLboolean m_depthMask      = GL_TRUE;
    GLint     m_viewport[4]    = {0, 0, 0, 0};
    GLboolean m_scissorEnabled = GL_FALSE;
    GLint     m_scissorBox[4]  = {0, 0, 0, 0};
    GLint     m_activeTexture  = GL_TEXTURE0;
    GLint     m_tex0Binding    = 0;
    GLint     m_fboBinding     = 0;
};

/**
 * @brief Forcefully resets OpenGL blend, texture, and FBO state between two
 *        preset pipeline phases.
 *
 * Call after finishing Preset A's draw and before starting Preset B's draw to
 * prevent Preset A's additive blend/texture state from contaminating Preset B.
 *
 * Resets:
 *   - Blending disabled (GL_ONE, GL_ZERO – opaque replace mode)
 *   - Texture units 0-7 unbound (GL_TEXTURE_2D)
 *   - FBO unbound (default framebuffer)
 *   - Depth mask enabled (default)
 */
static void gl_reset_state_between_pipelines()
{
    // Covers all texture units accessed by projectM shaders (warp, composite, blur, etc.).
    static constexpr int kMaxProjectMTextureUnits = 8;

    // Disable blending; reset to opaque replace mode.
    glDisable(GL_BLEND);
    glBlendFunc(GL_ONE, GL_ZERO);

    // Unbind textures on the first kMaxProjectMTextureUnits units.
    for (int unit = 0; unit < kMaxProjectMTextureUnits; ++unit)
    {
        glActiveTexture(static_cast<GLenum>(GL_TEXTURE0 + unit));
        glBindTexture(GL_TEXTURE_2D, 0);
    }
    glActiveTexture(GL_TEXTURE0); // Leave active unit at 0 as a clean default.

    // Reset depth mask.
    glDepthMask(GL_TRUE);

    // Unbind any FBO (render to default framebuffer).
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
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
    /**
     * @brief Compiles shaders, links program, and uploads the fullscreen quad geometry.
     * @return true on success; false if any GL call failed (program stays uninitialised).
     */
    bool Init()
    {
        // GLSL ES 3.00 vertex shader: maps NDC positions and derives UV coords.
        static const char* kVertSrc = R"(#version 300 es
in vec2 aPosition;
out vec2 vTexCoord;
void main() {
    vTexCoord = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
)";

        // GLSL ES 3.00 fragment shader: blends two textures with mix().
        //
        // uDither is set to 1.0 only when the dual-FBO source textures are
        // GL_RGBA8 (see FboFloatFormat::RGBA8 / DetectFormat()). RGBA8
        // intermediate textures accumulate visible 8-bit banding in
        // recursive warp/feedback presets; an ordered dither breaks up that
        // banding in the final on-screen image without requiring any preset
        // shader changes. clamp() guards against out-of-range values landing
        // on the (always 8-bit) canvas regardless of source format.
        static const char* kFragSrc = R"(#version 300 es
precision highp float;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uBlend;
uniform float uDither;
uniform int u_transparencyEnabled;
uniform float u_transparencyThreshold;
in vec2 vTexCoord;
out vec4 fragColor;

// 4x4 Bayer ordered-dither matrix, normalized to [-0.5, 0.5] / 255.
const float kBayer[16] = float[16](
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
);

void main() {
    vec4 colorA = texture(uTexA, vTexCoord);
    vec4 colorB = texture(uTexB, vTexCoord);
    vec4 color = mix(colorA, colorB, uBlend);

    if (uDither > 0.5) {
        ivec2 p = ivec2(mod(gl_FragCoord.xy, 4.0));
        float threshold = (kBayer[p.y * 4 + p.x] / 16.0 - 0.5) / 255.0;
        color.rgb += threshold;
    }

    fragColor = clamp(color, 0.0, 1.0);

    if (u_transparencyEnabled > 0) {
        float maxComponent = max(max(fragColor.r, fragColor.g), fragColor.b);
        if (maxComponent < u_transparencyThreshold) {
            fragColor = vec4(0.0, 0.0, 0.0, 0.0);
        }
    }
}
)";

        GLuint vert = CompileShader(GL_VERTEX_SHADER, kVertSrc);
        if (!vert)
        {
            return false;
        }
        GLuint frag = CompileShader(GL_FRAGMENT_SHADER, kFragSrc);
        if (!frag)
        {
            glDeleteShader(vert);
            return false;
        }

        m_program = glCreateProgram();
        glAttachShader(m_program, vert);
        glAttachShader(m_program, frag);
        glLinkProgram(m_program);
        glDeleteShader(vert);
        glDeleteShader(frag);

        GLint linked = GL_FALSE;
        glGetProgramiv(m_program, GL_LINK_STATUS, &linked);
        if (!linked)
        {
            GLint len = 0;
            glGetProgramiv(m_program, GL_INFO_LOG_LENGTH, &len);
            std::vector<char> log(static_cast<size_t>(len) + 1u);
            glGetProgramInfoLog(m_program, len, nullptr, log.data());
            fprintf(stderr, "CompositingBlendShader: link error: %s\n", log.data());
            glDeleteProgram(m_program);
            m_program = 0;
            return false;
        }

        // Cache uniform / attribute locations.
        m_locTexA   = glGetUniformLocation(m_program, "uTexA");
        m_locTexB   = glGetUniformLocation(m_program, "uTexB");
        m_locBlend  = glGetUniformLocation(m_program, "uBlend");
        m_locDither = glGetUniformLocation(m_program, "uDither");
        m_locTransparencyEnabled = glGetUniformLocation(m_program, "u_transparencyEnabled");
        m_locTransparencyThreshold = glGetUniformLocation(m_program, "u_transparencyThreshold");
        m_locPos    = glGetAttribLocation(m_program, "aPosition");

        // Fullscreen triangle-strip quad in NDC (CCW winding):
        //   (-1,-1)  (1,-1)  (-1,1)  (1,1)
        static const GLfloat kQuad[8] = {
            -1.0f, -1.0f,
             1.0f, -1.0f,
            -1.0f,  1.0f,
             1.0f,  1.0f,
        };

        glGenVertexArrays(1, &m_vao);
        glGenBuffers(1, &m_vbo);
        glBindVertexArray(m_vao);
        glBindBuffer(GL_ARRAY_BUFFER, m_vbo);
        glBufferData(GL_ARRAY_BUFFER, sizeof(kQuad), kQuad, GL_STATIC_DRAW);
        if (m_locPos >= 0)
        {
            glEnableVertexAttribArray(static_cast<GLuint>(m_locPos));
            glVertexAttribPointer(static_cast<GLuint>(m_locPos), 2, GL_FLOAT, GL_FALSE, 0, nullptr);
        }
        glBindVertexArray(0);
        glBindBuffer(GL_ARRAY_BUFFER, 0);

        m_initialized = true;
        fprintf(stderr, "CompositingBlendShader: initialized successfully.\n");
        return true;
    }

    /**
     * @brief Blends texA and texB into the default framebuffer (screen).
     *
     * @param texA   Preset A Read texture (GL_TEXTURE_2D handle).
     * @param texB   Preset B Read texture; pass 0 when no transition is active.
     * @param blend  Mix factor: 0.0 = full A, 1.0 = full B.
     * @param width  Viewport width in pixels.
     * @param height Viewport height in pixels.
     * @param dither If true, applies an ordered dither + clamp to the output
     *               (use when the source textures are GL_RGBA8, see
     *               FboFloatFormat::RGBA8).
     */
    void Draw(GLuint texA, GLuint texB, float blend, int width, int height, bool dither = false,
              bool transparencyMode = false, float transparencyThreshold = 0.01f)
    {
        if (!m_initialized || m_program == 0)
        {
            return;
        }

        // Render to the default framebuffer (browser canvas).
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glViewport(0, 0, width, height);
        glDisable(GL_BLEND);
        glDisable(GL_DEPTH_TEST);
        glDepthMask(GL_FALSE);
        glDisable(GL_SCISSOR_TEST);

        glUseProgram(m_program);

        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, texA);
        glUniform1i(m_locTexA, 0);

        // Fall back to texA when texB is 0 (no-transition blit).
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D, texB != 0u ? texB : texA);
        glUniform1i(m_locTexB, 1);

        glUniform1f(m_locBlend, blend);
        glUniform1f(m_locDither, dither ? 1.0f : 0.0f);
        if (m_locTransparencyEnabled >= 0)
        {
            glUniform1i(m_locTransparencyEnabled, transparencyMode ? 1 : 0);
        }
        if (m_locTransparencyThreshold >= 0)
        {
            glUniform1f(m_locTransparencyThreshold, transparencyThreshold);
        }

        glBindVertexArray(m_vao);
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
        glBindVertexArray(0);

        // Clean up texture bindings.
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D, 0);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, 0);

        glUseProgram(0);
    }

    bool IsInitialized() const { return m_initialized; }

private:
    static GLuint CompileShader(GLenum type, const char* src)
    {
        GLuint shader = glCreateShader(type);
        glShaderSource(shader, 1, &src, nullptr);
        glCompileShader(shader);

        GLint compiled = GL_FALSE;
        glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
        if (!compiled)
        {
            GLint len = 0;
            glGetShaderiv(shader, GL_INFO_LOG_LENGTH, &len);
            std::vector<char> log(static_cast<size_t>(len) + 1u);
            glGetShaderInfoLog(shader, len, nullptr, log.data());
            fprintf(stderr, "CompositingBlendShader: compile error (%s): %s\n",
                    type == GL_VERTEX_SHADER ? "vert" : "frag", log.data());
            glDeleteShader(shader);
            return 0;
        }
        return shader;
    }

    bool   m_initialized = false;
    GLuint m_program     = 0;
    GLuint m_vao         = 0;
    GLuint m_vbo         = 0;
    GLint  m_locTexA     = -1;
    GLint  m_locTexB     = -1;
    GLint  m_locBlend    = -1;
    GLint  m_locDither   = -1;
    GLint  m_locTransparencyEnabled = -1;
    GLint  m_locTransparencyThreshold = -1;
    GLint  m_locPos      = -1;
};

// Shared instances (defined in WasmDualFbo.cpp).
extern DualPingPongFramebuffer g_dualFbo;
extern CompositingBlendShader g_compositorShader;
