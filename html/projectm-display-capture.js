// Tab / system audio capture for projectM via getDisplayMedia().
//
// Drives html/audio-capture.html: the user shares a browser tab (or a screen
// with "share system audio"), the video track is dropped at once, and the
// audio track is tapped by the same AudioWorklet capture processor the FLAC
// player bridge uses (html/flac-player/projectm-pcm-bridge.js), so the host
// receiver (html/projectm-external-pcm.js) sees exactly the contract it already
// handles:
//
//   { type: 'pcm', buffer: Float32Array, channels: 2, sampleRate, producer, seq }
//
// posted to window.opener (popup) or window.parent (iframe), or — only when
// there is no window to post to, e.g. the page was opened in its own tab, or
// COOP severed the opener — on BroadcastChannel("projectm-audio"). Never both:
// a same-origin host listens on both and would feed every block twice.
//
// DRM: tab capture of protected media (Spotify, Netflix, Apple Music … in a
// browser tab) usually yields digital silence, because the browser blanks
// Encrypted Media Extensions output in captures. The capture still "works";
// it just carries zeros. Capturing a desktop app (screen share with system
// audio, Windows/ChromeOS Chrome only) avoids EME, but whether the app's own
// output is captured is up to the OS.

import {
    AUDIO_CHANNEL_NAME,
    CAPTURE_PROCESSOR_NAME,
    CAPTURE_PROCESSOR_SOURCE,
    DEFAULT_BLOCK_FRAMES,
    createPcmSender,
    interleaveStereo,
    resolveFeedTarget,
} from './flac-player/projectm-pcm-bridge.js';

export const DISPLAY_CAPTURE_PRODUCER = 'projectm-display-capture';

/**
 * How long a running capture may deliver only silence before the status says
 * so. Long enough to ride out a track gap; short enough to explain a DRM tab.
 */
export const SILENCE_HINT_MS = 4000;

/**
 * @typedef {'idle' | 'requesting' | 'capturing' | 'silent' | 'no-audio' | 'denied'
 *   | 'unsupported' | 'error' | 'stopped'} CaptureState
 */

/**
 * @typedef {object} CaptureStatus
 * @property {CaptureState} state
 * @property {string} message Human-readable, for the status line.
 */

/**
 * getDisplayMedia() options: prefer a browser tab, still allow a window or a
 * screen (with system audio where the platform offers it), and turn off the
 * voice-call processing that would otherwise squash music.
 *
 * Chrome requires `video` to be requested; the track is stopped as soon as it
 * arrives. Unknown members are ignored by browsers that lack them.
 *
 * @returns {Record<string, any>}
 */
export function buildDisplayMediaOptions() {
    return {
        video: { displaySurface: 'browser' },
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: { ideal: 2 },
            // Keep the captured tab audible to the user.
            suppressLocalAudioPlayback: false,
        },
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
        monitorTypeSurfaces: 'include',
    };
}

/**
 * Maps a getDisplayMedia() rejection to a status.
 * @param {unknown} error
 * @returns {CaptureStatus}
 */
export function describeCaptureError(error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
        return {
            state: 'denied',
            message: 'Permission denied or the share dialog was cancelled.',
        };
    }
    if (name === 'NotSupportedError' || name === 'TypeError') {
        return {
            state: 'unsupported',
            message: 'This browser cannot capture tab/system audio (getDisplayMedia audio unsupported).',
        };
    }
    if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'AbortError') {
        return { state: 'error', message: `Could not start capture (${name}).` };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { state: 'error', message: `Capture failed: ${detail}` };
}

/**
 * @typedef {object} DisplayAudioCapture
 * @property {() => void} stop Ends the capture and releases stream + context. Idempotent.
 * @property {() => { blocks: number, frames: number, sampleRate: number, channels: number,
 *   captureKind: string, via: 'postMessage' | 'broadcast' | 'none', lastLoudAt: number }} stats
 */

/**
 * Asks the user for a tab / screen share and streams its audio to projectM.
 * Must be called from a user gesture (getDisplayMedia() requires one).
 *
 * Resolves to null when nothing is captured (permission denied, no audio
 * track, unsupported); `onStatus` has then already said why.
 *
 * Injectables exist so the wiring can be unit-tested without a browser.
 *
 * @param {object} [options]
 * @param {(status: CaptureStatus) => void} [options.onStatus]
 * @param {any} [options.windowRef]
 * @param {any} [options.mediaDevices]
 * @param {any} [options.audioContextCtor]
 * @param {any} [options.audioWorkletNodeCtor]
 * @param {any} [options.broadcastChannelCtor]
 * @param {any} [options.blobCtor]
 * @param {(blob: Blob) => string} [options.createObjectURL]
 * @param {() => number} [options.now]
 * @param {number} [options.blockFrames]
 * @returns {Promise<DisplayAudioCapture | null>}
 */
export async function startDisplayAudioCapture({
    onStatus = () => {},
    windowRef = typeof window !== 'undefined' ? window : undefined,
    mediaDevices,
    audioContextCtor,
    audioWorkletNodeCtor,
    broadcastChannelCtor,
    blobCtor,
    createObjectURL,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    blockFrames = DEFAULT_BLOCK_FRAMES,
} = {}) {
    const win = windowRef ?? {};
    const devices = mediaDevices ?? win.navigator?.mediaDevices;
    if (!devices || typeof devices.getDisplayMedia !== 'function') {
        onStatus({
            state: 'unsupported',
            message: 'getDisplayMedia() is unavailable (needs a desktop browser and a secure https:// page).',
        });
        return null;
    }
    const AudioContextCtor = audioContextCtor ?? win.AudioContext ?? win.webkitAudioContext;
    if (typeof AudioContextCtor !== 'function') {
        onStatus({ state: 'unsupported', message: 'Web Audio (AudioContext) is unavailable.' });
        return null;
    }

    onStatus({ state: 'requesting', message: 'Choose a tab (tick “Share tab audio”) or a screen with system audio…' });

    /** @type {MediaStream} */
    let stream;
    try {
        stream = await devices.getDisplayMedia(buildDisplayMediaOptions());
    } catch (error) {
        onStatus(describeCaptureError(error));
        return null;
    }

    // Only the audio matters; the video track would just burn a capture pipeline.
    for (const track of stream.getVideoTracks()) {
        try {
            track.stop();
            stream.removeTrack(track);
        } catch { /* already ended */ }
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
        onStatus({
            state: 'no-audio',
            message: 'The share has no audio track. Pick a browser tab and tick “Share tab audio” '
                + '(or “Share system audio” for a screen), then try again.',
        });
        return null;
    }
    const audioTrack = audioTracks[0];
    const trackChannels = Number(audioTrack.getSettings?.().channelCount) || 2;

    const target = resolveFeedTarget(win);
    const BC = broadcastChannelCtor ?? win.BroadcastChannel;
    /** @type {BroadcastChannel | null} */
    let broadcastChannel = null;
    if (!target && typeof BC === 'function') {
        try {
            broadcastChannel = new BC(AUDIO_CHANNEL_NAME);
        } catch (error) {
            console.debug('[projectM display capture] BroadcastChannel unavailable:', error);
        }
    }
    const rawSend = createPcmSender({ target, broadcastChannel, producer: DISPLAY_CAPTURE_PRODUCER });

    const counters = {
        blocks: 0,
        frames: 0,
        sampleRate: 0,
        channels: trackChannels,
        captureKind: 'none',
        /** @type {'postMessage' | 'broadcast' | 'none'} */
        via: target ? 'postMessage' : (broadcastChannel ? 'broadcast' : 'none'),
        lastLoudAt: -Infinity,
    };

    let active = true;
    const startedAt = now();
    // Default sample rate: the browser picks the device rate, which is what the
    // capture is resampled to anyway. The receiver takes any rate.
    const context = new AudioContextCtor({ latencyHint: 'interactive' });
    /** @param {Float32Array} block */
    const send = (block) => {
        if (!active) return;
        counters.blocks += 1;
        counters.frames += block.length >> 1;
        counters.sampleRate = context.sampleRate;
        counters.lastLoudAt = now();
        rawSend(block, 2, context.sampleRate);
    };

    const source = context.createMediaStreamSource(stream);
    // Explicit stereo: a stereo source stays stereo, a mono one is upmixed.
    const input = context.createGain();
    try {
        input.channelCount = 2;
        input.channelCountMode = 'explicit';
        input.channelInterpretation = 'speakers';
    } catch { /* fakes / old engines */ }
    source.connect(input);
    // The capture node outputs silence into a muted gain on the destination so
    // every engine keeps pulling it. Nothing captured is played back here: the
    // shared tab already plays its own audio.
    const sink = context.createGain();
    sink.gain.value = 0;
    sink.connect(context.destination);

    /** @type {any} */
    let captureNode = null;
    /** @type {string | null} */
    let processorUrl = null;

    function attachScriptProcessor() {
        if (typeof context.createScriptProcessor !== 'function') {
            throw new Error('no AudioWorklet and no ScriptProcessor');
        }
        const processor = context.createScriptProcessor(blockFrames, 2, 2);
        processor.onaudioprocess = (/** @type {AudioProcessingEvent} */ event) => {
            const block = interleaveStereo(event.inputBuffer);
            if (block) send(block);
        };
        input.connect(processor);
        processor.connect(sink);
        counters.captureKind = 'script-processor';
        return processor;
    }

    async function attachWorklet() {
        const WorkletNode = audioWorkletNodeCtor ?? win.AudioWorkletNode;
        const BlobCtor = blobCtor ?? win.Blob;
        const makeUrl = createObjectURL ?? (win.URL?.createObjectURL ? (/** @type {Blob} */ b) => win.URL.createObjectURL(b) : null);
        if (typeof WorkletNode !== 'function' || !context.audioWorklet || typeof BlobCtor !== 'function' || !makeUrl) {
            throw new Error('AudioWorklet unavailable');
        }
        processorUrl = makeUrl(new BlobCtor([CAPTURE_PROCESSOR_SOURCE], { type: 'application/javascript' }));
        await context.audioWorklet.addModule(processorUrl);
        if (!active) return null;
        const node = new WorkletNode(context, CAPTURE_PROCESSOR_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { blockFrames },
        });
        node.port.onmessage = (/** @type {MessageEvent} */ event) => {
            if (event.data instanceof Float32Array) send(event.data);
        };
        input.connect(node);
        node.connect(sink);
        counters.captureKind = 'audio-worklet';
        return node;
    }

    /** @type {ReturnType<typeof setInterval> | 0} */
    let silenceTimer = 0;
    let silentReported = false;

    function stopInternal(/** @type {CaptureStatus | null} */ finalStatus) {
        if (!active) return;
        active = false;
        if (silenceTimer) {
            clearInterval(silenceTimer);
            silenceTimer = 0;
        }
        audioTrack.removeEventListener?.('ended', onTrackEnded);
        for (const track of stream.getTracks()) {
            try { track.stop(); } catch { /* already ended */ }
        }
        for (const node of [captureNode, input, sink, source]) {
            if (node && typeof node.disconnect === 'function') {
                try { node.disconnect(); } catch { /* already gone */ }
            }
        }
        if (captureNode?.port) captureNode.port.onmessage = null;
        if (captureNode) captureNode.onaudioprocess = null;
        captureNode = null;
        try { context.close?.(); } catch { /* already closed */ }
        if (processorUrl && win.URL?.revokeObjectURL) {
            try { win.URL.revokeObjectURL(processorUrl); } catch { /* ignore */ }
        }
        if (broadcastChannel) {
            try { broadcastChannel.close(); } catch { /* ignore */ }
            broadcastChannel = null;
        }
        if (finalStatus) onStatus(finalStatus);
    }

    // The user clicked the browser's own "Stop sharing" bar, or the shared tab closed.
    function onTrackEnded() {
        stopInternal({ state: 'stopped', message: 'Sharing ended from the browser. Click Start Capture to share again.' });
    }
    audioTrack.addEventListener?.('ended', onTrackEnded);

    try {
        captureNode = await attachWorklet();
    } catch (error) {
        if (active) {
            console.debug('[projectM display capture] AudioWorklet capture unavailable, using ScriptProcessor:', error);
            try {
                captureNode = attachScriptProcessor();
            } catch (fallbackError) {
                stopInternal(describeCaptureError(fallbackError));
                return null;
            }
        }
    }
    if (!active) return null;
    if (context.state === 'suspended' && typeof context.resume === 'function') {
        try { await context.resume(); } catch { /* resumes on the next gesture */ }
    }

    const viaLabel = counters.via === 'postMessage'
        ? (win.opener && target === win.opener ? 'the opener window' : 'the parent page')
        : (counters.via === 'broadcast' ? 'BroadcastChannel “projectm-audio”' : 'nowhere (no host page)');
    const capturingStatus = /** @type {CaptureStatus} */ ({
        state: 'capturing',
        message: `Capturing ${trackChannels >= 2 ? 'stereo' : 'mono'} audio “${audioTrack.label || 'shared audio'}” → ${viaLabel}.`,
    });
    onStatus(capturingStatus);

    // Silent blocks are not posted (the worklet skips them), so "nothing sent
    // for a while" is the signal for a paused tab or DRM-blanked audio.
    silenceTimer = setInterval(() => {
        if (!active) return;
        const quietSince = Math.max(startedAt, counters.lastLoudAt);
        const silent = now() - quietSince >= SILENCE_HINT_MS;
        if (silent && !silentReported) {
            silentReported = true;
            onStatus({
                state: 'silent',
                message: 'Capturing, but the audio is silent. Is it paused? DRM-protected players '
                    + '(e.g. Spotify web) often capture as silence.',
            });
        } else if (!silent && silentReported) {
            silentReported = false;
            onStatus(capturingStatus);
        }
    }, 1000);

    return {
        stop: () => stopInternal({ state: 'stopped', message: 'Capture stopped.' }),
        stats: () => ({ ...counters }),
    };
}
