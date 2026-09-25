#include "PerPixelGlslLowering.hpp"

#include "Constants.hpp"
#include "MilkdropStaticShaders.hpp"

#include <algorithm>
#include <cctype>
#include <cfloat>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#ifdef PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE
extern "C" {
#include <projectm-eval/CompilerTypes.h>
#include <projectm-eval/TreeFunctions.h>
}
#endif

namespace libprojectM {
namespace MilkdropPreset {

namespace {

/** @brief Marker lines PerPixelGlslLowering::ComposeWarpVertexShader() fills in. */
constexpr const char* kDeclarationsMarker = "//PRJM_PER_PIXEL_DECLARATIONS";
constexpr const char* kSetupMarker = "//PRJM_PER_PIXEL_SETUP";

/** @brief The warp mesh attributes the CPU evaluation loop fills in. */
constexpr const char* kCpuDeclarations =
    "layout(location = 4) in vec4 transforms;\n"
    "layout(location = 5) in vec2 warp_center;\n"
    "layout(location = 6) in vec2 warp_distance;\n"
    "layout(location = 7) in vec2 stretch;\n";

/** @brief The four per-frame seeds the equations start from on the GPU path. */
constexpr const char* kGpuSeedUniforms =
    "uniform vec4 u_pp_seed_transforms;\n"
    "uniform vec2 u_pp_seed_center;\n"
    "uniform vec2 u_pp_seed_distance;\n"
    "uniform vec2 u_pp_seed_stretch;\n";

/**
 * @brief Seeds the ten channels and runs the generated code, once per vertex.
 *
 * x, y, rad and ang are derived exactly as PerPixelMesh::CalculateMesh() derives them
 * for the CPU evaluator, including the negated angle. Spelled with the raw attribute
 * names rather than the shader's pos/radius/angle macros, because this block is
 * substituted after those macros are defined.
 */
constexpr const char* kGpuSetup =
    "    vec4 transforms = u_pp_seed_transforms;\n"
    "    vec2 warp_center = u_pp_seed_center;\n"
    "    vec2 warp_distance = u_pp_seed_distance;\n"
    "    vec2 stretch = u_pp_seed_stretch;\n"
    "    prjm_per_pixel(vertex_position.x * 0.5 * aspect.x + 0.5,\n"
    "                   vertex_position.y * 0.5 * aspect.y + 0.5,\n"
    "                   rad_ang.x, -rad_ang.y,\n"
    "                   transforms, warp_center, warp_distance, stretch);\n";

/**
 * @brief The attributes CpuSlice values travel in, narrowest first.
 *
 * These are the locations the CPU path uses for its ten transform channels. The GPU path
 * does not declare them otherwise, and PerPixelMesh fills them from the slice instead.
 */
struct CpuValueAttribute
{
    int location;
    int width;
};

constexpr CpuValueAttribute kCpuValueAttributes[] = {
    {5, 2},
    {6, 2},
    {7, 2},
    {4, 4},
};

void ReplaceMarker(std::string& source, const char* marker, const std::string& replacement)
{
    const auto position = source.find(marker);
    if (position == std::string::npos)
    {
        return;
    }
    source.replace(position, std::strlen(marker), replacement);
}

/** @brief Which attribute, and which component of it, carries CpuSlice value @a index. */
auto CpuValueSlot(int index) -> std::pair<int, int>
{
    int first = 0;
    for (int attribute = 0; attribute < static_cast<int>(sizeof(kCpuValueAttributes) / sizeof(kCpuValueAttributes[0])); attribute++)
    {
        if (index < first + kCpuValueAttributes[attribute].width)
        {
            return {attribute, index - first};
        }
        first += kCpuValueAttributes[attribute].width;
    }
    return {-1, -1};
}

} // namespace

auto PerPixelGlslLowering::ComposeWarpVertexShader(const std::string& generatedGlsl) -> std::string
{
    std::string source = MilkdropStaticShaders::Get()->GetPresetWarpVertexShader();

    if (generatedGlsl.empty())
    {
        ReplaceMarker(source, kDeclarationsMarker, kCpuDeclarations);
        ReplaceMarker(source, kSetupMarker, "");
        return source;
    }

    ReplaceMarker(source, kDeclarationsMarker, generatedGlsl + kGpuSeedUniforms);
    ReplaceMarker(source, kSetupMarker, kGpuSetup);
    return source;
}

auto PerPixelGlslLowering::CpuValueAttributeLocation(int index) -> int
{
    const auto slot = CpuValueSlot(index);
    return slot.first < 0 ? -1 : kCpuValueAttributes[slot.first].location;
}

auto PerPixelGlslLowering::ForcedToCpu() -> bool
{
    const char* const setting = std::getenv("PROJECTM_PER_PIXEL_EVAL");
    return setting != nullptr && std::string(setting) == "cpu";
}

auto PerPixelGlslLowering::CpuSlice::ValueCount() const -> int
{
    return m_valueCount;
}

auto PerPixelGlslLowering::CpuSlice::StatementCount() const -> int
{
    return m_statementCount;
}

auto PerPixelGlslLowering::CpuSlice::RandCallCount() const -> int
{
    return m_randCallCount;
}

auto PerPixelGlslLowering::CpuSlice::CostShare() const -> double
{
    return m_costShare;
}

#ifndef PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE

struct PerPixelGlslLowering::CpuSlice::Step
{
};

PerPixelGlslLowering::CpuSlice::CpuSlice() = default;
PerPixelGlslLowering::CpuSlice::~CpuSlice() = default;

void PerPixelGlslLowering::CpuSlice::Execute(float* /*values*/) const
{
}

auto PerPixelGlslLowering::Available() -> bool
{
    return false;
}

auto PerPixelGlslLowering::Lower(projectm_eval_code* /*code*/) -> Result
{
    Result result;
    result.reason = "built against a projectM-Eval that does not expose the expression tree";
    return result;
}

#else

/**
 * @brief One node the slice runs, and what it hands to the shader afterwards.
 *
 * Either a whole top-level statement, followed by the variables the shader reads after it,
 * or a single rand() call inside a statement the shader runs, whose result the shader reads
 * in its place.
 */
struct PerPixelGlslLowering::CpuSlice::Step
{
    prjm_eval_exptreenode_t* node{};          //!< A top-level statement, or a rand() call.
    bool captureResult{false};                //!< Hand the node's own value to the shader first.
    std::vector<const PRJM_EVAL_F*> captures; //!< Read right after the node runs, in slot order.
};

PerPixelGlslLowering::CpuSlice::CpuSlice() = default;
PerPixelGlslLowering::CpuSlice::~CpuSlice() = default;

void PerPixelGlslLowering::CpuSlice::Execute(float* values) const
{
    int slot = 0;
    for (const auto& step : m_steps)
    {
        // What projectm_eval_code_execute() does for the whole program, for one node.
        PRJM_EVAL_F result{};
        PRJM_EVAL_F* resultPointer = &result;
        step.node->func(step.node, &resultPointer);

        if (step.captureResult)
        {
            values[slot++] = static_cast<float>(*resultPointer);
        }
        for (const auto* variable : step.captures)
        {
            // The same conversion the CPU evaluation loop applies to its outputs.
            values[slot++] = static_cast<float>(*variable);
        }
    }
}

namespace {

using Node = prjm_eval_exptreenode_t;
using VariableKey = const PRJM_EVAL_F*;
using VariableSet = std::set<VariableKey>;

/*
 * The evaluator has two comparison epsilons. COMPARE_CLOSEFACTOR (1e-5) is used only by
 * band(), bor() and sigmoid(), and is spelled out literally in those helpers. Everything
 * else uses close_factor_low, which is 1e-300 for the 64-bit evaluator this tree builds:
 * no 32-bit float holds a magnitude between 1e-300 and zero, so the faithful GLSL
 * rendering of that epsilon is an exact comparison against zero, not a chosen epsilon.
 */

/** @brief Variables re-seeded on every vertex by the CPU loop; free to read and write. */
const char* const kPerVertexBuiltins[] = {
    "x", "y", "rad", "ang",
    "zoom", "zoomexp", "rot", "warp",
    "cx", "cy", "dx", "dy", "sx", "sy"};

/** @brief The ten channels the per-pixel code hands back to the warp vertex shader. */
struct OutputChannel
{
    const char* name;
    const char* target;
};

const OutputChannel kOutputChannels[] = {
    {"zoom", "transforms.x"},
    {"zoomexp", "transforms.y"},
    {"rot", "transforms.z"},
    {"warp", "transforms.w"},
    {"cx", "warp_center.x"},
    {"cy", "warp_center.y"},
    {"dx", "warp_distance.x"},
    {"dy", "warp_distance.y"},
    {"sx", "stretch.x"},
    {"sy", "stretch.y"},
};

/** @brief Per-frame scalars that are loaded once per frame and never re-seeded per vertex. */
struct ReadOnlyBuiltin
{
    const char* name;
    const char* uniform;
    std::uint32_t flag;
};

const ReadOnlyBuiltin kReadOnlyBuiltins[] = {
    {"time", "u_pp_time", PerPixelGlslLowering::UniformTime},
    {"fps", "u_pp_fps", PerPixelGlslLowering::UniformFps},
    {"frame", "u_pp_frame", PerPixelGlslLowering::UniformFrame},
    {"progress", "u_pp_progress", PerPixelGlslLowering::UniformProgress},
    {"bass", "u_pp_bass", PerPixelGlslLowering::UniformBass},
    {"mid", "u_pp_mid", PerPixelGlslLowering::UniformMid},
    {"treb", "u_pp_treb", PerPixelGlslLowering::UniformTreb},
    {"bass_att", "u_pp_bass_att", PerPixelGlslLowering::UniformBassAtt},
    {"mid_att", "u_pp_mid_att", PerPixelGlslLowering::UniformMidAtt},
    {"treb_att", "u_pp_treb_att", PerPixelGlslLowering::UniformTrebAtt},
    {"meshx", "u_pp_meshx", PerPixelGlslLowering::UniformMeshX},
    {"meshy", "u_pp_meshy", PerPixelGlslLowering::UniformMeshY},
    {"pixelsx", "u_pp_pixelsx", PerPixelGlslLowering::UniformPixelsX},
    {"pixelsy", "u_pp_pixelsy", PerPixelGlslLowering::UniformPixelsY},
    {"aspectx", "u_pp_aspectx", PerPixelGlslLowering::UniformAspectX},
    {"aspecty", "u_pp_aspecty", PerPixelGlslLowering::UniformAspectY},
};

/** @brief Helper functions the emitted code may call, in dependency order. */
enum Helper
{
    HelperDiv,
    HelperMod,
    HelperPow,
    HelperSqrt,
    HelperLog,
    HelperLog10,
    HelperAsin,
    HelperAcos,
    HelperAtan2,
    HelperSigmoid,
    HelperBand,
    HelperBor,
    HelperBitAnd,
    HelperBitOr,
    HelperCount
};

const char* const kHelperSource[HelperCount] = {
    // HelperDiv: the evaluator returns 0 instead of raising on a zero divisor.
    "float prjm_div(float a, float b) { return (b == 0.0) ? 0.0 : a / b; }\n",
    // HelperMod: the evaluator truncates both operands to integer and takes a C
    // remainder. GLSL ES leaves integer % undefined for negative operands, so the
    // same result is built from trunc() in floating point instead.
    "float prjm_mod(float a, float b) {\n"
    "    float fb = trunc(b);\n"
    "    if (fb == 0.0) { return 0.0; }\n"
    "    float fa = trunc(a);\n"
    "    return fa - fb * trunc(fa / fb);\n"
    "}\n",
    // HelperPow: matches the evaluator's zero-base and NaN handling, and keeps C
    // pow()'s defined behaviour for a negative base with an integral exponent,
    // which GLSL pow() leaves undefined.
    "float prjm_pow(float a, float b) {\n"
    "    if (a == 0.0) { return (b == 0.0) ? 1.0 : 0.0; }\n"
    "    if (a < 0.0) {\n"
    "        if (b == trunc(b)) {\n"
    "            float m = pow(-a, b);\n"
    "            return (prjm_mod(b, 2.0) != 0.0) ? -m : m;\n"
    "        }\n"
    "        return 0.0;\n"
    "    }\n"
    "    float r = pow(a, b);\n"
    "    return isnan(r) ? 0.0 : r;\n"
    "}\n",
    "float prjm_sqrt(float x) { return sqrt(abs(x)); }\n",
    "float prjm_log(float x) { return (x <= 0.0) ? 0.0 : log(x); }\n",
    "float prjm_log10(float x) { return (x <= 0.0) ? 0.0 : log(x) * 0.4342944819032518; }\n",
    "float prjm_asin(float x) { return (x < -1.0 || x > 1.0) ? 0.0 : asin(x); }\n",
    "float prjm_acos(float x) { return (x < -1.0 || x > 1.0) ? 0.0 : acos(x); }\n",
    // HelperAtan2: GLSL leaves atan(y, x) undefined when both arguments are zero,
    // while C atan2() is defined there and signed-zero aware: atan2(-0, -0) is -pi,
    // not 0. The mesh's exact centre vertex has rad == 0, so this case is reachable.
    "float prjm_atan2(float a, float b) {\n"
    "    if (a == 0.0 && b == 0.0) {\n"
    "        bool negA = floatBitsToInt(a) < 0;\n"
    "        if (floatBitsToInt(b) < 0) { return negA ? -3.1415926535897932 : 3.1415926535897932; }\n"
    "        return negA ? -0.0 : 0.0;\n"
    "    }\n"
    "    return atan(a, b);\n"
    "}\n",
    "float prjm_sigmoid(float a, float b) {\n"
    "    float t = 1.0 + exp(-a * b);\n"
    "    return (abs(t) > 1e-5) ? 1.0 / t : 0.0;\n"
    "}\n",
    "float prjm_band(float a, float b) { return (abs(a) > 1e-5 && abs(b) > 1e-5) ? 1.0 : 0.0; }\n",
    "float prjm_bor(float a, float b) { return (abs(a) > 1e-5 || abs(b) > 1e-5) ? 1.0 : 0.0; }\n",
    "float prjm_bitand(float a, float b) { return float(int(a) & int(b)); }\n",
    "float prjm_bitor(float a, float b) { return float(int(a) | int(b)); }\n",
};

/**
 * @brief Iteration count the cost estimate assumes when the evaluator decides at run time.
 *
 * Only used to weigh a hoisted while() or a loop() with a variable bound against the rest of
 * the program. Either one is expensive enough that the guess only has to be "large".
 */
constexpr double kUnknownIterationCost = 64.0;

/** @brief The evaluator's own cap on loop() iterations (MAX_LOOP_COUNT in TreeFunctions.c). */
constexpr double kEvaluatorMaxLoopCount = 1048576.0;

/**
 * @brief Relative CPU cost of evaluating one node, in units of a simple node.
 *
 * Measured on the evaluator built with -O2 -DNDEBUG (x86-64, 2M executions per program):
 * an operator, comparison, constant or variable node costs about 4 ns; sin/cos/exp/log and
 * the inverse trigonometric functions 20-40 ns; tan and sigmoid about 35 ns; pow and atan2
 * about 50 ns. Without the weights a thresh-style recurrence, all comparisons and
 * multiplies, looks far more expensive next to a program full of sin() and pow() than it
 * is. The absolute numbers differ in WASM; the ratios are what matter here.
 */
auto NodeCost(prjm_eval_expr_func_t* func) -> double
{
    if (func == prjm_eval_func_pow || func == prjm_eval_func_pow_op || func == prjm_eval_func_atan2)
    {
        return 10.0;
    }
    if (func == prjm_eval_func_tan || func == prjm_eval_func_sigmoid)
    {
        return 8.0;
    }
    if (func == prjm_eval_func_sin || func == prjm_eval_func_cos || func == prjm_eval_func_exp ||
        func == prjm_eval_func_log || func == prjm_eval_func_log10 || func == prjm_eval_func_asin ||
        func == prjm_eval_func_acos || func == prjm_eval_func_atan)
    {
        return 5.0;
    }
    if (func == prjm_eval_func_sqrt || func == prjm_eval_func_invsqrt || func == prjm_eval_func_rand)
    {
        return 2.0;
    }
    return 1.0;
}

auto ToLower(const char* name) -> std::string
{
    std::string lower(name != nullptr ? name : "");
    std::transform(lower.begin(), lower.end(), lower.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return lower;
}

auto Contains(const char* const* list, std::size_t count, const std::string& name) -> bool
{
    for (std::size_t i = 0; i < count; i++)
    {
        if (name == list[i])
        {
            return true;
        }
    }
    return false;
}

auto IsPerVertexBuiltin(const std::string& name) -> bool
{
    return Contains(kPerVertexBuiltins, sizeof(kPerVertexBuiltins) / sizeof(kPerVertexBuiltins[0]), name);
}

/**
 * @brief Returns 1..32 for the canonical spellings q1..q32, and 0 for anything else.
 *
 * Only these names are the registered q variables. A preset that writes @c q01 or @c q001
 * gets a separate local of that name from the evaluator, not @c q1.
 */
auto CanonicalQIndex(const std::string& name) -> int
{
    if (name.size() < 2 || name.size() > 3 || name[0] != 'q' || name[1] < '1' || name[1] > '9')
    {
        return 0;
    }
    if (name.size() == 3 && (name[2] < '0' || name[2] > '9'))
    {
        return 0;
    }
    const int index = std::atoi(name.c_str() + 1);
    return index <= QVarCount ? index : 0;
}

/**
 * @brief Prints a double as a GLSL float literal that always parses as a float.
 *
 * The value is first converted the way every CPU-side value reaching the shader is,
 * static_cast<float>, except that a finite value beyond the float range is clamped to
 * +/-FLT_MAX instead of becoming an infinity: GLSL has no infinity literal, and ANGLE
 * rejects an out-of-range one or clamps it with a warning.
 */
auto FloatLiteral(PRJM_EVAL_F value) -> std::string
{
    const double clamped = std::max(-static_cast<double>(FLT_MAX), std::min(static_cast<double>(FLT_MAX), static_cast<double>(value)));
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.9g", static_cast<double>(static_cast<float>(clamped)));
    std::string text(buffer);
    if (text.find('.') == std::string::npos &&
        text.find('e') == std::string::npos &&
        text.find("inf") == std::string::npos &&
        text.find("nan") == std::string::npos)
    {
        text += ".0";
    }
    return text;
}

/** @brief Thrown internally when a construct cannot be lowered; caught per statement. */
class Unsupported
{
public:
    explicit Unsupported(std::string reason)
        : m_reason(std::move(reason))
    {
    }

    auto Reason() const -> const std::string&
    {
        return m_reason;
    }

private:
    std::string m_reason;
};

/** @brief What one statement reads and writes, found by walking it in execution order. */
struct Effects
{
    VariableSet reads;      //!< Every variable read anywhere in the statement.
    VariableSet mayWrites;  //!< Every variable the statement may assign.
    VariableSet mustWrites; //!< Variables assigned on every path through the statement.

    //! The statement changes state outside the variables: rand() advances the shared
    //! Mersenne Twister, a megabuf/gmegabuf/reg write is seen by later statements, later
    //! vertices or other evaluation contexts. Such a statement must run on the CPU for
    //! every vertex, in order, whether or not anything reads its result.
    bool external{false};

    double cost{}; //!< Estimated evaluation cost, in simple-node units (see NodeCost()).

    void Merge(const Effects& other, bool keepMustWrites)
    {
        reads.insert(other.reads.begin(), other.reads.end());
        mayWrites.insert(other.mayWrites.begin(), other.mayWrites.end());
        if (keepMustWrites)
        {
            mustWrites.insert(other.mustWrites.begin(), other.mustWrites.end());
        }
        external = external || other.external;
        cost += other.cost;
    }
};

/**
 * @brief Computes a statement's Effects.
 *
 * Must-writes are sound, not complete: an assignment only counts when it runs whenever the
 * statement runs. The liveness passes in Lower() use them as kills, so claiming one that
 * might not happen would drop a statement the result depends on.
 */
class EffectAnalyzer
{
public:
    explicit EffectAnalyzer(const std::unordered_map<VariableKey, std::string>& variableNames)
        : m_variableNames(variableNames)
    {
    }

    auto Analyze(const Node* node) const -> Effects
    {
        Effects effects;
        Walk(node, effects);
        return effects;
    }

private:
    void Walk(const Node* node, Effects& effects) const
    {
        if (node == nullptr || node->func == nullptr)
        {
            return;
        }

        auto* const func = node->func;
        effects.cost += NodeCost(func);

        if (func == prjm_eval_func_const)
        {
            return;
        }

        if (func == prjm_eval_func_var)
        {
            effects.reads.insert(node->var);
            return;
        }

        if (func == prjm_eval_func_set || IsCompoundAssignment(func))
        {
            // The target reference is resolved first, then the right-hand side runs, then
            // the write happens; a compound assignment also reads the target.
            WalkTarget(node->args[0], func != prjm_eval_func_set, effects);
            Walk(node->args[1], effects);
            MarkWrite(node->args[0], true, effects);
            return;
        }

        if (func == prjm_eval_func_if)
        {
            Walk(node->args[0], effects);
            Effects thenEffects;
            Effects elseEffects;
            Walk(node->args[1], thenEffects);
            Walk(node->args[2], elseEffects);
            MergeAlternatives(thenEffects, elseEffects, effects);
            return;
        }

        if (func == prjm_eval_func_boolean_and_op || func == prjm_eval_func_boolean_or_op)
        {
            // The second operand only runs when the first does not decide the result.
            Walk(node->args[0], effects);
            Effects second;
            Walk(node->args[1], second);
            effects.Merge(second, false);
            return;
        }

        if (func == prjm_eval_func_execute_loop)
        {
            Walk(node->args[0], effects);
            Effects body;
            Walk(node->args[1], body);

            double iterations = kUnknownIterationCost;
            bool runsAtLeastOnce = false;
            if (node->args[0] != nullptr && node->args[0]->func == prjm_eval_func_const)
            {
                const double count = static_cast<double>(node->args[0]->value);
                iterations = std::isnan(count) ? 0.0 : std::max(0.0, std::min(std::trunc(count), kEvaluatorMaxLoopCount));
                runsAtLeastOnce = iterations >= 1.0;
            }
            body.cost *= iterations;
            effects.Merge(body, runsAtLeastOnce);
            return;
        }

        if (func == prjm_eval_func_execute_while)
        {
            // A do-while: the body runs at least once.
            Effects body;
            Walk(node->args[0], body);
            body.cost *= kUnknownIterationCost;
            effects.Merge(body, true);
            return;
        }

        if (func == prjm_eval_func_execute_list)
        {
            for (const auto* item = node->list; item != nullptr; item = item->next)
            {
                Walk(item->expr, effects);
            }
            return;
        }

        if (func == prjm_eval_func_rand ||
            func == prjm_eval_func_memset ||
            func == prjm_eval_func_memcpy ||
            func == prjm_eval_func_freembuf)
        {
            effects.external = true;
        }

        if (!IsKnownFunction(func))
        {
            // It might change anything; keep it on the CPU in every case.
            effects.external = true;
        }

        WalkArguments(node, effects);
    }

    void WalkArguments(const Node* node, Effects& effects) const
    {
        if (node->args == nullptr)
        {
            return;
        }
        for (auto** argument = node->args; *argument != nullptr; argument++)
        {
            Walk(*argument, effects);
        }
    }

    /** @brief Walks what resolving an assignment target evaluates, before the write. */
    void WalkTarget(const Node* target, bool readsTarget, Effects& effects) const
    {
        if (target == nullptr || target->func == nullptr)
        {
            return;
        }
        effects.cost += 1.0;

        if (target->func == prjm_eval_func_var)
        {
            if (readsTarget)
            {
                effects.reads.insert(target->var);
            }
            return;
        }

        if (target->func == prjm_eval_func_if)
        {
            Walk(target->args[0], effects);
            Effects thenEffects;
            Effects elseEffects;
            WalkTarget(target->args[1], readsTarget, thenEffects);
            WalkTarget(target->args[2], readsTarget, elseEffects);
            MergeAlternatives(thenEffects, elseEffects, effects);
            return;
        }

        // megabuf(i) / gmegabuf(i), or something more exotic: evaluate the operands.
        WalkArguments(target, effects);
    }

    /** @brief Records the write an assignment performs once its right-hand side has run. */
    void MarkWrite(const Node* target, bool definite, Effects& effects) const
    {
        if (target == nullptr || target->func == nullptr)
        {
            return;
        }

        if (target->func == prjm_eval_func_var)
        {
            effects.mayWrites.insert(target->var);
            if (definite)
            {
                effects.mustWrites.insert(target->var);
            }
            if (m_variableNames.find(target->var) == m_variableNames.end())
            {
                // reg00..reg99 live outside the context and are shared with every other one.
                effects.external = true;
            }
            return;
        }

        if (target->func == prjm_eval_func_if)
        {
            MarkWrite(target->args[1], false, effects);
            MarkWrite(target->args[2], false, effects);
            return;
        }

        // A memory write, or an l-value this analysis does not model.
        effects.external = true;
    }

    /** @brief Merges the two branches of an if(): only one of them runs. */
    static void MergeAlternatives(const Effects& first, const Effects& second, Effects& effects)
    {
        effects.reads.insert(first.reads.begin(), first.reads.end());
        effects.reads.insert(second.reads.begin(), second.reads.end());
        effects.mayWrites.insert(first.mayWrites.begin(), first.mayWrites.end());
        effects.mayWrites.insert(second.mayWrites.begin(), second.mayWrites.end());
        for (const auto* variable : first.mustWrites)
        {
            if (second.mustWrites.count(variable) > 0)
            {
                effects.mustWrites.insert(variable);
            }
        }
        effects.external = effects.external || first.external || second.external;
        effects.cost += std::max(first.cost, second.cost);
    }

    static auto IsCompoundAssignment(prjm_eval_expr_func_t* func) -> bool
    {
        return func == prjm_eval_func_add_op || func == prjm_eval_func_sub_op ||
               func == prjm_eval_func_mul_op || func == prjm_eval_func_div_op ||
               func == prjm_eval_func_mod_op || func == prjm_eval_func_pow_op ||
               func == prjm_eval_func_bitwise_and_op || func == prjm_eval_func_bitwise_or_op;
    }

    static auto IsKnownFunction(prjm_eval_expr_func_t* func) -> bool
    {
        prjm_eval_expr_func_t* const known[] = {
            prjm_eval_func_exec2, prjm_eval_func_exec3,
            prjm_eval_func_mem, prjm_eval_func_freembuf, prjm_eval_func_memcpy, prjm_eval_func_memset,
            prjm_eval_func_bnot, prjm_eval_func_equal, prjm_eval_func_notequal,
            prjm_eval_func_below, prjm_eval_func_above, prjm_eval_func_beloweq, prjm_eval_func_aboveeq,
            prjm_eval_func_add, prjm_eval_func_sub, prjm_eval_func_mul, prjm_eval_func_div, prjm_eval_func_mod,
            prjm_eval_func_bitwise_or, prjm_eval_func_bitwise_and,
            prjm_eval_func_boolean_and_func, prjm_eval_func_boolean_or_func, prjm_eval_func_neg,
            prjm_eval_func_sin, prjm_eval_func_cos, prjm_eval_func_tan,
            prjm_eval_func_asin, prjm_eval_func_acos, prjm_eval_func_atan, prjm_eval_func_atan2,
            prjm_eval_func_sqrt, prjm_eval_func_pow, prjm_eval_func_exp, prjm_eval_func_log, prjm_eval_func_log10,
            prjm_eval_func_floor, prjm_eval_func_ceil, prjm_eval_func_sigmoid, prjm_eval_func_sqr,
            prjm_eval_func_abs, prjm_eval_func_min, prjm_eval_func_max, prjm_eval_func_sign,
            prjm_eval_func_rand, prjm_eval_func_invsqrt};
        return std::find(std::begin(known), std::end(known), func) != std::end(known);
    }

    const std::unordered_map<VariableKey, std::string>& m_variableNames;
};

/** @brief The GLSL for one top-level statement, and what it needs declared. */
struct StatementCode
{
    std::string text;
    std::uint32_t uniforms{};
    std::uint32_t qVectors{};
    std::set<Helper> helpers;

    //! rand() calls the CPU makes for this statement, in evaluation order. The text reads
    //! call N's value from RandPlaceholder(N), which Lower() replaces with an attribute.
    std::vector<Node*> randSites;
};

/** @brief Stands in for the attribute carrying rand() call @a index of a statement. */
auto RandPlaceholder(std::size_t index) -> std::string
{
    return "@PRJM_RAND_" + std::to_string(index) + "@";
}

/**
 * @brief Walks the evaluator's expression tree and prints the equivalent GLSL.
 *
 * Every expression is emitted as a sequence of statements ending in a freshly named
 * float temporary. That costs some verbosity, but it is what makes the evaluator's
 * execution order reproducible: short-circuit operators, if() with a side-effecting
 * branch, and loop bodies all keep "only the taken path runs" without the printer
 * having to decide whether a subtree is pure.
 *
 * The printer also tracks which variables are definitely assigned on the current vertex,
 * in execution order. Reading a variable the program writes somewhere, before it is
 * definitely assigned, observes the value the CPU carried over from the previous vertex;
 * that throws, and the caller hoists the statement onto the CPU.
 */
class Printer
{
public:
    Printer(const std::unordered_map<VariableKey, std::string>& variableNames, const VariableSet& written)
        : m_variableNames(variableNames)
        , m_written(written)
    {
        m_assignedStack.emplace_back();
        for (const auto& entry : m_variableNames)
        {
            if (IsPerVertexBuiltin(entry.second))
            {
                m_assignedStack.back().insert(entry.first);
            }
        }
    }

    /**
     * @brief Emits one top-level statement.
     * @throws Unsupported if the statement cannot run on the GPU. The printer's state is
     *         then exactly what it was before the call.
     */
    auto EmitStatement(const Node* statement, const Effects& effects) -> StatementCode
    {
        const auto assignedBefore = m_assignedStack;
        m_body.clear();
        m_uniforms = 0;
        m_qVectors = 0;
        m_helpers.clear();
        m_randSites.clear();
        m_conditionalDepth = 0;
        m_statementWrites = &effects.mayWrites;

        try
        {
            EmitExpression(statement, 1);
        }
        catch (...)
        {
            m_assignedStack = assignedBefore;
            throw;
        }

        StatementCode code;
        code.text = std::move(m_body);
        code.uniforms = m_uniforms;
        code.qVectors = m_qVectors;
        code.helpers = m_helpers;
        code.randSites = std::move(m_randSites);
        m_body.clear();
        m_randSites.clear();
        return code;
    }

    /** @brief Records variables a hoisted statement leaves definitely assigned. */
    void MarkAssigned(const VariableSet& variables)
    {
        m_assignedStack.back().insert(variables.begin(), variables.end());
    }

    /** @brief The GLSL spelling of a variable the program writes. */
    auto WrittenVariableName(VariableKey key) -> std::string
    {
        const auto& name = m_variableNames.at(key);
        if (IsPerVertexBuiltin(name))
        {
            return "pp_" + name;
        }
        return LocalName(key, name);
    }

    auto Locals() const -> const std::vector<std::string>&
    {
        return m_localOrder;
    }

private:
    auto NextTemp() -> std::string
    {
        return "t" + std::to_string(m_tempCounter++);
    }

    void Line(int indent, const std::string& text)
    {
        m_body.append(static_cast<std::size_t>(indent) * 4u, ' ');
        m_body += text;
        m_body += '\n';
    }

    void Use(Helper helper)
    {
        m_helpers.insert(helper);
        if (helper == HelperPow)
        {
            // prjm_pow() calls prjm_mod() for the odd/even exponent test.
            m_helpers.insert(HelperMod);
        }
    }

    auto IsAssigned(VariableKey key) const -> bool
    {
        return m_assignedStack.back().count(key) > 0;
    }

    auto LocalName(VariableKey key, const std::string& name) -> std::string
    {
        const auto local = m_locals.find(key);
        if (local != m_locals.end())
        {
            return local->second;
        }

        const std::string glslName = "pl_" + std::to_string(m_locals.size());
        m_locals[key] = glslName;
        m_localOrder.push_back(glslName + " = 0.0; // " + name);
        return glslName;
    }

    /**
     * @brief Resolves a variable node to its GLSL spelling, refusing what cannot be lowered.
     * @param write True when the variable is the target of an assignment.
     */
    auto VariableReference(const Node* node, bool write) -> std::string
    {
        const auto found = m_variableNames.find(node->var);
        if (found == m_variableNames.end())
        {
            throw Unsupported("uses a reg00..reg99 global variable, which is shared between "
                              "evaluation contexts");
        }

        const std::string& name = found->second;

        if (IsPerVertexBuiltin(name))
        {
            return "pp_" + name;
        }

        if (m_written.count(node->var) > 0)
        {
            // Written somewhere in this program, so on the CPU it keeps its value from the
            // previous vertex evaluated on the same context; presets use that as a one-pole
            // filter. A GPU vertex has no previous vertex, so such a read must be done by
            // the CPU.
            if (!write && !IsAssigned(node->var))
            {
                if (CanonicalQIndex(name) > 0 || IsReadOnlyBuiltin(name))
                {
                    throw Unsupported("reads '" + name + "' before assigning it while also writing it, "
                                      "which carries state between vertices on the CPU path");
                }
                throw Unsupported("reads the local variable '" + name +
                                  "' before assigning it, which carries state between vertices on "
                                  "the CPU path");
            }
            return LocalName(node->var, name);
        }

        if (write)
        {
            // Every assignment target is in m_written; reaching this is a bug in the caller.
            throw Unsupported("assigns to a variable the analysis did not see written");
        }

        // Never written by this program, so it has the same value on every vertex.
        for (const auto& builtin : kReadOnlyBuiltins)
        {
            if (name == builtin.name)
            {
                m_uniforms |= builtin.flag;
                return builtin.uniform;
            }
        }

        const int qIndex = CanonicalQIndex(name);
        if (qIndex > 0)
        {
            const int zeroBased = qIndex - 1;
            m_qVectors |= 1u << static_cast<std::uint32_t>(zeroBased / 4);
            static const char* const kComponents[] = {"x", "y", "z", "w"};
            return "u_pp_q[" + std::to_string(zeroBased / 4) + "]." + kComponents[zeroBased % 4];
        }

        // A preset local nothing assigns keeps the zero it was registered with, forever.
        return "0.0";
    }

    static auto IsReadOnlyBuiltin(const std::string& name) -> bool
    {
        return std::any_of(std::begin(kReadOnlyBuiltins), std::end(kReadOnlyBuiltins),
                           [&name](const ReadOnlyBuiltin& builtin) { return name == builtin.name; });
    }

    /** @brief Resolves the target of an assignment. Only plain variables are supported. */
    auto LValue(const Node* node) -> std::string
    {
        if (node->func != prjm_eval_func_var)
        {
            throw Unsupported("assigns to something other than a variable (an if() or megabuf() "
                              "used as an l-value)");
        }
        return VariableReference(node, true);
    }

    /**
     * @brief Emits a subtree that may not run, whose assignments must not count as definite.
     * @return The emitted value, and the variables definitely assigned if it does run.
     */
    auto EmitConditional(const Node* node, int indent) -> std::pair<std::string, VariableSet>
    {
        m_assignedStack.push_back(m_assignedStack.back());
        m_conditionalDepth++;
        std::string result;
        try
        {
            result = EmitExpression(node, indent);
        }
        catch (...)
        {
            m_conditionalDepth--;
            m_assignedStack.pop_back();
            throw;
        }
        m_conditionalDepth--;
        auto assigned = std::move(m_assignedStack.back());
        m_assignedStack.pop_back();
        return {result, std::move(assigned)};
    }

    /**
     * @brief True if the CPU can evaluate @p node on its own, just before the statement it
     *        is part of, and get the value the statement would have seen.
     *
     * That holds for an expression without side effects that reads nothing the statement
     * itself assigns, and no reg00..reg99 global.
     */
    auto IsCpuEvaluableAhead(const Node* node) const -> bool
    {
        if (node == nullptr || node->func == nullptr)
        {
            return false;
        }
        auto* const func = node->func;
        if (func == prjm_eval_func_const)
        {
            return true;
        }
        if (func == prjm_eval_func_var)
        {
            return m_variableNames.count(node->var) > 0 && m_statementWrites->count(node->var) == 0;
        }
        // Pure functions only: no assignment, memory access, rand() or loop.
        const bool pure = UnaryOperatorKind(func) || BinaryOperatorKind(func) ||
                          func == prjm_eval_func_if || func == prjm_eval_func_exec2 ||
                          func == prjm_eval_func_exec3 || func == prjm_eval_func_boolean_and_op ||
                          func == prjm_eval_func_boolean_or_op || func == prjm_eval_func_invsqrt;
        if (!pure)
        {
            return false;
        }
        if (node->args != nullptr)
        {
            for (auto** argument = node->args; *argument != nullptr; argument++)
            {
                if (!IsCpuEvaluableAhead(*argument))
                {
                    return false;
                }
            }
        }
        return true;
    }

    auto EmitExpression(const Node* node, int indent) -> std::string
    {
        if (node == nullptr || node->func == nullptr)
        {
            throw Unsupported("contains an empty expression node");
        }

        auto* const func = node->func;

        if (func == prjm_eval_func_const)
        {
            if (std::isnan(static_cast<double>(node->value)))
            {
                throw Unsupported("contains a NaN constant");
            }
            const auto temp = NextTemp();
            Line(indent, "float " + temp + " = " + FloatLiteral(node->value) + ";");
            return temp;
        }

        if (func == prjm_eval_func_var)
        {
            const auto temp = NextTemp();
            Line(indent, "float " + temp + " = " + VariableReference(node, false) + ";");
            return temp;
        }

        if (func == prjm_eval_func_execute_list)
        {
            const auto temp = NextTemp();
            Line(indent, "float " + temp + " = 0.0;");
            for (const auto* item = node->list; item != nullptr; item = item->next)
            {
                const auto value = EmitExpression(item->expr, indent);
                Line(indent, temp + " = " + value + ";");
            }
            return temp;
        }

        if (func == prjm_eval_func_if)
        {
            const auto condition = EmitExpression(node->args[0], indent);
            const auto temp = NextTemp();
            Line(indent, "float " + temp + ";");
            Line(indent, "if (" + condition + " != 0.0) {");
            const auto thenBranch = EmitConditional(node->args[1], indent + 1);
            Line(indent + 1, temp + " = " + thenBranch.first + ";");
            Line(indent, "} else {");
            const auto elseBranch = EmitConditional(node->args[2], indent + 1);
            Line(indent + 1, temp + " = " + elseBranch.first + ";");
            Line(indent, "}");
            // Assigned on both paths means assigned.
            for (const auto* variable : thenBranch.second)
            {
                if (elseBranch.second.count(variable) > 0)
                {
                    m_assignedStack.back().insert(variable);
                }
            }
            return temp;
        }

        if (func == prjm_eval_func_boolean_and_op || func == prjm_eval_func_boolean_or_op)
        {
            const bool isAnd = (func == prjm_eval_func_boolean_and_op);
            const auto first = EmitExpression(node->args[0], indent);
            const auto temp = NextTemp();
            Line(indent, "float " + temp + " = " + (isAnd ? "0.0;" : "1.0;"));
            Line(indent, "if (" + first + (isAnd ? " != 0.0) {" : " == 0.0) {"));
            const auto second = EmitConditional(node->args[1], indent + 1);
            Line(indent + 1, temp + " = (" + second.first + " != 0.0) ? 1.0 : 0.0;");
            Line(indent, "}");
            return temp;
        }

        if (func == prjm_eval_func_execute_loop)
        {
            if (node->args[0]->func != prjm_eval_func_const)
            {
                throw Unsupported("uses loop() with a non-constant iteration count");
            }
            // Saturate before converting: a double beyond the range of the integer type
            // (or NaN) has no defined conversion.
            const double bound = static_cast<double>(node->args[0]->value);
            if (std::isnan(bound))
            {
                throw Unsupported("uses loop() with a NaN iteration count");
            }
            if (bound >= static_cast<double>(PerPixelGlslLowering::MaxLoopCount) + 1.0)
            {
                char count[32];
                std::snprintf(count, sizeof(count), "%g", bound);
                throw Unsupported(std::string("uses loop() with ") + count +
                                  " iterations, above the GPU cap of " +
                                  std::to_string(PerPixelGlslLowering::MaxLoopCount));
            }
            // The evaluator truncates the count; zero or less runs no iteration.
            const int count = bound < 1.0 ? 0 : static_cast<int>(bound);
            // With zero iterations the evaluator returns the loop count itself.
            const auto temp = NextTemp();
            Line(indent, "float " + temp + " = " + FloatLiteral(node->args[0]->value) + ";");
            if (count > 0)
            {
                const auto index = "i" + std::to_string(m_tempCounter++);
                Line(indent, "for (int " + index + " = 0; " + index + " < " +
                                 std::to_string(count) + "; ++" + index + ") {");
                const auto body = EmitConditional(node->args[1], indent + 1);
                Line(indent + 1, temp + " = " + body.first + ";");
                Line(indent, "}");
                // The body ran at least once, so what it definitely assigns is assigned.
                m_assignedStack.back().insert(body.second.begin(), body.second.end());
            }
            return temp;
        }

        if (func == prjm_eval_func_exec2 || func == prjm_eval_func_exec3)
        {
            const int count = (func == prjm_eval_func_exec2) ? 2 : 3;
            std::string last;
            for (int i = 0; i < count; i++)
            {
                last = EmitExpression(node->args[i], indent);
            }
            return last;
        }

        if (func == prjm_eval_func_set)
        {
            // The evaluator resolves the target reference first, then evaluates the
            // right-hand side, then writes. The statement value is the assigned value.
            const auto target = LValue(node->args[0]);
            const auto value = EmitExpression(node->args[1], indent);
            Line(indent, target + " = " + value + ";");
            m_assignedStack.back().insert(node->args[0]->var);
            return value;
        }

        if (func == prjm_eval_func_rand)
        {
            // The CPU makes this call, in vertex order, drawing exactly the numbers the CPU
            // path would, and the shader reads the result. That only works if the call runs
            // every time the statement does, and if the CPU can evaluate its argument ahead
            // of the statement. Otherwise the statement stays on the CPU as a whole.
            if (m_conditionalDepth > 0 || !IsCpuEvaluableAhead(node->args[0]))
            {
                throw Unsupported(UnsupportedFunctionReason(func));
            }
            const auto temp = NextTemp();
            Line(indent, "float " + temp + " = " + RandPlaceholder(m_randSites.size()) + ";");
            m_randSites.push_back(const_cast<Node*>(node));
            return temp;
        }

        if (auto compound = CompoundAssignment(func))
        {
            // Resolving the target reads it, so an unassigned carry variable refuses here.
            if (node->args[0]->func == prjm_eval_func_var)
            {
                VariableReference(node->args[0], false);
            }
            const auto target = LValue(node->args[0]);
            const auto value = EmitExpression(node->args[1], indent);
            // The evaluator reads the target *after* the right-hand side has run.
            Line(indent, target + " = " + compound(target, value) + ";");
            m_assignedStack.back().insert(node->args[0]->var);
            const auto temp = NextTemp();
            Line(indent, "float " + temp + " = " + target + ";");
            return temp;
        }

        if (auto unary = UnaryOperator(func))
        {
            const auto value = EmitExpression(node->args[0], indent);
            const auto temp = NextTemp();
            Line(indent, "float " + temp + " = " + unary(value) + ";");
            return temp;
        }

        if (auto binary = BinaryOperator(func))
        {
            const auto first = EmitExpression(node->args[0], indent);
            const auto second = EmitExpression(node->args[1], indent);
            const auto temp = NextTemp();
            Line(indent, "float " + temp + " = " + binary(first, second) + ";");
            return temp;
        }

        throw Unsupported(UnsupportedFunctionReason(func));
    }

    static auto UnaryOperatorKind(prjm_eval_expr_func_t* func) -> bool
    {
        prjm_eval_expr_func_t* const unary[] = {
            prjm_eval_func_neg, prjm_eval_func_bnot, prjm_eval_func_sin, prjm_eval_func_cos,
            prjm_eval_func_tan, prjm_eval_func_atan, prjm_eval_func_exp, prjm_eval_func_floor,
            prjm_eval_func_ceil, prjm_eval_func_abs, prjm_eval_func_sign, prjm_eval_func_sqr,
            prjm_eval_func_sqrt, prjm_eval_func_log, prjm_eval_func_log10, prjm_eval_func_asin,
            prjm_eval_func_acos};
        return std::find(std::begin(unary), std::end(unary), func) != std::end(unary);
    }

    static auto BinaryOperatorKind(prjm_eval_expr_func_t* func) -> bool
    {
        prjm_eval_expr_func_t* const binary[] = {
            prjm_eval_func_add, prjm_eval_func_sub, prjm_eval_func_mul, prjm_eval_func_min,
            prjm_eval_func_max, prjm_eval_func_equal, prjm_eval_func_notequal, prjm_eval_func_below,
            prjm_eval_func_above, prjm_eval_func_beloweq, prjm_eval_func_aboveeq, prjm_eval_func_div,
            prjm_eval_func_mod, prjm_eval_func_pow, prjm_eval_func_atan2, prjm_eval_func_sigmoid,
            prjm_eval_func_boolean_and_func, prjm_eval_func_boolean_or_func,
            prjm_eval_func_bitwise_and, prjm_eval_func_bitwise_or};
        return std::find(std::begin(binary), std::end(binary), func) != std::end(binary);
    }

    using UnaryEmitter = std::string (*)(const std::string&);
    using BinaryEmitter = std::string (*)(const std::string&, const std::string&);
    using CompoundEmitter = std::string (*)(const std::string&, const std::string&);

    auto UnaryOperator(prjm_eval_expr_func_t* func) -> UnaryEmitter
    {
        if (func == prjm_eval_func_neg) { return [](const std::string& a) { return "-" + a; }; }
        if (func == prjm_eval_func_bnot) { return [](const std::string& a) { return "float(" + a + " == 0.0)"; }; }
        if (func == prjm_eval_func_sin) { return [](const std::string& a) { return "sin(" + a + ")"; }; }
        if (func == prjm_eval_func_cos) { return [](const std::string& a) { return "cos(" + a + ")"; }; }
        if (func == prjm_eval_func_tan) { return [](const std::string& a) { return "tan(" + a + ")"; }; }
        if (func == prjm_eval_func_atan) { return [](const std::string& a) { return "atan(" + a + ")"; }; }
        if (func == prjm_eval_func_exp) { return [](const std::string& a) { return "exp(" + a + ")"; }; }
        if (func == prjm_eval_func_floor) { return [](const std::string& a) { return "floor(" + a + ")"; }; }
        if (func == prjm_eval_func_ceil) { return [](const std::string& a) { return "ceil(" + a + ")"; }; }
        if (func == prjm_eval_func_abs) { return [](const std::string& a) { return "abs(" + a + ")"; }; }
        if (func == prjm_eval_func_sign) { return [](const std::string& a) { return "sign(" + a + ")"; }; }
        if (func == prjm_eval_func_sqr) { return [](const std::string& a) { return "(" + a + " * " + a + ")"; }; }
        if (func == prjm_eval_func_sqrt) { Use(HelperSqrt); return [](const std::string& a) { return "prjm_sqrt(" + a + ")"; }; }
        if (func == prjm_eval_func_log) { Use(HelperLog); return [](const std::string& a) { return "prjm_log(" + a + ")"; }; }
        if (func == prjm_eval_func_log10) { Use(HelperLog10); return [](const std::string& a) { return "prjm_log10(" + a + ")"; }; }
        if (func == prjm_eval_func_asin) { Use(HelperAsin); return [](const std::string& a) { return "prjm_asin(" + a + ")"; }; }
        if (func == prjm_eval_func_acos) { Use(HelperAcos); return [](const std::string& a) { return "prjm_acos(" + a + ")"; }; }
        return nullptr;
    }

    auto BinaryOperator(prjm_eval_expr_func_t* func) -> BinaryEmitter
    {
        if (func == prjm_eval_func_add) { return [](const std::string& a, const std::string& b) { return "(" + a + " + " + b + ")"; }; }
        if (func == prjm_eval_func_sub) { return [](const std::string& a, const std::string& b) { return "(" + a + " - " + b + ")"; }; }
        if (func == prjm_eval_func_mul) { return [](const std::string& a, const std::string& b) { return "(" + a + " * " + b + ")"; }; }
        if (func == prjm_eval_func_min) { return [](const std::string& a, const std::string& b) { return "min(" + a + ", " + b + ")"; }; }
        if (func == prjm_eval_func_max) { return [](const std::string& a, const std::string& b) { return "max(" + a + ", " + b + ")"; }; }
        if (func == prjm_eval_func_equal) { return [](const std::string& a, const std::string& b) { return "float(" + a + " == " + b + ")"; }; }
        if (func == prjm_eval_func_notequal) { return [](const std::string& a, const std::string& b) { return "float(" + a + " != " + b + ")"; }; }
        if (func == prjm_eval_func_below) { return [](const std::string& a, const std::string& b) { return "float(" + a + " < " + b + ")"; }; }
        if (func == prjm_eval_func_above) { return [](const std::string& a, const std::string& b) { return "float(" + a + " > " + b + ")"; }; }
        if (func == prjm_eval_func_beloweq) { return [](const std::string& a, const std::string& b) { return "float(" + a + " <= " + b + ")"; }; }
        if (func == prjm_eval_func_aboveeq) { return [](const std::string& a, const std::string& b) { return "float(" + a + " >= " + b + ")"; }; }
        if (func == prjm_eval_func_div) { Use(HelperDiv); return [](const std::string& a, const std::string& b) { return "prjm_div(" + a + ", " + b + ")"; }; }
        if (func == prjm_eval_func_mod) { Use(HelperMod); return [](const std::string& a, const std::string& b) { return "prjm_mod(" + a + ", " + b + ")"; }; }
        if (func == prjm_eval_func_pow) { Use(HelperPow); return [](const std::string& a, const std::string& b) { return "prjm_pow(" + a + ", " + b + ")"; }; }
        if (func == prjm_eval_func_atan2) { Use(HelperAtan2); return [](const std::string& a, const std::string& b) { return "prjm_atan2(" + a + ", " + b + ")"; }; }
        if (func == prjm_eval_func_sigmoid) { Use(HelperSigmoid); return [](const std::string& a, const std::string& b) { return "prjm_sigmoid(" + a + ", " + b + ")"; }; }
        if (func == prjm_eval_func_boolean_and_func) { Use(HelperBand); return [](const std::string& a, const std::string& b) { return "prjm_band(" + a + ", " + b + ")"; }; }
        if (func == prjm_eval_func_boolean_or_func) { Use(HelperBor); return [](const std::string& a, const std::string& b) { return "prjm_bor(" + a + ", " + b + ")"; }; }
        if (func == prjm_eval_func_bitwise_and) { Use(HelperBitAnd); return [](const std::string& a, const std::string& b) { return "prjm_bitand(" + a + ", " + b + ")"; }; }
        if (func == prjm_eval_func_bitwise_or) { Use(HelperBitOr); return [](const std::string& a, const std::string& b) { return "prjm_bitor(" + a + ", " + b + ")"; }; }
        return nullptr;
    }

    auto CompoundAssignment(prjm_eval_expr_func_t* func) -> CompoundEmitter
    {
        if (func == prjm_eval_func_add_op) { return [](const std::string& v, const std::string& a) { return "(" + v + " + " + a + ")"; }; }
        if (func == prjm_eval_func_sub_op) { return [](const std::string& v, const std::string& a) { return "(" + v + " - " + a + ")"; }; }
        if (func == prjm_eval_func_mul_op) { return [](const std::string& v, const std::string& a) { return "(" + v + " * " + a + ")"; }; }
        if (func == prjm_eval_func_div_op) { Use(HelperDiv); return [](const std::string& v, const std::string& a) { return "prjm_div(" + v + ", " + a + ")"; }; }
        if (func == prjm_eval_func_mod_op) { Use(HelperMod); return [](const std::string& v, const std::string& a) { return "prjm_mod(" + v + ", " + a + ")"; }; }
        if (func == prjm_eval_func_pow_op) { Use(HelperPow); return [](const std::string& v, const std::string& a) { return "prjm_pow(" + v + ", " + a + ")"; }; }
        if (func == prjm_eval_func_bitwise_and_op) { Use(HelperBitAnd); return [](const std::string& v, const std::string& a) { return "prjm_bitand(" + v + ", " + a + ")"; }; }
        if (func == prjm_eval_func_bitwise_or_op) { Use(HelperBitOr); return [](const std::string& v, const std::string& a) { return "prjm_bitor(" + v + ", " + a + ")"; }; }
        return nullptr;
    }

    static auto UnsupportedFunctionReason(prjm_eval_expr_func_t* func) -> std::string
    {
        if (func == prjm_eval_func_mem) { return "uses megabuf()/gmegabuf(), which has no GPU equivalent"; }
        if (func == prjm_eval_func_freembuf) { return "uses freembuf()"; }
        if (func == prjm_eval_func_memcpy) { return "uses memcpy()"; }
        if (func == prjm_eval_func_memset) { return "uses memset()"; }
        if (func == prjm_eval_func_execute_while) { return "uses while(), which is unbounded"; }
        if (func == prjm_eval_func_rand) { return "uses rand(), which the CPU draws from a Mersenne Twister"; }
        if (func == prjm_eval_func_invsqrt)
        {
            return "uses invsqrt(), which the CPU computes with a 64-bit fast inverse square "
                   "root that 32-bit GLSL cannot reproduce";
        }
        return "uses an evaluator function this compiler does not know";
    }

    const std::unordered_map<VariableKey, std::string>& m_variableNames;
    const VariableSet& m_written;

    std::string m_body;
    std::map<VariableKey, std::string> m_locals;
    std::vector<std::string> m_localOrder;
    std::vector<VariableSet> m_assignedStack;
    std::set<Helper> m_helpers;
    std::uint32_t m_uniforms{};
    std::uint32_t m_qVectors{};
    int m_tempCounter{};

    std::vector<Node*> m_randSites;              //!< rand() calls of the current statement.
    int m_conditionalDepth{};                    //!< > 0 inside a branch, loop body or short-circuit operand.
    const VariableSet* m_statementWrites{};      //!< What the current statement may assign.
};

/** @brief Everything Lower() works out about one top-level statement. */
struct StatementPlan
{
    Node* node{};
    Effects effects;

    bool hoisted{false};     //!< Cannot run on the GPU; the CPU runs it.
    std::string hoistReason; //!< Why, if hoisted.
    StatementCode code;      //!< The GPU translation, if not hoisted.

    bool gpuKept{false};                //!< The shader needs this statement.
    bool cpuKept{false};                //!< The CPU slice runs this statement.
    std::vector<VariableKey> captures;  //!< Values handed to the shader after a hoisted statement.

    std::vector<Effects> randSites; //!< What each of code.randSites reads, and costs, on the CPU.
};

auto Intersects(const VariableSet& first, const VariableSet& second) -> bool
{
    return std::any_of(first.begin(), first.end(),
                       [&second](VariableKey key) { return second.count(key) > 0; });
}

/** @brief live = (live - kills) + reads: the backward transfer of one kept statement. */
void Transfer(VariableSet& live, const Effects& effects)
{
    for (const auto* variable : effects.mustWrites)
    {
        live.erase(variable);
    }
    live.insert(effects.reads.begin(), effects.reads.end());
}

/**
 * @brief Decides which statements the shader and the CPU slice each need, and what the
 *        shader must be handed after each hoisted statement.
 *
 * Two backward liveness passes over the top-level statements. The GPU pass starts from the
 * ten output channels; a hoisted statement hands over whichever of its writes are live
 * after it. The CPU pass starts from the variables whose final value the *next* vertex's
 * slice reads, which is itself what this pass finds live at the program start, so it runs
 * to a fixpoint. External statements (rand, memory and register writes) are always kept.
 */
void PlanStatements(std::vector<StatementPlan>& statements,
                    const std::unordered_map<VariableKey, std::string>& variableNames,
                    const VariableSet& written)
{
    VariableSet outputs;
    VariableSet perVertex;
    for (const auto& entry : variableNames)
    {
        if (IsPerVertexBuiltin(entry.second))
        {
            perVertex.insert(entry.first);
        }
        for (const auto& channel : kOutputChannels)
        {
            if (entry.second == channel.name)
            {
                outputs.insert(entry.first);
            }
        }
    }

    // GPU side.
    VariableSet gpuLive = outputs;
    for (auto statement = statements.rbegin(); statement != statements.rend(); ++statement)
    {
        auto& plan = *statement;
        plan.gpuKept = false;
        plan.captures.clear();
        if (plan.hoisted)
        {
            for (const auto* variable : plan.effects.mayWrites)
            {
                if (gpuLive.count(variable) > 0)
                {
                    plan.captures.push_back(variable);
                }
            }
            // Order the hand-over by name, so the attribute layout does not depend on
            // where the evaluator happened to allocate its variables.
            const auto nameOf = [&variableNames](VariableKey key) {
                const auto found = variableNames.find(key);
                return found != variableNames.end() ? found->second : std::string();
            };
            std::sort(plan.captures.begin(), plan.captures.end(),
                      [&nameOf](VariableKey first, VariableKey second) {
                          return nameOf(first) < nameOf(second);
                      });
            for (const auto* variable : plan.effects.mayWrites)
            {
                gpuLive.erase(variable);
            }
            continue;
        }

        plan.gpuKept = Intersects(plan.effects.mayWrites, gpuLive);
        if (plan.gpuKept)
        {
            Transfer(gpuLive, plan.effects);
        }
    }

    // CPU side, to a fixpoint over what carries from one vertex to the next.
    VariableSet carried;
    for (;;)
    {
        VariableSet cpuLive = carried;
        for (auto statement = statements.rbegin(); statement != statements.rend(); ++statement)
        {
            auto& plan = *statement;
            // A statement the shader runs has no external effect left: its rand() calls
            // run on the CPU as separate steps, just before it.
            plan.cpuKept = (plan.hoisted && plan.effects.external) ||
                           (plan.hoisted && !plan.captures.empty()) ||
                           Intersects(plan.effects.mayWrites, cpuLive);
            if (plan.cpuKept)
            {
                Transfer(cpuLive, plan.effects);
            }
            for (auto site = plan.randSites.rbegin(); site != plan.randSites.rend(); ++site)
            {
                cpuLive.insert(site->reads.begin(), site->reads.end());
            }
        }

        // Live at the start and written by the program: the value comes from the previous
        // vertex. Per-vertex builtins are re-seeded before every vertex instead.
        bool grew = false;
        for (const auto* variable : cpuLive)
        {
            if (written.count(variable) > 0 && perVertex.count(variable) == 0 &&
                carried.insert(variable).second)
            {
                grew = true;
            }
        }
        if (!grew)
        {
            break;
        }
    }
}

/** @brief The top-level statements of a program, in execution order. */
auto TopLevelStatements(Node* program) -> std::vector<Node*>
{
    std::vector<Node*> statements;
    if (program->func == prjm_eval_func_execute_list)
    {
        for (auto* item = program->list; item != nullptr; item = item->next)
        {
            statements.push_back(item->expr);
        }
    }
    else
    {
        statements.push_back(program);
    }
    return statements;
}

auto Percent(double share) -> std::string
{
    return std::to_string(static_cast<int>(std::lround(share * 100.0))) + "%";
}

} // namespace

auto PerPixelGlslLowering::Available() -> bool
{
    return true;
}

auto PerPixelGlslLowering::Lower(projectm_eval_code* code) -> Result
{
    // The CPU evaluator is always a correct fallback, so an internal failure here refuses
    // the preset rather than failing its load.
    try
    {
        return LowerProgram(code);
    }
    catch (const std::exception& exception)
    {
        Result result;
        result.reason = std::string("internal error in the GPU per-pixel compiler: ") + exception.what();
        return result;
    }
}

auto PerPixelGlslLowering::LowerProgram(projectm_eval_code* code) -> Result
{
    Result result;

    if (code == nullptr)
    {
        result.reason = "preset has no per-pixel code";
        return result;
    }

    auto* const program = reinterpret_cast<prjm_eval_program_t*>(code);
    if (program->cctx == nullptr)
    {
        result.reason = "per-pixel program has no compile context";
        return result;
    }

    // The tree identifies variables only by a pointer into the context's storage, so build
    // the reverse mapping once. Anything not in this list is a reg00..reg99 global, which
    // lives outside the context and is shared between evaluators.
    std::unordered_map<VariableKey, std::string> variableNames;
    for (const auto* entry = program->cctx->variables.first; entry != nullptr; entry = entry->next)
    {
        variableNames[&entry->variable->value] = ToLower(entry->variable->name);
    }

    // A block that is only comments compiles to no program at all. It does nothing on the
    // CPU either, so the GPU translation is the empty function: the seeds pass through.
    const EffectAnalyzer analyzer(variableNames);
    std::vector<StatementPlan> statements;
    if (program->program != nullptr)
    {
        for (auto* node : TopLevelStatements(program->program))
        {
            StatementPlan plan;
            plan.node = node;
            plan.effects = analyzer.Analyze(node);
            statements.push_back(std::move(plan));
        }
    }

    VariableSet written;
    for (const auto& plan : statements)
    {
        written.insert(plan.effects.mayWrites.begin(), plan.effects.mayWrites.end());
    }

    // Forward: translate what can run on the GPU, hoist what cannot; then plan both sides.
    // A statement whose rand() calls the CPU makes on their own cannot also run on the CPU
    // as a whole, or it would draw its numbers twice. If the slice turns out to need such a
    // statement, it is hoisted as a whole instead and the plan is made again.
    std::set<std::size_t> hoistWhole;
    std::unique_ptr<Printer> printer;
    std::string firstHoistReason;
    for (;;)
    {
        printer = std::make_unique<Printer>(variableNames, written);
        firstHoistReason.clear();
        for (std::size_t index = 0; index < statements.size(); index++)
        {
            auto& plan = statements[index];
            plan.hoisted = false;
            plan.hoistReason.clear();
            plan.code = StatementCode{};
            plan.randSites.clear();
            try
            {
                if (hoistWhole.count(index) > 0)
                {
                    throw Unsupported("uses rand(), which the CPU draws from a Mersenne Twister");
                }
                plan.code = printer->EmitStatement(plan.node, plan.effects);
                for (const auto* site : plan.code.randSites)
                {
                    plan.randSites.push_back(analyzer.Analyze(site));
                }
            }
            catch (const Unsupported& unsupported)
            {
                plan.hoisted = true;
                plan.hoistReason = unsupported.Reason();
                if (firstHoistReason.empty())
                {
                    firstHoistReason = plan.hoistReason;
                }
                // Whatever the statement assigns reaches the shader from the CPU, if needed.
                printer->MarkAssigned(plan.effects.mayWrites);
            }
        }

        PlanStatements(statements, variableNames, written);

        bool replanned = false;
        for (std::size_t index = 0; index < statements.size(); index++)
        {
            const auto& plan = statements[index];
            if (!plan.hoisted && !plan.randSites.empty() && plan.cpuKept)
            {
                hoistWhole.insert(index);
                replanned = true;
            }
        }
        if (!replanned)
        {
            break;
        }
    }

    double totalCost = 0.0;
    double cpuCost = 0.0;
    int cpuValues = 0;
    int cpuStatements = 0;
    int cpuRandCalls = 0;
    for (const auto& plan : statements)
    {
        totalCost += plan.effects.cost;
        if (plan.cpuKept)
        {
            cpuCost += plan.effects.cost;
            cpuStatements++;
        }
        for (const auto& site : plan.randSites)
        {
            // Made on the CPU whether or not the shader reads the number: it advances the
            // generator every other context draws from.
            cpuCost += site.cost;
            cpuRandCalls++;
            if (plan.gpuKept)
            {
                cpuValues++;
            }
        }
        cpuValues += static_cast<int>(plan.captures.size());
    }
    const double cpuShare = totalCost > 0.0 ? cpuCost / totalCost : 0.0;
    const bool hasSlice = cpuStatements > 0 || cpuRandCalls > 0;

    if (hasSlice)
    {
        if (cpuShare > MaxCpuShare)
        {
            result.reason = firstHoistReason + "; the statements that must stay on the CPU with it are " +
                            Percent(cpuShare) + " of the per-vertex work, above the " +
                            Percent(MaxCpuShare) + " a GPU path pays off at";
            return result;
        }
        if (cpuValues > MaxCpuValues)
        {
            result.reason = firstHoistReason + "; the statements that must stay on the CPU with it hand " +
                            std::to_string(cpuValues) + " values per vertex to the GPU, above the cap of " +
                            std::to_string(MaxCpuValues);
            return result;
        }
    }

    // Assemble the shader function. Slots are numbered in the order CpuSlice::Execute()
    // produces them: a statement's rand() calls, then what is captured after a hoisted one.
    std::set<Helper> helpers;
    std::uint32_t uniforms{};
    std::uint32_t qVectors{};
    std::string body;
    int slot = 0;
    const auto slotExpression = [](int index) {
        static const char* const kComponents[] = {"x", "y", "z", "w"};
        const auto location = CpuValueSlot(index);
        return "a_pp_cpu" + std::to_string(location.first) + "." + kComponents[location.second];
    };
    for (const auto& plan : statements)
    {
        if (plan.gpuKept)
        {
            auto text = plan.code.text;
            for (std::size_t site = 0; site < plan.randSites.size(); site++)
            {
                const auto placeholder = RandPlaceholder(site);
                text.replace(text.find(placeholder), placeholder.size(), slotExpression(slot++));
            }
            body += text;
            helpers.insert(plan.code.helpers.begin(), plan.code.helpers.end());
            uniforms |= plan.code.uniforms;
            qVectors |= plan.code.qVectors;
        }
        for (const auto* variable : plan.captures)
        {
            body += "    " + printer->WrittenVariableName(variable) + " = " + slotExpression(slot++) + ";\n";
        }
    }

    std::string source;

    for (int helper = 0; helper < HelperCount; helper++)
    {
        if (helpers.count(static_cast<Helper>(helper)) > 0)
        {
            source += kHelperSource[helper];
        }
    }
    if (!source.empty())
    {
        source += "\n";
    }

    for (const auto& builtin : kReadOnlyBuiltins)
    {
        if ((uniforms & builtin.flag) != 0u)
        {
            source += "uniform float ";
            source += builtin.uniform;
            source += ";\n";
        }
    }
    if (qVectors != 0u)
    {
        source += "uniform vec4 u_pp_q[" + std::to_string(QVarCount / 4) + "];\n";
    }

    // The CPU slice's values, in the attributes the CPU path uses for its channels.
    for (int attribute = 0, first = 0; first < cpuValues; attribute++)
    {
        const auto& layout = kCpuValueAttributes[attribute];
        source += "layout(location = " + std::to_string(layout.location) + ") in " +
                  (layout.width == 4 ? "vec4" : "vec2") + " a_pp_cpu" + std::to_string(attribute) + ";\n";
        first += layout.width;
    }
    source += "\n";

    source += "void ";
    source += EntryPointName;
    source += "(float pp_x, float pp_y, float pp_rad, float pp_ang,\n";
    source += "                    inout vec4 transforms, inout vec2 warp_center,\n";
    source += "                    inout vec2 warp_distance, inout vec2 stretch)\n";
    source += "{\n";

    for (const auto& channel : kOutputChannels)
    {
        source += "    float pp_";
        source += channel.name;
        source += " = ";
        source += channel.target;
        source += ";\n";
    }
    for (const auto& local : printer->Locals())
    {
        source += "    float " + local + "\n";
    }
    source += "\n";
    source += body;
    source += "\n";
    for (const auto& channel : kOutputChannels)
    {
        source += "    ";
        source += channel.target;
        source += " = pp_";
        source += channel.name;
        source += ";\n";
    }
    source += "}\n";

    if (hasSlice)
    {
        auto slice = std::make_shared<CpuSlice>();
        for (const auto& plan : statements)
        {
            for (auto* site : plan.code.randSites)
            {
                CpuSlice::Step step;
                step.node = site;
                step.captureResult = plan.gpuKept;
                slice->m_steps.push_back(std::move(step));
            }
            if (plan.cpuKept)
            {
                CpuSlice::Step step;
                step.node = plan.node;
                step.captures = plan.captures;
                slice->m_steps.push_back(std::move(step));
            }
        }
        slice->m_valueCount = cpuValues;
        slice->m_statementCount = cpuStatements;
        slice->m_randCallCount = cpuRandCalls;
        slice->m_costShare = cpuShare;
        result.cpuSlice = std::move(slice);

        std::string what = std::to_string(cpuStatements) + " of " + std::to_string(statements.size()) + " statements";
        if (cpuRandCalls > 0)
        {
            what += " and " + std::to_string(cpuRandCalls) + " rand() call" + (cpuRandCalls > 1 ? "s" : "");
        }
        result.cpuSliceReason = what + " (" + Percent(cpuShare) + " of the per-vertex work) run on the CPU" +
                                (firstHoistReason.empty() ? std::string() : ": " + firstHoistReason);
    }

    result.lowered = true;
    result.glsl = std::move(source);
    result.uniforms = uniforms;
    result.qVectors = qVectors;
    return result;
}

#endif // PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE

} // namespace MilkdropPreset
} // namespace libprojectM
