#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

struct projectm_eval_code;

namespace libprojectM {
namespace MilkdropPreset {

/**
 * @brief Compiles a Milkdrop @c per_pixel_* program from the projectM-EvalLib
 *        expression tree into a GLSL ES 3.00 function.
 *
 * This is the compiler of the GPU per-pixel path (see @c docs/GPU_PERPIXEL_EVAL.md).
 * Instead of running the equations on all (meshX+1)*(meshY+1) vertices on the CPU every
 * frame, the same math is emitted into the warp vertex shader and evaluated per vertex on
 * the GPU.
 *
 * The program is handled one top-level statement at a time. A statement whose GPU result
 * could differ from the CPU evaluator's is not translated; it is *hoisted* instead:
 *  - it reads a variable that is written somewhere in the program but not yet assigned on
 *    this vertex. On the CPU that value carries over from the previous vertex (presets use
 *    this as an IIR filter, @c thresh), which independent GPU vertices cannot see,
 *  - it calls @c rand where the call does not run every time the statement does (the CPU
 *    draws from one Mersenne Twister, in vertex order). An unconditional @c rand call is
 *    made on the CPU on its own instead, and only its value is handed to the shader,
 *  - it touches @c megabuf / @c gmegabuf / @c reg00..reg99, or calls @c while,
 *    @c invsqrt (a 64-bit bit hack), @c loop with a non-constant or oversized bound, or a
 *    function this compiler does not know.
 *
 * Hoisted statements, and whatever they depend on, form a CpuSlice: the CPU runs just
 * those statements, with the evaluator's own nodes, for every vertex in vertex order, and
 * hands the values the shader needs over as per-vertex attributes. The shader runs
 * everything else. That is exact with respect to single-threaded CPU evaluation. If the
 * slice would keep more than MaxCpuShare of the per-vertex work on the CPU, or needs more
 * than MaxCpuValues values per vertex, the program is refused and the CPU evaluator stays
 * authoritative. A refusal always carries a human-readable reason so the HUD and the logs
 * can say *why* a preset stayed on the CPU.
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

    /**
     * @brief Largest number of per-vertex values a CpuSlice may hand to the shader.
     *
     * The values travel in the four warp-mesh attributes the CPU path fills with the ten
     * transform channels (locations 4-7), which the GPU path otherwise leaves unread. See
     * CpuValueAttributeLocation().
     */
    static constexpr int MaxCpuValues = 10;

    /**
     * @brief Largest share of the program's per-vertex work a CpuSlice may keep on the CPU.
     *
     * The slice runs on one thread, in vertex order. The OpenMP CPU path spreads the whole
     * program over the worker pool, four threads in the WASM build, so a slice holding more
     * than a quarter of the work would not be faster than the path it replaces.
     */
    static constexpr double MaxCpuShare = 0.25;

    /**
     * @brief The part of a per-pixel program that must run on the CPU, in vertex order.
     *
     * Holds pointers into the compiled program it was lowered from, and must not outlive it.
     * Execute() runs the evaluator's own nodes on that program's context, so the caller must
     * seed x, y, rad, ang and the ten transform channels on that context first, exactly as
     * the CPU evaluation loop does, and call it once per vertex in vertex order on one thread.
     */
    class CpuSlice
    {
    public:
        CpuSlice();
        ~CpuSlice();

        CpuSlice(const CpuSlice&) = delete;
        auto operator=(const CpuSlice&) -> CpuSlice& = delete;

        /**
         * @brief Runs the slice for one vertex.
         * @param values Receives ValueCount() floats, in attribute slot order.
         */
        void Execute(float* values) const;

        /** @brief Number of floats Execute() writes per vertex. May be zero. */
        auto ValueCount() const -> int;

        /** @brief Number of top-level statements the slice runs per vertex. */
        auto StatementCount() const -> int;

        /** @brief Number of rand() calls the slice makes per vertex for statements the shader runs. */
        auto RandCallCount() const -> int;

        /** @brief Estimated share of the whole program's per-vertex work the slice keeps. */
        auto CostShare() const -> double;

    private:
        friend class PerPixelGlslLowering;

        struct Step;
        std::vector<Step> m_steps; //!< Statements and rand() calls to run, in program order.
        int m_valueCount{};        //!< Floats written per vertex.
        int m_statementCount{};    //!< See StatementCount().
        int m_randCallCount{};     //!< See RandCallCount().
        double m_costShare{};      //!< See CostShare().
    };

    struct Result
    {
        bool lowered{false};      //!< True if @c glsl holds a usable translation.
        std::string reason;       //!< Why the program was refused. Empty on success.
        std::string glsl;         //!< GLSL ES 3.00 source: helpers, attributes plus @c prjm_per_pixel().
        std::uint32_t uniforms{}; //!< Bitwise OR of UniformFlags for the scalars actually read.
        std::uint32_t qVectors{}; //!< Bit N set if the emitted code reads q[4N..4N+3].

        //! Statements that stay on the CPU, or null when every vertex is independent.
        std::shared_ptr<const CpuSlice> cpuSlice;
        //! Why the statements in @c cpuSlice stay on the CPU. Empty without a slice.
        std::string cpuSliceReason;
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
     * @param code The handle returned by @c projectm_eval_code_compile(). May be null. A
     *             returned CpuSlice executes this program's nodes and must not outlive it.
     * @return The translation, or a refusal with a reason.
     */
    static auto Lower(projectm_eval_code* code) -> Result;

    /**
     * @brief Vertex attribute location that carries CpuSlice value @a index.
     *
     * Values 0-1, 2-3 and 4-5 are the two components of the vec2 attributes at locations
     * 5, 6 and 7; values 6-9 are the vec4 at location 4. The narrow ones come first so the
     * common one- or two-value slice uploads eight bytes per vertex rather than sixteen.
     */
    static auto CpuValueAttributeLocation(int index) -> int;

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

private:
    /** @brief Lower() without its safety net for internal errors. */
    static auto LowerProgram(projectm_eval_code* code) -> Result;
};

} // namespace MilkdropPreset
} // namespace libprojectM
