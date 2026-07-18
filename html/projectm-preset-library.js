// Preset library: filter, favorites, quality-weighted random, multi-base loading.

import { getFavorites, isFavorite, toggleFavorite, presetId } from './projectm-preset-favorites.js';
import { getCachedPreset, defaultBasesForBase } from './projectm-preset-cache.js';
import { updatePresetDisplay } from './projectm-presets.js';
import { loadPresetFile } from './generated/projectm-wasm-api.js';
import { setTransitionDuration, startTransitionWhenReady as startTransition } from './projectm-transitions.js';

export const DEFAULT_FEATURED_MANIFEST_URL = './featured_pack_manifest.json';

export function collectTags(presets) {
    const tags = new Set();
    for (const p of presets) {
        for (const t of p.tags || []) tags.add(t);
    }
    return [...tags].sort();
}

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

export function filterPresets(presets, filters = {}) {
    const favorites = getFavorites();
    return presets.filter((p) => matchFilters(p, filters, favorites));
}

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

function safePresetName(filename) {
    return String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function loadPresetEntry(entry, {
    module,
    startTransitionWhenReady = startTransition,
    transitionDurationSec = 1.5,
    updateDisplay = true,
    fetchImpl = fetch,
    bases,
} = {}) {
    if (!module?.FS || !module._load_preset_file) {
        throw new Error('Module not ready');
    }

    const filename = String(entry.file).split('/').pop();
    const id = presetId(entry);
    let bytes = null;

    const cached = await getCachedPreset(id).catch(() => null);
    if (cached?.bytes) bytes = cached.bytes;

    const candidateBases = bases || defaultBasesForBase(entry.base || 'custom_milk_fixed');
    if (!bytes) {
        let lastError = null;
        for (const base of candidateBases) {
            try {
                const sep = base.endsWith('/') ? '' : '/';
                const res = await fetchImpl(`${base}${sep}${encodeURIComponent(filename)}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                bytes = new Uint8ClampedArray(await res.arrayBuffer());
                break;
            } catch (error) {
                lastError = error;
            }
        }
        if (!bytes) throw lastError || new Error(`Could not fetch ${filename}`);
    }

    setTransitionDuration(module, transitionDurationSec);
    const vfsPath = `/presets/${entry.base || 'custom'}_${safePresetName(filename)}`;
    module.FS.writeFile(vfsPath, bytes);
    loadPresetFile(module, vfsPath);
    if (startTransitionWhenReady) {
        await startTransitionWhenReady({ module, durationSec: transitionDurationSec });
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
