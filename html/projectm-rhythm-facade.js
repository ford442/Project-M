// projectm-rhythm-facade.js
//
// ProjectMContext's musical-time surface (projectM-4/rhythm.h): the beat / bar /
// section event subscription and the tempo, switch-policy and crossfade
// controls. The context's public methods (on(), setRhythmHint(), ...) delegate
// here; this module holds the state they share — how many rhythm listeners
// there are, and whether the engine is currently reporting to them.
//
// Every control is skipped on a bundle that predates it (transport.supports()),
// so a host can call them unconditionally.

/**
 * @typedef {import('./projectm-transport-types.ts').RenderTransport} RenderTransport
 * @typedef {import('./projectm-context-types.ts').ProjectMPresetSwitchPolicy} ProjectMPresetSwitchPolicy
 * @typedef {import('./projectm-context-types.ts').ProjectMRhythmInfo} ProjectMRhythmInfo
 */

/** The events `ProjectMContext.on()` routes from the engine's rhythm analysis. */
export const RHYTHM_EVENT_TYPES = Object.freeze(['beat', 'bar', 'section']);
/** `set_preset_switch_policy()`'s policy numbers, by name (projectM-4/rhythm.h). */
export const PRESET_SWITCH_POLICIES = Object.freeze(['timer', 'bars', 'section']);

export class RhythmFacade {
    /** Live subscriptions to beat/bar/section; the engine reports only while there are any. */
    #listeners = 0;
    /** Unsubscribes from the transport's rhythm events, while subscribed. @type {(() => void) | null} */
    #unsubscribe = null;
    #getTransport;
    #getHostHandle;
    #emit;

    /**
     * @param {object} options
     * @param {() => RenderTransport | null} options.getTransport The context's current transport.
     * @param {() => number} options.getHostHandle Its host handle (0 = the default host).
     * @param {(type: string, detail: unknown) => void} options.emit Dispatches on the context's `events`.
     */
    constructor({ getTransport, getHostHandle, emit }) {
        this.#getTransport = getTransport;
        this.#getHostHandle = getHostHandle;
        this.#emit = emit;
    }

    /**
     * Counts a subscription to `type` if it is a rhythm event, connecting the
     * engine's reporting on the first. Returns the matching release.
     *
     * @param {string} type
     * @returns {() => void}
     */
    retain(type) {
        if (!RHYTHM_EVENT_TYPES.includes(type)) {
            return () => {};
        }
        this.#listeners++;
        this.sync();
        return () => {
            this.#listeners--;
            this.sync();
        };
    }

    /** @param {number} bpm Beats per minute, or 0 to go back to estimating. */
    setRhythmHint(bpm) {
        this.#call('setRhythmHint', Number.isFinite(bpm) && bpm > 0 ? bpm : 0);
    }

    /**
     * @param {ProjectMPresetSwitchPolicy} policy
     * @param {number} [bars] Default 16.
     */
    setPresetSwitchPolicy(policy, bars = 16) {
        const index = PRESET_SWITCH_POLICIES.indexOf(policy);
        if (index < 0) {
            throw new RangeError(`unknown preset switch policy: ${policy}`);
        }
        this.#call('setPresetSwitchPolicy', index, Number.isFinite(bars) && bars > 0 ? Math.round(bars) : 16);
    }

    /** @param {number} beats Beats, or 0 to use seconds only. */
    setTransitionDurationBeats(beats) {
        this.#call('transitionSetDurationBeats', Number.isFinite(beats) && beats > 0 ? beats : 0);
    }

    /** @param {boolean} enabled */
    setHardCutOnBeat(enabled) {
        this.#call('setHardCutOnBeat', !!enabled);
    }

    /** @returns {Promise<ProjectMRhythmInfo | null>} */
    async getRhythmInfo() {
        const transport = this.#getTransport();
        if (!transport || !transport.supports('getRhythmBpm')) {
            return null;
        }
        const [bpm, beatPhase, barPhase, confidence, beatIndex, section] = await Promise.all([
            transport.call('getRhythmBpm'),
            transport.call('getRhythmBeatPhase'),
            transport.call('getRhythmBarPhase'),
            transport.call('getRhythmConfidence'),
            transport.call('getRhythmBeatIndex'),
            transport.call('getRhythmSection'),
        ]);
        return {
            bpm: Number(bpm),
            beatPhase: Number(beatPhase),
            barPhase: Number(barPhase),
            confidence: Number(confidence),
            beatIndex: Number(beatIndex),
            section: Number(section),
        };
    }

    /**
     * Applies the rhythm options passed to the context's constructor, once the
     * engine is up.
     *
     * @param {{ presetSwitchPolicy?: ProjectMPresetSwitchPolicy, presetSwitchBars?: number, transitionBeats?: number, rhythmHint?: number }} options
     */
    applyOptions({ presetSwitchPolicy, presetSwitchBars, transitionBeats, rhythmHint }) {
        if (presetSwitchPolicy && presetSwitchPolicy !== 'timer') {
            this.setPresetSwitchPolicy(presetSwitchPolicy, presetSwitchBars);
        }
        if (typeof transitionBeats === 'number' && transitionBeats > 0) {
            this.setTransitionDurationBeats(transitionBeats);
        }
        if (typeof rhythmHint === 'number' && rhythmHint > 0) {
            this.setRhythmHint(rhythmHint);
        }
    }

    /**
     * Connects the engine's rhythm events while someone listens, and
     * disconnects them (engine reporting included) when nobody does.
     */
    sync() {
        const transport = this.#getTransport();
        const wanted = this.#listeners > 0 && !!transport && transport.supports('setRhythmEvents');
        if (wanted && !this.#unsubscribe && transport) {
            this.#unsubscribe = transport.onRhythmEvent((event) => {
                // A shared Module reports every engine's events to every
                // subscriber; keep this context's own.
                const host = this.#getHostHandle();
                if (host && event.host !== host) {
                    return;
                }
                if (event.beat) this.#emit('beat', event);
                if (event.bar) this.#emit('bar', event);
                if (event.section) this.#emit('section', event);
            });
            transport.callVoid('setRhythmEvents', true);
        } else if (!wanted && this.#unsubscribe) {
            this.#unsubscribe();
            this.#unsubscribe = null;
            if (transport && transport.supports('setRhythmEvents')) {
                transport.callVoid('setRhythmEvents', false);
            }
        }
    }

    /**
     * Drops the transport subscription without telling the engine (it is going
     * away). Listeners stay counted, so a later start() reconnects them.
     */
    detach() {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
    }

    /**
     * One control op, skipped on a bundle that predates it.
     *
     * @param {string} name
     * @param {...unknown} args
     */
    #call(name, ...args) {
        const transport = this.#getTransport();
        if (!transport || !transport.supports(name)) {
            return;
        }
        transport.callVoid(name, ...args);
    }
}
