// Shared preset-entry shapes for the preset library / picker / favorites / cache
// modules.
//
// Types-only companion (no runtime code), imported from `.js` via
// `@typedef {import('./projectm-preset-types.ts').PresetEntry}`. Per
// html/README.md, this must not share a basename with any `.js` module — a
// same-basename `.ts` would shadow the real implementation for every JS
// importer during typecheck.

/**
 * One entry from `custom_presets_manifest.json`, as consumed by the preset
 * picker and library.
 */
export interface PresetEntry {
    /** Preset filename, e.g. `foo.milk`. */
    file: string;
    /** Directory the preset is fetched from; defaults to `custom_milk_fixed`. */
    base?: string;
    /** Human-readable label shown in the picker. */
    label?: string;
    /** Capture status recorded by scripts/generate_custom_preset_manifest.mjs. */
    status?: string;
    /** Free-form tags used by the library's filters. */
    tags?: string[];
    [key: string]: unknown;
}

/**
 * Anything accepted where a preset identity is expected: a full entry, or a
 * bare filename string.
 */
export type PresetEntryLike = PresetEntry | string;

/** A row in the `shaders` IndexedDB store (projectm-shader-cache.js). */
export interface ShaderCacheRecord {
    /** The cache key: `shader::<wasmVersion>::<glslVersion>::<contentHash>`. */
    id: string;
    warp?: string;
    composite?: string;
    /** Combined UTF-8 byte length of the stored GLSL, for LRU accounting. */
    sizeBytes?: number;
    cachedAt?: number;
    lastUsedAt?: number;
    [key: string]: unknown;
}

/**
 * Which of a preset's two transpiled shaders a cache write refers to.
 * Numeric to match `shader_cache_import_glsl` (0=warp, 1=composite) and the
 * `kind` argument of `js_on_transpiled_shader_stored` (projectM_emscripten.cpp).
 */
export type ShaderKind = 0 | 1;

/** One row of `measurePresetSwitchTimings()` output. */
export interface PresetSwitchTiming {
    preset: string;
    coldMs: number;
    warmMs: number;
    savedMs: number;
}

/** A row in the `presets` IndexedDB store (projectm-preset-cache.js). */
export interface CachedPresetRecord {
    /** `<base>::<file>`. */
    id: string;
    bytes?: Uint8Array;
    meta?: Record<string, unknown>;
    cachedAt?: number;
    lastUsedAt?: number;
    [key: string]: unknown;
}

/** Progress callback for the IndexedDB preset preloaders. */
export type PreloadProgressFn = (
    done: number,
    total: number,
    entry: PresetEntry,
    outcome: 'cached' | 'stored' | 'miss',
    label?: string,
) => void;

/** Filter state for the preset library / picker UI. */
export interface PresetFilters {
    /** Free-text search across label, file, tags, author, project, tier, reactivity. */
    query?: string;
    /** Tag to require, or `'all'`. */
    tag?: string;
    /** Quality tier to require, or `'all'`. */
    tier?: string;
    /** Audio-reactivity class to require, or `'all'`. */
    reactivity?: string;
    /** `'featured'` or `'favorites'`; anything else means no pack filter. */
    pack?: string;
    /** Keep only entries whose capture status is `'ok'`. */
    onlyOk?: boolean;
    /** Drop entries whose capture status is `'broken'`. */
    excludeBroken?: boolean;
}
