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
 *
 * Programs with a CPU slice (carried locals, rand(), ...) are run the way PerPixelMesh
 * runs them: the slice on the lowered program's own context, one vertex at a time in
 * vertex order, handing its values to the shader as vertex attributes. The reference is
 * the evaluator on one context, also in vertex order. That is the single-threaded CPU
 * path: with PRJM_ENABLE_OPENMP the CPU path splits the vertices across per-thread
 * contexts, each carrying its own copy of the state, so its output depends on the thread
 * count and there is no exact multi-threaded reference to compare against.
 */

#include "HeadlessGlContext.hpp"

#include <MilkdropPreset/Constants.hpp>
#include <MilkdropPreset/PerPixelContext.hpp>
#include <MilkdropPreset/PerPixelGlslLowering.hpp>
#include <MilkdropPreset/PresetFileParser.hpp>

#include <glad/gl.h>

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <random>
#include <string>
#include <vector>

#ifdef PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE
extern "C" {
#include <projectm-eval/CompilerTypes.h>
#include <projectm-eval/TreeFunctions.h>
}
#endif

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


/** @brief Compiles @p code on a fresh context, the way PerPixelContext does for a preset. */
auto CompileProgram(const std::string& code, std::unique_ptr<PerPixelContext>& context, std::string& error) -> bool
{
    context = std::make_unique<PerPixelContext>(nullptr, nullptr);
    context->RegisterBuiltinVariables();

    try
    {
        context->CompilePerPixelCode(code);
    }
    catch (const std::exception& exception)
    {
        error = exception.what();
        return false;
    }
    return true;
}

/** @brief Loads one frame's read-only values and q variables, as PerFrameUpdate() does. */
void LoadFrame(PerPixelContext& context, const FrameState& frame)
{
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
}

auto Channels(PerPixelContext& context) -> std::array<PRJM_EVAL_F*, kChannelCount>
{
    return {context.zoom, context.zoomexp, context.rot, context.warp,
            context.cx, context.cy, context.dx, context.dy,
            context.sx, context.sy};
}

/** @brief Seeds one vertex, as CalculateMesh() does before running the program. */
void SeedVertex(PerPixelContext& context, const FrameState& frame, const VertexInput& vertex)
{
    *context.x = vertex.x;
    *context.y = vertex.y;
    *context.rad = vertex.rad;
    *context.ang = vertex.ang;
    const auto channels = Channels(context);
    for (int i = 0; i < kChannelCount; i++)
    {
        *channels[i] = frame.seeds[i];
    }
}

/**
 * @brief Runs the per-pixel program on the CPU exactly the way CalculateMesh() does
 *        without OpenMP: one context, every vertex in order.
 *
 * The context keeps its variables between calls, so calling this again evaluates the next
 * frame, with whatever the program carried over from the last vertex of this one.
 */
void EvaluateOnCpu(PerPixelContext& context,
                   const FrameState& frame,
                   const std::vector<VertexInput>& vertices,
                   std::vector<double>& results)
{
    LoadFrame(context, frame);
    const auto channels = Channels(context);

    results.clear();
    results.reserve(vertices.size() * kChannelCount);

    for (const auto& vertex : vertices)
    {
        SeedVertex(context, frame, vertex);
        context.ExecutePerPixelCode();

        for (auto* channel : channels)
        {
            results.push_back(static_cast<double>(*channel));
        }
    }
}

// --- A resettable rand() --------------------------------------------------------------

#ifdef PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE

std::mt19937 g_standInRandom;
std::uint64_t g_standInDraws{};

/** @brief prjm_eval_func_rand's scaling, drawing from a generator the test can rewind. */
void StandInRand(prjm_eval_exptreenode* ctx, PRJM_EVAL_F** ret_val)
{
    PRJM_EVAL_F argument{};
    PRJM_EVAL_F* argumentPointer = &argument;
    ctx->args[0]->func(ctx->args[0], &argumentPointer);

    PRJM_EVAL_F randMax = std::floor(*argumentPointer);
    if (randMax < 1.0)
    {
        randMax = 1.0;
    }

    g_standInDraws++;
    **ret_val = static_cast<PRJM_EVAL_F>(static_cast<double>(g_standInRandom()) * (1.0 / static_cast<double>(0xFFFFFFFFu)) * randMax);
}

void ReplaceRand(prjm_eval_exptreenode* node)
{
    if (node == nullptr || node->func == nullptr ||
        node->func == prjm_eval_func_const || node->func == prjm_eval_func_var)
    {
        return;
    }
    if (node->func == prjm_eval_func_rand)
    {
        node->func = StandInRand;
    }
    if (node->func == prjm_eval_func_execute_list)
    {
        for (auto* item = node->list; item != nullptr; item = item->next)
        {
            ReplaceRand(item->expr);
        }
    }
    if (node->args != nullptr)
    {
        for (auto** argument = node->args; *argument != nullptr; argument++)
        {
            ReplaceRand(*argument);
        }
    }
}

#endif

/**
 * @brief Makes rand() in this context's program draw from a generator ResetRand() rewinds.
 *
 * The real rand() is Milkdrop's process-wide Mersenne Twister, which nothing can rewind, so
 * two runs of the same program would otherwise never see the same numbers. Call it after
 * lowering: the lowering recognises rand() by its function pointer.
 */
void UseResettableRand(PerPixelContext& context)
{
#ifdef PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE
    auto* program = reinterpret_cast<prjm_eval_program_t*>(context.perPixelCodeHandle);
    if (program != nullptr)
    {
        ReplaceRand(program->program);
    }
#else
    (void) context;
#endif
}

/** @brief Rewinds the stand-in rand() to @p seed and zeroes its draw counter. */
void ResetRand(unsigned seed)
{
#ifdef PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE
    g_standInRandom.seed(seed);
    g_standInDraws = 0;
#else
    (void) seed;
#endif
}

/** @brief How many numbers the stand-in rand() has handed out since ResetRand(). */
auto RandDraws() -> std::uint64_t
{
#ifdef PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE
    return g_standInDraws;
#else
    return 0;
#endif
}

// --- The GPU side ---------------------------------------------------------------------

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

/** @brief A lowered program, and the context whose compiled tree its CPU slice runs. */
struct LoweredProgram
{
    std::unique_ptr<PerPixelContext> context;
    PerPixelGlslLowering::Result lowering;
};

/**
 * @brief Runs the program the way the GPU path does: the CPU slice, if any, on the lowered
 *        context in vertex order; then the generated function in a vertex shader, evaluated
 *        with transform feedback, one point per vertex, with the slice's values as the
 *        vertex attributes PerPixelMesh uploads.
 */
auto EvaluateOnGpu(LoweredProgram& lowered,
                   const FrameState& frame,
                   const std::vector<VertexInput>& vertices,
                   std::vector<double>& results,
                   std::string& error) -> bool
{
    const auto& lowering = lowered.lowering;

    // The CPU slice first, exactly as PerPixelMesh::RunCpuSlice() runs it.
    const int valueCount = lowering.cpuSlice ? lowering.cpuSlice->ValueCount() : 0;
    std::vector<float> sliceValues;
    if (lowering.cpuSlice)
    {
        LoadFrame(*lowered.context, frame);
        sliceValues.resize(vertices.size() * PerPixelGlslLowering::MaxCpuValues);
        for (std::size_t index = 0; index < vertices.size(); index++)
        {
            SeedVertex(*lowered.context, frame, vertices[index]);
            lowering.cpuSlice->Execute(&sliceValues[index * PerPixelGlslLowering::MaxCpuValues]);
        }
    }

    std::string source = "#version 330\n";
    source += lowering.glsl;
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
    const GLint qLocation = glGetUniformLocation(program, "u_pp_q");
    if (qLocation >= 0)
    {
        // One call for the whole array, as PerPixelMesh::SetPerPixelUniforms() does.
        std::array<float, QVarCount> q{};
        for (int i = 0; i < QVarCount; i++)
        {
            q[static_cast<std::size_t>(i)] = static_cast<float>(frame.q[i]);
        }
        glUniform4fv(qLocation, QVarCount / 4, q.data());
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

    // The slice's values, one buffer per attribute location, laid out the way the lowering
    // says: CpuValueAttributeLocation() for each value, filling each attribute in order.
    std::map<int, std::vector<int>> valuesByLocation;
    for (int value = 0; value < valueCount; value++)
    {
        valuesByLocation[PerPixelGlslLowering::CpuValueAttributeLocation(value)].push_back(value);
    }
    std::vector<GLuint> sliceBuffers;
    for (const auto& entry : valuesByLocation)
    {
        const int location = entry.first;
        const int width = location == 4 ? 4 : 2;
        std::vector<float> data(vertices.size() * static_cast<std::size_t>(width), 0.0f);
        for (std::size_t vertex = 0; vertex < vertices.size(); vertex++)
        {
            for (std::size_t component = 0; component < entry.second.size(); component++)
            {
                data[vertex * static_cast<std::size_t>(width) + component] =
                    sliceValues[vertex * PerPixelGlslLowering::MaxCpuValues + static_cast<std::size_t>(entry.second[component])];
            }
        }
        GLuint buffer = 0;
        glGenBuffers(1, &buffer);
        glBindBuffer(GL_ARRAY_BUFFER, buffer);
        glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(data.size() * sizeof(float)), data.data(), GL_STATIC_DRAW);
        glEnableVertexAttribArray(static_cast<GLuint>(location));
        glVertexAttribPointer(static_cast<GLuint>(location), width, GL_FLOAT, GL_FALSE, 0, nullptr);
        sliceBuffers.push_back(buffer);
    }

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
    if (!sliceBuffers.empty())
    {
        glDeleteBuffers(static_cast<GLsizei>(sliceBuffers.size()), sliceBuffers.data());
    }
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

/**
 * @brief Per-vertex work with no carried state.
 *
 * Appended to the fixtures whose point is a small carried part, so they have a realistic
 * ratio of GPU work to the part that must stay on the CPU (real presets are mostly this).
 * Without it the carried part alone is more than PerPixelGlslLowering::MaxCpuShare of the
 * program, and the lowering rightly refuses.
 */
const std::string kIndependentWork =
    "p1 = sin(x*3.1 + time)*cos(y*2.7 - time*0.5) + sin(rad*5.3)*0.2;"
    "p2 = pow(abs(p1) + 0.5, 1.3)*atan2(y - 0.5, x - 0.5) + cos(ang*3 + bass);"
    "p3 = sqrt(x*x + y*y)*sin(ang*4 + p2) + cos(p1*p2*2.1) - sin(rad*rad*7 + treb);"
    "p4 = if(above(p3, 0.2), sin(p3*x*9 + mid), cos(p3*y*8 - time)) + min(p1, p2)*max(p2, p3);"
    "p5 = sigmoid(p4 - 0.1, 5)*exp(-rad*2) + log(abs(p3) + 1)*0.3 + sqr(p1 - p2)*0.1;"
    "p6 = sin(p5*q1 + p4*q2)*cos(p3*q3 - p2*q4) + atan(p1*q5 + p2*q6)*0.25 + q7*p5*p4;"
    "zoom = zoom + 0.01*p5 + 0.005*p4 + 0.002*p6; rot = rot + 0.01*p2 - 0.004*p3;"
    "warp = warp + 0.1*p1; cx = cx + 0.01*sin(p4*3); cy = cy + 0.01*cos(p5*2);"
    "sx = sx + 0.01*p3 - 0.003*p6; sy = sy - 0.01*p2;";

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
     * @brief Asserts that the program lowers and that the GPU path agrees with the CPU.
     *
     * Runs @p frames consecutive frames on both sides, so state a program carries over
     * from the last vertex of one frame into the next is compared too.
     */
    void ExpectAgrees(const std::string& code, int frames = 2, unsigned seed = 1234u)
    {
        LoweredProgram lowered;
        LowerOrFail(code, lowered);
        ASSERT_TRUE(lowered.lowering.lowered) << "refused: " << lowered.lowering.reason << "\ncode: " << code;

        std::unique_ptr<PerPixelContext> reference;
        std::string error;
        ASSERT_TRUE(CompileProgram(code, reference, error)) << error;

        UseResettableRand(*lowered.context);
        UseResettableRand(*reference);

        std::mt19937 rng(seed);
        const auto vertices = MakeVertices(rng);

        for (int frame = 0; frame < frames; frame++)
        {
            const auto frameState = MakeFrameState(rng);

            ResetRand(seed + static_cast<unsigned>(frame));
            std::vector<double> cpu;
            EvaluateOnCpu(*reference, frameState, vertices, cpu);
            const auto cpuDraws = RandDraws();

            ResetRand(seed + static_cast<unsigned>(frame));
            std::vector<double> gpu;
            ASSERT_TRUE(EvaluateOnGpu(lowered, frameState, vertices, gpu, error))
                << error << "\ncode: " << code;
            const auto gpuDraws = RandDraws();

            // rand() advances one generator shared with every other evaluation context, so
            // the GPU path must consume exactly as many numbers as the CPU would.
            EXPECT_EQ(cpuDraws, gpuDraws) << "frame " << frame << "\ncode: " << code;

            std::string mismatch;
            double worstDrift = 0.0;
            EXPECT_TRUE(CompareResults(cpu, gpu, 1e-4, 1e-4, mismatch, worstDrift))
                << "frame " << frame << ": " << mismatch << "\ncode: " << code
                << "\n--- generated ---\n"
                << lowered.lowering.glsl;
        }
    }

    /** @brief Asserts that the program is refused, with a reason mentioning @p needle. */
    void ExpectRefused(const std::string& code, const std::string& needle)
    {
        LoweredProgram lowered;
        LowerOrFail(code, lowered);
        EXPECT_FALSE(lowered.lowering.lowered) << "expected a refusal for: " << code;
        EXPECT_NE(lowered.lowering.reason.find(needle), std::string::npos)
            << "reason was: " << lowered.lowering.reason;
    }

    static void LowerOrFail(const std::string& code, LoweredProgram& lowered)
    {
        std::string error;
        ASSERT_TRUE(CompileProgram(code, lowered.context, error)) << error;
        lowered.lowering = PerPixelGlslLowering::Lower(lowered.context->perPixelCodeHandle);
    }

    /** @brief The CPU slice the program lowers with, or null (also when it is refused). */
    static auto SliceOf(const std::string& code, LoweredProgram& lowered) -> const PerPixelGlslLowering::CpuSlice*
    {
        LowerOrFail(code, lowered);
        return lowered.lowering.cpuSlice.get();
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

TEST_F(PerPixelGlslLoweringTest, FloatLiteralsBeyondTheFloatRangeAreClamped)
{
    // 1e300 is an ordinary double on the CPU but has no float representation. Emitted
    // as-is, ANGLE rejects the shader or turns the literal into an infinity (and then
    // 0 * inf is NaN); clamped to +/-FLT_MAX it behaves like the CPU wherever the result
    // fits in a float at all.
    ExpectAgrees("zoom = 1 + min(1e300, x)*0.1; rot = max(-1e300, y)*0.1;"
                 "warp = below(x, 1e300) + above(-1e300, y); sx = 1 + (x*0)*1e300;");

    LoweredProgram lowered;
    LowerOrFail("zoom = 1 + min(1e300, x);", lowered);
    ASSERT_TRUE(lowered.lowering.lowered) << lowered.lowering.reason;
    EXPECT_EQ(lowered.lowering.glsl.find("e+300"), std::string::npos) << lowered.lowering.glsl;
    EXPECT_NE(lowered.lowering.glsl.find("3.40282347e+38"), std::string::npos) << lowered.lowering.glsl;
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

TEST_F(PerPixelGlslLoweringTest, AssignedOnBothBranchesCountsAsAssigned)
{
    // Neither branch alone makes 'a' definitely assigned; both together do, so the read
    // afterwards sees this vertex's value and nothing has to stay on the CPU.
    const std::string code = "if(above(x, 0.5), a = 2, a = 3); zoom = 1 + a*0.1;";
    ExpectAgrees(code);
    LoweredProgram lowered;
    EXPECT_EQ(SliceOf(code, lowered), nullptr);
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

TEST_F(PerPixelGlslLoweringTest, NegativeLoopBoundRunsNoIteration)
{
    ExpectAgrees("a = 1; b = loop(-3.5, a = a + 1); zoom = 1 + a*0.1 + b*0.01 + x*0.01;");
}

TEST_F(PerPixelGlslLoweringTest, HugeNegativeLoopBoundIsNotConvertedToAnInteger)
{
    // Converting -1e300 to an integer is undefined behaviour, so the bound must be range
    // checked as a double first (the sanitizer build traps otherwise). Only the lowering
    // is checked here: the evaluator's own loop() performs that very conversion.
    LoweredProgram lowered;
    LowerOrFail("a = 1; loop(-1e300, a = a + 1); zoom = 1 + a*0.1 + x*0.01;", lowered);
    ASSERT_TRUE(lowered.lowering.lowered) << lowered.lowering.reason;
    EXPECT_EQ(lowered.lowering.glsl.find("for ("), std::string::npos) << lowered.lowering.glsl;
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

// --- Variables ------------------------------------------------------------------------

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

TEST_F(PerPixelGlslLoweringTest, EmptyProgramPassesTheSeedsThrough)
{
    // A per-pixel block that is only comments compiles to no program. It does nothing on
    // the CPU, so on the GPU it is the empty function, not a reason to stay on the CPU.
    const std::string code = "// zoom = 1 + cos(16*x)*.03;";
    ExpectAgrees(code);
    LoweredProgram lowered;
    EXPECT_EQ(SliceOf(code, lowered), nullptr);
}

TEST_F(PerPixelGlslLoweringTest, LocalsNothingAssignsReadAsZero)
{
    // 'dir' is never written, so it keeps the zero it was registered with on every vertex;
    // there is nothing to carry.
    const std::string code = "dx = cos(dir)*0.01 + x*0.01; dy = -sin(dir)*0.01 + pi*y;";
    ExpectAgrees(code);
    LoweredProgram lowered;
    EXPECT_EQ(SliceOf(code, lowered), nullptr);
}

TEST_F(PerPixelGlslLoweringTest, QWrittenBeforeItIsReadIsAPlainLocal)
{
    // q1 is reloaded from the per-frame value every frame, and this program assigns it
    // before reading it on every vertex, so no vertex sees another vertex's q1.
    const std::string code = "q1 = 4.05 + (sin(x + 0.237*time) - cos(y + 0.513*time));"
                             "zoom = if(above(x, 0.5), q1*0.1, zoom*0.95); rot = q1*0.01 + q2;";
    ExpectAgrees(code);
    LoweredProgram lowered;
    EXPECT_EQ(SliceOf(code, lowered), nullptr);
}

TEST_F(PerPixelGlslLoweringTest, ReadOnlyBuiltinWrittenBeforeItIsReadIsAPlainLocal)
{
    ExpectAgrees("time = 0; zoom = 1 + time + x*0.1;");
}

TEST_F(PerPixelGlslLoweringTest, NonCanonicalQNamesAreOrdinaryLocals)
{
    // The evaluator registers exactly q1..q32. 'q01' is a different variable, a preset
    // local that starts at zero -- not q1.
    ExpectAgrees("zoom = 1 + q01*0.1 + q1*0.1; rot = q001*0.1 + q3*0.01;");
    ExpectAgrees("q01 = x; zoom = 1 + q01*0.1 + q1*0.1;");
}

// --- Statements that stay on the CPU --------------------------------------------------

TEST_F(PerPixelGlslLoweringTest, CarriedThresholdRunsOnTheCpuAndAgrees)
{
    // The canonical mashup IIR. thresh, dx_r and dy_r carry over from vertex to vertex
    // (and frame to frame), so those three statements run on the CPU in vertex order and
    // everything else runs in the shader.
    const std::string code =
        "thresh = above(bass_att,thresh)*2+(1-above(bass_att,thresh))*((thresh-1.3)*0.96+1.3);"
        "dx_r = equal(thresh,2)*0.015*sin(5*time)+(1-equal(thresh,2))*dx_r;"
        "dy_r = equal(thresh,2)*0.015*sin(6*time)+(1-equal(thresh,2))*dy_r;" +
        kIndependentWork +
        "dx = dx + dx_r*sin(x*12); dy = dy + dy_r*cos(y*9);";
    ExpectAgrees(code, 3);

    LoweredProgram lowered;
    const auto* slice = SliceOf(code, lowered);
    ASSERT_NE(slice, nullptr) << lowered.lowering.reason;
    EXPECT_EQ(slice->StatementCount(), 3);
    EXPECT_EQ(slice->ValueCount(), 2) << "only dx_r and dy_r are read by the shader";
    EXPECT_LE(slice->CostShare(), PerPixelGlslLowering::MaxCpuShare);
    EXPECT_NE(lowered.lowering.cpuSliceReason.find("thresh"), std::string::npos) << lowered.lowering.cpuSliceReason;
}

TEST_F(PerPixelGlslLoweringTest, PreviousVertexValuesCarryOver)
{
    // 'oy' is last vertex's y: only the CPU, going in vertex order, knows it.
    ExpectAgrees("dy = dy + (y - oy)*0.5;" + kIndependentWork + "oy = y;", 2);
}

TEST_F(PerPixelGlslLoweringTest, CompoundAssignmentOfACarriedLocalIsNotReadAsZero)
{
    // 'a += ...' reads 'a' first. Before it is assigned on this vertex that is the value
    // the previous vertex left, which the GPU cannot know.
    const std::string code = "a += 0.001; zoom = zoom + a;" + kIndependentWork;
    ExpectAgrees(code, 2);
    LoweredProgram lowered;
    EXPECT_NE(SliceOf(code, lowered), nullptr);
}

TEST_F(PerPixelGlslLoweringTest, QCarriedAcrossVerticesIsReloadedEveryFrame)
{
    // q9 is read before this vertex writes it, so it is last vertex's x -- except on the
    // first vertex of a frame, which sees the per-frame value.
    ExpectAgrees("zoom = zoom + q9*0.01;" + kIndependentWork + "q9 = x;", 3);
}

TEST_F(PerPixelGlslLoweringTest, RandRunsOnTheCpuInVertexOrder)
{
    ExpectAgrees("rot = rot + (rand(10) - 5)*0.001; rot = rot + rad*0.01;" + kIndependentWork, 2);
}

TEST_F(PerPixelGlslLoweringTest, UnconditionalRandIsTheOnlyThingTheCpuRuns)
{
    // Only the call runs on the CPU; the statement around it, and the argument's
    // per-frame inputs, stay in the shader. Even a program this small goes to the GPU.
    const std::string code = "rot = rot + ((rand(10) - 5)*.001); rot = rot + (rad*.01);"
                             "zoom = zoom + rand(int(fps*5))*0.0001*sin(x*7);";
    ExpectAgrees(code, 2);

    LoweredProgram lowered;
    const auto* slice = SliceOf(code, lowered);
    ASSERT_NE(slice, nullptr) << lowered.lowering.reason;
    EXPECT_EQ(slice->StatementCount(), 0);
    EXPECT_EQ(slice->RandCallCount(), 2);
    EXPECT_EQ(slice->ValueCount(), 2);
}

TEST_F(PerPixelGlslLoweringTest, RandInAStatementTheCpuAlsoNeedsIsDrawnOnce)
{
    // 'b' carries over, and its update reads 'a', so the CPU needs the statement holding
    // rand() as a whole. Making the call separately as well would draw two numbers.
    ExpectAgrees("a = rand(100)*0.01; b = b*0.9 + a;" + kIndependentWork + "zoom = zoom + b*0.001;", 2);
}

TEST_F(PerPixelGlslLoweringTest, ConditionalRandConsumesTheSameNumbers)
{
    // Whether rand() runs depends on this vertex; the CPU slice must take the same
    // branches, or everything drawn after it -- here and in every other context -- shifts.
    ExpectAgrees("mq = if(above(x, 0.6), rand(3), mq);" + kIndependentWork + "zoom = zoom + mq*0.01;", 2);
}

TEST_F(PerPixelGlslLoweringTest, MegabufInASmallSliceAgrees)
{
    ExpectAgrees("megabuf(3) = megabuf(3) + 1; zoom = zoom + megabuf(3)*0.00001;" + kIndependentWork, 2);
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

TEST_F(PerPixelGlslLoweringTest, RefusesConditionalRandThatIsMostOfTheProgram)
{
    // Whether rand() runs depends on the vertex, so the whole statement stays on the CPU,
    // and here that statement is the whole program.
    ExpectRefused("zoom = if(above(x, 0.5), 1 + rand(10)*0.01, 1);", "rand");
}

TEST_F(PerPixelGlslLoweringTest, RefusesInvsqrt)
{
    // The evaluator uses a 64-bit fast inverse square root; GLSL's inversesqrt() is a
    // different function, so lowering it would silently change the picture.
    ExpectRefused("zoom = 1 + invsqrt(rad)*0.01;", "invsqrt");
}

TEST_F(PerPixelGlslLoweringTest, RefusesCarryStateLocalsThatAreMostOfTheProgram)
{
    // Without other work, keeping the carried part on the CPU is the whole program.
    ExpectRefused("thresh = above(bass_att, thresh)*2 + "
                  "(1 - above(bass_att, thresh))*((thresh - 1.3)*0.96 + 1.3);"
                  "zoom = 1 + thresh*0.01;",
                  "thresh");
    ExpectRefused("thresh = above(bass_att, thresh)*2 + "
                  "(1 - above(bass_att, thresh))*((thresh - 1.3)*0.96 + 1.3);"
                  "zoom = 1 + thresh*0.01;",
                  "per-vertex work");
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

TEST_F(PerPixelGlslLoweringTest, RefusesHugeLoopBoundsWithoutConvertingThem)
{
    // 1e300 does not fit any integer type; converting it first would be undefined
    // behaviour (the sanitizer build traps on it). exp(1000)*0 folds to a NaN constant.
    ExpectRefused("a = 0; loop(1e300, a = a + 1); zoom = 1 + a*0.0001;", "cap");
    ExpectRefused("a = 0; loop(exp(1000)*0, a = a + 1); zoom = 1 + a*0.0001;", "NaN");
}

TEST_F(PerPixelGlslLoweringTest, RefusesSlicesThatHandOverTooManyValues)
{
    // Eleven carried locals, each read by the shader: one value more than the four
    // warp-mesh attributes can carry.
    std::string code;
    for (int index = 0; index < 11; index++)
    {
        const auto n = std::to_string(index);
        code += "v" + n + " = c" + n + "*1; c" + n + " = x*" + n + ";";
    }
    code += "zoom = zoom + (v0 + v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9 + v10)*0.001;";
    code += kIndependentWork + kIndependentWork + kIndependentWork;
    ExpectRefused(code, "cap of 10");
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

/**
 * @brief Presets with per-pixel code that must reach the GPU path, of the 241 in the tree.
 *
 * #227 Phase 1 lowered 186. Phase 1.5 (docs/GPU_PERPIXEL_EVAL.md) set the bar at 220. The
 * number is a floor: raise it when coverage grows, never lower it to make a change pass.
 */
constexpr int kCorpusLoweredFloor = 220;

/** @brief Frames evaluated per preset, so state carried from one frame into the next is compared. */
constexpr int kCorpusFrames = 2;

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
    std::vector<FrameState> frames;
    for (int frame = 0; frame < kCorpusFrames; frame++)
    {
        frames.push_back(MakeFrameState(rng));
    }
    const auto vertices = MakeVertices(rng);

    int withCode = 0;
    int notCompiling = 0;
    int lowered = 0;
    int withSlice = 0;
    int refused = 0;
    double worstCorpusDrift = 0.0;
    std::string worstCorpusPreset;
    std::vector<std::string> driftingPresets;
    std::map<std::string, int> refusalReasons;
    std::vector<std::string> refusals;
    std::vector<std::string> slices;

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

        LoweredProgram program;
        std::string error;
        if (!CompileProgram(code, program.context, error))
        {
            // Presets the evaluator itself rejects stay on the CPU error path.
            notCompiling++;
            continue;
        }

        program.lowering = PerPixelGlslLowering::Lower(program.context->perPixelCodeHandle);
        if (!program.lowering.lowered)
        {
            refused++;
            EXPECT_FALSE(program.lowering.reason.empty()) << "silent refusal for " << path;
            // Group by the first few words so the summary stays readable.
            const auto cut = program.lowering.reason.find_first_of(",;");
            refusalReasons[program.lowering.reason.substr(0, std::min(cut, std::size_t{60}))]++;
            refusals.push_back(std::filesystem::path(path).filename().string() + ": " + program.lowering.reason);
            continue;
        }
        lowered++;
        if (program.lowering.cpuSlice)
        {
            withSlice++;
            slices.push_back(std::filesystem::path(path).filename().string() + ": " + program.lowering.cpuSliceReason);
        }

        std::unique_ptr<PerPixelContext> reference;
        ASSERT_TRUE(CompileProgram(code, reference, error)) << path << ": " << error;
        UseResettableRand(*program.context);
        UseResettableRand(*reference);

        double worstDrift = 0.0;
        for (int frame = 0; frame < kCorpusFrames; frame++)
        {
            ResetRand(4321u + static_cast<unsigned>(frame));
            std::vector<double> cpu;
            EvaluateOnCpu(*reference, frames[static_cast<std::size_t>(frame)], vertices, cpu);
            const auto cpuDraws = RandDraws();

            ResetRand(4321u + static_cast<unsigned>(frame));
            std::vector<double> gpu;
            ASSERT_TRUE(EvaluateOnGpu(program, frames[static_cast<std::size_t>(frame)], vertices, gpu, error))
                << path << ": " << error;
            EXPECT_EQ(cpuDraws, RandDraws()) << path << ": the GPU path consumed a different number of rand() draws";

            std::string mismatch;
            EXPECT_TRUE(CompareResults(cpu, gpu, kCorpusAbsoluteTolerance,
                                       kCorpusRelativeTolerance, mismatch, worstDrift))
                << path << " frame " << frame << ": " << mismatch << "\n--- per_pixel ---\n"
                << code;
        }

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
              << " with per-pixel code: " << lowered << " lowered to GPU (" << withSlice
              << " of them with a CPU slice), " << refused << " kept on CPU, " << notCompiling
              << " rejected by the evaluator\n";
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
    for (const auto& refusal : refusals)
    {
        std::cout << "[  CORPUS  ]     " << refusal << "\n";
    }
    for (const auto& slice : slices)
    {
        std::cout << "[  CORPUS  ]   cpu slice: " << slice << "\n";
    }

    EXPECT_GT(lowered, 0) << "no preset in the tree lowers to the GPU path";
    if (std::filesystem::is_directory(PROJECTM_WEEKS_PRESETS_DIR))
    {
        EXPECT_GE(lowered, kCorpusLoweredFloor)
            << "GPU per-pixel coverage regressed: " << lowered << " of " << withCode << " presets lower";
    }
    EXPECT_LE(static_cast<double>(driftingPresets.size()),
              kCorpusTightDriftBudget * static_cast<double>(lowered))
        << driftingPresets.size() << " of " << lowered
        << " lowered presets drift further than " << kCorpusTightDrift
        << "; the translation got less accurate";
}
