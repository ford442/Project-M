# Transparency Mode (Glass Layer)

## Goal

Enable projectM as a **glass layer** over video, album art, or a live camera feed. Near-black pixels in the final output are written with `alpha = 0`, so content behind the WebGL canvas shows through.

## Status

Implemented. Try it on [`html/projectm-core.html`](../html/projectm-core.html):

- Click **Glass Layer** (bottom-left) or open with `?transparent=1`
- Optional background media: `?bgVideo=<url>` or `?bgImage=<url>`
- Default background is a CSS gradient when no media URL is supplied

![Layer stack diagram](images/transparent-mode-demo.svg)

## Render paths

Final transparency is applied in the **last blit to the screen** (or legacy fallback), not in preset-internal FBOs.

| Path | When | Shader |
|------|------|--------|
| **CopyTexture** | Desktop / legacy WASM fallback (`projectm_opengl_render_frame`) | `copy_texture` fragment shader |
| **PresetTransition** | Native soft-cut transitions | `TransitionShaderMainGlsl330.frag` |
| **CompositingBlendShader** | WASM dual-FBO pipeline (normal + transition frames) | Inline shader in `projectM_emscripten.cpp` |

### Dual-FBO transitions (WASM)

The browser build renders presets into ping-pong FBOs, then composites to the canvas with `CompositingBlendShader`. Preset internals stay opaque; transparency runs only in that compositor pass (and in the legacy single-pass fallback via `CopyTexture`).

This avoids flashing opaque black during transitions: both the steady-state blit and the cross-fade use the same near-black → transparent rule.

## API

### C++

- `ProjectM::SetTransparencyMode(bool)` / `TransparencyMode()`
- `ProjectM::SetTransparencyThreshold(float)` / `TransparencyThreshold()` — default `0.01`

### C

```c
void projectm_set_transparency_mode(projectm_handle instance, bool enabled);
bool projectm_get_transparency_mode(projectm_handle instance);
void projectm_set_transparency_threshold(projectm_handle instance, float threshold);
float projectm_get_transparency_threshold(projectm_handle instance);
```

### WASM / JavaScript

```js
Module._set_transparency_mode(1);
Module._set_transparency_threshold(0.01);
```

See [WASM_JS_API.md](WASM_JS_API.md) for generated helpers.

## WebGL context requirements

Documented in [EMSCRIPTEN.md](EMSCRIPTEN.md#webgl-context-attributes):

- `alpha: true`
- `premultipliedAlpha: true`

For near-black pixels, premultiplied RGB ≈ 0, so compositing matches straight-alpha expectations.

## Shader rule

```glsl
if (u_transparencyEnabled > 0) {
    float maxComponent = max(max(color.r, color.g), color.b);
    if (maxComponent < u_transparencyThreshold) {
        color = vec4(0.0, 0.0, 0.0, 0.0);
    }
}
```

- **Threshold** default `0.01` — tolerates dither/noise without punching holes in dark but visible preset content.
- **No `discard`** — explicit `vec4(0)` avoids tile-GPU pitfalls and stale pixels when the drawing buffer is not cleared.

## Host page layering (`projectm-core.html`)

| Element | z-index | Role |
|---------|---------|------|
| `#bg-layer` | 2999 | Video / image / gradient behind the visualizer |
| `#scanvas` | 3000 | Opaque black underlay (hidden in glass mode) |
| `#mcanvas` | 3001 | WebGL visualizer |

## Design notes

- No extra framebuffer — transparency is a uniform branch in existing final-output shaders.
- Tunable threshold does not affect normal mode (`u_transparencyEnabled == 0`).
- User sprites draw after the final blit; they are not auto-masked by this mode.
