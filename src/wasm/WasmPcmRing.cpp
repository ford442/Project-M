// WasmPcmRing.cpp
//
// The single PCM ingest path into libprojectM on the web.
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

#define app_data (Host().appData)

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

int32_t* g_header = nullptr;
float* g_data = nullptr;
int g_capacityFrames = 0;
int g_readIndex = 0;
int g_indexModulus = 0;

// Reused across drains so the per-frame ingest does not allocate. Sized to the
// ring capacity, which is also the most a single drain can yield.
std::vector<float> g_drainScratch;

int32_t LoadWriteIndex()
{
    return __atomic_load_n(&g_header[kHeaderWriteIndex], __ATOMIC_SEQ_CST);
}

void PublishReadIndex(int32_t value)
{
    __atomic_store_n(&g_header[kHeaderReadIndex], value, __ATOMIC_SEQ_CST);
}

void BumpOverruns()
{
    __atomic_fetch_add(&g_header[kHeaderOverruns], 1, __ATOMIC_SEQ_CST);
}

} // namespace

extern "C" {

// Defined below; pcm_ring_init() reuses it to release a previous allocation.
EMSCRIPTEN_KEEPALIVE void pcm_ring_shutdown();

// Allocates the ring. Idempotent: a second call with the same capacity is a
// no-op so hosts can call it defensively before every producer hookup, and a
// call with a different capacity reallocates (dropping buffered audio, which is
// correct — the producers must remap their views anyway).
EMSCRIPTEN_KEEPALIVE
int pcm_ring_init(int capacity_frames)
{
    if (capacity_frames <= 0)
    {
        capacity_frames = kDefaultCapacityFrames;
    }
    if (capacity_frames > kMaxCapacityFrames)
    {
        capacity_frames = kMaxCapacityFrames;
    }

    if (g_header && g_capacityFrames == capacity_frames)
    {
        return 1;
    }

    pcm_ring_shutdown();

    g_header = static_cast<int32_t*>(calloc(kHeaderInts, sizeof(int32_t)));
    g_data = static_cast<float*>(calloc(static_cast<size_t>(capacity_frames) * 2, sizeof(float)));
    if (!g_header || !g_data)
    {
        fprintf(stderr, "pcm_ring_init: allocation failed for %d frames\n", capacity_frames);
        pcm_ring_shutdown();
        return 0;
    }

    g_capacityFrames = capacity_frames;
    g_indexModulus = capacity_frames * kIndexWrapMultiple;
    g_readIndex = 0;
    g_header[kHeaderCapacity] = capacity_frames;
    g_drainScratch.assign(static_cast<size_t>(capacity_frames) * 2, 0.0f);
    return 1;
}

// Releases the ring. Called from destruct() and from rebind_canvases() teardown
// so the scratch buffer does not leak across re-inits the way the old
// per-call `projectMAudioBufferPtr` malloc did.
EMSCRIPTEN_KEEPALIVE
void pcm_ring_shutdown()
{
    free(g_header);
    free(g_data);
    g_header = nullptr;
    g_data = nullptr;
    g_capacityFrames = 0;
    g_indexModulus = 0;
    g_readIndex = 0;
    std::vector<float>().swap(g_drainScratch);
}

// Byte offset of the int32 header within the WASM heap, or 0 when uninitialized.
EMSCRIPTEN_KEEPALIVE
uintptr_t get_pcm_ring_header_ptr()
{
    return reinterpret_cast<uintptr_t>(g_header);
}

// Byte offset of the interleaved float storage within the WASM heap.
EMSCRIPTEN_KEEPALIVE
uintptr_t get_pcm_ring_data_ptr()
{
    return reinterpret_cast<uintptr_t>(g_data);
}

// Modulus the frame indices wrap at. Producers must apply the same wrap when
// they publish the write index.
EMSCRIPTEN_KEEPALIVE
int get_pcm_ring_index_modulus()
{
    return g_indexModulus;
}

EMSCRIPTEN_KEEPALIVE
int get_pcm_ring_capacity_frames()
{
    return g_capacityFrames;
}

EMSCRIPTEN_KEEPALIVE
int get_pcm_ring_write_index()
{
    return g_header ? LoadWriteIndex() : 0;
}

EMSCRIPTEN_KEEPALIVE
int get_pcm_ring_read_index()
{
    return g_readIndex;
}

// Drains have skipped unread audio this many times since init. Non-zero means
// the render loop is not keeping up with the producers; the visualization stays
// in sync (it skips forward rather than tearing) but has lost samples.
EMSCRIPTEN_KEEPALIVE
int get_pcm_ring_overruns()
{
    return g_header ? __atomic_load_n(&g_header[kHeaderOverruns], __ATOMIC_SEQ_CST) : 0;
}

// Feeds every frame written since the last drain to the engine in one stereo
// projectm_pcm_add_float() call. Returns the number of frames fed.
//
// Overrun policy: when producers have lapped the ring, skip forward to the
// newest `capacity` frames rather than reading a torn mix of old and new
// samples. This mirrors drainPcmRing() in html/projectm-render-worker.js, which
// this replaces.
EMSCRIPTEN_KEEPALIVE
int pcm_ring_drain()
{
    if (!g_header || !g_data || g_capacityFrames <= 0)
    {
        return 0;
    }

    projectm_handle handle = app_data.projectm_engine;
    if (!handle)
    {
        return 0;
    }

    const int32_t writeIndex = LoadWriteIndex();
    if (writeIndex < 0 || writeIndex >= g_indexModulus)
    {
        // A producer published an index outside the agreed modulus; resynchronise
        // rather than indexing out of the ring.
        g_readIndex = writeIndex % g_indexModulus;
        if (g_readIndex < 0)
        {
            g_readIndex = 0;
        }
        PublishReadIndex(g_readIndex);
        return 0;
    }

    int available = (writeIndex - g_readIndex + g_indexModulus) % g_indexModulus;
    if (available == 0)
    {
        return 0;
    }

    if (available > g_capacityFrames)
    {
        g_readIndex = (writeIndex - g_capacityFrames + g_indexModulus) % g_indexModulus;
        available = g_capacityFrames;
        BumpOverruns();
    }

    const int start = g_readIndex % g_capacityFrames;
    const int firstFrames = std::min(available, g_capacityFrames - start);
    std::copy(g_data + static_cast<size_t>(start) * 2,
              g_data + static_cast<size_t>(start + firstFrames) * 2,
              g_drainScratch.begin());
    if (firstFrames < available)
    {
        const int remaining = available - firstFrames;
        std::copy(g_data,
                  g_data + static_cast<size_t>(remaining) * 2,
                  g_drainScratch.begin() + static_cast<size_t>(firstFrames) * 2);
    }

    g_readIndex = writeIndex;
    PublishReadIndex(g_readIndex);

    projectm_pcm_add_float(handle, g_drainScratch.data(),
                           static_cast<unsigned int>(available), PROJECTM_STEREO);
    return available;
}

} // extern "C"
