export const FLAC_PLAYER_BASE_URL = 'https://go.1ink.us/flac-player/';
export const MOD_PLAYER_BASE_URL = 'https://go.1ink.us/xm-player/';

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
 */

/**
 * @typedef {object} AudioPlayerController
 * @property {(sourceId: string) => void} showAudioPlayer
 * @property {() => void} cycleAudioPlayer
 * @property {() => void} closeAudioPlayer
 * @property {() => void} [openFlacPlayer]
 * @property {() => void} [openModPlayer]
 */

/** @type {AudioPlayerSource[]} */
const DEFAULT_AUDIO_SOURCES = [
    { id: 'none', label: 'Audio Player' },
    { id: 'flac', label: 'FLAC Player', sectionId: 'flacPlayerSection' },
    { id: 'mod', label: 'MOD Player', sectionId: 'modPlayerSection' }
];

// Signals an external audio player (MOD/FLAC) that it is being opened purely as
// a PCM feeder for projectM, so it can run in compact "audio-only" mode and skip
// its own standalone visualizer (e.g. the mod-player's WebGPU pattern/spectrum
// display) to save GPU budget for the projectM WASM renderer. The player is
// expected to detect `?projectm=1` (the host can't disable the remote player's
// canvas itself). Preserves any existing query string and returns the input
// unchanged if it can't be parsed as a URL.
/**
 * @param {string | null | undefined} url
 * @returns {string | null | undefined} `url` with `?projectm=1`, or unchanged
 *   if it is falsy or not parseable.
 */
export function withProjectMAudioFlag(url) {
    if (!url) return url;
    try {
        const parsed = new URL(url, window.location.href);
        parsed.searchParams.set('projectm', '1');
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
 * @returns {AudioPlayerController}
 */
export function createSectionAudioPlayerController({
    sources = DEFAULT_AUDIO_SOURCES,
    menuId,
    updateUi = defaultUpdateUi,
    exposeGlobals = true
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

    /** @param {string} sourceId */
    function showAudioPlayer(sourceId) {
        const source = sources.find((entry) => entry.id === sourceId) || sources[0];
        activeAudioSourceIndex = sources.findIndex((entry) => entry.id === source.id);
        hideAllAudioPlayers();

        if (source.sectionId) {
            if (menuId) {
                const menu = document.getElementById(menuId);
                if (menu) menu.style.display = 'block';
            }
            const section = document.getElementById(source.sectionId);
            if (section) section.style.display = 'block';
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
    /** @type {Map<string, Window>} */
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
            target: 'flac-player'
        },
        {
            id: 'mod',
            label: 'MOD Player',
            storageKey: 'modPlayerUrl',
            elementId: 'modPlayerUrl',
            defaultUrl: MOD_PLAYER_BASE_URL,
            target: 'mod-player'
        }
    ];
    let activeAudioSourceIndex = 0;

    /**
     * @param {AudioPlayerSource} source
     * @returns {string | null | undefined}
     */
    function sourceUrl(source) {
        return (source.storageKey ? localStorage.getItem(source.storageKey) : null) ||
            (source.elementId ? document.getElementById(source.elementId)?.textContent?.trim() : null) ||
            source.defaultUrl;
    }

    /** @param {AudioPlayerSource} source */
    function openPopup(source) {
        const popup = window.open(withProjectMAudioFlag(sourceUrl(source)) ?? undefined, source.target || `${source.id}-player`,
            'width=500,height=650,resizable=yes,scrollbars=no');
        if (popup) {
            popups.set(source.id, popup);
        } else {
            console.warn(`${source.label} popup was blocked. Please allow popups for this site. The player page must use postMessage to send PCM: window.opener.postMessage({type:"pcm", buffer: float32array, channels:2}, "*")`);
        }
    }

    function closeAllAudioPlayers() {
        for (const popup of popups.values()) {
            if (popup && !popup.closed) popup.close();
        }
        popups.clear();
    }

    /** @param {string} sourceId */
    function showAudioPlayer(sourceId) {
        const source = popupSources.find((entry) => entry.id === sourceId) || popupSources[0];
        activeAudioSourceIndex = popupSources.findIndex((entry) => entry.id === source.id);
        closeAllAudioPlayers();
        if (source.id !== 'none') openPopup(source);
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
        openFlacPlayer: () => showAudioPlayer('flac'),
        openModPlayer: () => showAudioPlayer('mod')
    };

    if (exposeGlobals) {
        exposeController(controller);
        window.openFlacPlayer = controller.openFlacPlayer;
        window.openModPlayer = controller.openModPlayer;
    }

    return controller;
}
