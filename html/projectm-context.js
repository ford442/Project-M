import { ensureAudioRunning, setupAudioUnlock } from './projectm-audio-bootstrap.js';
import { ensureWorkletReady, installWorkletPlaybackSafetyNet } from './projectm-worklet-playback.js';
import {
    connectMediaElement,
    installMediaElementSourceHook,
} from './projectm-audio-element-source.js';
import {
    AudioSourceRouter,
    audioSourceToRouterSource,
    createAudioSourceRouter,
} from './projectm-audio-source-router.js';
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
import { isRenderWorkerEnabled } from './projectm-render-worker-host.js';
import { checkCrossOriginIsolation, checkInit } from './projectm-init-errors.js';
import { setMeshQuality } from './projectm-mesh-quality.js';
import {
    loadPresetFromUrl,
    loadLocalPresetFile,
    updatePresetDisplay,
} from './projectm-presets.js';
import { startRender } from './generated/projectm-wasm-api.js';

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
 */

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
 */
export class ProjectMContext {
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
        /** @type {(() => void) | null} */
        this._pcmWriterCleanup = null;
        /** Latest stats posted by the render worker; null on the main thread. */
        this.workerStats = null;
        /** @type {((fps: number) => void) | undefined} */
        this.workerFpsSink = undefined;
        this.ready = false;
        this.destroyed = false;
        /** @type {ResizeObserver | null} */
        this.resizeObserver = null;
        this.fpsTimer = 0;
        this.fpsFrameCount = 0;
        this.fpsLastSample = 0;
        /** Internal render scale (1.0/0.75/0.5) applied by governor v2; see resize(). */
        this.renderScale = 1;
        /** @type {((event: Event) => void) | null} */
        this.presetListener = null;
/** @type {HTMLMediaElement | null} */
this.audioElement = null;
/** @type {AudioSourceRouter | null} */
this.audioRouter = options.audioRouter ?? null;
/** @type {(() => void) | null} */
this._externalReceiverClose = null;
    }

    /**
     * Boots WASM, starts rendering, and resolves when the engine is ready.
     * @returns {Promise<ProjectMContext>}
     */
    async start() {
        if (this.destroyed) {
            throw new Error('ProjectMContext was destroyed');
        }
        if (this.ready) {
            return this;
        }

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
            onError,
            onPresetChanged,
            onFps,
        } = this.options;

        if (audioSource === 'element') {
            const media = resolveMediaElement(audioElement, documentRef);
            if (media) {
                this.audioElement = media;
                media.id = media.id || 'audio-stream-element';
            }
        }

        if (requireCrossOriginIsolation && !checkCrossOriginIsolation()) {
            const error = new Error('Cross-origin isolation is required for this WASM build');
            onError?.({ code: 4, message: error.message, error });
            throw error;
        }

        try {
            const versionPaths = wasmVersion ? buildWasmBundlePaths(wasmVersion) : null;
            const resolvedBaseUrl = wasmBaseUrl ?? import.meta.url;

            // Topology first: the render worker takes the canvas by transfer,
            // so it has to be asked before anything on this thread touches a
            // drawing context. A worker that cannot start falls back to the
            // main thread here and the rest of start() is identical — that is
            // the whole point of the transport.
            const preferWorker = renderTopology === 'worker'
                || (renderTopology === 'auto' && isRenderWorkerEnabled());
            if (preferWorker) {
                this.transport = await this.#startRenderWorker({
                    resolvedBaseUrl,
                    wasmScriptUrl,
                    versionPaths,
                    wasmVersion,
                    targetFps,
                    qualityGovernor,
                    meshQuality,
                });
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
                    });
                } else {
                    await loadProjectMWasmScript({
                        documentRef,
                        baseUrl: resolvedBaseUrl,
                        ...(versionPaths
                            ? { pmScript: versionPaths.pmScript, rootScript: versionPaths.rootScript }
                            : {}),
                        forceRefresh: Boolean(wasmVersion),
                    });
                }

                this.module = /** @type {ProjectMModule} */ (await createProjectMModule({
                    scriptSrc: wasmScriptUrl || undefined,
                    wasmVersion,
                    baseUrl: resolvedBaseUrl,
                    windowRef,
                    noInitialRun: true,
                    primaryCanvasSelector: this.primaryCanvasSelector,
                    secondaryCanvasSelector: this.secondaryCanvasSelector,
                }));
                if (windowRef) {
                    windowRef.Module = this.module;
                }

                if (!checkInit(this.module, {
                    primaryCanvasSelector: this.primaryCanvasSelector,
                    secondaryCanvasSelector: this.secondaryCanvasSelector,
                })) {
                    const error = new Error('projectM init() failed');
                    onError?.({ code: -1, message: error.message, error });
                    throw error;
                }

                this.transport = createModuleTransport(this.module);
            }

            const transport = /** @type {RenderTransport} */ (this.transport);
            // External PCM arrives on this thread either way; tell it which
            // engine to hand the samples to.
            setExternalPcmTransport(transport);

            this.audioRouter = existingAudioRouter ?? createAudioSourceRouter({
                module: this.module,
                transport,
                initialSource: audioSourceToRouterSource(audioSource),
                onStatusChange: (status) => {
                    onAudioSourceChange?.(status);
                },
            });
            if (existingAudioRouter) {
                existingAudioRouter.setModule(this.module);
                existingAudioRouter.setTransport(transport);
                if (onAudioSourceChange) {
                    const prior = existingAudioRouter.onStatusChange;
                    existingAudioRouter.onStatusChange = (status) => {
                        prior?.(status);
                        onAudioSourceChange(status);
                    };
                }
            }

            setupAudioUnlock();
            installWorkletPlaybackSafetyNet();
            // The worklet runs on this thread in both topologies; this is what
            // decides where its PCM goes.
            this._pcmWriterCleanup = installTransportPcmWriter(transport);
            if (this.module) {
                setupContextLossRecovery(this.module, {
                    canvasSelector: this.primaryCanvasSelector,
                });
            }

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
                // throws outright where there is no global one.
                if (this.options.windowRef) {
                    this.options.windowRef.pmOnGovernorRenderScaleChange = (scale) => {
                        this.renderScale = scale;
                        this.resize();
                    };
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

            this.#wireAudio(audioSource, audioElement, externalPcmOrigins);
            if (!existingAudioRouter) {
                this.audioRouter.setModule(this.module);
                this.audioRouter.setTransport(transport);
            }
            this.#observeResize();
            this.#wirePresetEvents(onPresetChanged);

            if (presetUrl) {
                await this.loadPresetUrl(presetUrl);
            }

            this.ready = true;
            if (onFps) {
                this.#startFpsMonitor(onFps);
            }

            onReady?.(this);
            return this;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError?.({ code: -1, message, error });
            throw error;
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
        if (this.module) {
            return loadPresetFromUrl(url, {
                module: this.module,
                windowRef: this.options.windowRef,
            });
        }

        // Worker topology: the fetch still happens here — this thread has the
        // page's credentials and cache — and only the bytes cross, to be
        // written into the VFS on the other side.
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch preset (${response.status}): ${url}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const filename = String(url).split('/').pop()?.split('?')[0] || 'preset.milk';
        const vfsPath = `/presets/url_${filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
        this.transport.writePreset(vfsPath, bytes);
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
        if (this.module) {
            return loadLocalPresetFile(file, {
                module: this.module,
                updateDisplay: true,
            });
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        const vfsPath = `/presets/local_${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
        this.transport.writePreset(vfsPath, bytes);
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
        this.transport?.callVoid('switchPreset');
    }

    /** @param {boolean} locked */
    setLocked(locked) {
        this.transport?.callVoid('setPresetLocked', locked);
    }

    /** @param {boolean} enabled */
    setTransparent(enabled) {
        if (!this.transport) {
            return;
        }
        this.transport.callVoid('setTransparencyMode', enabled);
        if (this.secondaryCanvas) {
            this.secondaryCanvas.style.display = enabled ? 'none' : 'block';
        }
    }

    /**
     * @param {ProjectMMeshQuality} quality
     * @returns {string | undefined}
     */
    setMeshQuality(quality) {
        if (this.module) {
            // 'auto' resolves against the device, which needs the module's own
            // view of it; only the resolved grid crosses to the worker.
            return setMeshQuality(this.module, quality);
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
        if (this.module) {
            return setTargetFps(this.module, fps);
        }
        if (!this.transport) {
            return;
        }
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

    destroy() {
        this.destroyed = true;
        this.ready = false;
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.fpsTimer) {
            cancelAnimationFrame(this.fpsTimer);
            this.fpsTimer = 0;
        }
        if (this.presetListener) {
            this.options.windowRef?.removeEventListener('pm:preset-loaded', this.presetListener);
            this.presetListener = null;
        }
        if (this._externalReceiverClose) {
            this._externalReceiverClose();
            this._externalReceiverClose = null;
        }
        if (this._pcmWriterCleanup) {
            this._pcmWriterCleanup();
            this._pcmWriterCleanup = null;
        }
        if (this.options.windowRef?.pmOnGovernorRenderScaleChange) {
            this.options.windowRef.pmOnGovernorRenderScaleChange = null;
        }
        setExternalPcmTransport(null);
        this.audioRouter?.destroy();
        this.audioRouter = null;
        // Tears down the module on the main thread, terminates the worker in
        // the other topology. A module set without a transport (start() never
        // ran, or a host wired one in by hand) still gets torn down.
        if (this.transport) {
            this.transport.destroy();
        } else if (this.module?._destruct) {
            this.module._destruct();
        }
        this.transport = null;
        this.module = null;
        this.workerStats = null;
    }

    /**
     * @param {ProjectMAudioSource} audioSource
     * @param {HTMLMediaElement | string | undefined} audioElementOption
     * @param {string[] | undefined} externalPcmOrigins
     */
    #wireAudio(audioSource, audioElementOption, externalPcmOrigins) {
        const router = this.audioRouter;

        if (audioSource === 'external') {
            const receiver = setupExternalAudioReceiver({
                allowedOrigins: externalPcmOrigins ?? [],
                feedGate: () => router?.externalFeedGate() ?? false,
                onFeed: router
                    ? router.wrapExternalFeed(defaultFeedPCMToModule)
                    : defaultFeedPCMToModule,
            });
            this._externalReceiverClose = receiver.close;
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
        ensureWorkletReady()
            .then((ready) => {
                if (ready) connectMediaElement(media);
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
            });
            scriptSrc = new URL(candidate, resolvedBaseUrl).href;
        } catch (error) {
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
            onFallback: (reason) => {
                this.options.onRenderWorkerFallback?.(reason);
            },
            onError: (message) => {
                this.options.onError?.({ code: -1, message, error: new Error(message) });
            },
            onStats: (stats) => {
                this.workerStats = /** @type {any} */ (stats);
                this.workerFpsSink?.(/** @type {any} */ (stats).fps);
            },
        });
    }

    #observeResize() {
        this.resizeObserver = observeModuleSize({
            container: this.container,
            sync: () => this.resize(),
        });
        if (!this.resizeObserver && typeof globalThis.addEventListener === 'function') {
            globalThis.addEventListener('resize', () => this.resize());
        }
    }

    /** @param {((detail: ProjectMPresetDetail) => void) | undefined} onPresetChanged */
    #wirePresetEvents(onPresetChanged) {
        if (!onPresetChanged) {
            return;
        }
        this.presetListener = (event) => {
            onPresetChanged(/** @type {CustomEvent<ProjectMPresetDetail>} */ (event).detail);
        };
        this.options.windowRef?.addEventListener('pm:preset-loaded', this.presetListener);
    }

    /** @param {(fps: number) => void} onFps */
    #startFpsMonitor(onFps) {
        if (!this.module) {
            // No frame counter to read on this thread — the worker already
            // measures its own frame rate and posts it every 500 ms.
            this.fpsTimer = 0;
            this.workerFpsSink = onFps;
            return;
        }

        const sample = () => {
            if (this.destroyed || !this.module) {
                return;
            }

            const now = performance.now();
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
