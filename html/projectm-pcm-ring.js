// The one PCM ingest path into libprojectM from the browser host layer.
//
// The ring itself is allocated and owned by C++ (src/wasm/WasmPcmRing.cpp) in
// the WASM heap. This module maps views over it and gives every JS producer —
// the AudioWorklet, external postMessage PCM, synthetic test feeds, the render
// worker host — the same `write()`.
//
// Why the ring rather than a per-chunk `_malloc` + `projectm_pcm_add_float`:
//
//   * Producers write at audio rate. Nothing is sampled or decimated to fit an
//     animation frame, so a dropped frame delays the audio by one frame instead
//     of throwing a frame's worth of samples away.
//   * The engine drains on its own clock, in render_frame(), and gets every
//     sample written since the last frame in one call.
//   * It is stereo end to end. Mono producers are duplicated to both channels
//     here, at the boundary, rather than the engine being told the signal is
//     mono and losing the separation for stereo sources.
//   * There is exactly one buffer with one owner, allocated once. The previous
//     design malloc'd a 2048-float scratch from three places (two of them inside
//     EM_JS) into two different globals and never freed any of them.
//
// Layout, mirroring the C++ side:
//
//   header  Int32Array(4)  [0] write index (frames)  [1] capacity (frames)
//                          [2] read index (frames)   [3] overrun count
//   data    Float32Array(capacityFrames * 2)  interleaved stereo
//
// Frame indices wrap at `indexModulus` (a multiple of the capacity) rather than
// growing forever, so neither side overflows int32 during a long session.
//
// One ring per engine (#246). In a Module running several engines
// (create_host()), the descriptor exports report the *active* host's ring. Pass
// `hostHandle` to read / write a specific engine's ring: the host is activated
// for the synchronous descriptor read and the previous selection restored.

/**
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 */

/**
 * @typedef {object} PcmRingDescriptor
 * @property {ArrayBufferLike} memory The WASM heap backing the ring.
 * @property {number} headerPtr Byte offset of the int32 header.
 * @property {number} dataPtr Byte offset of the float storage.
 * @property {number} capacityFrames
 * @property {number} indexModulus
 */

/**
 * @typedef {object} PcmRingWriter
 * @property {(buffer: Float32Array, channels?: number) => number} write
 *   Writes interleaved (or mono) PCM into the ring and publishes the new write
 *   index. Returns the number of frames written.
 * @property {() => number} writeIndex
 * @property {number} capacityFrames
 * @property {PcmRingDescriptor} descriptor
 */

const RING_EXPORTS = [
    '_get_pcm_ring_data_ptr',
    '_get_pcm_ring_header_ptr',
    '_get_pcm_ring_capacity_frames',
    '_get_pcm_ring_index_modulus',
];

/**
 * Ring writers already built, keyed by module instance, then by host handle
 * (0 = whichever host is active, the single-instance default).
 * @type {WeakMap<object, Map<number, PcmRingWriter>>}
 */
const writerCache = new WeakMap();

/**
 * Runs `fn` with `hostHandle` as the module's active host, restoring the
 * previous selection. A handle of 0, or a module without the multi-instance
 * exports, runs `fn` against whatever host is active.
 *
 * @template T
 * @param {any} m
 * @param {number} hostHandle
 * @param {() => T} fn
 * @returns {T}
 */
function withActiveHost(m, hostHandle, fn) {
    if (!hostHandle || typeof m._get_active_host !== 'function' || typeof m.ccall !== 'function') {
        return fn();
    }
    const previous = m._get_active_host();
    if (previous === hostHandle) {
        return fn();
    }
    m.ccall('set_active_host', null, ['number'], [hostHandle]);
    try {
        return fn();
    } finally {
        if (previous) {
            m.ccall('set_active_host', null, ['number'], [previous]);
        }
    }
}

/**
 * Whether `module` exposes the WASM-owned PCM ring. Older bundles (and the test
 * doubles that stand in for them) do not, and callers fall back to the direct
 * `projectm_pcm_add_float` marshaling path.
 *
 * @param {ProjectMModuleLike | null | undefined} module
 * @returns {boolean}
 */
export function moduleHasPcmRing(module) {
    if (!module) return false;
    return RING_EXPORTS.every((name) => typeof (/** @type {any} */ (module))[name] === 'function');
}

/**
 * Reads the ring descriptor out of a module, allocating the ring first if the
 * engine has not done so yet (`_pcm_ring_init` is idempotent).
 *
 * @param {ProjectMModuleLike | null | undefined} module
 * @param {number} [hostHandle] Engine whose ring to read (create_host() handle);
 *   0 reads the active host's ring.
 * @returns {PcmRingDescriptor | null} null when the module has no ring, or the
 *   ring is not allocated and cannot be.
 */
export function readPcmRingDescriptor(module, hostHandle = 0) {
    if (!moduleHasPcmRing(module)) return null;
    const m = /** @type {any} */ (module);

    const raw = withActiveHost(m, hostHandle, () => {
        let dataPtr = m._get_pcm_ring_data_ptr();
        if (!dataPtr && typeof m._pcm_ring_init === 'function') {
            m._pcm_ring_init(0);
            dataPtr = m._get_pcm_ring_data_ptr();
        }
        return {
            dataPtr,
            headerPtr: m._get_pcm_ring_header_ptr(),
            capacityFrames: m._get_pcm_ring_capacity_frames(),
            indexModulus: m._get_pcm_ring_index_modulus(),
        };
    });
    const { dataPtr, headerPtr, capacityFrames, indexModulus } = raw;
    if (!dataPtr || !headerPtr || capacityFrames <= 0 || indexModulus <= 0) {
        return null;
    }

    // HEAPF32 is re-created on memory growth, so read the live buffer rather
    // than caching one from an earlier call.
    const memory = m.HEAPF32?.buffer || m.wasmMemory?.buffer || globalThis.wasmMemory?.buffer;
    if (!memory) return null;

    return { memory, headerPtr, dataPtr, capacityFrames, indexModulus };
}

/**
 * Builds a writer over an existing ring descriptor. Used directly by the
 * AudioWorklet and the render-worker host, which receive a descriptor over
 * postMessage and cannot call into WASM themselves.
 *
 * @param {PcmRingDescriptor} descriptor
 * @returns {PcmRingWriter}
 */
export function createPcmRingWriter(descriptor) {
    const { memory, headerPtr, dataPtr, capacityFrames, indexModulus } = descriptor;
    const header = new Int32Array(memory, headerPtr, 4);
    const data = new Float32Array(memory, dataPtr, capacityFrames * 2);

    /**
     * @param {Float32Array} buffer Interleaved stereo, or mono when channels is 1.
     * @param {number} [channels]
     * @returns {number} frames written
     */
    function write(buffer, channels = 2) {
        if (!buffer || buffer.length === 0) return 0;
        const stereo = channels === 2;
        let frames = stereo ? (buffer.length >> 1) : buffer.length;
        if (frames <= 0) return 0;

        // A single write larger than the ring can only leave the newest
        // `capacityFrames` behind anyway; drop the excess up front so the loop
        // does not overwrite its own output.
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

        // Publish last: the drain reads samples only up to the index it sees, so
        // the store is what makes this block visible, and it must not be
        // reordered ahead of the writes above.
        Atomics.store(header, 0, (writeIndex + frames) % indexModulus);
        return frames;
    }

    return {
        write,
        writeIndex: () => Atomics.load(header, 0),
        capacityFrames,
        descriptor,
    };
}

/**
 * The writer for `module`'s ring, cached per module and host handle. Re-derived
 * when the WASM heap has grown (which detaches the old views) or the ring was
 * reallocated (or, for handle 0, a different host became active).
 *
 * @param {ProjectMModuleLike | null | undefined} module
 * @param {number} [hostHandle] Engine to write to (create_host() handle); 0
 *   writes to the active host.
 * @returns {PcmRingWriter | null}
 */
export function getPcmRingWriter(module, hostHandle = 0) {
    if (!module) return null;
    const descriptor = readPcmRingDescriptor(module, hostHandle);
    if (!descriptor) return null;

    let perHost = writerCache.get(module);
    if (!perHost) {
        perHost = new Map();
        writerCache.set(module, perHost);
    }
    const cached = perHost.get(hostHandle);
    if (cached
        && cached.descriptor.memory === descriptor.memory
        && cached.descriptor.dataPtr === descriptor.dataPtr
        && cached.descriptor.capacityFrames === descriptor.capacityFrames) {
        return cached;
    }

    const writer = createPcmRingWriter(descriptor);
    perHost.set(hostHandle, writer);
    return writer;
}

/**
 * Feeds PCM to the engine: into the ring when the module has one, otherwise
 * through the direct marshaling fallback the caller supplies.
 *
 * The fallback exists for bundles built before the ring landed and for hosts
 * with no cross-origin isolation where a module cannot expose it; it is a
 * transport shim behind this one interface, not a second ingest design.
 *
 * @param {ProjectMModuleLike | null | undefined} module
 * @param {Float32Array} buffer Interleaved PCM (mono when channels is 1).
 * @param {object} [options]
 * @param {number} [options.channels]
 * @param {(() => boolean) | null} [options.fallback] Invoked when there is no
 *   ring; should feed the engine directly and report whether it did.
 * @param {number} [options.hostHandle] Engine to feed (create_host() handle);
 *   0 feeds the active host.
 * @returns {boolean} true when the audio reached the engine.
 */
export function feedPcmThroughRing(module, buffer, { channels = 2, fallback = null, hostHandle = 0 } = {}) {
    const writer = getPcmRingWriter(module, hostHandle);
    if (writer) {
        return writer.write(buffer, channels) > 0;
    }
    return fallback ? fallback() : false;
}

/**
 * Installs `globalThis.projectMWritePcmRing`, the writer the baked EM_JS worklet
 * handler prefers over its own inline copy (see
 * `js_install_worklet_pcm_handler` in src/wasm/WasmAudioBridge.cpp). Hosts that
 * load this module get one implementation of the write; hosts that do not still
 * work, one copy of the logic later.
 *
 * @param {ProjectMModuleLike | null | undefined} module
 * @returns {boolean} true when a writer was installed.
 */
export function installHostPcmRingWriter(module) {
    if (!moduleHasPcmRing(module)) return false;
    /** @type {any} */ (globalThis).projectMWritePcmRing =
    /** @param {Float32Array} buffer @param {number} [channels] */
    (buffer, channels = 2) => {
        const writer = getPcmRingWriter(module);
        if (writer) writer.write(buffer, channels);
    };
    return true;
}
