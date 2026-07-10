// Persist favorite presets in localStorage for the B3HD demo library.

const STORAGE_KEY = 'projectm:presetFavorites';

export function presetId(entry) {
    const base = entry?.base || 'custom_milk_fixed';
    const file = entry?.file || entry;
    return `${base}::${file}`;
}

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

export function saveFavorites(set) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
    } catch {
        // quota / private mode
    }
}

export function isFavorite(entry, favorites = getFavorites()) {
    return favorites.has(presetId(entry));
}

export function toggleFavorite(entry, favorites = getFavorites()) {
    const id = presetId(entry);
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    saveFavorites(next);
    return next.has(id);
}
