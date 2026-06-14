// projectm-audio-bootstrap.js
//
// Unified Web Audio bootstrap: resumes the shared AudioContext created by
// `js_initialize_worklet_system_once` (see projectM_emscripten.cpp) on the first user
// gesture, and shows a "Tap to enable audio" overlay while the context is `suspended`
// (the default on Safari/iOS and other strict autoplay-policy browsers).
//
// See docs/EMSCRIPTEN.md for details. Hosts that never create the shared AudioContext
// (external-PCM-only mode, e.g. MOD/FLAC players) are unaffected: setupAudioUnlock() is
// a no-op when `window.projectMAudioContext_Global_Cpp` does not exist.

const STYLE_ID = 'pm-audio-unlock-style';
const OVERLAY_ID = 'pm-audio-unlock';

const STYLE_CSS = `
#${OVERLAY_ID} {
  position: fixed;
  inset: 0;
  z-index: 99998;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  font-family: "Lucida Console", "Courier New", monospace;
  cursor: pointer;
}
#${OVERLAY_ID}.visible {
  display: flex;
}
#${OVERLAY_ID} .pm-audio-unlock-box {
  padding: 18px 30px;
  background: linear-gradient(160deg, #1b2436, #0d1117);
  border: 1px solid #2a3f5f;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 24px rgba(61, 213, 243, 0.15);
  color: #e2e8f0;
  text-align: center;
}
#${OVERLAY_ID} .pm-audio-unlock-title {
  margin: 0 0 4px;
  font-size: 16px;
  color: #93c5fd;
}
#${OVERLAY_ID} .pm-audio-unlock-message {
  margin: 0;
  font-size: 13px;
  color: #94a3b8;
}
`;

let overlayEl = null;

function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
}

function ensureOverlay() {
    if (overlayEl) {
        return overlayEl;
    }

    injectStyles();

    overlayEl = document.getElementById(OVERLAY_ID);
    if (overlayEl) {
        return overlayEl;
    }

    overlayEl = document.createElement('div');
    overlayEl.id = OVERLAY_ID;
    overlayEl.innerHTML = `
        <div class="pm-audio-unlock-box">
            <p class="pm-audio-unlock-title">Tap to enable audio</p>
            <p class="pm-audio-unlock-message">Your browser is blocking audio until you interact with the page.</p>
        </div>
    `;
    document.body.appendChild(overlayEl);

    return overlayEl;
}

function showOverlay() {
    ensureOverlay().classList.add('visible');
}

function hideOverlay() {
    if (overlayEl) {
        overlayEl.classList.remove('visible');
    }
}

/**
 * Returns the shared AudioContext created by `js_initialize_worklet_system_once`
 * (projectM_emscripten.cpp), or null if it has not been created (e.g. external-PCM-only
 * mode, which never creates an AudioContext).
 * @returns {AudioContext|null}
 */
export function getAudioContext() {
    return window.projectMAudioContext_Global_Cpp || null;
}

/**
 * Resumes the shared AudioContext if it exists and is suspended. Safe to call from any
 * user-gesture handler (click, keydown, touch, etc.).
 * @returns {Promise<boolean>} true if the context exists and is (now) running.
 */
export async function ensureAudioRunning() {
    const ctx = getAudioContext();
    if (!ctx) {
        return false;
    }

    if (ctx.state === 'suspended') {
        try {
            await ctx.resume();
        } catch (err) {
            console.warn('[projectM] AudioContext.resume() failed:', err);
        }
    }

    if (ctx.state === 'running') {
        hideOverlay();
        return true;
    }

    return false;
}

/**
 * Shows a "Tap to enable audio" overlay if the shared AudioContext exists and is
 * suspended, and registers gesture listeners that resume it on the first click, tap, or
 * key press anywhere on the page. No-op if no AudioContext has been created
 * (external-PCM-only mode) or if it is already running.
 *
 * Call once after `checkInit(Module)` succeeds.
 */
export function setupAudioUnlock() {
    const ctx = getAudioContext();
    if (!ctx || ctx.state !== 'suspended') {
        return;
    }

    showOverlay();

    const onGesture = () => {
        ensureAudioRunning().then((running) => {
            if (running) {
                document.removeEventListener('pointerdown', onGesture);
                document.removeEventListener('keydown', onGesture);
            }
        });
    };

    document.addEventListener('pointerdown', onGesture);
    document.addEventListener('keydown', onGesture);

    ctx.addEventListener('statechange', () => {
        if (ctx.state === 'running') {
            hideOverlay();
        }
    });
}
