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
//   * set_rhythm_latency_ms(): the beat clock runs behind the analysis by the audio
//     output latency, so beats (and switches) land when they are heard.
//   * set_preset_switch_phrase() / set_section_hard_cut(): switches quantised to
//     phrases, and a hard cut on each section change.
//   * set_rhythm_events(): beats, bars and section changes reported to
//     globalThis.pmOnRhythmEvent(event) - only those frames, never every frame -
//     which html/projectm-context.js turns into context.on('beat' | 'bar' | 'section').
//
// Every setter also records itself in the host's EngineSettings, so a context-loss
// restore or a rebind does not drop it.

#include "WasmEvents.hpp"
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
    const deliver = () => {
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
    };
    const queue = Module['pmEventQueue'];
    if (queue) { queue.post(hostHandle, deliver); } else { deliver(); }
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
    PostEvent([&] {
        js_report_rhythm_event(EventHostHandle(host), events, static_cast<double>(info.bpm),
                               static_cast<double>(info.beat_index), static_cast<double>(info.bar_phase), info.section,
                               static_cast<double>(info.confidence));
    });
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

namespace WasmApi {

/**
 * @brief Tempo in BPM, 0 while the tracker is not confident.
 */
float get_rhythm_bpm(WasmHost& H)
{
    return CurrentRhythm(H).bpm;
}

/**
 * @brief Beat phase, 0..1 (0 = beat).
 */
float get_rhythm_beat_phase(WasmHost& H)
{
    return CurrentRhythm(H).beat_phase;
}

/**
 * @brief Bar phase, 0..1 over four beats (0 = downbeat).
 */
float get_rhythm_bar_phase(WasmHost& H)
{
    return CurrentRhythm(H).bar_phase;
}

/**
 * @brief Tracker confidence, 0..1.
 */
float get_rhythm_confidence(WasmHost& H)
{
    return CurrentRhythm(H).confidence;
}

/**
 * @brief Beats counted since the engine started. A double: exact far beyond any session.
 */
double get_rhythm_beat_index(WasmHost& H)
{
    return static_cast<double>(CurrentRhythm(H).beat_index);
}

/**
 * @brief Section index, incremented on every detected section change.
 */
int get_rhythm_section(WasmHost& H)
{
    return CurrentRhythm(H).section;
}

/**
 * @brief Uses a known tempo instead of estimating it; 0 goes back to estimating.
 */
void set_rhythm_hint(WasmHost& H, float bpm)
{
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
void set_preset_switch_policy(WasmHost& H, int policy, int bars)
{
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
int get_preset_switch_policy(WasmHost& H)
{
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
void transition_set_duration_beats(WasmHost& H, float beats)
{
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
float transition_get_duration_beats(WasmHost& H)
{
    return H.transitionBeats;
}

/**
 * @brief Makes beat-detection hard cuts wait for the next beat (at most one beat).
 */
void set_hard_cut_on_beat(WasmHost& H, bool enabled)
{
    auto& pm = H.appData.projectm_engine;
    H.engineSettings.hardCutOnBeat = enabled;
    if (pm)
    {
        projectm_set_hard_cut_on_beat(pm, enabled);
    }
}

/**
 * @brief Delays the beat clock by the audio output latency (ms, 0..1000).
 *
 * The page measures it (AudioContext.outputLatency + baseLatency + the worklet's
 * buffering; ProjectMContext.setRhythmLatency('auto')) or the user nudges it.
 */
void set_rhythm_latency_ms(WasmHost& H, double ms)
{
    auto& pm = H.appData.projectm_engine;
    const double clamped = std::isfinite(ms) ? std::clamp(ms, 0.0, 1000.0) : 0.0;
    H.engineSettings.rhythmLatencyMs = clamped;
    if (pm)
    {
        projectm_set_rhythm_latency(pm, clamped);
    }
}

/**
 * @brief The latency set with set_rhythm_latency_ms(), in ms.
 */
double get_rhythm_latency_ms(WasmHost& H)
{
    auto& pm = H.appData.projectm_engine;
    if (!pm)
    {
        return H.engineSettings.rhythmLatencyMs.value_or(0.0);
    }
    return projectm_get_rhythm_latency(pm);
}

/**
 * @brief Quantises bar and section switches to phrases of @p bars bars (0 = off).
 */
void set_preset_switch_phrase(WasmHost& H, int bars)
{
    auto& pm = H.appData.projectm_engine;
    const auto clamped = static_cast<uint32_t>(std::clamp(bars, 0, 64));
    H.engineSettings.presetSwitchPhrase = clamped;
    if (pm)
    {
        projectm_set_preset_switch_phrase(pm, clamped);
    }
}

/**
 * @brief Hard cut on the first downbeat after each detected section change.
 */
void set_section_hard_cut(WasmHost& H, bool enabled)
{
    auto& pm = H.appData.projectm_engine;
    H.engineSettings.sectionHardCut = enabled;
    if (pm)
    {
        projectm_set_section_hard_cut(pm, enabled);
    }
}

/**
 * @brief Reports beats, bars and section changes to globalThis.pmOnRhythmEvent.
 *
 * Off by default: a page that does not listen pays nothing. Only frames with an
 * event call into JavaScript - about two a second at 120 BPM.
 */
void set_rhythm_events(WasmHost& H, bool enabled)
{
    H.rhythmEventsEnabled = enabled;
    H.pendingRhythmEvents = 0;
}

} // namespace WasmApi
