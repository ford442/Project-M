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

#include "ProjectMWasmInternal.hpp"

#include <projectM-4/debug.h>

namespace {

bool g_deterministicClock{false};
bool g_deterministicSeed{false};
double g_virtualNowMs{0.0};
double g_msPerFrame{1000.0 / 60.0};
uint32_t g_deterministicFrameIndex{0};

} // namespace

double WasmNow()
{
    return g_deterministicClock ? g_virtualNowMs : emscripten_get_now();
}

void DeterministicFrameTick()
{
    if (!g_deterministicClock)
    {
        return;
    }
    // Frame N is defined to happen at N / fps seconds. Set the clock before the
    // frame renders so the engine's per-frame evaluation and this TU's own
    // WasmNow() readers agree on when "now" is for this frame.
    g_virtualNowMs = static_cast<double>(g_deterministicFrameIndex) * g_msPerFrame;
    if (pm != nullptr)
    {
        projectm_set_frame_time(pm, g_virtualNowMs / 1000.0);
    }
    g_deterministicFrameIndex++;
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
 * Switches the host and engine onto a virtual clock advancing 1/fps per
 * rendered frame, restarting the frame count at 0. Disabling hands the engine
 * back to its own system clock (projectm_set_frame_time() < 0).
 */
EMSCRIPTEN_KEEPALIVE
void set_deterministic_clock(int enabled, double fps)
{
    g_deterministicClock = (enabled != 0);
    g_deterministicFrameIndex = 0;
    g_virtualNowMs = 0.0;
    if (g_deterministicClock)
    {
        g_msPerFrame = (fps > 0.0) ? (1000.0 / fps) : (1000.0 / 60.0);
        if (pm != nullptr)
        {
            projectm_set_frame_time(pm, 0.0);
        }
    }
    else if (pm != nullptr)
    {
        projectm_set_frame_time(pm, -1.0);
    }
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

/** Frames ticked since the virtual clock was last (re)enabled. */
EMSCRIPTEN_KEEPALIVE
unsigned int deterministic_frame_index()
{
    return g_deterministicFrameIndex;
}

} // extern "C"
