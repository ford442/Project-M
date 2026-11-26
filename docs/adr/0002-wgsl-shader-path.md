# ADR 0002: The WGSL shader path of the WebGPU backend

- **Status:** accepted. Phase C (this ADR's decision) is implemented: the generator, the
  `PresetCompatWgsl` corpus mode, naga validation and the Tint/WebGL parity harness, all in CI
  (`wgsl_corpus.yml`). Phases D–F (`WgpuDevice`, compute per-pixel, the host switch) are not
  built; their constraints from this phase are at the end.
- **Date:** 2026-11-26
- **Scope:** `vendor/hlslparser/src/WGSLGenerator.{h,cpp}`, `ShaderTranspiler::TranspileToWgsl()`,
  the `ENABLE_WGSL_EMIT` option, `tests/libprojectM/WgslGeneratorTest.cpp`,
  `PresetCompatWgsl` in `tests/libprojectM/PresetCompatTest.cpp`, `scripts/check_wgsl_corpus.sh`,
  `tests/webgpu/wgsl_parity.mjs`, `.github/workflows/wgsl_corpus.yml`
- **Supersedes:** the Phase 2 spike section of [`GPU_PERPIXEL_EVAL.md`](../GPU_PERPIXEL_EVAL.md),
  which chose the same option but built nothing.

## Context

Preset warp and composite shaders are HLSL in Direct3D 9's dialect. The vendored hlslparser
parses them into an `HLSLTree`, and `GLSLGenerator` prints GLSL 3.30 or ESSL 3.00 from that tree.
WebGPU accepts only WGSL. The render device seam is now WebGPU-shaped (pipelines, std140 uniform
buffers, bind groups, render passes, a render graph: [`RENDER_DEVICE.md`](../RENDER_DEVICE.md)
B1.1–B2), so the shader language is the remaining blocker for a second backend.

The GLSL generator encodes Milkdrop behavior that presets depend on, and a WGSL path has to keep
all of it, or a preset looks different on WebGPU:

- DX9's multiply, where `0 * x` is 0 even for an infinite or NaN `x` (`Flag_AlternateNanPropagation`);
- `abs()` around the argument of `sqrt`, `log`, `log2`, `log10`, `rsqrt` and the base of `pow`
  (DX9 takes the absolute value; projectM issue #724), and `pow(x, 1)` is `x` even for `x < 0`;
- shader model 3's `acos`/`asin`, defined beyond [-1, 1];
- float `%` and `fmod()` as GLSL's floor-based `mod()`;
- HLSL's matrix model: `floatRxC`, row-major constructors, `m[i]` as row *i*, `_m01` element swizzles;
- implicit vector truncation and zero padding, scalar swizzles (`x.xxx`), uniform writes through a
  local copy (`HLSLTree::ReplaceUniformsAssignments()`).

The issue asked for an IR stage after hlslparser and for reflection (bindings, uniform layout)
from that IR, not from a regex.

## Options

| Option | Shipped size (measured 2026-11-26) | Correctness | Reflection |
|---|---|---|---|
| **A. Tint (via Dawn) in the runtime** | Not built here. Tint reads WGSL and SPIR-V, not GLSL, so our GLSL would first need glslang (GLSL→SPIR-V) in the bundle too: two compilers, several MB, on the preset-switch path. | Translates the GLSL generator's output, so it inherits its semantics; but it is a second compiler stack behind ours, and a translation failure is in C++ we do not own. | From SPIR-V, after the fact. |
| **B. naga in the runtime** (`glsl-in` + `wgsl-out`) | **851 KB** wasm32 (`opt-level = "z"`, LTO, stripped), **261 KB** gzipped: a probe crate converting one GLSL fragment shader (`naga 26`). Over the 500 KB ceiling `GPU_PERPIXEL_EVAL.md` set for this option. | Same as A, with naga's GLSL front end, which is less complete than glslang's. | naga's module, after the fact. |
| **C. Our own WGSL emitter from `HLSLTree`** | **109 KB** text at `-Os` (182 KB at `-O2`), x86-64, against 35 KB for `GLSLGenerator`; 0 in today's WebGL 2 bundle (`ENABLE_WGSL_EMIT` is off for Emscripten). | Walks the same tree as the GLSL generator and keeps its quirks by construction; every rule says what GLSL rule it mirrors. | Directly from the tree: bindings and layouts are what the generator emitted. |

## Decision

**C: a `WGSLGenerator` next to `GLSLGenerator` in `vendor/hlslparser`.** naga is used, but only
in CI as a validator (option C of the spike); Chromium's Tint is the second validator and the
parity reference. Neither is linked into anything.

### 1. Where it runs

- `cmake -DENABLE_WGSL_EMIT=ON` (default on everywhere except Emscripten) adds
  `WGSLGenerator.cpp` to `hlslparser` and defines `PROJECTM_WGSL_EMIT`. A future WebGPU
  Emscripten flavor turns it on; the WebGL 2 bundle stays unchanged.
- `ShaderTranspiler::TranspileToWgsl()` takes exactly the inputs of `TranspileToGlsl()` and
  shares its preprocessing, declaration rewriting and parse (`ParsePresetShader()`), so a shader
  means the same thing on both paths and only the printer differs. It returns the WGSL and a
  `WGSLGenerator::Reflection`.
- Fragment shaders only. The built-in GLSL shaders (warp/composite vertex shaders, blur, copy,
  transitions, sprites: about 40 files) are authored in GLSL and get hand-written WGSL twins in
  Phase D, as the spike planned.

### 2. The module the generator writes

- `diagnostic(off, derivative_uniformity);` Preset code samples textures inside branches on
  computed values; GLSL accepts that and WGSL rejects it unless the diagnostic is off.
- **Bind group 0, uniform buffers.** Each `cbuffer` is a `var<uniform>` struct, in source order.
  `_milkdrop_frame` is binding 0 and has the same layout as the std140 block the GL path binds
  (`MilkdropFrameUniforms`): every member is a vec4 or a `float4x3`, which is `mat3x4f`, three
  vec4 columns, as std140's `mat3x4`. `WgslGenerator.FrameBlockLayoutMatchesMilkdropFrameUniforms`
  checks every offset against `offsetof()`. Plain uniforms (`texsize_*`, a preset's own
  `uniform float4 foo;`) are members of one more block, `pmw_globals`, at the next binding.
  Layouts follow WGSL's uniform-address-space rules (vec3 aligns to 16, a matrix is C columns of
  vecR); arrays and bools in uniform buffers are refused.
- **Bind group 1, textures.** Each HLSL `sampler2D`/`sampler3D` becomes a texture and a
  sampler, `<name>_tex` at binding 2k and `<name>_smp` at 2k+1, in declaration order. Cube,
  shadow, MS and array samplers are refused (no preset uses them).
- **Stage interface.** Inputs `TEXCOORDn` at location n, `COLORn` at 8 + n, `SV_Position`/`VPOS`
  as `@builtin(position)`. Outputs `COLORn`/`SV_Targetn` at location n (the warp shader writes
  the image to 0 and the motion-vector UVs to 1), `SV_Depth` as `@builtin(frag_depth)`, clamped
  as the GLSL generator does. The entry point is `fs_main`; the preset's `PS` stays a function
  that it calls with pointers for the outputs.
- **Reflection** lists all of the above: each binding's group, number, kind, WGSL name and HLSL
  source name, each uniform block's size and member offsets, and the stage variables. It is what
  Phase D builds bind group layouts from, and what the parity harness uses to feed both APIs.

### 3. Semantics kept from the GLSL path

Each of the quirks under Context is implemented the same way, most as small WGSL functions the
module carries (`pmw_mul_*`, `pmw_mod_*`, `pmw_acos_*`, `pmw_<matrix>_from_*`, `pmw_row_*`). One
deliberate bug-for-bug match: **float literals have six significant digits**, because the GLSL
generator prints them through an `ostream` at its default precision (`String_FormatFloat()`), so
`43758.5453` is `43758.5` on GL today. Printing the exact value made the two `frac(sin(x) *
43758.5453)` hash presets of `presets/custom` differ on 1.5% and 3.5% of their pixels. Fixing it
changes GL's output, so it is a separate change that fixes both printers and updates the golden
images (follow-up below).

### 4. What WGSL needs that GLSL did not

- Assignment and `++` are statements only; an assignment inside an expression is refused.
  A store to a multi-component swizzle (`ret.xy = ...`, `uv.xy *= 2`) becomes a temporary and
  per-component stores. Chains of swizzles fold first: the header's `uv` is `_uv.xy`, so
  `uv.y = ...` is `_uv.xy.y = ...`, which is stored as `_uv.y`.
- Parameters are immutable: each value parameter is copied into a variable of its own name.
  `out`/`inout` parameters are `ptr<function, T>`.
- No `?:`: `select()`, which evaluates both sides; WGSL expressions have no side effects, so
  nothing changes.
- No overloading: the second user function `foo` with other parameter types is `foo_1`.
- WGSL keywords, reserved words (`target`, `filter`, `smooth`, `set`, `mod`, ...) and predeclared
  names (`step`, `mix`, `vec3f`, ...) are renamed `pmw_u_<name>`; names starting `__` or `pmw_` too.
- A function with a return type gets a trailing zero-value return, since HLSL lets a path fall
  off the end.
- **Shader-creation-time constant evaluation.** WGSL evaluates const-expressions when the module
  is created and rejects it for `log(0.0)`, `1.0 / 0.0`, `inverseSqrt(0.0)`, `normalize(vec2f(0))`,
  `clamp(x, 0.1, 0.0)` or `smoothstep(0.5, 0.5, x)`; GLSL compiles all of them and returns inf,
  NaN or its own definition at run time. Two presets of `presets/weeks` hit the `clamp` case in
  Tint (naga accepted them). `clamp` and `smoothstep` are emitted as GLSL defines them
  (`min(max(x, lo), hi)`, the Hermite formula); a constant divisor or a constant argument of a
  domain-checked builtin goes through an identity function (`pmw_runtime_*`), which makes it a
  runtime value as on GL.
- HLSL lets `normalize()` and `dot()` take scalars; WGSL does not (`x / abs(x)`, `a * b`).
- `float4 a[2] = { 1, 2, 3, 4, 5, 6, 7, 8 };` fills the elements from the flat list; the GLSL
  generator emits invalid GLSL for it, so such a preset renders on WebGPU and not on GL.

### 5. Y convention for Phase D

The WebGPU backend negates clip-space y in every vertex stage. Row 0 of each render target is
then GL's bottom row, so texture memory, `@builtin(position)` and `dpdy()` agree with GL, and the
generator does not need to know. The parity harness renders this way and compares the two images
row for row, without flipping either.

### 6. Verification and the tolerance budget

| Check | Where | Result on 2026-11-26 |
|---|---|---|
| Transpile: every preset whose shaders transpile to GLSL transpiles to WGSL | `PresetCompatWgsl.CorporaTranspileExceptTheLedger` (ctest `PresetCompat`) | tests 8/8, custom 29/29, weeks 404/404 presets with shaders (47, 35 and 426 presets; the rest have no shader, or fail GLSL too) |
| Validate: naga accepts every module | `scripts/check_wgsl_corpus.sh` (naga 30.0.2) | 863/863 modules |
| Tint accepts the module and a render pipeline builds from the reflection | `tests/webgpu/wgsl_parity.mjs` (Chromium 158, SwiftShader adapter) | tests + custom: 70/70 modules |
| Parity: the WGSL on WebGPU against its GLSL ES twin on WebGL 2, same uniforms, textures, samplers and varyings, 64×64 | same | tests + custom: **101/101 render-target outputs bit-identical** (max channel delta 0) |

**Tolerance budget:** a module is within tolerance when at most 1% of its pixels differ by more
than 8/255 in any channel (`TOLERANCE` in `wgsl_parity.mjs`). It is not zero because on real GPUs
the two APIs reach the driver through different compilers (ANGLE vs Tint/Dawn), which may
contract multiply-adds or choose other transcendental approximations differently; on SwiftShader
both end in the same backend and agree exactly. Shaders that hash a coordinate
(`frac(sin(x) * 43758.5)`) magnify any such difference to a different noise value, so they are
where a GPU run will show the budget's limits first.

The issue's acceptance criterion of ≥ 95% of `presets/custom` rendering within tolerance is met
at the shader level: 29 of the 29 presets with shaders (100%). The other six use the built-in
shaders, which have no WGSL yet. The whole-frame version of the check (warp mesh, blur chain,
composite, feedback over many frames) needs `WgpuDevice` and is part of Phase D's acceptance.
`presets/weeks` runs in CI too, but only reports: some of its shaders take minutes on a software
rasterizer and are counted as timeouts, not failures.

The three checks share `tests/libprojectM/data/PresetCompat/wgsl_known_failures.txt`
(`transpile`/`validate`/`parity` lines), which only shrinks. It is empty.

## Consequences

- A change to the GLSL generator's semantics now needs the same change in `WGSLGenerator.cpp`;
  the parity harness shows a mismatch as a pixel diff on the corpus.
- Preset input reaches one more code path. `fuzz_hlsl_transpile` and `fuzz_shader_passes` run
  every shader that transpiles to GLSL through the WGSL generator as well.
- The WebGL 2 bundle does not change. A WebGPU flavor would carry the generator (about 110 KB
  before compression); the spike's budget for that flavor is 30% over today's bundle.

### Follow-ups

1. Print float literals exactly in both generators (nine significant digits), with the golden
   images updated in the same change.
2. Phase D, `WgpuDevice` (`Renderer/Device/Wgpu/`, `ENABLE_WEBGPU`): emdawnwebgpu
   (`--use-port=emdawnwebgpu`) in the browser, Dawn natively; bind group layouts from the
   reflection; the pipeline cache keyed by `Device::Hash(PipelineDesc)`; hand-written WGSL twins
   of the built-in shaders; clip-space y negated (section 5); the whole-frame pixel diff over
   `presets/tests` + `presets/custom` with this ADR's budget.
3. Phase E: a WGSL printer for `PerPixelGlslLowering`'s plan, writing the warp mesh from a
   compute shader.
4. Phase F: `?gpu=webgpu|webgl` with auto-detect, device-lost replay, GPU timestamps
   (`timestamp-query`) in the perf HUD. WebGL stays the default until the Phase D parity holds.
