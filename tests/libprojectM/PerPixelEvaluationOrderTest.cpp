/**
 * @file PerPixelEvaluationOrderTest.cpp
 * @brief The CPU per-pixel loop gives the same frame on one thread and on N (ABI v2, #352 C).
 *
 * PerPixelGlslLowering::ClassifyEvaluationOrder() decides at load whether a preset's per-pixel
 * program may be spread over the OpenMP context pool: only when no vertex can observe another
 * (no variable carried from vertex to vertex, no megabuf/gmegabuf/reg, no rand()). The first
 * group pins that classification on small programs. The second renders every preset in
 * presets/tests/ on the CPU per-pixel path with one thread and with four, and requires the same
 * pixels: a frame must not depend on how many threads the host gave OpenMP.
 */

#include "HeadlessGlContext.hpp"
#include "TestGl.hpp"

#include <MilkdropPreset/PerPixelContext.hpp>
#include <MilkdropPreset/PerPixelGlslLowering.hpp>
#include <MilkdropPreset/PresetFileParser.hpp>

#include <gtest/gtest.h>

#include <projectM-4/debug.h>
#include <projectM-4/offline_render.h>
#include <projectM-4/projectM.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <vector>

#ifdef PRJM_ENABLE_OPENMP
#include <omp.h>
#endif

using libprojectM::MilkdropPreset::PerPixelContext;
using libprojectM::MilkdropPreset::PerPixelGlslLowering;
using libprojectM::MilkdropPreset::PresetFileParser;

namespace {

/** @brief Compiles @p code the way a preset's per-pixel context does, and classifies it. */
auto Classify(const std::string& code) -> PerPixelGlslLowering::EvaluationOrder
{
    PerPixelContext context(nullptr, nullptr);
    context.RegisterBuiltinVariables();
    context.CompilePerPixelCode(code);
    return PerPixelGlslLowering::ClassifyEvaluationOrder(context.perPixelCodeHandle);
}

/** @brief Skips a test that needs the evaluator's expression tree. */
#define REQUIRE_TREE()                                                                          \
    if (!PerPixelGlslLowering::Available())                                                     \
    {                                                                                           \
        GTEST_SKIP() << "built against a projectM-Eval that does not expose the expression tree"; \
    }

} // namespace

// --- Classification ---------------------------------------------------------------------

TEST(PerPixelEvaluationOrder, NoCodeIsParallel)
{
    EXPECT_TRUE(PerPixelGlslLowering::ClassifyEvaluationOrder(nullptr).parallel);
    EXPECT_TRUE(Classify("").parallel);
}

TEST(PerPixelEvaluationOrder, WithoutTheTreeEveryProgramIsSerial)
{
    if (PerPixelGlslLowering::Available())
    {
        GTEST_SKIP() << "this build can inspect the tree";
    }
    const auto order = Classify("zoom = zoom + rad * 0.1;");
    EXPECT_FALSE(order.parallel);
    EXPECT_FALSE(order.reason.empty());
}

TEST(PerPixelEvaluationOrder, IndependentVerticesAreParallel)
{
    REQUIRE_TREE();
    for (const char* code : {
             "zoom = zoom + rad * 0.1; rot = rot + sin(ang) * q1 * bass;",
             "t = x * 2; dx = t * 0.01;",                       // a local assigned before it is read
             "x = x + 0.1; dx = x;",                            // per-vertex inputs are re-seeded
             "t = if(above(x, 0.5), 1, 2); dx = t;",            // assigned on every path
             "q1 = x; dx = q1;",                                // q written before it is read
             "t = 0; loop(4, t = t + x); dx = t;",              // carried only within the vertex
         })
    {
        const auto order = Classify(code);
        EXPECT_TRUE(order.parallel) << code << ": " << order.reason;
        EXPECT_TRUE(order.reason.empty()) << code;
    }
}

TEST(PerPixelEvaluationOrder, ACarriedVariableIsSerial)
{
    REQUIRE_TREE();
    for (const char* code : {
             "t = t * 0.9 + x * 0.1; dx = t;",         // an IIR filter across vertices
             "dx = t; t = x;",                         // read before this vertex assigns it
             "if(above(x, 0.5), t = 1, 0); dx = t;",   // assigned on one path only
             "dx = q1; q1 = x;",                       // q carried to the next vertex
         })
    {
        const auto order = Classify(code);
        EXPECT_FALSE(order.parallel) << code;
        EXPECT_NE(order.reason.find("carries over from the previous vertex"), std::string::npos)
            << code << ": " << order.reason;
    }
}

TEST(PerPixelEvaluationOrder, SharedStateIsSerial)
{
    REQUIRE_TREE();
    struct Case
    {
        const char* code;
        const char* reason;
    };
    for (const auto& item : {
             Case{"megabuf(1) = x; dx = megabuf(1);", "megabuf"},
             Case{"dx = megabuf(1);", "megabuf"},  // megabuf is per context: a pool context's is not the main one's
             Case{"gmegabuf(1) = x; dx = gmegabuf(1);", "megabuf"},
             Case{"reg00 = x; dx = reg00;", "reg00"},
             Case{"dx = reg01;", "reg00"},
             Case{"dx = rand(10) * 0.001;", "rand()"},
         })
    {
        const auto order = Classify(item.code);
        EXPECT_FALSE(order.parallel) << item.code;
        EXPECT_NE(order.reason.find(item.reason), std::string::npos) << item.code << ": " << order.reason;
    }
}

// The fixtures the thread test leans on: three that must run in order, one that may not.
TEST(PerPixelEvaluationOrder, FixturePresetsClassifyAsTheySay)
{
    REQUIRE_TREE();
    struct Case
    {
        const char* preset;
        bool parallel;
    };
    for (const auto& item : {
             Case{"110-per_pixel.milk", true},
             Case{"111-per_pixel-carried.milk", false},
             Case{"112-per_pixel-megabuf.milk", false},
             Case{"113-per_pixel-rand.milk", false},
             Case{"114-per_pixel-locals.milk", true},
         })
    {
        PresetFileParser parser;
        ASSERT_TRUE(parser.Read(std::string(PROJECTM_PRESET_TESTS_DIR) + "/" + item.preset)) << item.preset;
        const auto order = Classify(parser.GetCode("per_pixel_"));
        EXPECT_EQ(order.parallel, item.parallel) << item.preset << ": " << order.reason;
    }
}

// Report only: how much of the curated corpora the CPU loop may still spread over threads.
TEST(PerPixelEvaluationOrder, CorpusReport)
{
    REQUIRE_TREE();
    for (const char* directory : {PROJECTM_CUSTOM_MILK_FIXED_DIR, PROJECTM_WEEKS_PRESETS_DIR})
    {
        if (!std::filesystem::is_directory(directory))
        {
            continue;
        }
        int parallel = 0;
        int serial = 0;
        int noCode = 0;
        std::map<std::string, int> reasons;
        for (const auto& entry : std::filesystem::recursive_directory_iterator(directory))
        {
            if (entry.path().extension() != ".milk")
            {
                continue;
            }
            PresetFileParser parser;
            if (!parser.Read(entry.path().string()))
            {
                continue;
            }
            const auto code = parser.GetCode("per_pixel_");
            if (code.empty())
            {
                noCode++;
                continue;
            }
            PerPixelGlslLowering::EvaluationOrder order;
            try
            {
                order = Classify(code);
            }
            catch (const std::exception&)
            {
                continue; // does not compile; PresetCompat reports those
            }
            if (order.parallel)
            {
                parallel++;
                continue;
            }
            serial++;
            // "reads t before ..." -> one bucket for every carried variable.
            const auto bucket = order.reason.rfind("reads ", 0) == 0 ? std::string("a variable carries over from the previous vertex") : order.reason;
            reasons[bucket]++;
        }
        std::cout << "[  ORDER   ] " << std::filesystem::path(directory).filename().string() << ": " << parallel
                  << " parallel, " << serial << " serial, " << noCode << " without per-pixel code" << std::endl;
        for (const auto& reason : reasons)
        {
            std::cout << "[  ORDER   ]   " << reason.second << " x " << reason.first << std::endl;
        }
    }
}

// --- 1 thread vs N threads --------------------------------------------------------------

namespace {

constexpr int kWidth = 96;
constexpr int kHeight = 72;
constexpr int kFrames = 8;
constexpr int kThreads = 4; // the WASM build's pool
constexpr unsigned int kSamplesPerFrame = 735;
constexpr uint32_t kSeed = 0x5eed1234u;

class PerPixelThreadEquivalenceTest : public ::testing::Test
{
protected:
    void SetUp() override
    {
        if (!libprojectM::Test::HeadlessGlContext::IsAvailable())
        {
            GTEST_SKIP() << "no headless OpenGL context";
        }
        m_context = std::make_unique<libprojectM::Test::HeadlessGlContext>();
        if (!m_context->Valid() || !m_context->InitializeGlad())
        {
            GTEST_SKIP() << "could not create a headless OpenGL context";
        }
        glGenTextures(1, &m_texture);
        glBindTexture(GL_TEXTURE_2D, m_texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kWidth, kHeight, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        glGenFramebuffers(1, &m_framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_texture, 0);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }

    void TearDown() override
    {
        if (m_context && m_context->Valid())
        {
            glDeleteFramebuffers(1, &m_framebuffer);
            glDeleteTextures(1, &m_texture);
        }
    }

    /**
     * @brief Renders kFrames of @p path on the CPU per-pixel path with @p threads OpenMP
     *        threads; every frame's pixels, concatenated. Empty if projectM cannot run here.
     */
    auto Render(const std::string& path, int threads) -> std::vector<unsigned char>
    {
#ifdef PRJM_ENABLE_OPENMP
        // Before the engine and its preset exist: the preset sizes its context pool at load.
        const int previous = omp_get_max_threads();
        omp_set_num_threads(threads);
#else
        (void) threads;
#endif
        std::vector<unsigned char> pixels;
        auto* instance = projectm_create_seeded(kSeed);
        if (instance != nullptr)
        {
            projectm_set_render_path_flags(instance, PROJECTM_RENDER_PATH_PER_PIXEL_CPU);
            projectm_set_window_size(instance, kWidth, kHeight);
            // 65 x 49 vertices: above the 1000-vertex floor the parallel loop needs.
            projectm_set_mesh_size(instance, 64, 48);
            projectm_set_preset_duration(instance, 3600.0);
            projectm_set_soft_cut_duration(instance, 0.0);
            projectm_load_preset_file(instance, path.c_str(), false);

            std::vector<float> samples(kSamplesPerFrame * 2);
            std::vector<unsigned char> frame(static_cast<std::size_t>(kWidth) * kHeight * 4);
            for (int index = 0; index < kFrames; index++)
            {
                for (unsigned int i = 0; i < kSamplesPerFrame; i++)
                {
                    const double t = (index * kSamplesPerFrame + i) / 44100.0;
                    samples[i * 2] = 0.6F * static_cast<float>(std::sin(2.0 * 3.14159265358979 * 110.0 * t));
                    samples[i * 2 + 1] = samples[i * 2];
                }
                projectm_render_offline_frame(instance, samples.data(), kSamplesPerFrame, index / 60.0, m_framebuffer);
                glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
                glReadPixels(0, 0, kWidth, kHeight, GL_RGBA, GL_UNSIGNED_BYTE, frame.data());
                glBindFramebuffer(GL_FRAMEBUFFER, 0);
                pixels.insert(pixels.end(), frame.begin(), frame.end());
            }
            projectm_destroy(instance);
        }
#ifdef PRJM_ENABLE_OPENMP
        omp_set_num_threads(previous);
#endif
        return pixels;
    }

    std::unique_ptr<libprojectM::Test::HeadlessGlContext> m_context;
    GLuint m_texture{0};
    GLuint m_framebuffer{0};
};

#ifdef PRJM_ENABLE_OPENMP
/** @brief The first frame two renders differ in, or -1. */
auto FirstDifferingFrame(const std::vector<unsigned char>& first, const std::vector<unsigned char>& second) -> int
{
    const std::size_t frameBytes = static_cast<std::size_t>(kWidth) * kHeight * 4;
    for (int frame = 0; frame < kFrames; frame++)
    {
        const auto begin = static_cast<std::ptrdiff_t>(frame * frameBytes);
        const auto end = static_cast<std::ptrdiff_t>((frame + 1) * frameBytes);
        if (!std::equal(first.begin() + begin, first.begin() + end, second.begin() + begin))
        {
            return frame;
        }
    }
    return -1;
}
#endif

} // namespace

TEST_F(PerPixelThreadEquivalenceTest, OneThreadAndFourRenderTheSamePixels)
{
#ifndef PRJM_ENABLE_OPENMP
    GTEST_SKIP() << "built without OpenMP: there is only one thread";
#else
    std::vector<std::string> presets;
    for (const auto& entry : std::filesystem::directory_iterator(PROJECTM_PRESET_TESTS_DIR))
    {
        if (entry.path().extension() == ".milk")
        {
            presets.push_back(entry.path().string());
        }
    }
    std::sort(presets.begin(), presets.end());
    ASSERT_FALSE(presets.empty());

    int compared = 0;
    std::vector<std::string> unreproducible;
    for (const auto& path : presets)
    {
        const auto reference = Render(path, 1);
        if (reference.empty())
        {
            GTEST_SKIP() << "projectm_create() is unavailable with this context";
        }
        // A preset that differs from itself on one thread says nothing about threads.
        if (FirstDifferingFrame(reference, Render(path, 1)) >= 0)
        {
            unreproducible.push_back(std::filesystem::path(path).filename().string());
            continue;
        }
        const int frame = FirstDifferingFrame(reference, Render(path, kThreads));
        EXPECT_EQ(frame, -1) << std::filesystem::path(path).filename().string()
                             << ": " << kThreads << " threads render different pixels from one thread, from frame " << frame;
        compared++;
    }

    std::cout << "[ THREADS  ] " << compared << " presets compared, 1 vs " << kThreads << " threads";
    if (!unreproducible.empty())
    {
        std::cout << "; skipped, not reproducible on one thread:";
        for (const auto& name : unreproducible)
        {
            std::cout << " " << name;
        }
    }
    std::cout << std::endl;
    // Skips are for presets that are nondeterministic for some other reason; most must count.
    EXPECT_GE(compared, static_cast<int>(presets.size()) * 3 / 4);
#endif
}
