# Project-M: pointer for Claude Code

[`AGENTS.md`](AGENTS.md) is the one agent guide for this repository: build, test,
style, CI and deployment. This file only routes you to it; it used to also carry a
WASM status table and a copy of the build flags, and both went stale (the flags
live, with a comment per flag, in `cmake/EmscriptenWasmFlags.cmake`; open work is
on the GitHub issue tracker, `gh issue list -R ford442/Project-M`).

## Which doc should I read first?

| If you're... | Read this first |
|---|---|
| Doing any C++/CMake/build/test work | [`AGENTS.md`](AGENTS.md) — canonical build, style, and testing reference |
| Touching `src/wasm/` or the WASM build | [`docs/EMSCRIPTEN.md`](docs/EMSCRIPTEN.md), and `cmake/EmscriptenWasmFlags.cmake` for the flags (each one carries its reason) |
| Editing `html/*.js`/`*.html` demo pages | [`html/README.md`](html/README.md) (architecture) and [`html/REFACTORING_NOTES.md`](html/REFACTORING_NOTES.md) |
| Creating/upgrading `.milk` presets (Kimi/Codex/Grok) | [`docs/kimi_preset_authoring_plan.md`](docs/kimi_preset_authoring_plan.md) |
| Picking up a task from a human/another agent | [`grok_agent/README.md`](grok_agent/README.md) |
