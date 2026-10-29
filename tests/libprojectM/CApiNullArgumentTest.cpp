/**
 * @file CApiNullArgumentTest.cpp
 * @brief Drives every projectm_* export with null and zero arguments.
 *
 * Each export runs inside CApiGuard (ProjectMCWrapper.cpp), so a null handle or a null pointer
 * the export needs is logged and answered with the fallback value instead of crashing or
 * throwing across the C ABI. The no-handle half needs no GL; the valid-handle half (null
 * pointers into a real instance) needs a headless GL context and skips without one. Run under
 * ASan, a missed check is a crash here rather than a silent wrong answer.
 *
 * When an export is added to src/api, add a call here too.
 */

#include "HeadlessGlContext.hpp"
#include "TestGl.hpp"

#include <gtest/gtest.h>

#include <projectM-4/debug.h>
#include <projectM-4/preset_prepare.h>
#include <projectM-4/projectM.h>
#include <projectM-4/projectm_perf.h>
#include <projectM-4/rhythm.h>
#include <projectM-4/texture_reload.h>

#include <memory>

TEST(CApiNullArgument, NullHandleReturnsFallbacks)
{
    projectm_pcm_add_float(nullptr, nullptr, 0, PROJECTM_STEREO);
    projectm_pcm_add_int16(nullptr, nullptr, 0, PROJECTM_STEREO);
    projectm_pcm_add_uint8(nullptr, nullptr, 0, PROJECTM_STEREO);
    projectm_pcm_add_float(nullptr, nullptr, 512, PROJECTM_STEREO);

    projectm_set_preset_switch_requested_event_callback(nullptr, nullptr, nullptr);
    projectm_set_preset_switch_failed_event_callback(nullptr, nullptr, nullptr);
    projectm_set_texture_load_event_callback(nullptr, nullptr, nullptr);

    projectm_destroy(nullptr);
    projectm_load_preset_file(nullptr, nullptr, false);
    projectm_load_preset_data(nullptr, nullptr, false);
    projectm_reset_textures(nullptr);
    projectm_get_version_components(nullptr, nullptr, nullptr);

    projectm_write_debug_image_on_next_frame(nullptr, nullptr);

    projectm_free_string(nullptr);

    projectm_set_texture_search_paths(nullptr, nullptr, 0);
    projectm_set_texture_search_paths(nullptr, nullptr, 3);
    projectm_set_frame_time(nullptr, 0);
    EXPECT_EQ(projectm_get_last_frame_time(nullptr), 0.0);
    projectm_set_beat_sensitivity(nullptr, 0);
    EXPECT_EQ(projectm_get_beat_sensitivity(nullptr), 0.0f);
    projectm_set_hard_cut_duration(nullptr, 0);
    EXPECT_EQ(projectm_get_hard_cut_duration(nullptr), 0.0);
    projectm_set_hard_cut_enabled(nullptr, false);
    EXPECT_FALSE(projectm_get_hard_cut_enabled(nullptr));
    projectm_set_hard_cut_sensitivity(nullptr, 0);
    EXPECT_EQ(projectm_get_hard_cut_sensitivity(nullptr), 0.0f);
    projectm_set_soft_cut_duration(nullptr, 0);
    EXPECT_EQ(projectm_get_soft_cut_duration(nullptr), 0.0);
    projectm_set_preset_duration(nullptr, 0);
    EXPECT_EQ(projectm_get_preset_duration(nullptr), 0.0);
    projectm_set_mesh_size(nullptr, 0, 0);
    projectm_get_mesh_size(nullptr, nullptr, nullptr);
    projectm_set_max_blur_level(nullptr, 0);
    EXPECT_EQ(projectm_get_max_blur_level(nullptr), 0);
    projectm_set_blur_resolution_scale(nullptr, 0);
    EXPECT_EQ(projectm_get_blur_resolution_scale(nullptr), 0.0f);
    projectm_set_texel_offset(nullptr, 0, 0);
    projectm_get_texel_offset(nullptr, nullptr, nullptr);
    projectm_set_fps(nullptr, 0);
    EXPECT_EQ(projectm_get_fps(nullptr), 0);
    projectm_set_aspect_correction(nullptr, false);
    EXPECT_FALSE(projectm_get_aspect_correction(nullptr));
    projectm_set_easter_egg(nullptr, 0);
    EXPECT_EQ(projectm_get_easter_egg(nullptr), 0.0f);
    projectm_set_preset_locked(nullptr, false);
    EXPECT_FALSE(projectm_get_preset_locked(nullptr));
    projectm_set_window_size(nullptr, 0, 0);
    projectm_get_window_size(nullptr, nullptr, nullptr);
    projectm_set_preset_start_clean(nullptr, false);
    EXPECT_FALSE(projectm_get_preset_start_clean(nullptr));
    projectm_set_transparency_mode(nullptr, false);
    EXPECT_FALSE(projectm_get_transparency_mode(nullptr));
    projectm_set_transparency_threshold(nullptr, 0);
    EXPECT_EQ(projectm_get_transparency_threshold(nullptr), 0.0f);
    projectm_set_flash_limit_enabled(nullptr, false);
    EXPECT_FALSE(projectm_get_flash_limit_enabled(nullptr));
    projectm_set_flash_limit_threshold(nullptr, 0);
    EXPECT_EQ(projectm_get_flash_limit_threshold(nullptr), 0.0f);
    EXPECT_EQ(projectm_get_flash_limit_clamped_frames(nullptr), 0u);

    EXPECT_EQ(projectm_preset_prepare_begin_file(nullptr, nullptr), nullptr);
    EXPECT_EQ(projectm_preset_prepare_begin_file_contents(nullptr, nullptr, nullptr, 0), nullptr);
    EXPECT_EQ(projectm_preset_prepare_begin_file_contents(nullptr, nullptr, nullptr, 64), nullptr);
    EXPECT_EQ(projectm_preset_prepare_begin_data(nullptr, nullptr), nullptr);
    projectm_preset_prepare_run(nullptr);
    EXPECT_FALSE(projectm_preset_prepare_failed(nullptr));
    projectm_load_prepared_preset(nullptr, nullptr, false);
    EXPECT_FALSE(projectm_poll_pending_preset(nullptr));
    projectm_set_parallel_shader_compile(nullptr, false);
    EXPECT_FALSE(projectm_get_parallel_shader_compile(nullptr));
    projectm_preset_prepare_free(nullptr);

    projectm_perf_get_frame_timings(nullptr);
    projectm_perf_get_openmp_info(nullptr);

    projectm_opengl_render_frame(nullptr);
    projectm_opengl_render_frame_fbo(nullptr, 0);
    projectm_opengl_burn_texture(nullptr, 0, 0, 0, 0, 0);

    projectm_get_rhythm_info(nullptr, nullptr);
    projectm_rhythm_info rhythm{};
    projectm_get_rhythm_info(nullptr, &rhythm);
    projectm_set_rhythm_hint(nullptr, 0);
    EXPECT_EQ(projectm_get_rhythm_hint(nullptr), 0.0f);
    projectm_set_preset_switch_policy(nullptr, PROJECTM_PRESET_SWITCH_TIMER, 0);
    EXPECT_EQ(projectm_get_preset_switch_policy(nullptr, nullptr), PROJECTM_PRESET_SWITCH_TIMER);
    projectm_set_soft_cut_duration_beats(nullptr, 0);
    EXPECT_EQ(projectm_get_soft_cut_duration_beats(nullptr), 0.0);
    projectm_set_hard_cut_on_beat(nullptr, false);
    EXPECT_FALSE(projectm_get_hard_cut_on_beat(nullptr));

    EXPECT_FALSE(projectm_reload_texture(nullptr, nullptr));
    EXPECT_FALSE(projectm_reload_texture(nullptr, "noise_lq"));

    projectm_touch(nullptr, 0, 0, 0, PROJECTM_TOUCH_TYPE_RANDOM);
    projectm_touch_drag(nullptr, 0, 0, 0);
    projectm_touch_destroy(nullptr, 0, 0);
    projectm_touch_destroy_all(nullptr);

    EXPECT_EQ(projectm_sprite_create(nullptr, nullptr, nullptr), 0u);
    projectm_sprite_destroy(nullptr, 0);
    projectm_sprite_destroy_all(nullptr);
    EXPECT_EQ(projectm_sprite_get_sprite_count(nullptr), 0u);
    projectm_sprite_get_sprite_ids(nullptr, nullptr);
    projectm_sprite_set_max_sprites(nullptr, 0);
    EXPECT_EQ(projectm_sprite_get_max_sprites(nullptr), 0u);
    EXPECT_EQ(projectm_sprite_get_var(nullptr, 0, nullptr), 0.0);
    projectm_sprite_set_var(nullptr, 0, nullptr, 0);
}

TEST(CApiNullArgument, HandleFreeExportsTolerateNullAndZero)
{
    EXPECT_GT(projectm_pcm_get_max_samples(), 0u);

    char* version = projectm_get_version_string();
    ASSERT_NE(version, nullptr);
    projectm_free_string(version);
    char* vcsVersion = projectm_get_vcs_version_string();
    ASSERT_NE(vcsVersion, nullptr);
    projectm_free_string(vcsVersion);
    char* empty = projectm_alloc_string(0);
    projectm_free_string(empty);

    const bool wasDeterministic = projectm_is_deterministic_seed_set();
    projectm_set_deterministic_seed(0);
    EXPECT_TRUE(projectm_is_deterministic_seed_set());
    projectm_clear_deterministic_seed();
    EXPECT_FALSE(projectm_is_deterministic_seed_set());
    EXPECT_FALSE(wasDeterministic);

    projectm_set_log_callback(nullptr, true, nullptr);
    projectm_set_log_level(PROJECTM_LOG_LEVEL_NOTSET, true);

    const bool perfWasEnabled = projectm_perf_is_enabled();
    projectm_perf_set_enabled(perfWasEnabled);
    projectm_perf_set_gpu_stage_callback(nullptr, nullptr);
    const projectm_perf_gpu_stage previous = projectm_perf_enter_gpu_stage(PROJECTM_PERF_GPU_STAGE_OTHER);
    projectm_perf_enter_gpu_stage(previous);
    EXPECT_GE(projectm_perf_openmp_thread_count_in_parallel(), 1);
}

class CApiNullArgumentWithInstance : public testing::Test
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
        projectm_destroy(m_instance);
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
    projectm_handle m_instance{nullptr};
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> CApiNullArgumentWithInstance::s_context;

TEST_F(CApiNullArgumentWithInstance, NullPointersIntoARealInstance)
{
    projectm_pcm_add_float(m_instance, nullptr, 0, PROJECTM_STEREO);
    projectm_pcm_add_float(m_instance, nullptr, 512, PROJECTM_STEREO);
    projectm_pcm_add_int16(m_instance, nullptr, 512, PROJECTM_MONO);
    projectm_pcm_add_uint8(m_instance, nullptr, 512, PROJECTM_MONO);

    projectm_load_preset_file(m_instance, nullptr, false);
    projectm_load_preset_data(m_instance, nullptr, false);

    projectm_set_texture_search_paths(m_instance, nullptr, 0);
    projectm_set_texture_search_paths(m_instance, nullptr, 2);
    const char* pathsWithNull[] = {".", nullptr};
    projectm_set_texture_search_paths(m_instance, pathsWithNull, 2);

    projectm_get_mesh_size(m_instance, nullptr, nullptr);
    projectm_get_texel_offset(m_instance, nullptr, nullptr);
    projectm_get_window_size(m_instance, nullptr, nullptr);
    size_t width{};
    projectm_get_window_size(m_instance, &width, nullptr);
    EXPECT_EQ(width, 32u);

    EXPECT_EQ(projectm_preset_prepare_begin_file(m_instance, nullptr), nullptr);
    EXPECT_EQ(projectm_preset_prepare_begin_file_contents(m_instance, nullptr, nullptr, 0), nullptr);
    EXPECT_EQ(projectm_preset_prepare_begin_file_contents(m_instance, "x.milk", nullptr, 64), nullptr);
    EXPECT_EQ(projectm_preset_prepare_begin_data(m_instance, nullptr), nullptr);
    projectm_load_prepared_preset(m_instance, nullptr, false);

    projectm_get_rhythm_info(m_instance, nullptr);
    projectm_get_preset_switch_policy(m_instance, nullptr);

    EXPECT_FALSE(projectm_reload_texture(m_instance, nullptr));

    EXPECT_EQ(projectm_sprite_create(m_instance, nullptr, nullptr), 0u);
    EXPECT_EQ(projectm_sprite_create(m_instance, "milkdrop", nullptr), 0u);
    projectm_sprite_get_sprite_ids(m_instance, nullptr);
    EXPECT_EQ(projectm_sprite_get_var(m_instance, 0, nullptr), 0.0);
    projectm_sprite_set_var(m_instance, 0, nullptr, 1.0);

    projectm_opengl_render_frame(m_instance);
}
