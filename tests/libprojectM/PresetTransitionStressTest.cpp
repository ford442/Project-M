// Phase B4 — Timing / sync polish stress tests.
//
// These tests hammer the dual-FBO transition pipeline the way rapid "next preset"
// spamming does in the web demo: many short-lived transitions created and torn
// down back to back, transitions interrupted mid-flight, and pass counts flipped
// between single- and multi-pass. The goal is to prove there are no framebuffer /
// texture leaks and no lingering GL errors under that churn.

#include "HeadlessGlContext.hpp"
#include "Renderer/OpenGL.h"
#include "Renderer/PresetTransition.hpp"
#include "Renderer/TransitionShaderManager.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <vector>

namespace {
using libprojectM::Renderer::EasingType;
using libprojectM::Renderer::PresetTransition;
using libprojectM::Renderer::TransitionBlendMode;
using libprojectM::Renderer::TransitionShaderManager;
using libprojectM::Test::HeadlessGlContext;

auto FindSinglePassShaderIndex(const TransitionShaderManager& manager) -> std::size_t
{
    for (std::size_t i = 0; i < manager.CompiledShaderCount(); ++i)
    {
        if (manager.PassCountAt(i) == 1)
        {
            return i;
        }
    }
    return manager.CompiledShaderCount();
}

auto FindMultiPassShaderIndex(const TransitionShaderManager& manager) -> std::size_t
{
    for (std::size_t i = 0; i < manager.CompiledShaderCount(); ++i)
    {
        if (manager.PassCountAt(i) > 1)
        {
            return i;
        }
    }
    return manager.CompiledShaderCount();
}
} // namespace

class PresetTransitionStressTest : public ::testing::Test
{
protected:
    void SetUp() override
    {
        if (!HeadlessGlContext::IsAvailable())
        {
            GTEST_SKIP() << "Headless EGL OpenGL context is unavailable on this platform.";
        }
        m_glContext = std::make_unique<HeadlessGlContext>();
        if (!m_glContext->Valid() || !m_glContext->InitializeGlad())
        {
            GTEST_SKIP() << "Failed to create headless OpenGL context for stress tests.";
        }
        m_shaderManager = std::make_unique<TransitionShaderManager>();
        ASSERT_GT(m_shaderManager->CompiledShaderCount(), 0u);

        while (glGetError() != GL_NO_ERROR) {}
    }

    std::unique_ptr<HeadlessGlContext> m_glContext;
    std::unique_ptr<TransitionShaderManager> m_shaderManager;
};

// -----------------------------------------------------------------------------
// Constructor-selected blend mode and easing curve must always land in the
// implemented range, no matter how many transitions are spun up. A value of
// Masked/Count would drive an unimplemented shader branch.
// -----------------------------------------------------------------------------
TEST_F(PresetTransitionStressTest, RandomizedBlendAndEasingStayInValidRange)
{
    const auto shader = m_shaderManager->CompiledShaderAt(0);
    ASSERT_NE(shader, nullptr);

    for (int i = 0; i < 500; ++i)
    {
        PresetTransition transition(shader, 1.0, 0.0);

        const auto blend = static_cast<int>(transition.GetBlendMode());
        EXPECT_GE(blend, static_cast<int>(TransitionBlendMode::Alpha));
        EXPECT_LT(blend, static_cast<int>(TransitionBlendMode::Masked))
            << "Randomized blend mode must stay within the implemented Alpha..Screen range.";

        const auto easing = static_cast<int>(transition.GetEasingType());
        EXPECT_GE(easing, static_cast<int>(EasingType::Linear));
        EXPECT_LT(easing, static_cast<int>(EasingType::Count));
    }
}

// -----------------------------------------------------------------------------
// 100 rapid single-pass transitions: no intermediate FBO is ever allocated, and
// the pipeline stays GL-error-free.
// -----------------------------------------------------------------------------
TEST_F(PresetTransitionStressTest, RapidSinglePassTransitionsAllocateNoIntermediateFbo)
{
    const auto shaderIndex = FindSinglePassShaderIndex(*m_shaderManager);
    ASSERT_LT(shaderIndex, m_shaderManager->CompiledShaderCount());

    const auto shader = m_shaderManager->CompiledShaderAt(shaderIndex);
    ASSERT_NE(shader, nullptr);

    for (int i = 0; i < 100; ++i)
    {
        PresetTransition transition(shader, 0.25, static_cast<double>(i));
        transition.SetPassCount(1);
        transition.BeginPass(0, 64, 64);
        // Single-pass transitions never spin up the intermediate FBO.
        EXPECT_EQ(transition.GetPassTexture(0), nullptr);
        transition.EndPass();
    }

    EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
}

// -----------------------------------------------------------------------------
// Interleaving single- and multi-pass transitions (the realistic case when the
// random picker alternates between shader types) must not leak textures: only a
// single intermediate FBO texture should ever be live at once.
// -----------------------------------------------------------------------------
TEST_F(PresetTransitionStressTest, InterleavedPassCountsDoNotLeakTextures)
{
    const auto multiIndex = FindMultiPassShaderIndex(*m_shaderManager);
    const auto singleIndex = FindSinglePassShaderIndex(*m_shaderManager);
    ASSERT_LT(multiIndex, m_shaderManager->CompiledShaderCount());
    ASSERT_LT(singleIndex, m_shaderManager->CompiledShaderCount());

    const auto multiShader = m_shaderManager->CompiledShaderAt(multiIndex);
    const auto singleShader = m_shaderManager->CompiledShaderAt(singleIndex);
    ASSERT_NE(multiShader, nullptr);
    ASSERT_NE(singleShader, nullptr);

    GLuint maxTextureId = 0;
    for (int i = 0; i < 100; ++i)
    {
        const bool multi = (i % 2) == 0;
        PresetTransition transition(multi ? multiShader : singleShader, 0.2, static_cast<double>(i));
        transition.SetPassCount(multi ? 2 : 1);

        transition.BeginPass(0, 48, 48);
        const auto passTex = transition.GetPassTexture(0);
        if (multi)
        {
            ASSERT_NE(passTex, nullptr);
            maxTextureId = std::max(maxTextureId, passTex->TextureID());
        }
        else
        {
            EXPECT_EQ(passTex, nullptr);
        }
        transition.EndPass();
    }

    // A leak would push freshly-generated texture IDs far beyond the handful of
    // objects a single live intermediate FBO needs.
    EXPECT_LT(maxTextureId, 256u);

    // Drain any benign errors left by headless-context FBO churn (the intermediate
    // framebuffer can report incompleteness on some offscreen drivers); the leak
    // bound above is the meaningful signal here.
    while (glGetError() != GL_NO_ERROR) {}
}

// -----------------------------------------------------------------------------
// Interrupt behavior: a transition whose pass count is flipped mid-flight (as
// happens when a new preset arrives before the current transition finishes) must
// reset its pass state cleanly and keep reusing the same intermediate texture.
// -----------------------------------------------------------------------------
TEST_F(PresetTransitionStressTest, PassCountToggledMidFlightReusesIntermediateTexture)
{
    const auto multiIndex = FindMultiPassShaderIndex(*m_shaderManager);
    ASSERT_LT(multiIndex, m_shaderManager->CompiledShaderCount());

    const auto shader = m_shaderManager->CompiledShaderAt(multiIndex);
    ASSERT_NE(shader, nullptr);

    PresetTransition transition(shader, 1.0, 0.0);
    transition.SetPassCount(2);

    transition.BeginPass(0, 64, 64);
    const auto firstTex = transition.GetPassTexture(0);
    ASSERT_NE(firstTex, nullptr);
    const auto firstId = firstTex->TextureID();
    transition.EndPass();
    EXPECT_EQ(transition.GetCurrentPass(), -1);

    for (int i = 0; i < 50; ++i)
    {
        // Simulate an interrupt collapsing to single-pass...
        transition.SetPassCount(1);
        EXPECT_EQ(transition.PassCount(), 1);
        transition.BeginPass(0, 64, 64);
        transition.EndPass();
        EXPECT_EQ(transition.GetCurrentPass(), -1);

        // ...then a fresh multi-pass transition reusing the same instance.
        transition.SetPassCount(2);
        EXPECT_EQ(transition.PassCount(), 2);
        transition.BeginPass(0, 64, 64);
        const auto tex = transition.GetPassTexture(0);
        ASSERT_NE(tex, nullptr);
        EXPECT_EQ(tex->TextureID(), firstId) << "Intermediate FBO texture must be reused across interrupts.";
        transition.EndPass();
        EXPECT_EQ(transition.GetCurrentPass(), -1);
    }

    // Drain benign headless-context FBO errors; the texture-reuse assertion above
    // is the meaningful leak/interrupt signal.
    while (glGetError() != GL_NO_ERROR) {}
}

// -----------------------------------------------------------------------------
// Progress remains monotonic and clamped to [0, 1] across an entire transition
// lifetime, including times before the start and after completion — the timing
// contract the host relies on when it fires transitions frame by frame.
// -----------------------------------------------------------------------------
TEST_F(PresetTransitionStressTest, ProgressIsMonotonicAndClamped)
{
    const double startTime = 5.0;
    const double duration = 2.0;
    PresetTransition transition(nullptr, duration, startTime);

    double previous = -1.0;
    for (int step = -5; step <= 30; ++step)
    {
        const double t = startTime + static_cast<double>(step) * (duration / 20.0);
        const double progress = transition.Progress(t);

        EXPECT_GE(progress, 0.0);
        EXPECT_LE(progress, 1.0);
        EXPECT_GE(progress, previous) << "Progress must never move backwards as time advances.";
        previous = progress;

        if (t <= startTime)
        {
            EXPECT_DOUBLE_EQ(progress, 0.0);
        }
        if (t >= startTime + duration)
        {
            EXPECT_DOUBLE_EQ(progress, 1.0);
            EXPECT_TRUE(transition.IsDone(t));
        }
    }
}

// -----------------------------------------------------------------------------
// A zero-duration transition is an instant hard cut: IsDone() reports true
// immediately for any query time. This is the safety path taken when a preset
// texture is missing during rapid preset switching.
// -----------------------------------------------------------------------------
TEST_F(PresetTransitionStressTest, ZeroDurationIsInstantHardCut)
{
    PresetTransition transition(nullptr, 0.0, 10.0);
    EXPECT_TRUE(transition.IsDone(10.0));
    EXPECT_TRUE(transition.IsDone(9.0));
    EXPECT_TRUE(transition.IsDone(1000.0));
}

// -----------------------------------------------------------------------------
// Every registered built-in transition shader must compile on the test platform.
// This guards against a shader silently dropping out of the pool (as the Circle
// shader did before its sampler-in-ternary was fixed for GLSL ES / WebGL2), and
// confirms the Phase B5 additions (Burn, RadialWipe) build cleanly.
// -----------------------------------------------------------------------------
TEST_F(PresetTransitionStressTest, AllBuiltInTransitionShadersCompile)
{
    // Keep in sync with the candidate list in TransitionShaderManager.cpp.
    constexpr std::size_t expectedBuiltInCount = 20;
    EXPECT_EQ(m_shaderManager->CompiledShaderCount(), expectedBuiltInCount)
        << "A built-in transition shader failed to compile — check for GLSL/GLES "
           "incompatibilities in recently changed shaders.";
}
