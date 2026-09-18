#include "PerPixelGlslLowering.hpp"

#include "Constants.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#ifdef PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE
extern "C" {
#include <projectm-eval/CompilerTypes.h>
#include <projectm-eval/TreeFunctions.h>
}
#endif

namespace libprojectM {
namespace MilkdropPreset {

#ifndef PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE

auto PerPixelGlslLowering::Available() -> bool
{
    return false;
}

auto PerPixelGlslLowering::Lower(const projectm_eval_code* /*code*/) -> Result
{
    Result result;
    result.reason = "built against a projectM-Eval that does not expose the expression tree";
    return result;
}

#else

namespace {

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

/** @brief Prints a double as a GLSL float literal that always parses as a float. */
auto FloatLiteral(PRJM_EVAL_F value) -> std::string
{
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.9g", static_cast<double>(value));
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

/** @brief Thrown internally when a construct cannot be lowered; caught by Lower(). */
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

/**
 * @brief Walks the evaluator's expression tree and prints the equivalent GLSL.
 *
 * Every expression is emitted as a sequence of statements ending in a freshly named
 * float temporary. That costs some verbosity, but it is what makes the evaluator's
 * execution order reproducible: short-circuit operators, if() with a side-effecting
 * branch, and loop bodies all keep "only the taken path runs" without the printer
 * having to decide whether a subtree is pure.
 */
class Printer
{
public:
    explicit Printer(const prjm_eval_compiler_context_t* cctx)
    {
        // The tree identifies variables only by a pointer into the context's storage,
        // so build the reverse mapping once. Anything not in this list is a reg00..reg99
        // global, which lives outside the context and is shared between evaluators.
        for (const auto* entry = cctx->variables.first; entry != nullptr; entry = entry->next)
        {
            m_variableNames[&entry->variable->value] = ToLower(entry->variable->name);
        }
    }

    auto Run(const prjm_eval_exptreenode_t* program) -> std::string
    {
        m_assignedStack.emplace_back();
        auto& assigned = m_assignedStack.back();
        for (const auto* name : kPerVertexBuiltins)
        {
            assigned.insert(name);
        }

        EmitExpression(program, 1);
        return m_body;
    }

    auto Uniforms() const -> std::uint32_t
    {
        return m_uniforms;
    }

    auto QVectors() const -> std::uint32_t
    {
        return m_qVectors;
    }

    auto Helpers() const -> const std::set<Helper>&
    {
        return m_helpers;
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

    auto IsAssigned(const std::string& name) const -> bool
    {
        return m_assignedStack.back().count(name) > 0;
    }

    void MarkAssigned(const std::string& name)
    {
        m_assignedStack.back().insert(name);
    }

    /**
     * @brief Resolves a variable node to its GLSL spelling, refusing what cannot be lowered.
     * @param write True when the variable is the target of an assignment.
     */
    auto VariableReference(const prjm_eval_exptreenode_t* node, bool write) -> std::string
    {
        const auto found = m_variableNames.find(node->var);
        if (found == m_variableNames.end())
        {
            throw Unsupported("uses a reg00..reg99 global variable, which is shared between "
                              "evaluation contexts");
        }

        const std::string& name = found->second;

        if (Contains(kPerVertexBuiltins, sizeof(kPerVertexBuiltins) / sizeof(kPerVertexBuiltins[0]), name))
        {
            return "pp_" + name;
        }

        for (const auto& builtin : kReadOnlyBuiltins)
        {
            if (name == builtin.name)
            {
                if (write)
                {
                    throw Unsupported("writes to the read-only builtin '" + name +
                                      "', which persists across vertices on the CPU path");
                }
                m_uniforms |= builtin.flag;
                return builtin.uniform;
            }
        }

        if (name.size() >= 2 && name[0] == 'q')
        {
            const auto digits = name.substr(1);
            if (digits.find_first_not_of("0123456789") == std::string::npos)
            {
                const int index = std::atoi(digits.c_str());
                if (index >= 1 && index <= QVarCount)
                {
                    if (write)
                    {
                        throw Unsupported("writes to q" + std::to_string(index) +
                                          ", which persists across vertices on the CPU path");
                    }
                    const int zeroBased = index - 1;
                    m_qVectors |= 1u << static_cast<std::uint32_t>(zeroBased / 4);
                    static const char* const kComponents[] = {"x", "y", "z", "w"};
                    return "u_pp_q[" + std::to_string(zeroBased / 4) + "]." +
                           kComponents[zeroBased % 4];
                }
            }
        }

        // A preset-local variable. On the CPU it keeps its value from the previous
        // vertex evaluated on the same context; presets use that as a one-pole filter.
        // A GPU vertex starts from zero, so a read before a definite assignment is a
        // behaviour change we refuse rather than approximate.
        if (!write && !IsAssigned(name))
        {
            throw Unsupported("reads the local variable '" + name +
                              "' before assigning it, which carries state between vertices on "
                              "the CPU path");
        }

        const auto local = m_locals.find(name);
        if (local != m_locals.end())
        {
            return local->second;
        }

        const std::string glslName = "pl_" + std::to_string(m_locals.size());
        m_locals[name] = glslName;
        m_localOrder.push_back(glslName + " = 0.0; // " + name);
        return glslName;
    }

    /** @brief Resolves the target of an assignment. Only plain variables are supported. */
    auto LValue(const prjm_eval_exptreenode_t* node) -> std::string
    {
        if (node->func != prjm_eval_func_var)
        {
            throw Unsupported("assigns to something other than a variable (an if() or megabuf() "
                              "used as an l-value)");
        }
        return VariableReference(node, true);
    }

    /** @brief Emits a subtree whose assignments must not escape into the enclosing scope. */
    auto EmitConditional(const prjm_eval_exptreenode_t* node, int indent) -> std::string
    {
        m_assignedStack.push_back(m_assignedStack.back());
        std::string result;
        try
        {
            result = EmitExpression(node, indent);
        }
        catch (...)
        {
            m_assignedStack.pop_back();
            throw;
        }
        m_assignedStack.pop_back();
        return result;
    }

    auto EmitExpression(const prjm_eval_exptreenode_t* node, int indent) -> std::string
    {
        if (node == nullptr || node->func == nullptr)
        {
            throw Unsupported("contains an empty expression node");
        }

        auto* const func = node->func;

        if (func == prjm_eval_func_const)
        {
            if (!std::isfinite(static_cast<double>(node->value)))
            {
                throw Unsupported("contains a non-finite constant");
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
            const auto thenValue = EmitConditional(node->args[1], indent + 1);
            Line(indent + 1, temp + " = " + thenValue + ";");
            Line(indent, "} else {");
            const auto elseValue = EmitConditional(node->args[2], indent + 1);
            Line(indent + 1, temp + " = " + elseValue + ";");
            Line(indent, "}");
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
            Line(indent + 1, temp + " = (" + second + " != 0.0) ? 1.0 : 0.0;");
            Line(indent, "}");
            return temp;
        }

        if (func == prjm_eval_func_execute_loop)
        {
            if (node->args[0]->func != prjm_eval_func_const)
            {
                throw Unsupported("uses loop() with a non-constant iteration count");
            }
            const auto count = static_cast<long long>(node->args[0]->value);
            if (count > PerPixelGlslLowering::MaxLoopCount)
            {
                throw Unsupported("uses loop() with " + std::to_string(count) +
                                  " iterations, above the GPU cap of " +
                                  std::to_string(PerPixelGlslLowering::MaxLoopCount));
            }
            // With zero iterations the evaluator returns the loop count itself.
            const auto temp = NextTemp();
            Line(indent, "float " + temp + " = " + FloatLiteral(node->args[0]->value) + ";");
            if (count > 0)
            {
                const auto index = "i" + std::to_string(m_tempCounter++);
                Line(indent, "for (int " + index + " = 0; " + index + " < " +
                                 std::to_string(count) + "; ++" + index + ") {");
                const auto body = EmitConditional(node->args[1], indent + 1);
                Line(indent + 1, temp + " = " + body + ";");
                Line(indent, "}");
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
            MarkAssignedFor(node->args[0]);
            return value;
        }

        if (auto compound = CompoundAssignment(func))
        {
            const auto target = LValue(node->args[0]);
            const auto value = EmitExpression(node->args[1], indent);
            // The evaluator reads the target *after* the right-hand side has run.
            Line(indent, target + " = " + compound(target, value) + ";");
            MarkAssignedFor(node->args[0]);
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

    void MarkAssignedFor(const prjm_eval_exptreenode_t* target)
    {
        const auto found = m_variableNames.find(target->var);
        if (found != m_variableNames.end())
        {
            MarkAssigned(found->second);
        }
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

    std::string m_body;
    std::unordered_map<const PRJM_EVAL_F*, std::string> m_variableNames;
    std::map<std::string, std::string> m_locals;
    std::vector<std::string> m_localOrder;
    std::vector<std::set<std::string>> m_assignedStack;
    std::set<Helper> m_helpers;
    std::uint32_t m_uniforms{};
    std::uint32_t m_qVectors{};
    int m_tempCounter{};
};

} // namespace

auto PerPixelGlslLowering::Available() -> bool
{
    return true;
}

auto PerPixelGlslLowering::Lower(const projectm_eval_code* code) -> Result
{
    Result result;

    if (code == nullptr)
    {
        result.reason = "preset has no per-pixel code";
        return result;
    }

    const auto* program = reinterpret_cast<const prjm_eval_program_t*>(code);
    if (program->program == nullptr || program->cctx == nullptr)
    {
        result.reason = "per-pixel program is empty";
        return result;
    }

    Printer printer(program->cctx);
    std::string body;
    try
    {
        body = printer.Run(program->program);
    }
    catch (const Unsupported& unsupported)
    {
        result.reason = unsupported.Reason();
        return result;
    }

    std::string source;

    for (int helper = 0; helper < HelperCount; helper++)
    {
        if (printer.Helpers().count(static_cast<Helper>(helper)) > 0)
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
        if ((printer.Uniforms() & builtin.flag) != 0u)
        {
            source += "uniform float ";
            source += builtin.uniform;
            source += ";\n";
        }
    }
    if (printer.QVectors() != 0u)
    {
        source += "uniform vec4 u_pp_q[" + std::to_string(QVarCount / 4) + "];\n";
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
    for (const auto& local : printer.Locals())
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

    result.lowered = true;
    result.glsl = std::move(source);
    result.uniforms = printer.Uniforms();
    result.qVectors = printer.QVectors();
    return result;
}

#endif // PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE

} // namespace MilkdropPreset
} // namespace libprojectM
