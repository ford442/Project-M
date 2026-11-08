// context/controls.js
//
// The engine controls of ProjectMContext that need nothing but the transport
// (or, on the main thread, the module bound to this context's host): preset
// navigation, mesh/fps, rhythm, the flash limiter, sprites, frame capture and
// the audio source. ProjectMContext extends this class; lifecycle and every
// piece of private state stay in projectm-context.js.

import { setPresetLocked, setTransparencyMode, switchPreset } from '../generated/projectm-wasm-api.js';
import { setMeshQuality } from '../projectm-mesh-quality.js';
import { setTargetFps } from '../projectm-fps-governor.js';
import { RHYTHM_EVENT_TYPES, RhythmEventRelay, callRhythm, presetSwitchPolicyArgs, readRhythmInfo } from './presets.js';
import { createEngineBinder, meshGridFor, readFlashLimitStats } from './render.js';
import { createSpriteOn, destroySpriteOn, getSpriteVarOn, setSpriteVarOn } from './sprites.js';

/**
 * @typedef {import('../projectm-context-types.ts').ProjectMMeshQuality} ProjectMMeshQuality
 * @typedef {import('../projectm-context-types.ts').ProjectMAudioSourceStatus} ProjectMAudioSourceStatus
 * @typedef {import('../projectm-context-types.ts').ProjectMPresetSwitchPolicy} ProjectMPresetSwitchPolicy
 * @typedef {import('../projectm-context-types.ts').ProjectMRhythmInfo} ProjectMRhythmInfo
 * @typedef {import('../projectm-context-types.ts').ProjectMCapturedFrame} ProjectMCapturedFrame
 * @typedef {import('../projectm-context-types.ts').ProjectMCaptureFrameOptions} ProjectMCaptureFrameOptions
 * @typedef {import('../projectm-context-types.ts').ProjectMFlashLimitStats} ProjectMFlashLimitStats
 * @typedef {import('../generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('../projectm-transport-types.ts').RenderTransport} RenderTransport
 * @typedef {import('../projectm-audio-source-router.js').AudioSourceRouter} AudioSourceRouter
 * @typedef {import('../projectm-context-types.ts').ProjectMContextSnapshot} ProjectMContextSnapshot
 */

// Module-private access to the class's private state, for projectm-context.js
// (assigned in the class's static block). Not part of the public API.
/** @type {(context: ProjectMContextControls) => ProjectMModule | null} */
let engineOfImpl;
/** @type {(context: ProjectMContextControls) => RhythmEventRelay} */
let rhythmOfImpl;
/** @type {(context: ProjectMContextControls, snapshot: ProjectMContextSnapshot | null) => void} */
let setContextSnapshotImpl;

/**
 * This context's engine on the main thread: the module, bound to `hostHandle`
 * so every export called through it selects this context's host first. The
 * module itself for the single-engine default host; null in the worker
 * topology and before start().
 *
 * @param {ProjectMContextControls} context
 */
export const engineOf = (context) => engineOfImpl(context);
/** @param {ProjectMContextControls} context */
export const rhythmOf = (context) => rhythmOfImpl(context);
/**
 * @param {ProjectMContextControls} context
 * @param {ProjectMContextSnapshot | null} snapshot
 */
export const setContextSnapshot = (context, snapshot) => setContextSnapshotImpl(context, snapshot);

/**
 * Dispatches one of the context's per-instance events.
 *
 * @param {ProjectMContextControls} context
 * @param {string} type
 * @param {unknown} detail
 */
export function emitContextEvent(context, type, detail) {
    const event = typeof CustomEvent === 'function'
        ? new CustomEvent(type, { detail })
        : Object.assign(new Event(type), { detail });
    context.events.dispatchEvent(event);
}

export class ProjectMContextControls {
    /**
     * Per-instance notifications, for hosts that want an event stream rather
     * than the `on*` options: `ready`, `error`, `audio-source`,
     * `preset-changed` and `destroy`, each a `CustomEvent` whose `detail`
     * matches the corresponding callback's argument, plus the musical-time
     * events `beat`, `bar` and `section` (detail: a `RhythmEvent`) while
     * someone listens to them through {@link ProjectMContextControls#on}. Unlike the
     * window-level `pm:*` events these belong to this context alone.
     *
     * @type {EventTarget}
     */
    events = new EventTarget();

    /** Beat/bar/section events, connected to the engine while anyone listens. */
    #rhythm = new RhythmEventRelay((type, detail) => emitContextEvent(this, type, detail), () => this.hostHandle);

    /** What the engine negotiated with WebGL; see {@link ProjectMContextControls#contextSnapshot}. */
    #contextSnapshot = /** @type {ProjectMContextSnapshot | null} */ (null);
    /** setTransparent(true) on an opaque canvas has been reported. */
    #warnedOpaqueTransparency = false;
    /** @type {ProjectMModule | null} */
    module = null;
    /**
     * The one thing every engine call goes through. Null until start()
     * picks a topology; after that, `transport.topology` is the only place
     * the choice is visible, and callers of this class never branch on it.
     *
     * @type {RenderTransport | null}
     */
    transport = null;
    /**
     * Opaque per-instance host handle from create_host() when this context
     * shares a Module with others (#168 Phase B). 0 means the process
     * default host (single-instance / legacy path), where no set_active_host
     * is needed because there is only one engine.
     * @type {number}
     */
    hostHandle = 0;
    /** @type {AudioSourceRouter | null} */
    audioRouter = null;
    /** @type {HTMLCanvasElement | null} */
    secondaryCanvas = null;

    #bindEngine = createEngineBinder();

    /** See {@link engineOf}. */
    get #engine() {
        return this.#bindEngine(this.module, this.hostHandle);
    }

    static {
        engineOfImpl = (context) => context.#engine;
        rhythmOfImpl = (context) => context.#rhythm;
        setContextSnapshotImpl = (context, snapshot) => {
            context.#contextSnapshot = snapshot;
        };
    }

    /**
     * Add a preset to the playlist without switching to it.
     *
     * @param {string} vfsPath
     * @param {Uint8Array} bytes
     */
    addPreset(vfsPath, bytes) {
        this.transport?.writePreset(vfsPath, bytes, 'add');
    }

    /**
     * @param {number} threshold RGB cutoff below which pixels go transparent.
     */
    setTransparencyThreshold(threshold) {
        this.transport?.callVoid('setTransparencyThreshold', threshold);
    }

    nextPreset() {
        if (this.transport) {
            this.transport.callVoid('switchPreset');
            return;
        }
        const engine = this.#engine;
        if (engine) {
            switchPreset(engine);
        }
    }

    /** @param {boolean} locked */
    setLocked(locked) {
        if (this.transport) {
            this.transport.callVoid('setPresetLocked', locked);
            return;
        }
        const engine = this.#engine;
        if (engine) {
            setPresetLocked(engine, locked);
        }
    }

    /**
     * @param {ProjectMMeshQuality} quality
     * @returns {string | undefined}
     */
    setMeshQuality(quality) {
        const engine = this.#engine;
        if (engine) {
            // 'auto' resolves against the device, which needs the module's own
            // view of it; only the resolved grid crosses to the worker.
            return setMeshQuality(engine, quality);
        }
        if (!this.transport) {
            return;
        }
        this.transport.callVoid('setMesh', ...meshGridFor(quality));
        return quality;
    }

    /**
     * @param {number} fps
     * @returns {number | undefined}
     */
    setTargetFps(fps) {
        const engine = this.#engine;
        if (engine) {
            return setTargetFps(engine, fps);
        }
        if (!this.transport) {
            return;
        }
        this.transport.callVoid('setTargetFps', fps);
        return fps;
    }

    /**
     * Uses a known tempo instead of estimating it (a MIDI clock, track
     * metadata, a tap-tempo button). The beat phase still locks to the audio.
     *
     * @param {number} bpm Beats per minute, or 0 to go back to estimating.
     */
    setRhythmHint(bpm) {
        callRhythm(this.transport, 'setRhythmHint', Number.isFinite(bpm) && bpm > 0 ? bpm : 0);
    }

    /**
     * When the playlist moves on. See {@link ProjectMPresetSwitchPolicy}.
     *
     * @param {ProjectMPresetSwitchPolicy} policy
     * @param {number} [bars] Bars per preset, or the shortest preset for `'section'`. Default 16.
     */
    setPresetSwitchPolicy(policy, bars = 16) {
        callRhythm(this.transport, 'setPresetSwitchPolicy', ...presetSwitchPolicyArgs(policy, bars));
    }

    /**
     * Crossfade length in beats, resolved against the tempo when each crossfade
     * starts; while the tempo is unknown the duration in seconds applies.
     *
     * @param {number} beats Beats, or 0 to use seconds only.
     */
    setTransitionDurationBeats(beats) {
        callRhythm(this.transport, 'transitionSetDurationBeats', Number.isFinite(beats) && beats > 0 ? beats : 0);
    }

    /**
     * Makes beat-detection hard cuts wait for the next beat.
     *
     * @param {boolean} enabled
     */
    setHardCutOnBeat(enabled) {
        callRhythm(this.transport, 'setHardCutOnBeat', !!enabled);
    }

    /**
     * Tempo and phase of the most recent frame, or null before start() or on a
     * bundle without rhythm analysis. One round trip per field in the worker
     * topology, so poll it for a display, not per frame.
     *
     * @returns {Promise<ProjectMRhythmInfo | null>}
     */
    getRhythmInfo() {
        return readRhythmInfo(this.transport);
    }

    /**
     * Turns this engine's temporal flash limiter on or off. When a frame's mean
     * luminance would change faster than `threshold` allows, the frame is
     * blended toward the one shown before; see docs/FLASH_LIMITER.md. Off by
     * default (and then frames reach the canvas exactly as without it). A no-op
     * before start() — pass the `flashLimit` option to have it on from the first
     * frame — and on a bundle that predates the limiter.
     *
     * @param {boolean} enabled
     * @param {number} [threshold] 0.005..1; omitted keeps the current one (default 0.06).
     */
    setFlashLimit(enabled, threshold) {
        this.transport?.setFlashLimit(!!enabled, threshold);
    }

    /**
     * The flash limiter's state for this engine, or null before start() or on a
     * bundle without it. Reading the clamp count waits for the GPU to finish the
     * frames since the last read: poll it for a display, not per frame.
     *
     * @returns {Promise<ProjectMFlashLimitStats | null>}
     */
    getFlashLimitStats() {
        return readFlashLimitStats(this.transport);
    }

    /**
     * Adds a user sprite to this engine: an image drawn over every preset, positioned
     * and colored by its own expression code (projectM-4/user_sprites.h). `code` is
     * Milkdrop sprite code, one `key=value` per line:
     *
     * ```
     * img=pm_depth_map          texture base name (from /textures/, no extension)
     * init_1=x=0.5; y=0.5;      runs once
     * code_1=a=0.5+0.4*bass;    runs every frame
     * ```
     *
     * Sprite variables: x, y, sx, sy, rot, flipx, flipy, repeatx, repeaty,
     * blendmode (0..4), r, g, b, a, burn, done, plus read-only time, frame, fps,
     * progress, bass/mid/treb and their _att forms. Sprites survive preset
     * switches; at the limit (16) the oldest is replaced.
     *
     * @param {string} code
     * @param {{ type?: string }} [options] `type` defaults to `'milkdrop'`, the only one libprojectM knows.
     * @returns {Promise<number>} The sprite id, for the other sprite methods. Rejects
     *   before start(), on a bundle without the sprite exports, and when the engine
     *   refuses the sprite (code that does not compile, an unknown type).
     */
    createSprite(code, { type = 'milkdrop' } = {}) {
        return createSpriteOn(this.transport, String(code), type);
    }

    /**
     * Removes a sprite created with {@link createSprite}. An id that no longer
     * exists is ignored.
     *
     * @param {number} id
     * @returns {Promise<void>}
     */
    destroySprite(id) {
        return destroySpriteOn(this.transport, id);
    }

    /**
     * Reads one of a sprite's expression variables (0 for an unknown sprite or name).
     *
     * @param {number} id
     * @param {string} name
     * @returns {Promise<number>}
     */
    getSpriteVar(id, name) {
        return getSpriteVarOn(this.transport, id, name);
    }

    /**
     * Sets one of a sprite's expression variables. The sprite's per-frame code runs
     * after this, so a variable that code assigns every frame is overwritten; drive
     * the sprite through a variable of your own that its code reads instead
     * (`code_1=x=px;`, then set `px`).
     *
     * @param {number} id
     * @param {string} name
     * @param {number} value
     * @returns {Promise<void>}
     */
    setSpriteVar(id, name, value) {
        return setSpriteVarOn(this.transport, id, name, Number(value));
    }

    /**
     * Reads back the next frame this context's engine presents: the canvas's
     * RGBA8 pixels, top row first, as a copy the caller owns. Works in both
     * topologies and without `preserveDrawingBuffer` — the engine takes the
     * frame inside the render that drew it. With `presentMode: 'manual'` the
     * read does not stall the next live frame. For offline export, pause the
     * render loop and pass `renderFrame: true`: each call is then exactly one
     * rendered, committed and captured frame.
     *
     * Each context reads its own engine into its own buffer, so contexts on one
     * shared Module can capture at the same time.
     *
     * @param {ProjectMCaptureFrameOptions} [options]
     * @returns {Promise<ProjectMCapturedFrame>}
     */
    captureFrame(options = {}) {
        if (!this.transport) {
            return Promise.reject(new Error('captureFrame(): the context has not started'));
        }
        return this.transport.captureFrame(options);
    }

    /**
     * Which topology this context ended up on: 'worker' when rendering is off
     * the main thread, 'main' when it is not. Hosts should need this only for
     * reporting — every engine op works the same either way.
     *
     * @returns {import('../projectm-transport-types.ts').RenderTopology | null}
     */
    getRenderTopology() {
        return this.transport?.topology ?? null;
    }

    /**
     * Hand PCM straight to the engine, wherever it is.
     *
     * @param {Float32Array} buffer Interleaved samples.
     * @param {number} [channels]
     */
    feedPcm(buffer, channels = 2) {
        this.transport?.feedPcm(buffer, channels);
    }

    /**
     * @returns {ProjectMAudioSourceStatus | null}
     */
    getAudioSourceStatus() {
        return this.audioRouter?.getStatus() ?? null;
    }

    /**
     * @param {import('../projectm-audio-source-router.js').ProjectMAudioSourceActive} source
     */
    setAudioSource(source) {
        this.audioRouter?.setActiveSource(source);
    }

    /**
     * Turns transparency mode on or off. The canvas must have an alpha channel
     * for it to show (`contextAlpha`, which defaults to the `transparent` option
     * at start()); on an opaque one the cut-out pixels are drawn black.
     *
     * @param {boolean} enabled
     */
    setTransparent(enabled) {
        const engine = this.#engine;
        if (this.transport) {
            this.transport.callVoid('setTransparencyMode', enabled);
        } else if (engine) {
            setTransparencyMode(engine, enabled);
        } else {
            return;
        }
        if (enabled && this.#contextSnapshot?.attributes?.contextAlpha === false && !this.#warnedOpaqueTransparency) {
            this.#warnedOpaqueTransparency = true;
            console.warn('[projectM] transparency mode is on, but this canvas was created without an alpha channel, '
                + 'so nothing shows through; start the context with contextAlpha: true (or transparent: true)');
        }
        if (this.secondaryCanvas) {
            this.secondaryCanvas.style.display = enabled ? 'none' : 'block';
        }
    }

    /**
     * Subscribes to one of this context's events and returns the unsubscribe
     * function. Besides the lifecycle events of {@link ProjectMContextControls#events}
     * this delivers the music's structure as it plays:
     *
     *  - `beat`: on every beat, *on* it rather than after it (the beat clock
     *    predicts it), while the tempo is known.
     *  - `bar`: on every downbeat.
     *  - `section`: when a new part of the song starts.
     *
     * Each listener gets a `RhythmEvent` (bpm, beatIndex, barPhase,
     * sectionIndex, confidence). The engine only reports while at least one
     * beat/bar/section listener is subscribed, and only frames that carry an
     * event — never every frame. Works the same in both render topologies, and
     * may be called before start(): the subscription connects once the engine
     * is up.
     *
     * @param {string} type
     * @param {(detail: any) => void} listener
     * @returns {() => void}
     */
    on(type, listener) {
        const handler = (/** @type {Event} */ event) => listener(/** @type {CustomEvent} */ (event).detail);
        this.events.addEventListener(type, handler);
        const rhythm = RHYTHM_EVENT_TYPES.includes(type);
        if (rhythm) {
            this.#rhythm.count(1, this.transport);
        }
        let subscribed = true;
        return () => {
            if (!subscribed) {
                return;
            }
            subscribed = false;
            this.events.removeEventListener(type, handler);
            if (rhythm) {
                this.#rhythm.count(-1, this.transport);
            }
        };
    }

    /**
     * What the engine negotiated with WebGL for this context: float color
     * buffers, float blending, `WEBGL_lose_context`, the dual-FBO format it
     * ended up with, the attributes the context really has (`attributes`) and
     * where those differ from the options it was started with (`mismatches`,
     * also logged as a warning). Read-only and frozen; it reports what `create_host_with_config()`
     * already settled and requests nothing. Null until `start()` has resolved,
     * and on a bundle that predates `get_context_snapshot()`. Read once at start,
     * and again after a successful context-loss recovery, which builds a new
     * context. Same in both topologies: in the worker topology it is the
     * worker's context that is described.
     *
     * @returns {ProjectMContextSnapshot | null}
     */
    get contextSnapshot() {
        return this.#contextSnapshot;
    }
}
