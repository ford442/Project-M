// WasmDeterminism.cpp
//
// Reproducible frames for the graphics golden-image / benchmark harness.
//
// A Milkdrop frame is a function of (preset, audio history, frame index, RNG,
// time). The harness pins the first three itself — one preset per page, a fixed
// synthetic audio schedule written into the PCM ring, a fixed frame count. This
// TU pins the other two:
//
//   * RNG — delegated to libprojectM's process-global seed source via
//     projectm_set_deterministic_seed() (projectM-4/debug.h).
//   * Time — a virtual clock. `set_deterministic_clock(1, fps)` makes frame N
//     happen at exactly N/fps seconds: the engine is told so through
//     projectm_set_frame_time(), and the WASM host's own time base (transition
//     blend progress, dual-FBO idle release) reads WasmNow() instead of
//     emscripten_get_now().
//
// The two are deliberately separate switches, because a benchmark run wants one
// and not the other. Golden-image capture wants both: identical pixels. A perf
// run wants the seed pinned (so it renders the same work) but the *real* clock,
// since a virtual clock would make measured frame times meaningless — and the
// governor, which decides quality tiers from how long a frame actually took,
// would see a stream of impossible frames and step quality the wrong way.
//
// For that reason the governor's own measurement in renderLoop() stays on
// emscripten_get_now() unconditionally. It measures wall-clock cost, which the
// virtual clock is not.
//
// See docs/GRAPHICS_BENCHMARK_HARNESS.md.

#include "WasmHost.hpp"

#include <projectM-4/debug.h>

// The on/off switches and the frame period are process-wide harness settings.
// The frame index and the virtual "now" are per host (WasmHost): the shared
// main loop renders every started host once per tick, so a single index
// advanced once per host per tick and two engines each saw every other frame.
namespace {

bool g_deterministicClock{false};
bool g_deterministicSeed{false};
double g_msPerFrame{1000.0 / 60.0};

void ResetVirtualClock(WasmHost& host)
{
    host.deterministicFrameIndex = 0;
    host.virtualNowMs = 0.0;
}

} // namespace

double WasmNow()
{
    if (!g_deterministicClock)
    {
        return emscripten_get_now();
    }
    const WasmHost* active = ActiveHostOrNull();
    return active != nullptr ? active->virtualNowMs : 0.0;
}

void DeterministicFrameTick()
{
    WasmHost& H = Host();
    auto& pm = H.appData.projectm_engine;
    if (!g_deterministicClock)
    {
        return;
    }
    // Frame N is defined to happen at N / fps seconds. Set the clock before the
    // frame renders so the engine's per-frame evaluation and this TU's own
    // WasmNow() readers agree on when "now" is for this frame.
    H.virtualNowMs = static_cast<double>(H.deterministicFrameIndex) * g_msPerFrame;
    if (pm != nullptr)
    {
        projectm_set_frame_time(pm, H.virtualNowMs / 1000.0);
    }
    H.deterministicFrameIndex++;
}

extern "C" {

/**
 * Pins libprojectM's RNG. Safe to call before or after init(); the seed policy
 * is process-global and survives engine re-creation.
 */
EMSCRIPTEN_KEEPALIVE
void set_deterministic_seed(int enabled, unsigned int seed)
{
    g_deterministicSeed = (enabled != 0);
    if (g_deterministicSeed)
    {
        projectm_set_deterministic_seed(static_cast<uint32_t>(seed));
    }
    else
    {
        projectm_clear_deterministic_seed();
    }
}

EMSCRIPTEN_KEEPALIVE
int is_deterministic_seed()
{
    return g_deterministicSeed ? 1 : 0;
}

/**
 * Switches every host and its engine onto a virtual clock advancing 1/fps per
 * frame that host renders, restarting each host's frame count at 0. Disabling
 * hands the engines back to their own system clock (projectm_set_frame_time() < 0).
 */
EMSCRIPTEN_KEEPALIVE
void set_deterministic_clock(int enabled, double fps)
{
    g_deterministicClock = (enabled != 0);
    if (g_deterministicClock)
    {
        g_msPerFrame = (fps > 0.0) ? (1000.0 / fps) : (1000.0 / 60.0);
    }
    const auto reset = [](WasmHost& host) {
        ResetVirtualClock(host);
        if (host.appData.projectm_engine != nullptr)
        {
            projectm_set_frame_time(host.appData.projectm_engine, g_deterministicClock ? 0.0 : -1.0);
        }
    };
    const int slots = HostSlotCount();
    for (int i = 0; i < slots; ++i)
    {
        if (WasmHost* host = HostSlot(i))
        {
            reset(*host);
        }
    }
    // The harness may call this before any host exists; Host() then brings up
    // the compat default, which the loop above could not see.
    reset(Host());
}

EMSCRIPTEN_KEEPALIVE
int is_deterministic_clock()
{
    return g_deterministicClock ? 1 : 0;
}

/** The virtual clock reading, in milliseconds. Real time when not enabled. */
EMSCRIPTEN_KEEPALIVE
double deterministic_now_ms()
{
    return WasmNow();
}

/**
 * Pauses or resumes the Emscripten main loop registered by start_render().
 *
 * A deterministic capture cannot share the frame schedule with requestAnimationFrame:
 * the browser decides when RAF fires, so "frame 300" would be a different amount
 * of accumulated feedback on every run and on every machine. The harness pauses
 * the loop straight after start_render() and then drives render_frame() itself,
 * exactly once per audio block, which is what makes frame N a function of N.
 *
 * Perf runs do the opposite and keep the loop: they are measuring what the real
 * RAF-driven pipeline costs.
 */
EMSCRIPTEN_KEEPALIVE
void set_render_loop_paused(int paused)
{
    if (paused != 0)
    {
        emscripten_pause_main_loop();
    }
    else
    {
        emscripten_resume_main_loop();
    }
}

/** Frames the active host has ticked since the virtual clock was last (re)enabled. */
EMSCRIPTEN_KEEPALIVE
unsigned int deterministic_frame_index()
{
    return Host().deterministicFrameIndex;
}

} // extern "C"
