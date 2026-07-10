// Bump when publishing a new threaded WASM smoke build. Files must exist under ./pm/
// after deploy (see scripts/prepare_deploy_bundle.sh and docs/DEPLOYMENT.md).
export const PROJECTM_WASM_BUNDLE = 'projectm-v.034-thread';
export const PROJECTM_WASM_SCRIPT_PM = `./pm/${PROJECTM_WASM_BUNDLE}.1ijs`;
export const PROJECTM_WASM_SCRIPT_ROOT = `./${PROJECTM_WASM_BUNDLE}.1ijs`;

// Preferred path (pm/ mirror). Hosts should call resolveWasmScriptUrl() or
// loadProjectMWasmScript() so production still works when only root artifacts exist.
export const PROJECTM_WASM_SCRIPT = PROJECTM_WASM_SCRIPT_PM;

let resolvedWasmScript;

function resolveBaseUrl(documentRef, baseUrl) {
    if (baseUrl) {
        return baseUrl;
    }
    if (documentRef?.baseURI) {
        return documentRef.baseURI;
    }
    if (typeof location !== 'undefined') {
        return location.href;
    }
    return undefined;
}

/**
 * Resolves the threaded WASM glue script URL. Tries ./pm/ first (canonical deploy
 * layout), then falls back to ./ at the site root for legacy uploads that only
 * pushed projectm-v.*-thread.{1ijs,wasm} without the pm/ mirror.
 */
export async function resolveWasmScriptUrl({
    documentRef = typeof document !== 'undefined' ? document : undefined,
    fetchFn = fetch,
    baseUrl,
    pmScript = PROJECTM_WASM_SCRIPT_PM,
    rootScript = PROJECTM_WASM_SCRIPT_ROOT,
    forceRefresh = false,
} = {}) {
    if (!forceRefresh && resolvedWasmScript) {
        return resolvedWasmScript;
    }

    const resolvedBase = resolveBaseUrl(documentRef, baseUrl);
    const candidates = [pmScript, rootScript];

    for (const candidate of candidates) {
        const url = resolvedBase ? new URL(candidate, resolvedBase).href : candidate;
        try {
            const response = await fetchFn(url, { method: 'HEAD', cache: 'no-store' });
            if (response.ok) {
                resolvedWasmScript = candidate;
                return candidate;
            }
        } catch {
            // Try the next candidate.
        }
    }

    // Prefer the legacy root layout when pm/ is missing (common on partial deploys).
    resolvedWasmScript = rootScript;
    return rootScript;
}

export function loadScript(src, {
    documentRef = typeof document !== 'undefined' ? document : undefined,
    async = true,
    defer = false,
    charset = 'utf-8',
    type = 'text/javascript'
} = {}) {
    return new Promise((resolve, reject) => {
        const script = documentRef.createElement('script');
        script.src = src;
        script.async = async;
        script.defer = defer;
        script.charset = charset;
        script.type = type;
        script.onload = () => resolve(script);
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        documentRef.body.appendChild(script);
    });
}

export async function loadProjectMWasmScript(options = {}) {
    const scriptSrc = await resolveWasmScriptUrl(options);
    return loadScript(scriptSrc, options);
}

export async function createProjectMModule({
    scriptSrc,
    createModuleName = 'createModule',
    windowRef = window,
    ...resolveOptions
} = {}) {
    const resolvedScript = scriptSrc || await resolveWasmScriptUrl(resolveOptions);
    if (typeof windowRef[createModuleName] !== 'function') {
        await loadScript(resolvedScript);
    }
    if (typeof windowRef[createModuleName] !== 'function') {
        throw new Error(`${createModuleName} is not available after loading ${resolvedScript}`);
    }
    return windowRef[createModuleName]();
}

export function syncModuleSize({
    module = globalThis.Module,
    container = document.querySelector('#contain1'),
    mainCanvas = document.querySelector('#mcanvas'),
    secondaryCanvas = document.querySelector('#scanvas'),
    aspectCorrection
} = {}) {
    if (!module || !container || !mainCanvas || !secondaryCanvas) return false;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    mainCanvas.width = width;
    mainCanvas.height = height;
    secondaryCanvas.width = width;
    secondaryCanvas.height = height;

    mainCanvas.style.width = rect.width + 'px';
    mainCanvas.style.height = rect.height + 'px';
    secondaryCanvas.style.width = rect.width + 'px';
    secondaryCanvas.style.height = rect.height + 'px';

    if (module._set_window_size) module._set_window_size(width, height);
    if (module._set_aspect_correction && aspectCorrection !== undefined) {
        module._set_aspect_correction(!!aspectCorrection);
    }
    return true;
}

export function observeModuleSize({
    container = document.querySelector('#contain1'),
    beforeSync,
    sync = syncModuleSize,
    onResize
} = {}) {
    if (!container || typeof ResizeObserver === 'undefined') return null;

    const observer = new ResizeObserver((entries) => {
        if (beforeSync) beforeSync(entries);
        sync(entries);
        if (onResize) onResize(entries);
    });
    observer.observe(container);
    return observer;
}
