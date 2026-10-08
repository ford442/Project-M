/**
 * @file rhythm.h
 * @copyright 2003-2026 projectM Team
 * @brief Musical time: tempo, beat and bar phase, sections, and preset scheduling on them.
 * @since 4.2.0
 *
 * libprojectM tracks the tempo and the beat of the audio it is fed (see
 * docs/AUDIO_PIPELINE.md, "Rhythm analysis"). Presets read the results as the pm_* variables;
 * this header gives a host the same values and lets it switch presets on musical boundaries
 * instead of a timer. Fork extension.
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
 * @brief Musical-time values of the most recently rendered frame.
 *
 * The event fields (beat, bar, section_changed) are set on one frame only; poll after every
 * projectm_opengl_render_frame() call to see all of them.
 *
 * @since 4.2.0
 */
typedef struct projectm_rhythm_info {
    /** Tempo in beats per minute, 0 while confidence is below the reporting threshold (0.35). */
    float bpm;
    /** 0..1 sawtooth, 0 = the (predicted) beat. Keeps running at the last tempo while not confident. */
    float beat_phase;
    /** 0..1 over a four-beat bar, 0 = downbeat. */
    float bar_phase;
    /** 0..1 tracker confidence. 1 while a tempo hint is set. */
    float confidence;
    /** Monotonic beat counter, incremented every time beat_phase wraps. */
    uint64_t beat_index;
    /** Section index, incremented on every detected section change. */
    int section;
    /** Non-zero only on the frame a section change was detected. */
    int section_changed;
    /** Non-zero only on the frame of a beat, while confident. */
    int beat;
    /** Non-zero only on the frame of a downbeat (first beat of a bar), while confident. */
    int bar;
    /** 1 on the beat frame, decaying exponentially over ~100 ms. 0 while not confident. */
    float beat_pulse;
    /** Normalized onset strength (0..1) of the frame, all frequency bands. */
    float onset;
} projectm_rhythm_info;

/**
 * @brief Fills @p out_info with the musical-time values of the most recently rendered frame.
 *
 * All zero before the first frame.
 *
 * @param instance The projectM instance handle.
 * @param out_info Receives the values. Must not be NULL.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_get_rhythm_info(projectm_handle instance, projectm_rhythm_info* out_info);

/**
 * @brief Overrides tempo estimation with a known tempo.
 *
 * For a host that knows the tempo better than the audio analysis can: a MIDI clock, track
 * metadata, a tap-tempo button. The beat clock then runs at exactly this tempo, only its
 * phase is still locked to the audio, and the confidence reads 1.
 *
 * @param instance The projectM instance handle.
 * @param bpm Tempo in beats per minute, or 0 (any value <= 0) to clear the hint and go back
 *            to estimating it from the audio.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_set_rhythm_hint(projectm_handle instance, float bpm);

/**
 * @brief Returns the tempo hint set with projectm_set_rhythm_hint(), 0 if none.
 * @param instance The projectM instance handle.
 * @since 4.2.0
 */
PROJECTM_EXPORT float projectm_get_rhythm_hint(projectm_handle instance);

/**
 * @brief When projectM asks for the next preset (projectm_preset_switch_requested_event).
 * @since 4.2.0
 */
typedef enum {
    /** After the preset duration (projectm_set_preset_duration()). The default. */
    PROJECTM_PRESET_SWITCH_TIMER = 0,
    /**
     * On the downbeat that completes the given number of bars, counted from the preset start.
     * Falls back to the timer while the tempo is not confidently known, and switches at the
     * latest after twice the preset duration.
     */
    PROJECTM_PRESET_SWITCH_BARS = 1,
    /**
     * On the first downbeat after a detected section change (a new part of the song), at most
     * once per the given number of bars. Falls back to the timer, aligned to a downbeat when
     * the tempo is known.
     */
    PROJECTM_PRESET_SWITCH_SECTION = 2
} projectm_preset_switch_policy;

/**
 * @brief Sets when projectM requests the next preset.
 *
 * Hard cuts (projectm_set_hard_cut_enabled()) are unaffected. A locked preset never switches.
 *
 * @param instance The projectM instance handle.
 * @param policy When to switch.
 * @param bars For PROJECTM_PRESET_SWITCH_BARS, the preset length in bars (typically 16 or
 *             32); for PROJECTM_PRESET_SWITCH_SECTION, the shortest preset in bars. 0 means 16.
 *             Ignored for PROJECTM_PRESET_SWITCH_TIMER.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_set_preset_switch_policy(projectm_handle instance, projectm_preset_switch_policy policy,
                                                       uint32_t bars);

/**
 * @brief Returns the preset switch policy.
 * @param instance The projectM instance handle.
 * @param out_bars If not NULL, receives the bar count.
 * @since 4.2.0
 */
PROJECTM_EXPORT projectm_preset_switch_policy projectm_get_preset_switch_policy(projectm_handle instance, uint32_t* out_bars);

/**
 * @brief Sets the soft cut (transition) duration in beats instead of seconds.
 *
 * Each transition resolves it against the tempo at the moment it starts. While the tempo is
 * not confidently known, the duration in seconds (projectm_set_soft_cut_duration()) is used.
 *
 * @param instance The projectM instance handle.
 * @param beats Transition length in beats, or 0 to always use seconds (the default).
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_set_soft_cut_duration_beats(projectm_handle instance, double beats);

/**
 * @brief Returns the soft cut duration in beats, 0 if transitions use seconds.
 * @param instance The projectM instance handle.
 * @since 4.2.0
 */
PROJECTM_EXPORT double projectm_get_soft_cut_duration_beats(projectm_handle instance);

/**
 * @brief Lands beat-detection hard cuts on the beat.
 *
 * When enabled and the tempo is confidently known, a hard cut that the loudness trigger asks
 * for waits for the next beat (at most one beat). Without a confident tempo it cuts
 * immediately, as when disabled.
 *
 * @param instance The projectM instance handle.
 * @param enabled true to align hard cuts to beats. Default false.
 * @since 4.2.0
 */
PROJECTM_EXPORT void projectm_set_hard_cut_on_beat(projectm_handle instance, bool enabled);

/**
 * @brief Returns whether hard cuts are aligned to beats.
 * @param instance The projectM instance handle.
 * @since 4.2.0
 */
PROJECTM_EXPORT bool projectm_get_hard_cut_on_beat(projectm_handle instance);

#ifdef __cplusplus
} // extern "C"
#endif
