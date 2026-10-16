// Prefer same-origin players when co-deployed with projectM; libopenmpt MOD shell
// remains on test.1ink.us until xm-player assets are vendored in-repo.
export const FLAC_PLAYER_BASE_URL = './flac-player/';
/** Same-origin popup the panel audio button opens for tab / system capture. */
export const AUDIO_CAPTURE_PAGE_URL = './audio-capture.html';
const AUDIO_CAPTURE_WINDOW_FEATURES = 'popup,width=440,height=340';
const AUDIO_CAPTURE_WINDOW_NAME = 'projectm-audio-capture';
// Bump when html/flac-player/ changes. The shell's index.html is not
// content-hashed, so without a new URL a browser can keep serving a cached
// copy that loads an old bundle (e.g. bundle.d896f*.js, which needs a global
// Buffer) or an old decode-guard.js. index.html forwards it to its own imports.
export const FLAC_PLAYER_SHELL_REV = '3';
export const MOD_PLAYER_BASE_URL = 'https://test.1ink.us/xm-player/';

/**
 * One selectable external audio player.
 *
 * @typedef {object} AudioPlayerSource
 * @property {string} id
 * @property {string} label
 * @property {string} [sectionId] Element id of the inline section (section controller).
 * @property {string} [storageKey] localStorage key holding a custom URL (popup controller).
 * @property {string} [elementId] Element whose text holds a custom URL (popup controller).
 * @property {string} [defaultUrl]
 * @property {string} [target] window.open target name.
 * @property {string} [frameSelector] iframe selector inside an inline section.
 * @property {'popup'} [presentation] `popup` opens a sized window even when the
 *   URL is same-origin. Tab/system capture needs that: an iframe would cover
 *   the visualizer, and the share picker has to stay up while the user
 *   switches to the tab they shared.
 * @property {string} [windowFeatures] `window.open` features for `presentation: 'popup'`.
 * @property {() => string | null | undefined} [resolveUrl]
 */

/**
 * @typedef {object} AudioPlayerController
 * @property {(sourceId: string, options?: { trackUrl?: string }) => void} showAudioPlayer
 * @property {() => void} cycleAudioPlayer
 * @property {() => void} closeAudioPlayer
 * @property {() => void} dispose Release everything this controller opened: popup
 *   windows are closed and feeder iframes it created are removed. Idempotent, and
 *   it leaves the page's own inline player sections as they are.
 * @property {(trackUrl?: string) => void} [openFlacPlayer]
 * @property {(trackUrl?: string) => void} [openModPlayer]
 */

/** @type {AudioPlayerSource[]} */
const DEFAULT_AUDIO_SOURCES = [
    { id: 'none', label: 'Audio Player' },
    {
        id: 'flac',
        label: 'FLAC Player',
        sectionId: 'flacPlayerSection',
        frameSelector: '#flacFrame',
        target: 'flac-player',
        resolveUrl: resolveFlacPlayerUrl,
    },
    {
        id: 'mod',
        label: 'MOD Player',
        sectionId: 'modPlayerSection',
        frameSelector: '#modFrame',
        target: 'mod-player',
        resolveUrl: resolveModPlayerUrl,
    },
    captureAudioSource(),
];

/**
 * Resolve a player shell URL from DOM hidden element, localStorage, or default.
 * @param {string} elementId
 * @param {string} storageKey
 * @param {string} defaultUrl
 * @param {Document} [documentRef]
 * @returns {string}
 */
export function resolvePlayerUrl(elementId, storageKey, defaultUrl, documentRef) {
    const doc = documentRef ?? (typeof document !== 'undefined' ? document : null);
    const stored = localStorage.getItem(storageKey);
    if (stored) {
        return stored;
    }
    const fromDom = doc?.getElementById(elementId)?.textContent?.trim();
    if (fromDom) {
        try {
            return new URL(fromDom, window.location.href).href;
        } catch {
            return fromDom;
        }
    }
    try {
        return new URL(defaultUrl, window.location.href).href;
    } catch {
        return defaultUrl;
    }
}

export function resolveFlacPlayerUrl() {
    return resolvePlayerUrl('flacPlayerUrl', 'flacPlayerUrl', FLAC_PLAYER_BASE_URL);
}

export function resolveModPlayerUrl() {
    return resolvePlayerUrl('modPlayerUrl', 'modPlayerUrl', MOD_PLAYER_BASE_URL);
}

/**
 * Tab / system capture page. A popup, not an iframe: getDisplayMedia() runs
 * from that page's own Start click, and the window has to stay open.
 * @returns {AudioPlayerSource}
 */
export function captureAudioSource() {
    return {
        id: 'capture',
        label: 'Tab / System',
        target: AUDIO_CAPTURE_WINDOW_NAME,
        defaultUrl: AUDIO_CAPTURE_PAGE_URL,
        presentation: 'popup',
        windowFeatures: AUDIO_CAPTURE_WINDOW_FEATURES,
        resolveUrl() {
            try {
                const base = typeof globalThis.location?.href === 'string'
                    ? globalThis.location.href
                    : 'https://localhost/';
                return new URL(AUDIO_CAPTURE_PAGE_URL, base).href;
            } catch {
                return AUDIO_CAPTURE_PAGE_URL;
            }
        },
    };
}

/**
 * True when `url` is same-origin with the host page.
 * Cross-origin iframes are blocked by COEP: require-corp (033+ WASM hosts).
 * @param {string} url
 * @param {{ href?: string, origin?: string }} [locationRef]
 */
export function isSameOriginUrl(url, locationRef) {
    const loc = locationRef ?? (typeof globalThis !== 'undefined' ? globalThis.location : null);
    if (!url || !loc?.href) {
        return false;
    }
    try {
        const resolved = new URL(url, loc.href);
        const host = loc.origin || new URL(loc.href).origin;
        return resolved.origin === host;
    } catch {
        return false;
    }
}

/**
 * Same-origin iframe for FLAC/MOD shells so postMessage + BroadcastChannel
 * stay in the host COOP agent cluster. A separate tab of a path without matching
 * COOP headers cannot deliver PCM to the visualizer.
 * @param {string} frameId
 * @param {string} url
 * @param {Document} [documentRef]
 * @returns {HTMLIFrameElement | null}
 */
export function ensureSameOriginPlayerFrame(frameId, url, documentRef) {
    const doc = documentRef ?? (typeof document !== 'undefined' ? document : null);
    if (!doc?.body || !url) {
        return null;
    }
    let frame = /** @type {HTMLIFrameElement | null} */ (doc.getElementById(frameId));
    if (!frame) {
        frame = doc.createElement('iframe');
        frame.id = frameId;
        frame.title = 'projectM audio player';
        frame.setAttribute(
            'style',
            'position:fixed;right:8px;bottom:8px;width:360px;height:220px;border:1px solid #334;border-radius:8px;z-index:99990;background:#0b0f14;box-shadow:0 8px 24px rgba(0,0,0,0.45)'
        );
        frame.setAttribute('allow', 'autoplay');
        doc.body.appendChild(frame);
    }
    if (frame.getAttribute('src') !== url && frame.src !== url) {
        frame.src = url;
    }
    frame.style.display = 'block';
    return frame;
}

/**
 * Open a player URL for PCM feeding. Same-origin → iframe (COOP-safe);
 * cross-origin → new tab (no window features) so opener + postMessage work.
 * @param {string} url
 * @param {string} [target]
 * @param {Document} [documentRef]
 * @returns {Window | HTMLIFrameElement | null}
 */
export function openPlayerForPcmFeed(url, target = 'projectm-player', documentRef) {
    if (!url) {
        return null;
    }
    if (isSameOriginUrl(url)) {
        const frameId = `pm-player-frame-${String(target).replace(/[^\w-]+/g, '-')}`;
        return ensureSameOriginPlayerFrame(frameId, url, documentRef);
    }
    if (typeof globalThis.open === 'function') {
        // No features string → tab. Sized popups often break under COEP hosts.
        return globalThis.open(url, target);
    }
    return null;
}

// Signals an external audio player (MOD/FLAC) that it is being opened purely as
// a PCM feeder for projectM, so it can run in compact "audio-only" mode and skip
// its own standalone visualizer (e.g. the mod-player's WebGPU pattern/spectrum
// display) to save GPU budget for the projectM WASM renderer. The player is
// expected to detect `?projectm=1` (the host can't disable the remote player's
// canvas itself). Preserves any existing query string and returns the input
// unchanged if it can't be parsed as a URL.
/**
 * @param {string | null | undefined} url
 * @param {object} [options]
 * @param {string} [options.trackUrl] Optional track URL forwarded as `?url=`.
 * @returns {string | null | undefined} `url` with `?projectm=1` (and, for the
 *   FLAC player shell, `rev=`{@link FLAC_PLAYER_SHELL_REV}), or unchanged if it
 *   is falsy or not parseable.
 */
export function withProjectMAudioFlag(url, { trackUrl } = {}) {
    if (!url) return url;
    try {
        const base = typeof window !== 'undefined' && window.location?.href
            ? window.location.href
            : 'https://localhost/';
        const parsed = new URL(url, base);
        parsed.searchParams.set('projectm', '1');
        if (/\/flac-player\/(index\.html)?$/.test(parsed.pathname)) {
            parsed.searchParams.set('rev', FLAC_PLAYER_SHELL_REV);
        }
        if (trackUrl) {
            parsed.searchParams.set('url', trackUrl);
        }
        return parsed.toString();
    } catch (_) {
        return url;
    }
}

/**
 * @param {AudioPlayerSource} source
 * @param {object} [ids]
 * @param {string} [ids.statusId]
 * @param {string} [ids.buttonId]
 * @param {string} [ids.labelId]
 */
function defaultUpdateUi(source, {
    statusId = 'audio-player-status',
    buttonId = 'audioPlayerBtn',
    labelId = 'audioPlayerLabel'
} = {}) {
    const status = document.getElementById(statusId);
    const label = document.getElementById(labelId);
    const btn = /** @type {HTMLElement | null} */ (document.getElementById(buttonId));
    const text = source.id === 'none' ? 'Audio Player' : `Audio: ${source.label}`;

    if (status) status.textContent = text;
    if (label) label.textContent = text;
    if (btn) {
        btn.classList.toggle('engaged', source.id !== 'none');
        btn.style.borderColor = source.id === 'none' ? 'green' : 'yellow';
        btn.title = source.id === 'none'
            ? 'Audio Player - click to open FLAC, MOD, tab/system audio, or hide'
            : `${source.label} active - click to switch or hide`;
    }
}

/**
 * Release one player handle. A popup window is closed. A same-origin iframe
 * feeder is hidden so a later switch back re-opens it quickly, or removed
 * outright when `remove` is set (disposal: nothing may outlive the controller).
 *
 * @param {Window | HTMLIFrameElement | null | undefined} handle
 * @param {boolean} [remove]
 * @returns {boolean} Whether the handle is gone for good (closed or removed)
 *   and can be forgotten. A merely hidden feeder returns false: it stays
 *   reachable so `dispose()` can still remove it later.
 */
function releasePlayerHandle(handle, remove = false) {
    if (!handle) return true;
    if ('close' in handle && typeof handle.close === 'function' && 'closed' in handle) {
        if (!handle.closed) handle.close();
        return true;
    }
    if (remove && 'remove' in handle && typeof handle.remove === 'function') {
        handle.remove();
        return true;
    }
    if ('style' in handle && handle.style) {
        handle.style.display = 'none';
    }
    return false;
}

/**
 * Release every handle a controller owns and forget the ones that are gone.
 * Passing `exceptId` leaves that source's handle up (and tracked), so a second
 * click focuses an open window instead of tearing a share down.
 *
 * @param {Map<string, Window | HTMLIFrameElement>} handles
 * @param {{ exceptId?: string; remove?: boolean }} [options]
 */
function releasePlayerHandles(handles, { exceptId, remove = false } = {}) {
    for (const [id, handle] of handles) {
        if (id === exceptId) continue;
        if (releasePlayerHandle(handle, remove)) handles.delete(id);
    }
}

/**
 * Controller for hosts that embed the players as inline `.ext-player-section`
 * elements (panel2).
 *
 * @param {object} [options]
 * @param {AudioPlayerSource[]} [options.sources]
 * @param {string} [options.menuId] Menu element toggled alongside the sections.
 * @param {(source: AudioPlayerSource) => void} [options.updateUi]
 * @param {(url: string, target: string) => Window | HTMLIFrameElement | null} [options.openPopup]
 * @returns {AudioPlayerController}
 */
export function createSectionAudioPlayerController({
    sources = DEFAULT_AUDIO_SOURCES,
    menuId,
    updateUi = defaultUpdateUi,
    openPopup = (url, target) => openPlayerForPcmFeed(url, target),
} = {}) {
    let activeAudioSourceIndex = 0;
    /** @type {Map<string, Window | HTMLIFrameElement>} */
    const ownedPopups = new Map();

    function hideAllAudioPlayers() {
        const sections = /** @type {NodeListOf<HTMLElement>} */ (
            document.querySelectorAll('.ext-player-section')
        );
        sections.forEach((section) => {
            section.style.display = 'none';
        });
    }

    /**
     * @param {AudioPlayerSource} source
     * @returns {string}
     */
    function sourceUrl(source) {
        if (typeof source.resolveUrl === 'function') {
            return source.resolveUrl() || '';
        }
        return source.defaultUrl || '';
    }

    /**
     * @param {AudioPlayerSource} source
     * @param {string} url
     * @returns {Window | null}
     */
    function openOwnedPopup(source, url) {
        const target = source.target || `${source.id}-player`;
        const existing = ownedPopups.get(source.id);
        if (existing && 'closed' in existing && !existing.closed) {
            if ('focus' in existing && typeof existing.focus === 'function') {
                existing.focus();
            }
            return /** @type {Window} */ (existing);
        }
        if (typeof globalThis.open !== 'function') {
            return null;
        }
        const handle = globalThis.open(url, target, source.windowFeatures || AUDIO_CAPTURE_WINDOW_FEATURES);
        if (handle) {
            ownedPopups.set(source.id, handle);
        } else {
            console.warn(`${source.label} popup was blocked. Please allow popups for this site.`);
        }
        return handle;
    }

    /**
     * @param {string} sourceId
     * @param {{ trackUrl?: string }} [options]
     */
    function showAudioPlayer(sourceId, options = {}) {
        const source = sources.find((entry) => entry.id === sourceId) || sources[0];
        activeAudioSourceIndex = sources.findIndex((entry) => entry.id === source.id);
        hideAllAudioPlayers();

        if (source.presentation === 'popup') {
            // Leave this source's own window up: a second click focuses it.
            releasePlayerHandles(ownedPopups, { exceptId: source.id });
            const url = withProjectMAudioFlag(sourceUrl(source), options);
            if (url) openOwnedPopup(source, url);
            updateUi(source);
            return;
        }

        releasePlayerHandles(ownedPopups);

        if (source.sectionId) {
            if (menuId) {
                const menu = document.getElementById(menuId);
                if (menu) menu.style.display = 'block';
            }
            const url = withProjectMAudioFlag(sourceUrl(source), options);
            const frame = /** @type {HTMLIFrameElement | null} */ (source.frameSelector
                ? document.querySelector(source.frameSelector)
                : document.getElementById(source.sectionId)?.querySelector('iframe'));
            // COEP: require-corp blocks cross-origin iframes (go.1ink.us / test.1ink.us).
            // Same-origin ./flac-player/ can stay in the in-page section.
            if (url && frame && isSameOriginUrl(url)) {
                if (frame.getAttribute('src') !== url) {
                    frame.src = url;
                }
                const section = document.getElementById(source.sectionId);
                if (section) section.style.display = 'block';
            } else if (url) {
                const popup = openPopup(url, source.target || `${source.id}-player`);
                if (!popup) {
                    console.warn(`${source.label} popup was blocked. Please allow popups for this site.`);
                }
            }
            console.info('[projectM external PCM] Child iframe/popup should postMessage({ type: "pcm", buffer: Float32Array, channels: 1|2, sampleRate? }, "*") to this page');
        }

        updateUi(source);
    }

    function cycleAudioPlayer() {
        activeAudioSourceIndex = (activeAudioSourceIndex + 1) % sources.length;
        showAudioPlayer(sources[activeAudioSourceIndex].id);
    }

    function closeAudioPlayer() {
        activeAudioSourceIndex = 0;
        showAudioPlayer('none');
    }

    const controller = {
        showAudioPlayer,
        cycleAudioPlayer,
        closeAudioPlayer,
        dispose() {
            releasePlayerHandles(ownedPopups, { remove: true });
        },
    };

    return controller;
}

/**
 * Controller for hosts that open the players in popup windows which feed PCM
 * back through `postMessage`.
 *
 * @param {object} [options]
 * @param {AudioPlayerSource[]} [options.sources]
 * @param {(source: AudioPlayerSource) => void} [options.updateUi]
 * @returns {AudioPlayerController}
 */
export function createPopupAudioPlayerController({
    sources,
    updateUi = defaultUpdateUi,
} = {}) {
    /** @type {Map<string, Window | HTMLIFrameElement>} */
    const popups = new Map();
    /** @type {AudioPlayerSource[]} */
    const popupSources = sources || [
        { id: 'none', label: 'Audio Player' },
        {
            id: 'flac',
            label: 'FLAC Player',
            storageKey: 'flacPlayerUrl',
            elementId: 'flacPlayerUrl',
            defaultUrl: FLAC_PLAYER_BASE_URL,
            target: 'flac-player',
            resolveUrl: resolveFlacPlayerUrl,
        },
        {
            id: 'mod',
            label: 'MOD Player',
            storageKey: 'modPlayerUrl',
            elementId: 'modPlayerUrl',
            defaultUrl: MOD_PLAYER_BASE_URL,
            target: 'mod-player',
            resolveUrl: resolveModPlayerUrl,
        },
        captureAudioSource(),
    ];
    let activeAudioSourceIndex = 0;

    /**
     * @param {AudioPlayerSource} source
     * @returns {string | null | undefined}
     */
    function sourceUrl(source) {
        if (typeof source.resolveUrl === 'function') {
            return source.resolveUrl();
        }
        return (source.storageKey ? localStorage.getItem(source.storageKey) : null) ||
            (source.elementId ? document.getElementById(source.elementId)?.textContent?.trim() : null) ||
            source.defaultUrl;
    }

    /**
     * @param {AudioPlayerSource} source
     * @param {{ trackUrl?: string }} [options]
     * @returns {Window | HTMLIFrameElement | null}
     */
    function openPlayer(source, { trackUrl } = {}) {
        const url = withProjectMAudioFlag(sourceUrl(source), { trackUrl });
        const target = source.target || `${source.id}-player`;
        let handle = null;
        if (url && source.presentation === 'popup' && typeof globalThis.open === 'function') {
            // Same-origin capture must not fall through to the iframe feeder.
            handle = globalThis.open(url, target, source.windowFeatures || AUDIO_CAPTURE_WINDOW_FEATURES);
        } else {
            handle = url ? openPlayerForPcmFeed(url, target) : null;
        }
        if (handle) {
            popups.set(source.id, handle);
        } else {
            console.warn(
                `${source.label} could not open. Allow popups for cross-origin players. `
                + 'The player must postMessage PCM: '
                + 'window.opener.postMessage({type:"pcm", buffer: float32array, channels:2}, "*")'
            );
        }
        return handle;
    }

    /**
     * @param {string} sourceId
     * @param {{ trackUrl?: string }} [options]
     */
    function showAudioPlayer(sourceId, options = {}) {
        const source = popupSources.find((entry) => entry.id === sourceId) || popupSources[0];
        activeAudioSourceIndex = popupSources.findIndex((entry) => entry.id === source.id);
        const existing = popups.get(source.id);
        const reuse = source.presentation === 'popup' && existing && 'closed' in existing && !existing.closed;
        releasePlayerHandles(popups, { exceptId: reuse ? source.id : undefined });
        if (reuse) {
            if ('focus' in existing && typeof existing.focus === 'function') {
                existing.focus();
            }
        } else if (source.id !== 'none') {
            openPlayer(source, options);
        }
        updateUi(source);
    }

    function cycleAudioPlayer() {
        activeAudioSourceIndex = (activeAudioSourceIndex + 1) % popupSources.length;
        showAudioPlayer(popupSources[activeAudioSourceIndex].id);
    }

    function closeAudioPlayer() {
        activeAudioSourceIndex = 0;
        showAudioPlayer('none');
    }

    const controller = {
        showAudioPlayer,
        cycleAudioPlayer,
        closeAudioPlayer,
        dispose() {
            releasePlayerHandles(popups, { remove: true });
        },
        /** @param {string} [trackUrl] */
        openFlacPlayer: (trackUrl) => showAudioPlayer('flac', { trackUrl }),
        /** @param {string} [trackUrl] */
        openModPlayer: (trackUrl) => showAudioPlayer('mod', { trackUrl }),
    };

    return controller;
}
