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
import { claimGlobal } from './projectm-globals.js';
// The router registry lives in the hand-written router module — that is where
// AudioSourceRouter registers itself. This used to import the same-named
// function from generated/projectm-wasm-api.js, a second registry that nothing
// writes to, so notifyWorkletFeed() below never reached a router.
import { getHostAudioSourceRouter } from './projectm-audio-source-router.js';
import {
    getPcmRingWriter,
    installHostPcmRingWriter,
    readPcmRingDescriptor,
} from './projectm-pcm-ring.js';

// Resolved against THIS module, not the page. A bare relative URL goes through
// the page's base, so a bundle served from node_modules or a CDN asked the
// embedding site for /projectm_audio_processor.js and got a 404. In the
// first-party deploy the modules and the page share a directory, so the two
// agree there; packages/web copies the processor next to its bundle to match.
const PROCESSOR_URL = new URL('projectm_audio_processor.js', import.meta.url).href;
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
 * Let the engine's own worklet setup finish before this module starts one.
 *
 * `js_initialize_worklet_system_once` (WasmAudioBridge.cpp) begins loading the
 * processor as soon as it creates the AudioContext and publishes the outcome as
 * `globalThis.projectMWorkletReady`. If this module also called `addModule()`
 * and built a node while that was in flight, the two would only be ordered by
 * luck: the engine's failure path clears `projectMWorkletNode_Global_Cpp`
 * *after* a node built here has been connected, orphaning it, and the next
 * repair then connects a second node and doubles the PCM feed. Waiting for the
 * engine's attempt to settle first means only one of the two ever runs.
 *
 * @param {number} deadline `Date.now()` value after which to stop waiting.
 * @returns {Promise<'ready' | 'failed' | 'timeout'>} `ready` when the engine's
 *   attempt produced the node, `failed` when it settled without one (or there
 *   was no attempt to wait for), `timeout` when it was still pending at the deadline.
 */
async function settleEngineWorkletSetup(deadline) {
    const pending = /** @type {any} */ (globalThis).projectMWorkletReady;
    if (!pending || typeof pending.then !== 'function') {
        return globalThis.projectMWorkletNode_Global_Cpp ? 'ready' : 'failed';
    }

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
    });
    try {
        const outcome = await Promise.race([
            Promise.resolve(pending).then(() => 'settled', () => 'settled'),
            timedOut,
        ]);
        if (outcome === 'timeout') {
            return 'timeout';
        }
    } finally {
        clearTimeout(timer);
    }
    return globalThis.projectMWorkletNode_Global_Cpp ? 'ready' : 'failed';
}

/**
 * Completes AudioWorklet setup when the WASM async path left
 * `projectMWorkletNode_Global_Cpp` unset (failed or still racing).
 *
 * @param {number} deadline `Date.now()` value at which the caller gives up.
 * @returns {Promise<boolean>}
 */
async function repairWorkletSetup(deadline) {
    const ctx = getAudioContext();
    if (!ctx) {
        console.warn('[projectM] ensureWorkletReady: AudioContext not created yet');
        return false;
    }

    if (globalThis.projectMWorkletNode_Global_Cpp) {
        return true;
    }

    const engineSetup = await settleEngineWorkletSetup(deadline);
    if (engineSetup === 'ready') {
        return true;
    }
    if (engineSetup === 'timeout') {
        // The engine's addModule() is still pending. Starting a second setup
        // now is exactly the overlap this function exists to avoid.
        return false;
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

    // Something else may have won while we awaited addModule.
    if (globalThis.projectMWorkletNode_Global_Cpp) {
        return true;
    }

    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME);
    // Publish the node BEFORE attaching the ingest: the engine's
    // `_attach_worklet_ingest()` reads it from this global and returns without
    // doing anything when it is still unset, which left a repaired node with no
    // PCM handler at all.
    globalThis.projectMWorkletNode_Global_Cpp = workletNode;
    try {
        attachPcmHandler(workletNode);
        workletNode.connect(ctx.destination);
    } catch (err) {
        globalThis.projectMWorkletNode_Global_Cpp = null;
        try {
            workletNode.disconnect();
        } catch {
            // Never connected; nothing to undo.
        }
        throw err;
    }
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
                        return await repairWorkletSetup(deadline);
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
 * @typedef {object} SafetyNet
 * @property {BroadcastChannel | null} channel
 * @property {Set<ReturnType<typeof setTimeout>>} timers
 * @property {() => void} releaseLoadHook
 * @property {boolean} disposed
 */

/** How many live callers hold the safety net; the last release tears it down. */
let safetyNetRefs = 0;
/** @type {SafetyNet | null} */
let safetyNet = null;

/**
 * Build the BroadcastChannel('file') listener and the host load hook.
 * @returns {SafetyNet}
 */
function createSafetyNet() {
    /** @type {SafetyNet} */
    const net = {
        channel: null,
        timers: new Set(),
        // Prefer the host load path even after a WASM rebuild, so repair + logging
        // stay in one place deployable with html/ alone. Returns the promise so a
        // caller can await the load; loadSongIntoWorklet reports failure through
        // its result rather than by rejecting.
        releaseLoadHook: claimGlobal(
            globalThis,
            'projectMLoadSongIntoWorklet',
            /**
             * @param {string} path
             * @param {boolean} [loop]
             * @param {boolean} [startPlaying]
             */
            (path, loop, startPlaying) => loadSongIntoWorklet(path, loop !== false, startPlaying !== false)
        ),
        disposed: false,
    };

    if (typeof BroadcastChannel === 'undefined') {
        return net;
    }

    const channel = new BroadcastChannel('file');
    net.channel = channel;
    channel.addEventListener('message', (ea) => {
        const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        globalThis.__projectMSongLoadToken = token;
        const payload = ea?.data?.data;

        // Beat WASM's 250ms pl() timer so the worklet node exists first.
        ensureWorkletReady().catch((err) => {
            console.error('[projectM] worklet safety-net ensure failed:', err);
        });

        const timer = setTimeout(async () => {
            net.timers.delete(timer);
            if (net.disposed || globalThis.__projectMSongLoadToken !== token) {
                return;
            }
            try {
                const ready = await ensureWorkletReady();
                if (!ready || net.disposed) {
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
        net.timers.add(timer);
    });
    return net;
}

/**
 * Install a BroadcastChannel('file') safety-net that:
 * 1. Ensures the worklet is ready before WASM's 250ms `pl()` timer fires
 * 2. Retries host-side load from the BroadcastChannel payload if `pl()` no-op'd
 *
 * The net is shared: every caller gets the same channel, and it is closed —
 * with its pending retry timers cancelled and the `projectMLoadSongIntoWorklet`
 * hook released — when the last caller's disposer runs. Before this returned a
 * disposer the channel stayed open for the life of the page after the context
 * that asked for it was destroyed.
 *
 * @returns {() => void} Releases this caller's hold. Idempotent.
 */
export function installWorkletPlaybackSafetyNet() {
    safetyNetRefs += 1;
    if (!safetyNet) {
        safetyNet = createSafetyNet();
    }

    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        safetyNetRefs -= 1;
        if (safetyNetRefs > 0 || !safetyNet) {
            return;
        }
        const net = safetyNet;
        safetyNet = null;
        net.disposed = true;
        for (const timer of net.timers) {
            clearTimeout(timer);
        }
        net.timers.clear();
        net.releaseLoadHook();
        net.channel?.close();
    };
}
