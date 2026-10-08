/**
 * projectM -- Milkdrop-esque visualisation SDK
 * Copyright (C)2003-2007 projectM Team
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 * See 'LICENSE.txt' included within this release
 *
 */
#pragma once

#include <array>
#include <chrono>
#include <cstddef>

namespace libprojectM {
namespace Perf {

/**
 * @brief CPU-side per-frame timing buckets, in milliseconds.
 *
 * Each bucket covers a specific stage of ProjectM::RenderFrame() /
 * MilkdropPreset::RenderFrame(). "Total" is the wall-clock time of the
 * whole RenderFrame() call and will generally be larger than the sum of
 * the other buckets (driver overhead, GL state changes not individually
 * timed, etc.).
 */
enum class Field
{
    AudioAnalysis,   //!< PCM::UpdateFrameAudioData() - FFT + loudness analysis.
    RhythmAnalysis,  //!< PCM::UpdateRhythmAnalysis() - onsets, tempo, beat phase, sections.
    PerFrameEval,    //!< Per-frame equation evaluation (init/per-frame code).
    PerPixelEval,    //!< Per-pixel mesh evaluation and warp draw.
    Blur,            //!< Blur texture chain update.
    WaveformsShapes, //!< Custom shapes, custom waveforms, built-in waveform, darken center, border.
    Composite,       //!< Final compositing pass (and associated flips).
    Total,           //!< Whole RenderFrame() call.
    Count
};

/**
 * @brief Which path evaluated the per-pixel equations for a frame.
 *
 * Not a timing bucket: it says how the PerPixelEval milliseconds were spent, which is
 * what makes two measurements comparable. See docs/GPU_PERPIXEL_EVAL.md.
 */
enum class PerPixelPath
{
    Cpu = 0, //!< The projectM-EvalLib loop ran once per warp mesh vertex.
    Gpu = 1, //!< The equations were compiled into the warp vertex shader.
};

/**
 * @brief GPU-side stage a stretch of GL commands belongs to.
 *
 * Not a CPU bucket. The CPU fields above measure how long a stage took to
 * *submit*; GL is asynchronous, so fill-rate costs land wherever the driver
 * happens to execute them. These stages exist so a host with GPU timer queries
 * (the WASM build's EXT_disjoint_timer_query_webgl2) can time each one on the
 * GPU: libprojectM announces every stage change through the callback set with
 * SetGpuStageCallback(), and the host ends one timer query and begins the next.
 *
 * The stages tile the frame -- every GL command is in exactly one -- so their
 * sum is the whole-frame GPU time. Values match projectm_perf_gpu_stage in
 * projectm_perf.h; keep the two in order.
 */
enum class GpuStage
{
    Other = 0, //!< Anything not attributed below: clears, user sprites, state changes.
    Warp,      //!< Motion vectors + the per-pixel warp mesh draw.
    Blur,      //!< Blur texture chain update.
    Shapes,    //!< Custom shapes, custom waveforms, built-in waveform, darken center, border.
    Copy,      //!< Y-flip copies (CopyTexture passes) inside MilkdropPreset::RenderFrame().
    Composite, //!< The final composite shader pass.
    Present,   //!< Output to the target framebuffer: blit/copy/transition, and a host's own compositor.
    Count
};

/**
 * @brief Called whenever the GPU stage changes. See GpuStage.
 */
using GpuStageCallback = void (*)(GpuStage stage, void* userData);

/**
 * @brief One frame's worth of CPU timings plus the derived FPS.
 */
struct FrameTimings
{
    std::array<double, static_cast<std::size_t>(Field::Count)> values{};
    double fps{0.0};
    bool shaderLinkPending{false}; //!< A preset switch was waiting for its shader programs to link.
    PerPixelPath perPixelPath{PerPixelPath::Cpu};

    double operator[](Field field) const
    {
        return values[static_cast<std::size_t>(field)];
    }
};

namespace detail {

// NOTE: This state is intentionally global rather than per-ProjectM-instance.
// The Emscripten build only ever creates a single projectM handle, and a
// global avoids threading a timing context through MilkdropPreset, the
// transition system, and every Renderer:: helper that ProjectM::RenderFrame()
// touches. If this is ever embedded with multiple concurrent instances, this
// should become per-instance state.
inline bool g_enabled = false;
inline FrameTimings g_current{};
inline FrameTimings g_last{};
inline std::chrono::steady_clock::time_point g_frameStart{};
inline GpuStageCallback g_gpuStageCallback{nullptr};
inline void* g_gpuStageUserData{nullptr};
inline GpuStage g_gpuStage{GpuStage::Other};

} // namespace detail

/**
 * @brief Enables or disables perf timer collection.
 *
 * When disabled, BeginFrame()/EndFrame()/Add() and ScopedTimer are all no-ops,
 * so there is no measurable overhead in release builds that don't enable the HUD
 * or benchmark mode.
 */
inline void SetEnabled(bool enabled)
{
    detail::g_enabled = enabled;
}

inline bool IsEnabled()
{
    return detail::g_enabled;
}

/// Call once at the start of ProjectM::RenderFrame().
inline void BeginFrame()
{
    if (!detail::g_enabled)
    {
        return;
    }
    detail::g_current = FrameTimings{};
    detail::g_frameStart = std::chrono::steady_clock::now();
}

/// Records which path evaluated the per-pixel equations for the current frame.
inline void SetPerPixelPath(PerPixelPath path)
{
    if (!detail::g_enabled)
    {
        return;
    }
    detail::g_current.perPixelPath = path;
}

/// Adds `ms` milliseconds to the given bucket for the current frame.
inline void Add(Field field, double ms)
{
    if (!detail::g_enabled)
    {
        return;
    }
    detail::g_current.values[static_cast<std::size_t>(field)] += ms;
}

/// Records that a preset switch is waiting for its shader programs this frame.
inline void SetShaderLinkPending(bool pending)
{
    if (!detail::g_enabled)
    {
        return;
    }
    detail::g_current.shaderLinkPending = pending;
}

/// Call once at the end of ProjectM::RenderFrame(). Finalizes Total/fps and
/// publishes the frame's timings for GetLastFrame().
inline void EndFrame()
{
    if (!detail::g_enabled)
    {
        return;
    }
    const auto now = std::chrono::steady_clock::now();
    const double totalMs = std::chrono::duration<double, std::milli>(now - detail::g_frameStart).count();
    detail::g_current.values[static_cast<std::size_t>(Field::Total)] = totalMs;
    detail::g_current.fps = totalMs > 0.0 ? 1000.0 / totalMs : 0.0;
    detail::g_last = detail::g_current;
}

/// Returns the timings captured during the most recently completed frame.
inline FrameTimings GetLastFrame()
{
    return detail::g_last;
}

/**
 * @brief Installs (or, with nullptr, removes) the GPU stage change callback.
 *
 * Resets the current stage to GpuStage::Other, which is where a host's
 * per-frame timer starts. Stage changes are only reported while perf timers are
 * enabled.
 */
inline void SetGpuStageCallback(GpuStageCallback callback, void* userData)
{
    detail::g_gpuStageCallback = callback;
    detail::g_gpuStageUserData = userData;
    detail::g_gpuStage = GpuStage::Other;
}

/// The stage GL commands issued now are attributed to.
inline GpuStage CurrentGpuStage()
{
    return detail::g_gpuStage;
}

/**
 * @brief Attributes the GL commands that follow to `stage`.
 *
 * Calls the callback only on an actual change, so nested scopes for the same
 * stage cost nothing. Returns the stage that was current before.
 */
inline GpuStage EnterGpuStage(GpuStage stage)
{
    const GpuStage previous = detail::g_gpuStage;
    if (!detail::g_enabled || detail::g_gpuStageCallback == nullptr || stage == previous)
    {
        return previous;
    }
    detail::g_gpuStage = stage;
    detail::g_gpuStageCallback(stage, detail::g_gpuStageUserData);
    return previous;
}

/**
 * @brief RAII helper that attributes the GL commands in its scope to one GpuStage
 * and restores the previous stage on exit.
 *
 * No-op when perf timers are disabled or no host installed a callback.
 */
class GpuStageScope
{
public:
    explicit GpuStageScope(GpuStage stage)
        : m_active(detail::g_enabled && detail::g_gpuStageCallback != nullptr)
    {
        if (m_active)
        {
            m_previous = EnterGpuStage(stage);
        }
    }

    ~GpuStageScope()
    {
        if (m_active)
        {
            EnterGpuStage(m_previous);
        }
    }

    GpuStageScope(const GpuStageScope&) = delete;
    auto operator=(const GpuStageScope&) -> GpuStageScope& = delete;

private:
    bool m_active;
    GpuStage m_previous{GpuStage::Other};
};

/**
 * @brief RAII helper for the whole RenderFrame() call.
 *
 * Calls BeginFrame() on construction and EndFrame() on destruction, so the
 * "Total"/fps fields and GetLastFrame() snapshot are correctly updated even
 * if RenderFrame() returns early (e.g. zero-sized window, no preset loaded).
 */
class FrameGuard
{
public:
    FrameGuard()
    {
        BeginFrame();
    }

    ~FrameGuard()
    {
        EndFrame();
    }

    FrameGuard(const FrameGuard&) = delete;
    auto operator=(const FrameGuard&) -> FrameGuard& = delete;
};

/**
 * @brief RAII helper that adds the elapsed wall-clock time to a Field when destroyed.
 *
 * No-op (does not even call the clock) when perf timers are disabled.
 */
class ScopedTimer
{
public:
    explicit ScopedTimer(Field field)
        : m_field(field)
        , m_active(detail::g_enabled)
    {
        if (m_active)
        {
            m_start = std::chrono::steady_clock::now();
        }
    }

    ~ScopedTimer()
    {
        if (m_active)
        {
            const auto now = std::chrono::steady_clock::now();
            Add(m_field, std::chrono::duration<double, std::milli>(now - m_start).count());
        }
    }

    ScopedTimer(const ScopedTimer&) = delete;
    auto operator=(const ScopedTimer&) -> ScopedTimer& = delete;

private:
    Field m_field;
    bool m_active;
    std::chrono::steady_clock::time_point m_start;
};

} // namespace Perf
} // namespace libprojectM

#define PROJECTM_PERF_SCOPE_CONCAT_INNER(a, b) a##b
#define PROJECTM_PERF_SCOPE_CONCAT(a, b) PROJECTM_PERF_SCOPE_CONCAT_INNER(a, b)

/// Times the remainder of the enclosing scope into libprojectM::Perf::Field::field.
#define PROJECTM_PERF_SCOPE(field) \
    ::libprojectM::Perf::ScopedTimer PROJECTM_PERF_SCOPE_CONCAT(_projectm_perf_timer_, __LINE__)(::libprojectM::Perf::Field::field)

/// Attributes the GL commands in the rest of the enclosing scope to libprojectM::Perf::GpuStage::stage.
#define PROJECTM_PERF_GPU_STAGE(stage) \
    ::libprojectM::Perf::GpuStageScope PROJECTM_PERF_SCOPE_CONCAT(_projectm_perf_gpu_stage_, __LINE__)(::libprojectM::Perf::GpuStage::stage)
