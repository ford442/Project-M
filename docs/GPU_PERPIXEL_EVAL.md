# GPU per-pixel eval and the WGSL path (#227)

Living design for GitHub issue
[#227 — GPU per-pixel mesh + HLSL→WGSL path toward a WebGPU backend](https://github.com/ford442/Project-M/issues/227).
Companion to [`GRAPHICS_PERF_RECOVERY_PLAN.md`](GRAPHICS_PERF_RECOVERY_PLAN.md) §B
(the WebGPU deferral from #179) and [`PERFORMANCE.md`](PERFORMANCE.md)
(mesh / OpenMP / `perPixelEvalMs`).

**Status (2026-09-18): Phase 1 shipped.** The per-pixel equations are compiled to
GLSL and evaluated in the warp vertex shader, with the CPU evaluator kept as the
fallback for everything the compiler refuses. Phases 2 (WGSL emitter) and 3
(WebGPU renderer) remain design only — **no compiler or renderer code for those.**

The #224 gate this document was written behind has opened: `FULL_ES3=0` landed on
2026-09-17 with all 26 goldens byte-identical and the Y-inverted
`glBlitFramebuffer` proven to be a direct passthrough, so no GL call still needs
the emulation layer (`PERFORMANCE.md`, "Toolchain and flag verification").

What Phase 1 measures, in this tree, today:

| | |
|---|---|
| Presets with `per_pixel_*` code across `presets/tests`, `custom_milk_fixed` and `weeks_presets` | 241 of 497 |
| Compiled to GLSL (`perPixelEval=gpu`) | **186** |
| Kept on the CPU, each with a recorded reason | 55 |
| Presets from the top of `PRESET_WORKLIST.md` now on the GPU path | **9** (#227 asked for 5) |

Frame times are **not** measured here: the authoring environment has no GPU, so
every number above comes from llvmpipe. `?benchmark=1` on a real device is still
owed, and is the remaining half of acceptance criterion 1.

A fully-tuned WebGL2 Milkdrop is still the **current** product — Phase 1 is a
WebGL2 change and needs no new GPU API. Phases 2 and 3 are what later looks like
if we outgrow it.

---

## Why this exists

`PerPixelMesh::CalculateMesh` (`src/libprojectM/MilkdropPreset/PerPixelMesh.cpp`)
runs Milkdrop `per_pixel_*` equations on every warp-mesh vertex every frame via
`projectm-eval`. At the default 80×60 grid that is **4941 vertices**. OpenMP
(`#219` / `#220`, `kmp_set_blocktime(0)`) made the CPU path audio-safe; governor
v2 (#178) steps the mesh down when `perPixelEvalMs` blows the frame. That is
still the governor's first lever, and it is why 44 `weeks_presets` remain
`heavy` in [`PRESET_WORKLIST.md`](PRESET_WORKLIST.md).

[#170](https://github.com/ford442/Project-M/issues/170) moves heavy presets to
the GPU **by rewriting them** (hand-port `per_pixel_*` into `shader_body`).
This issue moves them **by compiling them**. The two are complementary: #170
ships looks now; #227 is the engine so the next 400 presets do not need a
human.

[#179](https://github.com/ford442/Project-M/issues/179) already deferred
WebGPU for the right reason: vendored `hlslparser` emits GLSL only
(`Version` enum 110…300_ES, no WGSL/SPIR-V). Building a WebGPU backend on
GLSL-via-Tint would freeze the wrong IR. This issue is the missing compiler
plus one GPU-eval prototype; the backend comes last.

---

## Constraints (do not ignore)

- Runtime HLSL is **Milkdrop's dialect**, not DX9/12: `tex2D`, `GetBlur1..3`,
  `uv`/`rad`/`ang`, `q1..q32`, `bass`/`mid`/`treb`, `time`, `frame`.
  `ShaderTranspiler.cpp` wraps `shader_body` in a fake `PS(...)` entry and
  `PresetShaderHeaderGlsl330.inc` supplies the builtins. A new backend must
  parse **that**, not "HLSL."
- Transpile happens **at preset load, in WASM**. A 15 MB DXC wasm is a
  non-starter next to a ~2.6 MB `projectm-v.037-thread.wasm`.
- Per-pixel **equations** are `projectm-eval`, not HLSL. GPU-moving them is
  either (a) compiling eval IR to GLSL/WGSL, or (b) keeping eval on CPU and
  only moving `shader_body`. (b) is #170. (a) is Phase 1 of this issue.
- OpenMP + `kmp_set_blocktime(0)` made the CPU path audio-safe. A GPU path
  must not reintroduce a 4-thread spin wait "just in case."
- `projectm-eval` nodes identify operations **only by function pointer**
  (`prjm_eval_exptreenode.func` → `prjm_eval_func_sin`, etc.). There is no
  opcode enum. A printer must either compare against known `prjm_eval_func_*`
  addresses or add a kind field. The public C API (`projectm-eval.h`) does
  not expose the tree; `projectm_eval_code` is an opaque `prjm_eval_program_t`.

---

## Phased plan (each phase shippable on WebGL2)

| Phase | Ships on | New GPU API? | Closes |
|-------|----------|--------------|--------|
| **1** Eval IR → GLSL vertex displacement | WebGL2 | No | **Landed.** Keep #227 open as the epic |
| **2** `WgslGenerator` next to `GLSLGenerator` | GLSL still ships | No | WGSL corpus test |
| **3** `RendererWgpu` / `ENABLE_WEBGPU` | Native wgpu + emdawnwebgpu | Yes | Only after Phase 2 is green |

Do **not** merge WebGPU code (Phase 3) until Phase 2's WGSL corpus test is green.

---

## Phase 1 — Eval IR → GLSL vertex displacement (landed)

This phase **alone** is the performance win. It does not need WebGPU.

### What the CPU does today

`PerPixelMesh::Draw` is three steps:

1. `InitializeMesh` — static grid: NDC `pos`, `radius`, `angle`. Rebuilt only
   when mesh or viewport size changes. Already OpenMP-parallel.
2. `CalculateMesh` — per vertex, every frame:
   - Seed `x`/`y`/`rad`/`ang` from the static grid (`x`/`y` in 0..1, `ang`
     negated vs. the attribute).
   - Seed `zoom`/`zoomexp`/`rot`/`warp`/`cx`/`cy`/`dx`/`dy`/`sx`/`sy` from
     **this frame's** per-frame values.
   - `ExecutePerPixelCode()` (skipped when the preset has no `per_pixel_*`).
   - Write the ten transform channels into stream vertex attributes
     (`transforms`, `warp_center`, `warp_distance`, `stretch`).
3. `WarpedBlit` — bind default or custom warp program, draw the mesh.
   `PresetWarpVertexShaderGlsl330.vert` consumes those attributes and
   produces `frag_TEXCOORD0` (warped UV). The fragment shader is a sample
   of `main` (plus decay), or the preset's custom warp `shader_body`.

The hot loop is step 2. Step 3 is already GPU. Phase 1 replaces step 2 with
a generated GLSL **vertex** snippet that writes the same ten channels,
then falls into the existing zoom/stretch/warp-sine/rotate/translate math
in `PresetWarpVertexShaderGlsl330.vert`.

When there is **no** `per_pixel_*` code, step 2 already skips eval and
broadcasts per-frame constants. A GPU path is optional there (one uniform
vs. 4941 attribute writes); do it only if the attribute upload shows up in
`perPixelEvalMs`.

### Where the new code lives

| Piece | Location |
|-------|----------|
| AST walk, feature detect, GLSL printer | `src/libprojectM/MilkdropPreset/PerPixelGlslLowering.{hpp,cpp}` |
| Lowering at preset load | `MilkdropPreset::LowerPerPixelCodeToGlsl()`, straight after `CompilePerPixelCode` |
| Result carried to the renderer | `PresetState::perPixelGpuGlsl` / `perPixelGpuReason` / `perPixelGpuUniforms` / `perPixelGpuQVectors` |
| Generated VS injection | `PerPixelGlslLowering::ComposeWarpVertexShader()` fills two marker lines in `PresetWarpVertexShaderGlsl330.vert`; the shader-cache key hashes the generated code |
| Skipping the CPU loop, uploading the uniforms | `PerPixelMesh::CalculateMesh` / `SetPerPixelUniforms` |
| HUD / timings | `projectm_perf_frame_timings` + `js_perf_report_frame` + `html/projectm-perf.js` |

Do **not** put the printer in `hlslparser`. Per-pixel equations are not HLSL.

**Why not in `vendor/projectm-eval/`,** which earlier drafts of this document assumed:
it is a submodule of the upstream evaluator, so code added there cannot be carried by
this repository. More importantly, the printer needs `CompilerTypes.h` and
`TreeFunctions.h` to walk the tree at all, and an installed projectM-Eval ships only
`api/projectm-eval.h`. CMake detects whether the vendored sources are in use and
defines `PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE`; without it the whole path compiles out,
`PerPixelGlslLowering::Available()` is false, and every preset uses the CPU evaluator
exactly as before. Growing a public tree-inspection API upstream would lift that
restriction, and is the clean long-term home.

### Uniforms and attributes on the GPU path

**Per-vertex:** `vertex_position` (location 0) and `rad_ang` (location 3), which the
CPU path already uploads and which only change on a resize. The generated function is
handed `x`, `y`, `rad` and `ang` derived from them exactly as `CalculateMesh` derives
them, including the negated angle. Locations 4–7 — the ten transform channels — are
simply not read on the GPU path, and nothing is written to them.

**Per-frame uniforms:** `u_pp_time`, `u_pp_fps`, `u_pp_frame`, `u_pp_progress`,
`u_pp_bass`, `u_pp_mid`, `u_pp_treb`, `u_pp_bass_att`, `u_pp_mid_att`,
`u_pp_treb_att`, `u_pp_meshx`, `u_pp_meshy`, `u_pp_pixelsx`, `u_pp_pixelsy`,
`u_pp_aspectx`, `u_pp_aspecty`, plus `u_pp_q[8]` (`q1..q32` packed as `vec4`s to stay
inside WebGL2's uniform limits) and the four seed uniforms `u_pp_seed_transforms`,
`u_pp_seed_center`, `u_pp_seed_distance` and `u_pp_seed_stretch`.

Only the uniforms the generated code actually reads are declared, and the lowering
reports which ones those are, so a preset that touches `bass` alone costs one upload
rather than fifty-eight. All of it is per frame, not per vertex.

**Outputs:** the same ten floats the CPU writes today, handed back through `inout`
parameters. The existing vertex shader body then runs unchanged.

### Lowering table (`projectm-eval` → GLSL 300 ES / GLSL 330)

Eval is scalar `double` (`PRJM_F_SIZE=8`). GLES 300 `highp float` is 32-bit. That is
an accepted, gated difference (see **Precision** below). Do not silently switch the
CPU evaluator to float to "match."

Several of these do not read the way the function name suggests. Everything below was
checked against `vendor/projectm-eval/projectm-eval/TreeFunctions.c` and is covered by
a differential test in `tests/libprojectM/PerPixelGlslLoweringTest.cpp`, which runs the
emitted GLSL on a real GL context and compares it against the evaluator.

**The two epsilons.** The evaluator has `close_factor` (1e-5) and `close_factor_low`
(1e-300 for the 64-bit build). Only `band`, `bor` and `sigmoid` use the large one. For
the small one there is nothing to emit: no 32-bit float holds a magnitude between
1e-300 and zero, so the faithful rendering is an exact comparison against zero, not a
chosen epsilon.

| Eval node (`prjm_eval_func_*`) | GLSL | Notes |
|--------------------------------|------|-------|
| `const`, `var` | literal / `float` local | Variables are resolved by walking the compile context's list; the tree stores only a pointer |
| `set` | `v = rhs` | The evaluator resolves the target reference first, then the right-hand side, then writes. Statement value is the assigned value |
| `add_op` … `pow_op` | `v = v OP rhs` | The evaluator reads `v` **after** the right-hand side has run. Emit in that order |
| `add` `sub` `mul` `neg` | `+ - * -` | |
| `div`, `div_op` | `(b == 0.0) ? 0.0 : a / b` | **The evaluator returns 0 on a zero divisor.** Not a bare `/` |
| `mod`, `mod_op` | `fa - fb*trunc(fa/fb)` on `trunc()`ed operands, 0 when the divisor truncates to 0 | **Integer C remainder, not floating `mod()`.** The evaluator casts both operands to `PRJM_EVAL_I` and takes `%`. GLSL ES leaves integer `%` and `/` undefined for negative operands, so it is rebuilt in floating point |
| `equal` `notequal` | `float(a == b)` / `float(a != b)` | The evaluator compares against `close_factor_low`; see above |
| `below` `above` `beloweq` `aboveeq` | `float(a < b)` etc. | Returns 0.0/1.0 floats, not bools |
| `bnot` | `float(a == 0.0)` | |
| `boolean_and_op` / `boolean_or_op` (`&&`, `||`) | `if` on the first operand, second emitted inside | The evaluator short-circuits these. Emitting a GLSL `&&` would be right for the value and wrong for any side effect in the second operand |
| `boolean_and_func` / `boolean_or_func` (`band` / `bor`) | `abs(a) > 1e-5 && abs(b) > 1e-5` | Two differences from `&&`: both arguments always run, **and** they use the large epsilon |
| `bitwise_and` `bitwise_or` (+ `_op`) | `float(int(a) & int(b))` | `(5&(x*10-0.5))` appears in the worklist. Exact only within 32 bits; the evaluator truncates to 64 |
| `sin` `cos` `tan` `atan` `exp` `floor` `ceil` `abs` `min` `max` | same | `int()` is an alias of `floor` in `TreeFunctions.c`, not a truncation |
| `sign` | `sign(x)` | GLSL `sign` returns 0 for 0; so does the evaluator. Exact match |
| `sqr` | `x*x` | |
| `sqrt` | `sqrt(abs(x))` | The evaluator is `sqrt(fabs(x))`, not bare `sqrt` |
| `log` / `log10` | `(x <= 0.0) ? 0.0 : log(x)` / `* 0.4342944819032518` | **Both** clamp non-positive inputs to 0. GLSL ES 3.00 has no `log10` |
| `asin` / `acos` | `(x < -1.0 \|\| x > 1.0) ? 0.0 : asin(x)` | Out of range returns **0**, not a clamp and not NaN |
| `atan2` | `atan(a, b)`, with a signed-zero branch | GLSL leaves `atan(0,0)` undefined; C `atan2` is defined and sign-aware (`atan2(-0,-0)` is `-pi`). The mesh's exact centre vertex has `rad == 0`, so this case is reachable — it was a real bug caught by the differential test |
| `pow`, `pow_op` | `prjm_pow()` helper | Four rules: zero base with a negative exponent is 0, `pow(0,0)` is 1, a **negative base with an integral exponent** keeps C's defined result (GLSL's `pow` does not), and NaN becomes 0 |
| `sigmoid` | `t = 1 + exp(-a*b); abs(t) > 1e-5 ? 1/t : 0` | Two arguments, and the large epsilon |
| `if` | `if (c != 0.0) { … } else { … }` writing a temp | Only the taken branch runs. A `mix()` lowering would execute both branches' assignments |
| `exec2` `exec3`, `execute_list` | statement sequence, value of the last | |
| `execute_loop` | `for` with a compile-time bound | With **zero** iterations the evaluator returns the loop-count value, not 0 |
| `execute_while` | **CPU fallback** | Unbounded |
| `rand` | **CPU fallback** | Milkdrop's Mersenne Twister. A GPU hash cannot match it |
| `invsqrt` | **CPU fallback** | **Not `inversesqrt()`.** The evaluator uses the fast inverse square root bit hack with the 64-bit magic constant `0x5fe6eb50c7b537a9` and one Newton step. GLSL's `inversesqrt` is a different (more accurate) function, and the 64-bit hack has no 32-bit equivalent |
| `mem` `freembuf` `memcpy` `memset` | **CPU fallback** | megabuf / gmegabuf |
| `reg00`..`reg99` | **CPU fallback** | Not in the context's variable list; shared between evaluation contexts |

#### Precision, and the two places it is not just rounding

The inputs are bit-identical on both paths: `x`, `y`, `rad` and `ang` are already
computed in 32-bit float on the CPU, and the shader derives them from the same vertex
attributes with the same operations in the same order. Only the evaluation differs,
double against float. Two consequences are worth naming rather than discovering later:

1. **Truncation boundaries.** `int()`, `mod` and the bitwise operators turn a
   last-bit difference into a whole-unit one. `((2 + 0.4) * 1.5 - 0.6) / 3` is
   `0.9999999999999999` in double and exactly `1.0` in float, so `int()` of it is 0 on
   the CPU and 1 on the GPU. Presets that step on `int()` or `equal()` of a continuous
   quantity therefore differ at whichever vertices sit on a step that frame.
2. **Feedback amplification.** The warp mesh samples the previous frame, so a preset is
   a feedback system and most are chaotic. On the step-function preset
   `390 threx no more warningsce amy-able.milk` the mean channel difference runs 0 at
   frame 1, 0.0004 at frame 2, 0.46 at frame 5, 4.1 at frame 15 and 10.8 at frame 40.
   None of that is a wiring fault, and the same divergence would appear between two
   different GPUs. **A long-sequence pixel comparison is not a valid equivalence test
   for this renderer**; `PerPixelGpuRenderTest` asserts at a short horizon and budgets
   the presets that still differ visibly there.

### Feature detect (per preset, at load)

`MilkdropPreset::LowerPerPixelCodeToGlsl()` walks the compiled program once after
`CompilePerPixelCode`. Every refusal carries a human-readable reason, which is what the
HUD and the logs report. The rules:

1. **Refuse an unlowerable function**: `mem` / `freembuf` / `memcpy` / `memset`,
   `execute_while`, `rand`, `invsqrt`, an `execute_loop` whose bound is not a constant
   or is above the GPU cap (64), or any `func` pointer the compiler does not know
   (forward-compat).
2. **Refuse an assignment whose target is not a plain variable** — an `if()` or
   `megabuf()` used as an l-value.
3. **Refuse `reg00`..`reg99`.** They live outside the evaluation context and are shared
   between contexts, so they are neither per-vertex nor uniform.
4. **Refuse a write to any variable that is not re-seeded per vertex.** `CalculateMesh`
   re-seeds only `x`/`y`/`rad`/`ang` and the ten transform channels; everything else
   (`q1`..`q32`, but equally `time`, `bass`, `progress`, `aspectx`, …) is loaded once
   per frame and **persists across vertices on the CPU**, so a write is a cross-vertex
   leak the GPU cannot reproduce. This generalises what earlier drafts of this document
   said about `q*` alone. Do not warn-and-allow; loosen later only with a golden A/B
   that shows the pixels match anyway.
5. **Refuse a preset-local read before it is definitely assigned.** In original Milkdrop
   (and in this tree's OpenMP pool) eval locals persist across vertices on the same
   context. Mashups use that as an IIR:

   ```
   thresh = above(bass_att,thresh)*2 + (1-above(bass_att,thresh))*((thresh-1.3)*0.96+1.3);
   dx_r   = equal(thresh,2)*0.015*sin(5*time) + (1-equal(thresh,2))*dx_r;
   ```

   A GPU vertex starts from zero. Detection is a linear walk in execution order, and an
   assignment inside an `if` branch, a loop body or a short-circuited operand does
   **not** count as definite. That conservative reading is what keeps the check sound.
6. **Accept** otherwise.

This is by far the biggest refusal class in practice, and it is why `sun fan phoets
newborns of satan.milk` (#1 on the worklist, 143 lines) is still on the CPU: it carries
`d`, and its siblings carry `thresh`, `sp`, `dy_mult`, `rd`. Across the whole tree, 55
presets are refused: 14 for `thresh` alone, 13 because their per-pixel block compiles to
an empty program, 5 for a `q1` write, 4 for `rand`, 3 for `megabuf`, and the rest for
other carry-state locals.

The HUD shows `perPixelEval=gpu` or `perPixelEval=cpu` from this classification.

### Semantic forks the printer must not paper over

| Topic | CPU today | GPU Phase 1 | Rule |
|-------|-----------|-------------|------|
| Carry-state locals (`thresh`, `dx_r`) | Persist on the eval context; OpenMP → persist **per thread** | Per-vertex zero | Fallback if read before definite assignment |
| Writes to any non-per-vertex variable (`q*`, but also `time`, `bass`, …) | Loaded once per frame, then persist across vertices | Re-seeded from a uniform every vertex | **CPU fallback on any such write** |
| `reg00`..`reg99` | Shared between evaluation contexts | No equivalent | Fallback |
| `rand()` | Milkdrop's Mersenne Twister | Would need a hash | Fallback |
| `invsqrt()` | 64-bit fast inverse square root, one Newton step | `inversesqrt()` is a different, more accurate function | Fallback |
| Precision | `double` | `highp float` | Allowed, but see **Precision** above: truncation flips whole units, and feedback amplifies |
| `if` as l-value | Eval returns a reference | No equivalent | Fallback |
| `if` with a side-effecting dead branch | Only the taken branch runs | An `if` statement writing a temp preserves that; `mix()` would not | Emit the statement form, never `mix()` |
| OpenMP | `kMinPerPixelMeshVerts=1000`, `kmp_set_blocktime(0)` | Not used on the GPU path | The CPU path is untouched; the pool is not spun "just in case" |

### HUD and `projectm_perf_frame_timings`

Today `per_pixel_eval_ms` is a CPU `steady_clock` around
`PerPixelMesh::Draw` (eval **and** the warp draw submit). That is the one
trustworthy per-stage bucket
([recovery-plan measurement section](GRAPHICS_PERF_RECOVERY_PLAN.md#measurement-what-the-hud-can-and-cannot-tell-you)).

On the GPU path:

- `per_pixel_eval_ms` stays where it is, but now covers only the uniform upload and
  the draw submit. It should drop sharply — there are no 4941 evaluations left in it.
- `projectm_perf_frame_timings::per_pixel_eval_path` (`0=cpu`, `1=gpu`) says which
  kind of number it is, and `js_perf_report_frame` passes it to `pmOnPerfFrame` as
  `perPixelEvalPath: 'gpu' | 'cpu'`.
- The HUD row reads `Per-pixel/warp [gpu]` or `[cpu]`. The `?benchmark=1` JSON records
  `perPixelEvalPath` for the run, or `'mixed'` if the preset changed under it, so two
  records cannot be compared by accident.
- Do **not** pretend this measures GPU vertex cost. `gpuMs`
  (`EXT_disjoint_timer_query_webgl2`) remains whole-frame. Ranking still
  uses A/B (`?perPixelEval=cpu` vs default) on `totalMs` / `gpuMs`.

### How Phase 1 is verified

Two test binaries, both headless, both in the normal `ctest` run.

**`PerPixelGlslLoweringTest`** — does the generated GLSL compute what the evaluator
computes? It does not inspect the emitted text; it compiles the generated function into
a real vertex shader, evaluates it over a batch of vertices with transform feedback, and
compares the ten channels against the CPU evaluator fed the same inputs. Cases cover
each operator and control-flow form, each refusal rule, and then sweep the whole preset
corpus: every preset either refuses with a reason or agrees numerically. One preset of
186 drifts past 1e-3 (`pow()` with an exponent in the tens, ill-conditioned in 32 bits
on any GPU); that count is budgeted so a less accurate translation shows up as a
regression rather than as a preset that looks slightly wrong.

**`PerPixelGpuRenderTest`** — is it wired into the frame correctly? Each preset is
rendered twice through the whole engine at a fixed seed and a fixed frame clock, once
with `PROJECTM_PER_PIXEL_EVAL=cpu` and once on the default path, and the framebuffers
are compared. `presets/tests/110-per_pixel.milk` is pixel-identical over 40 frames. Nine
worklist-heavy presets reach the GPU path; one of them (`390 threx`) differs visibly for
the step-function reason above, and that count is budgeted too.

**Still owed:** frame times. Both suites run on llvmpipe, which measures correctness and
nothing about speed. Acceptance criterion 1's second half — lower `per_pixel_eval_ms`
under `?benchmark=1` on a real GPU — needs a browser session. The benchmark JSON now
records `perPixelEvalPath` so the A/B cannot be run against the wrong baseline.

### Ablation

`?perPixelEval=cpu` (WASM) sets `PROJECTM_PER_PIXEL_EVAL=cpu`, which
`PerPixelGlslLowering::ForcedToCpu()` reads; the same environment variable works
natively and is what the render test uses to capture both paths. It is read once per
preset load, so it is a switch for an A/B run rather than a live toggle. There is no
`=gpu`: a preset the compiler refuses cannot be forced onto the GPU, and one it accepts
is already there.

---

## Phase 2 spike — hlslparser WGSL emitter vs naga vs stay GLSL

This is the decision #227 asked to write into
[`GRAPHICS_PERF_RECOVERY_PLAN.md`](GRAPHICS_PERF_RECOVERY_PLAN.md) §B.
Reached by reading the tree (same caveat as #175–#179: no GPU measurement
in the authoring environment). **No WebGPU code. No naga in the bundle.**

### What hlslparser actually is

`vendor/hlslparser/src/` is twelve files. The IR is `HLSLTree`
(`HLSLNodeType_*`, already a full statement/expression AST). The only
emitter is `GLSLGenerator` (~2.3k lines) targeting
`110/120/140/150/330/100_ES/300_ES`. Milkdrop-specific surface:

- Parser already knows `tex2D` / `tex2Dlod` / `tex2Dbias` / `tex2Dgrad`
  (`HLSLParser.cpp` intrinsic table).
- `ShaderTranspiler.cpp` rewrites `shader_body` into a `PS(...)` with
  `TEXCOORD0/1` and `COLOR0/1` (warp writes motion-vector UVs as MRT).
- `PresetShaderHeaderGlsl330.inc` `#define`s `GetBlur1..3`, `uv`, `rad`,
  `ang`, `q1..q32`, `tex2D` → `texture`, etc., **in GLSL**, after
  transpile. A WGSL emitter must either emit those macros as WGSL
  functions or run an equivalent header in WGSL.

There is no SPIR-V, no second generator, and no device abstraction behind
`Renderer::Framebuffer` / `Texture` / `Shader`.

### Options

| Option | Runtime cost | Correctness | When |
|--------|--------------|-------------|------|
| **A. `WgslGenerator` in hlslparser** (recommended for Phase 2) | ~0 in the shipped WebGL2 bundle if gated `ENABLE_WGSL_EMIT` / `ENABLE_WEBGPU`; desktop+CI always can compile it | Highest — walks the **same** `HLSLTree` Milkdrop already parsed; one dialect | After Phase 1, before any `RendererWgpu` |
| **B. naga / Tint / glslang in the WASM runtime** | Megabytes. Fights the 10 KB `FULL_ES3` diet. Second compiler on the preset-switch path the IDB GLSL cache is trying to keep short | Wrong dialect unless we still parse with hlslparser and only ask naga to consume GLSL/SPIR-V — a GLSL→WGSL sidecar, not a Milkdrop compiler | **Rejected** for the runtime unless a spike shows **<500 KB** **and** hlslparser cannot grow a WGSL emitter |
| **C. naga-cli in CI only** | Zero on users | Validates option A output (`naga foo.wgsl` / `naga foo.wgsl foo.spv`) | **Yes**, Phase 2 CI, pinned binary or `cargo install naga-cli` on the Emscripten job. `glslangValidator` stays for GLSL |
| **D. Stay GLSL forever** | Zero | Fine **until** we want WebGPU. Browsers do not ingest GLSL into WebGPU; Tint/naga would come back as option B | **Ship GLSL as the product** until Phase 2's corpus is green. Do not start Phase 3 on a GLSL-via-Tint hack (#179 B2.1) |
| **E. libniceshade / DXC-wasm** | DXC wasm is ~15 MB | Upstream #761; not Milkdrop | **Never by default** (issue decision table) |

### Decision

1. **Stay on GLSL 300 ES as the shipped target.** Phase 1 emits GLSL. The
   live product does not wait on WGSL.
2. **Phase 2 grows `WgslGenerator` next to `GLSLGenerator`**, walking
   `HLSLTree`. Subset: vertex + fragment, no geometry shaders, no FBOs,
   storage textures later. Bindings: explicit `@group/@binding` assigned
   by a small table in `MilkdropShader` (sampler_main, blur1..3, q
   uniforms) — do not invent a D3D register model.
3. **Validate with naga-cli in CI only.** Round-trip `presets/tests/`
   (the same corpus `PresetCompatTest.cpp` already transpiles HLSL→GLSL
   without a GL context). Fail the job on naga parse errors. Do not
   vendor naga/Tint/DXC into the runtime.
4. **Do not start WebGPU** (Phase 3) until that corpus is green.
5. Revisit option B only if `WgslGenerator` cannot express a Milkdrop
   construct that naga-of-GLSL can, **and** a size spike is <500 KB.

### Why not prototype one WebGPU pass now

Unchanged from #179 B3: a canvas holds one context type; a prototype that
does not share the Milkdrop frame graph measures triangle throughput, not
this application. Phase 1 on WebGL2 **does** share the frame graph (same
warp VS, same FBO ping-pong) and **does** answer the only question that
matters for FPS: can we delete 4941 CPU evals.

### Built-in GLSL corpus (Phase 2/3 tax)

40 `*Glsl330.frag/.vert/.inc` files (MilkdropPreset, Renderer transitions,
UserSprites) plus inline `#version 300 es` / `330` strings in
`CopyTexture.cpp`, `TransitionShaderManager.cpp`, `MilkdropSprite.cpp`.
A WebGPU backend needs WGSL twins **or** the Phase 2 emitter running on
HLSL sources we do not have for the built-ins (they are authored in GLSL).
Pragmatic path: **hand-port the small static set once** (warp/composite
headers, blur, copy, transitions) and **emit WGSL only for preset
`shader_body`**. Do not invent an HLSL original for every transition.
This is why Phase 3 is XL even after the emitter exists — see #179 B2.2
and B2.3 (the renderer is GL-shaped end to end).

---

## Phase 3 — WebGPU renderer (last)

Only after Phase 2 emits WGSL for warp + composite + blur + the
transition library:

- New `src/libprojectM/RendererWgpu/` (or `ENABLE_WEBGPU`) using **wgpu**
  (native) / **emscripten `--use-port=emdawnwebgpu`** (browser).
- Keep GLES; select at instance creation (mirrors upstream #1004).
- Dual-FBO compositor → a WebGPU render pass sampling two preset
  textures (architecture already in `WasmDualFbo.cpp`).
- Drop `FULL_ES3`, `GL_MAX_TEMP_BUFFER_SIZE`, and the GL emulation
  temp-buffer pool **on that build flavor**.
- Binary-size budget: WebGPU flavor may **not** exceed current glue+wasm
  by more than 30% without a written exception.
- Blur-as-compute (workgroup-shared separable taps) lives here, not in
  Phase 1. Phase 1's win is the CPU mesh.

Pthreads/OpenMP become less load-bearing because the hot loops left the
CPU. Do not delete the CPU eval path: unlowerable presets and native
SDL still need it.

---

## Gate: #224 leftovers — measured, gate lifted

Closed #224 landed the **contract** half (`WasmContextConfig` /
`set_context_config()`, MSAA default-off, host-driven FBO precision) and
deliberately did not flip `FULL_ES3=1 → 0`. The recorded blocker was
`CopyTexture::TryBlit()`: a Y-inverted `glBlitFramebuffer` every frame that flips a
same-size color attachment — the call most likely to differ between Emscripten's ES3
emulation and raw WebGL2.

**That measurement landed on 2026-09-17** (`PERFORMANCE.md`, "Toolchain and flag
verification"). `FULL_ES3=0` shipped: all 26 goldens byte-identical, the smoke
dual-FBO soft cut passing, and a pixel A/B over a blur3 + warp + composite preset and
a warp-without-composite preset, with default blit and with `?copyPath=shader`, at
frames 60 and 300 — 24 captures, 0 differing pixels at threshold 0. The blit turned out
to be a direct passthrough with or without emulation. There is no GL call that still
needs the emulation layer, and `GL_MAX_TEMP_BUFFER_SIZE` was removed with it.

That session had no GPU either, so it recorded no frame times and wrote no JSON under
`benchmark-results/`. The pixel evidence is what lifted the gate; the timing evidence
is the same browser session Phase 1 still owes.

---

## Libraries / tools

| Library | Role | When |
|---------|------|------|
| **projectm-eval** (existing) | Equation AST, walked in place from `PerPixelGlslLowering` | Phase 1, done |
| **hlslparser** (existing) | HLSL tree; add `WgslGenerator` | Phase 2 |
| **naga-cli** (CI only) | Validate WGSL | Phase 2 |
| **wgpu** + Dawn/emdawnwebgpu | WebGPU backend | Phase 3 |
| libniceshade / DXC-wasm / naga-in-runtime | Rejected unless hlslparser cannot grow a WGSL emitter and a spike shows <500 KB | Never by default |

---

## Out of scope (still)

- Hand-rewriting presets (#170), which remains the complementary route for the
  carry-state mashups this compiler refuses.
- Vendoring naga/Tint/DXC.
- `ENABLE_WEBGPU` CMake option, `RendererWgpu`, emdawnwebgpu.
- Changing OpenMP blocktime or pool size. The CPU path is untouched.
- Blur-as-compute: Phase 3.

## What Phase 1 did not do, and what would move it

- **Frame times.** The whole verification ran on llvmpipe. A `?benchmark=1` session on
  a real GPU, A/B'd against `?perPixelEval=cpu`, is the missing half of acceptance
  criterion 1.
- **The carry-state mashups.** 14 presets are refused for `thresh` alone, including the
  two heaviest in the tree. Lowering them needs either a documented golden update (GPU
  uses documented Milkdrop seeding, and the look changes) or a way to carry per-vertex
  state, which independent vertices do not have. Do not silently change their look to
  get a checkbox.
- **`rand()`, `invsqrt()`, `megabuf`.** Each is a deliberate refusal with a reason, not
  an oversight. A hash-based `rand` would not match the CPU and would fail goldens.
- **A public tree-inspection API upstream.** Until projectM-Eval exposes the expression
  tree, a build against an installed evaluator compiles the whole path out.
- **The 13 presets whose per-pixel block compiles to an empty program.** They fall back
  harmlessly, but they suggest the parser accepts something the tree drops; worth a look
  on its own.

---

## Related

- Closed: #179 (defer WebGPU), #112 (OpenMP/SIMD on eval — CPU), #178
  (governor v2), #220 (libomp spin), #224 (context config; `FULL_ES3=0`
  verified and landed 2026-09-17, which lifted this issue's gate).
- Open: #170 (heavy→GPU by rewriting presets), #227 (this epic).
- Upstream: #683 (Vulkan/Metal), #761 (libniceshade), #1004 (GL core vs
  ES at instance creation).
- Code: `PerPixelGlslLowering.{hpp,cpp}`, `PerPixelMesh`, `PerPixelContext`,
  `PresetWarpVertexShaderGlsl330.vert`,
  `vendor/projectm-eval/projectm-eval/TreeFunctions.c` (the semantics every
  lowering rule above is checked against),
  `vendor/hlslparser/src/GLSLGenerator.h`.
- Tests: `tests/libprojectM/PerPixelGlslLoweringTest.cpp` (CPU evaluator vs. the
  generated shader, run under transform feedback),
  `tests/libprojectM/PerPixelGpuRenderTest.cpp` (both paths rendered through the
  whole engine), `tests/web/projectm-perf.test.mjs` (HUD and benchmark readouts).
