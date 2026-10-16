# Host page flags

Every URL flag the first-party host pages (`html/projectm-core.html`,
`html/projectm_panel2.1ink`, the embed demos) honour, with the attribute,
page-global and `localStorage` fallbacks each one has.

The registry is `HOST_FLAGS` in [`html/projectm-host-config.js`](../html/projectm-host-config.js);
modules read a flag with `readHostFlag(name)` or the whole set with
`getHostConfig()` instead of parsing `location.search` themselves.

**Precedence.** For each flag, the tiers it lists are read left to right and
the first value the flag accepts wins. A value it does not accept (a garbled
`?targetFps=abc`, an unknown `?meshQuality=medium`) falls through to the next
tier instead of becoming the default, so it cannot mask a stored preference.

The `<project-m-visualizer>` element's own attributes are a separate surface,
documented in [`docs/WASM_JS_API.md`](WASM_JS_API.md) and parsed by
`html/projectm-element-attributes.js`.

The table below is generated from the registry. After changing a flag, run

```bash
UPDATE_HOST_FLAGS_DOC=1 node --test tests/web/projectm-host-config.test.mjs
```

and commit the result; `npm test` fails while the two disagree.

<!-- host-flags:begin -->
| Flag | Sources (first accepted wins) | Values | Default | Effect | Read by |
|------|-------------------------------|--------|---------|--------|---------|
| `wasm` | `?wasm=` → localStorage `projectm-wasm-version` | build tag, e.g. `039` | — | WASM bundle version to load (the hosts add the default when it is missing). | `projectm-init.js` |
| `renderWorker` | `?renderWorker=` → localStorage `renderWorker` | `0` / `1` | `true` | Render in an OffscreenCanvas worker (default) or on the main thread. | `projectm-render-worker-host.js` |
| `aa` | `?aa=` → localStorage `canvasAA` | `1`/`true`, `0`/`false` | `false` | Multisampled canvas (MSAA). | `projectm-core-host.js` |
| `capture` | `?capture=` → `window.__projectMCaptureMode` | `1`/`true` | `false` | Keep a readable back buffer (preserveDrawingBuffer) for screenshots and readback. | `projectm-core-host.js` |
| `depth` | `?depth=` | `1`/`true` | `false` | Give the canvas a depth+stencil attachment (off by default since #246). | `projectm-core-host.js` |
| `fboPrecision` | `?fboPrecision=` | `half` (RGBA16F), `high` (RGBA32F), `byte` (RGBA8) | `half` | Dual-FBO colour format. | `projectm-core-host.js` |
| `transparent` | `?transparent=` → localStorage `projectm:transparencyMode` | `1`/`true` | `false` | Start in glass-layer transparency mode (near-black pixels show the page). | `projectm-core-host.js` |
| `blurPath` | `?blurPath=` | `copy` | `default` | Blur via the copy path instead of the dedicated blur pass (A/B ablation). | `projectm-render-worker-host.js` |
| `copyPath` | `?copyPath=` | `shader` | `default` | Texture copies through a shader instead of glBlitFramebuffer (A/B ablation). | `projectm-render-worker-host.js` |
| `perPixelEval` | `?perPixelEval=` | `cpu` | `default` | Evaluate per-pixel equations on the CPU even when the GPU path compiled. | `projectm-render-worker-host.js` |
| `targetFps` | `?targetFps=` → localStorage `targetFps` | positive integer | `60` | Render target frame rate. | `projectm-fps-governor.js`, `projectm-core-host.js` |
| `governor` | `?governor=` → localStorage `qualityGovernor` | `1`/`true`, `0`/`false` | `true` | Adaptive quality governor (render scale / blur cap under load). | `projectm-fps-governor.js`, `projectm-core-host.js` |
| `meshQuality` | `?meshQuality=` → localStorage `meshQuality` | `auto`, `low`, `high` | `auto` | Per-pixel mesh size; `auto` picks from navigator.hardwareConcurrency. | `projectm-mesh-quality.js`, `projectm-core-host.js` |
| `presetApi` | `?presetApi=` → `window.PROJECTM_PRESET_API_BASE` → localStorage `apiBase` | URL | `https://storage.noahcohn.com` | Preset API base URL. | `projectm-presets.js` |
| `presetDuration` | `?presetDuration=` | seconds, >= 5 | `40` | Interval of the host's automatic random-preset switch. | `projectm-core-host.js` |
| `localPresets` | `?localPresets=` | `1` | `false` | Show the local .milk loader (drag-and-drop into the preset VFS) and the dev panel. | `projectm-core-host.js`, `projectm-preset-dev.js` |
| `devPreset` | `?devPreset=` | `1` | `false` | Preset hot-reload panel (inline editor + URL polling). | `projectm-preset-dev.js` |
| `devPresetUrl` | `?devPresetUrl=` | URL | `` | Preset URL the hot-reload panel fetches. | `projectm-preset-dev.js` |
| `devPoll` | `?devPoll=` | `1` | `false` | Start polling `devPresetUrl` immediately. | `projectm-preset-dev.js` |
| `devPollMs` | `?devPollMs=` | milliseconds (min 500) | `2000` | Hot-reload poll interval. | `projectm-preset-dev.js` |
| `switchOn` | `?switchOn=` | `timer`, `bars`, `section` | `timer` | Switch presets on the timer, every N bars, or on a detected section change. | `projectm-core-host.js` |
| `switchBars` | `?switchBars=` | positive integer | `16` | Phrase length for `switchOn=bars`. | `projectm-core-host.js` |
| `transitionBeats` | `?transitionBeats=` | beats | `0` | Crossfade length in beats (0 = seconds). | `projectm-core-host.js` |
| `bpm` | `?bpm=` | BPM | `0` | Known tempo instead of the estimate (0 = estimate). | `projectm-core-host.js` |
| `rhythmDebug` | `?rhythmDebug=` | `1` | `false` | Log beats, bars and section changes to the console. | `projectm-core-host.js` |
| `perfhud` | `?perfhud=` | `1` | `false` | On-canvas performance HUD. | `projectm-perf.js` |
| `pcmhud` | `?pcmhud=` → localStorage `projectm-pcm-hud` | `1` | `false` | PCM ingest HUD (ring fill, producer, dropped chunks). | `projectm-pcm-hud.js` |
| `benchmark` | `?benchmark=` | `1` | `false` | Run the frame-time benchmark and report p50/p95 (implies `perfhud`). | `projectm-perf.js` |
| `frames` | `?frames=` | positive integer | `500` | Frames the benchmark samples. | `projectm-perf.js` |
| `preset` | `?preset=` | preset path | — | Preset the benchmark loads first. | `projectm-perf.js` |
| `crossfade` | `?crossfade=` | `1` | `false` | Benchmark only frames rendered during a crossfade (main-thread topology). | `projectm-perf.js` |
| `crossfadeSec` | `?crossfadeSec=` | seconds (min 0.5) | `20` | Crossfade length for the crossfade benchmark. | `projectm-perf.js` |
| `crossfadePresets` | `?crossfadePresets=` | comma-separated preset paths | — | Presets the crossfade benchmark alternates between. | `projectm-perf.js` |
| `presetSwitchBench` | `?presetSwitchBench=` | `1` | `false` | Time preset switches over the featured pack (main-thread topology). | `projectm-perf.js` |
| `audioTest` | `?audioTest=` | `1` | `false` | Synthetic-audio panel (silence/bass/mid/treble/beat/sweep feeds). | `projectm-synthetic-audio.js` |
| `simulateInitFail` | `?simulateInitFail=` | `1` | `false` | Show the init-error overlay without a real failure (UI testing). | `projectm-init-errors.js` |
| `debugSender` | `?debugSender=` | present | `false` | Log external PCM senders off localhost too. | `projectm-core-host.js` |
| `experimental` | `?experimental=` | `1` | `false` | Experimental bridge (depth module, metadata hooks). | `projectm-experimental-bridge.js` |
| `depthModule` | `?depthModule=` | URL | — | Depth-estimation module the experimental bridge loads. | `projectm-experimental-bridge.js` |
| `mode` | `?mode=` | `weeks_on_fire` | — | Themed host mode (preset/song/texture folders and title). | `projectm-weeks-on-fire.js` |
<!-- host-flags:end -->
