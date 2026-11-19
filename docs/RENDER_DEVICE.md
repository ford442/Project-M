# Render device

Every GPU call projectM makes goes through one seam, `Renderer::Device`. Today it
has one backend, `Gl::GlDevice` (OpenGL 3.3 core, GLES 3, WebGL 2). It is Phase A
of the WebGPU backend: with the renderer and the WASM host both on the seam, a
second backend means implementing two interfaces, not editing forty files.

Phase A changes no behaviour. `GlDevice` issues the GL calls the renderer used to
make itself, in the same order (see [Equivalence](#equivalence)).

Phase B1 (#354) moves the interface to WebGPU's shape on GL, one step at a time,
each one pixel-identical: [pipelines](#pipelines) first, then render passes, bind
groups with uniform blocks, and the WASM compositor. From pipelines on, GL calls are
no longer issued in the old order (state already applied is skipped), so equivalence
means identical pixels, not identical call traces.

## Layout

| File | What it holds |
|------|---------------|
| `src/libprojectM/Renderer/Device/DeviceTypes.hpp` | Handles, enums and descriptors: `TextureDesc`, `PipelineDesc`, `RenderPassDesc`, `StateSnapshot`, `ResourceState`, ... No GL. |
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
- **Immediate on GL.** Commands execute as they are issued, and queries
  (`IsEnabled()`, `Viewport()`, `BoundRenderTarget()`, `CaptureState()`) ask the
  context. The one cache is the pipeline state the command list applied (see
  [Pipelines](#pipelines)), and it is dropped whenever a host could have changed GL.
- **Milkdrop-shaped, not a general RHI.** The interface covers fullscreen quads,
  the warp mesh, waveform lines and points, the blur chain, sprites, readback and
  the host compositor. Some calls are GL-isms kept for bit-identity and marked as
  such: `SetActiveTextureUnit()` and the `SetBoundTexture*()` parameter calls, the
  `Dither`/`FramebufferSrgb` capabilities, `RasterState::lineSmooth`, `SetLineWidth()`,
  `PixelOrder::Bgra`. A backend without them ignores them.

### Which device

`Device::Current()` is the device a `ScopedDevice` installed on this thread, or
else the process-wide `GlDevice` (created on first use and never destroyed,
because static objects may still release handles during static destruction).
Resource wrappers (`Texture`, `Sampler`, `Shader`, `Framebuffer`, `VertexBuffer`,
`CopyTexture`, `FlashLimiter`, `BlurTexture`, ...) capture `&Device::Current()`
when they are constructed and use that device for their lifetime. Free functions
and static helpers use `Device::Commands()`.

Each engine (`ProjectM` instance) owns a `GlDevice` in its `EngineContext`, and
`ScopedEngineContext` installs it as a `ScopedDevice` on every entry point and in
the preset prepare job, so an engine's resources and its validation tracker are its
own. The `EngineContext` outlives everything the engine creates (it is the first
`ProjectM` member, and prepared presets hold a reference), so captured device
pointers never dangle. Code outside any engine (the WASM host's compositor, tests)
uses the process-wide device.

`GlDevice` keeps no per-context state, so a device is not tied to one GL context.
Calls need the right context current, as before.

## What moved behind it

| Before | Now |
|--------|-----|
| `Framebuffer`, `TextureAttachment` | `RenderTargetHandle`s; attachments are `TextureDesc` + `CreateTexture()`. `TextureAttachment` takes a `Device::TextureFormat`. |
| `Texture`, `Sampler`, `TextureManager`, `MilkdropNoise` | `TextureHandle`/`SamplerHandle`, `Device::TextureFormat`, `FilterMode`, `WrapMode`, `PixelOrder`. |
| `Shader` | `ProgramHandle`; `BeginCompileProgram()`/`FinishCompileProgram()` keep the deferred (KHR_parallel_shader_compile) link. `AttributeLocation()` is new. |
| `VertexBuffer`, `VertexArray`, `VertexIndexArray`, `Mesh` | `BufferHandle`/`VertexArrayHandle`; vertex types no longer carry GL attribute-pointer code. |
| `BlendMode` | Removed: blending is part of each draw's `PipelineDesc` (`Device::BlendState`). |
| `CopyTexture`, `BlurTexture`, `FlashLimiter`, `PresetTransition` | Commands on the device, each draw through a pipeline. |
| Preset drawables (`Border`, `CustomShape`, `CustomWaveform`, `Waveform`, `Filters`, `MotionVectors`), `MilkdropSprite`, `ProjectM.cpp` | Commands on the device. |
| `src/wasm/WasmGraphics.hpp` | `DualPingPongFramebuffer` on device handles; `GLStateSnapshot`/`GLStateGuard` became `Device::StateSnapshot` + `RenderStateGuard`; `gl_reset_state_between_pipelines()` became `reset_render_state_between_pipelines()`; the compositor is a `Renderer::Shader` + `VertexArray` + `VertexBuffer<Point>` instead of its own compile/link code. |
| `WasmRenderLoop.cpp`, `WasmPresent.cpp` | `start_render()` state, the opaque-alpha fill and the frame capture (pixel-pack buffer + fence) on the device. |

## Pipelines

Blending, face culling, depth test and writes, colour write masks, line smoothing,
the vertex layout and the primitive topology of a draw are one immutable
`PipelineDesc`, with the program. A draw site describes its pipeline and makes it
current before drawing:

```cpp
// Mesh::Pipeline() fills in the program, the mesh's topology and its attribute layout.
Renderer::Device::SetPipeline(m_mesh.Pipeline(*shader, Renderer::Device::BlendState::Alpha()));
shader->SetUniformMat4x4("vertex_transformation", ...); // the pipeline's program is current
m_mesh.Draw();                                          // DrawIndexed() with its topology
```

- `IRenderDevice::CreatePipeline()` returns a `PipelineHandle` cached by
  `Device::Hash(desc)` and equality, so the same description always gives the same
  handle and a frame creates none after the first. A pipeline needs a program, and
  `DestroyProgram()` drops the program's pipelines. Ids are not reused, so a stale
  handle is unknown, never another pipeline. `Device::SetPipeline(desc)` creates or
  finds the pipeline and makes it current.
- Draws take no primitive: `Draw(first, count)` and `DrawIndexed(count)` use the
  current pipeline's topology. A draw without a current pipeline is skipped, with one
  `[RenderDevice] Draw() without a pipeline` warning. `SetProgram()` with the current
  pipeline's program (`Shader::Bind()` before a uniform upload) keeps the pipeline;
  any other program ends it.
- On GL, `GlCommandList` records what it applied and issues only the GL calls that
  change something. `InvalidateState()` drops the record. `ScopedDevice` calls it when
  it installs a device and when it hands back to a different one, because host code
  may have changed GL in between. Code that changes GL state behind the device must
  call it too.
- GL 3.3 and GLES 3.0 blend every draw buffer alike, so `GlDevice` applies
  `targets[0]`'s blend to all of them. Differing write masks use `glColorMaski` on
  desktop GL; on GLES every buffer gets the first target's mask.
- `Clear()` writes every channel and the depth buffer, whatever the pipeline's masks
  say. `ClearColorAttachment()` takes its own write mask. Both put the pipeline's
  masks back afterwards.
- Entry points that draw (`ProjectM::RenderFrame()`, `BurnInTexture()`) hold a
  `ScopedPipelineReset`, so the host finds GL's defaults afterwards: blending off with
  (one, zero), depth writes on, no culling or line smoothing, program 0. Before
  pipelines, projectM left blending off but left the last blend function and program bound.
- Not pipeline state: scissor, viewport, dither and sRGB encode (`Capability`), line
  width, and bound resources (textures, samplers, vertex arrays, uniforms). The vertex
  layout is in the description and its key, but on GL the `VertexArray` objects still
  hold the attribute pointers; the layout is there for a backend that builds vertex
  state from it.

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

Phase B1's steps are checked the same way, against `main`:

- The native harness, extended to 506 presets (six frames each) plus 16 scenarios,
  including two engines in one process. It now calls `projectm_set_deterministic_seed()`
  before creating any engine. Without that, 31 of 522 jobs differed between two runs of
  the same library: noise textures and the time keeper draw their seeds when an engine
  is created, before a per-engine seed can apply.
- Pipelines (with the per-frame allocation fixes before them): every hash identical
  in all three render-path variants. The WASM goldens: 26 frames, maximum channel
  delta 0.

Keeping it bit-identical meant keeping GL quirks. One example: `Framebuffer`
still lists depth and stencil attachments in `glDrawBuffers`. Fix such quirks in
a change of their own, with the golden images updated deliberately.

## Validation: feedback hazards

Sampling a texture in the pass that renders to it is undefined on GL. On WebGPU it
is a validation error. `ResourceStateTracker` finds these on the GL backend now, so
the WebGPU port does not discover them one preset at a time.

- Off by default. `PROJECTM_DEVICE_VALIDATION=1` starts every device (the process-wide
  one and each engine's) with it on; `IRenderDevice::Validation().SetEnabled(true)` turns it on at runtime.
- It follows draw-target attachments, 2D/3D texture bindings per unit and each
  program's sampler-uniform-to-unit assignment. On every draw it checks whether a
  unit the current program samples holds a texture attached to the draw target.
  It also flags blits and `CopyToBoundTexture()` that read the texture they write.
  A texture bound on a unit nothing samples is not a hazard.
- `scripts/hazard_inventory.sh <projectm-render> <out-dir> [preset-dir...]` renders every
  preset in `presets/tests`, `presets/custom` and `presets/weeks` with validation on and
  writes `hazards.json` / `hazards.md` (distinct hazards per preset, grouped by kind).
  `hazard_inventory.yml` runs it on every PR and on `main` and uploads the result as the
  `hazard-inventory` artifact. It reports and does not gate; `HAZARD_FAIL_ON_HAZARD=1`
  makes it fail on any hazard.
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
- New fixed-function state belongs in `PipelineDesc`, not in a `Set*()` call.
  Add it to `Device::Hash()` and to `GlCommandList::Apply()`, which applies only what
  changed.
- Tests: `tests/libprojectM/RenderDeviceTest.cpp` covers the tracker and pipeline
  hashing without GL, and `GlDevice` on a headless context: clear and readback, the
  pipeline cache, applied and filtered state, draws without a pipeline, clears against
  pipeline masks, capture and restore, and a real feedback draw.
