// WasmLiveInput.cpp
//
// Live input for the browser host (projectM-4/live_input.h, docs/LIVE_INPUT.md):
// camera or video frames into textures presets sample by name, and controller
// values (MIDI, OSC, sliders) into per-frame variables.
//
//   * texture_slot_register(name, width, height): create or resize a live texture
//     on the active host and its staging buffer on the WASM heap.
//   * texture_slot_buffer(name, bytes): where the page writes the next frame
//     (RGBA8, top row first), or 0 when `bytes` is not that slot's size — so a
//     page that lost track of a resize cannot write past the buffer.
//   * texture_slot_commit(name): the frame in the buffer is complete. The next
//     render_frame() uploads it, once, however many frames were committed since.
//   * texture_slot_unregister(name).
//   * eval_set(name, value) / eval_clear(name): projectm_eval_set() and
//     projectm_eval_clear() on the active host ("" clears every value).
//
// No pixel crosses the WASM boundary as an argument and nothing allocates per
// frame: the page copies into the staging buffer with HEAPU8.set(), the same
// discipline as the PCM ring. Everything is per host and kept across engine
// re-creation (context loss, rebind), like EngineSettings.

#include "WasmHost.hpp"

#include <cctype>

namespace {

// Live texture and variable names are case-insensitive in the engine; the host's
// copies are keyed the same way.
auto SlotName(const char* name) -> std::string
{
    std::string lower(name);
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return lower;
}

} // namespace

void UploadLiveTextures(WasmHost& host)
{
    projectm_handle pm = host.appData.projectm_engine;
    if (pm == nullptr)
    {
        return;
    }
    for (auto& [name, slot] : host.liveTextures)
    {
        if (!slot.dirty)
        {
            continue;
        }
        slot.dirty = false;
        projectm_texture_slot_update(pm, name.c_str(), slot.staging.data(), slot.staging.size());
    }
}

void ReapplyLiveInput(WasmHost& host)
{
    projectm_handle pm = host.appData.projectm_engine;
    if (pm == nullptr)
    {
        return;
    }
    for (auto& [name, slot] : host.liveTextures)
    {
        if (projectm_texture_slot_register(pm, name.c_str(), slot.width, slot.height))
        {
            // The new engine's texture starts black; the next frame shows the last one.
            slot.dirty = true;
        }
    }
    for (const auto& [name, value] : host.hostVariables)
    {
        projectm_eval_set(pm, name.c_str(), value);
    }
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int texture_slot_register(const char* name, int width, int height)
{
    WasmHost& H = Host();
    if (H.appData.projectm_engine == nullptr || name == nullptr)
    {
        return 0;
    }
    if (!projectm_texture_slot_register(H.appData.projectm_engine, name, width, height))
    {
        return 0;
    }
    auto& slot = H.liveTextures[SlotName(name)];
    if (slot.width != width || slot.height != height)
    {
        // The engine cleared its texture to black at the new size; so does this copy.
        slot.width = width;
        slot.height = height;
        slot.staging.assign(static_cast<size_t>(width) * static_cast<size_t>(height) * 4, 0);
        slot.dirty = false;
    }
    return 1;
}

EMSCRIPTEN_KEEPALIVE
uintptr_t texture_slot_buffer(const char* name, int bytes)
{
    WasmHost& H = Host();
    if (name == nullptr)
    {
        return 0;
    }
    auto const slot = H.liveTextures.find(SlotName(name));
    if (bytes <= 0 || slot == H.liveTextures.end() || slot->second.staging.size() != static_cast<size_t>(bytes))
    {
        return 0;
    }
    return reinterpret_cast<uintptr_t>(slot->second.staging.data());
}

EMSCRIPTEN_KEEPALIVE
int texture_slot_commit(const char* name)
{
    WasmHost& H = Host();
    if (name == nullptr)
    {
        return 0;
    }
    auto const slot = H.liveTextures.find(SlotName(name));
    if (slot == H.liveTextures.end())
    {
        return 0;
    }
    slot->second.dirty = true;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int texture_slot_unregister(const char* name)
{
    WasmHost& H = Host();
    if (name == nullptr || H.liveTextures.erase(SlotName(name)) == 0)
    {
        return 0;
    }
    if (H.appData.projectm_engine != nullptr)
    {
        projectm_texture_slot_unregister(H.appData.projectm_engine, name);
    }
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int eval_set(const char* name, double value)
{
    WasmHost& H = Host();
    if (H.appData.projectm_engine == nullptr || name == nullptr)
    {
        return 0;
    }
    if (!projectm_eval_set(H.appData.projectm_engine, name, value))
    {
        return 0;
    }
    H.hostVariables[SlotName(name)] = value;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int eval_clear(const char* name)
{
    WasmHost& H = Host();
    bool const all = name == nullptr || name[0] == '\0';
    bool removed = false;
    if (all)
    {
        removed = !H.hostVariables.empty();
        H.hostVariables.clear();
    }
    else
    {
        removed = H.hostVariables.erase(SlotName(name)) > 0;
    }
    if (H.appData.projectm_engine != nullptr)
    {
        projectm_eval_clear(H.appData.projectm_engine, all ? nullptr : name);
    }
    return removed ? 1 : 0;
}

} // extern "C"
