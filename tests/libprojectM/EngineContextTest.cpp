/**
 * @file EngineContextTest.cpp
 * @brief Per-engine random numbers (EngineContext): seeds, streams and scoping.
 *
 * Without GL: contexts with their own seeds draw independently of each other and of the
 * process default, the current context follows ScopedEngineContext, and streams on parallel
 * threads match the same streams drawn on one. On a headless GL context: two ProjectM
 * instances with different seeds, used interleaved, each render what they render alone.
 */

#include "HeadlessGlContext.hpp"
#include "TestGl.hpp"

#include <EngineContext.hpp>
#include <MilkdropPreset/EvalRandom.hpp>
#include <RandomSeed.hpp>

#include <gtest/gtest.h>

#include <projectM-4/debug.h>
#include <projectM-4/projectM.h>

#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <vector>

using libprojectM::EngineContext;
using libprojectM::ScopedEngineContext;

namespace {

auto Draw(EngineContext& context, int count) -> std::vector<uint32_t>
{
    std::vector<uint32_t> values;
    for (int i = 0; i < count; i++)
    {
        values.push_back(context.NextRandom());
    }
    return values;
}

class EngineContextTest : public testing::Test
{
protected:
    void TearDown() override
    {
        EngineContext::SetProcessSeed(std::nullopt);
    }
};

} // namespace

TEST_F(EngineContextTest, OwnSeedIsReproducibleAndIndependent)
{
    EngineContext first;
    EngineContext second;
    EngineContext again;
    first.SetSeed(1);
    second.SetSeed(2);
    again.SetSeed(1);

    EXPECT_TRUE(first.IsDeterministic());
    EXPECT_EQ(first.SeedFor("PresetState"), again.SeedFor("PresetState"));
    EXPECT_NE(first.SeedFor("PresetState"), second.SeedFor("PresetState"));
    EXPECT_NE(first.SeedFor("PresetState"), first.SeedFor("PresetTransition"));

    // Drawing from one stream does not move another.
    const auto firstValues = Draw(first, 8);
    Draw(second, 100);
    EXPECT_EQ(firstValues, Draw(again, 8));
    EXPECT_NE(firstValues, Draw(second, 8));
}

TEST_F(EngineContextTest, ProcessSeedAppliesToContextsWithoutTheirOwn)
{
    EngineContext follower;
    EngineContext own;
    own.SetSeed(7);
    const auto ownValues = Draw(own, 4);

    EngineContext::SetProcessSeed(7);
    EXPECT_TRUE(follower.IsDeterministic());
    EXPECT_EQ(follower.SeedFor("PresetState"), own.SeedFor("PresetState"));
    // Setting the process seed restarts the followers' streams, as srand() did.
    EXPECT_EQ(Draw(follower, 4), ownValues);

    EngineContext::SetProcessSeed(9);
    EXPECT_NE(follower.SeedFor("PresetState"), own.SeedFor("PresetState")) << "the own seed stays";

    EngineContext::SetProcessSeed(std::nullopt);
    EXPECT_FALSE(follower.IsDeterministic());
    EXPECT_TRUE(own.IsDeterministic());

    own.SetSeed(std::nullopt);
    EXPECT_FALSE(own.IsDeterministic());
}

TEST_F(EngineContextTest, CurrentFollowsTheInnermostScope)
{
    EngineContext outer;
    EngineContext inner;
    outer.SetSeed(11);
    inner.SetSeed(12);

    EXPECT_EQ(&EngineContext::Current(), &EngineContext::ProcessDefault());
    {
        const ScopedEngineContext outerScope(outer);
        EXPECT_EQ(&EngineContext::Current(), &outer);
        EXPECT_EQ(libprojectM::RandomSeed::Get("PresetState"), outer.SeedFor("PresetState"));
        {
            const ScopedEngineContext innerScope(inner);
            EXPECT_EQ(&EngineContext::Current(), &inner);
        }
        EXPECT_EQ(&EngineContext::Current(), &outer);
    }
    EXPECT_EQ(&EngineContext::Current(), &EngineContext::ProcessDefault());
}

TEST_F(EngineContextTest, ParallelThreadsDrawTheirOwnStreams)
{
    constexpr int kDraws = 20000;
    EngineContext referenceA;
    EngineContext referenceB;
    referenceA.SetSeed(100);
    referenceB.SetSeed(200);
    const auto expectedA = Draw(referenceA, kDraws);
    const auto expectedB = Draw(referenceB, kDraws);

    EngineContext a;
    EngineContext b;
    a.SetSeed(100);
    b.SetSeed(200);
    std::vector<uint32_t> gotA;
    std::vector<uint32_t> gotB;
    const auto drawCurrent = [](EngineContext& context, std::vector<uint32_t>& out) {
        const ScopedEngineContext scope(context);
        for (int i = 0; i < kDraws; i++)
        {
            out.push_back(libprojectM::RandomSeed::Next());
        }
    };
    std::thread threadA(drawCurrent, std::ref(a), std::ref(gotA));
    std::thread threadB(drawCurrent, std::ref(b), std::ref(gotB));
    threadA.join();
    threadB.join();

    EXPECT_EQ(gotA, expectedA);
    EXPECT_EQ(gotB, expectedB);
}

#ifdef PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE
TEST_F(EngineContextTest, EvalRandFollowsTheEngineSeed)
{
    // rand() in preset code: an expression context seeded under an engine draws a stream
    // that only that engine's seed decides.
    const auto drawEval = [](EngineContext& engine) {
        const ScopedEngineContext scope(engine);
        auto* context = projectm_eval_context_create(nullptr, nullptr);
        libprojectM::MilkdropPreset::SeedEvalRandom(context);
        auto* code = projectm_eval_code_compile(context, "rand(1000000)");
        std::vector<double> values;
        for (int i = 0; i < 16; i++)
        {
            values.push_back(projectm_eval_code_execute(code));
        }
        projectm_eval_code_destroy(code);
        projectm_eval_context_destroy(context);
        return values;
    };

    EngineContext first;
    EngineContext again;
    EngineContext other;
    first.SetSeed(42);
    again.SetSeed(42);
    other.SetSeed(43);
    const auto firstValues = drawEval(first);
    drawEval(other);
    EXPECT_EQ(drawEval(again), firstValues);
    EXPECT_NE(drawEval(other), firstValues);
}
#endif

namespace {

constexpr int kSize = 16;

class EngineSeedRenderTest : public testing::Test
{
protected:
    static void SetUpTestSuite()
    {
        if (!libprojectM::Test::HeadlessGlContext::IsAvailable())
        {
            return;
        }
        s_context = std::make_unique<libprojectM::Test::HeadlessGlContext>();
        if (!s_context->Valid() || !s_context->InitializeGlad())
        {
            s_context.reset();
        }
    }

    static void TearDownTestSuite()
    {
        s_context.reset();
    }

    void SetUp() override
    {
        if (s_context == nullptr || !s_context->MakeCurrent())
        {
            GTEST_SKIP() << "could not create a headless OpenGL context";
        }
        glGenTextures(1, &m_texture);
        glBindTexture(GL_TEXTURE_2D, m_texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kSize, kSize, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        glGenFramebuffers(1, &m_framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_texture, 0);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }

    void TearDown() override
    {
        if (m_framebuffer != 0)
        {
            glDeleteFramebuffers(1, &m_framebuffer);
            glDeleteTextures(1, &m_texture);
        }
    }

    auto CreateEngine(uint32_t seed) -> projectm_handle
    {
        auto* instance = projectm_create();
        if (instance != nullptr)
        {
            projectm_set_seed(instance, seed);
            projectm_set_window_size(instance, kSize, kSize);
            projectm_set_preset_duration(instance, 3600.0);
            projectm_set_soft_cut_duration(instance, 0.0);
            projectm_load_preset_file(instance, (std::string(PROJECTM_PRESET_TESTS_DIR) + "/271-compshader-rand-preset.milk").c_str(), false);
        }
        return instance;
    }

    auto RenderAndRead(projectm_handle instance, int frame) -> std::vector<unsigned char>
    {
        projectm_set_frame_time(instance, frame / 60.0);
        projectm_opengl_render_frame_fbo(instance, m_framebuffer);
        std::vector<unsigned char> pixels(kSize * kSize * 4);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glReadPixels(0, 0, kSize, kSize, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        return pixels;
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
    GLuint m_texture{0};
    GLuint m_framebuffer{0};
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> EngineSeedRenderTest::s_context;

} // namespace

TEST_F(EngineSeedRenderTest, InterleavedEnginesRenderWhatTheyRenderAlone)
{
    constexpr int kFrames = 4;

    std::vector<std::vector<unsigned char>> aloneA;
    {
        auto* a = CreateEngine(1);
        if (a == nullptr)
        {
            GTEST_SKIP() << "projectm_create() is unavailable with this context";
        }
        for (int frame = 0; frame < kFrames; frame++)
        {
            aloneA.push_back(RenderAndRead(a, frame));
        }
        projectm_destroy(a);
    }

    // Created, loaded and rendered interleaved with B: under the old process-wide libc rand()
    // stream, B's shader draws shifted A's.
    auto* b = CreateEngine(2);
    auto* a = CreateEngine(1);
    auto* b2 = CreateEngine(2);
    ASSERT_NE(a, nullptr);
    ASSERT_NE(b, nullptr);
    ASSERT_NE(b2, nullptr);
    std::vector<unsigned char> lastB;
    for (int frame = 0; frame < kFrames; frame++)
    {
        lastB = RenderAndRead(b, frame);
        RenderAndRead(b2, frame);
        EXPECT_EQ(RenderAndRead(a, frame), aloneA.at(frame)) << "frame " << frame;
    }
    EXPECT_NE(lastB, aloneA.back()) << "different seeds should draw different rand_preset colors";

    projectm_destroy(b2);
    projectm_destroy(a);
    projectm_destroy(b);
}
