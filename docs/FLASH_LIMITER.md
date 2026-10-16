# The present pass: flash limiter, frame capture, manual present

What happens to a frame between the Milkdrop composite and the canvas (#286). There are three
pieces, and all are opt-in:

- **Temporal flash limiter.** A photosensitivity safety pass in libprojectM, the same on native and
  WASM. It is off by default, and off it changes nothing.
- **Frame capture.** The WASM host reads back the frame it just presented, per engine, without
  `preserveDrawingBuffer`. This is the seam offline video export (#256 / #262) builds on.
- **Manual present.** With `explicitSwapControl` (`presentMode: 'manual'`), the canvas changes once
  per rendered frame and only then. See [EMSCRIPTEN.md](EMSCRIPTEN.md#manual-present-explicitswapcontrol).

There is no encoder, muxer or new library here, and no second GL context.

## Flash limiter

### What it does

The limiter is `Renderer::FlashLimiter` (`src/libprojectM/Renderer/FlashLimiter.{hpp,cpp}`), called
from `ProjectM::RenderFrame()`. When it is on, the frame's output (blit, transparency copy or
transition blend) goes into the limiter's RGBA8 frame texture instead of the target framebuffer.
Three small passes then run on the GPU:

1. **Measure.** A 32×32 grid of cells, each averaging the WCAG relative luminance of 4×4 pixels
   inside it. It uses `texelFetch`, because luminance is linear in light and sRGB values are not.
2. **Decide.** A 3×1 state texture holds the luminance of the frame presented last, an upper and a
   lower envelope, the clamp count and this frame's blend factor. The envelopes hold the highest and
   lowest luminance presented recently, and relax toward the latest one by `threshold` per
   `WindowSeconds` (⅓ s). The new frame's luminance must stay within `threshold` of both. If it would
   not, the blend factor is the fraction of the way from the previous frame to the new one that does.
3. **Present.** Draw `mix(previous, new, blend)` in linear light into the next "held" texture, then
   blit it to the target. A frame that is not limited (blend = 1) is copied texel for texel.

Nothing is read back per frame, so the limiter adds no CPU/GPU synchronization to a live frame. Only
the clamp count is read back (one texel), and only when someone asks for it.

What this guarantees for the presented mean luminance:

- **No frame-to-frame step larger than `threshold`.**
- **Any oscillation above 3 Hz spans at most 1.5 × `threshold`.** The envelopes move by half a
  threshold in the half period of a 3 Hz oscillation. With the default, that is 9%, under the 10%
  change WCAG 2.3.1 counts as half a flash.
- **A lasting change still comes through,** at `threshold / WindowSeconds` per second. With the
  default that is 18% of full scale per second, so a hard cut from black to white fades in over about
  5.5 s.

### Defaults, and how they were checked

| Parameter | Value | Where |
|-----------|-------|-------|
| `threshold` | `0.06` (settable, 0.005..1) | `FlashLimiter::DefaultThreshold`, `projectm_set_flash_limit_threshold()` |
| Envelope relax time | ⅓ s per threshold | `FlashLimiter::WindowSeconds` (the period of WCAG's "three flashes in one second") |

The default was measured against two fixtures:

- `presets/tests/290-compshader-strobe.milk`: a full-frame black/white strobe at 15 Hz, two frames
  each at 60 fps.
- `presets/tests/280-compshader-blur3.milk`: a calm composite-shader preset.

| Run (`tests/wasm-smoke/present_pass.mjs`, 40 frames at 60 fps) | Largest step | Span in 8 frames | Frames clamped |
|-------------------------------|--------------|------------------|----------------|
| strobe, limiter off | 1.0 | 1.0 | 0 |
| strobe, limiter on | 0.060 | 0.063 | 30 of 40 |
| calm, limiter off | 0.0002 | 0.0012 | 0 |
| calm, limiter on | 0.0002 | 0.0012 | 0 (frames identical to "off") |

### What it does not cover

Treat the limiter as a measurement target, not a WCAG conformance claim:

- **The limit is on the mean luminance of the whole frame.** A small bright strobe on a dark
  background moves the mean very little and passes. A spatial measure (a tile histogram over the
  same 32×32 grid) is the follow-up if the mean proves too coarse.
- **Red flashes get no special treatment.** WCAG's red-flash rule needs a saturated-red area
  measure, which the first pass does not compute.
- **User sprites are drawn after the limiter** and are not limited.
- **The WASM dual-FBO crossfade** composites two renders of the engine, and each one is already
  limited. A crossfade mixes them slowly, so its output steps little, but the compositor output is
  not measured again. During a crossfade the engine renders twice per frame, so the limiter advances
  twice and its count can grow by two.
- **It reacts to presets that strobe, not to the music.** A preset that pulses on every beat at
  20–30% brightness comes out noticeably calmer. That is the point of the limiter, which is also why
  it is opt-in.

### API

| Layer | Switch | Threshold | Clamped frames |
|-------|--------|-----------|----------------|
| C (`projectM-4/parameters.h`) | `projectm_set_flash_limit_enabled()` | `projectm_set_flash_limit_threshold()` | `projectm_get_flash_limit_clamped_frames()` |
| WASM export | `set_flash_limit_enabled` | `set_flash_limit_threshold` | `get_flash_limit_clamped_frames` |
| `ProjectMContext` | `flashLimit: true \| { threshold }` option, `setFlashLimit(enabled, threshold?)` | (same) | `getFlashLimitStats()` |
| Render worker | `init.flashLimit`, `set-flash-limit` message | (same) | ccall |
| Perf HUD | — | — | `flashClampedFrames` on `pmOnPerfFrame` ("flash-limited N"; -1 while off) |

- **Before the first frame.** The `flashLimit` option is applied before the engine renders anything:
  before `start_render()` on the main thread, and from the init message in the worker. A viewer who
  needs the limiter is never shown an unlimited frame.
- **Persistence.** The WASM host keeps the setting in its per-host `EngineSettings`, so it survives
  context loss and `rebind_canvases()`.
- **Count resets.** Enabling restarts the history and the count. A resize restarts the history only.
- **Reading the count.** Reading it waits for the frames rendered since the last read, so poll it a
  few times a second at most. The perf HUD reads it every 0.5 s.

## Frame capture

```js
const frame = await context.captureFrame();          // the next frame the render loop presents
// frame: { width, height, data: Uint8ClampedArray (RGBA8, top row first), frameIndex }
const image = new ImageData(frame.data, frame.width, frame.height);
```

How a capture works:

- **Request.** `capture_frame_request()` asks for the next frame.
- **Read.** `render_frame()` takes the frame after the compositor drew the canvas and before a
  manual-present commit (`TakeRequestedFrameCapture()` in `src/wasm/WasmPresent.cpp`). That is the
  one point where the drawing buffer is known to hold the image without `preserveDrawingBuffer`.
- **Per engine.** Each engine (`WasmHost`) has its own buffer, so two canvases on one Module capture
  independently. `ProjectMContext` binds every call to its own host.
- **Browser present (the live player).** One synchronous `glReadPixels` into the host's buffer. It
  stalls that one frame, only when asked, and nothing is allocated until the first capture.
- **Manual present.** The read goes into a pixel-pack buffer behind a fence, so the frame that issued
  it does not wait. `capture_frame_status()` collects it once the fence has signalled.
  `capture_frame_resolve(1)` takes it at once, which is meant for export ticks. The live player
  never allocates the pack buffer.
- **Render worker.** The worker reads the frame in its own scope (the drawing buffer is the
  worker's) and posts the pixels back as a transferred `ArrayBuffer`: `capture-frame` /
  `frame-captured`.

For offline export, pause the render loop (`set_render_loop_paused(1)`), turn on the deterministic
clock (`set_deterministic_clock(1, fps)`) and call `captureFrame({ renderFrame: true })` once per
tick. Each call renders, commits (on manual present) and captures exactly one frame.
`get_committed_frame_count()` counts the commits next to `get_rendered_frame_count()`, so a run of
N ticks can be checked for N commits.

WASM exports: `capture_frame_request`, `capture_frame_status` (0 idle, 1 requested, 2 pending,
3 ready, 4 failed), `capture_frame_resolve(wait)`, `capture_frame_data_ptr`, `capture_frame_width`,
`capture_frame_height`, `capture_frame_index`, `capture_frame_release`, `get_committed_frame_count`.
`HEAPU8` is exported for the copy.

## Tests

| What | Where |
|------|-------|
| Black→white step clamped to the threshold and counted, unchanged frame copied byte for byte, count across disable/re-enable and resize, strobe preset untouched while off and bounded while on, calm preset byte-identical either way | `tests/libprojectM/FlashLimiterTest.cpp` (GPU; SDL2 + a display or `xvfb-run`) |
| Strobe vs calm in a browser, per-engine readback, manual present (N ticks = N commits, asynchronous capture) | `tests/wasm-smoke/present_pass.mjs` (`--explicit-swap` for the manual-present half), both in `build_emscripten.yml` |
| `captureFrame()` polling / timeout / errors, two contexts on one Module capturing at once | `tests/web/projectm-frame-capture.test.mjs` |
| `flashLimit` applied before `start_render()`, and through the worker init message | `tests/web/context-lifecycle.test.mjs` |
| `set-flash-limit` / `capture-frame` / `frame-captured` on both sides of the worker protocol | `tests/web/projectm-render-worker.test.mjs`, `tests/web/projectm-render-worker-host.test.mjs` |
