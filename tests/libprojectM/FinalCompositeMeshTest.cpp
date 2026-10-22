/**
 * @file FinalCompositeMeshTest.cpp
 * @brief The composite mesh is rebuilt on a viewport change and not on the frames after it.
 *
 * FinalComposite::InitializeMesh() used to compare the viewport against members it never
 * wrote, so the mesh was rebuilt and re-uploaded every frame. Drives a composite-shader
 * preset through the C API on a real GL context (SDL2 + a display, or xvfb-run).
 */

#include "HeadlessGlContext.hpp"

#include <MilkdropPreset/FinalComposite.hpp>

#include "TestGl.hpp"

#include <gtest/gtest.h>

#include <projectM-4/projectM.h>

#include <cstdint>
#include <memory>
#include <string>

using libprojectM::MilkdropPreset::FinalComposite;

class FinalCompositeMeshTest : public testing::Test
{
protected:
    // One context for the suite: projectM's GL resolver pins its backend at the first
    // projectm_create() in the process (see PerPixelGpuRenderTest).
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

std::unique_ptr<libprojectM::Test::HeadlessGlContext> FinalCompositeMeshTest::s_context;

TEST_F(FinalCompositeMeshTest, RebuildsOnResizeOnly)
{
    auto* instance = projectm_create();
    if (instance == nullptr)
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    projectm_set_window_size(instance, 64, 48);
    projectm_set_preset_duration(instance, 3600.0);
    projectm_set_soft_cut_duration(instance, 0.0);
    const std::string presetPath = std::string(PROJECTM_PRESET_TESTS_DIR) + "/280-compshader-blur3.milk";
    projectm_load_preset_file(instance, presetPath.c_str(), false);

    int frame = 0;
    auto renderFrame = [&]() {
        projectm_set_frame_time(instance, static_cast<double>(frame++) / 60.0);
        projectm_opengl_render_frame(instance);
    };

    // Settle: the idle preset may still be drawing for the first frames.
    const uint64_t beforeWarmUp = FinalComposite::MeshRebuildCount();
    for (int i = 0; i < 10; i++)
    {
        renderFrame();
    }
    ASSERT_GT(FinalComposite::MeshRebuildCount(), beforeWarmUp) << "the composite shader never drew";

    const uint64_t settled = FinalComposite::MeshRebuildCount();
    renderFrame();
    renderFrame();
    EXPECT_EQ(FinalComposite::MeshRebuildCount(), settled) << "same viewport, mesh rebuilt anyway";

    projectm_set_window_size(instance, 80, 60);
    renderFrame();
    EXPECT_EQ(FinalComposite::MeshRebuildCount(), settled + 1) << "resize must rebuild exactly once";
    renderFrame();
    EXPECT_EQ(FinalComposite::MeshRebuildCount(), settled + 1) << "frame after the resize rebuilt again";

    projectm_destroy(instance);
}
