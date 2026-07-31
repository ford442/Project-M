# Option B: Milkdrop Blending Parity (Long-term Incremental Project)

**Status:** Active — Phase B2 complete, B3 complete (all 5 blend modes shipped),
B4 complete, B5 in progress (4 favorites shipped), B6 in progress  
**Approach:** Incremental sessions (at least once per week)  
**Goal:** Make Project-M’s preset transitions feel as smooth, organic, and high-quality as classic Milkdrop.

---

## Overall Vision

Milkdrop’s transitions feel special because of:
- Precise render target handling
- Natural timing and easing
- Multi-pass effects on some transitions
- Careful texture sampling and filtering
- Frame-accurate synchronization

We want to close the gap while staying Emscripten/WebGL compatible.

---

## Phased Roadmap

| Phase | Name                              | Focus                                          | Priority | Est. Sessions | Status    |
|-------|-----------------------------------|------------------------------------------------|----------|---------------|-----------|
| **B1**    | Gap Analysis & Prioritization     | Identify biggest differences vs Milkdrop       | High     | 1–2           | Done      |
| **B2**    | Multi-pass Transition Support     | Enable 2-pass and simple multi-pass effects    | High     | 3–4           | **Done**   |
| **B3**    | Advanced Blending & Compositing   | Add more sophisticated blending modes          | Medium   | 3–4           | **Done**    |
| **B4**    | Timing, Synchronization & Polish  | Match Milkdrop’s frame-accurate feel           | High     | 2–3           | **Done**    |
| **B5**    | Exotic Effects & Favorites        | Replicate beloved Milkdrop transitions         | Medium   | Ongoing       | **In progress** (4 shipped) |
| **B6**    | Performance & Parallelism         | Add OpenMP pragmas + other optimizations       | Medium   | 2–4           | **Started** |

---

## Session Guidelines

- Work in focused 1–3 hour sessions
- Always leave the codebase in a clean, buildable state
- Document progress in this file after each session
- Prioritize **high visual impact** changes early

---

## Completed Work (Latest Session)

### Phase B2: Multi-pass Transition Support (Complete)

**Implemented:**
- `PresetTransition` multi-pass framework:
  - `SetPassCount(int)` / `PassCount()`
  - `BeginPass(int, int, int)` / `EndPass()` / `GetCurrentPass()`
  - `GetPassTexture(int)` for external sampling
- `TransitionShaderManager` pass-count tracking per shader
- `ProjectM::StartPresetTransition()` wires up pass count automatically
- GLSL uniforms `iPass` and `iLastPassTex` in `TransitionShaderHeaderGlsl330.frag`
- Intermediate FBO management in `PresetTransition::Draw()`
- **PageCurl** ported to 2-pass (geometry + lighting/highlight/glow)
- **HeatWave** ported to 2-pass (distortion + heat shimmer/haze)
- **Glitch** ported to 2-pass (displacement/crossfade + scanlines/block corruption/RGB bleed)
- MultiPassTest shader (proof of concept) registered
- Unit tests in `tests/libprojectM/PresetTransitionMultiPassTest.cpp`:
  - Pass-count registry and shader compilation checks
  - Intermediate FBO reuse across 100 pass cycles
  - Rapid transition instance lifecycle (100 create/destroy, texture ID bound)
- Headless EGL test fixture (`HeadlessGlContext`) for CI-friendly GL tests

### Phase B3: Advanced Blending (Complete)

**Implemented:**
- `TransitionBlendMode` enum + `iBlendMode` uniform (Alpha, Additive,
  Multiplicative, Screen, Masked)
- Reusable GLSL blend library in `TransitionShaderHeaderGlsl330.frag`
- `prjmBlendPresets()` helper for per-channel preset mixing
- Per-transition random blend mode selection in `PresetTransition` constructor
- Advanced-blend usage expanded from 3 to 15 built-in transitions (see coverage
  table below)
- Fixed the **Circle** shader's `sampler2D` ternary (`iChannel0 : iChannel1`),
  which is illegal in GLSL ES / WebGL2 and previously dropped Circle from the
  compiled pool. Now branches on direction explicitly — one more transition
  available on WebGL2 with no GLES regression.
- **`Masked` implemented** (was reserved): `blendMasked()` builds a two-octave
  value-noise mask from `gl_FragCoord`/`iRandStatic` and turns the incoming blend
  factor into a per-pixel dissolve threshold, so the crossfade breaks up into an
  organic mottled reveal instead of a uniform fade. The mask is procedural rather
  than a texture lookup on purpose: the noise samplers are optional, and an
  unbound sampler would silently collapse the mask to black. The factor is
  remapped so `t == 0` and `t == 1` are still exact — a Masked transition starts
  and finishes on the same frame as any other. All 5 modes are now in the random
  rotation (`Count`, not `Masked`, bounds the draw).
- **End-of-transition pop fixed.** Additive ended on `old + new`, Multiplicative
  on `old * new` and Screen on `screen(old, new)` — none of which is the new
  preset, so the frame the transition completed and the renderer hard-cut to the
  new preset visibly jumped. All stylized modes now go through
  `_prjmEndpointSafe()`, which weights the stylized composite with a hump that
  vanishes at `t == 0` and `t == 1`, so the endpoints are exact while the
  mid-transition look (where the mode's character reads) is unchanged. For the
  transitions that pass a per-pixel mask as the blend factor rather than progress,
  this also keeps fully-old and fully-new regions clean and confines the stylized
  blend to the moving band.

#### Blend-mode coverage

`iBlendMode` is randomized per transition across all five implemented modes
(Alpha / Additive / Multiplicative / Screen / Masked). GLES3/WebGL2 share the same
uniform block — the blend library uses only `mix`, arithmetic, `int` comparison
and bitwise `&`, all core GLSL ES 3.00, so there is no desktop-vs-web divergence.
`scripts/check_transition_shaders.sh` proves this by assembling every built-in
shader exactly as `TransitionShaderManager` does and running it through
`glslangValidator` under both `#version 330` and `#version 300 es`; it runs on
every push in the "Transition shader GLSL/GLES validation" job.

| Transition   | Advanced blend | Notes |
|--------------|:--------------:|-------|
| SimpleBlend  | ✅ | Full `if`-ladder over all 4 modes + vignette/contrast |
| Dreamy       | ✅ | `prjmBlendPresets` on the radial-blurred pair |
| Glitch       | ✅ | Multi-pass; blend applied in the crossfade pass |
| MotionBlur   | ✅ | Blend factor = directional wipe mask |
| ZoomBlur     | ✅ | Blend on the zoom-blurred old vs. sharp new |
| Warp         | ✅ | Blend on the twist-warped sample pair |
| Plasma       | ✅ | Blend on the noise dissolve (before molten edge) |
| Pixelate     | ✅ | Blend on pixelated-old vs. sharp-new |
| WaterDrop    | ✅ | Blend factor = ripple mask |
| Sweep        | ✅ | Old kept as base so Additive/Screen brighten the seam |
| Kaleidoscope | ✅ | Blend on the radial reveal |
| Burn (B5)    | ✅ | Blend factor = burn field |
| RadialWipe (B5) | ✅ | Blend factor = clock-sweep reveal |
| LiquidMelt (B5) | ✅ | Blend factor = melt-line reveal |
| Tunnel (B5)  | ✅ | Multi-pass; blend on the zoom-trail hand-off in pass 0 |
| Circle       | ➖ | Geometric per-pixel select + chromatic aberration; a blend mode would fight the hard circular boundary |
| CubeRotate   | ➖ | Per-pixel face selection (3D geometry), not a full-frame crossfade |
| TileFlip     | ➖ | Per-tile card front/back selection |
| MosaicZoom   | ➖ | Per-tile alpha compositing with drop shadows |
| SliceSwipe   | ➖ | Per-slice geometric slide |
| PageCurl     | ➖ | Multi-pass geometry + lighting; own compositing |
| HeatWave     | ➖ | Multi-pass distortion + shimmer; own compositing |

➖ = intentionally geometric/mask-based; a global blend mode is not meaningful
because each pixel shows one preset or the other rather than a mixed result.

### Phase B4: Timing, Synchronization & Polish (Complete)

**Implemented:**
- `PresetTransition::SetEasingType()` / `GetEasingType()` accessors (easing curve
  was already randomized per transition and applied via `iProgressEased`; it is
  now inspectable/controllable and unit-tested).
- Rapid-switch / interrupt stress test suite
  (`tests/libprojectM/PresetTransitionStressTest.cpp`):
  - 500 constructions confirm the randomized blend mode and easing curve always
    stay within their implemented ranges (never `Count`) **and** that every
    implemented mode/curve is actually reachable — a randomization bound that
    excludes the last entry (as it did while `Masked` was a placeholder) shows up
    as an empty bucket.
  - Explicitly setting a blend mode / easing curve overrides the constructor's
    randomized pick for every enum value.
  - 100 rapid single-pass transitions allocate **no** intermediate FBO.
  - 100 interleaved single/multi-pass transitions do not leak textures
    (texture-ID bound check).
  - Pass count toggled mid-flight (simulating a preset arriving before the
    current transition finishes) resets pass state cleanly and reuses the same
    intermediate texture — no FBO leak on interrupt.
  - Progress is monotonic and clamped to `[0, 1]` before start, during, and after
    completion; zero-duration transitions are instant hard cuts.
  - 200 viewport resizes on a live multi-pass transition recycle the intermediate
    render target instead of accumulating GL objects (a resize destroys and
    recreates the attached texture, so this is the window-drag leak case).
  - The multi-pass roster is pinned: a shader added to the pool without its pass
    count (and which would therefore render only its first pass) fails the test.
  - All 22 built-in transition shaders compile on the headless test platform.
  - Runnable on its own via `ctest -R PresetTransitionStress`.
- Host readiness polling (`html/projectm-transitions.js`) is **pass-count
  agnostic** — pass count is resolved entirely inside `ProjectM`/
  `TransitionShaderManager` on the native side, so adding multi-pass shaders
  needs no host change. `startTransitionWhenReady` still gates only on preset-B
  allocation/readiness, and that contract is now covered by
  `tests/web/projectm-transitions.test.mjs` (run by `scripts/test_web_embed.sh`
  in the Linux workflow):
  - readiness gating, allocation retry when `dual_fbo_begin_transition` fails,
    and the "already active" early-out
  - the frame-budget timeout stops polling instead of looping forever
  - **100 rapid switches** (the browser-side twin of the native stress test)
    supersede each other: every superseded poll resolves rather than dangling,
    exactly one transition is started, and no poll loop survives the storm

### Phase B5: Exotic Effects & Favorites (In progress — 4 shipped)

**Implemented (4 high-impact Milkdrop-style looks):**
- **Burn** — the classic "burn away" dissolve: the old preset erodes along a
  two-octave value-noise field like burning paper, with a hot ember edge that
  glows just ahead of the advancing burn line and a charred darkening behind it.
  Bass pumps ember brightness; treble flickers the flame color.
- **RadialWipe** — a clock/radar sweep that rotates around a (usually central)
  pivot, revealing the new preset behind a soft leading edge with a glowing seam.
  Mid drives a subtle wobble; bass brightens the seam.
- **LiquidMelt** — the "melt away" look: the old preset softens into vertical
  columns that sag and drip off the bottom at staggered, gravity-accelerated
  speeds, stretching like hot wax while the new preset appears behind the
  receding melt line. A wet meniscus highlight and a refractive lens along the
  drip front sell the liquid feel; bass accelerates the drips, treble ripples the
  surface. Single-pass.
- **Tunnel** — "fly into the tunnel": the old preset recedes down a swirling
  tunnel while the new preset rushes out of the vanishing point. Two passes —
  pass 0 accumulates the zoom/rotate trail for both presets and cross-blends at
  the vanishing point, pass 1 adds radial chromatic aberration, motion streaks, a
  bass-pumped tunnel-mouth glow, treble rim sparkle and a speed-tightened
  vignette. The vanishing point, swirl direction and swirl strength are
  randomized per transition.

All four reuse the Phase B3 blend library and are registered in
`TransitionShaderManager` + `Renderer/CMakeLists.txt`.

**Intentionally deferred** (documented as different, not ported):
- **True frame-feedback transitions.** Classic Milkdrop gets its tunnel smear by
  re-sampling the previous frame. A transition shader has no frame history and
  adding one would mean another persistent render target for the whole
  transition. Tunnel instead rebuilds the trail every frame from 8 fixed zoom
  taps — visually equivalent over a 1.5s transition at no extra render-target
  cost. Real feedback stays out of scope.
- **True 3D depth-buffer transitions** (cube/sphere with real occlusion) — the
  transition pass is a full-screen quad with no depth attachment; CubeRotate and
  TileFlip fake the geometry per-pixel instead.
- **DirectX-specific texture-addressing tricks** — behavior outside the
  Emscripten/WebGL2 core-profile target.

### Phase B6: Performance & Parallelism (Started)

**Implemented:**
- OpenMP pragmas added to **11 waveform generators** that were missing them
- `Audio/PCM.cpp::CopyNewWaveformData()` — 576-sample buffer copy
- `Renderer/VertexIndexArray.cpp::MakeContinuous()` — index buffer fill
- `MilkdropPreset/CustomWaveform.cpp` — waveform scaling loop

All pragmas use the existing `#ifdef PRJM_ENABLE_OPENMP` guard with `schedule(static)`. No regressions on Emscripten (pragmas compile away when `ENABLE_OPENMP=OFF`).

---

## Next Session

**Recommended focus:** Continue B5 with 1–2 more favorites (a shatter/glass-break
look and a "star wipe" are the remaining obvious gaps), and/or capture
side-by-side screenshots/GIFs of the shipped Burn / RadialWipe / LiquidMelt /
Tunnel transitions for the docs — the nightly screenshot workflow
(`.github/workflows/nightly_preset_screenshots.yml`) already builds with
`ENABLE_WASM_TRANSITIONS=ON` and is the natural place to hang capture from.

**Blend-mode stretch (optional):** the `Masked` dissolve currently uses a
procedural noise field. Feeding it from a user-supplied grayscale mask texture
would let hosts author custom wipe shapes, but needs a texture-binding path and
a fallback for when no mask is bound.

---

## Detailed Gap Breakdown & Sub-Plans

### 1. Multi-pass Transition Support (Highest Visual Impact)
**Goal:** Enable transitions that require 2–3 render passes (like some classic Milkdrop effects).

**Detailed Steps:**
1. Add support for secondary and tertiary framebuffers in `PresetTransition` class
2. Design and implement a clean multi-pass API (`BeginPass(n)`, `EndPass()`, `GetPassTexture(n)`)
3. Create a base class or interface for multi-pass transitions
4. Port/recreate 2–3 example multi-pass transitions (e.g. complex PageCurl with backface + highlight pass, layered effects)
5. Update GLSL header to support multiple render targets when needed
6. Add automatic cleanup of extra framebuffers after transition ends
7. Write unit tests for multi-pass flow

**Key Files:**
- `src/libprojectM/Renderer/PresetTransition.hpp/.cpp`
- `src/libprojectM/Renderer/Framebuffer.hpp`
- New files: `MultiPassTransition.hpp`, example transition shaders

**Challenges:**
- WebGL 2.0 has limited MRT (Multiple Render Targets) support
- Managing multiple FBOs without leaking memory on Emscripten
- Shader complexity increases significantly

**Success Criteria:**
- At least 3 working multi-pass transitions
- No memory leaks after 100 rapid transitions
- Clean API that future transitions can easily use

**First Small Step:** Add secondary framebuffer support + `BeginPass(1)` / `EndPass()` skeleton.

**Priority:** High | **Est. Effort:** 4–5 sessions

---

### 2. Transition Timing & Frame Accuracy
**Goal:** Make transitions feel as locked and precise as Milkdrop.

**Detailed Steps:**
1. Audit current timing system in `PresetTransition` and `Renderer`
2. Implement frame-accurate progress calculation (using actual frame count instead of time delta)
3. Add per-transition timing curves (linear, ease, custom bezier)
4. Add beat-sync options (start transition on beat, sync progress to beat)
5. Expose fine-grained control (`SetTransitionDuration()`, `SetEasingCurve()`, `SyncToBeat()`)
6. Add optional visual debug overlay (progress bar + beat markers)
7. Compare timing feel against real Milkdrop using side-by-side testing

**Key Files:**
- `src/libprojectM/Renderer/PresetTransition.hpp/.cpp`
- `src/libprojectM/Renderer/Renderer.cpp`
- Possibly new `TransitionTiming.hpp
`

**Challenges:**
- Keeping timing consistent across different frame rates
- Emscripten timing can be less precise than desktop
- Beat detection must remain responsive

**Success Criteria:**
- Transitions feel “locked” and musical
- < 1 frame timing variance at 60fps
- Easy to use beat-sync API

**First Small Step:** Replace delta-time progress with frame-based progress calculation.

**Priority:** High | **Est. Effort:** 3 sessions

---

### 3. Advanced Blending & Compositing
**Goal:** Add more sophisticated ways to combine the two presets beyond basic alpha.

**Detailed Steps:**
1. Implement a `BlendMode` enum (Alpha, Additive, Multiplicative, Screen, Masked, etc.)
2. Create a small library of reusable blending functions in GLSL header
3. Allow transitions to dynamically choose blending mode
4. Add support for mask textures (grayscale mask controls blending strength)
5. Update 4–5 existing shaders to demonstrate new blending modes
6. Add documentation and examples for custom blending

**Key Files:**
- `TransitionShaderHeaderGlsl330.frag`
- `PresetTransition.cpp`
- Several transition shader `.frag` files

**Challenges:**
- Some blending modes can look bad at low opacity
- Mask texture management adds complexity
- Performance cost of more complex blending

**Success Criteria:**
- At least 5 distinct blending modes working
- Clean API for choosing mode per transition
- Good visual results across different presets

**First Small Step:** Add `BlendMode` enum + basic Additive and Multiplicative blending.

**Priority:** Medium | **Est. Effort:** 3–4 sessions

---

### 4. Render Target Quality & Filtering
**Goal:** Match or exceed Milkdrop’s render target quality during transitions.

**Detailed Steps:**
1. Review current framebuffer creation in `MilkdropPreset` and `PresetTransition`
2. Add automatic mipmap generation for transition textures
3. Implement better downsampling (use proper box filter or Lanczos where possible)
4. Add configurable quality levels (Performance / Balanced / Quality)
5. Add anisotropic filtering controls (desktop only)
6. Benchmark current vs target quality using test patterns
7. Document recommended settings per platform

**Key Files:**
- `src/libprojectM/Renderer/MilkdropPreset.cpp`
- `src/libprojectM/Renderer/PresetTransition.cpp`
- `src/libprojectM/Renderer/Framebuffer.cpp`

**Challenges:**
- Mipmap generation cost on Emscripten
- WebGL has limited filtering options compared to desktop OpenGL
- Memory usage increases with higher quality settings

**Success Criteria:**
- Visible improvement in smooth gradients and fine details during transitions
- No significant performance regression on target hardware

**First Small Step:** Add automatic mipmap generation for transition textures.

**Priority:** Medium | **Est. Effort:** 2–3 sessions

---

### 5. Preset State Isolation During Transition
**Goal:** Keep the two presets more cleanly isolated (like Milkdrop).

**Detailed Steps:**
1. Audit all shared state between old and new presets
2. Improve isolation of:
   - Random number generators / seeds
   - Beat reactivity variables
   - Per-preset `q` variables and custom variables
3. Add optional “strict isolation” mode
4. Document current behavior and trade-offs
5. Test with complex presets that heavily modify state
6. Add unit tests for state isolation

**Key Files:**
- `src/libprojectM/MilkdropPreset/MilkdropPreset.cpp`
- `src/libprojectM/Renderer/PresetTransition.cpp`
- Possibly `PerFrameContext` or similar

**Challenges:**
- Some presets intentionally share state for artistic effect
- Strict isolation may break some existing presets
- Performance cost of full isolation

**Success Criteria:**
- Old and new presets no longer interfere unexpectedly
- Easy to enable strict isolation when desired
- Backward compatibility maintained

**First Small Step:** Document current state sharing behavior + add isolation toggle.

**Priority:** Medium | **Est. Effort:** 2 sessions

---

### 6. Visual “Feel” of Specific Effects
**Goal:** Make key transitions feel more alive and Milkdrop-like.

**Detailed Steps:**
1. Select top 6–8 most visually important transitions (Glitch, HeatWave, WaterDrop, PageCurl, Kaleidoscope, etc.)
2. Analyze Milkdrop versions for subtle techniques (timing offsets, noise modulation, feedback, color cycling)
3. Enhance our versions with similar micro-details
4. Create side-by-side comparison (optional but very useful)
5. Iterate based on visual feedback from multiple people
6. Add parameters to let users tweak the “Milkdrop feel” intensity

**Key Files:**
- Individual transition shader files
- Possibly new helper functions in GLSL header

**Challenges:**
- “Feel” is subjective
- Some Milkdrop tricks rely on DirectX-specific behavior
- Risk of overcomplicating simple effects

**Success Criteria:**
- Key transitions feel noticeably more dynamic and “alive”
- Users familiar with Milkdrop recognize the improvement

**First Small Step:** Pick 2 transitions (e.g. Glitch + HeatWave) and add 1–2 subtle Milkdrop-style enhancements.

**Priority:** Medium-High | **Est. Effort:** 5–7 sessions (ongoing)

---

### 7. Performance on Complex Transitions + OpenMP (B6)
**Goal:** Make heavier transitions run smoothly and take advantage of multi-core CPUs.

**Detailed Steps:**
1. Profile current transition performance (especially on desktop)
2. Identify hot spots (shader compilation, texture uploads, blending passes)
3. Add OpenMP pragmas in key areas:
   - Preset loading / initialization
   - Parallel shader variable evaluation (if applicable)
   - Texture processing
4. Optimize framebuffer operations (avoid unnecessary copies)
5. Add performance warnings for very heavy transitions
6. Create performance regression tests
7. Document recommended settings per platform

**Key Files:**
- `src/libprojectM/Renderer/PresetTransition.cpp`
- `src/libprojectM/MilkdropPreset/MilkdropPreset.cpp`
- Various preset loading code

**Challenges:**
- OpenMP support varies across compilers and Emscripten
- Thread safety of OpenGL calls
- Debugging parallel code is harder

**Success Criteria:**
- Measurable performance improvement on multi-core desktop systems
- No regressions on Emscripten
- Clean, maintainable use of OpenMP

**First Small Step:** Add OpenMP to preset loading/initialization and measure improvement.

**Priority:** Medium | **Est. Effort:** 4–5 sessions (part of B6)