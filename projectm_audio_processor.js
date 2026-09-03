// projectm_audio_processor.js
//
// The audio-rate producer for projectM's PCM ring.
//
// Every 128-sample quantum this processor handles — whether it is playing a
// decoded buffer itself, or passing through a MediaElementAudioSourceNode
// connected to its input — is written straight into the ring that
// src/wasm/WasmPcmRing.cpp owns, and the write index is published with
// Atomics.store. The engine drains it in render_frame().
//
// It used to accumulate 576 mono samples and postMessage them to the main
// thread, which then copied them into a scratch buffer and called
// projectm_pcm_add_float. That still happens, but only as the fallback for
// pages without cross-origin isolation (no SharedArrayBuffer, so the WASM heap
// cannot be shared into the worklet) — and even then the message lands in the
// same ring on the other side. One ingest, two transports.
//
// Ring layout (mirrors WasmPcmRing.cpp):
//   header  Int32Array(4)  [0] write index (frames)  [1] capacity  [2] read index  [3] overruns
//   data    Float32Array(capacityFrames * 2)  interleaved stereo

// Frames buffered before a postMessage in the fallback transport. Matches
// projectM's own analysis buffer (AudioBufferSamples) so a page without
// SharedArrayBuffer still delivers whole analysis windows.
const FALLBACK_FRAMES = 576;

class ProjectMAudioWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);
        this.mainChannelData = null; // Array of Float32Arrays, one per channel (received via postMessage)
        this.totalSamples = 0;       // Total sample frames in the buffer
        this.numChannels = 0;        // Number of audio channels
        this.playhead = 0;           // Current sample frame position
        this.looping = true;         // Default to looping
        this.isPlaying = false;

        // --- Ring transport (preferred) ---
        /** @type {Int32Array | null} */
        this.ringHeader = null;
        /** @type {Float32Array | null} */
        this.ringData = null;
        this.ringCapacityFrames = 0;
        this.ringIndexModulus = 0;

        // Staging for one render quantum, so the ring's write index is published
        // once per quantum rather than once per sample. Sized for the largest
        // quantum a UA may hand us (128 today, but the spec allows more).
        this.quantum = new Float32Array(128 * 2);
        this.quantumFrames = 0;

        // --- postMessage transport (fallback) ---
        // Interleaved stereo, unlike the old mono buffer: stereo separation is
        // preserved all the way to the engine on this path too.
        this.fallbackBuffer = new Float32Array(FALLBACK_FRAMES * 2);
        this.fallbackFrames = 0;

        this.port.onmessage = (event) => {
            const data = event.data;
            if (!data) return;

            if (data.type === 'pcmRing') {
                this.attachRing(data);
            } else if (data.type === 'loadWavData') {
                // Sender posts raw channel data as an Array of Float32Arrays (not an AudioBuffer
                // object, since AudioBuffer cannot be reliably transferred across the worklet boundary).
                this.mainChannelData = data.channelData;
                this.numChannels = this.mainChannelData ? this.mainChannelData.length : 0;
                this.totalSamples = (this.mainChannelData && this.mainChannelData[0])
                                  ? this.mainChannelData[0].length : 0;
                this.playhead = data.startPlaying ? 0 : -1; // Reset or keep paused
                this.looping = data.loop !== undefined ? data.loop : true;
                this.isPlaying = data.startPlaying || false;
                this.fallbackFrames = 0;
                console.log(`[Worklet] AudioBuffer received, playback ${this.isPlaying ? 'started/resumed' : 'paused'}.`);
            } else if (data.type === 'stopPlayback') {
                this.isPlaying = false;
                console.log('[Worklet] Playback stopped by main thread.');
            } else if (data.type === 'startPlayback') {
                if (this.mainChannelData) { // Only start if buffer is loaded
                    this.isPlaying = true;
                    this.playhead = data.playheadPosition || 0; // Allow starting from specific point
                    console.log('[Worklet] Playback (re)started by main thread.');
                } else {
                    console.log('[Worklet] Cannot start playback, no audio buffer loaded.');
                }
            } else if (data.type === 'setLoop') {
                this.looping = data.loop;
                console.log('[Worklet] Loop set to: ' + this.looping);
            }
        };
    }

    /**
     * Maps the WASM-owned ring into this worklet. Only possible when the module's
     * memory is a SharedArrayBuffer, i.e. the page is cross-origin isolated.
     */
    attachRing({ memory, headerPtr, dataPtr, capacityFrames, indexModulus }) {
        try {
            this.ringHeader = new Int32Array(memory, headerPtr, 4);
            this.ringData = new Float32Array(memory, dataPtr, capacityFrames * 2);
            this.ringCapacityFrames = capacityFrames;
            this.ringIndexModulus = indexModulus;
            // Anything buffered for the message transport would now arrive twice.
            this.fallbackFrames = 0;
            this.quantumFrames = 0;
            console.log(`[Worklet] PCM ring attached (${capacityFrames} frames).`);
        } catch (err) {
            console.error('[Worklet] Failed to map PCM ring:', err);
            this.ringHeader = null;
            this.ringData = null;
            this.ringCapacityFrames = 0;
        }
    }

    /** Stages one stereo frame for this quantum. */
    emitFrame(left, right) {
        if (this.quantumFrames * 2 + 1 >= this.quantum.length) {
            // Larger quantum than we sized for: grow once and keep going.
            const grown = new Float32Array(this.quantum.length * 2);
            grown.set(this.quantum);
            this.quantum = grown;
        }
        this.quantum[this.quantumFrames * 2] = left;
        this.quantum[this.quantumFrames * 2 + 1] = right;
        this.quantumFrames += 1;
    }

    /**
     * Hands this quantum's frames to whichever transport is active. One
     * Atomics.store per quantum, not per sample: the store is what publishes the
     * samples to the drain, so it must come after all of them anyway.
     */
    commitQuantum() {
        const frames = this.quantumFrames;
        this.quantumFrames = 0;
        if (frames === 0) return;

        if (this.ringData && this.ringHeader) {
            const writeIndex = Atomics.load(this.ringHeader, 0);
            for (let i = 0; i < frames; i += 1) {
                const slot = ((writeIndex + i) % this.ringCapacityFrames) * 2;
                this.ringData[slot] = this.quantum[i * 2];
                this.ringData[slot + 1] = this.quantum[i * 2 + 1];
            }
            Atomics.store(this.ringHeader, 0, (writeIndex + frames) % this.ringIndexModulus);
            return;
        }

        for (let i = 0; i < frames; i += 1) {
            this.fallbackBuffer[this.fallbackFrames * 2] = this.quantum[i * 2];
            this.fallbackBuffer[this.fallbackFrames * 2 + 1] = this.quantum[i * 2 + 1];
            this.fallbackFrames += 1;
            if (this.fallbackFrames >= FALLBACK_FRAMES) {
                this.flushFallback();
            }
        }
    }

    flushFallback() {
        if (this.fallbackFrames === 0) return;
        const frames = this.fallbackFrames;
        this.fallbackFrames = 0;
        this.port.postMessage({
            type: 'pcmData',
            audioData: this.fallbackBuffer.slice(0, frames * 2),
            samplesPerChannel: frames,
            channelsForPM: 2,
        });
    }

    process(inputs, outputs) {
        const outputBuffer = outputs[0];
        const quantum = outputBuffer && outputBuffer[0] ? outputBuffer[0].length : 128;

        // Pass-through path: a MediaElementAudioSourceNode (or any other node)
        // connected to this processor's input. This is how <audio>/<video>
        // sources reach the engine now — the same producer as everything else,
        // rather than an AnalyserNode polled once per animation frame.
        //
        // Local playback wins when it is running: an element stays connected
        // across a source switch (the Web Audio API will not let us make a
        // second source node for it), and a connected-but-idle element would
        // otherwise feed silence over a song started with pl().
        const input = inputs[0];
        if (!this.isPlaying && input && input.length > 0 && input[0] && input[0].length > 0) {
            const inLeft = input[0];
            const inRight = input.length > 1 ? input[1] : input[0];
            for (let i = 0; i < inLeft.length; i += 1) {
                this.emitFrame(inLeft[i], inRight[i]);
                for (let ch = 0; ch < outputBuffer.length; ch += 1) {
                    outputBuffer[ch][i] = ch === 0 ? inLeft[i] : inRight[i];
                }
            }
            this.commitQuantum();
            return true;
        }

        if (!this.isPlaying || !this.mainChannelData || this.totalSamples === 0) {
            for (const outputChannel of outputBuffer) {
                outputChannel.fill(0);
            }
            return true; // Keep processor alive
        }

        const outputChannels = outputBuffer.length;
        const leftSource = this.mainChannelData[0];
        const rightSource = this.numChannels > 1 ? this.mainChannelData[1] : this.mainChannelData[0];

        for (let i = 0; i < quantum; i += 1) {
            if (this.playhead >= this.totalSamples) { // End of buffer
                if (this.looping) {
                    this.playhead = 0; // Loop
                } else {
                    this.isPlaying = false; // Stop
                    this.commitQuantum();
                    this.flushFallback();
                    for (let ch = 0; ch < outputChannels; ch += 1) {
                        outputBuffer[ch].fill(0, i);
                    }
                    return true; // End processing for this block
                }
            }

            const left = leftSource[this.playhead];
            const right = rightSource[this.playhead];
            for (let ch = 0; ch < outputChannels; ch += 1) {
                // Use the source channel when there is one, else duplicate.
                outputBuffer[ch][i] = this.numChannels > ch
                    ? this.mainChannelData[ch][this.playhead]
                    : (ch === 0 ? left : right);
            }

            this.emitFrame(left, right);
            this.playhead += 1;
        }

        this.commitQuantum();
        return true; // Keep processor alive
    }
}

registerProcessor('projectm-audio-processor', ProjectMAudioWorkletProcessor);
