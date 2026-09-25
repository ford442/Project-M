# Upstream proposal: a public expression-tree API for projectM-eval

**For:** [projectM-visualizer/projectm-eval](https://github.com/projectM-visualizer/projectm-eval)
**Patch:** [`projectm-eval-program-visit.diff`](projectm-eval-program-visit.diff). Written
against `da885dc` ("Bump version to 1.0.6", the commit `vendor/projectm-eval` pins); applies
unchanged to upstream `master` `e8c311e` ("Fix scanner rule for floats"), where the suite also
passes (76 tests).
**Status:** written and tested locally; **the upstream PR is not opened yet.**
**Tracks:** #261 (GPU per-pixel Phase 1.5), which asked for this under the working name
`prjm_eval_program_visit()`. Public names in projectm-eval are `projectm_eval_*`, so the
patch spells it `projectm_eval_code_visit()`.

## Why this fork needs it

`PerPixelGlslLowering` (`src/libprojectM/MilkdropPreset/`) compiles Milkdrop `per_pixel_*`
programs to GLSL by walking projectM-eval's expression tree, and runs single statements of
them on the CPU (the "CPU slice", `docs/GPU_PERPIXEL_EVAL.md`). Today it includes the
evaluator's internal headers (`CompilerTypes.h`, `TreeFunctions.h`) and identifies operations
by comparing `prjm_eval_func_*` addresses. An installed projectM-eval ships only
`api/projectm-eval.h`, so a build against one compiles the whole GPU path out, and every
internal refactor upstream is a silent break here.

With this API the lowering would need nothing but the public header, the vendored-only
restriction (`AGENTS.md`, `ENABLE_SYSTEM_PROJECTM_EVAL`) goes away, and distro builds get the
GPU path.

## What the patch adds

All in `api/projectm-eval.h` / `api/projectm-eval.c`; no change to the tree, the compiler or
the evaluation functions, and no behaviour change for existing callers.

| Function | Purpose |
|---|---|
| `projectm_eval_code_root(code)` | The root node, or `NULL` for an empty program (only comments) |
| `projectm_eval_node_operation(node)` | What the node does, as `projectm_eval_operation` |
| `projectm_eval_node_child_count(node)` / `projectm_eval_node_child(node, i)` | Arguments, or the items of an instruction list, in evaluation order |
| `projectm_eval_node_constant(node)` | A constant's value |
| `projectm_eval_node_variable(node)` | A variable's storage — the same pointer `projectm_eval_context_register_variable()` returns, so hosts recognise their own variables by address |
| `projectm_eval_code_variable_name(code, variable)` | A variable's name, `"reg00"`..`"reg99"` for the global registers |
| `projectm_eval_node_is_global_memory(code, node)` | `gmegabuf` versus `megabuf` |
| `projectm_eval_node_execute(node)` | Runs one node (for example one statement) exactly as it runs inside its program |
| `projectm_eval_code_visit(code, visitor, user_data)` | Pre-order walk with depth; the visitor can prune a subtree |

`projectm_eval_operation` has one value per *implementation*, not per spelling: `if` and
`_if`, `int` and `floor`, `megabuf`, `_mem` and `gmegabuf` each map to one value. Values are
only ever appended, and anything a given version cannot name reports
`PROJECTM_EVAL_OP_UNKNOWN`, so a translator refuses it rather than mistranslating it. That
answers the design note in `docs/GPU_PERPIXEL_EVAL.md` that "nodes identify operations only
by function pointer; there is no opcode enum" without adding a field to the node struct.

## Tests

`tests/TreeInspectionTest.cpp` (added to `projectM_EvalLib_Test`): empty programs, list and
assignment structure, spelling-independent operations, register naming, running single
statements, and visit order with pruning. Built with GCC 13, `-Wall -Wextra`, no new warnings;
all 76 tests of the suite pass (70 existing, 6 new).

To reproduce from this repository:

```bash
git -C vendor/projectm-eval archive HEAD | tar -x -C /tmp/pe
cd /tmp/pe && patch -p1 < "$OLDPWD/patches/projectm-eval-program-visit.diff"
cmake -G Ninja -S . -B build -DBUILD_TESTING=ON -DCMAKE_C_FLAGS="-Wall -Wextra"
cmake --build build && ./build/tests/projectM_EvalLib_Test
```

## PR description (ready to paste)

> **Add a public API to inspect and run a compiled program's expression tree**
>
> projectM's GPU per-pixel path compiles `per_pixel_*` programs into GLSL vertex shaders and
> runs the few statements that must stay sequential (carried locals, `rand()`) on the CPU.
> Doing that needs the expression tree, which today is reachable only through the internal
> headers, so it only works against the vendored sources and breaks silently on internal
> refactors.
>
> This adds a small, read-only walking API plus single-node execution to
> `projectm-eval.h`: `projectm_eval_code_root()`, `projectm_eval_node_operation()` (a stable
> operation enum, one value per implementation whatever the spelling, append-only, with
> `PROJECTM_EVAL_OP_UNKNOWN` for anything newer), child access, constant/variable
> accessors, variable names (including `reg00`..`reg99`), `gmegabuf` detection,
> `projectm_eval_node_execute()` and a pre-order `projectm_eval_code_visit()`. Nothing in the
> tree, compiler or evaluator changes. Covered by `tests/TreeInspectionTest.cpp`.
>
> Beyond projectM's GPU path this also serves preset linters and translators that today
> would have to fork the parser.

## After it lands

1. Bump `vendor/projectm-eval` to the release that has it. **That bump also brings upstream
   `348b697` ("Use close factor of 0.00001 everywhere"):** `equal`, `!=`, `bnot`, the
   divide-by-zero guard, `&&`/`||` and `while` then compare against 1e-5 instead of 1e-300.
   `PerPixelGlslLowering` renders the old 1e-300 as an exact comparison (see "The two
   epsilons" in `docs/GPU_PERPIXEL_EVAL.md`), so its lowering table has to follow in the same
   change; `PerPixelGlslLoweringTest`'s differential cases fail until it does.
2. Port `PerPixelGlslLowering` to the public header: `EffectAnalyzer`/`Printer` switch on
   `projectm_eval_node_operation()` instead of function addresses, `CpuSlice` runs steps with
   `projectm_eval_node_execute()`, and variable names come from
   `projectm_eval_code_variable_name()`.
3. Replace the `PROJECTM_EVAL_INTERNAL_TREE` detection in `vendor/CMakeLists.txt` with a
   version check, drop the `ENABLE_SYSTEM_PROJECTM_EVAL` caveat from `AGENTS.md`, and let the
   GPU per-pixel tests run against an installed evaluator too.
