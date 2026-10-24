// flac-player/preboot.js
//
// Runs (as a classic script, before anything else on the page) the two things
// the FLAC player bundle and its CSS expect to find already set:
//   - the Node-ish globals its webpack build reads (`global`, `process`);
//   - audio-only (embed) mode, when the page was opened as projectM's audio
//     source: ?projectm=1 or the popup name the host uses. The stylesheet keys
//     off `data-projectm-audio-only` on <html>, so setting it here avoids a
//     flash of the full player UI.

(function preboot() {
    const win =
        /** @type {Window & { global?: unknown, process?: unknown, __projectMAudioOnly?: boolean, __projectMEmbed?: boolean }} */ (
            window
        );
    win.global = window;
    win.process = win.process || { env: {}, browser: true };
    const params = new URLSearchParams(window.location.search);
    const audioOnly = params.get('projectm') === '1' || window.name === 'flac-player';
    win.__projectMAudioOnly = audioOnly;
    win.__projectMEmbed = audioOnly;
    if (audioOnly) document.documentElement.setAttribute('data-projectm-audio-only', '1');
})();
