// IndexedDB cache for preset bytes (featured pack, favorites) and transpiled GLSL.

const DB_NAME = 'projectm-preset-cache';
const DB_VERSION = 2;
export const PRESET_STORE = 'presets';
export const SHADER_STORE = 'shaders';

export function openPresetCacheDb() {
    return new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(PRESET_STORE)) {
                db.createObjectStore(PRESET_STORE, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(SHADER_STORE)) {
                db.createObjectStore(SHADER_STORE, { keyPath: 'id' });
            }
        };
    });
}

/** @deprecated use openPresetCacheDb */
function openDb() {
    return openPresetCacheDb();
}

export async function cachePreset(id, bytes, meta = {}) {
    const db = await openPresetCacheDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PRESET_STORE, 'readwrite');
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.objectStore(PRESET_STORE).put({
            id,
            bytes,
            meta,
            cachedAt: Date.now(),
            lastUsedAt: Date.now(),
        });
    });
}

export async function getCachedPreset(id) {
    const db = await openPresetCacheDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PRESET_STORE, 'readwrite');
        const store = tx.objectStore(PRESET_STORE);
        const req = store.get(id);
        req.onsuccess = () => {
            const row = req.result;
            if (row?.bytes) {
                row.lastUsedAt = Date.now();
                store.put(row);
            }
        };
        tx.oncomplete = () => {
            db.close();
            resolve(req.result || null);
        };
        tx.onerror = () => { db.close(); reject(req.error); };
    });
}

export async function touchShaderCacheEntry(id) {
    const db = await openPresetCacheDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SHADER_STORE, 'readwrite');
        const store = tx.objectStore(SHADER_STORE);
        const req = store.get(id);
        req.onsuccess = () => {
            const row = req.result;
            if (row) {
                row.lastUsedAt = Date.now();
                store.put(row);
            }
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function fetchPresetBytes(entry, { fetchImpl = fetch, basesForBase = defaultBasesForBase } = {}) {
    const bases = basesForBase(entry.base);
    for (const base of bases) {
        try {
            const sep = base.endsWith('/') ? '' : '/';
            const url = `${base}${sep}${encodeURIComponent(entry.file).replace(/%2F/g, '/')}`;
            const res = await fetchImpl(url);
            if (!res.ok) continue;
            return new Uint8Array(await res.arrayBuffer());
        } catch {
            // try next base
        }
    }
    return null;
}

async function preloadPresetEntries(presets, {
    fetchImpl = fetch,
    basesForBase = defaultBasesForBase,
    onProgress,
    label = 'preload',
} = {}) {
    let done = 0;
    for (const entry of presets) {
        const id = `${entry.base || 'custom_milk_fixed'}::${entry.file}`;
        const existing = await getCachedPreset(id).catch(() => null);
        if (existing?.bytes) {
            done += 1;
            onProgress?.(done, presets.length, entry, 'cached');
            continue;
        }
        const bytes = await fetchPresetBytes(entry, { fetchImpl, basesForBase });
        if (bytes) {
            await cachePreset(id, bytes, {
                file: entry.file,
                base: entry.base,
                label: entry.label,
                version: entry.version,
            });
        }
        done += 1;
        onProgress?.(done, presets.length, entry, bytes ? 'stored' : 'miss', label);
    }
    return done;
}

export async function preloadFeaturedPack(manifest, opts = {}) {
    const presets = manifest?.presets || [];
    return preloadPresetEntries(presets, { ...opts, label: 'featured' });
}

/**
 * Preload .milk bytes for favorite / Signature Series entries into IndexedDB.
 * @param {Array} allPresets Full manifest preset list
 * @param {Set<string>|string[]} favoriteIds presetId() strings
 */
export async function preloadFavoritePresets(allPresets, favoriteIds, opts = {}) {
    const favSet = favoriteIds instanceof Set ? favoriteIds : new Set(favoriteIds || []);
    const presets = (allPresets || []).filter((entry) => {
        const id = `${entry.base || 'custom_milk_fixed'}::${entry.file}`;
        return favSet.has(id);
    });
    if (!presets.length) return 0;
    return preloadPresetEntries(presets, { ...opts, label: 'favorites' });
}

export function defaultBasesForBase(base) {
    if (base === 'weeks_presets') {
        return ['../weeks_presets/', './weeks_presets/', 'https://glsl.1ink.us/weeks_presets/'];
    }
    return ['../custom_milk_fixed/', './custom_milk_fixed/', 'https://glsl.1ink.us/custom_milk/'];
}
