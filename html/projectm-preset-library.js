// Preset library: filter, favorites, quality-weighted random, multi-base loading.

import { getFavorites, isFavorite, toggleFavorite, presetId } from './projectm-preset-favorites.js';
import { getCachedPreset, cachePreset, defaultBasesForBase } from './projectm-preset-cache.js';
import { updatePresetDisplay } from './projectm-presets.js';
import { loadPresetFile } from './generated/projectm-wasm-api.js';
import { setTransitionDuration, startTransitionWhenReady as startTransition } from './projectm-transitions.js';
import {
    prepareShaderCacheForLoad,
    finalizeShaderCacheForLoad,
    setupShaderTranspileCacheHooks,
} from './projectm-shader-cache.js';

/**
 * @typedef {import('./projectm-preset-types.ts').PresetEntry} PresetEntry
 * @typedef {import('./projectm-preset-types.ts').PresetFilters} PresetFilters
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 */

export const DEFAULT_FEATURED_MANIFEST_URL = './featured_pack_manifest.json';

/**
 * @param {PresetEntry[]} presets
 * @returns {string[]} Sorted unique tags.
 */
export function collectTags(presets) {
    const tags = new Set();
    for (const p of presets) {
        for (const t of p.tags || []) tags.add(t);
    }
    return [...tags].sort();
}

/**
 * @param {PresetEntry} preset
 * @param {PresetFilters} [filters]
 * @param {Set<string>} [favorites]
 * @returns {boolean}
 */
export function matchFilters(preset, filters = {}, favorites = getFavorites()) {
    const q = (filters.query || '').trim().toLowerCase();
    if (q) {
        const hay = [
            preset.label,
            preset.file,
            ...(preset.tags || []),
            preset.author,
            preset.project,
            preset.tier,
            preset.reactivity,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
    }
    if (filters.tag && filters.tag !== 'all') {
        if (!(preset.tags || []).includes(filters.tag)) return false;
    }
    if (filters.tier && filters.tier !== 'all') {
        if (preset.tier !== filters.tier) return false;
    }
    if (filters.reactivity && filters.reactivity !== 'all') {
        if (preset.reactivity !== filters.reactivity) return false;
    }
    if (filters.pack === 'featured' && !preset.featured) return false;
    if (filters.pack === 'favorites' && !isFavorite(preset, favorites)) return false;
    if (filters.onlyOk && preset.status === 'broken') return false;
    if (filters.excludeBroken && preset.status === 'broken') return false;
    return true;
}

/**
 * @param {PresetEntry[]} presets
 * @param {PresetFilters} [filters]
 * @returns {PresetEntry[]}
 */
export function filterPresets(presets, filters = {}) {
    const favorites = getFavorites();
    return presets.filter((p) => matchFilters(p, filters, favorites));
}

/**
 * Weighted random pick favouring known-good and favourited presets.
 *
 * @param {PresetEntry[]} presets
 * @param {object} [options]
 * @param {boolean} [options.onlyOk]
 * @param {boolean} [options.excludeBroken]
 * @param {Set<string>} [options.favorites]
 * @returns {PresetEntry | null} null only when `presets` is empty.
 */
export function pickWeightedRandom(presets, {
    onlyOk = false,
    excludeBroken = true,
    favorites = getFavorites(),
} = {}) {
    let pool = presets.slice();
    if (onlyOk) pool = pool.filter((p) => p.status === 'ok');
    if (excludeBroken) pool = pool.filter((p) => p.status !== 'broken');
    if (!pool.length) pool = presets.filter((p) => p.status !== 'broken');
    if (!pool.length) pool = presets.slice();
    if (!pool.length) return null;

    const weights = pool.map((p) => {
        let w = typeof p.weight === 'number' ? p.weight : 5;
        if (isFavorite(p, favorites)) w += 4;
        if (p.status === 'ok') w += 3;
        return Math.max(1, w);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i += 1) {
        r -= weights[i];
        if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
}

/**
 * @param {string} filename
 * @returns {string}
 */
function safePresetName(filename) {
    return String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Readiness probe for the VFS + preset-load path.
 *
 * `load_preset_file` is a `ccall` entry in cmake/WasmApiManifest.cmake, so the
 * generated `ProjectMModule` type has no `_load_preset_file` member to test even
 * though the symbol is in EXPORTED_FUNCTIONS; `ccall` is what the wrapper
 * actually uses.
 *
 * @param {ProjectMModuleLike | null | undefined} moduleInstance
 * @returns {moduleInstance is import('./generated/projectm-wasm-api.ts').ProjectMModule
 *   & { FS: NonNullable<import('./generated/projectm-wasm-api.ts').ProjectMModule['FS']> }}
 */
function canLoadPresets(moduleInstance) {
    return !!(moduleInstance?.FS && moduleInstance.ccall);
}

/**
 * Fetches (or reuses cached) preset bytes, writes them into the VFS, and loads
 * the preset — optionally starting a crossfade once Preset B is ready.
 *
 * @param {PresetEntry} entry
 * @param {object} [options]
 * @param {ProjectMModuleLike} [options.module]
 * @param {((opts?: { module?: ProjectMModuleLike | null, timeoutFrames?: number, durationSec?: number }) => Promise<boolean>) | null} [options.startTransitionWhenReady]
 * @param {number} [options.transitionDurationSec]
 * @param {boolean} [options.updateDisplay]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string[]} [options.bases] Overrides the default base list.
 * @returns {Promise<{ vfsPath: string, filename: string, entry: PresetEntry }>}
 */
export async function loadPresetEntry(entry, {
    module,
    startTransitionWhenReady = startTransition,
    transitionDurationSec = 1.5,
    updateDisplay = true,
    fetchImpl = fetch,
    bases,
} = {}) {
    if (!canLoadPresets(module)) {
        throw new Error('Module not ready');
    }

    const filename = String(entry.file).split('/').pop() ?? String(entry.file);
    const id = presetId(entry);
    /** @type {Uint8Array | null} */
    let bytes = null;

    const cached = await getCachedPreset(id).catch(() => null);
    if (cached?.bytes) bytes = cached.bytes;

    const candidateBases = bases || defaultBasesForBase(entry.base || 'custom_milk_fixed');
    if (!bytes) {
        /** @type {unknown} */
        let lastError = null;
        for (const base of candidateBases) {
            try {
                const sep = base.endsWith('/') ? '' : '/';
                const res = await fetchImpl(`${base}${sep}${encodeURIComponent(filename)}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                // Uint8Array, not Uint8ClampedArray: the cached path, cachePreset(),
                // FS.writeFile() and prepareShaderCacheForLoad() all take Uint8Array.
                bytes = new Uint8Array(await res.arrayBuffer());
                break;
            } catch (error) {
                lastError = error;
            }
        }
        if (!bytes) throw lastError || new Error(`Could not fetch ${filename}`);
        cachePreset(id, bytes, {
            file: entry.file,
            base: entry.base || 'custom_milk_fixed',
            label: entry.label,
        }).catch(() => {});
    }

    setupShaderTranspileCacheHooks();
    setTransitionDuration(module, transitionDurationSec);
    const vfsPath = `/presets/${entry.base || 'custom'}_${safePresetName(filename)}`;
    module.FS.writeFile(vfsPath, bytes);
    await prepareShaderCacheForLoad(module, bytes);
    try {
        loadPresetFile(module, vfsPath);
        if (startTransitionWhenReady) {
            await startTransitionWhenReady({ module, durationSec: transitionDurationSec });
        }
    } finally {
        finalizeShaderCacheForLoad(module);
    }
    if (updateDisplay) updatePresetDisplay(entry.label || filename);
    return { vfsPath, filename, entry };
}

export async function fetchFeaturedManifest({
    url = DEFAULT_FEATURED_MANIFEST_URL,
    fetchImpl = fetch,
} = {}) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Featured pack manifest HTTP ${res.status}`);
    return res.json();
}

export { getFavorites, isFavorite, toggleFavorite, presetId };
