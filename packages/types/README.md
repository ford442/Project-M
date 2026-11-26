# @projectm/types

The projectM browser host layer's types, shared by `html/` (the host modules)
and `packages/web/` (the `@projectm/web` embed SDK). Types only: nothing here
runs.

| Entry | What |
|---|---|
| `@projectm/types/context` | `ProjectMContext` options, events and audio-source shapes |
| `@projectm/types/element` | `<project-m-visualizer>`'s props and events (the framework wrappers' types) |
| `@projectm/types/host` | the Emscripten module surface the host probes, and the host-owned page globals |
| `@projectm/types/preset` | preset manifest entries, filters and the preset cache's records |
| `@projectm/types/render-worker` | the render worker's wire protocol, both directions |
| `@projectm/types/transport` | `RenderTransport`, the one interface over both render topologies |
| `@projectm/types/wasm-api` | **generated** from `cmake/WasmApiManifest.cmake` (`scripts/sync_wasm_link_common.sh`): `HostHandle`, `ProjectMError`, `WasmApiCalls` and the wrappers' signatures. Never edit it by hand |

Import by name: `import type { RenderTransport } from '@projectm/types/transport'`
from TypeScript, `@typedef {import('@projectm/types/context').ProjectMContextOptions}`
from a JSDoc module. The html/ and packages/web tsconfigs map
`@projectm/types/*` to `src/*`, so no install is needed for a type check.

It is private (never published): the `@projectm/web` build stages `src/` as
`staging/types/` and rewrites every `@projectm/types/<name>` specifier to a
relative path, so the SDK's declarations need nothing outside its tarball. Two
files reach back into `html/` for an implementation type (the context class, the
audio router) by relative path; the build rewrites those too.

See `html/README.md` ("TypeScript") and `docs/HOST_LAYER.md` ("TypeScript strategy").
