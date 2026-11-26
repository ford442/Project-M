// GENERATED from projectm-pcm-ring.ts by scripts/build_html_ts.mjs — do not edit.
// Edit the .ts, then run `npm run build:html` (CI: npm run check:html-build).
import { claimGlobal } from './projectm-globals.js';
import { DEFAULT_HOST, bindModuleToHost } from './generated/projectm-wasm-api.js';
const RING_EXPORTS = [
    '_get_pcm_ring_data_ptr',
    '_get_pcm_ring_header_ptr',
    '_get_pcm_ring_capacity_frames',
    '_get_pcm_ring_index_modulus',
];
const writerCache = /* @__PURE__ */ new WeakMap();
function withHost(m, hostHandle, fn) {
    if (!hostHandle) {
        return fn(m);
    }
    if (typeof m._pm_host_is_live === 'function') {
        return fn(bindModuleToHost(m, hostHandle));
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
export function moduleHasPcmRing(module) {
    if (!module) return false;
    return RING_EXPORTS.every((name) => typeof module[name] === 'function');
}
export function readPcmRingDescriptor(module, hostHandle = DEFAULT_HOST) {
    if (!moduleHasPcmRing(module)) return null;
    const raw = withHost(module, hostHandle, (engine) => {
        let dataPtr2 = engine._get_pcm_ring_data_ptr();
        if (!dataPtr2 && typeof engine._pcm_ring_init === 'function') {
            engine._pcm_ring_init(0);
            dataPtr2 = engine._get_pcm_ring_data_ptr();
        }
        return {
            dataPtr: dataPtr2,
            headerPtr: engine._get_pcm_ring_header_ptr(),
            capacityFrames: engine._get_pcm_ring_capacity_frames(),
            indexModulus: engine._get_pcm_ring_index_modulus(),
        };
    });
    const { dataPtr, headerPtr, capacityFrames, indexModulus } = raw;
    if (!dataPtr || !headerPtr || capacityFrames <= 0 || indexModulus <= 0) {
        return null;
    }
    const memory = module.HEAPF32?.buffer || module.wasmMemory?.buffer || globalThis.wasmMemory?.buffer;
    if (!memory) return null;
    return { memory, headerPtr, dataPtr, capacityFrames, indexModulus };
}
export function createPcmRingWriter(descriptor) {
    const { memory, headerPtr, dataPtr, capacityFrames, indexModulus } = descriptor;
    const header = new Int32Array(memory, headerPtr, 4);
    const data = new Float32Array(memory, dataPtr, capacityFrames * 2);
    function write(buffer, channels = 2) {
        if (!buffer || buffer.length === 0) return 0;
        const stereo = channels === 2;
        let frames = stereo ? buffer.length >> 1 : buffer.length;
        if (frames <= 0) return 0;
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
        return frames;
    }
    return {
        write,
        writeIndex: () => Atomics.load(header, 0),
        capacityFrames,
        descriptor,
    };
}
export function readPcmRingCounters(descriptor) {
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
export function getPcmRingWriter(module, hostHandle = DEFAULT_HOST) {
    if (!module) return null;
    const descriptor = readPcmRingDescriptor(module, hostHandle);
    if (!descriptor) return null;
    let perHost = writerCache.get(module);
    if (!perHost) {
        perHost = /* @__PURE__ */ new Map();
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
export function feedPcmThroughRing(module, buffer, { channels = 2, fallback = null, hostHandle = DEFAULT_HOST } = {}) {
    const writer = getPcmRingWriter(module, hostHandle);
    if (writer) {
        return writer.write(buffer, channels) > 0;
    }
    return fallback ? fallback() : false;
}
export function feedPcm(target, frames, { channels = 2, scratch = null } = {}) {
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
        if (!ptr) return false;
    }
    try {
        module.HEAPF32?.set(frames, ptr >> 2);
        addFloat.call(module, host, ptr, samplesPerChannel, normalizedChannels);
        return true;
    } finally {
        if (!useScratch && typeof module._free === 'function') {
            module._free(ptr);
        }
    }
}
const hostRingWriterClaims = /* @__PURE__ */ new WeakMap();
export function installHostPcmRingWriter(module) {
    if (!module || !moduleHasPcmRing(module)) return null;
    const existing = hostRingWriterClaims.get(module);
    if (existing && globalThis.projectMWritePcmRing === existing.write) {
        return existing.release;
    }
    existing?.release();
    const write = (buffer, channels = 2) => {
        const writer = getPcmRingWriter(module);
        if (writer) writer.write(buffer, channels);
    };
    const releaseClaim = claimGlobal(globalThis, 'projectMWritePcmRing', write);
    const release = () => {
        if (hostRingWriterClaims.get(module)?.release === release) hostRingWriterClaims.delete(module);
        releaseClaim();
    };
    hostRingWriterClaims.set(module, { write, release });
    return release;
}
