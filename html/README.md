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

- `projectm-core.html`: reference core shell.
- `embed-demo.html`: minimal third-party embed demo using `<project-m-visualizer>` (see `packages/web/README.md`).
- `projectm_panel.1ink`: legacy panel shell.
- `projectm_panel2.1ink`: panel shell with embedded MOD/FLAC iframe sections and current bezel calibration.
- `projectm.1ink`: full legacy shell with extended UI experiments.
- `projectm_new.1ink`: newer full shell used to trial shared modules.
- `projectm_test.1ink`: harness/test page.

## `.1ink` Deprecation Path

Do not delete the `.1ink` hosts in one sweep. First, move shared behavior into modules and have each host import it. Next, replace repeated chrome with templates or dynamic imports. Once a host is thin enough, turn old `.1ink` names into redirect stubs or build-time composed outputs that point at the canonical shell.

Tracked `.bak` files should not be reintroduced. Use git history for previous versions.

## Review Checklist

Every HTML-facing PR should state which hosts are affected and which shared modules changed. At minimum, check:

- Does the change affect `projectm-core.html`, panel hosts, full hosts, or the test harness?
- Does Random Preset still go through `projectm-presets.js`?
- Does the custom preset picker still load through `projectm-preset-picker.js`, and is `custom_presets_manifest.json` regenerated if `custom_milk_fixed/` or the capture baseline changed?
- Does external PCM still go through `projectm-external-pcm.js`?
- Does FLAC/MOD UI still go through `projectm-audio-player.js`?
- If layout changed, was panel2 bezel calibration preserved or intentionally updated?
