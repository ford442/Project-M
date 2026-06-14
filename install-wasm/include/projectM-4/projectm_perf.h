/**
 * @file projectm_perf.h
 * @copyright 2003-2026 projectM Team
 * @brief Optional CPU-side frame timing/profiling API.
 *
 * projectM -- Milkdrop-esque visualisation SDK
 * Copyright (C)2003-2024 projectM Team
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

#include "projectM-4/types.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief CPU-side timing breakdown for a single rendered frame, in milliseconds.
 *
 * All fields are 0 if perf timers are disabled (the default) or no frame has
 * been rendered yet since they were enabled. "total_ms" is the wall-clock
 * time of the whole RenderFrame() call and will generally be larger than the
 * sum of the other fields, since it also covers GL driver overhead and any
 * stages not individually timed.
 *
 * @since 4.2.0
 */
typedef struct {
    /** PCM::UpdateFrameAudioData() - FFT + loudness analysis. */
    double audio_analysis_ms;
    /** Per-frame equation evaluation (init/per-frame code). */
    double per_frame_eval_ms;
    /** Per-pixel mesh evaluation and warp draw. */
    double per_pixel_eval_ms;
    /** Blur texture chain update. */
    double blur_ms;
    /** Custom shapes, custom waveforms, built-in waveform, darken center, border. */
    double waveforms_shapes_ms;
    /** Final compositing pass (and associated flips). */
    double composite_ms;
    /** Whole RenderFrame() call. */
    double total_ms;
    /** 1000 / total_ms, or 0 if total_ms is 0. */
    double fps;
} projectm_perf_frame_timings;

/**
 * @brief Enables or disables CPU-side per-frame timing collection.
 *
 * When disabled (the default), timing instrumentation in the render path is a
 * no-op and has no measurable performance impact. This is process-global, not
 * tied to a specific projectM instance.
 *
 * @param enabled true to start collecting timings on every RenderFrame() call,
 *                 false to stop (timings from the last frame remain readable).
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_perf_set_enabled(bool enabled);

/**
 * @brief Returns true if perf timer collection is currently enabled.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_perf_is_enabled();

/**
 * @brief Retrieves the CPU timing breakdown for the most recently rendered frame.
 *
 * @param out_timings Pointer to a struct that will receive the timings. Must not be NULL.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_perf_get_frame_timings(projectm_perf_frame_timings* out_timings);

#ifdef __cplusplus
} // extern "C"
#endif
