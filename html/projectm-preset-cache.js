// IndexedDB cache for featured-pack preset bytes (offline / fast reload).

const DB_NAME = 'projectm-preset-cache';
const DB_VERSION = 1;
const STORE = 'presets';

function openDb() {
    return new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'id' });
            }
        };
    });
}

export async function cachePreset(id, bytes, meta = {}) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.objectStore(STORE).put({
            id,
            bytes,
            meta,
            cachedAt: Date.now(),
        });
    });
}

export async function getCachedPreset(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

export async function preloadFeaturedPack(manifest, {
    fetchImpl = fetch,
    basesForBase = defaultBasesForBase,
    onProgress,
} = {}) {
    const presets = manifest?.presets || [];
    let done = 0;
    for (const entry of presets) {
        const id = `${entry.base || 'custom_milk_fixed'}::${entry.file}`;
        const existing = await getCachedPreset(id).catch(() => null);
        if (existing?.bytes) {
            done += 1;
            onProgress?.(done, presets.length, entry, 'cached');
            continue;
        }
        const bases = basesForBase(entry.base);
        let bytes = null;
        for (const base of bases) {
            try {
                const sep = base.endsWith('/') ? '' : '/';
                const url = `${base}${sep}${encodeURIComponent(entry.file).replace(/%2F/g, '/')}`;
                const res = await fetchImpl(url);
                if (!res.ok) continue;
                bytes = new Uint8Array(await res.arrayBuffer());
                break;
            } catch {
                // try next base
            }
        }
        if (bytes) {
            await cachePreset(id, bytes, {
                file: entry.file,
                base: entry.base,
                label: entry.label,
                version: entry.version,
            });
        }
        done += 1;
        onProgress?.(done, presets.length, entry, bytes ? 'stored' : 'miss');
    }
    return done;
}

export function defaultBasesForBase(base) {
    if (base === 'weeks_presets') {
        return ['../weeks_presets/', './weeks_presets/', 'https://glsl.1ink.us/weeks_presets/'];
    }
    return ['../custom_milk_fixed/', './custom_milk_fixed/', 'https://glsl.1ink.us/custom_milk/'];
}
