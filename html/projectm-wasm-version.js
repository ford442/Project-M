/**
 * Canonical WASM bundle version for browser hosts and npm embedders.
 *
 * Keep in sync with:
 * - scripts/prepare_deploy_bundle.sh (PROJECTM_WASM_VERSION default)
 * - scripts/verify_deploy_urls.sh (default bundle name)
 * - scripts/verify_wasm_version_sync.sh (CI check)
 */
export const PROJECTM_WASM_VERSION = '039';

/**
 * First-party host default for `?wasm=` (redirect + picker fallback).
 * May temporarily lag `PROJECTM_WASM_VERSION` when the latest bundle has
 * known regressions. 039 carries the audio-playback/visualization fixes
 * (tracking issue for #269-#274), so the default follows the latest bundle.
 */
export const PROJECTM_WASM_DEFAULT_VERSION = '039';

/** Threaded pthread build suffix used by deploy and hosts. */
export const PROJECTM_WASM_BUNDLE = `projectm-v.${PROJECTM_WASM_VERSION}-thread`;

/**
 * Hardcoded output tag from `scripts/build_wasm_smoke_wrapper.sh` / CI smoke tests.
 * `prepare_deploy_bundle.sh` renames files *and* rewrites this string inside the glue JS
 * when staging a non-030 deploy version. Hosts also remap at runtime as a safety net.
 */
export const PROJECTM_WASM_SMOKE_BUNDLE = 'projectm-v.030-thread';

/**
 * Historical + current threaded bundles selectable from first-party hosts
 * (`?wasm=033` or the panel picker). Older tags usually only exist as UTF-16
 * `.1ijs` at the site root; current (`038`+) prefer UTF-8 `.js` under `pm/`.
 */
export const PROJECTM_WASM_SELECTABLE_VERSIONS = Object.freeze([
    '030',
    '030b',
    '032',
    '033',
    '034',
    '035',
    '036',
    '037',
    '038',
    '039',
]);

/**
 * Tags deployed with UTF-8 `.js` glue under `pm/` (checked against
 * projectm.1ink.us). Everything else only exists as the legacy UTF-16 `.1ijs`,
 * which DreamHost gzips into ERR_CONTENT_DECODING_FAILED.
 *
 * Only the fallback for when `pm/builds.json` cannot be fetched: the manifest
 * names each build's glue file, so new versions need no edit here (see
 * docs/adr/0001-wasm-and-media-hosting.md).
 */
export const PROJECTM_WASM_UTF8_GLUE_VERSIONS = Object.freeze(['030', '035', '036', '037', '038', '039']);

/** Site-relative path of the build manifest (`scripts/generate_wasm_builds_manifest.mjs`). */
export const PROJECTM_WASM_BUILDS_MANIFEST_PATH = 'pm/builds.json';

/** Manifest `schema` this host understands. */
export const PROJECTM_WASM_BUILDS_SCHEMA = 1;

/** Build `status` values that hosts list in the version picker. */
export const PROJECTM_WASM_LISTED_STATUSES = Object.freeze(['stable', 'beta', 'legacy']);

/**
 * @typedef {object} WasmBuildEntry
 * @property {string} glue Site-relative path of the UTF-8 glue (`pm/…js`).
 * @property {string} wasm Site-relative path of the `.wasm`.
 * @property {string | null} worker Site-relative path of a separate pthread worker script, if any.
 * @property {{ glue?: string, wasm?: string }} sha256 Hex digests of the deployed bytes.
 * @property {string[] | null} api Exported C symbols (no leading underscore); null when unknown.
 * @property {string} status `stable` | `beta` | `legacy` | `withdrawn`.
 */

/**
 * @typedef {object} WasmBuildsManifest
 * @property {number} schema
 * @property {string} default Version the first-party hosts load without `?wasm=`.
 * @property {string} latest Newest deployed version.
 * @property {Record<string, WasmBuildEntry>} builds
 */

/** @type {WasmBuildsManifest | null} */
let registeredManifest = null;

const VERSION_TAG_RE = /^[0-9]{3}[a-z]?$/;
const MANIFEST_PATH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Validates a parsed `pm/builds.json`. Returns null (never throws) when the
 * document is not a manifest this host can use, so a bad deploy degrades to
 * the built-in table instead of breaking boot.
 *
 * @param {unknown} json
 * @returns {WasmBuildsManifest | null}
 */
export function parseWasmBuildsManifest(json) {
    if (!json || typeof json !== 'object') return null;
    const raw = /** @type {Record<string, any>} */ (json);
    if (raw.schema !== PROJECTM_WASM_BUILDS_SCHEMA || !raw.builds || typeof raw.builds !== 'object') {
        return null;
    }
    /** @type {Record<string, WasmBuildEntry>} */
    const builds = {};
    for (const [version, entry] of Object.entries(raw.builds)) {
        if (!VERSION_TAG_RE.test(version) || !entry || typeof entry !== 'object') continue;
        const { glue, wasm } = entry;
        // Paths are site-relative and plain: no scheme, no `..`, no leading slash.
        const pathOk = (/** @type {unknown} */ p) => typeof p === 'string' && MANIFEST_PATH_RE.test(p) && !p.includes('..') && !p.startsWith('/');
        if (!pathOk(glue) || !pathOk(wasm)) continue;
        builds[version] = {
            glue,
            wasm,
            worker: pathOk(entry.worker) ? entry.worker : null,
            sha256: entry.sha256 && typeof entry.sha256 === 'object' ? { ...entry.sha256 } : {},
            api: Array.isArray(entry.api) ? entry.api.filter((/** @type {unknown} */ n) => typeof n === 'string') : null,
            status: typeof entry.status === 'string' ? entry.status : 'stable',
        };
    }
    const versions = Object.keys(builds);
    if (versions.length === 0) return null;
    const pick = (/** @type {unknown} */ v) => (typeof v === 'string' && builds[v] ? v : null);
    const latest = pick(raw.latest) || versions.sort().at(-1) || versions[0];
    return {
        schema: PROJECTM_WASM_BUILDS_SCHEMA,
        default: pick(raw.default) || latest,
        latest,
        builds,
    };
}

/**
 * Makes `manifest` the one {@link buildWasmBundlePaths} and
 * {@link normalizeWasmVersion} consult (`projectm-wasm-manifest.js` calls this
 * after fetching it). Pass null to go back to the built-in table.
 *
 * @param {WasmBuildsManifest | null} manifest
 */
export function setWasmBuildsManifest(manifest) {
    registeredManifest = manifest;
}

/** @returns {WasmBuildsManifest | null} */
export function getWasmBuildsManifest() {
    return registeredManifest;
}

/**
 * Versions the picker offers: the manifest's listed builds when one is
 * registered, newest first, else the built-in list.
 *
 * @param {WasmBuildsManifest | null} [manifest]
 * @returns {readonly string[]}
 */
export function getSelectableWasmVersions(manifest = registeredManifest) {
    if (!manifest) return PROJECTM_WASM_SELECTABLE_VERSIONS;
    return Object.keys(manifest.builds)
        .filter((version) => PROJECTM_WASM_LISTED_STATUSES.includes(manifest.builds[version].status))
        .sort()
        .reverse();
}

/**
 * Default version for hosts: the manifest's `default`, else the built-in one.
 *
 * @param {WasmBuildsManifest | null} [manifest]
 * @returns {string}
 */
export function getDefaultWasmVersion(manifest = registeredManifest) {
    return manifest?.default || PROJECTM_WASM_DEFAULT_VERSION;
}

/**
 * True when the build is known to export `symbol` (no leading underscore), or
 * when its export list is unknown (no manifest, or an entry without `api`):
 * callers then keep their old "try it and handle the error" behaviour.
 *
 * @param {{ api?: readonly string[] | null } | null | undefined} build
 * @param {string} symbol
 * @returns {boolean}
 */
export function wasmBuildHasApi(build, symbol) {
    if (!build || !Array.isArray(build.api)) return true;
    return build.api.includes(symbol.replace(/^_/, ''));
}

/** localStorage key for the last selected WASM version (URL `?wasm=` wins). */
export const PROJECTM_WASM_VERSION_STORAGE_KEY = 'projectm-wasm-version';

// Prefer UTF-8 `.js` glue. DreamHost Apache gzips the legacy UTF-16 `.1ijs`
// variant; Chrome then fails with net::ERR_CONTENT_DECODING_FAILED (pthread
// workers re-fetch the same URL), which surfaces as RuntimeError: null function
// when calling `_init`. Keep `.1ijs` on the CDN for older embeds that hardcode it.
export const PROJECTM_WASM_SCRIPT_PM = `./pm/${PROJECTM_WASM_BUNDLE}.js`;
export const PROJECTM_WASM_SCRIPT_ROOT = `./${PROJECTM_WASM_BUNDLE}.js`;

/** Preferred deploy layout (pm/ mirror). */
export const PROJECTM_WASM_SCRIPT = PROJECTM_WASM_SCRIPT_PM;

/** Default CDN base used by first-party demos (override per host). */
export const PROJECTM_WASM_DEFAULT_CDN_BASE = 'https://projectm.1ink.us';

/**
 * Normalize a user/URL version token to a selectable tag (e.g. `035`), or null.
 * A version the registered manifest lists is selectable even when the
 * built-in list predates it.
 *
 * @param {unknown} raw
 * @param {WasmBuildsManifest | null} [manifest]
 * @returns {string | null}
 */
export function normalizeWasmVersion(raw, manifest = registeredManifest) {
    if (raw == null) {
        return null;
    }
    let text = String(raw).trim().toLowerCase();
    if (!text) {
        return null;
    }
    const bundleMatch = text.match(/projectm-v\.([0-9]{3}[a-z]?)-thread/);
    if (bundleMatch) {
        text = bundleMatch[1];
    } else {
        text = text.replace(/^v\.?/, '');
    }
    if (manifest?.builds[text]) {
        return text;
    }
    return PROJECTM_WASM_SELECTABLE_VERSIONS.includes(text) ? text : null;
}

/**
 * @typedef {object} WasmBundlePaths
 * @property {string} version
 * @property {string} bundle `projectm-v.NNN-thread`
 * @property {string} glueExt
 * @property {string} pmScript Glue to try first (page-relative).
 * @property {string} rootScript Glue to try when `pmScript` is missing.
 * @property {'manifest' | 'builtin'} source Where the paths came from.
 * @property {string[] | null} api Exported symbols, when the manifest lists them.
 * @property {string | null} status Manifest `status`, or null for the built-in table.
 */

/**
 * Resolve which glue paths to probe for a selectable WASM version.
 *
 * With a registered manifest that lists the version, its `glue` path is used
 * as-is for both candidates (it is authoritative; no root-layout probe).
 * Otherwise the built-in table guesses `.js` vs `.1ijs`.
 *
 * @param {string} [version=PROJECTM_WASM_VERSION]
 * @param {WasmBuildsManifest | null} [manifest]
 * @returns {WasmBundlePaths}
 */
export function buildWasmBundlePaths(version = PROJECTM_WASM_VERSION, manifest = registeredManifest) {
    const normalized = normalizeWasmVersion(version, manifest) || PROJECTM_WASM_VERSION;
    const bundle = `projectm-v.${normalized}-thread`;
    const entry = manifest?.builds[normalized];
    if (entry) {
        const script = `./${entry.glue}`;
        return {
            version: normalized,
            bundle,
            glueExt: entry.glue.slice(entry.glue.indexOf(`${bundle}.`) + bundle.length + 1) || 'js',
            pmScript: script,
            rootScript: script,
            source: 'manifest',
            api: entry.api,
            status: entry.status,
        };
    }
    // Canonical deploy ships UTF-8 `.js`; older CDN tags are UTF-16 `.1ijs` only.
    const glueExt =
        normalized === PROJECTM_WASM_VERSION || PROJECTM_WASM_UTF8_GLUE_VERSIONS.includes(normalized) ? 'js' : '1ijs';
    return {
        version: normalized,
        bundle,
        glueExt,
        pmScript: `./pm/${bundle}.${glueExt}`,
        rootScript: `./${bundle}.${glueExt}`,
        source: 'builtin',
        api: null,
        status: null,
    };
}

/**
 * Rewrites smoke-build artifact names (v.030) to the canonical deploy bundle name.
 * No-op when the target bundle is already the smoke tag.
 *
 * @param {string} path Artifact path or filename from Emscripten locateFile
 * @param {string} [targetBundle=PROJECTM_WASM_BUNDLE]
 * @param {string} [smokeBundle=PROJECTM_WASM_SMOKE_BUNDLE]
 * @returns {string}
 */
export function remapSmokeWasmArtifactName(
    path,
    targetBundle = PROJECTM_WASM_BUNDLE,
    smokeBundle = PROJECTM_WASM_SMOKE_BUNDLE
) {
    if (!path || !smokeBundle || targetBundle === smokeBundle) {
        return path;
    }
    if (!path.includes(smokeBundle)) {
        return path;
    }
    return path.split(smokeBundle).join(targetBundle);
}

/**
 * Builds absolute URLs for the threaded WASM glue + binary artifacts.
 *
 * @param {string} [baseUrl=PROJECTM_WASM_DEFAULT_CDN_BASE] Site root that hosts pm/
 * @param {string} [version=PROJECTM_WASM_VERSION]
 * @returns {{ scriptPm: string, scriptRoot: string, wasm: string, worker: string, version: string, bundle: string }}
 */
export function buildProjectMWasmUrls(
    baseUrl = PROJECTM_WASM_DEFAULT_CDN_BASE,
    version = PROJECTM_WASM_VERSION
) {
    const root = baseUrl.replace(/\/$/, '');
    const paths = buildWasmBundlePaths(version);
    const entry = registeredManifest?.builds[paths.version];
    return {
        version: paths.version,
        bundle: paths.bundle,
        scriptPm: `${root}/${paths.pmScript.replace(/^\.\//, '')}`,
        scriptRoot: `${root}/${paths.rootScript.replace(/^\.\//, '')}`,
        wasm: `${root}/${entry ? entry.wasm : `pm/${paths.bundle}.wasm`}`,
        worker: `${root}/${entry?.worker || `pm/${paths.bundle}.worker.js`}`,
    };
}
