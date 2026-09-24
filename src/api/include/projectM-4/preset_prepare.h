/**
 * @file preset_prepare.h
 * @copyright 2003-2025 projectM Team
 * @brief Loading a preset in steps, with the CPU-heavy part off the render thread.
 * @since 4.2.0
 *
 * projectm_load_preset_file() reads and parses the preset, transpiles its HLSL shaders to GLSL and
 * compiles them, all on the calling (render) thread, so the visualizer stops for however long that
 * takes. These functions split the load at the OpenGL boundary:
 *
 * 1. projectm_preset_prepare_begin_file() or projectm_preset_prepare_begin_data(), on the render
 *    thread, captures the state preparation needs and returns a job.
 * 2. projectm_preset_prepare_run(), on any thread, does the file I/O, parsing and shader
 *    transpiling. It touches neither OpenGL nor the projectM instance.
 * 3. projectm_load_prepared_preset(), on the render thread, creates and initializes the preset and
 *    starts the transition exactly as projectm_load_preset_file() would, or raises the preset
 *    switch failed event. With KHR_parallel_shader_compile the switch itself waits until the
 *    driver has linked the new shaders (see projectm_poll_pending_preset()).
 *
 * The current preset keeps rendering between steps 1 and 3. A job may be freed at any point with
 * projectm_preset_prepare_free() instead of being loaded, but not while step 2 is running on it.
 *
 * This is a fork extension (see docs/UPSTREAM_SYNC.md).
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

struct projectm_preset_prepare_job;
typedef struct projectm_preset_prepare_job* projectm_preset_prepare_job_handle; //!< A preset load in progress.

/**
 * @brief Starts loading a preset file or URL in steps.
 *
 * Render thread only. Accepts the same filenames and URLs as projectm_load_preset_file().
 *
 * @param instance The projectM instance handle.
 * @param filename The preset filename or URL to load.
 * @return The job. Pass it to projectm_load_prepared_preset() or projectm_preset_prepare_free().
 * @since 4.2.0
 */
PROJECTM_EXPORT projectm_preset_prepare_job_handle projectm_preset_prepare_begin_file(projectm_handle instance,
                                                                                      const char* filename);

/**
 * @brief Starts loading a preset file in steps, with its contents already read by the caller.
 *
 * Render thread only. projectm_preset_prepare_run() then parses @a data instead of opening the file;
 * the filename, preset name and any error message are as for projectm_preset_prepare_begin_file().
 * For hosts where file access from the preparing thread is expensive: under Emscripten pthreads,
 * every file system call from a worker thread waits for the main thread's current frame to end.
 * The data is copied.
 *
 * @param instance The projectM instance handle.
 * @param filename The preset filename (a plain path, not a URL).
 * @param data The file's contents.
 * @param length The length of @a data in bytes.
 * @return The job. Pass it to projectm_load_prepared_preset() or projectm_preset_prepare_free().
 * @since 4.2.0
 */
PROJECTM_EXPORT projectm_preset_prepare_job_handle projectm_preset_prepare_begin_file_contents(projectm_handle instance,
                                                                                               const char* filename,
                                                                                               const char* data,
                                                                                               size_t length);

/**
 * @brief Starts loading preset data (Milkdrop format) in steps.
 *
 * Render thread only. The data is copied.
 *
 * @param instance The projectM instance handle.
 * @param data The preset contents.
 * @return The job. Pass it to projectm_load_prepared_preset() or projectm_preset_prepare_free().
 * @since 4.2.0
 */
PROJECTM_EXPORT projectm_preset_prepare_job_handle projectm_preset_prepare_begin_data(projectm_handle instance,
                                                                                      const char* data);

/**
 * @brief Reads, parses and prepares the preset, including transpiling its shaders.
 *
 * May be called from any thread, concurrently with rendering. Does nothing if the job has already
 * run. Errors are recorded in the job and reported when it is loaded.
 *
 * @param job The job.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_preset_prepare_run(projectm_preset_prepare_job_handle job);

/**
 * @brief Returns whether projectm_preset_prepare_run() failed for this job.
 *
 * Loading a failed job raises the preset switch failed event and leaves the current preset.
 *
 * @param job The job.
 * @return True if the job ran and failed, false otherwise.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_preset_prepare_failed(projectm_preset_prepare_job_handle job);

/**
 * @brief Finishes a preset load: switches to the prepared preset or reports its failure.
 *
 * Render thread only. Runs the job first if nobody has. Takes ownership of the job, which must not
 * be used afterwards. Otherwise behaves like projectm_load_preset_file().
 *
 * @param instance The projectM instance handle. Need not be the instance that began the job.
 * @param job The job.
 * @param smooth_transition If true, the new preset is smoothly blended over.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_load_prepared_preset(projectm_handle instance,
                                                   projectm_preset_prepare_job_handle job,
                                                   bool smooth_transition);

/**
 * @brief Completes a preset switch that is waiting for its shader programs to link, if they have.
 *
 * Where the OpenGL context supports KHR_parallel_shader_compile, projectm_load_prepared_preset()
 * starts the new preset's shader links without waiting for them: the current preset keeps
 * rendering and the switch happens once the driver reports them complete. Rendering a frame does
 * this check; call this on the render thread to make progress without rendering one.
 *
 * @param instance The projectM instance handle.
 * @return True if a preset switch is still waiting afterwards.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_poll_pending_preset(projectm_handle instance);

/**
 * @brief Enables or disables background shader linking for projectm_load_prepared_preset().
 *
 * Enabled by default. Has no effect where the OpenGL context lacks KHR_parallel_shader_compile;
 * disabled, projectm_load_prepared_preset() waits for the links as projectm_load_preset_file() does.
 *
 * @param instance The projectM instance handle.
 * @param enabled Whether to link prepared presets' shaders in the background.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_set_parallel_shader_compile(projectm_handle instance, bool enabled);

/**
 * @brief Returns whether prepared presets' shaders are linked in the background.
 *
 * @param instance The projectM instance handle.
 * @return True if enabled and supported by the OpenGL context.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_get_parallel_shader_compile(projectm_handle instance);

/**
 * @brief Frees a job without loading it.
 *
 * Any thread, but not while projectm_preset_prepare_run() is running on the job. A job stays valid
 * after the instance that began it is destroyed, so it can always be freed.
 *
 * @param job The job. May be NULL.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_preset_prepare_free(projectm_preset_prepare_job_handle job);

#ifdef __cplusplus
} // extern "C"
#endif
