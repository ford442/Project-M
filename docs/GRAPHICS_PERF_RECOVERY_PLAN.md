# Graphics FPS Recovery Plan (Ping-Pong FBO → 60 FPS)

Living tracker for recovering steady-state framerate after dual ping-pong / Dual-FBO
work slowed WASM playback below 60 FPS, and for advancing WebGL2 (and evaluating
WebGPU) without regressing Milkdrop feedback quality.

Canonical discussion: GitHub epic
[#174 — Graphics FPS Recovery](https://github.com/ford442/Project-M/issues/174).
This file is the in-repo companion so the plan travels with the code.

**Status (2026-07-21):** Plan + five sub-issues filed. Implementation not started.

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
with float preference **RGBA32F → RGBA16F → RGBA8**, then a fullscreen
`CompositingBlendShader` blit to the canvas.

| Phase | Behavior | FPS impact |
|-------|----------|------------|
| Early Dual-FBO | Compositor ran **every frame** | Steady-state regression (main 60→N drop) |
| Current (`ShouldUseDualFboCompositor`) | Compositor only while `g_transitionActive` | Steady-state should recover if this build is deployed |
| Remaining cost | Eager A-pair alloc, RGBA32F bandwidth, 2× render during crossfade | Transition / VRAM / mobile |

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
| High `blurMs` | Blur passes + `glCopyTexSubImage2D` | #177 |
| High `perPixelEvalMs` | 80×60 mesh / OpenMP pool | #178 (+ existing mesh/OpenMP work) |
| Spike only during soft-cut | Dual FBO float bandwidth / double render | #175 |
| Mobile-only `gpuMs` | Canvas MSAA + fill rate | #178 |

---

## Tracked sub-issues

| Issue | Title | Priority | Focus |
|-------|-------|----------|-------|
| [#175](https://github.com/ford442/Project-M/issues/175) | Dual-FBO compositor lifecycle & float-format bandwidth | `P0` | Direct-to-canvas verify, RGBA16F default, lazy alloc, shrink 4→2 if safe |
| [#176](https://github.com/ford442/Project-M/issues/176) | Collapse MilkdropPreset Y-flip / `CopyTexture` passes | `P0` | UV/NDC flip, `glBlitFramebuffer` for non-flip copies |
| [#177](https://github.com/ford442/Project-M/issues/177) | Blur chain render-to-texture (kill `glCopyTexSubImage2D`) | `P1` | Attach blur targets directly; cut redundant copies |
| [#178](https://github.com/ford442/Project-M/issues/178) | Governor v2 — FBO scale, blur tier, MSAA policy | `P1` | Hold 60 FPS under fill load, not only mesh |
| [#179](https://github.com/ford442/Project-M/issues/179) | Advance WebGL2 + WebGPU feasibility spike | `P2` | Near-term WebGL2 wins; go/no-go for WebGPU |

Suggested order: **#175 → #176 → #177 → #178**, with **#179** spiked in parallel once
baselines exist (do not block FPS recovery on WebGPU).

---

## Ways to regain framerate (summary)

### Already in tree / verify first

1. **Direct-to-canvas when not transitioning** — `ShouldUseDualFboCompositor()` in
   `projectM_emscripten.cpp`. Confirm deploy.
2. **Mesh quality A/B** — `?meshQuality=low` (64×48) vs high (80×60).
3. **Perf HUD ranking** — fix the largest bucket first; avoid speculative refactors.

### Dual-FBO / WASM compositor (#175)

4. Prefer **RGBA16F** over RGBA32F for Dual FBOs (half bandwidth; keep RGBA32F opt-in).
5. **Lazy-allocate** Preset A/B pairs; free when idle if needed.
6. Consider **2 textures instead of 4** if ping-pong within a preset is unnecessary for the compositor.
7. Stop double-calling the same `pm` into A and B during transitions unless two true preset instances exist (or accept cost only for the blend window).
8. Fix helpers that still render to FBO 0 instead of `_fbo`.

### Core Milkdrop copies (#176, #177)

9. **Collapse Y-flips** into consumer shaders (warp/composite UV) instead of 2–3 fullscreen `CopyTexture` draws.
10. Use **`glBlitFramebuffer`** for format-matched, non-flip resolves (WebGL2).
11. Blur: **render into the destination texture attachment**; remove per-pass `glCopyTexSubImage2D`.

### Adaptive quality / present (#178)

12. Governor **v2**: step **internal FBO scale** (1.0 / 0.75 / 0.5) and **blur tier**, not only mesh.
13. Canvas **`antialias: false`** by default on mobile / when over budget; opt-in AA on desktop.
14. Keep post-load grace so ASYNCIFY compile spikes do not permanently downgrade quality.

### WebGL2 advances & WebGPU (#179)

15. Land deferred link flags after browser verify (`FULL_ES3=0`, Closure) — size/startup; coordinate with #173 for ASYNCIFY→JSPI.
16. **`WEBGL_get_program_binary`** warm cache (beyond GLSL IDB transpile cache).
17. Verify and consider defaulting **OffscreenCanvas render worker** (`?renderWorker=1`).
18. **WebGPU spike**: map frame graph → WGSL; identify HLSL→WGSL / Emscripten blockers; prototype one pass **or** write no-go. Full backend is XL and should not gate #175–#178.

There is **no existing WebGPU roadmap** in this repo; #179 creates the decision record.

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

- #179 WebGL2 leftovers + WebGPU go/no-go  

**Exit:** Plan section filled with decision; any cheap WebGL2 items merged or explicitly deferred.

---

## Measurement protocol (required per issue)

1. Build/deploy WASM with known `PROJECTM_WASM_BUNDLE`.  
2. Cold load → `?benchmark=1&frames=500&preset=<path>` at fixed canvas size.  
3. Capture JSON (`totalMs`, `breakdownMs`, `gpuMs`).  
4. Repeat after change; paste both into the issue and a short table in
   [`PERFORMANCE.md`](PERFORMANCE.md).  
5. For transitions: also sample during an active soft-cut (Dual path on).

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
