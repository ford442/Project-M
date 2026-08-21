# Graphics FPS Recovery Plan (Ping-Pong FBO → 60 FPS)

Living tracker for recovering steady-state framerate after dual ping-pong / Dual-FBO
work slowed WASM playback below 60 FPS, and for advancing WebGL2 (and evaluating
WebGPU) without regressing Milkdrop feedback quality.

Canonical discussion: GitHub epic
[#174 — Graphics FPS Recovery](https://github.com/ford442/Project-M/issues/174).
This file is the in-repo companion so the plan travels with the code.

**Status (2026-08-13):** Plan + five sub-issues filed. #175 (format policy + lazy
allocation + helper fixups), #176 (pre-warp flip removed, `glBlitFramebuffer` for final
output) and #177 (blur renders straight into its destination textures) have landed
in-tree — #177's code has been in the tree since before this update (commit
`2ba6a84`), the GitHub issue just hadn't been closed/linked to a PR; the code-truth
findings in this document already reflected the landed state. **#178 (Governor v2) has
now landed in-tree** — see [§178 implementation notes](#178-implementation-notes-governor-v2)
and `docs/PERFORMANCE.md`'s "Adaptive quality governor (WASM, v2)" section. **#179's spike has
now landed in-tree** — see [§179 implementation notes](#179-implementation-notes-webgl2-advances-and-webgpu-spike-report)
for the WebGL2 outcomes and the **defer** decision on WebGPU.
**No sub-issue has before/after benchmark JSON yet** — that requires a GPU and a
browser, and every code-truth finding here (including #178's) was reached by reading/
writing the tree, not by measuring.
The "verify first" step is now done against the tree — see
[Verified against the tree](#verified-against-the-tree-2026-07-31) before picking up
any sub-issue. Two results change the plan: the largest listed suspect is **already
fixed in code** (so #175's headline item is a deploy check, not a code change), and the
**HUD cannot rank the GPU suspects against each other**, which the diagnosis cheat
sheet below assumes it can.

Related (do not duplicate): [#173](https://github.com/ford442/Project-M/issues/173)
(ASYNCIFY / heap / OpenMP gates), [#80](https://github.com/ford442/Project-M/issues/80)
measurement harness, [#81](https://github.com/ford442/Project-M/issues/81) OffscreenCanvas
worker (opt-in).

---

## Goals

- Get **steady-state WASM playback back to ~60 FPS** on desktop Chrome at typical
  demo resolutions (document with `?benchmark=1`).
- Keep soft-cut **Dual-FBO transitions** without paying their cost every frame.
- Cut **mandatory fullscreen GPU copies** in the core Milkdrop ping-pong path.
- Extend the quality governor beyond mesh-only so fill-bound devices can hold FPS.
- Decide, with evidence, how far to push **WebGL2** vs when (if ever) to invest in
  **WebGPU**.

---

## Why we lost FPS (two ping-pong layers)

### Layer A — Core Milkdrop feedback (every platform, every frame)

`MilkdropPreset` owns a 2-surface FBO (`m_framebuffer{2}`). Each frame:

1. Bind previous → motion vectors  
2. **Fullscreen Y-flip** via `CopyTexture` → `mainTexture` for warp  
3. Bind current → warp mesh + blur + waves/shapes  
4. **Another Y-flip** (and sometimes a third) around composite  
5. `std::swap` current/previous  

This feedback ping-pong is **required** for Milkdrop warp. The tax is the extra
fullscreen shader copies, not the existence of two color attachments.

Key files: `src/libprojectM/MilkdropPreset/MilkdropPreset.cpp`,
`Renderer/CopyTexture.cpp`, `Renderer/Framebuffer.cpp`.

### Layer B — WASM DualPingPongFramebuffer compositor (transitions)

`projectM_emscripten.cpp` maintains up to four FBOs (A_Read/A_Write, B_Read/B_Write)
with float preference **RGBA16F → RGBA32F → RGBA8** by default (RGBA32F opt-in via `?fboPrecision=high`), then a fullscreen
`CompositingBlendShader` blit to the canvas.

| Phase | Behavior | FPS impact |
|-------|----------|------------|
| Early Dual-FBO | Compositor ran **every frame** | Steady-state regression (main 60→N drop) |
| Current (`ShouldUseDualFboCompositor`) | Compositor only while `g_transitionActive` | Steady-state should recover if this build is deployed |
| Remaining cost | 2× render during crossfade, plus RGBA32F bandwidth when high-precision opt-in is used | Transition / VRAM / mobile |

**First verification step:** confirm the deployed bundle includes direct-to-canvas
steady-state. If an older bundle is live, shipping that fix alone is the largest win.

### Concurrent load increase

Default mesh rose to **80×60** (~4941 verts) vs older 48×36 / 32×24. Governor v1
only steps to 64×48. High `perPixelEvalMs` can dominate even after compositor fixes —
measure before blaming FBO alone (`?meshQuality=low` A/B).

---

## Diagnosis cheat sheet

Use `html/projectm-core.html?perfhud=1` and `?benchmark=1&frames=500&preset=...`
([`PERFORMANCE.md`](PERFORMANCE.md)).

| HUD signal | Likely cause | Issue |
|------------|--------------|-------|
| High `compositeMs`/`gpuMs`, no transition | Old every-frame Dual blit, or Y-flip chain | #175, #176 |
| High `blurMs` | Blur passes (the `glCopyTexSubImage2D` copies are gone as of #177) | #177 |
| High `perPixelEvalMs` | 80×60 mesh / OpenMP pool | #178 (+ existing mesh/OpenMP work) |
| Spike only during soft-cut | Dual FBO float bandwidth / double render | #175 |
| Mobile-only `gpuMs` | Canvas MSAA + fill rate | #178 |

> ⚠️ This mapping assumes the per-stage buckets measure GPU cost. They do not — see
> [Measurement: what the HUD can and cannot tell you](#measurement-what-the-hud-can-and-cannot-tell-you).
> `gpuMs` is real but whole-frame, so it answers "GPU-bound or CPU-bound?" and not
> "which GPU stage?".

---

## Verified against the tree (2026-07-31)

Every suspect below was checked by reading the current `main`. Nothing here was
measured — this environment has no Emscripten toolchain and no GPU, so these are
code-truth findings that tell you where to point the profiler, not benchmark results.

### 1. Every-frame compositor blit — **already fixed in code** (#175)

`ShouldUseDualFboCompositor()` (`projectM_emscripten.cpp:475`) returns false unless a
transition is active, and `render_frame()` takes the direct-to-canvas path in that case
(`projectM_emscripten.cpp:503-509`). The steady-state extra FBO resolve + fullscreen
blit is gone from the source.

**So the open question is purely deployment.** If the live bundle predates this,
shipping a current build *is* the fix and no code work is needed. Check the deployed
`PROJECTM_WASM_BUNDLE` before spending a session on #175's headline item.

### 2. Preset A pair is now lazily allocated (#175 → #199 — landed)

`start_render()` records viewport size but defers Preset A/B texture allocation
until `dual_fbo_begin_transition()` is called. That removes idle steady-state VRAM
residency for Preset A in non-transition playback.

**#199 follow-up.** Cold-start laziness alone only bought the window before the first
preset switch: `PromoteBtoA()` left the pair resident for the rest of the session
afterwards, even though the compositor gate is false between transitions. The pair is
now reclaimed by `ReleaseDualFboIfIdle()` after a grace period
(`dual_fbo_set_idle_release_seconds()`, default 5 s), so steady-state residency is 0 B
at every point, not just before the first transition. Three wedge/leak paths were
closed alongside it: `transition_start()` no longer arms a blend the compositor cannot
run (which pinned `g_transitionActive` at true and both pairs resident forever),
`dual_fbo_begin_transition()` unwinds a lazily-allocated Preset A when Preset B fails,
and a timed-out host readiness poll hands its pairs back. Figures and the unmeasured
caveats are in
[PERFORMANCE.md](PERFORMANCE.md#dual-fbo-vram-residency-and-lazy-preset-a-allocation-issue-199).

The format policy also now defaults to RGBA16F (with RGBA32F opt-in), cutting both
transition-time bandwidth and float texture footprint on capable GPUs.

### 3. Y-flip chain — confirmed 2 passes, sometimes 3 (#176)

Per frame, in `MilkdropPreset::RenderFrame()`:

| Line | Pass |
|------|------|
| `MilkdropPreset.cpp:116` | flip previous frame → `m_flipTexture`, used as `mainTexture` for warp |
| `MilkdropPreset.cpp:166` | flip current frame → `m_flipTexture`, used as `mainTexture` for composite |
| `MilkdropPreset.cpp:178` | **third** flip, only when the preset has no composite shader (`!HasCompositeShader()`) |

So the "2–3 fullscreen passes" in the plan is accurate, and the third is
preset-dependent — old-school presets without a composite shader pay 50% more flip
cost than shader presets. Worth splitting the benchmark preset set accordingly, or the
A/B will be dominated by which presets happened to be sampled.

### 4. Blur chain — confirmed, 1 copy per pass — **fixed** (#177)

> **Landed.** `BlurTexture` now renders each pass straight into its destination texture;
> the per-pass `glCopyTexSubImage2D` is gone. The analysis below is kept as the record of
> what was wrong and how the hazards were handled. See
> [#177 implementation notes](#177-implementation-notes-blur-render-to-texture).

`BlurTexture::Update()` runs `passes = blurLevel * 2` iterations
(`BlurTexture.cpp:160`). Each iteration draws a fullscreen quad into the shared
`m_blurFramebuffer` and then copies the result out with `glCopyTexSubImage2D`
(`BlurTexture.cpp:262-267`). At `Blur3` that is **6 draws + 6 full-surface copies**;
the copies are pure overhead and the sub-issue's plan (attach the destination texture
directly) is the right fix.

Three hazards in the current `Framebuffer` API will bite whoever implements it:

- **`SetAttachment()` uses `std::map::insert`** (`Framebuffer.cpp`, in
  `SetAttachment`), which is a **no-op when the key already exists**. It still calls
  `glFramebufferTexture2D` with the new texture, so after the first re-attach the GL
  state and the tracked `m_attachments` map disagree, and
  `GetColorAttachmentTexture()` returns a stale texture. Re-attaching per pass needs
  `insert_or_assign` (fixing this is a prerequisite, not an optional cleanup).
- **`SetAttachment()` early-outs of the GL call** unless `m_width > 0 && m_height > 0`,
  so the blur FBO still needs a size set before any attachment is bound.
- **`Framebuffer::SetSize()` resizes every tracked attachment.** Once blur textures are
  attached, any later `SetSize()` on that FBO would reallocate them out from under
  `AllocateTextures()`. The current `SetSize()` call at `BlurTexture.cpp:367` must move
  or go away.

Note also that `glCopyTexSubImage2D` is one of the few calls here that can force
CPU-visible ordering — which is why `blurMs` (a CPU-side bucket) shows blur cost at all
while the other GPU stages read near zero. Removing the copies will *reduce* `blurMs`
far more than it reduces frame time. Do not read that drop as the full win.

#### #177 implementation notes (blur render-to-texture)

`BlurTexture` owns a dedicated FBO (`m_directFramebufferId`, raw GL rather than
`Renderer::Framebuffer`) and re-points `GL_COLOR_ATTACHMENT0` at
`m_blurTextures[pass]` before each pass. At `Blur3` that removes **6 full-surface
`glCopyTexSubImage2D` calls per frame** and the shared scratch attachment they copied
from (one source-resolution color texture that is no longer allocated in the default
path).

How the three `Framebuffer` hazards above were handled:

- `SetAttachment()` / the `Create*Attachment()` helpers now use `insert_or_assign`, so
  the tracked attachment map can no longer disagree with GL state after a re-attach.
  The fix is in `Framebuffer.cpp` for every caller, not just blur.
- The blur pass target is bound with raw `glFramebufferTexture2D`, sidestepping the
  `m_width`/`m_height` early-out entirely — each pass sizes its own viewport from the
  destination texture.
- The `m_blurFramebuffer.SetSize()` call moved out of `AllocateTextures()`. It now runs
  only when the copy fallback is actually in use, so `SetSize()` can never reallocate
  blur textures out from under `AllocateTextures()`.

Two behavioural details worth knowing:

- **Blur textures are now sized formats** (`GL_RGB8`, or `GL_RGBA16F` under
  `ENABLE_HDR_RENDERING`) instead of unsized `GL_RGB`, because unsized internal formats
  are not guaranteed to be color-renderable. Channel count and precision are unchanged.
- **A one-time completeness probe picks the path.** If a driver reports the blur texture
  as an incomplete color attachment, `BlurTexture` falls back to the old
  render-to-scratch + copy behaviour rather than losing the blur. The fallback also
  restores the scratch attachment allocation, so its cost profile is the pre-change one.
- **On `ENABLE_SRGB_FRAMEBUFFER` builds this is a small visual change.** The scratch
  attachment was `GL_SRGB8_ALPHA8` while the blur textures were linear, so blur results
  used to be sRGB-encoded and then byte-copied into a linear texture. Rendering directly
  into the linear blur textures drops that accidental encode, putting blur values in the
  same domain as the source. The option defaults to `OFF`, so default builds are
  unaffected.

**Ablation switch:** `?blurPath=copy` (WASM) or `PROJECTM_BLUR_COPY_PATH=1` (native)
forces the legacy copy path, so before/after can be benchmarked **on a single build**.
This is the recommended way to produce #177's before/after `?benchmark=1` JSON —
and note the `blurMs` caveat above: that bucket will fall further than frame time does.

**Item 3 (optional, "coordinate with #178") — landed.** Governor v2's tiers now include
`blurResolutionScale` (1.0 → 0.6 → 0.4, more aggressive than the general internal render
scale) alongside the mesh/blur-level-cap tiers, flowing through
`ProjectM::SetBlurResolutionScale()` → `BlurTexture::SetResolutionScale()`, applied in
`AllocateTextures()` before the existing per-level progressive halving. See
`docs/PERFORMANCE.md`'s governor v2 tier table for the full breakdown. Purely internal to
the WASM module — no host wiring needed, unlike the render-scale tier.

### 5. Canvas MSAA — narrower than it looks (#178)

`attrs.antialias = EM_TRUE` is set unconditionally (`WasmWebGLContext.cpp:95`).

What actually gets drawn into the canvas (FBO 0) is small: `ProjectM::RenderFrame()`
binds the target FBO (`ProjectM.cpp:220`) and then draws either the transition's
fullscreen quad (`ProjectM.cpp:238`) or a single fullscreen `CopyTexture` quad
(`ProjectM.cpp:242`), followed by user sprites (`ProjectM.cpp:251`). Everything else —
warp mesh, waveforms, shapes, borders, the composite grid — renders into the preset's
own FBOs, where MSAA does not apply.

A fullscreen quad has no interior edges, so **multisampling it produces no visible
difference**. The only real consumer is user sprites, which do draw geometry to the
canvas (`SpriteManager::Draw` → `MilkdropSprite::Draw`).

That reframes item 13: on a build with no sprites in use, `antialias: false` is close to
a free win (drops a multisampled color buffer and its per-frame resolve), not a
quality/perf tradeoff. It should be verified with sprites active before being made the
default, but it is a much stronger candidate than "mobile-only mitigation".

### 6. Mesh size

`MESH_SIZES` in `html/projectm-mesh-quality.js:19-22` is `low: [64, 48]`,
`high: [80, 60]`, resolved from `?meshQuality=`, localStorage, or
`navigator.hardwareConcurrency < 8`. `?meshQuality=low` only ever compares against the
`high` default, a 1.56× vertex-count ratio, not the 80×60 vs 32×24 (6.25×) implied by
the "raised from 48×36 / 32×24" framing in the context section — calibrate expectations
for that specific A/B accordingly. The **governor** (as of #178, see below) now steps
through a third, lower tier (48×36) that `projectm-mesh-quality.js` itself doesn't
expose as a `?meshQuality=` option.

---

## #178 implementation notes (governor v2)

Landed: three tiers (mesh × blur cap × internal render scale) stepped together instead
of mesh alone, plus a default-off canvas MSAA policy. Full description in
`docs/PERFORMANCE.md` ("Adaptive quality governor (WASM, v2)"); summary here for the
epic-level record:

- **Mesh** and **blur cap** are applied entirely inside the WASM module
  (`WasmPerfGovernor.cpp`'s `ApplyQualityTier()` calls `projectm_set_mesh_size()` and
  the new `projectm_set_max_blur_level()`). Blur capping flows through a new
  `Renderer::RenderContext::maxBlurLevel` field (same per-frame-context mechanism mesh
  size already used) into `BlurTexture::SetLevelCap()`/`EffectiveLevel()`, which clamp
  pass count and the descriptor/bind lists consumers see — a preset that requested more
  blur than the cap allows just doesn't get those higher levels updated or sampled that
  frame, no stale-texture risk. A third, independent axis — **blur-texture resolution
  scale** (1.0 → 0.6 → 0.4, more aggressive than the general render scale) — closes out
  #177 item 3 ("optionally downscale early blur levels more aggressively"); see
  [#177 implementation notes](#177-implementation-notes-blur-render-to-texture) above.
- **Internal render scale** reuses the fact that every WASM FBO already derives its size
  from the canvas backing-store resolution (`set_window_size()` → `ProjectM::m_windowWidth/Height`).
  Shrinking the backing store (`canvas.width`/`height`) while leaving the CSS box
  (`canvas.style.width`/`height`) fixed scales every FBO in the pipeline for free,
  including dual-FBO transition bandwidth, and the browser's native canvas-to-CSS-box
  scaling does the "present upscale" — no new offscreen FBO or blit shader was needed.
  This makes render-scale a **host-side** responsibility, unlike mesh/blur: two new
  push callbacks (`window.pmOnGovernorRenderScaleChange`/`...BlurCapChange`) plus pull
  getters (`get_governor_render_scale`/`get_governor_blur_cap`) are documented in
  `docs/WASM_JS_API.md`. `html/projectm-context.js` and `html/projectm-core.html` apply
  it; `?renderWorker=1` (OffscreenCanvas) does not yet.
- **Canvas MSAA** default flipped to `false` (`WasmWebGLContext.cpp`), opt-in via
  `?aa=1`/`localStorage.canvasAA`, per this document's own §5 finding that a fullscreen
  quad has no interior edges for MSAA to smooth — only sprite geometry benefits.
- New public C API: `projectm_set_max_blur_level()`/`projectm_get_max_blur_level()` and
  `projectm_set_blur_resolution_scale()`/`projectm_get_blur_resolution_scale()` (both
  mirror `projectm_set_mesh_size()`).

**Not measured in this environment** (no browser/GPU, consistent with every other entry
in this document): whether render-scale stepping recovers FPS faster than mesh-only on
a fill-bound preset (the epic's own acceptance criterion for #178), whether the blur cap
produces a visible "frozen" higher blur level on `sampler_blur3`-heavy presets, and
whether `antialias:false` is visually acceptable with sprites active. All three need
`?benchmark=1`/`?perfhud=1` verification on real hardware before #178 can be considered
fully done per its acceptance criteria — code landing is necessary but not sufficient.

---

## #179 implementation notes (WebGL2 advances) and WebGPU spike report

This section is the decision record the epic asked for. Everything below was reached by
reading and writing the tree; **no measurement was possible in the authoring environment**
(no browser, no GPU, no Emscripten toolchain — same caveat as #175–#178), so each item
records either what landed or what must be measured before it can land.

### A. WebGL2 items

| # | Item | Outcome |
|---|------|---------|
| A1 | `glBlitFramebuffer` for resolves | ✅ **Landed** — see below |
| A2 | Attach textures directly / MRT | ✅ **Already done**, no further cheap win — see below |
| A3 | `WEBGL_get_program_binary` cache | ❌ **No-go**, not a deferral — see below |
| A4 | Default `?renderWorker=1` | ⏸ **Deferred**, needs in-browser verification — see below |
| A5 | `FULL_ES3=0`, Closure | ⏸ **Deferred**, needs in-browser verification — see below |
| A6 | JSPI / ASYNCIFY isolation | ➡ Owned by [#173](https://github.com/ford442/Project-M/issues/173), not touched here |

#### A1 — `glBlitFramebuffer` resolves (landed)

Before this issue, the only hardware blit in the tree was the final preset→target copy added
by #176 (`ProjectM.cpp:247`, fed by `MilkdropPreset::BindOutputForRead()`). Every other copy
still went through `Renderer::CopyTexture`, i.e. a fullscreen textured quad. After #176 folded
the default-warp flip into the warp shader, the surviving quads in the Milkdrop frame are:

| Site | When it runs |
|------|--------------|
| `MilkdropPreset.cpp:124` — pre-warp flip of the previous frame | Only when the preset has a **custom warp shader** |
| `MilkdropPreset.cpp:181` — flip before `FinalComposite` | Every frame |
| `MilkdropPreset.cpp:193` — third flip for old-school effects | Only when the preset has **no composite shader** |

All three are plain (optionally Y-flipped) resolves between same-size color attachments, which
is exactly what `glBlitFramebuffer` does in hardware — including the flip, which the blit
expresses by inverting the destination rectangle. `CopyTexture::TryBlit()` now takes that path:
it attaches the source texture to a lazily created read FBO, blits into the instance's own
framebuffer with `GL_NEAREST` (matching the existing `m_sampler`), and detaches again so the
source is not kept alive across frames.

It deliberately falls back to the quad whenever the blit would **not** be equivalent:

- blending is enabled (`glBlitFramebuffer` ignores blend state and the fragment shader);
- the viewport does not cover the destination (the quad is viewport-clipped, the blit is not);
- the read framebuffer is incomplete for the source texture (not every format a preset texture
  can carry is color-renderable, and only color-renderable formats can be blitted from);
- the caller wants near-black transparency keying, which is real fragment work — the
  `SetTransparencyMode()` overload that draws into the *currently bound* framebuffer is
  untouched;
- the caller passes an explicit `targetTexture`, because that path swaps the attachment's
  `shared_ptr` without re-issuing `glFramebufferTexture2D` and so is not a straightforward
  render-to-target (pre-existing behaviour; not changed here).

**Ablation switch:** `?copyPath=shader` (WASM) or `PROJECTM_COPY_SHADER_PATH=1` (native)
restores the all-quad behaviour on the same build, mirroring `?blurPath=copy` from #177.

**Not measured.** The A/B that sizes this must use an old-school preset with a **custom warp
shader and no composite shader** — that is the only preset shape that pays all three quads.
A default-warp preset with a composite shader pays one, and will show close to nothing.

#### A2 — Direct texture attachment / MRT (already done)

The motion-vector UV map is already a second color attachment on the current framebuffer for
the warp draw (`MilkdropPreset.cpp:139` `SetAttachment(..., 1, m_motionVectorUVMap)`, removed
again right after), so the MRT opportunity named in the issue is spent. The blur chain stopped
round-tripping through a scratch attachment in #177. What remains is the feedback ping-pong
itself, which is required by Milkdrop semantics, not a copy that can be attached away. **No
further cheap win here** — the remaining copies were A1's, and they are now blits.

#### A3 — `WEBGL_get_program_binary` (no-go, close it)

This is not a deferral: **no shipping browser exposes program binaries to WebGL2.** The
extension exists as an ANGLE/native-GLES facility, not as a WebGL extension a page can request,
and Emscripten has no binding for it. The item as written in `PERFORMANCE.md` cannot be
implemented at any cost, and the line should be read as closed rather than pending.

What actually covers the warm-preset-switch case:

1. The browser's own internal program cache (Chrome/ANGLE persist compiled programs across
   loads keyed on source; nothing to do from our side).
2. The GLSL transpile cache we already ship — `Renderer::ShaderTranspileCache` plus the
   IndexedDB hooks installed in `projectM_emscripten.cpp` — which skips the HLSL parse and
   `M4::GLSLGenerator` run on repeat visits. That is the expensive half on preset switch;
   `glCompileShader`/`glLinkProgram` after it are the browser's to cache.

If warm preset switches are still slow after that, the next lever is reducing the *number* of
distinct programs (shader dedup across presets), not binary caching.

#### A4 — Default the OffscreenCanvas render worker (deferred)

`?renderWorker=1` is implemented and opt-in (`html/projectm-render-worker-host.js`,
`html/projectm-render-worker.js`; rationale and manual test matrix in `PERFORMANCE.md`
"OffscreenCanvas render worker"). Flipping the default is a *product* change with real
fallout — input/resize/preset control all move to `postMessage`, and every host embedding
`projectm-element.js` inherits it — so it must not be defaulted on unverified code.

**Blocked on:** running that document's existing five-step manual matrix (desktop Chrome,
Firefox, an OffscreenCanvas-less browser, the default path bit-for-bit, and audio latency),
plus `?benchmark=1` frame-p95 with and without the worker on one machine. Until someone has
a browser in front of them, the honest state is opt-in. Cross-reference: issue
[#81](https://github.com/ford442/Project-M/issues/81).

#### A5 — `FULL_ES3=0` and Closure (deferred)

`cmake/EmscriptenWasmFlags.cmake` still sets `FULL_ES3=1` alongside
`MIN_WEBGL_VERSION=2`/`MAX_WEBGL_VERSION=2`. `PERFORMANCE.md`'s deferred-flags table already
measured the build side: `FULL_ES3=0` links cleanly and saves ~10 KB of JS (-4.4%), with
`GL_MAX_TEMP_BUFFER_SIZE` / `GL_POOL_TEMP_BUFFERS=0` to be re-evaluated together with it.

The reason it has not landed is unchanged and is *not* laziness about size: nothing has
rendered a frame with it. The risk is a GL call that silently depends on ES3-emulation-on-top-
of-WebGL2 rather than failing to link. A1 makes this slightly more pressing, not less —
`glBlitFramebuffer` with an inverted destination rectangle is precisely the kind of call where
an emulation layer and native WebGL2 could differ. **Verify A1 and `FULL_ES3=0` in the same
browser session**, in that order.

Closure is the same shape of bet (JS-side size, needs a smoke test with the full host stack
including the worker path) and should ride along with the same verification session.

### B. WebGPU spike — **DEFER** (not no-go, not now)

**Decision: defer.** WebGPU is a plausible eventual backend, but it is gated on a shader
problem this repo does not currently have any part of, and it would buy nothing that
#175–#179 have not already bought more cheaply. Revisit when the WebGL2 items above are
measured and exhausted, or when a WGSL-capable HLSL path becomes available for free.

#### B1 — Frame graph mapping (the easy half)

The Milkdrop frame maps onto WebGPU cleanly, and this is not where the difficulty is:

| Milkdrop stage | WebGPU shape |
|----------------|--------------|
| Feedback ping-pong (2 color targets, swapped) | Two textures, alternating render pass attachments — same as today |
| Motion-vector UV MRT | Second color attachment in one render pass |
| Warp mesh (80×60 grid, CPU-evaluated per-pixel code) | Vertex buffer written per frame; the per-pixel eval stays on the CPU |
| Blur chain (separable, downscaled tiers) | Render passes, or compute passes with workgroup-shared taps |
| Final composite / video echo | Render pass to the swapchain texture |
| Dual-preset blend (WASM compositor) | Render pass sampling two preset outputs |
| Y-flip resolves | `copyTextureToTexture` cannot flip; would fold into UVs, as #176 already did |

The one genuinely *new* capability is compute for the blur chain and possibly for per-pixel
mesh evaluation. That is the only outcome that would beat a fully-tuned WebGL2 path, and it
is also the largest piece of new work.

#### B2 — Blockers (the hard half)

1. **HLSL→WGSL does not exist in this tree, and cannot be added cheaply.** Preset warp and
   composite shaders are authored in Milkdrop's HLSL dialect and transpiled **at preset load,
   at runtime, in the WASM module** by the vendored `hlslparser`
   (`src/libprojectM/MilkdropPreset/ShaderTranspiler.cpp` → `M4::GLSLGenerator`). That
   generator emits GLSL only: its `Version` enum (`vendor/hlslparser/src/GLSLGenerator.h:29`)
   is `110/120/140/150/330/100_ES/300_ES` — there is no WGSL target and no SPIR-V target.
   A WebGPU backend therefore needs one of:
   - a new `WGSLGenerator` backend in the vendored `hlslparser` (largest correctness risk:
     every preset in the wild is a test case, and the parser is already the source of
     long-tail preset bugs), or
   - a runtime GLSL→SPIR-V→WGSL chain (glslang + tint/naga) shipped **inside the WASM
     bundle**, because translation happens per preset load, not at build time. That is
     megabytes of added payload on a bundle whose deferred-flag work is currently fighting
     over 10 KB, and it puts a second compiler on the preset-switch hot path that A3 above
     is trying to keep short.
2. **Every built-in shader is GLSL source.** 38 `*Glsl330.frag/.vert/.inc` files across
   `MilkdropPreset/Shaders/` and `Renderer/TransitionShaders/`, plus inline `#version 300 es`
   / `#version 330` strings in `CopyTexture.cpp`, `TransitionShaderManager.cpp`,
   `MilkdropSprite.cpp` and others. All would need WGSL twins, and the transition shaders are
   an actively growing set (see `docs/transition_shaders.md`) — a second backend means every
   new transition is written twice or the backends diverge.
3. **The renderer is GL-shaped end to end, not abstracted.** `Renderer::Framebuffer`,
   `Texture`, `Shader`, `Sampler`, `Mesh` are thin wrappers over GL objects and are used
   directly by preset code (`glBlitFramebuffer`, `glFramebufferTexture2D` and raw enums appear
   in preset-level files, including in A1 above). There is no device abstraction to implement
   a second backend behind; introducing one is the actual XL, independent of WGSL.
4. **Emscripten integration is a separate world.** The build is `USE_WEBGL2=1` +
   `MIN/MAX_WEBGL_VERSION=2` with glad-style GL entry points. WebGPU means emdawnwebgpu /
   `navigator.gpu` and a different (asynchronous) device/adapter acquisition path — which
   collides with the ASYNCIFY/JSPI work in [#173](https://github.com/ford442/Project-M/issues/173)
   and with the OffscreenCanvas worker path in A4, since a `GPUCanvasContext` has its own
   transfer rules. There is currently **no WebGPU reference anywhere in the source tree**.
5. **Float feedback formats.** The Dual-FBO chain probes RGBA16F→RGBA32F→RGBA8 at runtime
   (#175). WebGPU's `rgba32float` is not blendable and `rgba16float` filtering/blending
   depends on features being requested at device creation — so the format-probing logic is
   not a port, it is a rewrite with different fallbacks.

#### B3 — Why not prototype one pass now

The issue offers "prototype one pass **or** conclude no-go with rationale". A single-pass
prototype (say, the final composite) would need its own `GPUDevice`, swapchain and canvas
context alongside the live WebGL2 context. **A canvas can hold only one context type**, so
the prototype cannot composite the existing WebGL2 output — it would have to render to an
offscreen canvas and prove nothing about interop, or the whole chain moves at once. A prototype
that shares no state with the real renderer measures WebGPU's triangle throughput, not this
application's, so it would not inform the go/no-go it is meant to inform. The blockers in B2
are structural and already answer the question.

#### B4 — Conditions to revisit

Revisit WebGPU when **any two** of these hold:

- WebGL2 is measured and exhausted: A1/A4/A5 landed and benchmarked, and `gpuMs` is still the
  budget after governor v2 has stepped down.
- A maintained HLSL→WGSL (or GLSL→WGSL) path exists that we can adopt rather than write,
  small enough to ship in the bundle or usable ahead of time.
- The renderer gains a device abstraction for another reason (e.g. a native Vulkan/Metal
  backend upstream), making the second backend incremental instead of foundational.
- A concrete workload appears that compute wins decisively and WebGL2 cannot express — the
  realistic candidate is per-pixel mesh evaluation moving to the GPU, which today is CPU
  + OpenMP and is the largest `perPixelEvalMs` bucket.

**Estimated invasiveness if pursued anyway:** XL. Device abstraction (L) + WGSL shader corpus
(L) + HLSL→WGSL runtime path (XL, highest risk) + Emscripten/canvas/worker integration (M),
with a long tail of per-preset visual regressions that only a large preset sweep would catch.

---

## Measurement: what the HUD can and cannot tell you

Worth settling before anyone ranks suspects, because the cheat sheet above over-promises.

**`gpuMs` is real.** `EXT_disjoint_timer_query_webgl2` is wired up
(`WasmPerfGovernor.cpp:21-67`): one `TIME_ELAPSED` query wraps each `render_frame()`,
results are polled non-blocking, and disjoint frames are discarded. It reports
**whole-frame** GPU time.

**The per-stage buckets are CPU time.** `PerfTimers.hpp` is a `steady_clock` scoped
timer (`Field::Blur`, `Field::Composite`, `Field::PerPixelEval`, …), so each bucket
measures how long it took to *submit* that stage's GL calls, not to execute them. GL is
asynchronous and there is no `glFinish`/`glFlush` in the frame path, so fill-rate costs
(MSAA resolve, RGBA32F bandwidth, extra fullscreen flips, blur fill) largely do not
appear in the stage that caused them.

Practical consequences:

- ✅ `totalMs` vs `gpuMs` reliably answers **CPU-bound or GPU-bound**.
- ✅ `perPixelEvalMs` and `audioMs` are trustworthy — genuinely CPU work.
- ❌ `compositeMs` will **not** rise when the Y-flip chain gets expensive; that cost
  lands in `gpuMs`, undifferentiated.
- ⚠️ `blurMs` is a **biased** estimator: it is visible only because
  `glCopyTexSubImage2D` can force ordering. It flags blur because blur is the stage
  that syncs, not because blur is necessarily the most expensive.

To actually rank #176 vs #177 vs #178 against each other, one of:

1. **Per-stage GPU queries** — nest `TIME_ELAPSED` queries per stage. Cleanest signal.
   Note that timer queries cannot be nested in a single query object, so this means one
   query per stage per frame and more polling bookkeeping; the existing
   `Module.__pmPerfGpu` ring is the place to extend.
2. **A/B ablation** — a runtime toggle per suspect (skip the third flip, force
   `BlurLevel::None`, `antialias:false`, force RGBA16F, `?meshQuality=low`), then diff
   `gpuMs` across otherwise identical `?benchmark=1` runs. Cruder, but needs no new
   timing infrastructure and directly answers "what would I gain by fixing this?".

Option 2 is the cheaper first move and is the recommended way to satisfy the epic's
"rank before coding" step.

---

## Tracked sub-issues

| Issue | Title | Priority | Focus |
|-------|-------|----------|-------|
| [#175](https://github.com/ford442/Project-M/issues/175) | Dual-FBO compositor lifecycle & float-format bandwidth | `P0` | Direct-to-canvas verify, RGBA16F default, lazy alloc, shrink 4→2 if safe |
| [#176](https://github.com/ford442/Project-M/issues/176) | Collapse MilkdropPreset Y-flip / `CopyTexture` passes | `P0` | UV/NDC flip, `glBlitFramebuffer` for non-flip copies |
| [#177](https://github.com/ford442/Project-M/issues/177) | Blur chain render-to-texture (kill `glCopyTexSubImage2D`) | `P1` | ✅ Code landed; benchmark JSON outstanding |
| [#178](https://github.com/ford442/Project-M/issues/178) | Governor v2 — FBO scale, blur tier, MSAA policy | `P1` | ✅ Code landed; benchmark JSON outstanding |
| [#179](https://github.com/ford442/Project-M/issues/179) | Advance WebGL2 + WebGPU feasibility spike | `P2` | ✅ Blit resolves landed + WebGPU deferred; A4/A5 need browser verify |

Suggested order: **#175 → #176 → #177 → #178**, with **#179** spiked in parallel once
baselines exist (do not block FPS recovery on WebGPU).

---

## Ways to regain framerate (summary)

### Already in tree / verify first

1. **Direct-to-canvas when not transitioning** — `ShouldUseDualFboCompositor()` in
   `projectM_emscripten.cpp:475`. ✅ Confirmed present in source; **confirm deploy**.
2. **Mesh quality A/B** — `?meshQuality=low` (64×48) vs high (80×60); a 1.56× vertex
   ratio, not the 6.25× the context section's "from 32×24" framing suggests.
3. **Perf HUD ranking** — ⚠️ only valid for `perPixelEvalMs`/`audioMs` and the
   `totalMs`-vs-`gpuMs` CPU/GPU split; use ablation to rank GPU stages. See
   [Measurement](#measurement-what-the-hud-can-and-cannot-tell-you).

### Dual-FBO / WASM compositor (#175)

4. Prefer **RGBA16F** over RGBA32F for Dual FBOs (half bandwidth; keep RGBA32F opt-in). ✅ Landed in-tree.
5. **Lazy-allocate** Preset A/B pairs; free when idle if needed. ✅ Preset A/B now allocated on first transition request.
6. Consider **2 textures instead of 4** if ping-pong within a preset is unnecessary for the compositor.
7. Stop double-calling the same `pm` into A and B during transitions unless two true preset instances exist (or accept cost only for the blend window).
8. Fix helpers that still render to FBO 0 instead of `_fbo`.

### Core Milkdrop copies (#176, #177)

9. **Collapse Y-flips** into consumer shaders (warp/composite UV) instead of 2–3 fullscreen `CopyTexture` draws.
10. Use **`glBlitFramebuffer`** for format-matched resolves (WebGL2) — including flips, via an inverted destination rectangle. ✅ Landed in-tree (#179); `?copyPath=shader` restores the quad path for A/B.
11. Blur: **render into the destination texture attachment**; remove per-pass `glCopyTexSubImage2D`. ✅ Landed in-tree; `?blurPath=copy` restores the old path for A/B.

### Adaptive quality / present (#178)

12. Governor **v2**: step **internal FBO scale** (1.0 / 0.75 / 0.5) and **blur tier**, not only mesh. ✅ Landed in-tree (#178); benchmark JSON outstanding.
13. Canvas **`antialias: false`** by default; opt-in via `?aa=1`. ✅ Landed in-tree (#178) — default for all devices, not mobile-only, per this doc's own §5 finding that MSAA on a fullscreen-quad canvas target is largely invisible regardless of device class.
14. Keep post-load grace so ASYNCIFY compile spikes do not permanently downgrade quality. ✅ Unchanged from v1, still honored by v2's tier stepping.

### WebGL2 advances & WebGPU (#179)

15. Land deferred link flags after browser verify (`FULL_ES3=0`, Closure) — size/startup; coordinate with #173 for ASYNCIFY→JSPI. ⏸ Still deferred (#179 A5) — verify in the same browser session as item 10.
16. **`WEBGL_get_program_binary`** warm cache — ❌ no-go (#179 A3): no shipping browser exposes program binaries to WebGL2. The GLSL IDB transpile cache plus the browser's own program cache is the whole story.
17. Verify and consider defaulting **OffscreenCanvas render worker** (`?renderWorker=1`). ⏸ Still opt-in (#179 A4) — blocked on `PERFORMANCE.md`'s manual browser matrix.
18. **WebGPU spike** — ⏸ **defer** (#179 B): frame graph maps cleanly, but there is no WGSL target in the vendored `hlslparser` and preset shaders are transpiled at runtime, so a backend is XL with no win WebGL2 cannot deliver first. Revisit conditions in §179 B4.

There was **no existing WebGPU roadmap** in this repo; [§179](#179-implementation-notes-webgl2-advances-and-webgpu-spike-report) is now the decision record.

---

## Milestone sketch

### M1 — Stop the bleeding (`P0`)

- #175 Dual-FBO lifecycle/format  
- #176 Y-flip / copy collapse  

**Exit:** Steady-state median ≥60 FPS on desktop reference presets @ 1280×720, or documented GPU-bound remainder with HUD proof.

### M2 — Fill-rate & blur (`P1`)

- #177 Blur render-to-texture  
- #178 Governor v2 + MSAA policy  

**Exit:** Mid-tier device holds ≥45 FPS without stuck tier-0 mesh; transitions still soft-cut.

### M3 — Platform next (`P2`)

- #179 WebGL2 leftovers + WebGPU go/no-go — ✅ decision recorded; blit resolves merged, A4/A5 deferred with a named verification step

**Exit:** Plan section filled with decision; any cheap WebGL2 items merged or explicitly deferred.

---

## Measurement protocol (required per issue)

0. **Before anything else:** confirm the deployed bundle already contains
   `ShouldUseDualFboCompositor()`. If it does not, deploy a current build and
   re-baseline — that alone may close the steady-state gap (see
   [Verified against the tree](#verified-against-the-tree-2026-07-31) §1).
1. Build/deploy WASM with known `PROJECTM_WASM_BUNDLE`.  
2. Cold load → `?benchmark=1&frames=500&preset=<path>` at fixed canvas size.  
3. Capture JSON (`totalMs`, `breakdownMs`, `gpuMs`).  
4. Repeat after change; paste both into the issue and a short table in
   [`PERFORMANCE.md`](PERFORMANCE.md).  
5. For transitions: also sample during an active soft-cut (Dual path on).  
6. Sample **both** a composite-shader preset and an old-school one without a composite
   shader — the latter pays a third fullscreen Y-flip (§3), so mixing them hides the
   effect of #176.  
7. Read `breakdownMs` with the caveats in
   [Measurement](#measurement-what-the-hud-can-and-cannot-tell-you); rank GPU stages by
   ablation, not by bucket size.

Native SDL comparison table in PERFORMANCE.md remains optional but useful for parity claims.

---

## Out of scope

- Preset content modernization (see [`PRESET_ROADMAP.md`](PRESET_ROADMAP.md) / epic #110).  
- Platform Product M5 host/TS/npm work (epic #163) except where Dual-FBO docs touch the host.  
- Enabling `ENABLE_HDR_RENDERING` by default (separate fidelity track; Dual FBO float is not libprojectM HDR).

---

## Definition of Done (per sub-issue)

- [ ] Code change merged with before/after benchmark JSON  
- [ ] No banding/regression on float-capable GPUs for feedback presets (or documented RGBA8 fallback banner)  
- [ ] Docs updated (`PERFORMANCE.md` and this file’s status line)  
- [ ] Epic #174 checklist item marked when all five close  

Update this file whenever a sub-issue changes state or the WebGPU decision lands.
