// Unit tests for html/projectm-fbo-format.js — surfaces the dual ping-pong FBO
// colour format picked by DualPingPongFramebuffer::DetectFormat() and warns
// when the browser fell back to 8-bit. Run with:
//   node --test tests/web/projectm-fbo-format.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { getFboFormatName, setupFboFormatIndicator, setupWorkerFboFormatIndicator } from '../../html/projectm-fbo-format.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

const BANNER_ID = 'pm-degraded-mode-banner';

/** @param {number} formatIndex `dual_fbo_get_format()`'s return value. */
function fakeModule(formatIndex) {
    return { _dual_fbo_get_format: () => formatIndex };
}

test('the format index maps to the name the benchmark records', () => {
    // FboFloatFormat's numbering, shared with set_context_config()'s fboPrecision.
    for (const [index, name] of [[0, 'RGBA16F'], [1, 'RGBA32F'], [2, 'RGBA8']]) {
        const dom = installFakeDom();
        try {
            assert.equal(setupFboFormatIndicator(fakeModule(index)), name);
            // projectm-perf.js reads the format straight off the module for its
            // report; the indicator publishes nothing on window.
            assert.equal(getFboFormatName(fakeModule(index)), name);
            assert.equal('pmGetFboFormat' in globalThis.window, false);
        } finally {
            dom.restore();
        }
    }
});

test('an unrecognised format index degrades to RGBA8 rather than undefined', () => {
    const dom = installFakeDom();
    try {
        assert.equal(setupFboFormatIndicator(fakeModule(7)), 'RGBA8');
        assert.equal(setupFboFormatIndicator(fakeModule(-1)), 'RGBA8');
        assert.equal(getFboFormatName(fakeModule(7)), 'RGBA8');
    } finally {
        dom.restore();
    }
});

test('only the RGBA8 fallback shows the degraded-mode banner', () => {
    for (const index of [0, 1]) {
        const dom = installFakeDom();
        try {
            setupFboFormatIndicator(fakeModule(index));
            assert.equal(dom.document.getElementById(BANNER_ID), null, `index ${index} should not warn`);
        } finally {
            dom.restore();
        }
    }

    const dom = installFakeDom();
    try {
        setupFboFormatIndicator(fakeModule(2));
        const banner = dom.document.getElementById(BANNER_ID);
        assert.ok(banner, 'RGBA8 should raise the banner');
        assert.equal(banner.style.display, 'block');
        assert.match(banner.textContent, /Degraded rendering mode/);

        // A second call reuses the existing banner instead of stacking another.
        setupFboFormatIndicator(fakeModule(2));
        assert.equal(dom.document.body.children.filter((el) => el.id === BANNER_ID).length, 1);
    } finally {
        dom.restore();
    }
});

// The render worker owns the module, so the format reaches the page in its
// periodic stats (`fboFormat`, the same index) rather than through a call.

/** A worker handle whose stats a test pushes by hand. */
function fakeWorkerHandle(lastStats = null) {
    const listeners = new Set();
    return {
        getLastStats: () => lastStats,
        onStats: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        push(stats) {
            lastStats = stats;
            listeners.forEach((listener) => listener(stats));
        },
        listeners,
    };
}

test('the worker indicator waits for the first stats that carry a format, then stops listening', () => {
    const dom = installFakeDom();
    try {
        const handle = fakeWorkerHandle();
        const indicator = setupWorkerFboFormatIndicator(handle);
        assert.equal(indicator.format(), null, 'unknown until the worker reports');

        // A bundle without dual_fbo_get_format() reports -1: still unknown.
        handle.push({ type: 'stats', fboFormat: -1 });
        assert.equal(indicator.format(), null);

        handle.push({ type: 'stats', fboFormat: 2 });
        assert.equal(indicator.format(), 'RGBA8');
        assert.equal(dom.document.getElementById(BANNER_ID).style.display, 'block');
        assert.equal(handle.listeners.size, 0, 'the format is fixed at init(), so one report settles it');
    } finally {
        dom.restore();
    }
});

test('the worker indicator reads stats that arrived before it was set up', () => {
    const dom = installFakeDom();
    try {
        const handle = fakeWorkerHandle({ type: 'stats', fboFormat: 0 });
        const indicator = setupWorkerFboFormatIndicator(handle);
        assert.equal(indicator.format(), 'RGBA16F');
        assert.equal(handle.listeners.size, 0);
        assert.equal(dom.document.getElementById(BANNER_ID), null, 'a full-quality format shows no banner');
        indicator.dispose();
    } finally {
        dom.restore();
    }
});
