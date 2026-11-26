// One interface over the two render topologies — see
// packages/types/src/transport.ts for the contract and why it exists.
//
// Two factories, one shape:
//
//   createModuleTransport(module)  main thread: calls land on the module here
//   createWorkerTransport(handle)  render worker: calls are proxied as ccalls
//
// A transport is bound to one engine. Two engines can share a Module (#168
// Phase B), and almost every export acts on the *active* one, so each call a
// transport issues selects its engine first — on the main thread through
// bindModuleToHost(), in the worker through the `host` field on every control
// message. A caller that awaits between two calls cannot have a sibling
// engine's activation land in between.
//
// `call(name, ...args)` is checked against the generated signature of `name`
// (WasmApiCalls, @projectm/types/wasm-api) at compile time in both topologies,
// and against WASM_API_SIGNATURES at run time, so a call that does not exist
// fails the same way on either side instead of as a ccall error in the worker.
//
// Neither knows anything about canvases, audio graphs, or the DOM. Deciding
// *which* one a host gets is selectRenderTopology()'s job, at the bottom.

import { DEFAULT_HOST, WASM_API_SIGNATURES, bindModuleToHost } from './generated/projectm-wasm-api.js';
import * as wasmApi from './generated/projectm-wasm-api.js';
import type {
    HostHandle,
    ProjectMModule,
    WasmApiArgs,
    WasmApiName,
    WasmApiResult,
    WasmApiSignature,
} from './generated/projectm-wasm-api.js';
import { captureFrameFromModule } from './projectm-frame-capture.js';
import { createLiveTextureWriter, createLiveTextures, pixelsOf, sourceSize } from './projectm-live-texture.js';
import { claimGlobal } from './projectm-globals.js';
import { feedPcm } from './projectm-pcm-ring.js';
import {
    isRenderWorkerSupported,
    renderWorkerUnsupportedReason,
    setupRenderWorker,
} from './projectm-render-worker-host.js';
import { subscribeWasmCallback } from './projectm-wasm-callbacks.js';
import type { ProjectMLiveTextureSource } from '@projectm/types/context';
import type {
    FlashLimitSettings,
    RenderPathOverrides,
    RenderWorkerHandle,
    RenderWorkerStatsMessage,
    RhythmEvent,
    WasmContextConfig,
} from '@projectm/types/render-worker';
import type { RenderTransport } from '@projectm/types/transport';

/** How live-texture frames become transferable bitmaps (the page's createImageBitmap). */
export type CreateImageBitmapFn = (source: ImageBitmapSource, options?: ImageBitmapOptions) => Promise<ImageBitmap>;

/** What the main-thread transport needs of the module beyond the generated surface. */
type TransportModule = ProjectMModule & {
    FS?: {
        writeFile: (path: string, data: Uint8Array | string) => void;
        mkdirTree?: (path: string) => void;
    };
};

/** A generated wrapper, as the dispatch table calls it. */
type Wrapper = (engine: ProjectMModule, ...args: readonly unknown[]) => unknown;

/**
 * The signature of `name`. Run-time half of the check `call()`'s type does at
 * compile time: JSDoc callers and messages from elsewhere can still name a call
 * that does not exist.
 */
function signatureFor(name: string): WasmApiSignature {
    if (!Object.prototype.hasOwnProperty.call(WASM_API_SIGNATURES, name)) {
        throw new Error(`Unknown projectM API call: ${name}`);
    }
    return WASM_API_SIGNATURES[name as WasmApiName];
}

/**
 * Coerce JS arguments to what the WASM boundary takes: booleans become 0/1,
 * everything else passes through. The generated paramTypes are the only place
 * that mapping is written down, so the worker side cannot drift from the
 * main-thread wrappers that do the same coercion inline.
 */
function coerceArgs(signature: WasmApiSignature, args: readonly unknown[]): unknown[] {
    return signature.paramTypes.map((paramType, index) => {
        const arg = args[index];
        return paramType === 'boolean' ? (arg ? 1 : 0) : arg;
    });
}

export interface ModuleTransportOptions {
    /**
     * The engine in `module` this transport drives: create_host*()'s handle, or
     * DEFAULT_HOST for the default host of a single-engine Module. Every call
     * activates it first, and the engine events it relays are that engine's only.
     */
    host?: HostHandle;
}

/**
 * Main-thread transport: the module is right here, so calls go through the
 * generated wrappers unchanged. Those wrappers already do the argument
 * coercion and pick direct-vs-ccall binding per the manifest, so this is a
 * dispatch table, not a second implementation of the API.
 *
 * @param module Emscripten module instance.
 */
export function createModuleTransport(
    module: TransportModule,
    { host = DEFAULT_HOST }: ModuleTransportOptions = {}
): RenderTransport {
    if (!module) {
        throw new Error('createModuleTransport requires a module instance');
    }
    // Every engine call goes through this view, so it lands on `host` however
    // long the caller awaited before making it.
    const engine = bindModuleToHost(module, host);
    const scope = { engineHost: host };

    const invoke = <K extends WasmApiName>(name: K, args: WasmApiArgs<K>): WasmApiResult<K> => {
        // Assert the name is real even though the wrapper is what we call:
        // an unknown name should fail the same way in both topologies.
        signatureFor(name);
        const wrapper: unknown = (wasmApi as unknown as Record<string, unknown>)[name];
        if (typeof wrapper !== 'function') {
            throw new Error(`projectM API call has no generated wrapper: ${name}`);
        }
        return (wrapper as Wrapper)(engine, ...args) as WasmApiResult<K>;
    };

    // Live textures: frames are drawn on this thread and copied into the slot's
    // staging buffer on the heap. Created on first use: most pages never need it.
    let liveTextures: ReturnType<typeof createLiveTextures> | null = null;
    const live = () => (liveTextures ??= createLiveTextures(createLiveTextureWriter(engine)));

    return {
        topology: 'main',
        module,
        host,
        workerHandle: null,

        supports(name) {
            const { symbol } = signatureFor(name);
            return typeof (module as unknown as Record<string, unknown>)[`_${symbol}`] === 'function';
        },

        call<K extends WasmApiName>(name: K, ...args: WasmApiArgs<K>): Promise<WasmApiResult<K>> {
            try {
                return Promise.resolve(invoke(name, args));
            } catch (error) {
                // Whatever the wrapper threw, as the worker topology's rejection carries it.
                return Promise.reject(error);
            }
        },

        callVoid<K extends WasmApiName>(name: K, ...args: WasmApiArgs<K>): void {
            invoke(name, args);
        },

        feedPcm(buffer, channels = 2) {
            // Same ingest as every other main-thread producer: this engine's
            // PCM ring, with the marshaling fallback for bundles built before
            // the ring existed.
            feedPcm({ module, host }, buffer, { channels });
        },

        writePreset(vfsPath, bytes, mode = 'load') {
            const fs = module.FS;
            if (!fs) {
                throw new Error('Module.FS not available');
            }
            try {
                // A bundle that preloads no presets has no /presets to write
                // into; the worker side does the same before its write.
                const dir = vfsPath.slice(0, vfsPath.lastIndexOf('/'));
                if (dir && fs.mkdirTree) fs.mkdirTree(dir);
            } catch (_) {
                // Already there; the write below reports anything real.
            }
            fs.writeFile(vfsPath, bytes);
            if (mode === 'add') {
                wasmApi.addPresetFile(engine, vfsPath);
            } else if (mode === 'load-hard') {
                wasmApi.loadPresetFileHard(engine, vfsPath);
            } else {
                wasmApi.loadPresetFile(engine, vfsPath);
            }
        },

        resize(width, height) {
            if (typeof module._set_window_size === 'function') {
                wasmApi.setWindowSize(engine, width, height);
            }
        },

        setFlashLimit(enabled, threshold) {
            if (typeof module._set_flash_limit_enabled !== 'function') {
                return;
            }
            // Threshold first, so a limiter switched on never runs a frame on
            // the previous one.
            if (typeof threshold === 'number' && Number.isFinite(threshold)) {
                wasmApi.setFlashLimitThreshold(engine, threshold);
            }
            wasmApi.setFlashLimitEnabled(engine, enabled);
        },

        captureFrame(options = {}) {
            return captureFrameFromModule(engine, options);
        },

        registerTexture(name, width, height, options) {
            return live().register(name, width, height, options);
        },

        updateTexture(name, source, options) {
            return live().update(name, source, options);
        },

        unregisterTexture(name) {
            return live().unregister(name);
        },

        restoreTextures() {
            return liveTextures ? liveTextures.restore() : Promise.resolve(0);
        },

        onContextEvent() {
            // The canvas is on this thread and dispatches the DOM events itself.
            return () => {};
        },

        onPerfFrame(listener) {
            // The engine calls the global on this thread; the bus lets several
            // listeners share it and keeps only this engine's frames.
            return subscribeWasmCallback('pmOnPerfFrame', listener, globalThis, scope);
        },

        onPerfHudEnabled(listener) {
            return subscribeWasmCallback('pmSetPerfHudEnabled', ({ enabled }) => listener(enabled), globalThis, scope);
        },

        onRhythmEvent(listener) {
            return subscribeWasmCallback(
                'pmOnRhythmEvent',
                (event) => listener(event as RhythmEvent),
                globalThis,
                scope
            );
        },

        contextSnapshot() {
            return typeof module._get_context_snapshot === 'function' ? Number(invoke('getContextSnapshot', [])) : null;
        },

        recoverContext(width = 0, height = 0) {
            // init() replaces whatever engine is left and refuses with 5 while
            // the context is still lost; nothing is built in that case. The
            // executor turns a throw into a rejection, as the worker's does.
            return new Promise<number>((resolve) => {
                const status = wasmApi.init(engine);
                if (status === 0 && width > 0 && height > 0) {
                    wasmApi.startRender(engine, width, height);
                }
                resolve(status);
            });
        },

        destroy() {
            if (typeof module._destruct === 'function') {
                module._destruct();
            }
        },
    };
}

/** The page's createImageBitmap(), or null where there is none (Node). */
function defaultCreateImageBitmap(): CreateImageBitmapFn | null {
    return typeof globalThis.createImageBitmap === 'function'
        ? (globalThis.createImageBitmap.bind(globalThis) as CreateImageBitmapFn)
        : null;
}

/**
 * An ImageBitmap of `source` at `size`. Pixels of the right size never get
 * here; anything else (a <video>, a canvas, an image) is resized by the
 * browser. A browser that rejects the resize options gets the frame at its own
 * size, and the worker scales it while drawing.
 */
async function scaledBitmap(
    create: CreateImageBitmapFn,
    source: ProjectMLiveTextureSource,
    size: { width: number; height: number }
): Promise<ImageBitmap> {
    // Plain `{ width, height, data }` pixels of another size: an ImageData is
    // something createImageBitmap() takes (a copy, since it takes no shared view).
    const data = (source as { data?: unknown }).data;
    const natural = sourceSize(source);
    const isImageData = typeof ImageData === 'function' && source instanceof ImageData;
    const bitmapSource =
        !isImageData && (data instanceof Uint8Array || data instanceof Uint8ClampedArray) && natural
            ? new ImageData(new Uint8ClampedArray(data), natural.width, natural.height)
            : (source as ImageBitmapSource);
    try {
        return await create(bitmapSource, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'low' });
    } catch (error) {
        if (!(error instanceof TypeError)) {
            throw error;
        }
        return create(bitmapSource);
    }
}

export interface WorkerTransportOptions {
    /**
     * Symbols the worker's bundle exports (the build manifest's `api`, no
     * leading underscore). When given, supports() answers from it; when not,
     * every call is assumed to exist.
     */
    exports?: Iterable<string> | null | undefined;
    /** How live-texture frames become transferable bitmaps; the page's own by default. */
    createImageBitmap?: CreateImageBitmapFn | null;
}

/**
 * Render-worker transport: the module is in the worker, so every call becomes
 * a ccall proxied over postMessage, marshaled from the generated signature
 * table rather than from types written out by hand on this side.
 */
export function createWorkerTransport(
    handle: RenderWorkerHandle,
    { exports = null, createImageBitmap = defaultCreateImageBitmap() }: WorkerTransportOptions = {}
): RenderTransport {
    if (!handle) {
        throw new Error('createWorkerTransport requires a render worker handle');
    }
    const exported = exports ? new Set(exports) : null;

    const ccallNumber = async (symbol: string, argTypes: Array<'number' | 'string'>, args: unknown[]) =>
        Number(await handle.ccall(symbol, 'number', argTypes, args));

    // Live textures: the frame is scaled to the slot's size here
    // (createImageBitmap's resize runs off the main thread in browsers) and
    // the bitmap is transferred; html/worker/live-texture.js writes it into
    // the slot's staging buffer on the worker's heap.
    const liveTextures = createLiveTextures({
        registerSlot: async (name, width, height) =>
            !!(await ccallNumber('texture_slot_register', ['string', 'number', 'number'], [name, width, height])),
        unregisterSlot: async (name) => !!(await ccallNumber('texture_slot_unregister', ['string'], [name])),
        async writeFrame(name, size, source) {
            const pixels = pixelsOf(source, size);
            if (pixels) {
                // A copy: the caller keeps its buffer, and the copy is transferred.
                const copy = new Uint8Array(pixels);
                handle.postTextureFrame(name, size.width, size.height, { pixels: copy.buffer });
                return true;
            }
            if (!createImageBitmap) {
                throw new Error(
                    'updateTexture(): this browser has no createImageBitmap() to hand frames to the render worker'
                );
            }
            const bitmap = await scaledBitmap(createImageBitmap, source, size);
            handle.postTextureFrame(name, size.width, size.height, { bitmap });
            return true;
        },
    });

    return {
        topology: 'worker',
        module: null,
        // The worker's engine, as it reported in 'ready'. The handle stamps it
        // on every control message it posts, so this is informational.
        get host() {
            return handle.engineHost?.() ?? DEFAULT_HOST;
        },
        workerHandle: handle,

        // The module is on the other side of postMessage, so there is nothing
        // to interrogate synchronously. With the manifest's export list the
        // answer is exact; without it every call is assumed available and a
        // bundle that lacks the export reports it as a ccall error instead.
        supports(name) {
            const signature = signatureFor(name);
            return exported ? exported.has(signature.symbol) : true;
        },

        call<K extends WasmApiName>(name: K, ...args: WasmApiArgs<K>): Promise<WasmApiResult<K>> {
            const signature = signatureFor(name);
            return handle.ccall(
                signature.symbol,
                signature.returnType,
                signature.argTypes,
                coerceArgs(signature, args)
            ) as Promise<WasmApiResult<K>>;
        },

        callVoid<K extends WasmApiName>(name: K, ...args: WasmApiArgs<K>): void {
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

        setFlashLimit(enabled, threshold) {
            handle.postFlashLimit(enabled, threshold);
        },

        captureFrame(options = {}) {
            // The drawing buffer is the worker's and only readable inside the
            // frame that drew it, so the worker reads it and posts the pixels.
            return handle.captureFrame(options);
        },

        registerTexture(name, width, height, options) {
            return liveTextures.register(name, width, height, options);
        },

        updateTexture(name, source, options) {
            return liveTextures.update(name, source, options);
        },

        unregisterTexture(name) {
            return liveTextures.unregister(name);
        },

        restoreTextures() {
            return liveTextures.restore();
        },

        onContextEvent(listener) {
            return handle.onContextEvent(listener);
        },

        onPerfFrame(listener) {
            return handle.onPerfFrame(listener);
        },

        onPerfHudEnabled(listener) {
            return handle.onPerfHudEnabled(listener);
        },

        onRhythmEvent(listener) {
            return handle.onRhythmEvent(listener);
        },

        contextSnapshot() {
            return handle.contextSnapshot();
        },

        recoverContext() {
            return handle.recoverContext();
        },

        destroy() {
            // Lets the worker stop its stats tick and destruct its engine before
            // it goes; the handle terminates it on the answer or a deadline.
            void handle.shutdown();
        },
    };
}

/**
 * How long {@link selectRenderTopology} waits for the worker's 'ready' before it
 * gives up on it and falls back. Generous: inside it the worker downloads and
 * compiles the whole bundle, and a slow network must not cost a working
 * topology. What it bounds is a boot that will never finish — a pthread pool
 * that cannot fill, an init that wedged — which used to hang start() for good.
 */
export const DEFAULT_RENDER_WORKER_BOOT_TIMEOUT_MS = 30000;

/**
 * Point `globalThis.projectMWritePreset` at this transport.
 *
 * Preset fetches run on the host page. In the render-worker topology there is
 * no module FS on that thread, so `fetchApiPreset` / `loadRandomApiPreset`
 * write through this function (vfs path + bytes + 'load'|'add') instead of
 * skipping with "module not ready". Same claim stack as the PCM writer.
 */
export function installTransportPresetWriter(transport: RenderTransport): () => void {
    return claimGlobal(
        globalThis,
        'projectMWritePreset',
        (vfsPath: string, bytes: Uint8Array, mode: 'load' | 'load-hard' | 'add' = 'load') =>
            transport.writePreset(vfsPath, bytes, mode)
    );
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
 * @returns Removes the writer again.
 */
export function installTransportPcmWriter(transport: RenderTransport): () => void {
    // The engine's worklet ingest calls this global by name, so there is one per
    // page. Claimed rather than assigned: destroying one context must not
    // unhook the writer another context installed after it.
    return claimGlobal(globalThis, 'projectMWritePcmRing', (buffer: Float32Array, channels = 2) =>
        transport.feedPcm(buffer, channels)
    );
}

export interface CanUseRenderWorkerOptions {
    canvas?: HTMLCanvasElement | null | undefined;
    crossOriginIsolated?: boolean;
}

/**
 * Whether this page can host the render worker at all.
 *
 * Cross-origin isolation is part of the answer and not a detail: without it
 * there is no SharedArrayBuffer, so the worker cannot share its module heap
 * and the PCM ring degrades to a postMessage chunk per audio callback. The
 * pthread build needs it regardless, but checking here keeps the fallback
 * decision in one place instead of failing later and further away.
 */
export function canUseRenderWorker({
    canvas,
    crossOriginIsolated = globalThis.crossOriginIsolated !== false,
}: CanUseRenderWorkerOptions = {}): boolean {
    return !!crossOriginIsolated && isRenderWorkerSupported(canvas);
}

export interface SelectRenderTopologyOptions {
    canvas: HTMLCanvasElement;
    preferWorker: boolean;
    /** The Emscripten glue the worker importScripts(). */
    scriptSrc: string;
    width: number;
    height: number;
    targetFps?: number | undefined;
    governor?: boolean | undefined;
    meshQuality?: string | undefined;
    contextConfig?: WasmContextConfig | undefined;
    renderPathOverrides?: RenderPathOverrides | undefined;
    /** Applied in the worker before the engine's first frame. */
    flashLimit?: FlashLimitSettings | null | undefined;
    /** See createWorkerTransport(). */
    wasmExports?: Iterable<string> | null | undefined;
    onFallback?: ((reason: string) => void) | undefined;
    onError?: ((message: string) => void) | undefined;
    onStats?: ((stats: RenderWorkerStatsMessage) => void) | undefined;
    /**
     * How long to wait for 'ready' before terminating the worker and resolving
     * null ({@link DEFAULT_RENDER_WORKER_BOOT_TIMEOUT_MS}).
     */
    bootTimeoutMs?: number | undefined;
    /**
     * Aborting while the worker boots terminates it and resolves null. Without
     * this a caller that gave up (its context was destroyed mid-boot) had no
     * handle to terminate: the worker, and the canvas it took by transfer,
     * outlived it.
     */
    signal?: AbortSignal | undefined;
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
    contextConfig,
    renderPathOverrides,
    flashLimit = null,
    wasmExports = null,
    onFallback,
    onError,
    onStats,
    bootTimeoutMs = DEFAULT_RENDER_WORKER_BOOT_TIMEOUT_MS,
    signal,
}: SelectRenderTopologyOptions): Promise<RenderTransport | null> {
    if (!preferWorker || signal?.aborted) {
        return Promise.resolve(null);
    }
    if (!canUseRenderWorker({ canvas })) {
        const reason =
            globalThis.crossOriginIsolated === false
                ? 'page is not cross-origin isolated'
                : renderWorkerUnsupportedReason(canvas);
        onFallback?.(`OffscreenCanvas, Worker, or cross-origin isolation unavailable: ${String(reason)}`);
        return Promise.resolve(null);
    }

    return new Promise<RenderTransport | null>((resolve) => {
        let settled = false;
        let handle: RenderWorkerHandle | null = null;
        let bootTimer: ReturnType<typeof setTimeout> | 0 = 0;

        const settle = (value: RenderTransport | null): void => {
            if (settled) return;
            settled = true;
            if (bootTimer) clearTimeout(bootTimer);
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        // A boot that ends without handing out a transport must not leave its
        // worker running: nobody else holds the handle. Terminated outright, not
        // shut down: a worker that failed its boot may not answer anything.
        const abandon = (): void => {
            handle?.terminate();
            settle(null);
        };
        const onAbort = (): void => {
            if (!settled) abandon();
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        handle = setupRenderWorker({
            canvas,
            scriptSrc,
            width,
            height,
            targetFps,
            governor,
            meshQuality,
            contextConfig,
            renderPathOverrides,
            flashLimit,
            onReady: () => settle(handle ? createWorkerTransport(handle, { exports: wasmExports }) : null),
            onUnsupported: (reason) => {
                onFallback?.(reason);
                if (!settled) abandon();
            },
            onInitError: ({ code, message }) => {
                if (settled) return;
                onFallback?.(`render worker failed to boot (init code ${code}): ${message}`);
                abandon();
            },
            // An error before 'ready' is a failed boot, so fall back; one after
            // is a live worker reporting a problem and belongs to the caller.
            onError: (message) => {
                if (!settled) {
                    onFallback?.(message);
                    abandon();
                    return;
                }
                onError?.(message);
            },
            onStats,
        });

        if (!handle) {
            settle(null);
            return;
        }
        if (bootTimeoutMs > 0 && Number.isFinite(bootTimeoutMs)) {
            bootTimer = setTimeout(() => {
                if (settled) return;
                onFallback?.(`render worker did not report ready within ${bootTimeoutMs} ms`);
                abandon();
            }, bootTimeoutMs);
        }
    });
}
