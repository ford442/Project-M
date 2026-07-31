import {
    setAudioSourceToStream,
    setHostAudioSourceRouter,
    stopWorkletPlayback,
} from './generated/projectm-wasm-api.js';

/**
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 * @typedef {import('./projectm-context-types.ts').ProjectMAudioSource} ProjectMAudioSource
 */

/** @typedef {'none' | 'element' | 'external' | 'worklet'} ProjectMAudioSourceActive */
/** @typedef {'exclusive' | 'mix'} ProjectMAudioRouterMode */

/**
 * @typedef {object} ProjectMAudioSourceStatus
 * @property {ProjectMAudioSourceActive} activeSource
 * @property {ProjectMAudioRouterMode} mode
 * @property {boolean} streamEnabled
 * @property {boolean} externalEnabled
 * @property {boolean} workletAllowed
 */

/**
 * Host-layer router that enforces a single active PCM ingress path by default.
 *
 * **Exclusive mode (default):** only one of element/stream, external PCM, or
 * worklet may feed libprojectM at a time. Switching sources stops the worklet
 * and toggles the stream-analyser gate (`set_audio_source_to_stream`).
 *
 * **Mix mode:** documented for future use; not implemented yet — `canFeed()`
 * still mirrors exclusive behaviour until mixing is designed.
 */
export class AudioSourceRouter {
    /**
     * @param {object} [options]
     * @param {ProjectMModuleLike | null} [options.module]
     * @param {ProjectMAudioRouterMode} [options.mode]
     * @param {ProjectMAudioSourceActive} [options.initialSource]
     * @param {boolean} [options.autoSwitchOnFeed] When true, the first external
     *   PCM chunk or `pl()` call promotes that path to active (used by legacy
     *   `projectm-core.html` which wires external PCM alongside worklet).
     * @param {(status: ProjectMAudioSourceStatus) => void} [options.onStatusChange]
     */
    constructor({
        module = null,
        mode = 'exclusive',
        initialSource = 'none',
        autoSwitchOnFeed = false,
        onStatusChange,
    } = {}) {
        /** @type {ProjectMModuleLike | null} */
        this.module = module;
        this.mode = mode;
        this.autoSwitchOnFeed = autoSwitchOnFeed;
        /** @type {ProjectMAudioSourceActive} */
        this.activeSource = initialSource;
        /** @type {(status: ProjectMAudioSourceStatus) => void | undefined} */
        this.onStatusChange = onStatusChange;
        this._applyExclusivePolicy(this.activeSource);
        setHostAudioSourceRouter(this);
    }

    /** @param {ProjectMModuleLike | null} module */
    setModule(module) {
        if (this.module === module) {
            return;
        }
        this.module = module;
        setHostAudioSourceRouter(this);
        this._applyExclusivePolicy(this.activeSource);
    }

    /**
     * @param {ProjectMAudioSource | ProjectMAudioSourceActive} source
     */
    setActiveSource(source) {
        const normalized = /** @type {ProjectMAudioSourceActive} */ (source);
        if (this.activeSource === normalized) {
            return;
        }
        this.activeSource = normalized;
        if (this.mode === 'exclusive') {
            this._applyExclusivePolicy(normalized);
        }
        this._emitStatus();
    }

    /** @returns {ProjectMAudioSourceActive} */
    getActiveSource() {
        return this.activeSource;
    }

    /** @returns {ProjectMAudioSourceStatus} */
    getStatus() {
        return {
            activeSource: this.activeSource,
            mode: this.mode,
            streamEnabled: this.activeSource === 'element',
            externalEnabled: this.activeSource === 'external',
            workletAllowed: this.activeSource === 'worklet',
        };
    }

    /**
     * @param {ProjectMAudioSourceActive} source
     * @returns {boolean}
     */
    canFeed(source) {
        if (this.mode === 'mix') {
            // Mix mode is reserved; treat as exclusive until implemented.
            return this.activeSource === 'none' ? false : this.activeSource === source;
        }
        if (this.activeSource === 'none') {
            return this.autoSwitchOnFeed;
        }
        return this.activeSource === source;
    }

    /** Called when an external PCM chunk is accepted at the host boundary. */
    notifyExternalFeed() {
        if (this.activeSource === 'external') {
            return;
        }
        if (this.autoSwitchOnFeed) {
            this.setActiveSource('external');
        }
    }

    /** Called before the worklet decode path (`pl()`) runs. */
    notifyWorkletFeed() {
        if (this.activeSource === 'worklet') {
            return;
        }
        if (this.autoSwitchOnFeed) {
            this.setActiveSource('worklet');
        }
    }

    /**
     * Gate for `projectm-external-pcm.js` — returns false when external PCM
     * should be dropped (not queued) under the active policy.
     * @returns {boolean}
     */
    externalFeedGate() {
        if (this.activeSource === 'none' && this.autoSwitchOnFeed) {
            this.notifyExternalFeed();
            return true;
        }
        if (!this.canFeed('external')) {
            return false;
        }
        this.notifyExternalFeed();
        return true;
    }

    /**
     * Wraps a feed callback so exclusive policy is enforced before WASM ingest.
     * @param {import('./projectm-host-types.ts').ExternalPcmFeedFn} feedFn
     * @returns {import('./projectm-host-types.ts').ExternalPcmFeedFn}
     */
    wrapExternalFeed(feedFn) {
        return (buffer, channels, sampleRate, samplesPerChannel) => {
            if (!this.externalFeedGate()) {
                return false;
            }
            return feedFn(buffer, channels, sampleRate, samplesPerChannel);
        };
    }

    destroy() {
        setHostAudioSourceRouter(null);
        this.module = null;
        this.onStatusChange = undefined;
    }

    /** @param {ProjectMAudioSourceActive} source */
    _applyExclusivePolicy(source) {
        const module = this.module;
        if (!module) {
            return;
        }

        if (source === 'external' || source === 'element' || source === 'none') {
            stopWorkletPlayback(module);
        }

        setAudioSourceToStream(module, source === 'element');
    }

    _emitStatus() {
        this.onStatusChange?.(this.getStatus());
    }
}

/**
 * @param {ConstructorParameters<typeof AudioSourceRouter>[0]} [options]
 * @returns {AudioSourceRouter}
 */
export function createAudioSourceRouter(options) {
    return new AudioSourceRouter(options);
}

/**
 * Maps embed `audioSource` option to the router's initial active path.
 * @param {ProjectMAudioSource | undefined} audioSource
 * @returns {ProjectMAudioSourceActive}
 */
export function audioSourceToRouterSource(audioSource) {
    switch (audioSource) {
    case 'element':
        return 'element';
    case 'external':
        return 'external';
    default:
        return 'none';
    }
}
