// GENERATED from projectm-render-worker.ts by scripts/build_html_ts.mjs — do not edit.
// Edit the .ts, then run `npm run build:html` (CI: npm run check:html-build).
const NO_HOST = 0;
function getCreateModule() {
    return self.createModule;
}
function postToHost(message, transfer = []) {
    self.postMessage(message, transfer);
}
let Module = null;
let engineHost = NO_HOST;
let statsInterval = 0;
let lastFrameTime = 0;
let lastFps = 0;
let surface = null;
let surfaceWidth = 0;
let surfaceHeight = 0;
let renderScale = 1;
function applySurfaceSize() {
    if (!surface || surfaceWidth <= 0 || surfaceHeight <= 0) return;
    const engine = selectEngine(engineHost);
    const scale = renderScale > 0 ? renderScale : 1;
    const width = Math.max(1, Math.round(surfaceWidth * scale));
    const height = Math.max(1, Math.round(surfaceHeight * scale));
    if (surface.width !== width || surface.height !== height) {
        surface.width = width;
        surface.height = height;
    }
    if (engine && engine._set_window_size) {
        engine._set_window_size(width, height);
    }
}
const engineViews = /* @__PURE__ */ new WeakMap();
function selectEngine(host) {
    const module = Module;
    if (!module) return null;
    const target = host || engineHost;
    if (typeof module._pm_host_is_live === 'function') {
        let views = engineViews.get(module);
        if (!views) {
            views = /* @__PURE__ */ new Map();
            engineViews.set(module, views);
        }
        let view = views.get(target);
        if (!view) {
            view = hostView(module, target);
            views.set(target, view);
        }
        return view;
    }
    if (!target) return module;
    if (typeof module._get_active_host === 'function' && module._get_active_host() === target) return module;
    try {
        module.ccall('set_active_host', null, ['number'], [target]);
    } catch (_) {}
    return module;
}
function hostView(module, host) {
    const pmExport = (name) => Reflect.get(module, `_pm_${name}`);
    return new Proxy(module, {
        get(obj, property) {
            const value = Reflect.get(obj, property);
            if (typeof property !== 'string' || typeof value !== 'function') return value;
            if (property === 'ccall') {
                const routed = (name, returnType, argTypes, args, ...rest) =>
                    typeof pmExport(name) === 'function'
                        ? value.call(
                              obj,
                              `pm_${name}`,
                              returnType,
                              ['number', ...(argTypes || [])],
                              [host, ...(args || [])],
                              ...rest
                          )
                        : value.call(obj, name, returnType, argTypes, args, ...rest);
                return routed;
            }
            if (!property.startsWith('_') || property.startsWith('_pm_')) return value;
            const pm = pmExport(property.slice(1));
            if (typeof pm !== 'function') return value;
            return (...args) => pm.call(obj, host, ...args);
        },
    });
}
importScripts('./worker/engine-hooks.js', './worker/pcm-ring.js', './worker/capture.js', './worker/live-texture.js');
const { flushPerfFrames } = self.installWorkerEngineHooks({
    getEngineHost: () => engineHost,
    postToHost,
    setRenderScale: (scale) => {
        renderScale = scale;
        applySurfaceSize();
    },
});
const { publishPcmRing, writePcmToRing, readPcmRingCounters } = self.createWorkerPcmRing({
    getModule: () => selectEngine(engineHost),
    postToHost,
});
const { applyFlashLimit, captureFrame } = self.createWorkerCapture({ selectEngine, postToHost });
const { writeTextureFrame } = self.createWorkerLiveTexture({ selectEngine, postToHost });
function installContextLossHandlers(canvas) {
    if (typeof canvas.addEventListener !== 'function') return;
    canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        const module = Module;
        if (module && typeof module._pm_handle_context_loss === 'function') {
            module._pm_handle_context_loss();
        }
        postToHost({ type: 'context-lost' });
    });
    canvas.addEventListener('webglcontextrestored', () => {
        postToHost({ type: 'context-restored' });
    });
}
function recoverContext(host) {
    if (!Module || !surface) {
        postToHost({ type: 'context-recovered', status: -1 });
        return;
    }
    let status;
    try {
        const engine = selectEngine(host);
        status = engine._init();
        if (status === 0) {
            engine._start_render(surface.width, surface.height);
        }
    } catch (error) {
        postToHost({ type: 'error', message: `context recovery failed: ${String(error)}` });
        postToHost({ type: 'context-recovered', status: -1 });
        return;
    }
    if (status === 0) {
        publishPcmRing();
    }
    postToHost({ type: 'context-recovered', status, ...(status === 0 ? contextSnapshotField() : {}) });
}
function contextSnapshotField() {
    const m = selectEngine(engineHost);
    return m && typeof m._get_context_snapshot === 'function' ? { contextSnapshot: m._get_context_snapshot() } : {};
}
function postStats() {
    flushPerfFrames();
    const engine = selectEngine(engineHost);
    if (!engine) return;
    const now = performance.now();
    if (lastFrameTime) {
        const delta = now - lastFrameTime;
        if (delta > 0) {
            lastFps = 1e3 / delta;
        }
    }
    lastFrameTime = now;
    const pcmRing = readPcmRingCounters();
    postToHost({
        type: 'stats',
        fps: lastFps,
        fboFormat: engine._dual_fbo_get_format ? engine._dual_fbo_get_format() : -1,
        qualityTier: engine._get_quality_tier ? engine._get_quality_tier() : -1,
        renderScale,
        renderPathOverrides: engine._get_render_path_overrides ? engine._get_render_path_overrides() : -1,
        ...(pcmRing ? { pcmRing } : {}),
    });
}
function handlePreset(module, msg) {
    const fs = module.FS;
    if (!fs) {
        postToHost({ type: 'error', message: 'preset write failed: module has no FS' });
        return;
    }
    try {
        const dir = msg.vfsPath.slice(0, msg.vfsPath.lastIndexOf('/'));
        if (dir && fs.mkdirTree) fs.mkdirTree(dir);
    } catch (_) {}
    try {
        fs.writeFile(msg.vfsPath, msg.bytes);
    } catch (error) {
        postToHost({ type: 'error', message: `preset write failed for ${msg.vfsPath}: ${String(error)}` });
        return;
    }
    const symbol =
        msg.mode === 'add'
            ? 'add_preset_file'
            : msg.mode === 'load-hard'
              ? 'load_preset_file_hard'
              : 'load_preset_file';
    try {
        module.ccall(symbol, null, ['string'], [msg.vfsPath]);
    } catch (error) {
        postToHost({ type: 'error', message: `${symbol} failed for ${msg.vfsPath}: ${String(error)}` });
    }
}
function handleCcall(module, msg) {
    let result;
    try {
        const argTypes = msg.argTypes || [];
        const args = msg.args || [];
        result = module.ccall(msg.name, msg.returnType || null, argTypes, args);
    } catch (error) {
        const message = `ccall ${msg.name} failed: ${String(error)}`;
        if (msg.requestId !== void 0) {
            postToHost({ type: 'ccall-rejected', requestId: msg.requestId, message });
        } else {
            postToHost({ type: 'error', message });
        }
        return;
    }
    if (msg.requestId !== void 0) {
        postToHost({ type: 'ccall-result', requestId: msg.requestId, result });
    }
}
let bootState = 'idle';
function stopStats() {
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = 0;
    }
}
function lastInitErrorCode() {
    const m = Module;
    try {
        return typeof m?._get_last_init_error === 'function' ? Number(m._get_last_init_error()) : -1;
    } catch (_) {
        return -1;
    }
}
function runInit(msg) {
    if (bootState !== 'idle') {
        postToHost({
            type: 'init-error',
            code: -1,
            message: `render worker already initialised (state: ${bootState})`,
        });
        return;
    }
    bootState = 'booting';
    init(msg).then(
        (ok) => {
            if (bootState === 'booting') bootState = ok ? 'ready' : 'failed';
        },
        (error) => {
            stopStats();
            if (bootState === 'shut-down') return;
            bootState = 'failed';
            postToHost({
                type: 'init-error',
                code: lastInitErrorCode(),
                message: `render worker init threw: ${String(error)}`,
            });
        }
    );
}
function shutdown() {
    const wasBooting = bootState === 'booting';
    bootState = 'shut-down';
    stopStats();
    flushPerfFrames();
    const m = selectEngine(engineHost);
    if (!wasBooting && m && typeof m._destruct === 'function') {
        try {
            m._destruct();
        } catch (error) {
            postToHost({ type: 'error', message: `engine shutdown failed: ${String(error)}` });
        }
    }
    Module = null;
    engineHost = NO_HOST;
    surface = null;
    postToHost({ type: 'shutdown-complete' });
}
async function init(msg) {
    if (typeof OffscreenCanvas === 'undefined' || typeof importScripts !== 'function') {
        postToHost({ type: 'unsupported', reason: 'OffscreenCanvas or importScripts unavailable in worker' });
        return false;
    }
    try {
        importScripts(msg.scriptSrc);
    } catch (error) {
        postToHost({ type: 'unsupported', reason: `failed to load ${msg.scriptSrc}: ${String(error)}` });
        return false;
    }
    const createModule = getCreateModule();
    if (typeof createModule !== 'function') {
        postToHost({ type: 'unsupported', reason: 'createModule not defined after importScripts' });
        return false;
    }
    try {
        Module = await createModule({
            canvas: msg.canvas,
            // The wrapper's main() calls init() the moment the module loads,
            // and init() needs the canvas registered below — which cannot
            // happen until the module object exists. So boot it inert and run
            // init() ourselves, exactly as ProjectMContext does on the main
            // thread.
            noInitialRun: true,
            // Where the pthread pool Workers load their copy of the glue from.
            //
            // Emscripten derives that URL from the running script's own
            // location, which inside this classic worker is html/, not the
            // directory we importScripts()'d the glue from. Every pool worker
            // then re-loaded *this* script, none joined the pool, and
            // createModule() waited forever for a pool that could not fill —
            // the silent boot hang that kept this topology opt-in. The glue
            // honours this override via src/wasm/pthread_script_url.pre.js.
            mainScriptUrlOrBlob: msg.scriptSrc,
            // Smoke wrapper embeds projectm-v.030-thread.wasm; deploy renames to
            // projectm-v.<ver>-thread.*. Remap from the loaded script URL so pm/
            // does not 404 to the UTF-16 HTML ErrorDocument.
            locateFile(path, prefix = '') {
                const smoke = 'projectm-v.030-thread';
                const match = /projectm-v\.\d+-thread/.exec(msg.scriptSrc || '');
                const target = match ? match[0] : null;
                let remapped = path;
                if (target && target !== smoke && typeof path === 'string' && path.includes(smoke)) {
                    remapped = path.split(smoke).join(target);
                }
                if (msg.scriptSrc) {
                    try {
                        return new URL(remapped, msg.scriptSrc).href;
                    } catch (_) {}
                }
                return `${prefix || ''}${remapped}`;
            },
        });
    } catch (error) {
        postToHost({ type: 'init-error', code: -1, message: `module init failed: ${String(error)}` });
        return false;
    }
    if (bootState === 'shut-down') {
        return false;
    }
    const targets = Module.specialHTMLTargets;
    if (!targets) {
        postToHost({
            type: 'unsupported',
            reason: 'bundle does not export specialHTMLTargets; rebuild with the current EXPORTED_RUNTIME_METHODS',
        });
        return false;
    }
    targets['#mcanvas'] = msg.canvas;
    const overrides = msg.renderPathOverrides;
    if (overrides && Module._set_render_path_overrides) {
        Module._set_render_path_overrides(
            overrides.blurCopyPath ? 1 : 0,
            overrides.copyShaderPath ? 1 : 0,
            overrides.perPixelForceCpu ? 1 : 0
        );
    }
    if (typeof Module._create_host_with_config !== 'function') {
        postToHost({
            type: 'unsupported',
            reason: 'bundle predates create_host_with_config(); rebuild, or render on the main thread',
        });
        return false;
    }
    const cfg = msg.contextConfig;
    const host = Module.ccall(
        'create_host_with_config',
        'number',
        ['string', 'string', 'number', 'number', 'number'],
        ['#mcanvas', '', cfg.flags, cfg.powerPreference, cfg.fboPrecision]
    );
    if (!host) {
        const code = Module._get_last_init_error ? Module._get_last_init_error() : -1;
        postToHost({
            type: 'init-error',
            message: `projectM engine creation failed in the render worker (init code ${code})`,
            code,
        });
        return false;
    }
    engineHost = Number(host);
    surface = msg.canvas;
    installContextLossHandlers(msg.canvas);
    surfaceWidth = msg.width;
    surfaceHeight = msg.height;
    if (msg.flashLimit) {
        applyFlashLimit(msg.flashLimit);
    }
    const engine = selectEngine(engineHost);
    engine._start_render(msg.width, msg.height);
    if (engine._set_target_fps && msg.targetFps) {
        engine._set_target_fps(msg.targetFps);
    }
    if (engine._set_quality_governor && msg.governor !== void 0) {
        engine._set_quality_governor(msg.governor ? 1 : 0);
    }
    if (engine._get_governor_render_scale) {
        renderScale = engine._get_governor_render_scale() || 1;
        applySurfaceSize();
    }
    if (engine._set_mesh && msg.meshQuality) {
        const [meshWidth, meshHeight] = msg.meshQuality === 'low' ? [64, 48] : [80, 60];
        engine._set_mesh(meshWidth, meshHeight);
    }
    publishPcmRing();
    stopStats();
    statsInterval = setInterval(postStats, 500);
    postToHost({ type: 'ready', host: engineHost, ...contextSnapshotField() });
    return true;
}
self.onmessage = (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'init':
            runInit(msg);
            break;
        case 'shutdown':
            shutdown();
            break;
        case 'resize':
            surfaceWidth = msg.width;
            surfaceHeight = msg.height;
            applySurfaceSize();
            break;
        case 'pcm':
            if (msg.buffer) {
                writePcmToRing(msg.buffer, msg.channels === 1 ? 1 : 2);
            }
            break;
        case 'preset':
            if (Module) {
                handlePreset(selectEngine(msg.host), msg);
            }
            break;
        case 'ccall':
            if (Module) {
                handleCcall(selectEngine(msg.host), msg);
            } else if (msg.requestId !== void 0) {
                postToHost({
                    type: 'ccall-rejected',
                    requestId: msg.requestId,
                    message: `ccall ${msg.name}: no engine in the render worker`,
                });
            }
            break;
        case 'recover-context':
            recoverContext(msg.host);
            break;
        case 'set-flash-limit':
            if (Module) {
                applyFlashLimit(msg, msg.host);
            }
            break;
        case 'texture-frame':
            writeTextureFrame(msg);
            break;
        case 'capture-frame':
            captureFrame(msg).catch((error) => {
                postToHost({
                    type: 'frame-captured',
                    requestId: msg.requestId,
                    error: `captureFrame() threw: ${String(error)}`,
                });
            });
            break;
        default:
            break;
    }
};
