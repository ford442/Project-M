// projectm-live-texture-source.js
//
// The page side of a live texture (docs/LIVE_INPUT.md): a camera, or a video
// file, fed into a ProjectMContext live texture once per video frame.
//
//   projectm-core.html?liveTex=1                    the camera -> "webcam"
//   projectm-core.html?liveTex=1&liveTexSrc=<url>   a looping, muted video file
//   &liveTexName=<name>                             another texture name
//   &liveTexSize=<px>                               cap on the long side (default 1024)
//
// A preset samples it like any user texture (`sampler sampler_webcam;`, then
// `tex2D(sampler_webcam, uv)`); presets/experimental/live_texture_webcam.milk
// is one. The camera and the <video> live on the page's thread, which is where
// getUserMedia() works; frames reach the engine through
// ProjectMContext.updateTexture() in either render topology, never through the
// VFS. Nothing here loads unless the page asks for it.

import { DEFAULT_LIVE_TEXTURE_MAX_SIZE, isLiveTextureName } from './projectm-live-texture.js';

/**
 * @typedef {object} LiveTextureSourceConfig
 * @property {string} name The live texture's name.
 * @property {'camera' | string} src `'camera'`, or a video URL.
 * @property {number} maxSize Cap on the texture's long side.
 */

/**
 * @typedef {object} LiveTextureContext The part of ProjectMContext this drives.
 * @property {(name: string, width: number, height: number, options?: { followSource?: boolean }) => Promise<boolean>} registerTexture
 * @property {(name: string, source: HTMLVideoElement, options?: { maxSize?: number }) => Promise<boolean>} updateTexture
 * @property {(name: string) => Promise<boolean>} unregisterTexture
 */

/**
 * The `?liveTex=` options, or null when the page did not ask for a live texture.
 *
 * @param {URLSearchParams} params
 * @returns {LiveTextureSourceConfig | null}
 */
export function resolveLiveTextureConfig(params) {
    const enabled = params.get('liveTex');
    if (enabled !== '1' && enabled !== 'true') {
        return null;
    }
    const requestedName = params.get('liveTexName') || 'webcam';
    const size = parseInt(params.get('liveTexSize') || '', 10);
    return {
        name: isLiveTextureName(requestedName) ? requestedName : 'webcam',
        src: params.get('liveTexSrc') || 'camera',
        maxSize: Number.isFinite(size) && size > 0 ? size : DEFAULT_LIVE_TEXTURE_MAX_SIZE,
    };
}

/**
 * @typedef {object} LiveTextureSourceOptions
 * @property {Document} [documentRef]
 * @property {Navigator} [navigatorRef] For getUserMedia().
 * @property {Window} [windowRef] For requestAnimationFrame(), where the video has no requestVideoFrameCallback().
 * @property {string} [log] Console prefix.
 * @property {(status: 'streaming' | 'failed', detail?: unknown) => void} [onStatus]
 */

/**
 * Starts feeding `config.src` into the live texture `config.name`.
 *
 * The texture is registered at once as a 1x1 placeholder that follows its
 * source, so presets loaded from now on bind it, and grows to the video's size
 * with the first frame. Returns a disposer: it stops the frame loop and the
 * camera, removes the <video>, and unregisters the texture.
 *
 * @param {LiveTextureContext} context
 * @param {LiveTextureSourceConfig} config
 * @param {LiveTextureSourceOptions} [options]
 * @returns {{ dispose(): void, registered: Promise<boolean>, ready: Promise<boolean> }}
 *   `registered` settles once the texture exists (false if the engine refused
 *   it); `ready` once frames are flowing (false if the source failed).
 */
export function setupLiveTextureSource(context, config, options = {}) {
    const documentRef = options.documentRef ?? globalThis.document;
    const navigatorRef = options.navigatorRef ?? globalThis.navigator;
    const windowRef = options.windowRef ?? globalThis.window;
    const log = options.log ?? '[projectM]';
    const { name, src, maxSize } = config;

    let disposed = false;
    /** @type {MediaStream | null} */
    let stream = null;
    /** @type {(() => void) | null} */
    let cancelFrame = null;

    const video = /** @type {HTMLVideoElement} */ (documentRef.createElement('video'));
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('aria-hidden', 'true');
    video.style.display = 'none';
    documentRef.body?.appendChild(video);

    // Before any preset that samples it loads.
    const registered = context.registerTexture(name, 1, 1, { followSource: true }).catch((error) => {
        console.warn(`${log} live texture "${name}" could not be registered:`, error);
        return false;
    });

    const scheduleFrame = () => {
        if (disposed) return;
        const rvfc =
            /** @type {{ requestVideoFrameCallback?: (cb: () => void) => number, cancelVideoFrameCallback?: (id: number) => void }} */ (
                video
            );
        if (typeof rvfc.requestVideoFrameCallback === 'function') {
            // Once per decoded frame: a 30 fps camera costs 30 uploads, not 60.
            const id = rvfc.requestVideoFrameCallback(onFrame);
            cancelFrame = () => rvfc.cancelVideoFrameCallback?.(id);
        } else if (windowRef && typeof windowRef.requestAnimationFrame === 'function') {
            const id = windowRef.requestAnimationFrame(onFrame);
            cancelFrame = () => windowRef.cancelAnimationFrame(id);
        }
    };

    function onFrame() {
        cancelFrame = null;
        if (disposed) return;
        context
            .updateTexture(name, video, { maxSize })
            .catch((error) => console.warn(`${log} live texture "${name}": frame upload failed:`, error))
            .finally(scheduleFrame);
    }

    /** @returns {Promise<void>} */
    async function attachSource() {
        if (src === 'camera') {
            if (!navigatorRef?.mediaDevices?.getUserMedia) {
                throw new Error('this browser has no camera access (navigator.mediaDevices.getUserMedia)');
            }
            stream = await navigatorRef.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false,
            });
            if (disposed) {
                stopStream();
                return;
            }
            video.srcObject = stream;
        } else {
            // Cross-origin files need CORS, or the canvas read of the frame throws.
            video.crossOrigin = 'anonymous';
            video.loop = true;
            video.src = src;
        }
        await video.play();
    }

    function stopStream() {
        for (const track of stream?.getTracks() ?? []) {
            track.stop();
        }
        stream = null;
    }

    const ready = (async () => {
        try {
            if (!(await registered)) {
                throw new Error(`the engine refused live texture name "${name}"`);
            }
            await attachSource();
            if (disposed) return false;
            console.info(`${log} live texture "${name}" fed from ${src === 'camera' ? 'the camera' : src}`);
            options.onStatus?.('streaming');
            scheduleFrame();
            return true;
        } catch (error) {
            if (!disposed) {
                console.warn(`${log} live texture "${name}" has no source:`, error);
                options.onStatus?.('failed', error);
            }
            return false;
        }
    })();

    return {
        registered,
        ready,
        dispose() {
            if (disposed) return;
            disposed = true;
            cancelFrame?.();
            cancelFrame = null;
            stopStream();
            // Optional calls: a document that is not a browser's may hand back a
            // plain element, and dispose() must still take it down.
            video.pause?.();
            video.removeAttribute?.('src');
            video.srcObject = null;
            video.remove();
            void context.unregisterTexture(name).catch(() => {});
        },
    };
}
