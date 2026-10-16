// projectm-context.js
//
// ProjectMContext: the high-level embed API. The boot sequence lives in
// projectm-context-boot.js (ordered steps that unwind on failure) and the
// musical-time surface in projectm-rhythm-facade.js; this file is the public
// class, its lifecycle and the engine ops.

import { setTargetFps } from './projectm-fps-governor.js';
import { setMeshQuality } from './projectm-mesh-quality.js';
import {
    loadPresetFromUrl,
    loadLocalPresetFile,
    updatePresetDisplay,
} from './projectm-presets.js';
import {
    bindModuleToHost,
    setPresetLocked,
    setTransparencyMode,
    switchPreset,
    destroyHost,
} from './generated/projectm-wasm-api.js';
import { CONTEXT_CONFIG_FLAGS, resolveWasmContextConfig } from './projectm-context-config.js';
import { resolveRenderPathOverrides } from './projectm-render-worker-host.js';
import {
    createAbortError,
    createContextBootSteps,
    isAbortError,
    runBootSteps,
    syncCanvasSize,
} from './projectm-context-boot.js';
import { RhythmFacade } from './projectm-rhythm-facade.js';

// Re-exported for embedders (`@projectm/web/context`): the encoder behind the
// context options, for hosts that create engines through the raw exports, and
// the shared-Module boot.
export { CONTEXT_CONFIG_FLAGS, resolveWasmContextConfig } from './projectm-context-config.js';
export { bootProjectMSharedModule } from './projectm-context-boot.js';

const DEFAULT_TARGET_FPS = 60;
let canvasIdSerial = 0;

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
 * @typedef {import('./projectm-context-types.ts').ProjectMPresetSwitchPolicy} ProjectMPresetSwitchPolicy
 * @typedef {import('./projectm-context-types.ts').ProjectMRhythmInfo} ProjectMRhythmInfo
 * @typedef {import('./projectm-context-types.ts').ProjectMCapturedFrame} ProjectMCapturedFrame
 * @typedef {import('./projectm-context-types.ts').ProjectMCaptureFrameOptions} ProjectMCaptureFrameOptions
 * @typedef {import('./projectm-context-types.ts').ProjectMFlashLimitStats} ProjectMFlashLimitStats
 * @typedef {import('./projectm-audio-source-router.js').AudioSourceRouter} AudioSourceRouter
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

    /** beat/bar/section subscriptions and the tempo / switch-policy controls. */
    #rhythm = new RhythmFacade({
        getTransport: () => this.transport,
        getHostHandle: () => this.hostHandle,
        emit: (type, detail) => this.#emit(type, detail),
    });
    /** Whether setTransparent() already warned that the canvas has no alpha channel. */
    #warnedNoAlpha = false;

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
    /** `#engine`'s cache: the module and host it was bound for, and the view. */
    #engineView = /** @type {{ module: ProjectMModule, host: number, view: ProjectMModule } | null} */ (null);

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
        /**
         * Latest stats posted by the render worker; null on the main thread.
         * @type {any}
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
        this.#reportedError = undefined;
        this.ownsModule = !this.options.sharedModule;
        try {
            await runBootSteps(createContextBootSteps(), {
                context: this,
                own: (dispose) => this.#own(dispose),
                throwIfAborted: (s) => this.#throwIfAborted(s),
                reportError: (error, code) => this.#reportError(error, code),
                reportRuntimeError: (message) => this.#reportRuntimeError(message),
                emit: (type, detail) => this.#emit(type, detail),
                engine: () => this.#engine,
                teardownEngine: () => this.#teardownEngine(),
                contextConfig: () => this.#contextConfig(),
                renderPathOverrides: () => this.#renderPathOverrides(),
                rhythm: this.#rhythm,
            }, signal);
            return this;
        } catch (error) {
            // Read this BEFORE tearing down: teardown aborts the signal itself,
            // so afterwards every failure would look like a cancellation.
            const cancelled = signal.aborted;
            // Release whatever this attempt had acquired before it failed (the
            // boot steps undid their own already): the Module and WebGL
            // context, or the Worker. Browsers cap live WebGL contexts at
            // roughly 16 and then drop the oldest, so a start that fails
            // repeatedly must not keep them.
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
        const engine = this.#engine;
        if (engine) {
            // The fetch yields; the load after it goes through `engine`, which
            // selects this context's host again however long that took.
            return loadPresetFromUrl(url, {
                module: engine,
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
        const engine = this.#engine;
        if (engine) {
            return loadLocalPresetFile(file, {
                module: engine,
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
        if (!engine) {
            return;
        }
        switchPreset(engine);
    }

    /** @param {boolean} locked */
    setLocked(locked) {
        if (this.transport) {
            this.transport.callVoid('setPresetLocked', locked);
            return;
        }
        const engine = this.#engine;
        if (!engine) {
            return;
        }
        setPresetLocked(engine, locked);
    }

    /**
     * Glass-layer transparency. It shows the page through near-black pixels
     * only if the canvas has an alpha channel, which is fixed when the WebGL
     * context is created (`contextAlpha`, default: the `transparent` option):
     * a host that toggles it at run time should pass `contextAlpha: true`.
     *
     * @param {boolean} enabled
     */
    setTransparent(enabled) {
        if (enabled && !this.#warnedNoAlpha
            && !(this.#contextConfig().flags & CONTEXT_CONFIG_FLAGS.contextAlpha)) {
            this.#warnedNoAlpha = true;
            console.warn('[ProjectMContext] setTransparent(true): this canvas was created without an alpha '
                + 'channel, so transparent pixels render opaque. Create the context with contextAlpha: true.');
        }
        const engine = this.#engine;
        if (this.transport) {
            this.transport.callVoid('setTransparencyMode', enabled);
        } else if (engine) {
            setTransparencyMode(engine, enabled);
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
        const engine = this.#engine;
        if (engine) {
            // 'auto' resolves against the device, which needs the module's own
            // view of it; only the resolved grid crosses to the worker.
            return setMeshQuality(engine, quality);
        }
        if (!this.transport) {
            return;
        }
        const grid = quality === 'low' ? [64, 48] : [80, 60];
        this.transport.callVoid('setMesh', grid[0], grid[1]);
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
        const release = this.#rhythm.retain(type);
        let subscribed = true;
        return () => {
            if (!subscribed) {
                return;
            }
            subscribed = false;
            this.events.removeEventListener(type, handler);
            release();
        };
    }

    /**
     * Uses a known tempo instead of estimating it (a MIDI clock, track
     * metadata, a tap-tempo button). The beat phase still locks to the audio.
     *
     * @param {number} bpm Beats per minute, or 0 to go back to estimating.
     */
    setRhythmHint(bpm) {
        this.#rhythm.setRhythmHint(bpm);
    }

    /**
     * When the playlist moves on. See {@link ProjectMPresetSwitchPolicy}.
     *
     * @param {ProjectMPresetSwitchPolicy} policy
     * @param {number} [bars] Bars per preset, or the shortest preset for `'section'`. Default 16.
     */
    setPresetSwitchPolicy(policy, bars = 16) {
        this.#rhythm.setPresetSwitchPolicy(policy, bars);
    }

    /**
     * Crossfade length in beats, resolved against the tempo when each crossfade
     * starts; while the tempo is unknown the duration in seconds applies.
     *
     * @param {number} beats Beats, or 0 to use seconds only.
     */
    setTransitionDurationBeats(beats) {
        this.#rhythm.setTransitionDurationBeats(beats);
    }

    /**
     * Makes beat-detection hard cuts wait for the next beat.
     *
     * @param {boolean} enabled
     */
    setHardCutOnBeat(enabled) {
        this.#rhythm.setHardCutOnBeat(enabled);
    }

    /**
     * Tempo and phase of the most recent frame, or null before start() or on a
     * bundle without rhythm analysis. One round trip per field in the worker
     * topology, so poll it for a display, not per frame.
     *
     * @returns {Promise<ProjectMRhythmInfo | null>}
     */
    getRhythmInfo() {
        return this.#rhythm.getRhythmInfo();
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
    async getFlashLimitStats() {
        const transport = this.transport;
        if (!transport || !transport.supports('getFlashLimitClampedFrames')) {
            return null;
        }
        const [enabled, threshold, clampedFrames] = await Promise.all([
            transport.call('getFlashLimitEnabled'),
            transport.call('getFlashLimitThreshold'),
            transport.call('getFlashLimitClampedFrames'),
        ]);
        return {
            enabled: !!enabled,
            threshold: Number(threshold),
            clampedFrames: Number(clampedFrames),
        };
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
        return transport.recoverContext(this.canvas.width, this.canvas.height);
    }

    resize() {
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
     * This context's engine on the main thread: the module, bound to
     * `hostHandle` (see bindModuleToHost() in generated/projectm-wasm-api.js)
     * so every export called through it selects this context's host first.
     * The module itself for the single-engine default host; null in the worker
     * topology and before start().
     *
     * @returns {ProjectMModule | null}
     */
    get #engine() {
        const { module, hostHandle } = this;
        if (!module) {
            return null;
        }
        const cached = this.#engineView;
        if (cached && cached.module === module && cached.host === hostHandle) {
            return cached.view;
        }
        const view = bindModuleToHost(module, hostHandle);
        this.#engineView = { module, host: hostHandle, view };
        return view;
    }

    /**
     * `create_host_with_config()`'s arguments for this context's options and
     * render-path switches — passed with the create call on the main thread,
     * and sent in the render worker's `init` message. Defaults: MSAA off,
     * preserveDrawingBuffer off, depth/stencil off (#246 — the canvas only
     * receives a fullscreen quad + sprites), an opaque canvas (WebGL alpha only
     * with `transparent` or `contextAlpha`), premultipliedAlpha on, software GL
     * accepted, implicit present, high-performance GPU, RGBA16F precision. The
     * `alpha` option is the canvas-CSS hint and is not part of it.
     *
     * @returns {import('./projectm-render-worker-types.ts').WasmContextConfig}
     */
    #contextConfig() {
        return resolveWasmContextConfig(this.options, this.#renderPathOverrides());
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