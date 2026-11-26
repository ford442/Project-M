// context/options.ts
//
// ProjectMContext's configuration: what the constructor derives from the
// options a host passes — the options with their defaults filled in, the
// canvases, the container the context sizes them to, and the CSS selectors the
// engine finds them by. Done once, before anything boots, and kept on the
// context as it is; start() reads it and nothing here touches the engine.

import { resolveCanvasSelector, resolveContextOptions } from './boot.js';
import type { ProjectMContextOptions, ProjectMResolvedContextOptions } from '@projectm/types/context';

/** Everything the constructor resolves from ProjectMContextOptions. */
export interface ContextSetup {
    options: ProjectMResolvedContextOptions;
    canvas: HTMLCanvasElement;
    secondaryCanvas: HTMLCanvasElement | null;
    /** What the canvases are sized to: `options.container`, else the canvas's parent, else the canvas. */
    container: HTMLElement;
    primaryCanvasSelector: string;
    secondaryCanvasSelector: string;
}

/**
 * Resolves the options a host passed to `new ProjectMContext()`.
 *
 * @throws When there is no canvas: there is nothing to render on.
 */
export function resolveContextSetup(options: ProjectMContextOptions): ContextSetup {
    if (!options?.canvas) {
        throw new Error('ProjectMContext requires a canvas element');
    }
    const { canvas } = options;
    const secondaryCanvas = options.secondaryCanvas ?? null;
    return {
        options: resolveContextOptions(options),
        canvas,
        secondaryCanvas,
        container: options.container ?? canvas.parentElement ?? canvas,
        primaryCanvasSelector: resolveCanvasSelector(canvas, options.primaryCanvasSelector, 'pm-main-canvas'),
        secondaryCanvasSelector: secondaryCanvas
            ? resolveCanvasSelector(secondaryCanvas, options.secondaryCanvasSelector, 'pm-secondary-canvas')
            : options.secondaryCanvasSelector || '#scanvas',
    };
}
