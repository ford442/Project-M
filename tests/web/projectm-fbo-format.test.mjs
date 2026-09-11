// Unit tests for html/projectm-fbo-format.js — surfaces the dual ping-pong FBO
// colour format picked by DualPingPongFramebuffer::DetectFormat() and warns
// when the browser fell back to 8-bit. Run with:
//   node --test tests/web/projectm-fbo-format.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { setupFboFormatIndicator } from '../../html/projectm-fbo-format.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

const BANNER_ID = 'pm-degraded-mode-banner';

/** @param {number} formatIndex `dual_fbo_get_format()`'s return value. */
function fakeModule(formatIndex) {
    return { _dual_fbo_get_format: () => formatIndex };
}

test('the format index maps to the name the benchmark records', () => {
    for (const [index, name] of [[0, 'RGBA32F'], [1, 'RGBA16F'], [2, 'RGBA8']]) {
        const dom = installFakeDom();
        try {
            assert.equal(setupFboFormatIndicator(fakeModule(index)), name);
            // projectm-perf.js reads the format back off window for its report.
            assert.equal(globalThis.window.pmGetFboFormat(), name);
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
