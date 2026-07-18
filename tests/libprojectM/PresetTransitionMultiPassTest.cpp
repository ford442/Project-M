#include "GlOffscreenContext.hpp"

#include <Renderer/Framebuffer.hpp>
#include <Renderer/PresetTransition.hpp>
#include <Renderer/Shader.hpp>
#include <Renderer/Texture.hpp>
#include <Renderer/TextureManager.hpp>
#include <Renderer/TransitionShaderManager.hpp>

#include <Preset.hpp>

#include <gtest/gtest.h>

#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include <EGL/egl.h>
#include <glad/gl.h>

namespace {

using libprojectM::Preset;
using libprojectM::Renderer::Framebuffer;
using libprojectM::Renderer::PresetTransition;
using libprojectM::Renderer::RenderContext;
using libprojectM::Renderer::Texture;
using libprojectM::Renderer::TransitionBlendMode;
using libprojectM::Renderer::TransitionShaderManager;

class MockPreset : public Preset
{
public:
    explicit MockPreset(std::shared_ptr<Texture> texture)
        : m_texture(std::move(texture))
    {
    }

    void Initialize(const RenderContext&) override {}
    void RenderFrame(const libprojectM::Audio::FrameAudioData&, const RenderContext&) override {}
    auto OutputTexture() const -> std::shared_ptr<Texture> override { return m_texture; }
    void DrawInitialImage(const std::shared_ptr<Texture>&, const RenderContext&) override {}
    void BindFramebuffer() override {}

private:
    std::shared_ptr<Texture> m_texture;
};

std::string ReadShaderSource(const std::string& relativePath)
{
    const std::string fullPath = std::string(PROJECTM_SOURCE_DIR) + "/" + relativePath;
    std::ifstream stream(fullPath);
    if (!stream.good())
    {
        return {};
    }

    std::ostringstream buffer;
    buffer << stream.rdbuf();
    return buffer.str();
}

bool ShaderUsesMultiPass(const std::string& source)
{
    return source.find("iPass") != std::string::npos &&
           source.find("iLastPassTex") != std::string::npos;
}

class PresetTransitionMultiPassTest : public ::testing::Test
{
protected:
    void SetUp() override
    {
        if (!m_gl.IsValid())
        {
            GTEST_SKIP() << "EGL offscreen GL unavailable: " << m_gl.Reason();
        }

        if (!gladLoadGL(reinterpret_cast<GLADloadfunc>(eglGetProcAddress)))
        {
            GTEST_SKIP() << "gladLoadGL failed";
        }

        m_textureManager = std::make_unique<libprojectM::Renderer::TextureManager>(std::vector<std::string>{});
        m_context.viewportSizeX = 64;
        m_context.viewportSizeY = 64;
        m_context.aspectX = 1.0f;
        m_context.aspectY = 1.0f;
        m_context.invAspectX = 1.0f;
        m_context.invAspectY = 1.0f;
        m_context.textureManager = m_textureManager.get();

        m_oldTexture = std::make_shared<Texture>("old", 64, 64, false);
        m_newTexture = std::make_shared<Texture>("new", 64, 64, false);
        m_oldPreset = std::make_unique<MockPreset>(m_oldTexture);
        m_newPreset = std::make_unique<MockPreset>(m_newTexture);

        m_shaderManager = std::make_unique<TransitionShaderManager>();
    }

    GlOffscreenContext m_gl;
    std::unique_ptr<libprojectM::Renderer::TextureManager> m_textureManager;
    RenderContext m_context{};
    std::shared_ptr<Texture> m_oldTexture;
    std::shared_ptr<Texture> m_newTexture;
    std::unique_ptr<MockPreset> m_oldPreset;
    std::unique_ptr<MockPreset> m_newPreset;
    std::unique_ptr<TransitionShaderManager> m_shaderManager;
    libprojectM::Audio::FrameAudioData m_audioData{};
};

} // namespace

TEST_F(PresetTransitionMultiPassTest, PassCountIsClampedToTwoPasses)
{
  PresetTransition transition(nullptr, 3.0, 0.0);

  transition.SetPassCount(0);
  EXPECT_EQ(transition.PassCount(), 1);

  transition.SetPassCount(2);
  EXPECT_EQ(transition.PassCount(), 2);

  transition.SetPassCount(99);
  EXPECT_EQ(transition.PassCount(), 2);
}

TEST_F(PresetTransitionMultiPassTest, BlendModeRoundTrip)
{
  PresetTransition transition(nullptr, 3.0, 0.0);

  transition.SetBlendMode(TransitionBlendMode::Screen);
  EXPECT_EQ(transition.GetBlendMode(), TransitionBlendMode::Screen);
}

TEST_F(PresetTransitionMultiPassTest, ProgressAndCompletion)
{
  PresetTransition transition(nullptr, 2.0, 10.0);

  EXPECT_DOUBLE_EQ(transition.Progress(10.0), 0.0);
  EXPECT_FALSE(transition.IsDone(11.0));
  EXPECT_DOUBLE_EQ(transition.Progress(11.0), 0.5);
  EXPECT_TRUE(transition.IsDone(12.0));
  EXPECT_DOUBLE_EQ(transition.Progress(12.0), 1.0);
}

TEST(MultiPassShaderSourceTest, KnownTransitionsDeclareMultiPassUniforms)
{
  const std::vector<std::pair<std::string, int>> multiPassShaders = {
      {"src/libprojectM/Renderer/TransitionShaders/TransitionShaderBuiltInPageCurlGlsl330.frag", 2},
      {"src/libprojectM/Renderer/TransitionShaders/TransitionShaderBuiltInHeatWaveGlsl330.frag", 2},
      {"src/libprojectM/Renderer/TransitionShaders/TransitionShaderBuiltInGlitchGlsl330.frag", 2},
      {"src/libprojectM/Renderer/TransitionShaders/TransitionShaderBuiltInMultiPassTestGlsl330.frag", 2},
  };

  for (const auto& [path, expectedPasses] : multiPassShaders)
  {
    const auto source = ReadShaderSource(path);
    ASSERT_FALSE(source.empty()) << "Missing shader source: " << path;
    EXPECT_TRUE(ShaderUsesMultiPass(source)) << path;
    EXPECT_GE(expectedPasses, 2) << path;
  }
}

TEST_F(PresetTransitionMultiPassTest, TransitionShaderManagerReportsMultiPassCounts)
{
  int multiPassCount = 0;
  for (int attempt = 0; attempt < 64; ++attempt)
  {
    const auto shader = m_shaderManager->RandomTransition();
    ASSERT_NE(shader, nullptr);
    if (m_shaderManager->GetPassCount(shader) > 1)
    {
      ++multiPassCount;
    }
  }

  EXPECT_GE(multiPassCount, 1);
}

TEST_F(PresetTransitionMultiPassTest, MultiPassDrawReusesIntermediateFramebuffer)
{
  std::shared_ptr<libprojectM::Renderer::Shader> multiPassShader;
  for (int attempt = 0; attempt < 64; ++attempt)
  {
    const auto shader = m_shaderManager->RandomTransition();
    ASSERT_NE(shader, nullptr);
    if (m_shaderManager->GetPassCount(shader) >= 2)
    {
      multiPassShader = shader;
      break;
    }
  }
  ASSERT_NE(multiPassShader, nullptr) << "No multi-pass transition shader compiled";

  PresetTransition transition(multiPassShader, 3.0, 0.0);
  transition.SetPassCount(m_shaderManager->GetPassCount(multiPassShader));

  const int baselineFbos = Framebuffer::LiveInstanceCount();

  for (int i = 0; i < 100; ++i)
  {
    transition.Draw(*m_oldPreset, *m_newPreset, m_context, m_audioData, static_cast<double>(i) * 0.01);
  }

  EXPECT_EQ(Framebuffer::LiveInstanceCount(), baselineFbos + 1);
}

TEST_F(PresetTransitionMultiPassTest, RapidSinglePassTransitionsDoNotLeakFramebuffers)
{
  const int baselineFbos = Framebuffer::LiveInstanceCount();

  for (int i = 0; i < 100; ++i)
  {
    const auto shader = m_shaderManager->RandomTransition();
    ASSERT_NE(shader, nullptr);

    PresetTransition transition(shader, 0.05, 0.0);
    transition.SetPassCount(m_shaderManager->GetPassCount(shader));
    transition.Draw(*m_oldPreset, *m_newPreset, m_context, m_audioData, 0.01);
  }

  EXPECT_EQ(Framebuffer::LiveInstanceCount(), baselineFbos);
}
