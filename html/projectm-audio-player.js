// Prefer same-origin players when co-deployed with projectM; libopenmpt MOD shell
// remains on test.1ink.us until xm-player assets are vendored in-repo.
export const FLAC_PLAYER_BASE_URL = './flac-player/';
export const MOD_PLAYER_BASE_URL = 'https://test.1ink.us/xm-player/';

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

const PLAYER_POPUP_FEATURES = 'width=500,height=650,resizable=yes,scrollbars=no';

// Signals an external audio player (MOD/FLAC) that it is being opened purely as
// a PCM feeder for projectM, so it can run in compact "audio-only" mode and skip
// its own standalone visualizer (e.g. the mod-player's WebGPU pattern/spectrum
// display) to save GPU budget for the projectM WASM renderer. The player is
// expected to detect `?projectm=1` (the host can't disable the remote player's
// canvas itself). Preserves any existing query string and returns the input
// unchanged if it can't be parsed as a URL.
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

function defaultUpdateUi(source, {
    statusId = 'audio-player-status',
    buttonId = 'audioPlayerBtn',
    labelId = 'audioPlayerLabel'
} = {}) {
    const status = document.getElementById(statusId);
    const label = document.getElementById(labelId);
    const btn = document.getElementById(buttonId);
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

function exposeController(controller) {
    window.cycleAudioPlayer = controller.cycleAudioPlayer;
    window.closeAudioPlayer = controller.closeAudioPlayer;
    window.flacPlayer = () => controller.showAudioPlayer('flac');
    window.modPlayer = () => controller.showAudioPlayer('mod');
}

export function createSectionAudioPlayerController({
    sources = DEFAULT_AUDIO_SOURCES,
    menuId,
    updateUi = defaultUpdateUi,
    exposeGlobals = true,
    openPopup = (url, target) => globalThis.open(url, target, PLAYER_POPUP_FEATURES),
} = {}) {
    let activeAudioSourceIndex = 0;

    function hideAllAudioPlayers() {
        document.querySelectorAll('.ext-player-section').forEach((section) => {
            section.style.display = 'none';
        });
    }

    function sourceUrl(source) {
        if (typeof source.resolveUrl === 'function') {
            return source.resolveUrl();
        }
        return source.defaultUrl || '';
    }

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
            const frame = source.frameSelector
                ? document.querySelector(source.frameSelector)
                : document.getElementById(source.sectionId)?.querySelector('iframe');
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

export function createPopupAudioPlayerController({
    sources,
    updateUi = defaultUpdateUi,
    exposeGlobals = true
} = {}) {
    const popups = new Map();
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

    function sourceUrl(source) {
        if (typeof source.resolveUrl === 'function') {
            return source.resolveUrl();
        }
        return localStorage.getItem(source.storageKey) ||
            document.getElementById(source.elementId)?.textContent?.trim() ||
            source.defaultUrl;
    }

    function openPopup(source, { trackUrl } = {}) {
        const popup = window.open(
            withProjectMAudioFlag(sourceUrl(source), { trackUrl }),
            source.target || `${source.id}-player`,
            'width=500,height=650,resizable=yes,scrollbars=no'
        );
        if (popup) {
            popups.set(source.id, popup);
        } else {
            console.warn(`${source.label} popup was blocked. Please allow popups for this site. The player page must use postMessage to send PCM: window.opener.postMessage({type:"pcm", buffer: float32array, channels:2}, "*")`);
        }
        return popup;
    }

    function closeAllAudioPlayers() {
        for (const popup of popups.values()) {
            if (popup && !popup.closed) popup.close();
        }
        popups.clear();
    }

    function showAudioPlayer(sourceId, options = {}) {
        const source = popupSources.find((entry) => entry.id === sourceId) || popupSources[0];
        activeAudioSourceIndex = popupSources.findIndex((entry) => entry.id === source.id);
        closeAllAudioPlayers();
        if (source.id !== 'none') openPopup(source, options);
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
        openFlacPlayer: (trackUrl) => showAudioPlayer('flac', { trackUrl }),
        openModPlayer: (trackUrl) => showAudioPlayer('mod', { trackUrl }),
    };

    if (exposeGlobals) {
        exposeController(controller);
        window.openFlacPlayer = controller.openFlacPlayer;
        window.openModPlayer = controller.openModPlayer;
    }

    return controller;
}
