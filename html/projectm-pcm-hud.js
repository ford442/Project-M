// projectm-pcm-hud.js
//
// Debug readout for the PCM path: frames per second arriving at the host's
// external-PCM ingress (iframe / popup players), frames per second handed to
// the engine, and frames per second the engine actually drained from its PCM
// ring — which, in the OffscreenCanvas topology, is the render worker's
// consumption, read from the ring header the worker reports in its stats.
//
// Real-time audio is ~44100 / 48000 frames per second at every stage. A host
// rate well above that means several producers are feeding at once (the
// overlapping-feed bug this readout was added for); an engine rate of 0 with a
// non-zero host rate means the samples never reach the worker; overruns that
// keep climbing mean the ring is written faster than it is drained.
//
// Always installs `globalThis.projectMPcmStats()` (cheap; tests and console
// use it). The on-screen overlay shows with `?pcmhud=1`, or
// `localStorage['projectm-pcm-hud'] = '1'`.

import { getExternalPcmStats } from './projectm-external-pcm.js';
import { readPcmRingCounters, readPcmRingDescriptor } from './projectm-pcm-ring.js';

/**
 * @typedef {import('./projectm-transport-types.ts').RenderTransport} RenderTransport
 * @typedef {import('./projectm-render-worker-types.ts').PcmRingCounters} PcmRingCounters
 */

/**
 * @typedef {object} PcmHudSnapshot
 * @property {number} hostFramesReceived
 * @property {number} hostFramesFed
 * @property {PcmRingCounters | null} ring
 * @property {number} [ringAt] When `ring` was read (ms). Defaults to the sample time.
 */

/**
 * @typedef {object} PcmHudRates
 * @property {number} hostFps Frames/s accepted at the host ingress.
 * @property {number} fedFps Frames/s handed to the engine (or the worker).
 * @property {number | null} ringWriteFps Frames/s written to the engine's ring.
 * @property {number | null} engineFps Frames/s the engine drained (the worker, in that topology).
 * @property {number | null} overruns Ring overruns since the engine started.
 * @property {number} hostFramesReceived
 * @property {number} hostFramesFed
 */

/** Span the ring rates are averaged over. */
export const RATE_WINDOW_MS = 2000;

/**
 * Forward distance between two ring indices that wrap at `modulus`.
 * @param {number} prev
 * @param {number} next
 * @param {number} modulus
 * @returns {number}
 */
export function ringDelta(prev, next, modulus) {
    if (!(modulus > 0)) return Math.max(0, next - prev);
    return ((next - prev) % modulus + modulus) % modulus;
}

/**
 * Turns successive counter snapshots into rates. Pure, so it is testable
 * without a page.
 * @param {{ windowMs?: number }} [options]
 * @returns {{ sample(snapshot: PcmHudSnapshot, now: number): PcmHudRates }}
 */
export function createPcmRateMeter({ windowMs = RATE_WINDOW_MS } = {}) {
    /** @type {{ snapshot: PcmHudSnapshot, now: number } | null} */
    let prev = null;
    /** Ring readings, oldest first, spanning at least `windowMs` once warm. @type {{ ring: PcmRingCounters, at: number }[]} */
    let readings = [];
    let ringWriteFps = /** @type {number | null} */ (null);
    let engineFps = /** @type {number | null} */ (null);

    return {
        sample(snapshot, now) {
            let hostFps = 0;
            let fedFps = 0;
            if (prev && now > prev.now) {
                const seconds = (now - prev.now) / 1000;
                hostFps = Math.max(0, snapshot.hostFramesReceived - prev.snapshot.hostFramesReceived) / seconds;
                fedFps = Math.max(0, snapshot.hostFramesFed - prev.snapshot.hostFramesFed) / seconds;
            }

            const ring = snapshot.ring;
            // The reader's own timestamp when it has one (the worker's clock),
            // so report jitter between threads does not read as rate changes.
            const ringAt = ring?.sampledAt ?? snapshot.ringAt ?? now;
            const last = readings[readings.length - 1];
            if (!ring) {
                readings = [];
                ringWriteFps = null;
                engineFps = null;
            } else if (!last || last.ring.indexModulus !== ring.indexModulus || ringAt < last.at) {
                readings = [{ ring, at: ringAt }];
            } else if (ringAt > last.at) {
                // Only a new reading moves the rate; the worker reports twice a
                // second, and re-reading the same report would read as silence.
                // The engine drains once per rendered frame, so a single
                // half-second window swings with frame pacing: rate over the
                // last `windowMs` instead.
                readings.push({ ring, at: ringAt });
                while (readings.length > 2 && ringAt - readings[1].at >= windowMs) {
                    readings.shift();
                }
                let written = 0;
                let drained = 0;
                for (let i = 1; i < readings.length; i++) {
                    const a = readings[i - 1].ring;
                    const b = readings[i].ring;
                    written += ringDelta(a.writeIndex, b.writeIndex, b.indexModulus);
                    drained += ringDelta(a.readIndex, b.readIndex, b.indexModulus);
                }
                const seconds = (ringAt - readings[0].at) / 1000;
                ringWriteFps = written / seconds;
                engineFps = drained / seconds;
            }

            prev = { snapshot, now };
            return {
                hostFps,
                fedFps,
                ringWriteFps,
                engineFps,
                overruns: ring ? ring.overruns : null,
                hostFramesReceived: snapshot.hostFramesReceived,
                hostFramesFed: snapshot.hostFramesFed,
            };
        },
    };
}

/**
 * Where the engine's ring counters come from: the module on this thread, or
 * the render worker's latest stats message.
 *
 * @param {RenderTransport | null | undefined} transport
 * @returns {{ ring: PcmRingCounters | null, source: object | null }}
 *   `source` changes identity whenever a new reading is available.
 */
export function readTransportRingCounters(transport) {
    if (!transport) return { ring: null, source: null };
    if (transport.topology === 'worker') {
        const stats = transport.workerHandle?.getLastStats() ?? null;
        return { ring: stats?.pcmRing ?? null, source: stats };
    }
    const module = /** @type {import('./projectm-host-types.ts').ProjectMModuleLike | null} */ (transport.module);
    const ring = readPcmRingCounters(readPcmRingDescriptor(module));
    return { ring, source: ring };
}

/** @param {number | null} fps */
function formatFps(fps) {
    if (fps === null) return 'n/a';
    return fps >= 1000 ? (fps / 1000).toFixed(1) + 'k' : fps.toFixed(0);
}

/**
 * One line of HUD text.
 * @param {PcmHudRates} rates
 * @param {import('./projectm-external-pcm.js').ExternalPcmStats} stats
 * @param {string} topology
 * @returns {string}
 */
export function formatPcmHudText(rates, stats, topology) {
    const engineLabel = topology === 'worker' ? 'worker' : 'engine';
    const format = stats.lastChannels
        ? ` · ${stats.lastChannels}ch${stats.lastSampleRate ? ' @' + stats.lastSampleRate : ''}`
        : '';
    const producer = stats.lastProducer ? ` · ${stats.lastProducer}` : '';
    return `PCM host ${formatFps(rates.hostFps)} fr/s (fed ${formatFps(rates.fedFps)})`
        + ` · ${engineLabel} ${formatFps(rates.engineFps)} fr/s`
        + ` · ring in ${formatFps(rates.ringWriteFps)}`
        + ` · overruns ${rates.overruns ?? 'n/a'}`
        + format
        + producer
        + ` · dropped dup ${stats.dropped.duplicate} superseded ${stats.dropped.superseded} gated ${stats.dropped.gated}`;
}

/**
 * @param {Window | undefined} windowRef
 * @returns {boolean}
 */
function hudRequested(windowRef) {
    try {
        if (new URLSearchParams(windowRef?.location?.search ?? '').get('pcmhud') === '1') return true;
    } catch (_) {
        // No location.
    }
    try {
        return windowRef?.localStorage?.getItem('projectm-pcm-hud') === '1';
    } catch (_) {
        return false;
    }
}

const HUD_ID = 'pm-pcm-hud';

/**
 * Starts sampling the PCM counters for `transport`.
 *
 * @param {object} options
 * @param {RenderTransport | null} options.transport
 * @param {any} [options.windowRef]
 * @param {Document} [options.documentRef]
 * @param {number} [options.intervalMs]
 * @param {boolean} [options.visible] Overrides the `?pcmhud=1` check.
 * @returns {() => void} Stops sampling and removes the overlay.
 */
export function setupPcmHud({
    transport,
    windowRef = typeof window !== 'undefined' ? window : undefined,
    documentRef = typeof document !== 'undefined' ? document : undefined,
    intervalMs = 1000,
    visible,
}) {
    const meter = createPcmRateMeter();
    const topology = transport?.topology ?? 'main';
    const showOverlay = visible ?? hudRequested(windowRef);
    /** @type {HTMLElement | null} */
    let overlay = null;
    /** @type {object | null} */
    let lastRingSource = null;
    let lastRingAt = 0;
    /** @type {(PcmHudRates & { topology: string, ingress: ReturnType<typeof getExternalPcmStats> }) | null} */
    let latest = null;

    const tick = () => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const stats = getExternalPcmStats();
        const { ring, source } = readTransportRingCounters(transport);
        if (source !== lastRingSource) {
            lastRingSource = source;
            lastRingAt = now;
        }
        const rates = meter.sample({
            hostFramesReceived: stats.framesReceived,
            hostFramesFed: stats.framesFed,
            ring,
            ringAt: lastRingAt,
        }, now);
        latest = { ...rates, topology, ingress: stats };
        if (showOverlay && documentRef?.body) {
            if (!overlay) {
                overlay = documentRef.getElementById(HUD_ID) ?? documentRef.createElement('div');
                overlay.id = HUD_ID;
                overlay.setAttribute('style', 'position:fixed;left:8px;bottom:8px;z-index:99997;'
                    + 'padding:4px 8px;background:rgba(0,0,0,0.7);color:#9ef;'
                    + 'font:11px/1.4 monospace;pointer-events:none;white-space:pre');
                documentRef.body.appendChild(overlay);
            }
            overlay.textContent = formatPcmHudText(rates, stats, topology);
        }
    };

    tick();
    const timer = setInterval(tick, intervalMs);
    const g = /** @type {any} */ (globalThis);
    const statsFn = () => latest;
    g.projectMPcmStats = statsFn;

    return () => {
        clearInterval(timer);
        if (g.projectMPcmStats === statsFn) {
            delete g.projectMPcmStats;
        }
        overlay?.remove();
        overlay = null;
    };
}
