// projectm-context.ts
//
// ProjectMContext: the high-level embed API. This file holds the context's
// state, its start / destroy sequence and its public methods; the work behind
// them lives in context/:
//
//   context/options.ts  configuration: the options, canvases and selectors the
//                       constructor resolves
//   context/session.ts  lifecycle state: the one boot in flight and the
//                       teardown stack
//   context/connect.ts  event wiring: everything start() connects around the
//                       engine, and error reporting
//   context/recovery.ts loss-replay: rebuilding the engine after a context loss
//   context/boot.js     glue + Module / render worker / engine creation
//   context/audio.js    the audio router and the configured audio source
//   context/presets.js  preset loading, rhythm controls and rhythm events
//   context/render.js   canvas sizing, resize, fps, snapshot, flash stats
//   context/controls.js the base class: engine controls, events, on()
//   context/wiring.js   the hooks and engine reports connect.ts installs
//
// Those modules keep no state of their own: whatever they acquire comes back
// here and is registered on this context's teardown stack.

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
import type { Disposable } from './context/session.js';
import type { DevicePixelSize } from './context/render.js';
import type { SharedModuleOptions } from './context/boot.js';
import type { ProjectMModule } from './generated/projectm-wasm-api.js';
import type { ProjectMContextOptions, ProjectMResolvedContextOptions } from '@projectm/types/context';
import type { RenderTransport } from '@projectm/types/transport';

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
 */
export async function bootProjectMSharedModule(options: SharedModuleOptions = {}): Promise<ProjectMModule> {
    return bootSharedModule(options, DEFAULT_BASE_URL);
}

/** Latest stats the render worker posted. */
type WorkerStats = Record<string, unknown> & { fps?: number };

/**
 * High-level embed API: canvas bootstrap, WASM init, resize, presets, and audio wiring.
 *
 * Lifecycle. `start()` is idempotent under concurrency: overlapping calls share
 * one boot. `destroy()` aborts a boot that is still in flight, and a start that
 * fails (or is aborted) releases everything it had acquired by then — the
 * Module, the render worker, the WebGL context and every listener — so the
 * context is left as it was before `start()` and can be started again. Every
 * resource is registered for teardown the moment it is acquired, which is what
 * lets one routine tear down both a finished context and a half-booted one.
 *
 * Several contexts can share a page. Everything a context puts in a
 * process-wide slot (`window.Module`, the PCM writer, the external-PCM
 * transport, the governor callback, the router registry, the worklet safety
 * net) is claimed and released, so destroying one leaves the others' intact.
 */
export class ProjectMContext extends ProjectMContextControls {
    options: ProjectMResolvedContextOptions;
    canvas: HTMLCanvasElement;
    container: HTMLElement;
    primaryCanvasSelector: string;
    secondaryCanvasSelector: string;
    /** Latest stats posted by the render worker; null on the main thread. */
    workerStats: WorkerStats | null = null;
    workerFpsSink: ((fps: number) => void) | undefined = undefined;
    /** Whether this context owns the Module (created it) vs. shares one. */
    ownsModule = true;
    ready = false;
    destroyed = false;
    resizeObserver: ResizeObserver | null = null;
    fpsTimer = 0;
    fpsFrameCount = 0;
    fpsLastSample = 0;
    /** Internal render scale (1.0/0.75/0.5) applied by governor v2; see resize(). */
    renderScale = 1;
    audioElement: HTMLMediaElement | null = null;

    /** The boot in flight; aborted by teardown. */
    private readonly startGate = new StartGate<ProjectMContext>();
    /** Undo steps for everything this context has acquired. */
    private readonly teardownStack = new TeardownStack();
    private readonly errors: ContextErrorReporter;
    /** The container's last observed device-pixel content box (see resize()). */
    private devicePixelSize: DevicePixelSize | null = null;

    constructor(options: ProjectMContextOptions) {
        const setup = resolveContextSetup(options);
        super();
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
    start(): Promise<ProjectMContext> {
        if (this.destroyed) {
            return Promise.reject(new Error('ProjectMContext was destroyed'));
        }
        if (this.ready) {
            return Promise.resolve(this);
        }
        return this.startGate.start((signal) => this.run(signal));
    }

    /** @param signal Aborted when this attempt is torn down. */
    private async run(signal: AbortSignal): Promise<ProjectMContext> {
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
            this.teardown();
            if (cancelled) {
                // destroy() cancelled this boot. Whatever surfaced afterwards
                // (a step running against state that was just released) is a
                // symptom of that, not a failure worth reporting.
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
    own<T extends Disposable>(disposable: T): T {
        return this.teardownStack.adopt(disposable, this.destroyed);
    }

    /**
     * Publish this context's Module as `window.Module` for the legacy code that
     * still reads it. Claimed, so destroying the context no longer leaves the
     * global pointing at a destructed engine, and with two contexts the older one
     * takes it back when the newer one goes.
     */
    private claimWindowModule(): void {
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
    private teardown(): void {
        this.ready = false;
        this.startGate.abort();
        // The transport goes away with the engine; on() listeners stay registered
        // and a later start() reconnects them.
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
        this.workerFpsSink = undefined;
    }

    async loadPresetUrl(url: string): Promise<{ url: string; vfsPath: string; filename: string }> {
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

    async loadPresetFile(file: File): Promise<{ filename: string; vfsPath: string }> {
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

    private requireTransport(): RenderTransport {
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
    recoverContext(): Promise<number> {
        return recoverEngine(this);
    }

    /**
     * Sizes the canvases to the container. The context calls this itself
     * whenever the container, the devicePixelRatio or the governor's render
     * scale changes; hosts only need it after changing `options` that affect
     * the size (aspect correction, an explicit devicePixelRatio).
     */
    resize(): void {
        // The observed device-pixel box only holds while the ratio is the
        // window's: a host-pinned devicePixelRatio means "size by this ratio".
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
        });
    }

    /**
     * Stops this context and releases everything it holds. A boot still in
     * flight is aborted: its `start()` promise rejects with an `AbortError`
     * (no `onError`, since nothing failed). Safe to call more than once.
     */
    destroy(): void {
        const alreadyDestroyed = this.destroyed;
        this.destroyed = true;
        this.teardown();
        if (!alreadyDestroyed) {
            emitContextEvent(this, 'destroy', undefined);
        }
    }

    private startFpsMonitor(onFps: (fps: number) => void, signal: AbortSignal): void {
        if (!this.module) {
            // No frame counter to read on this thread — the worker already
            // measures its own frame rate and posts it every 500 ms.
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

/** Convenience factory for hosts that prefer a functional entry point. */
export async function createProjectMContext(options: ProjectMContextOptions): Promise<ProjectMContext> {
    const context = new ProjectMContext(options);
    await context.start();
    return context;
}

export { updatePresetDisplay };
