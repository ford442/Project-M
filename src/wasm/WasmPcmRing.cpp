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
// reused by the next pcm_ring_init() of the same capacity, so a late write can
// at worst bleed a few milliseconds of audio into a new ring — never corrupt
// the heap. Bounded by kMaxHosts: the oldest entry is freed when a newer one
// needs the slot.
struct RetiredRing {
    int32_t* header = nullptr;
    float* data = nullptr;
    int capacityFrames = 0;
};
RetiredRing g_retiredRings[kMaxHosts];
int g_nextRetiredSlot = 0;

void RetireRing(int32_t* header, float* data, int capacityFrames)
{
    RetiredRing& slot = g_retiredRings[g_nextRetiredSlot];
    free(slot.header);
    free(slot.data);
    slot = RetiredRing{header, data, capacityFrames};
    g_nextRetiredSlot = (g_nextRetiredSlot + 1) % kMaxHosts;
}

bool TakeRetiredRing(int capacityFrames, int32_t*& header, float*& data)
{
    for (RetiredRing& slot : g_retiredRings)
    {
        if (slot.header != nullptr && slot.capacityFrames == capacityFrames)
        {
            header = slot.header;
            data = slot.data;
            slot = RetiredRing{};
            return true;
        }
    }
    return false;
}

int32_t LoadWriteIndex(const PcmRingState& ring)
{
    return __atomic_load_n(&ring.header[kHeaderWriteIndex], __ATOMIC_SEQ_CST);
}

void PublishReadIndex(const PcmRingState& ring, int32_t value)
{
    __atomic_store_n(&ring.header[kHeaderReadIndex], value, __ATOMIC_SEQ_CST);
}

void BumpOverruns(const PcmRingState& ring)
{
    __atomic_fetch_add(&ring.header[kHeaderOverruns], 1, __ATOMIC_SEQ_CST);
}

} // namespace

extern "C" {

// Defined below; pcm_ring_init() reuses it to release a previous allocation.
EMSCRIPTEN_KEEPALIVE void pcm_ring_shutdown();

// Allocates the active host's ring. Idempotent: a second call with the same
// capacity is a no-op so hosts can call it defensively before every producer
// hookup, and a call with a different capacity reallocates (dropping buffered
// audio, which is correct — the producers must remap their views anyway, and
// the worklet is sent the new descriptor).
EMSCRIPTEN_KEEPALIVE
int pcm_ring_init(int capacity_frames)
{
    WasmHost& H = Host();
    PcmRingState& ring = H.pcmRing;

    if (capacity_frames <= 0)
    {
        capacity_frames = kDefaultCapacityFrames;
    }
    if (capacity_frames > kMaxCapacityFrames)
    {
        capacity_frames = kMaxCapacityFrames;
    }

    if (ring.header && ring.capacityFrames == capacity_frames)
    {
        return 1;
    }

    pcm_ring_shutdown();

    if (!TakeRetiredRing(capacity_frames, ring.header, ring.data))
    {
        ring.header = static_cast<int32_t*>(calloc(kHeaderInts, sizeof(int32_t)));
        ring.data = static_cast<float*>(calloc(static_cast<size_t>(capacity_frames) * 2, sizeof(float)));
        if (!ring.header || !ring.data)
        {
            fprintf(stderr, "pcm_ring_init: allocation failed for %d frames\n", capacity_frames);
            free(ring.header);
            free(ring.data);
            ring.header = nullptr;
            ring.data = nullptr;
            return 0;
        }
    }

    // A reused allocation carries its previous owner's indices; start clean.
    // Producers only publish after they have this ring's descriptor, and that
    // is posted below, after the reset.
    for (int i = 0; i < kHeaderInts; ++i)
    {
        __atomic_store_n(&ring.header[i], 0, __ATOMIC_SEQ_CST);
    }

    ring.capacityFrames = capacity_frames;
    ring.indexModulus = capacity_frames * kIndexWrapMultiple;
    ring.readIndex = 0;
    ring.header[kHeaderCapacity] = capacity_frames;
    ring.drainScratch.assign(static_cast<size_t>(capacity_frames) * 2, 0.0f);

    PublishPcmRingToWorklet(HostHandle(H), reinterpret_cast<uintptr_t>(ring.header),
                            reinterpret_cast<uintptr_t>(ring.data), ring.capacityFrames,
                            ring.indexModulus);
    return 1;
}

// Releases the active host's ring. Called from destruct() (and so from
// destroy_host()) so the scratch buffer does not leak across re-inits the way
// the old per-call `projectMAudioBufferPtr` malloc did. The storage itself is
// retired rather than freed; see RetireRing().
EMSCRIPTEN_KEEPALIVE
void pcm_ring_shutdown()
{
    WasmHost& H = Host();
    PcmRingState& ring = H.pcmRing;
    if (ring.header != nullptr)
    {
        WithdrawPcmRingFromWorklet(HostHandle(H));
        RetireRing(ring.header, ring.data, ring.capacityFrames);
    }
    ring.header = nullptr;
    ring.data = nullptr;
    ring.capacityFrames = 0;
    ring.indexModulus = 0;
    ring.readIndex = 0;
    std::vector<float>().swap(ring.drainScratch);
}

// Byte offset of the active host's int32 header within the WASM heap, or 0
// when uninitialized.
EMSCRIPTEN_KEEPALIVE
uintptr_t get_pcm_ring_header_ptr()
{
    return reinterpret_cast<uintptr_t>(Host().pcmRing.header);
}

// Byte offset of the active host's interleaved float storage within the WASM heap.
EMSCRIPTEN_KEEPALIVE
uintptr_t get_pcm_ring_data_ptr()
{
    return reinterpret_cast<uintptr_t>(Host().pcmRing.data);
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
    return Host().pcmRing.capacityFrames;
}

EMSCRIPTEN_KEEPALIVE
int get_pcm_ring_write_index()
{
    const PcmRingState& ring = Host().pcmRing;
    return ring.header ? LoadWriteIndex(ring) : 0;
}

EMSCRIPTEN_KEEPALIVE
int get_pcm_ring_read_index()
{
    return Host().pcmRing.readIndex;
}

// Drains have skipped unread audio this many times since init. Non-zero means
// the render loop is not keeping up with the producers; the visualization stays
// in sync (it skips forward rather than tearing) but has lost samples.
EMSCRIPTEN_KEEPALIVE
int get_pcm_ring_overruns()
{
    const PcmRingState& ring = Host().pcmRing;
    return ring.header ? __atomic_load_n(&ring.header[kHeaderOverruns], __ATOMIC_SEQ_CST) : 0;
}

// Feeds every frame written to the active host's ring since the last drain to
// that host's engine in one stereo projectm_pcm_add_float() call. Returns the
// number of frames fed.
//
// Overrun policy: when producers have lapped the ring, skip forward to the
// newest `capacity` frames rather than reading a torn mix of old and new
// samples. This mirrors drainPcmRing() in html/projectm-render-worker.js, which
// this replaces.
EMSCRIPTEN_KEEPALIVE
int pcm_ring_drain()
{
    WasmHost& H = Host();
    PcmRingState& ring = H.pcmRing;
    if (!ring.header || !ring.data || ring.capacityFrames <= 0)
    {
        return 0;
    }

    projectm_handle handle = H.appData.projectm_engine;
    if (!handle)
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

    if (available > ring.capacityFrames)
    {
        ring.readIndex = (writeIndex - ring.capacityFrames + ring.indexModulus) % ring.indexModulus;
        available = ring.capacityFrames;
        BumpOverruns(ring);
    }

    const int start = ring.readIndex % ring.capacityFrames;
    const int firstFrames = std::min(available, ring.capacityFrames - start);
    std::copy(ring.data + static_cast<size_t>(start) * 2,
              ring.data + static_cast<size_t>(start + firstFrames) * 2,
              ring.drainScratch.begin());
    if (firstFrames < available)
    {
        const int remaining = available - firstFrames;
        std::copy(ring.data,
                  ring.data + static_cast<size_t>(remaining) * 2,
                  ring.drainScratch.begin() + static_cast<std::ptrdiff_t>(firstFrames) * 2);
    }

    ring.readIndex = writeIndex;
    PublishReadIndex(ring, ring.readIndex);

    projectm_pcm_add_float(handle, ring.drainScratch.data(),
                           static_cast<unsigned int>(available), PROJECTM_STEREO);
    return available;
}

} // extern "C"
