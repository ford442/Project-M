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

## TypeScript strategy (decision record, 2026-11, amended)

**Decision: TypeScript where a type system pays for itself, JSDoc elsewhere.
Never a wholesale conversion.**

`html/` is deployed as unbundled static ES modules: pages load the files by
URL. The JSDoc modules are strict `checkJs`, with no `ts-ignore` and few `any`,
and for a leaf module (a panel, a loader, a HUD) that is all the checking there
is to have. It stopped being enough for the protocol core: the largest modules
(the context, the render worker and its bridge, the transport) had reached the
point where JSDoc generics and discriminated unions were painful, and the WASM
boundary was untyped at the ccall (#269's `func is not a function` was a call
that type-checked fine).

The rule:

- **Anything with a wire protocol or a union-typed state machine is `.ts`:**
  `projectm-context.ts` (and `context/options.ts`, `session.ts`, `connect.ts`,
  `recovery.ts`), `projectm-render-transport.ts`, `projectm-render-worker.ts`,
  `projectm-render-worker-host.ts`, `projectm-pcm-ring.ts`. They are held to
  `tsconfig.strict.json` (`strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`) and emitted file by file to the committed `.js`
  next to them (`npm run build:html`, checked by `npm run check:html-build`), so
  deploy names and `import.meta.url` resolution do not change. See
  `html/README.md` "TypeScript modules".
- **The small leaf modules stay JSDoc-typed `.js`.**
- **Types shared by html/ and packages/web live in one workspace package,
  `@projectm/types`** (`packages/types/src`), imported by name; the
  `@projectm/web` build inlines it into its declarations.
- **The WASM boundary is typed by the generator:** `cmake/WasmApiManifest.cmake`
  emits `packages/types/src/wasm-api.d.ts` (`HostHandle`, `ProjectMError`,
  `WasmApiCalls`) alongside the `.js`, and `scripts/check_wasm_api_dts.mjs` keeps
  the manifest, the C++ exports, the `.d.ts`, the `.js` and a linked bundle in
  agreement.

A new module is `.ts` when it posts or receives messages, or holds a state
machine with more than two states; otherwise JSDoc. Converting one is its own
change: `git mv` the `.js` to `.ts`, type it, `npm run build:html`, and make sure
the emitted `.js` passes the same tests.

Ratchet, one step per change. Never take a step back:

1. ✅ `noUnusedLocals` in every program.
2. ✅ `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` in the
   TypeScript programs (`tsconfig.strict.json`, `tsconfig.worker.json`, which
   also covers `worker/*.js`).
3. `// @ts-check` in `tests/web/*.mjs`, one file at a time.
4. `noUncheckedIndexedAccess` in `tsconfig.json` (the JSDoc modules).
5. An ESLint rule that bans new `any`.

Agents: do not propose a big-bang `.ts` migration of `html/`. Convert a module
when it meets the rule above, or take the next ratchet step.
