// context/replay.js
//
// What a ProjectMContext has told its engine that a lost WebGL context takes
// away. Recovery from a context loss (projectm-context-loss.js →
// ProjectMContext.recoverContext()) rebuilds the engine with init(), which
// starts from the context's options: anything the host changed afterwards
// through the context's methods would silently revert. This record keeps the
// last value of each such setting and plays them back, in order, on the
// rebuilt engine.
//
// It is per context. It replaces reading `window.currentPresetPath`, a page
// global that names whichever context loaded a preset last, so with two
// contexts on a page one of them came back with its sibling's preset.
//
// Recorded: the preset (by its VFS path, which is still in the Module's MEMFS
// or the worker's after a loss), mesh quality, the flash limit, eval_set
// values, the preset lock, the live-texture slots (the transport keeps their
// sizes; see restoreTextures()) and user sprites (code, type and the variables
// set on them). A sprite comes back under a new engine id; the context maps the
// id it handed out to the new one (see `spriteId()`), so host code keeps using
// the id it was given.

import { createSpriteOn, setSpriteVarOn } from './sprites.js';
import { setEvalVarOn } from './live-input.js';

/**
 * @typedef {import('@projectm/types/transport').RenderTransport} RenderTransport
 * @typedef {{ code: string, type: string, vars: Map<string, number>, engineId: number }} SpriteRecord
 */

/**
 * @typedef {object} ReplayOps How the record reaches the rebuilt engine.
 *   The context supplies them, so the record itself never branches on topology.
 * @property {(vfsPath: string) => void} loadPreset
 * @property {(quality: string) => void} setMeshQuality
 * @property {(enabled: boolean, threshold: number | undefined) => void} setFlashLimit
 * @property {(locked: boolean) => void} setLocked
 * @property {(name: string, value: number) => Promise<boolean>} setEvalVar
 * @property {(code: string, type: string) => Promise<number>} createSprite
 * @property {(engineId: number, name: string, value: number) => Promise<void>} setSpriteVar
 */

export class ReplayRecord {
    /** @type {string | null} */
    preset = null;
    /** @type {string | null} */
    meshQuality = null;
    /** @type {{ enabled: boolean, threshold: number | undefined } | null} */
    flashLimit = null;
    /** @type {boolean | null} */
    locked = null;
    /** @type {Map<string, number>} */
    evalVars = new Map();
    /** @type {Map<number, SpriteRecord>} host-facing id → record */
    sprites = new Map();

    /** @param {string} vfsPath */
    recordPreset(vfsPath) {
        if (typeof vfsPath === 'string' && vfsPath) {
            this.preset = vfsPath;
        }
    }

    /** @param {string} quality */
    recordMeshQuality(quality) {
        this.meshQuality = quality;
    }

    /**
     * @param {boolean} enabled
     * @param {number | undefined} threshold
     */
    recordFlashLimit(enabled, threshold) {
        this.flashLimit = { enabled: !!enabled, threshold };
    }

    /** @param {boolean} locked */
    recordLocked(locked) {
        this.locked = !!locked;
    }

    /**
     * @param {string} name
     * @param {number} value
     */
    recordEvalVar(name, value) {
        this.evalVars.set(name.toLowerCase(), value);
    }

    /** @param {string} name An empty name cleared every value. */
    recordEvalClear(name) {
        if (name) {
            this.evalVars.delete(name.toLowerCase());
        } else {
            this.evalVars.clear();
        }
    }

    /**
     * @param {number} engineId The id the engine returned.
     * @param {string} code
     * @param {string} type
     * @returns {number} The id to give the host: the engine's, unless a sprite
     *   recreated by a recovery already answers to that number.
     */
    recordSprite(engineId, code, type) {
        let id = engineId;
        if (this.sprites.has(id)) {
            id = Math.max(...this.sprites.keys()) + 1;
        }
        this.sprites.set(id, { code, type, vars: new Map(), engineId });
        return id;
    }

    /** @param {number} id */
    recordSpriteDestroyed(id) {
        this.sprites.delete(id);
    }

    /**
     * @param {number} id
     * @param {string} name
     * @param {number} value
     */
    recordSpriteVar(id, name, value) {
        this.sprites.get(id)?.vars.set(name, value);
    }

    /**
     * The engine id behind a host-facing sprite id: the same number until a
     * recovery recreated the sprite.
     *
     * @param {number} id
     * @returns {number}
     */
    spriteId(id) {
        return this.sprites.get(id)?.engineId ?? id;
    }

    /** Forget everything (a new start() begins from the options again). */
    clear() {
        this.preset = null;
        this.meshQuality = null;
        this.flashLimit = null;
        this.locked = null;
        this.evalVars.clear();
        this.sprites.clear();
    }

    /**
     * Plays the record back on a rebuilt engine. Each step is independent: one
     * that throws is logged and the rest still run.
     *
     * @param {RenderTransport} transport
     * @param {ReplayOps} ops
     * @returns {Promise<void>}
     */
    async replay(transport, ops) {
        /** @param {string} what @param {() => unknown} step */
        const run = async (what, step) => {
            try {
                await step();
            } catch (error) {
                console.warn(`[ProjectMContext] could not restore ${what} after context loss:`, error);
            }
        };
        const { preset, meshQuality, flashLimit, locked } = this;
        if (flashLimit) {
            // First: the rebuilt engine must never show an unlimited frame to a
            // viewer who asked for the limiter.
            await run('the flash limit', () => ops.setFlashLimit(flashLimit.enabled, flashLimit.threshold));
        }
        if (meshQuality) {
            await run('mesh quality', () => ops.setMeshQuality(meshQuality));
        }
        if (locked !== null) {
            await run('the preset lock', () => ops.setLocked(locked));
        }
        await run('live textures', () => transport.restoreTextures());
        for (const [name, value] of [...this.evalVars]) {
            await run(`eval value ${name}`, () => ops.setEvalVar(name, value));
        }
        if (preset) {
            await run('the preset', () => ops.loadPreset(preset));
        }
        for (const record of [...this.sprites.values()]) {
            await run('a sprite', async () => {
                const engineId = await ops.createSprite(record.code, record.type);
                record.engineId = engineId;
                for (const [name, value] of record.vars) {
                    await ops.setSpriteVar(engineId, name, value);
                }
            });
        }
    }
}

/**
 * The ops a context replays through: its transport for engine calls, its own
 * methods where they resolve something on this thread first (mesh quality
 * 'auto', the main-thread engine binding). The context methods record what
 * they set again, which is the same value; sprites go straight to the
 * transport, since recording them again would duplicate them.
 *
 * @param {{
 *   setMeshQuality(quality: string): unknown,
 *   setLocked(locked: boolean): unknown,
 *   setFlashLimit(enabled: boolean, threshold?: number): unknown,
 * }} context
 * @param {RenderTransport} transport
 * @returns {ReplayOps}
 */
export function replayOpsFor(context, transport) {
    return {
        loadPreset: (vfsPath) => transport.callVoid('loadPresetFile', vfsPath),
        setMeshQuality: (quality) => {
            context.setMeshQuality(quality);
        },
        setFlashLimit: (enabled, threshold) => {
            context.setFlashLimit(enabled, threshold);
        },
        setLocked: (locked) => {
            context.setLocked(locked);
        },
        setEvalVar: (name, value) => setEvalVarOn(transport, name, value),
        createSprite: (code, type) => createSpriteOn(transport, code, type),
        setSpriteVar: (engineId, name, value) => setSpriteVarOn(transport, engineId, name, value),
    };
}
