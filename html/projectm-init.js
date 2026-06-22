// Bump when publishing a new threaded WASM smoke build. Files must exist under ./pm/
// after deploy (see scripts/prepare_deploy_bundle.sh and docs/DEPLOYMENT.md).
export const PROJECTM_WASM_BUNDLE = 'projectm-v.033-thread';
export const PROJECTM_WASM_SCRIPT = `./pm/${PROJECTM_WASM_BUNDLE}.1ijs`;

export function loadScript(src, {
    documentRef = document,
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

export async function createProjectMModule({
    scriptSrc = PROJECTM_WASM_SCRIPT,
    createModuleName = 'createModule',
    windowRef = window
} = {}) {
    if (typeof windowRef[createModuleName] !== 'function') {
        await loadScript(scriptSrc);
    }
    if (typeof windowRef[createModuleName] !== 'function') {
        throw new Error(`${createModuleName} is not available after loading ${scriptSrc}`);
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
