# projectM HTML Host Architecture

The HTML demo hosts are being migrated from copy-pasted standalone pages to thin shells backed by shared browser modules. Keep changes incremental: extract and share behavior first, then shrink individual hosts once parity is proven.

## Target Shape

### Core Shell

`projectm-core.html` is the reference minimal host. It should own only the visualization surface, WASM bootstrap, sizing, preset loading, and audio ingestion needed to run projectM in a browser.

Core behavior belongs in shared modules:

- `projectm-init.js`: script loading and reusable WASM/canvas bootstrap helpers.
- `projectm-presets.js`: API preset fetch, VFS writes, startup preset loading, and random preset loading.
- `projectm-external-pcm.js`: external MOD/FLAC `postMessage` PCM contract, origin allowlist, queued feeding, and preallocated transfer buffers.
- `projectm-transitions.js`: readiness polling before starting dual-FBO transitions.

### Panel Chrome

Panel controls, bezels, buttons, and embedded player sections are optional chrome layered over the core shell. They should be loaded from templates or small controller modules rather than pasted into every host.

Current shared panel behavior:

- `projectm-audio-player.js`: FLAC/MOD section cycling and popup player controls.

Preserve calibrated panel2 bezel artwork and hotspot positions when moving chrome into templates. Layout extraction should not retune artwork unless the change is explicitly about calibration.

### Extended Features

Full UI features such as GLTF, depth, image pipelines, and experimental render controls should be lazy-loaded modules. They should not become required dependencies for `projectm-core.html` or panel-only hosts.

Keep remote asset endpoints configurable. Existing pages read `localStorage.apiBase`; new modules should continue accepting explicit API bases or localStorage-derived values.

## Host Roles

- `projectm-core.html`: reference core shell.
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
- Does external PCM still go through `projectm-external-pcm.js`?
- Does FLAC/MOD UI still go through `projectm-audio-player.js`?
- If layout changed, was panel2 bezel calibration preserved or intentionally updated?
