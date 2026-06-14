export const DEFAULT_PRESET_API_BASE = 'https://storage.noahcohn.com';
export const FALLBACK_PRESET_API_BASES = [
    'https://storage.noahcohn.com',
    'https://storage.1ink.us'
];
export const LOCAL_PRESET_MAX_BYTES = 2 * 1024 * 1024;
export const LOCAL_PRESET_LAST_NAME_KEY = 'projectm:lastLocalPresetName';

export function updatePresetDisplay(name, {
    documentRef = document,
    windowRef = window,
    selector = '#preset-name',
    prefix = 'Preset: '
} = {}) {
    if (!name) return;
    const basename = String(name).split('/').pop();
    windowRef.currentPresetName = basename;
    // Track the full VFS path (when available) so a WebGL context-loss recovery
    // (see projectm-context-loss.js) can reload the same preset after re-init.
    if (String(name).includes('/')) {
        windowRef.currentPresetPath = String(name);
    }
    const el = documentRef.querySelector(selector);
    if (el) {
        el.textContent = prefix + basename;
    }
}

export function getPresetDir({
    documentRef = document,
    elementId = 'presetDir',
    defaultValue = 'any'
} = {}) {
    const el = documentRef.getElementById(elementId);
    const val = el ? el.innerHTML.trim() : 'default';
    return val === 'default' ? defaultValue : val;
}

export function getPresetApiBases({
    preferred,
    includeStorageOverride = true,
    fallbacks = [DEFAULT_PRESET_API_BASE]
} = {}) {
    const fromStorage = includeStorageOverride ? localStorage.getItem('apiBase') : null;
    return [...new Set([preferred, fromStorage, ...fallbacks].filter(Boolean))];
}

function safePresetName(filename) {
    return String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function setStatusMessage(message, {
    documentRef = document,
    selector = '#stat',
    isError = false
} = {}) {
    const el = documentRef.querySelector(selector);
    if (!el) return;
    el.style.display = 'block';
    el.textContent = message;
    el.style.background = isError ? 'rgba(127, 29, 29, 0.92)' : 'rgba(15, 23, 42, 0.88)';
    el.style.color = isError ? '#fecaca' : '#dbeafe';
    el.style.padding = '0.45rem 0.7rem';
    el.style.borderRadius = '0.45rem';
    el.style.border = isError ? '1px solid rgba(248,113,113,0.5)' : '1px solid rgba(96,165,250,0.35)';
}

function assertLocalPresetFile(file) {
    if (!file) {
        throw new Error('No preset file selected');
    }
    if (!/\.milk$/i.test(file.name)) {
        throw new Error('Invalid preset file. Choose a .milk file.');
    }
    if (file.size > LOCAL_PRESET_MAX_BYTES) {
        throw new Error(`Preset too large. Limit is ${Math.round(LOCAL_PRESET_MAX_BYTES / (1024 * 1024))}MB.`);
    }
}

export function getLocalPresetVfsPath(filename) {
    const baseName = safePresetName(filename || 'preset.milk');
    return `/presets/local_${baseName}`;
}

export async function fetchApiPreset({
    module,
    apiBase,
    apiBases,
    presetDir,
    fallbackApiBases = [DEFAULT_PRESET_API_BASE],
    requireDir = false,
    vfsPathForPreset,
    warnOnFallback = true
} = {}) {
    const dir = presetDir || getPresetDir();
    const bases = apiBases || getPresetApiBases({ preferred: apiBase, fallbacks: fallbackApiBases });
    let lastError = null;

    for (const base of bases) {
        try {
            const res = await fetch(`${base}/api/presets/random?dir=${encodeURIComponent(dir)}`);
            if (!res.ok) throw new Error(`API error ${res.status} from ${base}`);

            const data = await res.json();
            if (!data.url || !data.filename || (requireDir && !data.dir)) {
                throw new Error(`Invalid API response from ${base}`);
            }

            const milkRes = await fetch(data.url);
            if (!milkRes.ok) throw new Error(`Failed to fetch preset milk from ${data.url}`);

            const bytes = new Uint8ClampedArray(await milkRes.arrayBuffer());
            const vfsPath = vfsPathForPreset
                ? vfsPathForPreset(data)
                : `/presets/api_${data.dir || dir || 'any'}_${safePresetName(data.filename)}`;

            if (!module || !module.FS) throw new Error('Module.FS not available');
            module.FS.writeFile(vfsPath, bytes);

            return {
                vfsPath,
                filename: data.filename,
                dir: data.dir || dir,
                url: data.url,
                apiBase: base
            };
        } catch (error) {
            lastError = error;
            if (warnOnFallback) {
                console.warn('[ProjectM] preset API attempt failed:', base, error);
            }
        }
    }

    throw lastError || new Error('No preset API base available');
}

export async function loadStartupApiPresets({
    module,
    count,
    apiBase,
    apiBases,
    fallbackApiBases,
    updateDisplayMode = 'all',
    returnPaths = false,
    logLoaded = false,
    requireDir = false,
    vfsPathForPreset
}) {
    const results = [];
    for (let i = 0; i < count; i++) {
        try {
            const result = await fetchApiPreset({
                module,
                apiBase,
                apiBases,
                fallbackApiBases,
                requireDir,
                vfsPathForPreset
            });
            results.push(returnPaths ? result.vfsPath : result);
            if (updateDisplayMode === 'all' || (updateDisplayMode === 'first' && i === 0)) {
                updatePresetDisplay(result.filename);
            }
            if (logLoaded) {
                console.log('Startup API preset', i, 'loaded:', result.filename);
            }
        } catch (error) {
            console.error('Failed to load startup API preset', i, error);
        }
    }
    return results;
}

export async function loadRandomApiPreset({
    module,
    apiBase,
    apiBases,
    fallbackApiBases,
    requireDir = false,
    vfsPathForPreset,
    startTransitionWhenReady,
    updateDisplay = true,
    logLoaded = false
}) {
    if (!module || !module.ccall || !module._load_preset_file) {
        console.error('Module not ready');
        return null;
    }

    try {
        const result = await fetchApiPreset({
            module,
            apiBase,
            apiBases,
            fallbackApiBases,
            requireDir,
            vfsPathForPreset
        });
        module.ccall('load_preset_file', null, ['string'], [result.vfsPath]);
        if (startTransitionWhenReady) {
            startTransitionWhenReady({ module });
        }
        if (updateDisplay) {
            updatePresetDisplay(result.filename);
        }
        if (logLoaded) {
            console.log('Loaded API preset:', result.filename, 'from', result.dir);
        }
        return result;
    } catch (error) {
        console.error('Failed to load API preset:', error);
        return null;
    }
}

export async function loadLocalPresetFile(file, {
    module,
    startTransitionWhenReady,
    updateDisplay = true,
    rememberLast = true,
    documentRef = document
} = {}) {
    if (!module || !module.FS || !module.ccall || !module._load_preset_file) {
        throw new Error('Module not ready');
    }

    assertLocalPresetFile(file);
    setStatusMessage(`Loading local preset: ${file.name}`, { documentRef });

    let bytes;
    try {
        bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
        throw new Error(`Failed to read preset file: ${error instanceof Error ? error.message : error}`);
    }

    const vfsPath = getLocalPresetVfsPath(file.name);
    try {
        module.FS.writeFile(vfsPath, bytes);
    } catch (error) {
        throw new Error(`Failed to write preset to Emscripten FS: ${error instanceof Error ? error.message : error}`);
    }

    try {
        module.ccall('load_preset_file', null, ['string'], [vfsPath]);
    } catch (error) {
        throw new Error(`Preset parser rejected ${file.name}: ${error instanceof Error ? error.message : error}`);
    }

    if (startTransitionWhenReady) {
        startTransitionWhenReady({ module });
    }
    if (updateDisplay) {
        updatePresetDisplay(file.name, { documentRef });
    }
    if (rememberLast) {
        localStorage.setItem(LOCAL_PRESET_LAST_NAME_KEY, file.name);
    }
    setStatusMessage(`Loaded local preset: ${file.name}`, { documentRef });

    return {
        filename: file.name,
        vfsPath
    };
}
