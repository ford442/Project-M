# Render device

Every GPU call projectM makes goes through one seam, `Renderer::Device`. Today it
has one backend, `Gl::GlDevice` (OpenGL 3.3 core, GLES 3, WebGL 2). It is Phase A
of the WebGPU backend: with the renderer and the WASM host both on the seam, a
second backend means implementing two interfaces, not editing forty files.

Phase A changes no behaviour. `GlDevice` issues the GL calls the renderer used to
make itself, in the same order (see [Equivalence](#equivalence)).

Phase B moves the interface to WebGPU's shape on GL, one step at a time:
[pipelines](#pipelines) (B1.1/B1.2, #354), [uniform buffers](#uniform-buffers) (B1.3),
[bind groups](#bind-groups) (B1.4), [render passes](#render-passes) (B1.5) and the
[render graph](#render-graph) (B2). From pipelines on, GL calls are no longer issued in
the old order (state already applied is skipped), so equivalence means identical pixels,
not identical call traces; see [Equivalence](#equivalence) for what each step was checked
against. Phase C, the shader path (HLSL to WGSL, with reflection from the tree), is in:
[ADR 0002](adr/0002-wgsl-shader-path.md). Phase D (`WgpuDevice`) is next; the ADR lists what it
inherits (bind group layouts from the reflection, clip-space y negated).

## Layout

| File | What it holds |
|------|---------------|
| `src/libprojectM/Renderer/Device/DeviceTypes.hpp` | Handles, enums and descriptors: `TextureDesc`, `PipelineDesc`, `RenderPassDesc`, `StateSnapshot`, `ResourceState`, ... No GL. |
| `Renderer/Device/RenderDevice.hpp/.cpp` | `IRenderDevice`, `ICommandList`, `Device::Current()`, `ScopedDevice`, `Device::Commands()`. |
| `Renderer/Device/ResourceStateTracker.hpp/.cpp` | The validation layer (see [Validation](#validation-feedback-hazards)). |
| `Renderer/Device/Gl/GlEnums.hpp/.cpp` | Device enums to `GL_*`. The only place a `GL_*` constant appears for the renderer. |
| `Renderer/Device/Gl/GlDevice.hpp/.cpp` | The GL backend. |
| `Renderer/UniformRingBuffer.hpp/.cpp` | The ring per-draw uniform blocks are written to; each engine owns one (`EngineContext::UniformRing()`). |
| `Renderer/UniformBlocks.hpp/.cpp` | The built-in shaders' std140 blocks: slots, the block registry, the C++ mirrors, `UniformBlockWriter`. |
| `Renderer/RenderGraph.hpp/.cpp` | The frame as declared passes, transient targets and their pool. |

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
- **Every draw is inside a render pass.** `BeginRenderPass(RenderPassDesc)` binds a
  target, sets the viewport and applies the load op (`Load` keeps the contents,
  which Milkdrop's feedback passes depend on; `Clear` replaces them); `EndRenderPass()`
  ends it. `BindRenderTarget()` is for what happens outside passes: attachment
  changes, the read side of copies and blits. See [Render passes](#render-passes).
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
m_uniforms.Write(Renderer::TransformUniforms{projection, 1.0f}); // the draw's block, slot 1
m_mesh.Draw();                                                  // DrawIndexed() with its topology
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

## Uniform buffers

The preset shaders' per-frame inputs are one std140 uniform block, `cbuffer _milkdrop_frame`
in `PresetShaderHeaderGlsl330.inc` (hlslparser emits `layout(std140) uniform`): `rand_frame`,
`rand_preset`, `_c0`..`_c17` (time, fps, bass/mid/treb, the blur ranges, `pm_*`, `iPass`), `_qa`..`_qh`
(q1..q32) and the 24 `rot_*` matrices, 1600 bytes. `MilkdropFrameUniforms` in `MilkdropShader.hpp` is the
same layout (a `static_assert` checks the size; every member is a vec4 or a mat3x4, so std140 adds no
padding). Keep the two in step, one declaration per line: in a cbuffer the transpiler keeps only the first
name of `float4 a, b;`.

- `MilkdropShader::LoadVariables()` fills the struct and writes it to the engine's
  `UniformRingBuffer` (`EngineContext::UniformRing()`, owned by `ProjectM`): each draw gets its own
  range at `UniformBufferOffsetAlignment()`, which is WebGPU's dynamic-offset model. The ring is one
  64 KiB buffer that wraps across frames; ranges of one frame never overlap, and a frame that needs
  more grows it once. Nothing is allocated per frame. `ProjectM::RenderFrame()` starts each frame on
  it. A write with the same bytes as the previous one of the frame gets that write's range back: the
  per-instance draws of shapes and waves rewrite one constant block hundreds of times.
- Drawing objects write through a `UniformBlockWriter` member: inside an engine it uses the engine's
  ring; outside any engine (the WASM compositor, tests that draw with renderer objects directly) a
  4 KiB ring of its own, created on first use and released with the object, like its programs. The
  process device cannot hold a ring: it is not tied to one GL context (each WASM host has its own,
  and GPU tests make one per test). A ring nobody starts frames on wraps instead of growing.
- Device: `BufferKind::Uniform`, `CreateUniformBuffer()`, `WriteBuffer()` (queue-ordered, like
  `queue.writeBuffer()`), `ICommandList::BindUniformBuffer(slot, buffer, offset, size)`, and
  `BindUniformBlock(program, name, slot)`. GLSL 3.30 and ESSL 3.00 cannot say `layout(binding = n)`,
  so `Shader::SetUniformBlockBinding()` re-applies the slot after every link.
  `ResetPipelineState()` unbinds the slots it bound.
- An assignment to a block member (`q25 = ...;` in shader code) needs a local copy, because block
  members are read-only in GLSL; hlslparser makes the same copy it makes for a plain uniform.
- Cached transpiled GLSL without the block (from an older engine) is transpiled again.

### The built-in shaders' blocks

Every other value a built-in program reads is a member of a std140 block too, so no shader has
default-block uniforms left but its samplers (which texture unit a `sampler2D` reads; on WebGPU a
bind group entry) and the preset shaders' `texsize_*` (the WGSL path already puts those in
`pmw_globals`, ADR 0002). `Renderer/UniformBlocks.hpp` lists them:

| Block | Slot | C++ | Read by |
|---|---|---|---|
| `_milkdrop_frame` | 0 | `MilkdropFrameUniforms` | preset warp and composite shaders |
| `_pm_transform` | 1 | `TransformUniforms` | textured and untextured draws: shapes, waves, borders, filters, darken center, video echo |
| `_pm_copy` | 1 | `CopyUniforms` | `CopyTexture`'s shader path (both stages) |
| `_pm_motion_vectors` | 1 | `MotionVectorUniforms` | motion vectors |
| `_pm_warp` | 1 | `WarpUniforms` | the warp mesh's vertex shader (default and preset warp) and the default warp fragment shader (`u_flipMainTex`) |
| `_pm_blur` | 1 | `BlurUniforms` | both blur programs (`_c0`..`_c3`, `_c5`, `_c6`, `flipVertical`) |
| `_pm_transition` | 1 | `TransitionUniforms` | the transition shader header (the old uniform names are its members) |
| `_pm_flash_limiter` | 1 | `FlashLimiterUniforms` | the flash limiter's state and mix passes |
| `_pm_sprite` | 1 | `SpriteUniforms` | user sprites |
| `_pm_compositor` | 1 | `CompositorUniforms` | the WASM host's dual-FBO compositor |
| `_pm_per_pixel` | 2 | `PerPixelUniforms` | the GPU per-pixel path's generated code (`GPU_PERPIXEL_EVAL.md`) |

- Slot 0 is the preset's per-frame block, slot 1 the draw's own block, slot 2 the per-pixel block;
  no program reads two blocks from one slot. A block two stages of one program declare is
  declared identically in both.
- `Shader` binds every registry block a program declares to its slot after each link, so callers
  do not call `SetUniformBlockBinding()` for them.
- A draw writes its block with `m_uniforms.Write(block)` right before it draws, or before a run of
  draws that share it (the flash limiter's state and mix passes, a shape's instances). The slot
  binding is not pipeline state: it stays until the next block is written to that slot, so a draw
  must not rely on a block written by someone else.
- The structs' `static_assert`s pin the std140 offsets; `UniformBlockLayoutTest` (GPU) records every
  built-in block of every program an engine links while it draws all of them, on both copy and blur
  paths, and compares each member's offset, the block size and its slot with the struct. A block no
  program declared fails it, so a renamed one cannot go unchecked.
- For Phase D these structs are what the hand-written WGSL twins of the built-in shaders declare:
  each struct is already a WGSL uniform-address-space layout (vec3 at 16-byte alignment, a `mat4`
  as four columns, `ivec4` as `vec4i`).

## Bind groups

A `BindGroupDesc` lists textures (unit, target, texture, sampler) and uniform buffer ranges, optionally
with a dynamic offset. `IRenderDevice::CreateBindGroup()` makes an immutable group and
`ICommandList::SetBindGroup(group, dynamicOffsets)` makes it current.

- `MilkdropShader` binds its draw's resources as one group: the main texture, `sampler_lastpass`,
  the blur levels, the preset's own textures, in the unit order they always had, and the frame block at
  its ring offset. It keeps up to four groups keyed by the textures and their sizes; the main texture
  alternates between two, so a preset creates its groups in its first frames and reuses them after. The
  sampler-unit and texsize uniforms are set when a group is created, not on every draw. A relink drops
  the groups (it resets the uniforms).
- On GL, `SetBindGroup()` skips a texture or sampler a unit already holds, and leaves the active unit on
  the group's last unit, as binding one by one did. The command list follows unit bindings and forgets
  them on `InvalidateState()`, on texture uploads (which rebind the active unit), and when a texture or
  sampler is deleted (GL unbinds it, and may give its name to the next texture).
- The other draws (blur, copies, transitions, the flash limiter, sprites) still bind textures one by one.

## Render passes

`BeginRenderPass(RenderPassDesc)` / `EndRenderPass()`. The pass's colour targets are its target's
attachments (a render target is an attachment set; a WebGPU backend turns it into `colorAttachments`),
with a `LoadOp`, a `StoreOp` and a label. Every draw and clear is inside a pass and passes do not nest.
Inside a pass the target and its attachments are fixed, and copies, blits and readbacks are not allowed:
they are encoder commands on WebGPU.

- Code that renders elsewhere in the middle of its caller's pass (the extra shader passes, transition
  pass 0) holds a `ScopedPassInterruption`: it ends the open pass (`CurrentRenderPass()`) and begins
  `Resumed()`, the same pass with `LoadOp::Load`, when it is done. On WebGPU that is ending the pass
  encoder and beginning one that loads.
- `Framebuffer::BeginRenderPass(index, label, binding, viewport)` issues the same GL binds as `Bind()`
  (`ReadDraw`) or `BindDraw()` (`Draw`). `Preset::FramebufferPass()` replaced `BindFramebuffer()`, and the
  flash limiter's frame is `FlashLimiter::FramePass()`.
- With validation on, the tracker reports **pass violations** once each, as
  `[RenderDevice] Pass violation: ...`: a draw or clear outside a pass, a copy, blit or readback inside one,
  a pass begun inside another, a change of the draw target or of its attachments while one is open, and a
  frame that ends inside one (`PassViolationCount()`, `PassViolationMessages()`, `PassCount()`). The
  `RenderPassValidation` ctest renders `presets/tests` with transitions on both render paths and fails on
  any; the whole corpus has none.

## Render graph

`Renderer::RenderGraph` is the frame declared as passes with the targets they read and write. It is
built every frame and compiled and executed at once:

```cpp
graph.Reset();
const auto previous = graph.Import("previous frame", m_framebuffer.Target(m_previousFrameBuffer));
const auto passTarget = graph.CreateTransient("warp pass target A", {width, height, TextureFormat::RGBA});
auto warp = [&](RenderGraph::PassContext& context) { /* draws; context.Transient(passTarget) */ };
graph.AddPass("warp", {.target = current, .viewport = viewport, .reads = {previous}, .writes = {passTarget}}, warp);
if (graph.Compile())
{
    graph.Execute(commands);
}
```

- **Resources** are imported (persistent: the preset framebuffers, the host's target) or transient (from
  its first pass to its last, contents undefined at the first). `Resource{}` in a read or write list means
  "none", for targets a frame may not have.
- **Passes** are `Render` (the graph begins and ends a render pass on its target around the function,
  with `StoreOp::Discard` at a transient's last use) or `Encoder` (copies and blits, or a helper that runs
  its own render passes).
- `Compile()` rejects a frame that reads a transient before anything wrote it, or a render pass that
  samples its own target, and then gives each transient a target from the graph's pool: transients whose
  lifetimes do not overlap share one. Targets of a size no transient asks for any more (a resize) are
  dropped. `Describe()` lists the passes; `GetStats()` counts transients and the targets they use.
- Nothing allocates per frame once the pool holds what a preset needs: passes and resources are fixed
  arrays (`MaxPasses`, `MaxResources`), names are static strings, and pass functions are non-owning
  references to callables that outlive `Execute()`.

The frames:

- `MilkdropPreset::RenderFrame()`: motion vectors, flip main (custom warp shaders only), attach the
  motion-vector u/v, warp, detach, the blur (prepare, begin, one pass per level, end), shapes and waves,
  flip for the composite, composite, flip back (presets without a composite shader). The warp and
  composite extra passes (#229) take their ping-pong targets from the graph as transients, so the two
  chains share two targets instead of owning four.
- `ProjectM::RenderFrame()`: the transitioning and the active preset's frames, present (transition,
  blit or transparency copy, and the flash limiter), user sprites. The present step runs its own passes.
- **Variants** of a frame are different declarations: `BlurTexture::AddPasses()` declares the direct
  levels or the copy-path levels (`PROJECTM_BLUR_COPY_PATH`, `?blurPath=copy`), and the preset frame
  sets `CopyTexture`'s path (`PROJECTM_COPY_SHADER_PATH`, `?copyPath=shader`) when it declares its flips.

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

B1.3 to B2 were checked with `scripts/render_hash_corpus.sh <projectm-render> <out>`, which renders
every preset of `presets/tests`, `presets/custom` and `presets/weeks` (508) in four variants: the default
paths, the copy paths, CPU per-pixel, and a soft cut from each preset to the next (`projectm-render
--then`), 2032 renders. Compare two runs with `diff`. `projectm-render` seeds the process default first
(`projectm_set_deterministic_seed()`); before it did, 79 of 1524 renders differed between two runs of the
same build.

- Uniform buffers (B1.3): 486 of 509 presets render bit-identically to `main`. The other 23 (all in
  `presets/weeks`) differ in at most 0.5% of pixels, most by 1 to 4 of 255, more where a feedback preset
  amplifies it. That difference comes from llvmpipe, not from the values: feeding the same struct to the
  same shaders through plain uniforms reproduces `main` exactly. llvmpipe compiles a read from a uniform
  block differently from a read of a default-block uniform. The WASM goldens were unchanged.
- Render passes (B1.5): identical to B1.3, except on the blur copy path, where B1.5 fixes a bug: on the
  first frame and after a resize, resizing the scratch framebuffer left FBO 0 bound, the blur restored
  that, and the frame's shapes and waves went to the default framebuffer. B1.3 with only that fix gives
  B1.5's pixels for every copy-path render. The hazard inventory still finds no feedback hazards, and
  there are no pass violations.
- Bind groups (B1.4) and the render graph (B2): every render identical to the step before. Sharing the
  extra-pass targets was also checked on a preset with both warp and composite extra passes.
- The built-in shaders' blocks (Phase C): all 2032 renders identical to the step before. Unlike B1.3, no
  preset changed: llvmpipe compiles these reads the same way from a block as from the default block.
  One render of the baseline run (`presets/weeks/pair up gnothing knew nz.milk`, default paths)
  differed once and matched on every rerun of both builds, a nondeterminism of that preset under a
  loaded parallel run, not of this change.

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
- Tests: `tests/libprojectM/RenderDeviceTest.cpp` covers the tracker (hazards and pass
  violations) and pipeline hashing without GL, and `GlDevice` on a headless context: clear
  and readback, the pipeline cache, applied and filtered state, draws without a pipeline,
  clears against pipeline masks, capture and restore, a real feedback draw, uniform buffer
  ranges and the ring, bind groups and their binding cache, and pass interruption.
  `RenderGraphTest.cpp` covers the graph's validation, order and transient aliasing.
