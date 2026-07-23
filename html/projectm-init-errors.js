// projectm-init-errors.js
//
// Shows a user-visible overlay when projectM's WASM `init()` fails (WebGL/projectM
// setup), instead of leaving the user with a blank canvas and console-only errors.
//
// See docs/EMSCRIPTEN.md#init-error-codes for the meaning of the error codes below.

import { init as wasmInit } from './generated/projectm-wasm-api.js';

/** @type {Record<number, { title: string; message: string; hints: string[] }>} */
const ERROR_INFO = {
    2: {
        title: 'WebGL 2 Unavailable',
        message: 'projectM needs WebGL 2 with floating-point texture support, which your browser or GPU could not provide.',
        hints: [
            'Enable WebGL2 in your browser (e.g. chrome://flags or about:config).',
            'Turn off "Reduce GPU usage" / battery-saver modes, which can disable WebGL2 on mobile.',
            'On iOS, update to a recent Safari version with WebGL2 support.',
        ],
    },
    3: {
        title: 'projectM Failed to Start',
        message: 'The visualization engine could not start, even though the graphics context was created.',
        hints: [
            'This can happen on devices with very little free memory (e.g. low-RAM Android phones).',
            'Close other tabs or apps to free up memory, then press Retry.',
            'If the problem persists, reload the page.',
        ],
    },
    4: {
        title: 'Cross-Origin Isolation Unavailable',
        message: 'This build uses shared memory (SharedArrayBuffer) for audio and worker threads, which requires the page to be served with Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.',
        hints: [
            'If you are the site operator, see docs/DEPLOYMENT.md for required COOP/COEP headers.',
            'Reloading will not fix this — it depends on how the server sends this page.',
        ],
    },
};

const GENERIC_ERROR_INFO = {
    title: 'Initialization Failed',
    message: 'projectM could not start for an unknown reason.',
    hints: [
        'Reload the page and try again.',
        'Check the browser console for details.',
    ],
};

const TROUBLESHOOTING_URL = 'https://github.com/ford442/Project-M/blob/main/docs/EMSCRIPTEN.md#init-error-codes';

const STYLE_ID = 'pm-init-error-style';
const OVERLAY_ID = 'pm-init-error';

const STYLE_CSS = `
#${OVERLAY_ID} {
  position: fixed;
  inset: 0;
  z-index: 99999;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.72);
  font-family: "Lucida Console", "Courier New", monospace;
  color: #e2e8f0;
}
#${OVERLAY_ID}.visible {
  display: flex;
}
#${OVERLAY_ID} .pm-init-error-box {
  max-width: 480px;
  margin: 16px;
  padding: 24px 28px;
  background: linear-gradient(160deg, #1b2436, #0d1117);
  border: 1px solid #2a3f5f;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 24px rgba(61, 213, 243, 0.15);
}
#${OVERLAY_ID} .pm-init-error-title {
  margin: 0 0 8px;
  font-size: 18px;
  color: #f87171;
}
#${OVERLAY_ID} .pm-init-error-message {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 1.5;
  color: #cbd5e1;
}
#${OVERLAY_ID} .pm-init-error-hints {
  margin: 0 0 16px;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.5;
  color: #94a3b8;
}
#${OVERLAY_ID} .pm-init-error-hints li {
  margin-bottom: 4px;
}
#${OVERLAY_ID} .pm-init-error-docs {
  margin: 0 0 16px;
  font-size: 13px;
}
#${OVERLAY_ID} .pm-init-error-docs a {
  color: #60a5fa;
  text-decoration: underline;
}
#${OVERLAY_ID} .pm-init-error-retry {
  padding: 10px 22px;
  background-color: #2a3f5f;
  color: white;
  border: 2px solid #555;
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.3s ease;
}
#${OVERLAY_ID} .pm-init-error-retry:hover {
  background-color: #3a5f7f;
  box-shadow: 0 0 12px rgba(61, 213, 243, 0.3);
}
`;

/** @type {HTMLElement | null} */
let overlayEl = null;
/** @type {(() => void) | null} */
let retryCallback = null;

function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
}

/** @returns {HTMLElement} */
function ensureOverlay() {
    if (overlayEl) {
        return overlayEl;
    }

    injectStyles();

    overlayEl = document.getElementById(OVERLAY_ID);
    if (overlayEl) {
        return overlayEl;
    }

    overlayEl = document.createElement('div');
    overlayEl.id = OVERLAY_ID;
    overlayEl.innerHTML = `
        <div class="pm-init-error-box">
            <h2 class="pm-init-error-title"></h2>
            <p class="pm-init-error-message"></p>
            <ul class="pm-init-error-hints"></ul>
            <p class="pm-init-error-docs"><a href="${TROUBLESHOOTING_URL}" target="_blank" rel="noopener">Troubleshooting docs</a></p>
            <button type="button" class="pm-init-error-retry">Retry</button>
        </div>
    `;
    document.body.appendChild(overlayEl);

    overlayEl.querySelector('.pm-init-error-retry')?.addEventListener('click', () => {
        if (retryCallback) {
            retryCallback();
        }
    });

    return overlayEl;
}

/**
 * Shows the init-error overlay for the given error code (see docs/EMSCRIPTEN.md#init-error-codes).
 * @param {number} code The error code returned by `Module._init()`.
 * @param {string} [detail] Optional extra detail string from the C++ side.
 */
export function showInitError(code, detail) {
    const el = ensureOverlay();
    const info = ERROR_INFO[code] || GENERIC_ERROR_INFO;

    const titleEl = el.querySelector('.pm-init-error-title');
    if (titleEl) titleEl.textContent = info.title;
    const messageEl = el.querySelector('.pm-init-error-message');
    if (messageEl) {
        messageEl.textContent = detail ? `${info.message} (${detail})` : info.message;
    }

    const hintsEl = el.querySelector('.pm-init-error-hints');
    if (hintsEl) {
        hintsEl.innerHTML = '';
        info.hints.forEach((hint) => {
            const li = document.createElement('li');
            li.textContent = hint;
            hintsEl.appendChild(li);
        });
    }

    el.classList.add('visible');
    console.error(`[projectM] init() failed with code ${code}${detail ? ': ' + detail : ''}`);
}

/** Hides the init-error overlay, if visible. */
export function hideInitError() {
    if (overlayEl) {
        overlayEl.classList.remove('visible');
    }
}

/**
 * Sets up the init-error overlay and registers the `window.pmReportInitError` /
 * `window.pmHideInitError` hooks called from `projectM_emscripten.cpp`.
 *
 * @param {() => void} onRetry Called when the user clicks "Retry". Should re-run the full
 *   init + render setup.
 * @returns {{ simulate: boolean }} `simulate` is true if `?simulateInitFail=1` is present in
 *   the page URL; the overlay is shown immediately in that case for QA purposes. Callers
 *   should skip the real init attempt while `simulate` is true and clear it on retry.
 */
export function setupInitErrorHandling(onRetry) {
    retryCallback = onRetry;
    window.pmReportInitError = showInitError;
    window.pmHideInitError = hideInitError;
    ensureOverlay();

    const state = {
        simulate: new URLSearchParams(location.search).get('simulateInitFail') === '1',
    };

    if (state.simulate) {
        showInitError(2, 'Simulated failure via ?simulateInitFail=1');
    }

    return state;
}

/**
 * Checks `window.crossOriginIsolated` and shows the init-error overlay (code 4) if it is
 * false. This build is compiled with `-s SHARED_MEMORY=1 -pthread -s WASM_WORKERS=1`
 * (see CMakeLists.txt and docs/DEPLOYMENT.md), which requires the page to be served with
 * `Cross-Origin-Opener-Policy: same-origin` and a `Cross-Origin-Embedder-Policy` header —
 * without them, `SharedArrayBuffer` is unavailable and the WASM module's pthread runtime
 * fails to initialize.
 *
 * Call this *before* loading/instantiating the WASM module, so the failure is reported
 * with a clear message instead of a cryptic exception from the module loader.
 *
 * @returns {boolean} true if cross-origin isolation is available (or the browser does not
 *   expose `crossOriginIsolated`, e.g. very old browsers) and module loading can proceed.
 */
export function checkCrossOriginIsolation() {
    if (typeof window.crossOriginIsolated !== 'undefined' && !window.crossOriginIsolated) {
        showInitError(4);
        return false;
    }
    return true;
}

/**
 * Calls `Module._init()` and shows/hides the init-error overlay based on its return code.
 * @param {*} Module The Emscripten module instance.
 * @returns {boolean} true if initialization succeeded (code 0) and rendering can proceed.
 */
export function checkInit(Module) {
    const code = wasmInit(Module);
    if (code !== 0) {
        if (!overlayEl || !overlayEl.classList.contains('visible')) {
            showInitError(code);
        }
        return false;
    }
    hideInitError();
    return true;
}
