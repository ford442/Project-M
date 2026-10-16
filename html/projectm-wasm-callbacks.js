// projectm-wasm-callbacks.js
//
// The WASM -> host callback bus.
//
// The engine's EM_JS bodies (src/wasm/WasmPerfGovernor.cpp, WasmShaderCache.cpp,
// WasmJsBindings.cpp) report to the page by looking up a fixed *global name* --
// `globalThis.pmOnGovernorRenderScaleChange(scale)`, `globalThis.pmOnPerfFrame(stats)`
// and so on. That name is part of the bundle's ABI (tests/wasm-smoke/
// host_contract_names.mjs guards it), so it cannot move into an opt-in shim: a
// page that never imports the legacy globals must still hear the governor.
//
// What a host *can* control is how many things believe they own the name. With a
// plain assignment, two contexts overwrite each other and the first destroy()
// nulls the second one's hook. Here the global is installed once, on the first
// subscription, as a dispatcher that fans out to every subscriber, and removed
// again when the last one leaves.
//
// Which engine: since bundle 040 every callback names the engine it came from --
// the handle create_host*() returned, 0 for the legacy default host -- as its
// first argument (or `stats.host` / `event.host` on the two that pass an
// object). The dispatcher turns each call into one typed event
// (projectm-host-types.ts, `host` on every one), and a subscriber that passes
// `{ engineHost }` only hears its own engine. That is what lets two engines in
// one Module sit at different governor tiers: before it, engine A dropping a
// tier resized engine B's canvas too.
//
// Bundles up to 039 call the same names without the handle. The dispatcher
// tells the two apart by arity -- every positional callback gains exactly one
// leading argument, so the old and new shapes never have the same length -- and
// gives an old call `host: null`, which every subscriber hears, filtered or not:
// a page on an old bundle keeps today's fan-out rather than going deaf.

import { claimGlobal } from './projectm-globals.js';

/**
 * Every callback name the engine looks up on `globalThis`. Keep in sync with
 * the `typeof globalThis.<name> === 'function'` guards in src/wasm/.
 */
export const WASM_CALLBACK_NAMES = Object.freeze([
    'pmOnGovernorTierChange',
    'pmOnGovernorRenderScaleChange',
    'pmOnGovernorBlurCapChange',
    'pmOnPerfFrame',
    'pmSetPerfHudEnabled',
    'pmOnRhythmEvent',
    'pmOnTranspiledShaderStored',
    'pmReportInitError',
    'pmHideInitError',
]);

/**
 * The positional callbacks' payload fields, in the order the engine passes
 * them after the host handle. The two callbacks missing here pass one object.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const POSITIONAL_FIELDS = Object.freeze({
    pmOnGovernorTierChange: ['tier'],
    pmOnGovernorRenderScaleChange: ['scale'],
    pmOnGovernorBlurCapChange: ['cap'],
    pmSetPerfHudEnabled: ['enabled'],
    pmOnTranspiledShaderStored: ['key', 'kind', 'glsl'],
    pmReportInitError: ['code', 'detail'],
    pmHideInitError: [],
});

/**
 * @typedef {import('./projectm-host-types.ts').WasmCallbackEvent} WasmCallbackEvent
 * @typedef {import('./projectm-host-types.ts').WasmCallbackEventMap} WasmCallbackEventMap
 */

/**
 * Turns one engine call into the event its listeners get: `host` plus the
 * payload. Exported for the tests that pin both bundle shapes.
 *
 * @param {string} name
 * @param {unknown[]} args What the engine passed.
 * @returns {WasmCallbackEvent}
 */
export function decodeWasmCallback(name, args) {
    const fields = POSITIONAL_FIELDS[name];
    if (!fields) {
        // pmOnPerfFrame / pmOnRhythmEvent: one object, `host` on it since 040.
        const payload = /** @type {Record<string, unknown>} */ (args[0] ?? {});
        return /** @type {WasmCallbackEvent} */ (/** @type {unknown} */ (
            typeof payload.host === 'number' ? payload : { ...payload, host: null }
        ));
    }
    // 040+: (host, ...fields). Up to 039: (...fields), and a JS caller may
    // leave trailing ones out, so only a longer call can carry the handle.
    const scoped = args.length > fields.length;
    const values = scoped ? args.slice(1) : args;
    /** @type {Record<string, unknown>} */
    const event = { host: scoped ? Number(args[0]) : null };
    fields.forEach((field, index) => {
        event[field] = values[index];
    });
    return /** @type {WasmCallbackEvent} */ (/** @type {unknown} */ (event));
}

/**
 * @typedef {object} CallbackBus
 * @property {Set<(event: any) => void>} listeners
 * @property {() => void} release Gives the global name back.
 */

/** @type {WeakMap<object, Map<string, CallbackBus>>} */
const busesByHost = new WeakMap();

/**
 * @typedef {object} WasmCallbackFilter
 * @property {number} [engineHost] Only events from this engine: a context's
 *   `hostHandle` (0 for the default host). Omitted means every engine -- right
 *   for a page-wide listener such as the perf HUD on a single-engine page or
 *   the shader-cache store. Events from a bundle that predates the handle
 *   (`host: null`) reach filtered listeners too.
 */

/**
 * Listen to one engine callback.
 *
 * @template {keyof WasmCallbackEventMap} N
 * @param {N} name One of {@link WASM_CALLBACK_NAMES}.
 * @param {(event: WasmCallbackEventMap[N]) => void} listener Gets one event
 *   object per engine call, with `host` naming the engine.
 * @param {any} [hostObject] The object the engine reads the name from.
 * @param {WasmCallbackFilter} [filter]
 * @returns {() => void} Unsubscribes this listener only. Idempotent.
 */
export function subscribeWasmCallback(name, listener, hostObject = globalThis, filter = {}) {
    let buses = busesByHost.get(hostObject);
    if (!buses) {
        buses = new Map();
        busesByHost.set(hostObject, buses);
    }

    let bus = buses.get(name);
    if (!bus) {
        /** @type {Set<(event: any) => void>} */
        const listeners = new Set();
        const dispatch = (/** @type {any[]} */ ...args) => {
            const event = decodeWasmCallback(name, args);
            // Snapshot: a listener may unsubscribe itself (or a sibling) while
            // it runs, and one throwing must not starve the rest.
            for (const each of [...listeners]) {
                try {
                    each(event);
                } catch (error) {
                    console.error(`[projectM] ${name} listener threw:`, error);
                }
            }
        };
        bus = { listeners, release: claimGlobal(hostObject, name, dispatch) };
        buses.set(name, bus);
    }

    const ownBus = bus;
    const ownBuses = buses;
    const { engineHost } = filter ?? {};
    const scoped = typeof engineHost === 'number';
    // A wrapper per subscription, so subscribing the same function twice (from
    // two contexts) is two subscriptions rather than one Set entry.
    const entry = (/** @type {WasmCallbackEvent} */ event) => {
        if (scoped && event.host !== null && event.host !== engineHost) {
            return;
        }
        listener(/** @type {WasmCallbackEventMap[N]} */ (event));
    };
    ownBus.listeners.add(entry);

    let unsubscribed = false;
    return () => {
        if (unsubscribed) {
            return;
        }
        unsubscribed = true;
        ownBus.listeners.delete(entry);
        if (ownBus.listeners.size === 0 && ownBuses.get(name) === ownBus) {
            ownBuses.delete(name);
            ownBus.release();
        }
    };
}

/**
 * How many subscribers a callback has. For tests and diagnostics.
 *
 * @param {string} name
 * @param {any} [hostObject]
 * @returns {number}
 */
export function countWasmCallbackSubscribers(name, hostObject = globalThis) {
    return busesByHost.get(hostObject)?.get(name)?.listeners.size ?? 0;
}
