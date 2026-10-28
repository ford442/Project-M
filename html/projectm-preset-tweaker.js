// projectm-preset-tweaker.js — simple header param sliders for live preset tuning.

import { createDisposables } from './projectm-disposables.js';

const TWEAKER_ID = 'pm-preset-tweaker';

/**
 * The tweaker on the page, if any. One strip per dev panel: a second setup
 * replaces the first instead of stacking a second set of sliders under it.
 *
 * @type {{ dispose(): void } | null}
 */
let activeTweaker = null;

/**
 * One tunable `.milk` header parameter.
 *
 * @typedef {object} TweakerParam
 * @property {string} key Header key as it appears in the `.milk` file.
 * @property {string} label Slider label.
 * @property {number} min
 * @property {number} max
 * @property {number} step
 * @property {number} def Default slider position.
 */

/** @type {readonly TweakerParam[]} */
const PARAMS = [
    { key: 'fDecay', label: 'Decay', min: 0.85, max: 0.995, step: 0.001, def: 0.96 },
    { key: 'zoom', label: 'Zoom', min: 0.9, max: 1.1, step: 0.001, def: 1.0 },
    { key: 'rot', label: 'Rot', min: -0.2, max: 0.2, step: 0.001, def: 0.0 },
    { key: 'warp', label: 'Warp', min: 0.0, max: 0.05, step: 0.001, def: 0.01 },
    { key: 'wave_r', label: 'Wave R', min: 0, max: 1, step: 0.01, def: 0.65 },
    { key: 'wave_g', label: 'Wave G', min: 0, max: 1, step: 0.01, def: 0.65 },
    { key: 'wave_b', label: 'Wave B', min: 0, max: 1, step: 0.01, def: 0.65 },
];

/**
 * @param {string} milkText
 * @param {string} key
 * @returns {number | null} null when the header key is absent.
 */
function parseHeaderValue(milkText, key) {
    const re = new RegExp(`^${key}=([-\\d.]+)`, 'm');
    const m = milkText.match(re);
    return m ? parseFloat(m[1]) : null;
}

/**
 * Rewrites (or inserts) a `key=value` header line.
 *
 * @param {string} milkText
 * @param {string} key
 * @param {number} value
 * @returns {string}
 */
function patchHeaderValue(milkText, key, value) {
    const re = new RegExp(`^${key}=[-\\d.]+`, 'm');
    // Trailing zeros off ("0.960000" -> "0.96", "1.000000" -> "1"); toFixed()
    // always leaves a decimal point for this to stop at.
    const line = `${key}=${value.toFixed(6).replace(/\.?0+$/, '')}`;
    if (re.test(milkText)) {
        return milkText.replace(re, line);
    }
    const insertAt = milkText.indexOf('[preset00]');
    if (insertAt >= 0) {
        const after = milkText.indexOf('\n', insertAt) + 1;
        return milkText.slice(0, after) + line + '\n' + milkText.slice(after);
    }
    return line + '\n' + milkText;
}

/**
 * Installs the header-param slider strip inside the dev panel.
 *
 * @param {object} options
 * @param {(patchedMilk: string) => Promise<void> | void} options.onApply
 * @param {() => string} [options.getSource] Defaults to the dev-panel editor's contents.
 * @param {Document} [options.documentRef]
 * @returns {{ syncFromMilk: (milkText: string) => void, patchHeaderValue: typeof patchHeaderValue, dispose: () => void }}
 */
export function setupPresetTweaker(options) {
    const documentRef = options.documentRef ?? document;
    activeTweaker?.dispose();
    const owned = createDisposables({ label: 'projectM preset tweaker' });

    const getSource = options.getSource || (() => {
        const ed = /** @type {HTMLTextAreaElement | null} */ (
            documentRef.getElementById('pm-dev-editor')
        );
        return ed ? ed.value : '';
    });

    const root = documentRef.createElement('div');
    root.id = TWEAKER_ID;
    root.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid #334155';
    const heading = documentRef.createElement('strong');
    heading.style.color = '#94a3b8';
    heading.textContent = 'Param tweaker';
    root.appendChild(heading);
    const devPanel = documentRef.getElementById('pm-preset-dev-panel');
    if (devPanel) owned.append(devPanel, root);

    /** @type {Record<string, { input: HTMLInputElement, p: TweakerParam }>} */
    const sliders = {};
    PARAMS.forEach((p) => {
        const row = documentRef.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0';
        const label = documentRef.createElement('label');
        label.textContent = p.label;
        label.style.flex = '0 0 52px';
        const input = documentRef.createElement('input');
        input.type = 'range';
        input.min = String(p.min);
        input.max = String(p.max);
        input.step = String(p.step);
        input.value = String(p.def);
        input.style.flex = '1';
        const val = documentRef.createElement('span');
        val.style.flex = '0 0 48px';
        val.textContent = String(p.def);
        owned.listen(input, 'input', () => { val.textContent = input.value; });
        row.append(label, input, val);
        root.appendChild(row);
        sliders[p.key] = { input, p };
    });

    const applyBtn = documentRef.createElement('button');
    applyBtn.type = 'button';
    applyBtn.textContent = 'Apply tweaker';
    applyBtn.style.marginTop = '6px';
    root.appendChild(applyBtn);

    owned.listen(applyBtn, 'click', () => {
        let text = getSource();
        if (!text.trim()) return;
        PARAMS.forEach((p) => {
            const v = parseFloat(sliders[p.key].input.value);
            text = patchHeaderValue(text, p.key, v);
        });
        // onApply loads the patched preset; a failure (a bad edit) is reported,
        // not left as an unhandled rejection.
        Promise.resolve()
            .then(() => options.onApply(text))
            .catch((error) => {
                console.error('[projectM] preset tweaker apply failed:', error);
            });
    });

    const handle = {
        /** @param {string} milkText */
        syncFromMilk(milkText) {
            PARAMS.forEach((p) => {
                const cur = parseHeaderValue(milkText, p.key);
                if (cur != null) {
                    sliders[p.key].input.value = String(cur);
                }
            });
        },
        patchHeaderValue,
        dispose() {
            owned.dispose();
            if (activeTweaker === handle) activeTweaker = null;
        },
    };
    activeTweaker = handle;
    return handle;
}

export { PARAMS, patchHeaderValue, parseHeaderValue };
