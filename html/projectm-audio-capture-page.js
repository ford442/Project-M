// projectm-audio-capture-page.js
//
// html/audio-capture.html: the tab / system-audio capture popup the core page
// opens (window.openAudioCapture). Start / Stop around
// startDisplayAudioCapture() from projectm-display-capture.js, plus a status
// line and a stats readout. Moved out of the page's inline script so tsc and
// the lint gate see it.

import { startDisplayAudioCapture } from './projectm-display-capture.js';
import { createDisposables } from './projectm-disposables.js';

/**
 * @typedef {import('./projectm-display-capture.js').DisplayAudioCapture} DisplayAudioCapture
 */

/**
 * @param {Document} documentRef
 * @param {object} [options]
 * @param {Window} [options.windowRef]
 * @param {typeof startDisplayAudioCapture} [options.startCapture] Test seam.
 * @returns {{ dispose: () => void }}
 */
export function bootAudioCapturePage(
    documentRef,
    { windowRef = window, startCapture = startDisplayAudioCapture } = {}
) {
    const owned = createDisposables({ label: 'projectM audio capture page' });
    const startBtn = /** @type {HTMLButtonElement | null} */ (documentRef.getElementById('startBtn'));
    const stopBtn = /** @type {HTMLButtonElement | null} */ (documentRef.getElementById('stopBtn'));
    const statusEl = documentRef.getElementById('status');
    const statsEl = documentRef.getElementById('stats');
    if (!startBtn || !stopBtn || !statusEl || !statsEl) return { dispose: () => owned.dispose() };

    /** @type {DisplayAudioCapture | null} */
    let capture = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let statsTimer = null;
    const stopStats = () => {
        if (statsTimer) clearInterval(statsTimer);
        statsTimer = null;
    };
    owned.add(() => {
        stopStats();
        capture?.stop();
        capture = null;
    });

    /** @param {{ state: string, message: string }} status */
    function setStatus({ state, message }) {
        if (!startBtn || !stopBtn || !statusEl) return;
        statusEl.dataset.state = state;
        statusEl.textContent = message;
        const running = state === 'capturing' || state === 'silent' || state === 'requesting';
        startBtn.disabled = running;
        stopBtn.disabled = !running || state === 'requesting';
        if (!running) {
            capture = null;
            stopStats();
        }
    }

    function renderStats() {
        if (!statsEl) return;
        if (!capture) {
            statsEl.textContent = '';
            return;
        }
        const s = capture.stats();
        const seconds = s.sampleRate ? (s.frames / s.sampleRate).toFixed(1) : '0.0';
        statsEl.textContent = `${s.captureKind} · ${s.sampleRate || '?'} Hz · ${s.blocks} blocks · ${seconds}s sent via ${s.via}`;
    }

    // Must run straight from the click: getDisplayMedia() needs a user gesture.
    owned.listen(startBtn, 'click', () => {
        if (capture) return;
        startCapture({ onStatus: setStatus })
            .then((handle) => {
                if (!handle) return;
                if (owned.disposed) {
                    handle.stop();
                    return;
                }
                capture = handle;
                stopStats();
                statsTimer = setInterval(renderStats, 500);
                renderStats();
            })
            .catch((error) => setStatus({ state: 'error', message: `Capture failed: ${error}` }));
    });
    owned.listen(stopBtn, 'click', () => capture?.stop());
    owned.listen(windowRef, 'pagehide', () => capture?.stop());

    return { dispose: () => owned.dispose() };
}
