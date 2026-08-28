import { ensureAudioRunning, setupAudioUnlock } from './projectm-audio-bootstrap.js';
import { installWorkletPlaybackSafetyNet } from './projectm-worklet-playback.js';
import {
    AudioSourceRouter,
    audioSourceToRouterSource,
    createAudioSourceRouter,
} from './projectm-audio-source-router.js';
import { setupContextLossRecovery } from './projectm-context-loss.js';
import {
    defaultFeedPCMToModule,
    flushQueuedExternalPCM,
    setupExternalAudioReceiver,
} from './projectm-external-pcm.js';
import { getGovernorRenderScale, setQualityGovernorEnabled, setTargetFps } from './projectm-fps-governor.js';
import {
    buildWasmBundlePaths,
    createProjectMModule,
    loadProjectMWasmScript,
    observeModuleSize,
} from './projectm-init.js';
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
    setTransparencyThreshold,
    switchPreset,
    createHost,
    setActiveHost,
    destroyHost,
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

    const module = /** @type {ProjectMModule} */ (await createProjectMModule({
        scriptSrc: wasmScriptUrl || undefined,
        wasmVersion,
        baseUrl: resolvedBaseUrl,
        windowRef,
        noInitialRun: true,
        primaryCanvasSelector,
        secondaryCanvasSelector,
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
 * @param {{ module: ProjectMModuleLike | null; container: Element; mainCanvas: HTMLCanvasElement; secondaryCanvas?: HTMLCanvasElement | null; aspectCorrection?: boolean; devicePixelRatio?: number; renderScale?: number }} options
 * @returns {boolean}
 */
function syncCanvasSize({
    module,
    container,
    mainCanvas,
    secondaryCanvas,
    aspectCorrection,
    devicePixelRatio = globalThis.devicePixelRatio || 1,
    renderScale = 1,
}) {
    if (!module || !container || !mainCanvas) {
        return false;
    }

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
    const width = Math.max(1, Math.round(rect.width * devicePixelRatio * scale));
    const height = Math.max(1, Math.round(rect.height * devicePixelRatio * scale));

    mainCanvas.width = width;
    mainCanvas.height = height;
    mainCanvas.style.width = `${rect.width}px`;
    mainCanvas.style.height = `${rect.height}px`;

    if (secondaryCanvas) {
        secondaryCanvas.width = width;
        secondaryCanvas.height = height;
        secondaryCanvas.style.width = `${rect.width}px`;
        secondaryCanvas.style.height = `${rect.height}px`;
    }

    if (module._set_window_size) {
        module._set_window_size(width, height);
    }
    if (module._set_aspect_correction && aspectCorrection !== undefined) {
        module._set_aspect_correction(aspectCorrection ? 1 : 0);
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
            const sharedModule = this.options.sharedModule;
            if (sharedModule) {
                // Multi-instance path (#168 Phase B): reuse a Module booted by
                // bootProjectMSharedModule() and create a dedicated engine
                // instance inside it. create_host() sets its own canvas
                // selectors and inits the engine, returning an opaque handle;
                // every engine op below activates this host first.
                this.module = /** @type {ProjectMModule} */ (sharedModule);
                this.ownsModule = false;
                if (windowRef) {
                    windowRef.Module = this.module;
                }
                const handle = createHost(
                    this.module,
                    this.primaryCanvasSelector,
                    this.secondaryCanvasSelector || '#scanvas'
                );
                if (!handle) {
                    const error = new Error(
                        'create_host() failed (instance cap reached or engine init failed)'
                    );
                    onError?.({ code: 4, message: error.message, error });
                    throw error;
                }
                this.hostHandle = handle;
            } else {
                const versionPaths = wasmVersion ? buildWasmBundlePaths(wasmVersion) : null;
                const resolvedBaseUrl = wasmBaseUrl ?? import.meta.url;

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
            }

            this.audioRouter = existingAudioRouter ?? createAudioSourceRouter({
                module: this.module,
                initialSource: audioSourceToRouterSource(audioSource),
                onStatusChange: (status) => {
                    onAudioSourceChange?.(status);
                },
            });
            if (existingAudioRouter) {
                existingAudioRouter.setModule(this.module);
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
            setupContextLossRecovery(this.module, {
                canvasSelector: this.primaryCanvasSelector,
            });

            // Everything from here drives the engine; make this context's host
            // active first (no-op for the single-instance default host). The
            // calls below run synchronously without yielding, so one activation
            // covers the whole startup control sequence.
            this.#activate();

            syncCanvasSize({
                module: this.module,
                container: this.container,
                mainCanvas: this.canvas,
                secondaryCanvas: this.secondaryCanvas,
                aspectCorrection,
                devicePixelRatio: this.options.devicePixelRatio,
                renderScale: this.renderScale,
            });

            startRender(this.module, this.canvas.width, this.canvas.height);
            flushQueuedExternalPCM();

            setMeshQuality(this.module, meshQuality);
            setTargetFps(this.module, targetFps);
            setQualityGovernorEnabled(this.module, qualityGovernor);
            setPresetLocked(this.module, presetLocked);

            // Governor v2 (docs/PERFORMANCE.md): sync the starting render scale, then
            // resize on every tier change (WasmPerfGovernor.cpp pushes here via
            // js_governor_report_render_scale()). Shrinking the canvas backing store
            // while keeping its CSS size fixed is what actually applies the "internal
            // FBO render scale" tier — see the comment in syncCanvasSize() above.
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

            if (transparent) {
                setTransparencyMode(this.module, true);
                if (typeof transparencyThreshold === 'number') {
                    setTransparencyThreshold(this.module, transparencyThreshold);
                }
                if (this.secondaryCanvas) {
                    this.secondaryCanvas.style.display = 'none';
                }
            }

            this.#wireAudio(audioSource, audioElement, externalPcmOrigins);
            if (!existingAudioRouter) {
                this.audioRouter.setModule(this.module);
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
        if (!this.module) {
            throw new Error('ProjectMContext is not started');
        }
        this.#activate();
        return loadPresetFromUrl(url, {
            module: this.module,
            windowRef: this.options.windowRef,
        });
    }

    /**
     * @param {File} file
     * @returns {Promise<{ filename: string; vfsPath: string }>}
     */
    async loadPresetFile(file) {
        if (!this.module) {
            throw new Error('ProjectMContext is not started');
        }
        this.#activate();
        return loadLocalPresetFile(file, {
            module: this.module,
            updateDisplay: true,
        });
    }

    nextPreset() {
        if (!this.module) {
            return;
        }
        this.#activate();
        switchPreset(this.module);
    }

    /** @param {boolean} locked */
    setLocked(locked) {
        if (!this.module) {
            return;
        }
        this.#activate();
        setPresetLocked(this.module, locked);
    }

    /** @param {boolean} enabled */
    setTransparent(enabled) {
        if (!this.module) {
            return;
        }
        this.#activate();
        setTransparencyMode(this.module, enabled);
        if (this.secondaryCanvas) {
            this.secondaryCanvas.style.display = enabled ? 'none' : 'block';
        }
    }

    /**
     * @param {ProjectMMeshQuality} quality
     * @returns {string | undefined}
     */
    setMeshQuality(quality) {
        if (!this.module) {
            return;
        }
        this.#activate();
        return setMeshQuality(this.module, quality);
    }

    /**
     * @param {number} fps
     * @returns {number | undefined}
     */
    setTargetFps(fps) {
        if (!this.module) {
            return;
        }
        this.#activate();
        return setTargetFps(this.module, fps);
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
            module: this.module,
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
        if (this.options.windowRef?.pmOnGovernorRenderScaleChange) {
            this.options.windowRef.pmOnGovernorRenderScaleChange = null;
        }
        this.audioRouter?.destroy();
        this.audioRouter = null;
        if (this.hostHandle && this.module) {
            // Multi-instance: free just this engine; the shared Module and any
            // sibling contexts keep running. The Module itself is torn down by
            // whoever booted it (bootProjectMSharedModule caller).
            destroyHost(this.module, this.hostHandle);
            this.hostHandle = 0;
        } else if (this.ownsModule && this.module?._destruct) {
            this.module._destruct();
        }
        this.module = null;
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
        ensureAudioRunning().catch(() => {
            // Autoplay policies may require a user gesture; host should call ensureAudioRunning().
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
        const sample = () => {
            if (this.destroyed || !this.module) {
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
