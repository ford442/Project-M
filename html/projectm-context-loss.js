// projectm-context-loss.js
//
// Recovers from WebGL context loss (GPU driver reset, mobile tab
// backgrounding, etc.) without requiring a page reload.
//
// This module never touches the Emscripten Module. It talks to a
// RenderTransport (see projectm-transport-types.ts), so the same recovery runs
// whichever topology the engine is in:
//
//   main thread   the canvas is on this page, so the DOM events are heard here.
//                 On "webglcontextlost" this calls preventDefault() and the
//                 transport's pmHandleContextLoss(); on "webglcontextrestored"
//                 it asks the transport to recover.
//   render worker the canvas was transferred, so the events fire in the worker.
//                 The worker does the preventDefault()/pm_handle_context_loss()
//                 half itself and relays 'context-lost' / 'context-restored'
//                 (projectm-render-worker-types.ts); this module hears them
//                 through transport.onContextEvent() and asks the transport to
//                 recover, which posts 'recover-context'.
//
// Either way, recovery is transport.recoverContext(): init() rebuilds the engine
// on the restored context (it refuses with code 5 while the context is still
// lost, and the overlay stays up), start_render() recreates the dual-FBO
// pipeline, and the last-displayed preset is reloaded through the same
// transport from windowRef.currentPresetPath (set by updatePresetDisplay() in
// projectm-presets.js).
//
// The overlay ("Graphics paused — tap to restore") is page UI and needs a
// document; without one (headless, tests) recovery still runs, just silently.
//
// See docs/EMSCRIPTEN.md for details and the Chrome DevTools test procedure.

import { INIT_CONTEXT_LOST } from './projectm-init-errors.js';

/**
 * @typedef {import('./projectm-transport-types.ts').RenderTransport} RenderTransport
 *
 * The one thing recovery needs from a ProjectMContext: which transport it is
 * driving right now, and (optionally) a recovery entry point that activates
 * the context's own host first.
 * @typedef {{ transport: RenderTransport | null, recoverContext?: () => Promise<number> }} ContextLossTarget
 */

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

/**
 * @param {Document} doc
 * @returns {HTMLElement}
 */
function ensureOverlay(doc) {
    const existing = doc.getElementById(OVERLAY_ID);
    if (existing) {
        return existing;
    }

    if (!doc.getElementById(STYLE_ID)) {
        const style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLE_CSS;
        doc.head.appendChild(style);
    }

    const overlay = doc.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
        <div class="pm-context-lost-box">
            <h2 class="pm-context-lost-title">Graphics paused — tap to restore</h2>
            <p class="pm-context-lost-message">The browser reclaimed projectM's graphics context (this can happen after a long session or when the tab is backgrounded). Tap anywhere to restart the visualizer.</p>
        </div>
    `;
    doc.body.appendChild(overlay);
    return overlay;
}

/**
 * @param {ContextLossTarget | RenderTransport} target
 * @returns {target is RenderTransport}
 */
function isTransport(target) {
    return typeof (/** @type {RenderTransport} */ (target)).topology === 'string';
}

/**
 * Registers WebGL context-loss/restore handling for an engine.
 *
 * @param {ContextLossTarget | RenderTransport} target A ProjectMContext (its
 *   transport is looked up when needed, so a context that restarts is followed)
 *   or a bare RenderTransport.
 * @param {object} [options]
 * @param {HTMLCanvasElement | null} [options.canvas] The render canvas. Only
 *   listened to on the main thread; in the worker topology it has been
 *   transferred and the worker reports the events instead.
 * @param {Document | null} [options.documentRef] Where the overlay lives.
 *   Defaults to the global document, if there is one.
 * @param {(Window & typeof globalThis) | null} [options.windowRef] Where
 *   `currentPresetPath` is read from. Defaults to the global window.
 * @returns {() => void} Removes every listener this call added (on the canvas,
 *   the overlay and the transport). They used to stay attached for the life of
 *   the page, holding the destroyed module and canvas alive and, after a
 *   destroy(), still able to re-init a torn-down engine.
 */
export function setupContextLossRecovery(target, {
    canvas = null,
    documentRef = globalThis.document ?? null,
    windowRef = globalThis.window ?? null,
} = {}) {
    /** @returns {RenderTransport | null} */
    const getTransport = () => (isTransport(target) ? target : target.transport);

    const transport = getTransport();
    if (!transport) {
        return () => {};
    }

    /** @type {Array<() => void>} */
    const disposers = [];
    let disposed = false;
    let lost = false;
    let restoring = false;

    const showOverlay = () => {
        if (documentRef) ensureOverlay(documentRef).classList.add('visible');
    };
    const hideOverlay = () => {
        documentRef?.getElementById(OVERLAY_ID)?.classList.remove('visible');
    };

    /** @returns {Promise<number>} init()'s status. */
    const recover = () => {
        const current = getTransport();
        if (!current) {
            return Promise.resolve(-1);
        }
        // A context's own recoverContext() activates its host first, which
        // matters when several engines share one Module.
        if (!isTransport(target) && typeof target.recoverContext === 'function') {
            return target.recoverContext();
        }
        return current.recoverContext(canvas?.width, canvas?.height);
    };

    const reloadPreset = () => {
        const path = /** @type {{ currentPresetPath?: string } | null} */ (windowRef)?.currentPresetPath;
        if (!path) {
            return;
        }
        try {
            getTransport()?.callVoid('loadPresetFile', path);
        } catch (err) {
            console.warn('[projectM] Failed to reload preset after context restore:', err);
        }
    };

    const restore = async () => {
        // Only a context that actually lost its engine is rebuilt: init() on a
        // healthy one would tear down a working engine, and the overlay is
        // shared by every context on the page.
        if (disposed || !lost || restoring) {
            return;
        }
        restoring = true;
        try {
            const status = await recover();
            if (disposed || status === INIT_CONTEXT_LOST) {
                // The browser has not restored the context yet (a tap on the
                // overlay can come first): the overlay stays up and the
                // restored notification retries.
                return;
            }
            if (status !== 0) {
                // A real init failure. The engine reports it to the page's
                // init-error overlay, whose Retry button re-runs init.
                console.error(`[projectM] Context restore failed: init() returned ${status}`);
                return;
            }
            lost = false;
            reloadPreset();
            hideOverlay();
        } catch (err) {
            console.error('[projectM] Context restore failed:', err);
        } finally {
            restoring = false;
        }
    };

    const handleLost = () => {
        console.warn('[projectM] WebGL context lost.');
        lost = true;
        showOverlay();
    };
    const handleRestored = () => {
        console.warn('[projectM] WebGL context restored.');
        void restore();
    };

    if (transport.topology === 'worker') {
        disposers.push(transport.onContextEvent((event) => {
            if (event === 'lost') {
                handleLost();
            } else {
                handleRestored();
            }
        }));
    } else if (canvas) {
        const onContextLost = (/** @type {Event} */ event) => {
            // Required for the browser to consider restoring the context.
            event.preventDefault();
            // Resets projectM's GL bookkeeping; every GL call it would make on
            // a lost context is a no-op, so this only tears down state.
            if (transport.supports('pmHandleContextLoss')) {
                transport.callVoid('pmHandleContextLoss');
            }
            handleLost();
        };
        canvas.addEventListener('webglcontextlost', onContextLost, false);
        canvas.addEventListener('webglcontextrestored', handleRestored, false);
        disposers.push(() => {
            canvas.removeEventListener('webglcontextlost', onContextLost, false);
            canvas.removeEventListener('webglcontextrestored', handleRestored, false);
        });
    }

    if (documentRef) {
        const overlay = ensureOverlay(documentRef);
        const onOverlayClick = () => {
            void restore();
        };
        overlay.addEventListener('click', onOverlayClick);
        disposers.push(() => overlay.removeEventListener('click', onOverlayClick));
    }

    return () => {
        if (disposed) {
            return;
        }
        disposed = true;
        for (const dispose of disposers) {
            dispose();
        }
    };
}
