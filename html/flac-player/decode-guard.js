// Hardening for the vendored FLAC player bundle (wasm-audio-decoders).
//
// Local / library files fail in two ways:
//   1. ID3-tagged or non-fLaC payloads go to the WASM decoder → LOST_SYNC
//      and a 0-channel "success" result
//   2. AudioWorkletNode(outputChannelCount: [0]) then throws NotSupportedError
//
// These patches run before the bundle and do not require rebuilding it.

const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43]; // fLaC

/**
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
export function isFlacMagic(buffer) {
    if (!buffer || buffer.byteLength < 4) {
        return false;
    }
    const bytes = new Uint8Array(buffer, 0, 4);
    return FLAC_MAGIC.every((value, index) => bytes[index] === value);
}

/**
 * Strip a leading ID3v2 tag so the WASM FLAC decoder sees `fLaC`.
 * @param {ArrayBuffer} buffer
 * @returns {ArrayBuffer}
 */
export function stripId3Prefix(buffer) {
    if (!buffer || buffer.byteLength < 10) {
        return buffer;
    }
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
        return buffer;
    }
    const size = ((bytes[6] & 0x7f) << 21)
        | ((bytes[7] & 0x7f) << 14)
        | ((bytes[8] & 0x7f) << 7)
        | (bytes[9] & 0x7f);
    const start = 10 + size;
    if (start <= 10 || start >= bytes.length) {
        return buffer;
    }
    return buffer.slice(start);
}

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

export function installAudioWorkletChannelGuard(windowRef = globalThis) {
    const Original = windowRef.AudioWorkletNode;
    if (typeof Original !== 'function' || Original.__projectMChannelGuard) {
        return () => {};
    }

    function GuardedAudioWorkletNode(context, name, options) {
        const nextOptions = options ? { ...options } : options;
        if (nextOptions && Array.isArray(nextOptions.outputChannelCount)) {
            nextOptions.outputChannelCount = nextOptions.outputChannelCount.map(
                (count) => clampAudioChannelCount(count)
            );
        }
        return new Original(context, name, nextOptions);
    }

    GuardedAudioWorkletNode.prototype = Original.prototype;
    GuardedAudioWorkletNode.__projectMChannelGuard = true;
    windowRef.AudioWorkletNode = GuardedAudioWorkletNode;

    return () => {
        if (windowRef.AudioWorkletNode === GuardedAudioWorkletNode) {
            windowRef.AudioWorkletNode = Original;
        }
    };
}

export function installWorkerFlacDecodeGuard(windowRef = globalThis) {
    const WorkerCtor = windowRef.Worker;
    if (typeof WorkerCtor !== 'function' || WorkerCtor.prototype.__projectMFlacGuard) {
        return () => {};
    }

    const originalPost = WorkerCtor.prototype.postMessage;
    WorkerCtor.prototype.postMessage = function projectMGuardedPostMessage(message, transfer) {
        if (message && message.type === 'decode' && message.data?.arrayBuffer) {
            const stripped = stripId3Prefix(message.data.arrayBuffer);
            if (stripped !== message.data.arrayBuffer) {
                message = {
                    ...message,
                    data: { ...message.data, arrayBuffer: stripped },
                };
                transfer = [stripped];
            }
        }
        return originalPost.call(this, message, transfer);
    };
    WorkerCtor.prototype.__projectMFlacGuard = true;

    return () => {
        if (WorkerCtor.prototype.postMessage !== originalPost) {
            WorkerCtor.prototype.postMessage = originalPost;
            delete WorkerCtor.prototype.__projectMFlacGuard;
        }
    };
}

export function installFlacPlayerDecodeGuard(windowRef = globalThis) {
    const undoWorklet = installAudioWorkletChannelGuard(windowRef);
    const undoWorker = installWorkerFlacDecodeGuard(windowRef);
    return () => {
        undoWorker();
        undoWorklet();
    };
}
