# Creative Brief: Black-Hole Accretion Disk — projectM WASM Upgrade

**Preset ID:** milk015  
**Original Title:** *(untitled in source)* — referred to as **Black-Hole Accretion Disk**  
**Original Author:** projectM AI  
**Target Platform:** projectM 4.1.x WebAssembly / WebGL (GLES3)  
**Target Shader Model:** PSVERSION_WARP=3, PSVERSION_COMP=3 (HLSL-9 subset)  
**Upgrade Goal:** Preserve the signature "gravitational warp + accretion-disk composite + circular spectrum wave + black-hole disc shape" look while adding explicit WASM-safe shader versions and tuning the preset for reliable GLES3 browser rendering.

> **Important:** The current `custom_milk_fixed/milk015.milk` has **no shader version header**. Add explicit `PSVERSION_WARP=3` and `PSVERSION_COMP=3` declarations so projectM selects the HLSL-9 / GLES3 shader path in the WASM build.

---

## 1. Concept Title

**Black-Hole Accretion Disk (WASM Edition)**

A deep-space music visualization built around a central gravitational singularity. The feedback frame is pulled inward by a Schwarzschild-like warp: pixels spiral toward the center as they orbit a slowly rotating accretion flow. The composite pass paints a Doppler-shifted accretion disk — hot orange matter racing away, cool blue matter falling in — around a pitch-black event-horizon disc. A circular spectrum wave orbits the black hole, and a small, pulsing central disc shape anchors the scene. Bass drives the gravity well; treble fuels the disk flare.

---

## 2. Visual Description

The preset is radial and centered. Each frame, UV space is shifted to the screen center and converted to polar coordinates. A gravity term pulls pixels inward with a `1 / r²` falloff, while a swirl term adds angular rotation that decays with radius. The distorted UV is fed back through `sampler_main` with `fDecay=0.980000`, so the previous frame smears into long, spiraling streaks that never fully erase — a persistent accretion trail.

The composite pass samples the warped framebuffer, then overlays the accretion disk. Two concentric rings define the disk: a hot inner ring and a cooler outer band. A rotating angular offset drives a Doppler gradient via `sin(ang)`: one side shifts warm orange-red, the other shifts cold blue. A central shadow disc blocks light to create the black-hole silhouette. Bass adds a radial flare near the center, and a soft vignette darkens the edges so the eye stays locked on the singularity.

A single additive custom wave traces the spectrum in a circle around the black hole, its radius expanding with the audio. A single custom shape — a 100-sided disc rendered black with an emissive border — sits at the center as the event-horizon marker.

---

## 3. Color Palette

| Role | RGB (approx) | Description |
|------|--------------|-------------|
| Event horizon / shadow | `0.00, 0.00, 0.00` | Pitch-black central disc that swallows light. |
| Hot accretion matter | `0.90, 0.25, 0.02` | Orange-red Doppler-shifted matter moving away. |
| Cool accretion matter | `0.05, 0.25, 0.80` | Blue Doppler-shifted matter falling inward. |
| Disk glow | `1.00, 0.85, 0.50` | Bright yellow-white highlight at the inner edge. |
| Bass flare | `0.80, 0.50, 0.20` | Radial flash near the center driven by bass. |
| Wave orange | `0.90–1.00, 0.50–0.80, 0.20–0.50` | Time-modulated warm spectrum trace. |
| Event-horizon border | `0.90, 0.60, 0.20` | Emissive rim of the central black disc. |
| Deep space | `0.00, 0.00, 0.05` | Near-black canvas outside the disk. |

Palette rule: stay dark and high-contrast. The only saturated colors live in the Doppler disk and the flare; everything else is black or near-black. End the composite shader with `ret = saturate(col)` to keep all values inside the sRGB cube.

---

## 4. Audio Reactivity Strategy

| Audio Source | Visual Element | Mapping |
|--------------|----------------|---------|
| `bass_att` (smoothed bass) | Gravity pull strength + central flare + disc intensity | Drives how strongly pixels are pulled inward (`q2`, `q9`) and how bright the disk glows (`q12`). |
| `mid_att` | Accretion disk width | Sets the inner/outer ring radii (`q3`, `q7`). |
| `treb_att` | Outer disk radius + spectral wave color speed | Controls disk extent (`q4`, `q8`) and wave shimmer. |
| `bass` | Event-horizon disc radius + flare intensity | Pulses the central black disc (`q5`, `q6`) and the radial flare. |
| `time` | Global rotation + Doppler phase | Slow deterministic spin of the disk and gravity swirl (`q1`, `q11`). |

All audio values must be pre-computed in `per_frame` as `q`-variables; the warp/composite shaders must not reference `bass`, `mid`, `treb`, etc. directly.

---

## 5. Component Plan

### 5.1 Per-frame equations

Precompute and cache frame-constant values so the shaders stay cheap:

- `q1 = time * 0.12` — global slow rotation.
- `q2 = bass_att` — smoothed bass for gravity pull and disk glow.
- `q3 = mid_att` — smoothed mid for disk width.
- `q4 = treb_att` — smoothed treble for outer disk extent.
- `q5 = bass` — raw bass for event-horizon disc pulse.
- `q6 = 0.06 + q2 * 0.03` — central black-hole disc radius.
- `q7 = 0.12 + q3 * 0.04` — inner accretion ring radius.
- `q8 = 0.35 + q4 * 0.08` — outer accretion ring radius.
- `q9 = 0.15 + q5 * 0.06` — gravity pull strength.
- `q10 = 0.25 + q2 * 0.15` — swirl rotation strength.
- `q11 = sin(q1 * 2.0)` — disk Doppler phase offset.
- `q12 = 0.5 + q5 * 0.4` — disk brightness multiplier.

Also keep `fDecay=0.980000`, `zoom=1.0`, `rot=0.0`, `sx=1.0`, `sy=1.0`, and `wave_a=0.0` in `per_frame` so built-in frame feedback behaves predictably and the custom wave is the only waveform drawn.

### 5.2 Warp shader

Preserve the gravitational-spiral structure, but ensure every line is GLES3 HLSL-9 safe:

1. Compute centered UV: `d = uv - 0.5`.
2. Convert to polar: `r = length(d)`, `a = atan2(d.y, d.x)`.
3. Compute gravity pull: `pull = q9 / (r * r + 0.005)`.
4. Compute swirl envelope: `sw = q10 * exp(-r * 4.0)`.
5. Offset angle: `a += sw + q1 * 0.5`.
6. Pull radius inward: `r -= pull * 0.003`.
7. Rebuild UV: `uv2 = float2(cos(a), sin(a)) * r + 0.5`.
8. Sample `sampler_main` at `uv2` into `ret`.
9. Dim slightly: `ret *= 0.96`.

Safety edits:

- Use `float2` / `float3`, not `vec2` / `vec3`.
- Use `lerp`, not `mix`; use `frac`, not `fract`; use `fmod`, not `mod`.
- Guard the division with `+ 0.005` so the gravity term never explodes at `r = 0`.
- Always write `ret` before exiting.

### 5.3 Composite shader

Keep the Doppler accretion-disk grading logic, tighten it for WASM:

1. Compute centered UV and polar coordinates: `d = uv - 0.5`, `r = length(d)`, `a = atan2(d.y, d.x)`.
2. Sample `sampler_main` at `uv` into `col`.
3. Build disk mask: `disk = smoothstep(q7, q7 + 0.04, r) * smoothstep(q8, q8 - 0.08, r)`.
4. Build hot inner ring: `hot = smoothstep(q6, q6 + 0.03, r) * smoothstep(q7, q7 - 0.03, r)`.
5. Compute Doppler angle: `ang = a + q1 * 2.0 + q11`.
6. Compute Doppler factor: `doppler = sin(ang) * 0.5 + 0.5`.
7. Lerp hot/cool colors: `acc = lerp(float3(0.9, 0.25, 0.02), float3(0.05, 0.25, 0.8), doppler)`.
8. Add disk: `col += acc * disk * q12`.
9. Add inner glow: `col += float3(1.0, 0.85, 0.5) * hot * q12 * 1.5`.
10. Add bass flare: `flare = q5 * q5 * 0.4 * exp(-r * 3.0)`, `col += float3(0.8, 0.5, 0.2) * flare`.
11. Subtract event-horizon shadow: `shadow = smoothstep(q6 + 0.02, q6 - 0.01, r)`, `col *= 1.0 - shadow * 0.9`.
12. Apply vignette: `vig = smoothstep(0.8, 0.2, r)`, `col *= 0.3 + 0.7 * vig`.
13. `ret = saturate(col)` — mandatory final clamp.

### 5.4 Custom waves

Keep **one custom wave** (`wavecode_0`) as a circular spectrum ring:

- `enabled=1`
- `samples=512` — **preserve the original 512 samples**; the wave is simple and the visual depends on smooth spectral continuity.
- `sep=0`
- `bSpectrum=1`
- `bUseDots=1`
- `bDrawThick=0`
- `bAdditive=1`
- `scaling=1.0`, `smoothing=0.5`
- Base color: `r=1.0, g=0.8, b=0.5, a=0.7`

Per-point behavior:

- `ang = sample * 6.2832 + q1`
- `rad = 0.25 + value1 * 0.15`
- `x = cos(ang) * rad * 0.5 + 0.5`
- `y = sin(ang) * rad * 0.5 + 0.5`
- `r = 0.9 + 0.1 * sin(q1 * 3)`
- `g = 0.5 + 0.3 * sin(q1 * 2 + 1)`
- `b = 0.2 + 0.2 * sin(q1 * 5 + 2)`
- `a = 1`

This orbits the spectrum as a glowing ring around the black hole, expanding with each frequency bin magnitude.

### 5.5 Custom shapes

Keep **one custom shape** (`shapecode_0`) as the central event-horizon disc:

- `enabled=1`
- `sides=100` — high-count circle for a smooth disc silhouette.
- `additive=1`
- `thickOutline=0`, `textured=0`
- `num_inst=1`
- Positioned at center: `x=0.5, y=0.5`
- Per-frame radius: `rad = q6 + q5 * 0.02`
- Fill colors:
  - `r=0.0, g=0.0, b=0.0, a=0.9 + q5 * 0.1`
  - `r2=0.0, g2=0.0, b2=0.0, a2=0.9 + q5 * 0.1`
- Border colors:
  - `border_r=0.9 + 0.1 * sin(q1 * 4)`
  - `border_g=0.5 + 0.2 * sin(q1 * 3 + 1)`
  - `border_b=0.1 + 0.1 * sin(q1 * 5 + 2)`
  - `border_a=0.6`

The black fill blocks the warped background to create the hole; the animated border reads as the innermost stable orbit of the accretion flow.

---

## 6. Performance Budget

| Component | Budget | Rationale |
|-----------|--------|-----------|
| Per-frame equations | ≤ 20 lines | All audio pre-cached in q-vars; no heavy loops. |
| Warp shader | ~10 ALU instructions, 1 texture fetch | `length`, `atan2`, `exp`, `sin`, `cos`, and a single `tex2D`; branchless. |
| Composite shader | ~20–24 ALU instructions, 1 texture fetch | Multiple `smoothstep`, `sin`, `exp`, `lerp`, and final `saturate`. |
| Custom wave samples | 512 | Preserved from original; dot-based additive rendering is cheap. |
| Custom shapes | 1 disc, 100 sides | Negligible cost; 100-sided polygon is still trivial. |
| Total estimated fragment cost | ~35–45 instructions | Fits WebGL/GLES3 mobile limits; monitor on low-end devices. |

Risk areas to monitor:

- The composite shader contains several `smoothstep` and `sin` calls; this is the dominant cost but still branchless.
- If frame rate drops, first reduce `wavecode_0_samples` from 512 to 256 or 128, or simplify the per-point color modulation.
- Avoid enabling additional blur samplers; `sampler_main` alone is sufficient for the black-hole look.

---

## 7. WASM Upgrade Checklist

### Version headers

- [ ] Add explicit version declarations (the source currently has none):
  - `MILKDROP_PRESET_VERSION=200`
  - `PSVERSION_WARP=3`
  - `PSVERSION_COMP=3`
- [ ] Keep `fShader=0.000000` (legacy shader flag off); the version headers control shader execution.

### Decay clamp

- [ ] Keep `fDecay=0.980000` in `per_frame` as the original source does.
- [ ] Do not let `fDecay` exceed `0.999`; on WASM the framebuffer can retain ghosting indefinitely and never clear.
- [ ] Do not let `fDecay` fall below `0.94`; the long accretion trails would vanish too fast.

### GLES3-safe HLSL

- [ ] No GLSL types: use `float2`/`float3`/`float4`, not `vec2`/`vec3`/`vec4`.
- [ ] No GLSL intrinsics: `lerp` not `mix`, `frac` not `fract`, `fmod` not `mod`, `saturate` not `clamp(..., 0, 1)`.
- [ ] No `#version`, `#pragma`, `#include`, or `layout` qualifiers.
- [ ] No `Texture2D` / `sampler2D` declarations; only built-in samplers (`sampler_main`, `sampler_blur1`, etc.).
- [ ] No dynamic loops; any loop must have a compile-time-constant bound.
- [ ] No division by zero; guard `pull` with `+ 0.005` and avoid other divides near zero.
- [ ] No `pow(x, negative)` with `x` near zero.
- [ ] No `dFdx`/`dFdy`/`textureLod`/`textureGrad`.
- [ ] Always assign `ret` in every shader code path.
- [ ] End composite shader with `ret = saturate(col)` (or `ret = saturate(ret)`).
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

1. **Validator agent:** Check the existing `custom_milk_fixed/milk015.milk` for the missing shader version header, confirm `fDecay` lives in `per_frame`, and verify wave samples are set to 512.
2. **Shader Architect agent:** Rewrite warp and composite blocks using the plan above, ensuring every line is HLSL-9 / GLES3 safe and that the `+ 0.005` guard on the gravity term is preserved.
3. **Performance Optimizer agent:** Audit the final preset against the performance budget; if needed, reduce `wavecode_0_samples` from 512 to 256/128, but do not lower it by default.
4. **Preset Geneticist / assembler:** Rebuild the `.milk` file with the new headers, per-frame block, warp/composite shaders, and preserved wave/shape configurations.

**Output artifact:** an upgraded `.milk` file named `custom_milk_fixed/milk015.milk` (or a new variant) that loads cleanly in projectM WASM and retains the Black-Hole Accretion Disk aesthetic.
