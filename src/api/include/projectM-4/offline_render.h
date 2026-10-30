/**
 * @file offline_render.h
 * @copyright 2003-2026 projectM Team
 * @brief Rendering on a virtual clock, faster or slower than real time, deterministically.
 * @since 4.2.0
 *
 * An offline renderer (a video exporter, a golden-image test, a render farm) does not run in
 * real time: it decodes a file, hands each frame its share of the audio and renders as fast as
 * the GPU allows. projectm_render_offline_frame() does one such frame. Fork extension.
 *
 * What makes two offline runs identical:
 *  - the same seed (projectm_set_seed() before loading the first preset),
 *  - the same presets loaded at the same frames,
 *  - the same audio and frame times passed to each call,
 *  - the same GPU and driver (see projectm_set_deterministic_seed() for the caveats).
 *
 * The frame time replaces the wall clock everywhere: preset durations, soft cuts and the rhythm
 * analysis all advance by the difference between consecutive frame times. Shaders compile
 * synchronously (KHR_parallel_shader_compile is turned off), so a preset loaded before a frame
 * is drawn in that frame rather than a few frames later.
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
 * @brief Adds one frame's audio and renders that frame at a given time.
 *
 * Equivalent to projectm_pcm_add_float() with @a samples, then projectm_set_frame_time() with
 * @a frame_time, then projectm_opengl_render_frame_fbo() with @a framebuffer_object, with
 * parallel shader compilation turned off first. The OpenGL context the instance was created
 * with must be current.
 *
 * @param instance The projectM instance handle.
 * @param samples Interleaved stereo float samples for this frame (left, right, left, ...), or
 *                NULL for silence. Pass what the audio covers between the previous frame time
 *                and this one, e.g. 735 frames per video frame at 44.1 kHz and 60 fps.
 * @param sample_count Number of stereo sample frames (not floats) in @a samples.
 * @param frame_time Seconds since the first frame. Must be finite, at least 0 and not less
 *                   than the previous call's.
 * @param framebuffer_object The framebuffer to draw into, 0 for the default one.
 * @return true if the frame was rendered, false if an argument was invalid (nothing is changed
 *         then).
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_render_offline_frame(projectm_handle instance,
                                                   const float* samples,
                                                   unsigned int sample_count,
                                                   double frame_time,
                                                   uint32_t framebuffer_object);

#ifdef __cplusplus
} // extern "C"
#endif
