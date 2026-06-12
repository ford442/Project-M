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
    PerFrameEval,    //!< Per-frame equation evaluation (init/per-frame code).
    PerPixelEval,    //!< Per-pixel mesh evaluation and warp draw.
    Blur,            //!< Blur texture chain update.
    WaveformsShapes, //!< Custom shapes, custom waveforms, built-in waveform, darken center, border.
    Composite,       //!< Final compositing pass (and associated flips).
    Total,           //!< Whole RenderFrame() call.
    Count
};

/**
 * @brief One frame's worth of CPU timings plus the derived FPS.
 */
struct FrameTimings
{
    std::array<double, static_cast<std::size_t>(Field::Count)> values{};
    double fps{0.0};

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

/// Adds `ms` milliseconds to the given bucket for the current frame.
inline void Add(Field field, double ms)
{
    if (!detail::g_enabled)
    {
        return;
    }
    detail::g_current.values[static_cast<std::size_t>(field)] += ms;
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
 * @brief RAII helper that adds the elapsed wall-clock time to a Field when destroyed.
 *
 * No-op (does not even call the clock) when perf timers are disabled.
 */
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
