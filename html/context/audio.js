// context/audio.js
//
// ProjectMContext's audio wiring: which audio router the context feeds (its
// own, or one the host shares), and how the configured source — an external
// PCM sender, a media element, or nothing — reaches the engine. Everything
// acquired is handed to `own`, the context's teardown list.

import { ensureAudioRunning } from '../projectm-audio-bootstrap.js';
import { ensureWorkletReady } from '../projectm-worklet-playback.js';
import {
    connectMediaElement,
    disconnectMediaElement,
    installMediaElementSourceHook,
} from '../projectm-audio-element-source.js';
import { audioSourceToRouterSource, createAudioSourceRouter } from '../projectm-audio-source-router.js';
import { defaultFeedPCMToModule, setupExternalAudioReceiver } from '../projectm-external-pcm.js';

/**
 * @typedef {import('../generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('../projectm-transport-types.ts').RenderTransport} RenderTransport
 * @typedef {import('../projectm-context-types.ts').ProjectMAudioSource} ProjectMAudioSource
 * @typedef {import('../projectm-context-types.ts').ProjectMAudioSourceStatus} ProjectMAudioSourceStatus
 * @typedef {import('../projectm-audio-source-router.js').AudioSourceRouter} AudioSourceRouter
 * @typedef {(dispose: (() => void) | { dispose(): void } | null | undefined) => void} Own
 */

/**
 * @param {HTMLMediaElement | string | null | undefined} value
 * @param {Document | undefined} documentRef
 * @returns {HTMLMediaElement | null}
 */
export function resolveMediaElement(value, documentRef) {
    if (!value) {
        return null;
    }
    if (typeof value === 'string') {
        return /** @type {HTMLMediaElement | null} */ (documentRef?.querySelector(value)) ?? null;
    }
    return value;
}

/**
 * Creates the context's audio router, or adopts the host's.
 *
 * A router the context created is its own and is destroyed with it. One the
 * host injected (core.html shares a single router between the page and its
 * context) belongs to the host: teardown only detaches this context from it
 * and restores its status callback.
 *
 * @param {object} options
 * @param {AudioSourceRouter | null | undefined} options.existingRouter
 * @param {ProjectMModule | null} options.module
 * @param {RenderTransport} options.transport
 * @param {ProjectMAudioSource | undefined} options.audioSource
 * @param {(status: ProjectMAudioSourceStatus) => void} options.publish Status changes, to the host.
 * @param {Own} options.own
 * @returns {AudioSourceRouter}
 */
export function attachAudioRouter({ existingRouter, module, transport, audioSource, publish, own }) {
    if (!existingRouter) {
        const created = createAudioSourceRouter({
            module,
            transport,
            initialSource: audioSourceToRouterSource(audioSource),
            onStatusChange: publish,
        });
        own(() => created.destroy());
        return created;
    }

    existingRouter.setModule(module);
    existingRouter.setTransport(transport);
    const prior = existingRouter.onStatusChange;
    /** @param {ProjectMAudioSourceStatus} status */
    const wrapped = (status) => {
        prior?.(status);
        publish(status);
    };
    existingRouter.onStatusChange = wrapped;
    own(() => {
        if (existingRouter.onStatusChange === wrapped) {
            existingRouter.onStatusChange = prior;
        }
        if (existingRouter.module === module) {
            existingRouter.setModule(null);
        }
        if (existingRouter.transport === transport) {
            existingRouter.setTransport(null);
        }
    });
    return existingRouter;
}

/**
 * Connects the configured audio source to this context's engine.
 *
 * @param {object} options
 * @param {ProjectMAudioSource} options.audioSource
 * @param {HTMLMediaElement | null} options.media The element for `'element'`, resolved by the caller.
 * @param {string[] | undefined} options.externalPcmOrigins
 * @param {AudioSourceRouter | null} options.router
 * @param {boolean} options.sharedRouter The host injected `router` (see {@link attachAudioRouter}).
 * @param {RenderTransport | null} options.transport
 * @param {AbortSignal} options.signal Aborted when the context is torn down.
 * @param {Own} options.own
 * @returns {HTMLMediaElement | null} The element now feeding the engine, if any.
 */
export function wireAudioSource({ audioSource, media, externalPcmOrigins, router, sharedRouter, transport, signal, own }) {
    if (audioSource === 'external') {
        const receiver = setupExternalAudioReceiver({
            allowedOrigins: externalPcmOrigins ?? [],
            // This context's own engine, so the receiver keeps feeding it
            // whatever another context registers as the page default.
            transport,
            feedGate: () => router?.externalFeedGate() ?? false,
            onFeed: router
                ? router.wrapExternalFeed(defaultFeedPCMToModule)
                : defaultFeedPCMToModule,
        });
        own(receiver.close);
        return null;
    }

    if (audioSource !== 'element') {
        // Keep shared host routers (e.g. core.html autoSwitchOnFeed) at 'none'
        // so the first external/worklet feed can promote the active source.
        if (!sharedRouter) {
            router?.setActiveSource('none');
        }
        return null;
    }

    if (!media) {
        console.warn('[ProjectMContext] audioSource=element but no audio element was provided');
        return null;
    }

    router?.setActiveSource('element');
    media.id = media.id || 'audio-stream-element';
    own(installMediaElementSourceHook());
    ensureAudioRunning().catch(() => {
        // Autoplay policies may require a user gesture; host should call ensureAudioRunning().
    });
    // The element feeds the engine through the shared worklet (and from there
    // the PCM ring), so it cannot be connected until the worklet node exists.
    // By then this context may have been destroyed: connecting then would wire
    // a torn-down context's element into the shared worklet for good.
    ensureWorkletReady()
        .then((ready) => {
            if (!ready || signal.aborted) {
                return;
            }
            if (connectMediaElement(media)) {
                own(() => disconnectMediaElement(media));
            }
        })
        .catch((err) => {
            console.warn('[ProjectMContext] could not connect audio element:', err);
        });
    return media;
}
