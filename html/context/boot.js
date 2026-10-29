// context/boot.js
//
// ProjectMContext's boot: loading the glue, creating the Module or the render
// worker, and creating this context's engine in it. projectm-context.js
// sequences these steps and owns what they return; nothing here keeps state.
//
// No `import.meta.url` in this directory. The package build bundles the host
// modules into flat chunks, where `import.meta.url` is the chunk's own URL,
// and the default WASM base has to be the URL of projectm-context.js (the
// entry the old code resolved against). Callers pass it in as `baseUrl`.

import {
    buildWasmBundlePaths,
    createProjectMModule,
    loadProjectMWasmScript,
    resolveWasmScriptUrl,
} from '../projectm-init.js';
import { loadWasmBuildsManifest } from '../projectm-wasm-manifest.js';
import { createModuleTransport, selectRenderTopology } from '../projectm-render-transport.js';
import {
    isCanvasTransferred,
    isRenderWorkerEnabled,
    replaceTransferredCanvas,
    resolveRenderPathOverrides,
} from '../projectm-render-worker-host.js';
import { checkInit } from '../projectm-init-errors.js';
import { createConfiguredHost, resolveFlashLimit, resolveWasmContextConfig } from '../projectm-context-config.js';
import { resolveDevicePixelRatio } from './render.js';

/**
 * @typedef {import('../generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('../projectm-transport-types.ts').RenderTransport} RenderTransport
 * @typedef {import('../projectm-context-types.ts').ProjectMResolvedContextOptions} ProjectMResolvedContextOptions
 * @typedef {import('../projectm-render-worker-types.ts').WasmContextConfig} WasmContextConfig
 * @typedef {import('../projectm-render-worker-types.ts').RenderPathOverrides} RenderPathOverrides
 * @typedef {{ pmScript: string, rootScript: string, api?: string[] | null }} BundlePaths
 */

let canvasIdSerial = 0;

/**
 * Dispatched (bubbling, from the new element) when the engine moved its WebGL
 * context to a fresh copy of the canvas element: a canvas keeps the first
 * context it gave out, so a context with other attributes needs another
 * element. `detail.previous` is the element it replaced. See
 * ReplaceCanvasElement() in src/wasm/WasmWebGLContext.cpp.
 */
export const CANVAS_REPLACED_EVENT = 'projectm-canvas-replaced';

/**
 * An error shaped like the one `fetch()` rejects with when aborted, so callers
 * can tell "this was cancelled" from "this failed" by `error.name`.
 *
 * @param {string} message
 * @returns {Error}
 */
export function createAbortError(message) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
    return !!error && typeof error === 'object' && /** @type {{ name?: unknown }} */ (error).name === 'AbortError';
}

/** @param {AbortSignal} signal */
export function throwIfAborted(signal) {
    if (signal.aborted) {
        throw createAbortError('ProjectMContext was destroyed during start()');
    }
}

/**
 * Ensure a canvas has a document-unique id for Emscripten CSS selectors.
 * @param {HTMLCanvasElement} canvas
 * @param {string} prefix
 * @returns {string} The resulting element id (without `#`).
 */
function ensureCanvasElementId(canvas, prefix) {
    if (canvas.id) {
        return canvas.id;
    }
    canvasIdSerial += 1;
    const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().slice(0, 8)
        : `${canvasIdSerial}-${Math.random().toString(36).slice(2, 8)}`;
    canvas.id = `${prefix}-${suffix}`;
    return canvas.id;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string | undefined} explicitSelector
 * @param {string} idPrefix
 * @returns {string}
 */
export function resolveCanvasSelector(canvas, explicitSelector, idPrefix) {
    if (explicitSelector) {
        return explicitSelector;
    }
    return `#${ensureCanvasElementId(canvas, idPrefix)}`;
}

/**
 * `create_host_with_config()`'s context arguments for these options — passed
 * with the create call on the main thread, and sent in the render worker's
 * `init` message. Defaults: MSAA off, preserveDrawingBuffer off, depth/stencil
 * off (#246 — the canvas only receives a fullscreen quad + sprites), WebGL
 * alpha only for a transparent context (an opaque canvas otherwise),
 * premultipliedAlpha on, software GL accepted, implicit present,
 * high-performance GPU, RGBA16F precision. The `alpha` option is the canvas-CSS
 * hint and is not part of it (`contextAlpha` is).
 *
 * @param {ProjectMResolvedContextOptions} options
 * @returns {WasmContextConfig}
 */
export function contextConfigFor(options) {
    return resolveWasmContextConfig(options);
}

/**
 * @param {ProjectMResolvedContextOptions} options
 * @returns {RenderPathOverrides}
 */
export function renderPathOverridesFor(options) {
    return options.renderPathOverrides
        ?? resolveRenderPathOverrides(options.windowRef?.location?.search ?? '');
}

/**
 * Hand the render-path switches to the WASM host before it creates the
 * engine. Bundles that predate the export read the switches from the URL
 * themselves, which works on this thread.
 *
 * @param {ProjectMModule | null} module
 * @param {RenderPathOverrides} overrides
 */
export function applyRenderPathOverrides(module, overrides) {
    if (module && typeof module._set_render_path_overrides === 'function') {
        module._set_render_path_overrides(
            overrides.blurCopyPath ? 1 : 0,
            overrides.copyShaderPath ? 1 : 0,
            overrides.perPixelForceCpu ? 1 : 0
        );
    }
}

/**
 * Loads `pm/builds.json` unless the caller named the glue itself (it names
 * each build's glue and exports; without it, or on timeout, the built-in
 * table is used), then returns the paths for `wasmVersion`.
 *
 * @param {{ baseUrl: string, wasmScriptUrl?: string, wasmVersion?: string, signal?: AbortSignal }} options
 * @returns {Promise<BundlePaths | null>}
 */
export async function resolveBundlePaths({ baseUrl, wasmScriptUrl, wasmVersion, signal }) {
    if (!wasmScriptUrl) {
        await loadWasmBuildsManifest({ baseUrl, signal });
    }
    return wasmVersion ? buildWasmBundlePaths(wasmVersion) : null;
}

/**
 * Loads the glue script: the one the caller named, or the one `wasmVersion`
 * (or the default build) resolves to.
 *
 * @param {{
 *   documentRef: Document | undefined,
 *   baseUrl: string,
 *   wasmScriptUrl?: string,
 *   wasmVersion?: string,
 *   versionPaths: BundlePaths | null,
 *   signal?: AbortSignal,
 * }} options
 */
export async function loadGlueScript({ documentRef, baseUrl, wasmScriptUrl, wasmVersion, versionPaths, signal }) {
    if (wasmScriptUrl) {
        await loadProjectMWasmScript({
            documentRef,
            baseUrl,
            pmScript: wasmScriptUrl,
            rootScript: wasmScriptUrl,
            forceRefresh: true,
            signal,
        });
        return;
    }
    await loadProjectMWasmScript({
        documentRef,
        baseUrl,
        ...(versionPaths ? { pmScript: versionPaths.pmScript, rootScript: versionPaths.rootScript } : {}),
        forceRefresh: Boolean(wasmVersion),
        signal,
    });
}

/**
 * Runs the glue's module factory without starting an engine.
 *
 * @param {{
 *   documentRef: Document | undefined,
 *   windowRef: (Window & typeof globalThis) | undefined,
 *   baseUrl: string,
 *   wasmScriptUrl?: string,
 *   wasmVersion?: string,
 *   primaryCanvasSelector?: string,
 *   secondaryCanvasSelector?: string,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<ProjectMModule>}
 */
export async function createModule({
    documentRef,
    windowRef,
    baseUrl,
    wasmScriptUrl,
    wasmVersion,
    primaryCanvasSelector,
    secondaryCanvasSelector,
    signal,
}) {
    return /** @type {ProjectMModule} */ (await createProjectMModule({
        scriptSrc: wasmScriptUrl || undefined,
        wasmVersion,
        baseUrl,
        documentRef,
        windowRef,
        noInitialRun: true,
        primaryCanvasSelector,
        secondaryCanvasSelector,
        signal,
    }));
}

/**
 * What {@link bootEngine} hands back as it goes. Each setter runs the moment
 * the thing exists — before the next await and before the next abort check —
 * so a destroy() that lands mid-boot still finds it and tears it down.
 *
 * @typedef {object} BootSink
 * @property {(module: ProjectMModule) => void} adoptModule Also publishes `window.Module`.
 * @property {(transport: RenderTransport) => void} adoptTransport
 * @property {(handle: number) => void} adoptHost
 * @property {(canvas: HTMLCanvasElement) => void} replaceCanvas
 * @property {(error: Error, code: number) => void} reportError
 */

/**
 * @typedef {object} BootRequest
 * @property {ProjectMResolvedContextOptions} options
 * @property {string} baseUrl
 * @property {HTMLCanvasElement} canvas
 * @property {Element} container
 * @property {string} primaryCanvasSelector
 * @property {string} secondaryCanvasSelector
 * @property {(message: string) => void} onRuntimeError A live worker's error after its boot.
 * @property {(stats: Record<string, unknown> & { fps?: number }) => void} onStats
 * @property {AbortSignal} signal
 */

/**
 * Creates this context's engine in one of three places and returns the
 * transport every engine call goes through:
 *
 *  - a shared Module (`options.sharedModule`, #168 Phase B): a dedicated host
 *    inside it, created with this context's config;
 *  - the render worker, when the topology asks for it and it boots;
 *  - otherwise a Module of its own on this thread.
 *
 * @param {BootRequest} request
 * @param {BootSink} sink
 * @returns {Promise<RenderTransport>}
 */
export async function bootEngine(request, sink) {
    const { options, baseUrl, signal } = request;
    const { wasmScriptUrl, wasmVersion, documentRef, windowRef, renderTopology, sharedModule } = options;

    const versionPaths = sharedModule
        ? (wasmVersion ? buildWasmBundlePaths(wasmVersion) : null)
        : await resolveBundlePaths({ baseUrl, wasmScriptUrl, wasmVersion, signal });
    throwIfAborted(signal);

    if (sharedModule) {
        // Reuse a Module booted by bootProjectMSharedModule() and create a
        // dedicated engine inside it. create_host() sets its own canvas
        // selectors and inits the engine, returning an opaque handle; every
        // engine op activates this host first.
        const module = /** @type {ProjectMModule} */ (sharedModule);
        sink.adoptModule(module);
        // The context config is an argument of the create call, so a sibling
        // context starting at the same time cannot take it.
        applyRenderPathOverrides(module, renderPathOverridesFor(options));
        const { handle, code } = followCanvasReplacement(request.canvas, documentRef, sink, () => createConfiguredHost(module, {
            primary: request.primaryCanvasSelector,
            secondary: request.secondaryCanvasSelector || '#scanvas',
            config: contextConfigFor(options),
        }));
        if (!handle) {
            const error = new Error(
                `create_host_with_config() failed (init code ${code}: instance cap reached or engine init failed)`
            );
            sink.reportError(error, code);
            throw error;
        }
        sink.adoptHost(handle);
        // Bound to this engine: every call it makes selects `handle` first, so
        // a sibling context activating its own engine while this one awaits
        // cannot redirect what comes after.
        const transport = createModuleTransport(module, { host: handle });
        sink.adoptTransport(transport);
        return transport;
    }

    // Topology first: the render worker takes the canvas by transfer, so it has
    // to be asked before anything on this thread touches a drawing context. A
    // worker that cannot start falls back to the main thread here and the rest
    // of start() is identical — that is the whole point of the transport.
    const preferWorker = renderTopology === 'worker'
        || (renderTopology === 'auto' && isRenderWorkerEnabled());
    let canvas = request.canvas;
    if (preferWorker) {
        const workerTransport = await startRenderWorker(request, versionPaths);
        if (workerTransport) {
            // Adopted before the abort check so a transport that arrives after
            // destroy() is still torn down.
            sink.adoptTransport(workerTransport);
        }
        throwIfAborted(signal);
        if (workerTransport) {
            return workerTransport;
        }
        if (renderTopology === 'worker') {
            throw new Error('renderTopology="worker" was requested but the render worker could not start');
        }
        if (isCanvasTransferred(canvas)) {
            // The worker took the canvas and then failed to boot. A transferred
            // canvas can never give out a context on this thread, so the
            // fallback draws into a fresh copy of it.
            canvas = replaceTransferredCanvas(canvas);
            sink.replaceCanvas(canvas);
        }
    }

    await loadGlueScript({ documentRef, baseUrl, wasmScriptUrl, wasmVersion, versionPaths, signal });
    throwIfAborted(signal);

    // A module factory cannot be cancelled once it is running, so this resolves
    // even if destroy() happened meanwhile. Adopting it first means teardown
    // destructs it.
    const module = await createModule({
        documentRef,
        windowRef,
        baseUrl,
        wasmScriptUrl,
        wasmVersion,
        primaryCanvasSelector: request.primaryCanvasSelector,
        secondaryCanvasSelector: request.secondaryCanvasSelector,
        signal,
    });
    sink.adoptModule(module);
    throwIfAborted(signal);

    // Render paths are fixed before the first preset; the context config
    // travels with the create call itself.
    applyRenderPathOverrides(module, renderPathOverridesFor(options));

    let initCode = -1;
    if (!followCanvasReplacement(canvas, documentRef, sink, () => checkInit(module, {
        primaryCanvasSelector: request.primaryCanvasSelector,
        secondaryCanvasSelector: request.secondaryCanvasSelector,
        contextConfig: contextConfigFor(options),
        onCode: (code) => { initCode = code; },
    }))) {
        const error = new Error(`projectM init failed (init code ${initCode})`);
        sink.reportError(error, initCode);
        throw error;
    }

    const transport = createModuleTransport(module);
    sink.adoptTransport(transport);
    return transport;
}

/**
 * Runs `create`, a synchronous engine create, and hands `sink` the element the
 * engine ended up drawing into if the create moved its context off `canvas`
 * (see {@link CANVAS_REPLACED_EVENT}). That happens when the canvas still holds
 * a context with other attributes — e.g. a context re-created on the same
 * element with a different `transparent` setting.
 *
 * @template T
 * @param {HTMLCanvasElement} canvas
 * @param {Document | undefined} documentRef
 * @param {BootSink} sink
 * @param {() => T} create
 * @returns {T}
 */
function followCanvasReplacement(canvas, documentRef, sink, create) {
    const target = documentRef ?? globalThis.document;
    if (typeof target?.addEventListener !== 'function') {
        return create();
    }
    /** @type {{ canvas: HTMLCanvasElement | null }} */
    const replaced = { canvas: null };
    const listener = (/** @type {Event} */ event) => {
        const { detail } = /** @type {CustomEvent<{ previous?: unknown }>} */ (event);
        if (detail?.previous === canvas) {
            replaced.canvas = /** @type {HTMLCanvasElement} */ (event.target);
        }
    };
    target.addEventListener(CANVAS_REPLACED_EVENT, listener);
    try {
        return create();
    } finally {
        target.removeEventListener(CANVAS_REPLACED_EVENT, listener);
        if (replaced.canvas) {
            sink.replaceCanvas(replaced.canvas);
        }
    }
}

/**
 * Boot the render worker and wrap it in a transport, or resolve null so the
 * boot falls back to the main thread.
 *
 * @param {BootRequest} request
 * @param {BundlePaths | null} versionPaths
 * @returns {Promise<RenderTransport | null>}
 */
async function startRenderWorker(request, versionPaths) {
    const { options, baseUrl, signal } = request;
    const { wasmScriptUrl, wasmVersion } = options;

    // The worker importScripts() the glue itself, so it needs an absolute URL —
    // resolved the same way the main-thread path resolves it, so both
    // topologies load the same bundle.
    let scriptSrc;
    try {
        const candidate = wasmScriptUrl ?? await resolveWasmScriptUrl({
            documentRef: options.documentRef,
            baseUrl,
            ...(versionPaths ? { pmScript: versionPaths.pmScript, rootScript: versionPaths.rootScript } : {}),
            forceRefresh: Boolean(wasmVersion),
            signal,
        });
        scriptSrc = new URL(candidate, baseUrl).href;
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        options.onRenderWorkerFallback?.(`could not resolve the WASM bundle URL: ${error}`);
        return null;
    }

    // Ask for the layout size: the worker sizes its own backing store from it,
    // including the governor's render scale.
    const rect = request.container.getBoundingClientRect();
    const dpr = resolveDevicePixelRatio(options);

    return selectRenderTopology({
        canvas: request.canvas,
        preferWorker: true,
        scriptSrc,
        width: Math.max(1, Math.round(rect.width * dpr)),
        height: Math.max(1, Math.round(rect.height * dpr)),
        targetFps: options.targetFps,
        governor: options.qualityGovernor,
        meshQuality: options.meshQuality,
        // The worker creates its context and picks its render paths in its own
        // init(); these have to travel with the init message.
        contextConfig: contextConfigFor(options),
        renderPathOverrides: renderPathOverridesFor(options),
        flashLimit: resolveFlashLimit(options),
        // The manifest's export list lets transport.supports() answer for the
        // worker's module instead of assuming every call exists.
        wasmExports: versionPaths?.api ?? null,
        ...(typeof options.renderWorkerBootTimeoutMs === 'number'
            ? { bootTimeoutMs: options.renderWorkerBootTimeoutMs }
            : {}),
        signal,
        onFallback: (reason) => {
            options.onRenderWorkerFallback?.(reason);
        },
        onError: (message) => {
            // A live worker reporting a problem after a successful boot.
            request.onRuntimeError(message);
        },
        onStats: (stats) => {
            request.onStats(/** @type {Record<string, unknown> & { fps?: number }} */ (/** @type {unknown} */ (stats)));
        },
    });
}
