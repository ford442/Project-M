/**
 * @file RenderDeviceTest.cpp
 * @brief The render-device seam (Renderer::Device, docs/RENDER_DEVICE.md).
 *
 * Two groups:
 *
 *  - ResourceStateTracker on its own, no GL: a draw that samples the texture its own target
 *    renders to is a hazard, and so is a blit or copy that reads what it writes. Sampling a
 *    different texture, or leaving the target's texture bound on a unit the program does
 *    not read, is not.
 *  - GlDevice on a real context (SDL2 + a display, or xvfb-run): a pass that clears a
 *    render target reads back the clear colour, CaptureState()/RestoreState() round-trip,
 *    and with validation on a real feedback draw is reported through the backend's hooks
 *    and reaches the projectm_set_log_callback() callback.
 */

#include "HeadlessGlContext.hpp"

#include <Renderer/Device/Gl/GlDevice.hpp>
#include <Renderer/Device/RenderDevice.hpp>
#include <Renderer/Shader.hpp>

#include "TestGl.hpp"

#include <gtest/gtest.h>

#include <projectM-4/logging.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace Device = libprojectM::Renderer::Device;

namespace {

constexpr int kWidth = 16;
constexpr int kHeight = 8;

constexpr int kSamplerLocation = 3;

/** @brief A tracker with one program that samples kSamplerLocation, set to @a unit. */
auto TrackerWithSamplingProgram(int unit) -> Device::ResourceStateTracker
{
    Device::ResourceStateTracker tracker;
    tracker.SetEnabled(true);
    tracker.OnProgramLinked({1}, {kSamplerLocation});
    tracker.OnSetProgram({1});
    tracker.OnSetUniformInt(kSamplerLocation, 1, &unit);
    return tracker;
}

} // namespace

TEST(ResourceStateTrackerTest, DisabledByDefaultAndRecordsNothing)
{
    Device::ResourceStateTracker tracker;
    EXPECT_FALSE(tracker.Enabled());

    tracker.OnBindRenderTarget(Device::TargetBinding::Draw, {7});
    tracker.OnAttach(Device::TargetBinding::Draw, Device::AttachmentPoint::Color0, {3});
    tracker.OnBindTexture(0, Device::TextureTarget::Texture2D, {3});
    tracker.OnDraw();

    EXPECT_EQ(tracker.HazardCount(), 0u);
    EXPECT_EQ(tracker.StateOf({3}), Device::ResourceState::Undefined);
}

TEST(ResourceStateTrackerTest, SamplingTheTargetTextureIsAHazard)
{
    auto tracker = TrackerWithSamplingProgram(0);
    tracker.OnBindRenderTarget(Device::TargetBinding::Draw, {7});
    tracker.OnAttach(Device::TargetBinding::Draw, Device::AttachmentPoint::Color0, {3});
    tracker.OnBindTexture(0, Device::TextureTarget::Texture2D, {3});

    tracker.OnDraw();
    tracker.OnDraw();

    EXPECT_EQ(tracker.HazardCount(), 2u);
    ASSERT_EQ(tracker.HazardMessages().size(), 1u) << "the same hazard is described once";
    EXPECT_NE(tracker.HazardMessages().front().find("texture 3"), std::string::npos);
    EXPECT_NE(tracker.HazardMessages().front().find("render target 7"), std::string::npos);
}

TEST(ResourceStateTrackerTest, UnreadUnitIsNotAHazard)
{
    // The program reads unit 0; the target's own texture sits on unit 1, which nothing samples.
    auto tracker = TrackerWithSamplingProgram(0);
    tracker.OnBindRenderTarget(Device::TargetBinding::Draw, {7});
    tracker.OnAttach(Device::TargetBinding::Draw, Device::AttachmentPoint::Color0, {3});
    tracker.OnBindTexture(0, Device::TextureTarget::Texture2D, {4});
    tracker.OnBindTexture(1, Device::TextureTarget::Texture2D, {3});

    tracker.OnDraw();

    EXPECT_EQ(tracker.HazardCount(), 0u);
    EXPECT_EQ(tracker.StateOf({4}), Device::ResourceState::ShaderResource);
    EXPECT_EQ(tracker.StateOf({3}), Device::ResourceState::RenderTarget);
}

TEST(ResourceStateTrackerTest, SamplerUnitFollowsUniformAssignment)
{
    // Same bindings as above, but the sampler is pointed at unit 1.
    auto tracker = TrackerWithSamplingProgram(1);
    tracker.OnBindRenderTarget(Device::TargetBinding::Draw, {7});
    tracker.OnAttach(Device::TargetBinding::Draw, Device::AttachmentPoint::Color0, {3});
    tracker.OnBindTexture(0, Device::TextureTarget::Texture2D, {4});
    tracker.OnBindTexture(1, Device::TextureTarget::Texture2D, {3});

    tracker.OnDraw();

    EXPECT_EQ(tracker.HazardCount(), 1u);
}

TEST(ResourceStateTrackerTest, DetachingEndsTheHazard)
{
    auto tracker = TrackerWithSamplingProgram(0);
    tracker.OnBindRenderTarget(Device::TargetBinding::Draw, {7});
    tracker.OnAttach(Device::TargetBinding::Draw, Device::AttachmentPoint::Color0, {3});
    tracker.OnBindTexture(0, Device::TextureTarget::Texture2D, {3});
    tracker.OnAttach(Device::TargetBinding::Draw, Device::AttachmentPoint::Color0, {});

    tracker.OnDraw();

    EXPECT_EQ(tracker.HazardCount(), 0u);
}

TEST(ResourceStateTrackerTest, BlitAndCopyThatReadWhatTheyWrite)
{
    Device::ResourceStateTracker tracker;
    tracker.SetEnabled(true);

    // Blit from target 7 into target 8, both backed by texture 3.
    tracker.OnBindRenderTarget(Device::TargetBinding::Read, {7});
    tracker.OnAttach(Device::TargetBinding::Read, Device::AttachmentPoint::Color0, {3});
    tracker.OnBindRenderTarget(Device::TargetBinding::Draw, {8});
    tracker.OnAttach(Device::TargetBinding::Draw, Device::AttachmentPoint::Color0, {3});
    tracker.OnBlit();
    EXPECT_EQ(tracker.HazardCount(), 1u);

    // Copy from target 7 into texture 3, bound on unit 2.
    tracker.ResetHazards();
    tracker.OnBindTexture(2, Device::TextureTarget::Texture2D, {3});
    tracker.OnCopyToTexture(2);
    EXPECT_EQ(tracker.HazardCount(), 1u);

    // Copying into a different texture is fine.
    tracker.ResetHazards();
    tracker.OnBindTexture(2, Device::TextureTarget::Texture2D, {5});
    tracker.OnCopyToTexture(2);
    EXPECT_EQ(tracker.HazardCount(), 0u);
    EXPECT_EQ(tracker.StateOf({3}), Device::ResourceState::CopySource);
    EXPECT_EQ(tracker.StateOf({5}), Device::ResourceState::CopyDestination);
}

TEST(ResourceStateTrackerTest, DestroyedTextureIsForgotten)
{
    auto tracker = TrackerWithSamplingProgram(0);
    tracker.OnBindRenderTarget(Device::TargetBinding::Draw, {7});
    tracker.OnAttach(Device::TargetBinding::Draw, Device::AttachmentPoint::Color0, {3});
    tracker.OnBindTexture(0, Device::TextureTarget::Texture2D, {3});
    tracker.OnDestroyTexture({3});

    // GL reuses names: a new texture 3 is neither attached nor bound.
    tracker.OnDraw();

    EXPECT_EQ(tracker.HazardCount(), 0u);
    EXPECT_EQ(tracker.StateOf({3}), Device::ResourceState::Undefined);
}

namespace {

#ifdef USE_GLES
constexpr const char* kShaderHeader = "#version 300 es\nprecision mediump float;\n";
#else
constexpr const char* kShaderHeader = "#version 330 core\n";
#endif

void CollectLog(const char* message, projectm_log_level /*level*/, void* userData)
{
    static_cast<std::vector<std::string>*>(userData)->emplace_back(message);
}

// A fullscreen triangle from gl_VertexID, no vertex buffers.
constexpr const char* kVertexBody = R"(
void main()
{
    vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}
)";

constexpr const char* kFragmentBody = R"(
uniform sampler2D source;
out vec4 color;
void main()
{
    color = texture(source, vec2(0.5));
}
)";

} // namespace

class GlDeviceTest : public testing::Test
{
protected:
    // One context for the suite, for the reason PerPixelGpuRenderTest gives.
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
            GTEST_SKIP() << "No GL context available (needs SDL2 and a display, or xvfb-run).";
        }
        // A device of the test's own, so turning validation on cannot leak into other tests.
        m_device = std::make_unique<Device::Gl::GlDevice>();
        m_scope = std::make_unique<Device::ScopedDevice>(*m_device);
    }

    void TearDown() override
    {
        m_scope.reset();
        m_device.reset();
    }

    /** @brief An RGBA8 texture of kWidth x kHeight, nearest-filtered and edge-clamped. */
    auto CreateColorTexture() -> Device::TextureHandle
    {
        Device::TextureDesc desc;
        desc.width = kWidth;
        desc.height = kHeight;
        desc.format = Device::TextureFormat::RGBA8;
        desc.sampling = Device::TextureSampling{Device::FilterMode::Nearest, Device::WrapMode::ClampToEdge};
        return m_device->CreateTexture(desc, nullptr);
    }

    /** @brief A render target with @a texture on colour attachment 0, left bound for drawing. */
    auto CreateTarget(Device::TextureHandle texture) -> Device::RenderTargetHandle
    {
        auto& commands = m_device->Commands();
        const auto target = m_device->CreateRenderTarget();
        commands.BindRenderTarget(Device::TargetBinding::ReadDraw, target);
        commands.AttachTexture(Device::TargetBinding::ReadDraw, Device::AttachmentPoint::Color0, texture);
        EXPECT_TRUE(commands.CheckRenderTarget(Device::TargetBinding::ReadDraw).complete);
        return target;
    }

    auto ReadTarget(Device::RenderTargetHandle target) -> std::vector<uint8_t>
    {
        auto& commands = m_device->Commands();
        std::vector<uint8_t> pixels(static_cast<size_t>(kWidth) * kHeight * 4);
        commands.BindRenderTarget(Device::TargetBinding::Read, target);
        commands.SetReadBuffer(Device::AttachmentPoint::Color0);
        commands.ReadPixels({0, 0, kWidth, kHeight}, pixels.data());
        return pixels;
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;

    std::unique_ptr<Device::Gl::GlDevice> m_device;
    std::unique_ptr<Device::ScopedDevice> m_scope;
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> GlDeviceTest::s_context;

TEST_F(GlDeviceTest, CurrentIsTheScopedDevice)
{
    EXPECT_EQ(&Device::Current(), m_device.get());
    EXPECT_EQ(&Device::Commands(), &m_device->Commands());
}

TEST_F(GlDeviceTest, ClearPassReadsBack)
{
    const auto texture = CreateColorTexture();
    const auto target = CreateTarget(texture);
    auto& commands = m_device->Commands();

    Device::RenderPassDesc pass;
    pass.target = target;
    pass.binding = Device::TargetBinding::ReadDraw;
    pass.viewport = Device::Rect{0, 0, kWidth, kHeight};
    pass.load = Device::LoadOp::Clear;
    pass.clearColor = {1.0f, 0.0f, 1.0f, 1.0f};
    commands.SetEnabled(Device::Capability::ScissorTest, false);
    commands.BeginPass(pass);
    commands.EndPass();

    const auto pixels = ReadTarget(target);
    for (size_t i = 0; i < pixels.size(); i += 4)
    {
        ASSERT_EQ(pixels[i], 255) << "pixel " << i / 4;
        ASSERT_EQ(pixels[i + 1], 0) << "pixel " << i / 4;
        ASSERT_EQ(pixels[i + 2], 255) << "pixel " << i / 4;
        ASSERT_EQ(pixels[i + 3], 255) << "pixel " << i / 4;
    }

    commands.BindRenderTarget(Device::TargetBinding::ReadDraw, {});
    m_device->DestroyRenderTarget(target);
    m_device->DestroyTexture(texture);
    EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
}

TEST_F(GlDeviceTest, CaptureRestoreRoundTrip)
{
    auto& commands = m_device->Commands();
    const auto texture = CreateColorTexture();
    const auto target = CreateTarget(texture);

    commands.SetEnabled(Device::Capability::Blend, true);
    commands.SetBlendFunction(Device::BlendFactor::SourceAlpha, Device::BlendFactor::OneMinusSourceAlpha);
    commands.SetDepthMask(false);
    commands.SetViewport({1, 2, 3, 4});
    commands.SetEnabled(Device::Capability::ScissorTest, true);
    commands.SetScissor({2, 1, 5, 6});
    commands.BindTexture(0, Device::TextureTarget::Texture2D, texture);
    commands.SetActiveTextureUnit(3);
    const auto saved = commands.CaptureState();

    EXPECT_TRUE(saved.blendEnabled);
    EXPECT_EQ(saved.blendFunction.sourceColor, Device::BlendFactor::SourceAlpha);
    EXPECT_EQ(saved.blendFunction.destinationColor, Device::BlendFactor::OneMinusSourceAlpha);
    EXPECT_FALSE(saved.depthMask);
    EXPECT_EQ(saved.viewport, (Device::Rect{1, 2, 3, 4}));
    EXPECT_TRUE(saved.scissorEnabled);
    EXPECT_EQ(saved.scissorBox, (Device::Rect{2, 1, 5, 6}));
    EXPECT_EQ(saved.activeTextureUnit, 3);
    EXPECT_EQ(saved.unit0Texture2D, texture);
    EXPECT_EQ(saved.drawTarget, target);

    // Knock everything over, then put it back.
    commands.SetEnabled(Device::Capability::Blend, false);
    commands.SetBlendFunction(Device::BlendFactor::One, Device::BlendFactor::Zero);
    commands.SetDepthMask(true);
    commands.SetViewport({0, 0, kWidth, kHeight});
    commands.SetEnabled(Device::Capability::ScissorTest, false);
    commands.SetScissor({0, 0, kWidth, kHeight});
    commands.BindTexture(0, Device::TextureTarget::Texture2D, {});
    commands.BindRenderTarget(Device::TargetBinding::ReadDraw, {});
    commands.RestoreState(saved);

    const auto restored = commands.CaptureState();
    EXPECT_EQ(restored.blendEnabled, saved.blendEnabled);
    EXPECT_EQ(restored.blendFunction.sourceColor, saved.blendFunction.sourceColor);
    EXPECT_EQ(restored.blendFunction.destinationColor, saved.blendFunction.destinationColor);
    EXPECT_EQ(restored.blendFunction.sourceAlpha, saved.blendFunction.sourceAlpha);
    EXPECT_EQ(restored.blendFunction.destinationAlpha, saved.blendFunction.destinationAlpha);
    EXPECT_EQ(restored.depthMask, saved.depthMask);
    EXPECT_EQ(restored.viewport, saved.viewport);
    EXPECT_EQ(restored.scissorEnabled, saved.scissorEnabled);
    EXPECT_EQ(restored.scissorBox, saved.scissorBox);
    EXPECT_EQ(restored.activeTextureUnit, saved.activeTextureUnit);
    EXPECT_EQ(restored.unit0Texture2D, saved.unit0Texture2D);
    EXPECT_EQ(restored.drawTarget, saved.drawTarget);

    // Leave the shared context as other tests expect it.
    commands.SetEnabled(Device::Capability::Blend, false);
    commands.SetBlendFunction(Device::BlendFactor::One, Device::BlendFactor::Zero);
    commands.SetDepthMask(true);
    commands.SetEnabled(Device::Capability::ScissorTest, false);
    commands.BindTexture(0, Device::TextureTarget::Texture2D, {});
    commands.BindRenderTarget(Device::TargetBinding::ReadDraw, {});
    m_device->DestroyRenderTarget(target);
    m_device->DestroyTexture(texture);
    EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
}

TEST_F(GlDeviceTest, ValidationReportsARealFeedbackDraw)
{
    // On before the program links: the tracker learns its sampler uniforms at link time.
    m_device->Validation().SetEnabled(true);
    std::vector<std::string> logged;
    projectm_set_log_callback(&CollectLog, true, &logged);
    projectm_set_log_level(PROJECTM_LOG_LEVEL_WARN, true);

    libprojectM::Renderer::Shader shader;
    shader.CompileProgram(std::string(kShaderHeader) + kVertexBody, std::string(kShaderHeader) + kFragmentBody);

    auto& commands = m_device->Commands();
    const auto feedback = CreateColorTexture();
    const auto other = CreateColorTexture();
    const auto target = CreateTarget(feedback);
    const auto vertexArray = m_device->CreateVertexArray();

    commands.SetEnabled(Device::Capability::ScissorTest, false);
    commands.SetEnabled(Device::Capability::Blend, false);
    commands.BeginPass({target, Device::TargetBinding::Draw, Device::Rect{0, 0, kWidth, kHeight}});
    shader.Bind();
    shader.SetUniformInt("source", 0);
    commands.BindVertexArray(vertexArray);

    // Unit 0 holds another texture; the target's own texture on unit 1 is never sampled.
    commands.BindTexture(0, Device::TextureTarget::Texture2D, other);
    commands.BindTexture(1, Device::TextureTarget::Texture2D, feedback);
    commands.Draw(Device::PrimitiveType::Triangles, 0, 3);
    EXPECT_EQ(m_device->Validation().HazardCount(), 0u);

    // Now the program samples the texture it renders to.
    commands.BindTexture(0, Device::TextureTarget::Texture2D, feedback);
    commands.Draw(Device::PrimitiveType::Triangles, 0, 3);
    EXPECT_EQ(m_device->Validation().HazardCount(), 1u);
    commands.EndPass();

    // Hosts see it through the log callback, once per distinct hazard.
    projectm_set_log_callback(nullptr, true, nullptr);
    projectm_set_log_level(PROJECTM_LOG_LEVEL_NOTSET, true);
    EXPECT_EQ(std::count_if(logged.begin(), logged.end(), [](const std::string& message) {
                  return message.find("[RenderDevice] Feedback hazard") != std::string::npos;
              }),
              1);

    commands.BindVertexArray({});
    commands.BindTexture(1, Device::TextureTarget::Texture2D, {});
    commands.BindTexture(0, Device::TextureTarget::Texture2D, {});
    libprojectM::Renderer::Shader::Unbind();
    commands.BindRenderTarget(Device::TargetBinding::ReadDraw, {});
    m_device->DestroyVertexArray(vertexArray);
    m_device->DestroyRenderTarget(target);
    m_device->DestroyTexture(other);
    m_device->DestroyTexture(feedback);
    // The feedback draw itself is undefined behaviour, not a GL error.
    EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
}

TEST_F(GlDeviceTest, ValidationReportsGlErrorsOncePerOperation)
{
    std::vector<std::string> logged;
    projectm_set_log_callback(&CollectLog, true, &logged);
    projectm_set_log_level(PROJECTM_LOG_LEVEL_WARN, true);
    auto& commands = m_device->Commands();
    const auto countGlErrors = [&logged] {
        return std::count_if(logged.begin(), logged.end(), [](const std::string& message) {
            return message.find("[RenderDevice] GL error 0x0501 after Draw") != std::string::npos;
        });
    };

    // Off: the device leaves the error for whoever polls next.
    commands.Draw(Device::PrimitiveType::Triangles, 0, -1); // GL_INVALID_VALUE
    EXPECT_EQ(countGlErrors(), 0);
    EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_INVALID_VALUE));

    // On: drained and logged, once however often the same operation fails.
    m_device->Validation().SetEnabled(true);
    commands.Draw(Device::PrimitiveType::Triangles, 0, -1);
    commands.Draw(Device::PrimitiveType::Triangles, 0, -1);
    m_device->Validation().SetEnabled(false);

    projectm_set_log_callback(nullptr, true, nullptr);
    projectm_set_log_level(PROJECTM_LOG_LEVEL_NOTSET, true);
    EXPECT_EQ(countGlErrors(), 1);
    EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
}
