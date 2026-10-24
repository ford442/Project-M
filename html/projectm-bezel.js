// projectm-bezel.js
//
// The B3HD bezel: the frame photo (#frm) drawn into the full-window #circle
// canvas with a circular hole for the visualizer, the glass overlay (#gl)
// sized around it, and the iris that opens on first draw. projectm_panel2.1ink
// used to carry this as a classic inline script with twenty page globals; the
// page shell (projectm-app-shell.js) now calls draw() whenever the layout
// changes and dispose() on teardown.
//
// Page contract (all optional; a page without them gets a no-op bezel):
//   #circle  <canvas>  full-window drawing surface
//   #frm     <img>     bezel frame photo
//   #gl      <img>     glass overlay
//   #tcan    <canvas>  scratch canvas for the scaled frame
//   #shut    text "2"  iris enabled (anything else: no iris)
//   #lns     text "1"  iris not yet opened ("2" once it has; kept for pages
//                      that read it)

import { createDisposables } from './projectm-disposables.js';

/** Milliseconds per pixel of iris radius: the iris opens at 2 ms/px, as it always has. */
const IRIS_MS_PER_PX = 2;

/**
 * @typedef {object} Bezel
 * @property {() => void} draw Redraws for the current window size. Safe to call
 *   before the images load: it draws once they have.
 * @property {() => void} dispose
 */

/**
 * @param {Document} documentRef
 * @param {object} [options]
 * @param {Window & typeof globalThis} [options.windowRef]
 * @returns {Bezel}
 */
export function createBezel(documentRef, { windowRef = window } = {}) {
    const owned = createDisposables({ label: 'projectM bezel' });
    const circle = /** @type {HTMLCanvasElement | null} */ (documentRef.getElementById('circle'));
    const frame = /** @type {HTMLImageElement | null} */ (documentRef.getElementById('frm'));
    const glass = /** @type {HTMLImageElement | null} */ (documentRef.getElementById('gl'));
    const scratch = /** @type {HTMLCanvasElement | null} */ (documentRef.getElementById('tcan'));
    if (!circle || !frame || !glass || !scratch || typeof circle.getContext !== 'function') {
        return { draw() {}, dispose() {} };
    }

    const irisEnabled = Number(documentRef.getElementById('shut')?.textContent ?? '') === 2;
    const lensMarker = documentRef.getElementById('lns');
    let irisOpened = Number(lensMarker?.textContent ?? '1') !== 1;
    /** @type {number | null} */
    let irisFrame = null;
    let waitingForImages = false;

    owned.add(() => {
        if (irisFrame !== null) windowRef.cancelAnimationFrame(irisFrame);
        irisFrame = null;
    });

    const loaded = () => frame.complete && !!frame.naturalWidth && glass.complete && !!glass.naturalWidth;

    function draw() {
        if (owned.disposed) return;
        if (!loaded()) {
            if (waitingForImages) return;
            waitingForImages = true;
            const onLoad = () => {
                if (!loaded()) return;
                waitingForImages = false;
                draw();
            };
            owned.listen(frame, 'load', onLoad);
            owned.listen(glass, 'load', onLoad);
            return;
        }
        if (!circle || !frame || !glass || !scratch) return;

        const height = windowRef.innerHeight;
        const width = Math.round(windowRef.innerWidth);
        circle.width = width;
        circle.height = height;

        const glassSize = Math.round(height * 1.133);
        glass.height = glassSize;
        glass.width = glassSize;

        const radius = Math.round(height / 2);
        const centerX = Math.round((width - height) / 2 + radius);

        scratch.height = height;
        scratch.width = width;
        const glassLeft = Math.round((width - glassSize) / 2);
        const glassTop = Math.round((glassSize - height) / 2);
        glass.style.cssText = `display:block;position:absolute;left:${glassLeft}px;right:${glassLeft}px;z-index:555;top:-${glassTop}px;`;

        const naturalWidth = frame.naturalWidth;
        const naturalHeight = frame.naturalHeight;
        const scaledWidth = Math.round((height / naturalHeight) * naturalWidth);
        const cropX = Math.round(((scaledWidth - width) / 2) * (naturalHeight / height));

        const ctx = circle.getContext('2d', { alpha: true, desynchronized: false });
        const scratchCtx = scratch.getContext('2d', { alpha: true });
        if (!ctx || !scratchCtx) return;

        /** @param {number} r */
        const disc = (r) => {
            ctx.beginPath();
            ctx.arc(centerX, radius, r, 0, 2 * Math.PI, false);
            ctx.fill();
        };
        /** One iris step: the grey disc, with a hole of radius `r` cut in it. */
        const iris = (/** @type {number} */ r) => {
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = 'rgba(168,168,168,1)';
            disc(radius);
            ctx.globalCompositeOperation = 'destination-out';
            disc(r);
        };

        scratchCtx.drawImage(
            frame,
            cropX,
            0,
            naturalWidth - Math.round(naturalWidth * 0.02),
            naturalHeight - Math.round(naturalHeight * 0.02),
            0,
            0,
            scaledWidth,
            height
        );

        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, width, height);
        const pattern = ctx.createPattern(scratch, 'no-repeat');
        if (pattern) ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, width, height);

        ctx.globalCompositeOperation = 'destination-out';
        disc(radius);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(168,168,168,1)';
        disc(radius);

        if (!irisEnabled) return;
        if (irisOpened) {
            // Keep it open across resizes.
            ctx.globalCompositeOperation = 'destination-out';
            disc(radius);
            return;
        }

        // Open the iris: one radius step every IRIS_MS_PER_PX, drawn per frame.
        irisOpened = true;
        if (lensMarker) lensMarker.textContent = '2';
        const startedAt = windowRef.performance?.now?.() ?? Date.now();
        const step = () => {
            const now = windowRef.performance?.now?.() ?? Date.now();
            const r = Math.min(radius, Math.floor((now - startedAt) / IRIS_MS_PER_PX));
            iris(r);
            irisFrame = r < radius ? windowRef.requestAnimationFrame(step) : null;
        };
        if (irisFrame !== null) windowRef.cancelAnimationFrame(irisFrame);
        irisFrame = windowRef.requestAnimationFrame(step);
    }

    return {
        draw,
        dispose: () => owned.dispose(),
    };
}
