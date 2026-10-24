/**
 * @file ColorOutputTest.cpp
 * @brief What the final output stages write: colour encoding and alpha.
 *
 * All on a real GL context (SDL2 + a display, or xvfb-run), because each check runs the
 * production shader source, not a re-statement of it:
 *
 *  - HDR output (ShaderTranspiler::HdrOutputFunctions(), the helpers an HDR build appends
 *    to every composite shader): pure BT.709 primaries come out as their Display P3
 *    encodings. The gamut matrix has to act on linear light before the sRGB transfer
 *    function; applied to encoded values it shifts hue. Tone mapping is off, so only the
 *    matrix and the transfer function are under test.
 *  - The WASM dual-FBO compositor (src/wasm/WasmCompositorShader.hpp): alpha 1 without
 *    transparency mode, valid premultiplied output (rgb <= a) with it.
 *  - libprojectM's own transparency output, through projectm_opengl_render_frame_fbo():
 *    the copy pass, the transition shader and the flash limiter all write premultiplied
 *    pixels, so a canvas created with premultipliedAlpha composites them the same in
 *    every browser.
 */

#include "HeadlessGlContext.hpp"

#include <MilkdropPreset/ShaderTranspiler.hpp>
#include <MilkdropStaticShaders.hpp>

#include "TestGl.hpp"

#include <src/wasm/WasmCompositorShader.hpp>

#include <gtest/gtest.h>

#include <projectM-4/projectM.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

using libprojectM::MilkdropPreset::MilkdropStaticShaders;
namespace ShaderTranspiler = libprojectM::MilkdropPreset::ShaderTranspiler;

namespace {

using Rgba = std::array<float, 4>;

/** @brief A float colour target, so readback adds no quantization of its own. */
class FloatTarget
{
public:
    FloatTarget(int width, int height)
        : m_width(width)
        , m_height(height)
    {
        glGenTextures(1, &m_texture);
        glBindTexture(GL_TEXTURE_2D, m_texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, width, height, 0, GL_RGBA, GL_FLOAT, nullptr);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glBindTexture(GL_TEXTURE_2D, 0);
        glGenFramebuffers(1, &m_framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_texture, 0);
        m_complete = glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }

    ~FloatTarget()
    {
        glDeleteFramebuffers(1, &m_framebuffer);
        glDeleteTextures(1, &m_texture);
    }

    FloatTarget(const FloatTarget&) = delete;
    auto operator=(const FloatTarget&) -> FloatTarget& = delete;

    auto Complete() const -> bool
    {
        return m_complete;
    }

    void Bind() const
    {
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glViewport(0, 0, m_width, m_height);
    }

    auto Read() const -> std::vector<Rgba>
    {
        std::vector<Rgba> pixels(static_cast<size_t>(m_width) * m_height);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, m_framebuffer);
        glReadBuffer(GL_COLOR_ATTACHMENT0);
        glPixelStorei(GL_PACK_ALIGNMENT, 1);
        glReadPixels(0, 0, m_width, m_height, GL_RGBA, GL_FLOAT, pixels.data());
        glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
        return pixels;
    }

private:
    int m_width;
    int m_height;
    GLuint m_texture{0};
    GLuint m_framebuffer{0};
    bool m_complete{false};
};

/** @brief A 1x1 float texture holding one colour. */
class ColorTexture
{
public:
    explicit ColorTexture(const Rgba& color)
    {
        glGenTextures(1, &m_texture);
        glBindTexture(GL_TEXTURE_2D, m_texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, 1, 1, 0, GL_RGBA, GL_FLOAT, color.data());
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glBindTexture(GL_TEXTURE_2D, 0);
    }

    ~ColorTexture()
    {
        glDeleteTextures(1, &m_texture);
    }

    ColorTexture(const ColorTexture&) = delete;
    auto operator=(const ColorTexture&) -> ColorTexture& = delete;

    auto Id() const -> GLuint
    {
        return m_texture;
    }

private:
    GLuint m_texture{0};
};

auto CompileStage(GLenum type, const std::string& source, std::string& log) -> GLuint
{
    const GLuint shader = glCreateShader(type);
    const char* text = source.c_str();
    glShaderSource(shader, 1, &text, nullptr);
    glCompileShader(shader);
    GLint compiled = GL_FALSE;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
    if (compiled == GL_FALSE)
    {
        std::array<char, 4096> info{};
        glGetShaderInfoLog(shader, static_cast<GLsizei>(info.size()), nullptr, info.data());
        log += info.data();
        log += "\n--- source ---\n" + source;
        glDeleteShader(shader);
        return 0;
    }
    return shader;
}

/**
 * @brief Links a program; the vertex position attribute is bound to location 0 under
 *        @p positionAttribute (shaders with a layout qualifier ignore that).
 */
auto LinkProgram(const std::string& vertexSource, const std::string& fragmentSource,
                 const char* positionAttribute, std::string& log) -> GLuint
{
    const GLuint vertex = CompileStage(GL_VERTEX_SHADER, vertexSource, log);
    const GLuint fragment = CompileStage(GL_FRAGMENT_SHADER, fragmentSource, log);
    if (vertex == 0 || fragment == 0)
    {
        glDeleteShader(vertex);
        glDeleteShader(fragment);
        return 0;
    }
    const GLuint program = glCreateProgram();
    glAttachShader(program, vertex);
    glAttachShader(program, fragment);
    glBindAttribLocation(program, 0, positionAttribute);
    glLinkProgram(program);
    glDeleteShader(vertex);
    glDeleteShader(fragment);
    GLint linked = GL_FALSE;
    glGetProgramiv(program, GL_LINK_STATUS, &linked);
    if (linked == GL_FALSE)
    {
        std::array<char, 4096> info{};
        glGetProgramInfoLog(program, static_cast<GLsizei>(info.size()), nullptr, info.data());
        log += info.data();
        glDeleteProgram(program);
        return 0;
    }
    return program;
}

/** @brief Draws a fullscreen quad (positions at attribute 0) with the bound program. */
void DrawFullscreenQuad()
{
    static constexpr std::array<GLfloat, 8> quad{-1.0f, -1.0f, 1.0f, -1.0f, -1.0f, 1.0f, 1.0f, 1.0f};
    GLuint vertexArray = 0;
    GLuint buffer = 0;
    glGenVertexArrays(1, &vertexArray);
    glGenBuffers(1, &buffer);
    glBindVertexArray(vertexArray);
    glBindBuffer(GL_ARRAY_BUFFER, buffer);
    glBufferData(GL_ARRAY_BUFFER, sizeof(quad), quad.data(), GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, nullptr);
    glDisable(GL_BLEND);
    glDisable(GL_SCISSOR_TEST);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glBindVertexArray(0);
    glBindBuffer(GL_ARRAY_BUFFER, 0);
    glDeleteBuffers(1, &buffer);
    glDeleteVertexArrays(1, &vertexArray);
}

// --- HDR output -------------------------------------------------------------------------

/**
 * @brief Runs _prjm_hdr_out() on one linear BT.709 colour, through the same preprocessing
 *        and HLSL-to-GLSL path preset composite shaders take, and returns what it wrote.
 */
auto EvaluateHdrOutput(ShaderTranspiler::ToneMap toneMap, ShaderTranspiler::OutputGamut gamut,
                       const Rgba& linearBt709, std::string& error) -> Rgba
{
    // Functions before shader_body are how preset shaders define helpers too.
    std::string program = ShaderTranspiler::HdrOutputFunctions(toneMap, gamut) +
                          "shader_body\n{\n    ret = _prjm_hdr_out(float3(" +
                          std::to_string(linearBt709[0]) + ", " + std::to_string(linearBt709[1]) + ", " +
                          std::to_string(linearBt709[2]) + "));\n}\n";
    ShaderTranspiler::PreprocessPresetShader(ShaderTranspiler::ShaderType::CompositeShader, program);

    std::string glsl;
    if (!ShaderTranspiler::TranspileToGlsl(program, {"uniform sampler2D sampler_main;\n"}, {"uniform float4 texsize_main;\n"},
                                           MilkdropStaticShaders::Get()->GetGlslGeneratorVersion(), glsl, error))
    {
        return {};
    }

    const GLuint shaderProgram = LinkProgram(MilkdropStaticShaders::Get()->GetPresetCompVertexShader(), glsl,
                                             "vertex_position", error);
    if (shaderProgram == 0)
    {
        return {};
    }
    FloatTarget target(1, 1);
    if (!target.Complete())
    {
        error = "RGBA32F is not renderable here";
        glDeleteProgram(shaderProgram);
        return {};
    }
    target.Bind();
    glUseProgram(shaderProgram);
    DrawFullscreenQuad();
    glUseProgram(0);
    glDeleteProgram(shaderProgram);
    return target.Read().front();
}

auto SrgbEncode(double linear) -> double
{
    return linear <= 0.0031308 ? 12.92 * linear : 1.055 * std::pow(linear, 1.0 / 2.4) - 0.055;
}

/** @brief Linear BT.709 -> encoded Display P3, the reference the shader must match. */
auto ReferenceDisplayP3(const Rgba& c) -> Rgba
{
    static constexpr double m[3][3] = {{0.8224621, 0.1775380, 0.0},
                                       {0.0331941, 0.9668058, 0.0},
                                       {0.0170827, 0.0723974, 0.9105199}};
    Rgba out{0.0f, 0.0f, 0.0f, 1.0f};
    for (int row = 0; row < 3; row++)
    {
        const double linear = m[row][0] * c[0] + m[row][1] * c[1] + m[row][2] * c[2];
        out[row] = static_cast<float>(SrgbEncode(std::min(1.0, std::max(0.0, linear))));
    }
    return out;
}

constexpr float kOneLevel = 1.0f / 255.0f;

// --- Compositor -------------------------------------------------------------------------

/** @brief The compositor's GLSL ES 3.00 source, made to compile on this context. */
auto ForThisContext(const char* source) -> std::string
{
    std::string text(source);
#ifndef USE_GLES
    const std::string esVersion = "#version 300 es";
    text.replace(text.find(esVersion), esVersion.size(), "#version 330 core");
#endif
    return text;
}

struct CompositorInputs {
    Rgba a{};
    Rgba b{};
    float blend{0.0f};
    bool dither{false};
    bool transparency{false};
    float threshold{0.01f};
};

constexpr int kCompositorSize = 4; //!< One period of the 4x4 dither pattern.

auto RunCompositor(const CompositorInputs& in, std::string& error) -> std::vector<Rgba>
{
    const GLuint program = LinkProgram(ForThisContext(kCompositorVertexShader),
                                       ForThisContext(kCompositorFragmentShader), "aPosition", error);
    if (program == 0)
    {
        return {};
    }
    FloatTarget target(kCompositorSize, kCompositorSize);
    if (!target.Complete())
    {
        error = "RGBA32F is not renderable here";
        glDeleteProgram(program);
        return {};
    }
    const ColorTexture textureA(in.a);
    const ColorTexture textureB(in.b);

    target.Bind();
    glUseProgram(program);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, textureA.Id());
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, textureB.Id());
    glUniform1i(glGetUniformLocation(program, "uTexA"), 0);
    glUniform1i(glGetUniformLocation(program, "uTexB"), 1);
    glUniform1f(glGetUniformLocation(program, "uBlend"), in.blend);
    glUniform1f(glGetUniformLocation(program, "uDither"), in.dither ? 1.0f : 0.0f);
    glUniform1i(glGetUniformLocation(program, "u_transparencyEnabled"), in.transparency ? 1 : 0);
    glUniform1f(glGetUniformLocation(program, "u_transparencyThreshold"), in.threshold);
    DrawFullscreenQuad();
    glBindTexture(GL_TEXTURE_2D, 0);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, 0);
    glUseProgram(0);
    glDeleteProgram(program);
    return target.Read();
}

void ExpectPremultiplied(const std::vector<Rgba>& pixels)
{
    for (size_t i = 0; i < pixels.size(); i++)
    {
        const Rgba& p = pixels[i];
        EXPECT_LE(p[0], p[3] + 1e-6f) << "pixel " << i << " red exceeds alpha";
        EXPECT_LE(p[1], p[3] + 1e-6f) << "pixel " << i << " green exceeds alpha";
        EXPECT_LE(p[2], p[3] + 1e-6f) << "pixel " << i << " blue exceeds alpha";
    }
}

void ExpectEveryPixel(const std::vector<Rgba>& pixels, const Rgba& expected, float tolerance)
{
    for (size_t i = 0; i < pixels.size(); i++)
    {
        for (int channel = 0; channel < 4; channel++)
        {
            EXPECT_NEAR(pixels[i][channel], expected[channel], tolerance) << "pixel " << i << " channel " << channel;
        }
    }
}

// --- Engine output ----------------------------------------------------------------------

constexpr int kEngineWidth = 64;
constexpr int kEngineHeight = 48;

/** @brief An RGBA8 target, like a host's canvas. */
class ByteTarget
{
public:
    ByteTarget()
    {
        glGenTextures(1, &m_texture);
        glBindTexture(GL_TEXTURE_2D, m_texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kEngineWidth, kEngineHeight, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        glBindTexture(GL_TEXTURE_2D, 0);
        glGenFramebuffers(1, &m_framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_texture, 0);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }

    ~ByteTarget()
    {
        glDeleteFramebuffers(1, &m_framebuffer);
        glDeleteTextures(1, &m_texture);
    }

    ByteTarget(const ByteTarget&) = delete;
    auto operator=(const ByteTarget&) -> ByteTarget& = delete;

    auto Id() const -> GLuint
    {
        return m_framebuffer;
    }

    auto Read() const -> std::vector<uint8_t>
    {
        std::vector<uint8_t> pixels(static_cast<size_t>(kEngineWidth) * kEngineHeight * 4);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, m_framebuffer);
        glReadBuffer(GL_COLOR_ATTACHMENT0);
        glPixelStorei(GL_PACK_ALIGNMENT, 1);
        glReadPixels(0, 0, kEngineWidth, kEngineHeight, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
        glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
        return pixels;
    }

private:
    GLuint m_texture{0};
    GLuint m_framebuffer{0};
};

struct AlphaCensus {
    size_t transparent{0}; //!< alpha 0
    size_t opaque{0};      //!< alpha 255
    size_t partial{0};     //!< anything else
    size_t invalid{0};     //!< a colour channel above alpha
};

auto CountAlpha(const std::vector<uint8_t>& pixels) -> AlphaCensus
{
    AlphaCensus census;
    for (size_t i = 0; i + 3 < pixels.size(); i += 4)
    {
        const uint8_t alpha = pixels[i + 3];
        census.transparent += alpha == 0 ? 1 : 0;
        census.opaque += alpha == 255 ? 1 : 0;
        census.partial += (alpha != 0 && alpha != 255) ? 1 : 0;
        census.invalid += (pixels[i] > alpha || pixels[i + 1] > alpha || pixels[i + 2] > alpha) ? 1 : 0;
    }
    return census;
}

auto PresetPath(const char* name) -> std::string
{
    return std::string(PROJECTM_PRESET_TESTS_DIR) + "/" + name;
}

class ColorOutputTest : public testing::Test
{
protected:
    // One context for the suite, for the reason PerPixelGpuRenderTest gives: projectM's
    // GL resolver pins its backend at the first projectm_create() in the process.
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
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> ColorOutputTest::s_context;

} // namespace

TEST_F(ColorOutputTest, DisplayP3EncodesPureBt709Primaries)
{
#ifdef PROJECTM_HDR_RENDERING
    GTEST_SKIP() << "an HDR build wraps every composite shader in _prjm_hdr_out() already";
#endif
    using ShaderTranspiler::OutputGamut;
    using ShaderTranspiler::ToneMap;

    std::string error;
    const Rgba red = EvaluateHdrOutput(ToneMap::None, OutputGamut::DisplayP3, {1.0f, 0.0f, 0.0f, 1.0f}, error);
    ASSERT_TRUE(error.empty()) << error;
    // The golden values of the issue: linear BT.709 red in Display P3, sRGB-encoded.
    EXPECT_NEAR(red[0], 0.9175f, kOneLevel);
    EXPECT_NEAR(red[1], 0.2003f, kOneLevel);
    EXPECT_NEAR(red[2], 0.1386f, kOneLevel);
    EXPECT_EQ(red[3], 1.0f);

    const std::array<Rgba, 5> inputs{{{0.0f, 1.0f, 0.0f, 1.0f},
                                      {0.0f, 0.0f, 1.0f, 1.0f},
                                      {1.0f, 1.0f, 1.0f, 1.0f},
                                      {0.0f, 0.0f, 0.0f, 1.0f},
                                      {0.2f, 0.5f, 0.05f, 1.0f}}};
    for (const Rgba& input : inputs)
    {
        const Rgba out = EvaluateHdrOutput(ToneMap::None, OutputGamut::DisplayP3, input, error);
        ASSERT_TRUE(error.empty()) << error;
        const Rgba expected = ReferenceDisplayP3(input);
        for (int channel = 0; channel < 3; channel++)
        {
            EXPECT_NEAR(out[channel], expected[channel], kOneLevel)
                << "input (" << input[0] << ", " << input[1] << ", " << input[2] << ") channel " << channel;
        }
    }
}

TEST_F(ColorOutputTest, SrgbOutputWithoutToneMapOnlyEncodes)
{
#ifdef PROJECTM_HDR_RENDERING
    GTEST_SKIP() << "an HDR build wraps every composite shader in _prjm_hdr_out() already";
#endif
    using ShaderTranspiler::OutputGamut;
    using ShaderTranspiler::ToneMap;

    std::string error;
    const Rgba red = EvaluateHdrOutput(ToneMap::None, OutputGamut::Srgb, {1.0f, 0.0f, 0.0f, 1.0f}, error);
    ASSERT_TRUE(error.empty()) << error;
    EXPECT_NEAR(red[0], 1.0f, kOneLevel);
    EXPECT_NEAR(red[1], 0.0f, kOneLevel);
    EXPECT_NEAR(red[2], 0.0f, kOneLevel);

    const Rgba grey = EvaluateHdrOutput(ToneMap::None, OutputGamut::Srgb, {0.18f, 0.18f, 0.18f, 1.0f}, error);
    ASSERT_TRUE(error.empty()) << error;
    EXPECT_NEAR(grey[0], SrgbEncode(0.18), kOneLevel);
}

TEST_F(ColorOutputTest, ToneMapRunsInLinearLightBeforeTheGamutMatrix)
{
#ifdef PROJECTM_HDR_RENDERING
    GTEST_SKIP() << "an HDR build wraps every composite shader in _prjm_hdr_out() already";
#endif
    using ShaderTranspiler::OutputGamut;
    using ShaderTranspiler::ToneMap;

    // Over-range red: Reinhard scales by 1 / (1 + L), then the matrix, then the encode.
    const Rgba input{2.0f, 0.0f, 0.0f, 1.0f};
    const float scale = 1.0f / (1.0f + 0.2126f * input[0]);
    const Rgba toneMapped{input[0] * scale, 0.0f, 0.0f, 1.0f};

    std::string error;
    const Rgba out = EvaluateHdrOutput(ToneMap::Reinhard, OutputGamut::DisplayP3, input, error);
    ASSERT_TRUE(error.empty()) << error;
    const Rgba expected = ReferenceDisplayP3(toneMapped);
    for (int channel = 0; channel < 3; channel++)
    {
        EXPECT_NEAR(out[channel], expected[channel], kOneLevel) << "channel " << channel;
    }
}

TEST_F(ColorOutputTest, CompositorWritesOpaqueAlphaWithoutTransparency)
{
    std::string error;
    // A preset's alpha is blend-mode leftovers; it must not reach the canvas as coverage.
    auto pixels = RunCompositor({{0.8f, 0.6f, 0.4f, 0.2f}, {0.8f, 0.6f, 0.4f, 0.2f}}, error);
    ASSERT_TRUE(error.empty()) << error;
    ExpectEveryPixel(pixels, {0.8f, 0.6f, 0.4f, 1.0f}, 1e-6f);

    CompositorInputs dithered{{0.5f, 0.5f, 0.5f, 0.0f}, {0.5f, 0.5f, 0.5f, 0.0f}};
    dithered.dither = true;
    pixels = RunCompositor(dithered, error);
    ASSERT_TRUE(error.empty()) << error;
    ExpectEveryPixel(pixels, {0.5f, 0.5f, 0.5f, 1.0f}, 0.5f * kOneLevel + 1e-6f);
}

TEST_F(ColorOutputTest, CompositorWritesPremultipliedAlphaWithTransparency)
{
    std::string error;
    CompositorInputs opaque{{0.8f, 0.6f, 0.4f, 1.0f}, {0.8f, 0.6f, 0.4f, 1.0f}};
    opaque.transparency = true;
    auto pixels = RunCompositor(opaque, error);
    ASSERT_TRUE(error.empty()) << error;
    ExpectEveryPixel(pixels, {0.8f, 0.6f, 0.4f, 1.0f}, 1e-6f);

    CompositorInputs nearBlack{{0.004f, 0.004f, 0.004f, 1.0f}, {0.004f, 0.004f, 0.004f, 1.0f}};
    nearBlack.transparency = true;
    pixels = RunCompositor(nearBlack, error);
    ASSERT_TRUE(error.empty()) << error;
    ExpectEveryPixel(pixels, {0.0f, 0.0f, 0.0f, 0.0f}, 0.0f);

    // A crossfade from a cut-out pixel to an opaque one: the engine wrote both
    // premultiplied, so the mix is partial coverage, not a darkened opaque pixel.
    CompositorInputs crossfade{{0.0f, 0.0f, 0.0f, 0.0f}, {0.6f, 0.4f, 0.2f, 1.0f}, 0.5f};
    crossfade.transparency = true;
    pixels = RunCompositor(crossfade, error);
    ASSERT_TRUE(error.empty()) << error;
    ExpectEveryPixel(pixels, {0.3f, 0.2f, 0.1f, 0.5f}, 1e-6f);

    // Whatever comes in (here straight alpha) and with the dither pushing it up, the
    // colour never exceeds the alpha.
    CompositorInputs straight{{0.9f, 0.9f, 0.9f, 0.3f}, {0.9f, 0.9f, 0.9f, 0.3f}};
    straight.transparency = true;
    straight.dither = true;
    pixels = RunCompositor(straight, error);
    ASSERT_TRUE(error.empty()) << error;
    ExpectPremultiplied(pixels);
    ExpectEveryPixel(pixels, {0.3f, 0.3f, 0.3f, 0.3f}, 1e-6f);

    CompositorInputs ditheredEdge{{0.5f, 0.5f, 0.5f, 0.5f}, {0.5f, 0.5f, 0.5f, 0.5f}};
    ditheredEdge.transparency = true;
    ditheredEdge.dither = true;
    pixels = RunCompositor(ditheredEdge, error);
    ASSERT_TRUE(error.empty()) << error;
    ExpectPremultiplied(pixels);
}

TEST_F(ColorOutputTest, EngineTransparencyOutputIsPremultiplied)
{
    ByteTarget target;
    auto* instance = projectm_create();
    ASSERT_NE(instance, nullptr);
    projectm_set_window_size(instance, kEngineWidth, kEngineHeight);
    projectm_set_preset_duration(instance, 3600.0);
    projectm_set_soft_cut_duration(instance, 4.0);
    projectm_set_transparency_mode(instance, true);

    // Steady state: the copy pass. A red border on black, so both outcomes occur.
    projectm_load_preset_file(instance, PresetPath("100-square.milk").c_str(), false);
    double time = 0.0;
    for (int frame = 0; frame < 3; frame++, time += 1.0 / 60.0)
    {
        projectm_set_frame_time(instance, time);
        projectm_opengl_render_frame_fbo(instance, target.Id());
    }
    AlphaCensus census = CountAlpha(target.Read());
    EXPECT_EQ(census.invalid, 0u) << "copy pass";
    EXPECT_EQ(census.partial, 0u) << "copy pass: opaque or cut out, nothing between";
    EXPECT_GT(census.transparent, 0u);
    EXPECT_GT(census.opaque, 0u);

    // Mid-crossfade: the transition shader.
    projectm_load_preset_file(instance, PresetPath("280-compshader-blur3.milk").c_str(), true);
    for (int frame = 0; frame < 30; frame++, time += 1.0 / 60.0)
    {
        projectm_set_frame_time(instance, time);
        projectm_opengl_render_frame_fbo(instance, target.Id());
    }
    census = CountAlpha(target.Read());
    EXPECT_EQ(census.invalid, 0u) << "transition shader";

    projectm_destroy(instance);
}

TEST_F(ColorOutputTest, FlashLimitedTransparencyOutputIsPremultiplied)
{
    ByteTarget target;
    auto* instance = projectm_create();
    ASSERT_NE(instance, nullptr);
    projectm_set_window_size(instance, kEngineWidth, kEngineHeight);
    projectm_set_preset_duration(instance, 3600.0);
    projectm_set_soft_cut_duration(instance, 0.0);
    projectm_set_transparency_mode(instance, true);
    projectm_set_flash_limit_enabled(instance, true);

    // A black/white strobe: black is cut out, and the limiter blends the white frames
    // with the held cut-out ones, which mixes colour and alpha differently.
    projectm_load_preset_file(instance, PresetPath("290-compshader-strobe.milk").c_str(), false);
    size_t partialPixels = 0;
    for (int frame = 0; frame < 16; frame++)
    {
        projectm_set_frame_time(instance, static_cast<double>(frame) / 60.0);
        projectm_opengl_render_frame_fbo(instance, target.Id());
        const AlphaCensus census = CountAlpha(target.Read());
        EXPECT_EQ(census.invalid, 0u) << "frame " << frame;
        partialPixels += census.partial;
    }
    EXPECT_GT(projectm_get_flash_limit_clamped_frames(instance), 0u);
    EXPECT_GT(partialPixels, 0u) << "the limiter's blend never ran on a cut-out frame";

    projectm_destroy(instance);
}
