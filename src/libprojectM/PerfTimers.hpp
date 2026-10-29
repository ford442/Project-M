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
#include <atomic>
#include <chrono>
#include <cstddef>
#include <functional>
#include <mutex>

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
using GpuStageCallback = std::function<void(GpuStage stage)>;

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

/**
 * @brief One engine's perf timer state. Each EngineContext owns one.
 *
 * Frame timings and the current GPU stage belong to the engine that is rendering
 * (EngineContext::Current()). The process default context's state holds what the
 * handle-less C API sets: whether timers are on, the GPU stage callback engines use
 * when they have none of their own, and the timings of the last frame any engine
 * finished.
 */
struct State
{
    std::atomic<bool> enabled{false}; //!< Only read from the process state.
    FrameTimings current{};
    std::chrono::steady_clock::time_point frameStart{};
    GpuStage gpuStage{GpuStage::Other};
    GpuStageCallback gpuStageCallback; //!< Empty: use the process state's.

    mutable std::mutex lastMutex;
    FrameTimings last{};
};

/// The perf state of the engine rendering on this thread (EngineContext::Current()).
auto CurrentState() -> State&;

/// The process default context's perf state (the handle-less C API).
auto ProcessState() -> State&;

namespace detail {

inline auto StageCallback(State& state) -> const GpuStageCallback&
{
    return state.gpuStageCallback ? state.gpuStageCallback : ProcessState().gpuStageCallback;
}

} // namespace detail

/**
 * @brief Enables or disables perf timer collection, for every engine.
 *
 * When disabled, BeginFrame()/EndFrame()/Add() and ScopedTimer are all no-ops,
 * so there is no measurable overhead in release builds that don't enable the HUD
 * or benchmark mode.
 */
inline void SetEnabled(bool enabled)
{
    ProcessState().enabled.store(enabled, std::memory_order_relaxed);
}

inline bool IsEnabled()
{
    return ProcessState().enabled.load(std::memory_order_relaxed);
}

/// Call once at the start of ProjectM::RenderFrame().
inline void BeginFrame()
{
    if (!IsEnabled())
    {
        return;
    }
    auto& state = CurrentState();
    state.current = FrameTimings{};
    state.frameStart = std::chrono::steady_clock::now();
}

/// Records which path evaluated the per-pixel equations for the current frame.
inline void SetPerPixelPath(PerPixelPath path)
{
    if (!IsEnabled())
    {
        return;
    }
    CurrentState().current.perPixelPath = path;
}

/// Adds `ms` milliseconds to the given bucket for the current frame.
inline void Add(Field field, double ms)
{
    if (!IsEnabled())
    {
        return;
    }
    CurrentState().current.values[static_cast<std::size_t>(field)] += ms;
}

/// Records that a preset switch is waiting for its shader programs this frame.
inline void SetShaderLinkPending(bool pending)
{
    if (!IsEnabled())
    {
        return;
    }
    CurrentState().current.shaderLinkPending = pending;
}

/// Call once at the end of ProjectM::RenderFrame(). Finalizes Total/fps and
/// publishes the frame's timings for GetLastFrame(), for this engine and the process.
inline void EndFrame()
{
    if (!IsEnabled())
    {
        return;
    }
    auto& state = CurrentState();
    const auto now = std::chrono::steady_clock::now();
    const double totalMs = std::chrono::duration<double, std::milli>(now - state.frameStart).count();
    state.current.values[static_cast<std::size_t>(Field::Total)] = totalMs;
    state.current.fps = totalMs > 0.0 ? 1000.0 / totalMs : 0.0;
    {
        const std::lock_guard<std::mutex> lock(state.lastMutex);
        state.last = state.current;
    }
    auto& process = ProcessState();
    if (&process != &state)
    {
        const std::lock_guard<std::mutex> lock(process.lastMutex);
        process.last = state.current;
    }
}

/// Returns the timings of the last frame finished by the engine owning `state`
/// (for the process state: by any engine).
inline FrameTimings GetLastFrame(const State& state)
{
    const std::lock_guard<std::mutex> lock(state.lastMutex);
    return state.last;
}

/// Returns the timings of the last frame any engine finished.
inline FrameTimings GetLastFrame()
{
    return GetLastFrame(ProcessState());
}

/**
 * @brief Installs (or, with an empty callback, removes) a GPU stage change callback.
 *
 * On the process state it is the callback of every engine without its own. Resets
 * the state's current stage to GpuStage::Other, which is where a host's per-frame
 * timer starts. Stage changes are only reported while perf timers are enabled.
 */
inline void SetGpuStageCallback(State& state, GpuStageCallback callback)
{
    state.gpuStageCallback = std::move(callback);
    state.gpuStage = GpuStage::Other;
}

/// The stage GL commands issued now are attributed to.
inline GpuStage CurrentGpuStage()
{
    return CurrentState().gpuStage;
}

/**
 * @brief Attributes the GL commands that follow to `stage`.
 *
 * Calls the callback only on an actual change, so nested scopes for the same
 * stage cost nothing. Returns the stage that was current before.
 */
inline GpuStage EnterGpuStage(GpuStage stage)
{
    auto& state = CurrentState();
    const GpuStage previous = state.gpuStage;
    if (!IsEnabled() || stage == previous)
    {
        return previous;
    }
    const auto& callback = detail::StageCallback(state);
    if (!callback)
    {
        return previous;
    }
    state.gpuStage = stage;
    callback(stage);
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
        : m_active(IsEnabled() && static_cast<bool>(detail::StageCallback(CurrentState())))
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
        , m_active(IsEnabled())
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
