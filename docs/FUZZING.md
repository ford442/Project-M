# Fuzzing

Preset files are untrusted input (AGENTS.md, "Security Considerations"). They come from preset
packs, drag-and-drop and the network, and libprojectM parses them, transpiles their HLSL and
compiles and runs their equations. `tests/fuzz/` holds libFuzzer targets for each of those stages.
CI runs them on every push and every night (#351).

## Targets

| Target | Input | What runs | Seeds | Dictionary |
|---|---|---|---|---|
| `fuzz_preset_parser` | a whole `.milk` file | `PresetFileParser::Read()`, then `GetCode()` for the code prefixes and the typed getters for common keys | `presets/tests/`, the parser and compat fixtures in `tests/libprojectM/data/` | `milk.dict` |
| `fuzz_hlsl_transpile` | one preset shader, as `GetCode("warp_")` returns it (`shader_body { ... }`) | `ShaderTranspiler::PreprocessPresetShader()` + `TranspileToGlsl()` (hlslparser), as a warp shader and as a composite shader. This is the path PresetCompat checks | the warp/comp shaders of the presets above, plus `tests/fuzz/seeds/fuzz_hlsl_transpile/` | `hlsl.dict` |
| `fuzz_eval_compile` | Milkdrop equation code | `projectm_eval_code_compile()` in a fresh context with the per-frame and per-pixel variables registered, then one `projectm_eval_code_execute()` | the equation blocks of the presets above, plus `tests/fuzz/seeds/fuzz_eval_compile/` | `eval.dict` |
| `fuzz_shader_passes` | a whole `.milk` file | reads the file the way `PresetState` does (shader versions, `ExperimentalDepthSampler::ShaderCode()`, `PresetState::ReadShaderPasses()` for `warp_nPasses`/`comp_nPasses`, #229), then transpiles every stage and pass shader | as `fuzz_preset_parser` (`310`/`311` are the pass fixtures) | `milk.dict` |

A harness catches only the exceptions the engine itself handles at that point:
`Renderer::ShaderException` from preprocessing, which `MilkdropShader` catches, and
`MilkdropPresetLoadException` from `ReadShaderPasses()`. Any other exception, such as an
`std::out_of_range` from a bad offset, reaches libFuzzer as a crash.

`fuzz_eval_compile` has a **loop budget**. Each `loop(n, ...)` or `while(...)` runs up to 1048576
times (`MAX_LOOP_COUNT` in projectm-eval), so nested loops would take hours. That cost is known and
bounded. It is not a memory bug, and without a limit it would bury real findings under timeouts. So
the harness skips any input with more than one `loop`/`while` keyword, and any input with one
keyword that is longer than 256 bytes.

## Two builds of the same targets

- **`-DENABLE_FUZZING=ON`** (clang only) builds real libFuzzer binaries. `cmake/FuzzingFlags.cmake`
  instruments every target with coverage, ASan and UBSan (`-fno-sanitize-recover=all`), including
  libprojectM's object libraries, hlslparser and the vendored projectm-eval. It forces
  `ENABLE_SYSTEM_PROJECTM_EVAL=OFF`, because an installed evaluator would not be instrumented.
- **`-DBUILD_TESTING=ON` without `ENABLE_FUZZING`** works with any compiler, MSVC included. It
  links the same harnesses with `tests/fuzz/FuzzReplayMain.cpp`, which runs each input file once.
  This is how the ordinary Debug/Release and sanitizer jobs in `build_linux.yml` replay the
  regression corpus.

Both builds register one ctest per target, `FuzzRegression.<target>` (label `fuzz`). Each one
replays `tests/fuzz/regressions/<target>/` plus that target's checked-in seeds.

## Running locally

```bash
cmake -G Ninja -S . -B cmake-build-fuzz \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
  -DENABLE_FUZZING=ON -DBUILD_SHARED_LIBS=OFF -DENABLE_PLAYLIST=OFF
```

```bash
cmake --build cmake-build-fuzz --parallel --target fuzz_preset_parser fuzz_hlsl_transpile fuzz_eval_compile fuzz_shader_passes
```

```bash
ctest --test-dir cmake-build-fuzz -L fuzz --output-on-failure
```

```bash
scripts/fuzz_run.sh cmake-build-fuzz 300 fuzz-work            # all four, 5 min each, in parallel
```

```bash
scripts/fuzz_run.sh cmake-build-fuzz 600 fuzz-work fuzz_eval_compile
```

On Ubuntu, clang needs `libclang-rt-18-dev`, which provides the libFuzzer and sanitizer runtimes.
`scripts/fuzz_run.sh` seeds `fuzz-work/corpus/` with `tests/fuzz/extract_seeds.py`, passes the
regression corpus as a read-only extra corpus and writes findings to `fuzz-work/artifacts/<target>/`.
It exits 1 if any target produced a finding. To reproduce a finding, run the target on it:
`cmake-build-fuzz/tests/fuzz/fuzz_hlsl_transpile fuzz-work/artifacts/fuzz_hlsl_transpile/crash-...`.

## CI

- **`fuzz_smoke.yml`** runs on every push and PR. It replays the regression corpus, then fuzzes each
  target for 60 s with ASan + UBSan. It has no `paths:` filter, so it can be a required check.
- **`fuzz_nightly.yml`** runs daily and on manual dispatch. Each target gets its own runner and
  30 min in libFuzzer fork mode (`-fork=4`). The corpus carries over between runs through the actions
  cache and is minimized (`-merge=1`) at the end of each run. Findings and logs are uploaded as the
  `fuzz-findings-<target>` artifact, and a finding fails the job.

## When a fuzzer finds something

1. Reproduce it with the target binary and the input.
2. Fix the bug. Do not teach the harness to skip the input, unless the input is outside what the
   engine can receive. The loop budget above is the one such case today.
3. Add the input to `tests/fuzz/regressions/<target>/` in the same change, under a name that says
   what it is (e.g. `identifier-over-255-chars`). Each `FuzzRegression.<target>` test then replays
   it in every CI build, libFuzzer or not.
4. Add a `CHANGELOG.md` entry if the bug could be reached from a preset.

## Findings so far

Fixed (inputs in `tests/fuzz/regressions/`). Each one was reachable from a preset file in every
build, browser included. A hang freezes the thread that loads the preset, which is the render
thread or the WASM prepare thread.

| Found by | Bug | Fix |
|---|---|---|
| `fuzz_hlsl_transpile` | An identifier longer than 255 characters in a preset shader was `memcpy`'d into the tokenizer's 256-byte `m_identifier` buffer: memory corruption on preset load | `vendor/hlslparser/src/HLSLTokenizer.cpp` rejects it with a syntax error |
| `fuzz_shader_passes` | `()` or `{}` with nothing inside, as an expression, returned a null expression that callers (`!`, the comma-list walk) dereferenced | `vendor/hlslparser/src/HLSLParser.cpp` rejects it with a syntax error |
| `fuzz_hlsl_transpile` | **Hang.** `#if`/`#ifdef`/`#elif` followed by an unterminated `/*` (or at the very end of the source) looped forever waiting for an end of line | the preprocessor loops also stop at end of stream |
| `fuzz_hlsl_transpile` | **Hang.** A NUL byte or the end of the source inside a `#define` value looped forever the same way | the `#define` value loops also stop at end of stream |
| `fuzz_hlsl_transpile` | A `#define` that failed to parse (e.g. a bare `#define` before a NUL) stayed registered with a null value, which the next pass passed to `strlen()`: a segfault | the macro gets an empty value when it is registered |
| `fuzz_hlsl_transpile` | **Hang.** A macro whose value names itself (`#define t (t + 1)`), or a cycle of macros, was re-expanded forever, growing each round. (`c779916` only caught the exact `#define t t` case) | the preprocessor gives up after 64 expansion rounds or a 64 KiB value |

### Known findings, not yet fixed

Both are in projectm-eval, which is the fork `ford442/projectm-eval` (see `docs/UPSTREAM_SYNC.md`
"projectm-eval fork"). A fix there lands by pushing to the fork's `context-rng` branch and bumping
the submodule pin, not by changing files under `vendor/projectm-eval/` in this repo.

- **Compile-error leak.** A function call with the wrong argument count or an unknown name, such as
  `loop(x)`, leaks the argument list and the function name.
  `prjm_eval_compiler_create_function()` returns an error, and the grammar action `YYERROR`s
  without freeing them: Bison runs no `%destructor` on the RHS of the rule that raised the error.
  The fix is for `create_function()` to free the argument list on both error paths, and for the
  `PRJM_EVAL_FUNC` macro to free the name before `YYERROR`. The regression input is
  `regressions/fuzz_eval_compile/wrong-arg-count-leak`. Until the fix is pinned,
  `tests/sanitizers/lsan.supp` suppresses `leak:prjm_eval_parse`, which hides every leak allocated
  during parsing. Remove that entry with the pin bump.
- **Float-to-integer casts.** `%`, `|`, `&`, `loop()` counts and `megabuf` indices cast doubles to
  integers without a range check, so `x % 1e308` is UB (`float-cast-overflow`). In practice the
  result is the platform's (x86: `INT_MIN`; wasm: saturated), so native and browser builds can
  disagree, but nothing reads out of bounds. Fixing it changes evaluator semantics that the GPU
  per-pixel path mirrors (`docs/GPU_PERPIXEL_EVAL.md`), so it needs its own change. Until then,
  `tests/fuzz/CMakeLists.txt` builds projectm-eval with `-fno-sanitize=float-cast-overflow` in
  fuzzing builds only. Every other check stays on.
