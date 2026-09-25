// Unit tests for html/projectm-init-errors.js: COI gate and init-error overlay
// detail shapes. Run with: node --test tests/web/projectm-init-errors.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    INIT_CONTEXT_LOST,
    checkCrossOriginIsolation,
    checkInit,
    hideInitError,
    setupInitErrorHandling,
    showInitError,
} from '../../html/projectm-init-errors.js';
import { countWasmCallbackSubscribers } from '../../html/projectm-wasm-callbacks.js';

function installMinimalDocument() {
    const nodes = new Map();

    function makeElement(tag) {
        const children = [];
        const classList = {
            classes: new Set(),
            add(...names) {
                for (const name of names) this.classes.add(name);
            },
            remove(...names) {
                for (const name of names) this.classes.delete(name);
            },
            contains(name) {
                return this.classes.has(name);
            },
        };

        const el = {
            tagName: tag.toUpperCase(),
            id: '',
            className: '',
            textContent: '',
            classList,
            style: {},
            children,
            appendChild(child) {
                children.push(child);
                return child;
            },
            querySelector(selector) {
                const className = selector.replace(/^\./, '');
                const walk = (node) => {
                    if (node.className === className) {
                        return node;
                    }
                    for (const child of node.children || []) {
                        const found = walk(child);
                        if (found) {
                            return found;
                        }
                    }
                    return null;
                };
                return walk(el);
            },
            set innerHTML(html) {
                if (!html.includes('pm-init-error-title')) {
                    return;
                }
                const title = makeElement('h2');
                title.className = 'pm-init-error-title';
                const message = makeElement('p');
                message.className = 'pm-init-error-message';
                const hints = makeElement('ul');
                hints.className = 'pm-init-error-hints';
                children.push(title, message, hints);
            },
        };
        return el;
    }

    const document = {
        head: {
            appendChild(node) {
                if (node.id) {
                    nodes.set(node.id, node);
                }
            },
        },
        body: {
            appendChild(node) {
                if (node.id) {
                    nodes.set(node.id, node);
                }
            },
        },
        getElementById(id) {
            return nodes.get(id) ?? null;
        },
        createElement: makeElement,
    };

    globalThis.document = document;
    return { nodes };
}

const { nodes } = installMinimalDocument();
const originalWindow = globalThis.window;
globalThis.window = { crossOriginIsolated: true };

test.after(() => {
    hideInitError();
    globalThis.window = originalWindow;
    delete globalThis.document;
});

test('checkCrossOriginIsolation returns false when crossOriginIsolated is false', () => {
    globalThis.window = { crossOriginIsolated: false };

    assert.equal(checkCrossOriginIsolation(), false);
    const overlay = nodes.get('pm-init-error');
    assert.ok(overlay, 'must create the init-error overlay');
    assert.equal(overlay.classList.contains('visible'), true);
});

test('checkCrossOriginIsolation returns true when crossOriginIsolated is true', () => {
    globalThis.window = { crossOriginIsolated: true };
    assert.equal(checkCrossOriginIsolation(), true);
});

test('showInitError maps known codes to stable title and hint lists', () => {
    hideInitError();
    showInitError(4, 'detail string');

    const overlay = nodes.get('pm-init-error');
    assert.ok(overlay);

    const title = overlay.querySelector('.pm-init-error-title');
    const message = overlay.querySelector('.pm-init-error-message');
    const hints = overlay.querySelector('.pm-init-error-hints');

    assert.equal(title?.textContent, 'Cross-Origin Isolation Unavailable');
    assert.match(message?.textContent ?? '', /detail string/);
    assert.ok((hints?.children?.length ?? 0) >= 2, 'code 4 should include troubleshooting hints');
    assert.equal(overlay.classList.contains('visible'), true);
});

test('checkInit keeps quiet while the context is lost, and reports any other failure', () => {
    hideInitError();
    const overlay = () => nodes.get('pm-init-error');

    // A tap on the context-loss overlay can call init() before the browser has
    // restored the context; the C++ side refuses with 5, which is not an error.
    assert.equal(checkInit({ _init: () => INIT_CONTEXT_LOST }), false);
    assert.equal(overlay().classList.contains('visible'), false);

    assert.equal(checkInit({ _init: () => 3 }), false);
    assert.equal(overlay().classList.contains('visible'), true);

    assert.equal(checkInit({ _init: () => 0 }), true);
    assert.equal(overlay().classList.contains('visible'), false);
});

test('setupInitErrorHandling listens for the engine callbacks without writing to window, and disposes', () => {
    hideInitError();
    const previousLocation = globalThis.location;
    globalThis.location = { search: '' };
    globalThis.window = { crossOriginIsolated: true };
    const overlay = () => nodes.get('pm-init-error');

    let handling;
    try {
        const keysBefore = Object.keys(globalThis.window);
        handling = setupInitErrorHandling(() => {});

        assert.equal(handling.simulate, false);
        assert.deepEqual(Object.keys(globalThis.window), keysBefore, 'nothing is assigned to window');
        assert.equal(countWasmCallbackSubscribers('pmReportInitError'), 1);
        assert.equal(countWasmCallbackSubscribers('pmHideInitError'), 1);

        // WasmJsBindings.cpp looks these up on globalThis by name.
        globalThis.pmReportInitError(4, 'from the engine');
        assert.equal(overlay().classList.contains('visible'), true);
        assert.match(overlay().querySelector('.pm-init-error-message').textContent, /from the engine/);

        globalThis.pmHideInitError();
        assert.equal(overlay().classList.contains('visible'), false);

        handling.dispose();
        assert.equal(countWasmCallbackSubscribers('pmReportInitError'), 0);
        assert.equal('pmReportInitError' in globalThis, false, 'the last listener gives the hook back');
        assert.equal('pmHideInitError' in globalThis, false);
    } finally {
        handling?.dispose();
        globalThis.location = previousLocation;
    }
});

test('?simulateInitFail=1 shows the overlay immediately', () => {
    hideInitError();
    const previousLocation = globalThis.location;
    globalThis.location = { search: '?simulateInitFail=1' };
    let handling;
    try {
        handling = setupInitErrorHandling(() => {});
        assert.equal(handling.simulate, true);
        assert.equal(nodes.get('pm-init-error').classList.contains('visible'), true);
    } finally {
        handling?.dispose();
        globalThis.location = previousLocation;
    }
});
