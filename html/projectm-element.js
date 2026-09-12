import { buildProjectMWasmUrls } from './projectm-wasm-version.js';
import { ProjectMContext } from './projectm-context.js';
import { ELEMENT_TAG, OBSERVED_ATTRIBUTES } from './projectm-element-attributes.js';

export { ELEMENT_TAG, OBSERVED_ATTRIBUTES };

/**
 * @typedef {import('./projectm-context-types.ts').ProjectMAudioSource} ProjectMAudioSource
 * @typedef {import('./projectm-context-types.ts').ProjectMMeshQuality} ProjectMMeshQuality
 * @typedef {import('./projectm-context-types.ts').ProjectMRenderTopology} ProjectMRenderTopology
 */

/**
 * @param {string | null | undefined} value
 * @param {boolean} [fallback]
 * @returns {boolean}
 */
function parseBoolean(value, fallback = false) {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
        return false;
    }
    return true;
}

/**
 * @param {string | null | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function parseNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * @param {string | null | undefined} value
 * @returns {string[]}
 */
function parseOriginList(value) {
    if (!value) {
        return [];
    }
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return [];
        }
    }
    return trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * @param {EventTarget} target
 * @param {string} type
 * @param {unknown} [detail]
 */
function dispatchLifecycleEvent(target, type, detail) {
    target.dispatchEvent(new CustomEvent(type, {
        bubbles: true,
        composed: true,
        detail,
    }));
}

/**
 * Embeddable custom element wrapping projectM canvas bootstrap + context options.
 *
 * Uses unique per-element canvas ids (not page-global `#mcanvas` / `#scanvas`) and
 * passes CSS selectors into WASM via `init_with_canvases`. One Module instance /
 * one active visualizer per document is supported; multi-embed via iframes — see
 * packages/web/README.md and docs/EMSCRIPTEN.md.
 */
export class ProjectMVisualizerElement extends HTMLElement {
    static observedAttributes = OBSERVED_ATTRIBUTES;

    /** @type {ProjectMContext | null} */
    #context = null;
    /** @type {Promise<ProjectMContext> | null} */
    #bootPromise = null;

    connectedCallback() {
        if (this.querySelector('canvas.pm-main-canvas')) {
            this.#boot();
            return;
        }

        this.style.display = this.style.display || 'block';
        this.style.position = this.style.position || 'relative';
        this.style.width = this.style.width || '100%';
        this.style.height = this.style.height || '100%';
        this.style.overflow = 'hidden';

        const container = document.createElement('div');
        container.className = 'pm-visualizer-container';
        container.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';

        const mcanvas = document.createElement('canvas');
        mcanvas.className = 'emscripten pm-main-canvas';
        mcanvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';

        const scanvas = document.createElement('canvas');
        scanvas.className = 'emscripten pm-secondary-canvas';
        scanvas.style.cssText =
            'pointer-events:auto;display:block;position:absolute;z-index:1;background:rgba(0,0,0,1);top:0;left:0;width:100%;height:100%;transform:scaleY(-1);';

        if (parseBoolean(this.getAttribute('transparent'))) {
            mcanvas.style.background = 'transparent';
            scanvas.style.display = 'none';
        }

        container.append(mcanvas, scanvas);
        this.append(container);
        this.#boot();
    }

    disconnectedCallback() {
        this.#context?.destroy();
        this.#context = null;
        this.#bootPromise = null;
    }

    /**
     * @param {string} name
     * @param {string | null} oldValue
     * @param {string | null} newValue
     */
    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue || !this.isConnected || !this.#context?.ready) {
            return;
        }

        switch (name) {
        case 'locked':
            this.#context.setLocked(parseBoolean(newValue));
            break;
        case 'transparent':
            this.#context.setTransparent(parseBoolean(newValue));
            break;
        case 'mesh-quality':
            this.#context.setMeshQuality(/** @type {ProjectMMeshQuality} */ (newValue || 'auto'));
            break;
        case 'target-fps':
            this.#context.setTargetFps(parseNumber(newValue, 60));
            break;
        case 'preset-url':
            if (newValue) {
                this.loadPreset(newValue).catch((error) => {
                    this.#emitError(error);
                });
            }
            break;
        default:
            break;
        }
    }

    get context() {
        return this.#context;
    }

    /** @returns {Promise<ProjectMContext | null>} */
    async ready() {
        await this.#bootPromise;
        return this.#context;
    }

    /**
     * @param {string} url
     * @returns {Promise<{ url: string; vfsPath: string; filename: string }>}
     */
    async loadPreset(url) {
        const context = await this.ready();
        if (!context) {
            throw new Error('project-m-visualizer failed to initialize');
        }
        const result = await context.loadPresetUrl(url);
        dispatchLifecycleEvent(this, 'pm-preset-changed', {
            name: result.filename,
            path: result.vfsPath,
            url: result.url,
        });
        return result;
    }

    /**
     * @param {File} file
     * @returns {Promise<{ filename: string; vfsPath: string }>}
     */
    async loadPresetFile(file) {
        const context = await this.ready();
        if (!context) {
            throw new Error('project-m-visualizer failed to initialize');
        }
        const result = await context.loadPresetFile(file);
        dispatchLifecycleEvent(this, 'pm-preset-changed', {
            name: result.filename,
            path: result.vfsPath,
        });
        return result;
    }

    nextPreset() {
        this.#context?.nextPreset();
    }

    /** @returns {Promise<ProjectMContext>} */
    #boot() {
        if (this.#bootPromise) {
            return this.#bootPromise;
        }

        const canvas = /** @type {HTMLCanvasElement | null} */ (
            this.querySelector('canvas.pm-main-canvas') || this.querySelector('canvas')
        );
        const secondaryCanvas = /** @type {HTMLCanvasElement | null} */ (
            this.querySelector('canvas.pm-secondary-canvas')
        );
        if (!canvas) {
            const error = new Error('project-m-visualizer is missing a primary canvas');
            this.#emitError(error);
            return Promise.reject(error);
        }

        if (document.querySelectorAll('project-m-visualizer').length > 1) {
            console.warn(
                '[project-m-visualizer] Multiple elements in one document: only one Module ' +
                'instance / one active visualizer is supported. Use separate iframes for ' +
                'multi-embed, or rebind_canvases() to switch the active surface.'
            );
        }

        const wasmBaseUrl = this.getAttribute('wasm-base-url') || undefined;
        const wasmScriptUrl = this.getAttribute('wasm-script-url') || undefined;
        const presetUrl = this.getAttribute('preset-url') || undefined;
        const audioSource = /** @type {ProjectMAudioSource} */ (this.getAttribute('audio-source') || 'none');
        const requireCrossOriginIsolation = parseBoolean(
            this.getAttribute('crossorigin-isolated')
                ?? this.getAttribute('require-cross-origin-isolation'),
            true
        );
        // Embedders cannot set a query parameter on someone else's page, so the
        // topology escape hatch has to be an attribute too. Read once at boot:
        // where rendering happens is not something that can change under a
        // running engine.
        const renderTopology = /** @type {ProjectMRenderTopology} */ (
            this.getAttribute('render-topology') || 'auto'
        );

        this.#bootPromise = (async () => {
            const context = new ProjectMContext({
                canvas,
                secondaryCanvas,
                container: canvas.parentElement ?? this,
                wasmBaseUrl: wasmBaseUrl || import.meta.url,
                wasmScriptUrl: wasmScriptUrl || undefined,
                requireCrossOriginIsolation,
                meshQuality: /** @type {ProjectMMeshQuality} */ (this.getAttribute('mesh-quality') || 'auto'),
                targetFps: parseNumber(this.getAttribute('target-fps'), 60),
                qualityGovernor: true,
                transparent: parseBoolean(this.getAttribute('transparent')),
                presetUrl,
                presetLocked: parseBoolean(this.getAttribute('locked')),
                audioSource,
                audioElement: this.getAttribute('audio-element') || undefined,
                externalPcmOrigins: parseOriginList(this.getAttribute('external-pcm-origins')),
                renderTopology,
                onRenderWorkerFallback: (reason) => {
                    console.info('[project-m-visualizer] rendering on the main thread:', reason);
                },
                onReady: () => {
                    dispatchLifecycleEvent(this, 'pm-ready', { version: buildProjectMWasmUrls().wasm });
                },
                onError: (detail) => {
                    dispatchLifecycleEvent(this, 'pm-error', detail);
                },
                onPresetChanged: (detail) => {
                    dispatchLifecycleEvent(this, 'pm-preset-changed', detail);
                },
                onFps: (fps) => {
                    dispatchLifecycleEvent(this, 'pm-fps', { fps });
                },
                onAudioSourceChange: (status) => {
                    dispatchLifecycleEvent(this, 'pm-audio-source', status);
                },
            });

            await context.start();
            this.#context = context;
            return context;
        })().catch((error) => {
            this.#emitError(error);
            throw error;
        });

        return this.#bootPromise;
    }

    /** @param {unknown} error */
    #emitError(error) {
        dispatchLifecycleEvent(this, 'pm-error', {
            code: -1,
            message: error instanceof Error ? error.message : String(error),
            error,
        });
    }
}

/** @param {{ tagName?: string }} [options] */
export function registerProjectMElement(options = {}) {
    const tag = options.tagName || ELEMENT_TAG;
    if (!customElements.get(tag)) {
        customElements.define(tag, ProjectMVisualizerElement);
    }
}

if (typeof HTMLElement !== 'undefined' && typeof customElements !== 'undefined') {
    registerProjectMElement();
}

export { buildProjectMWasmUrls };
