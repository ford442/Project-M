// Part of the render worker (html/projectm-render-worker.js), which loads it with
// importScripts() before it handles any message. A classic script: no imports, no
// top-level state of its own beyond the one factory it publishes on `self`.
//
// The PCM ring helpers: publish the module's ring to the host, write posted PCM
// into it, and read its counters for the stats message.

/**
 * @typedef {object} PcmRingDeps
 * @property {() => WorkerModule | null} getModule
 * @property {(message: RenderWorkerMessage) => void} postToHost
 */

/**
 * @param {PcmRingDeps} deps
 */
function createWorkerPcmRing(deps) {
    const { postToHost } = deps;

    /**
     * Reads the module's PCM ring descriptor. Mirrors readPcmRingDescriptor() in
     * html/projectm-pcm-ring.js — this is a classic worker (importScripts, no ES
     * module imports), so the few lines are duplicated rather than imported.
     *
     * @returns {PcmRingDescriptor | null}
     */
    function readPcmRingDescriptor() {
        const m = deps.getModule();
        if (!m || typeof m._get_pcm_ring_data_ptr !== 'function') return null;

        let dataPtr = m._get_pcm_ring_data_ptr();
        if (!dataPtr && typeof m._pcm_ring_init === 'function') {
            m._pcm_ring_init(0);
            dataPtr = m._get_pcm_ring_data_ptr();
        }
        const headerPtr = m._get_pcm_ring_header_ptr();
        const capacityFrames = m._get_pcm_ring_capacity_frames();
        const indexModulus = m._get_pcm_ring_index_modulus();
        const memory = m.HEAPF32?.buffer;
        if (!dataPtr || !headerPtr || capacityFrames <= 0 || indexModulus <= 0 || !memory) {
            return null;
        }
        return { memory, headerPtr, dataPtr, capacityFrames, indexModulus };
    }

    /**
     * Hands the host the ring descriptor, if the module's memory can cross the
     * postMessage boundary. Without cross-origin isolation it is a plain
     * ArrayBuffer, which cannot be shared, and the host keeps posting PCM instead.
     */
    function publishPcmRing() {
        const descriptor = readPcmRingDescriptor();
        if (!descriptor) return;
        if (typeof SharedArrayBuffer === 'undefined'
            || !(descriptor.memory instanceof SharedArrayBuffer)) {
            return;
        }
        postToHost({ type: 'pcm-ring', descriptor });
    }

    /**
     * Writes posted PCM into the module's ring. Mirrors createPcmRingWriter().write()
     * in html/projectm-pcm-ring.js, for the same no-imports reason.
     *
     * @param {Float32Array} buffer Interleaved stereo, or mono when channels is 1.
     * @param {number} channels
     */
    function writePcmToRing(buffer, channels) {
        const descriptor = readPcmRingDescriptor();
        if (!descriptor || !buffer || buffer.length === 0) return;

        const { memory, headerPtr, dataPtr, capacityFrames, indexModulus } = descriptor;
        const header = new Int32Array(memory, headerPtr, 4);
        const data = new Float32Array(memory, dataPtr, capacityFrames * 2);

        const stereo = channels === 2;
        let frames = stereo ? (buffer.length >> 1) : buffer.length;
        if (frames <= 0) return;

        let offset = 0;
        if (frames > capacityFrames) {
            offset = frames - capacityFrames;
            frames = capacityFrames;
        }

        const writeIndex = Atomics.load(header, 0);
        for (let i = 0; i < frames; i += 1) {
            const slot = ((writeIndex + i) % capacityFrames) * 2;
            const src = offset + i;
            if (stereo) {
                data[slot] = buffer[src * 2];
                data[slot + 1] = buffer[src * 2 + 1];
            } else {
                const sample = buffer[src];
                data[slot] = sample;
                data[slot + 1] = sample;
            }
        }
        Atomics.store(header, 0, (writeIndex + frames) % indexModulus);
    }

    /**
     * The ring header counters for the stats message. Mirrors readPcmRingCounters()
     * in html/projectm-pcm-ring.js.
     *
     * @returns {import('../projectm-render-worker-types.ts').PcmRingCounters | undefined}
     */
    function readPcmRingCounters() {
        const descriptor = readPcmRingDescriptor();
        if (!descriptor) return undefined;
        const header = new Int32Array(descriptor.memory, descriptor.headerPtr, 4);
        return {
            writeIndex: Atomics.load(header, 0),
            readIndex: Atomics.load(header, 2),
            overruns: Atomics.load(header, 3),
            capacityFrames: descriptor.capacityFrames,
            indexModulus: descriptor.indexModulus,
            sampledAt: performance.now(),
        };
    }

    return { publishPcmRing, writePcmToRing, readPcmRingCounters };
}

// `self` is the worker global in a real worker, but not in a bundler-wrapped or
// node:vm scope: publish on it explicitly so the entry script finds it.
self.createWorkerPcmRing = createWorkerPcmRing;
