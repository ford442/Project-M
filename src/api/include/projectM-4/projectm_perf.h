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
    /**
     * Non-zero if a preset switch was waiting for its shader programs to link
     * (KHR_parallel_shader_compile) while this frame rendered the previous preset.
     * Fork extension; appended so existing field offsets are unchanged.
     */
    int shader_link_pending;
    /**
     * How the per-pixel equations were evaluated: 0 = CPU (the projectM-EvalLib loop
     * over every warp mesh vertex), 1 = GPU (compiled into the warp vertex shader).
     *
     * per_pixel_eval_ms means different things in the two cases -- on the GPU path it
     * is only the draw submission -- so a measurement is only comparable against
     * another with the same value here.
     */
    int per_pixel_eval_path;
    /**
     * PCM::UpdateRhythmAnalysis() - onset detection, tempo, beat phase and sections (the
     * pm_* preset variables). Not included in audio_analysis_ms.
     * Fork extension; appended so existing field offsets are unchanged.
     */
    double rhythm_analysis_ms;
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

/**
 * @brief GPU stage the GL commands issued from now on belong to.
 *
 * The CPU timings above measure how long each stage took to *submit*. GL is
 * asynchronous, so the GPU cost of a fullscreen pass lands wherever the driver
 * executes it. To time stages on the GPU, a host installs a callback with
 * projectm_perf_set_gpu_stage_callback(): libprojectM reports every change of
 * stage while rendering, and the host ends its current timer query
 * (GL_TIME_ELAPSED / EXT_disjoint_timer_query) and begins the next.
 *
 * The stages tile a frame -- every GL command is in exactly one -- so their sum
 * is the whole-frame GPU time. A frame starts in PROJECTM_PERF_GPU_STAGE_OTHER.
 * Fork extension.
 *
 * @since 4.2.0
 */
typedef enum {
    /** Anything not attributed below: clears, user sprites, state changes. */
    PROJECTM_PERF_GPU_STAGE_OTHER = 0,
    /** Motion vectors and the per-pixel warp mesh draw. */
    PROJECTM_PERF_GPU_STAGE_WARP = 1,
    /** Blur texture chain update. */
    PROJECTM_PERF_GPU_STAGE_BLUR = 2,
    /** Custom shapes, custom waveforms, built-in waveform, darken center, border. */
    PROJECTM_PERF_GPU_STAGE_SHAPES = 3,
    /** Y-flip copy passes inside the Milkdrop preset's frame. */
    PROJECTM_PERF_GPU_STAGE_COPY = 4,
    /** The final composite shader pass. */
    PROJECTM_PERF_GPU_STAGE_COMPOSITE = 5,
    /** Output to the target framebuffer (blit, copy, transition) and a host's own compositor. */
    PROJECTM_PERF_GPU_STAGE_PRESENT = 6,
    /** Number of stages; not a stage. */
    PROJECTM_PERF_GPU_STAGE_COUNT = 7
} projectm_perf_gpu_stage;

/**
 * @brief Receives every GPU stage change. Called on the rendering thread, with
 *        the GL context current, from inside the render call.
 * @since 4.2.0
 */
typedef void (*projectm_perf_gpu_stage_callback)(projectm_perf_gpu_stage stage, void* user_data);

/**
 * @brief Installs the GPU stage callback, or removes it when @p callback is NULL.
 *
 * Process-global, like the rest of this header. Stage changes are only reported
 * while perf timers are enabled (projectm_perf_set_enabled()), so an installed
 * callback costs nothing otherwise.
 *
 * @param callback Called on every stage change, or NULL to remove.
 * @param user_data Passed back to @p callback unchanged.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_perf_set_gpu_stage_callback(projectm_perf_gpu_stage_callback callback, void* user_data);

/**
 * @brief Attributes the GL commands that follow to @p stage, for GL work the host
 *        issues itself (e.g. its own compositor pass).
 *
 * Reports the change to the installed callback like any internal one, and
 * returns the previous stage so the host can restore it afterwards.
 *
 * @param stage The stage to enter.
 * @return The stage that was current before the call.
 * @since 4.2.0
 */
PROJECTM_EXPORT projectm_perf_gpu_stage projectm_perf_enter_gpu_stage(projectm_perf_gpu_stage stage);

/**
 * @brief OpenMP build/runtime information for profiling and benchmark reports.
 *
 * @param out_info Pointer to a struct that will receive OpenMP status. Must not be NULL.
 * @since 4.2.0
 */
typedef struct {
    /** true when built with PRJM_ENABLE_OPENMP (pragma regions are compiled in). */
    bool compiled_enabled;
    /** omp_get_max_threads() when compiled_enabled, otherwise 1. */
    int max_threads;
} projectm_perf_openmp_info;

/**
 * @brief Fills @p out_info with OpenMP compile-time and runtime thread-pool sizing.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_perf_get_openmp_info(projectm_perf_openmp_info* out_info);

/**
 * @brief Returns the number of threads executing a parallel region.
 *
 * When called from outside any parallel region this returns 1. Useful in
 * benchmarks to confirm OpenMP worker threads are actually spawned.
 *
 * @since 4.2.0
 */
PROJECTM_EXPORT int projectm_perf_openmp_thread_count_in_parallel();

#ifdef __cplusplus
} // extern "C"
#endif
