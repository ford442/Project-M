/**
 * @file LiveInputTest.cpp
 * @brief Live textures and host variables (projectM-4/live_input.h, docs/LIVE_INPUT.md).
 *
 * Without a GL context: which names a live texture may take, and which per-frame variables the
 * host may set.
 *
 * On a real GL context (SDL2 + a display, or xvfb-run): a composite shader sampling a live
 * texture shows each uploaded frame without a preset reload, keeps the texture through a resize
 * and new texture paths, and a composite shader showing q1/q2 shows the host's values from the
 * next frame on, through a preset switch, unless the preset's per-frame code assigns them.
 */

#include "HeadlessGlContext.hpp"
#include "TestGl.hpp"

#include <MilkdropPreset/HostVariables.hpp>
#include <Renderer/TextureManager.hpp>

#include <gtest/gtest.h>

#include <projectM-4/live_input.h>
#include <projectM-4/projectM.h>

#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#include <memory>
#include <string>
#include <vector>

using libprojectM::MilkdropPreset::IsHostWritableVariable;
using libprojectM::Renderer::TextureManager;

// ---- Without a GL context --------------------------------------------------------------------

TEST(LiveTextureName, AcceptsSamplerIdentifiers)
{
    EXPECT_TRUE(TextureManager::IsValidLiveTextureName("webcam"));
    EXPECT_TRUE(TextureManager::IsValidLiveTextureName("WebCam_2"));
    EXPECT_TRUE(TextureManager::IsValidLiveTextureName("pm_cam")) << "reachable as sampler_fc_pm_cam";
    EXPECT_TRUE(TextureManager::IsValidLiveTextureName("random_cam")) << "only randNN picks a random file";
    EXPECT_TRUE(TextureManager::IsValidLiveTextureName(std::string(64, 'a')));
}

TEST(LiveTextureName, RefusesNamesAPresetCannotSample)
{
    EXPECT_FALSE(TextureManager::IsValidLiveTextureName(""));
    EXPECT_FALSE(TextureManager::IsValidLiveTextureName(std::string(65, 'a')));
    EXPECT_FALSE(TextureManager::IsValidLiveTextureName("web-cam"));
    EXPECT_FALSE(TextureManager::IsValidLiveTextureName("web cam"));
    EXPECT_FALSE(TextureManager::IsValidLiveTextureName("cam.png"));
    EXPECT_FALSE(TextureManager::IsValidLiveTextureName("main"));
    EXPECT_FALSE(TextureManager::IsValidLiveTextureName("Blur2"));
    EXPECT_FALSE(TextureManager::IsValidLiveTextureName("rand03"));
    EXPECT_FALSE(TextureManager::IsValidLiveTextureName("rand07_smalltiled"));
}

TEST(HostVariables, AcceptsQVariablesAndWritablePerFrameVariables)
{
    for (int q = 1; q <= 32; q++)
    {
        EXPECT_TRUE(IsHostWritableVariable("q" + std::to_string(q))) << q;
    }
    for (const char* name : {"zoom", "zoomexp", "rot", "warp", "cx", "cy", "dx", "dy", "sx", "sy", "decay",
                             "wave_r", "wave_mode", "wave_usedots", "ob_size", "ib_a", "mv_l", "echo_zoom",
                             "echo_orient", "darken_center", "gamma", "wrap", "invert", "brighten", "darken",
                             "solarize", "blur1_min", "blur3_max", "blur1_edge_darken"})
    {
        EXPECT_TRUE(IsHostWritableVariable(name)) << name;
    }
}

TEST(HostVariables, RefusesReadOnlyInputsAndUnknownNames)
{
    for (const char* name : {"time", "fps", "frame", "progress", "bass", "mid", "treb", "bass_att", "treb_att",
                             "meshx", "meshy", "pixelsx", "pixelsy", "aspectx", "aspecty", "pm_beat_phase",
                             "q0", "q33", "q01", "q", "q1x", "reg00", "megabuf", "my_knob", "", "Zoom"})
    {
        EXPECT_FALSE(IsHostWritableVariable(name)) << name << " (the C API lower-cases first)";
    }
}

// ---- On a GL context -------------------------------------------------------------------------

namespace {

constexpr int kWidth = 32;
constexpr int kHeight = 32;

/** @brief A solid-color RGBA8 image. */
auto Solid(int width, int height, uint8_t r, uint8_t g, uint8_t b) -> std::vector<uint8_t>
{
    std::vector<uint8_t> pixels;
    pixels.reserve(static_cast<size_t>(width) * static_cast<size_t>(height) * 4);
    for (int i = 0; i < width * height; i++)
    {
        pixels.insert(pixels.end(), {r, g, b, 255});
    }
    return pixels;
}

/** @brief Writes a solid-color, uncompressed 32-bit TGA. */
void WriteSolidTga(const std::filesystem::path& path, int width, int height, uint8_t r, uint8_t g, uint8_t b)
{
    std::vector<uint8_t> data(18, 0);
    data[2] = 2; // Uncompressed true-color.
    data[12] = static_cast<uint8_t>(width & 0xff);
    data[13] = static_cast<uint8_t>(width >> 8);
    data[14] = static_cast<uint8_t>(height & 0xff);
    data[15] = static_cast<uint8_t>(height >> 8);
    data[16] = 32;
    data[17] = 0x28; // Top-left origin, 8 alpha bits.
    for (int i = 0; i < width * height; i++)
    {
        data.insert(data.end(), {b, g, r, 255});
    }
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
}

/**
 * @brief A preset whose composite shader outputs @a expression, with the warp/feedback path
 *        neutralised (decay 1, no zoom/rot/warp, no waveform) so the output is the expression.
 */
auto CompositePreset(const std::string& declarations, const std::string& expression, const std::string& perFrame = {}) -> std::string
{
    std::string text = "MILKDROP_PRESET_VERSION=201\nPSVERSION=3\nPSVERSION_WARP=3\nPSVERSION_COMP=3\n[preset00]\n";
    text += "fDecay=1\nzoom=1\nrot=0\nwarp=0\nwave_a=0\nnWaveMode=0\n";
    text += perFrame;
    text += "comp_1=`" + declarations + "\n";
    text += "comp_2=`shader_body\n";
    text += "comp_3=`{\n";
    text += "comp_4=`    ret = " + expression + ";\n";
    text += "comp_5=`}\n";
    return text;
}

class TargetFramebuffer
{
public:
    TargetFramebuffer()
    {
        glGenTextures(1, &m_texture);
        glBindTexture(GL_TEXTURE_2D, m_texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kWidth, kHeight, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        glBindTexture(GL_TEXTURE_2D, 0);
        glGenFramebuffers(1, &m_framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_texture, 0);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }

    ~TargetFramebuffer()
    {
        glDeleteFramebuffers(1, &m_framebuffer);
        glDeleteTextures(1, &m_texture);
    }

    TargetFramebuffer(const TargetFramebuffer&) = delete;
    auto operator=(const TargetFramebuffer&) -> TargetFramebuffer& = delete;

    auto Id() const -> GLuint
    {
        return m_framebuffer;
    }

    /** @brief The RGB of the center pixel. */
    auto Center() const -> std::vector<int>
    {
        uint8_t pixel[4]{};
        glBindFramebuffer(GL_READ_FRAMEBUFFER, m_framebuffer);
        glReadBuffer(GL_COLOR_ATTACHMENT0);
        glPixelStorei(GL_PACK_ALIGNMENT, 1);
        glReadPixels(kWidth / 2, kHeight / 2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pixel);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
        return {pixel[0], pixel[1], pixel[2]};
    }

private:
    GLuint m_texture{0};
    GLuint m_framebuffer{0};
};

/** @brief Each channel within 3 of the expected value. */
auto Near(const std::vector<int>& actual, std::vector<int> expected) -> testing::AssertionResult
{
    for (size_t channel = 0; channel < 3; channel++)
    {
        if (std::abs(actual[channel] - expected[channel]) > 3)
        {
            return testing::AssertionFailure() << "got (" << actual[0] << ", " << actual[1] << ", " << actual[2]
                                               << "), expected (" << expected[0] << ", " << expected[1] << ", " << expected[2] << ")";
        }
    }
    return testing::AssertionSuccess();
}

class LiveInputGpuTest : public testing::Test
{
protected:
    // One context for the suite; see PerPixelGpuRenderTest for why.
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
        m_dir = std::filesystem::temp_directory_path() / ("pm-live-input-test-" + std::to_string(::testing::UnitTest::GetInstance()->random_seed()));
        std::filesystem::create_directories(m_dir);

        m_instance = projectm_create();
        if (m_instance == nullptr)
        {
            GTEST_SKIP() << "projectm_create() is unavailable with this context";
        }
        std::string const dir = m_dir.string();
        const char* paths[] = {dir.c_str()};
        projectm_set_texture_search_paths(m_instance, paths, 1);
        projectm_set_window_size(m_instance, kWidth, kHeight);
        projectm_set_preset_duration(m_instance, 3600.0);
        projectm_set_soft_cut_duration(m_instance, 0.0);
        m_target = std::make_unique<TargetFramebuffer>();
    }

    void TearDown() override
    {
        m_target.reset();
        if (m_instance != nullptr)
        {
            projectm_destroy(m_instance);
        }
        std::error_code ignored;
        std::filesystem::remove_all(m_dir, ignored);
    }

    void LoadPreset(const std::string& name, const std::string& text)
    {
        auto const path = (m_dir / name).string();
        {
            std::ofstream preset(path);
            preset << text;
        }
        projectm_load_preset_file(m_instance, path.c_str(), false);
    }

    /** @brief Renders a few frames (a parallel shader compile may take more than one) and reads the center. */
    auto Render() -> std::vector<int>
    {
        for (int i = 0; i < 6; i++, m_frame++)
        {
            projectm_set_frame_time(m_instance, static_cast<double>(m_frame) / 60.0);
            projectm_opengl_render_frame_fbo(m_instance, m_target->Id());
        }
        return m_target->Center();
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
    std::filesystem::path m_dir;
    projectm_handle m_instance{nullptr};
    std::unique_ptr<TargetFramebuffer> m_target;
    int m_frame{0};
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> LiveInputGpuTest::s_context;

auto Upload(projectm_handle instance, const char* name, const std::vector<uint8_t>& pixels) -> bool
{
    return projectm_texture_slot_update(instance, name, pixels.data(), pixels.size());
}

} // namespace

TEST_F(LiveInputGpuTest, EveryUploadedFrameShowsWithoutAPresetReload)
{
    ASSERT_TRUE(projectm_texture_slot_register(m_instance, "webcam", 4, 4));
    LoadPreset("live.milk", CompositePreset("sampler sampler_webcam;", "tex2D(sampler_webcam, uv).xyz + 0.0 * texsize_webcam.x"));
    EXPECT_TRUE(Near(Render(), {0, 0, 0})) << "a new live texture is black";

    ASSERT_TRUE(Upload(m_instance, "webcam", Solid(4, 4, 255, 0, 0)));
    EXPECT_TRUE(Near(Render(), {255, 0, 0}));

    ASSERT_TRUE(Upload(m_instance, "WEBCAM", Solid(4, 4, 0, 0, 255))) << "names are case-insensitive";
    EXPECT_TRUE(Near(Render(), {0, 0, 255}));

    EXPECT_FALSE(Upload(m_instance, "webcam", Solid(2, 2, 0, 255, 0))) << "a frame of another size is refused";
    EXPECT_FALSE(Upload(m_instance, "not_registered", Solid(4, 4, 0, 255, 0)));
    EXPECT_TRUE(Near(Render(), {0, 0, 255})) << "refused frames leave the image alone";

    ASSERT_TRUE(projectm_texture_slot_register(m_instance, "webcam", 4, 4));
    EXPECT_TRUE(Near(Render(), {0, 0, 255})) << "registering again at the same size keeps the frame";

    // A new size: same texture, so the running preset follows it.
    ASSERT_TRUE(projectm_texture_slot_register(m_instance, "webcam", 8, 2));
    EXPECT_TRUE(Near(Render(), {0, 0, 0})) << "a resize clears to black";
    EXPECT_FALSE(Upload(m_instance, "webcam", Solid(3, 3, 0, 255, 0))) << "only the byte count is checked: 4x4 would pass";
    ASSERT_TRUE(Upload(m_instance, "webcam", Solid(8, 2, 0, 255, 0)));
    EXPECT_TRUE(Near(Render(), {0, 255, 0}));

    EXPECT_TRUE(projectm_texture_slot_unregister(m_instance, "webcam"));
    EXPECT_FALSE(projectm_texture_slot_unregister(m_instance, "webcam"));
    EXPECT_TRUE(Near(Render(), {0, 255, 0})) << "a running preset keeps the last frame";
}

TEST_F(LiveInputGpuTest, LiveTextureWinsOverAFileAndSurvivesNewTexturePaths)
{
    WriteSolidTga(m_dir / "webcam.tga", 4, 4, 255, 0, 0);
    ASSERT_TRUE(projectm_texture_slot_register(m_instance, "webcam", 2, 2));
    ASSERT_TRUE(Upload(m_instance, "webcam", Solid(2, 2, 0, 255, 0)));
    // Spelled with another case and a filter/wrap prefix, as stock presets do.
    LoadPreset("live.milk", CompositePreset("sampler sampler_fc_WebCam;", "tex2D(sampler_fc_WebCam, uv).xyz"));
    EXPECT_TRUE(Near(Render(), {0, 255, 0})) << "the live texture, not webcam.tga";

    std::string const dir = m_dir.string();
    const char* paths[] = {dir.c_str()};
    projectm_set_texture_search_paths(m_instance, paths, 1);
    LoadPreset("live2.milk", CompositePreset("sampler sampler_webcam;", "tex2D(sampler_webcam, uv).xyz"));
    EXPECT_TRUE(Near(Render(), {0, 255, 0})) << "new texture paths keep live textures";
    ASSERT_TRUE(Upload(m_instance, "webcam", Solid(2, 2, 0, 0, 255)));
    EXPECT_TRUE(Near(Render(), {0, 0, 255}));

    ASSERT_TRUE(projectm_texture_slot_unregister(m_instance, "webcam"));
    LoadPreset("live3.milk", CompositePreset("sampler sampler_webcam;", "tex2D(sampler_webcam, uv).xyz"));
    EXPECT_TRUE(Near(Render(), {255, 0, 0})) << "once unregistered, the file is found again";
}

TEST_F(LiveInputGpuTest, RegistrationRefusesBadNamesAndSizes)
{
    EXPECT_FALSE(projectm_texture_slot_register(m_instance, "noise_lq", 4, 4)) << "a built-in texture";
    EXPECT_FALSE(projectm_texture_slot_register(m_instance, "main", 4, 4));
    EXPECT_FALSE(projectm_texture_slot_register(m_instance, "rand00", 4, 4));
    EXPECT_FALSE(projectm_texture_slot_register(m_instance, "web-cam", 4, 4));
    EXPECT_FALSE(projectm_texture_slot_register(m_instance, "webcam", 0, 4));
    EXPECT_FALSE(projectm_texture_slot_register(m_instance, "webcam", 4, -1));
    EXPECT_FALSE(projectm_texture_slot_register(m_instance, "webcam", PROJECTM_LIVE_TEXTURE_MAX_SIZE + 1, 4));
    EXPECT_FALSE(projectm_texture_slot_update(m_instance, "webcam", Solid(1, 1, 0, 0, 0).data(), 4)) << "never registered";
}

TEST_F(LiveInputGpuTest, HostVariablesReachTheShaderFromTheNextFrame)
{
    LoadPreset("q.milk", CompositePreset("", "float3(q1, q2, 0)"));
    EXPECT_TRUE(Near(Render(), {0, 0, 0}));

    ASSERT_TRUE(projectm_eval_set(m_instance, "q1", 1.0));
    EXPECT_TRUE(Near(Render(), {255, 0, 0}));
    ASSERT_TRUE(projectm_eval_set(m_instance, "Q2", 1.0)) << "names are case-insensitive";
    EXPECT_TRUE(Near(Render(), {255, 255, 0}));

    // Survives a preset switch, including one whose per-frame code reads it.
    LoadPreset("half.milk", CompositePreset("", "float3(q1, q2, 0)", "per_frame_1=q1 = q1 * 0.5;\n"));
    EXPECT_TRUE(Near(Render(), {128, 255, 0})) << "per-frame code reads the host's value";

    // A preset that assigns the variable itself wins.
    LoadPreset("own.milk", CompositePreset("", "float3(q1, q2, 0)", "per_frame_1=q1 = 0;\n"));
    EXPECT_TRUE(Near(Render(), {0, 255, 0}));

    LoadPreset("q2.milk", CompositePreset("", "float3(q1, q2, 0)"));
    EXPECT_TRUE(projectm_eval_clear(m_instance, "q2"));
    EXPECT_FALSE(projectm_eval_clear(m_instance, "q2"));
    EXPECT_TRUE(Near(Render(), {255, 0, 0}));
    EXPECT_FALSE(projectm_eval_clear(m_instance, "")) << "an empty name is not \"all\"";
    EXPECT_TRUE(projectm_eval_clear(m_instance, nullptr));
    EXPECT_TRUE(Near(Render(), {0, 0, 0})) << "cleared: back to the preset's own value";
}

TEST_F(LiveInputGpuTest, HostVariablesRefuseReadOnlyNamesAndNonFiniteValues)
{
    EXPECT_FALSE(projectm_eval_set(m_instance, "time", 1.0));
    EXPECT_FALSE(projectm_eval_set(m_instance, "bass", 1.0));
    EXPECT_FALSE(projectm_eval_set(m_instance, "q33", 1.0));
    EXPECT_FALSE(projectm_eval_set(m_instance, "my_knob", 1.0));
    EXPECT_FALSE(projectm_eval_set(m_instance, "q1", std::numeric_limits<double>::quiet_NaN()));
    EXPECT_FALSE(projectm_eval_set(m_instance, "q1", std::numeric_limits<double>::infinity()));
    EXPECT_TRUE(projectm_eval_set(m_instance, "Zoom", 1.0));
    EXPECT_TRUE(projectm_eval_set(m_instance, "decay", 0.98));
}

TEST_F(LiveInputGpuTest, TheDemoPresetShowsTheCameraAndTakesQ1FromTheHost)
{
    // presets/experimental/live_texture_webcam.milk: stock syntax, no experimental header.
    std::string const path = std::string(PROJECTM_SOURCE_DIR) + "/presets/experimental/live_texture_webcam.milk";
    ASSERT_TRUE(projectm_texture_slot_register(m_instance, "webcam", 4, 4));
    ASSERT_TRUE(Upload(m_instance, "webcam", Solid(4, 4, 200, 40, 40)));
    projectm_load_preset_file(m_instance, path.c_str(), false);

    // q1 = 0 is the plain camera: the composite is the live texture itself.
    ASSERT_TRUE(projectm_eval_set(m_instance, "q1", 0.0));
    EXPECT_TRUE(Near(Render(), {200, 40, 40}));

    ASSERT_TRUE(Upload(m_instance, "webcam", Solid(4, 4, 40, 40, 200)));
    EXPECT_TRUE(Near(Render(), {40, 40, 200})) << "the next frame shows the new camera image";

    // The preset's own default (per_frame_init q1=0.6) mixes in the trails.
    ASSERT_TRUE(projectm_eval_clear(m_instance, "q1"));
    EXPECT_FALSE(Near(Render(), {40, 40, 200}));
}
