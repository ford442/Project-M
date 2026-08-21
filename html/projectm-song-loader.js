// Host-side song routing for Start/Change Song (musicBtn).
//
// WASM glue (WasmJsBindings.cpp) always opens ./flac/ and posts a random catalog
// URL on BroadcastChannel('sng'). That popup is a drop-zone unless /flac/ is
// already listening, and the merged catalog can also launch the MOD player.
//
// This module owns the music button: it plays FLAC/MP3/WAV/OGG in-page via
// fetch + decodeAudioData → the shared worklet (no player popup). MOD files stay
// on the Audio Player button, not Start/Change Song. If native FLAC decode
// fails, we fall back to the legacy ./flac/ BroadcastChannel path with a delayed
// 'sng' post so the decoder page has time to subscribe.

import { ensureWorkletReady, loadWavBytesIntoWorklet } from './projectm-worklet-playback.js';

/** @type {typeof BroadcastChannel | null} */
let nativeBroadcastChannel = null;

/** @type {boolean} */
let bypassSngIntercept = false;

/** @type {Promise<string[]> | null} */
let catalogScanPromise = null;

/**
 * @param {string} elementId
 * @param {string} fallback
 * @param {Document} [documentRef]
 */
export function resolveSongDirectory(elementId, fallback, documentRef) {
    const doc = documentRef ?? (typeof document !== 'undefined' ? document : null);
    const el = doc?.getElementById(elementId);
    const raw = el?.textContent?.trim() || fallback;
    const withSlash = raw.endsWith('/') ? raw : `${raw}/`;
    try {
        return new URL(withSlash, globalThis.location?.href || 'https://localhost/').href;
    } catch {
        return withSlash;
    }
}

/**
 * Parse an Apache-style directory listing into absolute file URLs.
 * @param {string} html
 * @param {string} baseUrl
 */
export function parseSongDirectoryListing(html, baseUrl) {
    const urls = [];
    const anchorRe = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = anchorRe.exec(html)) !== null) {
        const href = match[1];
        if (!href || href === '../' || href === '/' || href.startsWith('?')) {
            continue;
        }
        try {
            urls.push(new URL(href, baseUrl).href);
        } catch {
            // skip malformed href
        }
    }
    return urls;
}

/**
 * Scan songs/, mp3_songs/, and mod_songs/ into a merged host-side catalog.
 * @param {Document} [documentRef]
 * @param {typeof fetch} [fetchImpl]
 */
export async function scanSongCatalog(documentRef, fetchImpl = fetch) {
    const doc = documentRef ?? (typeof document !== 'undefined' ? document : null);
    const directories = [
        resolveSongDirectory('songDir', 'songs/', doc),
        resolveSongDirectory('mp3SongDir', 'mp3_songs/', doc),
        resolveSongDirectory('modSongDir', 'mod_songs/', doc),
    ];

    const merged = [];
    for (const baseUrl of directories) {
        try {
            const response = await fetchImpl(baseUrl);
            if (!response.ok) {
                console.debug('[projectM song loader] song scan skipped', baseUrl, response.status);
                continue;
            }
            const html = await response.text();
            const urls = parseSongDirectoryListing(html, baseUrl);
            merged.push(...urls);
            console.log(`[projectM song loader] scanned ${urls.length} tracks from ${baseUrl}`);
        } catch (error) {
            console.debug('[projectM song loader] song scan failed for', baseUrl, error);
        }
    }

    globalThis.__projectMSongCatalog = merged;
    return merged;
}

/** @returns {Promise<string[]>} */
export function ensureSongCatalog(documentRef) {
    const doc = documentRef ?? (typeof document !== 'undefined' ? document : null);
    if (!catalogScanPromise) {
        catalogScanPromise = scanSongCatalog(doc).catch((error) => {
            catalogScanPromise = null;
            throw error;
        });
    }
    return catalogScanPromise;
}

/**
 * Start/Change Song should play through the worklet, not open MOD/FLAC player UIs.
 * @param {string} url
 */
export function isWorkletCatalogSong(url) {
    const kind = classifySongUrl(url);
    return kind === 'browser' || kind === 'flac';
}

/**
 * Pick and route a random worklet-playable track (songs/ + mp3_songs/, not mods).
 * @returns {Promise<boolean>}
 */
export async function playRandomCatalogSong() {
    const catalog = await ensureSongCatalog();
    const playable = catalog.filter(isWorkletCatalogSong);
    if (!playable.length) {
        console.warn('[projectM song loader] no FLAC/MP3/WAV tracks in catalog');
        return false;
    }
    const url = playable[Math.floor(Math.random() * playable.length)];
    console.log('[projectM song loader] random track:', url);
    await routeSongUrl(url);
    return true;
}

/**
 * Capture-phase handler so merged catalog works before WASM glue runs snd().
 * @param {Document} [documentRef]
 */
export function installMusicButtonHandler(documentRef) {
    const doc = documentRef ?? (typeof document !== 'undefined' ? document : null);
    if (!doc) {
        return;
    }
    const btn = doc.getElementById('musicBtn');
    if (!btn || btn.dataset.projectmSongLoaderWired === '1') {
        return;
    }
    btn.dataset.projectmSongLoaderWired = '1';

    // Capture + sync stop so WASM glue cannot also open ./flac/ or the MOD player.
    btn.addEventListener('click', (event) => {
        event.stopImmediatePropagation();
        event.preventDefault();
        void playRandomCatalogSong().catch((error) => {
            console.error('[projectM song loader] random track failed:', error);
        });
    }, true);

    void ensureSongCatalog(doc);
}

/** @type {ReadonlySet<string>} */
export const BROWSER_DECODE_EXTENSIONS = new Set([
    '.mp3',
    '.wav',
    '.ogg',
    '.oga',
    '.m4a',
    '.aac',
    '.webm',
]);

/** @type {ReadonlySet<string>} */
export const MOD_EXTENSIONS = new Set([
    '.mod',
    '.xm',
    '.s3m',
    '.it',
    '.mptm',
    '.mtm',
    '.669',
    '.amf',
]);

/** @type {ReadonlySet<string>} */
export const FLAC_EXTENSIONS = new Set(['.flac', '.fla']);

/**
 * @param {string} url
 * @returns {string} Lower-case extension including dot, or empty string.
 */
export function songExtension(url) {
    if (!url || typeof url !== 'string') {
        return '';
    }
    try {
        const path = new URL(url, globalThis.location?.href || 'https://localhost/').pathname.toLowerCase();
        const dot = path.lastIndexOf('.');
        return dot >= 0 ? path.slice(dot) : '';
    } catch {
        const fallback = url.split('?')[0].split('#')[0].toLowerCase();
        const dot = fallback.lastIndexOf('.');
        return dot >= 0 ? fallback.slice(dot) : '';
    }
}

/**
 * @param {string} url
 * @returns {'browser' | 'flac' | 'mod' | 'unknown'}
 */
export function classifySongUrl(url) {
    const ext = songExtension(url);
    if (BROWSER_DECODE_EXTENSIONS.has(ext)) {
        return 'browser';
    }
    if (FLAC_EXTENSIONS.has(ext)) {
        return 'flac';
    }
    if (MOD_EXTENSIONS.has(ext)) {
        return 'mod';
    }
    return 'unknown';
}

/**
 * Fetch a remote audio file and decode it with the shared AudioContext worklet path.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function loadBrowserDecodableSong(url) {
    const ready = await ensureWorkletReady();
    if (!ready) {
        console.error('[projectM song loader] worklet not ready for', url);
        return false;
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`fetch failed (${response.status}) for ${url}`);
    }

    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) {
        throw new Error(`empty response for ${url}`);
    }

    const ok = await loadWavBytesIntoWorklet(bytes, true, true);
    if (ok) {
        console.log('[projectM song loader] playing via worklet:', url);
    }
    return ok;
}

/**
 * Open the libopenmpt MOD player popup (xm-player) for tracker modules.
 * @param {string} [trackUrl] Optional module URL (?url= on the player shell).
 */
export function openModSong(trackUrl) {
    const openMod = globalThis.openModPlayer;
    if (typeof openMod === 'function') {
        openMod(trackUrl);
        return;
    }

    if (!trackUrl) {
        console.warn('[projectM song loader] MOD selected but openModPlayer is unavailable');
        return;
    }

    try {
        const modBase = document.getElementById('modPlayerUrl')?.textContent?.trim()
            || 'https://test.1ink.us/xm-player/';
        const target = new URL(modBase, globalThis.location?.href || modBase);
        target.searchParams.set('projectm', '1');
        target.searchParams.set('url', trackUrl);
        const popup = globalThis.open(
            target.toString(),
            'mod-player',
            'width=500,height=650,resizable=yes,scrollbars=no'
        );
        if (!popup) {
            console.warn('[projectM song loader] MOD popup blocked — allow popups for this site');
        }
    } catch (error) {
        console.warn('[projectM song loader] could not open MOD URL:', error);
    }
}

/**
 * Legacy ./flac/ path: open the decoder and post the URL after it can subscribe.
 * @param {string} url
 */
export async function openLegacyFlacDecoder(url) {
    if (typeof globalThis.openWeeksFlacDecoder === 'function') {
        globalThis.openWeeksFlacDecoder();
    }
    if (!nativeBroadcastChannel) {
        return;
    }
    const postUrl = () => {
        bypassSngIntercept = true;
        try {
            const sng = new nativeBroadcastChannel('sng');
            sng.postMessage({ data: url });
        } finally {
            bypassSngIntercept = false;
        }
    };
    await new Promise((resolve) => setTimeout(resolve, 800));
    postUrl();
    setTimeout(postUrl, 1500);
}

/**
 * Route a song URL from the WASM song picker.
 * @param {string} url
 * @returns {Promise<'flac' | 'handled' | 'unknown'>}
 */
export async function routeSongUrl(url) {
    const kind = classifySongUrl(url);
    switch (kind) {
    case 'browser':
        await loadBrowserDecodableSong(url);
        return 'handled';
    case 'mod':
        openModSong(url);
        return 'handled';
    case 'flac':
        try {
            const ok = await loadBrowserDecodableSong(url);
            if (ok) {
                return 'handled';
            }
            console.warn('[projectM song loader] native FLAC decode returned false, falling back to ./flac/');
        } catch (error) {
            console.warn('[projectM song loader] native FLAC decode failed, falling back to ./flac/:', error);
        }
        await openLegacyFlacDecoder(url);
        return 'handled';
    default:
        console.warn('[projectM song loader] unknown song format, trying browser decode:', url);
        try {
            await loadBrowserDecodableSong(url);
            return 'handled';
        } catch (error) {
            console.warn('[projectM song loader] browser decode failed:', error);
            return 'unknown';
        }
    }
}

/**
 * Patch BroadcastChannel so host-side 'sng' posts are routed before the FLAC iframe
 * sees them. Must run before WASM init (same timing as wireFlacDecoderBridge).
 */
export function installSongLoaderInterceptor() {
    if (globalThis.__projectMSongLoaderInstalled) {
        return;
    }
    globalThis.__projectMSongLoaderInstalled = true;

    const OriginalBroadcastChannel = globalThis.BroadcastChannel;
    if (typeof OriginalBroadcastChannel !== 'function') {
        console.warn('[projectM song loader] BroadcastChannel unavailable');
        return;
    }

    nativeBroadcastChannel = OriginalBroadcastChannel;
    function PatchedBroadcastChannel(name) {
        const channel = new OriginalBroadcastChannel(name);
        if (name !== 'sng') {
            return channel;
        }

        const originalPostMessage = channel.postMessage.bind(channel);
        channel.postMessage = (data) => {
            const url = data?.data;
            if (bypassSngIntercept) {
                originalPostMessage(data);
                return;
            }
            if (typeof url !== 'string' || !url) {
                originalPostMessage(data);
                return;
            }

            // Host routes FLAC/MP3 through the worklet (or openLegacyFlacDecoder).
            // Never forward to the legacy ./flac/ 'sng' listener unless routing fails
            // completely — openLegacyFlacDecoder posts with bypassSngIntercept.
            void routeSongUrl(url).catch((error) => {
                console.error('[projectM song loader] route failed, forwarding to ./flac/:', error);
                originalPostMessage(data);
            });
        };
        return channel;
    }

    PatchedBroadcastChannel.prototype = OriginalBroadcastChannel.prototype;
    globalThis.BroadcastChannel = PatchedBroadcastChannel;

    installMusicButtonHandler();
}
