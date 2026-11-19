# Extra shader passes in .milk presets

A preset can run up to two extra shaders before its warp shader, and up to two before its
composite shader. Each extra pass draws into its own render target; the next pass, and finally
the stage's own shader, read that image as `sampler_lastpass`. This is a projectM extension
(#229). Milkdrop has no such thing (each stage has exactly one shader), so a preset that uses it
only runs in projectM.

## Syntax

The passes use the normal `.milk` line format, with the same backtick shader lines as `warp_N` and
`comp_N`:

```ini
warp_nPasses=2
warp_pass1_1=`shader_body
warp_pass1_2=`{
warp_pass1_3=`    ret = GetBlur1(uv) * 1.2;          // pass 0: draws into an intermediate target
warp_pass1_4=`}
warp_1=`shader_body
warp_2=`{
warp_3=`    ret = tex2D(sampler_lastpass, uv).xyz; // the warp shader: reads pass 0's output
warp_4=`}
```

| Key | Meaning |
|---|---|
| `warp_nPasses=N`, `comp_nPasses=N` | The stage runs N shaders, its own included: N - 1 extra passes, then `warp_`/`comp_`. 1 to 3; without the key, 1. |
| `warp_passK_1` .. , `comp_passK_1` .. | Code of extra pass K (1 .. N - 1), run in order. Each is a complete `shader_body` with its own `{ }`. |

The issue that proposed this (#229) sketched `[warp_pass1]` sections and `warp_pass1_enabled`
keys. Neither exists: a `.milk` file has one `[preset00]` section that the parser reads, so passes
use prefixed keys like everything else, and a pass is enabled by being within `nPasses`.

Keys are case-insensitive like every `.milk` key. Pass blocks are ignored unless `nPasses` says
to run them, so adding them to a preset without the key changes nothing (`ShaderPassTest`
checks this byte for byte).

## What a pass sees

Every pass of a stage is the same kind of shader as the stage's own: an extra warp pass is a warp
shader, an extra composite pass is a composite shader. They draw the same mesh with the same
inputs: `uv`, `uv_orig`, `rad`, `ang`, `sampler_main`, the blur textures, noise and user textures,
`q1`..`q32`, `time`, the audio values and so on. Two names are new:

| Name | Meaning |
|---|---|
| `sampler_lastpass` (also `iLastPassTex`) | The previous pass's output. In the first pass, the same image as `sampler_main`. Sample it with the same uv you would use for `sampler_main`: `tex2D(sampler_lastpass, uv_orig)` reads the pixel the previous pass wrote at this position. `GetLastPass(uv)` is `tex2D(sampler_lastpass, uv).xyz`. `texsize_lastpass` is its size. The usual prefixes work (`sampler_pc_lastpass` for nearest-neighbour, clamped). |
| `iPass` | This shader's pass number: 0 for the first pass, N - 1 for the stage's own shader. A float. |

A pass writes `ret`, as any preset shader does. Only the stage's own shader writes the frame: the
warp shader's output is what the next frame warps, the composite shader's is what is shown. An
extra pass's output exists only for the shaders after it, and only during this frame.

So a warp pass is a place to compute something from the feedback image (an edge map, a
displacement field, a blurred or recoloured copy) that the warp shader then combines with
`sampler_main`. A composite pass can do the same for the final image: a bloom pass that thresholds
the frame, then the composite shader that adds it back.

## Rules and limits

- **At most 3 shaders per stage** (`PresetState::MaxShaderPasses`). `nPasses` outside 1..3 fails
  the load, as does a declared pass with no code, or passes for a stage without a shader of its
  own. The host sees the usual load failure (`projectm_set_preset_switch_failed_event_callback`,
  `pmOnPresetSwitchFailed` in the browser), the previous preset keeps running, and no render
  target is created: background preparation refuses the preset before the render thread touches it.
- **A pass that fails to compile takes its stage with it**, as a failing warp or composite shader
  always has: a failed warp pass puts the preset on the default warp, a failed composite pass on
  the default composite shader, without extra passes. The preset still loads.
- **The stage's own shader must sample `sampler_lastpass`.** If it does not, the passes would
  draw for nothing, so they are skipped (with a warning in the log).
- **Cost**: each pass is one more full-screen draw of the stage's mesh, at the preset's resolution.
  A stage with passes allocates two render targets of the preset framebuffer's format the first
  time it draws, and frees them with the preset. Presets without passes pay nothing.
- **Not in the transpile cache.** The host's transpiled-GLSL cache keeps one shader per preset and
  stage; extra passes are transpiled on every load, and only on the render thread (background
  preparation transpiles the stage shaders ahead as before).
- No per-pass resolution, blend mode, or multiple render targets (WebGL 2 has no MRT we could
  rely on, and ping-ponging two targets is enough for three passes). No `iPassTime`: a pass runs
  in the same frame as the others, so `time` is the same for all of them.

## How it works

`PresetState::ReadShaderPasses()` reads the keys. `ShaderPassChain`
(`src/libprojectM/MilkdropPreset/ShaderPassChain.*`) holds a stage's extra passes, each a
`MilkdropShader` like the stage's own, and two render targets. Pass K draws into target K % 2 and
samples the other, so no pass reads what it writes. `PerPixelMesh` (warp) and `FinalComposite`
(composite) run the chain right before their own shader and hand it the last pass's texture.

Pass output has to be in the orientation `sampler_main` has, or `tex2D(sampler_lastpass, uv)`
would read it upside down: preset uv has v = 0 at the top, and the main texture is pre-flipped to
match. An extra pass therefore renders Y-flipped: a warp pass with the flipped projection matrix,
a composite pass with a copy of the composite vertex shader that negates y. The stage shaders are
untouched, which is why presets without passes render exactly as before.

`iPass` is `_c17.w`, which was unused (`_c17.xyz` are `pm_beat_index`, `pm_section`,
`pm_section_change`); it stays 0 for every shader of a preset without passes.

## Tests and fixtures

- `presets/tests/310-shaderpass-two-pass-warp.milk`: a warp pass draws a gradient, the warp
  shader shows it. Checks orientation and `iPass`.
- `presets/tests/311-shaderpass-three-pass-comp.milk`: three composite shaders whose result is
  one flat colour only if all three ran in order with the right `iPass`.
- `tests/libprojectM/ShaderPassTest.cpp` reads both back on a GL context, on the direct and the
  background-prepared load path, and covers the refusals and the leak check.
- `PresetCompat` declares and transpiles every pass of every preset in its corpora, so a preset
  with a broken pass fails there rather than at runtime.
- Both fixtures are in the WASM golden set (`tests/wasm-smoke/golden/manifest.json`) and the
  Emscripten smoke loads them.
