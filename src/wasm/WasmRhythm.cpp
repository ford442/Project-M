// WasmRhythm.cpp
//
// Musical time for the browser host: libprojectM's rhythm analysis (tempo, beat
// and bar phase, sections; projectM-4/rhythm.h) and the scheduling built on it.
//
//   * Readouts: get_rhythm_bpm() and friends, for an inspector or a tempo display.
//   * set_rhythm_hint(): a known tempo (MIDI clock, track metadata) instead of the
//     estimate.
//   * set_preset_switch_policy(): playlist switches on the timer, every N bars, or
//     on a detected section change.
//   * transition_set_duration_beats(): crossfades a musical length long, both the
//     dual-FBO compositor's and the engine's own soft cuts.
//   * set_hard_cut_on_beat(): beat-detection hard cuts wait for the beat.
//   * set_rhythm_events(): beats, bars and section changes reported to
//     globalThis.pmOnRhythmEvent(event) - only those frames, never every frame -
//     which html/projectm-context.js turns into context.on('beat' | 'bar' | 'section').
//
// Every setter also records itself in the host's EngineSettings, so a context-loss
// restore or a rebind does not drop it.

#include "WasmHost.hpp"

namespace {

// Event bits, as reported to the page.
constexpr int kRhythmEventBeat = 1;
constexpr int kRhythmEventBar = 2;
constexpr int kRhythmEventSection = 4;

auto CurrentRhythm(const WasmHost& host) -> projectm_rhythm_info
{
    projectm_rhythm_info info{};
    if (host.appData.projectm_engine != nullptr)
    {
        projectm_get_rhythm_info(host.appData.projectm_engine, &info);
    }
    return info;
}

} // namespace

// clang-format off
EM_JS(void, js_report_rhythm_event, (double hostHandle, int events, double bpm, double beatIndex, double barPhase, int section, double confidence), {
    if (typeof globalThis.pmOnRhythmEvent === 'function') {
        globalThis.pmOnRhythmEvent({
            host: hostHandle,
            beat: (events & 1) !== 0,
            bar: (events & 2) !== 0,
            section: (events & 4) !== 0,
            bpm: bpm,
            beatIndex: beatIndex,
            barPhase: barPhase,
            sectionIndex: section,
            confidence: confidence,
        });
    }
});
// clang-format on

void CollectRhythmEvents(WasmHost& host)
{
    if (!host.rhythmEventsEnabled)
    {
        return;
    }
    const auto info = CurrentRhythm(host);
    host.pendingRhythmEvents |= (info.beat != 0 ? kRhythmEventBeat : 0) |
                                (info.bar != 0 ? kRhythmEventBar : 0) |
                                (info.section_changed != 0 ? kRhythmEventSection : 0);
}

void FlushRhythmEvents(WasmHost& host)
{
    const int events = host.pendingRhythmEvents;
    host.pendingRhythmEvents = 0;
    if (!host.rhythmEventsEnabled || events == 0)
    {
        return;
    }
    const auto info = CurrentRhythm(host);
    js_report_rhythm_event(static_cast<double>(HostHandle(host)), events, static_cast<double>(info.bpm),
                           static_cast<double>(info.beat_index), static_cast<double>(info.bar_phase), info.section,
                           static_cast<double>(info.confidence));
}

float ResolveTransitionDuration(WasmHost& host)
{
    if (host.transitionBeats > 0.0f)
    {
        const auto info = CurrentRhythm(host);
        if (info.bpm > 0.0f)
        {
            return host.transitionBeats * 60.0f / info.bpm;
        }
    }
    return host.transitionDuration;
}

extern "C" {

/**
 * @brief Tempo in BPM, 0 while the tracker is not confident.
 */
EMSCRIPTEN_KEEPALIVE
float get_rhythm_bpm()
{
    return CurrentRhythm(Host()).bpm;
}

/**
 * @brief Beat phase, 0..1 (0 = beat).
 */
EMSCRIPTEN_KEEPALIVE
float get_rhythm_beat_phase()
{
    return CurrentRhythm(Host()).beat_phase;
}

/**
 * @brief Bar phase, 0..1 over four beats (0 = downbeat).
 */
EMSCRIPTEN_KEEPALIVE
float get_rhythm_bar_phase()
{
    return CurrentRhythm(Host()).bar_phase;
}

/**
 * @brief Tracker confidence, 0..1.
 */
EMSCRIPTEN_KEEPALIVE
float get_rhythm_confidence()
{
    return CurrentRhythm(Host()).confidence;
}

/**
 * @brief Beats counted since the engine started. A double: exact far beyond any session.
 */
EMSCRIPTEN_KEEPALIVE
double get_rhythm_beat_index()
{
    return static_cast<double>(CurrentRhythm(Host()).beat_index);
}

/**
 * @brief Section index, incremented on every detected section change.
 */
EMSCRIPTEN_KEEPALIVE
int get_rhythm_section()
{
    return CurrentRhythm(Host()).section;
}

/**
 * @brief Uses a known tempo instead of estimating it; 0 goes back to estimating.
 */
EMSCRIPTEN_KEEPALIVE
void set_rhythm_hint(float bpm)
{
    WasmHost& H = Host();
    auto& pm = H.appData.projectm_engine;
    H.engineSettings.rhythmHint = bpm;
    if (pm)
    {
        projectm_set_rhythm_hint(pm, bpm);
    }
}

/**
 * @brief When the playlist switches presets: 0 timer, 1 every @p bars bars, 2 on a
 *        section change (at most every @p bars bars). See projectM-4/rhythm.h.
 */
EMSCRIPTEN_KEEPALIVE
void set_preset_switch_policy(int policy, int bars)
{
    WasmHost& H = Host();
    auto& pm = H.appData.projectm_engine;
    const int clampedPolicy = policy >= 0 && policy <= 2 ? policy : 0;
    const auto clampedBars = static_cast<uint32_t>(std::max(bars, 0));
    H.engineSettings.presetSwitchPolicy = std::make_pair(clampedPolicy, clampedBars);
    if (pm)
    {
        projectm_set_preset_switch_policy(pm, static_cast<projectm_preset_switch_policy>(clampedPolicy), clampedBars);
    }
}

/**
 * @brief The preset switch policy (0 timer, 1 bars, 2 section).
 */
EMSCRIPTEN_KEEPALIVE
int get_preset_switch_policy()
{
    WasmHost& H = Host();
    auto& pm = H.appData.projectm_engine;
    if (!pm)
    {
        return H.engineSettings.presetSwitchPolicy ? H.engineSettings.presetSwitchPolicy->first : 0;
    }
    return static_cast<int>(projectm_get_preset_switch_policy(pm, nullptr));
}

/**
 * @brief Crossfade length in beats, resolved against the tempo when each crossfade
 *        starts; while the tempo is unknown the duration in seconds applies. 0 = seconds.
 *
 * Covers both the dual-FBO compositor's crossfades (transition_start()) and the
 * engine's own soft cuts.
 */
EMSCRIPTEN_KEEPALIVE
void transition_set_duration_beats(float beats)
{
    WasmHost& H = Host();
    auto& pm = H.appData.projectm_engine;
    H.transitionBeats = std::isfinite(beats) && beats > 0.0f ? beats : 0.0f;
    H.engineSettings.transitionBeats = H.transitionBeats;
    if (pm)
    {
        projectm_set_soft_cut_duration_beats(pm, H.transitionBeats);
    }
}

/**
 * @brief Crossfade length in beats, 0 if crossfades use seconds.
 */
EMSCRIPTEN_KEEPALIVE
float transition_get_duration_beats()
{
    return Host().transitionBeats;
}

/**
 * @brief Makes beat-detection hard cuts wait for the next beat (at most one beat).
 */
EMSCRIPTEN_KEEPALIVE
void set_hard_cut_on_beat(bool enabled)
{
    WasmHost& H = Host();
    auto& pm = H.appData.projectm_engine;
    H.engineSettings.hardCutOnBeat = enabled;
    if (pm)
    {
        projectm_set_hard_cut_on_beat(pm, enabled);
    }
}

/**
 * @brief Reports beats, bars and section changes to globalThis.pmOnRhythmEvent.
 *
 * Off by default: a page that does not listen pays nothing. Only frames with an
 * event call into JavaScript - about two a second at 120 BPM.
 */
EMSCRIPTEN_KEEPALIVE
void set_rhythm_events(bool enabled)
{
    WasmHost& H = Host();
    H.rhythmEventsEnabled = enabled;
    H.pendingRhythmEvents = 0;
}

} // extern "C"
