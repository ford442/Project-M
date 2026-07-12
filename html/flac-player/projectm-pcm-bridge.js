// projectM PCM bridge for the in-repo FLAC player shell (html/flac-player/index.html).
//
// Why this exists: the FLAC player's own (externally-built, minified) bundle only
// ships PCM to projectM over a BroadcastChannel("projectm-audio"). BroadcastChannel
// is *same-origin only*, so when the player is opened as a cross-origin popup
// (https://go.1ink.us/flac-player/) from the projectM host, the audio never arrives — see
// DIAGNOSIS_MOD_FLAC_PLAYER_CONNECTION.md. The host receiver
// (html/projectm-external-pcm.js) already accepts the cross-origin-safe
// `window.postMessage` path; this module supplies the matching sender without
// needing to rebuild the player bundle.
//
// It works by patching the Web Audio graph at the prototype level *before* the
// bundle builds its graph: whenever any node connects to `context.destination`,
// we also tap it into a passive AnalyserNode and stream that analyser's
// time-domain PCM to the projectM host via postMessage (opener for popups,
// parent for iframes), plus the legacy BroadcastChannel for same-origin hosts.
//
// Contract (matches projectm-external-pcm.js):
//   target.postMessage({ type: 'pcm', buffer: Float32Array, channels: 1, sampleRate }, '*')

export const AUDIO_CHANNEL_NAME = 'projectm-audio';
export const DEFAULT_FFT_SIZE = 2048;

// The window the player should feed: the opener (popup case) or the embedding
// parent (iframe case). Null when the page is standalone (nothing to feed).
export function resolveFeedTarget(win) {
    if (win.opener && win.opener !== win) return win.opener;
    if (win.parent && win.parent !== win) return win.parent;
    return null;
}

// True when this page is acting as a projectM audio feeder rather than a
// standalone player: explicit ?projectm=1, the popup window.name the host uses,
// or simply having an opener/parent to feed.
export function isProjectMFeederMode(win) {
    let params;
    try {
        params = new URLSearchParams(win.location.search);
    } catch {
        params = null;
    }
    if (params && params.get('projectm') === '1') return true;
    if (win.name === 'flac-player') return true;
    if (win.name === 'mod-player') return true;
    return !!resolveFeedTarget(win);
}

// Build the PCM sender. Sends over postMessage (primary, cross-origin safe) and,
// when available, the legacy BroadcastChannel (same-origin hosts only).
export function createPcmSender({ target, broadcastChannel = null } = {}) {
    return function send(buffer, channels, sampleRate) {
        if (target && typeof target.postMessage === 'function') {
            try {
                target.postMessage({ type: 'pcm', buffer, channels, sampleRate }, '*');
            } catch (error) {
                console.debug('[projectM FLAC bridge] postMessage failed (non-fatal):', error);
            }
        }
        if (broadcastChannel) {
            try {
                broadcastChannel.postMessage({ type: 'pcm', buffer, channels });
            } catch (error) {
                console.debug('[projectM FLAC bridge] BroadcastChannel post failed (non-fatal):', error);
            }
        }
    };
}

// Install the bridge. Injectables (windowRef, audioNodeProto, requestFrame, …)
// exist so the wiring can be unit-tested without a real browser/Web Audio stack.
// Returns { installed, uninstall }.
export function installProjectMPcmBridge({
    windowRef = typeof window !== 'undefined' ? window : undefined,
    audioNodeProto,
    requestFrame,
    cancelFrame,
    broadcastChannelCtor,
    fftSize = DEFAULT_FFT_SIZE,
    channelName = AUDIO_CHANNEL_NAME,
    force = false
} = {}) {
    const noop = { installed: false, uninstall() {} };
    if (!windowRef) return noop;
    if (!force && !isProjectMFeederMode(windowRef)) return noop;

    const proto = audioNodeProto
        || (windowRef.AudioNode && windowRef.AudioNode.prototype);
    if (!proto || typeof proto.connect !== 'function') {
        console.debug('[projectM FLAC bridge] AudioNode.connect unavailable; bridge inactive');
        return noop;
    }

    const raf = requestFrame
        || (windowRef.requestAnimationFrame && windowRef.requestAnimationFrame.bind(windowRef));
    const caf = cancelFrame
        || (windowRef.cancelAnimationFrame && windowRef.cancelAnimationFrame.bind(windowRef));
    if (typeof raf !== 'function') {
        console.debug('[projectM FLAC bridge] requestAnimationFrame unavailable; bridge inactive');
        return noop;
    }

    const BC = broadcastChannelCtor || windowRef.BroadcastChannel;
    let broadcastChannel = null;
    if (typeof BC === 'function') {
        try {
            broadcastChannel = new BC(channelName);
        } catch (error) {
            console.debug('[projectM FLAC bridge] BroadcastChannel unavailable:', error);
        }
    }

    const send = createPcmSender({ target: resolveFeedTarget(windowRef), broadcastChannel });

    const tapsByContext = new WeakMap();
    const pumpHandles = [];

    function startPump(context, analyser) {
        const buf = new Float32Array(analyser.fftSize || fftSize);
        const handle = { id: 0, active: true };
        const tick = () => {
            if (!handle.active) return;
            analyser.getFloatTimeDomainData(buf);
            // Mono time-domain samples — host duplicates to stereo and trims to
            // its 576-sample analysis window.
            send(buf.slice(0), 1, context.sampleRate);
            handle.id = raf(tick);
        };
        handle.id = raf(tick);
        pumpHandles.push(handle);
    }

    function ensureTap(context) {
        if (tapsByContext.has(context)) return tapsByContext.get(context);
        const analyser = context.createAnalyser();
        if (typeof fftSize === 'number') {
            try { analyser.fftSize = fftSize; } catch { /* clamp errors ignored */ }
        }
        tapsByContext.set(context, analyser);
        startPump(context, analyser);
        return analyser;
    }

    const originalConnect = proto.connect;
    proto.connect = function patchedConnect(destination, ...rest) {
        const result = originalConnect.apply(this, arguments);
        try {
            const context = this.context;
            if (context && destination && destination === context.destination) {
                const analyser = ensureTap(context);
                // Passive sink: feed the source into our analyser too. The
                // analyser is not connected onward, so playback is unaffected.
                originalConnect.call(this, analyser);
            }
        } catch (error) {
            console.debug('[projectM FLAC bridge] tap connect failed (non-fatal):', error);
        }
        return result;
    };

    return {
        installed: true,
        uninstall() {
            proto.connect = originalConnect;
            for (const handle of pumpHandles) {
                handle.active = false;
                if (typeof caf === 'function' && handle.id) caf(handle.id);
            }
            pumpHandles.length = 0;
            if (broadcastChannel) {
                try { broadcastChannel.close(); } catch { /* ignore */ }
                broadcastChannel = null;
            }
        }
    };
}
