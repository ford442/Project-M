export const DEFAULT_PRESET_API_BASE = 'https://storage.noahcohn.com';
export const FALLBACK_PRESET_API_BASES = [
    'https://storage.noahcohn.com',
    'https://storage.1ink.us'
];

export function updatePresetDisplay(name, {
    documentRef = document,
    windowRef = window,
    selector = '#preset-name',
    prefix = 'Preset: '
} = {}) {
    if (!name) return;
    const basename = String(name).split('/').pop();
    const el = documentRef.querySelector(selector);
    if (el) {
        el.textContent = prefix + basename;
        windowRef.currentPresetName = basename;
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
