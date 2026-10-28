/**
 * @file UserSpriteApiTest.cpp
 * @brief The user-sprite C API (projectM-4/user_sprites.h) the WASM build exports as
 *        create_sprite() and projectm_sprite_*.
 *
 * On a real GL context (SDL2 + a display, or xvfb-run): a sprite created from a code string
 * gets an id, its expression variables round-trip through projectm_sprite_set_var() /
 * projectm_sprite_get_var(), its per-frame code reads a host-set variable on the next frame,
 * and destroy removes it.
 */

#include "HeadlessGlContext.hpp"
#include "TestGl.hpp"

#include <gtest/gtest.h>

#include <projectM-4/projectM.h>

#include <cstdint>
#include <memory>
#include <vector>

namespace {

/**
 * The sprite the WASM build's zero-argument create_sprite() used to submit, moved here when
 * create_sprite() started taking its code from the caller. Written in the sprite format
 * MilkdropSprite actually parses (one key per line, init_N / code_N); the old string put
 * everything on one line with preset-style per_frame_N keys, which parsed as no code at all.
 */
constexpr const char* kMagentaSprite = "[img01]\n"
                                       "img=rv_IP_20250421_060250\n"
                                       "init_1=blendmode=1; x=0.5; y=0.5; sx=1.0; sy=1.0;\n"
                                       "code_1=a=1; r=1.0; g=0.0; b=1.0;\n";

/** Moves with a variable the host owns: per-frame code runs after set_var, so x itself would be overwritten. */
constexpr const char* kHostDrivenSprite = "[img01]\n"
                                          "img=noise_lq\n"
                                          "init_1=px=0.25;\n"
                                          "code_1=x=px; y=0.5;\n";

class UserSpriteApiTest : public testing::Test
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
        m_instance = projectm_create();
        if (m_instance == nullptr)
        {
            GTEST_SKIP() << "projectm_create() is unavailable with this context";
        }
        projectm_set_window_size(m_instance, 32, 32);
    }

    void TearDown() override
    {
        if (m_instance != nullptr)
        {
            projectm_destroy(m_instance);
        }
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
    projectm_handle m_instance{nullptr};
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> UserSpriteApiTest::s_context;

} // namespace

TEST_F(UserSpriteApiTest, CreateSetGetDestroyRoundTrip)
{
    uint32_t const id = projectm_sprite_create(m_instance, "milkdrop", kMagentaSprite);
    ASSERT_NE(id, 0u);
    EXPECT_EQ(projectm_sprite_get_sprite_count(m_instance), 1u);

    // init_1 ran at creation.
    EXPECT_DOUBLE_EQ(projectm_sprite_get_var(m_instance, id, "x"), 0.5);
    EXPECT_DOUBLE_EQ(projectm_sprite_get_var(m_instance, id, "blendmode"), 1.0);

    projectm_sprite_set_var(m_instance, id, "x", 0.125);
    EXPECT_DOUBLE_EQ(projectm_sprite_get_var(m_instance, id, "x"), 0.125);

    // A name the code never mentions is a variable of its own.
    projectm_sprite_set_var(m_instance, id, "host_value", 3.5);
    EXPECT_DOUBLE_EQ(projectm_sprite_get_var(m_instance, id, "host_value"), 3.5);

    std::vector<uint32_t> ids(projectm_sprite_get_sprite_count(m_instance));
    projectm_sprite_get_sprite_ids(m_instance, ids.data());
    EXPECT_EQ(ids, std::vector<uint32_t>{id});

    projectm_sprite_destroy(m_instance, id);
    EXPECT_EQ(projectm_sprite_get_sprite_count(m_instance), 0u);
    EXPECT_DOUBLE_EQ(projectm_sprite_get_var(m_instance, id, "x"), 0.0) << "a destroyed sprite reads as 0";
    projectm_sprite_set_var(m_instance, id, "x", 1.0); // Ignored, not a crash.
}

TEST_F(UserSpriteApiTest, PerFrameCodeReadsAHostSetVariable)
{
    uint32_t const id = projectm_sprite_create(m_instance, "milkdrop", kHostDrivenSprite);
    ASSERT_NE(id, 0u);

    projectm_set_frame_time(m_instance, 0.0);
    projectm_opengl_render_frame(m_instance);
    EXPECT_DOUBLE_EQ(projectm_sprite_get_var(m_instance, id, "x"), 0.25);

    projectm_sprite_set_var(m_instance, id, "px", 0.75);
    projectm_set_frame_time(m_instance, 1.0 / 60.0);
    projectm_opengl_render_frame(m_instance);
    EXPECT_DOUBLE_EQ(projectm_sprite_get_var(m_instance, id, "x"), 0.75);
}

TEST_F(UserSpriteApiTest, RefusedSpritesReturnZero)
{
    EXPECT_EQ(projectm_sprite_create(m_instance, "milkdrop", "code_1=x = = 1;\n"), 0u) << "per-frame code that does not compile";
    EXPECT_EQ(projectm_sprite_create(m_instance, "not-a-type", kMagentaSprite), 0u);
    EXPECT_EQ(projectm_sprite_get_sprite_count(m_instance), 0u);

    projectm_sprite_set_max_sprites(m_instance, 1);
    EXPECT_EQ(projectm_sprite_get_max_sprites(m_instance), 1u);
    uint32_t const first = projectm_sprite_create(m_instance, "milkdrop", kMagentaSprite);
    uint32_t const second = projectm_sprite_create(m_instance, "milkdrop", kMagentaSprite);
    ASSERT_NE(first, 0u);
    ASSERT_NE(second, 0u);
    std::vector<uint32_t> ids(projectm_sprite_get_sprite_count(m_instance));
    projectm_sprite_get_sprite_ids(m_instance, ids.data());
    EXPECT_EQ(ids.size(), 1u) << "at the limit the oldest sprite makes room";

    projectm_sprite_destroy_all(m_instance);
    EXPECT_EQ(projectm_sprite_get_sprite_count(m_instance), 0u);
}
