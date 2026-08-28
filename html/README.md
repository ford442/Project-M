# projectM HTML Host Architecture

The HTML demo hosts are being migrated from copy-pasted standalone pages to thin shells backed by shared browser modules. Keep changes incremental: extract and share behavior first, then shrink individual hosts once parity is proven.

## Target Shape

### Core Shell

`projectm-core.html` is the reference minimal host. It should own only the visualization surface, WASM bootstrap, sizing, preset loading, and audio ingestion needed to run projectM in a browser.

Core behavior belongs in shared modules:

- `projectm-init.js`: script loading and reusable WASM/canvas bootstrap helpers.
- `projectm-presets.js`: API preset fetch, VFS writes, startup preset loading, and random preset loading.
- `projectm-preset-picker.js`: named, searchable picker for the curated `custom_milk_fixed` presets, with known-good/known-broken status badges. Reads `custom_presets_manifest.json` (regenerate with `scripts/generate_custom_preset_manifest.mjs`); loads the raw `.milk` from a resilient list of bases (override via `localStorage.customPresetBase`). Backs the "Random Custom" button and a right-click "🎛 Presets" browser in `projectm-core.html`.
- `projectm-preset-dev.js`: hot-reload dev panel (`?devPreset=1`), URL polling, inline `.milk` editor. See `docs/SIGNATURE_SERIES_WORKFLOW.md`.
- `projectm-preset-tweaker.js`: header param sliders (decay, zoom, warp, wave RGB) used by the dev panel.
- `projectm-external-pcm.js`: external MOD/FLAC `postMessage` PCM contract, origin allowlist, queued feeding, and preallocated transfer buffers.
- `projectm-audio-source-router.js`: exclusive single-active-source policy (element / external / worklet).
- `projectm-context.js`: typed **embed context API** (`ProjectMContext`) — WASM bootstrap, resize/DPR, presets, audio modes, transparency.
- `projectm-element.js`: **`<project-m-visualizer>`** custom element + lifecycle events (`pm-ready`, `pm-preset-changed`, `pm-error`, `pm-fps`).
- `projectm-wasm-version.js`: canonical WASM bundle version + CDN URL helpers (keep in sync with deploy scripts).
- `projectm-transitions.js`: readiness polling before starting dual-FBO transitions.
- `projectm-song-loader.js`: host-side Start/Change Song routing — merges the
  `songs/`, `mp3_songs/`, and `mod_songs/` listings into one catalog and plays
  FLAC/MP3/WAV/OGG in-page through the shared worklet. Patches
  `BroadcastChannel` so the WASM glue's `'sng'` posts are intercepted before
  the legacy `./flac/` popup sees them, falling back to that popup only when
  in-page routing fails. MOD files stay on the Audio Player button.
- `projectm-weeks-on-fire.js`: **Weeks on Fire** demo mode (`?mode=weeks_on_fire`) — points texture/song/preset scanners at `./weeks_textures/`, `./weeks_songs/`, and `./weeks_presets/` on the host (e.g. `projectm.1ink.us`). WASM bootstrap seeds a random playlist and auto-starts the FLAC decoder.

### Panel Chrome

Panel controls, bezels, buttons, and embedded player sections are optional chrome layered over the core shell. They should be loaded from templates or small controller modules rather than pasted into every host.

Current shared panel behavior:

- `projectm-audio-player.js`: FLAC/MOD section cycling and popup player controls.

Preserve calibrated panel2 bezel artwork and hotspot positions when moving chrome into templates. Layout extraction should not retune artwork unless the change is explicitly about calibration.

### Extended Features

Full UI features such as GLTF, depth, image pipelines, and experimental render controls should be lazy-loaded modules. They should not become required dependencies for `projectm-core.html` or panel-only hosts.

- `projectm-experimental-bridge.js`: opt-in (`?experimental=1`) bridge from Depth Anything / glTF / `BroadcastChannel` hooks to preset textures and metadata. See `docs/EXPERIMENTAL_PRESET_HOOKS.md`.

Keep remote asset endpoints configurable. Existing pages read `localStorage.apiBase`; new modules should continue accepting explicit API bases or localStorage-derived values.

## Host Roles

Hosts fall into three tiers: the **core shell** and the **embed demo** are the
canonical, dogfooded surfaces; **panel hosts** layer calibrated chrome on top;
the former **legacy full hosts** are now redirect stubs onto the core shell.

### Gated hosts (public-API ratchet)

No first-party host under `html/` may call raw `Module._<sym>` /
`Module.ccall(...)` for public engine ops. Hosts boot through
**`ProjectMContext`** and/or `generated/projectm-wasm-api.js`; redirect stubs
make no `Module` calls at all. Enforced by
`scripts/check_core_host_public_api.sh` (CI: `.github/workflows/host_layer_gate.yml`)
against every first-party host under `html/`: `projectm-core.html`,
`embed-demo.html`, `embed-multi-iframe.html`, `projectm_panel2.1ink`,
`projectm_panel.1ink`, `projectm.1ink`, `projectm_new.1ink`,
`projectm_test.1ink`.

### Core / canonical

- `projectm-core.html`: reference core shell. Markup + panel chrome only; boots via
  **`ProjectMContext`** (`projectm-context.js`) for init, resize, preset lock, and
  transparency on the main-thread path (render-worker mode still uses the worker
  handle). Public engine operations go through the generated WASM API
  (`generated/projectm-wasm-api.js`) or context methods — **no raw
  `Module._<sym>` / `Module.ccall(...)` public-API calls** (see Gated hosts).
  Render-worker/perf internals that proxy ccalls through the render-worker handle
  are the only temporarily allowed exception, and they do not touch the `Module`
  object directly.
- `embed-demo.html`: minimal third-party embed demo using
  `<project-m-visualizer>` (see `packages/web/README.md`). The custom element
  and `ProjectMContext` (`projectm-context.js`) are the intended init path for
  new hosts.

### Panel hosts

- `projectm_panel2.1ink`: production bezel host with embedded MOD/FLAC iframe
  sections and current bezel calibration. Supports `?mode=weeks_on_fire` like
  `projectm-core.html`. Boots via **`ProjectMContext`** + generated WASM API
  (gated; see above). Still owns bezel chrome, external PCM, Weeks-on-Fire mode,
  and the WASM version picker (`?wasm=`).
- `projectm_panel.1ink`: **redirect stub** → `projectm_panel2.1ink`, preserving
  the query string and hash. Previous inline content is available via git
  history.

### Legacy full hosts (redirect stubs)

`projectm.1ink` and `projectm_new.1ink` are **redirect stubs** →
`projectm-core.html?experimental=1`. Their unique experimental UI (Depth
Anything / glTF hooks) was ported to the opt-in
`projectm-experimental-bridge.js` (see `docs/EXPERIMENTAL_PRESET_HOOKS.md`);
other inline chrome (build picker, APNG export, bezel/frame overlays) was not
ported and is only available via git history. `projectm_test.1ink` remains a
real harness/test page (already has no raw `Module._` / `Module.ccall`
public-API calls) and is gated (see above).

## `.1ink` Deprecation Path

Do not delete the `.1ink` hosts in one sweep. First, move shared behavior into modules and have each host import it. Next, replace repeated chrome with templates or dynamic imports. Once a host is thin enough, turn old `.1ink` names into redirect stubs or build-time composed outputs that point at the canonical shell.

`projectm_panel.1ink`, `projectm.1ink`, and `projectm_new.1ink` have completed
this path and are now redirect stubs. Tracked `.bak` files should not be
reintroduced. Use git history for previous versions.

## TypeScript Migration (Epic #163)

`tsconfig.json` runs with `strict: true` and `checkJs: true`. Modules listed in
its `include` are typechecked via `npm run typecheck` in this directory (also
invoked by `scripts/check_html_types.sh` in CI:
`build_linux.yml` / `build_emscripten.yml`) — a type error in any of them fails
the PR. TypeScript is pinned in `html/package.json` so local runs and CI use the
same compiler version.

Migration strategy: **`allowJs` + `checkJs` with JSDoc annotations**, not a
`.ts`-with-emit rewrite. Shared option/module shapes live in small types-only
`.ts` companions (`projectm-host-types.ts`, `projectm-context-types.ts`) that
the real `.js` implementation imports via
`@typedef {import('./foo-types.ts').Bar}`. Two rules keep this from drifting
back into the dual-source problem this migration started from:

1. **A types-only companion must never share a basename with the `.js`
   module it describes.** TypeScript's `bundler` module resolution resolves
   a `./foo.js` specifier to a same-basename `./foo.ts` if one exists,
   silently shadowing the real implementation for every JS importer during
   typecheck — exactly the kind of drift that left `projectm-context.ts` /
   `projectm-element.ts` as unmaintained `declare class` stubs before this
   migration. Name companions `*-types.ts` (see `projectm-context-types.ts`)
   or fold the types into the JSDoc directly, and never write a
   `declare class` / `declare function` that duplicates a real `.js` export.
2. Prefer typing the module's own logic in JSDoc over widening shared
   ambient types (`ProjectMModuleLike` in `projectm-host-types.ts`) to make
   an error disappear — a narrow, correct type here is worth more than a
   passing `tsc` run.

### Coverage

**All 33 `html/projectm-*.js` modules are checkJs-clean and in the `include` of
one of the two tsconfigs** — there is no unconverted backlog. Add new modules to
`tsconfig.json` in the same commit that creates them; a module left out is not
checked, and (as `projectm-worklet-playback.js` and then
`projectm-song-loader.js` both showed) being *reachable* from a checked module
is not the same as being listed: `projectm-song-loader.js` shipped fully
JSDoc-annotated but unlisted, and picked up eleven errors the moment it was
added. Verify with `ls html/projectm-*.js | wc -l` against the two `include`
lists rather than trusting a green `npm run typecheck`, which only proves the
listed set is clean.

Two programs, because the libs are mutually exclusive:

| tsconfig | lib | Covers |
|---|---|---|
| `tsconfig.json` | `DOM` | every module that runs on the main thread |
| `tsconfig.worker.json` | `WebWorker` | `projectm-render-worker.js` only |

`npm run typecheck` runs both, so `scripts/check_html_types.sh` (CI:
`build_linux.yml` / `build_emscripten.yml`) gates both.

The worker and its main-thread bridge only meet across `postMessage`, so the
wire format lives in `projectm-render-worker-types.ts` — included by both
programs, and the reason a field renamed on one side is a build error on the
other. Worker replies go through a `postToHost()` wrapper rather than
`self.postMessage` directly: the raw signature takes `any`, so without it an
outgoing typo type-checks fine and fails only on the far side.

### Types-only companions

- `projectm-host-types.ts` — `ProjectMModuleLike` plus every host-owned
  `window` / `globalThis` global. Note that the `Window` augmentation does not
  apply to `typeof globalThis`, so globals reached as `globalThis.foo` need a
  matching `var` declaration in the same file.
- `projectm-context-types.ts` — `ProjectMContext` options and audio-source shapes.
- `projectm-preset-types.ts` — preset manifest entries, filters, and the
  IndexedDB record shapes shared by the preset library / picker / cache modules.
- `projectm-render-worker-types.ts` — the render-worker message protocol.
- `projectm-wasm-api-worker.ts` — ccall symbol names for the worker proxy.

`generated/projectm-wasm-api.{js,ts}` is the one same-basename `.js`/`.ts` pair
in the tree. It does not violate rule 1 below: both halves are emitted together
from `cmake/WasmApiManifest.cmake`, so the `.ts` shadowing the `.js` for JS
importers is exactly what gives them the generated types. Never hand-edit
either half — an earlier revision added `setHostAudioSourceRouter()` to the
`.js` by hand and the next `scripts/sync_wasm_link_common.sh` run deleted it,
leaving an import of a non-existent export that threw at ESM link time and took
`projectm-context.js` down with it. Host-side policy belongs in a hand-written
module.

### Narrowing the module handle

Host modules hold `ProjectMModuleLike` (`Partial<ProjectMModule>`) because they
feature-detect before use, but the generated wrappers take a full
`ProjectMModule`. Bridge that with a readiness-checked type predicate rather
than widening the shared type or reaching for `any`:

```js
/**
 * @param {ProjectMModuleLike | null | undefined} m
 * @returns {m is ProjectMModule}
 */
function hasTransitionApi(m) {
    return !!(m && m._dual_fbo_begin_transition && m._transition_start);
}
```

One wrinkle worth knowing before you write the probe: manifest entries declared
`ccall` (e.g. `load_preset_file`, `shader_cache_begin_load`) get **no**
`_`-prefixed member on the generated `ProjectMModule` type, even though they are
in `EXPORTED_FUNCTIONS` and callable at runtime. Probing `m._load_preset_file`
is therefore a type error, not a real absence — test `m.ccall`, or a sibling
`direct` entry from the same manifest block.

Unit tests live under `tests/web/` and run via
`scripts/test_web_embed.sh` (CI: `build_linux.yml` → `web-embed` job). Coverage
includes PCM origin allowlist + channel trim, WASM script soft-404 fallback,
preset URL fetch/VFS mocks, COI init-error shapes, context canvas/destroy
behavior, exclusive audio-source policy, and dual-FBO transition readiness
ordering.

## Review Checklist

Every HTML-facing PR should state which hosts are affected and which shared modules changed. At minimum, check:

- Does the change affect `projectm-core.html`, panel hosts, full hosts, or the test harness?
- Does Random Preset still go through `projectm-presets.js`?
- Does the custom preset picker still load through `projectm-preset-picker.js`, and is `custom_presets_manifest.json` regenerated if `custom_milk_fixed/` or the capture baseline changed?
- Does external PCM still go through `projectm-external-pcm.js`?
- Does FLAC/MOD UI still go through `projectm-audio-player.js`?
- If layout changed, was panel2 bezel calibration preserved or intentionally updated?
- Does `projectm-core.html` still pass `scripts/check_core_host_public_api.sh` (no new raw `Module._`/`Module.ccall` public-API calls)?
