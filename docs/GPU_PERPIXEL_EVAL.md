# GPU per-pixel eval and the WGSL path (#227, #261)

Living design for GitHub issues
[#227 — GPU per-pixel mesh + HLSL→WGSL path toward a WebGPU backend](https://github.com/ford442/Project-M/issues/227)
(Phase 1 and the design) and
[#261 — Phase 1.5 and Phase 2](https://github.com/ford442/Project-M/issues/261).
Companion to [`GRAPHICS_PERF_RECOVERY_PLAN.md`](GRAPHICS_PERF_RECOVERY_PLAN.md) §B
(the WebGPU deferral from #179) and [`PERFORMANCE.md`](PERFORMANCE.md)
(mesh / OpenMP / `perPixelEvalMs`).

**Status (2026-09-25): Phase 1.5 implemented.** The per-pixel equations are compiled to
GLSL and evaluated in the warp vertex shader. What the shader cannot reproduce exactly —
state carried from one vertex to the next, `rand()`, `megabuf` — runs in a small CPU
slice, in vertex order, that hands its values to the shader as vertex attributes
([Phase 1.5](#phase-15--cheaper-correct-at-the-edges-more-presets)). The CPU evaluator
stays authoritative for the 12 presets where that slice would not pay off. Phase 2 (WGSL
emitter) waits for #260's toolchain work to merge (PR #265 is still open), and Phase 3
(WebGPU renderer) after it; both remain design only — **no compiler or renderer code for
those.**

The #224 gate this document was written behind has opened: `FULL_ES3=0` landed on
2026-09-17 with all 26 goldens byte-identical and the Y-inverted
`glBlitFramebuffer` proven to be a direct passthrough, so no GL call still needs
the emulation layer (`PERFORMANCE.md`, "Toolchain and flag verification").

What the GPU path covers, in this tree, today:

| | Phase 1 | Phase 1.5 |
|---|---|---|
| Presets with `per_pixel_*` code across `presets/tests`, `custom_milk_fixed` and `weeks_presets` | 241 of 497 | 241 of 497 |
| Compiled to GLSL (`perPixelEval=gpu`) | 186 | **227** (7 of them with a CPU slice) |
| Kept on the CPU, each with a recorded reason | 53 | **12** |
| Rejected by the evaluator itself (CPU error path either way) | 2 | 2 |
| Presets from the top of `PRESET_WORKLIST.md` on the GPU path | 9 | **18** (#227 asked for 5) |

`PerPixelGlslLoweringTest.PresetCorpusAgreesOrRefusesWithAReason` prints these counts and
holds the 227 as a floor of 220 (#261's target).

Frame times are **not** measured here: the authoring environment has no GPU, so
every number above comes from llvmpipe. `?benchmark=1` on a real device is still
owed (#247), and is the remaining half of #227's acceptance criterion 1. The Phase 1.5
upload fix below should land before that measurement.

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
| **1.5** Upload/uniform/cache fixes, edge fixes, CPU slice for carried state and `rand()` | WebGL2 | No | #261, first half. **Implemented** |
| **2** `WgslGenerator` next to `GLSLGenerator` | GLSL still ships | No | #261, second half: WGSL corpus test. Waits for #260 (PR #265) |
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
| AST walk, statement classification, liveness, GLSL printer | `src/libprojectM/MilkdropPreset/PerPixelGlslLowering.{hpp,cpp}` |
| The CPU slice (Phase 1.5) | `PerPixelGlslLowering::CpuSlice`, run by `PerPixelMesh::RunCpuSlice()` |
| Lowering at preset load | `MilkdropPreset::LowerPerPixelCodeToGlsl()`, straight after `CompilePerPixelCode` |
| Result carried to the renderer | `PresetState::perPixelGpuGlsl` / `perPixelGpuReason` / `perPixelGpuUniforms` / `perPixelGpuQVectors` / `perPixelGpuCpuSlice` |
| Generated VS injection | `PerPixelGlslLowering::ComposeWarpVertexShader()` fills two marker lines in `PresetWarpVertexShaderGlsl330.vert`; the shader-cache key is a 64-bit FNV-1a of the generated code |
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

**Per-vertex:** `vertex_position` (location 0) and `rad_ang` (location 3), which only
change on a resize and are uploaded only then (Phase 1.5). The generated function is
handed `x`, `y`, `rad` and `ang` derived from them exactly as `CalculateMesh` derives
them, including the negated angle. Locations 4–7 — the ten transform channels on the CPU
path — are not read on the GPU path unless the preset has a CPU slice, which hands its
per-vertex values over in them instead (`a_pp_cpu0..3`, narrowest first: the vec2s at 5,
6 and 7, then the vec4 at 4, so a one- or two-value slice uploads 8 bytes per vertex).

**Per-frame uniforms:** `u_pp_time`, `u_pp_fps`, `u_pp_frame`, `u_pp_progress`,
`u_pp_bass`, `u_pp_mid`, `u_pp_treb`, `u_pp_bass_att`, `u_pp_mid_att`,
`u_pp_treb_att`, `u_pp_meshx`, `u_pp_meshy`, `u_pp_pixelsx`, `u_pp_pixelsy`,
`u_pp_aspectx`, `u_pp_aspecty`, plus `u_pp_q[8]` (`q1..q32` packed as `vec4`s to stay
inside WebGL2's uniform limits, uploaded with one `glUniform4fv` call) and the four seed
uniforms `u_pp_seed_transforms`, `u_pp_seed_center`, `u_pp_seed_distance` and
`u_pp_seed_stretch`.

Only the uniforms the generated code actually reads are declared, and the lowering
reports which ones those are, so a preset that touches `bass` alone costs one upload
rather than fifty-eight. All of it is per frame, not per vertex. `Shader` caches uniform
locations per program, so none of these is a `glGetUniformLocation` call after the first
frame.

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
| `execute_while` | **CPU slice** (statement) | Unbounded |
| `rand` | **CPU slice** (the call alone, when it runs whenever its statement does; otherwise the statement) | Milkdrop's Mersenne Twister, one generator shared by every evaluation context. A GPU hash cannot match it; the CPU draws the same numbers in the same order and hands them over |
| `invsqrt` | **CPU slice** (statement) | **Not `inversesqrt()`.** The evaluator uses the fast inverse square root bit hack with the 64-bit magic constant `0x5fe6eb50c7b537a9` and one Newton step. GLSL's `inversesqrt` is a different (more accurate) function, and the 64-bit hack has no 32-bit equivalent |
| `mem` `freembuf` `memcpy` `memset` | **CPU slice** (statement) | megabuf / gmegabuf |
| `reg00`..`reg99` | **CPU slice** (statement) | Not in the context's variable list; shared between evaluation contexts |
| a variable nothing in the program assigns | `0.0` for a preset local, the uniform for a builtin or `q1`..`q32` | Never written means the value never changes: a local keeps the zero it was registered with |
| a variable the program reads before assigning it on this vertex, and writes somewhere | **CPU slice** (statement) | The value is the previous vertex's (or, for `q*`, the per-frame value on the first vertex) |

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
   a feedback system and most are chaotic: any last-bit difference is amplified frame
   over frame, and the same divergence would appear between two different GPUs. **A
   long-sequence pixel comparison is not a valid equivalence test for this renderer**;
   `PerPixelGpuRenderTest` asserts at a short horizon and budgets the presets that still
   differ visibly there.

   Phase 1 quoted `390 threx no more warningsce amy-able.milk` as the example (mean
   channel difference 0 at frame 1, 0.0004 at frame 2, 0.46 at frame 5). Phase 1.5 found
   that two **CPU-path** renders of that preset diverge the same way (0.0002 at frame 2,
   0.29 at frame 4, 1.35 at frame 8), so that curve was never a per-pixel measurement.
   The render test now checks that a preset reproduces itself before comparing its two
   paths; see [How it is verified](#how-it-is-verified).

### Classification (per top-level statement, at load)

`MilkdropPreset::LowerPerPixelCodeToGlsl()` walks the compiled program once after
`CompilePerPixelCode`, one top-level statement at a time, in execution order. Phase 1
refused the whole preset on the first construct it could not translate; Phase 1.5
*hoists* that statement onto the CPU instead ([CPU slice](#coverage-the-cpu-slice)). A
statement is hoisted when it:

1. **Uses a function the shader cannot reproduce**: `mem` / `freembuf` / `memcpy` /
   `memset`, `execute_while`, `invsqrt`, an `execute_loop` whose bound is not a constant
   or is above the GPU cap (64), a `rand` whose call does not run every time the
   statement does, or any `func` pointer the compiler does not know (forward-compat).
2. **Assigns to something that is not a plain variable** — an `if()` or `megabuf()` used
   as an l-value.
3. **Touches `reg00`..`reg99`.** They live outside the evaluation context and are shared
   between contexts.
4. **Reads a variable before it is definitely assigned on this vertex, when the program
   writes that variable somewhere.** On the CPU such a value persists from the previous
   vertex on the same context (and, for `q1`..`q32`, `time`, `bass`, … starts each frame
   at the per-frame value). Mashups use that as an IIR:

   ```
   thresh = above(bass_att,thresh)*2 + (1-above(bass_att,thresh))*((thresh-1.3)*0.96+1.3);
   dx_r   = equal(thresh,2)*0.015*sin(5*time) + (1-equal(thresh,2))*dx_r;
   ```

   A GPU vertex has no previous vertex. Detection is a linear walk in execution order; an
   assignment inside an `if` branch, a loop body or a short-circuited operand does **not**
   count as definite unless both branches of an `if` make it (or the loop has a constant
   bound of at least one). That conservative reading is what keeps the check sound.

What Phase 1 refused but is simply translated now: a write to `q1`..`q32` or another
per-frame builtin that is assigned before any read on the vertex (a GPU local; Phase 1's
rule 4), a preset local that nothing assigns (always `0.0`), and a per-pixel block that is
only comments (the empty function: the seeds pass through, as they do on the CPU).

Then two backward liveness passes over the statements decide what each side needs: the
shader starts from the ten output channels, the CPU slice from whatever the *next* vertex's
slice reads (a fixpoint), plus every statement with an effect outside the variables
(`rand()` advancing the shared generator, memory and register writes), which always runs.
Statements neither side needs are dropped: several `thresh` presets compute a carried
filter and then overwrite everything it feeds, and lower with no slice at all.

A preset stays on the CPU when the slice would keep more than 25% of the per-vertex work
or hand more than 10 values per vertex to the shader; see
[the cost model](#the-cost-model-and-the-25-bar). Every refusal carries a human-readable
reason, which is what the HUD and the logs report.

The HUD shows `perPixelEval=gpu` or `perPixelEval=cpu` from this classification; a
preset with a CPU slice reports `gpu`.

### Semantic forks the printer must not paper over

| Topic | CPU today | GPU path | Rule |
|-------|-----------|----------|------|
| Carry-state locals (`thresh`, `dx_r`) | Persist on the eval context; OpenMP → persist **per thread** | The statements that carry them run in the CPU slice, in vertex order | Exact against single-threaded CPU order |
| Writes to a per-frame variable (`q*`, `time`, `bass`, …) | Loaded once per frame, then persist across vertices | A GPU local when assigned before every read; otherwise the CPU slice | Never "re-seed and hope" |
| `reg00`..`reg99` | Shared between evaluation contexts | The touching statements run in the CPU slice | Exact against single-threaded CPU order |
| `rand()` | Milkdrop's Mersenne Twister, shared by every context | Drawn by the CPU slice, same calls, same order | The number of draws per frame must match, or every later draw (shapes, waves) shifts |
| `invsqrt()` | 64-bit fast inverse square root, one Newton step | `inversesqrt()` is a different, more accurate function | CPU slice |
| Precision | `double` | `highp float` | Allowed, but see **Precision** above: truncation flips whole units, and feedback amplifies |
| `if` as l-value | Eval returns a reference | No equivalent | CPU slice |
| `if` with a side-effecting dead branch | Only the taken branch runs | An `if` statement writing a temp preserves that; `mix()` would not | Emit the statement form, never `mix()` |
| OpenMP | `kMinPerPixelMeshVerts=1000`, `kmp_set_blocktime(0)` | Not used on the GPU path; the CPU slice is one thread by construction | The CPU path is untouched; the pool is not spun "just in case" |

### HUD and `projectm_perf_frame_timings`

Today `per_pixel_eval_ms` is a CPU `steady_clock` around
`PerPixelMesh::Draw` (eval **and** the warp draw submit). That is the one
trustworthy per-stage bucket
([recovery-plan measurement section](GRAPHICS_PERF_RECOVERY_PLAN.md#measurement-what-the-hud-can-and-cannot-tell-you)).

On the GPU path:

- `per_pixel_eval_ms` stays where it is, but now covers only the uniform upload and
  the draw submit — plus, for a preset with a CPU slice, running the slice and uploading
  its values. It should drop sharply — there are no 4941 full evaluations left in it.
- `projectm_perf_frame_timings::per_pixel_eval_path` (`0=cpu`, `1=gpu`) says which
  kind of number it is, and `js_perf_report_frame` passes it to `pmOnPerfFrame` as
  `perPixelEvalPath: 'gpu' | 'cpu'`.
- The HUD row reads `Per-pixel/warp [gpu]` or `[cpu]`. The `?benchmark=1` JSON records
  `perPixelEvalPath` for the run, or `'mixed'` if the preset changed under it, so two
  records cannot be compared by accident.
- Do **not** pretend this measures GPU vertex cost. `gpuMs`
  (`EXT_disjoint_timer_query_webgl2`) remains whole-frame. Ranking still
  uses A/B (`?perPixelEval=cpu` vs default) on `totalMs` / `gpuMs`.

### How it is verified

Three test files, all headless, all in the normal `ctest` run. The GPU per-pixel ones need
a vendored projectM-eval (see `ENABLE_SYSTEM_PROJECTM_EVAL` in `AGENTS.md`); they skip
otherwise.

**`PerPixelGlslLoweringTest`** — does the GPU path compute what the evaluator computes?
It does not inspect the emitted text; it runs it. The CPU slice runs on the lowered
program's own context, vertex by vertex, as `PerPixelMesh::RunCpuSlice()` runs it; the
generated function is compiled into a real vertex shader and evaluated over a batch of
vertices with transform feedback, with the slice's values as its vertex attributes; the
ten channels are compared against the CPU evaluator fed the same inputs. Every case runs
two or three consecutive frames, so state carried from one frame into the next is
compared too. `rand()` is swapped, in both programs, for a stand-in with the evaluator's
scaling that the test can rewind (the real generator is process-wide and cannot be), and
the test also checks both sides drew the same number of values. Cases cover each operator
and control-flow form, each hoisting rule and each refusal, and then sweep the whole
preset corpus: every preset either refuses with a reason or agrees numerically, and at
least 220 must lower. One preset drifts past 1e-3 (`pow()` with an exponent in the tens,
ill-conditioned in 32 bits on any GPU); that count is budgeted so a less accurate
translation shows up as a regression rather than as a preset that looks slightly wrong.

The reference is **single-threaded** CPU evaluation. With `PRJM_ENABLE_OPENMP` the CPU
path gives each thread its own context and carries state per thread, so its output
depends on the thread count and has no exact counterpart; the render test renders its CPU
side on one thread for the same reason.

**`PerPixelGpuRenderTest`** — is it wired into the frame correctly? Each preset is
rendered twice through the whole engine at a fixed seed and a fixed frame clock, once
with `PROJECTM_PER_PIXEL_EVAL=cpu` and once on the default path, and the framebuffers
are compared. `presets/tests/110-per_pixel.milk` is pixel-identical over 40 frames, and
across a mid-run resize and mesh-size change (the static grid is only re-uploaded then).
A synthetic preset whose carried accumulator drives `dx`/`dy` over a visible border checks
`RunCpuSlice()` and the attribute layout end to end (0% differing pixels at 8 and 40
frames). Of the worklist-heavy presets, 18 reach the GPU path (5 of them with a CPU
slice); 14 are compared, and 4 are skipped because two CPU renders of them already differ
(`rand()` outside the per-pixel code, or the unexplained nondeterminism of `390 threx`
noted above). None differs visibly. The suite shares one GL context: with a fresh SDL
context per test, `projectm_create()` failed in about half the runs, before and
independently of Phase 1.5, because the GL resolver's strict context gate pins the backend
(EGL or GLX) of the first instance in the process.

**`ShaderCacheTest`** — the evictable cache bound and order, that eviction deletes a
program only once no preset holds it, the per-program uniform location cache (including
across a relink), the one-call `u_pp_q` upload, and the FNV-1a reference vectors.

**Still owed:** frame times. Every suite runs on llvmpipe, which measures correctness and
nothing about speed. #227's acceptance criterion 1 second half — lower `per_pixel_eval_ms`
under `?benchmark=1` on a real GPU — needs a browser session (#247). The benchmark JSON
records `perPixelEvalPath` so the A/B cannot be run against the wrong baseline.

### Ablation

`?perPixelEval=cpu` (WASM) sets `PROJECTM_PER_PIXEL_EVAL=cpu`, which
`PerPixelGlslLowering::ForcedToCpu()` reads; the same environment variable works
natively and is what the render test uses to capture both paths. It is read once per
preset load, so it is a switch for an A/B run rather than a live toggle. There is no
`=gpu`: a preset the compiler refuses cannot be forced onto the GPU, and one it accepts
is already there.

---

## Phase 1.5 — cheaper, correct at the edges, more presets

[#261](https://github.com/ford442/Project-M/issues/261). Everything here is WebGL2 and
C++; nothing depends on Phase 2.

### Perf on the GPU path

| | Before | After |
|---|---|---|
| Static grid (positions, radius/angle, indices) | Uploaded every frame on both paths — 100–400 KB of buffer traffic per frame at high mesh quality — and, worse, *recomputed* every frame: `InitializeMesh()` compared the viewport against `m_viewportWidth`/`m_viewportHeight` but never stored them (upstream has the same bug) | Recomputed and uploaded only when the viewport or mesh size changes (`m_staticDataDirty`). The CPU path still uploads its four transform buffers every frame; the GPU path uploads nothing per vertex unless it has a CPU slice |
| Uniform locations | `glGetUniformLocation` for every uniform every frame (about 30 names on the GPU path, a JavaScript call plus a string decode each on WebGL), and a `"u_pp_q[N]"` string built per vector | `Shader` caches each name's location (including -1 for inactive ones) until the next link; `u_pp_q` goes up in one `glUniform4fv(loc, 8, …)` |
| Per-preset warp programs | `milkdrop_default_warp_shader_gpu_<std::hash>` — 32 bits on wasm32, so a collision silently draws another preset's warp — and never evicted | 64-bit FNV-1a of the generated GLSL plus its length; `ShaderCache::InsertEvictable()` keeps the 32 most recently used. A preset holds its program strongly, so eviction never deletes one in use; an evicted program is `glDeleteProgram`med as soon as nothing holds it |

The `Shader` location cache applies to every program, including the composite and custom
warp shaders' dozens of per-frame uniforms, not just the per-pixel ones.

### Correctness at the edges

- **`q01` is not `q1`.** The evaluator registers exactly `q1`..`q32`; `q01` or `q001` is a
  separate preset local. The lowering used to `atoi` the digits and read uniform `q1`.
  Only the canonical spellings map to `u_pp_q` now.
- **Float literals.** A finite double outside the float range (`1e300`) used to be
  emitted as-is, which ANGLE rejects or turns into an infinity (and `0*inf` into NaN).
  Literals now go through the same `static_cast<float>` every CPU value reaching the
  shader does, with a finite value beyond the range clamped to ±`FLT_MAX`.
- **`loop()` bounds** are range-checked as doubles before any integer conversion; a bound
  of `1e300` or NaN used to hit `static_cast<long long>` first, which is undefined.
- **A compound assignment of a carried local** (`a += 0.001` with `a` never assigned
  earlier on the vertex) slipped past Phase 1's carry check, because the target of an
  assignment was never checked as a read; the GPU started it at 0 where the CPU
  accumulates. No preset in the tree did this; the check now covers it.
- `PresetWarpVertexShaderGlsl330.vert` names `ComposeWarpVertexShader()`, which is what
  fills its markers.

### Coverage: the CPU slice

The design above called carried state and `rand()` "cannot match on the GPU". That is
true of an independent GPU vertex, not of the program: the part that must run in vertex
order is usually a few statements, and the CPU can run just those and hand their results
to the shader.

Take the canonical mashup:

```
thresh = above(bass_att,thresh)*2+(1-above(bass_att,thresh))*((thresh-1.3)*0.96+1.3);
dx_r = equal(thresh,2)*0.015*sin(5*time)+(1-equal(thresh,2))*dx_r;
dy_r = equal(thresh,2)*0.015*sin(6*time)+(1-equal(thresh,2))*dy_r;
... fifty statements of warp math ...
dx = dx + dx_r;
```

The three recurrence statements are hoisted. For every vertex, in vertex order,
`PerPixelMesh::RunCpuSlice()` seeds `x`/`y`/`rad`/`ang` and the ten channels exactly as the
CPU loop does and runs those three statements with the evaluator's own nodes, on the same
context — so `thresh` carries from vertex to vertex and frame to frame exactly as it does on
the CPU. After each hoisted statement it reads the values the shader needs (`dx_r`, `dy_r`)
and writes them into the vertex attributes at locations 4–7; the shader runs everything
else and reads `a_pp_cpu0.x` where it would have computed `dx_r`. That is bit-exact with
single-threaded CPU evaluation up to the conversion to float every value on the GPU path
gets anyway.

`rand()` is narrower still: when a call runs every time its statement does and its
argument is side-effect free, the slice makes **just the call** — the same draws from the
same shared generator, in the same order — and the statement stays in the shader. So a
per-vertex noise term like `rot = rot + (rand(10)-5)*.001` costs one `rand()` per vertex on
the CPU. A call under an `if` or a short-circuit operand hoists its whole statement,
because only the CPU knows whether it runs; a statement whose `rand()` the slice would
otherwise also need whole is hoisted whole, so no number is drawn twice.

| Phase 1 refusal | Presets | Phase 1.5 |
|---|---|---|
| Empty per-pixel program (the block is only comments) | 13 | **13 on the GPU**: the empty function, seeds pass through |
| `q1` write | 5 | **5 on the GPU**: `q1` is assigned before every read, so it is a GPU local (a dead store as far as other vertices go) |
| Carried locals (`thresh` 14, others 14) | 28 | **22 on the GPU**: 7 read a local nothing assigns (`dir`, `pi`, `brdr`, …: always 0); 9 compute carried state and overwrite everything it feeds (the liveness pass drops it); 6 with a CPU slice. 6 stay on the CPU (below) |
| `rand` | 4 | **1 on the GPU** with only the calls in the slice. 3 stay on the CPU |
| `megabuf` / `gmegabuf` | 3 | 3 stay on the CPU (below) |
| **Total** | **53** | **41 on the GPU, 12 on the CPU** |

`sun fan phoets newborns of satan.milk`, #1 on the worklist, is one of the six: 12 of its
121 statements (17% of the work) run in the slice — the `thresh` blocks, `d`/`r`, and
`q2`, which it reads before writing `q2 = q1 + sy` further down, so every vertex after the
first sees the previous vertex's value.

#### The cost model and the 25% bar

The slice runs on one thread. The OpenMP CPU path it replaces spreads the whole program
over the worker pool — four threads in the WASM build — so a slice that keeps more than a
quarter of the per-vertex work would not be faster than the path it replaces, only
cheaper in total CPU time. `PerPixelGlslLowering::MaxCpuShare` is that quarter.

The work is estimated per node, weighted by what the evaluator actually spends. Measured
on the evaluator built `-O2 -DNDEBUG` (x86-64, two million executions per program):
operators, comparisons, constants and variables about 4 ns; `sin`/`cos`/`exp`/`log` and
the inverse trigonometric functions 20–40 ns; `tan` and `sigmoid` about 35 ns; `pow` and
`atan2` about 50 ns. Without the weights, a `thresh` recurrence — all comparisons and
multiplies — looks far more expensive next to a program full of `sin()` than it is.
`loop()` multiplies its body by the constant count; `while()` and variable bounds count
64 iterations.

The slice may also hand the shader at most 10 values per vertex
(`PerPixelGlslLowering::MaxCpuValues`), the capacity of the four attributes.

#### What stays on the CPU (12)

| Preset | Why the slice does not pay off |
|---|---|
| `AdamFX … pcynqo mbproduq hynek` | `vy`, read before its assignment, feeds most of the program: 79% |
| `Martin - Mandelbox Explorer […]` ×2, `xtramartin (567)` | Every statement reads `gmegabuf()`: 91% |
| `bdrv et.AL Aderrasi - Accelerator (…)` | `thresh`: 32% |
| `bdrv et.AL Krash + Eo.s. - Photographic Sentinel (…)` | `thresh`: 25%, on the bar |
| `fuckin' wench blew my wallet - phlenexiconal section` | `thresh`: 54% |
| `suksma - platinum sulfur dope nz+ …` | `thresh`: 40% |
| `suksma - reason dies with hate - dealt log 5.6a` | `thresh` plus a carried `tg3` in a short program: 54% |
| `shifter - bronchiole (…) tethered web nz+ vhordesth` | Ten `rand()` calls under `if(above(chng,cthr), …)` plus carried `mq2x`/`atime`: 38% |
| `shifter - plasmic fact - …` ×2 | `rand()` under a condition computed from `x`/`y`: 54% |

The `gmegabuf()` three read the buffer only (the per-frame code writes it), so the value
is the same for every vertex of a frame; evaluating those reads once per frame into a
uniform would move them to the GPU. Not done here.

#### OpenMP

With `PRJM_ENABLE_OPENMP` the CPU path gives each thread its own evaluation context, so a
carried local is carried **per thread**, over each thread's static chunk of vertices, and
the picture depends on the thread count. Nothing on the GPU path reproduces that; the
slice reproduces single-threaded order, which is also what original Milkdrop computes. The
differential test compares against single-threaded evaluation, and the render test renders
its CPU side on one thread (`omp_set_num_threads(1)`). Expect a slice preset to look
slightly different from the multi-threaded CPU path; the GPU path is the faithful one.

#### Upstream: a public tree API

The compiler walks projectM-eval's internal tree (`CompilerTypes.h`, `TreeFunctions.h`),
which only the vendored sources expose, so a build against an installed projectM-eval
compiles the GPU path out (`AGENTS.md`, `ENABLE_SYSTEM_PROJECTM_EVAL`). The fix belongs
upstream: a small public walk-and-execute API in `projectm-eval.h`. The proposal is in
[`patches/projectm-eval-program-visit.md`](../patches/projectm-eval-program-visit.md). Until
it lands, the vendored build is the only GPU-capable configuration.

---

## Phase 2 spike — hlslparser WGSL emitter vs naga vs stay GLSL

**Status (2026-09-25): not started.** #261 schedules Phase 2 after the toolchain tiering
work of #260, because it adds a code generator that must stay out of the WebGL2 bundle;
#260's PR (#265) is still open. The plan #261 fixes, following the decision below:

1. `vendor/hlslparser/src/WGSLGenerator.{h,cpp}` next to `GLSLGenerator`, walking the same
   `HLSLTree`, behind `ENABLE_WGSL_EMIT` (off in the WASM bundle, on for native and CI).
2. The per-pixel lowering emits WGSL too. Phase 1.5 already splits it into a
   language-neutral part (statement classification, liveness, the CPU slice) and the GLSL
   printer; the WGSL backend is a second printer behind the same plan.
3. `WgslCorpusTest.cpp` transpiles every `presets/tests/` and `custom_milk_fixed/` shader to
   WGSL into the build dir, and a CI job runs a pinned `naga` (`cargo install naga-cli
   --locked`) over each file, failing on parse or validation errors.
4. WGSL twins of the ~40 built-in GLSL files under `Renderer/Shaders/wgsl/`, validated by a
   `check_transition_shaders.sh` sibling.
5. **Exit:** ≥95% of the corpus naga-valid, with the rest listed and explained in a
   checked-in file, and the WASM bundle within ±1 KB. Only then the Phase 3 issue.

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
| **projectm-eval** (existing) | Equation AST, walked in place from `PerPixelGlslLowering`; its nodes run the CPU slice | Phase 1 and 1.5, done |
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

## What is still open, and what would move it

- **Frame times.** The whole verification ran on llvmpipe. A `?benchmark=1` session on
  a real GPU, A/B'd against `?perPixelEval=cpu`, is the missing half of #227's acceptance
  criterion 1 (#247). The per-frame upload fix of Phase 1.5 is in; measure after it.
- **The 12 presets still on the CPU** (see [What stays on the CPU](#what-stays-on-the-cpu-12)).
  Loosening `MaxCpuShare` for non-OpenMP builds, where the CPU path is single-threaded
  too, or moving frame-invariant `gmegabuf()` reads into uniforms would move some.
  Hand-porting (#170) remains the route for the rest. Do not silently change their look
  to get a checkbox.
- **A public tree API upstream.** The proposal is written
  ([`patches/projectm-eval-program-visit.md`](../patches/projectm-eval-program-visit.md));
  the upstream PR is not opened yet. Until projectM-Eval exposes the tree, a build against
  an installed evaluator compiles the whole path out.
- **The 13 comment-only per-pixel blocks** are really comments (`//zoom = …`), so the
  empty program is right; they are on the GPU path now as the empty function.
- **CPU-path nondeterminism.** Two CPU-path renders of `390 threx no more warningsce
  amy-able.milk` in one process diverge from frame 2 although `rand()` never fires and
  `time` is pinned. Not per-pixel related, and not investigated; `TimeKeeper` seeding its
  first frame from the wall clock is one candidate.
- **`FinalComposite::InitializeMesh()`** has the same never-stored viewport check that
  made the warp grid rebuild every frame, so the composite mesh is rebuilt every frame
  too. Not touched here.

---

## Related

- Closed: #179 (defer WebGPU), #112 (OpenMP/SIMD on eval — CPU), #178
  (governor v2), #220 (libomp spin), #224 (context config; `FULL_ES3=0`
  verified and landed 2026-09-17, which lifted this issue's gate).
- Open: #170 (heavy→GPU by rewriting presets), #227 (this epic), #261 (Phase 1.5 and
  Phase 2), #247 (real-GPU A/B), #229 (pass authoring through hlslparser; coordinate the
  Phase 2 generator refactor), #250 (HDR present on the eventual WebGPU path).
- Upstream: #683 (Vulkan/Metal), #761 (libniceshade), #1004 (GL core vs
  ES at instance creation).
- Code: `PerPixelGlslLowering.{hpp,cpp}`, `PerPixelMesh`, `PerPixelContext`,
  `PresetWarpVertexShaderGlsl330.vert`,
  `vendor/projectm-eval/projectm-eval/TreeFunctions.c` (the semantics every
  lowering rule above is checked against),
  `vendor/hlslparser/src/GLSLGenerator.h`.
- Tests: `tests/libprojectM/PerPixelGlslLoweringTest.cpp` (CPU evaluator vs. the
  generated shader and CPU slice, run under transform feedback),
  `tests/libprojectM/PerPixelGpuRenderTest.cpp` (both paths rendered through the
  whole engine), `tests/libprojectM/ShaderCacheTest.cpp` (evictable programs, uniform
  location cache), `tests/web/projectm-perf.test.mjs` (HUD and benchmark readouts).
