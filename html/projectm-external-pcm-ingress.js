// Ingress policy and counters for projectm-external-pcm.js: which external
// PCM chunks get fed (tagged producers win over untagged ones, postMessage
// over BroadcastChannel, repeats dropped) and the page-wide stats the PCM HUD
// reads. Split out of projectm-external-pcm.js, which re-exports the public
// names.

/**
 * How long a tagged producer (one that sends `producer` + `seq`, such as
 * html/projectm-pcm-bridge.js) keeps untagged PCM out after its
 * last chunk, and how long a postMessage chunk keeps untagged BroadcastChannel
 * PCM out.
 *
 * Why: the FLAC player shell posts its own tagged, real-time stereo stream,
 * but the vendored player bundle still runs its own senders (an AnalyserNode
 * polled per animation frame, and its AudioWorklet's PCM callback), each to
 * both the parent window and the BroadcastChannel. A same-origin host hears
 * all of them. Fed together they put ~3.5x real-time, overlapping audio into
 * the engine's PCM ring, which overran constantly and stopped presets from
 * tracking the beat. One producer, one transport.
 */
export const TAGGED_PRODUCER_HOLD_MS = 1000;
/** Recent sequence numbers remembered per producer, to drop repeats. */
const RECENT_SEQ_LIMIT = 128;

const ingressPolicy = {
    lastTaggedAt: -Infinity,
    lastPostMessageAt: -Infinity,
    /** @type {Map<string, { set: Set<number>, order: number[] }>} */
    recentSeqByProducer: new Map(),
};

/**
 * @typedef {object} ExternalPcmStats
 * @property {number} chunksReceived Chunks that arrived at the page ingress.
 * @property {number} framesReceived Per-channel frames in accepted chunks.
 * @property {number} chunksFed
 * @property {number} framesFed Per-channel frames handed to the engine.
 * @property {{ origin: number, duplicate: number, superseded: number, invalid: number, gated: number, queued: number }} dropped
 * @property {number | null} lastSampleRate
 * @property {number | null} lastChannels
 * @property {string | null} lastProducer
 * @property {'postMessage' | 'broadcast' | null} lastVia
 * @property {number} lastPeak Absolute peak of the last accepted chunk.
 */

/** @returns {ExternalPcmStats} */
function freshStats() {
    return {
        chunksReceived: 0,
        framesReceived: 0,
        chunksFed: 0,
        framesFed: 0,
        dropped: { origin: 0, duplicate: 0, superseded: 0, invalid: 0, gated: 0, queued: 0 },
        lastSampleRate: null,
        lastChannels: null,
        lastProducer: null,
        lastVia: null,
        lastPeak: 0,
    };
}

/** Mutated in place: reset with {@link resetIngressState}. */
export const pcmStats = freshStats();

/**
 * Snapshot of the page-wide external PCM counters (see the PCM HUD,
 * html/projectm-pcm-hud.js). Counters only grow; rates are the caller's job.
 * @returns {ExternalPcmStats}
 */
export function getExternalPcmStats() {
    return { ...pcmStats, dropped: { ...pcmStats.dropped } };
}

function nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

/**
 * @param {string} producer
 * @param {number} seq
 * @returns {boolean} true when this (producer, seq) was seen recently.
 */
function rememberSeq(producer, seq) {
    let recent = ingressPolicy.recentSeqByProducer.get(producer);
    if (!recent) {
        recent = { set: new Set(), order: [] };
        ingressPolicy.recentSeqByProducer.set(producer, recent);
    }
    if (recent.set.has(seq)) return true;
    recent.set.add(seq);
    recent.order.push(seq);
    if (recent.order.length > RECENT_SEQ_LIMIT) {
        recent.set.delete(/** @type {number} */ (recent.order.shift()));
    }
    return false;
}

/**
 * Ingress policy for one `{ type: 'pcm' }` message: decides whether it is fed,
 * and counts it. Direct `feedPCMToModule` calls bypass this.
 *
 * @param {any} data The message payload.
 * @param {'postMessage' | 'broadcast'} via
 * @param {number} [now]
 * @returns {boolean} true when the chunk should be fed.
 */
export function acceptExternalPcmChunk(data, via, now = nowMs()) {
    pcmStats.chunksReceived += 1;
    const producer = typeof data.producer === 'string' && data.producer ? data.producer : null;
    const seq = Number.isFinite(data.seq) ? Number(data.seq) : null;

    if (producer && seq !== null) {
        if (rememberSeq(producer, seq)) {
            pcmStats.dropped.duplicate += 1;
            return false;
        }
        ingressPolicy.lastTaggedAt = now;
    } else {
        if (now - ingressPolicy.lastTaggedAt < TAGGED_PRODUCER_HOLD_MS) {
            pcmStats.dropped.superseded += 1;
            return false;
        }
        if (via === 'broadcast' && now - ingressPolicy.lastPostMessageAt < TAGGED_PRODUCER_HOLD_MS) {
            pcmStats.dropped.duplicate += 1;
            return false;
        }
    }
    if (via === 'postMessage') {
        ingressPolicy.lastPostMessageAt = now;
    }

    const buffer = data.buffer;
    if (buffer instanceof Float32Array) {
        const channels = data.channels === 1 ? 1 : 2;
        pcmStats.framesReceived += channels === 1 ? buffer.length : buffer.length >> 1;
        let peak = 0;
        for (let i = 0; i < buffer.length; i++) {
            const abs = Math.abs(buffer[i]);
            if (abs > peak) peak = abs;
        }
        pcmStats.lastPeak = peak;
        pcmStats.lastChannels = channels;
    }
    pcmStats.lastSampleRate = Number.isFinite(data.sampleRate) ? Number(data.sampleRate) : null;
    pcmStats.lastProducer = producer;
    pcmStats.lastVia = via;
    return true;
}

/** Forget which producers and transports were heard recently. */
export function resetIngressPolicy() {
    ingressPolicy.lastTaggedAt = -Infinity;
    ingressPolicy.lastPostMessageAt = -Infinity;
    ingressPolicy.recentSeqByProducer.clear();
}

/** Reset the counters and the ingress policy (test helper path). */
export function resetIngressState() {
    Object.assign(pcmStats, freshStats());
    resetIngressPolicy();
}
