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

import { claimGlobal } from './projectm-globals.js';
import { DEFAULT_HOST, bindModuleToHost } from './generated/projectm-wasm-api.js';
import type { HostHandle, ProjectMModule } from './generated/projectm-wasm-api.js';
import type { ProjectMModuleLike } from '@projectm/types/host';
import type { PcmRingCounters } from '@projectm/types/render-worker';

export interface PcmRingDescriptor {
    /** The WASM heap backing the ring. */
    memory: ArrayBufferLike;
    /** Byte offset of the int32 header. */
    headerPtr: number;
    /** Byte offset of the float storage. */
    dataPtr: number;
    capacityFrames: number;
    indexModulus: number;
}

export interface PcmRingWriter {
    /**
     * Writes interleaved (or mono) PCM into the ring and publishes the new write
     * index. Returns the number of frames written.
     */
    write(buffer: Float32Array, channels?: number): number;
    writeIndex(): number;
    capacityFrames: number;
    descriptor: PcmRingDescriptor;
}

/** The engine a PCM chunk is for. */
export interface PcmTarget {
    module: ProjectMModuleLike | null | undefined;
    /**
     * create_host*()'s handle; DEFAULT_HOST (0) or absent is the module's active
     * host, the single-engine default.
     */
    host?: HostHandle | undefined;
}

/**
 * A preallocated heap block the marshaling fallback may reuse instead of a
 * malloc/free per chunk. The caller owns it.
 */
export interface PcmScratch {
    /** Byte offset in the module heap. */
    ptr: number;
    /** Floats it holds. */
    capacity: number;
}

/** The ring exports a module must have for moduleHasPcmRing(). */
type RingModule = ProjectMModuleLike &
    Required<
        Pick<
            ProjectMModule,
            | '_get_pcm_ring_data_ptr'
            | '_get_pcm_ring_header_ptr'
            | '_get_pcm_ring_capacity_frames'
            | '_get_pcm_ring_index_modulus'
        >
    >;

const RING_EXPORTS = [
    '_get_pcm_ring_data_ptr',
    '_get_pcm_ring_header_ptr',
    '_get_pcm_ring_capacity_frames',
    '_get_pcm_ring_index_modulus',
] as const;

/**
 * Ring writers already built, keyed by module instance, then by host handle
 * (DEFAULT_HOST = whichever host is active, the single-instance default).
 */
const writerCache = new WeakMap<object, Map<HostHandle, PcmRingWriter>>();

/**
 * Runs `fn` with the module as seen by `hostHandle`'s engine. On an ABI v2
 * bundle (#352) that is the bound view (bindModuleToHost()), whose ring calls
 * name the host and activate nothing. An older bundle has `hostHandle` made
 * the active host for the call, and the previous one restored. A handle of 0,
 * or a module without the multi-instance exports, runs `fn` on the module
 * itself: whatever host is active.
 */
function withHost<T>(m: RingModule, hostHandle: HostHandle, fn: (engine: RingModule) => T): T {
    if (!hostHandle) {
        return fn(m);
    }
    if (typeof m._pm_host_is_live === 'function') {
        return fn(bindModuleToHost(m as RingModule & ProjectMModule, hostHandle));
    }
    const ccall = m.ccall;
    if (typeof m._get_active_host !== 'function' || typeof ccall !== 'function') {
        return fn(m);
    }
    const previous = m._get_active_host();
    if (previous === hostHandle) {
        return fn(m);
    }
    ccall.call(m, 'set_active_host', null, ['number'], [hostHandle]);
    try {
        return fn(m);
    } finally {
        if (previous) {
            ccall.call(m, 'set_active_host', null, ['number'], [previous]);
        }
    }
}

/**
 * Whether `module` exposes the WASM-owned PCM ring. Older bundles (and the test
 * doubles that stand in for them) do not, and callers fall back to the direct
 * `projectm_pcm_add_float` marshaling path.
 */
export function moduleHasPcmRing(module: ProjectMModuleLike | null | undefined): module is RingModule {
    if (!module) return false;
    return RING_EXPORTS.every((name) => typeof module[name] === 'function');
}

/**
 * Reads the ring descriptor out of a module, allocating the ring first if the
 * engine has not done so yet (`_pcm_ring_init` is idempotent).
 *
 * @param hostHandle Engine whose ring to read (create_host() handle);
 *   DEFAULT_HOST reads the active host's ring.
 * @returns null when the module has no ring, or the ring is not allocated and
 *   cannot be.
 */
export function readPcmRingDescriptor(
    module: ProjectMModuleLike | null | undefined,
    hostHandle: HostHandle = DEFAULT_HOST
): PcmRingDescriptor | null {
    if (!moduleHasPcmRing(module)) return null;

    const raw = withHost(module, hostHandle, (engine) => {
        let dataPtr = engine._get_pcm_ring_data_ptr();
        if (!dataPtr && typeof engine._pcm_ring_init === 'function') {
            engine._pcm_ring_init(0);
            dataPtr = engine._get_pcm_ring_data_ptr();
        }
        return {
            dataPtr,
            headerPtr: engine._get_pcm_ring_header_ptr(),
            capacityFrames: engine._get_pcm_ring_capacity_frames(),
            indexModulus: engine._get_pcm_ring_index_modulus(),
        };
    });
    const { dataPtr, headerPtr, capacityFrames, indexModulus } = raw;
    if (!dataPtr || !headerPtr || capacityFrames <= 0 || indexModulus <= 0) {
        return null;
    }

    // HEAPF32 is re-created on memory growth, so read the live buffer rather
    // than caching one from an earlier call.
    const memory = module.HEAPF32?.buffer || module.wasmMemory?.buffer || globalThis.wasmMemory?.buffer;
    if (!memory) return null;

    return { memory, headerPtr, dataPtr, capacityFrames, indexModulus };
}

/**
 * Builds a writer over an existing ring descriptor. Used directly by the
 * AudioWorklet and the render-worker host, which receive a descriptor over
 * postMessage and cannot call into WASM themselves.
 */
export function createPcmRingWriter(descriptor: PcmRingDescriptor): PcmRingWriter {
    const { memory, headerPtr, dataPtr, capacityFrames, indexModulus } = descriptor;
    const header = new Int32Array(memory, headerPtr, 4);
    const data = new Float32Array(memory, dataPtr, capacityFrames * 2);

    /**
     * @param buffer Interleaved stereo, or mono when channels is 1.
     * @returns frames written
     */
    function write(buffer: Float32Array, channels = 2): number {
        if (!buffer || buffer.length === 0) return 0;
        const stereo = channels === 2;
        let frames = stereo ? buffer.length >> 1 : buffer.length;
        if (frames <= 0) return 0;

        // A single write larger than the ring can only leave the newest
        // `capacityFrames` behind anyway; drop the excess up front so the loop
        // does not overwrite its own output.
        let offset = 0;
        if (frames > capacityFrames) {
            offset = frames - capacityFrames;
            frames = capacityFrames;
        }

        // Every index below is in bounds: `slot` is under capacityFrames * 2 and
        // `src` under the frame count `buffer` was measured to hold.
        const writeIndex = Atomics.load(header, 0);
        for (let i = 0; i < frames; i += 1) {
            const slot = ((writeIndex + i) % capacityFrames) * 2;
            const src = offset + i;
            if (stereo) {
                data[slot] = buffer[src * 2]!;
                data[slot + 1] = buffer[src * 2 + 1]!;
            } else {
                const sample = buffer[src]!;
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
 * Reads the ring header counters. `readIndex` is published by the engine on
 * every drain, so its rate is the PCM the engine actually consumed.
 */
export function readPcmRingCounters(descriptor: PcmRingDescriptor | null | undefined): PcmRingCounters | null {
    if (!descriptor) return null;
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

/**
 * The writer for `module`'s ring, cached per module and host handle. Re-derived
 * when the WASM heap has grown (which detaches the old views) or the ring was
 * reallocated (or, for DEFAULT_HOST, a different host became active).
 *
 * @param hostHandle Engine to write to (create_host() handle); DEFAULT_HOST
 *   writes to the active host.
 */
export function getPcmRingWriter(
    module: ProjectMModuleLike | null | undefined,
    hostHandle: HostHandle = DEFAULT_HOST
): PcmRingWriter | null {
    if (!module) return null;
    const descriptor = readPcmRingDescriptor(module, hostHandle);
    if (!descriptor) return null;

    let perHost = writerCache.get(module);
    if (!perHost) {
        perHost = new Map();
        writerCache.set(module, perHost);
    }
    const cached = perHost.get(hostHandle);
    if (
        cached &&
        cached.descriptor.memory === descriptor.memory &&
        cached.descriptor.dataPtr === descriptor.dataPtr &&
        cached.descriptor.capacityFrames === descriptor.capacityFrames
    ) {
        return cached;
    }

    const writer = createPcmRingWriter(descriptor);
    perHost.set(hostHandle, writer);
    return writer;
}

export interface FeedPcmThroughRingOptions {
    channels?: number;
    /**
     * Invoked when there is no ring; should feed the engine directly and report
     * whether it did.
     */
    fallback?: (() => boolean) | null;
    /** Engine to feed (create_host() handle); DEFAULT_HOST feeds the active host. */
    hostHandle?: HostHandle;
}

/**
 * Feeds PCM to the engine: into the ring when the module has one, otherwise
 * through the direct marshaling fallback the caller supplies.
 *
 * The fallback exists for bundles built before the ring landed and for hosts
 * with no cross-origin isolation where a module cannot expose it; it is a
 * transport shim behind this one interface, not a second ingest design.
 *
 * @param buffer Interleaved PCM (mono when channels is 1).
 * @returns true when the audio reached the engine.
 */
export function feedPcmThroughRing(
    module: ProjectMModuleLike | null | undefined,
    buffer: Float32Array,
    { channels = 2, fallback = null, hostHandle = DEFAULT_HOST }: FeedPcmThroughRingOptions = {}
): boolean {
    const writer = getPcmRingWriter(module, hostHandle);
    if (writer) {
        return writer.write(buffer, channels) > 0;
    }
    return fallback ? fallback() : false;
}

export interface FeedPcmOptions {
    channels?: number;
    scratch?: PcmScratch | null;
}

/**
 * Hands interleaved PCM to one engine. The only place the host layer calls
 * `_projectm_pcm_add_float_wrapper`: every main-thread producer (external PCM,
 * the synthetic test feed, the main-thread transport) comes through here, so
 * which engine a chunk reaches is decided once, from `target.host`, instead of
 * each producer hand-rolling malloc -> HEAPF32.set -> wrapper(0, ...) and
 * feeding whichever engine is active.
 *
 * Writes into the engine's PCM ring when the bundle has one. Bundles from
 * before the ring get the marshaling fallback, with the host handle passed to
 * the wrapper (which resolves it to that engine; 0 is the active one).
 *
 * @param frames Interleaved stereo, or mono when `channels` is 1.
 * @returns true when the chunk reached the engine.
 */
export function feedPcm(
    target: PcmTarget,
    frames: Float32Array,
    { channels = 2, scratch = null }: FeedPcmOptions = {}
): boolean {
    const module = target?.module;
    if (!module || !frames || frames.length === 0) return false;
    const host = target.host || DEFAULT_HOST;
    const normalizedChannels = channels === 1 ? 1 : 2;

    const writer = getPcmRingWriter(module, host);
    if (writer) {
        return writer.write(frames, normalizedChannels) > 0;
    }

    const addFloat = module._projectm_pcm_add_float_wrapper;
    if (typeof addFloat !== 'function' || !module.HEAPF32) {
        return false;
    }
    const samplesPerChannel = Math.floor(frames.length / normalizedChannels);
    if (samplesPerChannel <= 0) return false;

    const useScratch = !!scratch && scratch.ptr > 0 && frames.length <= scratch.capacity;
    let ptr = useScratch && scratch ? scratch.ptr : 0;
    if (!ptr) {
        if (typeof module._malloc !== 'function') return false;
        ptr = module._malloc(frames.length * 4);
        // 0 is malloc's failure value, never a usable block.
        if (!ptr) return false;
    }
    try {
        // Read after the malloc: growing the heap replaces HEAPF32.
        module.HEAPF32?.set(frames, ptr >> 2);
        addFloat.call(module, host, ptr, samplesPerChannel, normalizedChannels);
        return true;
    } finally {
        if (!useScratch && typeof module._free === 'function') {
            module._free(ptr);
        }
    }
}

/** What installHostPcmRingWriter() put in the global slot for one module. */
interface HostRingWriterClaim {
    write: (buffer: Float32Array, channels?: number) => void;
    release: () => void;
}

const hostRingWriterClaims = new WeakMap<object, HostRingWriterClaim>();

/**
 * Installs `globalThis.projectMWritePcmRing`, the writer the baked EM_JS worklet
 * handler prefers over its own inline copy (see
 * `js_install_worklet_pcm_handler` in src/wasm/WasmAudioBridge.cpp). Hosts that
 * load this module get one implementation of the write; hosts that do not still
 * work, one copy of the logic later.
 *
 * The slot is claimed through claimGlobal(), once per module: installing again
 * for the module whose writer is already visible returns the same release, so
 * a worklet that re-attaches does not stack claims.
 *
 * @returns Releases the claim; null when the module has no ring (nothing was
 *   installed).
 */
export function installHostPcmRingWriter(module: ProjectMModuleLike | null | undefined): (() => void) | null {
    if (!module || !moduleHasPcmRing(module)) return null;
    const existing = hostRingWriterClaims.get(module);
    if (existing && (globalThis as { projectMWritePcmRing?: unknown }).projectMWritePcmRing === existing.write) {
        return existing.release;
    }
    existing?.release();

    const write = (buffer: Float32Array, channels = 2): void => {
        const writer = getPcmRingWriter(module);
        if (writer) writer.write(buffer, channels);
    };
    const releaseClaim = claimGlobal(globalThis, 'projectMWritePcmRing', write);
    const release = (): void => {
        if (hostRingWriterClaims.get(module)?.release === release) hostRingWriterClaims.delete(module);
        releaseClaim();
    };
    hostRingWriterClaims.set(module, { write, release });
    return release;
}
