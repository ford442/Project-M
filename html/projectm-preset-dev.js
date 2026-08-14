// projectm-preset-dev.js — hot-reload, URL polling, inline editor for preset development.
// See docs/SIGNATURE_SERIES_WORKFLOW.md

import { getLocalPresetVfsPath, updatePresetDisplay } from './projectm-presets.js';
import { loadPresetFile } from './generated/projectm-wasm-api.js';
import { setupPresetTweaker } from './projectm-preset-tweaker.js';

/**
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 */

/**
 * The Emscripten FS surface this module needs. The generated
 * `EmscriptenModule['FS']` type only declares `writeFile` (that is all the
 * generated wrappers use), but the dev panel also has to create the `/presets`
 * directory chain, so it describes the wider shape locally rather than widening
 * the shared generated type.
 *
 * @typedef {object} DevPresetFS
 * @property {(path: string, data: Uint8Array | string) => void} writeFile
 * @property {(path: string) => void} mkdir Throws if the directory already exists.
 */

const STYLE_ID = 'pm-preset-dev-style';
const PANEL_ID = 'pm-preset-dev-panel';

const STYLE_CSS = `
#${PANEL_ID} {
  position: fixed;
  left: 8px;
  bottom: 8px;
  z-index: 99997;
  width: min(420px, 92vw);
  max-height: 45vh;
  overflow: auto;
  padding: 10px 12px;
  background: rgba(13, 17, 23, 0.94);
  border: 1px solid #334155;
  border-radius: 8px;
  font-family: "Lucida Console", monospace;
  font-size: 11px;
  color: #e2e8f0;
  box-shadow: 0 8px 24px rgba(0,0,0,0.45);
}
#${PANEL_ID} h4 { margin: 0 0 8px; font-size: 12px; color: #94a3b8; }
#${PANEL_ID} textarea {
  width: 100%;
  min-height: 120px;
  box-sizing: border-box;
  background: #0d1117;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 4px;
  font-family: inherit;
  font-size: 10px;
  resize: vertical;
}
#${PANEL_ID} .pm-dev-row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
#${PANEL_ID} button {
  background: #1e3a5f;
  color: #e2e8f0;
  border: 1px solid #3b82f6;
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 11px;
}
#${PANEL_ID} button:hover { background: #2563eb; }
#${PANEL_ID} .pm-dev-status { color: #86efac; margin-top: 6px; min-height: 1.2em; }
#${PANEL_ID} .pm-dev-status.err { color: #fca5a5; }
#${PANEL_ID} input[type=text] {
  flex: 1;
  min-width: 160px;
  background: #0d1117;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 4px 6px;
}
`;

/**
 * Queries an element this module itself just rendered. A miss means the panel
 * markup above and this lookup have drifted apart, which is a programming
 * error rather than a runtime condition to handle.
 *
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {Element}
 */
function requireEl(root, selector) {
    const el = root.querySelector(selector);
    if (!el) {
        throw new Error(`projectm-preset-dev: panel is missing ${selector}`);
    }
    return el;
}

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
}

/**
 * @param {ProjectMModuleLike | null | undefined} module
 * @param {string} vfsPath
 * @param {Uint8Array} bytes
 * @param {object} options
 * @param {((opts?: { module?: ProjectMModuleLike | null, durationSec?: number }) => Promise<boolean>) | undefined} [options.startTransitionWhenReady]
 * @param {string} [options.displayName]
 */
async function loadPresetBytes(module, vfsPath, bytes, { startTransitionWhenReady, displayName }) {
    if (!module?.FS || !module.ccall) throw new Error('Module not ready');
    const fs = /** @type {DevPresetFS} */ (/** @type {unknown} */ (module.FS));
    const dir = vfsPath.slice(0, vfsPath.lastIndexOf('/'));
    if (dir) {
        dir.split('/').filter(Boolean).reduce((acc, part) => {
            const next = acc + '/' + part;
            try { fs.mkdir(next); } catch { /* already exists */ }
            return next;
        }, '');
    }
    fs.writeFile(vfsPath, bytes);
    // `load_preset_file` is a ccall manifest entry, so the readiness check above
    // probes `ccall` rather than a `_`-prefixed member that the type never has.
    loadPresetFile(/** @type {import('./generated/projectm-wasm-api.ts').ProjectMModule} */ (module), vfsPath);
    let milkText;
    try {
        milkText = new TextDecoder().decode(bytes);
    } catch (_) {
        milkText = undefined;
    }
    updatePresetDisplay(displayName || vfsPath, { text: milkText });
    if (typeof startTransitionWhenReady === 'function') {
        await startTransitionWhenReady();
    }
}

/**
 * Installs the `?devPreset=1` hot-reload panel (URL polling + inline editor).
 *
 * @param {ProjectMModuleLike} Module
 * @param {object} [options]
 * @param {(opts?: { module?: ProjectMModuleLike | null, durationSec?: number }) => Promise<boolean>} [options.startTransitionWhenReady]
 * @param {URLSearchParams} [options.params]
 * @returns {{ enabled: boolean } & Record<string, unknown>}
 */
export function setupPresetDevTools(Module, options = {}) {
    const params = options.params || new URLSearchParams(location.search);
    const enabled = params.get('devPreset') === '1' || params.get('localPresets') === '1';
    if (!enabled) {
        return { enabled: false };
    }

    injectStyles();
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <h4>Preset dev — hot reload</h4>
            <div class="pm-dev-row">
                <input type="text" id="pm-dev-url" placeholder="Poll URL (optional)" />
                <button type="button" id="pm-dev-poll-toggle">Poll</button>
            </div>
            <textarea id="pm-dev-editor" spellcheck="false" placeholder="Paste .milk here — Ctrl+S or Apply to reload"></textarea>
            <div class="pm-dev-row">
                <button type="button" id="pm-dev-apply">Apply (reload)</button>
                <button type="button" id="pm-dev-fetch">Fetch URL once</button>
            </div>
            <div class="pm-dev-status" id="pm-dev-status"></div>
        `;
        document.body.appendChild(panel);
    }

    const statusEl = requireEl(panel, '#pm-dev-status');
    const editor = /** @type {HTMLTextAreaElement} */ (requireEl(panel, '#pm-dev-editor'));
    const urlInput = /** @type {HTMLInputElement} */ (requireEl(panel, '#pm-dev-url'));
    const pollBtn = /** @type {HTMLButtonElement} */ (requireEl(panel, '#pm-dev-poll-toggle'));

    const devUrl = params.get('devPresetUrl') || '';
    const pollMs = Math.max(500, parseInt(params.get('devPollMs') ?? '', 10) || 2000);
    if (devUrl) urlInput.value = devUrl;

    /** @type {ReturnType<typeof setInterval> | null} */
    let pollTimer = null;
    let lastFingerprint = '';

    /**
     * @param {string} msg
     * @param {boolean} [isError]
     */
    function setStatus(msg, isError = false) {
        statusEl.textContent = msg;
        statusEl.classList.toggle('err', isError);
    }

    /**
     * @param {string} text
     * @param {string} [label]
     */
    async function reloadFromText(text, label = 'dev_edit.milk') {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(text);
        const vfsPath = getLocalPresetVfsPath(label);
        await loadPresetBytes(Module, vfsPath, bytes, {
            startTransitionWhenReady: options.startTransitionWhenReady,
            displayName: label,
        });
        setStatus(`Reloaded ${label} @ ${new Date().toLocaleTimeString()}`);
    }

    /**
     * @param {string} url
     * @returns {Promise<string>}
     */
    async function fetchUrl(url) {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const name = url.split('/').pop() || 'polled.milk';
        editor.value = text;
        await reloadFromText(text, name);
        lastFingerprint = `${response.headers.get('etag') || ''}:${text.length}`;
        return text;
    }

    requireEl(panel, '#pm-dev-apply').addEventListener('click', () => {
        void reloadFromText(editor.value).catch((e) => setStatus(String(e), true));
    });

    requireEl(panel, '#pm-dev-fetch').addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (!url) return setStatus('Enter a URL', true);
        void fetchUrl(url).catch((e) => setStatus(String(e), true));
    });

    editor.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            void reloadFromText(editor.value).catch((err) => setStatus(String(err), true));
        }
    });

    pollBtn.addEventListener('click', () => {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
            pollBtn.textContent = 'Poll';
            setStatus('Polling stopped');
            return;
        }
        const url = urlInput.value.trim();
        if (!url) return setStatus('Enter a URL to poll', true);
        pollBtn.textContent = 'Stop';
        setStatus(`Polling every ${pollMs}ms…`);
        pollTimer = setInterval(() => {
            fetch(url, { cache: 'no-store' })
                .then(async (r) => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    const text = await r.text();
                    const fp = `${r.headers.get('etag') || ''}:${text.length}`;
                    if (fp !== lastFingerprint) {
                        editor.value = text;
                        await reloadFromText(text, url.split('/').pop());
                        lastFingerprint = fp;
                    }
                })
                .catch((e) => setStatus(`Poll error: ${e}`, true));
        }, pollMs);
    });

    const tweaker = setupPresetTweaker({
        // No `module` here: setupPresetTweaker never reads one — it works purely
        // on the .milk text and hands the patched result back through onApply.
        onApply: async (patchedText) => {
            editor.value = patchedText;
            await reloadFromText(patchedText, 'tweaked.milk');
        },
    });

    if (params.get('devPoll') === '1' && devUrl) {
        setTimeout(() => pollBtn.click(), 500);
    }

    window.pmReloadPresetText = reloadFromText;
    window.pmPresetDevEnabled = true;

    return { enabled: true, reloadFromText, tweaker };
}
