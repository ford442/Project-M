// Hardening for the vendored FLAC player bundle (wasm-audio-decoders).
//
// The bundle decodes local/buffered files in a Worker running
// @wasm-audio-decoders/flac. That fails in three ways:
//   1. ID3-tagged payloads: the decoder never sees `fLaC` -> LOST_SYNC.
//   2. Valid FLACs whose frame headers say "sample rate / sample size: take
//      from STREAMINFO" (codes 0000 / 000), e.g. songs/Claws of the
//      Angel.flac. The decoder hands libFLAC bare frames, never STREAMINFO,
//      and every frame fails with LOST_SYNC: 0 samples, 0 channels. ffmpeg
//      and the browsers' native decoders play these files fine.
//   3. The 0-channel "success" then reaches AudioWorkletNode
//      (outputChannelCount: [0]) -> NotSupportedError, and the player shows
//      16-bit / 0:00 / "No audio loaded".
//
// The guard below runs before the bundle and does not require rebuilding it
// (see installWorkerFlacDecodeGuard for the decode order):
//   - strips an ID3v2 prefix;
//   - rewrites STREAMINFO-coded frame headers to explicit codes (recomputing
//     the header CRC-8 and frame CRC-16) so the WASM decoder can sync;
//   - falls back between the WASM decoder and the browser's own decoder
//     (OfflineAudioContext.decodeAudioData at the STREAMINFO rate);
//   - turns a decode nothing could recover into a worker error, so the player
//     reports it instead of building a 0-channel node;
//   - fills duration / bit depth from STREAMINFO;
//   - clamps AudioWorkletNode output channel counts to >= 1.

import { normalizeFlacFrameHeaders, parseFlacStreamInfo, stripId3Prefix } from './flac-headers.js';

export {
    isFlacMagic,
    normalizeFlacFrameHeaders,
    parseFlacFrameHeader,
    parseFlacStreamInfo,
    prepareFlacForDecode,
    stripId3Prefix,
} from './flac-headers.js';

/** @typedef {import('./flac-headers.js').FlacStreamInfo} FlacStreamInfo */


/**
 * @param {unknown} count
 * @param {number} [fallback=2]
 */
export function clampAudioChannelCount(count, fallback = 2) {
    const value = Number(count);
    if (!Number.isFinite(value) || value < 1) {
        return fallback;
    }
    return Math.min(32, Math.floor(value));
}

/**
 * Shape the bundle's worker (bundle.4f00c4158ff714867bc6.js) replies to
 * `decode` with, as `{ id, type: 'decoded', result }`. It drops the
 * decoder's `errors` array: frames that fail just go missing, which
 * {@link decodeShortfall} detects against STREAMINFO.
 * @typedef {object} FlacDecodeResult
 * @property {number} sampleRate
 * @property {number} channels
 * @property {Float32Array} interleavedBuffer
 * @property {number} duration
 * @property {number} [bitDepth] Set by the bundle's worker.
 * @property {number} [bitsPerSample]
 * @property {number} [samplesDecoded]
 * @property {unknown[]} [errors]
 */

/**
 * True when a worker decode result carries no playable audio.
 * @param {any} result
 */
export function isEmptyDecodeResult(result) {
    return !result
        || !(Number(result.channels) >= 1)
        || !(Number(result.sampleRate) > 0)
        || !result.interleavedBuffer
        || !(result.interleavedBuffer.length > 0);
}

/**
 * Samples per channel the decoder lost against STREAMINFO's total (0 when the
 * total is unknown or everything decoded).
 * @param {FlacDecodeResult} result
 * @param {FlacStreamInfo | null} info
 */
export function decodeShortfall(result, info) {
    if (!info || !(info.totalSamples > 0) || !(result.channels >= 1)) {
        return 0;
    }
    const frames = Math.floor(result.interleavedBuffer.length / result.channels);
    return Math.max(0, info.totalSamples - frames);
}

/**
 * @param {{ numberOfChannels: number, length: number, sampleRate: number, getChannelData(channel: number): Float32Array }} audioBuffer
 * @param {FlacStreamInfo | null} [info]
 * @returns {FlacDecodeResult}
 */
export function audioBufferToDecodeResult(audioBuffer, info) {
    const channels = audioBuffer.numberOfChannels;
    const frames = audioBuffer.length;
    const interleavedBuffer = new Float32Array(frames * channels);
    for (let channel = 0; channel < channels; channel++) {
        const data = audioBuffer.getChannelData(channel);
        for (let i = 0; i < frames; i++) {
            interleavedBuffer[i * channels + channel] = data[i];
        }
    }
    const bitDepth = info?.bitsPerSample ?? 16;
    return {
        sampleRate: audioBuffer.sampleRate,
        channels,
        interleavedBuffer,
        duration: frames / audioBuffer.sampleRate,
        bitDepth,
        bitsPerSample: bitDepth,
        samplesDecoded: frames,
    };
}

/**
 * Decode with the browser's native decoder. An OfflineAudioContext at the
 * STREAMINFO rate keeps decodeAudioData from resampling.
 * @param {ArrayBuffer} buffer
 * @param {any} [windowRef]
 * @returns {Promise<FlacDecodeResult>}
 */
export async function decodeWithWebAudio(buffer, windowRef = globalThis) {
    const Ctx = windowRef.OfflineAudioContext || windowRef.webkitOfflineAudioContext;
    if (typeof Ctx !== 'function') {
        throw new Error('OfflineAudioContext unavailable');
    }
    const info = parseFlacStreamInfo(buffer);
    const context = new Ctx(clampAudioChannelCount(info?.channels), 1, info?.sampleRate || 44100);
    const audioBuffer = await context.decodeAudioData(buffer.slice(0));
    return audioBufferToDecodeResult(audioBuffer, info);
}

/**
 * Fill duration / bitsPerSample from STREAMINFO where the decoder left them
 * out (the player otherwise shows 16-bit and 0:00).
 * @param {FlacDecodeResult} result
 * @param {FlacStreamInfo | null} info
 */
function withStreamInfo(result, info) {
    if (!info) {
        return result;
    }
    const next = { ...result };
    if (!(Number(next.bitDepth) > 0)) {
        next.bitDepth = info.bitsPerSample;
    }
    if (!(Number(next.bitsPerSample) > 0)) {
        next.bitsPerSample = next.bitDepth;
    }
    if (!(Number(next.duration) > 0) && info.duration > 0) {
        next.duration = info.duration;
    }
    return next;
}

/**
 * @typedef {typeof AudioWorkletNode & { __projectMChannelGuard?: boolean }} AudioWorkletNodeCtor
 */

/**
 * Wraps `windowRef.AudioWorkletNode` so every `outputChannelCount` entry is
 * clamped to what the engine accepts. Returns the undo.
 *
 * @param {{ AudioWorkletNode?: AudioWorkletNodeCtor }} [windowRef]
 * @returns {() => void}
 */
export function installAudioWorkletChannelGuard(windowRef = globalThis) {
    const Original = windowRef.AudioWorkletNode;
    if (typeof Original !== 'function' || Original.__projectMChannelGuard) {
        return () => {};
    }
    const NativeNode = Original;

    /**
     * @param {BaseAudioContext} context
     * @param {string} name
     * @param {AudioWorkletNodeOptions} [options]
     */
    function GuardedAudioWorkletNode(context, name, options) {
        const nextOptions = options ? { ...options } : options;
        if (nextOptions && Array.isArray(nextOptions.outputChannelCount)) {
            nextOptions.outputChannelCount = nextOptions.outputChannelCount.map(
                (/** @type {unknown} */ count) => clampAudioChannelCount(count)
            );
        }
        return new NativeNode(context, name, nextOptions);
    }

    GuardedAudioWorkletNode.prototype = Original.prototype;
    // Called with `new` (it returns the real node, which replaces the implicit
    // this), so it stands in for the constructor.
    const Guarded = /** @type {AudioWorkletNodeCtor} */ (/** @type {unknown} */ (GuardedAudioWorkletNode));
    Guarded.__projectMChannelGuard = true;
    windowRef.AudioWorkletNode = Guarded;

    return () => {
        if (windowRef.AudioWorkletNode === Guarded) {
            windowRef.AudioWorkletNode = Original;
        }
    };
}

/**
 * @typedef {object} WorkerDecodeGuardOptions
 * @property {(buffer: ArrayBuffer) => Promise<FlacDecodeResult>} [nativeDecode]
 *   The browser's own decoder. Defaults to {@link decodeWithWebAudio} when
 *   `windowRef` has an OfflineAudioContext.
 * @property {(message: string, detail?: unknown) => void} [log]
 */

/**
 * @typedef {object} PendingDecode
 * @property {ArrayBuffer} buffer What the worker was sent.
 * @property {boolean} nativeTried The native decoder already failed on it.
 */

/**
 * Replace `windowRef.Worker` with a subclass that guards the bundle's
 * `decode` requests:
 *
 *   - ID3v2 prefixes are stripped and STREAMINFO-coded frame headers are
 *     rewritten (see {@link normalizeFlacFrameHeaders}).
 *   - Ordinary streams go to the WASM worker first. An error, an empty
 *     result, or missing samples (the worker drops the decoder's error list,
 *     so failed frames just vanish) fall back to the native decoder.
 *   - Streams that needed their headers rewritten go to the native decoder
 *     first: the WASM decoder mishandles that encoder's output beyond the
 *     headers too (e.g. 16 of 3581 frames of "Claws of the Angel" still fail
 *     with LOST_SYNC after the rewrite), and each failure is logged from
 *     inside the worker. The rewritten stream is the fallback, which is also
 *     the only path where there is no native decoder (Node).
 *   - A decode nothing could recover becomes an `error` reply, so the player
 *     reports it instead of building a 0-channel AudioWorkletNode.
 *
 * @param {any} [windowRef]
 * @param {WorkerDecodeGuardOptions} [options]
 */
export function installWorkerFlacDecodeGuard(windowRef = globalThis, options = {}) {
    const WorkerCtor = windowRef.Worker;
    if (typeof WorkerCtor !== 'function' || WorkerCtor.__projectMFlacGuard) {
        return () => {};
    }
    const nativeDecode = options.nativeDecode
        || (typeof (windowRef.OfflineAudioContext || windowRef.webkitOfflineAudioContext) === 'function'
            ? (/** @type {ArrayBuffer} */ buffer) => decodeWithWebAudio(buffer, windowRef)
            : null);
    const log = options.log || ((message, detail) => console.warn(`[projectM FLAC player] ${message}`, detail ?? ''));

    /**
     * @param {ArrayBuffer} buffer
     * @returns {Promise<FlacDecodeResult>}
     */
    async function decodeNatively(buffer) {
        if (!nativeDecode) {
            throw new Error('no native decoder (OfflineAudioContext unavailable)');
        }
        const result = await nativeDecode(buffer);
        if (isEmptyDecodeResult(result)) {
            throw new Error('native decoder produced no audio');
        }
        return result;
    }

    /**
     * Turn the worker's reply to a guarded `decode` into the reply the
     * bundle sees.
     * @param {PendingDecode} pending
     * @param {any} data
     */
    async function recover({ buffer, nativeTried }, data) {
        const info = parseFlacStreamInfo(buffer);
        const wasmResult = data.type === 'error' ? null : data.result;
        const usable = Boolean(wasmResult) && !isEmptyDecodeResult(wasmResult);
        const errorCount = usable && Array.isArray(wasmResult.errors) ? wasmResult.errors.length : 0;
        const shortfall = usable ? decodeShortfall(wasmResult, info) : 0;
        if (usable && errorCount === 0 && shortfall === 0) {
            return { ...data, result: withStreamInfo(wasmResult, info) };
        }
        let reason = 'decoder produced no audio';
        if (data.type === 'error') {
            reason = `worker error: ${data.error}`;
        } else if (errorCount > 0) {
            reason = `${errorCount} decoder error(s)`;
        } else if (usable) {
            reason = `${shortfall} of ${info?.totalSamples} samples missing`;
        }
        /** @type {unknown} */
        let nativeError = new Error('native decoder already failed');
        if (!nativeTried) {
            try {
                log(`WASM FLAC decode failed (${reason}); falling back to Web Audio decodeAudioData`);
                const result = await decodeNatively(buffer);
                return { ...data, type: data.type === 'error' ? 'decoded' : data.type, result: withStreamInfo(result, info) };
            } catch (error) {
                log('native FLAC decode failed', error);
                nativeError = error;
            }
        }
        if (usable) {
            return { ...data, result: withStreamInfo(wasmResult, info) };
        }
        const message = /** @type {any} */ (nativeError)?.message || String(nativeError);
        return {
            id: data.id,
            type: 'error',
            error: `FLAC decode failed: ${reason}; native decoder: ${message}`,
        };
    }

    class GuardedWorker extends WorkerCtor {
        /** @param {any[]} args */
        constructor(...args) {
            super(...args);
            /** @type {Map<unknown, PendingDecode>} */
            this.__projectMDecodes = new Map();
            /** @type {((event: any) => void) | null} */
            this.__projectMOnMessage = null;
        }

        get onmessage() {
            return this.__projectMOnMessage;
        }

        set onmessage(handler) {
            this.__projectMOnMessage = handler;
            if (typeof handler !== 'function') {
                super.onmessage = handler;
                return;
            }
            super.onmessage = (/** @type {any} */ event) => {
                const data = event?.data;
                const pending = data ? this.__projectMDecodes.get(data.id) : undefined;
                if (!pending) {
                    handler.call(this, event);
                    return;
                }
                this.__projectMDecodes.delete(data.id);
                recover(pending, data).then(
                    (next) => this.__projectMReply(next),
                    (error) => {
                        // Never leave the player waiting: hand it the worker's
                        // own answer, as if the guard were not there.
                        log('decode recovery failed; passing the worker result through', error);
                        this.__projectMReply(data);
                    }
                );
            };
        }

        /** @param {any} data */
        __projectMReply(data) {
            this.__projectMOnMessage?.call(this, { data, target: this });
        }

        /**
         * @param {any} message
         * @param {any} [transfer]
         */
        postMessage(message, transfer) {
            if (!(message && message.type === 'decode' && message.data?.arrayBuffer)) {
                return super.postMessage(message, transfer);
            }
            const buffer = stripId3Prefix(message.data.arrayBuffer);
            const { framesRewritten } = normalizeFlacFrameHeaders(buffer);
            /** @param {boolean} nativeTried */
            const toWorker = (nativeTried) => {
                // Keep our own reference for the fallback: post a structured
                // clone instead of transferring it to the worker.
                this.__projectMDecodes.set(message.id, { buffer, nativeTried });
                super.postMessage({ ...message, data: { ...message.data, arrayBuffer: buffer } });
            };
            if (framesRewritten === 0 || !nativeDecode) {
                toWorker(false);
                return undefined;
            }
            log(`${framesRewritten} FLAC frame headers take rate/size from STREAMINFO; decoding with Web Audio first`);
            const info = parseFlacStreamInfo(buffer);
            decodeNatively(buffer).then(
                (result) => this.__projectMReply({ id: message.id, type: 'decoded', result: withStreamInfo(result, info) }),
                (error) => {
                    log('native FLAC decode failed; trying the WASM decoder with rewritten headers', error);
                    toWorker(true);
                }
            );
            return undefined;
        }
    }
    Object.defineProperty(GuardedWorker, '__projectMFlacGuard', { value: true });
    windowRef.Worker = GuardedWorker;

    return () => {
        if (windowRef.Worker === GuardedWorker) {
            windowRef.Worker = WorkerCtor;
        }
    };
}

/**
 * @param {any} [windowRef]
 * @param {WorkerDecodeGuardOptions} [options]
 */
export function installFlacPlayerDecodeGuard(windowRef = globalThis, options = {}) {
    const undoWorklet = installAudioWorkletChannelGuard(windowRef);
    const undoWorker = installWorkerFlacDecodeGuard(windowRef, options);
    return () => {
        undoWorker();
        undoWorklet();
    };
}
