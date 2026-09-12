// WasmPlaylistBridge.cpp
//
// Preset playlist bridge: projectM preset-switch callbacks, playlist path /
// preset add helpers, load_preset_file(), and preset-readiness queries.
#include "WasmHost.hpp"

using namespace emscripten;

// Per-instance host state (#168 Phase B). The engine/playlist/loading triple
// and the preset-readiness gate were process-global; they are now members of
// the active WasmHost. These callbacks fire synchronously from inside the
// active host's render/load, and the exports run after set_active_host(), so
// mapping the former global names to Host() members keeps the bodies unchanged.
#define pm (Host().appData.projectm_engine)
#define app_data (Host().appData)
#define g_presetBReady (Host().presetBReady)
#define g_renderedFrameCount (Host().renderedFrameCount)
#define g_presetReadyFrame (Host().presetReadyFrame)
#define g_presetSwitchFailed (Host().presetSwitchFailed)

void load_preset_callback_example(bool is_hard_cut, unsigned int index, void* user_data)
{
    // AppData* app_data = (AppData*)user_data;
    projectm_playlist_handle playlist = app_data.playlist;
    uint32_t indx = projectm_playlist_play_next(playlist, false);
    return;
}

void load_preset_callback_done(bool is_hard_cut, unsigned int index, void* user_data)
{
    float randomDelay = (emscripten_random() * 30.0) + 27.0;
    projectm_set_preset_duration(app_data.projectm_engine, randomDelay);
    app_data.loading = EM_FALSE;

    // Phase 4: Shader compilation is complete (GL_LINK_STATUS == GL_TRUE was
    // confirmed inside Shader::CompileProgram before this callback was reached).
    // Signal to the transition system that the new preset is safe to blend in.
    g_presetBReady = true;
    g_presetReadyFrame = g_renderedFrameCount;

    uint32_t pos = projectm_playlist_get_position(app_data.playlist);
    char* preset_path = projectm_playlist_item(app_data.playlist, pos);
    if (preset_path)
    {
        js_update_preset_name(preset_path);
        projectm_playlist_free_string(preset_path);
    }
    return;
}

void _on_preset_switch_failed(const char* preset_filename, const char* message, void* user_data)
{
    printf("Preset switch failed (%s): %s\n", preset_filename, message);
    g_presetSwitchFailed = true;
    app_data.loading = EM_FALSE;
    js_report_preset_switch_failed(preset_filename, message);
    return;
}

void on_preset_switch_requested(bool is_hard_cut, void* user_data)
{
    // Ignore timer-driven switches while a manual preset load is compiling.
    // Without this, clicking "custom preset" can load the pick and then immediately
    // play_next() from an expired preset timer within the same frame.
    if (app_data.loading == EM_TRUE)
    {
        return;
    }
    printf("projectM is requesting a preset switch (hard_cut: %s)!\n", is_hard_cut ? "true" : "false");
    projectm_playlist_play_next(app_data.playlist, is_hard_cut);
    return;
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void add_preset_path()
{
    const char* loc = "/presets/";
    char preset_file[256];
    for (int i = 0; i <= 100; ++i)
    {
        snprintf(preset_file, sizeof(preset_file), "/presets/preset_%d.milk", i);
        projectm_playlist_add_preset(app_data.playlist, preset_file, false);
    }
    return;
}

EMSCRIPTEN_KEEPALIVE
void add_existing_vfs_presets()
{
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
    printf("Added %d existing VFS presets to playlist.\n", added);
    return;
}

EMSCRIPTEN_KEEPALIVE
void add_preset_file(const char* path)
{
    if (!app_data.playlist)
        return;
    projectm_playlist_add_preset(app_data.playlist, path, false);
    return;
}

EMSCRIPTEN_KEEPALIVE
void add_custom_milk_paths(int count)
{
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
    printf("Added %d of %d custom milk presets to playlist.\n", added, count);
    return;
}

EMSCRIPTEN_KEEPALIVE
void switch_preset()
{
    if (!app_data.playlist)
        return;
    projectm_playlist_play_next(app_data.playlist, false);
    return;
}
} // extern "C"

static void load_preset_file_impl(const char* filename, bool hard_cut)
{
    if (!pm)
    {
        return;
    }

    // Phase 4: Reset the "Preset B ready" gate so the transition compositing
    // layer does not start blending before the new preset's shaders are fully
    // compiled and linked.
    g_presetBReady = false;
    g_presetReadyFrame = g_renderedFrameCount;
    g_presetSwitchFailed = false;

    // Pause the render loop while shader compilation runs.  This prevents GL
    // state conflicts between the render call and the compile/link operations
    // that share the same WebGL context.
    app_data.loading = EM_TRUE;

    // Phase 4: Yield to the browser event loop *before* the heavy HLSL→GLSL
    // transpilation and glCompileShader/glLinkProgram calls begin.  This keeps
    // the page responsive and prevents the "unresponsive page" warning even
    // when the incoming preset has a complex shader.
    emscripten_sleep(0);

    // Phase 3: Route all preset switches through the playlist manager so that
    // the engine's built-in transition cleanup routines are always triggered
    // (dual FBO re-init, glClearColor reset, blend state isolation).
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
            // load_preset_callback_done is invoked synchronously from within
            // this call; it clears app_data.loading and sets g_presetBReady.
            projectm_playlist_set_position(app_data.playlist,
                                           static_cast<uint32_t>(foundIdx), hard_cut);
            return;
        }
        // Fall through to direct load if playlist add failed.
    }

    // Fallback: no playlist attached yet – load directly.
    projectm_load_preset_file(pm, filename, !hard_cut);

    g_presetBReady = true;
    g_presetReadyFrame = g_renderedFrameCount;
    app_data.loading = EM_FALSE;
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
    return static_cast<int>(g_renderedFrameCount);
}

EMSCRIPTEN_KEEPALIVE
int preset_switch_failed()
{
    return g_presetSwitchFailed ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int is_preset_ready(int min_frames_since_ready)
{
    if (!pm)
        return 0;
    if (app_data.loading == EM_TRUE)
        return 0;
    if (!g_presetBReady)
        return 0;
    if (g_presetSwitchFailed)
        return 0;
    const uint32_t requiredFrames = min_frames_since_ready > 0
                                        ? static_cast<uint32_t>(min_frames_since_ready)
                                        : 0u;
    return (g_renderedFrameCount - g_presetReadyFrame) >= requiredFrames ? 1 : 0;
}
} // extern "C"
