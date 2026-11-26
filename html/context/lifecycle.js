// context/lifecycle.js
//
// What a ProjectMContext does when the page is hidden, frozen or restored from
// the back/forward cache, and the Screen Wake Lock while audio plays.
//
//   hidden / freeze  the engine's requestAnimationFrame loop is paused
//                    (set_render_loop_paused), so a background tab spends no
//                    GPU time. Audio keeps running: the worklet keeps writing
//                    the PCM ring, which is a ring, so it simply wraps.
//   visible / pageshow / resume
//                    the loop is resumed — only if this module paused it, so a
//                    harness that paused it to drive render_frame() itself keeps
//                    control.
//
// The quality governor needs no reset: it scores each frame's own work time
// (UpdateQualityGovernor() in src/wasm/WasmPerfGovernor.cpp is fed
// `now - frameStart` inside renderLoop()), not the gap between frames, so a
// hidden stretch is never read as one slow frame.
//
// In the worker topology the loop runs in the worker, where the browser
// already throttles an OffscreenCanvas's requestAnimationFrame when the page
// is hidden; the pause is skipped when the transport does not offer it.

/**
 * @typedef {import('@projectm/types/transport').RenderTransport} RenderTransport
 * @typedef {{ release(): Promise<void>, addEventListener?: (type: string, listener: () => void) => void }} WakeLockSentinelLike
 */

/** How often the wake lock follows the AudioContext's state, ms. */
const WAKE_LOCK_POLL_MS = 2000;

/**
 * @param {object} params
 * @param {{ destroyed: boolean }} params.context
 * @param {RenderTransport} params.transport
 * @param {Document | undefined | null} params.documentRef
 * @param {(Window & typeof globalThis) | undefined | null} params.windowRef
 * @param {boolean | undefined} params.wakeLock Defaults to true.
 * @param {() => AudioContext | null} [params.getAudioContext]
 * @param {{ wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } } | undefined} [params.navigatorRef]
 * @returns {() => void} Removes every listener and releases the wake lock.
 */
export function watchPageLifecycle({
    context,
    transport,
    documentRef,
    windowRef,
    wakeLock = true,
    getAudioContext = () => globalThis.projectMAudioContext_Global_Cpp ?? null,
    navigatorRef = /** @type {any} */ (globalThis.navigator),
}) {
    if (!documentRef?.addEventListener) {
        return () => {};
    }
    const doc = documentRef;
    const canPause = transport.supports('setRenderLoopPaused');
    let pausedByUs = false;
    let disposed = false;

    const isHidden = () => doc.visibilityState === 'hidden';

    const pause = () => {
        if (!canPause || pausedByUs || context.destroyed) return;
        try {
            transport.callVoid('setRenderLoopPaused', true);
            pausedByUs = true;
        } catch (error) {
            console.warn('[ProjectMContext] could not pause the render loop:', error);
        }
    };
    const resume = () => {
        if (!pausedByUs || context.destroyed) return;
        pausedByUs = false;
        try {
            transport.callVoid('setRenderLoopPaused', false);
        } catch (error) {
            console.warn('[ProjectMContext] could not resume the render loop:', error);
        }
    };

    // ---- Screen Wake Lock: held while visible and the AudioContext runs.
    /** @type {WakeLockSentinelLike | null} */
    let sentinel = null;
    let requesting = false;
    const wantLock = () => !disposed && !isHidden() && getAudioContext()?.state === 'running';
    const syncWakeLock = () => {
        if (!wakeLock || !navigatorRef?.wakeLock) return;
        if (wantLock()) {
            if (sentinel || requesting) return;
            requesting = true;
            navigatorRef.wakeLock.request('screen').then(
                (lock) => {
                    requesting = false;
                    if (!wantLock()) {
                        void lock.release().catch(() => {});
                        return;
                    }
                    sentinel = lock;
                    // The browser drops it on hide; forget it so a show asks again.
                    lock.addEventListener?.('release', () => {
                        if (sentinel === lock) sentinel = null;
                    });
                },
                () => {
                    // Refused (no permission, battery saver, not focused): try on the next sync.
                    requesting = false;
                }
            );
        } else if (sentinel) {
            const lock = sentinel;
            sentinel = null;
            void lock.release().catch(() => {});
        }
    };

    const onVisibility = () => {
        if (isHidden()) pause();
        else resume();
        syncWakeLock();
    };
    const onFreeze = () => pause();
    const onResume = () => {
        if (!isHidden()) resume();
        syncWakeLock();
    };
    /** @param {Event} event */
    const onPageShow = (event) => {
        // Restored from the back/forward cache: the page never saw a load.
        if (/** @type {PageTransitionEvent} */ (event).persisted) onResume();
    };

    doc.addEventListener('visibilitychange', onVisibility);
    doc.addEventListener('freeze', onFreeze);
    doc.addEventListener('resume', onResume);
    windowRef?.addEventListener?.('pageshow', onPageShow);
    const timer = wakeLock && navigatorRef?.wakeLock ? setInterval(syncWakeLock, WAKE_LOCK_POLL_MS) : null;
    if (isHidden()) pause();
    syncWakeLock();

    return () => {
        if (disposed) return;
        disposed = true;
        doc.removeEventListener('visibilitychange', onVisibility);
        doc.removeEventListener('freeze', onFreeze);
        doc.removeEventListener('resume', onResume);
        windowRef?.removeEventListener?.('pageshow', onPageShow);
        if (timer !== null) clearInterval(timer);
        // The flag is the Module's, not this host's: a sibling context sharing
        // the Module must not inherit a pause this one made.
        if (pausedByUs) {
            pausedByUs = false;
            try {
                transport.callVoid('setRenderLoopPaused', false);
            } catch {
                // The engine is already gone.
            }
        }
        syncWakeLock();
    };
}
