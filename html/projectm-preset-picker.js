// Named custom-preset picker for the WASM demo hosts.
//
// Surfaces the fork's curated custom_milk_fixed/ presets (see
// docs/kimi_preset_authoring_plan.md) as a searchable, named list with
// known-good/known-broken status badges (from the screenshot capture
// baseline, baked into custom_presets_manifest.json by
// scripts/generate_custom_preset_manifest.mjs) plus prev/next and random.
//
// This is the "preview a specific upgraded shader" complement to the blind
// "Random Custom" button: instead of only random selection, you can pick a
// named preset and see which ones are verified-rendering vs. still broken.
//
// Loading reuses the same VFS-write → load_preset_file → transition flow as
// projectm-presets.js, fetching the raw .milk from a resilient list of bases
// (override via localStorage 'customPresetBase').

import { updatePresetDisplay } from './projectm-presets.js';

export const DEFAULT_MANIFEST_URL = './custom_presets_manifest.json';

// Candidate hosts/paths for the raw .milk bytes, tried in order. The first is
// the legacy production custom-milk host (matches projectM_emscripten.cpp's
// historical scan of https://glsl.1ink.us/custom_milk/); the relative paths
// work when the repo root is served directly (local dev).
export const DEFAULT_CUSTOM_PRESET_BASES = [
    'https://glsl.1ink.us/custom_milk/',
    '../custom_milk_fixed/',
    './custom_milk_fixed/'
];

function safePresetName(filename) {
    return String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function getCustomPresetBases({ preferred, fallbacks = DEFAULT_CUSTOM_PRESET_BASES } = {}) {
    let fromStorage = null;
    try {
        fromStorage = localStorage.getItem('customPresetBase');
    } catch {
        // localStorage may be unavailable (sandboxed iframe); ignore.
    }
    return [...new Set([preferred, fromStorage, ...fallbacks].filter(Boolean))];
}

export async function fetchCustomPresetManifest({
    url = DEFAULT_MANIFEST_URL,
    fetchImpl = fetch
} = {}) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Failed to fetch custom preset manifest (${res.status})`);
    const data = await res.json();
    if (!data || !Array.isArray(data.presets)) {
        throw new Error('Invalid custom preset manifest: missing presets[]');
    }
    return data.presets;
}

// Fetch a custom preset's bytes (trying each base), write to the WASM VFS, load
// it, and kick off the transition. Returns { vfsPath, filename, base }.
export async function loadCustomPresetFile(file, {
    module,
    startTransitionWhenReady,
    bases,
    updateDisplay = true,
    label,
    fetchImpl = fetch
} = {}) {
    if (!module || !module.FS || !module.ccall || !module._load_preset_file) {
        throw new Error('Module not ready');
    }
    const filename = String(file).split('/').pop();
    const candidates = bases || getCustomPresetBases();
    let lastError = null;

    for (const base of candidates) {
        try {
            const sep = base.endsWith('/') ? '' : '/';
            const res = await fetchImpl(`${base}${sep}${encodeURIComponent(filename)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}`);
            const bytes = new Uint8ClampedArray(await res.arrayBuffer());

            const vfsPath = `/presets/custom_${safePresetName(filename)}`;
            module.FS.writeFile(vfsPath, bytes);
            module.ccall('load_preset_file', null, ['string'], [vfsPath]);
            if (startTransitionWhenReady) startTransitionWhenReady({ module });
            if (updateDisplay) updatePresetDisplay(label || filename);
            return { vfsPath, filename, base };
        } catch (error) {
            lastError = error;
            console.warn('[ProjectM] custom preset fetch attempt failed:', base, error);
        }
    }
    throw lastError || new Error('No custom preset base available');
}

export function pickRandomFromList(presets, { onlyOk = false } = {}) {
    const pool = onlyOk ? presets.filter((p) => p.status === 'ok') : presets;
    const effective = pool.length ? pool : presets;
    if (!effective.length) return null;
    return effective[Math.floor(Math.random() * effective.length)];
}

const PICKER_STYLE_ID = 'pm-preset-picker-style';
const PICKER_CSS = `
#pm-preset-picker {
  position: fixed; right: 2vh; bottom: 2vh; z-index: 3303;
  width: min(24rem, 44vw); max-height: 70vh; display: flex; flex-direction: column;
  padding: 0.8rem; border-radius: 0.9rem;
  background: rgba(2, 6, 23, 0.92); border: 1px solid rgba(56, 189, 248, 0.3);
  color: #dbeafe; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5); backdrop-filter: blur(8px);
  font-family: 'Inter', system-ui, sans-serif;
}
#pm-preset-picker[hidden] { display: none !important; }
.pm-pp-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
.pm-pp-title { font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: #7dd3fc; }
.pm-pp-close { background: none; border: none; color: #93c5fd; font-size: 1.1rem; cursor: pointer; line-height: 1; }
.pm-pp-search {
  width: 100%; box-sizing: border-box; padding: 0.45rem 0.6rem; margin-bottom: 0.5rem;
  border-radius: 0.55rem; border: 1px solid rgba(56,189,248,0.3);
  background: rgba(15,23,42,0.8); color: #e0f2fe; font-size: 0.82rem;
}
.pm-pp-list { overflow-y: auto; flex: 1 1 auto; margin: 0; padding: 0; list-style: none; }
.pm-pp-item {
  display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.5rem;
  border-radius: 0.5rem; cursor: pointer; font-size: 0.82rem;
}
.pm-pp-item:hover, .pm-pp-item.active { background: rgba(8,145,178,0.22); }
.pm-pp-badge {
  flex: 0 0 auto; width: 0.6rem; height: 0.6rem; border-radius: 50%;
  background: #6b7280;
}
.pm-pp-badge.ok { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.8); }
.pm-pp-badge.broken { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.7); }
.pm-pp-label { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pm-pp-file { flex: 0 0 auto; font-size: 0.7rem; color: rgba(148,163,184,0.8); }
.pm-pp-actions { display: flex; gap: 0.4rem; margin-top: 0.55rem; }
.pm-pp-btn {
  flex: 1 1 auto; padding: 0.4rem 0.5rem; border-radius: 0.5rem;
  border: 1px solid rgba(56,189,248,0.35); background: rgba(8,145,178,0.18);
  color: #e0f2fe; cursor: pointer; font-size: 0.76rem;
}
.pm-pp-btn:hover { background: rgba(8,145,178,0.32); }
.pm-pp-status { margin-top: 0.45rem; font-size: 0.72rem; color: rgba(191,219,254,0.75); min-height: 1em; }
.pm-pp-launch {
  position: fixed; right: 2vh; bottom: 2vh; z-index: 3302;
  padding: 0.5rem 0.8rem; border-radius: 0.6rem;
  border: 1px solid rgba(56,189,248,0.4); background: rgba(8,145,178,0.22);
  color: #e0f2fe; cursor: pointer; font: 0.78rem/1 'Inter', system-ui, sans-serif;
}
.pm-pp-launch:hover { background: rgba(8,145,178,0.4); }
`;

function injectStyle(documentRef) {
    if (documentRef.getElementById(PICKER_STYLE_ID)) return;
    const style = documentRef.createElement('style');
    style.id = PICKER_STYLE_ID;
    style.textContent = PICKER_CSS;
    documentRef.head.appendChild(style);
}

// Build the picker UI and wire it up. Returns control methods. `getModule`
// must return the live Module (init is async, so we read it at click time).
export function setupPresetPicker({
    getModule,
    startTransitionWhenReady,
    manifestUrl = DEFAULT_MANIFEST_URL,
    documentRef = document,
    showLauncher = true
} = {}) {
    injectStyle(documentRef);

    const panel = documentRef.createElement('section');
    panel.id = 'pm-preset-picker';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="pm-pp-head">
        <span class="pm-pp-title">Custom Presets</span>
        <button class="pm-pp-close" title="Close" aria-label="Close">×</button>
      </div>
      <input class="pm-pp-search" type="search" placeholder="Filter presets…" aria-label="Filter presets" />
      <ul class="pm-pp-list" role="listbox"></ul>
      <div class="pm-pp-actions">
        <button class="pm-pp-btn" data-act="prev" title="Previous preset">‹ Prev</button>
        <button class="pm-pp-btn" data-act="random-ok" title="Random known-good preset">Random ✓</button>
        <button class="pm-pp-btn" data-act="random" title="Random (any) preset">Random</button>
        <button class="pm-pp-btn" data-act="next" title="Next preset">Next ›</button>
      </div>
      <div class="pm-pp-status" role="status"></div>
    `;
    documentRef.body.appendChild(panel);

    const listEl = panel.querySelector('.pm-pp-list');
    const searchEl = panel.querySelector('.pm-pp-search');
    const statusEl = panel.querySelector('.pm-pp-status');

    let launcher = null;
    if (showLauncher) {
        launcher = documentRef.createElement('button');
        launcher.className = 'pm-pp-launch';
        launcher.textContent = '🎛 Presets';
        launcher.title = 'Browse & preview custom presets by name';
        documentRef.body.appendChild(launcher);
        launcher.addEventListener('click', () => toggle());
    }

    let presets = [];
    let filtered = [];
    let currentIndex = -1;

    function setStatus(msg, isError = false) {
        statusEl.textContent = msg || '';
        statusEl.style.color = isError ? '#fecaca' : 'rgba(191,219,254,0.75)';
    }

    function render() {
        const q = searchEl.value.trim().toLowerCase();
        filtered = q
            ? presets.filter((p) => p.label.toLowerCase().includes(q) || p.file.toLowerCase().includes(q))
            : presets.slice();
        listEl.textContent = '';
        for (const p of filtered) {
            const li = documentRef.createElement('li');
            li.className = 'pm-pp-item';
            li.setAttribute('role', 'option');
            li.dataset.file = p.file;
            if (p.file === (presets[currentIndex] && presets[currentIndex].file)) li.classList.add('active');
            const badgeTitle = p.status === 'broken'
                ? `Known-broken in last capture${p.note ? `: ${p.note}` : ''}`
                : p.status === 'ok'
                    ? `Verified rendering (meanRgb ${p.meanRgb ?? '?'})`
                    : 'Not yet captured';
            li.innerHTML = `
              <span class="pm-pp-badge ${p.status}" title="${badgeTitle}"></span>
              <span class="pm-pp-label" title="${p.label}">${p.label}</span>
              <span class="pm-pp-file">${p.file.replace(/\.milk$/i, '')}</span>
            `;
            li.addEventListener('click', () => loadByFile(p.file));
            listEl.appendChild(li);
        }
    }

    async function loadByFile(file) {
        const idx = presets.findIndex((p) => p.file === file);
        const preset = presets[idx];
        if (!preset) return;
        currentIndex = idx;
        const module = getModule ? getModule() : null;
        if (!module) {
            setStatus('Visualizer not ready yet.', true);
            return;
        }
        setStatus(`Loading ${preset.label}…`);
        render();
        try {
            await loadCustomPresetFile(preset.file, {
                module,
                startTransitionWhenReady,
                label: preset.label
            });
            setStatus(
                preset.status === 'broken'
                    ? `Loaded ${preset.label} (flagged broken — may not render)`
                    : `Loaded ${preset.label}`
            );
        } catch (error) {
            setStatus(`Failed to load ${preset.file}: ${error instanceof Error ? error.message : error}`, true);
        }
    }

    function step(delta) {
        if (!presets.length) return;
        currentIndex = currentIndex < 0
            ? (delta > 0 ? 0 : presets.length - 1)
            : (currentIndex + delta + presets.length) % presets.length;
        loadByFile(presets[currentIndex].file);
    }

    function pickRandom({ onlyOk = false } = {}) {
        const choice = pickRandomFromList(presets, { onlyOk });
        if (choice) loadByFile(choice.file);
        return choice;
    }

    function open() { panel.hidden = false; if (launcher) launcher.style.display = 'none'; searchEl.focus(); }
    function close() { panel.hidden = true; if (launcher) launcher.style.display = ''; }
    function toggle() { (panel.hidden ? open : close)(); }

    panel.querySelector('.pm-pp-close').addEventListener('click', close);
    searchEl.addEventListener('input', render);
    panel.querySelectorAll('.pm-pp-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const act = btn.dataset.act;
            if (act === 'next') step(1);
            else if (act === 'prev') step(-1);
            else if (act === 'random') pickRandom({ onlyOk: false });
            else if (act === 'random-ok') pickRandom({ onlyOk: true });
        });
    });

    const ready = fetchCustomPresetManifest({ url: manifestUrl })
        .then((items) => {
            presets = items;
            render();
            const okCount = presets.filter((p) => p.status === 'ok').length;
            setStatus(`${presets.length} custom presets — ${okCount} verified rendering.`);
            return presets;
        })
        .catch((error) => {
            setStatus(`Could not load preset list: ${error instanceof Error ? error.message : error}`, true);
            console.error('[ProjectM] preset picker manifest load failed:', error);
            return [];
        });

    return { open, close, toggle, loadByFile, step, pickRandom, ready, element: panel };
}
