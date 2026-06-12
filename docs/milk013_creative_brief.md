# Creative Brief: Solar Corona — projectM WASM Upgrade

**Preset ID:** milk013  
**Original Title:** Solar Corona  
**Original Author:** projectM AI  
**Target Platform:** projectM 4.1.x WebAssembly / WebGL (GLES3)  
**Target Shader Model:** PSVERSION_WARP=3, PSVERSION_COMP=3 (HLSL-9 subset)  
**Upgrade Goal:** Preserve the signature "polar bass-reactive warp + hot-core composite + spectrum wave + additive sun disc" look while making the preset reliable, performant, and GLES3-safe in the browser.

---

## 1. Concept Title

**Solar Corona (WASM Edition)**

A fiery, bass-reactive star visualization. The screen becomes the surface of a slow-rotating sun: concentric coronal loops warp the feedback frame into radial streams of orange and gold, while a bright white-hot core sits at the center. A spectrum waveform traces the corona, and an additive sun-disc shape reinforces the stellar silhouette. On strong beats the corona flares outward; on quiet passages it contracts into a smoldering disc.

---

## 2. Visual Description

The preset is radial and centered. Each frame, UV space is remapped to polar coordinates around the screen center, then stretched outward by the smoothed bass (`bass_att`) and twisted by two sinusoidal displacement fields: a slow angular corrugation that spins with time, and a faster radial ripple that creates filament-like loops. The feedback loop (`fDecay=0.960000`) lets these distortions accumulate into long, flowing coronal streamers.

The composite pass samples the warped framebuffer and regrades it by luminance. Dark regions become deep orange-red embers; midtones shift to saturated gold; the brightest filaments become white-hot plasma. A small central disc is overlaid as a bright core, while a larger, bass-driven corona halo pushes outward. Treble energy (`treb_att`) drives brief flashes near the core. A soft vignette darkens the edges, keeping the eye on the star.

A custom spectrum wave (`wavecode_0`) is drawn as a thick, additive ring around the center, and a 100-sided custom shape provides a persistent additive sun disc.

---

## 3. Color Palette

| Role | RGB (approx) | Description |
|------|--------------|-------------|
| Deep corona shadow | `1.00, 0.15, 0.02` | Dark orange-red at the outer edge of the corona. |
| Mid corona / ejecta | `1.00, 0.40, 0.05` | Saturated orange-gold for the body of the corona streamers. |
| Hot ejecta flare | `1.00, 0.70, 0.20` | Bright amber-gold for energetic flares. |
| Hot core | `1.00, 0.95, 0.80` | Near-white yellow for the very brightest core and flashes. |
| Wave / shape tint | `1.00, 0.50, 0.05` | Orange-gold used for the spectrum waveform and sun-disc fill. |
| Border tint | `1.00, 0.80, 0.00` | Yellow-gold for the shape border. |

Palette rule: keep the family warm (orange → gold → white). All colors should stay within the sRGB cube; the composite shader ends with `ret = saturate(outcol)`.

---

## 4. Audio Reactivity Strategy

| Audio Source | Visual Element | Mapping |
|--------------|----------------|---------|
| `bass_att` (smoothed bass) | Coronal expansion + radial warp | Drives how far streamers push outward (`q2`, `q10`, `q12`, `q13`). |
| `mid_att` | Angular corrugation phase / slow swirl | Adds rotational twist to the polar displacement (reserved in `q3`). |
| `treb_att` | Flash intensity + fast radial ripple | Brief white-hot flashes near the core and fine filament detail (`q4`, `q9`, `q11`, `q14`). |
| `bass` | Core brightness / wave displacement | Raw bass pumps the central core and the spectrum-wave radius (`q7`, `q15`). |
| `time` | Global rotation + phase | Slow deterministic drift so the sun never freezes (`q1`). |

All audio values should be pre-computed in `per_frame` as `q`-variables; the warp/composite shaders must not call `bass`, `mid`, etc. directly.

---

## 5. Component Plan

### 5.1 Per-frame equations

Precompute and cache frame-constant values so the shaders stay cheap:

- `q1 = time * 0.6` — global solar rotation phase.
- `q2 = bass_att` — smoothed bass for coronal expansion.
- `q3 = mid_att` — smoothed mid for angular swirl.
- `q4 = treb_att` — smoothed treble for flash/fine ripples.
- `q5 = sin(q1)` — slow rotation sine.
- `q6 = cos(q1 * 0.8)` — slow rotation cosine.
- `q7 = bass` — raw bass for core pulse.
- `q8 = pow(q2, 2)` — squared bass for nonlinear expansion.
- `q9 = pow(q4, 2)` — squared treble for flash energy.
- `q10 = q2 * 0.06` — radial expansion coefficient.
- `q11 = q4 * 0.03` — fine radial ripple coefficient.
- `q12 = q2 * 0.2` — angular corrugation strength.
- `q13 = q2 * 0.02` — outward directional push strength.
- `q14 = q4 * q4` — treble flash mask driver.
- `q15 = q7 * 0.5` — core pulse scaler.

### 5.2 Warp shader

Maintain the existing polar/barrel/ripple structure, but refactor for GLES3 HLSL-9 safety:

1. Convert UV to centered coordinates via `d = uv - 0.5`.
2. Compute polar radius `r = length(d)` and angle `a = atan2(d.y, d.x)`.
3. Radial expansion: `r *= 1.0 + q10`.
4. Angular corrugation: `a += q12 * sin(r * 12.0 + q1 * 4.0)`.
5. Fine radial ripple: `r += q11 * sin(r * 30.0 - q1 * 8.0)`.
6. Convert back to Cartesian: `coords = float2(cos(a) * r, sin(a) * r) + 0.5`.
7. Apply a small outward push along `d`: `coords -= normalize(d + 0.0001) * q13`.
8. Sample `sampler_main` at `coords` and assign to `ret`.

Safety edits:
- Use `float2` / `float3`, not `vec2` / `vec3`.
- Use `lerp`, not `mix`; use `frac`, not `fract`; use `fmod`, not `mod`.
- Guard any division by ensuring denominators are non-zero (`normalize(d + 0.0001)`).

### 5.3 Composite shader

Keep the hot-core/corona grading logic, tighten it for WASM:

1. Sample `sampler_main` at current UV.
2. Compute centered radius: `r = length(uv - 0.5)`.
3. Build palette constants:
   - `hotCore = float3(1.0, 0.95, 0.8)`
   - `corona1 = float3(1.0, 0.4, 0.05)`
   - `corona2 = float3(1.0, 0.15, 0.02)`
   - `ejecta = float3(1.0, 0.7, 0.2)`
4. Compute masks:
   - `core = smoothstep(0.25, 0.0, r)`
   - `corona = smoothstep(0.6, 0.1, r) * q2`
   - `flash = q14 * smoothstep(0.5, 0.0, r)`
5. Luminance from sampled color: `bright = dot(col, float3(0.3, 0.5, 0.2))`.
6. Grade luminance into corona palette:
   - `outcol = lerp(corona2, corona1, saturate(bright * 3.0))`
   - `outcol = lerp(outcol, ejecta, saturate(bright * 5.0 - 1.5))`
   - `outcol = lerp(outcol, hotCore, saturate(bright * 8.0 - 3.0))`
7. Add flash, core, and corona halos:
   - `outcol += flash`
   - `outcol += core * hotCore * 0.5`
   - `outcol += corona * corona1 * 0.4`
8. Apply vignette: `vig = smoothstep(0.75, 0.35, r)`.
9. `outcol *= 0.6 + 0.4 * vig`.
10. `ret = saturate(outcol)` — mandatory final clamp.

### 5.4 Custom waves

Keep **one custom wave** (`wavecode_0`) to draw a thick, additive spectrum ring:

- `enabled=1`
- `samples=128` (reduced from 512 for WASM; see performance budget)
- `bSpectrum=1` (spectrum mode)
- `bUseDots=0`, `bDrawThick=1`
- `bAdditive=1`
- `scaling=1.0`, `smoothing=0.7`
- Color: `r=1.0, g=0.5, b=0.05`, alpha `0.8`
- Optional per-point: `x = 0.5 + cos(sample * 6.283) * (0.25 + value1 * 0.15)`; `y = 0.5 + sin(sample * 6.283) * (0.25 + value1 * 0.15)` to form a circular spectrum trace.

If the circular mapping is not desired, keep the original wave layout but cap samples at 128.

### 5.5 Custom shapes

Keep **one custom shape** (`shapecode_0`), a 100-sided additive sun disc:

- `enabled=1`
- `sides=100` (or reduce to 64 for WASM if needed)
- `additive=1`, `thickOutline=0`, `textured=0`
- `num_inst=1`
- Positioned at center: `x=0.5, y=0.5`
- Per-frame radius pulsing: `rad = 0.08 + q10 * 0.5`
- Fill colors:
  - `r=1.0, g=0.3, b=0.0, a=0.4`
  - `r2=1.0, g2=0.5, b2=0.0, a2=0.2`
- Border colors:
  - `border_r=1.0, border_g=0.8, border_b=0.0, border_a=0.5`

Keep alpha moderate so the disc reads as glowing plasma rather than an opaque sticker.

---

## 6. Performance Budget

| Component | Budget | Rationale |
|-----------|--------|-----------|
| Per-frame equations | ≤ 20 lines | All audio pre-cached in q-vars; no heavy loops. |
| Warp shader | ~15–20 ALU instructions, 1 texture fetch | Two displacement layers plus polar remapping; no loops or branches. |
| Composite shader | ~20–25 ALU instructions, 1 texture fetch | Multiple `smoothstep`/`lerp` palette grades; still lightweight. |
| Custom wave samples | 128 | Reduced from 512 to keep WASM/WebGL vertex work small. |
| Custom shapes | 1 shape, 64–100 sides | Negligible cost; reduce sides to 64 if GPU-bound. |
| Total estimated fragment cost | ~40–55 instructions | Fits WebGL/GLES3 mobile limits; monitor on low-end devices. |

Risk areas to monitor:
- High-frequency `sin`/`cos` in both warp and polar-to-Cartesian conversion; acceptable because they are per-pixel but bounded and branchless.
- Multiple `smoothstep` calls in composite; keep them linear and avoid nested dependent texture reads.
- If frame rate drops, first reduce `wavecode_0_samples` from 128 to 64 and drop `shapecode_0_sides` from 100 to 64.
- Avoid enabling additional blur samplers; `sampler_main` alone is sufficient for this look.

---

## 7. WASM Upgrade Checklist

### Version headers

- [ ] Add `MILKDROP_PRESET_VERSION=200` at the top of the preset block.
- [ ] Add `PSVERSION_WARP=3` to enable the HLSL-9 warp shader.
- [ ] Add `PSVERSION_COMP=3` to enable the HLSL-9 composite shader.
- [ ] Keep `fShader=0.000000` (legacy shader flag off); version headers control shader execution.

### Decay clamp

- [ ] Keep `fDecay=0.960000` or clamp it to `[0.94, 0.990]`.
- [ ] Do not let `fDecay` exceed `0.999`; on WASM the framebuffer can retain ghosting indefinitely and never clear.
- [ ] Do not let `fDecay` fall below `0.93`; the corona streamers would vanish too fast for the feedback loop to build up.

### GLES3-safe HLSL

- [ ] No GLSL types: use `float2`/`float3`/`float4`, not `vec2`/`vec3`/`vec4`.
- [ ] No GLSL intrinsics: `lerp` not `mix`, `frac` not `fract`, `fmod` not `mod`, `saturate` not `clamp(..., 0, 1)`.
- [ ] No `#version`, `#pragma`, `#include`, or `layout` qualifiers.
- [ ] No `Texture2D` / `sampler2D` declarations; only built-in samplers (`sampler_main`, `sampler_blur1`, etc.).
- [ ] No dynamic loops; any loop must have a compile-time-constant bound.
- [ ] No division by zero or `pow(x, negative)` with `x` near zero.
- [ ] No `dFdx`/`dFdy`/`textureLod`/`textureGrad`.
- [ ] Always assign `ret` in every shader code path.
- [ ] End composite shader with `ret = saturate(outcol)` (or `ret = saturate(ret)`).
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

1. **Validator agent:** Check the existing `custom_milk_fixed/milk013.milk` for the missing version headers and any existing HLSL syntax issues noted above.
2. **Shader Architect agent:** Rewrite warp and composite blocks using the plan above, ensuring every line is HLSL-9 / GLES3 safe.
3. **Performance Optimizer agent:** Audit the final preset against the performance budget; reduce wave samples from 512 → 128 (or 64) and shape sides from 100 → 64 if needed for 60 fps in the browser.
4. **Preset Geneticist / assembler:** Rebuild the `.milk` file with the new headers, per-frame block, warp/composite shaders, and preserved (but reduced) wave/shape configurations.

**Output artifact:** an upgraded `.milk` file named `custom_milk_fixed/milk013.milk` (or a new variant) that loads cleanly in projectM WASM and retains the Solar Corona aesthetic.
