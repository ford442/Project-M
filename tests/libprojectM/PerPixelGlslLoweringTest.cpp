/**
 * @file PerPixelGlslLoweringTest.cpp
 * @brief Differential tests for the GPU per-pixel compiler (docs/GPU_PERPIXEL_EVAL.md).
 *
 * The compiler's only job is to produce GLSL that computes exactly what
 * projectM-EvalLib computes on the CPU. These tests therefore do not inspect the
 * emitted text: they run it. Every case compiles the generated function into a real
 * vertex shader, evaluates it over a batch of vertices with transform feedback, and
 * compares the ten warp-mesh channels against the CPU evaluator fed the same inputs.
 *
 * A semantic mistake in the lowering table (integer mod, the divide-by-zero guard,
 * short-circuit operators, the two different comparison epsilons, ...) shows up here
 * as a numeric mismatch rather than as a preset that silently looks wrong.
 */

#include "HeadlessGlContext.hpp"

#include <MilkdropPreset/Constants.hpp>
#include <MilkdropPreset/PerPixelContext.hpp>
#include <MilkdropPreset/PerPixelGlslLowering.hpp>
#include <MilkdropPreset/PresetFileParser.hpp>

#include <glad/gl.h>

#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <map>
#include <memory>
#include <random>
#include <string>
#include <vector>

using libprojectM::MilkdropPreset::PerPixelContext;
using libprojectM::MilkdropPreset::PerPixelGlslLowering;
using libprojectM::MilkdropPreset::PresetFileParser;
using libprojectM::MilkdropPreset::QVarCount;

namespace {

constexpr int kVertexCount = 256;
constexpr int kChannelCount = 10;

/** @brief The per-frame state both evaluators are seeded with. */
struct FrameState
{
    double readOnly[16]{};  //!< time, fps, frame, progress, bass..treb_att, meshx..aspecty
    double q[QVarCount]{};
    double seeds[kChannelCount]{}; //!< zoom, zoomexp, rot, warp, cx, cy, dx, dy, sx, sy
};

/** @brief One vertex's inputs: x, y, rad, ang. */
struct VertexInput
{
    double x{};
    double y{};
    double rad{};
    double ang{};
};

const char* const kReadOnlyUniforms[16] = {
    "u_pp_time", "u_pp_fps", "u_pp_frame", "u_pp_progress",
    "u_pp_bass", "u_pp_mid", "u_pp_treb",
    "u_pp_bass_att", "u_pp_mid_att", "u_pp_treb_att",
    "u_pp_meshx", "u_pp_meshy", "u_pp_pixelsx", "u_pp_pixelsy",
    "u_pp_aspectx", "u_pp_aspecty"};

auto MakeFrameState(std::mt19937& rng) -> FrameState
{
    std::uniform_real_distribution<double> unit(0.0, 1.0);
    std::uniform_real_distribution<double> signed1(-1.5, 1.5);

    FrameState frame;
    frame.readOnly[0] = unit(rng) * 40.0;   // time
    frame.readOnly[1] = 60.0;               // fps
    frame.readOnly[2] = std::floor(unit(rng) * 900.0); // frame
    frame.readOnly[3] = unit(rng);          // progress
    for (int i = 4; i < 10; i++)
    {
        frame.readOnly[i] = unit(rng) * 2.0; // bass..treb_att
    }
    frame.readOnly[10] = 80.0;   // meshx
    frame.readOnly[11] = 60.0;   // meshy
    frame.readOnly[12] = 1280.0; // pixelsx
    frame.readOnly[13] = 720.0;  // pixelsy
    frame.readOnly[14] = 1.0;    // aspectx
    frame.readOnly[15] = 1.0 / 1.2; // aspecty

    for (auto& q : frame.q)
    {
        q = signed1(rng);
    }

    frame.seeds[0] = 1.0 + unit(rng) * 0.4; // zoom
    frame.seeds[1] = 1.0;                   // zoomexp
    frame.seeds[2] = signed1(rng) * 0.2;    // rot
    frame.seeds[3] = unit(rng);             // warp
    frame.seeds[4] = 0.5;                   // cx
    frame.seeds[5] = 0.5;                   // cy
    frame.seeds[6] = signed1(rng) * 0.01;   // dx
    frame.seeds[7] = signed1(rng) * 0.01;   // dy
    frame.seeds[8] = 1.0;                   // sx
    frame.seeds[9] = 1.0;                   // sy
    return frame;
}

auto MakeVertices(std::mt19937& rng) -> std::vector<VertexInput>
{
    std::vector<VertexInput> vertices;
    vertices.reserve(kVertexCount);

    // The first rows mirror what CalculateMesh() feeds the evaluator for a real grid,
    // including the exact centre vertex where the angle is pinned to zero.
    for (int index = 0; index < kVertexCount; index++)
    {
        const int gridX = index % 16;
        const int gridY = index / 16;
        const double ndcX = static_cast<double>(gridX) / 15.0 * 2.0 - 1.0;
        const double ndcY = static_cast<double>(gridY) / 15.0 * 2.0 - 1.0;

        VertexInput vertex;
        vertex.x = ndcX * 0.5 + 0.5;
        vertex.y = ndcY * 0.5 + 0.5;
        vertex.rad = std::hypot(ndcX, ndcY);
        vertex.ang = (gridX == 8 && gridY == 8) ? 0.0 : -std::atan2(ndcY, ndcX);
        vertices.push_back(vertex);
    }

    // Plus a handful of adversarial values: exact zeros and negatives reach the
    // divide-by-zero, pow(), mod() and atan2() guards that a well-behaved grid never
    // does. They stay inside the domain a real mesh spans (x/y around 0..1, rad up to
    // the corner radius) so that comparing CPU doubles against 32-bit shader floats
    // stays a test of the lowering rather than of how fast error grows off-domain.
    std::uniform_real_distribution<double> wide(-0.5, 1.5);
    for (int index = 0; index < 32; index++)
    {
        vertices[static_cast<std::size_t>(index)] =
            VertexInput{wide(rng), wide(rng), std::abs(wide(rng)) * 1.5,
                        (wide(rng) - 0.5) * 6.28318530718};
    }
    vertices[0] = VertexInput{0.0, 0.0, 0.0, 0.0};
    // rad == 0 with a negative zero angle is the mesh's exact centre vertex, where
    // atan2() sees two signed zeros.
    vertices[1] = VertexInput{0.5, 0.5, 0.0, -0.0};

    return vertices;
}

/** @brief Runs the per-pixel program on the CPU exactly the way CalculateMesh() does. */
auto EvaluateOnCpu(const std::string& code,
                   const FrameState& frame,
                   const std::vector<VertexInput>& vertices,
                   std::vector<double>& results,
                   std::string& error) -> bool
{
    PerPixelContext context(nullptr, nullptr);
    context.RegisterBuiltinVariables();

    try
    {
        context.CompilePerPixelCode(code);
    }
    catch (const std::exception& exception)
    {
        error = exception.what();
        return false;
    }

    PRJM_EVAL_F* const readOnly[16] = {
        context.time, context.fps, context.frame, context.progress,
        context.bass, context.mid, context.treb,
        context.bass_att, context.mid_att, context.treb_att,
        context.meshx, context.meshy, context.pixelsx, context.pixelsy,
        context.aspectx, context.aspecty};

    for (int i = 0; i < 16; i++)
    {
        *readOnly[i] = frame.readOnly[i];
    }
    for (int i = 0; i < QVarCount; i++)
    {
        *context.q_vars[i] = frame.q[i];
    }

    PRJM_EVAL_F* const channels[kChannelCount] = {
        context.zoom, context.zoomexp, context.rot, context.warp,
        context.cx, context.cy, context.dx, context.dy,
        context.sx, context.sy};

    results.clear();
    results.reserve(vertices.size() * kChannelCount);

    for (const auto& vertex : vertices)
    {
        *context.x = vertex.x;
        *context.y = vertex.y;
        *context.rad = vertex.rad;
        *context.ang = vertex.ang;
        for (int i = 0; i < kChannelCount; i++)
        {
            *channels[i] = frame.seeds[i];
        }

        context.ExecutePerPixelCode();

        for (auto* channel : channels)
        {
            results.push_back(static_cast<double>(*channel));
        }
    }

    return true;
}

auto CompileShader(GLenum type, const std::string& source, std::string& log) -> GLuint
{
    const GLuint shader = glCreateShader(type);
    const char* text = source.c_str();
    glShaderSource(shader, 1, &text, nullptr);
    glCompileShader(shader);

    GLint compiled = GL_FALSE;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
    if (compiled == GL_FALSE)
    {
        GLint length = 0;
        glGetShaderiv(shader, GL_INFO_LOG_LENGTH, &length);
        std::string message(static_cast<std::size_t>(std::max(length, 1)), '\0');
        glGetShaderInfoLog(shader, length, nullptr, message.data());
        log = message;
        glDeleteShader(shader);
        return 0;
    }
    return shader;
}

/**
 * @brief Compiles the generated function into a vertex shader and evaluates it with
 *        transform feedback, one point per vertex.
 */
auto EvaluateOnGpu(const std::string& generatedGlsl,
                   const FrameState& frame,
                   const std::vector<VertexInput>& vertices,
                   std::vector<double>& results,
                   std::string& error) -> bool
{
    std::string source = "#version 330\n";
    source += generatedGlsl;
    source += R"(
layout(location = 0) in vec4 a_vertex;

uniform vec4 u_seed_transforms;
uniform vec2 u_seed_center;
uniform vec2 u_seed_distance;
uniform vec2 u_seed_stretch;

out vec4 o_transforms;
out vec2 o_center;
out vec2 o_distance;
out vec2 o_stretch;

void main()
{
    vec4 transforms = u_seed_transforms;
    vec2 warp_center = u_seed_center;
    vec2 warp_distance = u_seed_distance;
    vec2 stretch = u_seed_stretch;

    prjm_per_pixel(a_vertex.x, a_vertex.y, a_vertex.z, a_vertex.w,
                   transforms, warp_center, warp_distance, stretch);

    o_transforms = transforms;
    o_center = warp_center;
    o_distance = warp_distance;
    o_stretch = stretch;
    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}
)";

    std::string log;
    const GLuint vertexShader = CompileShader(GL_VERTEX_SHADER, source, log);
    if (vertexShader == 0)
    {
        error = "vertex shader failed to compile: " + log + "\n--- source ---\n" + source;
        return false;
    }

    const GLuint fragmentShader = CompileShader(
        GL_FRAGMENT_SHADER,
        "#version 330\nout vec4 color;\nvoid main() { color = vec4(1.0); }\n", log);
    if (fragmentShader == 0)
    {
        glDeleteShader(vertexShader);
        error = "fragment shader failed to compile: " + log;
        return false;
    }

    const GLuint program = glCreateProgram();
    glAttachShader(program, vertexShader);
    glAttachShader(program, fragmentShader);

    const char* const varyings[] = {"o_transforms", "o_center", "o_distance", "o_stretch"};
    glTransformFeedbackVaryings(program, 4, varyings, GL_INTERLEAVED_ATTRIBS);
    glLinkProgram(program);

    GLint linked = GL_FALSE;
    glGetProgramiv(program, GL_LINK_STATUS, &linked);
    if (linked == GL_FALSE)
    {
        GLint length = 0;
        glGetProgramiv(program, GL_INFO_LOG_LENGTH, &length);
        std::string message(static_cast<std::size_t>(std::max(length, 1)), '\0');
        glGetProgramInfoLog(program, length, nullptr, message.data());
        glDeleteProgram(program);
        glDeleteShader(vertexShader);
        glDeleteShader(fragmentShader);
        error = "program failed to link: " + message;
        return false;
    }

    glUseProgram(program);

    for (int i = 0; i < 16; i++)
    {
        const GLint location = glGetUniformLocation(program, kReadOnlyUniforms[i]);
        if (location >= 0)
        {
            glUniform1f(location, static_cast<float>(frame.readOnly[i]));
        }
    }
    for (int vector = 0; vector < QVarCount / 4; vector++)
    {
        const std::string name = "u_pp_q[" + std::to_string(vector) + "]";
        const GLint location = glGetUniformLocation(program, name.c_str());
        if (location >= 0)
        {
            glUniform4f(location,
                        static_cast<float>(frame.q[vector * 4 + 0]),
                        static_cast<float>(frame.q[vector * 4 + 1]),
                        static_cast<float>(frame.q[vector * 4 + 2]),
                        static_cast<float>(frame.q[vector * 4 + 3]));
        }
    }
    glUniform4f(glGetUniformLocation(program, "u_seed_transforms"),
                static_cast<float>(frame.seeds[0]), static_cast<float>(frame.seeds[1]),
                static_cast<float>(frame.seeds[2]), static_cast<float>(frame.seeds[3]));
    glUniform2f(glGetUniformLocation(program, "u_seed_center"),
                static_cast<float>(frame.seeds[4]), static_cast<float>(frame.seeds[5]));
    glUniform2f(glGetUniformLocation(program, "u_seed_distance"),
                static_cast<float>(frame.seeds[6]), static_cast<float>(frame.seeds[7]));
    glUniform2f(glGetUniformLocation(program, "u_seed_stretch"),
                static_cast<float>(frame.seeds[8]), static_cast<float>(frame.seeds[9]));

    std::vector<float> attributes;
    attributes.reserve(vertices.size() * 4);
    for (const auto& vertex : vertices)
    {
        attributes.push_back(static_cast<float>(vertex.x));
        attributes.push_back(static_cast<float>(vertex.y));
        attributes.push_back(static_cast<float>(vertex.rad));
        attributes.push_back(static_cast<float>(vertex.ang));
    }

    GLuint vertexArray = 0;
    GLuint vertexBuffer = 0;
    GLuint feedbackBuffer = 0;
    glGenVertexArrays(1, &vertexArray);
    glBindVertexArray(vertexArray);
    glGenBuffers(1, &vertexBuffer);
    glBindBuffer(GL_ARRAY_BUFFER, vertexBuffer);
    glBufferData(GL_ARRAY_BUFFER,
                 static_cast<GLsizeiptr>(attributes.size() * sizeof(float)),
                 attributes.data(), GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 4, GL_FLOAT, GL_FALSE, 0, nullptr);

    const std::size_t outputCount = vertices.size() * kChannelCount;
    glGenBuffers(1, &feedbackBuffer);
    glBindBuffer(GL_TRANSFORM_FEEDBACK_BUFFER, feedbackBuffer);
    glBufferData(GL_TRANSFORM_FEEDBACK_BUFFER,
                 static_cast<GLsizeiptr>(outputCount * sizeof(float)),
                 nullptr, GL_STATIC_READ);
    glBindBufferBase(GL_TRANSFORM_FEEDBACK_BUFFER, 0, feedbackBuffer);

    glEnable(GL_RASTERIZER_DISCARD);
    glBeginTransformFeedback(GL_POINTS);
    glDrawArrays(GL_POINTS, 0, static_cast<GLsizei>(vertices.size()));
    glEndTransformFeedback();
    glDisable(GL_RASTERIZER_DISCARD);
    glFlush();

    std::vector<float> feedback(outputCount, 0.0f);
    glGetBufferSubData(GL_TRANSFORM_FEEDBACK_BUFFER, 0,
                       static_cast<GLsizeiptr>(outputCount * sizeof(float)),
                       feedback.data());

    glBindVertexArray(0);
    glDeleteBuffers(1, &feedbackBuffer);
    glDeleteBuffers(1, &vertexBuffer);
    glDeleteVertexArrays(1, &vertexArray);
    glDeleteProgram(program);
    glDeleteShader(vertexShader);
    glDeleteShader(fragmentShader);

    const GLenum glError = glGetError();
    if (glError != GL_NO_ERROR)
    {
        error = "GL error 0x" + std::to_string(glError);
        return false;
    }

    results.assign(feedback.begin(), feedback.end());
    return true;
}

/**
 * @brief Compares CPU and GPU results, and records the worst drift seen.
 *
 * The CPU evaluator is double precision and the shader is 32-bit, so an exact match is
 * not the bar. The tolerance only has to be far tighter than any semantic divergence:
 * a wrong operator changes a channel by whole units, while 32-bit rounding over a long
 * program stays in the fourth decimal. Presets that feed a float into a stiff function
 * (tan() of a large time, pow() with a fractional exponent) are the realistic worst
 * case, which is why the corpus reports its worst drift instead of assuming one.
 */
auto CompareResults(const std::vector<double>& cpu,
                    const std::vector<double>& gpu,
                    double absoluteTolerance,
                    double relativeTolerance,
                    std::string& mismatch,
                    double& worstDrift) -> bool
{
    if (cpu.size() != gpu.size())
    {
        mismatch = "result count differs";
        return false;
    }

    static const char* const kChannelNames[kChannelCount] = {
        "zoom", "zoomexp", "rot", "warp", "cx", "cy", "dx", "dy", "sx", "sy"};

    for (std::size_t index = 0; index < cpu.size(); index++)
    {
        const double expected = cpu[index];
        const double actual = gpu[index];

        // A program that overflows to infinity or NaN on the CPU has no defined GPU
        // counterpart; those vertices are skipped rather than compared.
        if (!std::isfinite(expected) || std::abs(expected) > 1e18)
        {
            continue;
        }
        if (!std::isfinite(actual))
        {
            mismatch = std::string("vertex ") + std::to_string(index / kChannelCount) + " " +
                       kChannelNames[index % kChannelCount] + ": cpu=" +
                       std::to_string(expected) + " gpu=non-finite";
            return false;
        }

        const double drift = std::abs(expected - actual) / (1.0 + std::abs(expected));
        worstDrift = std::max(worstDrift, drift);

        const double tolerance = absoluteTolerance + relativeTolerance * std::abs(expected);
        if (std::abs(expected - actual) > tolerance)
        {
            mismatch = std::string("vertex ") + std::to_string(index / kChannelCount) + " " +
                       kChannelNames[index % kChannelCount] + ": cpu=" +
                       std::to_string(expected) + " gpu=" + std::to_string(actual);
            return false;
        }
    }

    return true;
}

class PerPixelGlslLoweringTest : public testing::Test
{
protected:
    void SetUp() override
    {
        if (!PerPixelGlslLowering::Available())
        {
            GTEST_SKIP() << "built without access to the projectM-Eval expression tree";
        }
        if (!libprojectM::Test::HeadlessGlContext::IsAvailable())
        {
            GTEST_SKIP() << "no headless OpenGL context available";
        }
        m_context = std::make_unique<libprojectM::Test::HeadlessGlContext>();
        if (!m_context->Valid() || !m_context->InitializeGlad())
        {
            GTEST_SKIP() << "could not create a headless OpenGL context";
        }
    }

    /**
     * @brief Asserts that the program lowers and that the GPU agrees with the CPU.
     */
    void ExpectAgrees(const std::string& code, unsigned seed = 1234u)
    {
        const auto lowering = LowerOrFail(code);
        ASSERT_TRUE(lowering.lowered) << "refused: " << lowering.reason << "\ncode: " << code;

        std::mt19937 rng(seed);
        const auto frame = MakeFrameState(rng);
        const auto vertices = MakeVertices(rng);

        std::vector<double> cpu;
        std::string error;
        ASSERT_TRUE(EvaluateOnCpu(code, frame, vertices, cpu, error)) << error;

        std::vector<double> gpu;
        ASSERT_TRUE(EvaluateOnGpu(lowering.glsl, frame, vertices, gpu, error))
            << error << "\ncode: " << code;

        std::string mismatch;
        double worstDrift = 0.0;
        EXPECT_TRUE(CompareResults(cpu, gpu, 1e-4, 1e-4, mismatch, worstDrift))
            << mismatch << "\ncode: " << code << "\n--- generated ---\n" << lowering.glsl;
    }

    /** @brief Asserts that the program is refused, with a reason mentioning @p needle. */
    void ExpectRefused(const std::string& code, const std::string& needle)
    {
        const auto lowering = LowerOrFail(code);
        EXPECT_FALSE(lowering.lowered) << "expected a refusal for: " << code;
        EXPECT_NE(lowering.reason.find(needle), std::string::npos)
            << "reason was: " << lowering.reason;
    }

    static auto LowerOrFail(const std::string& code) -> PerPixelGlslLowering::Result
    {
        PerPixelContext compileContext(nullptr, nullptr);
        compileContext.RegisterBuiltinVariables();
        compileContext.CompilePerPixelCode(code);
        return PerPixelGlslLowering::Lower(compileContext.perPixelCodeHandle);
    }

    std::unique_ptr<libprojectM::Test::HeadlessGlContext> m_context;
};

} // namespace

// --- Arithmetic, comparison and the guarded operators -------------------------------

TEST_F(PerPixelGlslLoweringTest, ArithmeticMatchesTheEvaluator)
{
    ExpectAgrees("zoom = 1 + x*2 - y/3; rot = -ang*0.25; warp = rad*rad;");
}

TEST_F(PerPixelGlslLoweringTest, DivisionByZeroYieldsZeroLikeTheEvaluator)
{
    // The evaluator returns 0 for a zero divisor instead of producing an infinity.
    ExpectAgrees("zoom = 1 / (x - x); rot = y / (rad - rad); warp = 3 / x;");
}

TEST_F(PerPixelGlslLoweringTest, ModuloIsIntegerTruncatingLikeTheEvaluator)
{
    // mod() in the evaluator truncates both operands to integer and takes a C
    // remainder; it is not GLSL's floating-point mod().
    ExpectAgrees("zoom = (x*10) % 3; rot = (y*7) % (x*2); warp = (rad*5) % 0;");
}

TEST_F(PerPixelGlslLoweringTest, ComparisonOperatorsReturnFloats)
{
    ExpectAgrees("zoom = above(x, 0.5) + below(y, 0.5)*0.25;"
                 "rot = equal(x, y)*0.5 + bnot(rad);"
                 "warp = (x >= y) + (x <= y) + (x != y);");
}

TEST_F(PerPixelGlslLoweringTest, BitwiseOperatorsTruncateToInteger)
{
    ExpectAgrees("zoom = 1 + ((5 & (x*10 - 0.5)) * 0.1); rot = ((x*8) | 3) * 0.01;");
}

TEST_F(PerPixelGlslLoweringTest, PowerHandlesNegativeBasesAndZeroExponents)
{
    ExpectAgrees("zoom = pow(x, 3); rot = pow(y, 2.5); warp = pow(x, 0); sx = pow(0, y);");
}

TEST_F(PerPixelGlslLoweringTest, MathFunctionsMatchTheEvaluatorGuards)
{
    // sqrt() takes the absolute value, log()/log10() clamp non-positive inputs to zero,
    // and asin()/acos() return zero outside [-1, 1] instead of NaN.
    ExpectAgrees("zoom = 1 + sqrt(x)*0.1 + log(y)*0.01 + log10(rad)*0.01;"
                 "rot = asin(x)*0.1 + acos(y)*0.1 + atan2(y, x)*0.1;"
                 "warp = abs(x) + sign(y) + sqr(rad)*0.1 + floor(x) + ceil(y);"
                 "sx = 1 + min(x, y)*0.1 + max(x, y)*0.1 + sigmoid(x, 2)*0.1;");
}

TEST_F(PerPixelGlslLoweringTest, TrigonometryMatches)
{
    ExpectAgrees("zoom = 1 + sin(x*6.28)*0.1; rot = cos(y*3.14)*0.2 + tan(rad)*0.01;"
                 "warp = atan(x)*0.5 + exp(-rad)*0.1;");
}

// --- Control flow -------------------------------------------------------------------

TEST_F(PerPixelGlslLoweringTest, IfEvaluatesOnlyTheTakenBranch)
{
    // A mix()-style lowering would run both branches and let the untaken assignment
    // leak into the result.
    ExpectAgrees("a = 0; b = 0;"
                 "zoom = if(above(x, 0.5), exec2(a = 2, a), exec2(b = 3, b));"
                 "rot = a*0.1 - b*0.1;");
}

TEST_F(PerPixelGlslLoweringTest, ShortCircuitOperatorsSkipTheirRightHandSide)
{
    // && and || only evaluate the second operand conditionally, so a side effect there
    // must not run when the operator short-circuits.
    ExpectAgrees("a = 0; c = 0;"
                 "zoom = 1 + (above(x, 0.5) && exec2(a = 1, 1))*0.1;"
                 "rot = (below(y, 0.5) || exec2(c = 1, 1))*0.1;"
                 "warp = a + c;");
}

TEST_F(PerPixelGlslLoweringTest, BandAndBorEvaluateBothArgumentsWithTheLargeEpsilon)
{
    // band()/bor() differ from &&/|| twice over: both arguments always run, and they
    // compare against 1e-5 rather than against zero.
    ExpectAgrees("a = 0; c = 0;"
                 "zoom = 1 + band(above(x, 0.5), exec2(a = 1, 1))*0.1;"
                 "rot = bor(above(x, 0.5), exec2(c = 1, 1))*0.1;"
                 "warp = a + c;"
                 "sx = 1 + band(0.000001, 1) + bor(0.000001, 0.000001);");
}

TEST_F(PerPixelGlslLoweringTest, LoopWithConstantBoundUnrolls)
{
    ExpectAgrees("a = 0; loop(8, a = a + x*0.01); zoom = 1 + a;");
}

TEST_F(PerPixelGlslLoweringTest, ZeroIterationLoopReturnsTheLoopCount)
{
    ExpectAgrees("a = 1; zoom = 1 + loop(0, a = a + 1)*0.01; rot = a*0.1;");
}

TEST_F(PerPixelGlslLoweringTest, CompoundAssignmentsReadTheTargetAfterTheRightHandSide)
{
    // The divisor avoids landing exactly on an integer before %=: truncation is the one
    // place where the double CPU and the 32-bit shader can disagree by a whole unit
    // rather than by an ulp (see "Precision" in docs/GPU_PERPIXEL_EVAL.md).
    ExpectAgrees("a = 2; a += x; a *= 1.5; a -= y; a /= 3.25; a %= 5;"
                 "zoom = 1 + a*0.01; rot = a*0.001;");
}

TEST_F(PerPixelGlslLoweringTest, ExecutionListsReturnTheirLastValue)
{
    ExpectAgrees("zoom = exec3(1, 2, 1 + x*0.1); rot = exec2(5, y*0.1);");
}

TEST_F(PerPixelGlslLoweringTest, PerVertexBuiltinsMayBeOverwritten)
{
    // x, y, rad and ang are re-seeded on every vertex, so writing them is local.
    ExpectAgrees("x = x*2; rad = rad*0.5; zoom = 1 + x*0.1; rot = rad*0.1;");
}

TEST_F(PerPixelGlslLoweringTest, ReadOnlyBuiltinsAndQVariablesAreReadable)
{
    ExpectAgrees("zoom = 1 + q1*0.1 + q32*0.1 + bass*0.01;"
                 "rot = time*0.001 + treb_att*0.01 + progress*0.1;"
                 "warp = meshx*0.001 + aspectx*0.1 + pixelsx*0.0001;");
}

// --- Refusals -----------------------------------------------------------------------

TEST_F(PerPixelGlslLoweringTest, RefusesMemoryAccess)
{
    ExpectRefused("megabuf(1) = x; zoom = megabuf(1);", "megabuf");
}

TEST_F(PerPixelGlslLoweringTest, RefusesWhileLoops)
{
    ExpectRefused("a = 0; while(exec2(a = a + 1, below(a, 10))); zoom = 1 + a*0.01;", "while");
}

TEST_F(PerPixelGlslLoweringTest, RefusesRand)
{
    ExpectRefused("zoom = 1 + rand(10)*0.01;", "rand");
}

TEST_F(PerPixelGlslLoweringTest, RefusesInvsqrt)
{
    // The evaluator uses a 64-bit fast inverse square root; GLSL's inversesqrt() is a
    // different function, so lowering it would silently change the picture.
    ExpectRefused("zoom = 1 + invsqrt(rad)*0.01;", "invsqrt");
}

TEST_F(PerPixelGlslLoweringTest, RefusesWritesToQVariables)
{
    // On the CPU q1 keeps the written value for the next vertex on the same context.
    ExpectRefused("q1 = x; zoom = 1 + q1*0.1;", "q1");
}

TEST_F(PerPixelGlslLoweringTest, RefusesWritesToReadOnlyBuiltins)
{
    ExpectRefused("time = 0; zoom = 1 + time;", "time");
}

TEST_F(PerPixelGlslLoweringTest, RefusesCarryStateLocals)
{
    // The canonical mashup IIR: thresh is read before it is ever assigned, so on the
    // CPU it carries over from the previous vertex.
    ExpectRefused("thresh = above(bass_att, thresh)*2 + "
                  "(1 - above(bass_att, thresh))*((thresh - 1.3)*0.96 + 1.3);"
                  "zoom = 1 + thresh*0.01;",
                  "thresh");
}

TEST_F(PerPixelGlslLoweringTest, RefusesLocalsAssignedOnlyInsideABranch)
{
    // A conditional assignment does not make the following read safe.
    ExpectRefused("if(above(x, 0.5), a = 1, 0); zoom = 1 + a*0.1;", "'a'");
}

TEST_F(PerPixelGlslLoweringTest, RefusesRegisterGlobals)
{
    ExpectRefused("reg00 = x; zoom = 1 + reg00*0.1;", "reg00");
}

TEST_F(PerPixelGlslLoweringTest, RefusesLoopsWithNonConstantBounds)
{
    ExpectRefused("a = 0; loop(x*10, a = a + 1); zoom = 1 + a*0.01;", "non-constant");
}

TEST_F(PerPixelGlslLoweringTest, RefusesOversizedLoops)
{
    ExpectRefused("a = 0; loop(4096, a = a + 1); zoom = 1 + a*0.0001;", "cap");
}

// --- Corpus -------------------------------------------------------------------------

namespace {

/**
 * @brief Tolerances for the corpus sweep.
 *
 * Two thresholds, because two different things are being checked.
 *
 * The hard one exists to catch a wrong operator. A mistake in the lowering table moves
 * a channel by whole units (integer mod against floating mod, a missing divide-by-zero
 * guard, a branch that should not have run), never by a fraction of a percent, so
 * anything past 2% is a semantic bug and fails the test.
 *
 * The tight one is the drift budget. It is not a hard failure, because a handful of
 * presets are genuinely ill-conditioned in 32 bits: pow() with an exponent in the tens
 * multiplies the input's relative error by that exponent, acos() near +/-1 has an
 * unbounded derivative, and tan() of a time in the tens loses most of its significant
 * digits to argument reduction. Those presets drift on any real GPU too. What the test
 * pins down is how *many* of them there are, so that a change which quietly makes the
 * translation less accurate shows up as a count regression rather than as a preset
 * that looks slightly wrong.
 */
constexpr double kCorpusAbsoluteTolerance = 2e-3;
constexpr double kCorpusRelativeTolerance = 2e-2;
constexpr double kCorpusTightDrift = 1e-3;

/** @brief Share of lowered presets allowed to exceed kCorpusTightDrift. */
constexpr double kCorpusTightDriftBudget = 0.02;

/** @brief Collects every .milk file below @p directory, if it exists. */
auto CollectPresets(const std::string& directory) -> std::vector<std::string>
{
    std::vector<std::string> presets;
    std::error_code error;
    if (!std::filesystem::is_directory(directory, error))
    {
        return presets;
    }
    for (const auto& entry : std::filesystem::recursive_directory_iterator(
             directory, std::filesystem::directory_options::skip_permission_denied, error))
    {
        if (entry.is_regular_file(error) && entry.path().extension() == ".milk")
        {
            presets.push_back(entry.path().string());
        }
    }
    std::sort(presets.begin(), presets.end());
    return presets;
}

} // namespace

/**
 * @brief Every preset in the tree either refuses with a reason, or its GPU translation
 *        reproduces the CPU evaluator.
 *
 * This is the classifier's real regression net: a lowering bug that only shows up on
 * one construct in one preset fails here, and the counts printed at the end are the
 * coverage number quoted in docs/GPU_PERPIXEL_EVAL.md.
 */
TEST_F(PerPixelGlslLoweringTest, PresetCorpusAgreesOrRefusesWithAReason)
{
    std::vector<std::string> presets;
    for (const auto* directory : {PROJECTM_PRESET_TESTS_DIR,
                                  PROJECTM_CUSTOM_MILK_FIXED_DIR,
                                  PROJECTM_WEEKS_PRESETS_DIR})
    {
        const auto found = CollectPresets(directory);
        presets.insert(presets.end(), found.begin(), found.end());
    }

    ASSERT_FALSE(presets.empty()) << "no presets found to check";

    std::mt19937 rng(9876u);
    const auto frame = MakeFrameState(rng);
    const auto vertices = MakeVertices(rng);

    int withCode = 0;
    int lowered = 0;
    int refused = 0;
    double worstCorpusDrift = 0.0;
    std::string worstCorpusPreset;
    std::vector<std::string> driftingPresets;
    std::map<std::string, int> refusalReasons;

    for (const auto& path : presets)
    {
        PresetFileParser parser;
        if (!parser.Read(path))
        {
            continue;
        }
        const auto code = parser.GetCode("per_pixel_");
        if (code.empty())
        {
            continue;
        }
        withCode++;

        PerPixelContext context(nullptr, nullptr);
        context.RegisterBuiltinVariables();
        try
        {
            context.CompilePerPixelCode(code);
        }
        catch (const std::exception&)
        {
            // Presets the evaluator itself rejects stay on the CPU error path.
            continue;
        }

        const auto lowering = PerPixelGlslLowering::Lower(context.perPixelCodeHandle);
        if (!lowering.lowered)
        {
            refused++;
            EXPECT_FALSE(lowering.reason.empty()) << "silent refusal for " << path;
            // Group by the first few words so the summary stays readable.
            const auto cut = lowering.reason.find(',');
            refusalReasons[lowering.reason.substr(0, std::min(cut, std::size_t{60}))]++;
            continue;
        }
        lowered++;

        std::vector<double> cpu;
        std::string error;
        ASSERT_TRUE(EvaluateOnCpu(code, frame, vertices, cpu, error)) << path << ": " << error;

        std::vector<double> gpu;
        ASSERT_TRUE(EvaluateOnGpu(lowering.glsl, frame, vertices, gpu, error))
            << path << ": " << error;

        std::string mismatch;
        double worstDrift = 0.0;
        EXPECT_TRUE(CompareResults(cpu, gpu, kCorpusAbsoluteTolerance,
                                   kCorpusRelativeTolerance, mismatch, worstDrift))
            << path << ": " << mismatch << "\n--- per_pixel ---\n" << code;
        if (worstDrift > worstCorpusDrift)
        {
            worstCorpusDrift = worstDrift;
            worstCorpusPreset = path;
        }
        if (worstDrift > kCorpusTightDrift)
        {
            driftingPresets.push_back(path + " (" + std::to_string(worstDrift) + ")");
        }
    }

    std::cout << "[  CORPUS  ] " << presets.size() << " presets, " << withCode
              << " with per-pixel code: " << lowered << " lowered to GPU, " << refused
              << " kept on CPU\n";
    std::cout << "[  CORPUS  ] worst CPU-vs-GPU drift " << worstCorpusDrift << " in "
              << worstCorpusPreset << "\n";
    for (const auto& drifting : driftingPresets)
    {
        std::cout << "[  CORPUS  ]   above " << kCorpusTightDrift << ": " << drifting << "\n";
    }
    for (const auto& reason : refusalReasons)
    {
        std::cout << "[  CORPUS  ]   " << reason.second << "x " << reason.first << "\n";
    }

    EXPECT_GT(lowered, 0) << "no preset in the tree lowers to the GPU path";
    EXPECT_LE(static_cast<double>(driftingPresets.size()),
              kCorpusTightDriftBudget * static_cast<double>(lowered))
        << driftingPresets.size() << " of " << lowered
        << " lowered presets drift further than " << kCorpusTightDrift
        << "; the translation got less accurate";
}
