#!/usr/bin/env node
/**
 * One browser session against create_host_with_config()
 * (tests/wasm-smoke/context_attributes.html): with failIfMajorPerformanceCaveat
 * on, records whether the WebGL 2 context came up; reads every attribute back
 * from the browser's context; and tries an explicitSwapControl host.
 * Deliberately not part of run.mjs — the default smoke must start on
 * SwiftShader whatever the browser thinks of it.
 *
 * Whether software GL counts as a major performance caveat is the browser's
 * call, and headless Chromium with --use-angle=swiftshader (what CI has) says
 * no: it hands out SwiftShader even for a plain getContext() with the flag. The
 * page therefore asks the browser directly as well, and --check asserts the
 * engine agrees: the context comes up when the browser accepts the flag, and
 * create_host_with_config() fails with init code 8 when it refuses. A real GPU
 * (--gpu) should come up.
 *
 * Usage:
 *   node tests/wasm-smoke/context_attributes.mjs --module cmake-build/wasm-smoke/projectm-v.030-thread.js
 *   node tests/wasm-smoke/context_attributes.mjs --module <js> --gpu
 *   ... --check   exit 1 when the engine disagrees with the browser (see above)
 *   ... --explicit-swap   the bundle is the PROJECTM_WASM_EXPLICIT_SWAP=1 flavor
 *
 * explicitSwapControl: a production bundle must refuse it with init code 9; the
 * explicit-swap flavor must create the context with FBO 0 redirected to
 * Emscripten's offscreen back buffer.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createStaticServer, detectRepoRoot, launchChromium, listen, loadPlaywright, rootRelative,
} from './lib/harness-runtime.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.PROJECTM_ROOT || detectRepoRoot(scriptDir));

const options = {
    module: process.env.PROJECTM_WASM_JS || 'cmake-build/wasm-smoke/projectm-v.030-thread.js',
    gpu: false,
    check: false,
    explicitSwap: false,
};
for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--module') options.module = process.argv[++i];
    else if (arg === '--gpu') options.gpu = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--explicit-swap') options.explicitSwap = true;
    else throw new Error(`Unknown argument: ${arg}`);
}

const { chromium } = loadPlaywright(root);
const server = createStaticServer(root);
const port = await listen(server);
const url = (path) => rootRelative(root, resolve(root, path));
const pageUrl = `http://127.0.0.1:${port}${url('tests/wasm-smoke/context_attributes.html')}?`
    + new URLSearchParams({ module: url(options.module) });

let browser;
let failed = false;
try {
    browser = await launchChromium(chromium, options.gpu ? 'gpu' : 'software');
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[browser:pageerror]', error.message));
    await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });
    const handle = await page.waitForFunction(() => window.__projectMCaveatResult, null, { timeout: 120000 });
    const result = { mode: options.gpu ? 'gpu' : 'software', ...(await handle.jsonValue()) };
    console.log(JSON.stringify(result, null, 2));

    if (!result.ok) {
        console.error(`FAIL: ${result.error}`);
        failed = true;
    } else if (!result.withoutCaveat.cameUp) {
        console.error(`FAIL: no WebGL 2 context even without the caveat flag (init code ${result.withoutCaveat.initCode}).`);
        failed = true;
    } else {
        // The attribute block the C++ side built is what the browser reports
        // back (antialias/powerPreference/desynchronized are hints a browser
        // may decline, so they are recorded, not checked).
        const expectAttrs = [
            ['withCaveat', { alpha: true, premultipliedAlpha: true, depth: false, stencil: false, preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: true }],
            ['withoutCaveat', { alpha: true, premultipliedAlpha: true, failIfMajorPerformanceCaveat: false }],
            ['inverted', { alpha: false, premultipliedAlpha: false, depth: true, stencil: true, preserveDrawingBuffer: true }],
        ];
        for (const [name, expected] of expectAttrs) {
            const actual = result[name]?.attributes;
            if (!actual) continue; // did not come up; judged below
            for (const [key, value] of Object.entries(expected)) {
                if (actual[key] !== value) {
                    console.error(`FAIL: ${name}: context attribute ${key} is ${actual[key]}, expected ${value}.`);
                    failed = true;
                }
            }
        }
    }
    if (result.ok && options.check) {
        const engine = result.withCaveat;
        const agrees = result.browserAcceptsCaveat
            ? engine.cameUp
            : !engine.cameUp && engine.initCode === 8;
        if (!agrees) {
            console.error(`FAIL: the browser ${result.browserAcceptsCaveat ? 'accepts' : 'refuses'} `
                + `failIfMajorPerformanceCaveat, but the engine got cameUp=${engine.cameUp}, initCode=${engine.initCode}.`);
            failed = true;
        }
        const swap = result.explicitSwap;
        if (options.explicitSwap) {
            if (!swap.cameUp || swap.backBufferRedirected !== true) {
                console.error(`FAIL: explicit-swap flavor: cameUp=${swap.cameUp}, initCode=${swap.initCode}, `
                    + `backBufferRedirected=${swap.backBufferRedirected}.`);
                failed = true;
            }
        } else if (swap.cameUp || swap.initCode !== 9) {
            console.error(`FAIL: a production bundle must refuse explicitSwapControl with init code 9; `
                + `got cameUp=${swap.cameUp}, initCode=${swap.initCode}.`);
            failed = true;
        }
        if (options.gpu && !engine.cameUp) {
            console.error('FAIL: a GPU run refused the context as a performance caveat.');
            failed = true;
        }
    }
} finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
}
process.exit(failed ? 1 : 0);
