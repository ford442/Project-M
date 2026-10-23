// flac-player/boot.js
//
// Boots the in-repo FLAC player shell (flac-player/index.html) around the
// externally built, minified player bundle:
//   1. the Buffer polyfill the bundle needs (local copy, CDN fallback);
//   2. decode-guard.js, which repairs the FLAC headers the bundle's decoder
//      chokes on and clamps its AudioWorklet channel counts;
//   3. projectm-pcm-bridge.js, which taps the bundle's Web Audio graph and
//      posts PCM to the projectM host (only when the page is a feeder);
//   4. the bundle itself.
//
// ?rev= (FLAC_PLAYER_SHELL_REV in html/projectm-audio-player.js) versions the
// shell's own modules, which are not content-hashed like the bundle.

/** The content-hashed player bundle this shell loads. */
export const FLAC_PLAYER_BUNDLE = 'bundle.1be0dff2a33a879aefd0.js';

/**
 * @typedef {Window & typeof globalThis & {
 *   Buffer?: unknown,
 *   __projectMFlacDecodeGuard?: unknown,
 *   __projectMPcmBridge?: unknown,
 * }} FlacPlayerWindow
 */

/** @param {Document} documentRef @param {string} message */
function showBootError(documentRef, message) {
    const el = documentRef.getElementById('pm-flac-boot-error');
    if (el) {
        el.textContent = message;
        el.style.display = 'block';
    }
    console.error('[projectM FLAC player]', message);
}

// Held in variables so tsc does not try to compile the vendored, minified
// bundle (or resolve a CDN URL) as part of this program.
const LOCAL_BUFFER_URL = './vendor/buffer.bundle.mjs';
const CDN_BUFFER_URL = 'https://esm.sh/buffer@6.0.3';

/** @returns {Promise<unknown>} */
async function loadBufferCtor() {
    try {
        const mod = /** @type {{ Buffer?: unknown, default?: { Buffer?: unknown } }} */ (
            await import(LOCAL_BUFFER_URL)
        );
        return mod.Buffer || mod.default?.Buffer;
    } catch (localError) {
        console.warn('[projectM FLAC player] local buffer bundle missing, using CDN fallback:', localError);
        const mod = /** @type {{ Buffer?: unknown, default?: unknown }} */ (await import(CDN_BUFFER_URL));
        return mod.Buffer || mod.default;
    }
}

/**
 * @param {Document} documentRef
 * @param {object} [options]
 * @param {FlacPlayerWindow} [options.windowRef]
 * @returns {Promise<void>}
 */
export async function bootFlacPlayer(documentRef, { windowRef = /** @type {FlacPlayerWindow} */ (window) } = {}) {
    const rev = new URLSearchParams(windowRef.location.search).get('rev');
    const revQuery = rev ? `?rev=${encodeURIComponent(rev)}` : '';
    try {
        const Buffer = await loadBufferCtor();
        if (!Buffer) throw new Error('Buffer polyfill failed to load');
        /** @type {FlacPlayerWindow} */ (globalThis).Buffer = Buffer;
        windowRef.Buffer = Buffer;

        try {
            const guard = /** @type {typeof import('./decode-guard.js')} */ (
                await import(`./decode-guard.js${revQuery}`)
            );
            windowRef.__projectMFlacDecodeGuard = guard.installFlacPlayerDecodeGuard(windowRef);
        } catch (guardError) {
            console.warn('[projectM FLAC player] decode guard unavailable:', guardError);
        }

        /** @type {typeof import('./projectm-pcm-bridge.js') | null} */
        let bridge = null;
        try {
            bridge = /** @type {typeof import('./projectm-pcm-bridge.js')} */ (
                await import(`./projectm-pcm-bridge.js${revQuery}`)
            );
        } catch (bridgeError) {
            console.warn('[projectM FLAC player] local PCM bridge missing:', bridgeError);
        }
        if (bridge?.installProjectMPcmBridge) {
            windowRef.__projectMPcmBridge = bridge.installProjectMPcmBridge();
        } else if (windowRef.opener || (windowRef.parent && windowRef.parent !== windowRef)) {
            console.warn('[projectM FLAC player] PCM bridge unavailable — audio may not reach projectM host');
        }

        const bundle = documentRef.createElement('script');
        bundle.defer = true;
        bundle.src = FLAC_PLAYER_BUNDLE;
        bundle.onerror = () => showBootError(documentRef, `Failed to load FLAC player bundle (${FLAC_PLAYER_BUNDLE}).`);
        documentRef.head.appendChild(bundle);
    } catch (error) {
        showBootError(
            documentRef,
            `FLAC player failed to start: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
