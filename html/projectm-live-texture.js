// projectm-live-texture.js
//
// Live textures (projectM-4/live_input.h, docs/LIVE_INPUT.md): frames from a
// camera, a <video>, a canvas or raw pixels uploaded into a texture presets
// sample by name (`sampler_webcam` for "webcam"), as often as the source has a
// new frame. Not a PNG written to the VFS and reloaded: the engine keeps one GL
// texture per name and updates it in place.
//
// Two halves:
//
//   createLiveTextures()        the registry a RenderTransport keeps per engine:
//                               which names are registered at which size, and
//                               the rule for sizing a slot from its source.
//   createLiveTextureWriter()   the main-thread way to get a frame in: rasterize
//                               it at the slot's size and copy it into the
//                               slot's staging buffer on the WASM heap
//                               (texture_slot_buffer()), then commit. Nothing is
//                               malloc'ed per frame, like the PCM ring.
//
// The render worker does the second half in its own scope
// (html/worker/live-texture.js); the worker transport hands it the frame as an
// ImageBitmap already scaled to the slot's size.

import {
    textureSlotBuffer,
    textureSlotCommit,
    textureSlotCommitGeneration,
    textureSlotGeneration,
    textureSlotRegister,
    textureSlotUnregister,
} from './generated/projectm-wasm-api.js';

/**
 * @typedef {import('./projectm-context-types.ts').ProjectMLiveTextureSource} ProjectMLiveTextureSource
 * @typedef {import('./projectm-context-types.ts').ProjectMUpdateTextureOptions} ProjectMUpdateTextureOptions
 * @typedef {import('./projectm-context-types.ts').ProjectMRegisterTextureOptions} ProjectMRegisterTextureOptions
 * @typedef {{ width: number, height: number }} TextureSize
 */

/** Largest width or height of a live texture (PROJECTM_LIVE_TEXTURE_MAX_SIZE). */
export const LIVE_TEXTURE_MAX_SIZE = 8192;

/**
 * Default cap on the long side of a slot that follows its source. A 1080p
 * camera is 8 MB a frame at full size; presets sample a webcam as a texture, so
 * 1024 wide is plenty and an eighth of the bytes.
 */
export const DEFAULT_LIVE_TEXTURE_MAX_SIZE = 1024;

const NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Whether `name` can name a live texture at all (the engine also refuses
 * "main", "blurN", "randNN..." and its built-in textures).
 *
 * @param {unknown} name
 * @returns {name is string}
 */
export function isLiveTextureName(name) {
    return typeof name === 'string' && NAME_PATTERN.test(name);
}

/**
 * A frame source's natural size, or null before it has one (a <video> before
 * its metadata, an image still loading).
 *
 * @param {ProjectMLiveTextureSource} source
 * @returns {TextureSize | null}
 */
export function sourceSize(source) {
    /** @type {Record<string, unknown>} */
    const s = /** @type {any} */ (source);
    const pick = (/** @type {unknown} */ width, /** @type {unknown} */ height) =>
        typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
            ? { width: Math.round(width), height: Math.round(height) }
            : null;
    return (
        // VideoFrame: the display size, not the coded one (which may be padded).
        pick(s.displayWidth, s.displayHeight) ??
        pick(s.videoWidth, s.videoHeight) ??
        pick(s.naturalWidth, s.naturalHeight) ??
        pick(s.width, s.height)
    );
}

/**
 * Fits `size` inside `maxSize` on its long side, keeping the aspect ratio.
 *
 * @param {TextureSize} size
 * @param {number} [maxSize]
 * @returns {TextureSize}
 */
export function fitLiveTextureSize({ width, height }, maxSize = DEFAULT_LIVE_TEXTURE_MAX_SIZE) {
    const cap = Math.min(Math.max(1, Math.floor(maxSize) || DEFAULT_LIVE_TEXTURE_MAX_SIZE), LIVE_TEXTURE_MAX_SIZE);
    const scale = Math.min(1, cap / Math.max(width, height));
    return {
        width: Math.max(1, Math.min(cap, Math.round(width * scale))),
        height: Math.max(1, Math.min(cap, Math.round(height * scale))),
    };
}

/**
 * The RGBA8 bytes of a source that already is pixels of exactly `size`
 * (ImageData, or `{ width, height, data }`), else null.
 *
 * @param {ProjectMLiveTextureSource} source
 * @param {TextureSize} size
 * @returns {Uint8Array | Uint8ClampedArray | null}
 */
export function pixelsOf(source, size) {
    const data = /** @type {{ data?: unknown }} */ (source).data;
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
        return null;
    }
    const natural = sourceSize(source);
    if (!natural || natural.width !== size.width || natural.height !== size.height) {
        return null;
    }
    return data.length === size.width * size.height * 4 ? data : null;
}

/**
 * @typedef {object} FrameRasterizerOptions
 * @property {(width: number, height: number) => (OffscreenCanvas | HTMLCanvasElement)} [createCanvas]
 *   Makes the scratch canvas. Defaults to an OffscreenCanvas.
 */

/**
 * Turns any frame source into RGBA8 pixels at a given size, through one reused
 * 2D canvas. Sources that already are pixels of that size skip the canvas.
 *
 * @param {FrameRasterizerOptions} [options]
 */
export function createFrameRasterizer({ createCanvas } = {}) {
    /** @type {OffscreenCanvas | HTMLCanvasElement | null} */
    let canvas = null;
    /** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null} */
    let context2d = null;

    const makeCanvas =
        createCanvas ??
        ((/** @type {number} */ width, /** @type {number} */ height) => {
            if (typeof OffscreenCanvas !== 'function') {
                throw new Error('live textures need OffscreenCanvas to read frames');
            }
            return new OffscreenCanvas(width, height);
        });

    return {
        /**
         * @param {ProjectMLiveTextureSource} source
         * @param {TextureSize} size
         * @returns {Uint8Array | Uint8ClampedArray}
         */
        rasterize(source, size) {
            const pixels = pixelsOf(source, size);
            if (pixels) {
                return pixels;
            }
            if (!canvas) {
                canvas = makeCanvas(size.width, size.height);
                context2d = /** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null} */ (
                    canvas.getContext('2d', { willReadFrequently: true })
                );
                if (!context2d) {
                    throw new Error('live textures need a 2D canvas context to read frames');
                }
            }
            if (canvas.width !== size.width || canvas.height !== size.height) {
                canvas.width = size.width;
                canvas.height = size.height;
            }
            const ctx = /** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} */ (context2d);
            ctx.drawImage(scalableSource(source), 0, 0, size.width, size.height);
            return ctx.getImageData(0, 0, size.width, size.height).data;
        },
    };

    /**
     * drawImage() takes no pixels: pixels of another size than the slot are put
     * on a second canvas at their own size first, and scaled from there.
     *
     * @param {ProjectMLiveTextureSource} source
     * @returns {CanvasImageSource}
     */
    function scalableSource(source) {
        const data = /** @type {{ data?: unknown }} */ (source).data;
        const natural = sourceSize(source);
        if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !natural) {
            return /** @type {CanvasImageSource} */ (source);
        }
        if (data.length !== natural.width * natural.height * 4) {
            throw new Error(`live texture pixels: ${data.length} bytes is not ${natural.width}x${natural.height} RGBA`);
        }
        const staging = makeCanvas(natural.width, natural.height);
        const stagingContext = /** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null} */ (
            staging.getContext('2d')
        );
        if (!stagingContext) {
            throw new Error('live textures need a 2D canvas context to read frames');
        }
        // A copy: ImageData takes no shared or non-clamped view.
        stagingContext.putImageData(new ImageData(new Uint8ClampedArray(data), natural.width, natural.height), 0, 0);
        return staging;
    }
}

/**
 * @typedef {object} LiveTextureBackend
 * @property {(name: string, width: number, height: number) => boolean | Promise<boolean>} registerSlot
 *   texture_slot_register() on the engine.
 * @property {(name: string) => boolean | Promise<boolean>} unregisterSlot
 * @property {(name: string, size: TextureSize, source: ProjectMLiveTextureSource) => boolean | Promise<boolean>} writeFrame
 *   Gets one frame, scaled to `size`, into the slot and commits it.
 */

/**
 * The live textures one engine has, by lower-case name, and the sizing rule.
 *
 * A slot registered with an explicit size keeps it: frames are scaled to fit.
 * A slot that follows its source (`followSource`, or created by the first
 * `update()` of an unknown name) is resized to the source's size, capped at
 * `maxSize` on its long side, whenever that changes: the engine resizes the
 * texture in place, so presets already sampling it follow.
 *
 * @param {LiveTextureBackend} backend
 */
export function createLiveTextures(backend) {
    /** @type {Map<string, TextureSize & { followSource: boolean }>} */
    const slots = new Map();
    /** Names with a frame on its way: a newer frame is dropped, not queued. */
    const inFlight = new Set();

    /**
     * @param {string} name
     * @param {number} width
     * @param {number} height
     * @param {boolean} followSource
     */
    async function register(name, width, height, followSource) {
        if (!isLiveTextureName(name)) {
            return false;
        }
        const w = Math.round(Number(width));
        const h = Math.round(Number(height));
        if (!(w >= 1 && h >= 1 && w <= LIVE_TEXTURE_MAX_SIZE && h <= LIVE_TEXTURE_MAX_SIZE)) {
            return false;
        }
        const ok = !!(await backend.registerSlot(name, w, h));
        if (ok) {
            slots.set(name.toLowerCase(), { width: w, height: h, followSource });
        }
        return ok;
    }

    return {
        /**
         * @param {string} name
         * @param {number} width
         * @param {number} height
         * @param {ProjectMRegisterTextureOptions} [options]
         * @returns {Promise<boolean>}
         */
        register(name, width, height, { followSource = false } = {}) {
            return register(name, width, height, !!followSource);
        },

        /**
         * @param {string} name
         * @param {ProjectMLiveTextureSource} source
         * @param {ProjectMUpdateTextureOptions} [options]
         * @returns {Promise<boolean>} false when the frame was dropped: no size yet,
         *   a previous frame still on its way, or the engine refused it.
         */
        async update(name, source, { maxSize = DEFAULT_LIVE_TEXTURE_MAX_SIZE } = {}) {
            if (!isLiveTextureName(name) || !source) {
                return false;
            }
            const key = name.toLowerCase();
            if (inFlight.has(key)) {
                return false;
            }
            const natural = sourceSize(source);
            if (!natural) {
                return false;
            }
            inFlight.add(key);
            try {
                let slot = slots.get(key);
                if (!slot || slot.followSource) {
                    const wanted = fitLiveTextureSize(natural, maxSize);
                    if (!slot || slot.width !== wanted.width || slot.height !== wanted.height) {
                        if (!(await register(name, wanted.width, wanted.height, true))) {
                            return false;
                        }
                        slot = /** @type {TextureSize & { followSource: boolean }} */ (slots.get(key));
                    }
                }
                return !!(await backend.writeFrame(name, { width: slot.width, height: slot.height }, source));
            } finally {
                inFlight.delete(key);
            }
        },

        /**
         * @param {string} name
         * @returns {Promise<boolean>}
         */
        async unregister(name) {
            if (!isLiveTextureName(name)) {
                return false;
            }
            slots.delete(name.toLowerCase());
            return !!(await backend.unregisterSlot(name));
        },

        /**
         * The size a registered slot has, or null.
         *
         * @param {string} name
         * @returns {TextureSize | null}
         */
        size(name) {
            const slot = typeof name === 'string' ? slots.get(name.toLowerCase()) : undefined;
            return slot ? { width: slot.width, height: slot.height } : null;
        },
    };
}

/**
 * The main-thread backend: the module is on this thread, so a frame is drawn
 * at the slot's size and copied straight into the slot's staging buffer.
 *
 * @param {any} engine The module bound to one host (bindModuleToHost()).
 * @param {FrameRasterizerOptions} [options]
 * @returns {LiveTextureBackend}
 */
export function createLiveTextureWriter(engine, options = {}) {
    const rasterizer = createFrameRasterizer(options);
    return {
        registerSlot: (name, width, height) => !!textureSlotRegister(engine, name, width, height),
        unregisterSlot: (name) => !!textureSlotUnregister(engine, name),
        writeFrame(name, size, source) {
            const pixels = rasterizer.rasterize(source, size);
            const bytes = size.width * size.height * 4;
            if (pixels.length !== bytes) {
                return false;
            }
            // Asked every frame: a slot resized since (or unregistered) answers 0
            // instead of a buffer the frame would overrun.
            const buffer = acquireTextureBuffer(engine, name, bytes);
            if (!buffer) {
                return false;
            }
            // Read the view now: a heap that grew since has a new one.
            /** @type {Uint8Array} */ (engine.HEAPU8).set(pixels, buffer.ptr);
            return commitTextureBuffer(engine, name, buffer);
        },
    };
}

/**
 * A live texture's staging buffer: where to write, how much, and which
 * allocation it is. The generation changes whenever the slot's buffer is
 * reallocated (a resize, the slot removed and registered again), so a page
 * that awaits between acquiring and writing compares it with
 * `texture_slot_generation()` before writing, and a commit of a replaced
 * generation is refused by the engine (ABI v2, #352).
 *
 * @typedef {{ ptr: number, byteLength: number, generation: number | null }} TextureBuffer
 */

/**
 * The staging buffer of `name` for a frame of `bytes` bytes, or null when the
 * slot is unknown or another size. `generation` is null on a bundle from
 * before buffer generations.
 *
 * @param {any} engine The module bound to one host (bindModuleToHost()).
 * @param {string} name
 * @param {number} bytes
 * @returns {TextureBuffer | null}
 */
export function acquireTextureBuffer(engine, name, bytes) {
    const ptr = Number(textureSlotBuffer(engine, name, bytes));
    if (!ptr) {
        return null;
    }
    const generation =
        typeof engine._texture_slot_generation === 'function'
            ? Number(textureSlotGeneration(engine, name)) >>> 0
            : null;
    return { ptr, byteLength: bytes, generation };
}

/**
 * Commits the frame written into `buffer`; false when the slot is gone or the
 * buffer was replaced since it was acquired (the engine refuses that commit
 * and records it as the host's last error, 3).
 *
 * @param {any} engine
 * @param {string} name
 * @param {TextureBuffer} buffer
 * @returns {boolean}
 */
export function commitTextureBuffer(engine, name, buffer) {
    if (buffer.generation === null) {
        return !!textureSlotCommit(engine, name);
    }
    return Number(textureSlotCommitGeneration(engine, name, buffer.generation)) === 1;
}
