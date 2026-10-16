// WasmPcmRing.cpp
//
// The single PCM ingest path into libprojectM on the web.
//
// One ring per engine (#246). Every export below operates on the active
// host's ring (PcmRingState in WasmHost.hpp), so two engines in one Module
// ingest independently: draining host A never consumes host B's writes. JS
// producers pick a host's ring by activating it before reading the descriptor
// (html/projectm-pcm-ring.js), or receive a descriptor tagged with the host
// handle (the AudioWorklet, see WasmAudioBridge.cpp).
//
// The ring lives in the WASM heap and is owned here, in C++. JavaScript
// producers (the AudioWorklet, external postMessage PCM, synthetic test
// feeds, the render-worker host) map a Float32Array/Int32Array view over
// `wasmMemory.buffer` at the offsets reported by the descriptor exports below
// and write into it at audio rate; the engine drains everything written since
// the last drain once per rendered frame and hands it to
// projectm_pcm_add_float() in one stereo call.
//
// This replaces the former analyser-poll path (js_feed_stream_data_to_projectm),
// which sampled the newest 576 mono samples per animation frame and therefore
// dropped roughly a quarter of the signal at 48 kHz, discarded one channel, and
// could only run on the main thread because it reached for `window`.
//
// Layout (all offsets in bytes, relative to the start of the WASM heap):
//
//   header  int32[4]  [0] write index, in frames, monotonically increasing
//                     [1] capacity in frames (informational, for JS asserts)
//                     [2] read index, in frames (published for diagnostics)
//                     [3] overrun count: drains that skipped past unread frames
//   data    float32[capacityFrames * 2]  interleaved stereo, L,R,L,R…
//
// The write index is the only cross-thread handshake. Producers publish it with
// Atomics.store() after their sample writes; this side reads it with a
// sequentially-consistent atomic load, so the samples a published index covers
// are guaranteed visible.
//
// Indices count frames and wrap at `capacityFrames * 1024` rather than growing
// without bound: a plain monotonic counter overflows int32 after ~12 hours of
// 48 kHz playback, which would turn a long-running visualizer session into a
// silent one. The modulus is a multiple of the capacity, so `index % capacity`
// still lands on the same storage slot either side of a wrap, and distances are
// computed modulo it.
#include "WasmHost.hpp"

#include <cstddef>
#include <cstdlib>

namespace {

// ~0.37 s of stereo audio at 44.1 kHz. Large enough that a stalled render loop
// (a 30 Hz frame, a preset compile) does not lose samples, small enough that a
// reader that falls behind resynchronises within a few frames.
constexpr int kDefaultCapacityFrames = 16384;

// Guards against a hostile/buggy capacity request allocating the heap away.
constexpr int kMaxCapacityFrames = 1 << 20;

constexpr int kHeaderWriteIndex = 0;
constexpr int kHeaderCapacity = 1;
constexpr int kHeaderReadIndex = 2;
constexpr int kHeaderOverruns = 3;
constexpr int kHeaderInts = 4;

// Frame-index modulus: large enough that a producer can never lap it between
// two drains, small enough to stay far below INT32_MAX for every capacity.
constexpr int kIndexWrapMultiple = 1024;

// Retired ring allocations.
//
// A ring's descriptor lives on in producers that hold views over it (the
// AudioWorklet in particular, which learns about a withdrawal only through an
// asynchronous port message). Freeing the storage the moment a host shuts its
// ring down would let one more quantum land in memory the allocator may already
// have handed to something else. Released rings are parked here instead and
// reused by the next PcmRingInit() of the same capacity, so a late write can at
// worst bleed a few milliseconds of audio into a new ring — never corrupt the
// heap. Bounded by kMaxHosts: the oldest entry is freed when a newer one needs
// the slot.
PcmRingStorage g_retiredRings[kMaxHosts];
int g_nextRetiredSlot = 0;

void RetireRing(PcmRingStorage storage)
{
    // Overwriting the slot frees the allocation parked there before.
    g_retiredRings[g_nextRetiredSlot] = std::move(storage);
    g_nextRetiredSlot = (g_nextRetiredSlot + 1) % kMaxHosts;
}

bool TakeRetiredRing(int capacityFrames, PcmRingStorage& storage)
{
    for (PcmRingStorage& slot : g_retiredRings)
    {
        if (slot.header && slot.capacityFrames == capacityFrames)
        {
            storage = std::move(slot);
            slot = PcmRingStorage{};
            return true;
        }
    }
    return false;
}

PcmRingStorage AllocateRing(int capacityFrames)
{
    PcmRingStorage storage;
    storage.header.reset(static_cast<int32_t*>(calloc(kHeaderInts, sizeof(int32_t))));
    storage.data.reset(static_cast<float*>(calloc(static_cast<size_t>(capacityFrames) * 2, sizeof(float))));
    if (!storage.header || !storage.data)
    {
        return PcmRingStorage{};
    }
    storage.capacityFrames = capacityFrames;
    return storage;
}

int32_t LoadWriteIndex(const PcmRingState& ring)
{
    return __atomic_load_n(&ring.Header()[kHeaderWriteIndex], __ATOMIC_SEQ_CST);
}

void PublishReadIndex(const PcmRingState& ring, int32_t value)
{
    __atomic_store_n(&ring.Header()[kHeaderReadIndex], value, __ATOMIC_SEQ_CST);
}

void BumpOverruns(const PcmRingState& ring)
{
    __atomic_fetch_add(&ring.Header()[kHeaderOverruns], 1, __ATOMIC_SEQ_CST);
}

} // namespace

int PcmRingInit(WasmHost& host, int capacityFrames)
{
    PcmRingState& ring = host.pcmRing;

    if (capacityFrames <= 0)
    {
        capacityFrames = kDefaultCapacityFrames;
    }
    if (capacityFrames > kMaxCapacityFrames)
    {
        capacityFrames = kMaxCapacityFrames;
    }

    if (ring.Header() != nullptr && ring.CapacityFrames() == capacityFrames)
    {
        return 1;
    }

    PcmRingShutdown(host);

    if (!TakeRetiredRing(capacityFrames, ring.storage))
    {
        ring.storage = AllocateRing(capacityFrames);
        if (!ring.storage.header)
        {
            LOG_ERROR(WasmLogFormat("pcm_ring_init: allocation failed for %d frames", capacityFrames));
            return 0;
        }
    }

    // A reused allocation carries its previous owner's indices; start clean.
    // Producers only publish after they have this ring's descriptor, and that
    // is posted below, after the reset.
    int32_t* const header = ring.Header();
    for (int i = 0; i < kHeaderInts; ++i)
    {
        __atomic_store_n(&header[i], 0, __ATOMIC_SEQ_CST);
    }

    ring.indexModulus = capacityFrames * kIndexWrapMultiple;
    ring.readIndex = 0;
    header[kHeaderCapacity] = capacityFrames;
    ring.drainScratch.assign(static_cast<size_t>(capacityFrames) * 2, 0.0f);

    PublishPcmRingToWorklet(HostHandle(host), reinterpret_cast<uintptr_t>(header),
                            reinterpret_cast<uintptr_t>(ring.Data()), capacityFrames,
                            ring.indexModulus);
    return 1;
}

void PcmRingShutdown(WasmHost& host)
{
    PcmRingState& ring = host.pcmRing;
    if (ring.Header() != nullptr)
    {
        WithdrawPcmRingFromWorklet(HostHandle(host));
        RetireRing(std::move(ring.storage));
    }
    ring.storage = PcmRingStorage{};
    ring.indexModulus = 0;
    ring.readIndex = 0;
    std::vector<float>().swap(ring.drainScratch);
}

int PcmRingDrain(WasmHost& host)
{
    PcmRingState& ring = host.pcmRing;
    const int capacityFrames = ring.CapacityFrames();
    if (ring.Header() == nullptr || capacityFrames <= 0)
    {
        return 0;
    }

    projectm_handle engine = host.appData.Engine();
    if (engine == nullptr)
    {
        return 0;
    }

    const int32_t writeIndex = LoadWriteIndex(ring);
    if (writeIndex < 0 || writeIndex >= ring.indexModulus)
    {
        // A producer published an index outside the agreed modulus; resynchronise
        // rather than indexing out of the ring.
        ring.readIndex = writeIndex % ring.indexModulus;
        if (ring.readIndex < 0)
        {
            ring.readIndex = 0;
        }
        PublishReadIndex(ring, ring.readIndex);
        return 0;
    }

    int available = (writeIndex - ring.readIndex + ring.indexModulus) % ring.indexModulus;
    if (available == 0)
    {
        return 0;
    }

    if (available > capacityFrames)
    {
        ring.readIndex = (writeIndex - capacityFrames + ring.indexModulus) % ring.indexModulus;
        available = capacityFrames;
        BumpOverruns(ring);
    }

    const float* const data = ring.Data();
    const int start = ring.readIndex % capacityFrames;
    const int firstFrames = std::min(available, capacityFrames - start);
    std::copy(data + static_cast<size_t>(start) * 2,
              data + static_cast<size_t>(start + firstFrames) * 2,
              ring.drainScratch.begin());
    if (firstFrames < available)
    {
        const int remaining = available - firstFrames;
        std::copy(data,
                  data + static_cast<size_t>(remaining) * 2,
                  ring.drainScratch.begin() + static_cast<std::ptrdiff_t>(firstFrames) * 2);
    }

    ring.readIndex = writeIndex;
    PublishReadIndex(ring, ring.readIndex);

    projectm_pcm_add_float(engine, ring.drainScratch.data(),
                           static_cast<unsigned int>(available), PROJECTM_STEREO);
    return available;
}

extern "C" {

// Allocates the active host's ring. Idempotent: a second call with the same
// capacity is a no-op so hosts can call it defensively before every producer
// hookup, and a call with a different capacity reallocates (dropping buffered
// audio, which is correct — the producers must remap their views anyway, and
// the worklet is sent the new descriptor).
EMSCRIPTEN_KEEPALIVE
int pcm_ring_init(int capacity_frames)
{
    return PcmRingInit(Host(), capacity_frames);
}

// Byte offset of the active host's int32 header within the WASM heap, or 0
// when uninitialized.
EMSCRIPTEN_KEEPALIVE
uintptr_t get_pcm_ring_header_ptr()
{
    return reinterpret_cast<uintptr_t>(Host().pcmRing.Header());
}

// Byte offset of the active host's interleaved float storage within the WASM heap.
EMSCRIPTEN_KEEPALIVE
uintptr_t get_pcm_ring_data_ptr()
{
    return reinterpret_cast<uintptr_t>(Host().pcmRing.Data());
}

// Modulus the frame indices wrap at. Producers must apply the same wrap when
// they publish the write index.
EMSCRIPTEN_KEEPALIVE
int get_pcm_ring_index_modulus()
{
    return Host().pcmRing.indexModulus;
}

EMSCRIPTEN_KEEPALIVE
int get_pcm_ring_capacity_frames()
{
    return Host().pcmRing.CapacityFrames();
}

// ---- Test hooks (PROJECTM_WASM_DEBUG_EXPORTS) -------------------------------

EMSCRIPTEN_KEEPALIVE
int debug_get_pcm_ring_write_index()
{
    const PcmRingState& ring = Host().pcmRing;
    return ring.Header() != nullptr ? LoadWriteIndex(ring) : 0;
}

EMSCRIPTEN_KEEPALIVE
int debug_get_pcm_ring_read_index()
{
    return Host().pcmRing.readIndex;
}

// Drains have skipped unread audio this many times since init. Non-zero means
// the render loop is not keeping up with the producers; the visualization stays
// in sync (it skips forward rather than tearing) but has lost samples.
EMSCRIPTEN_KEEPALIVE
int debug_get_pcm_ring_overruns()
{
    const PcmRingState& ring = Host().pcmRing;
    return ring.Header() != nullptr ? __atomic_load_n(&ring.Header()[kHeaderOverruns], __ATOMIC_SEQ_CST) : 0;
}

// What render_frame() does once per frame, callable on its own so a test can
// drain without rendering. Returns the number of frames fed.
EMSCRIPTEN_KEEPALIVE
int debug_pcm_ring_drain()
{
    return PcmRingDrain(Host());
}

} // extern "C"
