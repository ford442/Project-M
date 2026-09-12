import {
    pl,
    setAudioSourceToStream,
    stopWorkletPlayback,
} from './generated/projectm-wasm-api.js';

/**
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 * @typedef {import('./projectm-context-types.ts').ProjectMAudioSource} ProjectMAudioSource
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 */

// Host-side registry for the active router.
//
// This deliberately lives here and NOT in `generated/projectm-wasm-api.js`:
// that file is regenerated from `cmake/WasmApiManifest.cmake` by
// `scripts/sync_wasm_link_common.sh`, and an earlier hand-edit that added
// `setHostAudioSourceRouter()` there was silently wiped by the next
// regeneration — leaving this module importing an export that no longer
// existed, which throws at ESM link time and took `projectm-context.js` down
// with it. Exclusive-source policy is host policy, not a WASM symbol, so it
// belongs in a hand-written module.

/**
 * Readiness check narrowing the defensively-optional {@link ProjectMModuleLike}
 * to the full module type the generated wrappers require. The WASM build's
 * exported set varies by link flags, so both symbols are feature-detected
 * rather than assumed.
 *
 * @param {ProjectMModuleLike | null} moduleInstance
 * @returns {moduleInstance is ProjectMModule}
 */
function canRouteAudio(moduleInstance) {
    return !!(
        moduleInstance &&
        moduleInstance._stop_worklet_playback &&
        moduleInstance._set_audio_source_to_stream
    );
}

/** @type {AudioSourceRouter | null} */
let hostAudioSourceRouter = null;

/**
 * Registers the host {@link AudioSourceRouter} consulted by {@link playSong}.
 *
 * @param {AudioSourceRouter | null} router
 */
export function setHostAudioSourceRouter(router) {
    hostAudioSourceRouter = router;
}

/** @returns {AudioSourceRouter | null} The currently registered router, if any. */
export function getHostAudioSourceRouter() {
    return hostAudioSourceRouter;
}

/**
 * Plays a VFS song through the worklet, respecting exclusive-source policy.
 *
 * Use this instead of the raw generated `pl()` wrapper from host code: when a
 * router is registered and another source (element/stream or external PCM) owns
 * the ingress path, the call is dropped instead of double-feeding libprojectM.
 *
 * @param {ProjectMModule} module
 * @param {string} songPath VFS path of the song to play.
 * @returns {boolean} true if the call was forwarded to the engine.
 */
export function playSong(module, songPath) {
    hostAudioSourceRouter?.notifyWorkletFeed();
    if (hostAudioSourceRouter && !hostAudioSourceRouter.canFeed('worklet')) {
        console.debug(
            '[projectM audio router] blocked pl() — active source is',
            hostAudioSourceRouter.getActiveSource(),
        );
        return false;
    }
    pl(module, songPath);
    return true;
}

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
     * @param {import('./projectm-transport-types.ts').RenderTransport | null} [options.transport]
     *   Render transport, when the host has one. The two engine ops the router
     *   performs go through it instead of through `module`, so the router works
     *   unchanged when the engine is in the render worker and there is no
     *   module on this thread at all.
     */
    constructor({
        module = null,
        mode = 'exclusive',
        initialSource = 'none',
        autoSwitchOnFeed = false,
        onStatusChange,
        transport = null,
    } = {}) {
        /** @type {ProjectMModuleLike | null} */
        this.module = module;
        /** @type {import('./projectm-transport-types.ts').RenderTransport | null} */
        this.transport = transport;
        this.mode = mode;
        this.autoSwitchOnFeed = autoSwitchOnFeed;
        /** @type {ProjectMAudioSourceActive} */
        this.activeSource = initialSource;
        // Parenthesised: `(...) => void | undefined` would bind the union to the
        // *return* type, making the property non-optional.
        /** @type {((status: ProjectMAudioSourceStatus) => void) | undefined} */
        this.onStatusChange = onStatusChange;
        this._applyExclusivePolicy(this.activeSource);
        setHostAudioSourceRouter(this);
    }

    /**
     * @param {import('./projectm-transport-types.ts').RenderTransport | null} transport
     */
    setTransport(transport) {
        if (this.transport === transport) {
            return;
        }
        this.transport = transport;
        setHostAudioSourceRouter(this);
        this._applyExclusivePolicy(this.activeSource);
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
        this.transport = null;
        this.onStatusChange = undefined;
    }

    /** @param {ProjectMAudioSourceActive} source */
    _applyExclusivePolicy(source) {
        const transport = this.transport;
        if (transport && transport.topology === 'worker') {
            if (source === 'external' || source === 'element' || source === 'none') {
                transport.callVoid('stopWorkletPlayback');
            }
            transport.callVoid('setAudioSourceToStream', source === 'element');
            return;
        }

        const module = this.module;
        if (!canRouteAudio(module)) {
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
