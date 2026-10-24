// projectm-textures.js
//
// Page-side texture loading. Presets that sample image files (`sampler_*` with a
// file name, Milkdrop's `rand` textures) find them under the engine's `textures`
// search path, i.e. the VFS directory `/textures`. Something has to put the files
// there; this module fetches the page's texture directory and writes each image
// in.
//
// This used to be EM_JS in src/wasm/WasmJsBindings.cpp: it read `#textureDir`
// with innerHTML, listed the directory with XMLHttpRequest and wrote `#stat`.
// The engine now only tells the page what happened; fetching and status text are
// the page's job.
//
// Main-thread engines only. In the render-worker topology the VFS lives in the
// worker and there is no message that writes a bare file (writePreset also loads
// it as a preset), which is what the old DOM-gated scan did as well: nothing.

/** File extensions the engine's texture loader can decode. */
export const TEXTURE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga', 'dds']);

/** Used when the page has no `#textureDir` element. Relative to the page. */
export const DEFAULT_TEXTURE_DIRECTORY = 'textures/';

/** The engine's texture search path (`projectm_set_texture_search_paths`). */
export const TEXTURE_VFS_DIRECTORY = '/textures';

/**
 * Whether a link in a directory index points at a texture image. Keyed on the
 * file extension rather than the listing's layout: an Apache index opens with
 * sort-column and "Parent Directory" links, and skipping them by position broke
 * on any other server or index option.
 *
 * @param {string} href
 */
export function isTextureFile(href) {
    const path = href.split('?')[0];
    const dot = path.lastIndexOf('.');
    return dot !== -1 && TEXTURE_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/**
 * Absolute URLs of the texture images linked from a directory index page.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @returns {string[]}
 */
export function parseTextureListing(html, baseUrl) {
    /** @type {Set<string>} */
    const urls = new Set();
    const anchorRe = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = anchorRe.exec(html)) !== null) {
        const href = match[1];
        if (href.startsWith('?') || !isTextureFile(href)) {
            continue;
        }
        try {
            urls.add(new URL(href, baseUrl).href);
        } catch {
            // skip a malformed href
        }
    }
    return [...urls];
}

/**
 * The VFS file name for a texture URL: its last path segment, decoded. Null for
 * a name that is not a plain file name (a decoded `/` or `..` would write
 * outside `/textures`).
 *
 * @param {string} url
 * @returns {string | null}
 */
export function textureFileName(url) {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    let name = last;
    try {
        name = decodeURIComponent(last);
    } catch {
        // keep the raw segment
    }
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        return null;
    }
    return name;
}

/**
 * The page's texture directory as an absolute URL: the text of its
 * `#textureDir` element (the hidden config element the host pages carry, which
 * `applyWeeksOnFireDomConfig` repoints in weeks mode), else `textures/`.
 *
 * @param {Pick<Document, 'getElementById'> | null | undefined} documentRef
 * @param {string} [locationHref] What a relative directory resolves against.
 * @returns {string}
 */
export function resolveTextureDirectory(documentRef, locationHref = globalThis.location?.href) {
    const raw = documentRef?.getElementById('textureDir')?.textContent?.trim() || DEFAULT_TEXTURE_DIRECTORY;
    const withSlash = raw.endsWith('/') ? raw : `${raw}/`;
    try {
        return new URL(withSlash, locationHref || 'https://localhost/').href;
    } catch {
        return withSlash;
    }
}

/**
 * Whether the loaded bundle's own glue still scans textures and seeds the weeks
 * playlist. Bundles built before WasmJsBindings.cpp lost its XMLHttpRequest
 * loaders did that on the main thread in `init()`, and installed
 * `globalThis.loadRandomWeeksPreset` while at it; a page that also loaded the
 * same files would download them twice (and seed two playlists).
 *
 * @param {object} [host] The engine's global scope; the page's `window`.
 */
export function bundleScansAssets(host = globalThis) {
    return typeof (/** @type {any} */ (host)).loadRandomWeeksPreset === 'function';
}

/**
 * Capture pages (`?capture=1`, or `__projectMCaptureMode` set before the module
 * loads) keep out of non-deterministic network I/O.
 *
 * @param {{ __projectMCaptureMode?: boolean, location?: { search?: string } } | null | undefined} windowRef
 */
export function isCaptureMode(windowRef) {
    if (windowRef?.__projectMCaptureMode === true) {
        return true;
    }
    try {
        const capture = new URLSearchParams(windowRef?.location?.search || '').get('capture');
        return capture === '1' || capture === 'true';
    } catch {
        return false;
    }
}

/**
 * @typedef {object} TextureLoadResult
 * @property {string[]} urls Every texture the directory listing linked.
 * @property {number} loaded Written to the VFS.
 * @property {number} failed Fetched or written unsuccessfully (each warned about).
 */

/**
 * List a texture directory and hand every image in it to `writeFile`. A missing
 * or unlistable directory is "no textures", not an error: a page that ships
 * none is normal. A single texture that fails does not stop the others.
 *
 * @param {object} options
 * @param {string} options.baseUrl Absolute URL of the directory index.
 * @param {(name: string, bytes: Uint8Array) => void} options.writeFile
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<TextureLoadResult>}
 */
export async function loadTextureDirectory({ baseUrl, writeFile, fetchImpl = fetch }) {
    const listing = await fetchImpl(baseUrl);
    if (!listing.ok) {
        console.debug('[projectM textures] no texture directory at', baseUrl, listing.status);
        return { urls: [], loaded: 0, failed: 0 };
    }
    const urls = parseTextureListing(await listing.text(), baseUrl);
    let loaded = 0;
    let failed = 0;
    await Promise.all(urls.map(async (url) => {
        try {
            const name = textureFileName(url);
            if (!name) {
                throw new Error('not a plain file name');
            }
            const response = await fetchImpl(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            writeFile(name, new Uint8Array(await response.arrayBuffer()));
            loaded += 1;
        } catch (error) {
            failed += 1;
            console.warn(`[projectM textures] ${url}:`, error);
        }
    }));
    console.log(`[projectM textures] ${loaded}/${urls.length} textures from ${baseUrl}`);
    return { urls, loaded, failed };
}

/**
 * @typedef {object} TextureVfs
 * @property {(path: string, data: Uint8Array) => void} writeFile
 * @property {(path: string) => void} [mkdirTree]
 */

/**
 * Fill the engine's `/textures` from the page's texture directory. Resolves
 * null when there is nothing to do: a capture page, a bundle that scans the
 * directory itself, or an engine whose VFS is not on this thread. Never rejects; a failed scan is logged.
 *
 * @param {object} options
 * @param {{ FS?: unknown } | null | undefined} options.module The main-thread module, if any.
 * @param {Pick<Document, 'getElementById'> | null} [options.documentRef]
 * @param {{ __projectMCaptureMode?: boolean, location?: { search?: string } } | null} [options.windowRef]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<TextureLoadResult | null>}
 */
export async function loadPageTextures({
    module,
    documentRef = typeof document !== 'undefined' ? document : null,
    windowRef = typeof window !== 'undefined' ? window : null,
    fetchImpl,
}) {
    if (isCaptureMode(windowRef)) {
        console.log('[projectM textures] capture mode: skipping the texture scan.');
        return null;
    }
    if (bundleScansAssets(windowRef ?? globalThis)) {
        console.log('[projectM textures] this bundle scans textures itself; not loading them twice.');
        return null;
    }
    const fs = /** @type {TextureVfs | undefined} */ (module?.FS);
    if (!fs) {
        return null;
    }
    try {
        fs.mkdirTree?.(TEXTURE_VFS_DIRECTORY);
    } catch {
        // Already there; a real problem shows up in the writes below.
    }
    try {
        return await loadTextureDirectory({
            baseUrl: resolveTextureDirectory(documentRef),
            writeFile: (name, bytes) => fs.writeFile(`${TEXTURE_VFS_DIRECTORY}/${name}`, bytes),
            ...(fetchImpl ? { fetchImpl } : {}),
        });
    } catch (error) {
        console.warn('[projectM textures] texture scan failed:', error);
        return null;
    }
}
