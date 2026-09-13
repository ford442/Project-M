# GPU per-pixel eval and the WGSL path (#227)

Living design for GitHub issue
[#227 — GPU per-pixel mesh + HLSL→WGSL path toward a WebGPU backend](https://github.com/ford442/Project-M/issues/227).
Companion to [`GRAPHICS_PERF_RECOVERY_PLAN.md`](GRAPHICS_PERF_RECOVERY_PLAN.md) §B
(the WebGPU deferral from #179) and [`PERFORMANCE.md`](PERFORMANCE.md)
(mesh / OpenMP / `perPixelEvalMs`).

**Status (2026-09-13):** Spike and Phase 1–3 design only. **Defer coding.** No compiler or
renderer code in this change. Phase 1 is gated on measuring the
WebGL2 leftovers recorded in closed [#224](https://github.com/ford442/Project-M/issues/224)
(#179 A5): `FULL_ES3=0` has linked and saved ~10 KB of JS glue, but has never
rendered a frame. Until that session lands JSON under `benchmark-results/`,
WebGL2 is not exhausted and this issue stays a roadmap.

A fully-tuned WebGL2 Milkdrop is the **current** product. This document is
what later looks like if we outgrow it.

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
| **1** Eval IR → GLSL vertex displacement | WebGL2 | No | First PR of #227 (keep epic open) |
| **2** `WgslGenerator` next to `GLSLGenerator` | GLSL still ships | No | WGSL corpus test |
| **3** `RendererWgpu` / `ENABLE_WEBGPU` | Native wgpu + emdawnwebgpu | Yes | Only after Phase 2 is green |

Do **not** merge WebGPU code (Phase 3) until Phase 2's WGSL corpus test is green.

---

## Phase 1 — Eval IR → GLSL vertex displacement

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
| AST walk + GLSL printer | `vendor/projectm-eval/` (new `GlslPrinter.c` or similar) plus a thin public API in `projectm-eval.h`: inspect program, enumerate used builtins, emit GLSL. Keep it C so a system `projectM-eval` package can grow the same surface. |
| Feature detect + fallback | `src/libprojectM/MilkdropPreset/` (`PerPixelMesh` / a new `PerPixelGlslLowering.cpp`) |
| Generated VS injection | New string assembled around `GetPresetWarpVertexShader()`; shader-cache key must include a hash of the snippet so two presets cannot share the default warp program |
| HUD / timings | `projectm_perf_frame_timings` + `js_perf_report_frame` + `html/projectm-perf.js` |

Do **not** put the printer in `hlslparser`. Per-pixel equations are not HLSL.

### Uniforms and attributes on the GPU path

**Per-vertex (keep as attributes, or reconstruct from `gl_VertexID`):**
`pos`, `radius`, `angle`. Reconstructing from vertex ID saves the radius/angle
upload; measure both. The CPU already has the buffers.

**Per-frame uniforms** (copied from `PerPixelContext::LoadStateReadOnlyVariables`
/ `LoadPerFrameQVariables`):

`time`, `fps`, `frame`, `progress`, `bass`, `mid`, `treb`, `bass_att`,
`mid_att`, `treb_att`, `meshx`, `meshy`, `pixelsx`, `pixelsy`, `aspectx`,
`aspecty`, `q1..q32`, plus the ten transform seeds (`zoom` … `sy`) so the
snippet can read-modify-write them the way the CPU loop does.

Pack `q1..q32` as `vec4 q[8]` (or two `mat4`s) to stay under WebGL2's
uniform limits.

**Outputs of the snippet:** the same ten floats the CPU writes today. Then
the existing VS body runs unchanged.

### Lowering table (`projectm-eval` → GLSL 300 ES)

Eval is scalar `double` (`PRJM_F_SIZE=8`). GLES 300 `highp float` is 32-bit.
That is an accepted, gated difference: golden-image tolerances in
[`GRAPHICS_BENCHMARK_HARNESS.md`](GRAPHICS_BENCHMARK_HARNESS.md) already
exist because GPU low bits differ. Do not silently switch the CPU evaluator
to float to "match."

| Eval node (`prjm_eval_func_*`) | GLSL | Notes |
|--------------------------------|------|-------|
| `const`, `var` | literal / `float` local | Variables are a `map<name, slot>` filled at print time |
| `set`, `add_op`…`pow_op` | `=` / `+=` / … | Compound assign is state-changing; keep it |
| `add` `sub` `mul` `div` `neg` | `+ - * / -` | |
| `mod` | `mod(a,b)` | Milkdrop `mod` is floating; GLSL `mod` matches better than `%` |
| `equal` `notequal` `below` `above` `beloweq` `aboveeq` | `float(a==b)` etc. | Eval returns 0.0/1.0 floats, not bools |
| `bnot` | `float(a==0.0)` | |
| `boolean_and_op` / `boolean_or_op` | GLSL short-circuit logical and/or | Eval **does** short-circuit these (`TreeFunctions.c`). GLSL matches. |
| `boolean_and_func` / `boolean_or_func` (`band` / `bor`) | eager temps, then `float(a!=0.0 && b!=0.0)` | Eval evaluates **both** args. Do not emit GLSL `&&` for `band`. |
| `bitwise_and` `bitwise_or` | `float(int(a) & int(b))` | `(5&(x*10-0.5))` appears in `sun fan phoets*` |
| `sin` `cos` `tan` `asin` `acos` `atan` `sqrt` `pow` `exp` `log` `floor` `ceil` `abs` `min` `max` `sign` | same | `int()` is an alias of `floor` in `TreeFunctions.c`. Eval `sqrt` is `sqrt(fabs(x))` — emit that, not bare `sqrt`. |
| `atan2` | `atan(y, x)` | GLSL ES 3.00 has two-arg `atan`, not `atan2`. Eval is C `atan2(arg0, arg1)` → `atan(arg0, arg1)`. |
| `log10` | `x <= 0.0 ? 0.0 : log(x) / log(10.0)` | No `log10` in GLSL ES 3.00. The `x <= 0` arm matches `prjm_eval_func_log10`. |
| `sqr` | `x*x` | |
| `invsqrt` | `inversesqrt(x)` | |
| `sigmoid` | match `TreeFunctions.c` (two args: `x`, `q`) | `1.0 / (1.0 + exp(-x * q))` with eval's `close_factor` zero-guard — **not** the one-arg logistic |
| `if` | `cond != 0.0 ? then : else` | Eval evaluates **only the taken branch** (`prjm_eval_func_if`). GLSL `mix(else, then, …)` evaluates **both** arguments and will run inactive-branch assignments. `mix` is allowed only when both branches are side-effect-free. Eval's `if` returns a **reference** (so `if(...) = x` can assign); if used as an l-value, **refuse** and keep CPU. If the printer cannot emit `?:` / an `if` statement that skips the dead branch, **CPU fallback**. |
| `exec2` `exec3` | statement list, last value | Lowerable |
| `execute_list` | `{ ... }` | Lowerable |
| `execute_loop` | `int n = int(bound); for (int i = 0; i < n; ++i)` | Eval truncates the bound with `(PRJM_EVAL_I)(*value_ptr)` (toward zero) — GLSL `int(float)` is the same. GLSL ES 3.00 has **no** implicit int/float conversion, so the cast is mandatory. If `n` is not a compile-time constant, or `n` exceeds a small documented GPU cap (64 is a reasonable first cap), **CPU fallback**. Do **not** clamp a large `n` down to that cap (that changes the look). Eval's CPU `MAX_LOOP_COUNT` (1 048 576) is a safety net, not a GPU policy. Negative `n`: loop does not run, same as CPU. |
| `execute_while` | **CPU fallback** | Unbounded; GLSL ES has no reliable unbounded loops |
| `rand` | **CPU fallback** (first version) | Hash-of-(vertex, frame) is possible later; it will not match `rand()` bit-exact and will fail goldens |
| `mem` `freembuf` `memcpy` `memset` | **CPU fallback** | megabuf / gmegabuf |

Eval `&&` / `||` short-circuit; `band` / `bor` do not. Match that in the
printer (table above). Side-effecting args in `band`/`bor` still run on
both GPU and CPU; they do not create a new sequential-vs-parallel fork
beyond the q*/local rules below.

### Feature detect (per preset, at load)

Walk the compiled `prjm_eval_program_t` **once** after
`CompilePerPixelCode`. Classify:

1. **Refuse (keep CPU OpenMP path)** if the tree contains `mem` /
   `freembuf` / `memcpy` / `memset`, `execute_while`, `rand`, an l-value
   `if`, an `if` whose taken-only semantics cannot be preserved (see
   lowering table), an `execute_loop` that fails the bound rule above,
   or any unknown `func` pointer (forward-compat).
2. **Refuse** if a non-builtin local is **read before it is assigned** in
   one execution of the program. In original Milkdrop (and in this tree's
   OpenMP pool) eval locals **persist across vertices on the same
   context**. Mashups use that as an IIR:

   ```
   thresh = above(bass_att,thresh)*2 + (1-above(bass_att,thresh))*((thresh-1.3)*0.96+1.3);
   dx_r   = equal(thresh,2)*0.015*sin(5*time) + (1-equal(thresh,2))*dx_r;
   ```

   That pattern is in `sun fan phoets.milk` / `sun fan phoets newborns of
   satan.milk` (`thresh`, `dx_r`, `dy_r`). Independent GPU vertices would
   zero-init those and **fail screenshot similarity**. Detecting
   read-before-write is the difference between a correct prototype and a
   pretty-but-wrong one.
3. **Refuse if the program writes any `q1..q32`.** CPU `q*` persist per
   OpenMP thread and are **not** reset at the start of each vertex in
   `CalculateMesh`. GPU Phase 1 reseeds `q*` from per-frame uniforms every
   vertex. A write is therefore a cross-vertex leak on CPU (the next
   vertex on that thread reads the written value) and a no-op leak on
   GPU. Documented Milkdrop is "set in `per_frame`, read in `per_pixel`,"
   but screenshot similarity against this tree requires matching the CPU
   path, not the docs. Do not warn-and-allow. Loosen later only with a
   golden A/B that shows the pixels match anyway.
4. **Accept** otherwise. `if`/`above`/`below`/`equal`/`bnot`/`pow` /
   `atan2` (as `atan`) / bitwise `&`/`|` / locals that are assigned before
   use are all in the heaviest worklist entries and **are** lowerable.

The HUD shows `perPixelEval=gpu` or `perPixelEval=cpu` from this
classification. A runtime override (`?perPixelEval=cpu`) forces fallback
for A/B, matching `?blurPath=copy` / `?copyPath=shader`.

### Semantic forks the printer must not paper over

| Topic | CPU today | GPU Phase 1 | Rule |
|-------|-----------|-------------|------|
| Carry-state locals (`thresh`, `dx_r`) | Persist on the eval context; OpenMP → persist **per thread** | Per-vertex zero | Fallback if read-before-write |
| `q*` writes | Persist per thread; not reset at the start of `CalculateMesh` | Uniform seed every vertex | **CPU fallback if any `q*` is written** |
| `rand()` | libc / eval RNG | Would need a hash | Fallback |
| Precision | `double` | `highp float` | Allowed; goldens already perceptual |
| `if` as l-value, or `if` with a side-effecting dead branch that cannot be skipped | Eval returns a reference; only the taken branch runs | GLSL `mix` runs both; `?:` skips the dead branch | Fallback if l-value or if `?:` / `if` cannot be emitted |
| OpenMP | `kMinPerPixelMeshVerts=1000`, `kmp_set_blocktime(0)` | Not used on the GPU path | Leave the CPU path untouched; do not spin the pool "just in case" |

### HUD and `projectm_perf_frame_timings`

Today `per_pixel_eval_ms` is a CPU `steady_clock` around
`PerPixelMesh::Draw` (eval **and** the warp draw submit). That is the one
trustworthy per-stage bucket
([recovery-plan measurement section](GRAPHICS_PERF_RECOVERY_PLAN.md#measurement-what-the-hud-can-and-cannot-tell-you)).

On the GPU path:

- Keep `per_pixel_eval_ms` as **CPU time in `CalculateMesh` + attribute /
  uniform upload + draw submit**. It should drop sharply (no 4941 evals).
- Add `per_pixel_eval_path` (`0=cpu`, `1=gpu`) on
  `projectm_perf_frame_timings` and on `js_perf_report_frame`.
- HUD label: `Per-pixel/warp [gpu]` vs `[cpu]`. Benchmark JSON grows
  `perPixelEvalPath`.
- Do **not** pretend this measures GPU vertex cost. `gpuMs`
  (`EXT_disjoint_timer_query_webgl2`) remains whole-frame. Ranking still
  uses A/B (`?perPixelEval=cpu` vs default) on `totalMs` / `gpuMs`.

### Proof plan (acceptance for the first code PR)

[`PRESET_WORKLIST.md`](PRESET_WORKLIST.md) ranks 44 `heavy` presets. Phase 1
does **not** have to GPU the #1 mashup if it fails feature-detect. It has
to GPU **at least five currently-`heavy` presets** that:

1. Classify `perPixelEval=gpu`.
2. Beat or match screenshot similarity on the existing capture harness
   ([`GRAPHICS_BENCHMARK_HARNESS.md`](GRAPHICS_BENCHMARK_HARNESS.md) —
   `tests/wasm-smoke/golden_images.mjs`, including
   `presets/tests/110-per_pixel.milk` as the trivial fixture:
   `zoom=0.9615-rad*0.1`).
3. Show lower `per_pixel_eval_ms` under `?benchmark=1`.

Candidates to try first (dominant term = per_pixel equations, and a
human pass for read-before-write before writing the printer):

| Priority | Preset | Why |
|----------|--------|-----|
| Fixture | `presets/tests/110-per_pixel.milk` | One line, no locals, already in the golden set |
| 1 | `Hexcollie, BDRV n Flexi - Cosmic evolution.milk` | 50 per_pixel lines, 83% of cost, small shader |
| 2–5 | Next worklist rows whose AST walks clean (no R-before-W, no `rand` in `per_pixel_*`) | Re-walk at implementation time; mashup #1/#2 are likely CPU until the IIR locals are handled |

`sun fan phoets*` (#1/#2, 143 lines, 86–87% per_pixel) are the **prize**,
not the first PR. They need either a carry-state story or a documented
"GPU uses documented Milkdrop seeding" golden update. Do not silently
change their look to get the checkbox.

### Ablation

`?perPixelEval=cpu|gpu|auto` (WASM) / `PROJECTM_PER_PIXEL_EVAL=cpu` (native),
default `auto`. `gpu` on an unlowerable preset is a load-time log + CPU
fallback, not a hard fail.

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

## Gate: #224 leftovers still unmeasured

Closed #224 landed the **contract** half (`WasmContextConfig` /
`set_context_config()`, MSAA default-off, host-driven FBO precision).
It deliberately did **not** flip `FULL_ES3=1 → 0`. The recorded blocker
is `CopyTexture::TryBlit()`: a Y-inverted `glBlitFramebuffer` every frame
that flips a same-size color attachment — the call most likely to differ
between Emscripten's ES3 emulation and raw WebGL2.

**Do not start Phase 1 coding until a browser session has rendered, on
one build with `FULL_ES3=0`:** A1 blit + blur3 + a no-composite-shader
preset + a composite-shader preset + a soft-cut, with JSON under
`benchmark-results/`. If that session fails, the GL emulation layer is
still load-bearing and a WebGPU backend (Phase 3) is even more work, not
less — but Phase 1 (GLSL VS on the existing WebGL2 context) can still
proceed once we know the blit is stable.

---

## Libraries / tools

| Library | Role | When |
|---------|------|------|
| **projectm-eval** (existing) | Equation AST; add a GLSL printer + feature-detect walk | Phase 1 |
| **hlslparser** (existing) | HLSL tree; add `WgslGenerator` | Phase 2 |
| **naga-cli** (CI only) | Validate WGSL | Phase 2 |
| **wgpu** + Dawn/emdawnwebgpu | WebGPU backend | Phase 3 |
| libniceshade / DXC-wasm / naga-in-runtime | Rejected unless hlslparser cannot grow a WGSL emitter and a spike shows <500 KB | Never by default |

---

## Out of scope (this document / this PR)

- Implementing the printer, HUD bit, or `?perPixelEval=`.
- Hand-rewriting presets (#170).
- Vendor naga/Tint/DXC.
- `ENABLE_WEBGPU` CMake option, `RendererWgpu`, emdawnwebgpu.
- Changing OpenMP blocktime or pool size.
- Flipping `FULL_ES3` (owned by #224 / #179 A5).

---

## Related

- Closed: #179 (defer WebGPU), #112 (OpenMP/SIMD on eval — CPU), #178
  (governor v2), #220 (libomp spin), #224 (context config; FULL_ES3
  still unverified).
- Open: #170 (heavy→GPU by rewriting presets), #227 (this epic).
- Upstream: #683 (Vulkan/Metal), #761 (libniceshade), #1004 (GL core vs
  ES at instance creation).
- Code: `PerPixelMesh`, `PerPixelContext`,
  `vendor/hlslparser/src/GLSLGenerator.h`,
  `vendor/projectm-eval/docs/Compiler-Internals.md`,
  `PresetWarpVertexShaderGlsl330.vert`.
