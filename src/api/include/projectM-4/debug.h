/**
 * @file debug.h
 * @copyright 2003-2025 projectM Team
 * @brief Debug functions for both libprojectM and preset developers.
 * @since 4.0.0
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
 * @brief Writes a .bmp main texture dump after rendering the next main texture, before shaders are applied.
 *
 * If no file name is given, the image is written to the current working directory
 * and will be named named "frame_texture_contents-YYYY-mm-dd-HH:MM:SS-frame.bmp".
 *
 * Note this is the main texture contents, not the final rendering result. If the active preset
 * uses a composite shader, the dumped image will not have it applied. The main texture is what is
 * passed over to the next frame, the composite shader is only applied to the display framebuffer
 * after updating the main texture.
 *
 * To capture the actual output, dump the contents of the main framebuffer after calling
 * @a projectm_render_frame() on the application side.
 *
 * @param instance The projectM instance handle.
 * @param output_file The filename to write the dump to or NULL.
 * @since 4.0.0
 */
PROJECTM_EXPORT void projectm_write_debug_image_on_next_frame(projectm_handle instance, const char* output_file);

/**
 * @brief Makes libprojectM's random number generation reproducible.
 *
 * By default every RNG in the library seeds itself from std::random_device, so
 * two runs of the same preset over the same frames differ in preset hue
 * offsets, per-frame shader `rand_frame` values, the noise textures and the
 * transition shader/easing choice. That is correct for playback and fatal for
 * golden-image regression testing.
 *
 * After this call, all of those seeds become a pure function of @a seed and an
 * internal per-call-site name, so an identical (preset, audio, frame schedule)
 * run produces identical pixels. Combine it with @a projectm_set_frame_time()
 * for a virtual clock and a fixed audio schedule to get a fully reproducible
 * frame — see docs/GRAPHICS_BENCHMARK_HARNESS.md.
 *
 * Scope and caveats:
 *  - The setting is **process-global**, not per instance: there is one RNG
 *    policy for the library, so this takes no handle.
 *  - It also calls std::srand(), which pins the libc rand() stream behind
 *    MilkdropShader's per-frame `rand_frame` uniform. That single global
 *    sequence reproduces only when the sequence of draws from it is itself
 *    identical — true for a deterministic single-engine frame schedule, not
 *    true if two engines render interleaved in one process.
 *  - Objects sharing a call site (e.g. the two PresetStates alive during a
 *    crossfade) draw the same values, by design: seeds do not depend on call
 *    ordering, so adding a call site elsewhere cannot invalidate goldens.
 *  - It does not make the *renderer* deterministic. GPU/driver differences
 *    still apply; compare captures perceptually, not byte-wise, across devices.
 *
 * @param seed The seed. Any value is valid, including 0.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_set_deterministic_seed(uint32_t seed);

/**
 * @brief Returns RNG seeding to std::random_device.
 *
 * Does not restore the libc rand() stream disturbed by
 * @a projectm_set_deterministic_seed().
 *
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_clear_deterministic_seed(void);

/**
 * @brief Whether deterministic seeding is currently active.
 * @return True if @a projectm_set_deterministic_seed() is in effect.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_is_deterministic_seed_set(void);

#ifdef __cplusplus
} // extern "C"
#endif
