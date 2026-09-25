// Unit tests for html/projectm-fps-governor.js and html/projectm-mesh-quality.js
// — the two "apply a persisted setting, then hand the host a control for it"
// modules. Run with:
//   node --test tests/web/projectm-fps-governor.test.mjs
//
// What matters here beyond the settings themselves:
//   * `localStorage` throws on *access* in a sandboxed iframe, so a page that
//     cannot persist must still boot;
//   * neither module writes to the page: the governor's tier notifications ride
//     the WASM callback bus, and the setters come back as a returned object;
//   * two modules on one page keep separate subscriptions, and disposing one
//     leaves the other hearing the engine.

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { setupFpsGovernor } from '../../html/projectm-fps-governor.js';
import { setupMeshQuality } from '../../html/projectm-mesh-quality.js';
import { countWasmCallbackSubscribers } from '../../html/projectm-wasm-callbacks.js';

/** Governors started by a test; every one is disposed so none outlives it. */
const started = [];
afterEach(() => {
    for (const governor of started.splice(0)) governor.dispose();
});

/** @param {URLSearchParams | string} [query] */
function params(query = '') {
    return new URLSearchParams(query);
}

function fakeModule({ renderScale = 1, blurCap = -1, tier = 0 } = {}) {
    /** @type {Array<[string, ...unknown[]]>} */
    const calls = [];
    return {
        calls,
        _set_target_fps: (fps) => calls.push(['set_target_fps', fps]),
        _set_quality_governor: (enabled) => calls.push(['set_quality_governor', enabled]),
        _get_quality_tier: () => tier,
        _get_governor_render_scale: () => renderScale,
        _get_governor_blur_cap: () => blurCap,
        _set_mesh: (width, height) => calls.push(['set_mesh', width, height]),
    };
}

function startGovernor(module, options = {}) {
    const governor = setupFpsGovernor(module, { params: params(), ...options });
    started.push(governor);
    return governor;
}

/**
 * Runs `fn` with `globalThis.localStorage` behaving as `storage`, where a
 * function value is used as the property getter (so it can throw on access,
 * like a sandboxed iframe does).
 */
function withLocalStorage(storage, fn) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: typeof storage === 'function' ? storage : () => storage,
    });
    try {
        return fn();
    } finally {
        if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
        else delete globalThis.localStorage;
    }
}

function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        map,
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
    };
}

const blockedStorage = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
};

// ---- fps governor: settings ---------------------------------------------------

test('the query string wins over storage, and storage over the defaults', () => {
    withLocalStorage(fakeStorage({ targetFps: '30', qualityGovernor: '0' }), () => {
        const fromStorage = startGovernor(fakeModule());
        assert.equal(fromStorage.targetFps, 30);
        assert.equal(fromStorage.governorEnabled, false);

        const fromQuery = startGovernor(fakeModule(), { params: params('?targetFps=75&governor=1') });
        assert.equal(fromQuery.targetFps, 75);
        assert.equal(fromQuery.governorEnabled, true);
    });

    withLocalStorage(fakeStorage(), () => {
        const defaults = startGovernor(fakeModule());
        assert.equal(defaults.targetFps, 60);
        assert.equal(defaults.governorEnabled, true);
    });
});

test('the applied values reach the engine', () => {
    withLocalStorage(fakeStorage(), () => {
        const module = fakeModule();
        startGovernor(module, { params: params('?targetFps=45&governor=0') });
        assert.deepEqual(module.calls, [['set_target_fps', 45], ['set_quality_governor', 0]]);
    });
});

test('a page whose localStorage throws on access still boots with defaults', () => {
    withLocalStorage(blockedStorage, () => {
        const module = fakeModule();
        const governor = startGovernor(module);

        assert.equal(governor.targetFps, 60);
        assert.equal(governor.governorEnabled, true);
        assert.deepEqual(module.calls, [['set_target_fps', 60], ['set_quality_governor', 1]]);

        // Persisting is best-effort: the setter still applies for this page load.
        assert.equal(governor.setTargetFps(30), 30);
        assert.equal(governor.setQualityGovernorEnabled(false), false);
        assert.deepEqual(module.calls.slice(2), [['set_target_fps', 30], ['set_quality_governor', 0]]);
    });
});

test('a storage whose getItem/setItem throw is tolerated the same way', () => {
    const broken = {
        getItem() { throw new Error('quota'); },
        setItem() { throw new Error('quota'); },
    };
    withLocalStorage(broken, () => {
        const governor = startGovernor(fakeModule());
        assert.equal(governor.targetFps, 60);
        assert.equal(governor.setTargetFps(50), 50);
    });
});

test('the setters persist what they apply, and reject nonsense back to the default', () => {
    const storage = fakeStorage();
    withLocalStorage(storage, () => {
        const module = fakeModule();
        const governor = startGovernor(module);

        assert.equal(governor.setTargetFps('90'), 90);
        assert.equal(storage.map.get('targetFps'), '90');

        assert.equal(governor.setTargetFps('not a number'), 60, 'an invalid fps falls back to 60');

        assert.equal(governor.setQualityGovernorEnabled(false), false);
        assert.equal(storage.map.get('qualityGovernor'), '0');
        assert.equal(governor.setQualityGovernorEnabled(true), true);
        assert.equal(storage.map.get('qualityGovernor'), '1');
    });
});

test('getQualityTier reads the engine', () => {
    withLocalStorage(fakeStorage(), () => {
        const governor = startGovernor(fakeModule({ tier: 2 }));
        assert.equal(governor.getQualityTier(), 2);
    });
});

// ---- fps governor: the tier notifications ---------------------------------

test('render-scale and blur-cap notifications reach the controller through the bus', () => {
    withLocalStorage(fakeStorage(), () => {
        /** @type {number[]} */
        const scales = [];
        const governor = startGovernor(fakeModule({ renderScale: 1, blurCap: -1 }), {
            onRenderScaleChange: (scale) => scales.push(scale),
        });
        assert.equal(governor.getRenderScale(), 1, 'seeded from the engine at setup');
        assert.equal(governor.getBlurCap(), -1);

        globalThis.pmOnGovernorRenderScaleChange(0.75);
        globalThis.pmOnGovernorBlurCapChange(2);

        assert.deepEqual(scales, [0.75]);
        assert.equal(governor.getRenderScale(), 0.75);
        assert.equal(governor.getBlurCap(), 2);
    });
});

test('setup writes nothing to the page apart from the engine hooks it listens on', () => {
    withLocalStorage(fakeStorage(), () => {
        const before = new Set(Object.getOwnPropertyNames(globalThis));
        const governor = startGovernor(fakeModule());
        const added = Object.getOwnPropertyNames(globalThis).filter((name) => !before.has(name));
        assert.deepEqual(added.sort(), ['pmOnGovernorBlurCapChange', 'pmOnGovernorRenderScaleChange']);

        for (const name of ['pmSetTargetFps', 'pmSetQualityGovernorEnabled', 'pmGetQualityTier',
            'pmGetGovernorRenderScale', 'pmGetGovernorBlurCap']) {
            assert.equal(name in globalThis, false, `${name} belongs to the legacy shim, not this module`);
        }

        governor.dispose();
        const leftover = Object.getOwnPropertyNames(globalThis).filter((name) => !before.has(name));
        assert.deepEqual(leftover, [], 'disposing removes every hook it added');
    });
});

test('dispose stops the notifications and is safe to repeat', () => {
    withLocalStorage(fakeStorage(), () => {
        /** @type {number[]} */
        const scales = [];
        const governor = startGovernor(fakeModule(), { onRenderScaleChange: (scale) => scales.push(scale) });
        governor.dispose();
        governor.dispose();

        assert.equal(countWasmCallbackSubscribers('pmOnGovernorRenderScaleChange'), 0);
        assert.equal('pmOnGovernorRenderScaleChange' in globalThis, false);
        assert.deepEqual(scales, []);
    });
});

test('setting up the same module again replaces the old subscriptions', () => {
    withLocalStorage(fakeStorage(), () => {
        const module = fakeModule();
        /** @type {string[]} */
        const heard = [];
        startGovernor(module, { onRenderScaleChange: () => heard.push('first') });
        startGovernor(module, { onRenderScaleChange: () => heard.push('second') });
        assert.equal(countWasmCallbackSubscribers('pmOnGovernorRenderScaleChange'), 1);

        globalThis.pmOnGovernorRenderScaleChange(0.5);
        assert.deepEqual(heard, ['second'], 'a retried init must not leave the first controller listening');
    });
});

test('two contexts: disposing one governor leaves the other hearing the engine', () => {
    withLocalStorage(fakeStorage(), () => {
        /** @type {number[]} */
        const heardA = [];
        /** @type {number[]} */
        const heardB = [];
        const a = startGovernor(fakeModule(), { onRenderScaleChange: (scale) => heardA.push(scale) });
        const b = startGovernor(fakeModule(), { onRenderScaleChange: (scale) => heardB.push(scale) });

        globalThis.pmOnGovernorRenderScaleChange(0.75);
        assert.deepEqual([heardA, heardB], [[0.75], [0.75]]);

        a.dispose();
        assert.equal(typeof globalThis.pmOnGovernorRenderScaleChange, 'function', 'B still needs the hook');
        globalThis.pmOnGovernorRenderScaleChange(0.5);
        assert.deepEqual([heardA, heardB], [[0.75], [0.75, 0.5]]);
        assert.equal(b.getRenderScale(), 0.5);
        assert.equal(a.getRenderScale(), 0.75, 'A stopped tracking when it was disposed');
    });
});

// ---- mesh quality ---------------------------------------------------------------

test('mesh quality: query beats storage, and the grid reaches the engine', () => {
    withLocalStorage(fakeStorage({ meshQuality: 'high' }), () => {
        const module = fakeModule();
        const result = setupMeshQuality(module, { params: params('?meshQuality=low') });
        assert.equal(result.quality, 'low');
        assert.deepEqual(module.calls, [['set_mesh', 64, 48]]);

        const fromStorage = setupMeshQuality(fakeModule(), { params: params() });
        assert.equal(fromStorage.quality, 'high');
    });
});

test('mesh quality: the setter persists and applies, and nothing lands on window', () => {
    const storage = fakeStorage();
    withLocalStorage(storage, () => {
        const module = fakeModule();
        const meshQuality = setupMeshQuality(module, { params: params('?meshQuality=high') });
        assert.equal('pmSetMeshQuality' in globalThis, false, 'the legacy shim owns that name');

        assert.equal(meshQuality.setQuality('low'), 'low');
        assert.equal(storage.map.get('meshQuality'), 'low');
        assert.deepEqual(module.calls.at(-1), ['set_mesh', 64, 48]);
    });
});

test('mesh quality: a page whose localStorage throws still gets its mesh', () => {
    withLocalStorage(blockedStorage, () => {
        const module = fakeModule();
        const meshQuality = setupMeshQuality(module, { params: params('?meshQuality=high') });
        assert.equal(meshQuality.quality, 'high');
        assert.equal(meshQuality.setQuality('low'), 'low', 'the choice applies even though it cannot persist');
        assert.deepEqual(module.calls, [['set_mesh', 80, 60], ['set_mesh', 64, 48]]);
    });
});
