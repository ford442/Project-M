// GENERATED from options.ts by scripts/build_html_ts.mjs — do not edit.
// Edit the .ts, then run `npm run build:html` (CI: npm run check:html-build).
import { resolveCanvasSelector, resolveContextOptions } from './boot.js';
export function resolveContextSetup(options) {
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
