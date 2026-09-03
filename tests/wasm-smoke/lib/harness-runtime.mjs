/**
 * Shared plumbing for the browser-driven graphics harness: a static file server
 * with the cross-origin isolation headers the SharedArrayBuffer PCM ring needs,
 * Chromium launch arguments for the two runner kinds, and playwright resolution.
 *
 * Split out of the individual runner scripts because the *headers* and the
 * *launch flags* are the parts that must not drift between the golden gate and
 * the perf run: a golden captured without COOP/COEP silently takes the non-SAB
 * audio path, and a perf number captured on SwiftShader is not a perf number.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, resolve, sep } from 'node:path';

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.1ijs': 'text/javascript; charset=utf-8',
    '.ts': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.milk': 'text/plain; charset=utf-8',
    '.png': 'image/png',
};

/**
 * Loads playwright from tests/wasm-smoke/node_modules first, falling back to
 * whatever the caller's resolution finds.
 *
 * @param {string} root Repository root.
 * @returns {any} The playwright module.
 */
export function loadPlaywright(root) {
    const smokePackage = join(root, 'tests/wasm-smoke/package.json');
    if (existsSync(smokePackage)) {
        try {
            return createRequire(smokePackage)('playwright');
        } catch (_) { /* fall through to the caller's resolution */ }
    }
    return createRequire(import.meta.url)('playwright');
}

/**
 * Serves `root` read-only over loopback with cross-origin isolation enabled.
 *
 * @param {string} root Absolute path to serve.
 * @returns {import('node:http').Server}
 */
export function createStaticServer(root) {
    return createServer((request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            const filePath = resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!filePath.startsWith(root + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
                response.writeHead(404).end('Not found');
                return;
            }
            response.writeHead(200, {
                'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
                // Required for SharedArrayBuffer, which the PCM ring uses in the
                // pthreads build. Without these the page silently degrades to a
                // different audio ingest path and the captures are not the ones
                // the goldens were taken on.
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Resource-Policy': 'same-origin',
                'Cache-Control': 'no-store',
            });
            createReadStream(filePath).pipe(response);
        } catch (error) {
            response.writeHead(500).end(String(error));
        }
    });
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<number>} The bound port.
 */
export function listen(server) {
    return new Promise((resolvePort) => {
        server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
    });
}

/**
 * Maps an absolute path inside `root` to a server URL path.
 *
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
export function rootRelative(root, path) {
    const normalizedRoot = root.endsWith(sep) ? root : root + sep;
    if (!path.startsWith(normalizedRoot)) throw new Error(`Outside repo root: ${path}`);
    return '/' + path.slice(normalizedRoot.length).split(sep).map(encodeURIComponent).join('/');
}

/**
 * Chromium arguments for the two runner kinds.
 *
 * `software`: ANGLE over SwiftShader. Reproducible pixel-for-pixel on any
 * machine and free on a hosted runner, which is what a golden-image gate needs.
 * Its frame times are meaningless and must never gate perf.
 *
 * `gpu`: whatever GL the machine actually has. The only mode whose timings mean
 * anything, and the reason the perf job wants a self-hosted or nightly runner.
 *
 * @param {'software' | 'gpu'} mode
 * @returns {string[]}
 */
export function chromiumArgs(mode) {
    const shared = [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // Keep a headless run rendering at a fixed rate rather than throttling
        // a backgrounded page — the capture drives frames itself, but the perf
        // run does not.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
    ];
    if (mode === 'gpu') {
        return [...shared, '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
    }
    return [
        ...shared,
        '--use-gl=angle',
        '--use-angle=swiftshader',
        // Newer Chromium refuses SwiftShader for WebGL without this.
        '--enable-unsafe-swiftshader',
        '--disable-gpu-sandbox',
    ];
}

/**
 * Launches Chromium for one of the two runner kinds.
 *
 * `PROJECTM_CHROMIUM_EXECUTABLE` overrides the browser binary. Playwright pins
 * a browser build per package version, and pre-provisioned environments (CI
 * images, dev containers) routinely ship a different one — without an override
 * the harness refuses to start on a machine that has a perfectly good Chromium.
 *
 * @param {any} chromium The playwright `chromium` export.
 * @param {'software' | 'gpu'} mode
 * @param {object} [options] Extra playwright launch options.
 * @returns {Promise<any>} The browser.
 */
export function launchChromium(chromium, mode, options = {}) {
    const executablePath = process.env.PROJECTM_CHROMIUM_EXECUTABLE || undefined;
    return chromium.launch({
        headless: true,
        args: chromiumArgs(mode),
        ...(executablePath ? { executablePath } : {}),
        ...options,
    });
}

/**
 * Finds the repository root from a path inside it.
 *
 * @param {string} startDir
 * @returns {string}
 */
export function detectRepoRoot(startDir) {
    let dir = resolve(startDir);
    for (let depth = 0; depth < 8; depth += 1) {
        if (existsSync(join(dir, 'CMakeLists.txt')) && existsSync(join(dir, 'html'))) return dir;
        const parent = resolve(dir, '..');
        if (parent === dir) break;
        dir = parent;
    }
    return resolve(startDir, '..', '..');
}
