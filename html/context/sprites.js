// context/sprites.js
//
// ProjectMContext's user sprites (projectM-4/user_sprites.h): creating one
// from Milkdrop sprite code, reading and setting its expression variables, and
// destroying it, in either render topology.
//
// Every call goes through the projectm_sprite_*_wrapper exports with the engine's
// own handle (validated there, so a stale one is a no-op) rather than through create_sprite(): a bundle older than these
// exports has a zero-argument create_sprite() of the same name that ignores its
// arguments, so only the projectm_sprite_*_wrapper names tell a new bundle from an old
// one. The handle is asked for on every call, because recovering a lost WebGL
// context builds a new engine.

/**
 * @typedef {import('../projectm-transport-types.ts').RenderTransport} RenderTransport
 */

/**
 * @param {RenderTransport | null} transport
 * @param {string} method For the error message.
 * @returns {RenderTransport}
 */
function spriteTransport(transport, method) {
    if (!transport) {
        throw new Error(`${method}(): the context has not started`);
    }
    if (!transport.supports('projectmSpriteCreateWrapper')) {
        throw new Error(`${method}(): this projectM bundle predates the user-sprite exports`);
    }
    return transport;
}

/**
 * @param {RenderTransport} transport
 * @returns {Promise<number>}
 */
async function engineHandle(transport) {
    const handle = Number(await transport.call('getProjectmHandle'));
    if (!handle) {
        throw new Error('projectM engine is not initialized');
    }
    return handle;
}

/**
 * @param {RenderTransport | null} transport
 * @param {string} code Milkdrop sprite code (`[img01]` section syntax: `img=`, `init_N=`, `code_N=`).
 * @param {string} type Sprite type; `'milkdrop'` is the only one libprojectM knows.
 * @returns {Promise<number>} The sprite id.
 */
export async function createSpriteOn(transport, code, type) {
    const t = spriteTransport(transport, 'createSprite');
    const id = Number(await t.call('projectmSpriteCreateWrapper', await engineHandle(t), type, code));
    if (!id) {
        throw new Error('createSprite(): the engine refused the sprite (unknown type, code that does not compile, or the sprite limit)');
    }
    return id;
}

/**
 * @param {RenderTransport | null} transport
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function destroySpriteOn(transport, id) {
    const t = spriteTransport(transport, 'destroySprite');
    await t.call('projectmSpriteDestroyWrapper', await engineHandle(t), id);
}

/**
 * @param {RenderTransport | null} transport
 * @param {number} id
 * @param {string} name
 * @returns {Promise<number>}
 */
export async function getSpriteVarOn(transport, id, name) {
    const t = spriteTransport(transport, 'getSpriteVar');
    return Number(await t.call('projectmSpriteGetVarWrapper', await engineHandle(t), id, name));
}

/**
 * @param {RenderTransport | null} transport
 * @param {number} id
 * @param {string} name
 * @param {number} value
 * @returns {Promise<void>}
 */
export async function setSpriteVarOn(transport, id, name, value) {
    const t = spriteTransport(transport, 'setSpriteVar');
    await t.call('projectmSpriteSetVarWrapper', await engineHandle(t), id, name, value);
}
