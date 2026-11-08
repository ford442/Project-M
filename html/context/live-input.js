// context/live-input.js
//
// ProjectMContext's live input (projectM-4/live_input.h, docs/LIVE_INPUT.md):
// live textures a camera, a video or a canvas feeds, and host values for the
// per-frame variables (q1..q32, zoom, decay, ...) a controller drives. The same
// calls in either render topology: the transport decides how a frame reaches
// the engine.

/**
 * @typedef {import('../projectm-transport-types.ts').RenderTransport} RenderTransport
 */

/**
 * @param {RenderTransport | null} transport
 * @param {string} method For the error message.
 * @param {string} probe The export whose absence marks an older bundle.
 * @returns {RenderTransport}
 */
export function liveInputTransport(transport, method, probe) {
    if (!transport) {
        throw new Error(`${method}(): the context has not started`);
    }
    if (!transport.supports(probe)) {
        throw new Error(`${method}(): this projectM bundle predates live input (${probe})`);
    }
    return transport;
}

/**
 * @param {RenderTransport | null} transport
 * @param {string} name
 * @param {number} value
 * @returns {Promise<boolean>}
 */
export async function setEvalVarOn(transport, name, value) {
    const t = liveInputTransport(transport, 'setEvalVar', 'evalSet');
    if (typeof name !== 'string' || !Number.isFinite(value)) {
        return false;
    }
    return Number(await t.call('evalSet', name, value)) === 1;
}

/**
 * @param {RenderTransport | null} transport
 * @param {string} name An empty name clears every value.
 * @returns {Promise<boolean>}
 */
export async function clearEvalVarOn(transport, name) {
    const t = liveInputTransport(transport, 'clearEvalVar', 'evalClear');
    return Number(await t.call('evalClear', typeof name === 'string' ? name : '')) === 1;
}
