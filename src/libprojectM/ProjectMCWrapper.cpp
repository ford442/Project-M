#include "ProjectMCWrapper.hpp"

#include "EngineContext.hpp"
#include "PerfTimers.hpp"
#include "PresetPrepareJob.hpp"
#include "Renderer/Platform/GladLoader.hpp"

#include <projectM-4/projectM.h>

#include <Logging.hpp>

#include <Audio/AudioConstants.hpp>
#include <Renderer/Platform/GLResolver.hpp>

#include <RandomSeed.hpp>

#include <projectM-4/debug.h>
#include <projectM-4/offline_render.h>
#include <projectM-4/parameters.h>
#include <projectM-4/projectm_perf.h>
#include <projectM-4/render_opengl.h>
#include <projectM-4/rhythm.h>

#ifdef PRJM_ENABLE_OPENMP
#include <omp.h>
#endif

#include <exception>
#include <stdexcept>
#include <string>
#include <type_traits>

#include <cstring>
#include <sstream>

namespace libprojectM {

void projectMWrapper::PresetSwitchRequestedEvent(bool isHardCut) const
{
    if (m_presetSwitchRequestedEventCallback)
    {
        m_presetSwitchRequestedEventCallback(isHardCut, m_presetSwitchRequestedEventUserData);
    }
}

void projectMWrapper::PresetSwitchFailedEvent(const std::string& presetFilename,
                                              const std::string& failureMessage) const
{
    if (m_presetSwitchFailedEventCallback)
    {
        m_presetSwitchFailedEventCallback(presetFilename.c_str(),
                                          failureMessage.c_str(), m_presetSwitchFailedEventUserData);
    }
}

} // namespace libprojectM

namespace {

/**
 * @brief Runs one C API export's body so that no exception crosses the C ABI.
 *
 * A std::exception or anything else thrown by @a body is logged with the export's name, and
 * @a fallback is returned instead. Invalid arguments (a null handle, a null pointer the export
 * needs) are thrown by Instance() and Required() inside the body, so they take the same path.
 */
template<typename Body>
auto CApiGuard(const char* function, std::invoke_result_t<Body&> fallback, Body&& body) noexcept -> std::invoke_result_t<Body&>
{
    using libprojectM::Logging;

    try
    {
        return body();
    }
    catch (const std::exception& e)
    {
        try
        {
            LOG_ERROR(std::string(function) + ": " + e.what());
        }
        catch (...)
        {
        }
    }
    catch (...)
    {
        try
        {
            LOG_ERROR(std::string(function) + ": unknown exception");
        }
        catch (...)
        {
        }
    }
    return fallback;
}

template<typename Body>
void CApiGuard(const char* function, Body&& body) noexcept
{
    CApiGuard(function, false, [&body] {
        body();
        return true;
    });
}

auto Instance(projectm_handle instance) -> libprojectM::projectMWrapper&
{
    if (instance == nullptr)
    {
        throw std::invalid_argument("null projectm_handle");
    }
    return *reinterpret_cast<libprojectM::projectMWrapper*>(instance);
}

template<typename T>
auto Required(T* pointer, const char* argument) -> T*
{
    if (pointer == nullptr)
    {
        throw std::invalid_argument(std::string("null ") + argument);
    }
    return pointer;
}

} // namespace

PROJECTM_EXPORT char* projectm_alloc_string(unsigned int length)
{
    try
    {
        return new char[length]{};
    }
    catch (...)
    {
        return nullptr;
    }
}

PROJECTM_EXPORT char* projectm_alloc_string_from_std_string(const std::string& str)
{
    auto pointer = projectm_alloc_string(static_cast<uint32_t>(str.length() + 1));
    if (pointer)
    {
        memcpy(pointer, str.c_str(), str.length());
    }
    return pointer;
}

void projectm_free_string(const char* str)
{
    CApiGuard(__func__, [&] {
        delete[] str;
    });
}

projectm_handle projectm_create()
{
    return CApiGuard(__func__, nullptr, [&]() -> projectm_handle {
        return projectm_create_with_opengl_load_proc(nullptr, nullptr);
    });
}

projectm_handle projectm_create_with_opengl_load_proc(void* (*load_proc)(const char*, void*), void* user_data)
{
    using libprojectM::Logging;

    try
    {
        // Init resolver to discover gl function pointers (guarded internally, valid to call multiple times)
        // Note: only the initial load_proc will be used, parameters on subsequent calls are ignored
        if (!libprojectM::Renderer::Platform::GLResolver::Instance().Initialize(load_proc, user_data))
        {
            return nullptr;
        }

        // Check GL requirements and init GLAD (guarded internally, valid to call multiple times)
        if (!libprojectM::Renderer::Platform::GladLoader::Instance().Initialize())
        {
            return nullptr;
        }

        // create projectM
        auto* projectMInstance = new libprojectM::projectMWrapper();
        return reinterpret_cast<projectm_handle>(projectMInstance);
    }
    catch (const std::exception& e)
    {
        LOG_ERROR("projectm_create_with_opengl_load_proc caught exception:");
        LOG_ERROR(e.what());
        return nullptr;
    }
    catch (...)
    {
        LOG_ERROR("projectm_create_with_opengl_load_proc caught unknown exception");
        return nullptr;
    }
}

void projectm_destroy(projectm_handle instance)
{
    CApiGuard(__func__, [&] {
        delete reinterpret_cast<libprojectM::projectMWrapper*>(instance);
    });
}

void projectm_load_preset_file(projectm_handle instance, const char* filename,
                               bool smooth_transition)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->LoadPresetFile(Required(filename, "filename"), smooth_transition);
    });
}

void projectm_load_preset_data(projectm_handle instance, const char* data,
                               bool smooth_transition)
{
    CApiGuard(__func__, [&] {
        std::stringstream presetDataStream(Required(data, "data"));
        auto* projectMInstance = &Instance(instance);
        projectMInstance->LoadPresetData(presetDataStream, smooth_transition);
    });
}

struct projectm_preset_prepare_job {
    std::unique_ptr<libprojectM::PresetPrepareJob> job;
};

projectm_preset_prepare_job_handle projectm_preset_prepare_begin_file(projectm_handle instance, const char* filename)
{
    return CApiGuard(__func__, nullptr, [&]() -> projectm_preset_prepare_job_handle {
        auto* projectMInstance = &Instance(instance);
        return new projectm_preset_prepare_job{projectMInstance->BeginPreparePresetFile(Required(filename, "filename"))};
    });
}

projectm_preset_prepare_job_handle projectm_preset_prepare_begin_file_contents(projectm_handle instance, const char* filename,
                                                                               const char* data, size_t length)
{
    return CApiGuard(__func__, nullptr, [&]() -> projectm_preset_prepare_job_handle {
        auto* projectMInstance = &Instance(instance);
        std::string contents = length > 0 ? std::string(Required(data, "data"), length) : std::string();
        return new projectm_preset_prepare_job{projectMInstance->BeginPreparePresetFile(Required(filename, "filename"), std::move(contents))};
    });
}

projectm_preset_prepare_job_handle projectm_preset_prepare_begin_data(projectm_handle instance, const char* data)
{
    return CApiGuard(__func__, nullptr, [&]() -> projectm_preset_prepare_job_handle {
        auto* projectMInstance = &Instance(instance);
        return new projectm_preset_prepare_job{projectMInstance->BeginPreparePresetData(Required(data, "data"))};
    });
}

void projectm_preset_prepare_run(projectm_preset_prepare_job_handle job)
{
    CApiGuard(__func__, [&] {
        if (job != nullptr && job->job)
        {
            job->job->Run();
        }
    });
}

bool projectm_preset_prepare_failed(projectm_preset_prepare_job_handle job)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        return job != nullptr && job->job && job->job->HasRun() && job->job->Failed();
    });
}

void projectm_load_prepared_preset(projectm_handle instance, projectm_preset_prepare_job_handle job,
                                   bool smooth_transition)
{
    CApiGuard(__func__, [&] {
        if (job == nullptr)
        {
            return;
        }
        std::unique_ptr<projectm_preset_prepare_job> owned(job);
        auto* projectMInstance = &Instance(instance);
        projectMInstance->LoadPreparedPreset(std::move(owned->job), smooth_transition);
    });
}

bool projectm_poll_pending_preset(projectm_handle instance)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->PollPendingPreset();
    });
}

void projectm_set_parallel_shader_compile(projectm_handle instance, bool enabled)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetParallelShaderCompile(enabled);
    });
}

bool projectm_get_parallel_shader_compile(projectm_handle instance)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->ParallelShaderCompile();
    });
}

void projectm_preset_prepare_free(projectm_preset_prepare_job_handle job)
{
    CApiGuard(__func__, [&] {
        delete job;
    });
}

void projectm_set_preset_switch_requested_event_callback(projectm_handle instance,
                                                         projectm_preset_switch_requested_event callback, void* user_data)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->m_presetSwitchRequestedEventCallback = callback;
        projectMInstance->m_presetSwitchRequestedEventUserData = user_data;
    });
}

void projectm_set_preset_switch_failed_event_callback(projectm_handle instance,
                                                      projectm_preset_switch_failed_event callback, void* user_data)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->m_presetSwitchFailedEventCallback = callback;
        projectMInstance->m_presetSwitchFailedEventUserData = user_data;
    });
}

void projectm_set_texture_load_event_callback(projectm_handle instance,
                                              projectm_texture_load_event callback, void* user_data)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->m_textureLoadEventCallback = callback;
        projectMInstance->m_textureLoadEventUserData = user_data;

        if (callback != nullptr)
        {
            // Create a wrapper lambda that bridges C callback to C++ callback
            projectMInstance->SetTextureLoadCallback(
                [projectMInstance](const std::string& textureName, libprojectM::Renderer::TextureLoadData& data) {
                    if (projectMInstance->m_textureLoadEventCallback)
                    {
                        projectm_texture_load_data cData{};
                        projectMInstance->m_textureLoadEventCallback(
                            textureName.c_str(), &cData, projectMInstance->m_textureLoadEventUserData);

                        // Copy data from C structure to C++ structure
                        data.data = cData.data;
                        data.width = cData.width;
                        data.height = cData.height;
                        data.channels = cData.channels;
                        data.textureId = cData.texture_id;
                    }
                });
        }
        else
        {
            projectMInstance->SetTextureLoadCallback(nullptr);
        }
    });
}

void projectm_set_texture_search_paths(projectm_handle instance,
                                       const char** texture_search_paths,
                                       size_t count)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);

        std::vector<std::string> texturePaths;

        for (size_t index = 0; index < count; index++)
        {
            texturePaths.emplace_back(Required(Required(texture_search_paths, "texture_search_paths")[index], "texture search path"));
        }

        projectMInstance->SetTexturePaths(texturePaths);
    });
}

void projectm_reset_textures(projectm_handle instance)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->ResetTextures();
    });
}

void projectm_get_version_components(int* major, int* minor, int* patch)
{
    CApiGuard(__func__, [&] {
        if (major != nullptr)
        {
            *major = PROJECTM_VERSION_MAJOR;
        }
        if (minor != nullptr)
        {
            *minor = PROJECTM_VERSION_MINOR;
        }
        if (patch != nullptr)
        {
            *patch = PROJECTM_VERSION_PATCH;
        }
    });
}

char* projectm_get_version_string()
{
    return CApiGuard(__func__, nullptr, [&]() -> char* {
        auto versionLength = strlen(PROJECTM_VERSION_STRING);
        auto buffer = projectm_alloc_string(static_cast<uint32_t>(versionLength + 1));
        if (buffer != nullptr)
        {
            strncpy(buffer, PROJECTM_VERSION_STRING, versionLength + 1);
        }
        return buffer;
    });
}

char* projectm_get_vcs_version_string()
{
    return CApiGuard(__func__, nullptr, [&]() -> char* {
        auto versionLength = strlen(PROJECTM_VERSION_VCS);
        auto buffer = projectm_alloc_string(static_cast<uint32_t>(versionLength + 1));
        if (buffer != nullptr)
        {
            strncpy(buffer, PROJECTM_VERSION_VCS, versionLength + 1);
        }
        return buffer;
    });
}

void projectm_opengl_render_frame(projectm_handle instance)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->RenderFrame();
    });
}

void projectm_opengl_render_frame_fbo(projectm_handle instance, uint32_t framebuffer_object_id)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->RenderFrame(framebuffer_object_id);
    });
}

void projectm_perf_set_enabled(bool enabled)
{
    CApiGuard(__func__, [&] {
        libprojectM::Perf::SetEnabled(enabled);
    });
}

bool projectm_perf_is_enabled()
{
    return CApiGuard(__func__, false, [&]() -> bool {
        return libprojectM::Perf::IsEnabled();
    });
}

namespace {

void FillFrameTimings(const libprojectM::Perf::FrameTimings& timings, projectm_perf_frame_timings* out_timings)
{
    out_timings->audio_analysis_ms = timings[libprojectM::Perf::Field::AudioAnalysis];
    out_timings->per_frame_eval_ms = timings[libprojectM::Perf::Field::PerFrameEval];
    out_timings->per_pixel_eval_ms = timings[libprojectM::Perf::Field::PerPixelEval];
    out_timings->blur_ms = timings[libprojectM::Perf::Field::Blur];
    out_timings->waveforms_shapes_ms = timings[libprojectM::Perf::Field::WaveformsShapes];
    out_timings->composite_ms = timings[libprojectM::Perf::Field::Composite];
    out_timings->total_ms = timings[libprojectM::Perf::Field::Total];
    out_timings->fps = timings.fps;
    out_timings->shader_link_pending = timings.shaderLinkPending ? 1 : 0;
    out_timings->per_pixel_eval_path = static_cast<int>(timings.perPixelPath);
    out_timings->rhythm_analysis_ms = timings[libprojectM::Perf::Field::RhythmAnalysis];
}

} // namespace

void projectm_perf_get_frame_timings(projectm_perf_frame_timings* out_timings)
{
    CApiGuard(__func__, [&] {
        Required(out_timings, "out_timings");
        FillFrameTimings(libprojectM::Perf::GetLastFrame(), out_timings);
    });
}

void projectm_perf_get_instance_frame_timings(projectm_handle instance, projectm_perf_frame_timings* out_timings)
{
    CApiGuard(__func__, [&] {
        auto& engine = Instance(instance).GetEngineContext();
        Required(out_timings, "out_timings");
        FillFrameTimings(libprojectM::Perf::GetLastFrame(engine.PerfState()), out_timings);
    });
}

// The C and C++ enums are two spellings of one list; this is what keeps them in step.
static_assert(static_cast<int>(libprojectM::Perf::GpuStage::Count) == PROJECTM_PERF_GPU_STAGE_COUNT,
              "projectm_perf_gpu_stage and libprojectM::Perf::GpuStage are out of sync");
static_assert(static_cast<int>(libprojectM::Perf::GpuStage::Present) == PROJECTM_PERF_GPU_STAGE_PRESENT,
              "projectm_perf_gpu_stage and libprojectM::Perf::GpuStage are out of sync");

namespace {

auto WrapGpuStageCallback(projectm_perf_gpu_stage_callback callback, void* userData) -> libprojectM::Perf::GpuStageCallback
{
    if (callback == nullptr)
    {
        return {};
    }
    return [callback, userData](libprojectM::Perf::GpuStage stage) {
        callback(static_cast<projectm_perf_gpu_stage>(stage), userData);
    };
}

} // namespace

void projectm_perf_set_gpu_stage_callback(projectm_perf_gpu_stage_callback callback, void* user_data)
{
    CApiGuard(__func__, [&] {
        libprojectM::Perf::SetGpuStageCallback(libprojectM::Perf::ProcessState(), WrapGpuStageCallback(callback, user_data));
    });
}

void projectm_perf_set_instance_gpu_stage_callback(projectm_handle instance, projectm_perf_gpu_stage_callback callback, void* user_data)
{
    CApiGuard(__func__, [&] {
        auto& engine = Instance(instance).GetEngineContext();
        libprojectM::Perf::SetGpuStageCallback(engine.PerfState(), WrapGpuStageCallback(callback, user_data));
    });
}

projectm_perf_gpu_stage projectm_perf_enter_gpu_stage(projectm_perf_gpu_stage stage)
{
    return CApiGuard(__func__, PROJECTM_PERF_GPU_STAGE_OTHER, [&]() -> projectm_perf_gpu_stage {
        const int index = static_cast<int>(stage);
        if (index < 0 || index >= PROJECTM_PERF_GPU_STAGE_COUNT)
        {
            return static_cast<projectm_perf_gpu_stage>(libprojectM::Perf::CurrentGpuStage());
        }
        return static_cast<projectm_perf_gpu_stage>(
            libprojectM::Perf::EnterGpuStage(static_cast<libprojectM::Perf::GpuStage>(index)));
    });
}

void projectm_perf_get_openmp_info(projectm_perf_openmp_info* out_info)
{
    CApiGuard(__func__, [&] {
        Required(out_info, "out_info");
#ifdef PRJM_ENABLE_OPENMP
        out_info->compiled_enabled = true;
        out_info->max_threads = omp_get_max_threads();
#else
        out_info->compiled_enabled = false;
        out_info->max_threads = 1;
#endif
    });
}

int projectm_perf_openmp_thread_count_in_parallel()
{
    return CApiGuard(__func__, 0, [&]() -> int {
#ifdef PRJM_ENABLE_OPENMP
        return omp_get_num_threads();
#else
        return 1;
#endif
    });
}

void projectm_opengl_burn_texture(projectm_handle instance, uint32_t texture, int left, int top, int width, int height)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->BurnInTexture(texture, left, top, width, height);
    });
}

void projectm_set_deterministic_seed(uint32_t seed)
{
    CApiGuard(__func__, [&] {
        libprojectM::RandomSeed::SetDeterministicSeed(seed);
    });
}

void projectm_clear_deterministic_seed()
{
    CApiGuard(__func__, [&] {
        libprojectM::RandomSeed::ClearDeterministicSeed();
    });
}

bool projectm_is_deterministic_seed_set()
{
    return CApiGuard(__func__, false, [&]() -> bool {
        return libprojectM::RandomSeed::IsDeterministic();
    });
}

void projectm_set_seed(projectm_handle instance, uint32_t seed)
{
    CApiGuard(__func__, [&] {
        Instance(instance).SetSeed(seed);
    });
}

void projectm_clear_seed(projectm_handle instance)
{
    CApiGuard(__func__, [&] {
        Instance(instance).SetSeed(std::nullopt);
    });
}

void projectm_set_frame_time(projectm_handle instance, double seconds_since_first_frame)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetFrameTime(seconds_since_first_frame);
    });
}

double projectm_get_last_frame_time(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0, [&]() -> double {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->GetFrameTime();
    });
}

void projectm_set_beat_sensitivity(projectm_handle instance, float sensitivity)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetBeatSensitivity(sensitivity);
    });
}

float projectm_get_beat_sensitivity(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0f, [&]() -> float {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->GetBeatSensitivity();
    });
}

double projectm_get_hard_cut_duration(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0, [&]() -> double {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->HardCutDuration();
    });
}

void projectm_set_hard_cut_duration(projectm_handle instance, double seconds)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetHardCutDuration(seconds);
    });
}

bool projectm_get_hard_cut_enabled(projectm_handle instance)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->HardCutEnabled();
    });
}

void projectm_set_hard_cut_enabled(projectm_handle instance, bool enabled)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetHardCutEnabled(enabled);
    });
}

float projectm_get_hard_cut_sensitivity(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0f, [&]() -> float {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->HardCutSensitivity();
    });
}

void projectm_set_hard_cut_sensitivity(projectm_handle instance, float sensitivity)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetHardCutSensitivity(sensitivity);
    });
}

double projectm_get_soft_cut_duration(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0, [&]() -> double {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->SoftCutDuration();
    });
}

void projectm_set_soft_cut_duration(projectm_handle instance, double seconds)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetSoftCutDuration(seconds);
    });
}

double projectm_get_preset_duration(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0, [&]() -> double {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->PresetDuration();
    });
}

void projectm_set_preset_duration(projectm_handle instance, double seconds)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetPresetDuration(seconds);
    });
}

void projectm_get_rhythm_info(projectm_handle instance, projectm_rhythm_info* out_info)
{
    CApiGuard(__func__, [&] {
        if (out_info == nullptr)
        {
            return;
        }
        auto* projectMInstance = &Instance(instance);
        const auto& rhythm = projectMInstance->RhythmInfo();
        out_info->bpm = rhythm.bpm;
        out_info->beat_phase = rhythm.beatPhase;
        out_info->bar_phase = rhythm.barPhase;
        out_info->confidence = rhythm.confidence;
        out_info->beat_index = rhythm.beatIndex;
        out_info->section = rhythm.section;
        out_info->section_changed = rhythm.sectionChanged ? 1 : 0;
        out_info->beat = rhythm.beat ? 1 : 0;
        out_info->bar = rhythm.bar ? 1 : 0;
        out_info->beat_pulse = rhythm.beatPulse;
        out_info->onset = rhythm.onset;
    });
}

void projectm_set_rhythm_hint(projectm_handle instance, float bpm)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetRhythmHint(bpm);
    });
}

float projectm_get_rhythm_hint(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0f, [&]() -> float {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->RhythmHint();
    });
}

void projectm_set_preset_switch_policy(projectm_handle instance, projectm_preset_switch_policy policy, uint32_t bars)
{
    CApiGuard(__func__, [&] {
        using Policy = libprojectM::ProjectM::PresetSwitchPolicy;
        auto* projectMInstance = &Instance(instance);
        Policy value{Policy::Timer};
        switch (policy)
        {
            case PROJECTM_PRESET_SWITCH_BARS:
                value = Policy::Bars;
                break;
            case PROJECTM_PRESET_SWITCH_SECTION:
                value = Policy::Section;
                break;
            case PROJECTM_PRESET_SWITCH_TIMER:
            default:
                break;
        }
        projectMInstance->SetPresetSwitchPolicy(value, bars);
    });
}

projectm_preset_switch_policy projectm_get_preset_switch_policy(projectm_handle instance, uint32_t* out_bars)
{
    return CApiGuard(__func__, PROJECTM_PRESET_SWITCH_TIMER, [&]() -> projectm_preset_switch_policy {
        auto* projectMInstance = &Instance(instance);
        if (out_bars != nullptr)
        {
            *out_bars = projectMInstance->PresetSwitchBars();
        }
        return static_cast<projectm_preset_switch_policy>(projectMInstance->GetPresetSwitchPolicy());
    });
}

void projectm_set_soft_cut_duration_beats(projectm_handle instance, double beats)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetSoftCutDurationBeats(beats);
    });
}

double projectm_get_soft_cut_duration_beats(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0, [&]() -> double {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->SoftCutDurationBeats();
    });
}

void projectm_set_hard_cut_on_beat(projectm_handle instance, bool enabled)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetHardCutOnBeat(enabled);
    });
}

bool projectm_get_hard_cut_on_beat(projectm_handle instance)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->HardCutOnBeat();
    });
}

// The C and C++ enums are two spellings of one list.
static_assert(static_cast<int>(libprojectM::ProjectM::PresetSwitchPolicy::Bars) == PROJECTM_PRESET_SWITCH_BARS,
              "projectm_preset_switch_policy and ProjectM::PresetSwitchPolicy are out of sync");
static_assert(static_cast<int>(libprojectM::ProjectM::PresetSwitchPolicy::Section) == PROJECTM_PRESET_SWITCH_SECTION,
              "projectm_preset_switch_policy and ProjectM::PresetSwitchPolicy are out of sync");

void projectm_get_mesh_size(projectm_handle instance, size_t* width, size_t* height)
{
    CApiGuard(__func__, [&] {
        uint32_t w, h;
        auto* projectMInstance = &Instance(instance);
        projectMInstance->MeshSize(w, h);
        if (width != nullptr)
        {
            *width = static_cast<size_t>(w);
        }
        if (height != nullptr)
        {
            *height = static_cast<size_t>(h);
        }
    });
}

void projectm_set_texel_offset(projectm_handle instance, float offset_X, float offset_y)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetTexelOffsets(offset_X, offset_y);
    });
}

void projectm_get_texel_offset(projectm_handle instance, float* offset_X, float* offset_y)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        float x{};
        float y{};
        projectMInstance->TexelOffsets(x, y);
        if (offset_X != nullptr)
        {
            *offset_X = x;
        }
        if (offset_y != nullptr)
        {
            *offset_y = y;
        }
    });
}

void projectm_set_mesh_size(projectm_handle instance, size_t width, size_t height)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetMeshSize(static_cast<uint32_t>(width), static_cast<uint32_t>(height));
    });
}

void projectm_set_max_blur_level(projectm_handle instance, int32_t max_level)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetMaxBlurLevel(max_level);
    });
}

int32_t projectm_get_max_blur_level(projectm_handle instance)
{
    return CApiGuard(__func__, 0, [&]() -> int32_t {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->MaxBlurLevel();
    });
}

void projectm_set_blur_resolution_scale(projectm_handle instance, float scale)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetBlurResolutionScale(scale);
    });
}

float projectm_get_blur_resolution_scale(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0f, [&]() -> float {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->BlurResolutionScale();
    });
}

int32_t projectm_get_fps(projectm_handle instance)
{
    return CApiGuard(__func__, 0, [&]() -> int32_t {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->TargetFramesPerSecond();
    });
}

void projectm_set_fps(projectm_handle instance, int32_t fps)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetTargetFramesPerSecond(fps);
    });
}

void projectm_set_aspect_correction(projectm_handle instance, bool enabled)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetAspectCorrection(enabled);
    });
}

bool projectm_get_aspect_correction(projectm_handle instance)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->AspectCorrection();
    });
}

void projectm_set_easter_egg(projectm_handle instance, float value)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetEasterEgg(value);
    });
}

float projectm_get_easter_egg(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0f, [&]() -> float {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->EasterEgg();
    });
}

void projectm_touch(projectm_handle instance, float x, float y, int pressure, projectm_touch_type touch_type)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->Touch(x, y, pressure, touch_type);
    });
}

void projectm_touch_drag(projectm_handle instance, float x, float y, int pressure)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->TouchDrag(x, y, pressure);
    });
}

void projectm_touch_destroy(projectm_handle instance, float x, float y)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->TouchDestroy(x, y);
    });
}

void projectm_touch_destroy_all(projectm_handle instance)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->TouchDestroyAll();
    });
}

bool projectm_get_preset_locked(projectm_handle instance)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->PresetLocked();
    });
}

void projectm_set_preset_locked(projectm_handle instance, bool lock)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetPresetLocked(lock);
    });
}

void projectm_get_window_size(projectm_handle instance, size_t* width, size_t* height)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        if (width != nullptr)
        {
            *width = static_cast<size_t>(projectMInstance->WindowWidth());
        }
        if (height != nullptr)
        {
            *height = static_cast<size_t>(projectMInstance->WindowHeight());
        }
    });
}

void projectm_set_window_size(projectm_handle instance, size_t width, size_t height)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetWindowSize(static_cast<uint32_t>(width), static_cast<uint32_t>(height));
    });
}

void projectm_set_preset_start_clean(projectm_handle instance, bool enabled)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetPresetStartClean(enabled);
    });
}

bool projectm_get_preset_start_clean(projectm_handle instance)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->PresetStartClean();
    });
}

void projectm_set_transparency_mode(projectm_handle instance, bool enabled)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetTransparencyMode(enabled);
    });
}

bool projectm_get_transparency_mode(projectm_handle instance)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->TransparencyMode();
    });
}

void projectm_set_transparency_threshold(projectm_handle instance, float threshold)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetTransparencyThreshold(threshold);
    });
}

float projectm_get_transparency_threshold(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0f, [&]() -> float {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->TransparencyThreshold();
    });
}

void projectm_set_flash_limit_enabled(projectm_handle instance, bool enabled)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetFlashLimitEnabled(enabled);
    });
}

bool projectm_get_flash_limit_enabled(projectm_handle instance)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->FlashLimitEnabled();
    });
}

void projectm_set_flash_limit_threshold(projectm_handle instance, float threshold)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);
        projectMInstance->SetFlashLimitThreshold(threshold);
    });
}

float projectm_get_flash_limit_threshold(projectm_handle instance)
{
    return CApiGuard(__func__, 0.0f, [&]() -> float {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->FlashLimitThreshold();
    });
}

uint32_t projectm_get_flash_limit_clamped_frames(projectm_handle instance)
{
    return CApiGuard(__func__, 0, [&]() -> uint32_t {
        auto* projectMInstance = &Instance(instance);
        return projectMInstance->FlashLimitClampedFrames();
    });
}

unsigned int projectm_pcm_get_max_samples()
{
    return CApiGuard(__func__, 0, [&]() -> unsigned int {
        return libprojectM::Audio::AudioBufferSamples;
    });
}

template<class BufferType>
static auto PcmAdd(projectm_handle instance, const BufferType* samples, unsigned int count, projectm_channels channels) -> void
{
    if (count > 0)
    {
        Required(samples, "samples");
    }
    Instance(instance).PCM().Add(samples, channels, count);
}

auto projectm_pcm_add_float(projectm_handle instance, const float* samples, unsigned int count, projectm_channels channels) -> void
{
    CApiGuard(__func__, [&] {
        PcmAdd(instance, samples, count, channels);
    });
}

auto projectm_pcm_add_int16(projectm_handle instance, const int16_t* samples, unsigned int count, projectm_channels channels) -> void
{
    CApiGuard(__func__, [&] {
        PcmAdd(instance, samples, count, channels);
    });
}

auto projectm_pcm_add_uint8(projectm_handle instance, const uint8_t* samples, unsigned int count, projectm_channels channels) -> void
{
    CApiGuard(__func__, [&] {
        PcmAdd(instance, samples, count, channels);
    });
}

bool projectm_render_offline_frame(projectm_handle instance, const float* samples, unsigned int sample_count, double frame_time, uint32_t framebuffer_object)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        return Instance(instance).RenderOfflineFrame(samples, sample_count, frame_time, framebuffer_object);
    });
}

auto projectm_write_debug_image_on_next_frame(projectm_handle, const char*) -> void
{
    CApiGuard(__func__, [&] {
        // UNIMPLEMENTED
    });
}

uint32_t projectm_sprite_create(projectm_handle instance, const char* type, const char* code)
{
    return CApiGuard(__func__, 0, [&]() -> uint32_t {
        auto* projectMInstance = &Instance(instance);

        return projectMInstance->AddUserSprite(Required(type, "type"), Required(code, "code"));
    });
}

void projectm_sprite_destroy(projectm_handle instance, uint32_t sprite_id)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);

        projectMInstance->DestroyUserSprite(sprite_id);
    });
}

void projectm_sprite_destroy_all(projectm_handle instance)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);

        projectMInstance->DestroyAllUserSprites();
    });
}

uint32_t projectm_sprite_get_sprite_count(projectm_handle instance)
{
    return CApiGuard(__func__, 0, [&]() -> uint32_t {
        auto* projectMInstance = &Instance(instance);

        return projectMInstance->UserSpriteCount();
    });
}

void projectm_sprite_get_sprite_ids(projectm_handle instance, uint32_t* sprite_ids)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);

        auto spriteIdList = projectMInstance->UserSpriteIdentifiers();
        if (!spriteIdList.empty())
        {
            Required(sprite_ids, "sprite_ids");
        }
        for (const auto& spriteId : spriteIdList)
        {
            *sprite_ids = spriteId;
            sprite_ids++;
        }
    });
}

void projectm_sprite_set_max_sprites(projectm_handle instance, uint32_t max_sprites)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);

        projectMInstance->SetUserSpriteLimit(max_sprites);
    });
}

uint32_t projectm_sprite_get_max_sprites(projectm_handle instance)
{
    return CApiGuard(__func__, 0, [&]() -> uint32_t {
        auto* projectMInstance = &Instance(instance);

        return projectMInstance->UserSpriteLimit();
    });
}

double projectm_sprite_get_var(projectm_handle instance, uint32_t sprite_id, const char* var_name)
{
    return CApiGuard(__func__, 0.0, [&]() -> double {
        auto* projectMInstance = &Instance(instance);

        return projectMInstance->UserSpriteGetVariableValue(sprite_id, Required(var_name, "var_name"));
    });
}

void projectm_sprite_set_var(projectm_handle instance, uint32_t sprite_id, const char* var_name, double value)
{
    CApiGuard(__func__, [&] {
        auto* projectMInstance = &Instance(instance);

        projectMInstance->UserSpriteSetVariableValue(sprite_id, Required(var_name, "var_name"), value);
    });
}

bool projectm_reload_texture(projectm_handle instance, const char* texture_name)
{
    return CApiGuard(__func__, false, [&]() -> bool {
        if (texture_name == nullptr)
        {
            return false;
        }

        auto* projectMInstance = &Instance(instance);

        return projectMInstance->ReloadTexture(texture_name);
    });
}

void projectm_set_log_callback(projectm_log_callback callback, bool current_thread_only, void* user_data)
{
    CApiGuard(__func__, [&] {
        if (current_thread_only)
        {
            libprojectM::Logging::SetThreadCallback({callback, user_data});
        }
        else
        {
            libprojectM::Logging::SetGlobalCallback({callback, user_data});
        }
    });
}

void projectm_set_instance_log_callback(projectm_handle instance, projectm_log_callback callback, void* user_data)
{
    CApiGuard(__func__, [&] {
        Instance(instance).GetEngineContext().SetLogCallback({callback, user_data});
    });
}

void projectm_set_instance_log_level(projectm_handle instance, projectm_log_level log_level)
{
    CApiGuard(__func__, [&] {
        Instance(instance).GetEngineContext().SetLogLevel(static_cast<libprojectM::Logging::LogLevel>(log_level));
    });
}

void projectm_set_log_level(projectm_log_level log_level, bool current_thread_only)
{
    CApiGuard(__func__, [&] {
        if (current_thread_only)
        {
            libprojectM::Logging::SetThreadLogLevel(static_cast<libprojectM::Logging::LogLevel>(log_level));
        }
        else
        {
            libprojectM::Logging::SetGlobalLogLevel(static_cast<libprojectM::Logging::LogLevel>(log_level));
        }
    });
}