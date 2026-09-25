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
// The callbacks carry no host handle, so a subscriber cannot tell which engine
// instance in a shared Module produced one. Every subscriber sees every call;
// telling instances apart needs the handle passed from the C++ side.

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
    'pmOnTranspiledShaderStored',
    'pmReportInitError',
    'pmHideInitError',
]);

/**
 * @typedef {object} CallbackBus
 * @property {Set<(...args: any[]) => void>} listeners
 * @property {() => void} release Gives the global name back.
 */

/** @type {WeakMap<object, Map<string, CallbackBus>>} */
const busesByHost = new WeakMap();

/**
 * Listen to one engine callback.
 *
 * @param {string} name One of {@link WASM_CALLBACK_NAMES}.
 * @param {(...args: any[]) => void} listener
 * @param {any} [host] The object the engine reads the name from.
 * @returns {() => void} Unsubscribes this listener only. Idempotent.
 */
export function subscribeWasmCallback(name, listener, host = globalThis) {
    let buses = busesByHost.get(host);
    if (!buses) {
        buses = new Map();
        busesByHost.set(host, buses);
    }

    let bus = buses.get(name);
    if (!bus) {
        /** @type {Set<(...args: any[]) => void>} */
        const listeners = new Set();
        const dispatch = (/** @type {any[]} */ ...args) => {
            // Snapshot: a listener may unsubscribe itself (or a sibling) while
            // it runs, and one throwing must not starve the rest.
            for (const each of [...listeners]) {
                try {
                    each(...args);
                } catch (error) {
                    console.error(`[projectM] ${name} listener threw:`, error);
                }
            }
        };
        bus = { listeners, release: claimGlobal(host, name, dispatch) };
        buses.set(name, bus);
    }

    const ownBus = bus;
    const ownBuses = buses;
    // A wrapper per subscription, so subscribing the same function twice (from
    // two contexts) is two subscriptions rather than one Set entry.
    const entry = (/** @type {any[]} */ ...args) => listener(...args);
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
 * @param {any} [host]
 * @returns {number}
 */
export function countWasmCallbackSubscribers(name, host = globalThis) {
    return busesByHost.get(host)?.get(name)?.listeners.size ?? 0;
}
