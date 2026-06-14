const AUDIO_CHANNEL_NAME = 'projectm-audio';
const DEFAULT_EXTERNAL_PCM_ORIGINS = [
    'https://mod.1ink.us',
    'https://flac.1ink.us',
    'https://test.1ink.us'
];
const LOCAL_STORAGE_ORIGIN_KEYS = [
    'externalPcmOrigins',
    'externalPcmAllowedOrigins'
];
const MAX_PENDING_EXTERNAL_PCM = 24;
const DEFAULT_PCM_TRANSFER_CAP = 2048;
// projectM's internal analysis buffer is 576 samples per channel (AudioBufferSamples).
// The built-in stream path (js_feed_stream_data_to_projectm in projectM_emscripten.cpp)
// trims its analyser output to the most recent 576 samples before feeding, so anything
// larger just overwrites the ring buffer before analysis. Mirror that here so external
// PCM hits projectm_pcm_add_float with the same analysis window as #track/stream, keeping
// beat detection and reactivity comparable across sources.
const PROJECTM_ANALYSIS_WINDOW = 576;
const GAIN_STORAGE_KEYS = ['externalPcmGain'];
const DEFAULT_EXTERNAL_PCM_GAIN = 1.0;
let configuredAllowedOrigins = null;
let configuredGain = DEFAULT_EXTERNAL_PCM_GAIN;
let debugRmsEnabled = false;
let externalAudioChannel = null;
let messageListenerInstalled = false;
let flushInterval = 0;
let pcmTransferPtr = 0;
let pcmTransferModule = null;
let pcmTransferCap = DEFAULT_PCM_TRANSFER_CAP;
let customFeed = null;

const pendingExternalPCM = [];

function normalizedOriginList(origins) {
    if (!origins) return DEFAULT_EXTERNAL_PCM_ORIGINS;
    if (origins instanceof Set) return Array.from(origins);
    if (Array.isArray(origins)) return origins;
    return String(origins).split(',');
}

function readAllowedOriginsFromStorage() {
    try {
        for (const key of LOCAL_STORAGE_ORIGIN_KEYS) {
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            const values = raw.trim().startsWith('[')
                ? JSON.parse(raw)
                : raw.split(',');
            const origins = normalizedOriginList(values).map((origin) => String(origin).trim()).filter(Boolean);
            if (origins.length > 0) return origins;
        }
    } catch (_) {
        console.debug('[projectM external PCM] localStorage unavailable; using configured origin allowlist');
    }
    return null;
}

function allowedOriginSet() {
    const origins = readAllowedOriginsFromStorage() || configuredAllowedOrigins || DEFAULT_EXTERNAL_PCM_ORIGINS;
    return new Set(normalizedOriginList(origins).map((origin) => String(origin).trim()).filter(Boolean));
}

function isTrustedExternalPcmOrigin(origin) {
    return allowedOriginSet().has(origin);
}

// Reads an optional input-gain multiplier for external PCM. External players feed
// raw AnalyserNode time-domain data, whose amplitude can differ from the decoded
// levels the internal worklet path sees, making presets look less reactive at the
// same beat-sensitivity. A gain lets operators match flac/mod loudness to #track on
// a reference preset without rebuilding the WASM module. Default 1.0 (no change).
function externalPcmGain() {
    let gain = configuredGain;
    try {
        for (const key of GAIN_STORAGE_KEYS) {
            const raw = localStorage.getItem(key);
            if (raw === null || raw === '') continue;
            const parsed = Number(raw);
            if (Number.isFinite(parsed) && parsed > 0) {
                gain = parsed;
                break;
            }
        }
    } catch (_) {
        // localStorage unavailable; fall back to the configured/default gain.
    }
    return Number.isFinite(gain) && gain > 0 ? gain : DEFAULT_EXTERNAL_PCM_GAIN;
}

// Matches the internal stream path's preprocessing: trim to the most recent
// PROJECTM_ANALYSIS_WINDOW samples per channel, then apply input gain. Returns the
// samples to feed plus the post-trim samplesPerChannel. Returns a Float32Array view
// (subarray) when no gain scaling is needed (gain === 1 and untrimmed), otherwise a
// fresh scaled copy — never mutates the caller's buffer (queued chunks are reused).
function preprocessExternalPcm(buffer, channels, samplesPerChannel) {
    const window = Math.min(samplesPerChannel, PROJECTM_ANALYSIS_WINDOW);
    const trimmedLength = window * channels;
    const trimmed = trimmedLength < buffer.length
        ? buffer.subarray(buffer.length - trimmedLength)
        : buffer;

    const gain = externalPcmGain();
    if (gain === 1) {
        return { samples: trimmed, samplesPerChannel: window };
    }

    const scaled = new Float32Array(trimmed.length);
    for (let i = 0; i < trimmed.length; i++) {
        scaled[i] = trimmed[i] * gain;
    }
    return { samples: scaled, samplesPerChannel: window };
}

function moduleCanAcceptExternalPCM(moduleInstance) {
    return !!(
        moduleInstance &&
        moduleInstance.HEAPF32 &&
        moduleInstance._projectm_pcm_add_float_wrapper &&
        moduleInstance._malloc
    );
}

function currentProjectMModule() {
    return globalThis.Module;
}

function ensurePcmTransferBuffer(moduleInstance) {
    if (pcmTransferModule && pcmTransferModule !== moduleInstance) {
        if (pcmTransferPtr && pcmTransferModule._free) {
            pcmTransferModule._free(pcmTransferPtr);
        }
        pcmTransferPtr = 0;
    }

    pcmTransferModule = moduleInstance;
    if (pcmTransferPtr) return pcmTransferPtr;
    if (!moduleCanAcceptExternalPCM(moduleInstance)) return 0;

    pcmTransferPtr = moduleInstance._malloc(pcmTransferCap * 4);
    return pcmTransferPtr;
}

function queueExternalPCM(buffer, channels, sampleRate) {
    if (pendingExternalPCM.length >= MAX_PENDING_EXTERNAL_PCM) {
        console.warn('[projectM external PCM] queue full, dropping oldest chunk');
        pendingExternalPCM.shift();
    }
    pendingExternalPCM.push({ buffer, channels, sampleRate });
}

export function defaultFeedPCMToModule(buffer, channels, sampleRate, samplesPerChannel) {
    const moduleInstance = currentProjectMModule();
    if (!moduleCanAcceptExternalPCM(moduleInstance)) return false;

    // Match the internal stream path: 576-sample analysis window + input gain.
    const { samples, samplesPerChannel: framesPerChannel } = preprocessExternalPcm(
        buffer, channels, samplesPerChannel
    );

    let ptr = 0;
    let usedPrealloc = false;
    if (samples.length <= pcmTransferCap) {
        ptr = ensurePcmTransferBuffer(moduleInstance);
        usedPrealloc = !!ptr;
    }

    if (!ptr) {
        ptr = moduleInstance._malloc(samples.length * 4);
        if (!ptr) return false;
    }

    try {
        moduleInstance.HEAPF32.set(samples, ptr >> 2);
        moduleInstance._projectm_pcm_add_float_wrapper(0, ptr, framesPerChannel, channels);
        console.debug('[projectM external PCM] fed chunk', {
            channels,
            samplesPerChannel: framesPerChannel,
            totalSamples: samples.length,
            sampleRate
        });
        return true;
    } finally {
        if (!usedPrealloc && ptr && moduleInstance._free) {
            moduleInstance._free(ptr);
        }
    }
}

function normalizePcmPayload(buffer, channels, sampleRate) {
    if (!(buffer instanceof Float32Array)) {
        console.debug('[projectM external PCM] ignored non-Float32Array payload');
        return null;
    }

    const normalizedChannels = channels === 1 ? 1 : 2;
    if (channels !== undefined && channels !== 1 && channels !== 2) {
        console.debug('[projectM external PCM] invalid channels value; defaulting to stereo:', channels);
    }

    if (normalizedChannels === 2 && (buffer.length % 2) !== 0) {
        console.debug('[projectM external PCM] rejected odd-length stereo payload:', buffer.length);
        return null;
    }

    const samplesPerChannel = normalizedChannels === 1 ? buffer.length : buffer.length / 2;
    if (samplesPerChannel <= 0) return null;

    return {
        buffer,
        channels: normalizedChannels,
        sampleRate,
        samplesPerChannel
    };
}

function logExternalPcmRms(buffer) {
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i];
    const rms = buffer.length > 0 ? Math.sqrt(sumSquares / buffer.length) : 0;
    let peak = 0;
    for (let i = 0; i < buffer.length; i++) {
        const abs = Math.abs(buffer[i]);
        if (abs > peak) peak = abs;
    }
    console.debug('[projectM external PCM] chunk RMS', {
        rms: rms.toFixed(4),
        peak: peak.toFixed(4),
        gain: externalPcmGain(),
        samples: buffer.length
    });
}

export function feedPCMToModule(buffer, channels = 2, sampleRate) {
    const payload = normalizePcmPayload(buffer, channels, sampleRate);
    if (!payload) return false;

    if (debugRmsEnabled) logExternalPcmRms(payload.buffer);

    const feedResult = customFeed
        ? customFeed(payload.buffer, payload.channels, payload.sampleRate, payload.samplesPerChannel)
        : defaultFeedPCMToModule(payload.buffer, payload.channels, payload.sampleRate, payload.samplesPerChannel);
    const fed = customFeed ? feedResult !== false : feedResult;

    if (!fed) {
        queueExternalPCM(payload.buffer, payload.channels, payload.sampleRate);
        return false;
    }

    return true;
}

export function flushQueuedExternalPCM() {
    if (pendingExternalPCM.length === 0) return;

    while (pendingExternalPCM.length > 0) {
        const next = pendingExternalPCM.shift();
        if (!feedPCMToModule(next.buffer, next.channels, next.sampleRate)) {
            break;
        }
    }
}

function closeExternalAudioChannel() {
    if (externalAudioChannel) {
        externalAudioChannel.close();
        externalAudioChannel = null;
    }
}

function cleanupExternalPCM() {
    if (flushInterval) {
        clearInterval(flushInterval);
        flushInterval = 0;
    }
    closeExternalAudioChannel();
    if (pcmTransferPtr && pcmTransferModule && pcmTransferModule._free) {
        pcmTransferModule._free(pcmTransferPtr);
    }
    pcmTransferPtr = 0;
    pcmTransferModule = null;
}

export function setExternalPcmGain(gain) {
    configuredGain = Number.isFinite(gain) && gain > 0 ? gain : DEFAULT_EXTERNAL_PCM_GAIN;
    return configuredGain;
}

export function setupExternalAudioReceiver({ onFeed, allowedOrigins, preallocSize, gain, debugRms } = {}) {
    customFeed = typeof onFeed === 'function' ? onFeed : null;
    configuredAllowedOrigins = allowedOrigins ? normalizedOriginList(allowedOrigins) : DEFAULT_EXTERNAL_PCM_ORIGINS;
    pcmTransferCap = Number.isFinite(preallocSize) && preallocSize > 0
        ? Math.floor(preallocSize)
        : DEFAULT_PCM_TRANSFER_CAP;
    if (gain !== undefined) setExternalPcmGain(gain);
    debugRmsEnabled = !!debugRms;

    if (!messageListenerInstalled) {
        window.addEventListener('message', (event) => {
            if (!isTrustedExternalPcmOrigin(event.origin)) {
                console.debug('[projectM external PCM] ignored untrusted origin:', event.origin);
                return;
            }

            const data = event.data;
            if (data && data.type === 'pcm') {
                feedPCMToModule(data.buffer, data.channels, data.sampleRate);
            }
        });
        messageListenerInstalled = true;
    }

    if (!externalAudioChannel) {
        try {
            externalAudioChannel = new BroadcastChannel(AUDIO_CHANNEL_NAME);
            externalAudioChannel.onmessage = (event) => {
                const data = event.data;
                if (data && data.type === 'pcm') {
                    feedPCMToModule(data.buffer, data.channels, data.sampleRate);
                }
            };
        } catch (error) {
            console.debug('[projectM external PCM] BroadcastChannel unavailable:', error);
        }
    }

    if (!flushInterval) {
        flushInterval = setInterval(flushQueuedExternalPCM, 100);
        window.addEventListener('beforeunload', cleanupExternalPCM, { once: true });
    }

    return {
        feedPCMToModule,
        flushQueuedExternalPCM,
        close: cleanupExternalPCM
    };
}
