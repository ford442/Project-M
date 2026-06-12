// Main-thread bridge for the opt-in OffscreenCanvas render worker
// (projectm-render-worker.js).
//
// Disabled by default. Enable with ?renderWorker=1 (or
// localStorage.renderWorker = '1'). When enabled but unsupported by the
// browser (no OffscreenCanvas/transferControlToOffscreen, or no Worker),
// setupRenderWorker() returns null and the caller should fall back to the
// existing main-thread render path unchanged.

const DEFAULT_PCM_RING_CAPACITY_PAIRS = 16384; // ~0.37s of audio at 44.1kHz stereo

export function isRenderWorkerEnabled({ search = location.search, storage = (() => {
    try { return window.localStorage; } catch (_) { return null; }
})() } = {}) {
    const params = new URLSearchParams(search);
    if (params.has('renderWorker')) {
        return params.get('renderWorker') === '1';
    }
    return !!storage && storage.getItem('renderWorker') === '1';
}

export function isRenderWorkerSupported(canvas) {
    return !!(
        canvas &&
        typeof canvas.transferControlToOffscreen === 'function' &&
        typeof Worker !== 'undefined' &&
        typeof OffscreenCanvas !== 'undefined'
    );
}

// Creates a SharedArrayBuffer-backed ring buffer for PCM data, if available.
// Requires cross-origin isolation (COOP/COEP) for SharedArrayBuffer; falls
// back to null (caller should use postMessage 'pcm' messages instead).
export function createPcmRing(capacityPairs = DEFAULT_PCM_RING_CAPACITY_PAIRS) {
    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
        return null;
    }

    const sab = new SharedArrayBuffer(4 + capacityPairs * 2 * 4);
    const header = new Int32Array(sab, 0, 1);
    const data = new Float32Array(sab, 4, capacityPairs * 2);
    let writeIndex = 0;

    return {
        sab,
        capacityPairs,
        write(buffer, channels) {
            let interleaved = buffer;
            let pairs;
            if (channels === 1) {
                pairs = buffer.length;
                interleaved = new Float32Array(pairs * 2);
                for (let i = 0; i < pairs; i++) {
                    interleaved[i * 2] = buffer[i];
                    interleaved[i * 2 + 1] = buffer[i];
                }
            } else {
                pairs = buffer.length / 2;
            }

            const start = writeIndex % capacityPairs;
            const firstPairs = Math.min(pairs, capacityPairs - start);
            data.set(interleaved.subarray(0, firstPairs * 2), start * 2);
            if (firstPairs < pairs) {
                data.set(interleaved.subarray(firstPairs * 2), 0);
            }

            writeIndex += pairs;
            Atomics.store(header, 0, writeIndex);
        }
    };
}

// Transfers `canvas` to a new render worker and starts the WASM module
// there. Returns null if unsupported (caller should fall back to the
// main-thread path). Otherwise returns a handle for the host to drive the
// worker (resize, PCM, generic ccall) and react to stats/errors.
export function setupRenderWorker({
    canvas,
    scriptSrc,
    width,
    height,
    targetFps,
    governor,
    meshQuality,
    onReady,
    onUnsupported,
    onError,
    onStats
} = {}) {
    if (!isRenderWorkerSupported(canvas)) {
        if (onUnsupported) onUnsupported('OffscreenCanvas/transferControlToOffscreen/Worker unavailable');
        return null;
    }

    let offscreen;
    try {
        offscreen = canvas.transferControlToOffscreen();
    } catch (error) {
        if (onUnsupported) onUnsupported(`transferControlToOffscreen failed: ${error}`);
        return null;
    }

    const pcmRing = createPcmRing();
    const worker = new Worker(new URL('./projectm-render-worker.js', import.meta.url));

    let nextRequestId = 1;
    const pendingCcalls = new Map();

    worker.onmessage = (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'ready':
                if (onReady) onReady();
                break;
            case 'unsupported':
                if (onUnsupported) onUnsupported(msg.reason);
                break;
            case 'error':
                if (onError) onError(msg.message);
                break;
            case 'stats':
                if (onStats) onStats(msg);
                break;
            case 'ccall-result': {
                const resolve = pendingCcalls.get(msg.requestId);
                if (resolve) {
                    pendingCcalls.delete(msg.requestId);
                    resolve(msg.result);
                }
                break;
            }
            default:
                break;
        }
    };

    worker.onerror = (event) => {
        if (onError) onError(event.message || String(event));
    };

    worker.postMessage({
        type: 'init',
        canvas: offscreen,
        scriptSrc,
        width,
        height,
        targetFps,
        governor,
        meshQuality,
        pcm: pcmRing ? { sab: pcmRing.sab, capacityPairs: pcmRing.capacityPairs } : null
    }, [offscreen]);

    return {
        worker,
        pcmRing,

        postResize(w, h) {
            worker.postMessage({ type: 'resize', width: w, height: h });
        },

        // Used only when pcmRing is unavailable (no cross-origin isolation).
        postPcm(buffer, channels) {
            worker.postMessage({ type: 'pcm', buffer, channels }, [buffer.buffer]);
        },

        ccall(name, returnType, argTypes, args) {
            return new Promise((resolve) => {
                const requestId = nextRequestId++;
                pendingCcalls.set(requestId, resolve);
                worker.postMessage({ type: 'ccall', name, returnType, argTypes, args, requestId });
            });
        },

        ccallVoid(name, argTypes, args) {
            worker.postMessage({ type: 'ccall', name, returnType: null, argTypes, args });
        }
    };
}
