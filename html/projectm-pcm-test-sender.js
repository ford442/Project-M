// projectm-pcm-test-sender.js
//
// A stand-in for the external players while developing the PCM bridge: a tone
// (or the microphone) analysed on this page and posted to projectM exactly the
// way the FLAC/MOD players post it — `{ type: 'pcm', buffer, channels: 1 }` to
// the opener and the parent, and on the legacy BroadcastChannel('projectm-audio')
// for hosts that only listen there.
//
// It moved here from projectm-core.html's inline script. The page shell
// (projectm-app-shell.js) publishes start/stop as
// `window.startLocalProjectMTestSender(useMic)` / `window.stopLocalProjectMTestSender()`
// for the console, and the UI shows the small debug panel on localhost or with
// ?debugSender.

/**
 * @typedef {object} PcmTestSender
 * @property {(useMic?: boolean) => Promise<void>} start
 * @property {() => void} stop
 * @property {() => boolean} running
 * @property {() => void} dispose Same as stop().
 */

/**
 * @param {object} [options]
 * @param {Window & typeof globalThis} [options.windowRef]
 * @returns {PcmTestSender}
 */
export function createPcmTestSender({ windowRef = window } = {}) {
    /** @type {number | null} */
    let raf = null;
    /** @type {AudioContext | null} */
    let context = null;
    /** @type {BroadcastChannel | null} */
    let channel = null;
    /** @type {MediaStream | null} */
    let stream = null;
    let starting = false;

    /** @param {{ type: 'pcm', buffer: Float32Array, channels: number }} message */
    function post(message) {
        try {
            if (windowRef.opener) windowRef.opener.postMessage(message, '*');
            if (windowRef.parent && windowRef.parent !== windowRef) windowRef.parent.postMessage(message, '*');
        } catch {
            // A cross-origin opener that went away: the BroadcastChannel post still runs.
        }
        try {
            channel?.postMessage(message);
        } catch {
            // Closed between frames.
        }
    }

    function stop() {
        if (raf !== null) windowRef.cancelAnimationFrame(raf);
        raf = null;
        for (const track of stream?.getTracks() ?? []) track.stop();
        stream = null;
        try {
            channel?.close();
        } catch {
            // already closed
        }
        channel = null;
        if (context) {
            void context.close().catch(() => {});
        }
        context = null;
    }

    /** @param {boolean} [useMic] */
    async function start(useMic = false) {
        if (raf !== null || starting) {
            console.warn('[projectM Test Sender] already running');
            return;
        }
        starting = true;
        try {
            const Ctor = windowRef.AudioContext ?? /** @type {any} */ (windowRef).webkitAudioContext;
            const audioContext = /** @type {AudioContext} */ (new Ctor());
            context = audioContext;
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0.2;

            let usingMic = false;
            if (useMic) {
                try {
                    const granted = await windowRef.navigator.mediaDevices.getUserMedia({ audio: true });
                    if (context !== audioContext) {
                        // stop() ran while the permission prompt was up.
                        for (const track of granted.getTracks()) track.stop();
                        return;
                    }
                    stream = granted;
                    audioContext.createMediaStreamSource(stream).connect(analyser);
                    usingMic = true;
                    console.log('[projectM Test Sender] Using microphone input for projectM PCM');
                } catch (error) {
                    console.error('[projectM Test Sender] Mic access denied, falling back to a generated tone', error);
                }
            }
            if (context !== audioContext) return; // stopped while the mic prompt was up
            if (!usingMic) {
                const osc = audioContext.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.value = 110;
                const gain = audioContext.createGain();
                gain.gain.value = 0.3;
                const filter = audioContext.createBiquadFilter();
                filter.type = 'lowpass';
                filter.frequency.value = 800;
                osc.connect(filter);
                filter.connect(gain);
                gain.connect(analyser);
                osc.start();
                console.log('[projectM Test Sender] Using a generated tone (saw + filter) for projectM PCM');
            }

            channel = new BroadcastChannel('projectm-audio');
            const buf = new Float32Array(analyser.fftSize);
            const tick = () => {
                analyser.getFloatTimeDomainData(buf);
                // A copy: the analyser's view is live.
                post({ type: 'pcm', buffer: buf.slice(0), channels: 1 });
                raf = windowRef.requestAnimationFrame(tick);
            };
            raf = windowRef.requestAnimationFrame(tick);
            console.log('[projectM Test Sender] Running. Call window.stopLocalProjectMTestSender() to stop.');
        } finally {
            starting = false;
        }
    }

    return {
        start,
        stop,
        running: () => raf !== null,
        dispose: stop,
    };
}
