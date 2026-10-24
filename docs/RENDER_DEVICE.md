# Render device

Every GPU call projectM makes goes through one seam, `Renderer::Device`. Today it
has one backend, `Gl::GlDevice` (OpenGL 3.3 core, GLES 3, WebGL 2). It is Phase A
of the WebGPU backend: with the renderer and the WASM host both on the seam, a
second backend means implementing two interfaces, not editing forty files.

Phase A changes no behaviour. `GlDevice` issues the GL calls the renderer used to
make itself, in the same order (see [Equivalence](#equivalence)).

## Layout

| File | What it holds |
|------|---------------|
| `src/libprojectM/Renderer/Device/DeviceTypes.hpp` | Handles, enums and descriptors: `TextureDesc`, `RenderPassDesc`, `StateSnapshot`, `ResourceState`, ... No GL. |
| `Renderer/Device/RenderDevice.hpp/.cpp` | `IRenderDevice`, `ICommandList`, `Device::Current()`, `ScopedDevice`, `Device::Commands()`. |
| `Renderer/Device/ResourceStateTracker.hpp/.cpp` | The validation layer (see [Validation](#validation-feedback-hazards)). |
| `Renderer/Device/Gl/GlEnums.hpp/.cpp` | Device enums to `GL_*`. The only place a `GL_*` constant appears for the renderer. |
| `Renderer/Device/Gl/GlDevice.hpp/.cpp` | The GL backend. |

`Renderer/Platform/` (context creation, the GL loader) is the other place GL is
allowed. `Renderer/OpenGL.h` stays where it is because the tests include it
through `tests/libprojectM/TestGl.hpp`.

## The model

- **Handles are values.** `TextureHandle`, `RenderTargetHandle`, `ProgramHandle`,
  `BufferHandle`, ... each wrap an id; id 0 is "none" (`Valid()` is false), and
  `RenderTargetHandle{0}` is the default framebuffer. On GL an id *is* the GL object
  name, so the C API's GL framebuffer and texture ids (`projectm_opengl_render_frame_fbo()`,
  burn-in textures, `dual_fbo_get_*()`) pass straight through as `{id}`.
- **Two interfaces.** `IRenderDevice` creates, re-specifies and destroys
  resources and answers capability queries. `ICommandList` sets state, records
  passes and draws, copies, blits and reads back.
- **Passes where the code is pass-shaped.** `BeginPass(RenderPassDesc)` binds a
  target, sets the viewport and applies the load op (`Load` keeps the contents,
  which Milkdrop's feedback passes depend on; `Clear` replaces them). `EndPass()`
  ends it. Code that is stateful today (the preset's own target juggling) uses
  `BindRenderTarget()`; a pass then lasts until the next draw-target bind.
- **Immediate on GL, no state cache.** Commands execute as they are issued, and
  queries (`IsEnabled()`, `Viewport()`, `BoundRenderTarget()`, `CaptureState()`)
  ask the context. A host can change GL state between frames without projectM
  serving a stale cached value.
- **Milkdrop-shaped, not a general RHI.** The interface covers fullscreen quads,
  the warp mesh, waveform lines and points, the blur chain, sprites, readback and
  the host compositor. Some calls are GL-isms kept for bit-identity and marked as
  such: `SetActiveTextureUnit()` and the `SetBoundTexture*()` parameter calls, the
  `Dither`/`LineSmooth`/`FramebufferSrgb` capabilities, `SetLineWidth()`,
  `PixelOrder::Bgra`. A backend without them ignores them.

### Which device

`Device::Current()` is the device a `ScopedDevice` installed on this thread, or
else the process-wide `GlDevice` (created on first use and never destroyed,
because static objects may still release handles during static destruction).
Resource wrappers (`Texture`, `Sampler`, `Shader`, `Framebuffer`, `VertexBuffer`,
`CopyTexture`, `FlashLimiter`, `BlurTexture`, ...) capture `&Device::Current()`
when they are constructed and use that device for their lifetime. Free functions
and static helpers use `Device::Commands()`.

`GlDevice` keeps no per-context state, so one instance serves every GL context in
the process (the WASM build's per-host WebGL contexts included). Calls need the
right context current, as before.

## What moved behind it

| Before | Now |
|--------|-----|
| `Framebuffer`, `TextureAttachment` | `RenderTargetHandle`s; attachments are `TextureDesc` + `CreateTexture()`. `TextureAttachment` takes a `Device::TextureFormat`. |
| `Texture`, `Sampler`, `TextureManager`, `MilkdropNoise` | `TextureHandle`/`SamplerHandle`, `Device::TextureFormat`, `FilterMode`, `WrapMode`, `PixelOrder`. |
| `Shader` | `ProgramHandle`; `BeginCompileProgram()`/`FinishCompileProgram()` keep the deferred (KHR_parallel_shader_compile) link. `AttributeLocation()` is new. |
| `VertexBuffer`, `VertexArray`, `VertexIndexArray`, `Mesh` | `BufferHandle`/`VertexArrayHandle`; vertex types no longer carry GL attribute-pointer code. |
| `BlendMode`, `CopyTexture`, `BlurTexture`, `FlashLimiter`, `PresetTransition` | Commands on the device; `BlendMode::Function` is `Device::BlendFactor`. |
| Preset drawables (`Border`, `CustomShape`, `CustomWaveform`, `Waveform`, `Filters`, `MotionVectors`), `MilkdropSprite`, `ProjectM.cpp` | Commands on the device. |
| `src/wasm/WasmGraphics.hpp` | `DualPingPongFramebuffer` on device handles; `GLStateSnapshot`/`GLStateGuard` became `Device::StateSnapshot` + `RenderStateGuard`; `gl_reset_state_between_pipelines()` became `reset_render_state_between_pipelines()`; the compositor is a `Renderer::Shader` + `VertexArray` + `VertexBuffer<Point>` instead of its own compile/link code. |
| `WasmRenderLoop.cpp`, `WasmPresent.cpp` | `start_render()` state, the opaque-alpha fill and the frame capture (pixel-pack buffer + fence) on the device. |

## Equivalence

Phase A's acceptance is "golden images and PresetCompat unchanged". It was checked
three ways:

- A native hash harness rendered every preset in `presets/tests/`, `presets/custom/`
  and `presets/weeks/` (501 presets, hashing three frames each). It also ran
  scenarios: soft transitions, a hard cut, resize, user sprites with burn-in,
  transparency, the flash limiter, and a blur-capped preset. It used the default path,
  `PROJECTM_COPY_SHADER_PATH=1 PROJECTM_BLUR_COPY_PATH=1`, and
  `PROJECTM_PER_PIXEL_EVAL=cpu`, against the library before and after. Every frame
  hash matched.
- The WASM golden-image harness (`tests/wasm-smoke/golden_images.mjs`) captured the
  bundle before and after, and the captures were compared.
- `ctest`: `PresetCompat`, the GPU per-pixel tests, the flash-limiter and colour-output
  tests.

Keeping it bit-identical meant keeping GL quirks. One example: `Framebuffer`
still lists depth and stencil attachments in `glDrawBuffers`. Fix such quirks in
a change of their own, with the golden images updated deliberately.

## Validation: feedback hazards

Sampling a texture in the pass that renders to it is undefined on GL. On WebGPU it
is a validation error. `ResourceStateTracker` finds these on the GL backend now, so
the WebGPU port does not discover them one preset at a time.

- Off by default. `PROJECTM_DEVICE_VALIDATION=1` starts the process-wide device with
  it on; `IRenderDevice::Validation().SetEnabled(true)` turns it on at runtime.
- It follows draw-target attachments, 2D/3D texture bindings per unit and each
  program's sampler-uniform-to-unit assignment. On every draw it checks whether a
  unit the current program samples holds a texture attached to the draw target.
  It also flags blits and `CopyToBoundTexture()` that read the texture they write.
  A texture bound on a unit nothing samples is not a hazard.
- Each hazard is counted (`HazardCount()`). Each distinct one is logged once at
  warning level as `[RenderDevice] Feedback hazard: ...` and kept in
  `HazardMessages()` (up to 32).
- It also records each texture's last `ResourceState` (`RenderTarget`,
  `ShaderResource`, `CopySource`, `CopyDestination`), which a WebGPU backend needs
  for its usage flags.
- Limits: a program linked while validation was off is not checked, because sampler
  locations are read at link time. The tracker is not thread-safe, so enable it only
  while one thread renders.

## The seam gate

`scripts/check_gl_seam.sh` (run by `cpp_format_gate.yml`) fails when a file under
its `PATHS` list, outside `Renderer/Device/Gl/` and `Renderer/Platform/`, has a
direct GL call (`\bgl[A-Z]\w*\(`) or includes `Renderer/OpenGL.h` or a glad
header. Comments are ignored. String literals are not, so a log message names a
GL function without its parentheses.

`PATHS` is ratcheted like `check_cpp_format.sh`: today it is `src/libprojectM` and
`src/wasm`, both clean. Before Phase A the same check found 441 lines there. Add a
directory once it is clean, never before. `src/sdl-test-ui` (a GL frontend that
owns its own context) and the tests are deliberately outside it.

## Adding to the interface

- Add the call to `ICommandList` or `IRenderDevice` in Milkdrop's terms, then
  implement it in `GlDevice`, mapping enums in `GlEnums.cpp`.
- If the call reads or writes a texture through a render target or a unit, give
  `ResourceStateTracker` a hook for it.
- Before adding a GL-only switch, ask what WebGPU would do with it. If the answer
  is "nothing", document that the backend ignores it, as `Dither` is.
- Tests: `tests/libprojectM/RenderDeviceTest.cpp` covers the tracker without GL and
  `GlDevice` on a headless context (clear and readback, capture and restore, a real
  feedback draw).
