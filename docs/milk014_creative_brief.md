# Creative Brief: Hex Ice Lattice — projectM WASM Upgrade

**Preset ID:** milk014  
**Original Title:** *(untitled in source)* — referred to as **Hex Ice Lattice**  
**Original Author:** projectM AI  
**Target Platform:** projectM 4.1.x WebAssembly / WebGL (GLES3)  
**Target Shader Model:** PSVERSION_WARP=3, PSVERSION_COMP=3 (HLSL-9 subset)  
**Upgrade Goal:** Preserve the signature "hex ice-lattice warp + rainbow-ice composite + additive waveform + centered hex shape" look while upgrading the legacy `PSVERSION=2` header to explicit WASM-safe shader versions and tuning the preset for reliable GLES3 browser rendering.

> **Important:** The current `custom_milk_fixed/milk014.milk` uses the single legacy header `PSVERSION=2`. This must be replaced with `PSVERSION_WARP=3` and `PSVERSION_COMP=3` so projectM selects the HLSL-9 / GLES3 shader path in the WASM build.

---

## 1. Concept Title

**Hex Ice Lattice (WASM Edition)**

A cold, crystalline music visualization built from a rotating hexagonal grid. The feedback frame is warped by an ice-like lattice: three-axis hex SDF lines shimmer, pulse with bass, and refract the image into prismatic ripples. A rainbow-ice composite pass tints everything in cyan, sapphire, and shifting spectral highlights, while a centered hexagon shape and a glowing waveform add structure and motion. Bass makes the lattice expand and flare; treble injects fleeting rainbow sparks across the ice.

---

## 2. Visual Description

The preset is centered and geometric. Each frame, UV space is shifted to the screen center and rotated by a slow time-driven angle. A hexagonal distance field is computed from three 60°-spaced axes; the nearest lattice edge generates thin, icy filaments via `smoothstep`. Bass (`bass_att`) scales the lattice density and drives a radial pulse that ripples outward through the hex cells, while mid frequencies add small lateral refraction offsets. The distorted UV is fed back through `sampler_main` with `fDecay=0.960000`, so the lattice carves persistent, ever-deepening ice channels.

The composite pass samples the warped framebuffer, applies a cool ice tint, and overlays a slow rainbow shimmer derived from `time`. A radial vignette darkens the edges and focuses attention on the center. Treble (`treb_att`) boosts the rainbow intensity, and bass modulates the overall brightness. A single additive custom waveform traces the audio, and a six-sided hexagon shape sits at the center as a crystalline emblem.

---

## 3. Color Palette

| Role | RGB (approx) | Description |
|------|--------------|-------------|
| Ice shadow / deep lattice | `0.05, 0.15, 0.35` | Deep navy-cyan in the lattice grooves. |
| Ice body | `0.30, 0.60, 1.00` | Cool sapphire-cyan used for the base tint and shape fill. |
| Icy highlight | `0.60, 0.85, 1.00` | Bright sky-blue for lattice edges and shape border. |
| Rainbow red | `1.00, 0.30, 0.30` | Treble-driven spectral flash. |
| Rainbow green | `0.30, 1.00, 0.50` | Mid-driven spectral accent. |
| Rainbow blue | `0.30, 0.50, 1.00` | Bass-aligned spectral accent. |
| Wave / border tint | `0.20, 0.70, 1.00` | Cyan used for the waveform and hex border. |

Palette rule: stay cold (deep blue → cyan → white). Rainbow accents are sparse and driven by treble so they read as glints on ice rather than warm colors. End the composite shader with `ret = saturate(col)` to keep everything inside the sRGB cube.

---

## 4. Audio Reactivity Strategy

| Audio Source | Visual Element | Mapping |
|--------------|----------------|---------|
| `bass_att` (smoothed bass) | Lattice scale + radial pulse + brightness | Drives how tight the hex grid becomes (`q2`, `q9`, `q11`) and how strongly the lattice pushes the feedback image. |
| `mid_att` | Lateral refraction offsets | Adds small `sin/cos` UV wobble to simulate ice refraction (`q3`, `q10`). |
| `treb_att` | Rainbow flash intensity | Controls how much the rainbow shimmer is added in the composite pass (`q4`, `q12`). |
| `bass` | Global brightness multiplier | Pumps the final composite brightness (`q2` scaled). |
| `time` | Global rotation + rainbow phase | Slow deterministic drift so the lattice never freezes (`q1`, `q5`, `q6`, `q7`, `q8`). |

All audio values must be pre-computed in `per_frame` as `q`-variables; the warp/composite shaders must not reference `bass`, `mid`, `treb`, etc. directly.

---

## 5. Component Plan

### 5.1 Per-frame equations

Precompute and cache frame-constant values so the shaders stay cheap:

- `q1 = time` — global time reference.
- `q2 = bass_att` — smoothed bass for lattice scale and brightness.
- `q3 = mid_att` — smoothed mid for refraction offsets.
- `q4 = treb_att` — smoothed treble for rainbow flashes.
- `q5 = sin(time * 0.3)` — slow rotation sine.
- `q6 = cos(time * 0.3)` — slow rotation cosine.
- `q7 = 0.5 + 0.5 * sin(time * 0.7)` — lattice shimmer phase.
- `q8 = 0.5 + 0.5 * cos(time * 0.5)` — secondary shimmer phase.
- `q9 = q2 * 0.03` — radial pulse amplitude.
- `q10 = q3 * 0.04` — lateral refraction strength.
- `q11 = 1.0 + q2 * 0.15` — lattice density scale factor.
- `q12 = time * 0.2 + q3 * 0.8` — composite rotation / rainbow phase.
- `q13 = q4 * 0.15` — rainbow flash multiplier.
- `q14 = 0.9 + 0.1 * q2` — final brightness multiplier.

Also drive the built-in wave colors from audio:

- `wave_r = 0.2 + 0.2 * q2`
- `wave_g = 0.5 + 0.3 * q3`
- `wave_b = 0.8 + 0.2 * q4`

### 5.2 Warp shader

Keep the three-axis hex SDF structure, but refactor for GLES3 HLSL-9 safety:

1. Center and optionally aspect-correct the UV: `p = (uv - 0.5) * aspect.xy`.
2. Rotate by `q12` (or a dedicated rotation q-var): `cr = cos(rot)`, `sr = sin(rot)`, `pr = float2(p.x*cr - p.y*sr, p.x*sr + p.y*cr)`.
3. Compute lattice scale: `sc = 8.0 + q2 * 4.0` (or use the `q11` scale factor).
4. Project onto the three hex axes:
   - `d1 = dot(pr, float2(1.0, 0.0)) * sc`
   - `d2 = dot(pr, float2(0.5, 0.8660254)) * sc`
   - `d3 = dot(pr, float2(-0.5, 0.8660254)) * sc`
5. Compute distance to nearest lattice line for each axis: `fN = abs(dN - floor(dN + 0.5))`.
6. Combine: `dist = min(f1, min(f2, f3))`.
7. Generate lattice mask: `lattice = smoothstep(0.12, 0.0, dist)`.
8. Bass-driven radial pulse: `pulse = 1.0 + q9 * sin(dist * 20.0 - q1 * 3.0)`.
9. Refraction offset: `offset = float2(cos(d1 * 0.5), sin(d2 * 0.5)) * q10 * 0.02`.
10. Distort: `refract = pr * pulse + offset + lattice * q2 * 0.03`.
11. Sample `sampler_main` at `refract * aspect.zw + 0.5` and assign to `ret`.

Safety edits:

- Use `float2` / `float3`, not `vec2` / `vec3`.
- Use `lerp`, not `mix`; use `frac`, not `fract`; use `fmod`, not `mod`.
- No division by zero; the lattice math uses `floor` and `dot` only.

### 5.3 Composite shader

Keep the rainbow-ice grading logic, tighten it for WASM:

1. Sample `sampler_main` at current `uv` into `col`.
2. Compute vignette radius: `r = length(uv - 0.5)`.
3. Vignette mask: `vig = smoothstep(0.7, 0.2, r)`.
4. Ice tint color: `ice = float3(0.3, 0.6, 1.0)`.
5. Apply ice tint: `col = lerp(col, col * ice * 1.3, 0.4)`.
6. Build time-driven rainbow:
   - `rainbow.r = sin(q1 * 0.7) * 0.5 + 0.5`
   - `rainbow.g = sin(q1 * 0.7 + 2.094) * 0.5 + 0.5`
   - `rainbow.b = sin(q1 * 0.7 + 4.189) * 0.5 + 0.5`
7. Add rainbow glint on the ice: `col += rainbow * (1.0 - vig) * 0.15 * q4`.
8. Bass-driven brightness: `col *= 0.9 + 0.1 * q2` (or use `q14`).
9. `ret = saturate(col)` — mandatory final clamp.

### 5.4 Custom waves

Keep **one custom wave** (`wavecode_0`) as a thick, additive trace:

- `enabled=1`
- `mode=0`
- `samples=128` (reduced from 200 for WASM; see performance budget)
- `bSpectrum=0` / `bSpectrum=1` depending on desired look (preserve original behavior)
- `bUseDots=0`, `bDrawThick=0` (or `1` if thick lines are preferred)
- `bAdditive=1`
- `scaling=1.0`, `smoothing=0.5`
- Color driven from `per_frame` via `wave_r`, `wave_g`, `wave_b`

If a circular spectrum layout is not desired, keep the original linear waveform but cap samples at 128.

### 5.5 Custom shapes

Keep **one custom shape** (`shapecode_0`), a centered hexagon:

- `enabled=1`
- `sides=6`
- `additive=0` (or `1` for a glow emblem)
- `thickOutline=0`, `textured=0`
- `num_inst=1`
- Positioned at center: `x=0.5, y=0.5`
- Per-frame radius pulsing: `rad = 0.08 + q2 * 0.04`
- Per-frame angle drift: `ang = q1 * 0.2`
- Fill colors:
  - `r=0.3, g=0.6, b=0.9, a=0.5`
  - `r2=0.1, g2=0.3, b2=0.6, a2=0.2`
- Border colors:
  - `border_r=0.4, border_g=0.7, border_b=1.0, border_a=0.4`

Keep alpha moderate so the hex reads as a translucent ice crystal rather than a solid sticker.

---

## 6. Performance Budget

| Component | Budget | Rationale |
|-----------|--------|-----------|
| Per-frame equations | ≤ 20 lines | All audio pre-cached in q-vars; no heavy loops. |
| Warp shader | ~18–22 ALU instructions, 1 texture fetch | Three `dot` projections, `floor`, `smoothstep`, `sin`, and a single `tex2D`; branchless. |
| Composite shader | ~12–16 ALU instructions, 1 texture fetch | Vignette, ice tint, three `sin` rainbow channels, and final `saturate`. |
| Custom wave samples | 128 | Reduced from 200 to keep WASM/WebGL vertex work small. |
| Custom shapes | 1 hexagon, 6 sides | Negligible cost; no need to reduce sides. |
| Total estimated fragment cost | ~35–45 instructions | Fits WebGL/GLES3 mobile limits; monitor on low-end devices. |

Risk areas to monitor:

- Three `sin` calls in the composite rainbow are cheap but can stack with the warp `sin`; acceptable for ~45 instructions total.
- The warp uses three `dot` plus `floor` per pixel; this is the dominant cost but still branchless.
- If frame rate drops, first reduce `wavecode_0_samples` from 128 to 96 or 64.
- Avoid enabling additional blur samplers; `sampler_main` alone is sufficient for the ice-lattice look.

---

## 7. WASM Upgrade Checklist

### Version headers

- [ ] Replace the legacy `PSVERSION=2` header with explicit version declarations:
  - `MILKDROP_PRESET_VERSION=200`
  - `PSVERSION_WARP=3`
  - `PSVERSION_COMP=3`
- [ ] Keep `fShader=0.000000` (legacy shader flag off); the version headers control shader execution.

### Decay clamp

- [ ] Keep `fDecay=0.960000` or clamp it to `[0.94, 0.990]`.
- [ ] Do not let `fDecay` exceed `0.999`; on WASM the framebuffer can retain ghosting indefinitely and never clear.
- [ ] Do not let `fDecay` fall below `0.93`; the ice-lattice feedback channels would vanish too fast.

### GLES3-safe HLSL

- [ ] No GLSL types: use `float2`/`float3`/`float4`, not `vec2`/`vec3`/`vec4`.
- [ ] No GLSL intrinsics: `lerp` not `mix`, `frac` not `fract`, `fmod` not `mod`, `saturate` not `clamp(..., 0, 1)`.
- [ ] No `#version`, `#pragma`, `#include`, or `layout` qualifiers.
- [ ] No `Texture2D` / `sampler2D` declarations; only built-in samplers (`sampler_main`, `sampler_blur1`, etc.).
- [ ] No dynamic loops; any loop must have a compile-time-constant bound.
- [ ] No division by zero or `pow(x, negative)` with `x` near zero.
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

1. **Validator agent:** Check the existing `custom_milk_fixed/milk014.milk` for the legacy `PSVERSION=2` header, missing version declarations, and any HLSL syntax issues noted above.
2. **Shader Architect agent:** Rewrite warp and composite blocks using the plan above, ensuring every line is HLSL-9 / GLES3 safe and that the hex SDF math is preserved.
3. **Performance Optimizer agent:** Audit the final preset against the performance budget; reduce wave samples from 200 → 128 (or 96/64) if needed for 60 fps in the browser.
4. **Preset Geneticist / assembler:** Rebuild the `.milk` file with the new headers, per-frame block, warp/composite shaders, and preserved (but reduced) wave/shape configurations.

**Output artifact:** an upgraded `.milk` file named `custom_milk_fixed/milk014.milk` (or a new variant) that loads cleanly in projectM WASM and retains the Hex Ice Lattice aesthetic.
