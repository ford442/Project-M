// Shared prop/event plumbing for the framework wrappers.
//
// `<project-m-visualizer>` is a custom element, so the wrappers are thin: their
// whole job is the two things frameworks get wrong about custom elements —
// mapping camelCase props onto kebab-case attributes, and subscribing to
// `CustomEvent`s that JSX-style `onFoo` props do not reach.
//
// The attribute list is derived from OBSERVED_ATTRIBUTES rather than restated,
// so adding an attribute to the element cannot leave the wrappers behind.

import { OBSERVED_ATTRIBUTES } from '../staging/projectm-element-attributes.js';

/**
 * `preset-url` -> `presetUrl`
 *
 * @param {string} attribute
 * @returns {string}
 */
function toCamelCase(attribute) {
    return attribute.replace(/-([a-z])/g, (/** @type {string} */ _, /** @type {string} */ letter) => letter.toUpperCase());
}

/** Every supported prop name, mapped to the attribute it sets. */
export const ATTRIBUTE_FOR_PROP = Object.freeze(
    Object.fromEntries(OBSERVED_ATTRIBUTES.map((attribute) => [toCamelCase(attribute), attribute])),
);

/**
 * Lifecycle events the element dispatches, mapped from the handler prop name.
 *
 * Kept as an explicit list because these are a contract with embedders, not an
 * internal detail: renaming one is a breaking change for every wrapper user.
 */
export const EVENT_FOR_HANDLER = Object.freeze({
    onReady: 'pm-ready',
    onError: 'pm-error',
    onPresetChanged: 'pm-preset-changed',
    onFps: 'pm-fps',
    onAudioSource: 'pm-audio-source',
});

/**
 * Reflect props onto the element as attributes.
 *
 * `false`, `null` and `undefined` remove the attribute; `true` sets it empty,
 * which is how the element reads boolean attributes (`transparent`, `locked`).
 * Arrays and objects are JSON-encoded for `external-pcm-origins`.
 *
 * @param {Element} element
 * @param {Record<string, unknown>} props
 */
export function applyProjectMAttributes(element, props) {
    for (const [prop, attribute] of Object.entries(ATTRIBUTE_FOR_PROP)) {
        const value = props[prop];
        if (value === undefined || value === null || value === false) {
            element.removeAttribute(attribute);
            continue;
        }
        if (value === true) {
            element.setAttribute(attribute, '');
            continue;
        }
        element.setAttribute(
            attribute,
            typeof value === 'object' ? JSON.stringify(value) : String(value),
        );
    }
}

/**
 * Subscribe the `on*` props in `props` to the element's lifecycle events.
 *
 * @param {EventTarget} element
 * @param {Record<string, unknown>} props
 * @returns {() => void} Unsubscribe.
 */
export function bindProjectMEvents(element, props) {
    /** @type {Array<[string, EventListener]>} */
    const bound = [];
    for (const [prop, type] of Object.entries(EVENT_FOR_HANDLER)) {
        const handler = props[prop];
        if (typeof handler !== 'function') continue;
        /** @param {Event} event */
        const listener = (event) => {
            handler(/** @type {CustomEvent} */ (event).detail, event);
        };
        element.addEventListener(type, listener);
        bound.push([type, listener]);
    }
    return () => {
        for (const [type, listener] of bound) element.removeEventListener(type, listener);
    };
}

/**
 * Props that are neither attributes nor handlers, and so pass straight through.
 *
 * @param {Record<string, unknown>} props
 * @returns {Record<string, unknown>}
 */
export function splitPassthroughProps(props) {
    /** @type {Record<string, unknown>} */
    const rest = {};
    for (const [key, value] of Object.entries(props)) {
        if (key in ATTRIBUTE_FOR_PROP) continue;
        if (key in EVENT_FOR_HANDLER) continue;
        rest[key] = value;
    }
    return rest;
}
