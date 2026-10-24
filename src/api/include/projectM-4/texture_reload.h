/**
 * @file texture_reload.h
 * @copyright 2003-2026 projectM Team
 * @brief Updating a loaded preset texture in place when its file changes.
 * @since 4.2.0
 *
 * A host that rewrites an image in the texture search paths while a preset is running (the
 * WASM experimental bridge writes a depth map to /textures/pm_depth_map.png) can make the
 * running preset sample the new image without reloading the preset. Fork extension.
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
 * @brief Re-reads a texture that was loaded from a file and updates it in place.
 *
 * The texture search paths are rescanned, the named file is decoded again (its size may have
 * changed) and uploaded into the existing texture, so every preset and sprite already sampling
 * it shows the new image from the next frame on.
 *
 * A texture that is not loaded yet cannot be updated: it is read from the file the next time a
 * preset asks for it, and a running preset that resolved the name to the black placeholder keeps
 * the placeholder until it is reloaded. Textures from the texture load callback are not touched.
 *
 * Call from the thread that renders, with the instance's OpenGL context current.
 *
 * @param instance The projectM instance handle.
 * @param texture_name The texture's file base name, without extension or a filter/wrap prefix
 *                     such as "fc_", e.g. "pm_depth_map" for pm_depth_map.png.
 * @return true if a loaded texture was updated; false if none of that name was loaded from a
 *         file, or its file is gone or could not be decoded.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_reload_texture(projectm_handle instance, const char* texture_name);

#ifdef __cplusplus
} // extern "C"
#endif
