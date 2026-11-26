/**
 * @file UniformBlocks.hpp
 * @brief The std140 uniform blocks of the built-in shaders, their buffer slots and C++ mirrors.
 *
 * Every value a built-in program reads that is not a texture is a member of one std140 block,
 * written per draw to the device's UniformRingBuffer and bound to the block's slot: WebGPU's
 * model, where a shader has no default-block uniforms. A struct here is its block byte for byte
 * (the static_asserts check the std140 offsets; UniformBlockLayoutTest checks them against the
 * linked GL programs). A block that two stages of one program both declare is declared the same
 * way in both. See docs/RENDER_DEVICE.md "Uniform buffers".
 *
 * Sampler uniforms (which texture unit a sampler2D reads) are not values and stay plain
 * uniforms on GL; on WebGPU they are bind group entries.
 */
#pragma once

#include "Renderer/Device/RenderDevice.hpp"
#include "Renderer/UniformRingBuffer.hpp"

#include <glm/mat4x4.hpp>
#include <glm/vec2.hpp>
#include <glm/vec3.hpp>
#include <glm/vec4.hpp>

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>

namespace libprojectM {
namespace Renderer {

/**
 * @brief The uniform buffer slots blocks are bound to.
 *
 * A program reads at most one block per slot: the preset shaders' per-frame block, the draw's
 * own block (one per built-in program) and the GPU per-pixel path's block.
 */
namespace UniformSlot {
constexpr int Frame = 0;    //!< _milkdrop_frame (MilkdropPreset::MilkdropFrameUniforms).
constexpr int Draw = 1;     //!< The built-in program's own block (the structs below).
constexpr int PerPixel = 2; //!< _pm_per_pixel (MilkdropPreset::PerPixelUniforms).
} // namespace UniformSlot

/**
 * @brief A block name and the slot every program that declares it reads it from.
 */
struct UniformBlockBinding {
    const char* name;
    int slot;
};

/**
 * @brief Every built-in block. Shader binds each one a program declares after every link.
 */
inline constexpr std::array<UniformBlockBinding, 11> BuiltInUniformBlocks{{
    {"_milkdrop_frame", UniformSlot::Frame},
    {"_pm_transform", UniformSlot::Draw},
    {"_pm_copy", UniformSlot::Draw},
    {"_pm_motion_vectors", UniformSlot::Draw},
    {"_pm_warp", UniformSlot::Draw},
    {"_pm_blur", UniformSlot::Draw},
    {"_pm_transition", UniformSlot::Draw},
    {"_pm_flash_limiter", UniformSlot::Draw},
    {"_pm_sprite", UniformSlot::Draw},
    {"_pm_compositor", UniformSlot::Draw},
    {"_pm_per_pixel", UniformSlot::PerPixel},
}};

/**
 * @brief <tt>_pm_transform</tt>: the textured and untextured draw shaders (shapes, waves,
 *        borders, filters, darken center, video echo).
 */
struct alignas(16) TransformUniforms {
    static constexpr const char* BlockName = "_pm_transform";
    static constexpr int Slot = UniformSlot::Draw;

    glm::mat4 vertexTransformation{1.0f}; //!< vertex_transformation
    float vertexPointSize{1.0f};          //!< vertex_point_size
};
static_assert(offsetof(TransformUniforms, vertexPointSize) == 64);
static_assert(sizeof(TransformUniforms) == 80);

/**
 * @brief <tt>_pm_copy</tt>: CopyTexture's shader path, both stages.
 */
struct alignas(16) CopyUniforms {
    static constexpr const char* BlockName = "_pm_copy";
    static constexpr int Slot = UniformSlot::Draw;

    glm::mat4 vertexTransformation{1.0f}; //!< vertex_transformation
    int32_t transparencyEnabled{};        //!< u_transparencyEnabled
    float transparencyThreshold{};        //!< u_transparencyThreshold
};
static_assert(offsetof(CopyUniforms, transparencyEnabled) == 64);
static_assert(offsetof(CopyUniforms, transparencyThreshold) == 68);
static_assert(sizeof(CopyUniforms) == 80);

/**
 * @brief <tt>_pm_motion_vectors</tt>: the motion vector grid.
 */
struct alignas(16) MotionVectorUniforms {
    static constexpr const char* BlockName = "_pm_motion_vectors";
    static constexpr int Slot = UniformSlot::Draw;

    glm::mat4 vertexTransformation{1.0f}; //!< vertex_transformation
    float lengthMultiplier{};             //!< length_multiplier
    float minimumLength{};                //!< minimum_length
};
static_assert(offsetof(MotionVectorUniforms, lengthMultiplier) == 64);
static_assert(offsetof(MotionVectorUniforms, minimumLength) == 68);
static_assert(sizeof(MotionVectorUniforms) == 80);

/**
 * @brief <tt>_pm_warp</tt>: the warp mesh's vertex shader (default and preset warp shaders) and
 *        the default warp fragment shader.
 */
struct alignas(16) WarpUniforms {
    static constexpr const char* BlockName = "_pm_warp";
    static constexpr int Slot = UniformSlot::Draw;

    glm::mat4 vertexTransformation{1.0f}; //!< vertex_transformation
    glm::vec4 aspect{};                   //!< aspect: aspectX, aspectY, invAspectX, invAspectY
    glm::vec4 warpFactors{};              //!< warpFactors
    glm::vec2 texelOffset{};              //!< texelOffset
    float warpTime{};                     //!< warpTime
    float warpScaleInverse{};             //!< warpScaleInverse
    float decay{};                        //!< decay
    int32_t flipMainTex{};                //!< u_flipMainTex (default warp fragment shader)
};
static_assert(offsetof(WarpUniforms, aspect) == 64);
static_assert(offsetof(WarpUniforms, warpFactors) == 80);
static_assert(offsetof(WarpUniforms, texelOffset) == 96);
static_assert(offsetof(WarpUniforms, warpTime) == 104);
static_assert(offsetof(WarpUniforms, warpScaleInverse) == 108);
static_assert(offsetof(WarpUniforms, decay) == 112);
static_assert(offsetof(WarpUniforms, flipMainTex) == 116);
static_assert(sizeof(WarpUniforms) == 128);

/**
 * @brief <tt>_pm_blur</tt>: both blur programs. The first pass reads _c0.._c3, the second
 *        _c0, _c5 and _c6 (Milkdrop's constant register numbers).
 */
struct alignas(16) BlurUniforms {
    static constexpr const char* BlockName = "_pm_blur";
    static constexpr int Slot = UniformSlot::Draw;

    glm::vec4 c0{};         //!< _c0: source texsize (.xy) and its inverse (.zw)
    glm::vec4 c1{};         //!< _c1: w1..w4
    glm::vec4 c2{};         //!< _c2: d1..d4
    glm::vec4 c3{};         //!< _c3: scale, bias, w_div
    glm::vec4 c5{};         //!< _c5: w1, w2, d1, d2
    glm::vec4 c6{};         //!< _c6: w_div, edge darken c1..c3
    int32_t flipVertical{}; //!< flipVertical
};
static_assert(offsetof(BlurUniforms, c5) == 64);
static_assert(offsetof(BlurUniforms, flipVertical) == 96);
static_assert(sizeof(BlurUniforms) == 112);

/**
 * @brief <tt>_pm_transition</tt>: the transition shader header's inputs.
 */
struct alignas(16) TransitionUniforms {
    static constexpr const char* BlockName = "_pm_transition";
    static constexpr int Slot = UniformSlot::Draw;

    glm::vec4 durationParams{};    //!< durationParams
    glm::ivec4 randStatic{};       //!< iRandStatic
    glm::ivec4 randFrame{};        //!< iRandFrame
    glm::vec3 resolution{};        //!< iResolution
    float frameRate{};             //!< iFrameRate (never set: 0)
    glm::vec3 beatValues{};        //!< iBeatValues
    int32_t frame{};               //!< iFrame (never set: 0)
    glm::vec3 beatAttValues{};     //!< iBeatAttValues
    int32_t pass{};                //!< iPass
    glm::vec2 timeParams{};        //!< timeParams
    float aspectX{};               //!< iAspectX
    float aspectY{};               //!< iAspectY
    float invAspectX{};            //!< iInvAspectX
    float invAspectY{};            //!< iInvAspectY
    int32_t transparencyEnabled{}; //!< u_transparencyEnabled
    float transparencyThreshold{}; //!< u_transparencyThreshold
    int32_t blendMode{};           //!< iBlendMode
    int32_t maskBound{};           //!< iMaskBound
};
static_assert(offsetof(TransitionUniforms, randStatic) == 16);
static_assert(offsetof(TransitionUniforms, randFrame) == 32);
static_assert(offsetof(TransitionUniforms, resolution) == 48);
static_assert(offsetof(TransitionUniforms, frameRate) == 60);
static_assert(offsetof(TransitionUniforms, beatValues) == 64);
static_assert(offsetof(TransitionUniforms, frame) == 76);
static_assert(offsetof(TransitionUniforms, beatAttValues) == 80);
static_assert(offsetof(TransitionUniforms, pass) == 92);
static_assert(offsetof(TransitionUniforms, timeParams) == 96);
static_assert(offsetof(TransitionUniforms, aspectX) == 104);
static_assert(offsetof(TransitionUniforms, invAspectY) == 116);
static_assert(offsetof(TransitionUniforms, transparencyEnabled) == 120);
static_assert(offsetof(TransitionUniforms, transparencyThreshold) == 124);
static_assert(offsetof(TransitionUniforms, blendMode) == 128);
static_assert(offsetof(TransitionUniforms, maskBound) == 132);
static_assert(sizeof(TransitionUniforms) == 144);

/**
 * @brief <tt>_pm_flash_limiter</tt>: the flash limiter's state and mix shaders.
 */
struct alignas(16) FlashLimiterUniforms {
    static constexpr const char* BlockName = "_pm_flash_limiter";
    static constexpr int Slot = UniformSlot::Draw;

    float threshold{};            //!< threshold (state shader)
    float envelopeDecay{};        //!< envelope_decay (state shader)
    int32_t resetHistory{};       //!< reset_history (state shader)
    int32_t premultipliedAlpha{}; //!< premultiplied_alpha (mix shader)
};
static_assert(offsetof(FlashLimiterUniforms, premultipliedAlpha) == 12);
static_assert(sizeof(FlashLimiterUniforms) == 16);

/**
 * @brief <tt>_pm_sprite</tt>: the Milkdrop user sprite shader.
 */
struct alignas(16) SpriteUniforms {
    static constexpr const char* BlockName = "_pm_sprite";
    static constexpr int Slot = UniformSlot::Draw;

    int32_t blendMode{}; //!< blend_mode
};
static_assert(sizeof(SpriteUniforms) == 16);

/**
 * @brief <tt>_pm_compositor</tt>: the WASM host's dual-FBO compositor (WasmCompositorShader.hpp).
 */
struct alignas(16) CompositorUniforms {
    static constexpr const char* BlockName = "_pm_compositor";
    static constexpr int Slot = UniformSlot::Draw;

    float blend{};                 //!< uBlend
    float dither{};                //!< uDither
    int32_t transparencyEnabled{}; //!< u_transparencyEnabled
    float transparencyThreshold{}; //!< u_transparencyThreshold
};
static_assert(sizeof(CompositorUniforms) == 16);

/**
 * @brief Writes a drawing object's uniform blocks to the right ring and binds them.
 *
 * Inside an engine, that is the engine's ring (EngineContext::UniformRing()), on which the engine
 * starts a frame every frame. Outside any engine (the WASM host's compositor, tests drawing with
 * renderer objects directly), it is a small ring of the writer's own, created on first use on the
 * current device: the process device is not tied to one GL context (every WASM host has its own),
 * so a ring on it could hold a buffer of another context. The own ring belongs to the drawing
 * object like its programs and vertex arrays do, and is released with it. It wraps instead of
 * growing (UniformRingBuffer::BeginFrame()).
 *
 * The binding a write makes is not pipeline state: it holds until the next block is written to
 * that slot, so a draw writes its block right before it draws, or before a run of draws that
 * share it.
 */
class UniformBlockWriter
{
public:
    UniformBlockWriter() = default;
    ~UniformBlockWriter();

    UniformBlockWriter(const UniformBlockWriter&) = delete;
    auto operator=(const UniformBlockWriter&) -> UniformBlockWriter& = delete;
    UniformBlockWriter(UniformBlockWriter&&) noexcept;
    auto operator=(UniformBlockWriter&&) noexcept -> UniformBlockWriter&;

    /**
     * @brief Writes @a block and binds its range to the block's slot.
     */
    template<typename Block>
    auto Write(const Block& block) -> UniformRingBuffer::Range
    {
        return Ring().WriteAndBind(Block::Slot, &block, sizeof(Block));
    }

    /**
     * @brief The ring Write() uses now: the current engine's, else the writer's own.
     */
    auto Ring() -> UniformRingBuffer&;

    /// Capacity of a writer's own ring: a few draws' blocks.
    static constexpr size_t OwnRingCapacity = 4096;

private:
    std::unique_ptr<UniformRingBuffer> m_ownRing; //!< Outside engines only, see Ring().
};

} // namespace Renderer
} // namespace libprojectM
