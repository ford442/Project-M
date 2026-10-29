// Routes <audio>/<video> elements into projectM's PCM ring.
//
// Element playback used to be its own ingest: an AnalyserNode created inside
// EM_JS, polled once per animation frame from the render loop, forwarding the
// newest 576 mono samples of a 2048-sample window. It dropped roughly a quarter
// of the signal at 48 kHz, collapsed stereo to mono, and could only exist on the
// main thread because it reached for `document`.
//
// Now an element is just another producer: MediaElementAudioSourceNode → the
// shared AudioWorkletNode → the ring. Same path, same timing, same stereo as
// worklet playback and external PCM.
//
// Installing this module also gives the baked EM_JS
// (`connect_media_element_source` in src/wasm/WasmAudioBridge.cpp) a host
// implementation to prefer, so the wiring can change without a WASM rebuild.

import { getAudioContext } from './projectm-audio-bootstrap.js';

/**
 * Source nodes already created per element. `createMediaElementSource()` throws
 * on a second call for the same element, and an element can legitimately be
 * connected again after a source switch.
 *
 * @type {WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>}
 */
const elementSources = new WeakMap();

/**
 * @param {HTMLMediaElement | string} target Element, or a CSS selector for one.
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @returns {HTMLMediaElement | null}
 */
function resolveElement(target, { documentRef } = {}) {
    if (typeof target !== 'string') {
        return target || null;
    }
    const doc = documentRef || globalThis.document;
    if (!doc) return null;
    return /** @type {HTMLMediaElement | null} */ (doc.querySelector(target));
}

/**
 * Connects a media element to the shared worklet so its audio reaches the
 * engine. Idempotent per element.
 *
 * @param {HTMLMediaElement | string} target Element, or a CSS selector for one.
 * @param {object} [options]
 * @param {AudioContext} [options.audioContext]
 * @param {AudioWorkletNode} [options.workletNode]
 * @param {Document} [options.documentRef]
 * @returns {boolean} true when the element is connected.
 */
export function connectMediaElement(target, {
    audioContext = getAudioContext() || undefined,
    workletNode = globalThis.projectMWorkletNode_Global_Cpp || undefined,
    documentRef,
} = {}) {
    const element = resolveElement(target, { documentRef });
    if (!element) {
        console.warn('[projectM element source] no media element for', target);
        return false;
    }
    if (!audioContext || !workletNode) {
        console.warn('[projectM element source] AudioContext or worklet not ready yet');
        return false;
    }

    let source = elementSources.get(element);
    if (!source) {
        try {
            source = audioContext.createMediaElementSource(element);
        } catch (err) {
            console.error('[projectM element source] createMediaElementSource failed:', err);
            return false;
        }
        elementSources.set(element, source);
    }

    // Into the worklet (which writes the ring) and on to the speakers. The
    // worklet passes its input through, so connecting it to the destination —
    // which projectM's init already does — is what keeps the element audible.
    source.connect(workletNode);
    return true;
}

/**
 * Disconnects a previously connected element. The source node is kept, because
 * the Web Audio API will not let us make a second one for the same element.
 *
 * @param {HTMLMediaElement | string} target
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @returns {boolean} true when something was disconnected.
 */
export function disconnectMediaElement(target, { documentRef } = {}) {
    const element = resolveElement(target, { documentRef });
    if (!element) return false;
    const source = elementSources.get(element);
    if (!source) return false;
    try {
        source.disconnect();
    } catch (err) {
        console.debug('[projectM element source] disconnect failed:', err);
        return false;
    }
    return true;
}

/**
 * Installs `globalThis.projectMConnectMediaElement`, which the WASM
 * `connect_media_element_source()` export prefers over its own inline fallback.
 *
 * @returns {void}
 */
export function installMediaElementSourceHook() {
    /** @type {any} */ (globalThis).projectMConnectMediaElement =
    /** @param {string} selector */
    (selector) => connectMediaElement(selector);
}

/**
 * Test seam: forgets the cached source node for `element`.
 *
 * @param {HTMLMediaElement | null | undefined} element
 */
export function resetMediaElementSourcesForTests(element) {
    if (element) elementSources.delete(element);
}
