// Named custom-preset picker for the WASM demo hosts.
//
// Searchable list with tags/tier/reactivity filters, favorites, quality-weighted
// random, and optional Featured pack tab. Metadata from custom_presets_manifest.json
// (schemaVersion ≥ 2) and featured_pack_manifest.json.

import { updatePresetDisplay } from './projectm-presets.js';
import {
    filterPresets,
    pickWeightedRandom,
    collectTags,
    loadPresetEntry,
    fetchFeaturedManifest,
    isFavorite,
    toggleFavorite,
    presetId,
    DEFAULT_FEATURED_MANIFEST_URL,
} from './projectm-preset-library.js';
import { preloadFeaturedPack, preloadFavoritePresets } from './projectm-preset-cache.js';
import { getFavorites } from './projectm-preset-favorites.js';

/**
 * @typedef {import('./projectm-preset-types.ts').PresetEntry} PresetEntry
 * @typedef {import('./projectm-preset-types.ts').PresetFilters} PresetFilters
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 */

/**
 * @typedef {(opts?: {
 *   module?: ProjectMModuleLike | null,
 *   timeoutFrames?: number,
 *   durationSec?: number,
 * }) => Promise<boolean>} StartTransitionFn
 */

export const DEFAULT_MANIFEST_URL = './custom_presets_manifest.json';

export const DEFAULT_CUSTOM_PRESET_BASES = [
    'https://glsl.1ink.us/custom_milk/',
    '../custom_milk_fixed/',
    './custom_milk_fixed/',
];

/**
 * @param {string} filename
 * @returns {string}
 */
function safePresetName(filename) {
    return String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * @param {object} [options]
 * @param {string} [options.preferred] Base tried before everything else.
 * @param {string[]} [options.fallbacks]
 * @returns {string[]} De-duplicated base URLs, in try order.
 */
export function getCustomPresetBases({ preferred, fallbacks = DEFAULT_CUSTOM_PRESET_BASES } = {}) {
    /** @type {string | null} */
    let fromStorage = null;
    try {
        fromStorage = localStorage.getItem('customPresetBase');
    } catch {
        // localStorage may be unavailable
    }
    return [...new Set(
        /** @type {string[]} */ ([preferred, fromStorage, ...fallbacks].filter(Boolean)),
    )];
}

/**
 * @param {object} [options]
 * @param {string} [options.url]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ presets: PresetEntry[] } & Record<string, unknown>>}
 */
export async function fetchCustomPresetManifest({
    url = DEFAULT_MANIFEST_URL,
    fetchImpl = fetch,
} = {}) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Failed to fetch custom preset manifest (${res.status})`);
    const data = await res.json();
    if (!data || !Array.isArray(data.presets)) {
        throw new Error('Invalid custom preset manifest: missing presets[]');
    }
    return data;
}

/**
 * @deprecated use loadPresetEntry from projectm-preset-library.js
 *
 * @param {string} file
 * @param {object} [options]
 * @param {ProjectMModuleLike} [options.module]
 * @param {StartTransitionFn | null} [options.startTransitionWhenReady]
 * @param {string[]} [options.bases]
 * @param {boolean} [options.updateDisplay]
 * @param {string} [options.label]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function loadCustomPresetFile(file, {
    module,
    startTransitionWhenReady,
    bases,
    updateDisplay = true,
    label,
    fetchImpl = fetch,
} = {}) {
    return loadPresetEntry(
        { file, base: 'custom_milk_fixed', label: label || file },
        { module, startTransitionWhenReady, updateDisplay, fetchImpl, bases },
    );
}

/**
 * @param {PresetEntry[]} presets
 * @param {object} [options]
 * @param {boolean} [options.onlyOk]
 * @param {boolean} [options.weighted]
 * @returns {PresetEntry | null}
 */
export function pickRandomFromList(presets, { onlyOk = false, weighted = true } = {}) {
    if (weighted && presets.some((p) => typeof p.weight === 'number')) {
        return pickWeightedRandom(presets, { onlyOk, excludeBroken: !onlyOk });
    }
    const pool = onlyOk ? presets.filter((p) => p.status === 'ok') : presets.filter((p) => p.status !== 'broken');
    const effective = pool.length ? pool : presets;
    if (!effective.length) return null;
    return effective[Math.floor(Math.random() * effective.length)];
}

const PICKER_STYLE_ID = 'pm-preset-picker-style';
const PICKER_CSS = `
#pm-preset-picker {
  position: fixed; right: 2vh; bottom: 2vh; z-index: 3303;
  width: min(26rem, 46vw); max-height: 78vh; display: flex; flex-direction: column;
  padding: 0.8rem; border-radius: 0.9rem;
  background: rgba(2, 6, 23, 0.92); border: 1px solid rgba(56, 189, 248, 0.3);
  color: #dbeafe; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5); backdrop-filter: blur(8px);
  font-family: 'Inter', system-ui, sans-serif;
}
#pm-preset-picker[hidden] { display: none !important; }
.pm-pp-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
.pm-pp-title { font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: #7dd3fc; }
.pm-pp-close { background: none; border: none; color: #93c5fd; font-size: 1.1rem; cursor: pointer; line-height: 1; }
.pm-pp-tabs { display: flex; gap: 0.35rem; margin-bottom: 0.45rem; }
.pm-pp-tab {
  flex: 1; padding: 0.3rem 0.4rem; border-radius: 0.45rem; font-size: 0.72rem;
  border: 1px solid rgba(56,189,248,0.25); background: rgba(15,23,42,0.6); color: #93c5fd; cursor: pointer;
}
.pm-pp-tab.active { background: rgba(8,145,178,0.35); color: #e0f2fe; border-color: rgba(56,189,248,0.5); }
.pm-pp-filters { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.45rem; }
.pm-pp-filters select {
  flex: 1 1 45%; min-width: 5.5rem; padding: 0.3rem 0.35rem; border-radius: 0.45rem;
  border: 1px solid rgba(56,189,248,0.25); background: rgba(15,23,42,0.75); color: #e0f2fe; font-size: 0.72rem;
}
.pm-pp-search {
  width: 100%; box-sizing: border-box; padding: 0.45rem 0.6rem; margin-bottom: 0.45rem;
  border-radius: 0.55rem; border: 1px solid rgba(56,189,248,0.3);
  background: rgba(15,23,42,0.8); color: #e0f2fe; font-size: 0.82rem;
}
.pm-pp-list { overflow-y: auto; flex: 1 1 auto; margin: 0; padding: 0; list-style: none; min-height: 6rem; }
.pm-pp-item {
  display: flex; align-items: center; gap: 0.4rem; padding: 0.38rem 0.45rem;
  border-radius: 0.5rem; cursor: pointer; font-size: 0.8rem;
}
.pm-pp-item:hover, .pm-pp-item.active { background: rgba(8,145,178,0.22); }
.pm-pp-fav {
  flex: 0 0 auto; background: none; border: none; cursor: pointer; font-size: 0.9rem;
  line-height: 1; padding: 0; color: rgba(148,163,184,0.5);
}
.pm-pp-fav.on { color: #fbbf24; text-shadow: 0 0 6px rgba(251,191,36,0.6); }
.pm-pp-badge {
  flex: 0 0 auto; width: 0.55rem; height: 0.55rem; border-radius: 50%;
  background: #6b7280;
}
.pm-pp-badge.ok { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.8); }
.pm-pp-badge.broken { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.7); }
.pm-pp-label { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pm-pp-meta { flex: 0 0 auto; font-size: 0.65rem; color: rgba(148,163,184,0.85); text-transform: uppercase; }
.pm-pp-actions { display: flex; gap: 0.35rem; margin-top: 0.5rem; flex-wrap: wrap; }
.pm-pp-btn {
  flex: 1 1 40%; padding: 0.38rem 0.45rem; border-radius: 0.5rem;
  border: 1px solid rgba(56,189,248,0.35); background: rgba(8,145,178,0.18);
  color: #e0f2fe; cursor: pointer; font-size: 0.74rem;
}
.pm-pp-btn:hover { background: rgba(8,145,178,0.32); }
.pm-pp-status { margin-top: 0.4rem; font-size: 0.7rem; color: rgba(191,219,254,0.75); min-height: 1em; }
.pm-pp-launch {
  position: fixed; right: 2vh; bottom: 2vh; z-index: 3302;
  padding: 0.5rem 0.8rem; border-radius: 0.6rem;
  border: 1px solid rgba(56,189,248,0.4); background: rgba(8,145,178,0.22);
  color: #e0f2fe; cursor: pointer; font: 0.78rem/1 'Inter', system-ui, sans-serif;
}
.pm-pp-launch:hover { background: rgba(8,145,178,0.4); }
`;

/**
 * Queries an element this module just rendered; a miss is a programming error.
 *
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {Element}
 */
function requireEl(root, selector) {
    const el = root.querySelector(selector);
    if (!el) {
        throw new Error(`projectm-preset-picker: panel is missing ${selector}`);
    }
    return el;
}

/** @param {Document} documentRef */
function injectStyle(documentRef) {
    if (documentRef.getElementById(PICKER_STYLE_ID)) return;
    const style = documentRef.createElement('style');
    style.id = PICKER_STYLE_ID;
    style.textContent = PICKER_CSS;
    documentRef.head.appendChild(style);
}

/**
 * Builds the searchable preset browser panel and its optional launcher button.
 *
 * @param {object} [options]
 * @param {() => ProjectMModuleLike | null | undefined} [options.getModule]
 * @param {StartTransitionFn} [options.startTransitionWhenReady]
 * @param {string} [options.manifestUrl]
 * @param {string} [options.featuredManifestUrl]
 * @param {Document} [options.documentRef]
 * @param {boolean} [options.showLauncher]
 * @param {() => boolean} [options.isLocked]
 * @param {() => void} [options.onLockBlocked] Called when a load is refused by the lock.
 * @param {number} [options.transitionDurationSec]
 * @param {boolean} [options.preloadFeatured]
 */
export function setupPresetPicker({
    getModule,
    startTransitionWhenReady,
    manifestUrl = DEFAULT_MANIFEST_URL,
    featuredManifestUrl = DEFAULT_FEATURED_MANIFEST_URL,
    documentRef = document,
    showLauncher = true,
    isLocked = () => false,
    onLockBlocked,
    transitionDurationSec = 1.5,
    preloadFeatured = true,
} = {}) {
    injectStyle(documentRef);

    const panel = documentRef.createElement('section');
    panel.id = 'pm-preset-picker';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="pm-pp-head">
        <span class="pm-pp-title">Preset Library</span>
        <button class="pm-pp-close" title="Close" aria-label="Close">×</button>
      </div>
      <div class="pm-pp-tabs" role="tablist">
        <button class="pm-pp-tab active" data-tab="all" role="tab">All</button>
        <button class="pm-pp-tab" data-tab="featured" role="tab">Featured</button>
        <button class="pm-pp-tab" data-tab="favorites" role="tab">★ Favs</button>
      </div>
      <div class="pm-pp-filters">
        <select class="pm-pp-tier" aria-label="Performance tier">
          <option value="all">Any tier</option>
          <option value="light">Light</option>
          <option value="medium">Medium</option>
          <option value="heavy">Heavy</option>
        </select>
        <select class="pm-pp-reactivity" aria-label="Reactivity">
          <option value="all">Any reactivity</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="none">Static</option>
        </select>
        <select class="pm-pp-tag" aria-label="Tag">
          <option value="all">All tags</option>
        </select>
      </div>
      <input class="pm-pp-search" type="search" placeholder="Search name, tags, author…" aria-label="Filter presets" />
      <ul class="pm-pp-list" role="listbox"></ul>
      <div class="pm-pp-actions">
        <button class="pm-pp-btn" data-act="prev" title="Previous preset">‹ Prev</button>
        <button class="pm-pp-btn" data-act="random-ok" title="Weighted random (verified)">Random ✓</button>
        <button class="pm-pp-btn" data-act="random" title="Weighted random (any)">Random</button>
        <button class="pm-pp-btn" data-act="next" title="Next preset">Next ›</button>
      </div>
      <div class="pm-pp-status" role="status"></div>
    `;
    documentRef.body.appendChild(panel);

    const listEl = requireEl(panel, '.pm-pp-list');
    const searchEl = /** @type {HTMLInputElement} */ (requireEl(panel, '.pm-pp-search'));
    const statusEl = /** @type {HTMLElement} */ (requireEl(panel, '.pm-pp-status'));
    const tierEl = /** @type {HTMLSelectElement} */ (requireEl(panel, '.pm-pp-tier'));
    const reactEl = /** @type {HTMLSelectElement} */ (requireEl(panel, '.pm-pp-reactivity'));
    const tagEl = /** @type {HTMLSelectElement} */ (requireEl(panel, '.pm-pp-tag'));
    const tabEls = /** @type {NodeListOf<HTMLButtonElement>} */ (
        panel.querySelectorAll('.pm-pp-tab')
    );

    /** @type {HTMLButtonElement | null} */
    let launcher = null;
    if (showLauncher) {
        launcher = documentRef.createElement('button');
        launcher.className = 'pm-pp-launch';
        launcher.textContent = '🎛 Presets';
        launcher.title = 'Browse presets — tags, favorites, featured pack';
        documentRef.body.appendChild(launcher);
        launcher.addEventListener('click', () => toggle());
    }

    /** @type {PresetEntry[]} */
    let allPresets = [];
    /** @type {PresetEntry[]} */
    let featuredPresets = [];
    let activeTab = 'all';
    /** @type {PresetEntry[]} */
    let filtered = [];
    /** @type {string | null} */
    let currentId = null;

    function activePool() {
        if (activeTab === 'featured' && featuredPresets.length) return featuredPresets;
        if (activeTab === 'favorites') {
            return allPresets.filter((p) => isFavorite(p));
        }
        return allPresets;
    }

    /** @returns {PresetFilters} */
    function currentFilters() {
        return {
            query: searchEl.value,
            tier: tierEl.value,
            reactivity: reactEl.value,
            tag: tagEl.value,
            pack: 'all',
        };
    }

    /**
     * @param {string} msg
     * @param {boolean} [isError]
     */
    function setStatus(msg, isError = false) {
        statusEl.textContent = msg || '';
        statusEl.style.color = isError ? '#fecaca' : 'rgba(191,219,254,0.75)';
    }

    function populateTagSelect() {
        const tags = collectTags(allPresets);
        tagEl.innerHTML = '<option value="all">All tags</option>';
        for (const t of tags) {
            const opt = documentRef.createElement('option');
            opt.value = t;
            opt.textContent = t;
            tagEl.appendChild(opt);
        }
    }

    function render() {
        filtered = filterPresets(activePool(), currentFilters());
        listEl.textContent = '';
        for (const p of filtered) {
            const li = documentRef.createElement('li');
            li.className = 'pm-pp-item';
            li.setAttribute('role', 'option');
            li.dataset.id = presetId(p);
            if (presetId(p) === currentId) li.classList.add('active');

            const favBtn = documentRef.createElement('button');
            favBtn.className = `pm-pp-fav${isFavorite(p) ? ' on' : ''}`;
            favBtn.textContent = '★';
            favBtn.title = isFavorite(p) ? 'Remove favorite' : 'Add favorite';
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFavorite(p);
                render();
            });

            const badge = documentRef.createElement('span');
            badge.className = `pm-pp-badge ${p.status || 'unknown'}`;
            badge.title = p.status === 'ok' ? 'Verified' : p.status === 'broken' ? 'Broken' : 'Unknown';

            const label = documentRef.createElement('span');
            label.className = 'pm-pp-label';
            label.title = p.label ?? p.file;
            label.textContent = p.label ?? p.file;

            const meta = documentRef.createElement('span');
            meta.className = 'pm-pp-meta';
            meta.textContent = typeof p.tier === 'string' ? p.tier.slice(0, 1) : '';

            li.appendChild(favBtn);
            li.appendChild(badge);
            li.appendChild(label);
            li.appendChild(meta);
            li.addEventListener('click', () => loadByEntry(p));
            listEl.appendChild(li);
        }
    }

    /** @param {PresetEntry | null | undefined} preset */
    async function loadByEntry(preset) {
        if (!preset) return;
        currentId = presetId(preset);
        const module = getModule ? getModule() : null;
        if (!module) {
            setStatus('Visualizer not ready yet.', true);
            return;
        }
        setStatus(`Loading ${preset.label}…`);
        render();
        try {
            await loadPresetEntry(preset, {
                module,
                startTransitionWhenReady,
                transitionDurationSec,
            });
            setStatus(`Loaded ${preset.label}${preset.tier ? ` · ${preset.tier}` : ''}`);
        } catch (error) {
            setStatus(`Failed: ${error instanceof Error ? error.message : error}`, true);
        }
    }

    /** @param {string} file */
    async function loadByFile(file) {
        const preset = allPresets.find((p) => p.file === file)
            || featuredPresets.find((p) => p.file === file);
        if (preset) await loadByEntry(preset);
    }

    function guardLocked() {
        if (isLocked()) {
            onLockBlocked?.();
            setStatus('Preset locked — unlock to change.', true);
            return true;
        }
        return false;
    }

    /** @param {number} delta +1 for next, -1 for previous. */
    function step(delta) {
        if (guardLocked()) return;
        const pool = filtered.length ? filtered : filterPresets(activePool(), currentFilters());
        if (!pool.length) return;
        let idx = pool.findIndex((p) => presetId(p) === currentId);
        idx = idx < 0
            ? (delta > 0 ? 0 : pool.length - 1)
            : (idx + delta + pool.length) % pool.length;
        loadByEntry(pool[idx]);
    }

    function pickRandom({ onlyOk = false } = {}) {
        if (guardLocked()) return null;
        const pool = filterPresets(activePool(), { ...currentFilters(), onlyOk, excludeBroken: true });
        const choice = pickWeightedRandom(pool.length ? pool : activePool(), { onlyOk, excludeBroken: true });
        if (choice) loadByEntry(choice);
        return choice;
    }

    function open() { panel.hidden = false; if (launcher) launcher.style.display = 'none'; searchEl.focus(); }
    function close() { panel.hidden = true; if (launcher) launcher.style.display = ''; }
    function toggle() { (panel.hidden ? open : close)(); }

    requireEl(panel, '.pm-pp-close').addEventListener('click', close);
    searchEl.addEventListener('input', render);
    tierEl.addEventListener('change', render);
    reactEl.addEventListener('change', render);
    tagEl.addEventListener('change', render);
    tabEls.forEach((tab) => {
        tab.addEventListener('click', () => {
            activeTab = tab.dataset.tab ?? 'all';
            tabEls.forEach((t) => t.classList.toggle('active', t === tab));
            render();
        });
    });
    const actionButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (
        panel.querySelectorAll('.pm-pp-btn')
    );
    actionButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const act = btn.dataset.act;
            if (act === 'next') step(1);
            else if (act === 'prev') step(-1);
            else if (act === 'random') pickRandom({ onlyOk: false });
            else if (act === 'random-ok') pickRandom({ onlyOk: true });
        });
    });

    const ready = fetchCustomPresetManifest({ url: manifestUrl })
        .then(async (data) => {
            allPresets = data.presets;
            populateTagSelect();
            render();
            const okCount = allPresets.filter((p) => p.status === 'ok').length;
            setStatus(`${allPresets.length} presets — ${okCount} verified.`);

            try {
                const featured = await fetchFeaturedManifest({ url: featuredManifestUrl });
                featuredPresets = featured.presets || [];
                if (preloadFeatured && featuredPresets.length) {
                    preloadFeaturedPack(featured, {
                        onProgress: (done, total) => {
                            if (done === total) setStatus(`${allPresets.length} presets · featured pack cached (${total}).`);
                        },
                    }).catch(() => {});
                }
                const favorites = getFavorites();
                if (favorites.size > 0) {
                    preloadFavoritePresets(allPresets, favorites, {
                        onProgress: (done, total) => {
                            if (done === total && total > 0) {
                                setStatus(`${allPresets.length} presets · ${total} favorite(s) cached.`);
                            }
                        },
                    }).catch(() => {});
                }
            } catch {
                featuredPresets = allPresets.filter((p) => p.featured);
            }
            return allPresets;
        })
        .catch((error) => {
            setStatus(`Could not load preset list: ${error instanceof Error ? error.message : error}`, true);
            console.error('[ProjectM] preset picker manifest load failed:', error);
            return [];
        });

    return {
        open, close, toggle, loadByFile, loadByEntry, step, pickRandom, ready,
        element: panel, getPresets: () => allPresets,
    };
}
