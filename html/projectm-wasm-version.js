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

export const PROJECTM_WASM_SCRIPT_PM = `./pm/${PROJECTM_WASM_BUNDLE}.1ijs`;
export const PROJECTM_WASM_SCRIPT_ROOT = `./${PROJECTM_WASM_BUNDLE}.1ijs`;

/** Preferred deploy layout (pm/ mirror). */
export const PROJECTM_WASM_SCRIPT = PROJECTM_WASM_SCRIPT_PM;

/** Default CDN base used by first-party demos (override per host). */
export const PROJECTM_WASM_DEFAULT_CDN_BASE = 'https://projectm.1ink.us';

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
