/**
 * @file TransitionLooksTest.cpp
 * @brief The Phase B5 transition looks drawn for real (#229 Track A).
 *
 * PresetTransition::Draw() blends two stand-in presets whose output is a solid colour
 * (old = red, new = green) into an RGBA8 target that is read back:
 *
 *  - Shatter and StarWipe start exactly on the old preset and end exactly on the new one,
 *    in every blend mode, and show both mid-transition. The only allowed difference is
 *    the main shader's +-1 LSB output dither.
 *  - The Masked blend mode samples the host's pm_wipe_mask texture when there is one:
 *    with a mask that is black on top and white below, the top half has turned new and the
 *    bottom half is still old half-way through, i.e. the mask is upright on screen.
 *
 * With PROJECTM_TRANSITION_STILLS_DIR set, DumpStills also writes frames of both looks over
 * two patterned stand-in presets as PPM files there (scripts/capture_transition_stills.sh
 * turns them into the GIFs in docs/images/transitions/).
 *
 * Needs a GL context (SDL2 + a display, or xvfb-run); skips without one.
 */

#include "HeadlessGlContext.hpp"

#include <Renderer/PresetTransition.hpp>
#include <Renderer/TextureManager.hpp>
#include <Renderer/TransitionShaderManager.hpp>

#include <Preset.hpp>

#include "TestGl.hpp"

#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

namespace {

using libprojectM::Renderer::EasingType;
using libprojectM::Renderer::PresetTransition;
using libprojectM::Renderer::RenderContext;
using libprojectM::Renderer::Texture;
using libprojectM::Renderer::TextureManager;
using libprojectM::Renderer::TransitionBlendMode;
using libprojectM::Renderer::TransitionShaderManager;
using libprojectM::Test::HeadlessGlContext;

constexpr int kWidth = 96;
constexpr int kHeight = 64;

auto SolidTexture(uint8_t red, uint8_t green, uint8_t blue) -> std::shared_ptr<Texture>
{
    std::vector<uint8_t> pixels(static_cast<size_t>(kWidth) * kHeight * 4);
    for (size_t i = 0; i < pixels.size(); i += 4)
    {
        pixels[i] = red;
        pixels[i + 1] = green;
        pixels[i + 2] = blue;
        pixels[i + 3] = 255;
    }
    return std::make_shared<Texture>("solid", pixels.data(), libprojectM::Renderer::Device::TextureTarget::Texture2D,
                                     kWidth, kHeight, 0, libprojectM::Renderer::Device::TextureFormat::RGBA, false);
}

/**
 * @brief A @p width x @p height stand-in for a preset frame: warm diagonal bands (old) or
 *        cool concentric rings (new), so stills show which preset is where.
 */
auto PatternTexture(int width, int height, bool rings) -> std::shared_ptr<Texture>
{
    std::vector<uint8_t> pixels(static_cast<size_t>(width) * height * 4);
    for (int y = 0; y < height; y++)
    {
        for (int x = 0; x < width; x++)
        {
            const float u = static_cast<float>(x) / static_cast<float>(width);
            const float v = static_cast<float>(y) / static_cast<float>(height);
            float red;
            float green;
            float blue;
            if (rings)
            {
                const float du = (u - 0.5f) * static_cast<float>(width) / static_cast<float>(height);
                const float r = std::sqrt(du * du + (v - 0.5f) * (v - 0.5f));
                const float wave = 0.5f + 0.5f * std::cos(r * 40.0f);
                red = 0.05f + 0.15f * wave;
                green = 0.35f + 0.45f * wave;
                blue = 0.55f + 0.45f * (1.0f - r);
            }
            else
            {
                const float wave = 0.5f + 0.5f * std::sin((u + v) * 25.0f);
                red = 0.75f + 0.25f * wave;
                green = 0.25f + 0.45f * wave * (1.0f - v);
                blue = 0.1f + 0.2f * u;
            }
            uint8_t* pixel = &pixels[(static_cast<size_t>(y) * width + x) * 4];
            pixel[0] = static_cast<uint8_t>(std::fmin(red, 1.0f) * 255.0f);
            pixel[1] = static_cast<uint8_t>(std::fmin(green, 1.0f) * 255.0f);
            pixel[2] = static_cast<uint8_t>(std::fmin(blue, 1.0f) * 255.0f);
            pixel[3] = 255;
        }
    }
    return std::make_shared<Texture>("pattern", pixels.data(), libprojectM::Renderer::Device::TextureTarget::Texture2D,
                                     width, height, 0, libprojectM::Renderer::Device::TextureFormat::RGBA, false);
}

/** @brief A preset whose output is a fixed texture. */
class SolidPreset : public libprojectM::Preset
{
public:
    explicit SolidPreset(std::shared_ptr<Texture> texture)
        : m_texture(std::move(texture))
    {
    }

    void Initialize(const RenderContext&) override
    {
    }
    void RenderFrame(const libprojectM::Audio::FrameAudioData&, const RenderContext&) override
    {
    }
    auto OutputTexture() const -> std::shared_ptr<Texture> override
    {
        return m_texture;
    }
    void DrawInitialImage(const std::shared_ptr<Texture>&, const RenderContext&) override
    {
    }
    auto FramebufferPass() const -> std::optional<libprojectM::Renderer::Device::RenderPassDesc> override
    {
        return std::nullopt;
    }

private:
    std::shared_ptr<Texture> m_texture;
};

/** @brief An RGBA8 framebuffer the transition draws into. */
class Target
{
public:
    explicit Target(int width = kWidth, int height = kHeight)
        : m_width(width)
        , m_height(height)
    {
        glGenTextures(1, &m_texture);
        glBindTexture(GL_TEXTURE_2D, m_texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        glBindTexture(GL_TEXTURE_2D, 0);
        glGenFramebuffers(1, &m_framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_texture, 0);
    }

    ~Target()
    {
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glDeleteFramebuffers(1, &m_framebuffer);
        glDeleteTextures(1, &m_texture);
    }

    Target(const Target&) = delete;
    auto operator=(const Target&) -> Target& = delete;

    void Bind() const
    {
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
    }

    /** @return RGBA rows, bottom row first (glReadPixels order). */
    auto Read() const -> std::vector<uint8_t>
    {
        std::vector<uint8_t> pixels(static_cast<size_t>(m_width) * m_height * 4);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glPixelStorei(GL_PACK_ALIGNMENT, 1);
        glReadPixels(0, 0, m_width, m_height, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
        return pixels;
    }

private:
    int m_width;
    int m_height;
    GLuint m_texture{};
    GLuint m_framebuffer{};
};

auto IsColor(const uint8_t* pixel, int red, int green, int blue) -> bool
{
    // The transition output carries a +-1 LSB triangular dither.
    return std::abs(pixel[0] - red) <= 1 && std::abs(pixel[1] - green) <= 1 && std::abs(pixel[2] - blue) <= 1;
}

struct Census {
    int oldPixels{};
    int newPixels{};
    int total{};
};

/** @brief Counts old (red) and new (green) pixels in rows [firstRow, lastRow) (bottom row = 0). */
auto Count(const std::vector<uint8_t>& pixels, int firstRow, int lastRow) -> Census
{
    Census census;
    for (int row = firstRow; row < lastRow; row++)
    {
        for (int column = 0; column < kWidth; column++)
        {
            const uint8_t* pixel = &pixels[(static_cast<size_t>(row) * kWidth + column) * 4];
            census.total++;
            if (IsColor(pixel, 255, 0, 0))
            {
                census.oldPixels++;
            }
            else if (IsColor(pixel, 0, 255, 0))
            {
                census.newPixels++;
            }
        }
    }
    return census;
}

} // namespace

class TransitionLooksTest : public ::testing::Test
{
protected:
    void SetUp() override
    {
        if (!HeadlessGlContext::IsAvailable())
        {
            GTEST_SKIP() << "No OpenGL context on this platform.";
        }
        m_glContext = std::make_unique<HeadlessGlContext>();
        if (!m_glContext->Valid() || !m_glContext->InitializeGlad())
        {
            GTEST_SKIP() << "Failed to create a headless OpenGL context.";
        }

        m_shaders = std::make_unique<TransitionShaderManager>();
        m_textures = std::make_unique<TextureManager>(std::vector<std::string>{});
        m_oldPreset = std::make_unique<SolidPreset>(SolidTexture(255, 0, 0));
        m_newPreset = std::make_unique<SolidPreset>(SolidTexture(0, 255, 0));
        m_target = std::make_unique<Target>();

        m_context.viewportSizeX = kWidth;
        m_context.viewportSizeY = kHeight;
        m_context.aspectX = 1.0f;
        m_context.aspectY = static_cast<float>(kHeight) / static_cast<float>(kWidth);
        m_context.invAspectX = 1.0f / m_context.aspectX;
        m_context.invAspectY = 1.0f / m_context.aspectY;
        m_context.textureManager = m_textures.get();

        while (glGetError() != GL_NO_ERROR)
        {
        }
    }

    void TearDown() override
    {
        // GL objects go before the context.
        m_target.reset();
        m_oldPreset.reset();
        m_newPreset.reset();
        m_textures.reset();
        m_shaders.reset();
    }

    /**
     * @brief Draws one frame of a named transition at linear progress @p progress.
     */
    auto Render(const std::string& name, TransitionBlendMode mode, double progress,
                const libprojectM::Audio::FrameAudioData& audio = {}) -> std::vector<uint8_t>
    {
        const auto index = m_shaders->IndexOf(name);
        EXPECT_TRUE(index.has_value()) << name << " is not in the compiled transition pool.";
        if (!index)
        {
            return {};
        }

        constexpr double duration = 2.0;
        PresetTransition transition(m_shaders->CompiledShaderAt(*index), duration, 0.0);
        transition.SetPassCount(m_shaders->PassCountAt(*index));
        transition.SetBlendMode(mode);
        transition.SetEasingType(EasingType::Linear);

        m_target->Bind();
        transition.Draw(*m_oldPreset, *m_newPreset, m_context, audio, progress * duration);
        EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
        return m_target->Read();
    }

    std::unique_ptr<HeadlessGlContext> m_glContext;
    std::unique_ptr<TransitionShaderManager> m_shaders;
    std::unique_ptr<TextureManager> m_textures;
    std::unique_ptr<SolidPreset> m_oldPreset;
    std::unique_ptr<SolidPreset> m_newPreset;
    std::unique_ptr<Target> m_target;
    RenderContext m_context;
};

TEST_F(TransitionLooksTest, NewLooksAreInThePool)
{
    EXPECT_TRUE(m_shaders->IndexOf("Shatter").has_value());
    EXPECT_TRUE(m_shaders->IndexOf("StarWipe").has_value());
    EXPECT_FALSE(m_shaders->IndexOf("NoSuchTransition").has_value());
    ASSERT_GT(m_shaders->CompiledShaderCount(), 0u);
    EXPECT_EQ(m_shaders->NameAt(m_shaders->CompiledShaderCount()), "");
}

TEST_F(TransitionLooksTest, ShatterAndStarWipeEndpointsAreExact)
{
    for (const char* name : {"Shatter", "StarWipe"})
    {
        for (int mode = 0; mode < static_cast<int>(TransitionBlendMode::Count); mode++)
        {
            SCOPED_TRACE(std::string(name) + ", blend mode " + std::to_string(mode));
            const auto blendMode = static_cast<TransitionBlendMode>(mode);

            const auto start = Render(name, blendMode, 0.0);
            ASSERT_FALSE(start.empty());
            const auto startCount = Count(start, 0, kHeight);
            EXPECT_EQ(startCount.oldPixels, startCount.total) << "t == 0 must be exactly the old preset.";

            const auto end = Render(name, blendMode, 1.0);
            const auto endCount = Count(end, 0, kHeight);
            EXPECT_EQ(endCount.newPixels, endCount.total) << "t == 1 must be exactly the new preset.";

            const auto middle = Render(name, blendMode, 0.5);
            const auto middleCount = Count(middle, 0, kHeight);
            EXPECT_LT(middleCount.oldPixels, middleCount.total) << "Nothing has changed half-way through.";
            EXPECT_LT(middleCount.newPixels, middleCount.total) << "Everything has changed half-way through.";
        }
    }
}

TEST_F(TransitionLooksTest, MaskedModeSamplesTheHostMaskUpright)
{
    // Top half black (revealed first), bottom half white (revealed last). Rows run
    // top to bottom, as in an image file.
    const std::string maskName = PresetTransition::MaskTextureName;
    ASSERT_TRUE(m_textures->RegisterLiveTexture(maskName, kWidth, kHeight));
    std::vector<uint8_t> mask(static_cast<size_t>(kWidth) * kHeight * 4, 255);
    for (int row = 0; row < kHeight / 2; row++)
    {
        for (int column = 0; column < kWidth; column++)
        {
            uint8_t* pixel = &mask[(static_cast<size_t>(row) * kWidth + column) * 4];
            pixel[0] = 0;
            pixel[1] = 0;
            pixel[2] = 0;
        }
    }
    ASSERT_TRUE(m_textures->UpdateLiveTexture(maskName, mask.data(), mask.size()));

    // Pixelate blends a solid old frame and a solid new one with prjmBlendPresets() at
    // the transition progress, so with solid inputs the mask is all that varies.
    const auto middle = Render("Pixelate", TransitionBlendMode::Masked, 0.5);
    ASSERT_FALSE(middle.empty());

    // A margin of a few rows around the seam, where the mask texture is filtered.
    const auto bottom = Count(middle, 0, kHeight / 2 - 4);
    const auto top = Count(middle, kHeight / 2 + 4, kHeight);
    EXPECT_EQ(top.newPixels, top.total) << "The black (top) part of the mask is not revealed half-way through.";
    EXPECT_EQ(bottom.oldPixels, bottom.total) << "The white (bottom) part of the mask is revealed half-way through.";

    // The endpoints stay exact with a host mask too.
    const auto start = Render("Pixelate", TransitionBlendMode::Masked, 0.0);
    EXPECT_EQ(Count(start, 0, kHeight).oldPixels, kWidth * kHeight);
    const auto end = Render("Pixelate", TransitionBlendMode::Masked, 1.0);
    EXPECT_EQ(Count(end, 0, kHeight).newPixels, kWidth * kHeight);
}

TEST_F(TransitionLooksTest, FindTextureIsQuietAboutMissingTextures)
{
    EXPECT_FALSE(m_textures->FindTexture("fc_pm_wipe_mask").has_value());
    // Generated textures are always there.
    EXPECT_TRUE(m_textures->FindTexture("noise_lq").has_value());
}

/**
 * @brief Writes frames of Shatter and StarWipe to $PROJECTM_TRANSITION_STILLS_DIR as PPM.
 *
 * Not a check: skipped unless the variable is set. scripts/capture_transition_stills.sh runs it.
 */
TEST_F(TransitionLooksTest, DumpStills)
{
    const char* directory = std::getenv("PROJECTM_TRANSITION_STILLS_DIR");
    if (directory == nullptr || *directory == '\0')
    {
        GTEST_SKIP() << "PROJECTM_TRANSITION_STILLS_DIR is not set.";
    }

    constexpr int width = 480;
    constexpr int height = 270;
    constexpr int frames = 36;
    m_target = std::make_unique<Target>(width, height);
    m_oldPreset = std::make_unique<SolidPreset>(PatternTexture(width, height, false));
    m_newPreset = std::make_unique<SolidPreset>(PatternTexture(width, height, true));
    m_context.viewportSizeX = width;
    m_context.viewportSizeY = height;
    m_context.aspectY = static_cast<float>(height) / static_cast<float>(width);
    m_context.invAspectY = 1.0f / m_context.aspectY;

    for (const char* name : {"Shatter", "StarWipe"})
    {
        for (int frame = 0; frame <= frames; frame++)
        {
            // A steady beat so the audio-driven parts (StarWipe's points, sparkle) show.
            libprojectM::Audio::FrameAudioData audio{};
            audio.bass = audio.bassAtt = 1.0f + 0.6f * static_cast<float>(frame % 6 == 0);
            audio.mid = audio.midAtt = 1.0f;
            audio.treb = audio.trebAtt = 1.2f;
            const auto pixels = Render(name, TransitionBlendMode::Alpha, static_cast<double>(frame) / frames, audio);
            ASSERT_FALSE(pixels.empty());

            char file[64];
            std::snprintf(file, sizeof(file), "/%s_%03d.ppm", name, frame);
            std::ofstream out(std::string(directory) + file, std::ios::binary);
            out << "P6\n"
                << width << " " << height << "\n255\n";
            for (int row = height - 1; row >= 0; row--)
            {
                for (int column = 0; column < width; column++)
                {
                    out.write(reinterpret_cast<const char*>(&pixels[(static_cast<size_t>(row) * width + column) * 4]), 3);
                }
            }
            ASSERT_TRUE(out.good()) << directory << file;
        }
    }
}
