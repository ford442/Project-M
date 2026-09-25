// WasmPresetPrepare.hpp
//
// Per-host background preset preparation.
//
// A preset load has a CPU half (read + parse the .milk file, transpile its HLSL
// shaders to GLSL) and a GL half (create the preset's GL objects, compile and
// link). libprojectM splits the two (projectM-4/preset_prepare.h); this runs
// the CPU half of every load on a dedicated pthread per WasmHost, so the render
// loop keeps drawing the current preset instead of stopping for the transpile.
//
//   main runtime thread                     prepare thread
//   -------------------                     --------------
//   RequestPresetPrepare()
//     begin job, Post() ------------------> Run the job
//                                            park the result, wake main -----+
//   ActivatePreparedPreset()  <-- render_frame() top, or the wake-up  <-------+
//     TakeCompleted(), load it into the engine, start the transition
//
// The queue holds one pending request and one completed result; a newer request
// replaces a pending one, and a result is only activated if nothing newer has
// been posted since (latest wins). Nothing on the prepare thread touches GL, the
// engine, the playlist, JS or the file system: the preset file is read on the
// main runtime thread when the request is made.
//
// See docs/EMSCRIPTEN.md ("Preset loading").
#pragma once

#include <projectM-4/preset_prepare.h>

#include <cstdint>
#include <memory>
#include <optional>
#include <string>

struct WasmHost;

// What the host needs to finish a load once its job has run.
struct PresetPrepareRequest {
    uint64_t generation = 0;                          //!< Post() order; only the latest is activated.
    projectm_preset_prepare_job_handle job = nullptr; //!< The libprojectM job (owned by whoever holds the request).
    std::string path;                                 //!< Preset path, for failure reports.
    bool hardCut = false;                             //!< Hard cut instead of a soft transition.
    std::optional<uint32_t> playlistIndex;            //!< Playlist index the load was for, if any.
};

// A switch the engine has accepted but not made yet: with KHR_parallel_shader_compile,
// projectm_load_prepared_preset() leaves the new preset's programs linking and the
// engine keeps rendering the current one until they are done.
struct PendingPresetSwitch {
    bool hardCut = false;
    std::optional<uint32_t> playlistIndex;
};

// One host's prepare thread and its single-slot inbox/outbox.
class PresetPrepareQueue
{
public:
    // Starts the prepare thread. `hostHandle` identifies the host to wake on the
    // main runtime thread when a result is ready (see HostFromHandle()).
    explicit PresetPrepareQueue(uintptr_t hostHandle);

    // Stops the thread without waiting for it: a job it is running finishes on
    // its own and is freed there. Frees queued jobs.
    ~PresetPrepareQueue();

    PresetPrepareQueue(const PresetPrepareQueue&) = delete;
    PresetPrepareQueue& operator=(const PresetPrepareQueue&) = delete;

    // Queues `request` (taking ownership of its job), replacing a pending request
    // that has not started. Returns the request's generation.
    uint64_t Post(PresetPrepareRequest request);

    // Removes and returns the completed result if it is the latest posted
    // request; frees and drops it if something newer has been posted since.
    std::optional<PresetPrepareRequest> TakeCompleted();

    // Frees queued and completed jobs and makes an in-flight one's result stale,
    // e.g. because the engine it was for has been destroyed.
    void DiscardAll();

    // State shared with the prepare thread (defined in WasmPresetPrepare.cpp).
    struct Shared;

private:
    std::shared_ptr<Shared> m_shared;
};

// Main runtime thread: begins a preparation of `path` for the active host and
// posts it. The current preset keeps rendering until ActivatePreparedPreset()
// switches to the new one.
void RequestPresetPrepare(WasmHost& host, const char* path, bool hardCut, std::optional<uint32_t> playlistIndex);

// Main runtime thread: if the host's latest preparation has finished, loads it
// into the engine (under the host's own GL context), and completes the switch
// once the engine has made it (after its shader links, where those run in the
// background). Cheap when nothing is ready; render_frame() calls it every frame.
void ActivatePreparedPreset(WasmHost& host);
