// WasmPerfGovernor.cpp
//
// Performance HUD instrumentation (CPU perf timers + WebGL GPU timer queries)
// and the adaptive quality governor that trades per-pixel mesh resolution for
// frame-rate stability. Also hosts the OpenMP introspection exports.
#include "ProjectMWasmInternal.hpp"

// =============================================================================
// Perf HUD / Benchmark support (see docs/PERFORMANCE.md)
//
// CPU-side per-frame timings come from libprojectM's optional perf timer API
// (projectm_perf.h). GPU timing uses the EXT_disjoint_timer_query_webgl2
// extension where available. Both are no-ops unless set_perf_hud(1) was
// called, so there is no overhead in normal use.
// =============================================================================

bool g_perfHudEnabled = false; //!< Whether set_perf_hud(1) has been called.

// Begins a GPU timer query for the upcoming render_frame() call, if the
// EXT_disjoint_timer_query_webgl2 extension is available. No-op otherwise.
EM_JS(void, js_perf_gpu_begin_frame, (), {
    if (!Module.__pmPerfGpu) {
        const ext = GLctx.getExtension('EXT_disjoint_timer_query_webgl2');
        Module.__pmPerfGpu = { ext: ext, queries: [], lastMs: -1 };
    }
    const gpu = Module.__pmPerfGpu;
    if (!gpu.ext) {
        return;
    }
    const query = GLctx.createQuery();
    GLctx.beginQuery(gpu.ext.TIME_ELAPSED_EXT, query);
    gpu.queries.push(query);
});

// Ends the GPU timer query started by js_perf_gpu_begin_frame() and polls
// previously submitted queries (without blocking) for completed results.
EM_JS(void, js_perf_gpu_end_frame, (), {
    const gpu = Module.__pmPerfGpu;
    if (!gpu || !gpu.ext) {
        return;
    }
    GLctx.endQuery(gpu.ext.TIME_ELAPSED_EXT);
    // GPU timer queries complete asynchronously, often a frame or two later.
    while (gpu.queries.length > 0) {
        const oldest = gpu.queries[0];
        if (!GLctx.getQueryParameter(oldest, GLctx.QUERY_RESULT_AVAILABLE)) {
            break;
        }
        const disjoint = GLctx.getParameter(gpu.ext.GPU_DISJOINT_EXT);
        if (!disjoint) {
            const ns = GLctx.getQueryParameter(oldest, GLctx.QUERY_RESULT);
            gpu.lastMs = ns / 1e6;
        }
        GLctx.deleteQuery(oldest);
        gpu.queries.shift();
    }
    // Don't let unresolved queries pile up if results never arrive.
    while (gpu.queries.length > 8) {
        GLctx.deleteQuery(gpu.queries.shift());
    }
});

// Returns the most recently completed GPU frame time in milliseconds, or -1
// if the timer query extension is unavailable or no result has arrived yet.
EM_JS(double, js_perf_gpu_get_last_ms, (), {
    return (Module.__pmPerfGpu && Module.__pmPerfGpu.ext) ? Module.__pmPerfGpu.lastMs : -1;
});

// Notifies the host page that perf timer collection was enabled/disabled, so
// it can show or hide the on-screen HUD. See html/projectm-perf.js.
EM_JS(void, js_perf_hud_set_enabled, (int enabled), {
    if (typeof window.pmSetPerfHudEnabled === 'function') {
        window.pmSetPerfHudEnabled(!!enabled);
    }
});

// Reports one frame's worth of CPU/GPU timings to the host page. If
// window.pmOnPerfFrame(stats) is defined (see html/projectm-perf.js), it is
// called with a stats object so the HUD and/or benchmark harness can consume it.
EM_JS(void, js_perf_report_frame, (
    double totalMs, double audioMs, double perFrameEvalMs, double perPixelEvalMs,
    double blurMs, double waveformsShapesMs, double compositeMs, double gpuMs, double fps
), {
    if (typeof window.pmOnPerfFrame === 'function') {
        window.pmOnPerfFrame({
            totalMs: totalMs,
            audioMs: audioMs,
            perFrameEvalMs: perFrameEvalMs,
            perPixelEvalMs: perPixelEvalMs,
            blurMs: blurMs,
            waveformsShapesMs: waveformsShapesMs,
            compositeMs: compositeMs,
            gpuMs: gpuMs,
            fps: fps,
        });
    }
});

// =============================================================================
// Adaptive quality governor v2 (see docs/PERFORMANCE.md, issue #178)
//
// Original Milkdrop holds 60 FPS and lets quality settings absorb load
// instead of letting the frame rate drop. v1 only stepped per-pixel mesh
// resolution between two tiers. v2 steps three fill-cost axes together, in
// lockstep, per tier, because mesh-only stepping does not recover FPS on
// fill-bound (fullscreen-pass-heavy) devices:
//
//   - Per-pixel mesh resolution (perPixelEvalMs cost)
//   - Blur level cap (blurMs / fullscreen blur pass cost, see BlurTexture)
//   - Internal render scale (gpuMs fill-rate cost: canvas backing-store
//     resolution vs. its unchanged CSS display size — see
//     html/projectm-fps-governor.js / syncModuleSize() for how the JS host
//     applies this by shrinking canvas.width/height while leaving
//     canvas.style.width/height alone, letting the browser's own
//     bitmap-to-CSS-box scaling do the "present upscale" for free)
//
// Tuning (see PR description for rationale):
//   - Budget = 1000 / targetFps ms (default targetFps = 60 -> ~16.7ms).
//   - Step DOWN a tier after kOverBudgetFrameThreshold consecutive frames
//     that take longer than kOverBudgetRatio * budget.
//   - Step UP a tier after kUnderBudgetFrameThreshold consecutive frames
//     that take less than kUnderBudgetRatio * budget.
//   - Frames rendered while a preset is loading (app_data.loading) are
//     skipped entirely (renderLoop returns early), and the
//     kPostLoadGraceFrames frames immediately after a load completes are
//     excluded from the over/under-budget counters, so a single slow
//     ASYNCIFY preset compile cannot trigger a permanent downgrade.
// =============================================================================

static bool g_governorEnabled = true; //!< Whether the adaptive quality governor is active.
static int g_targetFps = 60;          //!< Frame budget reference, set via set_target_fps().
static int g_qualityTier = 0;         //!< 0 = high, 1 = regular, 2 = low. See kQualityTiers.
static bool g_qualityTierInitialized = false;

static int g_overBudgetFrames = 0;
static int g_underBudgetFrames = 0;
bool g_wasLoading = false;
int g_postLoadGraceFrames = 0;

constexpr double kOverBudgetRatio = 1.3;        //!< Step down once frame time exceeds 1.3x budget...
constexpr int kOverBudgetFrameThreshold = 15;   //!< ...for this many consecutive frames (~0.25s @ 60fps).
constexpr double kUnderBudgetRatio = 0.8;       //!< Step back up once frame time is under 0.8x budget...
constexpr int kUnderBudgetFrameThreshold = 90;  //!< ...for this many consecutive frames (~1.5s @ 60fps).
constexpr int kMaxQualityTier = 2;              //!< Highest (lowest-quality) tier index.

struct QualityTierSettings
{
    size_t meshWidth;
    size_t meshHeight;
    int32_t maxBlurLevel;     //!< -1 = uncapped, else BlurTexture::BlurLevel (0-3). See ProjectM::SetMaxBlurLevel().
    double renderScale;       //!< Internal render scale applied by the JS host (1.0 = full resolution).
    double blurResolutionScale; //!< Extra blur-texture downscale (issue #177 item 3), see ProjectM::SetBlurResolutionScale().
};

// Ordered high -> low quality. Mesh, blur cap, render scale, and blur resolution scale
// step together per tier so a single "reduce quality" decision cuts cost on all fill/
// eval axes at once, matching how the governor's hysteresis (see UpdateQualityGovernor())
// already treats tier transitions as a single atomic step.
//
// blurResolutionScale is intentionally more aggressive than renderScale at the same
// tier: blur is a low-frequency effect, so it tolerates more downscaling than the main
// scene without a visible quality loss (issue #177's "downscale early blur levels more
// aggressively" coordination point with this governor).
constexpr QualityTierSettings kQualityTiers[kMaxQualityTier + 1] = {
    {80, 60, -1, 1.00, 1.00}, // tier 0: high    - uncapped blur, full resolution
    {64, 48,  2, 0.75, 0.60}, // tier 1: regular - cap at Blur2, 0.75x render / 0.6x blur-texture scale
    {48, 36,  1, 0.50, 0.40}, // tier 2: low     - cap at Blur1, 0.5x render / 0.4x blur-texture scale
};

// Notifies the host page when the governor changes the quality tier, so the
// UI can reflect it (e.g. show a "reduced quality" indicator).
EM_JS(void, js_governor_report_tier, (int tier), {
    if (typeof window.pmOnGovernorTierChange === 'function') {
        window.pmOnGovernorTierChange(tier);
    }
});

// Notifies the host page of the tier's internal render scale (1.0/0.75/0.5), so
// it can shrink the canvas backing store while keeping its CSS display size fixed
// (see html/projectm-fps-governor.js and syncModuleSize() in projectm-core.html).
// This is a *push* notification; get_governor_render_scale() below is the pull
// counterpart for late-binding hosts.
EM_JS(void, js_governor_report_render_scale, (double scale), {
    if (typeof window.pmOnGovernorRenderScaleChange === 'function') {
        window.pmOnGovernorRenderScaleChange(scale);
    }
});

// Notifies the host page of the tier's blur-level cap, mainly for HUD/telemetry.
// The actual clamping is applied purely in C++ via ProjectM::SetMaxBlurLevel(); no
// JS action is required for the cap to take effect.
EM_JS(void, js_governor_report_blur_cap, (int cap), {
    if (typeof window.pmOnGovernorBlurCapChange === 'function') {
        window.pmOnGovernorBlurCapChange(cap);
    }
});

static void ApplyQualityTier(int tier)
{
    tier = std::max(0, std::min(kMaxQualityTier, tier));
    g_qualityTier = tier;
    const QualityTierSettings& settings = kQualityTiers[tier];
    projectm_set_mesh_size(pm, settings.meshWidth, settings.meshHeight);
    projectm_set_max_blur_level(pm, settings.maxBlurLevel);
    projectm_set_blur_resolution_scale(pm, static_cast<float>(settings.blurResolutionScale));
    js_governor_report_tier(tier);
    js_governor_report_render_scale(settings.renderScale);
    js_governor_report_blur_cap(settings.maxBlurLevel);
}

// Resets the consecutive over/under-budget frame counters. Called whenever
// the governor's configuration changes or a tier transition happens, so a
// single step doesn't immediately trigger another one based on stale counts.
void ResetGovernorCounters()
{
    g_overBudgetFrames = 0;
    g_underBudgetFrames = 0;
}

// Evaluates one frame's wall-clock time against the budget and steps the
// quality tier up or down if warranted. No-op if the governor is disabled or
// the frame falls within the post-load grace period.
void UpdateQualityGovernor(double frameMs)
{
    if (!g_qualityTierInitialized)
    {
        size_t width = 0;
        size_t height = 0;
        projectm_get_mesh_size(pm, &width, &height);
        // Find the lowest tier whose mesh width is still >= the current mesh width,
        // so startup syncs to whatever html/projectm-mesh-quality.js already applied
        // (tiers are ordered high -> low, so this picks the first tier at or below it).
        g_qualityTier = 0;
        for (int tier = kMaxQualityTier; tier >= 0; tier--)
        {
            if (width <= kQualityTiers[tier].meshWidth)
            {
                g_qualityTier = tier;
                break;
            }
        }
        g_qualityTierInitialized = true;
    }

    if (g_postLoadGraceFrames > 0)
    {
        g_postLoadGraceFrames--;
        return;
    }

    if (!g_governorEnabled)
    {
        return;
    }

    const double budgetMs = 1000.0 / static_cast<double>(g_targetFps > 0 ? g_targetFps : 60);

    if (frameMs > budgetMs * kOverBudgetRatio)
    {
        g_overBudgetFrames++;
        g_underBudgetFrames = 0;
    }
    else if (frameMs < budgetMs * kUnderBudgetRatio)
    {
        g_underBudgetFrames++;
        g_overBudgetFrames = 0;
    }
    else
    {
        g_overBudgetFrames = 0;
        g_underBudgetFrames = 0;
    }

    if (g_overBudgetFrames >= kOverBudgetFrameThreshold && g_qualityTier < kMaxQualityTier)
    {
        ApplyQualityTier(g_qualityTier + 1);
        ResetGovernorCounters();
    }
    else if (g_underBudgetFrames >= kUnderBudgetFrameThreshold && g_qualityTier > 0)
    {
        ApplyQualityTier(g_qualityTier - 1);
        ResetGovernorCounters();
    }
}

extern "C" {
// Sets the target FPS used both as the preset "fps" hint (projectm_set_fps)
// and as the adaptive quality governor's frame budget reference
// (1000 / target_fps). See html/projectm-fps-governor.js.
EMSCRIPTEN_KEEPALIVE
void set_target_fps(int fps) {
if (fps <= 0) {
fps = 60;
}
g_targetFps = fps;
if (pm) {
projectm_set_fps(pm, fps);
}
ResetGovernorCounters();
return;
}

// Enables/disables the adaptive quality governor (see UpdateQualityGovernor
// above). Disabling does not change the current quality tier, it just stops
// further automatic adjustments.
EMSCRIPTEN_KEEPALIVE
void set_quality_governor(int enabled) {
g_governorEnabled = enabled != 0;
ResetGovernorCounters();
return;
}

// Returns the governor's current quality tier (0 = high/80x60, 1 = regular/64x48,
// 2 = low/48x36). See kQualityTiers.
EMSCRIPTEN_KEEPALIVE
int get_quality_tier() {
return g_qualityTier;
}

// Returns the current tier's internal render scale (1.0/0.75/0.5). Pull
// counterpart to the js_governor_report_render_scale() push notification, for
// hosts that bind pmOnGovernorRenderScaleChange after the governor already
// initialized its starting tier.
EMSCRIPTEN_KEEPALIVE
double get_governor_render_scale() {
return kQualityTiers[std::max(0, std::min(kMaxQualityTier, g_qualityTier))].renderScale;
}

// Returns the current tier's blur-level cap (-1 = uncapped, else 0-3). See
// ProjectM::MaxBlurLevel().
EMSCRIPTEN_KEEPALIVE
int get_governor_blur_cap() {
return kQualityTiers[std::max(0, std::min(kMaxQualityTier, g_qualityTier))].maxBlurLevel;
}

// Toggles the frame-time profiling HUD/benchmark instrumentation. When
// enabled, CPU timers (libprojectM's projectm_perf API) and, if available,
// a WebGL GPU timer query are collected each frame and reported to the host
// page via js_perf_report_frame()/window.pmOnPerfFrame. See
// docs/PERFORMANCE.md and html/projectm-perf.js.
EMSCRIPTEN_KEEPALIVE
void set_perf_hud(int enabled) {
g_perfHudEnabled = enabled != 0;
projectm_perf_set_enabled(g_perfHudEnabled);
js_perf_hud_set_enabled(enabled);
return;
}

// OpenMP introspection for benchmark reports and runtime verification.
// See docs/PERFORMANCE.md and projectm_perf_get_openmp_info().
EMSCRIPTEN_KEEPALIVE
int get_omp_enabled() {
    projectm_perf_openmp_info info{};
    projectm_perf_get_openmp_info(&info);
    return info.compiled_enabled ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int get_omp_max_threads() {
    projectm_perf_openmp_info info{};
    projectm_perf_get_openmp_info(&info);
    return info.max_threads;
}

// Returns omp_get_num_threads() from inside a short parallel region so
// benchmarks can confirm worker threads are actually spawned (not just compiled).
EMSCRIPTEN_KEEPALIVE
int get_omp_thread_count_in_parallel() {
    int observed = 1;
#pragma omp parallel
    {
#pragma omp single
        observed = omp_get_num_threads();
    }
    return observed;
}
} // extern "C"
