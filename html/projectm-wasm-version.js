/**
 * Canonical WASM bundle version for browser hosts and npm embedders.
 *
 * Keep in sync with:
 * - scripts/prepare_deploy_bundle.sh (PROJECTM_WASM_VERSION default)
 * - scripts/verify_deploy_urls.sh (default bundle name)
 * - scripts/verify_wasm_version_sync.sh (CI check)
 */
export const PROJECTM_WASM_VERSION = '035';

/** Threaded pthread build suffix used by deploy and hosts. */
export const PROJECTM_WASM_BUNDLE = `projectm-v.${PROJECTM_WASM_VERSION}-thread`;

/**
 * Hardcoded output tag from `scripts/build_wasm_smoke_wrapper.sh` / CI smoke tests.
 * `prepare_deploy_bundle.sh` renames files *and* rewrites this string inside the glue JS
 * when staging a non-030 deploy version. Hosts also remap at runtime as a safety net.
 */
export const PROJECTM_WASM_SMOKE_BUNDLE = 'projectm-v.030-thread';

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
 * @returns {{ scriptPm: string, scriptRoot: string, wasm: string, worker: string }}
 */
export function buildProjectMWasmUrls(baseUrl = PROJECTM_WASM_DEFAULT_CDN_BASE) {
    const root = baseUrl.replace(/\/$/, '');
    return {
        scriptPm: `${root}/${PROJECTM_WASM_SCRIPT_PM.replace(/^\.\//, '')}`,
        scriptRoot: `${root}/${PROJECTM_WASM_SCRIPT_ROOT.replace(/^\.\//, '')}`,
        wasm: `${root}/pm/${PROJECTM_WASM_BUNDLE}.wasm`,
        worker: `${root}/pm/${PROJECTM_WASM_BUNDLE}.worker.js`,
    };
}
