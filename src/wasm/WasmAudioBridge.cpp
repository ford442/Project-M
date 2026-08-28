// WasmAudioBridge.cpp
//
// Audio bridge: Web Audio worklet + stream analyser EM_JS interop, PCM feed
// wrappers, and the pl()/stream-source C exports.
#include "WasmHost.hpp"

using namespace emscripten;

// Per-instance host state (#168 Phase B). The audio-source flag is now a
// WasmHost member. NOTE: the Web Audio worklet / analyser plumbing on the JS
// side (window.projectMAudioContext_Global_Cpp, the single worklet node, the
// stream analyser) is still process-global, so in a two-instance Module the
// second engine is visual-only unless the host explicitly routes PCM to it via
// _projectm_pcm_add_float_wrapper(handle, ...). See docs/EMSCRIPTEN.md.
//
// None of the EM_JS bodies below contain a bare `pm` / `app_data` /
// `g_is_streaming_audio` token, so these object-like macros do not rewrite the
// embedded JavaScript.
#define pm                    (Host().appData.projectm_engine)
#define app_data              (Host().appData)
#define g_is_streaming_audio  (Host().isStreamingAudio)

EM_JS(void, js_feed_stream_data_to_projectm, (uintptr_t pm_handle, int buffer_size), {
    const analyser = window.projectMStreamAnalyser;
    const pcmBuffer = window.projectMStreamBuffer;
    if (!analyser || !pcmBuffer || pcmBuffer.length !== buffer_size) {
        return;
    }
    analyser.getFloatTimeDomainData(pcmBuffer);

    // Lazy-allocate a permanent 2048-float WASM buffer (max size for both audio paths).
    // Using a pre-allocated buffer avoids ccall's 'array' type which relies on stackAlloc,
    // and is fragile with ALLOW_MEMORY_GROWTH + pthreads + SHARED_MEMORY.
    if (!window.projectMAudioBufferPtr) {
        window.projectMAudioBufferPtr = _malloc(2048 * 4);
    }
    const buf = window.projectMAudioBufferPtr;

    // Optimization: projectM's internal analysis buffer is 576 samples (AudioBufferSamples).
    // Sending more than this just overwrites the older data in the ring buffer before analysis.
    // We send only the most recent 576 samples to minimize overhead while keeping the buffer fresh.
    const projectm_buffer_size = 576;
    const src = (pcmBuffer.length > projectm_buffer_size)
                ? pcmBuffer.subarray(pcmBuffer.length - projectm_buffer_size)
                : pcmBuffer;

    // Write via a fresh Float32Array view of the live SharedArrayBuffer.
    new Float32Array(wasmMemory.buffer).set(src, buf >> 2);
    _projectm_pcm_add_float_wrapper(pm_handle, buf, src.length, 1);
});

EM_JS(void, js_initialize_stream_analyser, (), {
    const audioContext = window.projectMAudioContext_Global_Cpp;
    const audioElement = document.getElementById('audio-stream-element')
        || document.getElementById('track');
    if (!audioContext || !audioElement) {
        console.error("JS Stream Init: AudioContext or audio element not found.");
        return;
    }
    const analyser = audioContext.createAnalyser();


    analyser.fftSize = 2048; // A common size for detailed analysis


    const source = audioContext.createMediaElementSource(audioElement);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    window.projectMStreamAnalyser = analyser;
    window.projectMStreamBuffer = new Float32Array(analyser.fftSize);
    console.log("JS Stream Init: Media element and analyser connected.");
});

void projectm_pcm_add_float_from_js_array_wrapper(
uintptr_t pm_handle_value,
emscripten::val js_audio_array_val,
unsigned int num_samples_per_channel,
int channels_enum_value) {
// Honor an explicit engine handle (multi-instance PCM routing); fall back to
// the active host's engine when 0 is passed (legacy single-instance callers).
projectm_handle current_pm_handle = pm_handle_value
    ? reinterpret_cast<projectm_handle>(pm_handle_value)
    : app_data.projectm_engine;
if (!current_pm_handle) {
fprintf(stderr, "Error: projectM handle is null in from_js_array_wrapper.\n");
return;
}

std::vector<float> cpp_audio_buffer = emscripten::vecFromJSArray<float>(js_audio_array_val);
if (channels_enum_value <= 0 || num_samples_per_channel == 0) {
fprintf(stderr, "Error: Invalid channel count (%d) or samples_per_channel (%u).\n",
channels_enum_value, num_samples_per_channel);
return;
}

size_t expected_total_elements = static_cast<size_t>(num_samples_per_channel) * static_cast<size_t>(channels_enum_value);
if (cpp_audio_buffer.size() != expected_total_elements) {
fprintf(stderr, "Error: Audio data size mismatch. Expected %zu elements, got %zu elements from JS array.\n",
expected_total_elements, cpp_audio_buffer.size());
return;
}

projectm_pcm_add_float(current_pm_handle, cpp_audio_buffer.data(), num_samples_per_channel, static_cast<projectm_channels>(channels_enum_value));
return;
}

EM_JS(void, js_initialize_worklet_system_once, (uintptr_t pm_handle_for_addpcm), {
    if (window.projectMAudioContext_Global_Cpp) { return; }
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        window.projectMAudioContext_Global_Cpp = audioContext;
        console.log("JS Audio Init: Web Audio context created.");

        // Shared promise so hosts / pl() can await worklet readiness instead of
        // silently no-op'ing when addModule is still in flight or previously failed.
        let resolveReady;
        let rejectReady;
        window.projectMWorkletReady = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        window.projectMWorkletReadyResolve = resolveReady;
        window.projectMWorkletReadyReject = rejectReady;

        (async () => {
            try {
                await audioContext.audioWorklet.addModule('projectm_audio_processor.js');
                if (window.projectMWorkletNode_Global_Cpp) {
                    resolveReady(window.projectMWorkletNode_Global_Cpp);
                    return;
                }
                const workletNode = new AudioWorkletNode(audioContext, 'projectm-audio-processor');
                window.projectMWorkletNode_Global_Cpp = workletNode;
                workletNode.port.onmessage = (event) => {
                    if (event.data.type === 'pcmData' && _projectm_pcm_add_float_wrapper) {
                        if (!window.projectMAudioBufferPtr) {
                            window.projectMAudioBufferPtr = _malloc(2048 * 4);
                        }
                        const buf = window.projectMAudioBufferPtr;
                        const audioData = event.data.audioData;
                        const projectm_buffer_size = 576;
                        const src = (audioData.length > projectm_buffer_size)
                            ? audioData.subarray(audioData.length - projectm_buffer_size)
                            : audioData;
                        new Float32Array(wasmMemory.buffer).set(src, buf >> 2);
                        _projectm_pcm_add_float_wrapper(pm_handle_for_addpcm, buf, src.length, event.data.channelsForPM);
                    }
                };
                workletNode.connect(audioContext.destination);
                console.log("JS Audio Init: AudioWorkletNode created and connected permanently.");
                resolveReady(workletNode);
            } catch (err) {
                console.error("JS Audio Init: AudioWorklet setup failed:", err);
                // Allow a later user-gesture repair (html/projectm-worklet-playback.js)
                // to recreate the promise / node.
                window.projectMWorkletNode_Global_Cpp = null;
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

EM_JS(void, js_load_song_into_worklet, (const char* path_in_vfs, bool loop, bool startPlaying), {
    const filePath = UTF8ToString(path_in_vfs);
    // Prefer host override (deployable without rebuilding WASM).
    if (typeof window.projectMLoadSongIntoWorklet === 'function') {
        window.projectMLoadSongIntoWorklet(filePath, !!loop, !!startPlaying);
        return;
    }

    async function decodeAndSend(audioContext, workletNode) {
        try {
            const fileDataUint8Array = FS.readFile(filePath);
            console.log(`JS Load Song: Read ${fileDataUint8Array.length} bytes from ${filePath}.`);
            if (fileDataUint8Array.length === 0) { window.projectMSongLoadState = 'error'; return; }

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
            window.projectMSongLoadState = 'loaded';
        } catch(e) {
            console.error("JS Load Song: Error during decode and send:", e);
            window.projectMSongLoadState = 'error';
        }
    }

    async function waitForWorkletAndLoad() {
        let audioContext = window.projectMAudioContext_Global_Cpp;
        let workletNode = window.projectMWorkletNode_Global_Cpp;

        if (!audioContext) {
            console.error('JS Load Song: AudioContext missing — init may not have run. Path:', filePath);
            window.projectMSongLoadState = 'error';
            return;
        }

        if (!workletNode) {
            console.warn('JS Load Song: AudioWorklet not ready yet; waiting before loading', filePath);
            try {
                if (window.projectMWorkletReady && typeof window.projectMWorkletReady.then === 'function') {
                    await Promise.race([
                        window.projectMWorkletReady,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('worklet ready timeout')), 12000))
                    ]);
                } else {
                    const deadline = Date.now() + 12000;
                    while (!window.projectMWorkletNode_Global_Cpp && Date.now() < deadline) {
                        await new Promise((r) => setTimeout(r, 50));
                    }
                }
            } catch (err) {
                console.error('JS Load Song: timed out waiting for AudioWorklet:', err);
                window.projectMSongLoadState = 'error';
                return;
            }
            workletNode = window.projectMWorkletNode_Global_Cpp;
            audioContext = window.projectMAudioContext_Global_Cpp;
        }

        if (!audioContext || !workletNode) {
            console.error('JS Load Song: AudioWorklet still unavailable after wait; song will not play:', filePath);
            window.projectMSongLoadState = 'error';
            return;
        }

        if (window.projectMSongLoadState === 'loading') {
            console.warn('JS Load Song: Load already in progress, skipping duplicate request for ' + filePath);
            return;
        }
        window.projectMSongLoadState = 'loading';
        await decodeAndSend(audioContext, workletNode);
    }

    waitForWorkletAndLoad();
    return;
});

extern "C" {

EMSCRIPTEN_KEEPALIVE
void pl(const char* song_path_in_vfs) {
printf("C++: pl() called for unique path: %s\n", song_path_in_vfs);
js_load_song_into_worklet(song_path_in_vfs, true, true);
return;
}

EMSCRIPTEN_KEEPALIVE
void set_audio_source_to_stream(bool is_streaming) {
g_is_streaming_audio = is_streaming;
printf("C++: Audio source set to stream: %s\n", is_streaming ? "true" : "false");
}

EM_JS(void, js_stop_worklet_playback, (), {
    const workletNode = window.projectMWorkletNode_Global_Cpp;
    if (workletNode) {
        workletNode.port.postMessage({ type: 'stopPlayback' });
    }
});

EMSCRIPTEN_KEEPALIVE
void stop_worklet_playback() {
    js_stop_worklet_playback();
}

} // extern "C"

extern "C" {

void add_audio_data(uint8_t* data, int len) {
projectm_pcm_add_uint8(pm, data, len, PROJECTM_MONO);
return;
}

}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void projectm_pcm_add_float_wrapper(uintptr_t pm_handle_value, float* audio_data, unsigned int num_samples_per_channel, int channels_enum_value) {
    // Honor an explicit engine handle so a host can feed a specific instance
    // (multi-instance A/B). 0 falls back to the active host's engine, preserving
    // the legacy single-instance contract where the argument was ignored.
    projectm_handle current_pm_handle = pm_handle_value
        ? reinterpret_cast<projectm_handle>(pm_handle_value)
        : app_data.projectm_engine;
    if (!current_pm_handle) {
        fprintf(stderr, "Error: projectM handle is null in pcm_add_float_wrapper.\n");
        return;
    }
    projectm_pcm_add_float(current_pm_handle, audio_data, num_samples_per_channel, static_cast<projectm_channels>(channels_enum_value));
}
} // extern "C"
