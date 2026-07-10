// projectm-experimental-bridge.js — opt-in bridge between B3HD advanced hooks and presets.
// Enable with ?experimental=1 on projectm-core.html (or full legacy hosts).
// Does not modify Milkdrop parsing; only injects host-side assets via the WASM VFS.

const DEFAULT_DEPTH_MODULE_URL = 'https://noahcohn.com/dpt-shader-sml-001.3ijs';
const DEPTH_TEXTURE_NAME = 'pm_depth_map.png';
const DEPTH_VFS_PATH = `/textures/${DEPTH_TEXTURE_NAME}`;

const PM_EXPERIMENTAL_HEADER = /^\/\/\s*pm:experimental\s+(.+)$/im;

/**
 * Parse `// pm:experimental key=value ...` header directives from .milk text.
 * @param {string} milkText
 * @returns {Record<string, string>}
 */
export function parseExperimentalMetadata(milkText) {
    const meta = {};
    if (!milkText) return meta;
    const match = milkText.match(PM_EXPERIMENTAL_HEADER);
    if (!match) return meta;
    for (const token of match[1].split(/\s+/)) {
        const eq = token.indexOf('=');
        if (eq === -1) {
            meta[token] = 'true';
        } else {
            meta[token.slice(0, eq)] = token.slice(eq + 1);
        }
    }
    return meta;
}

function decodeUtf32Module(uint8Array, littleEndian = true) {
    const view = new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
    let result = '';
    for (let i = 0; i < uint8Array.length; i += 4) {
        result += String.fromCodePoint(view.getUint32(i, littleEndian));
    }
    return result;
}

function ensureVfsDir(module, dir) {
    if (!module?.FS) return;
    dir.split('/').filter(Boolean).reduce((acc, part) => {
        const next = `${acc}/${part}`;
        try { module.FS.mkdir(next); } catch (_) { /* exists */ }
        return next;
    }, '');
}

/**
 * Write a PNG/JPEG blob into the preset texture VFS and optionally reload textures.
 * @param {*} module Emscripten module
 * @param {string} vfsPath e.g. /textures/pm_depth_map.png
 * @param {Uint8Array} bytes
 */
export function injectVfsTexture(module, vfsPath, bytes) {
    if (!module?.FS) throw new Error('WASM FS not ready');
    const dir = vfsPath.slice(0, vfsPath.lastIndexOf('/'));
    ensureVfsDir(module, dir);
    module.FS.writeFile(vfsPath, bytes);
}

async function dataUrlToBytes(dataUrl) {
    const res = await fetch(dataUrl);
    return new Uint8Array(await res.arrayBuffer());
}

async function imageToPngBytes(imageSource, maxSize = 512) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const loaded = new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to decode image'));
    });
    img.src = imageSource;
    await loaded;

    let { width, height } = img;
    if (width > maxSize || height > maxSize) {
        const scale = Math.min(maxSize / width, maxSize / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Lazy-load the legacy UTF-32 Depth Anything / Transformers.js module used by B3HD.
 * @param {string} url
 */
export async function loadDepthModule(url = DEFAULT_DEPTH_MODULE_URL) {
    if (window.__pmDepthModuleLoading) return window.__pmDepthModuleLoading;
    window.__pmDepthModuleLoading = (async () => {
        const xhr = new XMLHttpRequest();
        const buf = await new Promise((resolve, reject) => {
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = () => {
                if (xhr.status === 200) resolve(xhr.response);
                else reject(new Error(`Depth module HTTP ${xhr.status}`));
            };
            xhr.onerror = () => reject(new Error('Depth module network error'));
            xhr.send();
        });
        const code = decodeUtf32Module(new Uint8Array(buf), true);
        const scr = document.createElement('script');
        scr.type = 'module';
        scr.text = code;
        document.body.appendChild(scr);
        return true;
    })();
    return window.__pmDepthModuleLoading;
}

function postImageToDepthPipeline(imageDataUrl) {
    const ch = new BroadcastChannel('imageChannel');
    ch.postMessage({ imageDataURL: imageDataUrl });
    ch.close();
}

function requestGltfLoad(title) {
    const ch = new BroadcastChannel('loaderChannel');
    ch.postMessage({ GLloc: title || 'projectm_snapshot' });
    ch.close();
}

/**
 * @param {*} module
 * @param {{ reloadPresetPath?: string, displayName?: string }} options
 */
export async function applyDepthTexture(module, depthImageSource, options = {}) {
    const bytes = await imageToPngBytes(depthImageSource);
    injectVfsTexture(module, DEPTH_VFS_PATH, bytes);
    if (options.reloadPresetPath && module?.ccall) {
        module.ccall('load_preset_file', null, ['string'], [options.reloadPresetPath]);
        if (options.displayName && window.updatePresetDisplay) {
            window.updatePresetDisplay(options.displayName);
        }
    }
    window.dispatchEvent(new CustomEvent('pm:depth-texture-ready', {
        detail: { vfsPath: DEPTH_VFS_PATH, bytesLength: bytes.length }
    }));
    return DEPTH_VFS_PATH;
}

/**
 * Capture the live visualization canvas and run it through the depth pipeline.
 */
export async function captureCanvasForDepth(module, canvas, options = {}) {
    if (!canvas) throw new Error('Canvas not found');
    const dataUrl = canvas.toDataURL('image/png');
    await loadDepthModule(options.depthModuleUrl);
    postImageToDepthPipeline(dataUrl);
    return dataUrl;
}

/**
 * Opt-in experimental bridge. Safe to call when ?experimental=1 is absent (no-op).
 */
export function setupExperimentalBridge(module, options = {}) {
    const params = options.params || new URLSearchParams(location.search);
    if (params.get('experimental') !== '1') {
        return { enabled: false };
    }

    const depthModuleUrl = params.get('depthModule') || DEFAULT_DEPTH_MODULE_URL;
    const state = {
        enabled: true,
        lastMetadata: {},
        depthModuleUrl,
        pendingSource: null
    };

    window.pmExperimental = {
        state,
        parseExperimentalMetadata,
        injectVfsTexture,
        applyDepthTexture: (src, opts) => applyDepthTexture(module, src, opts),
        captureCanvasForDepth: (canvas, opts) => captureCanvasForDepth(module, canvas, { depthModuleUrl, ...opts }),
        loadDepthModule: () => loadDepthModule(depthModuleUrl),
        postImageToDepthPipeline,
        requestGltfLoad,
        /** Feed an upload / example image into Depth Anything, then bind result to presets. */
        async runDepthFromUpload(imageDataUrl, reloadOptions = {}) {
            await loadDepthModule(depthModuleUrl);
            postImageToDepthPipeline(imageDataUrl);
            state.pendingSource = imageDataUrl;
            return imageDataUrl;
        }
    };

    // Legacy B3HD channels — depth module posts results here; glTF loader listens here.
    const imageChannel = new BroadcastChannel('imageChannel');
    imageChannel.addEventListener('message', async (event) => {
        const url = event.data?.imageDataURL || event.data?.data;
        if (!url) return;
        try {
            await applyDepthTexture(module, url, {
                reloadPresetPath: window.currentPresetPath,
                displayName: window.currentPresetName
            });
            setStatus('Depth map injected as pm_depth_map.png');
        } catch (err) {
            console.warn('[pm:experimental] depth inject failed:', err);
            setStatus(`Depth inject failed: ${err.message}`, true);
        }
    });

    const resultImage = document.getElementById('resultImage');
    if (resultImage) {
        const observer = new MutationObserver(async () => {
            if (!resultImage.src || resultImage.src === state.lastResultSrc) return;
            state.lastResultSrc = resultImage.src;
            try {
                await applyDepthTexture(module, resultImage.src, {
                    reloadPresetPath: window.currentPresetPath,
                    displayName: window.currentPresetName
                });
                setStatus('Depth result bound to preset textures');
            } catch (err) {
                console.warn('[pm:experimental] resultImage hook failed:', err);
            }
        });
        observer.observe(resultImage, { attributes: true, attributeFilter: ['src'] });
    }

    window.addEventListener('pm:preset-loaded', async (event) => {
        const { name, path, text: detailText } = event.detail || {};
        let milkText = detailText || '';
        if (!milkText && path && module?.FS) {
            try {
                milkText = new TextDecoder().decode(module.FS.readFile(path));
            } catch (_) { /* preset may live outside VFS */ }
        }
        const meta = parseExperimentalMetadata(milkText);
        state.lastMetadata = meta;
        if (!Object.keys(meta).length) return;

        if (meta.depth === 'auto' || meta['depth-texture']) {
            const source = meta['depth-source'] || state.pendingSource;
            if (source) {
                setStatus('Preset requests depth map — processing…');
                await window.pmExperimental.runDepthFromUpload(source, {
                    reloadPresetPath: window.currentPresetPath,
                    displayName: name
                });
            } else {
                setStatus('Preset wants depth:auto — upload an image or capture canvas', true);
            }
        }

        if (meta['gltf-export'] === 'true' || meta['gltf-export'] === 'on-lock') {
            // Coordinator only — actual Three.js export lives in the legacy depth/glTF module.
            window.pmExperimental._gltfExportMode = meta['gltf-export'];
        }
    });

    injectPanel(module, state);
    console.info('[pm:experimental] bridge active — see docs/EXPERIMENTAL_PRESET_HOOKS.md');
    return { enabled: true, state };
}

function setStatus(message, isError = false) {
    const el = document.getElementById('pm-experimental-status');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('err', isError);
}

function injectPanel(module, state) {
    if (document.getElementById('pm-experimental-panel')) return;

    const style = document.createElement('style');
    style.textContent = `
#pm-experimental-panel {
  position: fixed; right: 8px; bottom: 8px; z-index: 99996;
  width: min(320px, 90vw); padding: 10px 12px;
  background: rgba(20, 12, 48, 0.94); border: 1px solid #7c3aed;
  border-radius: 8px; font: 11px "Lucida Console", monospace; color: #e9d5ff;
  box-shadow: 0 8px 24px rgba(0,0,0,0.45);
}
#pm-experimental-panel h4 { margin: 0 0 8px; font-size: 12px; color: #c4b5fd; }
#pm-experimental-panel button {
  background: #4c1d95; color: #f5f3ff; border: 1px solid #a78bfa;
  border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 11px;
}
#pm-experimental-panel button:hover { background: #6d28d9; }
#pm-experimental-panel .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
#pm-experimental-panel .pm-experimental-status { margin-top: 6px; min-height: 1.2em; color: #86efac; }
#pm-experimental-panel .pm-experimental-status.err { color: #fca5a5; }
`;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'pm-experimental-panel';
    panel.innerHTML = `
<h4>Experimental preset hooks</h4>
<div class="row">
  <button type="button" id="pm-exp-load-depth">Load depth AI</button>
  <button type="button" id="pm-exp-capture">Depth from canvas</button>
  <button type="button" id="pm-exp-gltf-load">glTF load</button>
  <button type="button" id="pm-exp-gltf-save">glTF save</button>
</div>
<div class="row">
  <label style="cursor:pointer"><input type="file" id="pm-exp-upload" accept="image/*" hidden />Upload image</label>
</div>
<div id="pm-experimental-status" class="pm-experimental-status">Idle</div>
`;
    document.body.appendChild(panel);

    document.getElementById('pm-exp-load-depth')?.addEventListener('click', async () => {
        try {
            setStatus('Loading Depth Anything module…');
            await loadDepthModule(state.depthModuleUrl);
            setStatus('Depth module loaded');
        } catch (err) {
            setStatus(err.message, true);
        }
    });

    document.getElementById('pm-exp-capture')?.addEventListener('click', async () => {
        const canvas = document.querySelector('#mcanvas');
        try {
            setStatus('Capturing canvas → depth pipeline…');
            await captureCanvasForDepth(module, canvas, { depthModuleUrl: state.depthModuleUrl });
            setStatus('Sent canvas frame to depth pipeline');
        } catch (err) {
            setStatus(err.message, true);
        }
    });

    document.getElementById('pm-exp-upload')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                setStatus('Upload → depth pipeline…');
                await window.pmExperimental.runDepthFromUpload(reader.result);
                state.pendingSource = reader.result;
                setStatus('Image sent to depth pipeline');
            } catch (err) {
                setStatus(err.message, true);
            }
        };
        reader.readAsDataURL(file);
    });

    document.getElementById('pm-exp-gltf-load')?.addEventListener('click', () => {
        const title = prompt('glTF scene title / URL key:', 'projectm_scene') || 'projectm_scene';
        requestGltfLoad(title);
        setStatus(`Posted loaderChannel: ${title}`);
    });

    document.getElementById('pm-exp-gltf-save')?.addEventListener('click', () => {
        const title = prompt('Export title:', window.currentPresetName || 'projectm_snapshot');
        const saveName = document.getElementById('saveName');
        const savedName = document.getElementById('savedName');
        if (saveName) saveName.textContent = title || '';
        if (savedName) savedName.value = title || '';
        setStatus(`Ready for glTF save: ${title || '(untitled)'}`);
        window.dispatchEvent(new CustomEvent('pm:gltf-save-requested', { detail: { title } }));
    });
}
