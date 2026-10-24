/**
 * @file ExperimentalDepthSamplerTest.cpp
 * @brief The experimental pm_depth shader sampler and in-place texture reloads
 *        (docs/EXPERIMENTAL_PRESET_HOOKS.md).
 *
 * Without a GL context: the "// pm:experimental" header is read by the preset parser, a
 * preset that asks for a depth texture gets pm_depth rewritten to sampler_fc_pm_depth_map, and
 * the same shader without the header is left alone (and does not transpile, because nothing
 * declares pm_depth).
 *
 * On a real GL context (SDL2 + a display, or xvfb-run): a composite shader that outputs
 * tex2D(pm_depth, uv) shows the texture file, keeps showing it after the file is rewritten,
 * and shows the new file after projectm_reload_texture(), with no preset reload.
 */

#include "HeadlessGlContext.hpp"
#include "TestGl.hpp"

#include <MilkdropPreset/ExperimentalDepthSampler.hpp>
#include <MilkdropPreset/MilkdropShader.hpp>
#include <MilkdropPreset/PresetFileParser.hpp>
#include <MilkdropPreset/ShaderTranspiler.hpp>
#include <MilkdropStaticShaders.hpp>

#include <gtest/gtest.h>

#include <projectM-4/projectM.h>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using libprojectM::MilkdropPreset::ExperimentalDepthSampler;
using libprojectM::MilkdropPreset::MilkdropShader;
using libprojectM::MilkdropPreset::MilkdropStaticShaders;
using libprojectM::MilkdropPreset::PresetFileParser;
namespace ShaderTranspiler = libprojectM::MilkdropPreset::ShaderTranspiler;

namespace {

auto ParsePreset(const std::string& text) -> PresetFileParser
{
    PresetFileParser parser;
    std::istringstream stream(text);
    EXPECT_TRUE(parser.Read(stream));
    return parser;
}

/** @brief Transpiles a composite shader the way PresetCompat does: one sampler2D per referenced name. */
auto TranspileComposite(std::string code, std::string& glsl) -> bool
{
    auto const samplerNames = ShaderTranspiler::GetReferencedSamplers(code);
    ShaderTranspiler::PreprocessPresetShader(ShaderTranspiler::ShaderType::CompositeShader, code);
    std::set<std::string> samplerDeclarations;
    std::set<std::string> texSizeDeclarations;
    for (const auto& name : samplerNames)
    {
        samplerDeclarations.insert("uniform sampler2D sampler_" + name + ";\n");
        texSizeDeclarations.insert("uniform float4 texsize_" + name + ";\n");
    }
    std::string error;
    return ShaderTranspiler::TranspileToGlsl(code, samplerDeclarations, texSizeDeclarations,
                                             MilkdropStaticShaders::Get()->GetGlslGeneratorVersion(), glsl, error);
}

constexpr const char* kCompositeBody = "comp_1=`shader_body\n"
                                       "comp_2=`{\n"
                                       "comp_3=`    ret = tex2D(pm_depth, uv).xyz + 0.0 * texsize_pm_depth.x;\n"
                                       "comp_4=`}\n";

auto PresetText(const std::string& header) -> std::string
{
    return header + "MILKDROP_PRESET_VERSION=201\nPSVERSION=3\nPSVERSION_WARP=3\nPSVERSION_COMP=3\n[preset00]\n"
                    "fDecay=1\nzoom=1\nrot=0\nwarp=0\nwave_a=0\n" +
           kCompositeBody;
}

} // namespace

TEST(ExperimentalDepthSampler, ParserRecordsTheFirstExperimentalHeader)
{
    auto parser = ParsePreset("// Signature Series demo\n"
                              "// pm:experimental depth=auto depth-texture=pm_depth_map\n"
                              "// pm:experimental depth-texture=other\n"
                              "MILKDROP_PRESET_VERSION=201\n[preset00]\nfDecay=1\n");
    EXPECT_EQ(parser.ExperimentalDirectives(), "depth=auto depth-texture=pm_depth_map");
    EXPECT_EQ(parser.GetInt("MILKDROP_PRESET_VERSION", 0), 201) << "the header changes nothing else";

    EXPECT_EQ(ParsePreset("//pm:experimental depth=true\nfDecay=1\n").ExperimentalDirectives(), "depth=true");
    EXPECT_EQ(ParsePreset("// pm:experimentally depth=true\nfDecay=1\n").ExperimentalDirectives(), "");
    EXPECT_EQ(ParsePreset("fDecay=1 // pm:experimental depth=true\n").ExperimentalDirectives(), "");
    EXPECT_EQ(ParsePreset("fDecay=1\n").ExperimentalDirectives(), "");
}

TEST(ExperimentalDepthSampler, TextureComesFromTheDepthDirectives)
{
    EXPECT_EQ(ExperimentalDepthSampler::TextureFor(""), "");
    EXPECT_EQ(ExperimentalDepthSampler::TextureFor("gltf-export=true"), "");
    EXPECT_EQ(ExperimentalDepthSampler::TextureFor("depth=auto"), "pm_depth_map");
    EXPECT_EQ(ExperimentalDepthSampler::TextureFor("depth=true shapecode=0"), "pm_depth_map");
    EXPECT_EQ(ExperimentalDepthSampler::TextureFor("depth=off"), "");
    EXPECT_EQ(ExperimentalDepthSampler::TextureFor("depth-texture=pm_depth_map"), "pm_depth_map");
    EXPECT_EQ(ExperimentalDepthSampler::TextureFor("depth-texture=pm_depth_map.png"), "pm_depth_map");
    EXPECT_EQ(ExperimentalDepthSampler::TextureFor("depth=auto depth-texture=my_depth"), "my_depth");
    // A name that is not a plain identifier cannot become a sampler name; fall back to the default.
    EXPECT_EQ(ExperimentalDepthSampler::TextureFor("depth=auto depth-texture=../x"), "pm_depth_map");
    EXPECT_EQ(ExperimentalDepthSampler::TextureFor("depth-texture=a;b"), "");
}

TEST(ExperimentalDepthSampler, RewritesWholeIdentifiersOnly)
{
    EXPECT_EQ(ExperimentalDepthSampler::Apply("ret = tex2D(pm_depth, uv).xyz;", "pm_depth_map"),
              "ret = tex2D(sampler_fc_pm_depth_map, uv).xyz;");
    EXPECT_EQ(ExperimentalDepthSampler::Apply("float2 s = texsize_pm_depth.zw;", "pm_depth_map"),
              "float2 s = texsize_pm_depth_map.zw;");
    EXPECT_EQ(ExperimentalDepthSampler::Apply("sampler pm_depth;", "d"), "sampler sampler_fc_d;");

    std::string const untouched = "tex2D(sampler_pm_depth_map, uv) + pm_depth2 + my_pm_depth + pm_depthx";
    EXPECT_EQ(ExperimentalDepthSampler::Apply(untouched, "pm_depth_map"), untouched);
    EXPECT_EQ(ExperimentalDepthSampler::Apply("tex2D(pm_depth, uv)", ""), "tex2D(pm_depth, uv)");
}

TEST(ExperimentalDepthSampler, MarkedPresetDeclaresTheDepthSampler)
{
    auto parser = ParsePreset(PresetText("// pm:experimental depth-texture=pm_depth_map\n"));
    auto const code = ExperimentalDepthSampler::ShaderCode(parser, "comp_");

    EXPECT_EQ(code.find("pm_depth,"), std::string::npos);
    auto const samplers = ShaderTranspiler::GetReferencedSamplers(code);
    EXPECT_EQ(samplers.count("fc_pm_depth_map"), 1u) << "loaded and bound like any user texture";
    EXPECT_EQ(samplers.count("pm_depth_map"), 1u) << "from texsize_pm_depth";

    std::string glsl;
    ASSERT_TRUE(TranspileComposite(code, glsl));
    EXPECT_NE(glsl.find("sampler_fc_pm_depth_map"), std::string::npos);
}

TEST(ExperimentalDepthSampler, EngineLoadsOnlyThePrefixedTexture)
{
    // What MilkdropShader asks the TextureManager for. "pm_depth_map" on its own would lose
    // "pm_" as a filter prefix and bind a missing "depth_map", so texsize_pm_depth_map, which
    // the fc_ sampler already provides, must not add it.
    auto parser = ParsePreset(PresetText("// pm:experimental depth-texture=pm_depth_map\n"));
    auto const source = MilkdropShader::AnalyzeCode(MilkdropShader::ShaderType::CompositeShader,
                                                    ExperimentalDepthSampler::ShaderCode(parser, "comp_"));
    EXPECT_EQ(source.samplerNames, (std::set<std::string>{"main", "fc_pm_depth_map"}));

    // Unchanged for names a prefix strip does not alter.
    auto const plain = MilkdropShader::AnalyzeCode(MilkdropShader::ShaderType::CompositeShader,
                                                   "shader_body { ret = tex2D(sampler_fc_clouds, uv).xyz * texsize_clouds.x; }");
    EXPECT_EQ(plain.samplerNames, (std::set<std::string>{"main", "fc_clouds", "clouds"}));
    auto const unpaired = MilkdropShader::AnalyzeCode(MilkdropShader::ShaderType::CompositeShader,
                                                      "shader_body { ret = texsize_ab_cd.xyz; }");
    EXPECT_EQ(unpaired.samplerNames.count("ab_cd"), 1u) << "only skipped when a prefixed sampler sizes it";
}

TEST(ExperimentalDepthSampler, UnmarkedPresetDoesNotDeclareIt)
{
    auto parser = ParsePreset(PresetText("// tags: experimental\n"));
    auto const code = ExperimentalDepthSampler::ShaderCode(parser, "comp_");

    EXPECT_EQ(code, parser.GetCode("comp_")) << "a stock preset's shader is not touched";
    auto const samplers = ShaderTranspiler::GetReferencedSamplers(code);
    EXPECT_EQ(samplers.count("fc_pm_depth_map"), 0u);

    std::string glsl;
    EXPECT_FALSE(TranspileComposite(code, glsl)) << "pm_depth is an undeclared identifier without the header";
}

TEST(ExperimentalDepthSampler, DemoPresetTranspiles)
{
    std::string const path = std::string(PROJECTM_SOURCE_DIR) + "/presets/experimental/depth_sampler_demo.milk";
    PresetFileParser parser;
    ASSERT_TRUE(parser.Read(path)) << path;
    EXPECT_EQ(ExperimentalDepthSampler::TextureFor(parser.ExperimentalDirectives()), "pm_depth_map");

    std::string glsl;
    EXPECT_TRUE(TranspileComposite(ExperimentalDepthSampler::ShaderCode(parser, "comp_"), glsl));
    EXPECT_NE(glsl.find("sampler_fc_pm_depth_map"), std::string::npos);
    EXPECT_NE(glsl.find("texsize_pm_depth_map"), std::string::npos);

    std::string warp = ExperimentalDepthSampler::ShaderCode(parser, "warp_");
    EXPECT_NE(warp.find("tex2D(sampler_fc_pm_depth_map, uv)"), std::string::npos);
}

// ---- On a GL context -------------------------------------------------------------------------

namespace {

constexpr int kWidth = 32;
constexpr int kHeight = 32;

/** @brief Writes a solid-color, uncompressed 32-bit TGA (one of the texture formats projectM scans for). */
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

class ExperimentalDepthTextureGpuTest : public testing::Test
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
        m_dir = std::filesystem::temp_directory_path() / ("pm-depth-test-" + std::to_string(::testing::UnitTest::GetInstance()->random_seed()));
        std::filesystem::create_directories(m_dir);
    }

    void TearDown() override
    {
        std::error_code ignored;
        std::filesystem::remove_all(m_dir, ignored);
    }

    /** @brief Renders a few frames (a parallel shader compile may take more than one). */
    static void Render(projectm_handle instance, const TargetFramebuffer& target, int& frame)
    {
        for (int i = 0; i < 6; i++, frame++)
        {
            projectm_set_frame_time(instance, static_cast<double>(frame) / 60.0);
            projectm_opengl_render_frame_fbo(instance, target.Id());
        }
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
    std::filesystem::path m_dir;
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> ExperimentalDepthTextureGpuTest::s_context;

} // namespace

TEST_F(ExperimentalDepthTextureGpuTest, ReloadShowsTheRewrittenFileWithoutAPresetReload)
{
    auto const texture = m_dir / "pm_depth_map.tga";
    WriteSolidTga(texture, 4, 4, 255, 0, 0);
    auto const presetPath = (m_dir / "depth.milk").string();
    {
        std::ofstream preset(presetPath);
        preset << PresetText("// pm:experimental depth-texture=pm_depth_map\n");
    }

    TargetFramebuffer target;
    auto* instance = projectm_create();
    if (instance == nullptr)
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    std::string const dir = m_dir.string();
    const char* paths[] = {dir.c_str()};
    projectm_set_texture_search_paths(instance, paths, 1);
    projectm_set_window_size(instance, kWidth, kHeight);
    projectm_set_preset_duration(instance, 3600.0);
    projectm_set_soft_cut_duration(instance, 0.0);
    projectm_load_preset_file(instance, presetPath.c_str(), false);

    int frame = 0;
    Render(instance, target, frame);
    auto red = target.Center();
    EXPECT_GE(red[0], 250);
    EXPECT_LE(red[1], 5);
    EXPECT_LE(red[2], 5);

    // Rewritten, at a different size: the loaded texture is cached, so nothing changes yet.
    WriteSolidTga(texture, 8, 2, 0, 255, 0);
    Render(instance, target, frame);
    EXPECT_EQ(target.Center(), red);

    EXPECT_TRUE(projectm_reload_texture(instance, "pm_depth_map"));
    Render(instance, target, frame);
    auto green = target.Center();
    EXPECT_LE(green[0], 5);
    EXPECT_GE(green[1], 250);
    EXPECT_LE(green[2], 5);

    EXPECT_FALSE(projectm_reload_texture(instance, "not_loaded")) << "only loaded textures update in place";
    EXPECT_FALSE(projectm_reload_texture(instance, "noise_lq")) << "generated textures have no file";
    EXPECT_FALSE(projectm_reload_texture(instance, nullptr));

    std::filesystem::remove(texture);
    EXPECT_FALSE(projectm_reload_texture(instance, "pm_depth_map")) << "the file is gone";
    Render(instance, target, frame);
    EXPECT_EQ(target.Center(), green) << "a failed reload keeps the last image";

    projectm_destroy(instance);
}
