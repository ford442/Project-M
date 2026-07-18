// IndexedDB cache for transpiled preset GLSL (warp + composite).
// Skips HLSL parse/transpile on repeat visits; glCompileShader still runs each session.

import { PROJECTM_WASM_VERSION } from './projectm-wasm-version.js';
import {
    openPresetCacheDb,
    SHADER_STORE,
    touchShaderCacheEntry,
} from './projectm-preset-cache.js';
import {
    getGlslGeneratorVersion,
    shaderCacheBeginLoad,
    shaderCacheEndLoad,
    shaderCacheImportGlsl,
} from './generated/projectm-wasm-api.js';

const ENGINE_VERSION_KEY = 'projectm:shaderCacheEngineVersion';
const MAX_SHADER_CACHE_ENTRIES = 96;
const MAX_SHADER_CACHE_BYTES = 48 * 1024 * 1024;

/** @type {Map<string, { warp?: string, composite?: string }>} */
const pendingShaderWrites = new Map();

let hooksInstalled = false;

function bytesForStrings(...parts) {
    let total = 0;
    for (const part of parts) {
        if (part) total += new TextEncoder().encode(part).byteLength;
    }
    return total;
}

/**
 * SHA-256 hex digest of preset bytes (content-addressed cache key component).
 * @param {Uint8Array} bytes
 */
export async function hashPresetBytes(bytes) {
    if (!globalThis.crypto?.subtle) {
        // Fallback: length + first/last bytes (weaker, but avoids blocking loads).
        const head = bytes.length > 0 ? bytes[0] : 0;
        const tail = bytes.length > 1 ? bytes[bytes.length - 1] : 0;
        return `len${bytes.length}-h${head}-t${tail}`;
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cache key: wasm bundle version + GLSL generator version + preset content hash.
 */
export function buildShaderCacheKey(contentHash, {
    wasmVersion = PROJECTM_WASM_VERSION,
    glslVersion,
} = {}) {
    const glsl = glslVersion ?? '?';
    return `shader::${wasmVersion}::${glsl}::${contentHash}`;
}

export async function getShaderCacheKeyForBytes(bytes, module) {
    const contentHash = await hashPresetBytes(bytes);
    const glslVersion = module ? getGlslGeneratorVersion(module) : '?';
    return buildShaderCacheKey(contentHash, { glslVersion });
}

export async function ensureShaderCacheEngineVersion(wasmVersion = PROJECTM_WASM_VERSION) {
    try {
        const stored = localStorage.getItem(ENGINE_VERSION_KEY);
        if (stored === wasmVersion) return;
        const db = await openPresetCacheDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(SHADER_STORE, 'readwrite');
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
            tx.objectStore(SHADER_STORE).clear();
        });
        localStorage.setItem(ENGINE_VERSION_KEY, wasmVersion);
    } catch {
        // IndexedDB or localStorage unavailable — cache stays in-memory only.
    }
}

export async function getCachedTranspiledShaders(cacheKey) {
    const db = await openPresetCacheDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SHADER_STORE, 'readwrite');
        const store = tx.objectStore(SHADER_STORE);
        const req = store.get(cacheKey);
        req.onsuccess = () => {
            const row = req.result;
            if (row?.warp && row?.composite) {
                row.lastUsedAt = Date.now();
                store.put(row);
                resolve({ warp: row.warp, composite: row.composite });
                return;
            }
            resolve(null);
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function evictShaderCacheIfNeeded(db, incomingBytes = 0) {
    const tx = db.transaction(SHADER_STORE, 'readonly');
    const rows = await new Promise((resolve, reject) => {
        const out = [];
        const req = tx.objectStore(SHADER_STORE).openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                out.push(cursor.value);
                cursor.continue();
            }
        };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
    });

    let totalBytes = rows.reduce((sum, row) => sum + (row.sizeBytes || 0), 0);
    rows.sort((a, b) => (a.lastUsedAt || a.cachedAt || 0) - (b.lastUsedAt || b.cachedAt || 0));

    const victims = [];
    while (rows.length - victims.length > 0
        && (rows.length - victims.length >= MAX_SHADER_CACHE_ENTRIES
            || totalBytes + incomingBytes > MAX_SHADER_CACHE_BYTES)) {
        const victim = rows[victims.length];
        victims.push(victim.id);
        totalBytes -= victim.sizeBytes || 0;
    }

    if (!victims.length) return;

    await new Promise((resolve, reject) => {
        const evictTx = db.transaction(SHADER_STORE, 'readwrite');
        evictTx.oncomplete = () => resolve();
        evictTx.onerror = () => reject(evictTx.error);
        const evictStore = evictTx.objectStore(SHADER_STORE);
        for (const id of victims) evictStore.delete(id);
    });
}

export async function putCachedTranspiledShaders(cacheKey, { warp, composite }, meta = {}) {
    if (!warp || !composite) return false;
    const sizeBytes = bytesForStrings(warp, composite);
    const db = await openPresetCacheDb();
    await evictShaderCacheIfNeeded(db, sizeBytes);
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SHADER_STORE, 'readwrite');
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.objectStore(SHADER_STORE).put({
            id: cacheKey,
            warp,
            composite,
            meta,
            sizeBytes,
            cachedAt: Date.now(),
            lastUsedAt: Date.now(),
        });
    });
}

function queueShaderWrite(cacheKey, kind, glsl) {
    if (!cacheKey || !glsl) return;
    const bucket = pendingShaderWrites.get(cacheKey) || {};
    if (kind === 0) bucket.warp = glsl;
    else if (kind === 1) bucket.composite = glsl;
    pendingShaderWrites.set(cacheKey, bucket);
    const entry = pendingShaderWrites.get(cacheKey);
    if (entry?.warp && entry?.composite) {
        putCachedTranspiledShaders(cacheKey, entry).catch(() => {});
        pendingShaderWrites.delete(cacheKey);
    }
}

/**
 * Wire window.pmOnTranspiledShaderStored once per page load.
 */
export function setupShaderTranspileCacheHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;
    ensureShaderCacheEngineVersion().catch(() => {});
    window.pmOnTranspiledShaderStored = (cacheKey, kind, glsl) => {
        queueShaderWrite(cacheKey, kind, glsl);
        touchShaderCacheEntry(cacheKey).catch(() => {});
    };
}

/**
 * Prepare WASM to use cached transpiled GLSL for the next preset load.
 * @returns {Promise<string|null>} active cache key
 */
export async function prepareShaderCacheForLoad(module, bytes) {
    if (!module?._shader_cache_begin_load) return null;
    setupShaderTranspileCacheHooks();
    const cacheKey = await getShaderCacheKeyForBytes(bytes, module);
    shaderCacheBeginLoad(module, cacheKey);
    const cached = await getCachedTranspiledShaders(cacheKey).catch(() => null);
    if (cached) {
        shaderCacheImportGlsl(module, 0, cached.warp);
        shaderCacheImportGlsl(module, 1, cached.composite);
    }
    return cacheKey;
}

export function finalizeShaderCacheForLoad(module) {
    if (module?._shader_cache_end_load) {
        shaderCacheEndLoad(module);
    }
}

/**
 * Measure cold vs warm preset-switch time for heavy presets.
 * @param {*} module Emscripten module
 * @param {Array<{file:string,base?:string,label?:string}>} entries
 */
export async function measurePresetSwitchTimings(module, entries, {
    loadEntry,
    clearShaderCache = false,
} = {}) {
    if (!loadEntry) {
        throw new Error('measurePresetSwitchTimings requires loadEntry');
    }
    const results = [];
    for (const entry of entries) {
        if (clearShaderCache) {
            const db = await openPresetCacheDb().catch(() => null);
            if (db) {
                await new Promise((resolve) => {
                    const tx = db.transaction(SHADER_STORE, 'readwrite');
                    tx.oncomplete = () => { db.close(); resolve(); };
                    tx.objectStore(SHADER_STORE).clear();
                });
            }
        }
        const coldStart = performance.now();
        await loadEntry(entry, { module, updateDisplay: false, startTransitionWhenReady: null });
        const coldMs = performance.now() - coldStart;

        const warmStart = performance.now();
        await loadEntry(entry, { module, updateDisplay: false, startTransitionWhenReady: null });
        const warmMs = performance.now() - warmStart;

        results.push({
            preset: entry.label || entry.file,
            coldMs: Math.round(coldMs),
            warmMs: Math.round(warmMs),
            savedMs: Math.round(coldMs - warmMs),
        });
    }
    const summary = { presets: results, timestamp: new Date().toISOString() };
    console.log('[projectM preset-switch benchmark]', JSON.stringify(summary));
    window.postMessage({ type: 'pm-preset-switch-benchmark', result: summary }, '*');
    return summary;
}
