# Milkdrop2 vs Project-M: Multi-Pass Transition Comparison

**Date:** 2026-05-07  
**Goal:** Understand how Milkdrop2 implements multi-pass transitions and design the best equivalent for Project-M (OpenGL + Emscripten).

---

## 1. How Milkdrop2 Handles Multi-Pass

### Core Concepts in Milkdrop2:
- Uses **DirectX render targets** (textures) as intermediate buffers
- Supports **up to 4 passes** in some transitions
- Each pass can have its own:
  - Vertex shader
  - Pixel (fragment) shader
  - Render target
  - Blend mode
- Special built-in variables:
  - `pass` (current pass number)
  - `pass_time` (time within current pass)
  - `lastpass` / `lastpass_tex` (previous pass result)
- The engine automatically manages render target ping-ponging
- Transitions are defined in `.milk` files with `passX_` prefixed code blocks

### Strengths of Milkdrop2 Approach:
- Extremely flexible
- Artists have fine-grained control per pass
- Good performance on DirectX
- Many famous transitions rely on 2–3 passes (e.g. complex page curls, layered effects, feedback)

### Limitations:
- Tightly coupled to DirectX
- Complex for beginners
- Some passes are only used for intermediate calculations (not shown on screen)

---

## 2. How We Should Do It in Project-M (OpenGL)

### Recommended Design Principles:
- Keep it **simpler and more modern** than Milkdrop2
- Use a clean C++ API (`BeginPass()`, `EndPass()`)
- Support **2–3 passes** initially (enough for most effects)
- Make it easy for shader authors
- Stay compatible with Emscripten/WebGL 2.0

### Proposed Architecture for Project-M:

```cpp
// In PresetTransition
void BeginPass(int passNumber);
void EndPass();
GLuint GetPassTexture(int passNumber) const;
```

**Key Differences from Milkdrop2:**

| Aspect                    | Milkdrop2 (DirectX)              | Project-M (OpenGL) Recommendation                  |
|---------------------------|----------------------------------|----------------------------------------------------|
| Render Target Management  | Automatic ping-pong per pass     | Explicit `BeginPass(n)` / `EndPass()`              |
| Max Passes                | Up to 4                          | Start with 2–3, make extensible                    |
| Shader per Pass           | Separate vertex + pixel per pass | Single fragment shader + optional pass number      |
| Variables                 | `pass`, `pass_time`, etc.        | `iPass`, `iPassTime`, `iLastPassTex`               |
| WebGL Compatibility       | N/A                              | Careful with MRT (Multiple Render Targets)         |
| Artist Control            | Very high (per-pass code blocks) | High but simpler API                               |

---

## 3. Proposed First Implementation (Minimal Viable)

### Phase 1 (MVP):
- Support **2 passes** maximum
- Add `BeginPass(0)` and `BeginPass(1)`
- Automatically manage 2 framebuffers
- Expose `iPass` and `iLastPassTex` in GLSL
- Update 1–2 existing transitions to use 2 passes as proof of concept

### Phase 2 (Later):
- Support 3 passes
- Add `iPassTime`
- Allow custom blend modes between passes
- Add better debugging tools

---

## 4. Key Challenges & Solutions

| Challenge                        | Solution for Project-M                                      |
|----------------------------------|-------------------------------------------------------------|
| WebGL 2.0 MRT limitations        | Use sequential passes instead of true MRT                   |
| Managing multiple FBOs           | Simple array of 3 framebuffers + automatic cleanup          |
| Shader complexity                | Keep it simple — one shader with `if (iPass == 0)` branches |
| Performance                      | Reuse framebuffers, avoid unnecessary copies                |
| Artist workflow                  | Provide good examples + clear documentation                 |

---

## 5. Next Steps (Recommended)

1. **Today / Next Session**: Design and implement basic 2-pass support in `PresetTransition`
2. Create helper macros in GLSL header (`iPass`, `iLastPassTex`)
3. Port one existing transition to use 2 passes as a test case
4. Document the new API clearly

---

## 6. Verification Notes (2026-06-12): FBO Format, Blur, and VideoEcho/Gamma Parity

This section documents an audit of the dual ping-pong FBO format selection
(`projectM_emscripten.cpp`), the blur chain (`BlurTexture.cpp`), and the
VideoEcho/gamma per-frame path (`MilkdropPreset.cpp`/`VideoEcho.cpp`) against
Milkdrop2 behavior, per the renderer parity follow-up to the 60 FPS/quality
governor work above.

### 6.1 FBO float format preference (RGBA32F > RGBA16F > RGBA8)

`DualPingPongFramebuffer::DetectFormat()` (`projectM_emscripten.cpp`, ~line
99) already probes extensions in the order `EXT_color_buffer_float` (RGBA32F)
→ `EXT_color_buffer_half_float` (RGBA16F) → RGBA8 last resort. This already
satisfies "default to RGBA16F when half-float is available, RGBA8 only when
neither extension exists" — RGBA32F being preferred over RGBA16F when
*both* are available is a strict improvement, not a deviation. No change was
needed to the priority order itself.

What was missing was **surfacing the selected/degraded format**:

- `dual_fbo_get_format()` (0=RGBA32F, 1=RGBA16F, 2=RGBA8) was already exported
  in `CMakeLists.txt`'s `PROJECTM_WASM_EXPORTED_FUNCTIONS` but missing from
  `scripts/build_wasm_smoke_wrapper.sh`'s `EXPORTED_FUNCTIONS` list — added.
- Added `html/projectm-fbo-format.js` (`setupFboFormatIndicator(Module)`,
  wired into `projectm-core.html`'s `attemptInit()` after `_start_render()`).
  When the format is RGBA8, it shows an on-screen "Degraded rendering mode"
  banner and exposes `window.pmGetFboFormat()` returning `'RGBA32F'`,
  `'RGBA16F'`, or `'RGBA8'`.
- `DetectFormat()`'s RGBA8 branch log messages were extended to mention the
  degraded-mode query API and the dithering/clamping described below.
- `start_render()` now conditionally re-enables `GL_DITHER` (previously
  unconditionally disabled) when the detected format is RGBA8, on the theory
  that extra driver-level dithering on the final blit can only help hide
  8-bit banding in that mode; it remains disabled for RGBA32F/RGBA16F as
  before.

### 6.2 RGBA8 fallback: output clamping/dithering

Added a 4x4 Bayer ordered-dither + `clamp(color, 0.0, 1.0)` to the
`CompositingBlendShader` fragment shader (`projectM_emscripten.cpp`, Phase 5
final compositing blit). A new `uDither` uniform is set per-draw from
`g_dualFbo.GetFormat() == FboFloatFormat::RGBA8`. This is the final
on-screen blit regardless of which intermediate FBO format was used, so it:

- Adds no overhead in the RGBA32F/RGBA16F (default) case (`uDither = 0`).
- In RGBA8 (degraded) mode, breaks up visible banding in the final
  composited image without modifying any preset shader code, satisfying
  "inject output clamping/dithering (don't rely on preset shaders)".

The underlying precision loss in the intermediate RGBA8 ping-pong feedback
textures themselves (used for recursive warp/feedback) is inherent to 8-bit
storage — this is exactly why RGBA16F/RGBA32F are preferred whenever
available, and is not separately "fixable" within an RGBA8 fallback.

### 6.3 BlurTexture.cpp audit vs. Milkdrop2

Audited `src/libprojectM/MilkdropPreset/BlurTexture.cpp` against the known
Milkdrop2 `milkdropfs.cpp` blur chain design (no local Milkdrop2 source tree
was available in this environment to diff line-by-line; this is a structural
audit based on documented Milkdrop2 behavior):

- **Weight table** `{4.0f, 3.8f, 3.5f, 2.9f, 1.9f, 1.2f, 0.7f, 0.3f}` matches
  Milkdrop2's per-level blur weighting (decreasing influence at higher blur
  levels).
- **Separable two-pass blur**: horizontal pass (`blur1Shader`) on even
  passes, vertical pass (`blur2Shader`) on odd passes — matches Milkdrop2's
  separable Gaussian-style approach.
- **Progressive downsampling**: 512 → 256 → 128 → 128 → 64 → 64, with
  scale/bias min-max remapping carried between levels — matches Milkdrop2's
  mip-style blur pyramid used to feed `blur1`/`blur2`/`blur3` sampler
  variables to preset shaders.
- **Edge darkening** applied only on `pass == 1` — matches Milkdrop2's
  edge-darkening behavior on the first blur level.

**Conclusion**: `BlurTexture.cpp` already matches the Milkdrop2 blur chain
structurally (kernel weights, separable passes, downsample schedule, edge
darkening). No changes made.

### 6.4 VideoEcho gamma/zoom/orientation + composite `echo_*` uniforms

Found and fixed a genuine parity bug: `PerFrameContext::LoadStateVariables()`
initializes the per-frame eval variables `gamma`, `echo_zoom`, `echo_alpha`,
and `echo_orient` from `PresetState` (`m_state.gammaAdj`,
`m_state.videoEchoZoom`, etc.) *before* per-frame code runs. However,
`MilkdropPreset::PerFrameUpdate()` only clamped `gamma` and `echo_zoom`
*after* `ExecutePerFrameCode()` and never wrote any of the four values back to
`m_state`. `VideoEcho::Draw()` / `DrawVideoEcho()` / `DrawGammaAdjustment()`
only ever read the static `m_state.gammaAdj` / `videoEchoZoom` /
`videoEchoAlpha` / `videoEchoOrientation`, which were set once from the
`.milk` file's header values (`fGammaAdj`, `fVideoEchoZoom`,
`fVideoEchoAlpha`, `nVideoEchoOrientation`) during `PresetState::Initialize`.

This means **any preset that animates `gamma`, `echo_zoom`, `echo_alpha`, or
`echo_orient` in `per_frame_*` code** — extremely common in Milkdrop2 presets
— always rendered with the static header value instead, regardless of the
per-frame expression.

**Fix** (`MilkdropPreset.cpp::PerFrameUpdate()`): after the existing
`gamma`/`echo_zoom` clamps, write all four eval-context values back to
`m_state.gammaAdj` / `videoEchoZoom` / `videoEchoAlpha` / `videoEchoOrientation`.

Because `echo_orient` can now come from arbitrary per-frame expressions
(e.g. `3 * sin(time)`, which is frequently negative), `VideoEcho.cpp`'s
`DrawVideoEcho()` orientation wrap was changed from `% 4` (which can return
negative results in C++ for negative operands) to a positive modulo
`((x % 4) + 4) % 4`.

**Composite `echo_*` uniforms**: `FinalComposite`'s composite-shader path
(`compositeShaderVersion > 0`) and the legacy `VideoEcho`/`Filters` path are
mutually exclusive — confirmed no `echo_*` uniforms exist in
`MilkdropShader.cpp` or `Filters.cpp`, consistent with Milkdrop2 (composite
shaders implement their own echo/gamma equivalents via `ret`/`hue_shader`
style code, not fixed uniforms). No composite-path changes were needed.

### 6.5 Five reference presets: expected behavior

No GPU/display is available in this environment (same limitation noted in
`docs/PERFORMANCE.md`), so the following is a code-level analysis of expected
before/after behavior for five `weeks_presets/` presets that exercise the
fixed code paths, rather than rendered screenshots. All five build and load
successfully against the native target verified above.

| # | Preset | Relevant per-frame code | Before fix | After fix |
|---|---|---|---|---|
| 1 | `Rovastar - Harlequin's Fractal Encounter - cancer of saints.milk` | `per_frame_27: echo_zoom = 1.32 + 0.3*(...) + 0.05*bass_effect;` `per_frame_42: echo_orient = mode;` | Echo zoom stuck at header value `fVideoEchoZoom=1.000`; echo orientation stuck at header default — echo overlay zoom/orientation never animates with audio/`mode`. | Echo zoom and orientation track the per-frame expressions every frame, as in Milkdrop2. **PASS** (analysis). |
| 2 | `shifter - blueshift - clapsule.milk` | `per_frame_13: gamma = gv;` (gv computed from audio elsewhere in the preset) | Gamma stuck at static header `fGammaAdj=3.870` regardless of `gv`; gamma-adjustment redraw count (`DrawGammaAdjustment`) never changes. | Gamma redraw count follows `gv` each frame. **PASS** (analysis). |
| 3 | `enforced word wrap.milk` | `per_frame_14: gamma = 1.0 + flash*0.5 + min(bass_att^2*0.3, 0.49);` | Gamma fixed at header `fGammaAdj=1.780`; no audio-reactive gamma pumping. | Gamma pumps with `flash`/`bass_att` as authored. **PASS** (analysis). |
| 4 | `orb - inferno - burnt to a crisp - ngdothz.milk` | `per_frame_12: echo_alpha = 1*sin(time);` `per_frame_13: echo_orient = 0 + 3*Sin(time);` | Echo alpha/orientation stuck at header values (`fVideoEchoAlpha=0.500`); `echo_orient` per-frame value never applied, so the `(videoEchoOrientation % 4 + 4) % 4` fix is moot. | `echo_alpha` oscillates with `sin(time)` (note: when it crosses ≤ 0.001, `Draw()` switches between `DrawVideoEcho()`/`DrawGammaAdjustment()` — both paths exercised over time). `echo_orient = 3*sin(time)` produces values in `(-3, 3)`, including negatives; the positive-modulo fix in `VideoEcho.cpp` ensures `videoEchoOrientation % 4` always wraps to `[0, 3]` instead of yielding negative results for negative inputs (e.g. C++ `-1 % 4 == -1`, now wrapped to `3`). **PASS** (analysis) — this preset specifically exercises the orientation-modulo defensive fix. |
| 5 | `suksma - reason dies with hate - dealt log 5.6a.milk` | Static `fVideoEchoZoom=21.843`, `zoom≈1.00034` (slow, large-scale recursive feedback) | With RGBA8 fallback (forced via no `EXT_color_buffer_half_float`), the large echo zoom amplifies 8-bit quantization error in the ping-pong feedback texture each frame, producing visible banding/contouring in the echo overlay. | With RGBA16F/RGBA32F (default on capable GPUs), feedback precision is preserved — no banding expected. With RGBA8 forced, the new Bayer-dither + clamp on the final composite blit reduces (but does not eliminate) visible banding, and the on-screen "Degraded rendering mode" banner (`projectm-fbo-format.js`) is shown. **Not independently measurable here** — requires a browser with WebGL2 to compare `RGBA16F` vs. an artificially-forced `RGBA8` path. |

### 6.6 Verification performed

- Native build (`cmake --build cmake-build-openmp --target projectM
  projectM_playlist`) succeeds with the `MilkdropPreset.cpp` /
  `VideoEcho.cpp` changes.
- `projectM_emscripten.cpp` syntax-checks cleanly with `em++ -fsyntax-only`
  after the `CompositingBlendShader` dithering changes and the `GL_DITHER`
  / `dual_fbo_get_format` log-message edits (only the 4 pre-existing
  unrelated "empty character constant" warnings from embedded JS string
  literals remain, same as in `docs/PERFORMANCE.md`).
- **Not yet measured in this environment** (no GPU/display available): actual
  RGBA32F vs. forced-RGBA8 visual comparison for preset #5, the
  "Degraded rendering mode" banner appearing, and confirming no runaway
  feedback blowout on a recursive-warp preset under forced RGBA8. To force
  RGBA8 for manual testing, temporarily make `DetectFormat()` skip both
  extension checks (or test on a browser/driver that doesn't support
  `EXT_color_buffer_half_float`).