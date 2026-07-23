# @projectm/web

Embeddable **projectM** web integration: a typed context API and `<project-m-visualizer>` custom element that wrap the existing `html/` module graph (WASM bootstrap, resize/DPR, presets, external PCM).

This package is the first step toward third-party embeds without copying `.1ink` hosts.

## Requirements

### Cross-origin isolation (COOP / COEP)

The threaded WASM build uses `SharedArrayBuffer` and pthread Workers. The **host page** must be served with:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

(or `credentialless` for COEP). Without these headers, initialization fails with init error code **4**.

See [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#cross-origin-isolation-coopcoep) for nginx/Caddy/Cloudflare examples.

If you cannot set COOP/COEP on your app origin, embed projectM in a **cross-origin isolated iframe** on a dedicated subdomain that sends the required headers.

### Autoplay / Web Audio

When `audio-source="element"`, browsers block audio until a user gesture. Call `ensureAudioRunning()` from `@projectm/web/context`'s dependency chain, or rely on your own play button before expecting reactivity.

External PCM (`audio-source="external"`) does not use the internal AudioWorklet path; origins are **opt-in** via the `external-pcm-origins` attribute.

### WASM artifacts

JS modules do **not** include the `.wasm` blob. Host one of:

| Layout | Glue script | Binary |
|--------|-------------|--------|
| Canonical (recommended) | `./pm/projectm-v.035-thread.1ijs` | `./pm/projectm-v.035-thread.wasm` |
| Legacy root mirror | `./projectm-v.035-thread.1ijs` | `./projectm-v.035-thread.wasm` |

Pin the bundle version with `PROJECTM_WASM_BUNDLE` in `html/projectm-wasm-version.js` (currently **`035`**). Override per element with `wasm-base-url` or `wasm-script-url`.

First-party CDN default: `https://projectm.1ink.us` (see `buildProjectMWasmUrls()`).

## Quick start (CDN / ES modules)

Serve this page **with COOP/COEP** and place WASM artifacts next to your host (or point `wasm-base-url` at a CDN):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>projectM embed demo</title>
  <style>
    html, body { margin: 0; height: 100%; background: #000; }
    project-m-visualizer { display: block; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <project-m-visualizer
    preset-url="/presets/tests/000-empty.milk"
    audio-source="external"
    external-pcm-origins='["https://your-player.example"]'
    mesh-quality="auto"
    target-fps="60"
  ></project-m-visualizer>

  <script type="module">
    import '../../html/projectm-element.js';

    const viz = document.querySelector('project-m-visualizer');
    viz.addEventListener('pm-ready', () => console.log('projectM ready'));
    viz.addEventListener('pm-error', (e) => console.error(e.detail));
    viz.addEventListener('pm-fps', (e) => console.debug('fps', e.detail.fps));
  </script>
</body>
</html>
```

See [`html/embed-demo.html`](../../html/embed-demo.html) for a self-contained example in this repo.
For two visualizers on one page, use the [iframe multi-embed recipe](../../html/embed-multi-iframe.html)
(one Module instance per iframe — see Limitations below).

## npm / TypeScript

```javascript
import { registerProjectMElement } from '@projectm/web';
import { createProjectMContext } from '@projectm/web/context';
import { PROJECTM_WASM_BUNDLE, buildProjectMWasmUrls } from '@projectm/web/wasm-version';
```

Type-checking: `bash scripts/check_html_types.sh` (includes context + element typings).

### Packaging / publishing

The published package is **self-contained** — it does not reference monorepo
(`../../html/...`) paths, so `npm pack` / `npm install @projectm/web` work for
third parties. The `html/` module graph is vendored into a package-local
`dist/` by a build step that follows the real import closure from
`projectm-element.js` (so it can't drift from source):

```bash
npm run build      # regenerate dist/ from ../../html
npm pack --dry-run # inspect the tarball contents
```

`dist/` is git-ignored and regenerated automatically on `prepack`, so
`npm publish` always ships fresh vendored sources. The `.wasm`/glue artifacts
are still **not** bundled — host them yourself (see [WASM artifacts](#wasm-artifacts)).

## Custom element API

### Attributes

| Attribute | Description |
|-----------|-------------|
| `preset-url` | HTTP(S) URL of a `.milk` preset to load after init |
| `audio-source` | `none` (default), `element`, or `external` |
| `audio-element` | CSS selector or `#id` for `HTMLMediaElement` when `audio-source="element"` |
| `wasm-base-url` | Base URL for WASM glue resolution (defaults to module URL) |
| `wasm-script-url` | Explicit glue `.1ijs` URL (skips pm/ probe) |
| `mesh-quality` | `auto`, `high`, or `low` |
| `target-fps` | Target frame rate (default `60`) |
| `transparent` | Enable near-black transparency mode |
| `locked` | Lock preset (no auto-switch) |
| `require-cross-origin-isolation` | When `"false"`, skip the COOP/COEP pre-check (WASM may still fail) |
| `external-pcm-origins` | JSON array or comma-separated origin allowlist for `postMessage` PCM |

### Events

| Event | Detail |
|-------|--------|
| `pm-ready` | Engine started |
| `pm-preset-changed` | `{ name, path?, url? }` |
| `pm-error` | `{ code, message, error? }` |
| `pm-fps` | `{ fps }` (once per second) |

### Methods

- `ready()` → `Promise<ProjectMContext>`
- `loadPreset(url)`
- `loadPresetFile(file)`
- `nextPreset()`

## Limitations (v0.1)

- **One visualizer per Module / document**: host state (`AppData`) is still process-global. Canvas CSS selectors are configurable (`init_with_canvases` / unique ids from `<project-m-visualizer>`), and `rebind_canvases()` can switch the active surface, but two simultaneous engines in one Module are not supported. For dashboards / multi-deck embeds, use **one cross-origin-isolated iframe per visualizer** (≈1 GiB `INITIAL_MEMORY` per Module instance — see [docs/EMSCRIPTEN.md](../../docs/EMSCRIPTEN.md#configurable-canvas-selectors)).
- **No SharedArrayBuffer polyfill**: non-isolated pages cannot run this build.
- **WASM not bundled**: host or CDN must serve version-pinned artifacts.
- Full panel chrome, render worker, and experimental hooks remain in first-party hosts only.

## Related docs

- [docs/WASM_JS_API.md](../../docs/WASM_JS_API.md) — stable codegen API tier
- [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) — deploy + COOP/COEP
- [html/README.md](../../html/README.md) — host architecture
