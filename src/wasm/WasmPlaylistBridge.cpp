// WasmPlaylistBridge.cpp
//
// Preset playlist bridge: projectM preset-switch callbacks, playlist path /
// preset add helpers, load_preset_file(), and preset-readiness queries.
#include "WasmHost.hpp"

#include <random>

// Per-instance host state (#168 Phase B). The engine/playlist/loading triple
// and the preset-readiness gate are members of the WasmHost that owns them.
//
// The engine and playlist callbacks below are registered by init() with that
// host as their user_data, and act on it rather than on whichever host happens
// to be active when they fire: a callback raised for one engine must not flip
// the readiness flags of its sibling. The exports further down run after
// set_active_host() and use Host() as usual.

// The host a callback was registered for. init() always passes one; the
// fallback only covers a caller that registers a callback without it.
static WasmHost& CallbackHost(void* user_data)
{
    return user_data != nullptr ? *static_cast<WasmHost*>(user_data) : Host();
}

// How long the preset that was just switched to runs: the host's
// set_preset_duration() policy, its random part drawn from the host's seeded RNG
// (see WasmHost::presetDurationRng). The engine's timer reads it when the
// switch completes, so it is set right after each one.
double NextPresetDuration(WasmHost& host)
{
    if (host.presetDurationRandomExtra <= 0.0)
    {
        return host.presetDurationSeconds;
    }
    std::uniform_real_distribution<double> extra(0.0, host.presetDurationRandomExtra);
    return host.presetDurationSeconds + extra(host.presetDurationRng);
}

void SeedPresetDurationRng(WasmHost& host)
{
    host.presetDurationRng.seed(libprojectM::RandomSeed::Get(kPresetDurationRngDomain));
}

void load_preset_callback_done([[maybe_unused]] bool is_hard_cut, [[maybe_unused]] unsigned int index, void* user_data)
{
    WasmHost& H = CallbackHost(user_data);
    projectm_handle engine = H.appData.Engine();
    if (engine == nullptr)
    {
        return;
    }
    projectm_set_preset_duration(engine, NextPresetDuration(H));
    H.appData.loading = EM_FALSE;

    // Phase 4: Shader compilation is complete (ActivatePreparedPreset() calls
    // this after projectm_load_prepared_preset() initialized the preset).
    // Signal to the transition system that the new preset is safe to blend in.
    H.presetBReady = true;
    H.presetReadyFrame = H.renderedFrameCount;

    projectm_playlist_handle playlist = H.appData.Playlist();
    if (playlist == nullptr)
    {
        return;
    }
    uint32_t pos = projectm_playlist_get_position(playlist);
    char* preset_path = projectm_playlist_item(playlist, pos);
    if (preset_path)
    {
        js_update_preset_name(preset_path);
        projectm_playlist_free_string(preset_path);
    }
}

void on_preset_switch_failed(const char* preset_filename, const char* message, void* user_data)
{
    WasmHost& H = CallbackHost(user_data);
    H.presetSwitchFailed = true;
    H.appData.loading = EM_FALSE;
    // The page hears about it (console.warn + pmPresetSwitchFailed); no second log line here.
    js_report_preset_switch_failed(preset_filename, message);
}

void on_preset_switch_requested(bool is_hard_cut, void* user_data)
{
    WasmHost& H = CallbackHost(user_data);
    // Ignore timer-driven switches while a preset load is being prepared.
    // Without this, clicking "custom preset" can load the pick and then immediately
    // play_next() from an expired preset timer. The engine only asks once per
    // preset, so remember the request: if the in-flight load fails, nothing
    // restarts the engine's timer and ActivatePreparedPreset() replays it.
    if (H.appData.loading == EM_TRUE)
    {
        H.switchRequestDeferred = true;
        H.deferredSwitchHardCut = is_hard_cut;
        return;
    }
    projectm_playlist_handle playlist = H.appData.Playlist();
    if (playlist == nullptr)
    {
        return;
    }
    LOG_DEBUG(std::string("Engine requested a preset switch, hard cut: ") + (is_hard_cut ? "true" : "false"));
    projectm_playlist_play_next(playlist, is_hard_cut);
}

// The playlist's preset-load hook: every playlist-driven load (set_position,
// play_next, the engine's timer) arrives here instead of the playlist calling
// projectm_load_preset_file() synchronously. Queues it for preparation and
// tells the playlist it is handled; load_preset_callback_done() runs once the
// preset has been activated (ActivatePreparedPreset()).
bool on_playlist_preset_load(unsigned int index, const char* filename, bool hard_cut, void* user_data)
{
    WasmHost& H = CallbackHost(user_data);
    if (H.appData.Engine() == nullptr || H.presetPrepare == nullptr)
    {
        return false; // Let the playlist load it synchronously.
    }
    RequestPresetPrepare(H, filename, hard_cut, index);
    return true;
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void add_preset_file(const char* path)
{
    if (projectm_playlist_handle playlist = Host().appData.Playlist())
    {
        projectm_playlist_add_preset(playlist, path, false);
    }
}

EMSCRIPTEN_KEEPALIVE
void switch_preset()
{
    if (projectm_playlist_handle playlist = Host().appData.Playlist())
    {
        projectm_playlist_play_next(playlist, false);
    }
}

// How long each preset runs before the engine's timer switches to the next:
// `seconds` plus a uniform draw from [0, randomExtraSeconds), taken afresh for
// every preset from this host's RNG, which set_deterministic_seed() pins. The
// default is a fixed 30 s (randomExtraSeconds 0). Applies from the current
// preset on, and survives the engine being re-created. Only the timer policy
// (set_preset_switch_policy(0)) reads it.
EMSCRIPTEN_KEEPALIVE
void set_preset_duration(double seconds, double randomExtraSeconds)
{
    WasmHost& H = Host();
    H.presetDurationSeconds = seconds > 0.0 ? seconds : 30.0;
    H.presetDurationRandomExtra = randomExtraSeconds > 0.0 ? randomExtraSeconds : 0.0;
    if (projectm_handle engine = H.appData.Engine())
    {
        projectm_set_preset_duration(engine, NextPresetDuration(H));
    }
}
} // extern "C"

static void load_preset_file_impl(const char* filename, bool hard_cut)
{
    WasmHost& H = Host();
    if (H.appData.Engine() == nullptr || filename == nullptr)
    {
        return;
    }

    // Phase 3: Route all preset switches through the playlist manager so that
    // the engine's built-in transition cleanup routines are always triggered
    // (dual FBO re-init, glClearColor reset, blend state isolation).
    //
    // Nothing here blocks: the playlist hands the load to on_playlist_preset_load(),
    // which queues it on this host's prepare thread and returns. The current
    // preset keeps rendering until the new one is prepared and activated, so
    // there is no need to yield to the browser first (the emscripten_sleep(0)
    // that used to be here was the only reason the build needed ASYNCIFY).
    if (projectm_playlist_handle playlist = H.appData.Playlist())
    {
        // Search the existing playlist for this filename.
        uint32_t count = projectm_playlist_size(playlist);
        int32_t foundIdx = -1;
        for (uint32_t i = 0; i < count; ++i)
        {
            char* item = projectm_playlist_item(playlist, i);
            if (item)
            {
                bool match = (std::string(item) == filename);
                projectm_playlist_free_string(item);
                if (match)
                {
                    foundIdx = static_cast<int32_t>(i);
                    break;
                }
            }
        }
        if (foundIdx < 0)
        {
            // Add to playlist so the manager can track it.
            uint32_t sizeBefore = projectm_playlist_size(playlist);
            projectm_playlist_add_preset(playlist, filename, false);
            uint32_t sizeAfter = projectm_playlist_size(playlist);
            if (sizeAfter > sizeBefore)
            {
                foundIdx = static_cast<int32_t>(sizeAfter - 1);
            }
        }
        if (foundIdx >= 0)
        {
            projectm_playlist_set_position(playlist, static_cast<uint32_t>(foundIdx), hard_cut);
            return;
        }
        // Fall through to a direct load if playlist add failed.
    }

    // Fallback: no playlist attached yet – prepare the file directly.
    RequestPresetPrepare(H, filename, hard_cut, std::nullopt);
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void load_preset_file(const char* filename)
{
    load_preset_file_impl(filename, false);
}

EMSCRIPTEN_KEEPALIVE
void load_preset_file_hard(const char* filename)
{
    load_preset_file_impl(filename, true);
}
} // extern "C"

extern "C" {
EMSCRIPTEN_KEEPALIVE
int get_rendered_frame_count()
{
    return static_cast<int>(Host().renderedFrameCount);
}

// ---- Test hooks (PROJECTM_WASM_DEBUG_EXPORTS) -------------------------------

EMSCRIPTEN_KEEPALIVE
int debug_preset_switch_failed()
{
    return Host().presetSwitchFailed ? 1 : 0;
}

// The current preset's duration as the engine's timer sees it (0 without an
// engine): what set_preset_duration() and its seeded draw produced.
EMSCRIPTEN_KEEPALIVE
double debug_get_preset_duration()
{
    projectm_handle engine = Host().appData.Engine();
    return engine != nullptr ? projectm_get_preset_duration(engine) : 0.0;
}

// 1 once the latest preset load has been activated (shaders linked) and at
// least `min_frames_since_ready` frames have rendered with it since.
EMSCRIPTEN_KEEPALIVE
int debug_is_preset_ready(int min_frames_since_ready)
{
    const WasmHost& H = Host();
    if (H.appData.Engine() == nullptr || H.appData.loading == EM_TRUE || !H.presetBReady || H.presetSwitchFailed)
    {
        return 0;
    }
    const uint32_t requiredFrames = min_frames_since_ready > 0
                                        ? static_cast<uint32_t>(min_frames_since_ready)
                                        : 0u;
    return (H.renderedFrameCount - H.presetReadyFrame) >= requiredFrames ? 1 : 0;
}
} // extern "C"
