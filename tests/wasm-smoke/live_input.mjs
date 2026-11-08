#!/usr/bin/env node
/**
 * Live input in a real browser (tests/wasm-smoke/live_input.html,
 * docs/LIVE_INPUT.md): ProjectMContext.registerTexture() / updateTexture() /
 * setEvalVar() against the linked bundle, in the render-worker topology and on
 * the main thread. A canvas, ImageData pixels and a camera (Chromium's fake
 * capture device, through setupLiveTextureSource() — the ?liveTex=1 path) reach
 * a stock-syntax `sampler_webcam` without a VFS write, and q1 set by the host
 * reaches the composite shader on the next frames.
 *
 * Usage:
 *   node tests/wasm-smoke/live_input.mjs --module cmake-build/wasm-smoke/projectm-v.030-thread.js
 *   node tests/wasm-smoke/live_input.mjs --module <js> --topology main
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    chromiumArgs, detectRepoRoot, launchChromium, listen, loadPlaywright, rootRelative,
} from './lib/harness-runtime.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.PROJECTM_ROOT || detectRepoRoot(scriptDir));

const options = {
    module: process.env.PROJECTM_WASM_JS || 'cmake-build/wasm-smoke/projectm-v.030-thread.js',
    topologies: ['worker', 'main'],
};
for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--module') options.module = process.argv[++i];
    else if (arg === '--topology') options.topologies = [process.argv[++i]];
    else throw new Error(`Unknown argument: ${arg}`);
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.wasm': 'application/wasm', '.json': 'application/json', '.milk': 'text/plain',
};

/**
 * The repo, cross-origin isolated. The main-thread loader renames a smoke-tagged
 * bundle's sibling files (v.030) to the deployed bundle's name, so a request
 * for a projectm-v.NNN-thread.* that does not exist next to the module is
 * answered with the module's own sibling (as scripts/test_context_loss_playwright.mjs does).
 */
function startServer(modulePath) {
    const bundleDir = dirname(modulePath);
    return createServer((request, response) => {
        const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
        let filePath = resolve(root, '.' + path);
        const sibling = /^projectm-v\.\d+-thread(\..+)$/.exec(basename(path));
        if (dirname(filePath) === bundleDir && sibling && !existsSync(filePath)) {
            filePath = join(bundleDir, basename(modulePath).replace(/\.js$/, sibling[1]));
        }
        if (!filePath.startsWith(root + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
            response.writeHead(404).end('Not found');
            return;
        }
        response.writeHead(200, {
            'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Cache-Control': 'no-store',
        });
        createReadStream(filePath).pipe(response);
    });
}

const { chromium } = loadPlaywright(root);
const server = startServer(resolve(root, options.module));
const port = await listen(server);
const url = (path) => rootRelative(root, resolve(root, path));

let failed = false;
let browser;
try {
    browser = await launchChromium(chromium, 'software', {
        // A camera without a camera: a generated test pattern, and no permission prompt.
        args: [...chromiumArgs('software'), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    for (const topology of options.topologies) {
        const browserContext = await browser.newContext({ permissions: ['camera'] });
        const page = await browserContext.newPage();
        page.on('pageerror', (error) => console.error('[browser:pageerror]', error.message));
        if (process.env.PM_DEBUG_CONSOLE) page.on('console', (m) => console.log('[browser]', m.text()));
        const pageUrl = `http://127.0.0.1:${port}${url('tests/wasm-smoke/live_input.html')}?`
            + new URLSearchParams({ module: url(options.module), topology });
        await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });
        const handle = await page.waitForFunction(() => window.__projectMLiveInputResult, null, { timeout: 300000 });
        const result = await handle.jsonValue();
        console.log(JSON.stringify({ requested: topology, ...result }, null, 2));

        const fail = (message) => {
            console.error(`FAIL (${topology}): ${message}`);
            failed = true;
        };
        if (result.error) {
            fail(result.error);
        } else {
            const { steps } = result;
            if (result.topology !== topology) fail(`ran on '${result.topology}', not '${topology}'`);
            if (!result.ok) fail(`errors reported: ${JSON.stringify(result.errors)}`);
            for (const name of ['registered', 'canvasUpload', 'pixelUpload', 'evalSet', 'readOnlyRefused', 'evalClear',
                'cameraRegistered', 'cameraStreaming', 'cameraMoves', 'unregisteredAgain']) {
                if (steps[name] !== true) fail(`${name} was ${JSON.stringify(steps[name])}`);
            }
            if (steps.refusedName !== false) fail('a built-in texture name was accepted');
            for (const name of ['black', 'red', 'blue', 'q1', 'cleared', 'camera']) {
                if (!steps[name]?.ok) fail(`${name}: ${JSON.stringify(steps[name])}`);
            }
        }
        await browserContext.close();
    }
} finally {
    await browser?.close();
    server.close();
}

if (failed) {
    process.exit(1);
}
console.log('live input: OK');
