// Smoke tests for the React / Svelte / Vue wrappers in packages/web/src.
//
// `<project-m-visualizer>` is a custom element, so each wrapper is thin — and
// thin is exactly where a wrapper breaks quietly. The two things they all exist
// to do are the two things asserted here: props reach the element as the
// attribute spellings it observes (objects JSON-encoded, booleans present/absent
// rather than "true"/"false"), and `on*` handlers are subscribed to the
// lifecycle CustomEvents that a framework's own prop system never reaches.
//
// They run against the BUILT bundles, not the sources, because the bundler is
// part of what can break them: dropping the bare element import (which a stale
// `sideEffects` entry once did) leaves a wrapper that renders an inert tag.
//
// scripts/test_web_embed.sh runs the package build before this suite.

import assert from 'node:assert/strict';
import test from 'node:test';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distRoot = join(repoRoot, 'packages', 'web', 'dist');

// Every wrapper imports the element module for its registration side effect,
// and the element subclasses HTMLElement at module scope. Install the minimum
// custom-element globals before anything is loaded.
const definedElements = [];
globalThis.HTMLElement = class {};
globalThis.customElements = {
    get: (tag) => definedElements.find((entry) => entry.tag === tag)?.ctor,
    define: (tag, ctor) => definedElements.push({ tag, ctor }),
};

const load = (file) => import(`file://${join(distRoot, file)}`);

/** A DOM element stand-in that records what the wrappers do to it. */
function fakeElement(tagName = 'project-m-visualizer') {
    /** @type {Map<string, string>} */
    const attributes = new Map();
    /** @type {Array<{ type: string, listener: Function }>} */
    const listeners = [];
    const element = {
        tagName: tagName.toUpperCase(),
        attributes,
        listeners,
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: (name) => attributes.delete(name),
        getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
        addEventListener: (type, listener) => listeners.push({ type, listener }),
        removeEventListener: (type, listener) => {
            const index = listeners.findIndex((e) => e.type === type && e.listener === listener);
            if (index >= 0) listeners.splice(index, 1);
        },
        /** Fire a lifecycle event at whatever is subscribed. */
        emit: (type, detail) => {
            for (const entry of listeners.filter((e) => e.type === type)) {
                entry.listener({ type, detail });
            }
        },
        remove: () => {},
        querySelector: () => null,
        appendChild: (child) => child,
    };
    return element;
}

const SAMPLE_PROPS = {
    presetUrl: '/presets/000-empty.milk',
    meshQuality: 'high',
    targetFps: 60,
    transparent: true,
    locked: false,
    externalPcmOrigins: ['https://player.example'],
};

/** The attribute expectations shared by all three wrappers. */
function assertAttributes(element) {
    assert.equal(element.getAttribute('preset-url'), '/presets/000-empty.milk');
    assert.equal(element.getAttribute('mesh-quality'), 'high');
    assert.equal(element.getAttribute('target-fps'), '60');
    // Booleans are presence, not the string "true"/"false".
    assert.equal(element.getAttribute('transparent'), '');
    assert.equal(element.getAttribute('locked'), null, '`false` must remove the attribute');
    // Objects are JSON, not "[object Object]".
    assert.deepEqual(
        JSON.parse(element.getAttribute('external-pcm-origins')),
        ['https://player.example'],
    );
}

test('loading a wrapper registers the custom element', async () => {
    await load('svelte.js');
    assert.deepEqual(definedElements.map((entry) => entry.tag), ['project-m-visualizer']);
});

test('the Svelte action applies props and subscribes handlers', async () => {
    const { projectM } = await load('svelte.js');
    const element = fakeElement();

    /** @type {any[]} */
    const ready = [];
    const action = projectM(element, { ...SAMPLE_PROPS, onReady: (detail) => ready.push(detail) });
    assertAttributes(element);

    element.emit('pm-ready', { version: 'test' });
    assert.deepEqual(ready, [{ version: 'test' }]);

    // update() re-applies and must not leave the old handler double-subscribed.
    action.update({ presetUrl: '/presets/other.milk', onReady: (detail) => ready.push(detail) });
    assert.equal(element.getAttribute('preset-url'), '/presets/other.milk');
    assert.equal(element.getAttribute('mesh-quality'), null, 'dropped props must be removed');
    element.emit('pm-ready', { version: 'second' });
    assert.equal(ready.length, 2, 'the replaced handler was not unsubscribed');

    action.destroy();
    element.emit('pm-ready', { version: 'after-destroy' });
    assert.equal(ready.length, 2, 'destroy() must unsubscribe');
});

test('the Vue directive applies props on mount and update, and cleans up', async () => {
    const { vProjectM } = await load('vue.js');
    const element = fakeElement();

    /** @type {any[]} */
    const errors = [];
    vProjectM.mounted(element, { value: { ...SAMPLE_PROPS, onError: (d) => errors.push(d) } });
    assertAttributes(element);

    element.emit('pm-error', { code: 4 });
    assert.deepEqual(errors, [{ code: 4 }]);

    vProjectM.updated(element, { value: { presetUrl: '/presets/other.milk' } });
    assert.equal(element.getAttribute('preset-url'), '/presets/other.milk');
    element.emit('pm-error', { code: 5 });
    assert.equal(errors.length, 1, 'the previous handler was not unsubscribed on update');

    vProjectM.unmounted(element);
    assert.equal(element.listeners.length, 0, 'unmounted must remove every listener');
});

test('the React component renders the custom element and wires props and events', async () => {
    // React is a peer dependency; it is here as a devDependency so this can run.
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { ProjectMVisualizer } = await load('react.js');

    const markup = renderToStaticMarkup(
        createElement(ProjectMVisualizer, { className: 'viz', presetUrl: '/p.milk' }),
    );
    // Attributes are applied in an effect, which does not run during SSR — what
    // this asserts is that the component renders the real custom element tag
    // with passthrough props, rather than a div or nothing.
    assert.match(markup, /^<project-m-visualizer/, `unexpected markup: ${markup}`);
    assert.match(markup, /class="viz"/);
    assert.doesNotMatch(markup, /presetUrl/, 'wrapper props must not leak onto the DOM node');
});

test('each wrapper bundle keeps the element registration import', async () => {
    const { readFileSync } = await import('node:fs');
    // The bare `import '../staging/projectm-element.js'` is what defines the
    // custom element. A `sideEffects` hint that excludes it makes esbuild drop
    // the import silently, leaving a wrapper that renders an inert unknown tag.
    for (const entry of ['react.js', 'svelte.js', 'vue.js']) {
        const source = readFileSync(join(distRoot, entry), 'utf8');
        const chunks = [...source.matchAll(/from"(\.\/chunk-[^"]+)"/g)].map((m) => m[1]);
        const reachable = chunks
            .map((chunk) => readFileSync(join(distRoot, chunk.slice(2)), 'utf8'))
            .join('');
        assert.ok(
            `${source}${reachable}`.includes('customElements'),
            `${entry} no longer pulls in the custom-element registration`,
        );
    }
});
