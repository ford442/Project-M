// WasmAudioBridge.cpp
//
// Audio bridge: Web Audio worklet EM_JS interop, PCM feed wrappers, and the
// pl()/stream-source C exports.
//
// This file no longer ingests audio itself. Everything it wires up -- the
// worklet, media elements, host PCM producers -- writes into the single PCM
// ring owned by WasmPcmRing.cpp, which render_frame() drains. The former
// AnalyserNode poll (js_feed_stream_data_to_projectm /
// js_initialize_stream_analyser) is gone with it.
//
// Nothing here touches `window` or `document` directly: the same EM_JS runs in
// a worker (OffscreenCanvas render path), where neither exists. Globals that
// are genuinely the host contract go through `globalThis`; DOM lookups resolve
// `globalThis.document` once and bail when it is absent.
#include "WasmHost.hpp"

using namespace emscripten;

// Per-instance host state (#168 Phase B). The audio-source flag is now a
// WasmHost member. Informational only: every source writes into the one PCM
// ring in WasmPcmRing.cpp. The worklet itself is still process-global, so in a
// two-instance Module the second engine is visual-only unless the host routes
// PCM to it via _projectm_pcm_add_float_wrapper(handle, ...).
//
// None of the EM_JS bodies below contain a bare `pm` / `app_data` /
// `g_is_streaming_audio` token, so these object-like macros do not rewrite the
// embedded JavaScript.
#define pm (Host().appData.projectm_engine)
#define app_data (Host().appData)
#define g_is_streaming_audio (Host().isStreamingAudio)

void projectm_pcm_add_float_from_js_array_wrapper(
    uintptr_t pm_handle_value,
    emscripten::val js_audio_array_val,
    unsigned int num_samples_per_channel,
    int channels_enum_value)
{
    // Honor an explicit engine handle (multi-instance PCM routing); fall back to
    // the active host's engine when 0 is passed (legacy single-instance callers).
    projectm_handle current_pm_handle = pm_handle_value
                                            ? reinterpret_cast<projectm_handle>(pm_handle_value)
                                            : app_data.projectm_engine;
    if (!current_pm_handle)
    {
        fprintf(stderr, "Error: projectM handle is null in from_js_array_wrapper.\n");
        return;
    }

    std::vector<float> cpp_audio_buffer = emscripten::vecFromJSArray<float>(js_audio_array_val);
    if (channels_enum_value <= 0 || num_samples_per_channel == 0)
    {
        fprintf(stderr, "Error: Invalid channel count (%d) or samples_per_channel (%u).\n",
                channels_enum_value, num_samples_per_channel);
        return;
    }

    size_t expected_total_elements = static_cast<size_t>(num_samples_per_channel) * static_cast<size_t>(channels_enum_value);
    if (cpp_audio_buffer.size() != expected_total_elements)
    {
        fprintf(stderr, "Error: Audio data size mismatch. Expected %zu elements, got %zu elements from JS array.\n",
                expected_total_elements, cpp_audio_buffer.size());
        return;
    }

    projectm_pcm_add_float(current_pm_handle, cpp_audio_buffer.data(), num_samples_per_channel, static_cast<projectm_channels>(channels_enum_value));
    return;
}

// Ring descriptor handed to the AudioWorkletProcessor so it can write each
// 128-sample quantum straight into the WASM-owned PCM ring, at audio rate,
// without a postMessage round trip. Returns null when the ring has not been
// allocated yet (init() allocates it before this runs) or when the module's
// memory is not shared (no COOP/COEP), in which case the processor falls back
// to posting `pcmData` messages that land in the same ring one hop later.
// clang-format off
EM_JS(void, js_post_pcm_ring_to_worklet, (), {
    const node = globalThis.projectMWorkletNode_Global_Cpp;
    if (!node || typeof _get_pcm_ring_data_ptr !== 'function') { return; }
    const dataPtr = _get_pcm_ring_data_ptr();
    const headerPtr = _get_pcm_ring_header_ptr();
    const capacityFrames = _get_pcm_ring_capacity_frames();
    if (!dataPtr || !headerPtr || capacityFrames <= 0) { return; }
    const memory = wasmMemory && wasmMemory.buffer;
    if (typeof SharedArrayBuffer === 'undefined' || !(memory instanceof SharedArrayBuffer)) {
        // Not cross-origin isolated: the processor keeps postMessage'ing PCM.
        return;
    }
    node.port.postMessage({
        type: 'pcmRing',
        memory: memory,
        headerPtr: headerPtr,
        dataPtr: dataPtr,
        capacityFrames: capacityFrames,
        indexModulus: _get_pcm_ring_index_modulus()
    });
});
// clang-format on

// Fallback ingest for the non-isolated case: the processor posts PCM, and this
// writes it into the same ring the drain reads, so there is one ingest path with
// one overrun policy either way -- the transport differs, the architecture does
// not. Prefers the host writer from html/projectm-pcm-ring.js when the page has
// loaded it (one implementation), and otherwise writes the ring inline.
//
// Note there is no _malloc here, and no per-message scratch buffer: the ring is
// allocated once by pcm_ring_init() and owned by WasmPcmRing.cpp.
// clang-format off
EM_JS(void, js_install_worklet_pcm_handler, (), {
    const node = globalThis.projectMWorkletNode_Global_Cpp;
    if (!node) { return; }
    node.port.onmessage = (event) => {
        const data = event.data;
        if (!data || data.type !== 'pcmData' || !data.audioData) { return; }
        const channels = data.channelsForPM === 2 ? 2 : 1;
        const hostWrite = globalThis.projectMWritePcmRing;
        if (typeof hostWrite === 'function') {
            hostWrite(data.audioData, channels);
            return;
        }
        if (typeof _get_pcm_ring_data_ptr !== 'function') { return; }
        const dataPtr = _get_pcm_ring_data_ptr();
        const headerPtr = _get_pcm_ring_header_ptr();
        const capacityFrames = _get_pcm_ring_capacity_frames();
        const indexModulus = _get_pcm_ring_index_modulus();
        if (!dataPtr || !headerPtr || capacityFrames <= 0) { return; }

        const heap = wasmMemory.buffer;
        const header = new Int32Array(heap, headerPtr, 4);
        const ring = new Float32Array(heap, dataPtr, capacityFrames * 2);
        const src = data.audioData;
        const frames = channels === 2 ? (src.length >> 1) : src.length;
        if (frames <= 0) { return; }

        let writeIndex = Atomics.load(header, 0);
        for (let i = 0; i < frames; i++) {
            const slot = ((writeIndex + i) % capacityFrames) * 2;
            if (channels === 2) {
                ring[slot] = src[i * 2];
                ring[slot + 1] = src[i * 2 + 1];
            } else {
                ring[slot] = src[i];
                ring[slot + 1] = src[i];
            }
        }
        writeIndex = (writeIndex + frames) % indexModulus;
        Atomics.store(header, 0, writeIndex);
    };
});
// clang-format on

// clang-format off
EM_JS(void, js_initialize_worklet_system_once, (), {
    if (globalThis.projectMAudioContext_Global_Cpp) { return; }
    try {
        const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContextCtor) {
            console.warn("JS Audio Init: Web Audio unavailable in this context.");
            return;
        }
        const audioContext = new AudioContextCtor();
        globalThis.projectMAudioContext_Global_Cpp = audioContext;
        console.log("JS Audio Init: Web Audio context created.");

        // Shared promise so hosts / pl() can await worklet readiness instead of
        // silently no-op'ing when addModule is still in flight or previously failed.
        let resolveReady;
        let rejectReady;
        globalThis.projectMWorkletReady = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        globalThis.projectMWorkletReadyResolve = resolveReady;
        globalThis.projectMWorkletReadyReject = rejectReady;

        (async () => {
            try {
                await audioContext.audioWorklet.addModule('projectm_audio_processor.js');
                if (globalThis.projectMWorkletNode_Global_Cpp) {
                    _attach_worklet_ingest();
                    resolveReady(globalThis.projectMWorkletNode_Global_Cpp);
                    return;
                }
                const workletNode = new AudioWorkletNode(audioContext, 'projectm-audio-processor');
                globalThis.projectMWorkletNode_Global_Cpp = workletNode;
                _attach_worklet_ingest();
                workletNode.connect(audioContext.destination);
                console.log("JS Audio Init: AudioWorkletNode created and connected permanently.");
                resolveReady(workletNode);
            } catch (err) {
                console.error("JS Audio Init: AudioWorklet setup failed:", err);
                // Allow a later user-gesture repair (html/projectm-worklet-playback.js)
                // to recreate the promise / node.
                globalThis.projectMWorkletNode_Global_Cpp = null;
                if (typeof rejectReady === 'function') {
                    rejectReady(err);
                }
            }
        })();
    } catch(e) {
        console.error("JS Audio Init: Failed to initialize worklet system:", e);
    }
    return;
});
// clang-format on

// clang-format off
EM_JS(void, js_load_song_into_worklet, (const char* path_in_vfs, bool loop, bool startPlaying), {
    const filePath = UTF8ToString(path_in_vfs);
    // Prefer host override (deployable without rebuilding WASM).
    if (typeof globalThis.projectMLoadSongIntoWorklet === 'function') {
        globalThis.projectMLoadSongIntoWorklet(filePath, !!loop, !!startPlaying);
        return;
    }

    async function decodeAndSend(audioContext, workletNode) {
        try {
            const fileDataUint8Array = FS.readFile(filePath);
            console.log(`JS Load Song: Read ${fileDataUint8Array.length} bytes from ${filePath}.`);
            if (fileDataUint8Array.length === 0) { globalThis.projectMSongLoadState = 'error'; return; }

            const audioDataArrayBuffer = fileDataUint8Array.buffer.slice(
                fileDataUint8Array.byteOffset, fileDataUint8Array.byteOffset + fileDataUint8Array.byteLength
            );

            if (audioContext.state === 'suspended') { await audioContext.resume(); }

            const decodedBuffer = await audioContext.decodeAudioData(audioDataArrayBuffer);
            console.log(`JS Load Song: Decoded buffer. Duration: ${decodedBuffer.duration.toFixed(2)}s. Sending to worklet.`);

            const rawChannelData = Array.from({length: decodedBuffer.numberOfChannels}, (_, i) => decodedBuffer.getChannelData(i));

            workletNode.port.postMessage({
                type: 'loadWavData',
                channelData: rawChannelData,
                sampleRate: decodedBuffer.sampleRate,
                loop: loop,
                startPlaying: startPlaying
            });
            globalThis.projectMSongLoadState = 'loaded';
        } catch(e) {
            console.error("JS Load Song: Error during decode and send:", e);
            globalThis.projectMSongLoadState = 'error';
        }
    }

    async function waitForWorkletAndLoad() {
        let audioContext = globalThis.projectMAudioContext_Global_Cpp;
        let workletNode = globalThis.projectMWorkletNode_Global_Cpp;

        if (!audioContext) {
            console.error('JS Load Song: AudioContext missing — init may not have run. Path:', filePath);
            globalThis.projectMSongLoadState = 'error';
            return;
        }

        if (!workletNode) {
            console.warn('JS Load Song: AudioWorklet not ready yet; waiting before loading', filePath);
            try {
                if (globalThis.projectMWorkletReady && typeof globalThis.projectMWorkletReady.then === 'function') {
                    await Promise.race([
                        globalThis.projectMWorkletReady,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('worklet ready timeout')), 12000))
                    ]);
                } else {
                    const deadline = Date.now() + 12000;
                    while (!globalThis.projectMWorkletNode_Global_Cpp && Date.now() < deadline) {
                        await new Promise((r) => setTimeout(r, 50));
                    }
                }
            } catch (err) {
                console.error('JS Load Song: timed out waiting for AudioWorklet:', err);
                globalThis.projectMSongLoadState = 'error';
                return;
            }
            workletNode = globalThis.projectMWorkletNode_Global_Cpp;
            audioContext = globalThis.projectMAudioContext_Global_Cpp;
        }

        if (!audioContext || !workletNode) {
            console.error('JS Load Song: AudioWorklet still unavailable after wait; song will not play:', filePath);
            globalThis.projectMSongLoadState = 'error';
            return;
        }

        if (globalThis.projectMSongLoadState === 'loading') {
            console.warn('JS Load Song: Load already in progress, skipping duplicate request for ' + filePath);
            return;
        }
        globalThis.projectMSongLoadState = 'loading';
        await decodeAndSend(audioContext, workletNode);
    }

    waitForWorkletAndLoad();
    return;
});
// clang-format on

extern "C" {

EMSCRIPTEN_KEEPALIVE
// Routes an <audio>/<video> element into the worklet via a
// MediaElementAudioSourceNode, so element playback is not a special case with
// its own analyser and its own sampling behaviour -- it is the same producer
// writing the same ring as everything else.
//
// Prefers a host implementation (html/projectm-audio-element-source.js) when the
// page provides one, so the wiring is deployable without a WASM rebuild.
// clang-format off
EM_JS(int, js_connect_media_element_source, (const char* selector), {
    const sel = UTF8ToString(selector);
    if (typeof globalThis.projectMConnectMediaElement === 'function') {
        return globalThis.projectMConnectMediaElement(sel) ? 1 : 0;
    }

    // Resolved once, and never dereferenced when absent: in the render worker
    // there is no DOM, and an element source is not reachable from there.
    const doc = globalThis.document;
    const audioContext = globalThis.projectMAudioContext_Global_Cpp;
    const node = globalThis.projectMWorkletNode_Global_Cpp;
    if (!doc || !audioContext || !node) { return 0; }

    const element = doc.querySelector(sel);
    if (!element) {
        console.warn('JS Element Source: no element matched', sel);
        return 0;
    }

    globalThis.projectMElementSources = globalThis.projectMElementSources || new WeakMap();
    // createMediaElementSource() throws if the element already has a source node,
    // so reuse the one made earlier for this element.
    let source = globalThis.projectMElementSources.get(element);
    if (!source) {
        source = audioContext.createMediaElementSource(element);
        globalThis.projectMElementSources.set(element, source);
    }
    source.connect(node);
    return 1;
});
// clang-format on

// Hands the worklet its ring descriptor and installs the postMessage fallback.
// Exported because html/projectm-worklet-playback.js repairs a failed worklet
// setup on a later user gesture and must re-attach ingest to the new node.
EMSCRIPTEN_KEEPALIVE
void attach_worklet_ingest()
{
    js_install_worklet_pcm_handler();
    js_post_pcm_ring_to_worklet();
}

// Connects a media element (CSS selector) to the worklet. Returns 1 on success.
EMSCRIPTEN_KEEPALIVE
int connect_media_element_source(const char* selector)
{
    return js_connect_media_element_source(selector);
}

void pl(const char* song_path_in_vfs)
{
    printf("C++: pl() called for unique path: %s\n", song_path_in_vfs);
    js_load_song_into_worklet(song_path_in_vfs, true, true);
    return;
}

EMSCRIPTEN_KEEPALIVE
void set_audio_source_to_stream(bool is_streaming)
{
    g_is_streaming_audio = is_streaming;
    printf("C++: Audio source set to stream: %s\n", is_streaming ? "true" : "false");
}

// clang-format off
EM_JS(void, js_stop_worklet_playback, (), {
    const workletNode = globalThis.projectMWorkletNode_Global_Cpp;
    if (workletNode) {
        workletNode.port.postMessage({ type: 'stopPlayback' });
    }
});
// clang-format on

EMSCRIPTEN_KEEPALIVE
void stop_worklet_playback()
{
    js_stop_worklet_playback();
}

} // extern "C"

extern "C" {

void add_audio_data(uint8_t* data, int len)
{
    projectm_pcm_add_uint8(pm, data, len, PROJECTM_MONO);
    return;
}
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void projectm_pcm_add_float_wrapper(uintptr_t pm_handle_value, float* audio_data, unsigned int num_samples_per_channel, int channels_enum_value)
{
    // Honor an explicit engine handle so a host can feed a specific instance
    // (multi-instance A/B). 0 falls back to the active host's engine, preserving
    // the legacy single-instance contract where the argument was ignored.
    projectm_handle current_pm_handle = pm_handle_value
                                            ? reinterpret_cast<projectm_handle>(pm_handle_value)
                                            : app_data.projectm_engine;
    if (!current_pm_handle)
    {
        fprintf(stderr, "Error: projectM handle is null in pcm_add_float_wrapper.\n");
        return;
    }
    projectm_pcm_add_float(current_pm_handle, audio_data, num_samples_per_channel, static_cast<projectm_channels>(channels_enum_value));
}
} // extern "C"
