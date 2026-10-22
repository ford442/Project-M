// "Weeks on fire" demo mode: texture-heavy weeks_presets + weeks_textures + weeks_songs.
// Enable with ?mode=weeks_on_fire on projectm.1ink.us (or any host that wires this module).
//
// The preset side lives here (createWeeksPresetLoader / startWeeksOnFire): it
// lists the weeks_presets directory, fetches presets with fetch() and hands the
// bytes to the page's writePreset, which is `transport.writePreset` in either
// render topology. That used to be XMLHttpRequest inside the WASM glue
// (src/wasm/WasmJsBindings.cpp), which only worked with the engine on the main
// thread. Textures come from projectm-textures.js (`#textureDir`, which
// applyWeeksOnFireDomConfig points at weeks_textures/), songs from
// projectm-song-loader.js (`#songDir`).

export const WEEKS_ON_FIRE_MODE = 'weeks_on_fire';

export const DEFAULT_WEEKS_PATHS = {
    presets: './weeks_presets/',
    textures: './weeks_textures/',
    songs: './weeks_songs/',
};

/** Same-origin FLAC decode page used by BroadcastChannel('sng'/'file'). */
export function resolveFlacDecoderUrl(documentRef = document) {
    const el = documentRef.getElementById('flacDecoderUrl');
    const fromDom = el?.textContent?.trim();
    if (fromDom) {
        try {
            return new URL(fromDom, globalThis.location?.href || 'https://projectm.1ink.us/').href;
        } catch {
            return fromDom;
        }
    }
    const origin = globalThis.location?.origin;
    if (origin) {
        return `${origin}/flac/`;
    }
    return './flac/';
}

/**
 * Hidden same-origin iframe so BroadcastChannel('sng'/'file') stays in the host
 * agent cluster. Under COOP:same-origin, a separate tab/popup of `./flac/` that
 * does not itself send COOP is a different agent cluster — BroadcastChannel and
 * often window.opener both fail, so decoded WAV never reaches the visualizer.
 * Same-origin iframes share the host cluster and work with COEP:require-corp.
 * @param {Document} [documentRef]
 */
export function ensureWeeksFlacDecoderFrame(documentRef = document) {
    let frame = documentRef.getElementById('weeksFlacDecoderFrame');
    if (!frame) {
        frame = documentRef.createElement('iframe');
        frame.id = 'weeksFlacDecoderFrame';
        frame.title = 'FLAC decoder';
        frame.setAttribute(
            'style',
            'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none'
        );
        documentRef.body.appendChild(frame);
    }
    const iframe = /** @type {HTMLIFrameElement} */ (frame);
    const target = resolveFlacDecoderUrl(documentRef);
    const current = iframe.getAttribute('src') || iframe.src || '';
    if (!current || !current.includes('/flac')) {
        iframe.src = target;
    }
    return iframe;
}

/**
 * Open the legacy `/flac/` decoder (BroadcastChannel sng/file).
 *
 * Default is a same-origin hidden **iframe** so `sng`/`file` channels reach the
 * visualizer under COOP/COEP. Pass `{ preferIframe: false }` to force a tab.
 *
 * @param {Document} [documentRef]
 * @param {{ preferIframe?: boolean }} [options]
 */
export function openWeeksFlacDecoder(documentRef = document, { preferIframe = true } = {}) {
    const url = resolveFlacDecoderUrl(documentRef);
    if (preferIframe !== false && documentRef?.body) {
        ensureWeeksFlacDecoderFrame(documentRef);
        return null;
    }
    if (typeof globalThis.open === 'function') {
        // Omit features so the browser opens a tab, not a constrained popup.
        return globalThis.open(url, 'flac-decoder');
    }
    if (documentRef?.body) {
        ensureWeeksFlacDecoderFrame(documentRef);
    }
    return null;
}

/** Expose the FLAC decoder helpers on globalThis, where projectm-song-loader.js looks for them. */
export function wireWeeksOnFireFlacBridge(documentRef = document) {
    if (typeof globalThis === 'undefined') {
        return;
    }
    globalThis.resolveFlacDecoderUrl = () => resolveFlacDecoderUrl(documentRef);
    globalThis.ensureWeeksFlacDecoderFrame = () => ensureWeeksFlacDecoderFrame(documentRef);
    globalThis.openWeeksFlacDecoder = (/** @type {{ preferIframe?: boolean } | undefined} */ options) =>
        openWeeksFlacDecoder(documentRef, options);
}

/**
 * Wire same-origin FLAC decode helpers for every host.
 * Exposes `openWeeksFlacDecoder` (hidden iframe by default) for WASM glue and
 * the song loader so BroadcastChannel PCM/WAV stays in the COOP agent cluster.
 */
export function wireFlacDecoderBridge(documentRef = document) {
    let el = documentRef.getElementById('flacDecoderUrl');
    if (!el) {
        el = documentRef.createElement('div');
        el.id = 'flacDecoderUrl';
        el.hidden = true;
        documentRef.body?.appendChild(el);
    }
    el.textContent = resolveFlacDecoderUrl(documentRef);
    wireWeeksOnFireFlacBridge(documentRef);
}

/** @param {URLSearchParams|string|undefined} search */
export function isWeeksOnFireMode(search) {
    if (typeof globalThis !== 'undefined' && globalThis.__projectMWeeksOnFire === true) {
        return true;
    }
    let params = search;
    if (!params) {
        try {
            params = new URLSearchParams(globalThis.location?.search || '');
        } catch {
            return false;
        }
    } else if (typeof params === 'string') {
        params = new URLSearchParams(params);
    }
    return params.get('mode') === WEEKS_ON_FIRE_MODE;
}

/**
 * Point the page's hidden config elements (`#textureDir`, `#songDir`,
 * `#weeksPresetDir`) at the weeks_* folders. Call before the texture, song and
 * weeks-preset scans read them.
 * @param {Document} [documentRef]
 * @param {{ presets?: string, textures?: string, songs?: string, flacDecoder?: string }} [paths]
 */
export function applyWeeksOnFireDomConfig(documentRef = document, paths = DEFAULT_WEEKS_PATHS) {
    const doc = documentRef;
    const merged = { ...DEFAULT_WEEKS_PATHS, ...paths };

    /**
     * @param {string} id
     * @param {string} value
     */
    function setHidden(id, value) {
        const el = doc.getElementById(id);
        if (el) el.textContent = value;
    }

    setHidden('textureDir', merged.textures);
    setHidden('songDir', merged.songs);
    setHidden('weeksPresetDir', merged.presets);
    setHidden('presetDir', 'weeks_presets');

    const flacDecoder = merged.flacDecoder
        || (typeof globalThis.location !== 'undefined' && globalThis.location.origin
            ? `${globalThis.location.origin}/flac/`
            : './flac/');
    setHidden('flacDecoderUrl', flacDecoder);
    wireWeeksOnFireFlacBridge(doc);

    if (typeof globalThis !== 'undefined') {
        globalThis.__projectMWeeksOnFire = true;
        globalThis.__projectMWeeksPaths = merged;
    }
}

/**
 * Parse an Apache-style directory index and return absolute .milk URLs.
 * @param {string} html
 * @param {string} baseUrl
 */
export function parseMilkDirectoryListing(html, baseUrl) {
    if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const anchors = Array.from(doc.querySelectorAll('pre a'));
        /** @type {string[]} */
        const urls = [];
        for (const anchor of anchors) {
            const href = anchor.getAttribute('href');
            if (!href || href.startsWith('?') || href === '../' || href === '/') continue;
            const decoded = decodeURIComponent(href);
            if (!decoded.toLowerCase().endsWith('.milk')) continue;
            urls.push(new URL(href, baseUrl).href);
        }
        return urls;
    }

    /** @type {string[]} */
    const urls = [];
    const anchorRe = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = anchorRe.exec(html)) !== null) {
        const href = match[1];
        if (!href || href.startsWith('?') || href === '../' || href === '/') continue;
        const decoded = decodeURIComponent(href);
        if (!decoded.toLowerCase().endsWith('.milk')) continue;
        urls.push(new URL(href, baseUrl).href);
    }
    return urls;
}

/**
 * The weeks preset directory as an absolute URL: the text of `#weeksPresetDir`
 * (which applyWeeksOnFireDomConfig sets), else `weeks_presets/`.
 *
 * @param {Pick<Document, 'getElementById'> | null | undefined} [documentRef]
 * @param {string} [locationHref] What a relative directory resolves against.
 */
export function resolveWeeksPresetBase(
    documentRef = typeof document !== 'undefined' ? document : null,
    locationHref = globalThis.location?.href,
) {
    const raw = documentRef?.getElementById('weeksPresetDir')?.textContent?.trim() || DEFAULT_WEEKS_PATHS.presets;
    const withSlash = raw.endsWith('/') ? raw : `${raw}/`;
    try {
        return new URL(withSlash, locationHref || 'https://localhost/').href;
    } catch {
        return withSlash;
    }
}

/**
 * @typedef {'load' | 'load-hard' | 'add'} WeeksWriteMode
 *   `load` soft-cuts to the preset, `load-hard` cuts to it at once, `add` only
 *   appends it to the playlist (the render transport's writePreset modes).
 */

/**
 * @typedef {object} WeeksPresetLoaderOptions
 * @property {(vfsPath: string, bytes: Uint8Array, mode: WeeksWriteMode) => void} writePreset
 *   Writes the bytes into the engine's VFS and loads or adds them; pass
 *   `(path, bytes, mode) => context.transport.writePreset(path, bytes, mode)`.
 * @property {(name: string) => void} [onPresetLoaded] Told the file name of each
 *   preset the engine was switched to (the page's preset name readout).
 * @property {string} [presetBase] Directory index URL. Defaults to `#weeksPresetDir`.
 * @property {typeof fetch} [fetchImpl]
 * @property {() => number} [random] In [0, 1); for tests.
 */

/**
 * Fetches presets from the weeks_presets directory into the engine.
 *
 * @param {WeeksPresetLoaderOptions} options
 */
export function createWeeksPresetLoader({
    writePreset,
    onPresetLoaded,
    presetBase,
    fetchImpl = fetch,
    random = Math.random,
}) {
    /** @type {string[] | null} */
    let urls = null;
    /** @type {Promise<string[]> | null} */
    let scanning = null;
    let pickInFlight = false;

    /** @param {string} url */
    const fileName = (url) => decodeURIComponentSafe(url.split('/').pop() ?? url);

    /** @param {string} url */
    async function fetchBytes(url) {
        const response = await fetchImpl(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
    }

    /**
     * The .milk URLs in the weeks preset directory. Scanned once; a failed scan
     * is tried again on the next call.
     * @returns {Promise<string[]>}
     */
    function scan() {
        if (urls) {
            return Promise.resolve(urls);
        }
        if (!scanning) {
            const base = presetBase ?? resolveWeeksPresetBase();
            scanning = (async () => {
                const listing = await fetchImpl(base);
                if (!listing.ok) {
                    throw new Error(`Failed to list weeks presets (${listing.status})`);
                }
                const found = parseMilkDirectoryListing(await listing.text(), listing.url || base);
                console.log(`[projectM weeks] scanned ${found.length} presets from ${base}`);
                urls = found;
                return found;
            })().finally(() => {
                scanning = null;
            });
        }
        return scanning;
    }

    return {
        scan,

        /**
         * Load one random weeks preset with a hard cut. A pick that is still
         * downloading swallows further requests. Resolves the file name loaded,
         * or null when nothing was loaded.
         * @returns {Promise<string | null>}
         */
        async loadRandom() {
            if (pickInFlight) {
                console.log('[projectM weeks] preset pick already in flight; ignoring duplicate request.');
                return null;
            }
            pickInFlight = true;
            try {
                const all = await scan();
                if (all.length === 0) {
                    console.log('[projectM weeks] no weeks presets available.');
                    return null;
                }
                const url = all[Math.floor(random() * all.length)];
                const name = fileName(url);
                writePreset(`/presets/weeks_pick_${Date.now()}.milk`, await fetchBytes(url), 'load-hard');
                onPresetLoaded?.(name);
                return name;
            } catch (error) {
                console.warn('[projectM weeks] failed to load a weeks preset:', error);
                return null;
            } finally {
                pickInFlight = false;
            }
        },

        /**
         * Seed the playlist with `count` random presets, downloaded in parallel.
         * Whichever arrives first is loaded; the rest are added behind it.
         * Resolves the file names that made it in.
         * @param {number} [count]
         * @returns {Promise<string[]>}
         */
        async seed(count = 5) {
            const all = await scan();
            const pool = all.slice();
            const picks = [];
            for (let n = Math.min(count, pool.length); n > 0; n -= 1) {
                picks.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
            }
            /** @type {string[]} */
            const seeded = [];
            await Promise.all(picks.map(async (url, slot) => {
                try {
                    const bytes = await fetchBytes(url);
                    const first = seeded.length === 0;
                    writePreset(`/presets/weeks_${slot}.milk`, bytes, first ? 'load' : 'add');
                    seeded.push(fileName(url));
                    if (first) {
                        onPresetLoaded?.(fileName(url));
                    }
                } catch (error) {
                    console.warn(`[projectM weeks] failed to download weeks preset ${url}:`, error);
                }
            }));
            console.log(`[projectM weeks] seeded ${seeded.length} presets into the playlist.`);
            return seeded;
        },
    };
}

/** @param {string} value */
function decodeURIComponentSafe(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * Start weeks-on-fire's preset playlist and, once it is seeded, a random song.
 *
 * @param {WeeksPresetLoaderOptions & {
 *   count?: number,
 *   playSong?: () => (void | Promise<unknown>),
 *   songDelayMs?: number,
 * }} options
 * @returns {{ loader: ReturnType<typeof createWeeksPresetLoader>, ready: Promise<string[]> }}
 *   `ready` resolves the seeded file names and never rejects.
 */
export function startWeeksOnFire({ count = 5, playSong, songDelayMs = 2500, ...loaderOptions }) {
    const loader = createWeeksPresetLoader(loaderOptions);
    const ready = loader.seed(count).then((seeded) => {
        if (playSong) {
            setTimeout(() => {
                Promise.resolve()
                    .then(playSong)
                    .catch((error) => console.warn('[projectM weeks] could not start a song:', error));
            }, songDelayMs);
        }
        return seeded;
    }).catch((error) => {
        console.warn('[projectM weeks] could not seed the weeks presets:', error);
        return /** @type {string[]} */ ([]);
    });
    return { loader, ready };
}
