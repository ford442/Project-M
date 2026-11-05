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
export const FLAC_PLAYER_SHELL_REV = '4';
export const MOD_PLAYER_BASE_URL = 'https://test.1ink.us/xm-player/';

/**
 * One selectable external audio player.
 *
 * @typedef {object} AudioPlayerSource
 * @property {string} id
 * @property {string} label
 * @property {string} [sectionId] Element id of the page's inline section, where it has one.
 * @property {string} [storageKey] localStorage key holding a custom URL.
 * @property {string} [elementId] Element whose text holds a custom URL.
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
 * @property {(trackUrl?: string) => void} openFlacPlayer
 * @property {(trackUrl?: string) => void} openModPlayer
 * @property {() => string} activeSourceId
 * @property {() => void} dispose Closes every window and drops every frame
 *   listener this controller made.
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
            'position:fixed;right:8px;bottom:8px;width:360px;height:220px;border:1px solid #334;border-radius:8px;z-index:var(--pm-z-player, 3250);background:#0b0f14;box-shadow:0 8px 24px rgba(0,0,0,0.45)'
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
 * How one source is shown:
 * - `section`: the page's own inline section (same-origin URL, page has it);
 * - `dock`: a small fixed iframe this controller creates (same-origin URL, no
 *   section on the page);
 * - `tab`: a new tab (cross-origin URL: COEP require-corp blocks the iframe);
 * - `popup`: a sized window (tab/system capture, which must stay open while
 *   the user switches to the shared tab);
 * - `none`: nothing (the "Audio Player" off state).
 *
 * @typedef {'section' | 'dock' | 'tab' | 'popup' | 'none'} AudioPlayerPresentation
 */

/**
 * The one audio-player controller. Every page uses it: the panel page has
 * inline sections, the core page does not and gets docked frames, and the
 * choice is made per source and URL rather than per page.
 *
 * It owns everything it opens: windows are closed and frames hidden when
 * another source is chosen. Same-origin frames hand Escape back to the host
 * (it closes the player) and give focus back to the host page once they have
 * loaded, so the page's keyboard shortcuts keep working.
 *
 * @param {object} [options]
 * @param {AudioPlayerSource[]} [options.sources]
 * @param {string} [options.menuId] Menu element shown alongside a section.
 * @param {(source: AudioPlayerSource) => void} [options.updateUi]
 * @param {(url: string, target: string) => Window | HTMLIFrameElement | null} [options.openPopup]
 *   Opens a non-section, non-capture player (default: {@link openPlayerForPcmFeed},
 *   a docked frame for same-origin URLs and a tab otherwise).
 * @param {Document} [options.documentRef]
 * @returns {AudioPlayerController}
 */
export function createAudioPlayerController({
    sources = DEFAULT_AUDIO_SOURCES,
    menuId,
    updateUi = defaultUpdateUi,
    openPopup,
    documentRef,
} = {}) {
    const doc = () => documentRef ?? /** @type {Document} */ (globalThis.document);
    const open = openPopup ?? ((url, target) => openPlayerForPcmFeed(url, target, documentRef));
    let activeIndex = 0;
    /** @type {Map<string, Window | HTMLIFrameElement>} */
    const owned = new Map();
    /** @type {Map<HTMLIFrameElement, () => void>} */
    const frameHooks = new Map();

    /**
     * @param {AudioPlayerSource} source
     * @returns {string | null | undefined}
     */
    function sourceUrl(source) {
        if (typeof source.resolveUrl === 'function') {
            return source.resolveUrl();
        }
        return (source.storageKey ? globalThis.localStorage?.getItem(source.storageKey) : null) ||
            (source.elementId ? doc()?.getElementById(source.elementId)?.textContent?.trim() : null) ||
            source.defaultUrl;
    }

    /**
     * @param {AudioPlayerSource} source
     * @returns {HTMLIFrameElement | null}
     */
    function sectionFrame(source) {
        if (!source.sectionId) return null;
        const d = doc();
        const section = d?.getElementById(source.sectionId);
        if (!section) return null;
        return /** @type {HTMLIFrameElement | null} */ (source.frameSelector
            ? d.querySelector(source.frameSelector)
            : section.querySelector?.('iframe') ?? null);
    }

    /**
     * @param {AudioPlayerSource} source
     * @param {string | null | undefined} url
     * @returns {AudioPlayerPresentation}
     */
    function presentationFor(source, url) {
        if (source.id === 'none' || !url) return 'none';
        if (source.presentation === 'popup') return 'popup';
        if (!isSameOriginUrl(url)) return 'tab';
        return sectionFrame(source) ? 'section' : 'dock';
    }

    /**
     * Same-origin frames: Escape inside the player closes it, and focus goes
     * back to the host page once the player has loaded (a click into the
     * iframe would otherwise keep every page shortcut in the frame).
     *
     * @param {HTMLIFrameElement} frame
     */
    function hookFrame(frame) {
        if (frameHooks.has(frame) || typeof frame.addEventListener !== 'function') return;
        /** @type {Document | null} */
        let hookedDoc = null;
        /** @param {KeyboardEvent} event */
        const onKey = (event) => {
            if (event.key === 'Escape') {
                closeAudioPlayer();
                doc()?.getElementById('audioPlayerBtn')?.focus?.();
            }
        };
        const onLoad = () => {
            try {
                hookedDoc?.removeEventListener('keydown', onKey);
                hookedDoc = frame.contentDocument;
                hookedDoc?.addEventListener('keydown', onKey);
            } catch {
                hookedDoc = null; // navigated cross-origin; nothing to hook
            }
            globalThis.focus?.();
        };
        frame.addEventListener('load', onLoad);
        frameHooks.set(frame, () => {
            frame.removeEventListener('load', onLoad);
            try {
                hookedDoc?.removeEventListener('keydown', onKey);
            } catch {
                /* frame gone */
            }
        });
    }

    function hideSections() {
        const d = doc();
        const sections = /** @type {HTMLElement[]} */ ([
            ...Array.from(d?.querySelectorAll?.('.ext-player-section') ?? []),
            ...sources.map((entry) => (entry.sectionId ? d?.getElementById(entry.sectionId) : null)),
        ]);
        for (const section of sections) {
            if (section?.style) section.style.display = 'none';
        }
    }

    /**
     * Close windows, hide docked frames. `keep` stays as it is.
     * @param {Window | HTMLIFrameElement} [keep]
     */
    function releaseOwned(keep) {
        for (const [id, handle] of owned) {
            if (!handle || handle === keep) continue;
            if ('closed' in handle && typeof handle.close === 'function') {
                if (!handle.closed) handle.close();
            } else if ('style' in handle && handle.style) {
                // A docked same-origin frame: hide it, keep it loaded.
                handle.style.display = 'none';
            }
            owned.delete(id);
        }
    }

    /**
     * @param {string} sourceId
     * @param {{ trackUrl?: string }} [options]
     */
    function showAudioPlayer(sourceId, options = {}) {
        const source = sources.find((entry) => entry.id === sourceId) || sources[0];
        activeIndex = sources.findIndex((entry) => entry.id === source.id);
        const url = withProjectMAudioFlag(sourceUrl(source), options);
        const presentation = presentationFor(source, url);
        const existing = owned.get(source.id);
        // A capture window that is still open is focused, not replaced: the
        // share picker lives in it.
        const reuse = presentation === 'popup' && existing && 'closed' in existing && !existing.closed
            ? existing
            : undefined;

        hideSections();
        releaseOwned(reuse);

        if (reuse) {
            if (typeof reuse.focus === 'function') reuse.focus();
        } else if (url && presentation === 'section') {
            const frame = /** @type {HTMLIFrameElement} */ (sectionFrame(source));
            if (frame.getAttribute('src') !== url) frame.src = url;
            hookFrame(frame);
            if (menuId) {
                const menu = doc()?.getElementById(menuId);
                if (menu) menu.style.display = 'block';
            }
            const section = source.sectionId ? doc()?.getElementById(source.sectionId) : null;
            if (section) section.style.display = 'block';
        } else if (url && presentation === 'popup') {
            const handle = typeof globalThis.open === 'function'
                ? globalThis.open(url, source.target || `${source.id}-player`, source.windowFeatures || AUDIO_CAPTURE_WINDOW_FEATURES)
                : null;
            if (handle) owned.set(source.id, handle);
            else console.warn(`${source.label} popup was blocked. Please allow popups for this site.`);
        } else if (url && (presentation === 'dock' || presentation === 'tab')) {
            const handle = open(url, source.target || `${source.id}-player`);
            if (handle) {
                owned.set(source.id, handle);
                if (presentation === 'dock' && !('closed' in handle)) hookFrame(/** @type {HTMLIFrameElement} */ (handle));
            } else {
                console.warn(
                    `${source.label} could not open. Allow popups for cross-origin players. `
                    + 'The player must postMessage PCM: '
                    + 'window.opener.postMessage({type:"pcm", buffer: float32array, channels:2}, "*")'
                );
            }
        }

        updateUi(source);
    }

    function cycleAudioPlayer() {
        activeIndex = (activeIndex + 1) % sources.length;
        showAudioPlayer(sources[activeIndex].id);
    }

    function closeAudioPlayer() {
        activeIndex = 0;
        showAudioPlayer('none');
    }

    return {
        showAudioPlayer,
        cycleAudioPlayer,
        closeAudioPlayer,
        /** @param {string} [trackUrl] */
        openFlacPlayer: (trackUrl) => showAudioPlayer('flac', { trackUrl }),
        /** @param {string} [trackUrl] */
        openModPlayer: (trackUrl) => showAudioPlayer('mod', { trackUrl }),
        activeSourceId: () => sources[activeIndex]?.id ?? 'none',
        dispose() {
            releaseOwned();
            for (const unhook of frameHooks.values()) unhook();
            frameHooks.clear();
        },
    };
}
