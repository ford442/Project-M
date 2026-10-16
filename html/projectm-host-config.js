// projectm-host-config.js
//
// Every URL flag the first-party hosts honour, declared once.
//
// Thirteen modules used to build their own `new URLSearchParams(location.search)`
// and read their own localStorage keys, with their own idea of what an empty
// or garbled value meant: `?governor=` was "use the stored preference" in
// projectm-fps-governor.js and "governor on" in projectm-core.html, which read
// the same flag for the render worker. Nothing listed what a page could be
// told. This module is that list (HOST_FLAGS), one reader with one precedence
// rule (readHostFlag / getHostConfig), and the generator of the docs table
// (docs/HOST_FLAGS.md, checked by tests/web/projectm-host-config.test.mjs).
//
// Precedence, per flag, for the tiers it names:
//
//   ?query  ->  element attribute  ->  page global  ->  localStorage  ->  default
//
// The first value the flag's parser accepts wins. A value it rejects falls
// through to the next tier rather than turning into the default, so a garbled
// `?targetFps=abc` cannot mask a stored preference.
//
// To add a flag: add it to HostConfig in projectm-host-config-types.ts and to
// HOST_FLAGS below (tsc fails until both agree), read it with readHostFlag(),
// then regenerate the docs table:
//   UPDATE_HOST_FLAGS_DOC=1 node --test tests/web/projectm-host-config.test.mjs

import { normalizeWasmVersion, PROJECTM_WASM_VERSION_STORAGE_KEY } from './projectm-wasm-version.js';

/**
 * @typedef {import('./projectm-host-config-types.ts').HostConfig} HostConfig
 * @typedef {import('./projectm-host-config-types.ts').HostConfigSources} HostConfigSources
 * @typedef {import('./projectm-host-config-types.ts').HostFlagName} HostFlagName
 * @typedef {import('./projectm-host-config-types.ts').HostFlagRegistry} HostFlagRegistry
 */

/** The preset API every host falls back to (projectm-presets.js re-exports it). */
export const DEFAULT_PRESET_API_BASE = 'https://storage.noahcohn.com';

// ---------------------------------------------------------------------------
// Parsers. Each returns undefined for a value it does not accept.
// ---------------------------------------------------------------------------

/** `'1'` turns it on; anything else is no opinion. @param {string} raw */
const on = (raw) => (raw === '1' ? true : undefined);
/** `'1'`/`'true'` on; anything else is no opinion. @param {string} raw */
const onLoose = (raw) => (raw === '1' || raw === 'true' ? true : undefined);
/** `'1'`/`'true'` on, `'0'`/`'false'` off. @param {string} raw */
const bool = (raw) => {
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return undefined;
};
/** `'0'` off, `'1'` on, nothing else. @param {string} raw */
const bool01 = (raw) => {
    if (raw === '1') return true;
    if (raw === '0') return false;
    return undefined;
};
/** Present at all. */
const present = () => true;
/** @param {string} raw */
const positiveInt = (raw) => {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
};
/** @param {string} raw */
const positiveNumber = (raw) => {
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
};
/** @param {string} raw */
const nonEmpty = (raw) => (raw ? raw : undefined);
/**
 * @template {string} T
 * @param {readonly T[]} allowed
 * @returns {(raw: string) => T | undefined}
 */
const oneOf = (allowed) => (raw) => {
    const lower = /** @type {T} */ (raw.toLowerCase());
    return allowed.includes(lower) ? lower : undefined;
};

const CORE_HOST = 'projectm-core-host.js';

/**
 * The registry. Keys are the query names, so `grep "'name'"` lands here.
 *
 * @type {HostFlagRegistry}
 */
export const HOST_FLAGS = Object.freeze({
    // --- Bundle and topology -------------------------------------------------
    wasm: {
        query: 'wasm',
        storage: PROJECTM_WASM_VERSION_STORAGE_KEY,
        parse: (raw) => normalizeWasmVersion(raw) ?? undefined,
        default: null,
        values: 'build tag, e.g. `039`',
        doc: 'WASM bundle version to load (the hosts add the default when it is missing).',
        readBy: ['projectm-init.js'],
    },
    renderWorker: {
        query: 'renderWorker',
        storage: 'renderWorker',
        parse: bool01,
        default: true,
        values: '`0` / `1`',
        doc: 'Render in an OffscreenCanvas worker (default) or on the main thread.',
        readBy: ['projectm-render-worker-host.js'],
    },

    // --- WebGL context ---------------------------------------------------------
    aa: {
        query: 'aa',
        storage: 'canvasAA',
        parse: bool,
        default: false,
        values: '`1`/`true`, `0`/`false`',
        doc: 'Multisampled canvas (MSAA).',
        readBy: [CORE_HOST],
    },
    capture: {
        query: 'capture',
        global: '__projectMCaptureMode',
        parse: onLoose,
        default: false,
        values: '`1`/`true`',
        doc: 'Keep a readable back buffer (preserveDrawingBuffer) for screenshots and readback.',
        readBy: [CORE_HOST],
    },
    depth: {
        query: 'depth',
        parse: onLoose,
        default: false,
        values: '`1`/`true`',
        doc: 'Give the canvas a depth+stencil attachment (off by default since #246).',
        readBy: [CORE_HOST],
    },
    fboPrecision: {
        query: 'fboPrecision',
        parse: oneOf(/** @type {const} */ (['half', 'high', 'byte'])),
        default: 'half',
        values: '`half` (RGBA16F), `high` (RGBA32F), `byte` (RGBA8)',
        doc: 'Dual-FBO colour format.',
        readBy: [CORE_HOST],
    },
    transparent: {
        query: 'transparent',
        storage: 'projectm:transparencyMode',
        parse: onLoose,
        default: false,
        values: '`1`/`true`',
        doc: 'Start in glass-layer transparency mode (near-black pixels show the page).',
        readBy: [CORE_HOST],
    },

    // --- Render-path ablations ---------------------------------------------------
    blurPath: {
        query: 'blurPath',
        parse: oneOf(/** @type {const} */ (['copy'])),
        default: 'default',
        values: '`copy`',
        doc: 'Blur via the copy path instead of the dedicated blur pass (A/B ablation).',
        readBy: ['projectm-render-worker-host.js'],
    },
    copyPath: {
        query: 'copyPath',
        parse: oneOf(/** @type {const} */ (['shader'])),
        default: 'default',
        values: '`shader`',
        doc: 'Texture copies through a shader instead of glBlitFramebuffer (A/B ablation).',
        readBy: ['projectm-render-worker-host.js'],
    },
    perPixelEval: {
        query: 'perPixelEval',
        parse: oneOf(/** @type {const} */ (['cpu'])),
        default: 'default',
        values: '`cpu`',
        doc: 'Evaluate per-pixel equations on the CPU even when the GPU path compiled.',
        readBy: ['projectm-render-worker-host.js'],
    },

    // --- Frame pacing and quality ------------------------------------------------
    targetFps: {
        query: 'targetFps',
        storage: 'targetFps',
        parse: positiveInt,
        default: 60,
        values: 'positive integer',
        doc: 'Render target frame rate.',
        readBy: ['projectm-fps-governor.js', CORE_HOST],
    },
    governor: {
        query: 'governor',
        storage: 'qualityGovernor',
        parse: bool,
        default: true,
        values: '`1`/`true`, `0`/`false`',
        doc: 'Adaptive quality governor (render scale / blur cap under load).',
        readBy: ['projectm-fps-governor.js', CORE_HOST],
    },
    meshQuality: {
        query: 'meshQuality',
        storage: 'meshQuality',
        parse: oneOf(/** @type {const} */ (['auto', 'low', 'high'])),
        default: 'auto',
        values: '`auto`, `low`, `high`',
        doc: 'Per-pixel mesh size; `auto` picks from navigator.hardwareConcurrency.',
        readBy: ['projectm-mesh-quality.js', CORE_HOST],
    },

    // --- Presets -----------------------------------------------------------------
    presetApi: {
        query: 'presetApi',
        global: 'PROJECTM_PRESET_API_BASE',
        storage: 'apiBase',
        parse: (raw) => nonEmpty(raw.replace(/\/+$/, '')),
        default: DEFAULT_PRESET_API_BASE,
        values: 'URL',
        doc: 'Preset API base URL.',
        readBy: ['projectm-presets.js'],
    },
    presetDuration: {
        query: 'presetDuration',
        parse: (raw) => {
            const seconds = Number(raw);
            return Number.isFinite(seconds) && seconds >= 5 ? seconds : undefined;
        },
        default: 40,
        values: 'seconds, >= 5',
        doc: 'Interval of the host\'s automatic random-preset switch.',
        readBy: [CORE_HOST],
    },
    localPresets: {
        query: 'localPresets',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'Show the local .milk loader (drag-and-drop into the preset VFS) and the dev panel.',
        readBy: [CORE_HOST, 'projectm-preset-dev.js'],
    },
    devPreset: {
        query: 'devPreset',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'Preset hot-reload panel (inline editor + URL polling).',
        readBy: ['projectm-preset-dev.js'],
    },
    devPresetUrl: {
        query: 'devPresetUrl',
        parse: nonEmpty,
        default: '',
        values: 'URL',
        doc: 'Preset URL the hot-reload panel fetches.',
        readBy: ['projectm-preset-dev.js'],
    },
    devPoll: {
        query: 'devPoll',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'Start polling `devPresetUrl` immediately.',
        readBy: ['projectm-preset-dev.js'],
    },
    devPollMs: {
        query: 'devPollMs',
        parse: positiveInt,
        default: 2000,
        values: 'milliseconds (min 500)',
        doc: 'Hot-reload poll interval.',
        readBy: ['projectm-preset-dev.js'],
    },

    // --- Musical scheduling ------------------------------------------------------
    switchOn: {
        query: 'switchOn',
        parse: oneOf(/** @type {const} */ (['timer', 'bars', 'section'])),
        default: 'timer',
        values: '`timer`, `bars`, `section`',
        doc: 'Switch presets on the timer, every N bars, or on a detected section change.',
        readBy: [CORE_HOST],
    },
    switchBars: {
        query: 'switchBars',
        parse: positiveInt,
        default: 16,
        values: 'positive integer',
        doc: 'Phrase length for `switchOn=bars`.',
        readBy: [CORE_HOST],
    },
    transitionBeats: {
        query: 'transitionBeats',
        parse: positiveNumber,
        default: 0,
        values: 'beats',
        doc: 'Crossfade length in beats (0 = seconds).',
        readBy: [CORE_HOST],
    },
    bpm: {
        query: 'bpm',
        parse: positiveNumber,
        default: 0,
        values: 'BPM',
        doc: 'Known tempo instead of the estimate (0 = estimate).',
        readBy: [CORE_HOST],
    },
    rhythmDebug: {
        query: 'rhythmDebug',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'Log beats, bars and section changes to the console.',
        readBy: [CORE_HOST],
    },

    // --- Diagnostics and benchmarks ----------------------------------------------
    perfhud: {
        query: 'perfhud',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'On-canvas performance HUD.',
        readBy: ['projectm-perf.js'],
    },
    pcmhud: {
        query: 'pcmhud',
        storage: 'projectm-pcm-hud',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'PCM ingest HUD (ring fill, producer, dropped chunks).',
        readBy: ['projectm-pcm-hud.js'],
    },
    benchmark: {
        query: 'benchmark',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'Run the frame-time benchmark and report p50/p95 (implies `perfhud`).',
        readBy: ['projectm-perf.js'],
    },
    frames: {
        query: 'frames',
        parse: positiveInt,
        default: 500,
        values: 'positive integer',
        doc: 'Frames the benchmark samples.',
        readBy: ['projectm-perf.js'],
    },
    preset: {
        query: 'preset',
        parse: nonEmpty,
        default: null,
        values: 'preset path',
        doc: 'Preset the benchmark loads first.',
        readBy: ['projectm-perf.js'],
    },
    crossfade: {
        query: 'crossfade',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'Benchmark only frames rendered during a crossfade (main-thread topology).',
        readBy: ['projectm-perf.js'],
    },
    crossfadeSec: {
        query: 'crossfadeSec',
        parse: positiveNumber,
        default: 20,
        values: 'seconds (min 0.5)',
        doc: 'Crossfade length for the crossfade benchmark.',
        readBy: ['projectm-perf.js'],
    },
    crossfadePresets: {
        query: 'crossfadePresets',
        parse: (raw) => {
            const list = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
            return list.length ? list : undefined;
        },
        default: [],
        values: 'comma-separated preset paths',
        doc: 'Presets the crossfade benchmark alternates between.',
        readBy: ['projectm-perf.js'],
    },
    presetSwitchBench: {
        query: 'presetSwitchBench',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'Time preset switches over the featured pack (main-thread topology).',
        readBy: ['projectm-perf.js'],
    },
    audioTest: {
        query: 'audioTest',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'Synthetic-audio panel (silence/bass/mid/treble/beat/sweep feeds).',
        readBy: ['projectm-synthetic-audio.js'],
    },
    simulateInitFail: {
        query: 'simulateInitFail',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'Show the init-error overlay without a real failure (UI testing).',
        readBy: ['projectm-init-errors.js'],
    },
    debugSender: {
        query: 'debugSender',
        parse: present,
        default: false,
        values: 'present',
        doc: 'Log external PCM senders off localhost too.',
        readBy: [CORE_HOST],
    },

    // --- Experimental and themed hosts ---------------------------------------------
    experimental: {
        query: 'experimental',
        parse: on,
        default: false,
        values: '`1`',
        doc: 'Experimental bridge (depth module, metadata hooks).',
        readBy: ['projectm-experimental-bridge.js'],
    },
    depthModule: {
        query: 'depthModule',
        parse: nonEmpty,
        default: null,
        values: 'URL',
        doc: 'Depth-estimation module the experimental bridge loads.',
        readBy: ['projectm-experimental-bridge.js'],
    },
    mode: {
        query: 'mode',
        parse: nonEmpty,
        default: null,
        values: '`weeks_on_fire`',
        doc: 'Themed host mode (preset/song/texture folders and title).',
        readBy: ['projectm-weeks-on-fire.js'],
    },
});

// ---------------------------------------------------------------------------
// Reader.
// ---------------------------------------------------------------------------

/**
 * @param {HostConfigSources['search']} search
 * @returns {URLSearchParams}
 */
function toParams(search) {
    if (search instanceof URLSearchParams) return search;
    try {
        return new URLSearchParams(search || '');
    } catch {
        return new URLSearchParams();
    }
}

/** @returns {string} */
function defaultSearch() {
    try {
        return globalThis.location?.search ?? '';
    } catch {
        return '';
    }
}

/** @returns {HostConfigSources['storage']} */
function defaultStorage() {
    // Throws on *access* in a sandboxed iframe and some private modes.
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

/**
 * Resolves the sources once, so getHostConfig() parses the query a single time.
 *
 * @param {HostConfigSources} sources
 */
function resolveSources(sources) {
    return {
        params: toParams('search' in sources ? sources.search : defaultSearch()),
        element: sources.element ?? null,
        globals: 'globals' in sources ? sources.globals : /** @type {Record<string, unknown>} */ (globalThis),
        storage: 'storage' in sources ? sources.storage : defaultStorage(),
    };
}

/**
 * @template {HostFlagName} K
 * @param {K} name
 * @param {ReturnType<typeof resolveSources>} resolved
 * @returns {HostConfig[K]}
 */
function readResolved(name, resolved) {
    const spec = /** @type {import('./projectm-host-config-types.ts').HostFlagSpec<HostConfig[K]>} */ (HOST_FLAGS[name]);
    /** @type {Array<() => string | null | undefined>} */
    const tiers = [
        () => (spec.query ? resolved.params.get(spec.query) : null),
        () => (spec.attribute ? resolved.element?.getAttribute(spec.attribute) : null),
        () => {
            if (!spec.global || !resolved.globals) return null;
            const value = resolved.globals[spec.global];
            return value == null ? null : String(value);
        },
        () => (spec.storage ? resolved.storage?.getItem(spec.storage) : null),
    ];
    for (const tier of tiers) {
        let raw;
        try {
            raw = tier();
        } catch {
            continue; // Storage and exotic globals can throw on read.
        }
        if (raw == null) continue;
        const value = spec.parse(raw);
        if (value !== undefined) return value;
    }
    return spec.default;
}

/**
 * One flag's value.
 *
 * @template {HostFlagName} K
 * @param {K} name
 * @param {HostConfigSources} [sources]
 * @returns {HostConfig[K]}
 */
export function readHostFlag(name, sources = {}) {
    return readResolved(name, resolveSources(sources));
}

/**
 * Every flag, parsed.
 *
 * @param {HostConfigSources} [sources]
 * @returns {HostConfig}
 */
export function getHostConfig(sources = {}) {
    const resolved = resolveSources(sources);
    const config = /** @type {Record<string, unknown>} */ ({});
    for (const name of /** @type {HostFlagName[]} */ (Object.keys(HOST_FLAGS))) {
        config[name] = readResolved(name, resolved);
    }
    return /** @type {HostConfig} */ (/** @type {unknown} */ (config));
}

// ---------------------------------------------------------------------------
// Docs.
// ---------------------------------------------------------------------------

/**
 * The Markdown table docs/HOST_FLAGS.md carries between its markers.
 *
 * @returns {string}
 */
export function renderHostFlagsTable() {
    /** @param {unknown} value */
    const show = (value) => {
        if (value === null) return '—';
        if (Array.isArray(value)) return value.length ? `\`${value.join(',')}\`` : '—';
        return `\`${String(value)}\``;
    };
    const rows = Object.entries(HOST_FLAGS).map(([name, spec]) => {
        const tiers = [
            spec.query && `\`?${spec.query}=\``,
            spec.attribute && `attribute \`${spec.attribute}\``,
            spec.global && `\`window.${spec.global}\``,
            spec.storage && `localStorage \`${spec.storage}\``,
        ].filter(Boolean).join(' → ');
        const readers = spec.readBy.map((/** @type {string} */ file) => `\`${file}\``).join(', ');
        return `| \`${name}\` | ${tiers} | ${spec.values} | ${show(spec.default)} | ${spec.doc} | ${readers} |`;
    });
    return [
        '| Flag | Sources (first accepted wins) | Values | Default | Effect | Read by |',
        '|------|-------------------------------|--------|---------|--------|---------|',
        ...rows,
    ].join('\n');
}
