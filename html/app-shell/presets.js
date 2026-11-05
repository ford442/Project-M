// app-shell/presets.js
//
// The shell's preset sources: the preset API (random + the startup batch),
// the render-worker byte writer, and weeks-on-fire's scanned list.

import { addPresetFile, loadPresetFile } from '../generated/projectm-wasm-api.js';
import {
    getConfiguredPresetApiBase,
    loadRandomApiPreset,
    loadStartupApiPresets,
    updatePresetDisplay,
} from '../projectm-presets.js';
import { bundleScansAssets } from '../projectm-textures.js';
import { startTransitionWhenReady } from '../projectm-transitions.js';
import { startWeeksOnFire } from '../projectm-weeks-on-fire.js';

/**
 * @typedef {import('../generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('../projectm-context.js').ProjectMContext} ProjectMContext
 * @typedef {import('./config.js').ShellProfile} ShellProfile
 *
 * @typedef {object} ShellPresetDeps
 * @property {ShellProfile} profile
 * @property {string} log
 * @property {Window & typeof globalThis} windowRef
 * @property {Storage | null} storage
 * @property {{ startupPresetsLoaded: boolean }} state
 * @property {boolean} weeksOnFire
 * @property {() => ProjectMContext | null} getContext
 * @property {() => ProjectMModule | undefined} getModule
 */

/** @param {ShellPresetDeps} deps */
export function createShellPresets({ profile, log, windowRef, storage, state, weeksOnFire, getContext, getModule }) {
    // Weeks on fire's preset loader: set by startWeeksOnFire() once the engine is
    // up. Null in a normal session, and in weeks mode against a bundle old
    // enough to seed its own playlist.
    /** @type {ReturnType<typeof startWeeksOnFire> | null} */
    let weeksLoader = null;

    /**
     * Where fetched preset bytes go: the main-thread module's VFS, or — in the
     * render-worker topology, where the VFS is in the worker — the transport.
     *
     * @param {'load' | 'add'} mode
     * @returns {((vfsPath: string, bytes: Uint8Array) => void) | undefined}
     */
    function presetWriterFor(mode) {
        if (getModule()?.FS) return undefined;
        const transport = getContext()?.transport;
        if (transport?.writePreset) {
            return (vfsPath, bytes) => transport.writePreset?.(vfsPath, bytes, mode);
        }
        return undefined;
    }

    async function loadRandomPresetFromRemote() {
        const writeBytes = presetWriterFor('load');
        const result = await loadRandomApiPreset({
            module: getModule(),
            apiBase: getConfiguredPresetApiBase({ windowRef, storage }),
            requireDir: profile.requirePresetDir,
            startTransitionWhenReady: writeBytes ? undefined : startTransitionWhenReady,
            writeBytes,
        });
        const pmContext = getContext();
        if (!result && pmContext) {
            // API down: cycle the bundled local presets instead.
            try {
                pmContext.nextPreset();
            } catch (error) {
                console.warn(`${log} local preset fallback failed:`, error);
            }
        }
    }
    const randomRemote = () => {
        loadRandomPresetFromRemote().catch((error) => console.warn(`${log} random preset failed:`, error));
    };

    async function loadStartupPresets() {
        if (state.startupPresetsLoaded) return;
        state.startupPresetsLoaded = true;
        if (weeksOnFire) {
            const context = getContext();
            if (bundleScansAssets(windowRef)) {
                console.log(`${log} Weeks on fire: preset playlist seeded by the WASM bundle`);
            } else if (context) {
                weeksLoader = startWeeksOnFire({
                    writePreset: (vfsPath, bytes, mode) => context.transport?.writePreset?.(vfsPath, bytes, mode),
                    onPresetLoaded: updatePresetDisplay,
                    playSong: () => import('../projectm-song-loader.js').then((mod) => mod.playRandomCatalogSong()),
                });
            }
            return;
        }
        const module = getModule();
        // `count` is a named option: positional `loadStartupApiPresets(5)`
        // destructured to count = 0 and quietly loaded nothing.
        const startup = /** @type {{ vfsPath: string, filename: string, bytes?: Uint8Array }[]} */ (
            await loadStartupApiPresets({
                module,
                count: 5,
                apiBase: getConfiguredPresetApiBase({ windowRef, storage }),
                requireDir: profile.requirePresetDir,
                updateDisplayMode: 'first',
                writeBytes: presetWriterFor('add'),
            })
        );
        if (startup.length === 0 || !getContext()) return;
        if (module?.FS) {
            loadPresetFile(module, startup[0].vfsPath);
            updatePresetDisplay(startup[0].filename);
            for (const entry of startup.slice(1)) addPresetFile(module, entry.vfsPath);
            return;
        }
        // Render-worker topology: the first preset is loaded, the rest queued, there.
        startup.forEach(({ vfsPath, bytes }, index) => {
            const pmContext = getContext();
            if (!bytes || !pmContext) return;
            if (index === 0) {
                pmContext.transport?.writePreset?.(vfsPath, bytes);
                updatePresetDisplay(startup[0].filename);
            } else {
                pmContext.addPreset(vfsPath, bytes);
            }
        });
    }

    /** Weeks-on-fire mode draws from its own scanned list. @returns {boolean} handled */
    function weeksPreset() {
        if (!weeksOnFire) return false;
        if (weeksLoader) {
            void weeksLoader.loader.loadRandom();
            return true;
        }
        // Bundles built before the glue lost its XHR loaders install this themselves.
        const pick = /** @type {{ loadRandomWeeksPreset?: () => void }} */ (/** @type {unknown} */ (windowRef))
            .loadRandomWeeksPreset;
        if (typeof pick === 'function') pick();
        else console.warn(`${log} Weeks mode: preset scanner not ready yet`);
        return true;
    }

    return { randomRemote, loadStartupPresets, weeksPreset };
}
