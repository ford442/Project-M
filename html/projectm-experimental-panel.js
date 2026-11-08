// The ?experimental=1 control panel for projectm-experimental-bridge.js: the
// floating panel, its buttons and the status line. Split out of
// projectm-experimental-bridge.js; the bridge passes its depth-pipeline entry
// points in rather than this module importing them back.

/**
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 * @typedef {import('./projectm-disposables.js').Disposables} Disposables
 */

/**
 * @param {string} message
 * @param {boolean} [isError]
 */
export function setStatus(message, isError = false) {
    const el = document.getElementById('pm-experimental-status');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('err', isError);
}

/**
 * @param {ProjectMModuleLike} module
 * @param {Record<string, any>} state
 * @param {{ bindDepthResult: (src?: string) => Promise<string>,
 *           runDepthFromUpload: (imageDataUrl: string) => Promise<string>,
 *           spawnDepthSprite: () => number,
 *           spawnDepthSpriteHint: () => string }} api
 *   Passed in rather than read back off `window.pmExperimental`.
 * @param {{ loadDepthModule: (url?: string) => Promise<unknown>,
 *           captureCanvasForDepth: (module: ProjectMModuleLike, canvas: HTMLCanvasElement | null, options?: { depthModuleUrl?: string }) => Promise<unknown>,
 *           requestGltfLoad: (title: string) => void }} depth
 *   The bridge's depth-pipeline entry points.
 * @param {Disposables} owned Takes the panel, its style and its listeners down on dispose.
 */
export function injectPanel(module, state, api, depth, owned) {
    // A panel left by a bridge that was never disposed is bound to that
    // bridge's state; replace it rather than leave this bridge without controls.
    document.getElementById('pm-experimental-panel')?.remove();

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
#pm-experimental-panel label.file-btn {
  background: #4c1d95; color: #f5f3ff; border: 1px solid #a78bfa;
  border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 11px;
}
`;
    owned.append(document.head, style);

    const panel = document.createElement('div');
    panel.id = 'pm-experimental-panel';
    panel.innerHTML = `
<h4>Experimental preset hooks</h4>
<div class="row">
  <button type="button" id="pm-exp-load-depth">Load depth AI</button>
  <button type="button" id="pm-exp-capture">Depth from canvas</button>
  <button type="button" id="pm-exp-bind">Bind result</button>
</div>
<div class="row">
  <button type="button" id="pm-exp-gltf-load">glTF load</button>
  <button type="button" id="pm-exp-gltf-save">glTF save</button>
  <button type="button" id="pm-exp-sprite">Depth sprite</button>
</div>
<div class="row">
  <label class="file-btn"><input type="file" id="pm-exp-upload" accept="image/*" hidden />Upload image</label>
</div>
<div id="pm-experimental-status" class="pm-experimental-status">Idle</div>
`;
    owned.append(document.body, panel);
    /** @param {string} selector */
    const control = (selector) => panel.querySelector(selector);

    owned.listen(control('#pm-exp-load-depth'), 'click', async () => {
        try {
            setStatus('Loading Depth Anything module…');
            await depth.loadDepthModule(state.depthModuleUrl);
            setStatus('Depth module loaded');
        } catch (err) {
            setStatus(err instanceof Error ? err.message : String(err), true);
        }
    });

    owned.listen(control('#pm-exp-capture'), 'click', async () => {
        const canvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector('#mcanvas'));
        try {
            setStatus('Capturing canvas → depth pipeline…');
            await depth.captureCanvasForDepth(module, canvas, { depthModuleUrl: state.depthModuleUrl });
            setStatus('Sent canvas frame to depth pipeline (await result)');
        } catch (err) {
            setStatus(err instanceof Error ? err.message : String(err), true);
        }
    });

    owned.listen(control('#pm-exp-bind'), 'click', async () => {
        try {
            setStatus('Binding depth result…');
            await api.bindDepthResult();
            setStatus('Depth result bound');
        } catch (err) {
            setStatus(err instanceof Error ? err.message : String(err), true);
        }
    });

    owned.listen(control('#pm-exp-upload'), 'change', (e) => {
        const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                setStatus('Upload → depth pipeline…');
                const dataUrl = String(reader.result);
                await api.runDepthFromUpload(dataUrl);
                state.pendingSource = dataUrl;
                setStatus('Image sent to depth pipeline (await result)');
            } catch (err) {
                setStatus(err instanceof Error ? err.message : String(err), true);
            }
        };
        reader.readAsDataURL(file);
    });

    owned.listen(control('#pm-exp-gltf-load'), 'click', () => {
        const title = prompt('glTF scene title / URL key:', 'projectm_scene') || 'projectm_scene';
        depth.requestGltfLoad(title);
        setStatus(`Posted loaderChannel: ${title}`);
    });

    owned.listen(control('#pm-exp-gltf-save'), 'click', () => {
        const title = prompt('Export title:', window.currentPresetName || 'projectm_snapshot');
        const saveName = document.getElementById('saveName');
        const savedName = /** @type {HTMLInputElement | null} */ (
            document.getElementById('savedName')
        );
        if (saveName) saveName.textContent = title || '';
        if (savedName) savedName.value = title || '';
        setStatus(`Ready for glTF save: ${title || '(untitled)'}`);
        window.dispatchEvent(new CustomEvent('pm:gltf-save-requested', { detail: { title } }));
    });

    owned.listen(control('#pm-exp-sprite'), 'click', () => {
        // An older bundle cannot take sprite code; the console gets it instead.
        if (!api.spawnDepthSprite()) {
            api.spawnDepthSpriteHint();
        }
    });
}
