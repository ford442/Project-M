// Host-side song routing for Start/Change Song (musicBtn).
//
// WASM glue (WasmJsBindings.cpp) picks a random URL from #songDir and posts it on
// BroadcastChannel('sng'). The same-origin ./flac/ decoder iframe converts FLAC →
// WAV and posts back on BroadcastChannel('file') → worklet via pl().
//
// That FLAC path only works when /flac/ is deployed on the *same origin* as the
// host (BroadcastChannel is not cross-origin). Staging hosts (go/test.1ink.us) and
// local dev often lack ./flac/, so FLAC fails silently.
//
// This module intercepts outgoing 'sng' messages and handles browser-decodable
// formats (MP3, WAV, OGG, M4A) directly via fetch + decodeAudioData → worklet,
// without the FLAC iframe. MOD tracker files are routed to the MOD player shell.

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
 * Pick and route a random track from the host-side catalog (mp3/mod/flac folders).
 * @returns {Promise<boolean>}
 */
export async function playRandomCatalogSong() {
    const catalog = await ensureSongCatalog();
    if (!catalog.length) {
        return false;
    }
    const url = catalog[Math.floor(Math.random() * catalog.length)];
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

    btn.addEventListener('click', (event) => {
        void (async () => {
            const played = await playRandomCatalogSong();
            if (played) {
                event.stopImmediatePropagation();
            }
        })();
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
        if (typeof globalThis.openWeeksFlacDecoder === 'function') {
            globalThis.openWeeksFlacDecoder();
        }
        if (nativeBroadcastChannel) {
            bypassSngIntercept = true;
            try {
                const sng = new nativeBroadcastChannel('sng');
                sng.postMessage({ data: url });
            } finally {
                bypassSngIntercept = false;
            }
        }
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

            void routeSongUrl(url).then((result) => {
                if (result === 'flac') {
                    originalPostMessage(data);
                }
            }).catch((error) => {
                console.error('[projectM song loader] route failed:', error);
            });
        };
        return channel;
    }

    PatchedBroadcastChannel.prototype = OriginalBroadcastChannel.prototype;
    globalThis.BroadcastChannel = PatchedBroadcastChannel;

    installMusicButtonHandler();
}
