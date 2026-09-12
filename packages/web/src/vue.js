// Vue 3 directive for <project-m-visualizer>.
//
//   import { vProjectM } from '@projectm/web/vue';
//   app.directive('projectm', vProjectM);
//
//   <project-m-visualizer v-projectm="{ presetUrl, onReady }" />
//
// Vue passes unknown props on custom elements through as attributes, so the
// directive exists for the same two reasons the other wrappers do: object and
// boolean values, and the lifecycle CustomEvents.
//
// Tell Vue the tag is a custom element, or it warns on every render:
//   compilerOptions.isCustomElement = (tag) => tag === 'project-m-visualizer'

import { ELEMENT_TAG } from '../staging/projectm-element-attributes.js';
import '../staging/projectm-element.js';
import { applyProjectMAttributes, bindProjectMEvents } from './bindings.js';

/** @type {WeakMap<Element, () => void>} */
const unbinders = new WeakMap();

/**
 * @param {Element} el
 * @param {{ value?: Record<string, any> }} binding
 */
function apply(el, binding) {
    const target = el.tagName.toLowerCase() === ELEMENT_TAG
        ? el
        : el.querySelector(ELEMENT_TAG) || el.appendChild(document.createElement(ELEMENT_TAG));
    const props = binding.value || {};
    applyProjectMAttributes(target, props);
    unbinders.get(target)?.();
    unbinders.set(target, bindProjectMEvents(target, props));
}

export const vProjectM = {
    mounted: apply,
    updated: apply,
    /** @param {Element} el */
    unmounted(el) {
        unbinders.get(el)?.();
        unbinders.delete(el);
    },
};

export default vProjectM;
