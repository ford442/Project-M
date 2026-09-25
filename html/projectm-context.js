import { ensureAudioRunning, setupAudioUnlock } from './projectm-audio-bootstrap.js';
import { ensureWorkletReady, installWorkletPlaybackSafetyNet } from './projectm-worklet-playback.js';
import {
    connectMediaElement,
    disconnectMediaElement,
    installMediaElementSourceHook,
} from './projectm-audio-element-source.js';
import {
    AudioSourceRouter,
    audioSourceToRouterSource,
    createAudioSourceRouter,
} from './projectm-audio-source-router.js';
import { claimGlobal } from './projectm-globals.js';
import { subscribeWasmCallback } from './projectm-wasm-callbacks.js';
import { setupContextLossRecovery } from './projectm-context-loss.js';
import {
    defaultFeedPCMToModule,
    flushQueuedExternalPCM,
    setExternalPcmTransport,
    setupExternalAudioReceiver,
} from './projectm-external-pcm.js';
import { getGovernorRenderScale, setQualityGovernorEnabled, setTargetFps } from './projectm-fps-governor.js';
import {
    buildWasmBundlePaths,
    createProjectMModule,
    loadProjectMWasmScript,
    observeModuleSize,
    resolveWasmScriptUrl,
} from './projectm-init.js';
import {
    createModuleTransport,
    installTransportPcmWriter,
    selectRenderTopology,
} from './projectm-render-transport.js';
import { isRenderWorkerEnabled, resolveRenderPathOverrides } from './projectm-render-worker-host.js';
import { checkCrossOriginIsolation, checkInit } from './projectm-init-errors.js';
import { setMeshQuality } from './projectm-mesh-quality.js';
import {
    loadPresetFromUrl,
    loadLocalPresetFile,
    updatePresetDisplay,
} from './projectm-presets.js';
import {
    startRender,
    setPresetLocked,
    setTransparencyMode,
    switchPreset,
    createHost,
    setActiveHost,
    destroyHost,
    setContextConfig,
} from './generated/projectm-wasm-api.js';

const DEFAULT_TARGET_FPS = 60;
let canvasIdSerial = 0;

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

    const versionPaths = wasmVersion ? buildWasmBundlePaths(wasmVersion) : null;
    const resolvedBaseUrl = wasmBaseUrl ?? import.meta.url;

    if (wasmScriptUrl) {
        await loadProjectMWasmScript({
            documentRef,
            baseUrl: resolvedBaseUrl,
            pmScript: wasmScriptUrl,
            rootScript: wasmScriptUrl,
            forceRefresh: true,
            signal,
        });
    } else {
        await loadProjectMWasmScript({
            documentRef,
            baseUrl: resolvedBaseUrl,
            ...(versionPaths
                ? { pmScript: versionPaths.pmScript, rootScript: versionPaths.rootScript }
                : {}),
            forceRefresh: Boolean(wasmVersion),
            signal,
        });
    }

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
 * Ensure a canvas has a document-unique id for Emscripten CSS selectors.
 * @param {HTMLCanvasElement} canvas
 * @param {string} prefix
 * @returns {string} The resulting element id (without `#`).
 */
function ensureCanvasElementId(canvas, prefix) {
    if (canvas.id) {
        return canvas.id;
    }
    canvasIdSerial += 1;
    const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().slice(0, 8)
        : `${canvasIdSerial}-${Math.random().toString(36).slice(2, 8)}`;
    canvas.id = `${prefix}-${suffix}`;
    return canvas.id;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string | undefined} explicitSelector
 * @param {string} idPrefix
 * @returns {string}
 */
function resolveCanvasSelector(canvas, explicitSelector, idPrefix) {
    if (explicitSelector) {
        return explicitSelector;
    }
    return `#${ensureCanvasElementId(canvas, idPrefix)}`;
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
 */

/**
 * An error shaped like the one `fetch()` rejects with when aborted, so callers
 * can tell "this was cancelled" from "this failed" by `error.name`.
 *
 * @param {string} message
 * @returns {Error}
 */
function createAbortError(message) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
    return !!error && typeof error === 'object' && /** @type {{ name?: unknown }} */ (error).name === 'AbortError';
}

/**
 * @param {HTMLMediaElement | string | null | undefined} value
 * @param {Document | undefined} documentRef
 * @returns {HTMLMediaElement | null}
 */
function resolveMediaElement(value, documentRef) {
    if (!value) {
        return null;
    }
    if (typeof value === 'string') {
        return /** @type {HTMLMediaElement | null} */ (documentRef?.querySelector(value)) ?? null;
    }
    return value;
}

/**
 * @param {{ transport: RenderTransport | null; container: Element; mainCanvas: HTMLCanvasElement; secondaryCanvas?: HTMLCanvasElement | null; aspectCorrection?: boolean; devicePixelRatio?: number; renderScale?: number }} options
 * @returns {boolean}
 */
function syncCanvasSize({
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
    // scaling stretches the smaller backing store to fill the unchanged layout box
    // — this is the "present upscale" for internal FBO render scale; no separate
    // offscreen blit is needed because everything (including the dual-FBO
    // compositor) renders at the backing-store resolution already.
    const scale = renderScale > 0 ? renderScale : 1;
    const layoutWidth = Math.max(1, Math.round(rect.width * devicePixelRatio));
    const layoutHeight = Math.max(1, Math.round(rect.height * devicePixelRatio));
    const width = Math.max(1, Math.round(rect.width * devicePixelRatio * scale));
    const height = Math.max(1, Math.round(rect.height * devicePixelRatio * scale));

    if (ownsBackingStore) {
        mainCanvas.width = width;
        mainCanvas.height = height;
    }
    mainCanvas.style.width = `${rect.width}px`;
    mainCanvas.style.height = `${rect.height}px`;

    if (secondaryCanvas) {
        if (ownsBackingStore) {
            secondaryCanvas.width = width;
            secondaryCanvas.height = height;
        }
        secondaryCanvas.style.width = `${rect.width}px`;
        secondaryCanvas.style.height = `${rect.height}px`;
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
     * matches the corresponding callback's argument. Unlike the window-level
     * `pm:*` events these belong to this context alone.
     *
     * @type {EventTarget}
     */
    events = new EventTarget();

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
            devicePixelRatio: globalThis.devicePixelRatio || 1,
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
        /** Latest stats posted by the render worker; null on the main thread. */
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
            wasmScriptUrl,
            wasmBaseUrl,
            wasmVersion,
            documentRef,
            windowRef,
            meshQuality,
            targetFps,
            qualityGovernor,
            transparent,
            transparencyThreshold,
            aspectCorrection,
            presetLocked,
            presetUrl,
            renderTopology,
            audioSource,
            audioElement,
            externalPcmOrigins,
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
            const versionPaths = wasmVersion ? buildWasmBundlePaths(wasmVersion) : null;
            const resolvedBaseUrl = wasmBaseUrl ?? import.meta.url;
            const sharedModule = this.options.sharedModule;

            if (sharedModule) {
                // Multi-instance path (#168 Phase B): reuse a Module booted by
                // bootProjectMSharedModule() and create a dedicated engine
                // instance inside it. create_host() sets its own canvas
                // selectors and inits the engine, returning an opaque handle;
                // every engine op below activates this host first.
                this.module = /** @type {ProjectMModule} */ (sharedModule);
                this.ownsModule = false;
                this.#claimWindowModule();
                // Context attributes are baked at context creation, which
                // create_host() does — configure them first.
                this.#applyContextConfig();
                const handle = createHost(
                    this.module,
                    this.primaryCanvasSelector,
                    this.secondaryCanvasSelector || '#scanvas'
                );
                if (!handle) {
                    const error = new Error(
                        'create_host() failed (instance cap reached or engine init failed)'
                    );
                    this.#reportError(error, 4);
                    throw error;
                }
                this.hostHandle = handle;
                this.transport = createModuleTransport(this.module);
            } else {
                // Topology first: the render worker takes the canvas by transfer,
                // so it has to be asked before anything on this thread touches a
                // drawing context. A worker that cannot start falls back to the
                // main thread here and the rest of start() is identical — that is
                // the whole point of the transport.
                const preferWorker = renderTopology === 'worker'
                    || (renderTopology === 'auto' && isRenderWorkerEnabled());
                if (preferWorker) {
                    // Assigned before the abort check so a transport that
                    // arrives after destroy() is still torn down by teardown.
                    this.transport = await this.#startRenderWorker({
                        resolvedBaseUrl,
                        wasmScriptUrl,
                        versionPaths,
                        wasmVersion,
                        targetFps,
                        qualityGovernor,
                        meshQuality,
                        signal,
                    });
                    this.#throwIfAborted(signal);
                    if (!this.transport && renderTopology === 'worker') {
                        throw new Error('renderTopology="worker" was requested but the render worker could not start');
                    }
                }

                if (!this.transport) {
                    if (wasmScriptUrl) {
                        await loadProjectMWasmScript({
                            documentRef,
                            baseUrl: resolvedBaseUrl,
                            pmScript: wasmScriptUrl,
                            rootScript: wasmScriptUrl,
                            forceRefresh: true,
                            signal,
                        });
                    } else {
                        await loadProjectMWasmScript({
                            documentRef,
                            baseUrl: resolvedBaseUrl,
                            ...(versionPaths
                                ? { pmScript: versionPaths.pmScript, rootScript: versionPaths.rootScript }
                                : {}),
                            forceRefresh: Boolean(wasmVersion),
                            signal,
                        });
                    }
                    this.#throwIfAborted(signal);

                    // A module factory cannot be cancelled once it is running,
                    // so this resolves even if destroy() happened meanwhile.
                    // Assigning it first means teardown destructs it.
                    this.module = /** @type {ProjectMModule} */ (await createProjectMModule({
                        scriptSrc: wasmScriptUrl || undefined,
                        wasmVersion,
                        baseUrl: resolvedBaseUrl,
                        documentRef,
                        windowRef,
                        noInitialRun: true,
                        primaryCanvasSelector: this.primaryCanvasSelector,
                        secondaryCanvasSelector: this.secondaryCanvasSelector,
                        signal,
                    }));
                    this.#throwIfAborted(signal);
                    this.#claimWindowModule();

                    // Context attributes are baked when checkInit() creates the
                    // WebGL context — configure them first.
                    this.#applyContextConfig();

                    if (!checkInit(this.module, {
                        primaryCanvasSelector: this.primaryCanvasSelector,
                        secondaryCanvasSelector: this.secondaryCanvasSelector,
                    })) {
                        const error = new Error('projectM init() failed');
                        this.#reportError(error, -1);
                        throw error;
                    }

                    this.transport = createModuleTransport(this.module);
                }
            }

            const transport = /** @type {RenderTransport} */ (this.transport);
            // External PCM arrives on this thread either way; tell it which
            // engine to hand the samples to. A claim, not an assignment: the
            // release below leaves a sibling context's registration alone.
            this.#own(setExternalPcmTransport(transport));

            this.audioRouter = this.#attachAudioRouter(existingAudioRouter, transport, audioSource, onAudioSourceChange);

            this.#own(setupAudioUnlock());
            this.#own(installWorkletPlaybackSafetyNet());
            // The worklet runs on this thread in both topologies; this is what
            // decides where its PCM goes.
            this.#own(installTransportPcmWriter(transport));
            if (this.module) {
                this.#own(setupContextLossRecovery(this.module, {
                    canvasSelector: this.primaryCanvasSelector,
                }));
            }

            // Everything from here drives the engine; make this context's host
            // active first (no-op for the single-instance default host). The
            // calls below run synchronously without yielding, so one activation
            // covers the whole startup control sequence.
            this.#activate();

            syncCanvasSize({
                transport,
                container: this.container,
                mainCanvas: this.canvas,
                secondaryCanvas: this.secondaryCanvas,
                aspectCorrection,
                devicePixelRatio: this.options.devicePixelRatio,
                renderScale: this.renderScale,
            });

            if (this.module) {
                // The worker calls _start_render() itself, on its own canvas,
                // before it reports ready.
                startRender(this.module, this.canvas.width, this.canvas.height);
            }
            flushQueuedExternalPCM();

            if (this.module) {
                // Mesh/fps/governor go to the worker in its init message, since
                // it must have them before the first frame. Setting them again
                // over the wire would be a second source of truth.
                setMeshQuality(this.module, meshQuality);
                setTargetFps(this.module, targetFps);
                setQualityGovernorEnabled(this.module, qualityGovernor);
            }
            transport.callVoid('setPresetLocked', presetLocked);

            // Governor v2 (docs/PERFORMANCE.md): sync the starting render scale, then
            // resize on every tier change (WasmPerfGovernor.cpp pushes here via
            // js_governor_report_render_scale()). Shrinking the canvas backing store
            // while keeping its CSS size fixed is what actually applies the "internal
            // FBO render scale" tier — see the comment in syncCanvasSize() above.
            //
            // In the worker topology the backing store is not ours to shrink, so
            // the worker applies the same factor to the canvas it owns and this
            // thread keeps renderScale at 1 — see html/projectm-render-worker.js.
            if (this.module) {
                this.renderScale = getGovernorRenderScale(this.module) || 1;
                // Via the injected windowRef, like every other global hook this class
                // installs — a bare `window` here ignores the caller's window and
                // throws outright where there is no global one. The engine calls the
                // hook by its global name, so it goes through the callback bus: every
                // context listens, and destroying one leaves the rest subscribed.
                if (this.options.windowRef) {
                    this.#own(subscribeWasmCallback('pmOnGovernorRenderScaleChange', (/** @type {number} */ scale) => {
                        this.renderScale = scale;
                        this.resize();
                    }, this.options.windowRef));
                }
            }

            if (transparent) {
                transport.callVoid('setTransparencyMode', true);
                if (typeof transparencyThreshold === 'number') {
                    transport.callVoid('setTransparencyThreshold', transparencyThreshold);
                }
                if (this.secondaryCanvas) {
                    this.secondaryCanvas.style.display = 'none';
                }
            }

            this.#wireAudio(audioSource, audioElement, externalPcmOrigins, signal);
            if (!existingAudioRouter) {
                this.audioRouter.setModule(this.module);
                this.audioRouter.setTransport(transport);
            }
            this.#observeResize();
            this.#wirePresetEvents(onPresetChanged);

            if (presetUrl) {
                await this.loadPresetUrl(presetUrl);
                this.#throwIfAborted(signal);
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
     * Registers an undo step for something this context just acquired. It runs
     * when the context is destroyed, and when a start that acquired it fails.
     *
     * @param {(() => void) | null | undefined} dispose
     */
    #own(dispose) {
        if (typeof dispose === 'function') {
            this.#disposers.push(dispose);
        }
    }

    /** @param {AbortSignal} signal */
    #throwIfAborted(signal) {
        if (signal.aborted) {
            throw createAbortError('ProjectMContext was destroyed during start()');
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
     * Creates this context's audio router, or adopts the host's.
     *
     * A router the context created is its own and is destroyed with it. One the
     * host injected (core.html shares a single router between the page and its
     * context) belongs to the host: teardown only detaches this context from it
     * and restores its status callback.
     *
     * @param {AudioSourceRouter | null | undefined} existingRouter
     * @param {RenderTransport} transport
     * @param {ProjectMAudioSource | undefined} audioSource
     * @param {((status: ProjectMAudioSourceStatus) => void) | undefined} onAudioSourceChange
     * @returns {AudioSourceRouter}
     */
    #attachAudioRouter(existingRouter, transport, audioSource, onAudioSourceChange) {
        /** @param {ProjectMAudioSourceStatus} status */
        const publish = (status) => {
            onAudioSourceChange?.(status);
            this.#emit('audio-source', status);
        };

        if (!existingRouter) {
            const created = createAudioSourceRouter({
                module: this.module,
                transport,
                initialSource: audioSourceToRouterSource(audioSource),
                onStatusChange: publish,
            });
            this.#own(() => created.destroy());
            return created;
        }

        existingRouter.setModule(this.module);
        existingRouter.setTransport(transport);
        const prior = existingRouter.onStatusChange;
        /** @param {ProjectMAudioSourceStatus} status */
        const wrapped = (status) => {
            prior?.(status);
            publish(status);
        };
        existingRouter.onStatusChange = wrapped;
        const attachedModule = this.module;
        this.#own(() => {
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
        if (!this.transport) {
            throw new Error('ProjectMContext is not started');
        }
        const transport = this.transport;
        const signal = this.#attempt?.signal;
        this.#activate();
        if (this.module) {
            return loadPresetFromUrl(url, {
                module: this.module,
                windowRef: this.options.windowRef,
                signal,
            });
        }

        // Worker topology: the fetch still happens here — this thread has the
        // page's credentials and cache — and only the bytes cross, to be
        // written into the VFS on the other side.
        const response = await fetch(url, signal ? { signal } : undefined);
        if (!response.ok) {
            throw new Error(`Failed to fetch preset (${response.status}): ${url}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (signal?.aborted || this.transport !== transport) {
            throw createAbortError(`Preset load aborted: ${url}`);
        }
        const filename = String(url).split('/').pop()?.split('?')[0] || 'preset.milk';
        const vfsPath = `/presets/url_${filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
        transport.writePreset(vfsPath, bytes);
        updatePresetDisplay(vfsPath, { windowRef: this.options.windowRef });
        return { url, vfsPath, filename };
    }

    /**
     * @param {File} file
     * @returns {Promise<{ filename: string; vfsPath: string }>}
     */
    async loadPresetFile(file) {
        if (!this.transport) {
            throw new Error('ProjectMContext is not started');
        }
        const transport = this.transport;
        this.#activate();
        if (this.module) {
            return loadLocalPresetFile(file, {
                module: this.module,
                updateDisplay: true,
            });
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        if (this.transport !== transport) {
            throw createAbortError(`Preset load aborted: ${file.name}`);
        }
        const vfsPath = `/presets/local_${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
        transport.writePreset(vfsPath, bytes);
        let text;
        try {
            text = new TextDecoder().decode(bytes);
        } catch {
            text = undefined;
        }
        updatePresetDisplay(vfsPath, { documentRef: this.options.documentRef, text });
        return { filename: file.name, vfsPath };
    }

    /**
     * Add a preset to the playlist without switching to it.
     *
     * @param {string} vfsPath
     * @param {Uint8Array} bytes
     */
    addPreset(vfsPath, bytes) {
        this.#activate();
        this.transport?.writePreset(vfsPath, bytes, 'add');
    }

    /**
     * @param {number} threshold RGB cutoff below which pixels go transparent.
     */
    setTransparencyThreshold(threshold) {
        this.#activate();
        this.transport?.callVoid('setTransparencyThreshold', threshold);
    }

    nextPreset() {
        this.#activate();
        if (this.transport) {
            this.transport.callVoid('switchPreset');
            return;
        }
        if (!this.module) {
            return;
        }
        switchPreset(this.module);
    }

    /** @param {boolean} locked */
    setLocked(locked) {
        this.#activate();
        if (this.transport) {
            this.transport.callVoid('setPresetLocked', locked);
            return;
        }
        if (!this.module) {
            return;
        }
        setPresetLocked(this.module, locked);
    }

    /** @param {boolean} enabled */
    setTransparent(enabled) {
        this.#activate();
        if (this.transport) {
            this.transport.callVoid('setTransparencyMode', enabled);
        } else if (this.module) {
            setTransparencyMode(this.module, enabled);
        } else {
            return;
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
        this.#activate();
        if (this.module) {
            // 'auto' resolves against the device, which needs the module's own
            // view of it; only the resolved grid crosses to the worker.
            return setMeshQuality(this.module, quality);
        }
        if (!this.transport) {
            return;
        }
        this.#activate();
        const grid = quality === 'low' ? [64, 48] : [80, 60];
        this.transport.callVoid('setMesh', grid[0], grid[1]);
        return quality;
    }

    /**
     * @param {number} fps
     * @returns {number | undefined}
     */
    setTargetFps(fps) {
        this.#activate();
        if (this.module) {
            return setTargetFps(this.module, fps);
        }
        if (!this.transport) {
            return;
        }
        this.#activate();
        this.transport.callVoid('setTargetFps', fps);
        return fps;
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
        this.#activate();
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

    resize() {
        this.#activate();
        syncCanvasSize({
            transport: this.transport,
            container: this.container,
            mainCanvas: this.canvas,
            secondaryCanvas: this.secondaryCanvas,
            aspectCorrection: this.options.aspectCorrection,
            devicePixelRatio: this.options.devicePixelRatio,
            renderScale: this.renderScale,
        });
    }

    /**
     * Make this context's engine the active host before a control op. No-op for
     * the single-instance default host (hostHandle 0), where there is only one
     * engine and set_active_host would be redundant.
     */
    #activate() {
        if (this.hostHandle && this.module) {
            setActiveHost(this.module, this.hostHandle);
        }
    }

    /**
     * Forward WebGL context attributes + dual-FBO precision to the WASM host
     * before it creates the context. Options default to MSAA off,
     * preserveDrawingBuffer off, depth/stencil off (#246 — the canvas only
     * receives a fullscreen quad + sprites), high-performance GPU and RGBA16F
     * precision. The WASM host applies this to the engine create_host() makes
     * next, so each context in a shared Module keeps its own attributes.
     */
    #applyContextConfig() {
        if (!this.module || typeof setContextConfig !== 'function') {
            return;
        }
        const c = this.#contextConfig();
        setContextConfig(
            this.module,
            c.antialias,
            c.preserveDrawingBuffer,
            c.depth,
            c.stencil,
            c.alpha,
            c.powerPreference,
            c.fboPrecision
        );
        // Bundles that predate the export read the switches from the URL
        // themselves, which works on this thread.
        if (typeof this.module._set_render_path_overrides === 'function') {
            const r = this.#renderPathOverrides();
            this.module._set_render_path_overrides(
                r.blurCopyPath ? 1 : 0,
                r.copyShaderPath ? 1 : 0,
                r.perPixelForceCpu ? 1 : 0
            );
        }
    }

    /**
     * `set_context_config()`'s arguments for this context's options — applied
     * here on the main thread, and sent in the render worker's `init` message.
     *
     * @returns {import('./projectm-render-worker-types.ts').RenderWorkerContextConfig}
     */
    #contextConfig() {
        const o = this.options;
        /** @type {Record<string, number>} */
        const powerMap = { 'default': 0, 'low-power': 1, 'high-performance': 2 };
        // The FboFloatFormat numbering, which dual_fbo_get_format() also reports.
        /** @type {Record<string, number>} */
        const fboMap = { 'half': 0, 'high': 1, 'byte': 2 };
        return {
            antialias: o.antialias ? 1 : 0,
            preserveDrawingBuffer: o.preserveDrawingBuffer ? 1 : 0,
            depth: o.depth ? 1 : 0,
            stencil: o.stencil ? 1 : 0,
            // Context alpha stays on (transparency overlays); the `alpha` option
            // is a separate canvas-CSS hint, not the WebGL alpha attribute.
            alpha: 1,
            powerPreference: powerMap[o.powerPreference ?? 'high-performance'] ?? 2,
            fboPrecision: fboMap[o.fboPrecision ?? 'half'] ?? 0,
        };
    }

    /** @returns {import('./projectm-render-worker-types.ts').RenderPathOverrides} */
    #renderPathOverrides() {
        return this.options.renderPathOverrides
            ?? resolveRenderPathOverrides(this.options.windowRef?.location?.search ?? '');
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
     * @param {ProjectMAudioSource} audioSource
     * @param {HTMLMediaElement | string | undefined} audioElementOption
     * @param {string[] | undefined} externalPcmOrigins
     * @param {AbortSignal} signal
     */
    #wireAudio(audioSource, audioElementOption, externalPcmOrigins, signal) {
        const router = this.audioRouter;

        if (audioSource === 'external') {
            const receiver = setupExternalAudioReceiver({
                allowedOrigins: externalPcmOrigins ?? [],
                // This context's own engine, so the receiver keeps feeding it
                // whatever another context registers as the page default.
                transport: this.transport,
                feedGate: () => router?.externalFeedGate() ?? false,
                onFeed: router
                    ? router.wrapExternalFeed(defaultFeedPCMToModule)
                    : defaultFeedPCMToModule,
            });
            this.#own(receiver.close);
            return;
        }

        if (audioSource !== 'element') {
            // Keep shared host routers (e.g. core.html autoSwitchOnFeed) at 'none'
            // so the first external/worklet feed can promote the active source.
            if (!this.options.audioRouter) {
                router?.setActiveSource('none');
            }
            return;
        }

        const media = this.audioElement ?? resolveMediaElement(audioElementOption, this.options.documentRef);
        if (!media) {
            console.warn('[ProjectMContext] audioSource=element but no audio element was provided');
            return;
        }

        router?.setActiveSource('element');
        this.audioElement = media;
        media.id = media.id || 'audio-stream-element';
        installMediaElementSourceHook();
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
                    this.#own(() => disconnectMediaElement(media));
                }
            })
            .catch((err) => {
                console.warn('[ProjectMContext] could not connect audio element:', err);
            });
    }

    /**
     * Boot the render worker and wrap it in a transport, or resolve null so
     * start() falls back to the main thread.
     *
     * @param {object} options
     * @param {string} options.resolvedBaseUrl
     * @param {string | undefined} options.wasmScriptUrl
     * @param {{ pmScript: string, rootScript: string } | null} options.versionPaths
     * @param {string | undefined} options.wasmVersion
     * @param {number | undefined} options.targetFps
     * @param {boolean | undefined} options.qualityGovernor
     * @param {ProjectMMeshQuality | undefined} options.meshQuality
     * @param {AbortSignal} options.signal
     * @returns {Promise<RenderTransport | null>}
     */
    async #startRenderWorker({
        resolvedBaseUrl,
        wasmScriptUrl,
        versionPaths,
        wasmVersion,
        targetFps,
        qualityGovernor,
        meshQuality,
        signal,
    }) {
        // The worker importScripts() the glue itself, so it needs an absolute
        // URL — resolved the same way the main-thread path resolves it, so both
        // topologies load the same bundle.
        let scriptSrc;
        try {
            const candidate = wasmScriptUrl ?? await resolveWasmScriptUrl({
                documentRef: this.options.documentRef,
                baseUrl: resolvedBaseUrl,
                ...(versionPaths
                    ? { pmScript: versionPaths.pmScript, rootScript: versionPaths.rootScript }
                    : {}),
                forceRefresh: Boolean(wasmVersion),
                signal,
            });
            scriptSrc = new URL(candidate, resolvedBaseUrl).href;
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            this.options.onRenderWorkerFallback?.(`could not resolve the WASM bundle URL: ${error}`);
            return null;
        }

        // Ask for the layout size: the worker sizes its own backing store from
        // it, including the governor's render scale.
        const rect = this.container.getBoundingClientRect();
        const dpr = this.options.devicePixelRatio || 1;

        return selectRenderTopology({
            canvas: this.canvas,
            preferWorker: true,
            scriptSrc,
            width: Math.max(1, Math.round(rect.width * dpr)),
            height: Math.max(1, Math.round(rect.height * dpr)),
            targetFps,
            governor: qualityGovernor,
            meshQuality,
            // The worker creates its context and picks its render paths in its
            // own init(); these have to travel with the init message.
            contextConfig: this.#contextConfig(),
            renderPathOverrides: this.#renderPathOverrides(),
            signal,
            onFallback: (reason) => {
                this.options.onRenderWorkerFallback?.(reason);
            },
            onError: (message) => {
                // A live worker reporting a problem after a successful boot.
                this.#reportRuntimeError(message);
            },
            onStats: (stats) => {
                this.workerStats = /** @type {any} */ (stats);
                this.workerFpsSink?.(/** @type {any} */ (stats).fps);
            },
        });
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

    #observeResize() {
        const observer = observeModuleSize({
            container: this.container,
            sync: () => this.resize(),
        });
        if (observer) {
            this.resizeObserver = observer;
            this.#own(() => {
                observer.disconnect();
                this.resizeObserver = null;
            });
            return;
        }

        // No ResizeObserver: fall back to window resizes, on the same window the
        // rest of this class is told to use, and take the listener off again.
        const target = /** @type {EventTarget | undefined} */ (this.options.windowRef ?? globalThis);
        if (typeof target?.addEventListener === 'function') {
            const onResize = () => this.resize();
            target.addEventListener('resize', onResize);
            this.#own(() => target.removeEventListener('resize', onResize));
        }
    }

    /** @param {((detail: ProjectMPresetDetail) => void) | undefined} onPresetChanged */
    #wirePresetEvents(onPresetChanged) {
        const { windowRef } = this.options;
        if (!windowRef?.addEventListener) {
            return;
        }
        const listener = (/** @type {Event} */ event) => {
            const detail = /** @type {CustomEvent<ProjectMPresetDetail>} */ (event).detail;
            onPresetChanged?.(detail);
            this.#emit('preset-changed', detail);
        };
        windowRef.addEventListener('pm:preset-loaded', listener);
        this.#own(() => windowRef.removeEventListener('pm:preset-loaded', listener));
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

        const sample = () => {
            if (signal.aborted || this.destroyed || !this.module) {
                return;
            }

            const now = performance.now();
            this.#activate();
            const frameCount = this.module._get_rendered_frame_count?.() ?? 0;
            if (!this.fpsLastSample) {
                this.fpsLastSample = now;
                this.fpsFrameCount = frameCount;
            }

            const elapsed = (now - this.fpsLastSample) / 1000;
            if (elapsed >= 1) {
                const fps = (frameCount - this.fpsFrameCount) / elapsed;
                onFps(fps);
                this.fpsLastSample = now;
                this.fpsFrameCount = frameCount;
            }

            this.fpsTimer = requestAnimationFrame(sample);
        };
        this.fpsTimer = requestAnimationFrame(sample);
        this.#own(() => {
            if (this.fpsTimer) {
                cancelAnimationFrame(this.fpsTimer);
                this.fpsTimer = 0;
            }
            this.fpsLastSample = 0;
        });
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
