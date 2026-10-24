// context/presets.js
//
// ProjectMContext's presets: loading one from a URL or a File in either render
// topology, the `pm:preset-loaded` relay, and the musical side of preset
// switching — the rhythm controls (switch on bars/sections, crossfades in
// beats) and the beat/bar/section events `ProjectMContext.on()` delivers.

import { createAbortError } from './boot.js';
import { loadLocalPresetFile, loadPresetFromUrl, updatePresetDisplay } from '../projectm-presets.js';

/**
 * @typedef {import('../generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('../projectm-transport-types.ts').RenderTransport} RenderTransport
 * @typedef {import('../projectm-context-types.ts').ProjectMPresetDetail} ProjectMPresetDetail
 * @typedef {import('../projectm-context-types.ts').ProjectMPresetSwitchPolicy} ProjectMPresetSwitchPolicy
 * @typedef {import('../projectm-context-types.ts').ProjectMRhythmInfo} ProjectMRhythmInfo
 * @typedef {import('../projectm-context-types.ts').ProjectMResolvedContextOptions} ProjectMResolvedContextOptions
 */

/** The events `ProjectMContext.on()` routes from the engine's rhythm analysis. */
export const RHYTHM_EVENT_TYPES = Object.freeze(['beat', 'bar', 'section']);
/** `set_preset_switch_policy()`'s policy numbers, by name (projectM-4/rhythm.h). */
const PRESET_SWITCH_POLICIES = Object.freeze(['timer', 'bars', 'section']);

/**
 * @typedef {object} PresetTarget Where a preset load goes.
 * @property {RenderTransport} transport
 * @property {ProjectMModule | null} engine The bound main-thread engine; null in the worker topology.
 * @property {() => boolean} isCurrent Still this context's transport (no destroy() meanwhile).
 */

/**
 * @param {string} url
 * @param {PresetTarget & { windowRef?: Window, signal?: AbortSignal }} target
 * @returns {Promise<{ url: string; vfsPath: string; filename: string }>}
 */
export async function loadPresetUrlInto(url, { transport, engine, isCurrent, windowRef, signal }) {
    if (engine) {
        // The fetch yields; the load after it goes through `engine`, which
        // selects this context's host again however long that took.
        return loadPresetFromUrl(url, { module: engine, windowRef, signal });
    }

    // Worker topology: the fetch still happens here — this thread has the
    // page's credentials and cache — and only the bytes cross, to be written
    // into the VFS on the other side.
    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) {
        throw new Error(`Failed to fetch preset (${response.status}): ${url}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (signal?.aborted || !isCurrent()) {
        throw createAbortError(`Preset load aborted: ${url}`);
    }
    const filename = String(url).split('/').pop()?.split('?')[0] || 'preset.milk';
    const vfsPath = `/presets/url_${filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    transport.writePreset(vfsPath, bytes);
    updatePresetDisplay(vfsPath, { windowRef });
    return { url, vfsPath, filename };
}

/**
 * @param {File} file
 * @param {PresetTarget & { documentRef?: Document }} target
 * @returns {Promise<{ filename: string; vfsPath: string }>}
 */
export async function loadPresetFileInto(file, { transport, engine, isCurrent, documentRef }) {
    if (engine) {
        return loadLocalPresetFile(file, { module: engine, updateDisplay: true });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isCurrent()) {
        throw createAbortError(`Preset load aborted: ${file.name}`);
    }
    const vfsPath = `/presets/local_${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    transport.writePreset(vfsPath, bytes);
    let text;
    try {
        text = new TextDecoder().decode(bytes);
    } catch {
        text = undefined;
    }
    updatePresetDisplay(vfsPath, { documentRef, text });
    return { filename: file.name, vfsPath };
}

/**
 * Relays the page's `pm:preset-loaded` events to the context.
 *
 * @param {Window | undefined} windowRef
 * @param {(detail: ProjectMPresetDetail) => void} onPresetLoaded
 * @returns {(() => void) | null} Removes the listener; null without a window.
 */
export function relayPresetEvents(windowRef, onPresetLoaded) {
    if (!windowRef?.addEventListener) {
        return null;
    }
    const listener = (/** @type {Event} */ event) => {
        onPresetLoaded(/** @type {CustomEvent<ProjectMPresetDetail>} */ (event).detail);
    };
    windowRef.addEventListener('pm:preset-loaded', listener);
    return () => windowRef.removeEventListener('pm:preset-loaded', listener);
}

/**
 * One rhythm control op, skipped before start() and on a bundle that predates it.
 *
 * @param {RenderTransport | null} transport
 * @param {string} name
 * @param {...unknown} args
 */
export function callRhythm(transport, name, ...args) {
    if (!transport || !transport.supports(name)) {
        return;
    }
    transport.callVoid(name, ...args);
}

/**
 * `setPresetSwitchPolicy`'s wire arguments.
 *
 * @param {ProjectMPresetSwitchPolicy} policy
 * @param {number} bars
 * @returns {[number, number]}
 */
export function presetSwitchPolicyArgs(policy, bars) {
    const index = PRESET_SWITCH_POLICIES.indexOf(policy);
    if (index < 0) {
        throw new RangeError(`unknown preset switch policy: ${policy}`);
    }
    return [index, Number.isFinite(bars) && bars > 0 ? Math.round(bars) : 16];
}

/**
 * The rhythm options passed to the constructor, as calls to make once the
 * engine is up.
 *
 * @param {ProjectMResolvedContextOptions} options
 * @param {{
 *   setPresetSwitchPolicy: (policy: ProjectMPresetSwitchPolicy, bars?: number) => void,
 *   setTransitionDurationBeats: (beats: number) => void,
 *   setRhythmHint: (bpm: number) => void,
 * }} controls
 */
export function applyRhythmOptions(options, controls) {
    const { presetSwitchPolicy, presetSwitchBars, transitionBeats, rhythmHint } = options;
    if (presetSwitchPolicy && presetSwitchPolicy !== 'timer') {
        controls.setPresetSwitchPolicy(presetSwitchPolicy, presetSwitchBars);
    }
    if (typeof transitionBeats === 'number' && transitionBeats > 0) {
        controls.setTransitionDurationBeats(transitionBeats);
    }
    if (typeof rhythmHint === 'number' && rhythmHint > 0) {
        controls.setRhythmHint(rhythmHint);
    }
}

/**
 * Tempo and phase of the most recent frame, or null on a bundle without
 * rhythm analysis. One round trip per field in the worker topology.
 *
 * @param {RenderTransport | null} transport
 * @returns {Promise<ProjectMRhythmInfo | null>}
 */
export async function readRhythmInfo(transport) {
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
 * Connects the engine's rhythm events to a context while someone listens, and
 * disconnects them (engine reporting included) when nobody does. The engine
 * only reports while at least one listener is subscribed.
 */
export class RhythmEventRelay {
    /** Live beat/bar/section subscriptions. */
    #listeners = 0;
    /** @type {(() => void) | null} */
    #unsubscribe = null;
    /** @type {(type: string, detail: unknown) => void} */
    #emit;
    /** @type {() => number} */
    #hostHandle;

    /**
     * @param {(type: string, detail: unknown) => void} emit
     * @param {() => number} hostHandle The context's engine handle, 0 for the default host.
     */
    constructor(emit, hostHandle) {
        this.#emit = emit;
        this.#hostHandle = hostHandle;
    }

    /**
     * A listener came (+1) or went (-1).
     *
     * @param {1 | -1} delta
     * @param {RenderTransport | null} transport
     */
    count(delta, transport) {
        this.#listeners += delta;
        this.sync(transport);
    }

    /** @param {RenderTransport | null} transport */
    sync(transport) {
        const wanted = this.#listeners > 0 && !!transport && transport.supports('setRhythmEvents');
        if (wanted && !this.#unsubscribe && transport) {
            this.#unsubscribe = transport.onRhythmEvent((event) => {
                // A shared Module reports every engine's events to every
                // subscriber; keep this context's own.
                const host = this.#hostHandle();
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
     * The transport is going away with the engine. Listeners stay counted, and
     * the next sync() against a new transport reconnects them.
     */
    detach() {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
    }
}
