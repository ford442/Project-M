// Preset bytes into the engine.
//
// A bundle with load_preset_data() (#352 D) takes the bytes in one call: they
// are copied onto the WASM heap, stored in the engine's VFS under `vfsPath`
// and acted on there. Bundles built before it get the old sequence, the Emscripten
// FS API (mkdirTree, writeFile) and then the path export. Either way the preset
// keeps the name `vfsPath`, which the playlist and a context-loss reload use.

import { addPresetFile, loadPresetData, loadPresetFile, loadPresetFileHard } from './generated/projectm-wasm-api.js';

/**
 * What to do with a preset once it is stored:
 * - `load`: load it (soft transition)
 * - `load-hard`: load it with a hard cut
 * - `add`: add it to the playlist only
 * - `store`: nothing yet; the caller loads it by path later
 *
 * @typedef {'load' | 'load-hard' | 'add' | 'store'} PresetStoreMode
 */

/**
 * load_preset_data()'s `mode` argument for each PresetStoreMode
 * (src/wasm/WasmPlaylistBridge.cpp).
 */
export const PRESET_STORE_MODES = Object.freeze({ load: 0, 'load-hard': 1, add: 2, store: 3 });

/**
 * @typedef {object} PresetStoreModule The parts of a module (or host view) this file uses.
 * @property {(name: string, returnType: string | null, argTypes: string[], args: unknown[]) => unknown} ccall
 * @property {((size: number) => number)} [_malloc]
 * @property {((ptr: number) => void)} [_free]
 * @property {Uint8Array} [HEAPU8]
 * @property {unknown} [_load_preset_data]
 * @property {{ writeFile: (path: string, data: Uint8Array) => void, mkdirTree?: (path: string) => void }} [FS]
 */

/**
 * Whether presets reach `module` through load_preset_data(): the export, and
 * the heap access the copy needs (`_malloc`, `_free`, `HEAPU8`, all exported by
 * every bundle that has the export). On a host view (bindModuleToHost()) the
 * compat name resolves to the host's pm_ export.
 *
 * @param {unknown} module
 * @returns {boolean}
 */
export function hasPresetDataExport(module) {
    const candidate = /** @type {PresetStoreModule | null | undefined} */ (module);
    return typeof candidate?._load_preset_data === 'function'
        && typeof candidate._malloc === 'function'
        && typeof candidate._free === 'function'
        && candidate.HEAPU8 instanceof Uint8Array;
}

/**
 * Whether this thread can hand presets to `module` at all: false for a
 * missing module, which is the render-worker topology's main thread (the
 * engine is in the worker; presets go through the transport).
 *
 * @param {unknown} module
 * @returns {boolean}
 */
export function canStorePresets(module) {
    if (!module) return false;
    return hasPresetDataExport(module) || !!(/** @type {{ FS?: unknown }} */ (module).FS);
}

/**
 * Stores a preset under `vfsPath` and acts on it as `mode` says.
 *
 * @param {PresetStoreModule} module A module or a host view of one.
 * @param {string} vfsPath The name the preset is known by.
 * @param {Uint8Array} bytes The .milk file.
 * @param {PresetStoreMode} [mode]
 * @throws {Error} When the module can take no presets, the heap is full, or
 *   the engine refused the preset (no engine, a bad name, a failed write).
 */
export function storePreset(module, vfsPath, bytes, mode = 'load') {
    const code = PRESET_STORE_MODES[mode];
    if (code === undefined) throw new Error(`unknown preset store mode: ${mode}`);

    if (hasPresetDataExport(module) && module._malloc && module._free && module.HEAPU8) {
        const ptr = module._malloc(Math.max(bytes.byteLength, 1));
        if (!ptr) throw new Error(`no WASM heap left for preset ${vfsPath} (${bytes.byteLength} bytes)`);
        try {
            // Read HEAPU8 after the allocation: it is the view of the heap as it is now.
            module.HEAPU8.set(bytes, ptr);
            const stored = loadPresetData(
                /** @type {import('./generated/projectm-wasm-api.ts').ProjectMModule} */ (/** @type {unknown} */ (module)),
                ptr,
                bytes.byteLength,
                vfsPath,
                code,
            );
            if (!stored) throw new Error(`the engine refused preset ${vfsPath}`);
        } finally {
            module._free(ptr);
        }
        return;
    }

    const fs = module.FS;
    if (!fs) throw new Error('Module has neither load_preset_data nor FS');
    try {
        // A bundle that preloads no presets has no /presets to write into, and
        // the failure is a bare ErrnoError 44 that says nothing useful.
        const dir = vfsPath.slice(0, vfsPath.lastIndexOf('/'));
        if (dir && fs.mkdirTree) fs.mkdirTree(dir);
    } catch (_) {
        // Already there; the write below reports anything real.
    }
    fs.writeFile(vfsPath, bytes);
    const api = /** @type {import('./generated/projectm-wasm-api.ts').ProjectMModule} */ (/** @type {unknown} */ (module));
    if (mode === 'add') addPresetFile(api, vfsPath);
    else if (mode === 'load-hard') loadPresetFileHard(api, vfsPath);
    else if (mode === 'load') loadPresetFile(api, vfsPath);
}
