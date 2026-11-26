// GENERATED from recovery.ts by scripts/build_html_ts.mjs — do not edit.
// Edit the .ts, then run `npm run build:html` (CI: npm run check:html-build).
import { contextConfigFor } from './boot.js';
import { readContextSnapshot } from './render.js';
import { replayOf, setContextSnapshot } from './controls.js';
import { replayOpsFor } from './replay.js';
export function recordLoaded(context, loaded) {
    replayOf(context).recordPreset(loaded.vfsPath);
    return loaded;
}
export async function recoverEngine(context) {
    const transport = context.transport;
    if (!transport) {
        return -1;
    }
    const status = await transport.recoverContext(context.canvas.width, context.canvas.height);
    if (status === 0 && context.transport === transport) {
        setContextSnapshot(context, readContextSnapshot(transport, contextConfigFor(context.options)));
        await replayOf(context).replay(transport, replayOpsFor(context, transport));
    }
    return status;
}
