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
- `projectm-context.js`: typed **embed context API** (`ProjectMContext`) — WASM bootstrap, resize/DPR, presets, audio modes, transparency.
- `projectm-element.js`: **`<project-m-visualizer>`** custom element + lifecycle events (`pm-ready`, `pm-preset-changed`, `pm-error`, `pm-fps`).
- `projectm-wasm-version.js`: canonical WASM bundle version + CDN URL helpers (keep in sync with deploy scripts).
- `projectm-transitions.js`: readiness polling before starting dual-FBO transitions.
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
**legacy full hosts** remain for extended experiments and are on the
deprecation path below.

### Core / canonical

- `projectm-core.html`: reference core shell. Markup + panel chrome only; all
  public engine operations (init, `start_render`, resize/`set_window_size`,
  `set_aspect_correction`, preset load/add, preset lock, transparency) go
  through the generated WASM API (`generated/projectm-wasm-api.js`) or shared
  modules — **no raw `Module._<sym>` / `Module.ccall(...)` public-API calls**.
  Enforced by `scripts/check_core_host_public_api.sh`
  (CI: `.github/workflows/host_layer_gate.yml`). Render-worker/perf internals
  that proxy ccalls through the render-worker handle are the only temporarily
  allowed exception, and they do not touch the `Module` object directly.
- `embed-demo.html`: minimal third-party embed demo using
  `<project-m-visualizer>` (see `packages/web/README.md`). The custom element
  and `ProjectMContext` (`projectm-context.js`) are the intended init path for
  new hosts.

### Panel hosts

- `projectm_panel.1ink`: legacy panel shell.
- `projectm_panel2.1ink`: production bezel host with embedded MOD/FLAC iframe
  sections and current bezel calibration. Supports `?mode=weeks_on_fire` like
  `projectm-core.html`. **Next to migrate** onto the shared host layer (shared
  modules / generated API), preserving calibrated bezel artwork and hotspot
  positions; still owns WASM bootstrap, external PCM, and Weeks-on-Fire mode
  until then.

### Legacy full hosts

- `projectm.1ink`: full legacy shell with extended UI experiments.
- `projectm_new.1ink`: newer full shell used to trial shared modules.
- `projectm_test.1ink`: harness/test page.

Legacy full hosts should converge to thin wrappers or redirect stubs per the
deprecation path below rather than accreting more inline engine calls.

## `.1ink` Deprecation Path

Do not delete the `.1ink` hosts in one sweep. First, move shared behavior into modules and have each host import it. Next, replace repeated chrome with templates or dynamic imports. Once a host is thin enough, turn old `.1ink` names into redirect stubs or build-time composed outputs that point at the canonical shell.

Tracked `.bak` files should not be reintroduced. Use git history for previous versions.

## TypeScript Migration (Epic #163)

`tsconfig.json` runs with `strict: true` and `checkJs: true`. Modules listed in
its `include` are typechecked as part of `scripts/check_html_types.sh` (CI:
`build_linux.yml` / `build_emscripten.yml`) — a type error in any of them fails
the PR.

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

### Converted (checkJs-clean, in `tsconfig.json`)

- `projectm-external-pcm.js`
- `projectm-init.js`, `projectm-init-errors.js`
- `projectm-presets.js`
- `projectm-context.js`, `projectm-element.js` (implementation; shared types
  in `projectm-context-types.ts`)
- `projectm-audio-bootstrap.js`, `projectm-context-loss.js`,
  `projectm-fps-governor.js`, `projectm-mesh-quality.js`,
  `projectm-element-attributes.js`, `projectm-wasm-version.js`

### Not yet converted

`projectm-perf.js`, `projectm-transitions.js`, `projectm-shader-cache.js`,
`projectm-preset-cache.js`, `projectm-preset-dev.js`,
`projectm-preset-favorites.js`, `projectm-preset-library.js`,
`projectm-preset-picker.js`, `projectm-preset-tweaker.js`,
`projectm-render-worker.js`, `projectm-render-worker-host.js`,
`projectm-experimental-bridge.js`, `projectm-fbo-format.js`,
`projectm-synthetic-audio.js`, `projectm-audio-player.js`,
`projectm-weeks-on-fire.js`. Convert module-by-module (add JSDoc, add to
`tsconfig.json`'s `include`, fix errors) rather than adding `checkJs` for all
of them at once — each one surfaces its own batch of implicit-`any` and
Emscripten-boundary casts to work through.

## Review Checklist

Every HTML-facing PR should state which hosts are affected and which shared modules changed. At minimum, check:

- Does the change affect `projectm-core.html`, panel hosts, full hosts, or the test harness?
- Does Random Preset still go through `projectm-presets.js`?
- Does the custom preset picker still load through `projectm-preset-picker.js`, and is `custom_presets_manifest.json` regenerated if `custom_milk_fixed/` or the capture baseline changed?
- Does external PCM still go through `projectm-external-pcm.js`?
- Does FLAC/MOD UI still go through `projectm-audio-player.js`?
- If layout changed, was panel2 bezel calibration preserved or intentionally updated?
- Does `projectm-core.html` still pass `scripts/check_core_host_public_api.sh` (no new raw `Module._`/`Module.ccall` public-API calls)?
