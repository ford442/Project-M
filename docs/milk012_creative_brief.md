# Creative Brief: Liquid Mercury — projectM WASM Upgrade

**Preset ID:** milk012  
**Original Title:** Liquid Mercury  
**Original Author:** projectM AI  
**Target Platform:** projectM 4.1.x WebAssembly / WebGL (GLES3)  
**Target Shader Model:** PSVERSION_WARP=3, PSVERSION_COMP=3 (HLSL-9 subset)  
**Upgrade Goal:** Preserve the signature "ripple warp + mercury metal composite" look while making the preset reliable, performant, and GLES3-safe in the browser.

---

## 1. Concept Title

**Liquid Mercury (WASM Edition)**

A dark, liquid-metal visualization where concentric ripples radiate from the center, refracting the previous frame into flowing mercury-like sheets. A final composite pass maps luminance to a cool metallic palette, producing mirror-bright specular highlights against deep gunmetal shadows.

---

## 2. Visual Description

The preset presents a centered, radially symmetric fluid surface. Each frame, the UV space is pulled through a slow barrel distortion, rotated gently, and perturbed by three layered ripple frequencies (radial rings, angular waves, and fine surface texture). The feedback loop accumulates these distortions into organic, ever-shifting metallic flows. In the composite stage, the distorted image is graded into a restricted cool-metal palette: near-black shadows, pale-blue midtones, and almost-white highlights. A subtle vignette and mild gamma lift keep the center bright while the edges sink into shadow, reinforcing a "liquid mirror" illusion.

---

## 3. Color Palette

| Role | RGB (approx) | Description |
|------|--------------|-------------|
| Shadow / base metal | `0.02, 0.02, 0.03` | Deep blue-grey gunmetal, used in low-luminance regions. |
| Midtone metal | `0.85, 0.88, 0.95` | Cool silver-blue, the dominant reflective body color. |
| Specular highlight | `0.98, 0.99, 1.00` | Near-white used for the brightest specular hits. |
| Wave / shape tint | `0.80, 0.85, 0.95` | Pale steel-blue for custom waveform overlays. |
| Border tint | `0.70, 0.75, 0.85` | Slightly darker blue-grey for shape borders. |

Palette rule: keep saturation low and hue cool. All colors should stay within the sRGB cube; the composite shader ends with `saturate(outCol)`.

---

## 4. Audio Reactivity Strategy

| Audio Source | Visual Element | Mapping |
|--------------|----------------|---------|
| `bass_att` (smoothed bass) | Ripple amplitude + zoom pulse | Larger, more energetic ripples on beats. Drives `q2`. |
| `mid_att` | Angular ripple strength | Adds swirl/twist to the ripple field. Drives `q3`. |
| `treb_att` | Specular highlight intensity | Brief flashes of bright metal on treble hits. Drives `q4`. |
| `bass` | Shape radius / wave height | Custom shape expands and custom wave y-displacement grows with bass. Drives `q8`. |
| `time` | Global rotation + phase | Slow deterministic drift so the preset never freezes. Drives `q1`. |

All audio values should be pre-computed in `per_frame` as `q`-variables; the warp/composite shaders must not call `bass`, `mid`, etc. directly.

---

## 5. Component Plan

### 5.1 Per-frame equations

Precompute and cache frame-constant values so the shaders stay cheap:

- `q1 = time` — global time reference.
- `q2 = bass_att` — smoothed bass for ripple amplitude / zoom.
- `q3 = mid_att` — smoothed mid for angular ripple.
- `q4 = treb_att` — smoothed treble for specular flashes.
- `q5 = 0.5 + 0.5 * sin(time * 0.5)` — slow sine LFO for color modulation.
- `q6 = 0.5 + 0.5 * cos(time * 0.3)` — slow cosine LFO for rotation drift.
- `q7 = 0.5 + 0.5 * sin(time * 1.1)` — faster shimmer LFO.
- `q8 = bass` — raw bass for shape/wave reactivity.
- `q9 = 0.5 + 0.5 * sin(time * 0.2)` — very slow palette shift.
- `q10 = 0.5 + 0.5 * cos(time * 0.15)` — complementary slow LFO.
- `q11 = q2 * 0.1` — scaled bass for zoom.
- `q12 = q3 * 0.08` — scaled mid for angular ripple.

Optionally precompute combined terms (e.g., `q13 = q1 * 2.8`, `q14 = q1 * 5.0`) if it shortens the shader, but keep readability high.

### 5.2 Warp shader

Maintain the existing radial/barrel/ripple structure, but refactor for GLES3 HLSL-9 safety:

1. Convert UV to centered coordinates, aspect-corrected via `aspect.xy`.
2. Compute polar radius `r` and angle `a` with `atan2(c.y, c.x)`.
3. Apply a slow, bass-reactive zoom and a mild barrel expansion (`1.0 + r*r*0.25`).
4. Add a slow global rotation (`a += q1 * 0.04 + q2 * 0.06`).
5. Layer three ripple displacements:
   - **Radial ripple:** `sin(r * 20.0 - q1 * 2.8 + q2 * 3.0) * (0.008 + q2 * 0.012)`
   - **Angular ripple:** `cos(a * 5.0 + q1 * 1.3) * (0.005 + q3 * 0.008)`
   - **Fine ripple:** `sin(r * 35.0 - q1 * 5.0) * 0.003`
6. Convert displacements back to Cartesian offsets and sample `sampler_main` at the new UV.
7. Assign result to `ret`.

Safety edits:
- Use `float2` / `float3`, not `vec2` / `vec3`.
- Use `lerp`, not `mix`; use `frac`, not `fract`; use `fmod`, not `mod`.
- Guard any division by ensuring denominators are non-zero (none here, but verify).

### 5.3 Composite shader

Keep the metal grading logic, tighten it for WASM:

1. Sample `sampler_main` at current UV.
2. Compute luminance: `lum = dot(col, float3(0.333, 0.333, 0.333))` (or `(col.x+col.y+col.z)*0.333`).
3. Build metal palette:
   - `darkMetal = float3(0.02, 0.02, 0.03)`
   - `lightMetal = float3(0.85, 0.88, 0.95)`
   - `specular = float3(0.98, 0.99, 1.0)`
4. `metal = pow(lum, 0.8)` — tonal curve.
5. `outCol = lerp(darkMetal, lightMetal, metal)`.
6. `spec = pow(smoothstep(0.6, 1.0, lum), 4.0)` — bright specular mask.
7. `outCol = lerp(outCol, specular, spec * (0.6 + 0.4 * q4))` — treble-reactive highlights.
8. Apply vignette: `vig = smoothstep(0.8, 0.3, length(uv - 0.5))`.
9. `outCol *= 0.85 + 0.15 * vig`.
10. Mild gamma/contrast: `outCol = pow(outCol, 1.15)`.
11. `ret = saturate(outCol);` — mandatory final clamp.

Optional: add a very light `GetBlur1` bloom if performance allows, but default to no blur to keep WebGL cost low.

### 5.4 Custom waves

Keep **one custom wave** (`wavecode_0`) to draw a thin, bass-reactive PCM trace across the center:

- `enabled=1`
- `samples=200` (WASM-safe; do not raise to 512+)
- `bSpectrum=0` (PCM waveform)
- `bUseDots=0`, `bDrawThick=0`
- Per-point: `x = sample; y = 0.5 + value1 * (0.2 + q8 * 0.1)`
- Color: fixed pale steel-blue `r=0.8, g=0.85, b=0.95`, alpha `0.4`

This adds a subtle waveform "surface scratch" without dominating the metal look.

### 5.5 Custom shapes

Keep **one custom shape** (`shapecode_0`), a 32-sided polygon acting as a soft central disc:

- `enabled=1`
- `sides=32`
- `additive=0`, `thickOutline=0`, `textured=0`
- Per-frame:
  - `rad = 0.05 + q2 * 0.08`
  - `r = 0.8 + q2 * 0.2`
  - `g = 0.8 + q2 * 0.15`
  - `b = 0.9 + q2 * 0.1`
- Keep alpha low (`0.2` fill / `0.1` secondary / `0.3` border) so it reads as a specular pool, not a solid sticker.

No additional shapes are needed; the visual focus is the warp/composite interaction.

---

## 6. Performance Budget

| Component | Budget | Rationale |
|-----------|--------|-----------|
| Per-frame equations | ≤ 20 lines | All audio pre-cached in q-vars; no heavy loops. |
| Warp shader | ~20–25 ALU instructions, 1 texture fetch | Three ripple layers are cheap; no loops or branches. |
| Composite shader | ~15–20 ALU instructions, 1 texture fetch | Optional blur only if frame budget > 55 fps. |
| Custom wave samples | 200 | WASM/WebGL vertex work stays small. |
| Custom shapes | 1 shape, 32 sides | Negligible cost. |
| Total estimated fragment cost | ~40–50 instructions | Fits comfortably inside WebGL/GLES3 mobile limits. |

Risk areas to monitor:
- High-frequency `sin`/`cos` in the warp shader; acceptable because they are per-pixel but bounded and branchless.
- `pow(lum, 0.8)` and `pow(..., 4.0)` in composite — acceptable for one invocation.
- If frame rate drops, first remove the fine ripple (`sin(r * 35.0 - q1 * 5.0) * 0.003`) and reduce wave samples to 128.

---

## 7. WASM Upgrade Checklist

### Version headers

- [ ] Add `MILKDROP_PRESET_VERSION=200` at the top of the preset block.
- [ ] Add `PSVERSION_WARP=3` to enable the HLSL-9 warp shader.
- [ ] Add `PSVERSION_COMP=3` to enable the HLSL-9 composite shader.
- [ ] Keep `fShader=0.000000` (legacy shader flag off); version headers control shader execution.

### Decay clamp

- [ ] Keep `fDecay=0.990000` or clamp it to `[0.96, 0.995]`.
- [ ] Do not let `fDecay` exceed `0.999`; on WASM the framebuffer can retain ghosting indefinitely and never clear.
- [ ] Do not let `fDecay` fall below `0.95`; the trail would vanish too fast for the ripple feedback to build up.

### GLES3-safe HLSL

- [ ] No GLSL types: use `float2`/`float3`/`float4`, not `vec2`/`vec3`/`vec4`.
- [ ] No GLSL intrinsics: `lerp` not `mix`, `frac` not `fract`, `fmod` not `mod`, `saturate` not `clamp(..., 0, 1)`.
- [ ] No `#version`, `#pragma`, `#include`, or `layout` qualifiers.
- [ ] No `Texture2D` / `sampler2D` declarations; only built-in samplers (`sampler_main`, `sampler_blur1`, etc.).
- [ ] No dynamic loops; any loop must have a compile-time-constant bound.
- [ ] No division by zero or `pow(x, negative)` with `x` near zero.
- [ ] No `dFdx`/`dFdy`/`textureLod`/`textureGrad`.
- [ ] Always assign `ret` in every shader code path.
- [ ] End composite shader with `ret = saturate(ret);`.
- [ ] Every shader line starts with a backtick `` ` `` and no leading spaces.
- [ ] Numbering is gapless: `warp_1`, `warp_2`, ... and `comp_1`, `comp_2`, ... with no skipped indices.

### Compatibility / validation

- [ ] File size stays well under 1 MiB (expected ~4–6 KiB).
- [ ] No null bytes in the file; save as plain UTF-8 text.
- [ ] All q-variables used in shaders are initialized in `per_frame`.
- [ ] No redeclaration of built-in aliases such as `uv_orig` or `uv`.
- [ ] Final preset should parse and transpile through the projectM HLSL-to-GLSL path without errors.

---

## 8. Summary for Implementation Agents

1. **Validator agent:** Check the existing `custom_milk_fixed/milk012.milk` for the missing version headers and the existing HLSL syntax issues noted above.
2. **Shader Architect agent:** Rewrite warp and composite blocks using the plan above, ensuring every line is HLSL-9 / GLES3 safe.
3. **Performance Optimizer agent:** Audit the final preset against the performance budget; remove the fine ripple or the custom wave if needed for 60 fps in the browser.
4. **Preset Geneticist / assembler:** Rebuild the `.milk` file with the new headers, per-frame block, warp/composite shaders, and preserved wave/shape configurations.

**Output artifact:** an upgraded `.milk` file named `custom_milk_fixed/milk012.milk` (or a new variant) that loads cleanly in projectM WASM and retains the Liquid Mercury aesthetic.
