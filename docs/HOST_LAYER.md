# The browser host layer

`html/` holds the browser host: the ES modules that boot the WASM engine, size
its canvas, feed it audio and build the page chrome. `packages/web/` is the
publishable embed SDK built from it. This page records the rules for who owns
which state, and the TypeScript strategy. Testing and gates are in `AGENTS.md`
("Browser host-layer tests").

## One owner per piece of state

Bugs #310 and #311 had the same cause: several pieces of code owned the same
state. Each piece now has exactly one owner:

| State | Owner | Everyone else |
|-------|-------|---------------|
| Canvas backing store + CSS box | `ProjectMContext.resize()` → `syncCanvasSize()` (`html/context/render.js`) | The app shell lays out `#contain1` and calls `resize()` only when aspect correction changes. Nothing else assigns `canvas.width`. |
| Container / DPR observation | `followContainerSize()`: one `ResizeObserver` on `device-pixel-content-box` (content box fallback) + `watchDevicePixelRatio()` | Nothing else observes `#contain1`. The shell listens for window resizes only to re-run the bezel layout. |
| Governor render scale | `ProjectMContext` (subscribes to `pmOnGovernorRenderScaleChange`) | `setupFpsGovernor()` reports the scale, it does not resize. |
| External audio players | `createAudioPlayerController()` (`html/projectm-audio-player.js`) | Every page uses it. It owns every window and frame it opens. |
| Page globals | `claimGlobal()`, or the single owner named in `OWNED_GLOBALS` (`scripts/check_host_globals.sh`) | ESLint and `check_host_globals.sh` reject other writes to `window`/`globalThis`/`self`/`windowRef`. |

`syncCanvasSize()` assigns `width`/`height` only when they change, because each
assignment clears the drawing buffer.

Each `install*()`/`setup*()` returns a disposer, and the caller (usually the
app shell's `owned` list) keeps it. That includes page-once guards: disposing
clears the guard, so a dispose followed by a new boot installs again.

### Z-index scale

The pages define the chrome's stacking order once, as CSS custom properties on
`:root`:

| Property | Value | Used by |
|----------|-------|---------|
| `--pm-z-visualizer` | 3200 | bezel/glass layers |
| `--pm-z-player` | 3250 | player sections and the controller's docked frame |
| `--pm-z-panel` | 3300 | the control panel |

Player chrome stays below the panel, so the audio button can always switch
players or close them.

## Module size

No module in `html/` should be over 700 lines, the same rule `src/wasm/`
follows. To split a module, move cohesive parts into a subdirectory, as
`html/context/` does for `projectm-context.js`. Keep the original file as the
entry point, so import paths stay stable.

## `html/flac-player/` holds a webpack build of an external app

`html/flac-player/` is the output of the separate `flac_player` app (webpack), not source
maintained here. It ships **two** content-hashed bundles, and both are live:

- `bundle.<hash>.js` (today `1be0…`): the main bundle, the only script `boot.js` loads.
- `bundle.<hash>.js` (today `4f00…`): the **FLAC decoder Web Worker chunk**. Nothing in `html/`
  loads it by name (only comments mention the hash); the main bundle starts it with `new Worker(new URL(…))`, and webpack's
  chunk-name table (`__webpack_require__.u`) inside the main bundle holds its file name.
  `decode-guard.js` and `tests/web/flac-decode-claws.test.mjs` describe its message protocol.

So a file with no inbound reference is not an orphan here: grep the main bundle for the hash before
deleting one. Deleting the worker chunk makes every FLAC decode fail. When the external app is
rebuilt, replace **both** files together (the main bundle's table names the worker chunk it needs);
`deploy.py` uploads the whole directory (`html/flac-player/**/*`), so a stale chunk left behind is
the only way an old hash stays deployed.

## TypeScript strategy (decision record, 2026-11)

**Decision: do not convert `html/` to `.ts` wholesale.**

`html/` is deployed as unbundled static ES modules: the deploy uploads the
files as they are, and pages load them by URL. It is already type-checked as
strict `checkJs` (three programs: DOM, worker, AudioWorklet), with no
`ts-ignore` and few `any`. A `.ts` conversion would add a build step to
every deploy and give almost no extra checking.

The rule:

- **Contracts are `.ts` declaration-style files.** That covers the
  render-worker wire protocol, context/transport/host types and events
  (`projectm-*-types.ts`, `generated/projectm-wasm-api.ts`). They contain
  types only, and runtime code imports them through JSDoc `import('…')`.
- **Runtime stays JSDoc-typed JS** in `html/`.
- **`packages/web/src` may move to real `.ts`**, since it already has a build
  (esbuild + `tsc --emitDeclarationOnly`).

Ratchet, one step per change. Never take a step back:

1. ✅ `noUnusedLocals` in all three programs (`tsconfig.worker.json` was the
   last).
2. `// @ts-check` in `tests/web/*.mjs`, one file at a time.
3. `noUncheckedIndexedAccess`.
4. An ESLint rule that bans new `any`.

Agents: do not propose a big-bang `.ts` migration of `html/`. Take the next
ratchet step instead.
