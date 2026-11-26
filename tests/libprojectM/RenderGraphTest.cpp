/**
 * @file RenderGraphTest.cpp
 * @brief Renderer::RenderGraph (B2, docs/RENDER_DEVICE.md "Render graph").
 *
 * Without GL: passes run in declaration order, a frame that reads a transient before anything
 * wrote it, or a render pass that samples its own target, does not compile (and runs nothing),
 * "none" entries in read/write lists are skipped, and a frame over the limits is refused.
 * On a real context: transients whose lifetimes do not overlap share one pooled target, the
 * pool is reused frame after frame and drops targets of a size no longer asked for, and render
 * passes are begun and ended around their function with a Discard store at a transient's last use.
 */

#include "HeadlessGlContext.hpp"

#include <Renderer/Device/Gl/GlDevice.hpp>
#include <Renderer/Device/RenderDevice.hpp>
#include <Renderer/Device/ResourceStateTracker.hpp>
#include <Renderer/Framebuffer.hpp>
#include <Renderer/RenderGraph.hpp>

#include "TestGl.hpp"

#include <gtest/gtest.h>

#include <memory>
#include <string>
#include <vector>

using libprojectM::Renderer::RenderGraph;
namespace Device = libprojectM::Renderer::Device;

namespace {

/** @brief A pass function that records its name. */
struct Recorder {
    std::vector<std::string>* log;
    const char* name;
    void operator()(RenderGraph::PassContext& /*context*/) const
    {
        log->emplace_back(name);
    }
};

} // namespace

TEST(RenderGraphTest, EncoderPassesRunInOrder)
{
    RenderGraph graph;
    std::vector<std::string> log;
    Recorder first{&log, "first"};
    Recorder second{&log, "second"};
    graph.Reset();
    const auto image = graph.Import("image", {5});
    graph.AddPass("first", {.kind = RenderGraph::PassKind::Encoder, .writes = {image}}, first);
    graph.AddPass("second", {.kind = RenderGraph::PassKind::Encoder, .reads = {image, RenderGraph::Resource{}}}, second);
    ASSERT_TRUE(graph.Compile());
    EXPECT_EQ(graph.PassCount(), 2u);
    EXPECT_STREQ(graph.PassName(1), "second");
    EXPECT_EQ(graph.PassName(2), nullptr);
    EXPECT_EQ(graph.GetStats().transients, 0u);

    // The command list is not touched by encoder passes; any device's will do.
    graph.Execute(Device::Commands());
    EXPECT_EQ(log, (std::vector<std::string>{"first", "second"}));

    const auto description = graph.Describe();
    EXPECT_NE(description.find("encoder first writes image"), std::string::npos);
    EXPECT_NE(description.find("encoder second reads image"), std::string::npos);
}

TEST(RenderGraphTest, InvalidFramesDoNotRun)
{
    RenderGraph graph;
    std::vector<std::string> log;
    Recorder pass{&log, "pass"};

    // A transient read before anything wrote it.
    graph.Reset();
    const auto scratch = graph.CreateTransient("scratch", {16, 16});
    graph.AddPass("reader", {.kind = RenderGraph::PassKind::Encoder, .reads = {scratch}}, pass);
    EXPECT_FALSE(graph.Compile());
    graph.Execute(Device::Commands());
    EXPECT_TRUE(log.empty());

    // A render pass that samples its own target.
    graph.Reset();
    const auto target = graph.Import("target", {3});
    graph.AddPass("feedback", {.target = target, .reads = {target}}, pass);
    EXPECT_FALSE(graph.Compile());

    // A render pass without a target.
    graph.Reset();
    graph.AddPass("nowhere", {}, pass);
    EXPECT_FALSE(graph.Compile());

    // More passes than the graph holds.
    graph.Reset();
    for (size_t i = 0; i <= RenderGraph::MaxPasses; i++)
    {
        graph.AddPass("many", {.kind = RenderGraph::PassKind::Encoder}, pass);
    }
    EXPECT_FALSE(graph.Compile());
    EXPECT_TRUE(log.empty());

    // Reset() starts over: a valid frame compiles again.
    graph.Reset();
    graph.AddPass("fine", {.kind = RenderGraph::PassKind::Encoder}, pass);
    EXPECT_TRUE(graph.Compile());
}

class RenderGraphGlTest : public testing::Test
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
            GTEST_SKIP() << "No GL context available (needs SDL2 and a display, or xvfb-run).";
        }
        m_device = std::make_unique<Device::Gl::GlDevice>();
        m_scope = std::make_unique<Device::ScopedDevice>(*m_device);
    }

    void TearDown() override
    {
        m_scope.reset();
        m_device.reset();
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
    std::unique_ptr<Device::Gl::GlDevice> m_device;
    std::unique_ptr<Device::ScopedDevice> m_scope;
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> RenderGraphGlTest::s_context;

TEST_F(RenderGraphGlTest, TransientsWithDisjointLifetimesShareATarget)
{
    RenderGraph graph;
    const RenderGraph::TargetDesc desc{32, 16};
    std::vector<libprojectM::Renderer::Framebuffer*> seen;
    struct Capture {
        std::vector<libprojectM::Renderer::Framebuffer*>* seen;
        RenderGraph::Resource resource;
        void operator()(RenderGraph::PassContext& context) const
        {
            seen->push_back(context.Transient(resource));
        }
    };

    for (int frame = 0; frame < 3; frame++)
    {
        graph.Reset();
        const auto output = graph.Import("output", {});
        const auto a = graph.CreateTransient("warp pass target", desc);
        const auto b = graph.CreateTransient("composite pass target", desc);
        Capture useA{&seen, a};
        Capture useB{&seen, b};
        auto nothing = [](RenderGraph::PassContext&) {};
        graph.AddPass("warp", {.kind = RenderGraph::PassKind::Encoder, .writes = {a}}, useA);
        graph.AddPass("between", {.kind = RenderGraph::PassKind::Encoder, .writes = {output}}, nothing);
        graph.AddPass("composite", {.kind = RenderGraph::PassKind::Encoder, .writes = {b}}, useB);
        ASSERT_TRUE(graph.Compile());
        EXPECT_EQ(graph.GetStats().transients, 2u);
        EXPECT_EQ(graph.GetStats().physicalTargets, 1u);
        EXPECT_EQ(graph.GetStats().pooledTargets, 1u);
        graph.Execute(m_device->Commands());
    }
    ASSERT_EQ(seen.size(), 6u);
    for (const auto* framebuffer : seen)
    {
        ASSERT_NE(framebuffer, nullptr);
        EXPECT_EQ(framebuffer, seen.front()) << "every frame reuses the one pooled target";
    }
    EXPECT_EQ(seen.front()->Width(), 32);

    // Overlapping lifetimes need two targets; a different size replaces the old ones.
    graph.Reset();
    const auto a = graph.CreateTransient("a", {64, 64});
    const auto b = graph.CreateTransient("b", {64, 64});
    auto nothing = [](RenderGraph::PassContext&) {};
    graph.AddPass("both", {.kind = RenderGraph::PassKind::Encoder, .writes = {a, b}}, nothing);
    graph.AddPass("reads both", {.kind = RenderGraph::PassKind::Encoder, .reads = {a, b}}, nothing);
    ASSERT_TRUE(graph.Compile());
    EXPECT_EQ(graph.GetStats().physicalTargets, 2u);
    EXPECT_EQ(graph.GetStats().pooledTargets, 2u);
    EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
}

TEST_F(RenderGraphGlTest, RenderPassesAreBegunAndEnded)
{
    m_device->Validation().SetEnabled(true);
    RenderGraph graph;
    const RenderGraph::TargetDesc desc{8, 8, Device::TextureFormat::RGBA8};
    struct Check {
        Device::ICommandList* commands;
        Device::StoreOp expectedStore;
        Device::RenderTargetHandle* target;
        void operator()(RenderGraph::PassContext& /*context*/) const
        {
            const auto* pass = commands->CurrentRenderPass();
            ASSERT_NE(pass, nullptr);
            EXPECT_EQ(pass->store, expectedStore);
            ASSERT_TRUE(pass->viewport.has_value());
            EXPECT_EQ(pass->viewport->width, 8);
            *target = pass->target;
        }
    };
    auto& commands = m_device->Commands();
    Device::RenderTargetHandle firstTarget;
    Device::RenderTargetHandle secondTarget;
    Check first{&commands, Device::StoreOp::Store, &firstTarget};
    Check last{&commands, Device::StoreOp::Discard, &secondTarget};

    graph.Reset();
    const auto scratch = graph.CreateTransient("scratch", desc);
    graph.AddPass("clear scratch", {.target = scratch, .load = Device::LoadOp::Clear, .clearColor = {1.0f, 0.0f, 0.0f, 1.0f}}, first);
    graph.AddPass("draw on scratch", {.target = scratch}, last);
    ASSERT_TRUE(graph.Compile());
    graph.Execute(commands);
    EXPECT_EQ(commands.CurrentRenderPass(), nullptr);
    EXPECT_TRUE(firstTarget.Valid());
    EXPECT_EQ(firstTarget, secondTarget);
    EXPECT_EQ(m_device->Validation().PassCount(), 2u);
    EXPECT_EQ(m_device->Validation().PassViolationCount(), 0u);
    EXPECT_NE(graph.Describe().find("render  clear scratch -> scratch@0 (clear)"), std::string::npos);

    commands.BindRenderTarget(Device::TargetBinding::ReadDraw, {});
    EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
}
