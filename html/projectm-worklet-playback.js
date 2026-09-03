// projectm-worklet-playback.js
//
// Ensures the shared AudioWorklet used by C++ `pl()` is actually ready before a
// decoded FLAC/WAV is loaded. `js_initialize_worklet_system_once` creates the
// AudioContext synchronously but loads the worklet module asynchronously; if
// addModule fails or is still pending, `js_load_song_into_worklet` silently
// returns and the song never plays (C++ still logs `pl() called`).
//
// Hosts should call `ensureWorkletReady()` from the music-button gesture (and
// after init). This module can also repair a failed worklet setup without a
// WASM rebuild.

import { ensureAudioRunning, getAudioContext } from './projectm-audio-bootstrap.js';
import { getHostAudioSourceRouter } from './generated/projectm-wasm-api.js';
import {
    getPcmRingWriter,
    installHostPcmRingWriter,
    readPcmRingDescriptor,
} from './projectm-pcm-ring.js';

const PROCESSOR_URL = 'projectm_audio_processor.js';
const PROCESSOR_NAME = 'projectm-audio-processor';

/** @type {Promise<boolean> | null} */
let workletSetupPromise = null;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The Emscripten module, wherever this build put it. */
function currentModule() {
    return globalThis.Module || null;
}

/**
 * Wire a repaired worklet node into the PCM ring.
 *
 * Two transports, one ingest. When the module's memory is shared (COOP/COEP),
 * the processor writes the ring itself at audio rate and this only has to hand
 * it the descriptor. Otherwise the processor posts PCM and we write the same
 * ring here, one hop later.
 *
 * There is no `_malloc` and no scratch buffer: the ring is allocated once by
 * `pcm_ring_init()` in the WASM heap and owned there.
 *
 * @param {AudioWorkletNode} workletNode
 */
function attachPcmHandler(workletNode) {
    const module = currentModule();

    // Prefer the module's own attach path so the descriptor handoff and the
    // fallback handler stay defined in one place (WasmAudioBridge.cpp).
    if (typeof module?._attach_worklet_ingest === 'function') {
        installHostPcmRingWriter(module);
        module._attach_worklet_ingest();
        return;
    }

    const descriptor = readPcmRingDescriptor(module);
    if (descriptor && typeof SharedArrayBuffer !== 'undefined'
        && descriptor.memory instanceof SharedArrayBuffer) {
        workletNode.port.postMessage({ type: 'pcmRing', ...descriptor });
    }

    workletNode.port.onmessage = (event) => {
        if (event.data?.type !== 'pcmData' || !event.data.audioData) {
            return;
        }
        // Re-resolved per message: the WASM heap can grow, which detaches views.
        const writer = getPcmRingWriter(currentModule());
        if (!writer) {
            return;
        }
        writer.write(event.data.audioData, event.data.channelsForPM === 1 ? 1 : 2);
    };
}

/** Notify exclusive AudioSourceRouter that the worklet path is feeding. */
function notifyWorkletSourceActive() {
    try {
        getHostAudioSourceRouter()?.notifyWorkletFeed?.();
    } catch {
        // Router is optional; worklet PCM still feeds without it.
    }
}

/**
 * Completes AudioWorklet setup when the WASM async path left
 * `projectMWorkletNode_Global_Cpp` unset (failed or still racing).
 * @returns {Promise<boolean>}
 */
async function repairWorkletSetup() {
    const ctx = getAudioContext();
    if (!ctx) {
        console.warn('[projectM] ensureWorkletReady: AudioContext not created yet');
        return false;
    }

    if (globalThis.projectMWorkletNode_Global_Cpp) {
        return true;
    }

    if (ctx.state === 'suspended') {
        try {
            await ctx.resume();
        } catch (err) {
            console.warn('[projectM] AudioContext.resume() during worklet repair failed:', err);
        }
    }

    console.warn('[projectM] AudioWorklet missing after init; completing setup on user gesture');
    await ctx.audioWorklet.addModule(PROCESSOR_URL);

    // WASM's in-flight setup may have won while we awaited addModule.
    if (globalThis.projectMWorkletNode_Global_Cpp) {
        return true;
    }

    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME);
    attachPcmHandler(workletNode);
    workletNode.connect(ctx.destination);
    globalThis.projectMWorkletNode_Global_Cpp = workletNode;
    console.log('[projectM] AudioWorkletNode repaired and connected');
    return true;
}

/**
 * Wait until the shared worklet node exists, repairing setup if needed.
 * Safe to call from any user-gesture handler before `pl()` / FLAC decode.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs=12000]
 * @param {number} [options.pollMs=50]
 * @returns {Promise<boolean>}
 */
export async function ensureWorkletReady({
    timeoutMs = 12000,
    pollMs = 50,
} = {}) {
    await ensureAudioRunning();

    if (globalThis.projectMWorkletNode_Global_Cpp) {
        return true;
    }

    if (!workletSetupPromise) {
        workletSetupPromise = (async () => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (globalThis.projectMWorkletNode_Global_Cpp) {
                    return true;
                }
                if (getAudioContext()) {
                    try {
                        return await repairWorkletSetup();
                    } catch (err) {
                        console.error('[projectM] Worklet repair failed:', err);
                        // Keep polling in case WASM's original async path recovers.
                    }
                }
                await sleep(pollMs);
            }
            console.error(
                '[projectM] AudioWorklet not ready after',
                timeoutMs,
                'ms — pl() will no-op until projectMWorkletNode_Global_Cpp exists'
            );
            return false;
        })().finally(() => {
            workletSetupPromise = null;
        });
    }

    return workletSetupPromise;
}

/**
 * Decode a VFS WAV path and send it to the worklet (same contract as
 * `js_load_song_into_worklet`). Used when hosts want to drive playback without
 * relying on the baked EM_JS early-return.
 *
 * @param {string} filePath MEMFS path (e.g. /snd/song_….wav)
 * @param {boolean} [loop=true]
 * @param {boolean} [startPlaying=true]
 * @returns {Promise<boolean>}
 */
export async function loadSongIntoWorklet(filePath, loop = true, startPlaying = true) {
    const ready = await ensureWorkletReady();
    const audioContext = getAudioContext();
    const workletNode = globalThis.projectMWorkletNode_Global_Cpp;
    if (!ready || !audioContext || !workletNode) {
        console.error('[projectM] loadSongIntoWorklet: worklet unavailable for', filePath);
        return false;
    }

    if (globalThis.projectMSongLoadState === 'loading') {
        console.warn('[projectM] loadSongIntoWorklet: load already in progress, skipping', filePath);
        return false;
    }
    globalThis.projectMSongLoadState = 'loading';
    notifyWorkletSourceActive();

    try {
        const FS = globalThis.FS;
        if (!FS?.readFile) {
            throw new Error('Emscripten FS.readFile unavailable');
        }
        const fileDataUint8Array = FS.readFile(filePath);
        console.log(`[projectM] loadSongIntoWorklet: read ${fileDataUint8Array.length} bytes from ${filePath}`);
        if (fileDataUint8Array.length === 0) {
            globalThis.projectMSongLoadState = 'error';
            return false;
        }

        const audioDataArrayBuffer = fileDataUint8Array.buffer.slice(
            fileDataUint8Array.byteOffset,
            fileDataUint8Array.byteOffset + fileDataUint8Array.byteLength
        );

        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        const decodedBuffer = await audioContext.decodeAudioData(audioDataArrayBuffer);
        console.log(
            `[projectM] loadSongIntoWorklet: decoded ${decodedBuffer.duration.toFixed(2)}s, sending to worklet`
        );

        const rawChannelData = Array.from(
            { length: decodedBuffer.numberOfChannels },
            (_, i) => decodedBuffer.getChannelData(i)
        );

        workletNode.port.postMessage({
            type: 'loadWavData',
            channelData: rawChannelData,
            sampleRate: decodedBuffer.sampleRate,
            loop,
            startPlaying,
        });
        globalThis.projectMSongLoadState = 'loaded';
        return true;
    } catch (err) {
        console.error('[projectM] loadSongIntoWorklet failed:', err);
        globalThis.projectMSongLoadState = 'error';
        return false;
    }
}

/**
 * Decode raw WAV bytes and send them to the worklet (no MEMFS required).
 * @param {ArrayBuffer | ArrayBufferView} wavBytes
 * @param {boolean} [loop=true]
 * @param {boolean} [startPlaying=true]
 * @returns {Promise<boolean>}
 */
export async function loadWavBytesIntoWorklet(wavBytes, loop = true, startPlaying = true) {
    const ready = await ensureWorkletReady();
    const audioContext = getAudioContext();
    const workletNode = globalThis.projectMWorkletNode_Global_Cpp;
    if (!ready || !audioContext || !workletNode) {
        console.error('[projectM] loadWavBytesIntoWorklet: worklet unavailable');
        return false;
    }

    if (globalThis.projectMSongLoadState === 'loading') {
        console.warn('[projectM] loadWavBytesIntoWorklet: load already in progress');
        return false;
    }
    globalThis.projectMSongLoadState = 'loading';
    notifyWorkletSourceActive();

    try {
        const view = ArrayBuffer.isView(wavBytes)
            ? wavBytes
            : new Uint8Array(wavBytes);
        const audioDataArrayBuffer = view.buffer.slice(
            view.byteOffset,
            view.byteOffset + view.byteLength
        );

        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        const decodedBuffer = await audioContext.decodeAudioData(audioDataArrayBuffer);
        console.log(
            `[projectM] loadWavBytesIntoWorklet: decoded ${decodedBuffer.duration.toFixed(2)}s, sending to worklet`
        );

        const rawChannelData = Array.from(
            { length: decodedBuffer.numberOfChannels },
            (_, i) => decodedBuffer.getChannelData(i)
        );

        workletNode.port.postMessage({
            type: 'loadWavData',
            channelData: rawChannelData,
            sampleRate: decodedBuffer.sampleRate,
            loop,
            startPlaying,
        });
        globalThis.projectMSongLoadState = 'loaded';
        return true;
    } catch (err) {
        console.error('[projectM] loadWavBytesIntoWorklet failed:', err);
        globalThis.projectMSongLoadState = 'error';
        return false;
    }
}

/**
 * Install a BroadcastChannel('file') safety-net that:
 * 1. Ensures the worklet is ready before WASM's 250ms `pl()` timer fires
 * 2. Retries host-side load from the BroadcastChannel payload if `pl()` no-op'd
 */
export function installWorkletPlaybackSafetyNet() {
    if (globalThis.__projectMWorkletSafetyNetInstalled) {
        return;
    }
    globalThis.__projectMWorkletSafetyNetInstalled = true;

    // Prefer the host load path even after a WASM rebuild, so repair + logging
    // stay in one place deployable with html/ alone.
    globalThis.projectMLoadSongIntoWorklet = (path, loop, startPlaying) => {
        loadSongIntoWorklet(path, loop !== false, startPlaying !== false);
    };

    const channel = new BroadcastChannel('file');
    channel.addEventListener('message', (ea) => {
        const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        globalThis.__projectMSongLoadToken = token;
        const payload = ea?.data?.data;

        // Beat WASM's 250ms pl() timer so the worklet node exists first.
        ensureWorkletReady().catch((err) => {
            console.error('[projectM] worklet safety-net ensure failed:', err);
        });

        setTimeout(async () => {
            if (globalThis.__projectMSongLoadToken !== token) {
                return;
            }
            try {
                const ready = await ensureWorkletReady();
                if (!ready) {
                    return;
                }
                const state = globalThis.projectMSongLoadState;
                // Baked EM_JS used to return without setting state when the worklet
                // was missing; retry from VFS path (new builds) or raw WAV bytes.
                if (state === 'loaded' || state === 'loading') {
                    return;
                }
                const path = globalThis.projectMLastSongPath;
                if (path) {
                    console.warn('[projectM] pl() did not load song; retrying via host VFS path:', path);
                    await loadSongIntoWorklet(path, true, true);
                    return;
                }
                if (payload) {
                    console.warn('[projectM] pl() did not load song; retrying from BroadcastChannel WAV bytes');
                    await loadWavBytesIntoWorklet(payload, true, true);
                }
            } catch (err) {
                console.error('[projectM] worklet safety-net retry failed:', err);
            }
        }, 400);
    });
}
