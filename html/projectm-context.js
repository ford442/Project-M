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

import { getAudioContext, setupAudioUnlock } from './projectm-audio-bootstrap.js';
import { installWorkletPlaybackSafetyNet } from './projectm-worklet-playback.js';
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
    RHYTHM_EVENT_TYPES,
    RhythmEventRelay,
    applyRhythmOptions,
    callRhythm,
    clampRhythmLatencyMs,
    measureOutputLatencyMs,
    loadPresetFileInto,
    loadPresetUrlInto,
    presetSwitchPolicyArgs,
    readRhythmInfo,
    relayPresetEvents,
} from './context/presets.js';
import {
    createEngineBinder,
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
/** How often `rhythmLatency: 'auto'` re-measures the output latency. */
const RHYTHM_LATENCY_REMEASURE_MS = 3000;

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
            if (this.options.rhythmLatency === 'auto') {
                // outputLatency is only known once the AudioContext runs, and it
                // changes with the output device: re-measure every few seconds.
                const nudge = this.options.rhythmLatencyNudge ?? 0;
                let applied = -1;
                const timer = setInterval(() => {
                    const ms = clampRhythmLatencyMs(measureOutputLatencyMs(getAudioContext()) + nudge);
                    if (Math.abs(ms - applied) >= 1) {
                        applied = this.setRhythmLatency(ms);
                    }
                }, RHYTHM_LATENCY_REMEASURE_MS);
                this.#own(() => clearInterval(timer));
            }
            this.#rhythm.sync(transport);
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
     * Delays the beat clock by the audio output latency, so beats, bars and the
     * preset switches scheduled on them land when the music is heard rather
     * than when it is analyzed.
     *
     * `'auto'` measures it from the shared AudioContext (outputLatency +
     * baseLatency) and adds `nudgeMs`, the user's "tap to align" correction.
     * A number sets it directly. Returns the latency applied, in ms.
     *
     * @param {number | 'auto'} latency Milliseconds (0..1000), or `'auto'`.
     * @param {number} [nudgeMs] Added to the measured latency in auto mode.
     * @returns {number}
     */
    setRhythmLatency(latency, nudgeMs = 0) {
        const ms =
            latency === 'auto'
                ? clampRhythmLatencyMs(measureOutputLatencyMs(getAudioContext()) + (Number(nudgeMs) || 0))
                : clampRhythmLatencyMs(Number(latency));
        callRhythm(this.transport, 'setRhythmLatencyMs', ms);
        return ms;
    }

    /**
     * Quantises bar and section switches to phrases: a switch only lands on a
     * downbeat that starts a phrase of `bars` bars, counted from the latest
     * detected section change.
     *
     * @param {number} bars Typically 4, 8 or 16; 0 turns it off.
     */
    setPresetSwitchPhrase(bars) {
        callRhythm(this.transport, 'setPresetSwitchPhrase', Number.isFinite(bars) && bars > 1 ? Math.round(bars) : 0);
    }

    /**
     * Hard cut ("drop" cut) on the first downbeat after each detected section change.
     *
     * @param {boolean} enabled
     */
    setSectionHardCut(enabled) {
        callRhythm(this.transport, 'setSectionHardCut', !!enabled);
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
