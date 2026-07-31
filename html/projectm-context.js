import { ensureAudioRunning, setupAudioUnlock } from './projectm-audio-bootstrap.js';
import { AudioSourceRouter } from './projectm-audio-router.js';
import { setupContextLossRecovery } from './projectm-context-loss.js';
import {
    defaultFeedPCMToModule,
    flushQueuedExternalPCM,
    setupExternalAudioReceiver,
} from './projectm-external-pcm.js';
import { setQualityGovernorEnabled, setTargetFps } from './projectm-fps-governor.js';
import {
    createProjectMModule,
    loadProjectMWasmScript,
    observeModuleSize,
    resolveWasmScriptUrl,
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
} from './generated/projectm-wasm-api.js';

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
 * @typedef {import('./projectm-context-types.ts').ProjectMPresetDetail} ProjectMPresetDetail
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
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
 * @param {{ module: ProjectMModuleLike | null; container: Element; mainCanvas: HTMLCanvasElement; secondaryCanvas?: HTMLCanvasElement | null; aspectCorrection?: boolean; devicePixelRatio?: number }} options
 * @returns {boolean}
 */
function syncCanvasSize({
    module,
    container,
    mainCanvas,
    secondaryCanvas,
    aspectCorrection,
    devicePixelRatio = globalThis.devicePixelRatio || 1,
}) {
    if (!module || !container || !mainCanvas) {
        return false;
    }

    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * devicePixelRatio));
    const height = Math.max(1, Math.round(rect.height * devicePixelRatio));

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
        this.ready = false;
        this.destroyed = false;
        /** @type {ResizeObserver | null} */
        this.resizeObserver = null;
        this.fpsTimer = 0;
        this.fpsFrameCount = 0;
        this.fpsLastSample = 0;
        /** @type {((event: Event) => void) | null} */
        this.presetListener = null;
        /** @type {HTMLMediaElement | null} */
        this.audioElement = null;
        /** Single-active-source router. Fires `pm-audio-source` events on source changes. */
        this.audioSourceRouter = new AudioSourceRouter({
            windowRef: this.options.windowRef ?? null,
        });
    }

    /**
     * The currently active audio source as tracked by the AudioSourceRouter.
     * One of `'none'`, `'worklet'`, `'element'`, or `'external'`.
     * @returns {import('./projectm-audio-router.js').AudioSourceName}
     */
    get activeAudioSource() {
        return this.audioSourceRouter.activeSource;
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
            onReady,
            onError,
            onPresetChanged,
            onFps,
        } = this.options;

        if (requireCrossOriginIsolation && !checkCrossOriginIsolation()) {
            const error = new Error('Cross-origin isolation is required for this WASM build');
            onError?.({ code: 4, message: error.message, error });
            throw error;
        }

        try {
            if (wasmScriptUrl) {
                await loadProjectMWasmScript({
                    documentRef,
                    baseUrl: wasmBaseUrl,
                    pmScript: wasmScriptUrl,
                    rootScript: wasmScriptUrl,
                    forceRefresh: true,
                });
            } else {
                await loadProjectMWasmScript({
                    documentRef,
                    baseUrl: wasmBaseUrl ?? import.meta.url,
                });
            }

            this.module = /** @type {ProjectMModule} */ (await createProjectMModule({
                scriptSrc: wasmScriptUrl || await resolveWasmScriptUrl({
                    documentRef,
                    baseUrl: wasmBaseUrl ?? import.meta.url,
                }),
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

            setupAudioUnlock();
            setupContextLossRecovery(this.module, {
                canvasSelector: this.primaryCanvasSelector,
            });

            syncCanvasSize({
                module: this.module,
                container: this.container,
                mainCanvas: this.canvas,
                secondaryCanvas: this.secondaryCanvas,
                aspectCorrection,
                devicePixelRatio: this.options.devicePixelRatio,
            });

            startRender(this.module, this.canvas.width, this.canvas.height);
            flushQueuedExternalPCM();

            setMeshQuality(this.module, meshQuality);
            setTargetFps(this.module, targetFps);
            setQualityGovernorEnabled(this.module, qualityGovernor);
            setPresetLocked(this.module, presetLocked);

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
        return loadLocalPresetFile(file, {
            module: this.module,
            updateDisplay: true,
        });
    }

    nextPreset() {
        if (!this.module) {
            return;
        }
        switchPreset(this.module);
    }

    /** @param {boolean} locked */
    setLocked(locked) {
        if (!this.module) {
            return;
        }
        setPresetLocked(this.module, locked);
    }

    /** @param {boolean} enabled */
    setTransparent(enabled) {
        if (!this.module) {
            return;
        }
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
        return setTargetFps(this.module, fps);
    }

    resize() {
        syncCanvasSize({
            module: this.module,
            container: this.container,
            mainCanvas: this.canvas,
            secondaryCanvas: this.secondaryCanvas,
            aspectCorrection: this.options.aspectCorrection,
            devicePixelRatio: this.options.devicePixelRatio,
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
        if (this.module?._destruct) {
            this.module._destruct();
        }
        this.module = null;
        this.audioSourceRouter.reset();
    }

    /**
     * @param {ProjectMAudioSource} audioSource
     * @param {HTMLMediaElement | string | undefined} audioElementOption
     * @param {string[] | undefined} externalPcmOrigins
     */
    #wireAudio(audioSource, audioElementOption, externalPcmOrigins) {
        const router = this.audioSourceRouter;

        if (audioSource === 'external') {
            router.activate('external');
            setupExternalAudioReceiver({
                allowedOrigins: externalPcmOrigins ?? [],
                // Gate the external PCM feed through the router so that if the
                // source changes at runtime (e.g. a host switches to 'element'),
                // arriving external chunks are dropped rather than double-feeding.
                onFeed: (buffer, channels, sampleRate, samplesPerChannel) => {
                    if (!router.shouldFeedExternal()) return false;
                    return defaultFeedPCMToModule(buffer, channels, sampleRate, samplesPerChannel);
                },
            });
            return;
        }

        if (audioSource !== 'element') {
            router.activate('none');
            return;
        }

        const media = resolveMediaElement(audioElementOption, this.options.documentRef);
        if (!media) {
            console.warn('[ProjectMContext] audioSource=element but no audio element was provided');
            return;
        }

        router.activate('element');
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
