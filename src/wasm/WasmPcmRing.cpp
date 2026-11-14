// WasmPcmRing.cpp
//
// The single PCM ingest path into libprojectM on the web.
//
// One ring per engine (#246). Every export below operates on its host's ring
// (PcmRingState in WasmHost.hpp), so two engines in one Module ingest
// independently: draining host A never consumes host B's writes. JS producers
// read a host's descriptor through its pm_ exports (html/projectm-pcm-ring.js),
// or receive a descriptor tagged with the host handle (the AudioWorklet, see
// WasmAudioBridge.cpp).
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
#include "WasmLog.hpp"

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
// A ring's descriptor lives on in producers that hold views over it. Freeing
// the storage the moment a host shuts its ring down would let one more write
// land in memory the allocator may already have handed to something else.
//
//   * The AudioWorklet learns about a withdrawal only through an asynchronous
//     port message (pcmRingDetach), and writes every render quantum until it
//     has processed it. A ring it may have mapped is parked here, neither
//     reused nor freed, until it answers pcmRingDetached
//     (pcm_ring_release_retired()).
//   * Every other producer (the main-thread ring writer, external PCM) runs on
//     this thread and re-reads the descriptor, but may write once more from a
//     cached view. Released rings it may hold, and acknowledged ones, go to a
//     reuse pool: the next pcm_ring_init() of the same capacity takes one, so
//     a late write can at worst bleed a few milliseconds of audio into a new
//     ring, never corrupt the heap.
//
// Both are bounded. A worklet that never answers (its context closed before it
// processed the message) cannot grow the park without limit: past
// kMaxAwaitingAck the oldest parked ring moves to the reuse pool, which is no
// worse than before the handshake existed. The pool frees its oldest entry when
// a newer one needs the slot.
struct RetiredRing {
    int32_t* header = nullptr;
    float* data = nullptr;
    int capacityFrames = 0;
};

constexpr int kMaxAwaitingAck = kMaxHosts * 4;
RetiredRing g_awaitingAck[kMaxAwaitingAck];
RetiredRing g_reusePool[kMaxHosts];
int g_nextReuseSlot = 0;

void AddToReusePool(const RetiredRing& ring)
{
    RetiredRing& slot = g_reusePool[g_nextReuseSlot];
    free(slot.header);
    free(slot.data);
    slot = ring;
    g_nextReuseSlot = (g_nextReuseSlot + 1) % kMaxHosts;
}

void ParkUntilAcknowledged(const RetiredRing& ring)
{
    for (RetiredRing& slot : g_awaitingAck)
    {
        if (slot.header == nullptr)
        {
            slot = ring;
            return;
        }
    }
    // Full: the oldest-parked entry is slot 0 (entries shift down as they leave).
    WASM_LOG_WARN("pcm_ring: %d released rings await the audio worklet's pcmRingDetached; "
                  "recycling the oldest without it.",
                  kMaxAwaitingAck);
    AddToReusePool(g_awaitingAck[0]);
    for (int i = 1; i < kMaxAwaitingAck; ++i)
    {
        g_awaitingAck[i - 1] = g_awaitingAck[i];
    }
    g_awaitingAck[kMaxAwaitingAck - 1] = ring;
}

void RetireRing(uintptr_t hostHandle, const RetiredRing& ring)
{
    const bool workletMayHoldIt = WithdrawPcmRingFromWorklet(hostHandle, reinterpret_cast<uintptr_t>(ring.header));
    if (workletMayHoldIt)
    {
        ParkUntilAcknowledged(ring);
    }
    else
    {
        AddToReusePool(ring);
    }
}

bool TakeRetiredRing(int capacityFrames, int32_t*& header, float*& data)
{
    for (RetiredRing& slot : g_reusePool)
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

namespace WasmApi {

// Allocates the active host's ring. Idempotent: a second call with the same
// capacity is a no-op so hosts can call it defensively before every producer
// hookup, and a call with a different capacity reallocates (dropping buffered
// audio, which is correct — the producers must remap their views anyway, and
// the worklet is sent the new descriptor).
int pcm_ring_init(WasmHost& H, int capacity_frames)
{
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

    pcm_ring_shutdown(H);

    if (!TakeRetiredRing(capacity_frames, ring.header, ring.data))
    {
        ring.header = static_cast<int32_t*>(calloc(kHeaderInts, sizeof(int32_t)));
        ring.data = static_cast<float*>(calloc(static_cast<size_t>(capacity_frames) * 2, sizeof(float)));
        if (!ring.header || !ring.data)
        {
            WASM_LOG_ERROR("pcm_ring_init: allocation failed for %d frames", capacity_frames);
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
void pcm_ring_shutdown(WasmHost& H)
{
    PcmRingState& ring = H.pcmRing;
    if (ring.header != nullptr)
    {
        RetireRing(HostHandle(H), RetiredRing{ring.header, ring.data, ring.capacityFrames});
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
uintptr_t get_pcm_ring_header_ptr(WasmHost& H)
{
    return reinterpret_cast<uintptr_t>(H.pcmRing.header);
}

// Byte offset of the active host's interleaved float storage within the WASM heap.
uintptr_t get_pcm_ring_data_ptr(WasmHost& H)
{
    return reinterpret_cast<uintptr_t>(H.pcmRing.data);
}

// Modulus the frame indices wrap at. Producers must apply the same wrap when
// they publish the write index.
int get_pcm_ring_index_modulus(WasmHost& H)
{
    return H.pcmRing.indexModulus;
}

int get_pcm_ring_capacity_frames(WasmHost& H)
{
    return H.pcmRing.capacityFrames;
}

int get_pcm_ring_write_index(WasmHost& H)
{
    const PcmRingState& ring = H.pcmRing;
    return ring.header ? LoadWriteIndex(ring) : 0;
}

int get_pcm_ring_read_index(WasmHost& H)
{
    return H.pcmRing.readIndex;
}

// Drains have skipped unread audio this many times since init. Non-zero means
// the render loop is not keeping up with the producers; the visualization stays
// in sync (it skips forward rather than tearing) but has lost samples.
int get_pcm_ring_overruns(WasmHost& H)
{
    const PcmRingState& ring = H.pcmRing;
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
int pcm_ring_drain(WasmHost& H)
{
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

// The audio worklet answered pcmRingDetached for the ring at `headerPtr`: it
// holds no views of it any more, so the storage joins the reuse pool.
bool pcm_ring_release_retired(uintptr_t headerPtr)
{
    for (int i = 0; i < kMaxAwaitingAck; ++i)
    {
        if (g_awaitingAck[i].header != nullptr && reinterpret_cast<uintptr_t>(g_awaitingAck[i].header) == headerPtr)
        {
            AddToReusePool(g_awaitingAck[i]);
            for (int j = i + 1; j < kMaxAwaitingAck; ++j)
            {
                g_awaitingAck[j - 1] = g_awaitingAck[j];
            }
            g_awaitingAck[kMaxAwaitingAck - 1] = RetiredRing{};
            return true;
        }
    }
    return false;
}

int pcm_ring_parked_count()
{
    int count = 0;
    for (const RetiredRing& slot : g_awaitingAck)
    {
        count += slot.header != nullptr ? 1 : 0;
    }
    return count;
}

} // namespace WasmApi
