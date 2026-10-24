// projectm-embed-demo.js
//
// html/embed-demo.html: one <project-m-visualizer> and a status line that
// follows its events. The smallest working embed, kept as a module so the
// typecheck and lint gates cover it like every other shipped script.

import './projectm-element.js';

/**
 * @param {Document} documentRef
 * @returns {{ dispose: () => void }}
 */
export function bootEmbedDemo(documentRef) {
    const status = documentRef.getElementById('status');
    const viz = documentRef.querySelector('project-m-visualizer');
    if (!status || !viz) return { dispose() {} };

    /** @type {Array<[string, (event: Event) => void]>} */
    const listeners = [
        [
            'pm-ready',
            () => {
                status.textContent = 'Ready';
            },
        ],
        [
            'pm-preset-changed',
            (event) => {
                status.textContent = `Preset: ${/** @type {CustomEvent<{ name: string }>} */ (event).detail.name}`;
            },
        ],
        [
            'pm-error',
            (event) => {
                const detail = /** @type {CustomEvent<{ message: string }>} */ (event).detail;
                status.textContent = `Error: ${detail.message}`;
                console.error(detail);
            },
        ],
        [
            'pm-fps',
            (event) => {
                status.dataset.fps = String(Math.round(/** @type {CustomEvent<{ fps: number }>} */ (event).detail.fps));
            },
        ],
    ];
    for (const [type, listener] of listeners) viz.addEventListener(type, listener);
    return {
        dispose() {
            for (const [type, listener] of listeners) viz.removeEventListener(type, listener);
        },
    };
}
