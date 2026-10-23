// projectm-redirect-stub.js
//
// The whole of a deprecated host page (projectm.1ink, projectm_new.1ink,
// projectm_panel.1ink): forward to the page that replaced it, keeping the
// query and hash. The page names the target on the script tag:
//
//   <script src="./projectm-redirect-stub.js"
//           data-target="./projectm-core.html"
//           data-set="experimental=1"></script>
//
// `data-set` is an optional query string merged over the current one. A
// classic script, so it runs (and redirects) before the page renders; the
// page's <noscript> meta refresh covers the no-JS case. See html/README.md
// ".1ink Deprecation Path".

(function redirectStub() {
    const script = /** @type {HTMLScriptElement | null} */ (document.currentScript);
    const target = script?.dataset.target;
    if (!target) return;
    try {
        const params = new URLSearchParams(window.location.search);
        new URLSearchParams(script.dataset.set ?? '').forEach((value, key) => params.set(key, value));
        const query = params.toString();
        window.location.replace(`${target}${query ? `?${query}` : ''}${window.location.hash}`);
    } catch {
        window.location.href = target + (script.dataset.set ? `?${script.dataset.set}` : '');
    }
})();
