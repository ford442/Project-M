import { ensureAudioRunning, setupAudioUnlock } from './projectm-audio-bootstrap.js';
import { setupContextLossRecovery } from './projectm-context-loss.js';
import {
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

/**
 * @typedef {import('./projectm-context.ts').ProjectMContextOptions} ProjectMContextOptions
 */

function resolveMediaElement(value, documentRef) {
    if (!value) {
        return null;
    }
    if (typeof value === 'string') {
        return documentRef.querySelector(value);
    }
    return value;
}

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
            throw new Error('ProjectMContext requires a canvas element (#mcanvas)');
        }

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
        this.module = null;
        this.ready = false;
        this.destroyed = false;
        this.resizeObserver = null;
        this.fpsTimer = 0;
        this.fpsFrameCount = 0;
        this.fpsLastSample = 0;
        this.presetListener = null;
        this.audioElement = null;
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

            this.module = await createProjectMModule({
                scriptSrc: wasmScriptUrl || await resolveWasmScriptUrl({
                    documentRef,
                    baseUrl: wasmBaseUrl ?? import.meta.url,
                }),
                windowRef,
            });
            windowRef.Module = this.module;

            if (!checkInit(this.module)) {
                const error = new Error('projectM init() failed');
                onError?.({ code: -1, message: error.message, error });
                throw error;
            }

            setupAudioUnlock();
            setupContextLossRecovery(this.module);

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

    async loadPresetUrl(url) {
        if (!this.module) {
            throw new Error('ProjectMContext is not started');
        }
        return loadPresetFromUrl(url, {
            module: this.module,
            windowRef: this.options.windowRef,
        });
    }

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

    setLocked(locked) {
        if (!this.module) {
            return;
        }
        setPresetLocked(this.module, locked);
    }

    setTransparent(enabled) {
        if (!this.module) {
            return;
        }
        setTransparencyMode(this.module, enabled);
        if (this.secondaryCanvas) {
            this.secondaryCanvas.style.display = enabled ? 'none' : 'block';
        }
    }

    setMeshQuality(quality) {
        if (!this.module) {
            return;
        }
        return setMeshQuality(this.module, quality);
    }

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
    }

    #wireAudio(audioSource, audioElementOption, externalPcmOrigins) {
        if (audioSource === 'external') {
            setupExternalAudioReceiver({
                allowedOrigins: externalPcmOrigins ?? [],
                onFeed: () => flushQueuedExternalPCM(),
            });
            return;
        }

        if (audioSource !== 'element') {
            return;
        }

        const media = resolveMediaElement(audioElementOption, this.options.documentRef);
        if (!media) {
            console.warn('[ProjectMContext] audioSource=element but no audio element was provided');
            return;
        }

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

    #wirePresetEvents(onPresetChanged) {
        if (!onPresetChanged) {
            return;
        }
        this.presetListener = (event) => {
            onPresetChanged(event.detail);
        };
        this.options.windowRef?.addEventListener('pm:preset-loaded', this.presetListener);
    }

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
