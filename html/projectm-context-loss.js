// projectm-context-loss.js
//
// Recovers from WebGL context loss (GPU driver reset, mobile tab
// backgrounding, etc.) without requiring a page reload.
//
// On "webglcontextlost":
//   - calls event.preventDefault() so the browser attempts recovery
//   - calls Module._pm_handle_context_loss() to tear down projectM's GL
//     state (see projectM_emscripten.cpp)
//   - shows a "Graphics paused — tap to restore" overlay
//
// On "webglcontextrestored" (or a tap on the overlay):
//   - re-runs checkInit(Module), which calls Module._init() and performs a
//     full re-initialization (new WebGL context, new projectM/playlist
//     instance)
//   - calls Module._start_render() to recreate the dual-FBO pipeline
//   - reloads the last-displayed preset via window.currentPresetPath (set by
//     updatePresetDisplay() in projectm-presets.js)
//
// See docs/EMSCRIPTEN.md for details and the Chrome DevTools test procedure.

import { checkInit } from './projectm-init-errors.js';
import { loadPresetFile, pmHandleContextLoss, startRender } from './generated/projectm-wasm-api.js';

const STYLE_ID = 'pm-context-lost-style';
const OVERLAY_ID = 'pm-context-lost';

const STYLE_CSS = `
#${OVERLAY_ID} {
  position: fixed;
  inset: 0;
  z-index: 99997;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.72);
  font-family: "Lucida Console", "Courier New", monospace;
  cursor: pointer;
}
#${OVERLAY_ID}.visible {
  display: flex;
}
#${OVERLAY_ID} .pm-context-lost-box {
  max-width: 420px;
  margin: 16px;
  padding: 24px 28px;
  background: linear-gradient(160deg, #1b2436, #0d1117);
  border: 1px solid #2a3f5f;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 24px rgba(61, 213, 243, 0.15);
  text-align: center;
}
#${OVERLAY_ID} .pm-context-lost-title {
  margin: 0 0 8px;
  font-size: 18px;
  color: #f87171;
}
#${OVERLAY_ID} .pm-context-lost-message {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: #94a3b8;
}
`;

/** @type {HTMLElement | null} */
let overlayEl = null;

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
        <div class="pm-context-lost-box">
            <h2 class="pm-context-lost-title">Graphics paused — tap to restore</h2>
            <p class="pm-context-lost-message">The browser reclaimed projectM's graphics context (this can happen after a long session or when the tab is backgrounded). Tap anywhere to restart the visualizer.</p>
        </div>
    `;
    document.body.appendChild(overlayEl);

    return overlayEl;
}

function showOverlay() {
    ensureOverlay().classList.add('visible');
}

function hideOverlay() {
    if (overlayEl) {
        overlayEl.classList.remove('visible');
    }
}

/**
 * Registers WebGL context-loss/restore handling for the given canvas.
 *
 * @param {*} Module The Emscripten module instance.
 * @param {{ canvasSelector?: string }} [options]
 */
export function setupContextLossRecovery(Module, { canvasSelector = '#mcanvas' } = {}) {
    const canvas = document.querySelector(canvasSelector);
    if (!canvas) {
        return;
    }

    let restoring = false;

    function restore() {
        if (restoring) {
            return;
        }
        restoring = true;
        try {
            if (!checkInit(Module)) {
                // init-error overlay is shown; its own Retry button re-runs init.
                return;
            }

            const mcanvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector(canvasSelector));
            if (!mcanvas) {
                return;
            }
            startRender(Module, mcanvas.width, mcanvas.height);

            if (window.currentPresetPath) {
                try {
                    loadPresetFile(Module, window.currentPresetPath);
                } catch (err) {
                    console.warn('[projectM] Failed to reload preset after context restore:', err);
                }
            }

            hideOverlay();
        } finally {
            restoring = false;
        }
    }

    canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        console.warn('[projectM] WebGL context lost.');
        if (Module && Module._pm_handle_context_loss) {
            pmHandleContextLoss(Module);
        }
        showOverlay();
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
        console.warn('[projectM] WebGL context restored.');
        restore();
    }, false);

    const overlay = ensureOverlay();
    overlay.addEventListener('click', () => {
        if (overlay.classList.contains('visible')) {
            restore();
        }
    });
}
