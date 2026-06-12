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
let configuredAllowedOrigins = null;
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

function defaultFeedPCMToModule(buffer, channels, sampleRate, samplesPerChannel) {
    const moduleInstance = currentProjectMModule();
    if (!moduleCanAcceptExternalPCM(moduleInstance)) return false;

    let ptr = 0;
    let usedPrealloc = false;
    if (buffer.length <= pcmTransferCap) {
        ptr = ensurePcmTransferBuffer(moduleInstance);
        usedPrealloc = !!ptr;
    }

    if (!ptr) {
        ptr = moduleInstance._malloc(buffer.length * 4);
        if (!ptr) return false;
    }

    try {
        moduleInstance.HEAPF32.set(buffer, ptr >> 2);
        moduleInstance._projectm_pcm_add_float_wrapper(0, ptr, samplesPerChannel, channels);
        console.debug('[projectM external PCM] fed chunk', {
            channels,
            samplesPerChannel,
            totalSamples: buffer.length,
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

export function feedPCMToModule(buffer, channels = 2, sampleRate) {
    const payload = normalizePcmPayload(buffer, channels, sampleRate);
    if (!payload) return false;

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

export function setupExternalAudioReceiver({ onFeed, allowedOrigins, preallocSize } = {}) {
    customFeed = typeof onFeed === 'function' ? onFeed : null;
    configuredAllowedOrigins = allowedOrigins ? normalizedOriginList(allowedOrigins) : DEFAULT_EXTERNAL_PCM_ORIGINS;
    pcmTransferCap = Number.isFinite(preallocSize) && preallocSize > 0
        ? Math.floor(preallocSize)
        : DEFAULT_PCM_TRANSFER_CAP;

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
