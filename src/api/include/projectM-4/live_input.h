/**
 * @file live_input.h
 * @copyright 2003-2026 projectM Team
 * @brief Live input from the host: frames into named textures, values into per-frame variables.
 * @since 4.2.0
 *
 * A host that wants a running preset to show a camera or a video, or to be driven by a
 * controller (MIDI, OSC, a slider), feeds it here instead of rewriting files or preset text:
 *
 * - A live texture is a texture the host registers by name and uploads frames into, as often as
 *   it likes. Presets sample it like any user texture (`sampler sampler_webcam;` in a warp or
 *   composite shader, `texsize_webcam` for its size). Fork extension.
 * - A host variable sets a per-frame variable (q1..q32, zoom, decay, ...) for every preset, every
 *   frame, until cleared. Fork extension.
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

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Largest width or height of a live texture, in pixels.
 * @since 4.2.0
 */
#define PROJECTM_LIVE_TEXTURE_MAX_SIZE 8192

/**
 * @brief Creates a live texture, or resizes one that exists.
 *
 * The texture is RGBA8 and starts black. Presets find it by name like a texture file, and it
 * takes precedence over a file or the texture load callback of the same name. It keeps its GPU
 * texture until it is unregistered, so resizing it here or uploading frames with
 * projectm_texture_slot_update() shows in every preset already sampling it from the next frame
 * on. It is never evicted, and survives projectm_set_texture_search_paths().
 *
 * Register it before loading the presets that sample it: a preset loaded while no texture of
 * that name existed got the black placeholder and keeps it until it is loaded again.
 *
 * Registering an existing live texture at its current size changes nothing (its last frame
 * stays); at another size its image is cleared to black.
 *
 * Call from the thread that renders, with the instance's OpenGL context current.
 *
 * @param instance The projectM instance handle.
 * @param name The texture's base name: 1-64 ASCII letters, digits or underscores, case-insensitive,
 *             as a preset spells it after `sampler_`. A name whose third character is an
 *             underscore ("pm_cam") reads as a filter/wrap prefix there, so presets must spell
 *             the prefix out (`sampler_fc_pm_cam`). "main", "blur1".."blur3", "randNN..." and
 *             the built-in textures (noise_*, noisevol_*, idlem, idleheadphones) are refused.
 * @param width Width in pixels, 1..PROJECTM_LIVE_TEXTURE_MAX_SIZE.
 * @param height Height in pixels, 1..PROJECTM_LIVE_TEXTURE_MAX_SIZE.
 * @return true if a live texture of that name and size exists now.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_texture_slot_register(projectm_handle instance, const char* name,
                                                    int width, int height);

/**
 * @brief Uploads one frame into a live texture.
 *
 * The upload replaces the whole image and reuses the texture's storage, so it is cheap enough to
 * call every frame. Call from the thread that renders, with the instance's OpenGL context current.
 *
 * @param instance The projectM instance handle.
 * @param name The name the texture was registered with.
 * @param rgba width * height RGBA8 pixels, top row first (the order a canvas or an image decoder
 *             produces), unpremultiplied.
 * @param bytes The size of @a rgba in bytes; must be exactly width * height * 4 of the texture's
 *              registered size.
 * @return true if the frame was uploaded; false for an unknown name, a null @a rgba or a size
 *         that does not match.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_texture_slot_update(projectm_handle instance, const char* name,
                                                  const void* rgba, size_t bytes);

/**
 * @brief Removes a live texture.
 *
 * Presets sampling it keep its last frame until they are loaded again. Call from the thread that
 * renders, with the instance's OpenGL context current.
 *
 * @param instance The projectM instance handle.
 * @param name The name the texture was registered with.
 * @return true if a live texture of that name existed.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_texture_slot_unregister(projectm_handle instance, const char* name);

/**
 * @brief Sets a per-frame variable for every preset, from the next frame on, until cleared.
 *
 * Each frame, after a preset's per-frame variables are reset to their starting values (the
 * preset file's values, and q1..q32 as its init code left them) and before its per-frame code
 * runs, the host's value is loaded over the starting value. Per-frame code that reads the variable
 * sees the host's value; code that assigns it overrides it for that frame, as the preset's author
 * intended. The value carries over to every preset loaded later, and through transitions, until
 * projectm_eval_clear() removes it.
 *
 * Per-pixel code, custom shapes and waves, and the warp/composite shaders see q1..q32 as the
 * per-frame code left them, so a preset that passes q1 through unchanged hands the host's value
 * all the way to its shaders.
 *
 * Call from the thread that renders: rendering reads the values.
 *
 * @param instance The projectM instance handle.
 * @param name q1..q32, or a per-frame variable a preset may assign: zoom, zoomexp, rot, warp, cx,
 *             cy, dx, dy, sx, sy, decay, wave_* (a, r, g, b, x, y, mystery, mode, usedots,
 *             thick, additive, brighten), ob_* and ib_* (size, r, g, b, a), mv_* (x, y, dx, dy,
 *             l, r, g, b, a), echo_zoom, echo_alpha, echo_orient, darken_center, gamma, wrap,
 *             invert, brighten, darken, solarize, blur1_min..blur3_max, blur1_edge_darken.
 *             Case-insensitive. The read-only inputs (time, fps, frame, progress, bass, mid,
 *             treb, *_att, meshx, meshy, pixelsx, pixelsy, aspectx, aspecty, pm_*) are refused.
 * @param value The value. NaN and infinities are refused.
 * @return true if the value is set.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_eval_set(projectm_handle instance, const char* name, double value);

/**
 * @brief Removes a value set with projectm_eval_set(), or all of them.
 *
 * From the next frame on, the variable starts from the preset's own value again. Call from the
 * thread that renders.
 *
 * @param instance The projectM instance handle.
 * @param name The variable name, or NULL to clear every host value.
 * @return true if at least one value was removed.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_eval_clear(projectm_handle instance, const char* name);

#ifdef __cplusplus
} // extern "C"
#endif
