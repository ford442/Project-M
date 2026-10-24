/**
 * @file FlashLimiter.hpp
 * @brief Temporal flash limiter: the opt-in safety pass at the end of a frame.
 *
 * When enabled, the frame is presented into a texture owned by this class instead of the
 * target framebuffer. The limiter measures the frame's mean relative luminance on the GPU
 * (a fixed 32x32 downsample, then a 3x1 state pass) and compares it to the luminance of
 * the frame it presented last and to the highest and lowest luminance it presented over
 * the last fraction of a second. If the frame would leave that band by more than the
 * threshold, it is blended (in linear light) toward the frame that was shown before, by
 * just enough to stay within it. The result is copied to the target framebuffer.
 *
 * The whole decision stays on the GPU: nothing is read back per frame, so the limiter
 * adds no CPU/GPU synchronization to a live frame. Only ClampedFrames() reads back (one
 * texel), and only when asked.
 *
 * Disabled (the default), the limiter allocates nothing and ProjectM presents exactly as
 * it did before it existed. Enabled with no frame clamped, the target receives the same
 * bytes as without it. See docs/FLASH_LIMITER.md.
 */
#pragma once

#include "Renderer/OpenGL.h"

#include <array>
#include <cstdint>
#include <memory>

namespace libprojectM {
namespace Renderer {

class Shader;

class FlashLimiter
{
public:
    /**
     * Default threshold: how far, in mean relative luminance (0..1), the presented frames may
     * span within the limiter's memory. WCAG 2.3.1 counts a change of 10% of full scale as
     * half of a flash. Oscillations faster than 3 Hz stay within 1.5 thresholds (see
     * WindowSeconds), so the default keeps them at 9%. See docs/FLASH_LIMITER.md.
     */
    static constexpr float DefaultThreshold{0.06f};

    /**
     * How fast the luminance envelopes relax: one threshold per this many seconds. A third
     * of a second is the period of the "three flashes in one second" WCAG 2.3.1 general
     * flash limit, so in the half period of a 3 Hz oscillation the band moves by half a
     * threshold. Lasting changes come through at threshold / WindowSeconds per second.
     */
    static constexpr double WindowSeconds{1.0 / 3.0};

    FlashLimiter();
    ~FlashLimiter();

    FlashLimiter(const FlashLimiter&) = delete;
    auto operator=(const FlashLimiter&) -> FlashLimiter& = delete;
    FlashLimiter(FlashLimiter&&) = delete;
    auto operator=(FlashLimiter&&) -> FlashLimiter& = delete;

    /**
     * @brief Turns the limiter on or off.
     * Enabling restarts the luminance history and the clamped-frame count. Disabling
     * releases the GPU resources at the next BeginFrame() or destruction.
     */
    void SetEnabled(bool enabled);

    [[nodiscard]] auto Enabled() const -> bool;

    /**
     * @brief Sets the threshold: the span of mean relative luminance (0..1) the presented
     *        frames may cover within the limiter's memory, which also caps every step.
     * Clamped to [0.005, 1]; 1 lets every frame through unchanged.
     */
    void SetThreshold(float threshold);

    [[nodiscard]] auto Threshold() const -> float;

    /**
     * @brief Prepares the frame texture and binds it as the draw framebuffer.
     *
     * Call before drawing the frame that is to be limited. Allocates (or resizes) the
     * limiter's textures on first use. When the limiter is disabled this only releases
     * whatever an earlier enabled frame allocated.
     *
     * @param width Frame width in pixels.
     * @param height Frame height in pixels.
     * @return true if the frame should now be drawn into the bound framebuffer, false if the
     *         limiter is disabled or could not allocate (then present as usual).
     */
    auto BeginFrame(int width, int height) -> bool;

    /**
     * @brief Measures and limits the frame drawn since BeginFrame(), then copies the
     *        result into @p targetFramebuffer.
     *
     * Leaves @p targetFramebuffer bound as the draw framebuffer and the viewport covering
     * the frame. Changes the bound program, textures, samplers and vertex array.
     *
     * @param targetFramebuffer The framebuffer the frame belongs in.
     * @param secondsSinceLastFrame Frame time step: how far the luminance envelopes relax.
     * @param premultipliedAlpha The frame's alpha is coverage with premultiplied colour
     *        (transparency mode), so a limited frame keeps its colour within its alpha.
     *        Otherwise the alpha is passed along and never touches the colour.
     */
    void EndFrame(GLuint targetFramebuffer, double secondsSinceLastFrame, bool premultipliedAlpha = false);

    /**
     * @brief Frames that were blended toward the previous frame since the limiter was
     *        last enabled.
     *
     * Reads one texel back from the GPU when frames were limited since the last call,
     * which waits for those frames to finish rendering. Poll it a few times a second at
     * most, not every frame. Must be called with the GL context current.
     */
    auto ClampedFrames() -> uint32_t;

    /**
     * @brief The framebuffer that holds the last limited frame (the image EndFrame() copied
     *        to its target), or 0 if the limiter has not presented a frame.
     */
    [[nodiscard]] auto PresentedFramebuffer() const -> GLuint;

private:
    struct Target {
        GLuint texture{0};
        GLuint framebuffer{0};
    };

    auto Allocate(int width, int height) -> bool;
    /**
     * @brief Deletes the textures. With @p keepClampedFrames, reads the count back first so
     *        ClampedFrames() still answers afterwards.
     */
    void Release(bool keepClampedFrames = true);
    auto CompileShaders() -> bool;
    void DrawFullscreen(const Target& target, int width, int height) const;
    auto ReadClampedFrames(const Target& state) const -> uint32_t;

    static auto CreateTarget(int width, int height) -> Target;
    static void DeleteTarget(Target& target);

    bool m_enabled{false};
    float m_threshold{DefaultThreshold};

    bool m_allocated{false};
    int m_width{0};
    int m_height{0};
    bool m_resetHistory{true}; //!< Next frame re-seeds the luminance history.

    Target m_frame;                //!< The frame as drawn, before limiting.
    std::array<Target, 2> m_held;  //!< Ping-pong: the previously presented frame, and the next one.
    Target m_luma;                 //!< 32x32 mean luminance cells of m_frame.
    std::array<Target, 2> m_state; //!< Ping-pong 3x1 state: history, blend and clamp count.
    int m_current{0};              //!< Index of the m_held / m_state written last.
    bool m_presented{false};       //!< m_held[m_current] holds a presented frame.

    GLuint m_vertexArray{0}; //!< Empty VAO for attribute-less fullscreen triangles.

    std::unique_ptr<Shader> m_downsampleShader;
    std::unique_ptr<Shader> m_stateShader;
    std::unique_ptr<Shader> m_mixShader;
    bool m_shadersFailed{false};

    uint32_t m_clampedFrames{0};      //!< Last count read back (or carried over a release).
    bool m_clampedFramesStale{false}; //!< Frames were limited since m_clampedFrames was read.
};

} // namespace Renderer
} // namespace libprojectM
