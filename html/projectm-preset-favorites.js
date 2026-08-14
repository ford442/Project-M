// Persist favorite presets in localStorage for the B3HD demo library.

/**
 * @typedef {import('./projectm-preset-types.ts').PresetEntryLike} PresetEntryLike
 */

const STORAGE_KEY = 'projectm:presetFavorites';

/**
 * Stable identity for a preset, used as the localStorage favorite key.
 *
 * @param {PresetEntryLike} entry Manifest entry, or a bare filename.
 * @returns {string} `<base>::<file>`
 */
export function presetId(entry) {
    const base = (typeof entry === 'object' && entry?.base) || 'custom_milk_fixed';
    const file = typeof entry === 'object' ? entry?.file : entry;
    return `${base}::${file}`;
}

/** @returns {Set<string>} Favorite {@link presetId} strings. */
export function getFavorites() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch {
        return new Set();
    }
}

/** @param {Set<string>} set */
export function saveFavorites(set) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
    } catch {
        // quota / private mode
    }
}

/**
 * @param {PresetEntryLike} entry
 * @param {Set<string>} [favorites]
 * @returns {boolean}
 */
export function isFavorite(entry, favorites = getFavorites()) {
    return favorites.has(presetId(entry));
}

/**
 * Flips the favorite bit for `entry` and persists the result.
 *
 * @param {PresetEntryLike} entry
 * @param {Set<string>} [favorites]
 * @returns {boolean} true if the preset is a favorite after the toggle.
 */
export function toggleFavorite(entry, favorites = getFavorites()) {
    const id = presetId(entry);
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    saveFavorites(next);
    return next.has(id);
}
