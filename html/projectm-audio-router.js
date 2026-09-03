/**
 * projectm-audio-router.js
 *
 * Single-active-source policy for projectM audio inputs.
 *
 * Four ingress paths feed PCM to the engine:
 *   'worklet'  — internal AudioWorklet (projectm_audio_processor.js)
 *   'element'  — media element routed through the worklet (#audio-stream-element)
 *   'external' — MOD/FLAC players via postMessage (projectm-external-pcm.js)
 *   'none'     — no source configured (default / reset)
 *
 * Default policy is *exclusive*: activating any source records it as the single
 * live path and fires a `pm-audio-source` CustomEvent on the window so hosts and
 * panels can reflect the current state.  Switching from one source to another
 * fires the event again with the new value.
 *
 * The router does **not** suppress the WASM-managed worklet, because it is
 * created from C++ land.  It does:
 *   - Gate the external-PCM feed (see `shouldFeedExternal()`) so that external
 *     chunks are ignored when a different source is currently active.
 *   - Expose the active source via `activeSource` for host UI and context events.
 *
 * Usage:
 *   const router = new AudioSourceRouter({ windowRef: window });
 *   router.activate('external');          // → emits pm-audio-source { source:'external' }
 *   router.activate('element');           // → emits pm-audio-source { source:'element' }
 *   router.shouldFeedExternal();          // → false (element is active)
 */

/** @typedef {'none' | 'worklet' | 'element' | 'external'} AudioSourceName */

export const AUDIO_SOURCE_NONE = /** @type {AudioSourceName} */ ('none');
export const AUDIO_SOURCE_WORKLET = /** @type {AudioSourceName} */ ('worklet');
export const AUDIO_SOURCE_ELEMENT = /** @type {AudioSourceName} */ ('element');
export const AUDIO_SOURCE_EXTERNAL = /** @type {AudioSourceName} */ ('external');

/** All valid source names, in priority order used for display. */
export const AUDIO_SOURCE_NAMES = /** @type {readonly AudioSourceName[]} */ ([
    'none',
    'worklet',
    'element',
    'external',
]);

/**
 * Enforces a single-active-source policy and dispatches `pm-audio-source`
 * CustomEvents when the active source changes.
 */
export class AudioSourceRouter {
    /** @type {AudioSourceName} */
    #active = 'none';
    /** @type {(Window & typeof globalThis) | null} */
    #windowRef = null;

    /**
     * @param {{ windowRef?: (Window & typeof globalThis) | null }} [options]
     */
    constructor({ windowRef } = {}) {
        this.#windowRef = windowRef !== undefined
            ? windowRef
            : (typeof window !== 'undefined' ? window : null);
    }

    /** The currently active audio source name. */
    get activeSource() {
        return this.#active;
    }

    /**
     * Switches to the given source.  If the source is already active this is a
     * no-op and returns `false`.  Otherwise the active source is updated and a
     * `pm-audio-source` event is fired on the window.
     *
     * @param {AudioSourceName} source
     * @returns {boolean} `true` when the source actually changed.
     */
    activate(source) {
        if (!AUDIO_SOURCE_NAMES.includes(source)) {
            console.warn('[AudioSourceRouter] unknown source:', source);
            return false;
        }
        if (source === this.#active) return false;
        this.#active = source;
        this.#emit(source);
        return true;
    }

    /**
     * Returns `true` when external PCM should be forwarded to the engine.  In
     * exclusive mode (the default) this is only the case while `active === 'external'`.
     * Hosts that want mix-mode may ignore this check, but they must document the
     * policy explicitly.
     *
     * @returns {boolean}
     */
    shouldFeedExternal() {
        return this.#active === 'external';
    }

    /**
     * Resets the router to `'none'` without emitting an event.  Useful during
     * cleanup / destroy so that dangling listeners don't react to teardown.
     */
    reset() {
        this.#active = 'none';
    }

    /**
     * Update the window reference used for event dispatch (e.g. after the
     * context's `windowRef` becomes available post-construction).
     * @param {(Window & typeof globalThis) | null} ref
     */
    setWindowRef(ref) {
        this.#windowRef = ref;
    }

    /** @param {AudioSourceName} source */
    #emit(source) {
        const ref = this.#windowRef;
        if (!ref) return;
        try {
            ref.dispatchEvent(
                new CustomEvent('pm-audio-source', {
                    bubbles: false,
                    cancelable: false,
                    detail: { source },
                })
            );
        } catch (_) {
            // Non-fatal: some environments (e.g. minimal Node.js test shims without
            // CustomEvent) may throw; swallow to keep teardown safe.
        }
    }
}
