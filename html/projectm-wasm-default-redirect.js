// Keep DEFAULT_WASM_VERSION in sync with PROJECTM_WASM_DEFAULT_VERSION in projectm-wasm-version.js
// (checked by scripts/verify_wasm_version_sync.sh).
var DEFAULT_WASM_VERSION = '032';
(function () {
    try {
        var params = new URLSearchParams(window.location.search);
        if (params.has('wasm')) {
            return;
        }
        params.set('wasm', DEFAULT_WASM_VERSION);
        var query = params.toString();
        var next = window.location.pathname + (query ? '?' + query : '') + window.location.hash;
        window.location.replace(next);
    } catch (err) {
        // Ignore redirect failures (sandboxed docs, very old browsers).
    }
})();
