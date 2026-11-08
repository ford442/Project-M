// Canvas sizing (html/context/render.js): the device-pixel content box, and
// not touching a backing store that is already the right size (assigning
// width/height clears the drawing buffer).

import test from 'node:test';
import assert from 'node:assert/strict';

import { syncCanvasSize, followContainerSize, devicePixelSizeOf, setBackingStore } from '../../html/context/render.js';

function countingCanvas() {
    let width = 300;
    let height = 150;
    const canvas = {
        assignments: 0,
        style: { width: '', height: '' },
        get width() {
            return width;
        },
        set width(value) {
            canvas.assignments++;
            width = value;
        },
        get height() {
            return height;
        },
        set height(value) {
            canvas.assignments++;
            height = value;
        },
    };
    return canvas;
}

function mainTransport() {
    const resizes = [];
    return {
        topology: 'main',
        resizes,
        resize: (w, h) => resizes.push([w, h]),
        supports: () => false,
        callVoid: () => {},
    };
}

const container = (width, height) => ({ getBoundingClientRect: () => ({ width, height }) });

test('syncCanvasSize assigns the backing store only when it changes', () => {
    const canvas = countingCanvas();
    const transport = mainTransport();
    const options = { transport, container: container(400, 300), mainCanvas: canvas, devicePixelRatio: 2 };
    syncCanvasSize(options);
    assert.equal(canvas.width, 800);
    assert.equal(canvas.height, 600);
    assert.equal(canvas.assignments, 2);
    syncCanvasSize(options);
    syncCanvasSize(options);
    assert.equal(canvas.assignments, 2, 'an unchanged size must not reassign width/height');
});

test('syncCanvasSize prefers the observed device-pixel box over rect × dpr', () => {
    const canvas = countingCanvas();
    const transport = mainTransport();
    // 333.5 css px at dpr 1.5 rounds to 500 (500.25), but the browser snapped the box to 501.
    syncCanvasSize({
        transport,
        container: container(333.5, 200),
        mainCanvas: canvas,
        devicePixelRatio: 1.5,
        devicePixelSize: { width: 501, height: 300 },
    });
    assert.deepEqual([canvas.width, canvas.height], [501, 300]);
    assert.equal(canvas.style.width, `${501 / 1.5}px`);
    assert.deepEqual(transport.resizes, [[501, 300]]);
});

for (const dpr of [1, 2, 3]) {
    test(`syncCanvasSize at dpr ${dpr}: backing store equals the device-pixel box`, () => {
        const canvas = countingCanvas();
        const box = { width: 640 * dpr, height: 360 * dpr };
        syncCanvasSize({
            transport: mainTransport(),
            container: container(640, 360),
            mainCanvas: canvas,
            devicePixelRatio: dpr,
            devicePixelSize: box,
        });
        assert.deepEqual([canvas.width, canvas.height], [box.width, box.height]);
    });
}

test('syncCanvasSize scales the device-pixel box by the render scale', () => {
    const canvas = countingCanvas();
    syncCanvasSize({
        transport: mainTransport(),
        container: container(100, 100),
        mainCanvas: canvas,
        renderScale: 0.5,
        devicePixelSize: { width: 800, height: 600 },
    });
    assert.deepEqual([canvas.width, canvas.height], [400, 300]);
});

test('setBackingStore reports whether it assigned', () => {
    const canvas = countingCanvas();
    assert.equal(setBackingStore(/** @type {any} */ (canvas), 300, 150), false);
    assert.equal(setBackingStore(/** @type {any} */ (canvas), 10, 10), true);
});

test('devicePixelSizeOf reads devicePixelContentBoxSize, null without it', () => {
    assert.deepEqual(
        devicePixelSizeOf(/** @type {any} */ ({ devicePixelContentBoxSize: [{ inlineSize: 10, blockSize: 20 }] })),
        { width: 10, height: 20 }
    );
    assert.equal(devicePixelSizeOf(/** @type {any} */ ({ contentRect: {} })), null);
    assert.equal(devicePixelSizeOf(undefined), null);
});

function fakeObserverClass({ rejectDeviceBox = false } = {}) {
    const instances = [];
    class FakeResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.observed = [];
            this.disconnected = false;
            instances.push(this);
        }
        observe(target, options) {
            if (rejectDeviceBox && options?.box === 'device-pixel-content-box') {
                throw new TypeError('unsupported box');
            }
            this.observed.push({ target, options });
        }
        disconnect() {
            this.disconnected = true;
        }
    }
    return { FakeResizeObserver, instances };
}

test('followContainerSize observes the device-pixel-content-box and passes it on', () => {
    const { FakeResizeObserver, instances } = fakeObserverClass();
    const calls = [];
    const target = {};
    const follow = followContainerSize({
        container: target,
        windowRef: { ResizeObserver: FakeResizeObserver },
        onResize: (size) => calls.push(size),
    });
    assert.ok(follow);
    assert.equal(instances.length, 1);
    assert.deepEqual(instances[0].observed, [{ target, options: { box: 'device-pixel-content-box' } }]);
    instances[0].callback([{ devicePixelContentBoxSize: [{ inlineSize: 1280, blockSize: 720 }] }]);
    assert.deepEqual(calls, [{ width: 1280, height: 720 }]);
    follow.dispose();
    assert.equal(instances[0].disconnected, true);
});

test('followContainerSize falls back to the content box where the device box is unsupported', () => {
    const { FakeResizeObserver, instances } = fakeObserverClass({ rejectDeviceBox: true });
    const calls = [];
    followContainerSize({
        container: {},
        windowRef: { ResizeObserver: FakeResizeObserver },
        onResize: (size) => calls.push(size),
    });
    assert.equal(instances[0].observed.length, 1);
    assert.equal(instances[0].observed[0].options, undefined);
    instances[0].callback([{ contentRect: { width: 1, height: 1 } }]);
    assert.deepEqual(calls, [null]);
});

test('followContainerSize re-measures (null) on a devicePixelRatio change', () => {
    const { FakeResizeObserver } = fakeObserverClass();
    /** @type {Array<() => void>} */
    const listeners = [];
    const win = {
        devicePixelRatio: 1,
        ResizeObserver: FakeResizeObserver,
        matchMedia: () => ({
            addEventListener: (_type, listener) => listeners.push(listener),
            removeEventListener: () => {},
        }),
    };
    const calls = [];
    followContainerSize({ container: {}, windowRef: win, onResize: (size) => calls.push(size) });
    win.devicePixelRatio = 2;
    listeners[0]();
    assert.deepEqual(calls, [null]);
});
