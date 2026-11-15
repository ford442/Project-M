// WasmPlaylistBridge.cpp
//
// Preset playlist bridge: projectM preset-switch callbacks, playlist path /
// preset add helpers, load_preset_file(), and preset-readiness queries.
#include "WasmEvents.hpp"
#include "WasmHost.hpp"
#include "WasmLog.hpp"

#include <cstdio>
#include <filesystem>
#include <string>
#include <system_error>

// Per-instance host state (#168 Phase B). The engine/playlist/loading triple
// and the preset-readiness gate are members of the WasmHost that owns them.
//
// The engine and playlist callbacks below are registered by init() with that
// host as their user_data, and act on it rather than on whichever host happens
// to be active when they fire: a callback raised for one engine must not flip
// the readiness flags of its sibling. The exports further down get their host
// from the barrier.

// The host a callback was registered for: init() always registers one.
static WasmHost& CallbackHost(void* user_data)
{
    return *static_cast<WasmHost*>(user_data);
}

void load_preset_callback_done([[maybe_unused]] bool is_hard_cut, [[maybe_unused]] unsigned int index, void* user_data)
{
    WasmHost& H = CallbackHost(user_data);
    auto& app_data = H.appData;
    auto& g_presetBReady = H.presetBReady;
    auto& g_renderedFrameCount = H.renderedFrameCount;
    auto& g_presetReadyFrame = H.presetReadyFrame;
    if (!app_data.projectm_engine)
    {
        return;
    }
    const double randomDelay = (emscripten_random() * 30.0) + 27.0;
    projectm_set_preset_duration(app_data.projectm_engine, randomDelay);
    app_data.loading = EM_FALSE;

    // Phase 4: Shader compilation is complete (ActivatePreparedPreset() calls
    // this after projectm_load_prepared_preset() initialized the preset).
    // Signal to the transition system that the new preset is safe to blend in.
    g_presetBReady = true;
    g_presetReadyFrame = g_renderedFrameCount;

    if (!app_data.playlist)
    {
        return;
    }
    uint32_t pos = projectm_playlist_get_position(app_data.playlist);
    char* preset_path = projectm_playlist_item(app_data.playlist, pos);
    if (preset_path)
    {
        PostEvent([&] { js_update_preset_name(EventHostHandle(H), preset_path); });
        projectm_playlist_free_string(preset_path);
    }
    return;
}

void on_preset_switch_failed(const char* preset_filename, const char* message, void* user_data)
{
    WasmHost& H = CallbackHost(user_data);
    auto& app_data = H.appData;
    auto& g_presetSwitchFailed = H.presetSwitchFailed;
    WASM_LOG_WARN("Preset switch failed (%s): %s", preset_filename, message);
    g_presetSwitchFailed = true;
    app_data.loading = EM_FALSE;
    PostEvent([&] { js_report_preset_switch_failed(EventHostHandle(H), preset_filename, message); });
    return;
}

void on_preset_switch_requested(bool is_hard_cut, void* user_data)
{
    WasmHost& H = CallbackHost(user_data);
    auto& app_data = H.appData;
    // Ignore timer-driven switches while a preset load is being prepared.
    // Without this, clicking "custom preset" can load the pick and then immediately
    // play_next() from an expired preset timer. The engine only asks once per
    // preset, so remember the request: if the in-flight load fails, nothing
    // restarts the engine's timer and ActivatePreparedPreset() replays it.
    if (app_data.loading == EM_TRUE)
    {
        H.switchRequestDeferred = true;
        H.deferredSwitchHardCut = is_hard_cut;
        return;
    }
    if (!app_data.playlist)
    {
        return;
    }
    WASM_LOG_INFO("projectM is requesting a preset switch (hard_cut: %s)!", is_hard_cut ? "true" : "false");
    projectm_playlist_play_next(app_data.playlist, is_hard_cut);
    return;
}

// The playlist's preset-load hook: every playlist-driven load (set_position,
// play_next, the engine's timer) arrives here instead of the playlist calling
// projectm_load_preset_file() synchronously. Queues it for preparation and
// tells the playlist it is handled; load_preset_callback_done() runs once the
// preset has been activated (ActivatePreparedPreset()).
bool on_playlist_preset_load(unsigned int index, const char* filename, bool hard_cut, void* user_data)
{
    WasmHost& H = CallbackHost(user_data);
    if (!H.appData.projectm_engine || H.presetPrepare == nullptr)
    {
        return false; // Let the playlist load it synchronously.
    }
    RequestPresetPrepare(H, filename, hard_cut, index);
    return true;
}

namespace WasmApi {
void add_preset_path(WasmHost& H)
{
    auto& app_data = H.appData;
    if (!app_data.playlist)
    {
        return;
    }
    char preset_file[256];
    for (int i = 0; i <= 100; ++i)
    {
        snprintf(preset_file, sizeof(preset_file), "/presets/preset_%d.milk", i);
        projectm_playlist_add_preset(app_data.playlist, preset_file, false);
    }
    return;
}

void add_existing_vfs_presets(WasmHost& H)
{
    auto& app_data = H.appData;
    if (!app_data.playlist)
    {
        return;
    }
    char preset_file[256];
    int added = 0;
    for (int i = 0; i <= 100; ++i)
    {
        snprintf(preset_file, sizeof(preset_file), "/presets/preset_%d.milk", i);
        if (access(preset_file, F_OK) == 0)
        {
            projectm_playlist_add_preset(app_data.playlist, preset_file, false);
            added++;
        }
    }
    WASM_LOG_INFO("Added %d existing VFS presets to playlist.", added);
    return;
}

void add_preset_file(WasmHost& H, const char* path)
{
    auto& app_data = H.appData;
    if (!app_data.playlist)
    {
        return;
    }
    projectm_playlist_add_preset(app_data.playlist, path, false);
    return;
}

void add_custom_milk_paths(WasmHost& H, int count)
{
    auto& app_data = H.appData;
    if (!app_data.playlist)
    {
        return;
    }
    char preset_file[256];
    int added = 0;
    for (int i = 0; i < count; ++i)
    {
        snprintf(preset_file, sizeof(preset_file), "/presets/custmilk_%d.milk", i);
        if (access(preset_file, F_OK) == 0)
        {
            projectm_playlist_add_preset(app_data.playlist, preset_file, false);
            added++;
        }
    }
    WASM_LOG_INFO("Added %d of %d custom milk presets to playlist.", added, count);
    return;
}

void switch_preset(WasmHost& H)
{
    auto& app_data = H.appData;
    if (!app_data.playlist)
    {
        return;
    }
    projectm_playlist_play_next(app_data.playlist, false);
    return;
}
} // namespace WasmApi

static void LoadPresetFile(WasmHost& H, const char* filename, bool hard_cut)
{
    auto& pm = H.appData.projectm_engine;
    auto& app_data = H.appData;
    if (!pm || filename == nullptr)
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
    if (app_data.playlist)
    {
        // Search the existing playlist for this filename.
        uint32_t count = projectm_playlist_size(app_data.playlist);
        int32_t foundIdx = -1;
        for (uint32_t i = 0; i < count; ++i)
        {
            char* item = projectm_playlist_item(app_data.playlist, i);
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
            uint32_t sizeBefore = projectm_playlist_size(app_data.playlist);
            projectm_playlist_add_preset(app_data.playlist, filename, false);
            uint32_t sizeAfter = projectm_playlist_size(app_data.playlist);
            if (sizeAfter > sizeBefore)
            {
                foundIdx = static_cast<int32_t>(sizeAfter - 1);
            }
        }
        if (foundIdx >= 0)
        {
            projectm_playlist_set_position(app_data.playlist,
                                           static_cast<uint32_t>(foundIdx), hard_cut);
            return;
        }
        // Fall through to a direct load if playlist add failed.
    }

    // Fallback: no playlist attached yet – prepare the file directly.
    RequestPresetPrepare(H, filename, hard_cut, std::nullopt);
}

namespace WasmApi {
void load_preset_file(WasmHost& H, const char* filename)
{
    LoadPresetFile(H, filename, false);
}

void load_preset_file_hard(WasmHost& H, const char* filename)
{
    LoadPresetFile(H, filename, true);
}

// Presets by buffer. The bytes still get a name in MEMFS: the playlist, a
// context-loss reload (html/projectm-context-loss.js reloads the current path)
// and the transpiled-shader cache all know a preset by its path. What changes
// for the host is that it no longer drives the filesystem itself (mkdir, then
// FS.writeFile, then a second call to load). See docs/EMSCRIPTEN.md
// "Presets by buffer".
int load_preset_data(WasmHost& H, uint8_t* data, uintptr_t len, const char* name, int mode)
{
    // The `mode` values (html/projectm-preset-store.js, PRESET_STORE_MODES).
    constexpr int kLoad = 0;
    constexpr int kLoadHardCut = 1;
    constexpr int kAddToPlaylist = 2;
    constexpr int kStoreOnly = 3;
    if (name == nullptr || name[0] == '\0' || (data == nullptr && len > 0) || mode < kLoad || mode > kStoreOnly)
    {
        return 0;
    }
    // Storing needs no engine; the other modes hand the preset to one.
    if (mode != kStoreOnly && !H.appData.projectm_engine)
    {
        return 0;
    }
    std::string path = name;
    if (path.front() != '/')
    {
        path = "/presets/" + path;
    }
    if (path.back() == '/')
    {
        return 0;
    }

    std::error_code error;
    std::filesystem::create_directories(std::filesystem::path(path).parent_path(), error);
    FILE* file = fopen(path.c_str(), "wb");
    if (file == nullptr)
    {
        WASM_LOG_WARN("load_preset_data: cannot store %s", path.c_str());
        return 0;
    }
    const bool written = len == 0 || fwrite(data, 1, len, file) == len;
    const bool closed = fclose(file) == 0;
    if (!written || !closed)
    {
        WASM_LOG_WARN("load_preset_data: writing %s failed", path.c_str());
        return 0;
    }

    if (mode == kAddToPlaylist)
    {
        add_preset_file(H, path.c_str());
    }
    else if (mode != kStoreOnly)
    {
        LoadPresetFile(H, path.c_str(), mode == kLoadHardCut);
    }
    return 1;
}
} // namespace WasmApi

namespace WasmApi {
int get_rendered_frame_count(WasmHost& H)
{
    auto& g_renderedFrameCount = H.renderedFrameCount;
    return static_cast<int>(g_renderedFrameCount);
}

int preset_switch_failed(WasmHost& H)
{
    auto& g_presetSwitchFailed = H.presetSwitchFailed;
    return g_presetSwitchFailed ? 1 : 0;
}

int is_preset_ready(WasmHost& H, int min_frames_since_ready)
{
    auto& pm = H.appData.projectm_engine;
    auto& app_data = H.appData;
    auto& g_presetBReady = H.presetBReady;
    auto& g_renderedFrameCount = H.renderedFrameCount;
    auto& g_presetReadyFrame = H.presetReadyFrame;
    auto& g_presetSwitchFailed = H.presetSwitchFailed;
    if (!pm)
    {
        return 0;
    }
    if (app_data.loading == EM_TRUE)
    {
        return 0;
    }
    if (!g_presetBReady)
    {
        return 0;
    }
    if (g_presetSwitchFailed)
    {
        return 0;
    }
    const uint32_t requiredFrames = min_frames_since_ready > 0
                                        ? static_cast<uint32_t>(min_frames_since_ready)
                                        : 0u;
    return (g_renderedFrameCount - g_presetReadyFrame) >= requiredFrames ? 1 : 0;
}
} // namespace WasmApi
