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
| Canonical (recommended) | `./pm/projectm-v.036-thread.js` | `./pm/projectm-v.036-thread.wasm` |
| Legacy root mirror | `./projectm-v.036-thread.js` | `./projectm-v.036-thread.wasm` |

Pin the bundle version with `PROJECTM_WASM_BUNDLE` in `html/projectm-wasm-version.js` (currently **`036`**). Override per element with `wasm-base-url` or `wasm-script-url`.

First-party CDN default: `https://projectm.1ink.us` (see `buildProjectMWasmUrls()`).

#### Self-hosting the artifacts

The package ships a `projectm-fetch-wasm` bin that downloads the pinned bundle
into your static directory and records a lockfile, so you can serve the WASM from
your own origin, work offline, and pin independently of whatever the CDN serves
today:

```bash
npx projectm-fetch-wasm --out public/pm            # download glue + .wasm + lockfile
npx projectm-fetch-wasm --out public/pm --verify   # re-check hashes in CI, no network
```

`projectm-wasm.lock.json` records each file's SHA-256 and an SRI `integrity`
string. Commit it. The layout written is the first candidate
`resolveWasmScriptUrl()` probes, so pointing the element at the **parent** of
that directory is all the wiring needed:

```html
<project-m-visualizer wasm-base-url="/"></project-m-visualizer>
<!-- with files served from /pm/ -->
```

> **Version note.** `--version` defaults to `036`, the tag the runtime resolver
> asks for. The first-party hosts currently default to `032`
> (`PROJECTM_WASM_DEFAULT_VERSION`) because 036 has open audio and framerate
> regressions. If you hit those, `--version 032` fetches the older bundle — it
> lives at the site root as a UTF-16 `.1ijs` glue script rather than under `pm/`,
> and the tool handles that layout difference for you. This split is the one
> thing an embedder has to make a decision about today.

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
    viz.addEventListener('pm-audio-source', (e) => console.debug('audio', e.detail));
  </script>
</body>
</html>
```

See [`html/embed-demo.html`](../../html/embed-demo.html) for a self-contained example in this repo.
For two visualizers on one page, either share one Module (lower memory) with
`bootProjectMSharedModule()` + a `sharedModule` per context — see
[`html/embed-multi-same-module.html`](../../html/embed-multi-same-module.html) — or, for full
isolation / more than two engines, use the
[iframe multi-embed recipe](../../html/embed-multi-iframe.html) (one Module per iframe).

## npm / TypeScript

```javascript
import { registerProjectMElement } from '@projectm/web';
import { createProjectMContext } from '@projectm/web/context';
import { PROJECTM_WASM_BUNDLE, buildProjectMWasmUrls } from '@projectm/web/wasm-version';
```

Type-checking: `bash scripts/check_html_types.sh` (includes context + element typings).

### Types are generated, never hand-written

Every `.d.ts` this package ships is emitted by `tsc --emitDeclarationOnly`
(`tsconfig.build.json`) from the vendored `dist/` closure, as part of
`npm run build`. There is no hand-maintained type surface to drift: the JSDoc on
`html/*.js` and the `*-types.ts` companions are the single source, exactly as
`html/generated/projectm-wasm-api.ts` is generated from
`cmake/WasmApiManifest.cmake`.

The hand-written `types/*.d.ts` shims this replaced had already drifted —
`types/entry.d.ts` re-exported the context API from the `.` entry point, whose
runtime module (`projectm-element.js`) does not export it, so
`import { ProjectMContext } from '@projectm/web'` type-checked and then failed at
run time. Import it from `@projectm/web/context`.

### Public API stability

The `public` symbols in `cmake/WasmApiManifest.cmake` are held to this package's
version by `scripts/check_wasm_public_api.sh` (`npm run check:api`, run in CI).
Removing a public symbol or changing its signature requires a version bump here;
see [docs/WASM_JS_API.md](../../docs/WASM_JS_API.md#visibility-tiers).

### Framework wrappers

`<project-m-visualizer>` is a custom element, so these are thin. They exist for
the two things frameworks get wrong about custom elements: object and boolean
props (React stringifies an array to `[object Object]`; an attribute set to the
string `"false"` still reads as present), and `on*` handlers, which no
framework's prop system connects to a `CustomEvent`.

All three take the same camelCase props, derived from `OBSERVED_ATTRIBUTES` so
they cannot fall behind the element, plus `onReady`, `onError`,
`onPresetChanged`, `onFps` and `onAudioSource`, which receive `event.detail`.

**React** (`react >= 17` as an optional peer dependency):

```jsx
import { ProjectMVisualizer } from '@projectm/web/react';

<ProjectMVisualizer
  presetUrl="/presets/000-empty.milk"
  audioSource="external"
  externalPcmOrigins={['https://your-player.example']}
  transparent
  onReady={() => console.log('ready')}
  onError={(detail) => console.error(detail)}
/>
```

**Svelte** (an action; works on the element itself or on a wrapper node):

```svelte
<script>
  import { projectM } from '@projectm/web/svelte';
</script>

<project-m-visualizer use:projectM={{ presetUrl, onReady }} />
```

**Vue 3** (a directive):

```js
import { vProjectM } from '@projectm/web/vue';
app.directive('projectm', vProjectM);
// Vue also needs to be told the tag is a custom element, or it warns on render:
//   compilerOptions.isCustomElement = (tag) => tag === 'project-m-visualizer'
```

```vue
<project-m-visualizer v-projectm="{ presetUrl, onReady }" />
```

Wrapper sources live in `packages/web/src/` (they have no `html/` counterpart),
are type-checked by `tsconfig.src.json`, and are covered by
`tests/web/projectm-web-wrappers.test.mjs`.

### Playground

A live page with a control for every attribute, an event log, and an embed
snippet that updates as you change them — HTML, React, Svelte and Vue flavours:

```bash
npm run build                                      # in packages/web
node scripts/fetch-wasm.mjs --out playground/pm    # the engine itself
npm run playground                                 # http://localhost:8173
```

It loads `dist/`, not `html/`, so what it exercises is what an embedder installs.

`scripts/serve-playground.mjs` exists because of the single most common way a
first embed appears broken: `python -m http.server` and friends send no
COOP/COEP, `SharedArrayBuffer` is then unavailable, and the engine fails with
init error code 4 before drawing anything. The page detects that case and says
so rather than showing a black rectangle.

The page is plain static HTML and will run from any cross-origin-isolated
origin. Note that **GitHub Pages cannot serve it** — it does not let you set
COOP/COEP — so a hosted playground needs either an origin you control (the
first-party host already sends these headers) or a `coi-serviceworker`-style
shim.

### Script tag (no bundler)

`dist/projectm-web.iife.js` is a single minified file that defines the element
and exposes the same exports on a `projectM` global:

```html
<script src="/node_modules/@projectm/web/dist/projectm-web.iife.js"></script>
```

Serve the whole `dist/` directory: the render worker is fetched by URL relative
to the script, and so is the default WASM base.

### Packaging / publishing

The published package is **self-contained** — it does not reference monorepo
(`../../html/...`) paths, so `npm pack` / `npm install @projectm/web` work for
third parties. `scripts/build.mjs` runs three stages:

1. **vendor** — follow the real import closure from `projectm-element.js` into
   `staging/`, so the file list cannot drift from source;
2. **declare** — emit `dist/types/**/*.d.ts` from the staged copies;
3. **bundle** — esbuild to minified, source-mapped ESM (code-split, so importing
   both `.` and `./context` shares one copy of the module-level state) plus the
   IIFE build.

```bash
npm run build      # regenerate dist/ from ../../html
npm pack --dry-run # inspect the tarball contents
```

`dist/` and `staging/` are git-ignored; `prepack` rebuilds, so `npm publish`
always ships fresh output. Publishing runs from a `web-v<version>` tag through
`.github/workflows/publish_web_package.yml`, with `npm publish --provenance`.

Two things about the layout are load-bearing, and
`tests/web/projectm-web-package.test.mjs` asserts both:

- **Every emitted module stays flat in `dist/`.** `import.meta.url` survives
  bundling into shared chunks, and both the render worker URL and the default
  WASM base resolve against the containing file's directory. A `chunks/`
  subdirectory would make both resolve one level too deep.
- **`dist/projectm-render-worker.js` is never bundled into a module.** It is a
  classic worker loaded by URL, invisible to the import-graph scan, and it was
  absent from the package entirely before — the worker render topology 404'd for
  every npm consumer and silently fell back to the main thread.

The `.wasm`/glue artifacts are still **not** in the tarball — fetch them with
`projectm-fetch-wasm` or host them yourself (see
[WASM artifacts](#wasm-artifacts)).

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
| `pm-audio-source` | `{ activeSource, mode, streamEnabled, externalEnabled, workletAllowed }` |

### Methods

- `ready()` → `Promise<ProjectMContext>`
- `loadPreset(url)`
- `loadPresetFile(file)`
- `nextPreset()`

## Limitations (v0.1)

- **Up to two engines per Module (v1 cap)**: host state now lives in a per-instance `WasmHost`, so two visualizers (A/B, compare-two-presets) can share one Module — boot it with `bootProjectMSharedModule()` and pass each `ProjectMContext` / `<project-m-visualizer>` a `sharedModule` (see [`html/embed-multi-same-module.html`](../../html/embed-multi-same-module.html)). `create_host()` past `max_host_count()` (2) returns 0. Audio (the Web Audio worklet / analyser) is still process-global, so the second engine is visual-only unless the host routes PCM to it. For more than two engines or full isolation, use **one cross-origin-isolated iframe per visualizer** (**256 MiB** `INITIAL_MEMORY` per Module, growable to 4 GiB — see [docs/EMSCRIPTEN.md](../../docs/EMSCRIPTEN.md#multi-instance-host-state)).
- **No SharedArrayBuffer polyfill**: non-isolated pages cannot run this build.
- **WASM not bundled**: host or CDN must serve version-pinned artifacts. `npx projectm-fetch-wasm` writes them into your static directory with a verifiable lockfile.
- Full panel chrome and experimental hooks remain in first-party hosts only. The **render worker** now ships (it previously did not), so the OffscreenCanvas topology is available to embedders.

## Related docs

- [docs/WASM_JS_API.md](../../docs/WASM_JS_API.md) — stable codegen API tier
- [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) — deploy + COOP/COEP
- [html/README.md](../../html/README.md) — host architecture
