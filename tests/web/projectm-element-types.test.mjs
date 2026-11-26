// @projectm/types/element describes <project-m-visualizer> for the framework
// wrappers (packages/web/src). Its props must be the element's attributes,
// one for one: a prop for an attribute the element does not observe is a prop
// the wrapper silently drops, and an attribute without a prop is one no
// wrapper user can set with types on. (EVENT_FOR_HANDLER, the event half, is
// checked by its JSDoc type against ProjectMVisualizerEventForHandler.)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { OBSERVED_ATTRIBUTES } from '../../html/projectm-element-attributes.js';
import { ATTRIBUTE_FOR_PROP, EVENT_FOR_HANDLER } from '../../packages/web/src/bindings.js';

const ELEMENT_TYPES = readFileSync(
    fileURLToPath(new URL('../../packages/types/src/element.ts', import.meta.url)),
    'utf8'
);

/** The member names of `interface <name> { ... }` in element.ts. */
function interfaceMembers(name) {
    const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(ELEMENT_TYPES);
    assert.ok(body, `element.ts declares ${name}`);
    return [...body[1].matchAll(/^\s+(?:readonly\s+)?(\w+)\??:/gm)].map((m) => m[1]).sort();
}

test('ProjectMVisualizerAttributeProps has one prop per observed attribute', () => {
    const camel = OBSERVED_ATTRIBUTES.map((a) => a.replace(/-([a-z])/g, (_, c) => c.toUpperCase())).sort();
    assert.deepEqual(interfaceMembers('ProjectMVisualizerAttributeProps'), camel);
    assert.deepEqual(Object.keys(ATTRIBUTE_FOR_PROP).sort(), camel);
});

test('ProjectMVisualizerEventForHandler is EVENT_FOR_HANDLER', () => {
    assert.deepEqual(interfaceMembers('ProjectMVisualizerEventForHandler'), Object.keys(EVENT_FOR_HANDLER).sort());
    for (const [handler, type] of Object.entries(EVENT_FOR_HANDLER)) {
        assert.match(ELEMENT_TYPES, new RegExp(`readonly ${handler}: '${type}';`));
        assert.match(ELEMENT_TYPES, new RegExp(`'${type}': CustomEvent<`), `${type} is in ProjectMVisualizerEventMap`);
    }
});
