# Live input: textures a host feeds, variables a host sets

Phase 1 of the browser VJ runtime ([#250](https://github.com/ford442/Project-M/issues/250)):
the host can put camera or video frames into a texture that presets sample by name,
and set per-frame variables (`q1`..`q32`, `zoom`, `decay`, ...) from outside a preset.
Both are ordinary Milkdrop inputs. A preset that samples `sampler_webcam` or reads `q1`
needs no new syntax and no `// pm:experimental` header.

| Layer | Live textures | Host variables |
|-------|---------------|----------------|
| C API (`projectM-4/live_input.h`) | `projectm_texture_slot_register()` / `_update()` / `_unregister()` | `projectm_eval_set()` / `projectm_eval_clear()` |
| WASM exports (`src/wasm/WasmLiveInput.cpp`) | `texture_slot_register` / `_buffer` / `_commit` / `_unregister` | `eval_set` / `eval_clear` |
| `ProjectMContext` | `registerTexture()` / `updateTexture()` / `unregisterTexture()` | `setEvalVar()` / `clearEvalVar()` |
| Page | `projectm-core.html?liveTex=1` (`html/projectm-live-texture-source.js`) | (Phase 2: MIDI/OSC control bus) |

Demo preset: [`presets/experimental/live_texture_webcam.milk`](../presets/experimental/live_texture_webcam.milk)
(camera trails, `q1` = wet/dry).

## Live textures

A live texture is an RGBA8 texture that the host registers under a name. The host then
uploads frames into it as often as it has them. To a preset it is a user texture like one
loaded from a file:

```milk
warp_1=`sampler sampler_webcam;
warp_2=`shader_body
warp_3=`{
warp_4=`    ret = tex2D(sampler_webcam, uv).xyz;            // texsize_webcam: size and 1/size
warp_5=`}
```

Filter/wrap prefixes work as usual (`sampler_fc_webcam`, `sampler_pw_webcam`), and names
are case-insensitive. A live texture wins over a texture file or the texture load callback
with the same name. The engine never evicts it, and it survives
`projectm_set_texture_search_paths()`.

**The texture stays the same object.** Each upload rewrites it in place
(`IRenderDevice::WriteTexture`, `glTexSubImage2D`, with no reallocation). A resize
re-specifies the storage of the same texture name. Every preset already sampling the
texture therefore shows the new frame, or the new size, from the next frame on, without
being reloaded. That is the difference from the experimental depth map, which writes a
PNG into the VFS and calls `projectm_reload_texture()`: that path is fine once a second,
but too slow for a camera.

**Register before the preset loads.** A preset that asked for the name while no texture
of that name existed got the engine's black placeholder, and keeps it until it is loaded
again. Register early and size later: the `?liveTex=1` page registers a 1x1 placeholder
right after the engine starts. That happens before any preset loads, and the first camera
frame resizes the texture in place.

Names are 1-64 ASCII letters, digits or underscores. The engine refuses `main`,
`blur1`..`blur3` and `randNN...`, because the shader resolves those itself. It also refuses
its built-in textures (`noise_*`, `noisevol_*`, `idlem`, `idleheadphones`). A name whose
third character is `_` (`pm_cam`) reads as a filter/wrap prefix in a sampler name, so a
preset has to spell the prefix out: `sampler_fc_pm_cam`. Sizes are 1..8192 pixels a side.
`projectm_texture_slot_update()` checks only the byte count (`width * height * 4`).

### In the browser

```js
await context.registerTexture('webcam', 1, 1, { followSource: true }); // before presets load
const video = document.querySelector('video');                     // a getUserMedia() stream, or a file
const pump = () => {
  void context.updateTexture('webcam', video);   // scaled to the texture's size
  video.requestVideoFrameCallback(pump);         // once per decoded frame
};
video.requestVideoFrameCallback(pump);
```

`updateTexture(name, source, { maxSize })` takes a `<video>`, a canvas, an image, an
`ImageBitmap` or `VideoFrame`, `ImageData`, or `{ width, height, data }` RGBA8 pixels (top
row first). The frame is scaled to the texture's size. A texture registered with an
explicit size keeps it. A texture registered with `followSource: true`, or one that
`updateTexture()` registers itself for an unknown name, takes each frame's size, capped
at `maxSize` (default 1024) on its long side.

Calling `updateTexture()` while the previous frame for that name is still on its way
resolves `false` and drops the new frame. Frames are never queued, because only the
newest one matters.

What happens in each topology:

- **Main thread.** The frame is drawn at the texture's size on one reused 2D canvas, and
  `getImageData()` is copied with `HEAPU8.set()` into the slot's staging buffer on the
  WASM heap (`texture_slot_buffer(name, bytes)`). The page then calls
  `texture_slot_commit(name)`, and the next `render_frame()` uploads it, once, however
  many frames were committed in between. Nothing is malloc'ed per frame: the staging
  buffer belongs to the slot, like the PCM ring. `texture_slot_buffer()` answers 0 when
  `bytes` is not the slot's size, so a page that lost track of a resize cannot write past
  the buffer.
- **Render worker** (the default topology). The camera and the `<video>` stay on the
  page's thread, which is where `getUserMedia()` works. The transport turns each frame
  into an `ImageBitmap` already scaled to the texture's size
  (`createImageBitmap(source, { resizeWidth, resizeHeight })`). It transfers the bitmap in
  a `texture-frame` message (`projectm-render-worker-types.ts`).
  `html/worker/live-texture.js` then does the main-thread steps against the worker's own
  heap. Exact-size pixels cross as a transferred copy. No `Module._` is touched on the
  page.

The staging buffers and the registered sizes belong to the `WasmHost`, not to the
engine. After a WebGL context loss, `init()` re-registers every live texture on the new
engine and uploads its last frame (`ReapplyLiveInput()`). Two hosts in one Module have
separate textures.

### `?liveTex=1`

```
html/projectm-core.html?liveTex=1                        the camera into "webcam"
html/projectm-core.html?liveTex=1&liveTexSrc=/clip.mp4   a looping, muted video file (needs CORS)
                         &liveTexName=deck_b             another texture name
                         &liveTexSize=640                cap on the long side (default 1024)
```

Then load `presets/experimental/live_texture_webcam.milk`, or any preset that samples
the name. Without `?liveTex=1`, `projectm-live-texture-source.js` is not even fetched: the
app shell `import()`s it on demand. A refused camera logs a warning and leaves the
texture black.

### Native hosts

```c
projectm_texture_slot_register(pm, "webcam", 640, 360);           // before loading presets
/* per camera frame, on the render thread with the GL context current: */
projectm_texture_slot_update(pm, "webcam", rgba, 640 * 360 * 4);  // top row first
```

## Host variables

`projectm_eval_set(pm, "q1", 0.75)` (`context.setEvalVar('q1', 0.75)`) sets a per-frame
variable for every preset, from the next frame on, until `projectm_eval_clear()`.

The value is a **starting value, not a lock**. Each frame Milkdrop resets a preset's
per-frame variables to the preset's starting values: the file's `zoom=`, `fDecay=`, ...,
and `q1`..`q32` as the init code left them. Only then does it run the per-frame code. The
host's value is loaded right after that reset, before the code runs, so:

- per-frame code that **reads** the variable sees the host's value
  (`zoom = zoom + 0.02*bass;` adds to the host's zoom);
- per-frame code that **assigns** it wins for that frame (`q1 = bass;` ignores the host),
  as the preset's author intended;
- per-pixel code, custom shapes and waves, and the warp/composite shaders see `q1`..`q32`
  as the per-frame code left them. A preset that passes `q1` through unchanged hands the
  host's value all the way to its shaders.

A preset written to be driven gives its knobs a default in init code
(`per_frame_init_1=q1=0.6;`) and only reads them per frame. The demo preset does exactly
that.

Values carry over to every preset loaded later, and through transitions (both presets of a
crossfade get them). Like the other engine settings, they survive a context loss.

Accepted names: `q1`..`q32` and the per-frame variables a preset may assign: `zoom`,
`zoomexp`, `rot`, `warp`, `cx`, `cy`, `dx`, `dy`, `sx`, `sy`, `decay`, `wave_*` (a, r, g,
b, x, y, mystery, mode, usedots, thick, additive, brighten), `ob_*` and `ib_*` (size, r,
g, b, a), `mv_*` (x, y, dx, dy, l, r, g, b, a), `echo_zoom`, `echo_alpha`, `echo_orient`,
`darken_center`, `gamma`, `wrap`, `invert`, `brighten`, `darken`, `solarize`,
`blur1_min`..`blur3_max` and `blur1_edge_darken`, in any case. The read-only inputs the
engine writes every frame (`time`, `fps`, `frame`, `progress`, `bass`/`mid`/`treb` and
their `_att` forms, `meshx`, `meshy`, `pixelsx`, `pixelsy`, `aspectx`, `aspecty`, `pm_*`)
are refused, and so are NaN and infinities. The list lives in
`src/libprojectM/MilkdropPreset/PerFrameContext.cpp` (`kHostWritableVariables`).

### A MIDI knob on `q1`

Phase 2 of #250 is a lazy-loaded control bus (`?midi=1`, a JSON map, OSC over WebSocket).
Until then, a page that already has a `ProjectMContext` can wire one controller in a few
lines. Web MIDI is the browser's own API: nothing loads unless the page asks for it.

```js
// CC 1 (the mod wheel) on any channel drives q1, 0..1.
const midi = await navigator.requestMIDIAccess();
for (const input of midi.inputs.values()) {
  input.onmidimessage = ({ data: [status, controller, value] }) => {
    if ((status & 0xf0) === 0xb0 && controller === 1) {
      void context.setEvalVar('q1', value / 127);
    }
  };
}
```

With `live_texture_webcam.milk` loaded, the wheel fades between the plain camera (0) and
the trails (1). `context.clearEvalVar('q1')` hands the knob back to the preset's default.

## Tests

- `tests/libprojectM/LiveInputTest.cpp`: name and variable rules without GL. On a GL
  context, it checks that each uploaded frame shows without a preset reload, that a
  resize is followed in place, that a live texture wins over a file and survives new
  texture paths, that q1/q2 reach the composite shader from the next frame on (read by
  per-frame code, overridden by code that assigns them, cleared back to the preset's
  value), and the demo preset end to end.
- `tests/web/projectm-live-texture.test.mjs`: the registry, both transports, the
  `ProjectMContext` methods and the `?liveTex=1` source. The worker half is covered in
  `projectm-render-worker.test.mjs`, and both halves together in
  `projectm-render-worker-roundtrip.test.mjs`.
- `tests/wasm-smoke/live_input.mjs` (CI, `build_emscripten.yml`): the linked bundle in
  Chromium, on both topologies. It feeds a canvas, `ImageData` and Chromium's fake camera
  through `setupLiveTextureSource()`, checks `q1` on and off, and reads every check back
  from the canvas.

## Not in this phase

- Uploading straight from an `ImageBitmap`/`VideoFrame` into the GL texture
  (`texSubImage2D(..., bitmap)`), which would skip the canvas readback. It needs JS-side
  GL calls outside the device seam, and care with the WebGL unpack state.
- The MIDI/OSC control bus (Phase 2), the HDR/Display-P3 present (Phase 3) and
  NDI/WebRTC ingest (Phase 4, as another source for the same texture slot).
