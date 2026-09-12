// One interface over the two render topologies — see projectm-transport-types.ts
// for the contract and why it exists.
//
// Two factories, one shape:
//
//   createModuleTransport(module)  main thread: calls land on the module here
//   createWorkerTransport(handle)  render worker: calls are proxied as ccalls
//
// Neither knows anything about canvases, audio graphs, or the DOM. Deciding
// *which* one a host gets is selectRenderTopology()'s job, at the bottom.

import {
    WASM_API_SIGNATURES,
    feedPcmFloat,
} from './generated/projectm-wasm-api.js';
import * as wasmApi from './generated/projectm-wasm-api.js';
import { feedPcmThroughRing } from './projectm-pcm-ring.js';
import { isRenderWorkerSupported, setupRenderWorker } from './projectm-render-worker-host.js';

/**
 * @typedef {import('./projectm-transport-types.ts').RenderTransport} RenderTransport
 * @typedef {import('./projectm-transport-types.ts').RenderTopology} RenderTopology
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerHandle} RenderWorkerHandle
 */

/**
 * @param {string} name
 * @returns {import('./generated/projectm-wasm-api.js').WasmApiSignature}
 */
function signatureFor(name) {
    const signature = WASM_API_SIGNATURES[name];
    if (!signature) {
        throw new Error(`Unknown projectM API call: ${name}`);
    }
    return signature;
}

/**
 * Coerce JS arguments to what the WASM boundary takes: booleans become 0/1,
 * everything else passes through. The generated paramTypes are the only place
 * that mapping is written down, so the worker side cannot drift from the
 * main-thread wrappers that do the same coercion inline.
 *
 * @param {import('./generated/projectm-wasm-api.js').WasmApiSignature} signature
 * @param {unknown[]} args
 * @returns {unknown[]}
 */
function coerceArgs(signature, args) {
    return signature.paramTypes.map((paramType, index) => {
        const arg = args[index];
        return paramType === 'boolean' ? (arg ? 1 : 0) : arg;
    });
}

/**
 * Main-thread transport: the module is right here, so calls go through the
 * generated wrappers unchanged. Those wrappers already do the argument
 * coercion and pick direct-vs-ccall binding per the manifest, so this is a
 * dispatch table, not a second implementation of the API.
 *
 * @param {any} module Emscripten module instance.
 * @returns {RenderTransport}
 */
export function createModuleTransport(module) {
    if (!module) {
        throw new Error('createModuleTransport requires a module instance');
    }

    /**
     * @param {string} name
     * @param {unknown[]} args
     */
    const invoke = (name, args) => {
        // Assert the name is real even though the wrapper is what we call:
        // an unknown name should fail the same way in both topologies.
        signatureFor(name);
        const wrapper = /** @type {Record<string, Function>} */ (
            /** @type {unknown} */ (wasmApi)
        )[name];
        if (typeof wrapper !== 'function') {
            throw new Error(`projectM API call has no generated wrapper: ${name}`);
        }
        return wrapper(module, ...args);
    };

    return {
        topology: /** @type {RenderTopology} */ ('main'),
        module,
        workerHandle: null,

        supports(name) {
            const { symbol } = signatureFor(name);
            return typeof module[`_${symbol}`] === 'function';
        },

        call(name, ...args) {
            try {
                return Promise.resolve(invoke(name, args));
            } catch (error) {
                return Promise.reject(error);
            }
        },

        callVoid(name, ...args) {
            invoke(name, args);
        },

        feedPcm(buffer, channels = 2) {
            // Same ingest as every other main-thread producer: the WASM-owned
            // PCM ring, with the malloc/HEAPF32 marshaling only as the fallback
            // for bundles built before the ring existed.
            feedPcmThroughRing(module, buffer, {
                channels,
                fallback: () => {
                    feedPcmFloat(
                        module,
                        buffer,
                        Math.floor(buffer.length / Math.max(1, channels)),
                        channels,
                    );
                    return true;
                },
            });
        },

        writePreset(vfsPath, bytes, mode = 'load') {
            if (!module.FS) {
                throw new Error('Module.FS not available');
            }
            try {
                // A bundle that preloads no presets has no /presets to write
                // into; the worker side does the same before its write.
                const dir = vfsPath.slice(0, vfsPath.lastIndexOf('/'));
                if (dir && module.FS.mkdirTree) module.FS.mkdirTree(dir);
            } catch (_) {
                // Already there; the write below reports anything real.
            }
            module.FS.writeFile(vfsPath, bytes);
            if (mode === 'add') {
                wasmApi.addPresetFile(module, vfsPath);
            } else if (mode === 'load-hard') {
                wasmApi.loadPresetFileHard(module, vfsPath);
            } else {
                wasmApi.loadPresetFile(module, vfsPath);
            }
        },

        resize(width, height) {
            if (module._set_window_size) {
                wasmApi.setWindowSize(module, width, height);
            }
        },

        destroy() {
            if (module._destruct) {
                module._destruct();
            }
        },
    };
}

/**
 * Render-worker transport: the module is in the worker, so every call becomes
 * a ccall proxied over postMessage, marshaled from the generated signature
 * table rather than from types written out by hand on this side.
 *
 * @param {RenderWorkerHandle} handle
 * @returns {RenderTransport}
 */
export function createWorkerTransport(handle) {
    if (!handle) {
        throw new Error('createWorkerTransport requires a render worker handle');
    }

    return {
        topology: /** @type {RenderTopology} */ ('worker'),
        module: null,
        workerHandle: handle,

        // The module is on the other side of postMessage, so there is nothing
        // to interrogate synchronously. Every call is assumed available; a
        // bundle that lacks the export reports it as a ccall error instead.
        supports(name) {
            signatureFor(name);
            return true;
        },

        call(name, ...args) {
            const signature = signatureFor(name);
            return handle.ccall(
                signature.symbol,
                signature.returnType,
                signature.argTypes,
                coerceArgs(signature, args),
            );
        },

        callVoid(name, ...args) {
            const signature = signatureFor(name);
            handle.ccallVoid(signature.symbol, signature.argTypes, coerceArgs(signature, args));
        },

        feedPcm(buffer, channels = 2) {
            handle.feedPcm(buffer, channels);
        },

        writePreset(vfsPath, bytes, mode = 'load') {
            handle.postPreset(vfsPath, bytes, mode);
        },

        resize(width, height) {
            // The worker owns the OffscreenCanvas, so it must resize the canvas
            // itself before telling the engine — postResize does both.
            handle.postResize(width, height);
        },

        destroy() {
            handle.worker.terminate();
        },
    };
}

/**
 * Point `globalThis.projectMWritePcmRing` — the writer the baked EM_JS worklet
 * handler prefers over its own inline copy (see `js_install_worklet_pcm_handler`
 * in src/wasm/WasmAudioBridge.cpp) — at this transport.
 *
 * This is what makes worklet audio topology-agnostic: the worklet always runs
 * on the main thread, and this is the one place that decides whether its PCM
 * lands in a ring right here or crosses into the worker. Supersedes
 * installHostPcmRingWriter() for hosts that hold a transport.
 *
 * @param {RenderTransport} transport
 * @returns {() => void} Removes the writer again.
 */
export function installTransportPcmWriter(transport) {
    /** @type {any} */ (globalThis).projectMWritePcmRing =
        /** @param {Float32Array} buffer @param {number} [channels] */
        (buffer, channels = 2) => transport.feedPcm(buffer, channels);
    return () => {
        /** @type {any} */ (globalThis).projectMWritePcmRing = undefined;
    };
}

/**
 * Whether this page can host the render worker at all.
 *
 * Cross-origin isolation is part of the answer and not a detail: without it
 * there is no SharedArrayBuffer, so the worker cannot share its module heap
 * and the PCM ring degrades to a postMessage chunk per audio callback. The
 * pthread build needs it regardless, but checking here keeps the fallback
 * decision in one place instead of failing later and further away.
 *
 * @param {object} [options]
 * @param {HTMLCanvasElement | null} [options.canvas]
 * @param {boolean} [options.crossOriginIsolated]
 * @returns {boolean}
 */
export function canUseRenderWorker({
    canvas,
    crossOriginIsolated = globalThis.crossOriginIsolated !== false,
} = {}) {
    return !!crossOriginIsolated && isRenderWorkerSupported(canvas);
}

/**
 * Pick a topology and build its transport.
 *
 * The worker is the default (see docs/PERFORMANCE.md): it is the topology that
 * cannot be jank-bombed by the embedding page. `?renderWorker=0` opts out and
 * is a supported path, not a deprecated one — and anything the browser cannot
 * do falls back to the main thread on its own, with `onFallback` saying why.
 *
 * Returns null when the worker was wanted but could not start; the caller then
 * boots the module itself and calls createModuleTransport().
 *
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {boolean} options.preferWorker
 * @param {string} [options.scriptSrc]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.targetFps]
 * @param {boolean} [options.governor]
 * @param {string} [options.meshQuality]
 * @param {(reason: string) => void} [options.onFallback]
 * @param {(message: string) => void} [options.onError]
 * @param {(stats: unknown) => void} [options.onStats]
 * @returns {Promise<RenderTransport | null>}
 */
export function selectRenderTopology({
    canvas,
    preferWorker,
    scriptSrc,
    width,
    height,
    targetFps,
    governor,
    meshQuality,
    onFallback,
    onError,
    onStats,
}) {
    if (!preferWorker) {
        return Promise.resolve(null);
    }
    if (!canUseRenderWorker({ canvas })) {
        onFallback?.('OffscreenCanvas, Worker, or cross-origin isolation unavailable');
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        let settled = false;
        /** @param {RenderTransport | null} value */
        const settle = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const handle = setupRenderWorker({
            canvas,
            scriptSrc,
            width,
            height,
            targetFps,
            governor,
            meshQuality,
            onReady: () => settle(handle ? createWorkerTransport(handle) : null),
            onUnsupported: (reason) => {
                onFallback?.(reason);
                settle(null);
            },
            // An error before 'ready' is a failed boot, so fall back; one after
            // is a live worker reporting a problem and belongs to the caller.
            onError: (message) => {
                if (!settled) {
                    onFallback?.(message);
                    settle(null);
                    return;
                }
                onError?.(message);
            },
            onStats,
        });

        if (!handle) {
            settle(null);
        }
    });
}
