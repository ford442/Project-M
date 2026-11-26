// GENERATED from projectm-render-transport.ts by scripts/build_html_ts.mjs — do not edit.
// Edit the .ts, then run `npm run build:html` (CI: npm run check:html-build).
import { DEFAULT_HOST, WASM_API_SIGNATURES, bindModuleToHost } from './generated/projectm-wasm-api.js';
import * as wasmApi from './generated/projectm-wasm-api.js';
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
function signatureFor(name) {
    if (!Object.prototype.hasOwnProperty.call(WASM_API_SIGNATURES, name)) {
        throw new Error(`Unknown projectM API call: ${name}`);
    }
    return WASM_API_SIGNATURES[name];
}
function coerceArgs(signature, args) {
    return signature.paramTypes.map((paramType, index) => {
        const arg = args[index];
        return paramType === 'boolean' ? (arg ? 1 : 0) : arg;
    });
}
export function createModuleTransport(module, { host = DEFAULT_HOST } = {}) {
    if (!module) {
        throw new Error('createModuleTransport requires a module instance');
    }
    const engine = bindModuleToHost(module, host);
    const scope = { engineHost: host };
    const invoke = (name, args) => {
        signatureFor(name);
        const wrapper = wasmApi[name];
        if (typeof wrapper !== 'function') {
            throw new Error(`projectM API call has no generated wrapper: ${name}`);
        }
        return wrapper(engine, ...args);
    };
    let liveTextures = null;
    const live = () => liveTextures ?? (liveTextures = createLiveTextures(createLiveTextureWriter(engine)));
    return {
        topology: 'main',
        module,
        host,
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
            feedPcm({ module, host }, buffer, { channels });
        },
        writePreset(vfsPath, bytes, mode = 'load') {
            const fs = module.FS;
            if (!fs) {
                throw new Error('Module.FS not available');
            }
            try {
                const dir = vfsPath.slice(0, vfsPath.lastIndexOf('/'));
                if (dir && fs.mkdirTree) fs.mkdirTree(dir);
            } catch (_) {}
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
            return () => {};
        },
        onPerfFrame(listener) {
            return subscribeWasmCallback('pmOnPerfFrame', listener, globalThis, scope);
        },
        onPerfHudEnabled(listener) {
            return subscribeWasmCallback('pmSetPerfHudEnabled', ({ enabled }) => listener(enabled), globalThis, scope);
        },
        onRhythmEvent(listener) {
            return subscribeWasmCallback('pmOnRhythmEvent', (event) => listener(event), globalThis, scope);
        },
        contextSnapshot() {
            return typeof module._get_context_snapshot === 'function' ? Number(invoke('getContextSnapshot', [])) : null;
        },
        recoverContext(width = 0, height = 0) {
            return new Promise((resolve) => {
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
function defaultCreateImageBitmap() {
    return typeof globalThis.createImageBitmap === 'function' ? globalThis.createImageBitmap.bind(globalThis) : null;
}
async function scaledBitmap(create, source, size) {
    const data = source.data;
    const natural = sourceSize(source);
    const isImageData = typeof ImageData === 'function' && source instanceof ImageData;
    const bitmapSource =
        !isImageData && (data instanceof Uint8Array || data instanceof Uint8ClampedArray) && natural
            ? new ImageData(new Uint8ClampedArray(data), natural.width, natural.height)
            : source;
    try {
        return await create(bitmapSource, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'low' });
    } catch (error) {
        if (!(error instanceof TypeError)) {
            throw error;
        }
        return create(bitmapSource);
    }
}
export function createWorkerTransport(handle, { exports = null, createImageBitmap = defaultCreateImageBitmap() } = {}) {
    if (!handle) {
        throw new Error('createWorkerTransport requires a render worker handle');
    }
    const exported = exports ? new Set(exports) : null;
    const ccallNumber = async (symbol, argTypes, args) => Number(await handle.ccall(symbol, 'number', argTypes, args));
    const liveTextures = createLiveTextures({
        registerSlot: async (name, width, height) =>
            !!(await ccallNumber('texture_slot_register', ['string', 'number', 'number'], [name, width, height])),
        unregisterSlot: async (name) => !!(await ccallNumber('texture_slot_unregister', ['string'], [name])),
        async writeFrame(name, size, source) {
            const pixels = pixelsOf(source, size);
            if (pixels) {
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
        call(name, ...args) {
            const signature = signatureFor(name);
            return handle.ccall(
                signature.symbol,
                signature.returnType,
                signature.argTypes,
                coerceArgs(signature, args)
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
            handle.postResize(width, height);
        },
        setFlashLimit(enabled, threshold) {
            handle.postFlashLimit(enabled, threshold);
        },
        captureFrame(options = {}) {
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
            void handle.shutdown();
        },
    };
}
export const DEFAULT_RENDER_WORKER_BOOT_TIMEOUT_MS = 3e4;
export function installTransportPresetWriter(transport) {
    return claimGlobal(globalThis, 'projectMWritePreset', (vfsPath, bytes, mode = 'load') =>
        transport.writePreset(vfsPath, bytes, mode)
    );
}
export function installTransportPcmWriter(transport) {
    return claimGlobal(globalThis, 'projectMWritePcmRing', (buffer, channels = 2) =>
        transport.feedPcm(buffer, channels)
    );
}
export function canUseRenderWorker({ canvas, crossOriginIsolated = globalThis.crossOriginIsolated !== false } = {}) {
    return !!crossOriginIsolated && isRenderWorkerSupported(canvas);
}
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
}) {
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
    return new Promise((resolve) => {
        let settled = false;
        let handle = null;
        let bootTimer = 0;
        const settle = (value) => {
            if (settled) return;
            settled = true;
            if (bootTimer) clearTimeout(bootTimer);
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const abandon = () => {
            handle?.terminate();
            settle(null);
        };
        const onAbort = () => {
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
