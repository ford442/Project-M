// projectm-context.js
//
// ProjectMContext: the high-level embed API. This file holds the context's
// state, its lifecycle (start / teardown / destroy) and its public methods;
// the work behind them lives in context/:
//
//   context/boot.js     glue + Module / render worker / engine creation
//   context/audio.js    the audio router and the configured audio source
//   context/presets.js  preset loading, rhythm controls and rhythm events
//   context/render.js   canvas sizing, resize, fps, snapshot, flash stats
//
// Those modules keep no state of their own: whatever they acquire comes back
// here and is registered on this context's teardown list.

import { setupAudioUnlock } from './projectm-audio-bootstrap.js';
import { installWorkletPlaybackSafetyNet } from './projectm-worklet-playback.js';
import { claimGlobal } from './projectm-globals.js';
import { subscribeWasmCallback } from './projectm-wasm-callbacks.js';
import { setupContextLossRecovery } from './projectm-context-loss.js';
import { flushQueuedExternalPCM, setExternalPcmTransport } from './projectm-external-pcm.js';
import { setupPcmHud } from './projectm-pcm-hud.js';
import { getGovernorRenderScale, setQualityGovernorEnabled, setTargetFps } from './projectm-fps-governor.js';
import { installTransportPcmWriter, installTransportPresetWriter } from './projectm-render-transport.js';
import { checkCrossOriginIsolation, INIT_CONTEXT_LOST } from './projectm-init-errors.js';
import { setMeshQuality } from './projectm-mesh-quality.js';
import { toDisposeFunction } from './projectm-disposables.js';
import { updatePresetDisplay } from './projectm-presets.js';
import {
    startRender,
    setPresetLocked,
    setTransparencyMode,
    switchPreset,
    destroyHost,
} from './generated/projectm-wasm-api.js';
import { resolveFlashLimit } from './projectm-context-config.js';
import {
    bootEngine,
    contextConfigFor,
    createAbortError,
    createModule,
    isAbortError,
    loadGlueScript,
    resolveBundlePaths,
    resolveCanvasSelector,
    throwIfAborted,
} from './context/boot.js';
import { attachAudioRouter, resolveMediaElement, wireAudioSource } from './context/audio.js';
import {
    RHYTHM_EVENT_TYPES,
    RhythmEventRelay,
    applyRhythmOptions,
    callRhythm,
    loadPresetFileInto,
    loadPresetUrlInto,
    presetSwitchPolicyArgs,
    readRhythmInfo,
    relayPresetEvents,
} from './context/presets.js';
import {
    createEngineBinder,
    followContainerSize,
    meshGridFor,
    readContextSnapshot,
    readFlashLimitStats,
    resolveDevicePixelRatio,
    startFpsMonitor,
    syncCanvasSize,
} from './context/render.js';
import { createSpriteOn, destroySpriteOn, getSpriteVarOn, setSpriteVarOn } from './context/sprites.js';

// Re-exported for embedders (`@projectm/web/context`): the encoder behind the
// context options, for hosts that create engines through the raw exports.
export { CONTEXT_CONFIG_FLAGS, resolveWasmContextConfig } from './projectm-context-config.js';

/**
 * `ProjectMErrorDetail.code` of a preset that failed to load or compile. Not a
 * boot failure: the engine keeps running its previous preset, so a page can show
 * a toast and carry on. `detail.error.preset` is the VFS path that failed.
 */
export const PRESET_SWITCH_FAILED = -2;

const DEFAULT_TARGET_FPS = 60;

/**
 * The default WASM base: this module's URL. Read here and nowhere in
 * context/, because the package build bundles modules into flat chunks where
 * `import.meta.url` is the chunk's URL, not the source file's.
 */
const DEFAULT_BASE_URL = import.meta.url;

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

    const baseUrl = wasmBaseUrl ?? DEFAULT_BASE_URL;
    const versionPaths = await resolveBundlePaths({ baseUrl, wasmScriptUrl, wasmVersion, signal });
    await loadGlueScript({ documentRef, baseUrl, wasmScriptUrl, wasmVersion, versionPaths, signal });
    const module = await createModule({
        documentRef,
        windowRef,
        baseUrl,
        wasmScriptUrl,
        wasmVersion,
        primaryCanvasSelector,
        secondaryCanvasSelector,
        signal,
    });
    if (windowRef) {
        windowRef.Module = module;
    }
    return module;
}

/**
 * @typedef {import('./projectm-context-types.ts').ProjectMContextOptions} ProjectMContextOptions
 * @typedef {import('./projectm-context-types.ts').ProjectMResolvedContextOptions} ProjectMResolvedContextOptions
 * @typedef {import('./projectm-context-types.ts').ProjectMMeshQuality} ProjectMMeshQuality
 * @typedef {import('./projectm-context-types.ts').ProjectMAudioSource} ProjectMAudioSource
 * @typedef {import('./projectm-context-types.ts').ProjectMAudioSourceStatus} ProjectMAudioSourceStatus
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 * @typedef {import('./projectm-context-types.ts').ProjectMPresetDetail} ProjectMPresetDetail
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('./projectm-transport-types.ts').RenderTransport} RenderTransport
 * @typedef {import('./projectm-context-types.ts').ProjectMRenderTopology} ProjectMRenderTopology
 * @typedef {import('./projectm-audio-source-router.js').AudioSourceRouter} AudioSourceRouter
 * @typedef {import('./projectm-context-types.ts').ProjectMPresetSwitchPolicy} ProjectMPresetSwitchPolicy
 * @typedef {import('./projectm-context-types.ts').ProjectMRhythmInfo} ProjectMRhythmInfo
 * @typedef {import('./projectm-context-types.ts').ProjectMCapturedFrame} ProjectMCapturedFrame
 * @typedef {import('./projectm-context-types.ts').ProjectMCaptureFrameOptions} ProjectMCaptureFrameOptions
 * @typedef {import('./projectm-context-types.ts').ProjectMFlashLimitStats} ProjectMFlashLimitStats
 * @typedef {import('./projectm-context-types.ts').ProjectMContextSnapshot} ProjectMContextSnapshot
 */

/**
 * High-level embed API: canvas bootstrap, WASM init, resize, presets, and audio wiring.
 *
 * Lifecycle. `start()` is idempotent under concurrency: overlapping calls share
 * one boot. `destroy()` aborts a boot that is still in flight, and a start that
 * fails (or is aborted) releases everything it had acquired by then — the
 * Module, the render worker, the WebGL context and every listener — so the
 * context is left as it was before `start()` and can be started again. Every
 * resource is registered for teardown the moment it is acquired, which is what lets one routine tear down both a finished context
 * and a half-booted one.
 *
 * Several contexts can share a page. Everything a context puts in a
 * process-wide slot (`window.Module`, the PCM writer, the external-PCM
 * transport, the governor callback, the router registry, the worklet safety
 * net) is claimed and released, so destroying one leaves the others' intact.
 */
export class ProjectMContext {
    /**
     * Per-instance notifications, for hosts that want an event stream rather
     * than the `on*` options: `ready`, `error`, `audio-source`,
     * `preset-changed` and `destroy`, each a `CustomEvent` whose `detail`
     * matches the corresponding callback's argument, plus the musical-time
     * events `beat`, `bar` and `section` (detail: a `RhythmEvent`) while
     * someone listens to them through {@link ProjectMContext#on}. Unlike the
     * window-level `pm:*` events these belong to this context alone.
     *
     * @type {EventTarget}
     */
    events = new EventTarget();

    /** Beat/bar/section events, connected to the engine while anyone listens. */
    #rhythm = new RhythmEventRelay((type, detail) => this.#emit(type, detail), () => this.hostHandle);

    /**
     * Aborted by teardown: whatever `start()` is still awaiting gives up, and a
     * continuation that outlives the context checks it before touching anything.
     * @type {AbortController | null}
     */
    #attempt = null;
    /** @type {Promise<ProjectMContext> | null} */
    #startPromise = null;
    /**
     * Undo steps for everything this context has acquired, oldest first;
     * teardown runs them newest first.
     * @type {(() => void)[]}
     */
    #disposers = [];
    /** The last error handed to `onError`, so one failure is reported once. */
    #reportedError = /** @type {unknown} */ (undefined);
    /** `#engine`'s cache of the bound engine view. */
    #bindEngine = createEngineBinder();
    /** What the engine negotiated with WebGL; see {@link ProjectMContext#contextSnapshot}. */
    #contextSnapshot = /** @type {ProjectMContextSnapshot | null} */ (null);
    /** setTransparent(true) on an opaque canvas has been reported. */
    #warnedOpaqueTransparency = false;

    /** @param {ProjectMContextOptions} options */
    constructor(options) {
        if (!options?.canvas) {
            throw new Error('ProjectMContext requires a canvas element');
        }

        /** @type {ProjectMResolvedContextOptions} */
        this.options = {
            requireCrossOriginIsolation: true,
            meshQuality: 'auto',
            targetFps: DEFAULT_TARGET_FPS,
            qualityGovernor: true,
            transparent: false,
            transparencyThreshold: 0.01,
            aspectCorrection: true,
            alpha: false,
            audioSource: 'none',
            presetLocked: false,
            renderTopology: 'auto',
            documentRef: typeof document !== 'undefined' ? document : undefined,
            windowRef: typeof window !== 'undefined' ? window : undefined,
            ...options,
        };

        this.canvas = options.canvas;
        this.secondaryCanvas = options.secondaryCanvas ?? null;
        this.container = options.container ?? this.canvas.parentElement ?? this.canvas;
        this.primaryCanvasSelector = resolveCanvasSelector(
            this.canvas,
            options.primaryCanvasSelector,
            'pm-main-canvas'
        );
        this.secondaryCanvasSelector = this.secondaryCanvas
            ? resolveCanvasSelector(
                this.secondaryCanvas,
                options.secondaryCanvasSelector,
                'pm-secondary-canvas'
            )
            : (options.secondaryCanvasSelector || '#scanvas');
        /** @type {ProjectMModule | null} */
        this.module = null;
        /**
         * The one thing every engine call goes through. Null until start()
         * picks a topology; after that, `transport.topology` is the only place
         * the choice is visible, and callers of this class never branch on it.
         *
         * @type {RenderTransport | null}
         */
        this.transport = null;
        /**
         * Latest stats posted by the render worker; null on the main thread.
         * @type {(Record<string, unknown> & { fps?: number }) | null}
         */
        this.workerStats = null;
        /** @type {((fps: number) => void) | undefined} */
        this.workerFpsSink = undefined;
        /**
         * Opaque per-instance host handle from create_host() when this context
         * shares a Module with others (#168 Phase B). 0 means the process
         * default host (single-instance / legacy path), where no set_active_host
         * is needed because there is only one engine.
         * @type {number}
         */
        this.hostHandle = 0;
        /** Whether this context owns the Module (created it) vs. shares one. */
        this.ownsModule = true;
        this.ready = false;
        this.destroyed = false;
        /** @type {ResizeObserver | null} */
        this.resizeObserver = null;
        this.fpsTimer = 0;
        this.fpsFrameCount = 0;
        this.fpsLastSample = 0;
        /** Internal render scale (1.0/0.75/0.5) applied by governor v2; see resize(). */
        this.renderScale = 1;
        /** @type {HTMLMediaElement | null} */
        this.audioElement = null;
        /** @type {AudioSourceRouter | null} */
        this.audioRouter = options.audioRouter ?? null;
    }

    /**
     * Boots WASM, starts rendering, and resolves when the engine is ready.
     *
     * Calling it again while a boot is in flight returns the same promise, and
     * calling it once ready resolves immediately. If the boot fails everything
     * it acquired is released and a later call starts over.
     *
     * @returns {Promise<ProjectMContext>}
     */
    start() {
        if (this.destroyed) {
            return Promise.reject(new Error('ProjectMContext was destroyed'));
        }
        if (this.ready) {
            return Promise.resolve(this);
        }
        if (!this.#startPromise) {
            const attempt = new AbortController();
            this.#attempt = attempt;
            const promise = this.#run(attempt.signal).finally(() => {
                if (this.#startPromise === promise) {
                    this.#startPromise = null;
                }
            });
            this.#startPromise = promise;
        }
        return this.#startPromise;
    }

    /**
     * @param {AbortSignal} signal Aborted when this attempt is torn down.
     * @returns {Promise<ProjectMContext>}
     */
    async #run(signal) {
        const {
            requireCrossOriginIsolation,
            documentRef,
            windowRef,
            meshQuality,
            targetFps,
            qualityGovernor,
            transparent,
            transparencyThreshold,
            presetLocked,
            presetUrl,
            audioSource,
            audioElement,
            onAudioSourceChange,
            audioRouter: existingAudioRouter,
            onReady,
            onPresetChanged,
            onFps,
        } = this.options;

        this.#reportedError = undefined;
        this.ownsModule = !this.options.sharedModule;

        if (audioSource === 'element') {
            const media = resolveMediaElement(audioElement, documentRef);
            if (media) {
                this.audioElement = media;
                media.id = media.id || 'audio-stream-element';
            }
        }

        if (requireCrossOriginIsolation && !checkCrossOriginIsolation()) {
            const error = new Error('Cross-origin isolation is required for this WASM build');
            this.#reportError(error, 4);
            this.#teardown();
            throw error;
        }

        try {
            const transport = await bootEngine({
                options: this.options,
                baseUrl: this.options.wasmBaseUrl ?? DEFAULT_BASE_URL,
                canvas: this.canvas,
                container: this.container,
                primaryCanvasSelector: this.primaryCanvasSelector,
                secondaryCanvasSelector: this.secondaryCanvasSelector,
                onRuntimeError: (message) => this.#reportRuntimeError(message),
                onStats: (stats) => {
                    this.workerStats = stats;
                    this.workerFpsSink?.(Number(stats.fps));
                },
                signal,
            }, {
                adoptModule: (module) => {
                    this.module = module;
                    this.#claimWindowModule();
                },
                adoptTransport: (adopted) => { this.transport = adopted; },
                adoptHost: (handle) => { this.hostHandle = handle; },
                replaceCanvas: (canvas) => { this.canvas = canvas; },
                reportError: (error, code) => this.#reportError(error, code),
            });
            throwIfAborted(signal);

            // External PCM arrives on this thread either way; tell it which
            // engine to hand the samples to. A claim, not an assignment: the
            // release below leaves a sibling context's registration alone.
            this.#own(setExternalPcmTransport(transport));
            // PCM-rate readout (host ingress, engine/worker drain); overlay with ?pcmhud=1.
            this.#own(setupPcmHud({ transport, windowRef, documentRef }));

            this.audioRouter = attachAudioRouter({
                existingRouter: existingAudioRouter,
                module: this.module,
                transport,
                audioSource,
                publish: (status) => {
                    onAudioSourceChange?.(status);
                    this.#emit('audio-source', status);
                },
                own: (dispose) => this.#own(dispose),
            });

            this.#own(setupAudioUnlock());
            this.#own(installWorkletPlaybackSafetyNet());
            // The worklet runs on this thread in both topologies; this is what
            // decides where its PCM goes.
            this.#own(installTransportPcmWriter(transport));
            // Preset milk is fetched on this thread; the worker owns the VFS.
            this.#own(installTransportPresetWriter(transport));
            // Both topologies: on the main thread the canvas is heard here, in
            // the worker the loss is relayed through the transport.
            this.#own(setupContextLossRecovery(this, {
                canvas: this.canvas,
                documentRef,
                windowRef,
            }));

            // The flash limiter is on before the engine's first frame: a viewer
            // who needs it must never be shown an unlimited one. The worker
            // applied it from its init message already.
            const flashLimit = resolveFlashLimit(this.options);
            if (flashLimit && transport.topology === 'main') {
                transport.setFlashLimit(flashLimit.enabled, flashLimit.threshold);
            }

            // Everything from here drives the engine, through the transport or
            // #engine. Both select this context's host on every call, so the
            // `await this.loadPresetUrl()` below cannot resume on a sibling's
            // engine; nothing here relies on an activation lasting.

            this.resize();

            const engine = this.#engine;
            if (engine) {
                // The worker calls _start_render() itself, on its own canvas,
                // before it reports ready.
                startRender(engine, this.canvas.width, this.canvas.height);
            }
            flushQueuedExternalPCM();

            if (engine) {
                // Mesh/fps/governor go to the worker in its init message, since
                // it must have them before the first frame. Setting them again
                // over the wire would be a second source of truth.
                setMeshQuality(engine, meshQuality);
                setTargetFps(engine, targetFps);
                setQualityGovernorEnabled(engine, qualityGovernor);
            }
            transport.callVoid('setPresetLocked', presetLocked);
            applyRhythmOptions(this.options, this);
            this.#rhythm.sync(transport);

            // Governor v2 (docs/PERFORMANCE.md): sync the starting render scale, then
            // resize on every tier change (WasmPerfGovernor.cpp pushes here via
            // js_governor_report_render_scale()). Shrinking the canvas backing store
            // while keeping its CSS size fixed is what actually applies the "internal
            // FBO render scale" tier — see syncCanvasSize() in context/render.js.
            //
            // In the worker topology the backing store is not ours to shrink, so
            // the worker applies the same factor to the canvas it owns and this
            // thread keeps renderScale at 1 — see html/projectm-render-worker.js.
            if (engine) {
                this.renderScale = getGovernorRenderScale(engine) || 1;
                // Via the injected windowRef, like every other global hook this class
                // installs — a bare `window` here ignores the caller's window and
                // throws outright where there is no global one. The engine calls the
                // hook by its global name, so it goes through the callback bus:
                // destroying one context leaves the rest subscribed, and the
                // engineHost filter keeps a sibling engine's tier change from
                // resizing this canvas.
                if (windowRef) {
                    this.#own(subscribeWasmCallback('pmOnGovernorRenderScaleChange', ({ scale }) => {
                        this.renderScale = scale;
                        this.resize();
                    }, windowRef, { engineHost: this.hostHandle }));
                }
            }
            this.#watchEngineInitErrors();
            this.#watchPresetSwitchFailures();

            if (transparent) {
                transport.callVoid('setTransparencyMode', true);
                if (typeof transparencyThreshold === 'number') {
                    transport.callVoid('setTransparencyThreshold', transparencyThreshold);
                }
                if (this.secondaryCanvas) {
                    this.secondaryCanvas.style.display = 'none';
                }
            }

            const media = wireAudioSource({
                audioSource,
                media: audioSource === 'element'
                    ? this.audioElement ?? resolveMediaElement(audioElement, documentRef)
                    : null,
                externalPcmOrigins: this.options.externalPcmOrigins,
                router: this.audioRouter,
                sharedRouter: !!existingAudioRouter,
                transport: this.transport,
                signal,
                own: (dispose) => this.#own(dispose),
            });
            if (media) {
                this.audioElement = media;
            }
            if (!existingAudioRouter) {
                this.audioRouter.setModule(this.module);
                this.audioRouter.setTransport(transport);
            }
            this.#observeResize();
            this.#own(relayPresetEvents(windowRef, (detail) => {
                onPresetChanged?.(detail);
                this.#emit('preset-changed', detail);
            }));

            this.#contextSnapshot = readContextSnapshot(transport, contextConfigFor(this.options));

            if (presetUrl) {
                await this.loadPresetUrl(presetUrl);
                throwIfAborted(signal);
            }

            this.ready = true;
            if (onFps) {
                this.#startFpsMonitor(onFps, signal);
            }

            onReady?.(this);
            this.#emit('ready', undefined);
            return this;
        } catch (error) {
            // Read this BEFORE tearing down: teardown aborts the signal itself,
            // so afterwards every failure would look like a cancellation.
            const cancelled = signal.aborted;
            // Release whatever this attempt had acquired before it failed: a
            // Module and WebGL context, a Worker, and every listener. Browsers
            // cap live WebGL contexts at roughly 16 and then drop the oldest, so
            // a start that fails repeatedly must not keep them.
            this.#teardown();
            if (cancelled) {
                // destroy() cancelled this boot. Whatever surfaced afterwards
                // (a step running against state that was just released) is a
                // symptom of that, not a failure worth reporting.
                throw isAbortError(error)
                    ? error
                    : createAbortError('ProjectMContext was destroyed during start()');
            }
            this.#reportError(error);
            throw error;
        }
    }

    /**
     * Ties something a host built around this context — a `setup*()` panel, a
     * subscription, any `{ dispose }` or disposer function — to the context's
     * lifetime: it is disposed when the context is destroyed, newest first,
     * alongside what start() acquired. Registered on a context that is already
     * destroyed, it is disposed at once.
     *
     * @template {(() => void) | { dispose(): void } | null | undefined} T
     * @param {T} disposable
     * @returns {T} `disposable`, so a setup can be owned where it is made.
     */
    own(disposable) {
        const dispose = toDisposeFunction(disposable);
        if (!dispose) {
            return disposable;
        }
        if (this.destroyed) {
            try {
                dispose();
            } catch (error) {
                console.warn('[ProjectMContext] cleanup step failed:', error);
            }
            return disposable;
        }
        this.#disposers.push(dispose);
        return disposable;
    }

    /**
     * Registers an undo step for something this context just acquired. It runs
     * when the context is destroyed, and when a start that acquired it fails.
     *
     * @param {(() => void) | { dispose(): void } | null | undefined} dispose
     */
    #own(dispose) {
        const fn = toDisposeFunction(dispose);
        if (fn) {
            this.#disposers.push(fn);
        }
    }

    /**
     * Hands a failure to `onError` and the `error` event — once. `start()` reports
     * some failures where they happen (they carry a specific code) and the outer
     * handler sees the same error again on its way out.
     *
     * @param {unknown} error
     * @param {number} [code]
     */
    #reportError(error, code = -1) {
        if (this.#reportedError === error) {
            return;
        }
        this.#reportedError = error;
        const message = error instanceof Error ? error.message : String(error);
        this.options.onError?.({ code, message, error });
        this.#emit('error', { code, message, error });
    }

    /**
     * Errors from a running engine (the worker), as opposed to a failed start.
     * Not deduplicated: each one is a separate event.
     *
     * @param {string} message
     */
    #reportRuntimeError(message) {
        const error = new Error(message);
        this.options.onError?.({ code: -1, message, error });
        this.#emit('error', { code: -1, message, error });
    }

    /**
     * @param {string} type
     * @param {unknown} detail
     */
    #emit(type, detail) {
        const event = typeof CustomEvent === 'function'
            ? new CustomEvent(type, { detail })
            : Object.assign(new Event(type), { detail });
        this.events.dispatchEvent(event);
    }

    /**
     * Publish this context's Module as `window.Module` for the legacy code that
     * still reads it. Claimed, so destroying the context no longer leaves the
     * global pointing at a destructed engine, and with two contexts the older one
     * takes it back when the newer one goes.
     */
    #claimWindowModule() {
        const { windowRef } = this.options;
        if (windowRef && this.module) {
            this.#own(claimGlobal(windowRef, 'Module', this.module));
        }
    }

    /**
     * Releases everything `start()` acquired, newest first, then the engine
     * itself. Safe to call at any point of a boot and more than once: the
     * failure path of a half-finished start and destroy() both come through
     * here, and a destroy() that lands mid-boot is followed by the boot's own
     * cleanup for whatever it acquired after that.
     */
    #teardown() {
        this.ready = false;
        this.#attempt?.abort();
        this.#attempt = null;
        // The transport goes away with the engine; on() listeners stay registered
        // and a later start() reconnects them.
        this.#rhythm.detach();
        this.#contextSnapshot = null;

        const disposers = this.#disposers.splice(0).reverse();
        for (const dispose of disposers) {
            try {
                dispose();
            } catch (error) {
                console.warn('[ProjectMContext] cleanup step failed:', error);
            }
        }

        this.#teardownEngine();
        this.audioRouter = null;
        this.workerStats = null;
        this.workerFpsSink = undefined;
    }

    /** Frees the engine: a host inside a shared Module, a worker, or an owned Module. */
    #teardownEngine() {
        const { module, transport, hostHandle } = this;
        this.hostHandle = 0;
        this.transport = null;
        this.module = null;

        try {
            if (hostHandle && module) {
                // Multi-instance: free just this engine; the shared Module and any
                // sibling contexts keep running. The Module itself is torn down by
                // whoever booted it (bootProjectMSharedModule caller).
                destroyHost(module, hostHandle);
            } else if (transport) {
                // Tears down the module on the main thread, terminates the worker in
                // the other topology.
                transport.destroy();
            } else if (this.ownsModule && module?._destruct) {
                // A Module that was created but never got a transport (init failed
                // part-way, or the boot was cancelled right after the factory ran).
                module._destruct();
            }
        } catch (error) {
            console.warn('[ProjectMContext] engine teardown failed:', error);
        }
    }

    /**
     * @param {string} url
     * @returns {Promise<{ url: string; vfsPath: string; filename: string }>}
     */
    async loadPresetUrl(url) {
        const transport = this.#requireTransport();
        return loadPresetUrlInto(url, {
            transport,
            engine: this.#engine,
            isCurrent: () => this.transport === transport,
            windowRef: this.options.windowRef,
            signal: this.#attempt?.signal,
        });
    }

    /**
     * @param {File} file
     * @returns {Promise<{ filename: string; vfsPath: string }>}
     */
    async loadPresetFile(file) {
        const transport = this.#requireTransport();
        return loadPresetFileInto(file, {
            transport,
            engine: this.#engine,
            isCurrent: () => this.transport === transport,
            documentRef: this.options.documentRef,
        });
    }

    /** @returns {RenderTransport} */
    #requireTransport() {
        if (!this.transport) {
            throw new Error('ProjectMContext is not started');
        }
        return this.transport;
    }

    /**
     * Add a preset to the playlist without switching to it.
     *
     * @param {string} vfsPath
     * @param {Uint8Array} bytes
     */
    addPreset(vfsPath, bytes) {
        this.transport?.writePreset(vfsPath, bytes, 'add');
    }

    /**
     * @param {number} threshold RGB cutoff below which pixels go transparent.
     */
    setTransparencyThreshold(threshold) {
        this.transport?.callVoid('setTransparencyThreshold', threshold);
    }

    nextPreset() {
        if (this.transport) {
            this.transport.callVoid('switchPreset');
            return;
        }
        const engine = this.#engine;
        if (engine) {
            switchPreset(engine);
        }
    }

    /** @param {boolean} locked */
    setLocked(locked) {
        if (this.transport) {
            this.transport.callVoid('setPresetLocked', locked);
            return;
        }
        const engine = this.#engine;
        if (engine) {
            setPresetLocked(engine, locked);
        }
    }

    /**
     * Turns transparency mode on or off. The canvas must have an alpha channel
     * for it to show (`contextAlpha`, which defaults to the `transparent` option
     * at start()); on an opaque one the cut-out pixels are drawn black.
     *
     * @param {boolean} enabled
     */
    setTransparent(enabled) {
        const engine = this.#engine;
        if (this.transport) {
            this.transport.callVoid('setTransparencyMode', enabled);
        } else if (engine) {
            setTransparencyMode(engine, enabled);
        } else {
            return;
        }
        if (enabled && this.#contextSnapshot?.attributes?.contextAlpha === false && !this.#warnedOpaqueTransparency) {
            this.#warnedOpaqueTransparency = true;
            console.warn('[projectM] transparency mode is on, but this canvas was created without an alpha channel, '
                + 'so nothing shows through; start the context with contextAlpha: true (or transparent: true)');
        }
        if (this.secondaryCanvas) {
            this.secondaryCanvas.style.display = enabled ? 'none' : 'block';
        }
    }

    /**
     * @param {ProjectMMeshQuality} quality
     * @returns {string | undefined}
     */
    setMeshQuality(quality) {
        const engine = this.#engine;
        if (engine) {
            // 'auto' resolves against the device, which needs the module's own
            // view of it; only the resolved grid crosses to the worker.
            return setMeshQuality(engine, quality);
        }
        if (!this.transport) {
            return;
        }
        this.transport.callVoid('setMesh', ...meshGridFor(quality));
        return quality;
    }

    /**
     * @param {number} fps
     * @returns {number | undefined}
     */
    setTargetFps(fps) {
        const engine = this.#engine;
        if (engine) {
            return setTargetFps(engine, fps);
        }
        if (!this.transport) {
            return;
        }
        this.transport.callVoid('setTargetFps', fps);
        return fps;
    }

    /**
     * Subscribes to one of this context's events and returns the unsubscribe
     * function. Besides the lifecycle events of {@link ProjectMContext#events}
     * this delivers the music's structure as it plays:
     *
     *  - `beat`: on every beat, *on* it rather than after it (the beat clock
     *    predicts it), while the tempo is known.
     *  - `bar`: on every downbeat.
     *  - `section`: when a new part of the song starts.
     *
     * Each listener gets a `RhythmEvent` (bpm, beatIndex, barPhase,
     * sectionIndex, confidence). The engine only reports while at least one
     * beat/bar/section listener is subscribed, and only frames that carry an
     * event — never every frame. Works the same in both render topologies, and
     * may be called before start(): the subscription connects once the engine
     * is up.
     *
     * @param {string} type
     * @param {(detail: any) => void} listener
     * @returns {() => void}
     */
    on(type, listener) {
        const handler = (/** @type {Event} */ event) => listener(/** @type {CustomEvent} */ (event).detail);
        this.events.addEventListener(type, handler);
        const rhythm = RHYTHM_EVENT_TYPES.includes(type);
        if (rhythm) {
            this.#rhythm.count(1, this.transport);
        }
        let subscribed = true;
        return () => {
            if (!subscribed) {
                return;
            }
            subscribed = false;
            this.events.removeEventListener(type, handler);
            if (rhythm) {
                this.#rhythm.count(-1, this.transport);
            }
        };
    }

    /**
     * Uses a known tempo instead of estimating it (a MIDI clock, track
     * metadata, a tap-tempo button). The beat phase still locks to the audio.
     *
     * @param {number} bpm Beats per minute, or 0 to go back to estimating.
     */
    setRhythmHint(bpm) {
        callRhythm(this.transport, 'setRhythmHint', Number.isFinite(bpm) && bpm > 0 ? bpm : 0);
    }

    /**
     * When the playlist moves on. See {@link ProjectMPresetSwitchPolicy}.
     *
     * @param {ProjectMPresetSwitchPolicy} policy
     * @param {number} [bars] Bars per preset, or the shortest preset for `'section'`. Default 16.
     */
    setPresetSwitchPolicy(policy, bars = 16) {
        callRhythm(this.transport, 'setPresetSwitchPolicy', ...presetSwitchPolicyArgs(policy, bars));
    }

    /**
     * Crossfade length in beats, resolved against the tempo when each crossfade
     * starts; while the tempo is unknown the duration in seconds applies.
     *
     * @param {number} beats Beats, or 0 to use seconds only.
     */
    setTransitionDurationBeats(beats) {
        callRhythm(this.transport, 'transitionSetDurationBeats', Number.isFinite(beats) && beats > 0 ? beats : 0);
    }

    /**
     * Makes beat-detection hard cuts wait for the next beat.
     *
     * @param {boolean} enabled
     */
    setHardCutOnBeat(enabled) {
        callRhythm(this.transport, 'setHardCutOnBeat', !!enabled);
    }

    /**
     * Tempo and phase of the most recent frame, or null before start() or on a
     * bundle without rhythm analysis. One round trip per field in the worker
     * topology, so poll it for a display, not per frame.
     *
     * @returns {Promise<ProjectMRhythmInfo | null>}
     */
    getRhythmInfo() {
        return readRhythmInfo(this.transport);
    }

    /**
     * Turns this engine's temporal flash limiter on or off. When a frame's mean
     * luminance would change faster than `threshold` allows, the frame is
     * blended toward the one shown before; see docs/FLASH_LIMITER.md. Off by
     * default (and then frames reach the canvas exactly as without it). A no-op
     * before start() — pass the `flashLimit` option to have it on from the first
     * frame — and on a bundle that predates the limiter.
     *
     * @param {boolean} enabled
     * @param {number} [threshold] 0.005..1; omitted keeps the current one (default 0.06).
     */
    setFlashLimit(enabled, threshold) {
        this.transport?.setFlashLimit(!!enabled, threshold);
    }

    /**
     * The flash limiter's state for this engine, or null before start() or on a
     * bundle without it. Reading the clamp count waits for the GPU to finish the
     * frames since the last read: poll it for a display, not per frame.
     *
     * @returns {Promise<ProjectMFlashLimitStats | null>}
     */
    getFlashLimitStats() {
        return readFlashLimitStats(this.transport);
    }

    /**
     * Adds a user sprite to this engine: an image drawn over every preset, positioned
     * and colored by its own expression code (projectM-4/user_sprites.h). `code` is
     * Milkdrop sprite code, one `key=value` per line:
     *
     * ```
     * img=pm_depth_map          texture base name (from /textures/, no extension)
     * init_1=x=0.5; y=0.5;      runs once
     * code_1=a=0.5+0.4*bass;    runs every frame
     * ```
     *
     * Sprite variables: x, y, sx, sy, rot, flipx, flipy, repeatx, repeaty,
     * blendmode (0..4), r, g, b, a, burn, done, plus read-only time, frame, fps,
     * progress, bass/mid/treb and their _att forms. Sprites survive preset
     * switches; at the limit (16) the oldest is replaced.
     *
     * @param {string} code
     * @param {{ type?: string }} [options] `type` defaults to `'milkdrop'`, the only one libprojectM knows.
     * @returns {Promise<number>} The sprite id, for the other sprite methods. Rejects
     *   before start(), on a bundle without the sprite exports, and when the engine
     *   refuses the sprite (code that does not compile, an unknown type).
     */
    createSprite(code, { type = 'milkdrop' } = {}) {
        return createSpriteOn(this.transport, String(code), type);
    }

    /**
     * Removes a sprite created with {@link createSprite}. An id that no longer
     * exists is ignored.
     *
     * @param {number} id
     * @returns {Promise<void>}
     */
    destroySprite(id) {
        return destroySpriteOn(this.transport, id);
    }

    /**
     * Reads one of a sprite's expression variables (0 for an unknown sprite or name).
     *
     * @param {number} id
     * @param {string} name
     * @returns {Promise<number>}
     */
    getSpriteVar(id, name) {
        return getSpriteVarOn(this.transport, id, name);
    }

    /**
     * Sets one of a sprite's expression variables. The sprite's per-frame code runs
     * after this, so a variable that code assigns every frame is overwritten; drive
     * the sprite through a variable of your own that its code reads instead
     * (`code_1=x=px;`, then set `px`).
     *
     * @param {number} id
     * @param {string} name
     * @param {number} value
     * @returns {Promise<void>}
     */
    setSpriteVar(id, name, value) {
        return setSpriteVarOn(this.transport, id, name, Number(value));
    }

    /**
     * Reads back the next frame this context's engine presents: the canvas's
     * RGBA8 pixels, top row first, as a copy the caller owns. Works in both
     * topologies and without `preserveDrawingBuffer` — the engine takes the
     * frame inside the render that drew it. With `presentMode: 'manual'` the
     * read does not stall the next live frame. For offline export, pause the
     * render loop and pass `renderFrame: true`: each call is then exactly one
     * rendered, committed and captured frame.
     *
     * Each context reads its own engine into its own buffer, so contexts on one
     * shared Module can capture at the same time.
     *
     * @param {ProjectMCaptureFrameOptions} [options]
     * @returns {Promise<ProjectMCapturedFrame>}
     */
    captureFrame(options = {}) {
        if (!this.transport) {
            return Promise.reject(new Error('captureFrame(): the context has not started'));
        }
        return this.transport.captureFrame(options);
    }

    /**
     * What the engine negotiated with WebGL for this context: float color
     * buffers, float blending, `WEBGL_lose_context`, the dual-FBO format it
     * ended up with, the attributes the context really has (`attributes`) and
     * where those differ from the options it was started with (`mismatches`,
     * also logged as a warning). Read-only and frozen; it reports what `create_host_with_config()`
     * already settled and requests nothing. Null until `start()` has resolved,
     * and on a bundle that predates `get_context_snapshot()`. Read once at start,
     * and again after a successful context-loss recovery, which builds a new
     * context. Same in both topologies: in the worker topology it is the
     * worker's context that is described.
     *
     * @returns {ProjectMContextSnapshot | null}
     */
    get contextSnapshot() {
        return this.#contextSnapshot;
    }

    /**
     * Which topology this context ended up on: 'worker' when rendering is off
     * the main thread, 'main' when it is not. Hosts should need this only for
     * reporting — every engine op works the same either way.
     *
     * @returns {import('./projectm-transport-types.ts').RenderTopology | null}
     */
    getRenderTopology() {
        return this.transport?.topology ?? null;
    }

    /**
     * Hand PCM straight to the engine, wherever it is.
     *
     * @param {Float32Array} buffer Interleaved samples.
     * @param {number} [channels]
     */
    feedPcm(buffer, channels = 2) {
        this.transport?.feedPcm(buffer, channels);
    }

    /**
     * @returns {ProjectMAudioSourceStatus | null}
     */
    getAudioSourceStatus() {
        return this.audioRouter?.getStatus() ?? null;
    }

    /**
     * @param {import('./projectm-audio-source-router.js').ProjectMAudioSourceActive} source
     */
    setAudioSource(source) {
        this.audioRouter?.setActiveSource(source);
    }

    /**
     * Rebuild the engine after the browser restored a lost WebGL context.
     * Called by html/projectm-context-loss.js; hosts have no reason to call it
     * themselves. Activates this context's own host first, so a context sharing
     * a Module with others recovers its own engine and not a sibling's.
     *
     * @returns {Promise<number>} `init()`'s status: 0 recovered, 5 the context is
     *   still lost, anything else an init failure (-1 when not started).
     */
    async recoverContext() {
        const transport = this.transport;
        if (!transport) {
            return -1;
        }
        const status = await transport.recoverContext(this.canvas.width, this.canvas.height);
        if (status === 0 && this.transport === transport) {
            // A recovered engine runs on a new context; describe that one. (Not
            // if destroy() landed meanwhile: that context has nothing left to describe.)
            this.#contextSnapshot = readContextSnapshot(transport, contextConfigFor(this.options));
        }
        return status;
    }

    resize() {
        syncCanvasSize({
            transport: this.transport,
            container: this.container,
            mainCanvas: this.canvas,
            secondaryCanvas: this.secondaryCanvas,
            aspectCorrection: this.options.aspectCorrection,
            devicePixelRatio: resolveDevicePixelRatio(this.options),
            renderScale: this.renderScale,
        });
    }

    /**
     * Stops this context and releases everything it holds. A boot still in
     * flight is aborted: its `start()` promise rejects with an `AbortError`
     * (no `onError`, since nothing failed). Safe to call more than once.
     */
    destroy() {
        const alreadyDestroyed = this.destroyed;
        this.destroyed = true;
        this.#teardown();
        if (!alreadyDestroyed) {
            this.#emit('destroy', undefined);
        }
    }

    /**
     * This context's engine on the main thread: the module, bound to
     * `hostHandle` so every export called through it selects this context's
     * host first. The module itself for the single-engine default host; null in
     * the worker topology and before start().
     *
     * @returns {ProjectMModule | null}
     */
    get #engine() {
        return this.#bindEngine(this.module, this.hostHandle);
    }

    /**
     * Surfaces an init failure the engine reports for *this* context's host
     * after start() — a context-loss recovery whose init() failed, say —
     * through `onError` and the `error` event. Failures during start() are
     * reported where they happen, with their code; this subscription starts
     * after that. A sibling engine's failure is filtered out, and so is a
     * bundle that predates the host argument (it cannot say whose it was).
     */
    #watchEngineInitErrors() {
        const { windowRef } = this.options;
        if (!windowRef || !this.module) {
            return;
        }
        this.#own(subscribeWasmCallback('pmReportInitError', ({ host, code, detail }) => {
            // 5 is "the context is still lost": the context-loss overlay is up
            // and the restore event retries; not a failure to report.
            if (host === null || code === INIT_CONTEXT_LOST || this.destroyed) {
                return;
            }
            const suffix = detail ? `: ${detail}` : '';
            this.#reportError(new Error(`projectM engine init failed (init code ${code})${suffix}`), code);
        }, windowRef, { engineHost: this.hostHandle }));
    }

    /**
     * Surfaces a preset the engine could not switch to through `onError` and the
     * `error` event, as {@link PRESET_SWITCH_FAILED}. The engine reports it
     * through the callback bus (`pmOnPresetSwitchFailed`) instead of writing the
     * page's DOM, so this is the one place a failed preset becomes a page-visible
     * event. Main-thread engines only: a render worker's report stays in its own
     * console, as it always has.
     */
    #watchPresetSwitchFailures() {
        const { windowRef } = this.options;
        if (!windowRef || !this.module) {
            return;
        }
        // A context that booted its own Module never learns its handle
        // (checkInit() returns only the init code), so `hostHandle` is 0 there
        // while the engine's events carry the real one -- and `engineHost: 0`
        // means "the legacy default host", which would drop them. That engine is
        // the Module's only one, so it hears everything.
        const filter = this.hostHandle ? { engineHost: this.hostHandle } : {};
        this.#own(subscribeWasmCallback('pmOnPresetSwitchFailed', ({ preset, message }) => {
            if (this.destroyed) {
                return;
            }
            const name = preset.split('/').pop() || preset;
            const text = message ? `Preset failed: ${name} (${message})` : `Preset failed: ${name}`;
            const error = Object.assign(new Error(text), { preset });
            // Not deduplicated like #reportError(): each failed switch is its own event.
            this.options.onError?.({ code: PRESET_SWITCH_FAILED, message: text, error });
            this.#emit('error', { code: PRESET_SWITCH_FAILED, message: text, error });
        }, windowRef, filter));
    }

    #observeResize() {
        const follow = followContainerSize({
            container: this.container,
            windowRef: this.options.windowRef,
            onResize: () => this.resize(),
        });
        if (!follow) {
            return;
        }
        this.resizeObserver = follow.observer;
        this.#own(() => {
            follow.dispose();
            this.resizeObserver = null;
        });
    }

    /**
     * @param {(fps: number) => void} onFps
     * @param {AbortSignal} signal
     */
    #startFpsMonitor(onFps, signal) {
        if (!this.module) {
            // No frame counter to read on this thread — the worker already
            // measures its own frame rate and posts it every 500 ms.
            this.fpsTimer = 0;
            this.workerFpsSink = onFps;
            return;
        }
        this.#own(startFpsMonitor(this, {
            getEngine: () => this.#engine,
            stopped: () => signal.aborted || this.destroyed,
            onFps,
        }));
    }
}

/**
 * Convenience factory for hosts that prefer a functional entry point.
 * @param {ProjectMContextOptions} options
 */
export async function createProjectMContext(options) {
    const context = new ProjectMContext(options);
    await context.start();
    return context;
}

export { updatePresetDisplay };
