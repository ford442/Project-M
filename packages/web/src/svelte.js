// Svelte action for <project-m-visualizer>.
//
// Svelte handles custom elements natively, so this is only the part it does not
// do: object and boolean props in the form the element parses, and typed
// callbacks for the lifecycle CustomEvents.
//
//   <script>
//     import { projectM } from '@projectm/web/svelte';
//   </script>
//   <project-m-visualizer use:projectM={{ presetUrl, onReady }} />
//
// Applied to any other element, it creates the visualizer as a child, so it also
// works on a plain wrapper <div>.

import { ELEMENT_TAG } from '../staging/projectm-element-attributes.js';
import '../staging/projectm-element.js';
import { applyProjectMAttributes, bindProjectMEvents } from './bindings.js';

/**
 * @param {HTMLElement} node
 * @param {Record<string, any>} [params]
 */
export function projectM(node, params = {}) {
    const element = node.tagName.toLowerCase() === ELEMENT_TAG
        ? node
        : node.appendChild(document.createElement(ELEMENT_TAG));

    let unbind = () => {};
    /** @param {Record<string, any>} next */
    const apply = (next) => {
        applyProjectMAttributes(element, next);
        unbind();
        unbind = bindProjectMEvents(element, next);
    };
    apply(params);

    return {
        /** @param {Record<string, any>} next */
        update(next) {
            apply(next || {});
        },
        destroy() {
            unbind();
            if (element !== node) element.remove();
        },
    };
}

export default projectM;
