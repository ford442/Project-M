import { feedPcmFloat } from './generated/projectm-wasm-api.js';
import { feedPcmThroughRing } from './projectm-pcm-ring.js';

/**
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 * @typedef {import('./projectm-host-types.ts').ExternalPcmFeedFn} ExternalPcmFeedFn
 * @typedef {import('./projectm-host-types.ts').ExternalPcmChunk} ExternalPcmChunk
 * @typedef {import('./projectm-transport-types.ts').RenderTransport} RenderTransport
 */

/**
 * The render transport to feed, when the host has one.
 *
 * External PCM arrives on the main thread by postMessage regardless of where
 * rendering happens, so this is the seam where it learns which engine to hand
 * the samples to. Unset (the default) keeps the historical behaviour of
 * reaching for `globalThis.Module`.
 *
 * @type {RenderTransport | null}
 */
let renderTransport = null;

/**
 * Registers (or clears, with null) the transport external PCM should feed.
 *
 * @param {RenderTransport | null} transport
 */
export function setExternalPcmTransport(transport) {
    renderTransport = transport;
}

const AUDIO_CHANNEL_NAME = 'projectm-audio';
/**
 * First-party players / hosts that postMessage PCM into the visualizer.
 * Keep in sync with html/projectm-audio-player.js (go.1ink.us shells) and
 * panel embeds that still open flac.1ink.us / mod.1ink.us.
 * The page's own origin is always trusted at runtime (see allowedOriginSet).
 */
export const DEFAULT_EXTERNAL_PCM_ORIGINS = Object.freeze([
    'https://go.1ink.us',
    'https://test.1ink.us',
    'https://projectm.1ink.us',
    'https://flac.1ink.us',
    'https://mod.1ink.us',
]);
const LOCAL_STORAGE_ORIGIN_KEYS = [
    'externalPcmOrigins',
    'externalPcmAllowedOrigins'
];
const MAX_PENDING_EXTERNAL_PCM = 24;
const DEFAULT_PCM_TRANSFER_CAP = 2048;
const GAIN_STORAGE_KEYS = ['externalPcmGain'];
const DEFAULT_EXTERNAL_PCM_GAIN = 1.0;
/** @type {string[] | null} */
let configuredAllowedOrigins = null;
let configuredGain = DEFAULT_EXTERNAL_PCM_GAIN;
let debugRmsEnabled = false;
/** @type {BroadcastChannel | null} */
let externalAudioChannel = null;
let messageListenerInstalled = false;
/** @type {ReturnType<typeof setInterval> | 0} */
let flushInterval = 0;
let pcmTransferPtr = 0;
/** @type {ProjectMModuleLike | null} */
let pcmTransferModule = null;
let pcmTransferCap = DEFAULT_PCM_TRANSFER_CAP;
/** @type {ExternalPcmFeedFn | null} */
let customFeed = null;
/** @type {(() => boolean) | null} */
let feedGate = null;

/** @type {ExternalPcmChunk[]} */
const pendingExternalPCM = [];

/**
 * @param {string[] | Set<string> | string | null | undefined} origins
 * @returns {string[] | null} Normalized list, or null when the caller omitted origins
 *   so the default allowlist should apply. An explicit empty list stays empty
 *   (embedder opt-out).
 */
function normalizedOriginList(origins) {
    if (origins == null) return null;
    if (origins instanceof Set) {
        return Array.from(origins).map((origin) => String(origin).trim()).filter(Boolean);
    }
    if (Array.isArray(origins)) {
        return origins.map((origin) => String(origin).trim()).filter(Boolean);
    }
    return String(origins).split(',').map((origin) => origin.trim()).filter(Boolean);
}

function readAllowedOriginsFromStorage() {
    try {
        for (const key of LOCAL_STORAGE_ORIGIN_KEYS) {
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            const values = raw.trim().startsWith('[')
                ? JSON.parse(raw)
                : raw.split(',');
            const origins = normalizedOriginList(values);
            if (origins && origins.length > 0) return origins;
        }
    } catch (_) {
        console.debug('[projectM external PCM] localStorage unavailable; using configured origin allowlist');
    }
    return null;
}

/**
 * Active allowlist for postMessage PCM. Prefer localStorage override, then the
 * value passed to setupExternalAudioReceiver / setConfiguredAllowedOrigins, then
 * {@link DEFAULT_EXTERNAL_PCM_ORIGINS}. Always includes the page's own origin so
 * same-origin iframes (e.g. /flac/ on projectm.1ink.us) are not dropped.
 *
 * @returns {Set<string>}
 */
function allowedOriginSet() {
    const fromStorage = readAllowedOriginsFromStorage();
    let origins;
    if (fromStorage) {
        origins = fromStorage;
    } else if (configuredAllowedOrigins != null) {
        origins = configuredAllowedOrigins;
    } else {
        origins = [...DEFAULT_EXTERNAL_PCM_ORIGINS];
    }
    const set = new Set(origins.map((origin) => String(origin).trim()).filter(Boolean));
    try {
        if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') {
            set.add(location.origin);
        }
    } catch (_) {
        // Non-browser / opaque origin environments.
    }
    return set;
}

/**
 * @param {string} origin
 * @returns {boolean}
 */
export function isTrustedExternalPcmOrigin(origin) {
    return allowedOriginSet().has(origin);
}

/** @param {string[] | Set<string> | string | null | undefined} origins */
export function setConfiguredAllowedOrigins(origins) {
    configuredAllowedOrigins = origins == null ? null : (normalizedOriginList(origins) ?? []);
}

/** Test helper: reset module-level receiver state between unit tests. */
export function resetExternalPcmStateForTests() {
    if (flushInterval) {
        clearInterval(flushInterval);
        flushInterval = 0;
    }
    configuredAllowedOrigins = null;
    configuredGain = DEFAULT_EXTERNAL_PCM_GAIN;
    feedGate = null;
    customFeed = null;
    renderTransport = null;
    pendingExternalPCM.length = 0;
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

// Applies the configured input gain. Returns the caller's buffer unchanged when
// the gain is unity, otherwise a fresh scaled copy — never mutates the caller's
// buffer, since queued chunks are reused on the next flush.
//
// This no longer trims to projectM's 576-sample analysis window. That trim
// existed to mirror the old AnalyserNode poll, which could only forward one
// window per animation frame and threw the rest away; feeding the whole chunk
// into the PCM ring instead is the point of the ring — the engine drains
// everything that arrived since the last frame.
/**
 * @param {Float32Array} buffer
 * @param {number} channels
 * @param {number} samplesPerChannel
 * @returns {{ samples: Float32Array; samplesPerChannel: number }}
 */
function preprocessExternalPcm(buffer, channels, samplesPerChannel) {
    const gain = externalPcmGain();
    if (gain === 1) {
        return { samples: buffer, samplesPerChannel };
    }

    const scaled = new Float32Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        scaled[i] = buffer[i] * gain;
    }
    return { samples: scaled, samplesPerChannel };
}

/**
 * @param {ProjectMModuleLike | null | undefined} moduleInstance
 * @returns {moduleInstance is ProjectMModuleLike}
 */
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

/**
 * @param {ProjectMModuleLike} moduleInstance
 * @returns {number}
 */
function ensurePcmTransferBuffer(moduleInstance) {
    if (pcmTransferModule && pcmTransferModule !== moduleInstance) {
        if (pcmTransferPtr && pcmTransferModule._free) {
            pcmTransferModule._free(pcmTransferPtr);
        }
        pcmTransferPtr = 0;
    }

    pcmTransferModule = moduleInstance;
    if (pcmTransferPtr) return pcmTransferPtr;
    if (!moduleCanAcceptExternalPCM(moduleInstance) || !moduleInstance._malloc) return 0;

    pcmTransferPtr = moduleInstance._malloc(pcmTransferCap * 4);
    return pcmTransferPtr;
}

/**
 * @param {Float32Array} buffer
 * @param {number} channels
 * @param {number | undefined} sampleRate
 */
function queueExternalPCM(buffer, channels, sampleRate) {
    if (pendingExternalPCM.length >= MAX_PENDING_EXTERNAL_PCM) {
        console.warn('[projectM external PCM] queue full, dropping oldest chunk');
        pendingExternalPCM.shift();
    }
    pendingExternalPCM.push({ buffer, channels, sampleRate });
}

/**
 * @param {Float32Array} buffer
 * @param {number} channels
 * @param {number | undefined} sampleRate
 * @param {number} samplesPerChannel
 * @returns {boolean}
 */
export function defaultFeedPCMToModule(buffer, channels, sampleRate, samplesPerChannel) {
    // With rendering in the worker there is no module on this thread to check
    // or marshal into: the transport owns the ingest and the samples cross
    // once, here. Gain still applies first, so the two topologies hear the
    // same signal.
    if (renderTransport && renderTransport.topology === 'worker') {
        const { samples } = preprocessExternalPcm(buffer, channels, samplesPerChannel);
        renderTransport.feedPcm(samples, channels);
        return true;
    }

    const moduleInstance = currentProjectMModule();
    if (!moduleCanAcceptExternalPCM(moduleInstance)) return false;
    const m = /** @type {any} */ (moduleInstance);

    const { samples, samplesPerChannel: framesPerChannel } = preprocessExternalPcm(
        buffer, channels, samplesPerChannel
    );

    // Preferred path: straight into the WASM-owned PCM ring, same as every other
    // producer. The malloc/HEAPF32 marshaling below is the fallback for bundles
    // built before the ring existed.
    if (feedPcmThroughRing(m, samples, { channels })) {
        console.debug('[projectM external PCM] fed chunk to ring', {
            channels,
            samplesPerChannel: framesPerChannel,
            totalSamples: samples.length,
            sampleRate
        });
        return true;
    }

    let ptr = 0;
    let usedPrealloc = false;
    if (samples.length <= pcmTransferCap) {
        ptr = ensurePcmTransferBuffer(moduleInstance);
        usedPrealloc = !!ptr;
    }

    if (!ptr) {
        feedPcmFloat(m, samples, framesPerChannel, channels);
        console.debug('[projectM external PCM] fed chunk', {
            channels,
            samplesPerChannel: framesPerChannel,
            totalSamples: samples.length,
            sampleRate
        });
        return true;
    }

    try {
        m.HEAPF32.set(samples, ptr >> 2);
        m._projectm_pcm_add_float_wrapper(0, ptr, framesPerChannel, channels);
        console.debug('[projectM external PCM] fed chunk', {
            channels,
            samplesPerChannel: framesPerChannel,
            totalSamples: samples.length,
            sampleRate
        });
        return true;
    } finally {
        if (!usedPrealloc && ptr && m._free) {
            m._free(ptr);
        }
    }
}

/**
 * @param {unknown} buffer
 * @param {number} [channels]
 * @param {number} [sampleRate]
 * @returns {{ buffer: Float32Array; channels: number; sampleRate: number | undefined; samplesPerChannel: number } | null}
 */
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

/** @param {Float32Array} buffer */
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

/**
 * @param {unknown} buffer
 * @param {number} [channels]
 * @param {number} [sampleRate]
 * @returns {boolean}
 */
export function feedPCMToModule(buffer, channels = 2, sampleRate) {
    const payload = normalizePcmPayload(buffer, channels, sampleRate);
    if (!payload) return false;

    if (feedGate && !feedGate()) {
        return false;
    }

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
        if (!next) break;
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
    feedGate = null;
    closeExternalAudioChannel();
    if (pcmTransferPtr && pcmTransferModule && pcmTransferModule._free) {
        pcmTransferModule._free(pcmTransferPtr);
    }
    pcmTransferPtr = 0;
    pcmTransferModule = null;
}

/**
 * @param {number} gain
 * @returns {number}
 */
export function setExternalPcmGain(gain) {
    configuredGain = Number.isFinite(gain) && gain > 0 ? gain : DEFAULT_EXTERNAL_PCM_GAIN;
    return configuredGain;
}

/**
 * @param {object} [options]
 * @param {ExternalPcmFeedFn} [options.onFeed]
 * @param {() => boolean} [options.feedGate] When it returns false, PCM is dropped
 *   (not queued). Used by {@link AudioSourceRouter} for exclusive-source policy.
 * @param {string[] | Set<string> | string} [options.allowedOrigins]
 * @param {number} [options.preallocSize]
 * @param {number} [options.gain]
 * @param {boolean} [options.debugRms]
 * @returns {{ feedPCMToModule: typeof feedPCMToModule; flushQueuedExternalPCM: typeof flushQueuedExternalPCM; close: () => void }}
 */
export function setupExternalAudioReceiver({
    onFeed,
    feedGate: feedGateOption,
    allowedOrigins,
    preallocSize,
    gain,
    debugRms,
} = {}) {
    customFeed = typeof onFeed === 'function' ? onFeed : null;
    feedGate = typeof feedGateOption === 'function' ? feedGateOption : null;
    // null/undefined → defaults; explicit [] disables all remote origins (same-origin still allowed).
    configuredAllowedOrigins = allowedOrigins === undefined
        ? null
        : (normalizedOriginList(allowedOrigins) ?? []);
    pcmTransferCap = preallocSize !== undefined && Number.isFinite(preallocSize) && preallocSize > 0
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
