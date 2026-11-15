// WasmDeterminism.cpp
//
// Reproducible frames for the graphics golden-image / benchmark harness.
//
// A Milkdrop frame is a function of (preset, audio history, frame index, RNG,
// time). The harness pins the first three itself — one preset per page, a fixed
// synthetic audio schedule written into the PCM ring, a fixed frame count. This
// TU pins the other two:
//
//   * RNG — the host's engine gets its own seed (projectm_create_seeded() /
//     projectm_set_seed(), projectM-4/debug.h); the process default is left alone.
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

#include <optional>

#include <projectM-4/debug.h>

// Every switch here is per host (WasmHost): the shared main loop renders every
// started host once per tick, and a harness that pins one engine must leave
// its sibling alone (pm_set_host_deterministic_seed/clock()). The compat names
// set_deterministic_seed/clock() keep their pre-ABI-v2 meaning, "every engine
// in the Module": they set every live host and the defaults below, which each
// host created afterwards starts from (InitHostDeterminism()).
namespace {

void ResetVirtualClock(WasmHost& host)
{
    host.deterministicFrameIndex = 0;
    host.virtualNowMs = 0.0;
}

double MsPerFrame(double fps)
{
    return (fps > 0.0) ? (1000.0 / fps) : (1000.0 / 60.0);
}

// What set_deterministic_seed/clock() asked of every engine created from now
// on. Page configuration, like the render-path overrides: it is read when a
// host is allocated and never reaches a host that already exists.
struct PageDeterminism {
    std::optional<uint32_t> seed;
    bool clock = false;
    double msPerFrame = 1000.0 / 60.0;
};
PageDeterminism g_pageDeterminism;

template<typename Fn>
void ForEachHost(Fn&& fn)
{
    for (int i = 0; i < HostSlotCount(); ++i)
    {
        if (WasmHost* host = HostSlot(i))
        {
            fn(*host);
        }
    }
}

} // namespace

void InitHostDeterminism(WasmHost& host)
{
    host.deterministicSeed = g_pageDeterminism.seed;
    host.deterministicClock = g_pageDeterminism.clock;
    host.msPerFrame = g_pageDeterminism.msPerFrame;
    ResetVirtualClock(host);
}

double WasmNow(const WasmHost& host)
{
    if (!host.deterministicClock)
    {
        return emscripten_get_now();
    }
    return host.virtualNowMs;
}

void DeterministicFrameTick(WasmHost& H)
{
    auto& pm = H.appData.projectm_engine;
    if (!H.deterministicClock)
    {
        return;
    }
    // Frame N is defined to happen at N / fps seconds. Set the clock before the
    // frame renders so the engine's per-frame evaluation and this TU's own
    // WasmNow() readers agree on when "now" is for this frame.
    H.virtualNowMs = static_cast<double>(H.deterministicFrameIndex) * H.msPerFrame;
    if (pm != nullptr)
    {
        projectm_set_frame_time(pm, H.virtualNowMs / 1000.0);
    }
    H.deterministicFrameIndex++;
}

projectm_handle CreateHostEngine(const WasmHost& host)
{
    return host.deterministicSeed ? projectm_create_seeded(*host.deterministicSeed) : projectm_create();
}

void ApplyDeterministicClock(WasmHost& host)
{
    if (host.appData.projectm_engine != nullptr && host.deterministicClock)
    {
        projectm_set_frame_time(host.appData.projectm_engine, 0.0);
    }
}

namespace WasmApi {

/**
 * Pins this host's engine's RNG (projectm_set_seed(), so other engines in the
 * Module keep their own). On a running engine it covers what is drawn from
 * then on; an engine created later (init(), context loss, rebind) is created
 * with the seed (projectm_create_seeded()), which also covers what it draws
 * while it is constructed.
 */
void set_host_deterministic_seed(WasmHost& H, bool enabled, uint32_t seed)
{
    auto& pm = H.appData.projectm_engine;
    H.deterministicSeed = enabled ? std::optional<uint32_t>(seed) : std::nullopt;
    if (pm == nullptr)
    {
        return;
    }
    if (enabled)
    {
        projectm_set_seed(pm, seed);
    }
    else
    {
        projectm_clear_seed(pm);
    }
}

/**
 * Compat: every engine in the Module, the live ones and each one created
 * afterwards (set it before init() / create_host*() to cover engine creation).
 */
void set_deterministic_seed(bool enabled, uint32_t seed)
{
    g_pageDeterminism.seed = enabled ? std::optional<uint32_t>(seed) : std::nullopt;
    ForEachHost([&](WasmHost& host) { set_host_deterministic_seed(host, enabled, seed); });
}

bool is_deterministic_seed(WasmHost& H)
{
    return H.deterministicSeed.has_value();
}

/**
 * Switches this host and its engine onto a virtual clock advancing 1/fps per
 * frame it renders, restarting its frame count at 0. Disabling hands the
 * engine back to its own system clock (projectm_set_frame_time() < 0). Holds
 * across engine re-creation.
 */
void set_host_deterministic_clock(WasmHost& H, bool enabled, double fps)
{
    H.deterministicClock = enabled;
    if (enabled)
    {
        H.msPerFrame = MsPerFrame(fps);
    }
    ResetVirtualClock(H);
    if (H.appData.projectm_engine != nullptr)
    {
        projectm_set_frame_time(H.appData.projectm_engine, enabled ? 0.0 : -1.0);
    }
}

/** Compat: every engine in the Module, the live ones and each one created afterwards. */
void set_deterministic_clock(bool enabled, double fps)
{
    g_pageDeterminism.clock = enabled;
    if (enabled)
    {
        g_pageDeterminism.msPerFrame = MsPerFrame(fps);
    }
    ForEachHost([&](WasmHost& host) { set_host_deterministic_clock(host, enabled, fps); });
}

bool is_deterministic_clock(WasmHost& H)
{
    return H.deterministicClock;
}

/** The host's virtual clock reading, in milliseconds. Real time when not enabled. */
double deterministic_now_ms(WasmHost& H)
{
    return WasmNow(H);
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
void set_render_loop_paused(bool paused)
{
    if (paused)
    {
        emscripten_pause_main_loop();
    }
    else
    {
        emscripten_resume_main_loop();
    }
}

/** Frames the host has ticked since the virtual clock was last (re)enabled. */
uint32_t deterministic_frame_index(WasmHost& H)
{
    return H.deterministicFrameIndex;
}

} // namespace WasmApi
