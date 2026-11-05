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
//   context/controls.js the base class: engine controls, events, on()
//   context/wiring.js   the hooks and engine reports start() wires up
//
// Those modules keep no state of their own: whatever they acquire comes back
// here and is registered on this context's teardown list.

import { claimGlobal } from './projectm-globals.js';
import { flushQueuedExternalPCM } from './projectm-external-pcm.js';
import { getGovernorRenderScale } from './projectm-fps-governor.js';
import { checkCrossOriginIsolation } from './projectm-init-errors.js';
import { toDisposeFunction } from './projectm-disposables.js';
import { updatePresetDisplay } from './projectm-presets.js';
import { startRender } from './generated/projectm-wasm-api.js';
import {
    bootEngine,
    bootSharedModule,
    contextConfigFor,
    createAbortError,
    isAbortError,
    releaseEngine,
    resolveCanvasSelector,
    resolveContextOptions,
    throwIfAborted,
} from './context/boot.js';
import { attachAudioRouter, resolveMediaElement, wireAudioSource } from './context/audio.js';
import { applyRhythmOptions, loadPresetFileInto, loadPresetUrlInto, relayPresetEvents } from './context/presets.js';
import {
    followContainerSize,
    readContextSnapshot,
    resolveDevicePixelRatio,
    startFpsMonitor,
    syncCanvasSize,
} from './context/render.js';
import {
    ProjectMContextControls,
    emitContextEvent,
    engineOf,
    rhythmOf,
    setContextSnapshot,
} from './context/controls.js';
import {
    PRESET_SWITCH_FAILED,
    applyEngineSettings,
    applyInitialFlashLimit,
    followGovernorRenderScale,
    installPlaybackHooks,
    installTransportHooks,
    watchEngineInitErrors,
    watchPresetSwitchFailures,
} from './context/wiring.js';

// Re-exported for embedders (`@projectm/web/context`): the encoder behind the
// context options, for hosts that create engines through the raw exports.
export { CONTEXT_CONFIG_FLAGS, resolveWasmContextConfig } from './projectm-context-config.js';

export { PRESET_SWITCH_FAILED };

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
 * @param {import('./context/boot.js').SharedModuleOptions} [options]
 * @returns {Promise<ProjectMModule>}
 */
export async function bootProjectMSharedModule(options = {}) {
    return bootSharedModule(options, DEFAULT_BASE_URL);
}

/**
 * @typedef {import('./projectm-context-types.ts').ProjectMContextOptions} ProjectMContextOptions
 * @typedef {import('./projectm-context-types.ts').ProjectMResolvedContextOptions} ProjectMResolvedContextOptions
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('./projectm-transport-types.ts').RenderTransport} RenderTransport
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
export class ProjectMContext extends ProjectMContextControls {
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
    /** The container's last observed device-pixel content box (see resize()). */
    #devicePixelSize = /** @type {import('./context/render.js').DevicePixelSize | null} */ (null);

    /** @param {ProjectMContextOptions} options */
    constructor(options) {
        if (!options?.canvas) {
            throw new Error('ProjectMContext requires a canvas element');
        }
        super();

        /** @type {ProjectMResolvedContextOptions} */
        this.options = resolveContextOptions(options);

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
        /**
         * Latest stats posted by the render worker; null on the main thread.
         * @type {(Record<string, unknown> & { fps?: number }) | null}
         */
        this.workerStats = null;
        /** @type {((fps: number) => void) | undefined} */
        this.workerFpsSink = undefined;
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

            installTransportHooks({ transport, documentRef, windowRef }).forEach((d) => this.#own(d));

            this.audioRouter = attachAudioRouter({
                existingRouter: existingAudioRouter,
                module: this.module,
                transport,
                audioSource,
                publish: (status) => {
                    onAudioSourceChange?.(status);
                    emitContextEvent(this, 'audio-source', status);
                },
                own: (dispose) => this.#own(dispose),
            });

            installPlaybackHooks({ transport, context: this, canvas: this.canvas, documentRef, windowRef })
                .forEach((d) => this.#own(d));
            applyInitialFlashLimit(transport, this.options);

            // Everything from here drives the engine, through the transport or
            // #engine. Both select this context's host on every call, so the
            // `await this.loadPresetUrl()` below cannot resume on a sibling's
            // engine; nothing here relies on an activation lasting.

            this.resize();

            const engine = engineOf(this);
            if (engine) {
                // The worker calls _start_render() itself, on its own canvas,
                // before it reports ready.
                startRender(engine, this.canvas.width, this.canvas.height);
            }
            flushQueuedExternalPCM();

            if (engine) {
                applyEngineSettings(engine, this.options);
            }
            transport.callVoid('setPresetLocked', presetLocked);
            applyRhythmOptions(this.options, this);
            rhythmOf(this).sync(transport);

            // Governor v2 render scale; see followGovernorRenderScale() in context/wiring.js.
            if (engine) {
                this.renderScale = getGovernorRenderScale(engine) || 1;
                this.#own(followGovernorRenderScale({
                    windowRef,
                    engineHost: this.hostHandle,
                    onScaleChange: (scale) => {
                        this.renderScale = scale;
                        this.resize();
                    },
                }));
            }
            this.#watchEngineReports();

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
                emitContextEvent(this, 'preset-changed', detail);
            }));

            setContextSnapshot(this, readContextSnapshot(transport, contextConfigFor(this.options)));

            if (presetUrl) {
                await this.loadPresetUrl(presetUrl);
                throwIfAborted(signal);
            }

            this.ready = true;
            if (onFps) {
                this.#startFpsMonitor(onFps, signal);
            }

            onReady?.(this);
            emitContextEvent(this, 'ready', undefined);
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
        emitContextEvent(this, 'error', { code, message, error });
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
        emitContextEvent(this, 'error', { code: -1, message, error });
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
        rhythmOf(this).detach();
        setContextSnapshot(this, null);

        const disposers = this.#disposers.splice(0).reverse();
        for (const dispose of disposers) {
            try {
                dispose();
            } catch (error) {
                console.warn('[ProjectMContext] cleanup step failed:', error);
            }
        }

        const { module, transport, hostHandle } = this;
        this.hostHandle = 0;
        this.transport = null;
        this.module = null;
        releaseEngine({ module, transport, hostHandle, ownsModule: this.ownsModule });
        this.audioRouter = null;
        this.workerStats = null;
        this.workerFpsSink = undefined;
    }


    /**
     * @param {string} url
     * @returns {Promise<{ url: string; vfsPath: string; filename: string }>}
     */
    async loadPresetUrl(url) {
        const transport = this.#requireTransport();
        return loadPresetUrlInto(url, {
            transport,
            engine: engineOf(this),
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
            engine: engineOf(this),
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
            setContextSnapshot(this, readContextSnapshot(transport, contextConfigFor(this.options)));
        }
        return status;
    }

    /**
     * Sizes the canvases to the container. The context calls this itself
     * whenever the container, the devicePixelRatio or the governor's render
     * scale changes; hosts only need it after changing `options` that affect
     * the size (aspect correction, an explicit devicePixelRatio).
     */
    resize() {
        // The observed device-pixel box only holds while the ratio is the
        // window's: a host-pinned devicePixelRatio means "size by this ratio".
        const devicePixelSize = this.options.devicePixelRatio ? null : this.#devicePixelSize;
        syncCanvasSize({
            transport: this.transport,
            container: this.container,
            mainCanvas: this.canvas,
            secondaryCanvas: this.secondaryCanvas,
            aspectCorrection: this.options.aspectCorrection,
            devicePixelRatio: resolveDevicePixelRatio(this.options),
            renderScale: this.renderScale,
            devicePixelSize,
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
            emitContextEvent(this, 'destroy', undefined);
        }
    }

    /** Engine reports that become this context's errors; see context/wiring.js. */
    #watchEngineReports() {
        const { windowRef } = this.options;
        if (!windowRef || !this.module) {
            return;
        }
        const isDestroyed = () => this.destroyed;
        this.#own(watchEngineInitErrors({
            windowRef,
            engineHost: this.hostHandle,
            isDestroyed,
            report: (error, code) => this.#reportError(error, code),
        }));
        this.#own(watchPresetSwitchFailures({
            windowRef,
            engineHost: this.hostHandle,
            isDestroyed,
            report: (detail) => {
                this.options.onError?.(detail);
                emitContextEvent(this, 'error', { ...detail });
            },
        }));
    }

    #observeResize() {
        const follow = followContainerSize({
            container: this.container,
            windowRef: this.options.windowRef,
            onResize: (devicePixelSize) => {
                this.#devicePixelSize = devicePixelSize;
                this.resize();
            },
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
            getEngine: () => engineOf(this),
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
