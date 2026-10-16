// projectm-context-boot.js
//
// ProjectMContext#start()'s boot sequence, as an ordered list of named steps.
//
// It used to be one 300-line method. A failure part-way through was unwound by
// the context's flat list of disposers, which worked, but nothing said which
// stage had acquired what, and adding a stage meant threading new state through
// the middle of that method. Each stage is a step now:
//
//   { name, run(ctx, signal, own), undo() }
//
// `run` does the stage's work and registers every release it needs with `own`
// (the step's own list); `undo` runs those releases, newest first, and is
// idempotent. runBootSteps() runs the steps in order and, when one throws (or
// the boot is aborted between steps), undoes every step that started, newest
// first, before rethrowing — so a failed boot leaves nothing behind. Each step's
// undo is also registered with the context as it starts, so destroy() — mid-boot
// or after it — releases the same things in the same order.
//
// The engine itself (Module, render worker, host handle) is not a step's to
// free: ProjectMContext#teardownEngine() does that after the step undos, on
// every teardown path, because it also covers a transport that arrives after
// destroy().

import { ensureAudioRunning, setupAudioUnlock } from './projectm-audio-bootstrap.js';
import { ensureWorkletReady, installWorkletPlaybackSafetyNet } from './projectm-worklet-playback.js';
import { connectMediaElement, disconnectMediaElement } from './projectm-audio-element-source.js';
import { audioSourceToRouterSource, createAudioSourceRouter } from './projectm-audio-source-router.js';
import { claimGlobal } from './projectm-globals.js';
import { subscribeWasmCallback } from './projectm-wasm-callbacks.js';
import { setupContextLossRecovery } from './projectm-context-loss.js';
import { defaultFeedPCMToModule, flushQueuedExternalPCM, setExternalPcmTransport, setupExternalAudioReceiver } from './projectm-external-pcm.js';
import { setupPcmHud } from './projectm-pcm-hud.js';
import { getGovernorRenderScale, setQualityGovernorEnabled, setTargetFps } from './projectm-fps-governor.js';
import {
    buildWasmBundlePaths,
    createProjectMModule,
    loadProjectMWasmScript,
    observeModuleSize,
    resolveWasmScriptUrl,
} from './projectm-init.js';
import { loadWasmBuildsManifest } from './projectm-wasm-manifest.js';
import {
    createModuleTransport,
    installTransportPcmWriter,
    installTransportPresetWriter,
    selectRenderTopology,
} from './projectm-render-transport.js';
import { isRenderWorkerEnabled } from './projectm-render-worker-host.js';
import { checkCrossOriginIsolation, checkInit, INIT_CONTEXT_LOST } from './projectm-init-errors.js';
import { setMeshQuality } from './projectm-mesh-quality.js';
import { startRender } from './generated/projectm-wasm-api.js';
import { INIT_ERROR } from './generated/projectm-init-error-codes.js';
import { createConfiguredHost, resolveFlashLimit } from './projectm-context-config.js';

/**
 * @typedef {import('./projectm-context.js').ProjectMContext} ProjectMContext
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('./projectm-transport-types.ts').RenderTransport} RenderTransport
 * @typedef {import('./projectm-context-types.ts').ProjectMAudioSource} ProjectMAudioSource
 * @typedef {import('./projectm-context-types.ts').ProjectMAudioSourceStatus} ProjectMAudioSourceStatus
 * @typedef {import('./projectm-context-types.ts').ProjectMPresetDetail} ProjectMPresetDetail
 * @typedef {import('./projectm-audio-source-router.js').AudioSourceRouter} AudioSourceRouter
 * @typedef {import('./projectm-rhythm-facade.js').RhythmFacade} RhythmFacade
 */

/**
 * What a ProjectMContext lends its boot steps: the context itself (its public
 * fields: options, canvas, module, transport, hostHandle, ...) and the private
 * operations a step needs, which the context binds when it boots.
 *
 * @typedef {object} BootHost
 * @property {ProjectMContext} context
 * @property {(dispose: (() => void) | null | undefined) => void} own Registers a context-level undo.
 * @property {(signal: AbortSignal) => void} throwIfAborted
 * @property {(error: unknown, code?: number) => void} reportError
 * @property {(message: string) => void} reportRuntimeError
 * @property {(type: string, detail: unknown) => void} emit
 * @property {() => ProjectMModule | null} engine The context's host-bound module view.
 * @property {() => void} teardownEngine
 * @property {() => import('./projectm-render-worker-types.ts').WasmContextConfig} contextConfig
 * @property {() => import('./projectm-render-worker-types.ts').RenderPathOverrides} renderPathOverrides
 * @property {RhythmFacade} rhythm
 */

/**
 * @typedef {(dispose: (() => void) | null | undefined) => void} Own
 * @typedef {{ name: string, run: (ctx: BootHost, signal: AbortSignal) => unknown, undo: () => void }} BootStep
 */

// ---------------------------------------------------------------------------
// Step machinery.
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @param {(ctx: BootHost, signal: AbortSignal, own: Own) => unknown} run
 * @returns {BootStep}
 */
export function bootStep(name, run) {
    /** @type {Array<() => void>} */
    const releases = [];
    /** @type {Own} */
    const own = (dispose) => {
        if (typeof dispose === 'function') {
            releases.push(dispose);
        }
    };
    return {
        name,
        run: (ctx, signal) => run(ctx, signal, own),
        undo() {
            for (const release of releases.splice(0).reverse()) {
                try {
                    release();
                } catch (error) {
                    console.warn(`[ProjectMContext] undoing boot step "${name}" failed:`, error);
                }
            }
        },
    };
}

/**
 * Runs `steps` in order. A step that throws, or an abort noticed between two
 * steps, undoes every step that started (newest first) and rethrows.
 *
 * @param {BootStep[]} steps
 * @param {BootHost} ctx
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
export async function runBootSteps(steps, ctx, signal) {
    /** @type {BootStep[]} */
    const started = [];
    try {
        for (const step of steps) {
            ctx.throwIfAborted(signal);
            started.push(step);
            // Registered before it runs, so a destroy() while it is awaiting
            // releases what it has acquired so far.
            ctx.own(() => step.undo());
            await step.run(ctx, signal);
        }
    } catch (error) {
        for (const step of started.reverse()) {
            step.undo();
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Helpers shared with projectm-context.js.
// ---------------------------------------------------------------------------

/**
 * An error shaped like the one `fetch()` rejects with when aborted, so callers
 * can tell "this was cancelled" from "this failed" by `error.name`.
 *
 * @param {string} message
 * @returns {Error}
 */
export function createAbortError(message) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
    return !!error && typeof error === 'object' && /** @type {{ name?: unknown }} */ (error).name === 'AbortError';
}

/**
 * @param {HTMLMediaElement | string | null | undefined} value
 * @param {Document | undefined} documentRef
 * @returns {HTMLMediaElement | null}
 */
export function resolveMediaElement(value, documentRef) {
    if (!value) {
        return null;
    }
    if (typeof value === 'string') {
        return /** @type {HTMLMediaElement | null} */ (documentRef?.querySelector(value)) ?? null;
    }
    return value;
}

/**
 * Sizes the canvases to their container and tells the engine.
 *
 * @param {{ transport: RenderTransport | null; container: Element; mainCanvas: HTMLCanvasElement; secondaryCanvas?: HTMLCanvasElement | null; aspectCorrection?: boolean; devicePixelRatio?: number; renderScale?: number }} options
 * @returns {boolean}
 */
export function syncCanvasSize({
    transport,
    container,
    mainCanvas,
    secondaryCanvas,
    aspectCorrection,
    devicePixelRatio = globalThis.devicePixelRatio || 1,
    renderScale = 1,
}) {
    if (!transport || !container || !mainCanvas) {
        return false;
    }

    // In the worker topology the canvas has been transferred: assigning to its
    // width/height here throws, and the governor's render scale is applied on
    // the other side (html/projectm-render-worker.js). This thread still owns
    // the CSS box, which is what keeps the present upscale looking the same in
    // both topologies.
    const ownsBackingStore = transport.topology === 'main';

    const rect = container.getBoundingClientRect();
    // The canvas backing store (width/height attributes) is rendered at
    // renderScale * devicePixelRatio, while its CSS box size (style.width/height)
    // always stays at the full, unscaled container size. When renderScale < 1
    // (governor v2 stepped down internal render scale, see
    // html/projectm-fps-governor.js), the browser's own canvas-bitmap-to-CSS-box
    // scaling stretches the smaller backing store to fill the unchanged layout
    // box — this is the "present upscale" for internal FBO render scale; no
    // separate offscreen blit is needed because everything (including the
    // dual-FBO compositor) renders at the backing-store resolution already.
    const scale = renderScale > 0 ? renderScale : 1;
    const layoutWidth = Math.max(1, Math.round(rect.width * devicePixelRatio));
    const layoutHeight = Math.max(1, Math.round(rect.height * devicePixelRatio));
    const width = Math.max(1, Math.round(rect.width * devicePixelRatio * scale));
    const height = Math.max(1, Math.round(rect.height * devicePixelRatio * scale));

    for (const canvas of [mainCanvas, secondaryCanvas]) {
        if (!canvas) continue;
        if (ownsBackingStore) {
            canvas.width = width;
            canvas.height = height;
        }
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
    }

    // The worker scales the layout size by its own copy of the render scale,
    // so sending it the already-scaled size would apply the factor twice.
    transport.resize(
        ownsBackingStore ? width : layoutWidth,
        ownsBackingStore ? height : layoutHeight,
    );
    if (aspectCorrection !== undefined && transport.supports('setAspectCorrection')) {
        transport.callVoid('setAspectCorrection', aspectCorrection);
    }

    return true;
}

/**
 * Whether the transport can make `name`: false on a bundle (or a generated API)
 * that predates it, instead of the throw an unknown name gets.
 *
 * @param {RenderTransport} transport
 * @param {string} name
 */
function canCall(transport, name) {
    try {
        return transport.supports(name);
    } catch {
        return false;
    }
}

/**
 * The `presetDuration` option as set_preset_duration()'s two arguments.
 *
 * @param {import('./projectm-context-types.ts').ProjectMContextOptions['presetDuration']} option
 * @returns {[seconds: number, randomExtra: number] | null}
 */
export function resolvePresetDuration(option) {
    if (option === undefined || option === null) return null;
    const { seconds, randomExtra = 0 } = typeof option === 'number' ? { seconds: option } : option;
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return [seconds, Number.isFinite(randomExtra) && randomExtra > 0 ? randomExtra : 0];
}

/**
 * Boot a single projectM WASM Module *without* initialising an engine, so that
 * several `ProjectMContext` instances can share it and each create their own
 * per-instance host with `create_host()` (#168 Phase B). Pass the returned
 * module to each context as `options.sharedModule`.
 *
 * Two engines in one Module cost one INITIAL_MEMORY reservation instead of one
 * per iframe; see docs/EMSCRIPTEN.md ("Multi-instance host state") for the
 * memory budget and the process-global audio caveat.
 *
 * @param {{
 *   wasmVersion?: string,
 *   wasmBaseUrl?: string,
 *   wasmScriptUrl?: string,
 *   documentRef?: Document,
 *   windowRef?: (Window & typeof globalThis),
 *   primaryCanvasSelector?: string,
 *   secondaryCanvasSelector?: string,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<ProjectMModule>}
 */
export async function bootProjectMSharedModule(options = {}) {
    const {
        wasmVersion,
        wasmBaseUrl,
        wasmScriptUrl,
        documentRef = typeof document !== 'undefined' ? document : undefined,
        windowRef = typeof window !== 'undefined' ? window : undefined,
        primaryCanvasSelector,
        secondaryCanvasSelector,
        signal,
    } = options;

    const resolvedBaseUrl = wasmBaseUrl ?? import.meta.url;
    if (!wasmScriptUrl) {
        await loadWasmBuildsManifest({ baseUrl: resolvedBaseUrl, signal });
    }
    const versionPaths = wasmVersion ? buildWasmBundlePaths(wasmVersion) : null;
    await loadGlue({ documentRef, resolvedBaseUrl, wasmScriptUrl, versionPaths, wasmVersion, signal });

    const module = /** @type {ProjectMModule} */ (await createProjectMModule({
        scriptSrc: wasmScriptUrl || undefined,
        wasmVersion,
        baseUrl: resolvedBaseUrl,
        documentRef,
        windowRef,
        noInitialRun: true,
        primaryCanvasSelector,
        secondaryCanvasSelector,
        signal,
    }));
    if (windowRef) {
        windowRef.Module = module;
    }
    return module;
}

/**
 * Injects the glue script: an explicit URL as-is, else the version's paths
 * (or the default bundle's).
 *
 * @param {{ documentRef: Document | undefined, resolvedBaseUrl: string, wasmScriptUrl: string | undefined, versionPaths: { pmScript: string, rootScript: string } | null, wasmVersion: string | undefined, signal: AbortSignal | undefined }} options
 */
async function loadGlue({ documentRef, resolvedBaseUrl, wasmScriptUrl, versionPaths, wasmVersion, signal }) {
    if (wasmScriptUrl) {
        await loadProjectMWasmScript({
            documentRef,
            baseUrl: resolvedBaseUrl,
            pmScript: wasmScriptUrl,
            rootScript: wasmScriptUrl,
            forceRefresh: true,
            signal,
        });
        return;
    }
    await loadProjectMWasmScript({
        documentRef,
        baseUrl: resolvedBaseUrl,
        ...(versionPaths ? { pmScript: versionPaths.pmScript, rootScript: versionPaths.rootScript } : {}),
        forceRefresh: Boolean(wasmVersion),
        signal,
    });
}

// ---------------------------------------------------------------------------
// The steps.
// ---------------------------------------------------------------------------

/**
 * ProjectMContext's boot, in order. Fresh per boot: a step's undo list is
 * per-attempt state.
 *
 * @returns {BootStep[]}
 */
export function createContextBootSteps() {
    return [
        bootStep('audio-element', ({ context }) => {
            const { audioSource, audioElement, documentRef } = context.options;
            if (audioSource === 'element') {
                const media = resolveMediaElement(audioElement, documentRef);
                if (media) {
                    context.audioElement = media;
                    media.id = media.id || 'audio-stream-element';
                }
            }
        }),

        bootStep('cross-origin-isolation', ({ context, reportError }) => {
            if (context.options.requireCrossOriginIsolation && !checkCrossOriginIsolation()) {
                const error = new Error('Cross-origin isolation is required for this WASM build');
                reportError(error, INIT_ERROR.CROSS_ORIGIN_ISOLATION);
                throw error;
            }
        }),

        bootStep('engine', bootEngine),

        bootStep('host-wiring', (ctx, signal, own) => {
            const { context } = ctx;
            const { documentRef, windowRef, audioSource, onAudioSourceChange, audioRouter } = context.options;
            const transport = /** @type {RenderTransport} */ (context.transport);
            // External PCM arrives on this thread either way; tell it which
            // engine to hand the samples to. A claim, not an assignment: the
            // release leaves a sibling context's registration alone.
            own(setExternalPcmTransport(transport));
            // PCM-rate readout (host ingress, engine/worker drain); overlay with ?pcmhud=1.
            own(setupPcmHud({ transport, windowRef, documentRef }));

            context.audioRouter = attachAudioRouter(ctx, own, audioRouter, transport, audioSource, onAudioSourceChange);

            own(setupAudioUnlock());
            own(installWorkletPlaybackSafetyNet());
            // The worklet runs on this thread in both topologies; this is what
            // decides where its PCM goes.
            own(installTransportPcmWriter(transport));
            // Preset milk is fetched on this thread; the worker owns the VFS.
            own(installTransportPresetWriter(transport));
            // Both topologies: on the main thread the canvas is heard here, in
            // the worker the loss is relayed through the transport.
            own(setupContextLossRecovery(context, { canvas: context.canvas, documentRef, windowRef }));
        }),

        bootStep('flash-limit', ({ context }) => {
            // On before the engine's first frame: a viewer who needs it must
            // never be shown an unlimited one. The worker applied it from its
            // init message already.
            const flashLimit = resolveFlashLimit(context.options);
            const transport = /** @type {RenderTransport} */ (context.transport);
            if (flashLimit && transport.topology === 'main') {
                transport.setFlashLimit(flashLimit.enabled, flashLimit.threshold);
            }
        }),

        // Everything from here drives the engine, through the transport or the
        // host-bound engine view. Both select this context's host on every call,
        // so an await below cannot resume on a sibling's engine.

        bootStep('first-frame', ({ context, engine }) => {
            const transport = /** @type {RenderTransport} */ (context.transport);
            syncCanvasSize({
                transport,
                container: context.container,
                mainCanvas: context.canvas,
                secondaryCanvas: context.secondaryCanvas,
                aspectCorrection: context.options.aspectCorrection,
                devicePixelRatio: context.options.devicePixelRatio,
                renderScale: context.renderScale,
            });
            const view = engine();
            if (view) {
                // The worker calls _start_render() itself, on its own canvas,
                // before it reports ready.
                startRender(view, context.canvas.width, context.canvas.height);
            }
            flushQueuedExternalPCM();
        }),

        bootStep('engine-settings', ({ context, engine, rhythm }) => {
            const { meshQuality, targetFps, qualityGovernor, presetLocked, presetDuration } = context.options;
            const transport = /** @type {RenderTransport} */ (context.transport);
            const view = engine();
            if (view) {
                // Mesh/fps/governor go to the worker in its init message, since
                // it must have them before the first frame. Setting them again
                // over the wire would be a second source of truth.
                setMeshQuality(view, meshQuality);
                setTargetFps(view, targetFps);
                setQualityGovernorEnabled(view, qualityGovernor);
            }
            transport.callVoid('setPresetLocked', presetLocked);
            const duration = resolvePresetDuration(presetDuration);
            if (duration && canCall(transport, 'setPresetDuration')) {
                transport.callVoid('setPresetDuration', ...duration);
            }
            rhythm.applyOptions(context.options);
            rhythm.sync();
        }),

        bootStep('render-scale', ({ context, engine }, signal, own) => {
            // Governor v2 (docs/PERFORMANCE.md): sync the starting render scale,
            // then resize on every tier change (WasmPerfGovernor.cpp pushes via
            // js_governor_report_render_scale()). Shrinking the backing store
            // while keeping its CSS size fixed applies the "internal FBO render
            // scale" tier — see syncCanvasSize().
            //
            // In the worker topology the backing store is not ours to shrink:
            // the worker applies the same factor to the canvas it owns and this
            // thread keeps renderScale at 1 (html/projectm-render-worker.js).
            const view = engine();
            if (!view) return;
            context.renderScale = getGovernorRenderScale(view) || 1;
            // Via the injected windowRef: the engine calls the hook by its
            // global name, so it goes through the callback bus, and the
            // engineHost filter keeps a sibling's tier change off this canvas.
            const { windowRef } = context.options;
            if (windowRef) {
                own(subscribeWasmCallback('pmOnGovernorRenderScaleChange', ({ scale }) => {
                    context.renderScale = scale;
                    context.resize();
                }, windowRef, { engineHost: context.hostHandle }));
            }
        }),

        bootStep('init-error-watch', ({ context, reportError, }, signal, own) => {
            // Surfaces an init failure the engine reports for *this* host after
            // start() — a context-loss recovery whose init() failed, say. A
            // sibling engine's failure is filtered out, and so is a bundle that
            // predates the host argument (it cannot say whose it was).
            const { windowRef } = context.options;
            if (!windowRef || !context.module) return;
            own(subscribeWasmCallback('pmReportInitError', ({ host, code, detail }) => {
                // "Still lost": the context-loss overlay is up and the restore
                // event retries; not a failure to report.
                if (host === null || code === INIT_CONTEXT_LOST || context.destroyed) {
                    return;
                }
                const suffix = detail ? `: ${detail}` : '';
                reportError(new Error(`projectM engine init failed (init code ${code})${suffix}`), code);
            }, windowRef, { engineHost: context.hostHandle }));
        }),

        bootStep('transparency', ({ context }) => {
            const { transparent, transparencyThreshold } = context.options;
            if (!transparent) return;
            const transport = /** @type {RenderTransport} */ (context.transport);
            transport.callVoid('setTransparencyMode', true);
            if (typeof transparencyThreshold === 'number') {
                transport.callVoid('setTransparencyThreshold', transparencyThreshold);
            }
            if (context.secondaryCanvas) {
                context.secondaryCanvas.style.display = 'none';
            }
        }),

        bootStep('audio', (ctx, signal, own) => {
            const { context } = ctx;
            wireAudio(ctx, own, signal);
            if (!context.options.audioRouter && context.audioRouter) {
                context.audioRouter.setModule(context.module);
                context.audioRouter.setTransport(context.transport);
            }
        }),

        bootStep('resize-observer', ({ context }, signal, own) => {
            const observer = observeModuleSize({
                container: context.container,
                sync: () => context.resize(),
            });
            if (observer) {
                context.resizeObserver = observer;
                own(() => {
                    observer.disconnect();
                    context.resizeObserver = null;
                });
                return;
            }
            // No ResizeObserver: fall back to window resizes, on the window the
            // context was told to use, and take the listener off again.
            const target = /** @type {EventTarget | undefined} */ (context.options.windowRef ?? globalThis);
            if (typeof target?.addEventListener === 'function') {
                const onResize = () => context.resize();
                target.addEventListener('resize', onResize);
                own(() => target.removeEventListener('resize', onResize));
            }
        }),

        bootStep('preset-events', ({ context, emit }, signal, own) => {
            const { windowRef, onPresetChanged } = context.options;
            if (!windowRef?.addEventListener) return;
            const listener = (/** @type {Event} */ event) => {
                const detail = /** @type {CustomEvent<ProjectMPresetDetail>} */ (event).detail;
                onPresetChanged?.(detail);
                emit('preset-changed', detail);
            };
            windowRef.addEventListener('pm:preset-loaded', listener);
            own(() => windowRef.removeEventListener('pm:preset-loaded', listener));
        }),

        bootStep('initial-preset', async ({ context, throwIfAborted }, signal) => {
            const { presetUrl } = context.options;
            if (presetUrl) {
                await context.loadPresetUrl(presetUrl);
                throwIfAborted(signal);
            }
        }),

        bootStep('ready', (ctx, signal, own) => {
            const { context, emit } = ctx;
            context.ready = true;
            if (context.options.onFps) {
                startFpsMonitor(ctx, own, context.options.onFps, signal);
            }
            context.options.onReady?.(context);
            emit('ready', undefined);
        }),
    ];
}

/**
 * Picks the engine for this context and brings it up: a host inside a shared
 * Module, the render worker, or a Module on this thread. Leaves
 * `context.transport` (and on this thread `context.module`) set.
 *
 * @param {BootHost} ctx
 * @param {AbortSignal} signal
 * @param {Own} own
 */
async function bootEngine(ctx, signal, own) {
    const { context, throwIfAborted, reportError } = ctx;
    const { wasmScriptUrl, wasmBaseUrl, wasmVersion, documentRef, windowRef, renderTopology, sharedModule } = context.options;

    // Same directory as projectm-context.js, so relative bundle paths resolve alike.
    const resolvedBaseUrl = wasmBaseUrl ?? import.meta.url;
    if (!wasmScriptUrl && !sharedModule) {
        // pm/builds.json names each build's glue and exports; without it (or on
        // timeout) the built-in table is used.
        await loadWasmBuildsManifest({ baseUrl: resolvedBaseUrl, signal });
        throwIfAborted(signal);
    }
    const versionPaths = wasmVersion ? buildWasmBundlePaths(wasmVersion) : null;

    /** Publishes the Module as `window.Module` for legacy readers, claimed. */
    const claimWindowModule = () => {
        if (windowRef && context.module) {
            own(claimGlobal(windowRef, 'Module', context.module));
        }
    };

    if (sharedModule) {
        // Multi-instance path (#168 Phase B): reuse a Module booted by
        // bootProjectMSharedModule() and create a dedicated engine instance in
        // it. The create call carries the context config (render paths
        // included), so a sibling context starting at the same time cannot
        // take it.
        context.module = /** @type {ProjectMModule} */ (sharedModule);
        context.ownsModule = false;
        claimWindowModule();
        applyLegacyRenderPathOverrides(ctx);
        const { handle, code } = createConfiguredHost(context.module, {
            primary: context.primaryCanvasSelector,
            secondary: context.secondaryCanvasSelector || '#scanvas',
            config: ctx.contextConfig(),
        });
        if (!handle) {
            const error = new Error(
                `create_host_with_config() failed (init code ${code}: instance cap reached or engine init failed)`
            );
            reportError(error, code);
            throw error;
        }
        context.hostHandle = handle;
        // Bound to this engine: every call it makes selects `handle` first, so
        // a sibling activating its own engine while this one awaits cannot
        // redirect what comes after.
        context.transport = createModuleTransport(context.module, { host: handle });
        return;
    }

    // Topology first: the render worker takes the canvas by transfer, so it has
    // to be asked before anything on this thread touches a drawing context. A
    // worker that cannot start falls back to the main thread here and the rest
    // of the boot is identical — that is the point of the transport.
    const preferWorker = renderTopology === 'worker'
        || (renderTopology === 'auto' && isRenderWorkerEnabled());
    if (preferWorker) {
        // Assigned before the abort check so a transport that arrives after
        // destroy() is still torn down.
        context.transport = await startRenderWorker(ctx, { resolvedBaseUrl, versionPaths, signal });
        throwIfAborted(signal);
        if (!context.transport && renderTopology === 'worker') {
            throw new Error('renderTopology="worker" was requested but the render worker could not start');
        }
    }
    if (context.transport) {
        return;
    }

    await loadGlue({ documentRef, resolvedBaseUrl, wasmScriptUrl, versionPaths, wasmVersion, signal });
    throwIfAborted(signal);

    // A module factory cannot be cancelled once it is running, so this resolves
    // even if destroy() happened meanwhile. Assigning it first means teardown
    // destructs it.
    context.module = /** @type {ProjectMModule} */ (await createProjectMModule({
        scriptSrc: wasmScriptUrl || undefined,
        wasmVersion,
        baseUrl: resolvedBaseUrl,
        documentRef,
        windowRef,
        noInitialRun: true,
        primaryCanvasSelector: context.primaryCanvasSelector,
        secondaryCanvasSelector: context.secondaryCanvasSelector,
        signal,
    }));
    throwIfAborted(signal);
    claimWindowModule();

    // Render paths are fixed before the first preset; the context config (with
    // them, on a current bundle) travels with the create call itself.
    applyLegacyRenderPathOverrides(ctx);

    let initCode = -1;
    if (!checkInit(context.module, {
        primaryCanvasSelector: context.primaryCanvasSelector,
        secondaryCanvasSelector: context.secondaryCanvasSelector,
        contextConfig: ctx.contextConfig(),
        onCode: (code) => { initCode = code; },
    })) {
        const error = new Error(`projectM init failed (init code ${initCode})`);
        reportError(error, initCode);
        throw error;
    }

    context.transport = createModuleTransport(context.module);
}

/**
 * Render-path switches for a bundle that predates create_host_with_config():
 * the process-wide set_render_path_overrides() call is the only way to reach
 * it. A current bundle gets them per host, in the create call's flags —
 * calling the setter there would land on whichever sibling host is active.
 *
 * @param {BootHost} ctx
 */
function applyLegacyRenderPathOverrides({ context, renderPathOverrides }) {
    const module = context.module;
    const exports = /** @type {Record<string, unknown> | null} */ (/** @type {unknown} */ (module));
    if (!module || typeof exports?._create_host_with_config === 'function'
        || typeof module._set_render_path_overrides !== 'function') {
        return;
    }
    const r = renderPathOverrides();
    module._set_render_path_overrides(
        r.blurCopyPath ? 1 : 0,
        r.copyShaderPath ? 1 : 0,
        r.perPixelForceCpu ? 1 : 0
    );
}

/**
 * Boot the render worker and wrap it in a transport, or resolve null so the
 * boot falls back to the main thread.
 *
 * @param {BootHost} ctx
 * @param {{ resolvedBaseUrl: string, versionPaths: { pmScript: string, rootScript: string, api?: string[] | null } | null, signal: AbortSignal }} options
 * @returns {Promise<RenderTransport | null>}
 */
async function startRenderWorker(ctx, { resolvedBaseUrl, versionPaths, signal }) {
    const { context } = ctx;
    const { options } = context;
    // The worker importScripts() the glue itself, so it needs an absolute URL —
    // resolved the same way the main-thread path resolves it, so both
    // topologies load the same bundle.
    let scriptSrc;
    try {
        const candidate = options.wasmScriptUrl ?? await resolveWasmScriptUrl({
            documentRef: options.documentRef,
            baseUrl: resolvedBaseUrl,
            ...(versionPaths ? { pmScript: versionPaths.pmScript, rootScript: versionPaths.rootScript } : {}),
            forceRefresh: Boolean(options.wasmVersion),
            signal,
        });
        scriptSrc = new URL(candidate, resolvedBaseUrl).href;
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        options.onRenderWorkerFallback?.(`could not resolve the WASM bundle URL: ${error}`);
        return null;
    }

    // Ask for the layout size: the worker sizes its own backing store from it,
    // including the governor's render scale.
    const rect = context.container.getBoundingClientRect();
    const dpr = options.devicePixelRatio || 1;

    return selectRenderTopology({
        canvas: context.canvas,
        preferWorker: true,
        scriptSrc,
        width: Math.max(1, Math.round(rect.width * dpr)),
        height: Math.max(1, Math.round(rect.height * dpr)),
        targetFps: options.targetFps,
        governor: options.qualityGovernor,
        meshQuality: options.meshQuality,
        // The worker creates its context and picks its render paths in its own
        // init(); these have to travel with the init message.
        contextConfig: ctx.contextConfig(),
        renderPathOverrides: ctx.renderPathOverrides(),
        flashLimit: resolveFlashLimit(options),
        // The manifest's export list lets transport.supports() answer for the
        // worker's module instead of assuming every call exists.
        wasmExports: versionPaths?.api ?? null,
        signal,
        onFallback: (reason) => {
            options.onRenderWorkerFallback?.(reason);
        },
        onError: (message) => {
            // A live worker reporting a problem after a successful boot.
            ctx.reportRuntimeError(message);
        },
        onStats: (stats) => {
            context.workerStats = /** @type {any} */ (stats);
            context.workerFpsSink?.(/** @type {any} */ (stats).fps);
        },
    });
}

/**
 * Creates this context's audio router, or adopts the host's.
 *
 * A router the context created is its own and is destroyed with it. One the
 * host injected (core.html shares a single router between the page and its
 * context) belongs to the host: the undo only detaches this context from it
 * and restores its status callback.
 *
 * @param {BootHost} ctx
 * @param {Own} own
 * @param {AudioSourceRouter | null | undefined} existingRouter
 * @param {RenderTransport} transport
 * @param {ProjectMAudioSource | undefined} audioSource
 * @param {((status: ProjectMAudioSourceStatus) => void) | undefined} onAudioSourceChange
 * @returns {AudioSourceRouter}
 */
function attachAudioRouter({ context, emit }, own, existingRouter, transport, audioSource, onAudioSourceChange) {
    /** @param {ProjectMAudioSourceStatus} status */
    const publish = (status) => {
        onAudioSourceChange?.(status);
        emit('audio-source', status);
    };

    if (!existingRouter) {
        const created = createAudioSourceRouter({
            module: context.module,
            transport,
            initialSource: audioSourceToRouterSource(audioSource),
            onStatusChange: publish,
        });
        own(() => created.destroy());
        return created;
    }

    existingRouter.setModule(context.module);
    existingRouter.setTransport(transport);
    const prior = existingRouter.onStatusChange;
    /** @param {ProjectMAudioSourceStatus} status */
    const wrapped = (status) => {
        prior?.(status);
        publish(status);
    };
    existingRouter.onStatusChange = wrapped;
    const attachedModule = context.module;
    own(() => {
        if (existingRouter.onStatusChange === wrapped) {
            existingRouter.onStatusChange = prior;
        }
        if (existingRouter.module === attachedModule) {
            existingRouter.setModule(null);
        }
        if (existingRouter.transport === transport) {
            existingRouter.setTransport(null);
        }
    });
    return existingRouter;
}

/**
 * @param {BootHost} ctx
 * @param {Own} own
 * @param {AbortSignal} signal
 */
function wireAudio({ context }, own, signal) {
    const router = context.audioRouter;
    const { audioSource, audioElement: audioElementOption, externalPcmOrigins } = context.options;

    if (audioSource === 'external') {
        const receiver = setupExternalAudioReceiver({
            allowedOrigins: externalPcmOrigins ?? [],
            // This context's own engine, so the receiver keeps feeding it
            // whatever another context registers as the page default.
            transport: context.transport,
            feedGate: () => router?.externalFeedGate() ?? false,
            onFeed: router
                ? router.wrapExternalFeed(defaultFeedPCMToModule)
                : defaultFeedPCMToModule,
        });
        own(receiver.close);
        return;
    }

    if (audioSource !== 'element') {
        // Keep shared host routers (e.g. core.html autoSwitchOnFeed) at 'none'
        // so the first external/worklet feed can promote the active source.
        if (!context.options.audioRouter) {
            router?.setActiveSource('none');
        }
        return;
    }

    const media = context.audioElement ?? resolveMediaElement(audioElementOption, context.options.documentRef);
    if (!media) {
        console.warn('[ProjectMContext] audioSource=element but no audio element was provided');
        return;
    }

    router?.setActiveSource('element');
    context.audioElement = media;
    media.id = media.id || 'audio-stream-element';
    ensureAudioRunning().catch(() => {
        // Autoplay policies may require a user gesture; host should call ensureAudioRunning().
    });
    // The element feeds the engine through the shared worklet (and from there
    // the PCM ring), so it cannot be connected until the worklet node exists.
    // By then this context may have been destroyed: connecting then would wire
    // a torn-down context's element into the shared worklet for good.
    ensureWorkletReady()
        .then((ready) => {
            if (!ready || signal.aborted) {
                return;
            }
            if (connectMediaElement(media)) {
                own(() => disconnectMediaElement(media));
            }
        })
        .catch((err) => {
            console.warn('[ProjectMContext] could not connect audio element:', err);
        });
}

/**
 * @param {BootHost} ctx
 * @param {Own} own
 * @param {(fps: number) => void} onFps
 * @param {AbortSignal} signal
 */
function startFpsMonitor({ context, engine }, own, onFps, signal) {
    if (!context.module) {
        // No frame counter to read on this thread — the worker measures its
        // own frame rate and posts it every 500 ms.
        context.fpsTimer = 0;
        context.workerFpsSink = onFps;
        return;
    }

    const sample = () => {
        const view = engine();
        if (signal.aborted || context.destroyed || !view) {
            return;
        }
        const now = performance.now();
        const frameCount = view._get_rendered_frame_count?.() ?? 0;
        if (!context.fpsLastSample) {
            context.fpsLastSample = now;
            context.fpsFrameCount = frameCount;
        }
        const elapsed = (now - context.fpsLastSample) / 1000;
        if (elapsed >= 1) {
            onFps((frameCount - context.fpsFrameCount) / elapsed);
            context.fpsLastSample = now;
            context.fpsFrameCount = frameCount;
        }
        context.fpsTimer = requestAnimationFrame(sample);
    };
    context.fpsTimer = requestAnimationFrame(sample);
    own(() => {
        if (context.fpsTimer) {
            cancelAnimationFrame(context.fpsTimer);
            context.fpsTimer = 0;
        }
        context.fpsLastSample = 0;
    });
}
