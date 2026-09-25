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
// This is the one place the host's audio-source policy lives. It deliberately
// is NOT in `generated/projectm-wasm-api.js`: that file is regenerated from
// `cmake/WasmApiManifest.cmake` by `scripts/sync_wasm_link_common.sh`, and an
// earlier hand-edit that added `setHostAudioSourceRouter()` there was silently
// wiped by the next regeneration — leaving this module importing an export that
// no longer existed, which throws at ESM link time and took
// `projectm-context.js` down with it. Exclusive-source policy is host policy,
// not a WASM symbol; the generated wrappers are ccall/direct only, and
// `playSong()` below is the gate in front of the generated `pl()`.

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

/**
 * Routers that are alive on this page, oldest first. The last entry is the one
 * the process-wide worklet reports to.
 *
 * A list rather than a single slot: with two contexts on a page each has its
 * own router, and the second one registering must not make the first one's
 * destroy() unregister *it*. The worklet, and `pl()`, are process-global, so
 * "the router" they consult is inherently the most recently active one.
 *
 * @type {AudioSourceRouter[]}
 */
const hostAudioSourceRouters = [];

/**
 * Makes `router` the one the worklet path notifies. Registering a router that
 * is already registered moves it to the front of the queue again, which is what
 * a router does whenever it is handed a new module or transport.
 *
 * @param {AudioSourceRouter} router
 */
export function registerHostAudioSourceRouter(router) {
    unregisterHostAudioSourceRouter(router);
    hostAudioSourceRouters.push(router);
}

/**
 * Removes one router from the registry. Whoever was registered before it takes
 * over again; other routers are not affected.
 *
 * @param {AudioSourceRouter} router
 */
export function unregisterHostAudioSourceRouter(router) {
    const index = hostAudioSourceRouters.indexOf(router);
    if (index !== -1) {
        hostAudioSourceRouters.splice(index, 1);
    }
}

/**
 * Registers the host {@link AudioSourceRouter} consulted by {@link playSong}
 * and by the worklet playback path, or, with `null`, forgets every router.
 *
 * Prefer {@link registerHostAudioSourceRouter} / {@link unregisterHostAudioSourceRouter}
 * from code that owns one router among several; `null` here is the blunt
 * "reset the page" form kept for hosts and tests.
 *
 * @param {AudioSourceRouter | null} router
 */
export function setHostAudioSourceRouter(router) {
    if (router) {
        registerHostAudioSourceRouter(router);
    } else {
        hostAudioSourceRouters.length = 0;
    }
}

/** @returns {AudioSourceRouter | null} The most recently registered router, if any. */
export function getHostAudioSourceRouter() {
    return hostAudioSourceRouters[hostAudioSourceRouters.length - 1] ?? null;
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
    const router = getHostAudioSourceRouter();
    router?.notifyWorkletFeed();
    if (router && !router.canFeed('worklet')) {
        console.debug(
            '[projectM audio router] blocked pl() — active source is',
            router.getActiveSource(),
        );
        return false;
    }
    pl(module, songPath);
    return true;
}

/** @typedef {'none' | 'element' | 'external' | 'worklet'} ProjectMAudioSourceActive */

/**
 * @typedef {object} ProjectMAudioSourceStatus
 * @property {ProjectMAudioSourceActive} activeSource
 * @property {boolean} streamEnabled
 * @property {boolean} externalEnabled
 * @property {boolean} workletAllowed
 */

/**
 * Host-layer router that enforces a single active PCM ingress path.
 *
 * Only one of element/stream, external PCM, or worklet may feed libprojectM at
 * a time. Switching sources stops the worklet and toggles the stream-analyser
 * gate (`set_audio_source_to_stream`).
 *
 * There is deliberately no "mix" mode. Blending sources has to happen in the
 * Web Audio graph, before the single PCM ring producer, never inside the
 * engine; until that graph exists a `mode` option would only promise something
 * the router cannot do.
 */
export class AudioSourceRouter {
    /**
     * @param {object} [options]
     * @param {ProjectMModuleLike | null} [options.module]
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
        initialSource = 'none',
        autoSwitchOnFeed = false,
        onStatusChange,
        transport = null,
    } = {}) {
        /** @type {ProjectMModuleLike | null} */
        this.module = module;
        /** @type {import('./projectm-transport-types.ts').RenderTransport | null} */
        this.transport = transport;
        this.autoSwitchOnFeed = autoSwitchOnFeed;
        /** @type {ProjectMAudioSourceActive} */
        this.activeSource = initialSource;
        // Parenthesised: `(...) => void | undefined` would bind the union to the
        // *return* type, making the property non-optional.
        /** @type {((status: ProjectMAudioSourceStatus) => void) | undefined} */
        this.onStatusChange = onStatusChange;
        this.destroyed = false;
        this._applyExclusivePolicy(this.activeSource);
        registerHostAudioSourceRouter(this);
    }

    /**
     * @param {import('./projectm-transport-types.ts').RenderTransport | null} transport
     */
    setTransport(transport) {
        if (this.transport === transport) {
            return;
        }
        this.transport = transport;
        if (transport) {
            this._registerUnlessDestroyed();
        }
        this._applyExclusivePolicy(this.activeSource);
    }

    /** @param {ProjectMModuleLike | null} module */
    setModule(module) {
        if (this.module === module) {
            return;
        }
        this.module = module;
        if (module) {
            // Attaching an engine makes this the active router; detaching one
            // (a context letting go of a shared router) must not.
            this._registerUnlessDestroyed();
        }
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
        this._applyExclusivePolicy(normalized);
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

    /**
     * Leaves the registry and lets go of the module and transport. Only THIS
     * router is unregistered: another context's router, registered on the same
     * page, keeps receiving the worklet's notifications.
     */
    destroy() {
        this.destroyed = true;
        unregisterHostAudioSourceRouter(this);
        this.module = null;
        this.transport = null;
        this.onStatusChange = undefined;
    }

    /** A router that was torn down must not put itself back into the registry. */
    _registerUnlessDestroyed() {
        if (!this.destroyed) {
            registerHostAudioSourceRouter(this);
        }
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
