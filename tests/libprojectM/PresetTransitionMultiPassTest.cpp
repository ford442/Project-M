#include "HeadlessGlContext.hpp"

#include "Renderer/OpenGL.h"
#include "Renderer/PresetTransition.hpp"
#include "Renderer/TransitionShaderManager.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <vector>

namespace {

using libprojectM::Renderer::PresetTransition;
using libprojectM::Renderer::TransitionBlendMode;
using libprojectM::Renderer::TransitionShaderManager;
using libprojectM::Test::HeadlessGlContext;

class PresetTransitionMultiPassTest : public ::testing::Test
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
            GTEST_SKIP() << "Failed to create headless OpenGL context for multi-pass tests.";
        }

        m_shaderManager = std::make_unique<TransitionShaderManager>();
        ASSERT_GT(m_shaderManager->CompiledShaderCount(), 0u);

        while (glGetError() != GL_NO_ERROR)
        {
        }
    }

    std::unique_ptr<HeadlessGlContext> m_glContext;
    std::unique_ptr<TransitionShaderManager> m_shaderManager;
};

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

TEST_F(PresetTransitionMultiPassTest, PassCountClamping)
{
    const auto shader = m_shaderManager->CompiledShaderAt(0);
    ASSERT_NE(shader, nullptr);

    PresetTransition transition(shader, 1.0, 0.0);

    transition.SetPassCount(0);
    EXPECT_EQ(transition.PassCount(), 1);

    transition.SetPassCount(5);
    EXPECT_EQ(transition.PassCount(), 2);

    transition.SetPassCount(2);
    EXPECT_EQ(transition.PassCount(), 2);
}

TEST_F(PresetTransitionMultiPassTest, BlendModeRoundTrip)
{
    const auto shader = m_shaderManager->CompiledShaderAt(0);
    ASSERT_NE(shader, nullptr);

    PresetTransition transition(shader, 1.0, 0.0);

    transition.SetBlendMode(TransitionBlendMode::Screen);
    EXPECT_EQ(transition.GetBlendMode(), TransitionBlendMode::Screen);

    transition.SetBlendMode(TransitionBlendMode::Additive);
    EXPECT_EQ(transition.GetBlendMode(), TransitionBlendMode::Additive);
}

TEST_F(PresetTransitionMultiPassTest, MultiPassShadersCompileAndRegisterPassCount)
{
    int multiPassCount = 0;
    int maxPassCount = 0;

    for (std::size_t i = 0; i < m_shaderManager->CompiledShaderCount(); ++i)
    {
        const auto shader = m_shaderManager->CompiledShaderAt(i);
        ASSERT_NE(shader, nullptr);

        const int passCount = m_shaderManager->PassCountAt(i);
        EXPECT_EQ(passCount, m_shaderManager->GetPassCount(shader));
        EXPECT_GE(passCount, 1);
        EXPECT_LE(passCount, 2);

        maxPassCount = std::max(maxPassCount, passCount);
        if (passCount > 1)
        {
            ++multiPassCount;
        }
    }

    EXPECT_GE(multiPassCount, 3) << "Expected at least PageCurl, HeatWave, and Glitch to be multi-pass.";
    EXPECT_EQ(maxPassCount, 2);
}

TEST_F(PresetTransitionMultiPassTest, IntermediateFramebufferIsReusedAcrossPasses)
{
    const auto shaderIndex = FindMultiPassShaderIndex(*m_shaderManager);
    ASSERT_LT(shaderIndex, m_shaderManager->CompiledShaderCount());

    const auto shader = m_shaderManager->CompiledShaderAt(shaderIndex);
    ASSERT_NE(shader, nullptr);

    PresetTransition transition(shader, 1.0, 0.0);
    transition.SetPassCount(2);

    transition.BeginPass(0, 64, 64);
    const auto firstPassTex = transition.GetPassTexture(0);
    ASSERT_NE(firstPassTex, nullptr);
    const auto firstTextureId = firstPassTex->TextureID();
    ASSERT_NE(firstTextureId, 0u);
    transition.EndPass();

    for (int i = 0; i < 100; ++i)
    {
        transition.BeginPass(0, 64, 64);
        const auto passTex = transition.GetPassTexture(0);
        ASSERT_NE(passTex, nullptr);
        EXPECT_EQ(passTex->TextureID(), firstTextureId);
        transition.EndPass();
    }

    while (glGetError() != GL_NO_ERROR)
    {
    }
}

TEST_F(PresetTransitionMultiPassTest, RapidTransitionInstancesDoNotLeakTextures)
{
    const auto shaderIndex = FindMultiPassShaderIndex(*m_shaderManager);
    ASSERT_LT(shaderIndex, m_shaderManager->CompiledShaderCount());

    const auto shader = m_shaderManager->CompiledShaderAt(shaderIndex);
    ASSERT_NE(shader, nullptr);

    GLuint maxTextureId = 0;

    for (int i = 0; i < 100; ++i)
    {
        PresetTransition transition(shader, 0.5, 0.0);
        transition.SetPassCount(2);
        transition.BeginPass(0, 64, 64);
        const auto passTex = transition.GetPassTexture(0);
        ASSERT_NE(passTex, nullptr);
        maxTextureId = std::max(maxTextureId, passTex->TextureID());
        transition.EndPass();
    }

    // One intermediate FBO texture at a time; leaked textures would push IDs much higher.
    EXPECT_LT(maxTextureId, 128u);

    while (glGetError() != GL_NO_ERROR)
    {
    }
}

TEST_F(PresetTransitionMultiPassTest, PassStateIsResetAfterEndPass)
{
    const auto shaderIndex = FindMultiPassShaderIndex(*m_shaderManager);
    ASSERT_LT(shaderIndex, m_shaderManager->CompiledShaderCount());

    const auto shader = m_shaderManager->CompiledShaderAt(shaderIndex);
    ASSERT_NE(shader, nullptr);

    PresetTransition transition(shader, 1.0, 0.0);
    transition.SetPassCount(2);

    transition.BeginPass(0, 64, 64);
    EXPECT_EQ(transition.GetCurrentPass(), 0);
    transition.EndPass();
    EXPECT_EQ(transition.GetCurrentPass(), -1);

    transition.BeginPass(1, 64, 64);
    EXPECT_EQ(transition.GetCurrentPass(), 1);
    transition.EndPass();
    EXPECT_EQ(transition.GetCurrentPass(), -1);
}
