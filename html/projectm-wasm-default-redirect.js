// Adds ?wasm=<default> to the page URL when it has none, so the version in use
// is visible and shareable.
//
// The default comes from pm/builds.json (`default`, written at deploy by
// scripts/generate_wasm_builds_manifest.mjs), so changing it needs no host
// page redeploy. DEFAULT_WASM_VERSION is the fallback when the manifest is
// missing, slow, or invalid. Keep it in sync with PROJECTM_WASM_DEFAULT_VERSION
// in projectm-wasm-version.js (checked by scripts/verify_wasm_version_sync.sh).
var DEFAULT_WASM_VERSION = '039';
(function () {
    var MANIFEST_TIMEOUT_MS = 1200;
    /** @type {any} */
    var win = window;
    /** @type {URLSearchParams} */
    var params;
    try {
        params = new URLSearchParams(window.location.search);
        if (params.has('wasm')) {
            return;
        }
    } catch (err) {
        // Ignore redirect failures (sandboxed docs, very old browsers).
        return;
    }

    // The page is about to navigate: hosts check this before booting the
    // engine (projectm_panel2.1ink), so it is not started twice.
    win.__projectMWasmRedirectPending = true;
    var done = false;
    /** @param {string} version */
    function redirect(version) {
        if (done) {
            return;
        }
        done = true;
        try {
            params.set('wasm', version || DEFAULT_WASM_VERSION);
            var query = params.toString();
            window.location.replace(window.location.pathname + (query ? '?' + query : '') + window.location.hash);
        } catch (err) {
            win.__projectMWasmRedirectPending = false;
        }
    }

    if (typeof fetch !== 'function') {
        redirect(DEFAULT_WASM_VERSION);
        return;
    }
    var timer = setTimeout(function () { redirect(DEFAULT_WASM_VERSION); }, MANIFEST_TIMEOUT_MS);
    fetch('./pm/builds.json', { cache: 'no-cache', credentials: 'omit' })
        .then(function (response) {
            var type = response.headers.get('content-type') || '';
            return response.ok && /json/i.test(type) ? response.json() : null;
        })
        .then(function (manifest) {
            var version = manifest && manifest.schema === 1 && manifest.builds
                && typeof manifest['default'] === 'string' && manifest.builds[manifest['default']]
                ? manifest['default']
                : DEFAULT_WASM_VERSION;
            clearTimeout(timer);
            redirect(version);
        }, function () {
            clearTimeout(timer);
            redirect(DEFAULT_WASM_VERSION);
        });
})();
