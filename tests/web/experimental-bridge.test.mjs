// Unit tests for pure helpers in html/projectm-experimental-bridge.js.
// Run with: node --test tests/web/experimental-bridge.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseExperimentalMetadata,
    setupExperimentalBridge,
    wantsExperimentalDepth,
    buildDepthSpriteCode
} from '../../html/projectm-experimental-bridge.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

test('parseExperimentalMetadata returns empty for plain milk', () => {
    const milk = 'MILKDROP_PRESET_VERSION=201\n[preset00]\nfRating=3\n';
    assert.deepEqual(parseExperimentalMetadata(milk), {});
});

test('parseExperimentalMetadata parses key=value tokens', () => {
    const milk = [
        '// Signature Series demo',
        '// pm:experimental depth=auto depth-texture=pm_depth_map shapecode=0 gltf-export=on-lock',
        'MILKDROP_PRESET_VERSION=201',
        '[preset00]'
    ].join('\n');
    const meta = parseExperimentalMetadata(milk);
    assert.equal(meta.depth, 'auto');
    assert.equal(meta['depth-texture'], 'pm_depth_map');
    assert.equal(meta.shapecode, '0');
    assert.equal(meta['gltf-export'], 'on-lock');
});

test('parseExperimentalMetadata treats bare tokens as true', () => {
    const milk = '// pm:experimental experimental depth-source=upload\nMILKDROP_PRESET_VERSION=201\n';
    const meta = parseExperimentalMetadata(milk);
    assert.equal(meta.experimental, 'true');
    assert.equal(meta['depth-source'], 'upload');
});

test('parseExperimentalMetadata ignores empty input', () => {
    assert.deepEqual(parseExperimentalMetadata(''), {});
    assert.deepEqual(parseExperimentalMetadata(null), {});
    assert.deepEqual(parseExperimentalMetadata(undefined), {});
});

test('wantsExperimentalDepth detects auto and texture directives', () => {
    assert.equal(wantsExperimentalDepth({}), false);
    assert.equal(wantsExperimentalDepth({ depth: 'auto' }), true);
    assert.equal(wantsExperimentalDepth({ 'depth-texture': 'pm_depth_map' }), true);
    assert.equal(wantsExperimentalDepth({ depth: 'true' }), true);
    assert.equal(wantsExperimentalDepth({ 'gltf-export': 'true' }), false);
});

test('buildDepthSpriteCode emits milkdrop sprite block with depth texture', () => {
    const code = buildDepthSpriteCode({ scale: 1.2, blendmode: 1 });
    assert.match(code, /\[preset01\]/);
    assert.match(code, /img='textures\/pm_depth_map\.png'/);
    assert.match(code, /scaling=1\.2/);
    assert.match(code, /blendmode=1/);
    assert.match(code, /bass_att/);
});

// ---- lifecycle ---------------------------------------------------------------

test('the bridge is inert without ?experimental=1', () => {
    const dom = installFakeDom();
    try {
        assert.deepEqual(setupExperimentalBridge({}, { params: new URLSearchParams() }), { enabled: false });
    } finally {
        dom.restore();
    }
});

test('an enabled bridge returns its api, publishes nothing on window, and dispose detaches everything', () => {
    const dom = installFakeDom();
    /** @type {Map<string, Set<Function>>} */
    const windowListeners = new Map();
    globalThis.window.addEventListener = (type, listener) => {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type).add(listener);
    };
    globalThis.window.removeEventListener = (type, listener) => windowListeners.get(type)?.delete(listener);
    const listenerCount = (type) => windowListeners.get(type)?.size ?? 0;

    let observing = 0;
    let disconnected = 0;
    const previousObserver = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
        observe() { observing += 1; }
        disconnect() { disconnected += 1; }
    };

    let bridge;
    try {
        const keysBefore = Object.keys(globalThis.window).sort();
        bridge = setupExperimentalBridge({}, { params: new URLSearchParams('experimental=1') });

        assert.equal(bridge.enabled, true);
        assert.equal(typeof bridge.api.applyDepthTexture, 'function');
        assert.equal(bridge.state, bridge.api.state);
        assert.deepEqual(
            Object.keys(globalThis.window).sort(),
            keysBefore,
            'the bridge must not publish window.pmExperimental itself; exposeExperimentalGlobals() does',
        );

        assert.equal(listenerCount('pm:preset-loaded'), 1);
        assert.equal(listenerCount('pm:preset-text'), 1);
        assert.equal(observing, 1);

        bridge.dispose();
        assert.equal(listenerCount('pm:preset-loaded'), 0);
        assert.equal(listenerCount('pm:preset-text'), 0);
        assert.equal(disconnected, 1);
    } finally {
        // The image BroadcastChannel is a real one and would keep node alive.
        bridge?.dispose?.();
        globalThis.MutationObserver = previousObserver;
        dom.restore();
    }
});
