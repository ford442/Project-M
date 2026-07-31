# libprojectM – Rendering Performance Notes

This document records frame-time optimisations that were applied to the
Milkdrop rendering pipeline and the measured (or estimated) impact of each.

---

## Issue #176 – Collapse y-flip / CopyTexture fullscreen passes

**Merged:** PR #176

### Background

Every Milkdrop frame in `MilkdropPreset::RenderFrame` previously ran up to
**three** full-resolution fullscreen `CopyTexture` shader draws per frame:

| Pass | When | Purpose |
|------|------|---------|
| Pass 1 – pre-warp flip | every frame | y-flip previous-frame texture for warp shader (Milkdrop UV convention) |
| Pass 2 – pre-composite flip | every frame | y-flip warped image for composite shader |
| Pass 3 – post-composite flip | presets without composite shader only | flip old-school composite output back to correct orientation |

Additionally, `ProjectM::RenderFrame` issued a fourth fullscreen shader quad
(`CopyTexture::Draw()`) to blit the preset output to the caller-supplied target
framebuffer object.

On WASM / mobile GPUs each shader pass takes a measurable slice of the per-frame
budget (~0.5–2 ms at 1080 p depending on hardware).

### Changes (PR #176)

#### 1 – Eliminate Pass 1 for the default warp shader (steady-state path)

When a preset has **no custom HLSL warp shader** (the majority of presets that
rely on `zoom`, `rot`, `warp`, etc.) the pre-warp `CopyTexture` flip pass is
now skipped entirely.

Instead, a new `uniform int u_flipMainTex` in the default warp **fragment**
shader folds the V-axis flip into the texture sample coordinate:

```glsl
vec2 sampleCoord = frag_TEXCOORD0.xy;
if (u_flipMainTex > 0) {
    sampleCoord.y = 1.0 - sampleCoord.y;
}
color = frag_COLOR * texture(texture_sampler, sampleCoord);
```

The motion-vector UV attachment (`texCoords`) continues to write the
**un-flipped** warp UV so motion-arrow direction is unaffected.

Presets that do have a custom HLSL warp shader still use Pass 1 (the HLSL
`sampler_main` binding expects the pre-flipped texture in Milkdrop UV space).

`PerPixelMesh::HasCustomWarpShader()` exposes the predicate.

#### 2 – Replace the final output CopyTexture quad with `glBlitFramebuffer`

In `ProjectM::RenderFrame`, the no-transition / non-transparency final copy
(`CopyTexture::Draw()` to the caller's FBO) is replaced by `glBlitFramebuffer`,
a hardware-accelerated pixel copy with no shader or vertex-processing overhead:

```cpp
m_activePreset->BindOutputForRead();   // bind preset's output FBO for reading
glBlitFramebuffer(0, 0, w, h,
                  0, 0, w, h,
                  GL_COLOR_BUFFER_BIT, GL_NEAREST);
```

`Preset::BindOutputForRead()` is a new virtual method (default no-op).
`MilkdropPreset::BindOutputForRead()` delegates to
`Framebuffer::BindRead(m_currentFrameBuffer)`.

When **transparency mode** is active the `CopyTexture` shader path is retained
because `glBlitFramebuffer` cannot perform the near-black → fully-transparent
alpha conversion required by that mode.

### Before / After (estimated, 1080 p, mobile GPU)

| Metric | Before | After (default warp, no transparency) |
|--------|--------|---------------------------------------|
| Fullscreen shader passes per frame | 3–4 | 2 (Pass 2 + final CopyTexture removed) |
| Final output copy | shader quad | `glBlitFramebuffer` (driver-accelerated) |
| `compositeMs` (estimated) | baseline | −15 % to −25 % |
| `gpuMs` (estimated) | baseline | −10 % to −20 % |

Actual savings depend on resolution, GPU, and preset complexity.  Use the
`?benchmark=1` URL parameter (WASM) or the `PROJECTM_PERF_SCOPE` instrumentation
(native) to measure on your target hardware.

### Transparency mode correctness

`u_transparencyEnabled` is only set on the `CopyTexture` path that writes to
the **caller-supplied** target FBO.  Internal preset-to-preset feedback paths
(`u_transparencyEnabled = 0`) are unchanged.  The `glBlitFramebuffer` path is
only taken when transparency mode is **off**, so there is no risk of corrupting
internal feedback textures.

### Test coverage

- `PresetCompat` harness (`tests/libprojectM/`) – parses and transpiles all
  presets in `presets/tests/`; unchanged pass rate.
- WASM smoke test (`tests/wasm-smoke/run.mjs`) – renders the idle preset for
  10 frames; no visual regression.
