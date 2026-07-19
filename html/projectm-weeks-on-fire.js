// "Weeks on fire" demo mode: texture-heavy weeks_presets + weeks_textures + weeks_songs.
// Enable with ?mode=weeks_on_fire on projectm.1ink.us (or any host that wires this module).

export const WEEKS_ON_FIRE_MODE = 'weeks_on_fire';

export const DEFAULT_WEEKS_PATHS = {
    presets: './weeks_presets/',
    textures: './weeks_textures/',
    songs: './weeks_songs/',
};

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
 * Point the legacy emscripten DOM scanner at the weeks_* folders before WASM init.
 * @param {Document} [documentRef]
 * @param {{ presets?: string, textures?: string, songs?: string }} [paths]
 */
export function applyWeeksOnFireDomConfig(documentRef = document, paths = DEFAULT_WEEKS_PATHS) {
    const doc = documentRef;
    const merged = { ...DEFAULT_WEEKS_PATHS, ...paths };

    function setHidden(id, value) {
        const el = doc.getElementById(id);
        if (el) el.textContent = value;
    }

    setHidden('textureDir', merged.textures);
    setHidden('songDir', merged.songs);
    setHidden('weeksPresetDir', merged.presets);
    setHidden('presetDir', 'weeks_presets');

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
        const anchors = doc.querySelectorAll('pre a');
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
 * Host-side helper when emscripten globals are unavailable (unit tests / future hosts).
 * @param {{ getModule: () => any, startTransitionWhenReady?: Function, count?: number, fetchImpl?: typeof fetch }} opts
 */
export async function bootstrapWeeksOnFirePresets({
    getModule,
    startTransitionWhenReady,
    count = 5,
    fetchImpl = fetch,
    presetBase = DEFAULT_WEEKS_PATHS.presets,
} = {}) {
    const module = getModule();
    if (!module?.FS || !module._load_preset_file) {
        throw new Error('Module not ready for weeks preset bootstrap');
    }

    const base = presetBase.endsWith('/') ? presetBase : `${presetBase}/`;
    const listingRes = await fetchImpl(base);
    if (!listingRes.ok) {
        throw new Error(`Failed to list weeks presets (${listingRes.status})`);
    }
    const urls = parseMilkDirectoryListing(await listingRes.text(), listingRes.url);
    if (!urls.length) {
        throw new Error('No .milk presets found in weeks_presets');
    }

    const picks = [];
    const pool = urls.slice();
    const want = Math.min(count, pool.length);
    for (let i = 0; i < want; i += 1) {
        const idx = Math.floor(Math.random() * pool.length);
        picks.push(pool.splice(idx, 1)[0]);
    }

    const vfsPaths = [];
    for (let i = 0; i < picks.length; i += 1) {
        const url = picks[i];
        const res = await fetchImpl(url);
        if (!res.ok) continue;
        const bytes = new Uint8ClampedArray(await res.arrayBuffer());
        const vfsPath = `/presets/weeks_host_${i}.milk`;
        module.FS.writeFile(vfsPath, bytes);
        vfsPaths.push({ vfsPath, label: url.split('/').pop() });
    }

    if (!vfsPaths.length) {
        throw new Error('Failed to download any weeks presets');
    }

    module.ccall('load_preset_file', null, ['string'], [vfsPaths[0].vfsPath]);
    for (let i = 1; i < vfsPaths.length; i += 1) {
        module.ccall('add_preset_file', null, ['string'], [vfsPaths[i].vfsPath]);
    }
    if (startTransitionWhenReady) {
        await startTransitionWhenReady({ module, durationSec: 1.5 });
    }
    return vfsPaths;
}
