// WasmRenderPathOverrides.cpp
//
// URL query-string ablation switches for the WASM graphics pipeline.
//
// Each of these reads one `?key=value` pair off the host page's location and,
// where the engine takes its answer from the environment, sets the matching
// PROJECTM_* variable. They exist so a single build can be A/B'd against its
// own alternative render paths in the browser without a rebuild — see
// docs/GRAPHICS_PERF_RECOVERY_PLAN.md.
//
// init() (projectM_emscripten.cpp) calls them all exactly once, before the
// first preset renders: every path below is decided once at startup and never
// re-read.
#include "ProjectMWasmInternal.hpp"

#include <cstdlib>

// clang-format off
EM_JS(int, js_dual_fbo_prefer_high_precision, (), {
    if (!globalThis.location || !globalThis.location.search)
    {
        return 0;
    }
    try
    {
        const value = new URLSearchParams(globalThis.location.search).get('fboPrecision');
        return (value && value.toLowerCase() === 'high') ? 1 : 0;
    }
    catch (e)
    {
        return 0;
    }
});
// clang-format on

// clang-format off
EM_JS(int, js_blur_force_copy_path, (), {
    if (!globalThis.location || !globalThis.location.search)
    {
        return 0;
    }
    try
    {
        const value = new URLSearchParams(globalThis.location.search).get('blurPath');
        return (value && value.toLowerCase() === 'copy') ? 1 : 0;
    }
    catch (e)
    {
        return 0;
    }
});
// clang-format on

// clang-format off
EM_JS(int, js_copy_force_shader_path, (), {
    if (!globalThis.location || !globalThis.location.search)
    {
        return 0;
    }
    try
    {
        const value = new URLSearchParams(globalThis.location.search).get('copyPath');
        return (value && value.toLowerCase() === 'shader') ? 1 : 0;
    }
    catch (e)
    {
        return 0;
    }
});
// clang-format on

// clang-format off
EM_JS(int, js_per_pixel_force_cpu_path, (), {
    if (!globalThis.location || !globalThis.location.search)
    {
        return 0;
    }
    try
    {
        const value = new URLSearchParams(globalThis.location.search).get('perPixelEval');
        return (value && value.toLowerCase() === 'cpu') ? 1 : 0;
    }
    catch (e)
    {
        return 0;
    }
});
// clang-format on

// Ablation switch for the GPU per-pixel path: ?perPixelEval=cpu keeps every preset on
// the projectM-EvalLib loop even when its equations compiled to GLSL, so the two paths
// can be A/B'd on one build. Consumed by PerPixelGlslLowering::ForcedToCpu(); see
// docs/GPU_PERPIXEL_EVAL.md.
void ApplyPerPixelEvalOverride()
{
    if (js_per_pixel_force_cpu_path() != 0)
    {
        setenv("PROJECTM_PER_PIXEL_EVAL", "cpu", 1);
    }
}

// Ablation switch for benchmarking the texture-copy path: ?copyPath=shader restores the
// pre-#179 fullscreen-quad copy so it can be A/B'd against the default glBlitFramebuffer
// resolve on one build. See docs/GRAPHICS_PERF_RECOVERY_PLAN.md.
void ApplyCopyPathOverride()
{
    if (js_copy_force_shader_path() != 0)
    {
        setenv("PROJECTM_COPY_SHADER_PATH", "1", 1);
    }
}

// Ablation switch for benchmarking the blur chain: ?blurPath=copy restores the legacy
// render-to-scratch + glCopyTexSubImage2D behaviour so it can be A/B'd against the
// default render-to-texture path on one build. See docs/GRAPHICS_PERF_RECOVERY_PLAN.md.
void ApplyBlurPathOverride()
{
    if (js_blur_force_copy_path() != 0)
    {
        setenv("PROJECTM_BLUR_COPY_PATH", "1", 1);
    }
}

// ?fboPrecision=high probes RGBA32F before RGBA16F when picking the dual-FBO
// texture format. Consumed by DualPingPongFramebuffer::DetectFormat().
bool WasmPreferHighPrecisionFbo()
{
    return js_dual_fbo_prefer_high_precision() != 0;
}
