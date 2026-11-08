// Part of the render worker (html/projectm-render-worker.js), which loads it with
// importScripts() before it handles any message. A classic script: no imports, no
// top-level state of its own beyond the one factory it publishes on `self`.
//
// Live textures (projectM-4/live_input.h): writes a 'texture-frame' the host
// posted into the slot's staging buffer on this module's heap and commits it, so
// the engine's next render_frame() uploads it. Mirrors writeFrame() of
// createLiveTextureWriter() in html/projectm-live-texture.js, duplicated for the
// same no-imports reason as the PCM ring helpers. Registering and unregistering
// slots are plain ccalls; only the frames need a message of their own.

/**
 * @typedef {object} LiveTextureDeps
 * @property {() => WorkerModule | null} getModule
 * @property {(host: number | undefined) => void} selectEngine
 * @property {(message: RenderWorkerMessage, transfer?: Transferable[]) => void} postToHost
 * @property {(width: number, height: number) => OffscreenCanvas} [createCanvas]
 */

/**
 * @param {LiveTextureDeps} deps
 */
function createWorkerLiveTexture(deps) {
    /** @type {OffscreenCanvas | null} */
    let canvas = null;
    /** @type {OffscreenCanvasRenderingContext2D | null} */
    let context2d = null;
    /** Reported once: a bundle without the exports would otherwise fail every frame. */
    let reportedMissingExports = false;

    /**
     * @param {ImageBitmap} bitmap
     * @param {number} width
     * @param {number} height
     * @returns {Uint8ClampedArray}
     */
    function rasterize(bitmap, width, height) {
        if (!canvas) {
            canvas = deps.createCanvas ? deps.createCanvas(width, height) : new OffscreenCanvas(width, height);
            context2d = canvas.getContext('2d', { willReadFrequently: true });
            if (!context2d) {
                throw new Error('no 2D context on an OffscreenCanvas');
            }
        }
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (context2d);
        ctx.drawImage(bitmap, 0, 0, width, height);
        return ctx.getImageData(0, 0, width, height).data;
    }

    /**
     * @param {RenderWorkerTextureFrameMessage} msg
     */
    function writeTextureFrame(msg) {
        try {
            const m = deps.getModule();
            if (!m) return;
            if (typeof m._texture_slot_buffer !== 'function') {
                if (!reportedMissingExports) {
                    reportedMissingExports = true;
                    deps.postToHost({
                        type: 'error',
                        message: 'live textures: this projectM bundle predates texture_slot_buffer()',
                    });
                }
                return;
            }
            deps.selectEngine(msg.host);
            const bytes = msg.width * msg.height * 4;
            // 0 when the slot is gone or has another size by now: drop the frame.
            const ptr = Number(m.ccall('texture_slot_buffer', 'number', ['string', 'number'], [msg.name, bytes]));
            if (!ptr) return;
            const pixels = msg.pixels
                ? new Uint8Array(msg.pixels)
                : msg.bitmap
                  ? rasterize(msg.bitmap, msg.width, msg.height)
                  : null;
            if (!pixels || pixels.length !== bytes) return;
            // Read the view now, not earlier: a heap that grew has a new one.
            const heap = m.HEAPU8;
            if (!heap) return;
            heap.set(pixels, ptr);
            m.ccall('texture_slot_commit', 'number', ['string'], [msg.name]);
        } catch (error) {
            deps.postToHost({ type: 'error', message: `live texture "${msg.name}": ${String(error)}` });
        } finally {
            msg.bitmap?.close();
        }
    }

    return { writeTextureFrame };
}

// `self` is the worker global in a real worker, but not in a bundler-wrapped or
// node:vm scope: publish on it explicitly so the entry script finds it.
self.createWorkerLiveTexture = createWorkerLiveTexture;
