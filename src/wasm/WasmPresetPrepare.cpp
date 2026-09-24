// WasmPresetPrepare.cpp
//
// Background preset preparation: one prepare thread per WasmHost, fed by the
// playlist's preset-load hook and load_preset_file(), drained by
// render_frame(). See WasmPresetPrepare.hpp for the flow.
#include "WasmPresetPrepare.hpp"

#include "WasmHost.hpp"

#include <emscripten/eventloop.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>

#include <condition_variable>
#include <mutex>
#include <thread>
#include <utility>

static_assert(kWasmPresetPrepareThreads >= kMaxHosts,
              "Every WasmHost runs a prepare thread; PTHREAD_POOL_SIZE must pre-spawn one Worker per host");

// State shared by the host side and the prepare thread. The thread holds its
// own reference, so a queue destroyed while a job runs leaves this alive until
// the job finishes and the thread exits.
struct PresetPrepareQueue::Shared {
    std::mutex mutex;
    std::condition_variable wake;
    bool stop = false;
    uintptr_t hostHandle = 0;
    uint64_t latestGeneration = 0;                 //!< Generation of the latest Post().
    std::optional<PresetPrepareRequest> pending;   //!< Posted, not yet picked up by the thread.
    std::optional<PresetPrepareRequest> completed; //!< Run, not yet taken by the host.
};

namespace {

void FreeRequest(std::optional<PresetPrepareRequest>& request)
{
    if (request)
    {
        projectm_preset_prepare_free(request->job);
        request.reset();
    }
}

// A macrotask on the main runtime thread, with no C++ frames below it. The
// host may be gone by now (or its address reused by a new host); activation
// only takes a result the host's own queue holds, so either way this is safe.
void ActivateFromEventLoop(void* hostHandle)
{
    if (WasmHost* host = HostFromHandle(reinterpret_cast<uintptr_t>(hostHandle)))
    {
        ActivatePreparedPreset(*host);
    }
}

// Proxied to the main runtime thread by the prepare thread. It must not load
// the preset itself: a main thread blocked on a futex (a contended mutex, an
// OpenMP barrier in the middle of a frame) runs queued proxied calls from
// inside that wait (_emscripten_yield), which would re-enter the engine
// mid-render. So it only schedules a zero-delay timer; render_frame() polls
// too, so a busy render loop picks the result up without waiting for it.
void OnPreparedOnMainThread(void* hostHandle)
{
    emscripten_set_timeout(&ActivateFromEventLoop, 0.0, hostHandle);
}

void PrepareThreadMain(const std::shared_ptr<PresetPrepareQueue::Shared>& shared)
{
    std::unique_lock<std::mutex> lock(shared->mutex);
    while (true)
    {
        shared->wake.wait(lock, [&] { return shared->stop || shared->pending.has_value(); });
        if (shared->stop)
        {
            break;
        }
        if (!shared->pending.has_value())
        {
            continue; // Not reachable after the wait predicate; keeps the access below checked.
        }

        PresetPrepareRequest request = std::move(*shared->pending);
        shared->pending.reset();
        lock.unlock();

        // The expensive part: file read, parse, HLSL-to-GLSL transpile.
        projectm_preset_prepare_run(request.job);

        lock.lock();
        if (shared->stop || request.generation != shared->latestGeneration)
        {
            // Superseded or abandoned while it ran.
            projectm_preset_prepare_free(request.job);
            continue;
        }
        FreeRequest(shared->completed);
        shared->completed = std::move(request);

        const uintptr_t hostHandle = shared->hostHandle;
        lock.unlock();
        emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(),
                               &OnPreparedOnMainThread, reinterpret_cast<void*>(hostHandle));
        lock.lock();
    }

    FreeRequest(shared->pending);
    FreeRequest(shared->completed);
}

} // namespace

PresetPrepareQueue::PresetPrepareQueue(uintptr_t hostHandle)
    : m_shared(std::make_shared<Shared>())
{
    m_shared->hostHandle = hostHandle;
    // Detached: the host never waits for this thread. Joining would block the
    // main runtime thread (the browser's, in the classic topology) for as long
    // as a transpile takes.
    std::thread([shared = m_shared]() { PrepareThreadMain(shared); }).detach();
}

PresetPrepareQueue::~PresetPrepareQueue()
{
    {
        std::lock_guard<std::mutex> lock(m_shared->mutex);
        m_shared->stop = true;
        FreeRequest(m_shared->pending);
        FreeRequest(m_shared->completed);
    }
    m_shared->wake.notify_all();
}

uint64_t PresetPrepareQueue::Post(PresetPrepareRequest request)
{
    uint64_t generation = 0;
    {
        std::lock_guard<std::mutex> lock(m_shared->mutex);
        generation = ++m_shared->latestGeneration;
        request.generation = generation;
        FreeRequest(m_shared->pending);
        // A completed result is stale now too.
        FreeRequest(m_shared->completed);
        m_shared->pending = std::move(request);
    }
    m_shared->wake.notify_one();
    return generation;
}

std::optional<PresetPrepareRequest> PresetPrepareQueue::TakeCompleted()
{
    std::lock_guard<std::mutex> lock(m_shared->mutex);
    if (!m_shared->completed)
    {
        return std::nullopt;
    }
    if (m_shared->completed->generation != m_shared->latestGeneration)
    {
        FreeRequest(m_shared->completed);
        return std::nullopt;
    }
    std::optional<PresetPrepareRequest> result = std::move(m_shared->completed);
    m_shared->completed.reset();
    return result;
}

void PresetPrepareQueue::DiscardAll()
{
    std::lock_guard<std::mutex> lock(m_shared->mutex);
    ++m_shared->latestGeneration;
    FreeRequest(m_shared->pending);
    FreeRequest(m_shared->completed);
}

// =============================================================================
// Host side
// =============================================================================

void RequestPresetPrepare(WasmHost& host, const char* path, bool hardCut, std::optional<uint32_t> playlistIndex)
{
    auto& pm = host.appData.projectm_engine;
    if (pm == nullptr || host.presetPrepare == nullptr || path == nullptr)
    {
        return;
    }

    // Phase 4: Reset the "Preset B ready" gate so the transition compositing
    // layer does not start blending before the new preset has been prepared,
    // compiled and linked.
    host.presetBReady = false;
    host.presetReadyFrame = host.renderedFrameCount;
    host.presetSwitchFailed = false;
    // "A preparation is in flight": gates is_preset_ready() and timer-driven
    // switches, but no longer pauses rendering.
    host.appData.loading = EM_TRUE;

    PresetPrepareRequest request;
    // Captures the render-thread state the preparation needs (texture snapshot,
    // which shaders the transpiled-GLSL cache holds for the armed key).
    request.job = projectm_preset_prepare_begin_file(pm, path);
    request.path = path;
    request.hardCut = hardCut;
    request.playlistIndex = playlistIndex;
    host.presetPrepare->Post(std::move(request));
}

// Marks the host's newest preset as loaded: the state load_preset_callback_done()
// sets for a playlist load, for a load that did not go through the playlist.
static void MarkPresetReady(WasmHost& host)
{
    host.appData.loading = EM_FALSE;
    host.presetBReady = true;
    host.presetReadyFrame = host.renderedFrameCount;
}

void ActivatePreparedPreset(WasmHost& host)
{
    if (host.presetPrepare == nullptr)
    {
        return;
    }
    std::optional<PresetPrepareRequest> prepared = host.presetPrepare->TakeCompleted();
    if (!prepared)
    {
        return;
    }

    // Engine callbacks fired from the load (switch failed) operate on the active
    // host, and the GL work must hit this host's context.
    WasmHost* const previous = ActiveHostOrNull();
    if (previous != &host)
    {
        SetActiveHost(&host);
    }

    auto& pm = host.appData.projectm_engine;
    if (pm == nullptr)
    {
        projectm_preset_prepare_free(prepared->job);
        host.appData.loading = EM_FALSE;
    }
    else
    {
        host.presetSwitchFailed = false;
        // Instantiates and initializes the preset (GL objects, shader compile
        // and link) and starts the transition; on failure the engine raises
        // on_preset_switch_failed(), which clears `loading` and tells the page.
        projectm_load_prepared_preset(pm, prepared->job, !prepared->hardCut);

        const bool deferredSwitch = host.switchRequestDeferred;
        const bool deferredHardCut = host.deferredSwitchHardCut;
        host.switchRequestDeferred = false;

        if (!host.presetSwitchFailed)
        {
            if (prepared->playlistIndex && host.appData.playlist != nullptr)
            {
                load_preset_callback_done(prepared->hardCut, *prepared->playlistIndex, &host.appData);
            }
            else
            {
                MarkPresetReady(host);
            }
            // The load itself (GL compile and link) lands in this frame's cost;
            // keep the quality governor from reacting to it.
            host.postLoadGraceFrames = kPostLoadGraceFrames;
            ResetGovernorCounters();
        }
        else if (deferredSwitch && host.appData.playlist != nullptr)
        {
            // The engine asked for a switch while this load was in flight and was
            // told to wait. The load failed, so nothing reset its switch timer:
            // honour the request now or automatic switching stops for good.
            projectm_playlist_play_next(host.appData.playlist, deferredHardCut);
        }
    }

    if (previous != nullptr && previous != &host)
    {
        SetActiveHost(previous);
    }
}
