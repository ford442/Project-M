#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct projectm_eval_code;

namespace libprojectM {
namespace MilkdropPreset {

/**
 * @brief Compiles a Milkdrop @c per_pixel_* program from the projectM-EvalLib
 *        expression tree into a GLSL ES 3.00 function.
 *
 * This is the Phase 1 compiler of the GPU per-pixel path (see
 * @c docs/GPU_PERPIXEL_EVAL.md). Instead of running the equations on all
 * (meshX+1)*(meshY+1) vertices on the CPU every frame, the same math is emitted
 * into the warp vertex shader and evaluated per vertex on the GPU.
 *
 * The lowering is deliberately conservative: anything whose GPU semantics would
 * differ from the CPU evaluator is refused, and the caller keeps the existing
 * OpenMP CPU path. Refusal is always reported with a human-readable reason so
 * the HUD and the logs can say *why* a preset stayed on the CPU.
 *
 * Refused constructs (the CPU path stays authoritative):
 *  - @c megabuf / @c gmegabuf / @c freembuf / @c memcpy / @c memset,
 *  - @c while (unbounded), @c loop with a non-constant or oversized bound,
 *  - @c rand (the CPU uses a Mersenne Twister; a GPU hash cannot match it),
 *  - @c invsqrt (the CPU uses the 64-bit fast inverse square root bit hack,
 *    which has no faithful 32-bit GLSL equivalent),
 *  - @c reg00..reg99 (shared across evaluation contexts),
 *  - writes to read-only builtins, including @c q1..q32: on the CPU those
 *    persist across vertices on the same evaluation context, so a write is a
 *    cross-vertex carry the GPU cannot reproduce,
 *  - reads of a preset-local variable before it has been definitely assigned:
 *    on the CPU such a local carries its value over from the previous vertex
 *    (presets use this as an IIR filter), while a GPU vertex would see 0,
 *  - an assignment whose target is not a plain variable.
 */
class PerPixelGlslLowering
{
public:
    /** @brief Bit flags telling the caller which per-frame uniforms the emitted code reads. */
    enum UniformFlags : std::uint32_t
    {
        UniformNone = 0u,
        UniformTime = 1u << 0u,
        UniformFps = 1u << 1u,
        UniformFrame = 1u << 2u,
        UniformProgress = 1u << 3u,
        UniformBass = 1u << 4u,
        UniformMid = 1u << 5u,
        UniformTreb = 1u << 6u,
        UniformBassAtt = 1u << 7u,
        UniformMidAtt = 1u << 8u,
        UniformTrebAtt = 1u << 9u,
        UniformMeshX = 1u << 10u,
        UniformMeshY = 1u << 11u,
        UniformPixelsX = 1u << 12u,
        UniformPixelsY = 1u << 13u,
        UniformAspectX = 1u << 14u,
        UniformAspectY = 1u << 15u,
    };

    struct Result
    {
        bool lowered{false};      //!< True if @c glsl holds a usable translation.
        std::string reason;       //!< Why the program was refused. Empty on success.
        std::string glsl;         //!< GLSL ES 3.00 source: helpers plus @c prjm_per_pixel().
        std::uint32_t uniforms{}; //!< Bitwise OR of UniformFlags for the scalars actually read.
        std::uint32_t qVectors{}; //!< Bit N set if the emitted code reads q[4N..4N+3].
    };

    /**
     * @brief Name of the generated entry point.
     *
     * The generated function has the signature
     * @code
     * void prjm_per_pixel(float x, float y, float rad, float ang,
     *                     inout vec4 transforms,    // zoom, zoomexp, rot, warp
     *                     inout vec2 warp_center,   // cx, cy
     *                     inout vec2 warp_distance, // dx, dy
     *                     inout vec2 stretch);      // sx, sy
     * @endcode
     * which matches the warp mesh vertex attributes the CPU path writes today.
     */
    static constexpr const char* EntryPointName = "prjm_per_pixel";

    /** @brief Largest @c loop() trip count that may be unrolled onto the GPU. */
    static constexpr int MaxLoopCount = 64;

    /**
     * @brief Translates a compiled per-pixel program into GLSL.
     * @param code The handle returned by @c projectm_eval_code_compile(). May be null.
     * @return The translation, or a refusal with a reason.
     */
    static auto Lower(const projectm_eval_code* code) -> Result;

    /**
     * @brief Builds the warp mesh vertex shader for one preset.
     *
     * The static shader carries two marker lines. This fills them in with either the
     * warp mesh vertex attributes (CPU path, @p generatedGlsl empty) or the generated
     * per-pixel function, its uniforms and the call that seeds and runs it (GPU path).
     *
     * @param generatedGlsl The @c Result::glsl of a successful lowering, or an empty
     *                      string to build the CPU-path shader.
     */
    static auto ComposeWarpVertexShader(const std::string& generatedGlsl) -> std::string;

    /**
     * @brief True when the environment forces every preset onto the CPU path.
     *
     * Set by @c PROJECTM_PER_PIXEL_EVAL=cpu, which the WASM host maps from
     * @c ?perPixelEval=cpu. Mirrors the @c ?blurPath / @c ?copyPath ablation switches
     * so one build can be A/B'd against itself.
     */
    static auto ForcedToCpu() -> bool;

    /** @brief True if this build can inspect the evaluator's expression tree at all. */
    static auto Available() -> bool;
};

} // namespace MilkdropPreset
} // namespace libprojectM
