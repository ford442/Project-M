// Emscripten --pre-js: let the host say which script the pthread pool Workers
// are created from.
//
// PThread.allocateUnusedWorker() does `new Worker(_scriptName, {name:
// 'em-pthread'})`, and inside a Worker the glue sets `_scriptName =
// self.location.href` — it assumes the worker running the module *is* the
// glue. True for a page, and for a worker whose own script is the glue. Not
// true for html/projectm-render-worker.js, which importScripts() the glue from
// another directory: there `_scriptName` is the render worker's own URL, so
// every pool worker re-loaded the render worker, none ever joined the pool, and
// createModule() waited forever for a pool that could not fill. That silent
// boot hang is what kept the OffscreenCanvas topology opt-in.
//
// Emscripten used to expose this as Module.mainScriptUrlOrBlob and dropped it.
// Reassigning `_scriptName` from here does not work — this file is emitted
// above the `ENVIRONMENT_IS_WORKER` assignment, which would overwrite it — so
// shadow the constructor instead, which is order-independent. `var` hoists to
// the factory scope, so every unqualified `Worker` in the module body resolves
// here; nothing else in the page or the worker is affected.
var Worker = (function () {
    var NativeWorker = globalThis.Worker;
    var target = Module['mainScriptUrlOrBlob'];
    if (!target) {
        return NativeWorker;
    }
    return function ProjectMPthreadWorker(url, options) {
        // Only the pool. A Worker the module creates for any other reason
        // keeps the URL it asked for.
        var resolved = options && options.name === 'em-pthread' ? target : url;
        return new NativeWorker(resolved, options);
    };
})();
