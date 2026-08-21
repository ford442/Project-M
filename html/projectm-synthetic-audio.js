/**
 * Synthetic PCM generators and direct WASM feed helpers for audio reactivity testing.
 * Used by ?audioTest=1 debug panel and tests/wasm-smoke/audio_reactivity.html.
 */

export const PROJECTM_ANALYSIS_WINDOW = 576;
export const DEFAULT_SAMPLE_RATE = 44100;

/**
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 */

/** @typedef {'silence' | 'bass' | 'mid' | 'treble' | 'beat' | 'sweep'} SyntheticFeedMode */

/**
 * @param {number} sampleCount
 * @returns {Float32Array}
 */
export function generateSilence(sampleCount) {
    return new Float32Array(sampleCount);
}

/**
 * @param {number} sampleCount
 * @param {object} [options]
 * @param {number} [options.frequencyHz]
 * @param {number} [options.sampleRate]
 * @param {number} [options.amplitude]
 * @param {number} [options.phase]
 * @returns {Float32Array}
 */
export function generateSine(sampleCount, {
    frequencyHz = 440,
    sampleRate = DEFAULT_SAMPLE_RATE,
    amplitude = 0.7,
    phase = 0,
} = {}) {
    const out = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
        const t = (i + phase) / sampleRate;
        out[i] = amplitude * Math.sin(2 * Math.PI * frequencyHz * t);
    }
    return out;
}

/**
 * Stepped frequency sweep for manual/visual verification.
 *
 * @param {number} sampleCount
 * @param {object} [options]
 * @param {number} [options.startHz]
 * @param {number} [options.endHz]
 * @param {number} [options.sampleRate]
 * @param {number} [options.amplitude]
 * @returns {Float32Array}
 */
export function generateFrequencySweep(sampleCount, {
    startHz = 80,
    endHz = 8000,
    sampleRate = DEFAULT_SAMPLE_RATE,
    amplitude = 0.6,
} = {}) {
    const out = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
        const progress = i / Math.max(1, sampleCount - 1);
        const freq = startHz * Math.pow(endHz / startHz, progress);
        const t = i / sampleRate;
        out[i] = amplitude * Math.sin(2 * Math.PI * freq * t);
    }
    return out;
}

/**
 * Impulse train at BPM for beat-detection checks.
 *
 * @param {number} sampleCount
 * @param {object} [options]
 * @param {number} [options.bpm]
 * @param {number} [options.sampleRate]
 * @param {number} [options.amplitude]
 * @returns {Float32Array}
 */
export function generateBeatPulse(sampleCount, {
    bpm = 120,
    sampleRate = DEFAULT_SAMPLE_RATE,
    amplitude = 0.9,
} = {}) {
    const out = new Float32Array(sampleCount);
    const interval = Math.round(sampleRate * 60 / bpm);
    for (let i = 0; i < sampleCount; i += interval) {
        const len = Math.min(80, sampleCount - i);
        for (let j = 0; j < len; j += 1) {
            const env = 1 - j / len;
            out[i + j] = amplitude * env * Math.sin(2 * Math.PI * 60 * j / sampleRate);
        }
    }
    return out;
}

/**
 * Trims interleaved PCM to the trailing `window` frames projectM analyses.
 *
 * @param {Float32Array} buffer Interleaved PCM.
 * @param {number} samplesPerChannel Frames present in `buffer`.
 * @param {number} [window] Frames to keep.
 * @returns {{ buffer: Float32Array, samplesPerChannel: number }}
 */
export function trimToAnalysisWindow(buffer, samplesPerChannel, window = PROJECTM_ANALYSIS_WINDOW) {
    const frames = Math.min(samplesPerChannel, window);
    const trimmedLength = frames * (buffer.length / samplesPerChannel);
    if (trimmedLength >= buffer.length) return { buffer, samplesPerChannel: frames };
    return {
        buffer: buffer.subarray(buffer.length - trimmedLength),
        samplesPerChannel: frames,
    };
}

/**
 * @param {ProjectMModuleLike | null | undefined} module
 * @param {Float32Array} buffer Interleaved PCM.
 * @param {number} [channels]
 * @param {number} [samplesPerChannel]
 * @returns {boolean} true if the chunk was handed to the engine.
 */
export function feedPcmToModule(module, buffer, channels = 1, samplesPerChannel) {
    // Feature-detect every symbol used below: the WASM build's exported set
    // varies by link flags, and HEAPF32/_free were previously assumed present.
    if (!module?._projectm_pcm_add_float_wrapper || !module._malloc
        || !module._free || !module.HEAPF32) {
        return false;
    }
    const frames = samplesPerChannel ?? (channels === 1 ? buffer.length : buffer.length / 2);
    const { buffer: trimmed, samplesPerChannel: windowFrames } = trimToAnalysisWindow(buffer, frames);
    const ptr = module._malloc(trimmed.length * 4);
    if (!ptr) return false;
    try {
        module.HEAPF32.set(trimmed, ptr >> 2);
        module._projectm_pcm_add_float_wrapper(0, ptr, windowFrames, channels);
        return true;
    } finally {
        module._free(ptr);
    }
}

/**
 * Continuous synthetic feed loop driven by requestAnimationFrame.
 *
 * @param {ProjectMModuleLike | null | undefined} module
 * @param {SyntheticFeedMode} [mode]
 * @param {object} [options]
 * @param {number} [options.channels]
 * @param {(frame: number, mode: SyntheticFeedMode) => void} [options.onFrame]
 * @returns {() => void} Stops the feed.
 */
export function startSyntheticFeed(module, mode = 'bass', {
    channels = 1,
    onFrame,
} = {}) {
    let frame = 0;
    let running = true;

    /** @type {Record<SyntheticFeedMode, () => Float32Array>} */
    const generators = {
        silence: () => generateSilence(PROJECTM_ANALYSIS_WINDOW),
        bass: () => generateSine(PROJECTM_ANALYSIS_WINDOW, { frequencyHz: 80, amplitude: 0.85 }),
        mid: () => generateSine(PROJECTM_ANALYSIS_WINDOW, { frequencyHz: 800, amplitude: 0.85 }),
        treble: () => generateSine(PROJECTM_ANALYSIS_WINDOW, { frequencyHz: 5000, amplitude: 0.85 }),
        beat: () => generateBeatPulse(PROJECTM_ANALYSIS_WINDOW, { bpm: 120 }),
        sweep: () => generateFrequencySweep(PROJECTM_ANALYSIS_WINDOW, { startHz: 60, endHz: 10000 }),
    };

    const tick = () => {
        if (!running) return;
        const gen = generators[mode] || generators.bass;
        const mono = gen();
        const buf = channels === 1
            ? mono
            : (() => {
                const stereo = new Float32Array(mono.length * 2);
                for (let i = 0; i < mono.length; i += 1) {
                    stereo[i * 2] = mono[i];
                    stereo[i * 2 + 1] = mono[i];
                }
                return stereo;
            })();
        feedPcmToModule(module, buf, channels);
        onFrame?.(frame, mode);
        frame += 1;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { running = false; };
}

/**
 * Installs the `?audioTest=1` debug panel.
 *
 * @param {ProjectMModuleLike | (() => ProjectMModuleLike | null | undefined) | null} moduleRef
 *   The module, or a getter re-read on each click (it may not exist yet at setup).
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @returns {HTMLDivElement | null} The panel, or null when not enabled.
 */
export function setupAudioTestPanel(moduleRef, { documentRef = document } = {}) {
    const params = new URLSearchParams(globalThis.location?.search || '');
    if (params.get('audioTest') !== '1') return null;

    const panel = documentRef.createElement('div');
    panel.id = 'pm-audio-test';
    panel.style.cssText = 'position:fixed;top:8px;left:8px;z-index:99998;background:#111;color:#7dd3fc;font:11px/1.4 monospace;padding:8px 10px;border:1px solid #38bdf8;border-radius:6px;max-width:14rem';
    panel.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px">Audio Reactivity Test</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${['silence', 'bass', 'mid', 'treble', 'beat', 'sweep'].map((m) =>
        `<button data-mode="${m}" style="font-size:10px;padding:2px 6px;cursor:pointer">${m}</button>`).join('')}
      </div>
      <div id="pm-audio-test-status" style="margin-top:6px;opacity:0.8">stopped</div>
    `;
    documentRef.body.appendChild(panel);

    /** @type {(() => void) | null} */
    let stopFeed = null;
    const status = panel.querySelector('#pm-audio-test-status');
    if (!status) {
        return panel;
    }

    const buttons = /** @type {NodeListOf<HTMLButtonElement>} */ (
        panel.querySelectorAll('button[data-mode]')
    );
    buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const module = typeof moduleRef === 'function' ? moduleRef() : moduleRef;
            if (!module) {
                status.textContent = 'module not ready';
                return;
            }
            if (stopFeed) stopFeed();
            const mode = /** @type {SyntheticFeedMode} */ (btn.dataset.mode);
            status.textContent = `feeding: ${mode}`;
            stopFeed = startSyntheticFeed(module, mode, {
                onFrame: (f) => { status.textContent = `feeding: ${mode} (frame ${f})`; },
            });
        });
    });

    return panel;
}
