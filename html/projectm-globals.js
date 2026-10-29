// projectm-globals.js
//
// Ownership-tracked writes to process-wide slots (`window.Module`,
// `globalThis.projectMWritePcmRing`, the WASM -> host callbacks, ...).
//
// A plain `window.x = fn` on start and `window.x = null` on destroy is correct
// only while there is one writer. With two contexts on a page the second write
// silently replaces the first, and the first context's destroy() then nulls the
// slot the *second* one is using. `claimGlobal()` keeps a stack of claims per
// slot instead: the newest claim is the visible value, and releasing a claim
// removes only that claim. Whoever is left underneath becomes visible again, and
// the slot returns to its pre-claim value once the last claim is gone.
//
// A release never overwrites a value it does not recognise. If some other script
// assigned the slot directly in the meantime (a smoke page wrapping
// `globalThis.pmOnPerfFrame`, say) that value stays where it is.

/**
 * @typedef {object} GlobalSlot
 * @property {boolean} hadOwn Whether the host had its own property before the first claim.
 * @property {unknown} original The value the host had before the first claim.
 * @property {{ value: unknown }[]} claims Oldest first; the last entry is the visible value.
 */

/** @type {WeakMap<object, Map<string, GlobalSlot>>} */
const slotsByHost = new WeakMap();

/**
 * Publish `value` as `host[key]` until the returned function is called.
 *
 * @param {any} host The object carrying the slot, usually `window` / `globalThis`.
 * @param {string} key
 * @param {unknown} value
 * @returns {() => void} Releases this claim only. Idempotent.
 */
export function claimGlobal(host, key, value) {
    let slots = slotsByHost.get(host);
    if (!slots) {
        slots = new Map();
        slotsByHost.set(host, slots);
    }

    let slot = slots.get(key);
    if (!slot) {
        slot = {
            hadOwn: Object.prototype.hasOwnProperty.call(host, key),
            original: host[key],
            claims: [],
        };
        slots.set(key, slot);
    }

    const claim = { value };
    slot.claims.push(claim);
    host[key] = value;

    const ownSlot = slot;
    const ownSlots = slots;
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;

        const index = ownSlot.claims.indexOf(claim);
        if (index === -1) {
            return;
        }
        const wasVisible = index === ownSlot.claims.length - 1;
        ownSlot.claims.splice(index, 1);
        const stillOurs = host[key] === claim.value;

        if (ownSlot.claims.length === 0) {
            ownSlots.delete(key);
            if (!stillOurs) {
                return;
            }
            if (ownSlot.hadOwn) {
                host[key] = ownSlot.original;
            } else {
                delete host[key];
            }
            return;
        }

        if (wasVisible && stillOurs) {
            host[key] = ownSlot.claims[ownSlot.claims.length - 1].value;
        }
    };
}

/**
 * How many live claims a slot has. For tests and diagnostics.
 *
 * @param {any} host
 * @param {string} key
 * @returns {number}
 */
export function countGlobalClaims(host, key) {
    return slotsByHost.get(host)?.get(key)?.claims.length ?? 0;
}
