export const FLAC_PLAYER_BASE_URL = 'https://go.1ink.us/flac-player/';
export const MOD_PLAYER_BASE_URL = 'https://go.1ink.us/xm-player/';

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
    exposeGlobals = true
} = {}) {
    let activeAudioSourceIndex = 0;

    function hideAllAudioPlayers() {
        document.querySelectorAll('.ext-player-section').forEach((section) => {
            section.style.display = 'none';
        });
    }

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

    function sourceUrl(source) {
        return localStorage.getItem(source.storageKey) ||
            document.getElementById(source.elementId)?.textContent?.trim() ||
            source.defaultUrl;
    }

    function openPopup(source) {
        const popup = window.open(withProjectMAudioFlag(sourceUrl(source)), source.target || `${source.id}-player`,
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
