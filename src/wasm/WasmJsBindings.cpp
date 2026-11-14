// WasmJsBindings.cpp
//
// EM_JS clusters that are glue and nothing else: the main-thread VFS/song
// bootstrap (js_init_projectm_glue) and the preset-name / init-error /
// preset-switch-failure notifications back to the host page.
//
// No DOM and no network in here. Fetching presets, textures and song catalogs,
// and writing status text, are the host page's job (html/projectm-presets.js,
// html/projectm-textures.js, html/projectm-weeks-on-fire.js, the page's own
// `pmOn*` subscribers); the engine only tells the page what happened. This used
// to scrape `#milkPath`/`#textureDir` out of the page, download with
// XMLHttpRequest and write `#stat` with innerHTML, and a host page without
// those elements threw. tests/web/wasm-glue-dom.test.mjs keeps it that way.
//
// These blocks run in the render worker too (OffscreenCanvas path), where there
// is no `window` and no `document`. Host hooks are read off `globalThis`, which
// is the actual contract with the page.
#include "ProjectMWasmInternal.hpp"
#include "WasmEvents.hpp"
#include "WasmHost.hpp"

// clang-format off
EM_JS(void, js_update_preset_name, (double host, const char* name), {
    const presetName = UTF8ToString(name);
    const deliver = () => {
        if (globalThis.updatePresetDisplay) {
            globalThis.updatePresetDisplay(presetName);
        }
    };
    const queue = Module['pmEventQueue'];
    if (queue) { queue.post(host, deliver); } else { deliver(); }
});
// clang-format on

// Tells the host page that a preset failed to switch, so it can show something
// other than a silently frozen preset. `globalThis.pmOnPresetSwitchFailed(host,
// preset, message)` is the callback bus entry (html/projectm-wasm-callbacks.js);
// the page decides how to surface it. The two `projectMPresetSwitch*` globals
// stay for pages and smoke tests that poll instead of subscribing.
// clang-format off
EM_JS(void, js_report_preset_switch_failed, (double host, const char* preset_filename, const char* message), {
    const name = preset_filename ? UTF8ToString(preset_filename) : '(unknown preset)';
    const msg = message ? UTF8ToString(message) : '';
    console.warn('[projectM] preset switch failed (' + name + '): ' + msg);
    const deliver = () => {
        globalThis.projectMPresetSwitchFailed = true;
        globalThis.projectMPresetSwitchFailure = { preset: name, message: msg };
        if (typeof globalThis.pmOnPresetSwitchFailed === 'function') {
            globalThis.pmOnPresetSwitchFailed(host, name, msg);
        }
    };
    const queue = Module['pmEventQueue'];
    if (queue) { queue.post(host, deliver); } else { deliver(); }
});
// clang-format on

// One-time main-thread setup that only the engine's own module can do: the VFS
// directories the host writes presets, textures and songs into, and the
// BroadcastChannel('file') hook that turns a decoded WAV from the legacy FLAC
// decoder into a /snd file plus a `pl()` call. A worker has no `document`, and
// there the host page owns the VFS (render-worker.js) and the audio worklet
// does not exist, so it returns early.
// clang-format off
EM_JS(void, js_init_projectm_glue, (), {
if (typeof globalThis.document === 'undefined') {
    return;
}
if (globalThis.projectMGlueInitialized) return;
globalThis.projectMGlueInitialized = true;

function vfsPathExists(path) {
    try {
        FS.stat(path);
        return true;
    } catch (e) {
        return false;
    }
}

function vfsMkdir(path) {
    try {
        FS.mkdir(path);
    } catch (e) {
        // Ignore if already exists or other FS errors
    }
}

vfsMkdir('/presets');
vfsMkdir('/textures');
vfsMkdir('/snd');

var lastSongFileName = '';

const fll = new BroadcastChannel('file');
fll.addEventListener('message', ea => {
    const uniqueFileName = `/snd/song_${Date.now()}.wav`;
    console.log(`JS Event: Received new song. Writing to unique path: ${uniqueFileName}`);
    const fill = new Uint8Array(ea.data.data);
    FS.writeFile(uniqueFileName, fill);
    if (lastSongFileName && vfsPathExists(lastSongFileName)) {
        FS.unlink(lastSongFileName);
        console.log(`JS Event: Cleaned up previous song file: ${lastSongFileName}`);
    }
    lastSongFileName = uniqueFileName;
    // Host safety-net (projectm-worklet-playback.js) reads this for retries.
    globalThis.projectMLastSongPath = uniqueFileName;
    setTimeout(function() {
        Module.ccall(
            'pl',                   // C function name
            null,                   // return type
            ['string'],             // argument types
            [uniqueFileName]        // arguments
        );
        const shutDown = new BroadcastChannel('shutDown');
        shutDown.postMessage({data: 222});
    }, 250); // Shorter timeout should be fine
});
});
// clang-format on

// Reports an init() failure to the host page. If the page has defined
// globalThis.pmReportInitError(host, code, detail) (see html/projectm-init-errors.js), it is
// called so an overlay can be shown; otherwise the error is just logged. `host`
// is the engine that failed (EventHostHandle()), so a page running two engines
// can tell whose init it was; bundles before 040 called (code, detail).
//
// See docs/EMSCRIPTEN.md#init-error-codes for the meaning of `code`.
// clang-format off
EM_JS(void, js_notify_init_error, (double host, int code, const char* detail), {
    const detailStr = detail ? UTF8ToString(detail) : '';
    const deliver = () => {
        if (typeof globalThis.pmReportInitError === 'function') {
            globalThis.pmReportInitError(host, code, detailStr);
        } else {
            console.error('[projectM] init() failed with code ' + code + (detailStr ? ': ' + detailStr : ''));
        }
    };
    const queue = Module['pmEventQueue'];
    if (queue) { queue.post(host, deliver); } else { deliver(); }
});
// clang-format on

// Notifies the host page that init() succeeded for `host`, so any previously
// shown init-error overlay can be hidden. See html/projectm-init-errors.js.
// clang-format off
EM_JS(void, js_notify_init_success, (double host), {
    const deliver = () => {
        if (typeof globalThis.pmHideInitError === 'function') {
            globalThis.pmHideInitError(host);
        }
    };
    const queue = Module['pmEventQueue'];
    if (queue) { queue.post(host, deliver); } else { deliver(); }
});
// clang-format on

// Each host keeps the code of its own last init() failure (WasmHost::
// lastInitError, pm_get_init_error()), so one engine's successful init no
// longer clears the error a sibling's failed one left. A create_host*() that
// fails returns a 0 handle and leaves no host to hold why: that code is the
// one module-wide value (WasmHost.cpp, get_last_init_error()).
void ReportInitErrorForEventHost(double host, int code, const char* detail)
{
    PostEvent([&] { js_notify_init_error(host, code, detail); });
}

void ReportInitError(WasmHost& host, int code, const char* detail)
{
    host.lastInitError = code;
    SetLastCreateHostError(0);
    ReportInitErrorForEventHost(EventHostHandle(host), code, detail);
}

void ReportInitSuccess(WasmHost& host)
{
    host.lastInitError = 0;
    SetLastCreateHostError(0);
    PostEvent([&] { js_notify_init_success(EventHostHandle(host)); });
}

namespace WasmApi {

int get_init_error(WasmHost& H)
{
    return H.lastInitError;
}

} // namespace WasmApi
