// context/recovery.ts
//
// ProjectMContext's side of a WebGL context loss: rebuild the engine once the
// browser restores the context, then put back what the host set since start()
// — the presets it loaded, mesh quality, locks, eval variables, sprites (the
// record is context/replay.js's ReplayRecord). Detecting the loss and deciding
// when to recover is html/projectm-context-loss.js's job; it calls
// ProjectMContext.recoverContext(), which lands here.

import { contextConfigFor } from './boot.js';
import { readContextSnapshot } from './render.js';
import { replayOf, setContextSnapshot } from './controls.js';
import { replayOpsFor } from './replay.js';
import type { ProjectMContext } from '../projectm-context.js';

/**
 * Notes a preset `context` loaded, for replay after a context loss.
 *
 * @returns `loaded`, so a load can be recorded where it returns.
 */
export function recordLoaded<T extends { vfsPath: string }>(context: ProjectMContext, loaded: T): T {
    replayOf(context).recordPreset(loaded.vfsPath);
    return loaded;
}

/**
 * Rebuilds `context`'s engine on its restored WebGL context and replays its
 * record. Goes through the context's transport, which names its own host, so a
 * context sharing a Module with others recovers its own engine and not a
 * sibling's.
 *
 * @returns `init()`'s status: 0 recovered, 5 the context is still lost,
 *   anything else an init failure (-1 when not started).
 */
export async function recoverEngine(context: ProjectMContext): Promise<number> {
    const transport = context.transport;
    if (!transport) {
        return -1;
    }
    const status = await transport.recoverContext(context.canvas.width, context.canvas.height);
    if (status === 0 && context.transport === transport) {
        // A recovered engine runs on a new context; describe that one. (Not
        // if destroy() landed meanwhile: that context has nothing left to describe.)
        setContextSnapshot(context, readContextSnapshot(transport, contextConfigFor(context.options)));
        // init() started from the options; put back what was set since.
        await replayOf(context).replay(transport, replayOpsFor(context, transport));
    }
    return status;
}
