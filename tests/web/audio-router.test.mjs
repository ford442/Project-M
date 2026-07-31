// Unit tests for html/projectm-audio-router.js.
// Run with: node --test tests/web/audio-router.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AudioSourceRouter,
    AUDIO_SOURCE_NONE,
    AUDIO_SOURCE_WORKLET,
    AUDIO_SOURCE_ELEMENT,
    AUDIO_SOURCE_EXTERNAL,
    AUDIO_SOURCE_NAMES,
} from '../../html/projectm-audio-router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a minimal window-like object that records dispatched events. */
function fakeWindow() {
    const dispatched = [];
    return {
        dispatched,
        dispatchEvent(event) {
            dispatched.push({ type: event.type, detail: event.detail });
        },
    };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('AUDIO_SOURCE_NAMES includes all four source names', () => {
    assert.ok(AUDIO_SOURCE_NAMES.includes('none'));
    assert.ok(AUDIO_SOURCE_NAMES.includes('worklet'));
    assert.ok(AUDIO_SOURCE_NAMES.includes('element'));
    assert.ok(AUDIO_SOURCE_NAMES.includes('external'));
    assert.equal(AUDIO_SOURCE_NAMES.length, 4);
});

test('exported source-name constants match their string values', () => {
    assert.equal(AUDIO_SOURCE_NONE, 'none');
    assert.equal(AUDIO_SOURCE_WORKLET, 'worklet');
    assert.equal(AUDIO_SOURCE_ELEMENT, 'element');
    assert.equal(AUDIO_SOURCE_EXTERNAL, 'external');
});

// ---------------------------------------------------------------------------
// Construction / initial state
// ---------------------------------------------------------------------------

test('AudioSourceRouter starts with activeSource === "none"', () => {
    const router = new AudioSourceRouter();
    assert.equal(router.activeSource, 'none');
});

test('AudioSourceRouter accepts a windowRef option', () => {
    const win = fakeWindow();
    const router = new AudioSourceRouter({ windowRef: win });
    router.activate('external');
    assert.equal(win.dispatched.length, 1, 'event should be dispatched on the provided window');
});

test('AudioSourceRouter works without a windowRef (null/missing)', () => {
    const router = new AudioSourceRouter({ windowRef: null });
    assert.doesNotThrow(() => router.activate('external'));
    assert.equal(router.activeSource, 'external');
});

// ---------------------------------------------------------------------------
// activate()
// ---------------------------------------------------------------------------

test('activate() changes the active source', () => {
    const router = new AudioSourceRouter({ windowRef: null });
    router.activate('external');
    assert.equal(router.activeSource, 'external');
    router.activate('element');
    assert.equal(router.activeSource, 'element');
    router.activate('worklet');
    assert.equal(router.activeSource, 'worklet');
    router.activate('none');
    assert.equal(router.activeSource, 'none');
});

test('activate() returns true when the source changes', () => {
    const router = new AudioSourceRouter({ windowRef: null });
    assert.equal(router.activate('external'), true);
    assert.equal(router.activate('element'), true);
});

test('activate() returns false and does not emit when the source is unchanged', () => {
    const win = fakeWindow();
    const router = new AudioSourceRouter({ windowRef: win });
    router.activate('external');
    win.dispatched.length = 0; // clear

    const changed = router.activate('external');
    assert.equal(changed, false);
    assert.equal(win.dispatched.length, 0, 'no event for a same-source call');
});

test('activate() with an unknown source name warns and returns false', () => {
    const router = new AudioSourceRouter({ windowRef: null });
    const result = router.activate(/** @type {any} */ ('unknown'));
    assert.equal(result, false);
    assert.equal(router.activeSource, 'none', 'active source must not change on invalid input');
});

// ---------------------------------------------------------------------------
// pm-audio-source event
// ---------------------------------------------------------------------------

test('activate() dispatches pm-audio-source event with the new source in detail', () => {
    const win = fakeWindow();
    const router = new AudioSourceRouter({ windowRef: win });

    router.activate('external');
    assert.equal(win.dispatched.length, 1);
    assert.equal(win.dispatched[0].type, 'pm-audio-source');
    assert.deepEqual(win.dispatched[0].detail, { source: 'external' });
});

test('activate() emits an event for every distinct source change', () => {
    const win = fakeWindow();
    const router = new AudioSourceRouter({ windowRef: win });

    router.activate('worklet');
    router.activate('element');
    router.activate('external');
    router.activate('none');

    assert.equal(win.dispatched.length, 4);
    assert.deepEqual(
        win.dispatched.map((e) => e.detail.source),
        ['worklet', 'element', 'external', 'none']
    );
});

// ---------------------------------------------------------------------------
// shouldFeedExternal()
// ---------------------------------------------------------------------------

test('shouldFeedExternal() returns true only when activeSource is "external"', () => {
    const router = new AudioSourceRouter({ windowRef: null });

    assert.equal(router.shouldFeedExternal(), false, 'none → false');
    router.activate('worklet');
    assert.equal(router.shouldFeedExternal(), false, 'worklet → false');
    router.activate('element');
    assert.equal(router.shouldFeedExternal(), false, 'element → false');
    router.activate('external');
    assert.equal(router.shouldFeedExternal(), true, 'external → true');
    router.activate('none');
    assert.equal(router.shouldFeedExternal(), false, 'back to none → false');
});

// ---------------------------------------------------------------------------
// Exclusive-mode: external vs element
// ---------------------------------------------------------------------------

test('switching from element to external sets shouldFeedExternal to true', () => {
    const router = new AudioSourceRouter({ windowRef: null });
    router.activate('element');
    assert.equal(router.shouldFeedExternal(), false);
    router.activate('external');
    assert.equal(router.shouldFeedExternal(), true);
});

test('switching from external to element stops external feed', () => {
    const router = new AudioSourceRouter({ windowRef: null });
    router.activate('external');
    assert.equal(router.shouldFeedExternal(), true);
    router.activate('element');
    assert.equal(router.shouldFeedExternal(), false);
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

test('reset() sets activeSource back to "none" without emitting an event', () => {
    const win = fakeWindow();
    const router = new AudioSourceRouter({ windowRef: win });
    router.activate('external');
    win.dispatched.length = 0; // clear after the activate event

    router.reset();
    assert.equal(router.activeSource, 'none');
    assert.equal(win.dispatched.length, 0, 'reset must not dispatch an event');
});

// ---------------------------------------------------------------------------
// setWindowRef()
// ---------------------------------------------------------------------------

test('setWindowRef() replaces the event target after construction', () => {
    const win1 = fakeWindow();
    const win2 = fakeWindow();
    const router = new AudioSourceRouter({ windowRef: win1 });

    router.setWindowRef(win2);
    router.activate('external');

    assert.equal(win1.dispatched.length, 0, 'old window must not receive events after setWindowRef');
    assert.equal(win2.dispatched.length, 1, 'new window must receive the event');
});
