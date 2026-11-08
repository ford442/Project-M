/**
 * @file HostVariables.hpp
 * @brief Which per-frame variables a host may set from outside a preset (projectm_eval_set()).
 */
#pragma once

#include <string_view>

namespace libprojectM {
namespace MilkdropPreset {

/**
 * @brief Whether the host may override this per-frame variable.
 *
 * q1..q32 and the per-frame variables a preset can assign itself (zoom, rot, warp, cx, cy, dx,
 * dy, sx, sy, decay, the wave_*, ob_*, ib_*, mv_* and echo_* variables, gamma, the blur ranges,
 * ...). Not the read-only inputs (time, fps, frame, progress, bass/mid/treb and *_att, meshx/y,
 * pixelsx/y, aspectx/y, pm_*): the engine writes those every frame.
 *
 * @param lowerCaseName The variable name in lower case.
 */
auto IsHostWritableVariable(std::string_view lowerCaseName) -> bool;

} // namespace MilkdropPreset
} // namespace libprojectM
