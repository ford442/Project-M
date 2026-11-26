// GENERATED from projectm-context.ts by scripts/build_html_ts.mjs — do not edit.
// Edit the .ts, then run `npm run build:html` (CI: npm run check:html-build).
import { claimGlobal } from './projectm-globals.js';
import { checkCrossOriginIsolation } from './projectm-init-errors.js';
import { updatePresetDisplay } from './projectm-presets.js';
import {
    bootEngine,
    bootSharedModule,
    createAbortError,
    isAbortError,
    releaseEngine,
    throwIfAborted,
} from './context/boot.js';
import { resolveMediaElement } from './context/audio.js';
import { loadPresetFileInto, loadPresetUrlInto } from './context/presets.js';
import { resolveDevicePixelRatio, startFpsMonitor, syncCanvasSize } from './context/render.js';
import {
    ProjectMContextControls,
    emitContextEvent,
    engineOf,
    replayOf,
    rhythmOf,
    setContextSnapshot,
} from './context/controls.js';
import { PRESET_SWITCH_FAILED } from './context/wiring.js';
import { resolveContextSetup } from './context/options.js';
import { StartGate, TeardownStack } from './context/session.js';
import { ContextErrorReporter, connectEngine } from './context/connect.js';
import { recordLoaded, recoverEngine } from './context/recovery.js';
import { DEFAULT_HOST } from './generated/projectm-wasm-api.js';
export { CONTEXT_CONFIG_FLAGS, resolveWasmContextConfig } from './projectm-context-config.js';
export { PRESET_SWITCH_FAILED };
const DEFAULT_BASE_URL = import.meta.url;
export async function bootProjectMSharedModule(options = {}) {
    return bootSharedModule(options, DEFAULT_BASE_URL);
}
export class ProjectMContext extends ProjectMContextControls {
    constructor(options) {
        const setup = resolveContextSetup(options);
        super();
        /** Latest stats posted by the render worker; null on the main thread. */
        this.workerStats = null;
        this.workerFpsSink = void 0;
        /** Whether this context owns the Module (created it) vs. shares one. */
        this.ownsModule = true;
        this.ready = false;
        this.destroyed = false;
        this.resizeObserver = null;
        this.fpsTimer = 0;
        this.fpsFrameCount = 0;
        this.fpsLastSample = 0;
        /** Internal render scale (1.0/0.75/0.5) applied by governor v2; see resize(). */
        this.renderScale = 1;
        this.audioElement = null;
        /** The boot in flight; aborted by teardown. */
        this.startGate = new StartGate();
        /** Undo steps for everything this context has acquired. */
        this.teardownStack = new TeardownStack();
        /** The container's last observed device-pixel content box (see resize()). */
        this.devicePixelSize = null;
        this.options = setup.options;
        this.canvas = setup.canvas;
        this.secondaryCanvas = setup.secondaryCanvas;
        this.container = setup.container;
        this.primaryCanvasSelector = setup.primaryCanvasSelector;
        this.secondaryCanvasSelector = setup.secondaryCanvasSelector;
        this.audioRouter = options.audioRouter ?? null;
        this.errors = new ContextErrorReporter(this);
    }
    /**
     * Boots WASM, starts rendering, and resolves when the engine is ready.
     *
     * Calling it again while a boot is in flight returns the same promise, and
     * calling it once ready resolves immediately. If the boot fails everything
     * it acquired is released and a later call starts over.
     */
    start() {
        if (this.destroyed) {
            return Promise.reject(new Error('ProjectMContext was destroyed'));
        }
        if (this.ready) {
            return Promise.resolve(this);
        }
        return this.startGate.start((signal) => this.run(signal));
    }
    /** @param signal Aborted when this attempt is torn down. */
    async run(signal) {
        const { requireCrossOriginIsolation, documentRef, audioSource, audioElement, presetUrl, onReady, onFps } =
            this.options;
        this.errors.reset();
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
            this.errors.report(error, 4);
            this.teardown();
            throw error;
        }
        try {
            const transport = await bootEngine(
                {
                    options: this.options,
                    baseUrl: this.options.wasmBaseUrl ?? DEFAULT_BASE_URL,
                    canvas: this.canvas,
                    container: this.container,
                    primaryCanvasSelector: this.primaryCanvasSelector,
                    secondaryCanvasSelector: this.secondaryCanvasSelector,
                    onRuntimeError: (message) => this.errors.reportRuntime(message),
                    onStats: (stats) => {
                        this.workerStats = stats;
                        this.workerFpsSink?.(Number(stats.fps));
                    },
                    signal,
                },
                {
                    adoptModule: (module) => {
                        this.module = module;
                        this.claimWindowModule();
                    },
                    adoptTransport: (adopted) => {
                        this.transport = adopted;
                    },
                    adoptHost: (handle) => {
                        this.hostHandle = handle;
                    },
                    replaceCanvas: (canvas) => {
                        this.canvas = canvas;
                    },
                    reportError: (error, code) => this.errors.report(error, code),
                }
            );
            throwIfAborted(signal);
            connectEngine(
                {
                    context: this,
                    own: (disposable) => this.teardownStack.add(disposable),
                    errors: this.errors,
                    onContainerResize: (devicePixelSize) => {
                        this.devicePixelSize = devicePixelSize;
                        this.resize();
                    },
                },
                transport,
                signal
            );
            if (presetUrl) {
                await this.loadPresetUrl(presetUrl);
                throwIfAborted(signal);
            }
            this.ready = true;
            if (onFps) {
                this.startFpsMonitor(onFps, signal);
            }
            onReady?.(this);
            emitContextEvent(this, 'ready', void 0);
            return this;
        } catch (error) {
            const cancelled = signal.aborted;
            this.teardown();
            if (cancelled) {
                throw isAbortError(error) ? error : createAbortError('ProjectMContext was destroyed during start()');
            }
            this.errors.report(error);
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
     * @returns `disposable`, so a setup can be owned where it is made.
     */
    own(disposable) {
        return this.teardownStack.adopt(disposable, this.destroyed);
    }
    /**
     * Publish this context's Module as `window.Module` for the legacy code that
     * still reads it. Claimed, so destroying the context no longer leaves the
     * global pointing at a destructed engine, and with two contexts the older one
     * takes it back when the newer one goes.
     */
    claimWindowModule() {
        const { windowRef } = this.options;
        if (windowRef && this.module) {
            this.teardownStack.add(claimGlobal(windowRef, 'Module', this.module));
        }
    }
    /**
     * Releases everything `start()` acquired, newest first, then the engine
     * itself. Safe to call at any point of a boot and more than once: the
     * failure path of a half-finished start and destroy() both come through
     * here, and a destroy() that lands mid-boot is followed by the boot's own
     * cleanup for whatever it acquired after that.
     */
    teardown() {
        this.ready = false;
        this.startGate.abort();
        rhythmOf(this).detach();
        replayOf(this).clear();
        setContextSnapshot(this, null);
        this.teardownStack.run();
        const { module, transport, hostHandle } = this;
        this.hostHandle = DEFAULT_HOST;
        this.transport = null;
        this.module = null;
        releaseEngine({ module, transport, hostHandle, ownsModule: this.ownsModule });
        this.audioRouter = null;
        this.workerStats = null;
        this.workerFpsSink = void 0;
    }
    async loadPresetUrl(url) {
        const transport = this.requireTransport();
        return recordLoaded(
            this,
            await loadPresetUrlInto(url, {
                transport,
                engine: engineOf(this),
                isCurrent: () => this.transport === transport,
                windowRef: this.options.windowRef,
                signal: this.startGate.signal,
            })
        );
    }
    async loadPresetFile(file) {
        const transport = this.requireTransport();
        return recordLoaded(
            this,
            await loadPresetFileInto(file, {
                transport,
                engine: engineOf(this),
                isCurrent: () => this.transport === transport,
                documentRef: this.options.documentRef,
            })
        );
    }
    requireTransport() {
        if (!this.transport) {
            throw new Error('ProjectMContext is not started');
        }
        return this.transport;
    }
    /**
     * Rebuild the engine after the browser restored a lost WebGL context.
     * Called by html/projectm-context-loss.js; hosts have no reason to call it
     * themselves. See context/recovery.ts.
     *
     * @returns `init()`'s status: 0 recovered, 5 the context is still lost,
     *   anything else an init failure (-1 when not started).
     */
    recoverContext() {
        return recoverEngine(this);
    }
    /**
     * Sizes the canvases to the container. The context calls this itself
     * whenever the container, the devicePixelRatio or the governor's render
     * scale changes; hosts only need it after changing `options` that affect
     * the size (aspect correction, an explicit devicePixelRatio).
     */
    resize() {
        const devicePixelSize = this.options.devicePixelRatio ? null : this.devicePixelSize;
        syncCanvasSize({
            transport: this.transport,
            container: this.container,
            mainCanvas: this.canvas,
            secondaryCanvas: this.secondaryCanvas,
            aspectCorrection: this.options.aspectCorrection,
            devicePixelRatio: resolveDevicePixelRatio(this.options),
            renderScale: this.renderScale,
            devicePixelSize,
            maxBackingStoreSize: this.contextCaps?.maxRenderbufferSize ?? 0,
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
        this.teardown();
        if (!alreadyDestroyed) {
            emitContextEvent(this, 'destroy', void 0);
        }
    }
    startFpsMonitor(onFps, signal) {
        if (!this.module) {
            this.fpsTimer = 0;
            this.workerFpsSink = onFps;
            return;
        }
        this.teardownStack.add(
            startFpsMonitor(this, {
                getEngine: () => engineOf(this),
                stopped: () => signal.aborted || this.destroyed,
                onFps,
            })
        );
    }
}
export async function createProjectMContext(options) {
    const context = new ProjectMContext(options);
    await context.start();
    return context;
}
export { updatePresetDisplay };
