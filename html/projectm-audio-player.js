// Prefer same-origin players when co-deployed with projectM; libopenmpt MOD shell
// remains on test.1ink.us until xm-player assets are vendored in-repo.
export const FLAC_PLAYER_BASE_URL = './flac-player/';
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
 * @property {() => string | null | undefined} [resolveUrl]
 */

/**
 * @typedef {object} AudioPlayerController
 * @property {(sourceId: string, options?: { trackUrl?: string }) => void} showAudioPlayer
 * @property {() => void} cycleAudioPlayer
 * @property {() => void} closeAudioPlayer
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
 * @returns {string | null | undefined} `url` with `?projectm=1`, or unchanged
 *   if it is falsy or not parseable.
 */
export function withProjectMAudioFlag(url, { trackUrl } = {}) {
    if (!url) return url;
    try {
        const base = typeof window !== 'undefined' && window.location?.href
            ? window.location.href
            : 'https://localhost/';
        const parsed = new URL(url, base);
        parsed.searchParams.set('projectm', '1');
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
            ? 'Audio Player - click to open FLAC, MOD, or hide'
            : `${source.label} active - click to switch or hide`;
    }
}

/** @param {AudioPlayerController} controller */
function exposeController(controller) {
    window.cycleAudioPlayer = controller.cycleAudioPlayer;
    window.closeAudioPlayer = controller.closeAudioPlayer;
    window.flacPlayer = () => controller.showAudioPlayer('flac');
    window.modPlayer = () => controller.showAudioPlayer('mod');
}

/**
 * Controller for hosts that embed the players as inline `.ext-player-section`
 * elements (panel2).
 *
 * @param {object} [options]
 * @param {AudioPlayerSource[]} [options.sources]
 * @param {string} [options.menuId] Menu element toggled alongside the sections.
 * @param {(source: AudioPlayerSource) => void} [options.updateUi]
 * @param {boolean} [options.exposeGlobals]
 * @param {(url: string, target: string) => Window | HTMLIFrameElement | null} [options.openPopup]
 * @returns {AudioPlayerController}
 */
export function createSectionAudioPlayerController({
    sources = DEFAULT_AUDIO_SOURCES,
    menuId,
    updateUi = defaultUpdateUi,
    exposeGlobals = true,
    openPopup = (url, target) => openPlayerForPcmFeed(url, target),
} = {}) {
    let activeAudioSourceIndex = 0;

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
     * @param {string} sourceId
     * @param {{ trackUrl?: string }} [options]
     */
    function showAudioPlayer(sourceId, options = {}) {
        const source = sources.find((entry) => entry.id === sourceId) || sources[0];
        activeAudioSourceIndex = sources.findIndex((entry) => entry.id === source.id);
        hideAllAudioPlayers();

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
        closeAudioPlayer
    };

    if (exposeGlobals) exposeController(controller);
    return controller;
}

/**
 * Controller for hosts that open the players in popup windows which feed PCM
 * back through `postMessage`.
 *
 * @param {object} [options]
 * @param {AudioPlayerSource[]} [options.sources]
 * @param {(source: AudioPlayerSource) => void} [options.updateUi]
 * @param {boolean} [options.exposeGlobals]
 * @returns {AudioPlayerController}
 */
export function createPopupAudioPlayerController({
    sources,
    updateUi = defaultUpdateUi,
    exposeGlobals = true
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
        }
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
        const handle = url ? openPlayerForPcmFeed(url, target) : null;
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

    function closeAllAudioPlayers() {
        for (const handle of popups.values()) {
            if (!handle) continue;
            // Window popup/tab
            if ('close' in handle && typeof handle.close === 'function' && 'closed' in handle) {
                if (!handle.closed) handle.close();
                continue;
            }
            // Same-origin iframe feeder — hide, keep loaded for quick re-open
            if ('style' in handle && handle.style) {
                handle.style.display = 'none';
            }
        }
        popups.clear();
    }

    /**
     * @param {string} sourceId
     * @param {{ trackUrl?: string }} [options]
     */
    function showAudioPlayer(sourceId, options = {}) {
        const source = popupSources.find((entry) => entry.id === sourceId) || popupSources[0];
        activeAudioSourceIndex = popupSources.findIndex((entry) => entry.id === source.id);
        closeAllAudioPlayers();
        if (source.id !== 'none') openPlayer(source, options);
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
        /** @param {string} [trackUrl] */
        openFlacPlayer: (trackUrl) => showAudioPlayer('flac', { trackUrl }),
        /** @param {string} [trackUrl] */
        openModPlayer: (trackUrl) => showAudioPlayer('mod', { trackUrl }),
    };

    if (exposeGlobals) {
        exposeController(controller);
        window.openFlacPlayer = controller.openFlacPlayer;
        window.openModPlayer = controller.openModPlayer;
    }

    return controller;
}
