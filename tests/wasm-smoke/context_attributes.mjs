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
 *
 * Every host's get_context_snapshot() attributes must equal what
 * getContextAttributes() says, and a host re-created on its element with other
 * attributes must get them, on a fresh copy of the element (see the page).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeContextSnapshot } from '../../html/projectm-context-config.js';
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
            ['withCaveat', { alpha: false, premultipliedAlpha: true, depth: false, stencil: false, preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: true }],
            ['withoutCaveat', { alpha: false, premultipliedAlpha: true, failIfMajorPerformanceCaveat: false }],
            ['inverted', { alpha: true, premultipliedAlpha: false, depth: true, stencil: true, preserveDrawingBuffer: true }],
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
    if (result.ok) {
        // get_context_snapshot() against the browser's own answer on a throwaway
        // context, and against dual_fbo_get_format(); skipped on a bundle that
        // predates the export.
        const caps = result.browserCapabilities;
        for (const [name, precision] of [['withoutCaveat', 0], ['highPrecision', 1], ['bytePrecision', 2]]) {
            const run = result[name];
            if (!run?.cameUp || run.snapshot === null) continue;
            const snapshot = decodeContextSnapshot(run.snapshot);
            if (!snapshot) {
                console.error(`FAIL: ${name}: get_context_snapshot() is ${run.snapshot} on a host with a context.`);
                failed = true;
                continue;
            }
            if (snapshot.fboFormat !== run.fboFormat) {
                console.error(`FAIL: ${name}: snapshot format ${snapshot.fboFormat} but dual_fbo_get_format() is ${run.fboFormat}.`);
                failed = true;
            }
            if (!caps) continue;
            for (const key of ['floatColorBuffer', 'floatBlend', 'loseContext']) {
                if (snapshot[key] !== caps[key]) {
                    console.error(`FAIL: ${name}: snapshot ${key}=${snapshot[key]}, the browser says ${caps[key]}.`);
                    failed = true;
                }
            }
            // DetectFormat(): byte is forced; high needs EXT_color_buffer_float; otherwise
            // RGBA16F wherever half-float targets render, RGBA8 where nothing does.
            const expectedFormat = precision === 2 ? 2
                : precision === 1 && caps.floatColorBuffer ? 1
                : (caps.floatColorBuffer || caps.halfFloatColorBuffer) ? 0 : 2;
            if (snapshot.fboFormat !== expectedFormat) {
                console.error(`FAIL: ${name}: fboPrecision ${precision} should give format ${expectedFormat}, snapshot says ${snapshot.fboFormat}.`);
                failed = true;
            }
        }
    }
    if (result.ok) {
        // The attributes get_context_snapshot() reports are getContextAttributes(),
        // for every host that came up.
        /** @type {Array<[string, any]>} */
        const runs = [
            ['withCaveat', result.withCaveat], ['withoutCaveat', result.withoutCaveat], ['inverted', result.inverted],
            ['highPrecision', result.highPrecision], ['bytePrecision', result.bytePrecision],
            ['rebindOtherAttributes.first', result.rebindOtherAttributes?.first],
            ['rebindOtherAttributes.second', result.rebindOtherAttributes?.second],
            ['rebindSameAttributes.second', result.rebindSameAttributes?.second],
            ['foreign', result.foreign],
        ];
        for (const [name, run] of runs) {
            if (!run?.cameUp || run.snapshot === null || !run.attributes) continue;
            const reported = decodeContextSnapshot(run.snapshot)?.attributes;
            if (!reported) {
                console.error(`FAIL: ${name}: the snapshot carries no attributes.`);
                failed = true;
                continue;
            }
            const browser = run.attributes;
            /** @type {Array<[string, unknown, unknown]>} */
            const pairs = [
                ['alpha', reported.contextAlpha, browser.alpha],
                ['premultipliedAlpha', reported.premultipliedAlpha, browser.premultipliedAlpha],
                ['depth', reported.depth, browser.depth],
                ['stencil', reported.stencil, browser.stencil],
                ['antialias', reported.antialias, browser.antialias],
                ['preserveDrawingBuffer', reported.preserveDrawingBuffer, browser.preserveDrawingBuffer],
                ['failIfMajorPerformanceCaveat', reported.failIfMajorPerformanceCaveat, browser.failIfMajorPerformanceCaveat],
                ['desynchronized', reported.desynchronized, !!browser.desynchronized],
                ['powerPreference', reported.powerPreference, browser.powerPreference],
            ];
            for (const [key, engine, actual] of pairs) {
                if (engine !== actual) {
                    console.error(`FAIL: ${name}: the snapshot says ${key}=${engine}, getContextAttributes() says ${actual}.`);
                    failed = true;
                }
            }
        }

        const other = result.rebindOtherAttributes;
        if (!other?.second?.cameUp || other.second.attributes?.alpha !== true || !other.replaced
            || !other.originalDetached || other.events.length !== 1
            || !other.events[0].previousIsOriginal || !other.events[0].targetIsCurrent) {
            console.error(`FAIL: re-creating a host with other attributes must move it to a fresh element: ${JSON.stringify(other)}`);
            failed = true;
        } else {
            const copied = other.copied;
            if (copied.className !== 'pm-rebind' || copied.width !== 48 || copied.height !== 32
                || copied.styleWidth !== '96px' || copied.styleHeight !== '64px' || copied.parentId !== 'rebind-parent') {
                console.error(`FAIL: the fresh element lost the original's size, CSS or place: ${JSON.stringify(copied)}`);
                failed = true;
            }
        }
        const same = result.rebindSameAttributes;
        if (!same?.second?.cameUp || same.replaced || same.events.length !== 0) {
            console.error(`FAIL: re-creating a host with the same attributes must keep its element: ${JSON.stringify(same)}`);
            failed = true;
        }
        const alpha = result.alphaOutput;
        if (!alpha?.cameUp || alpha.error || alpha.canvasAlpha !== true) {
            console.error(`FAIL: alpha output: no host on a canvas with alpha: ${JSON.stringify(alpha)}`);
            failed = true;
        } else {
            for (const name of ['opaque', 'opaqueAgain']) {
                if (alpha[name].opaque !== 64 * 64) {
                    console.error(`FAIL: alpha output: transparency off must reach the canvas opaque: ${JSON.stringify(alpha[name])}`);
                    failed = true;
                }
            }
            const cut = alpha.transparent;
            if (cut.invalidPremultiplied !== 0 || cut.partial !== 0 || cut.framesWithCutOut === 0) {
                console.error(`FAIL: alpha output: transparency on must be valid premultiplied (cut out or opaque), `
                    + `with cut-out and opaque pixels in some frame: ${JSON.stringify(cut)}`);
                failed = true;
            }
        }
        const echo = result.echoAlphaOutput;
        if (!echo?.cameUp || echo.error || echo.census?.opaque !== 64 * 64) {
            console.error(`FAIL: alpha output: a video-echo preset with transparency off must reach the canvas opaque: ${JSON.stringify(echo)}`);
            failed = true;
        }
        const foreignRun = result.foreign;
        if (!foreignRun?.cameUp || !foreignRun.replaced || foreignRun.attributes?.alpha !== false || foreignRun.attributes?.depth !== false) {
            console.error(`FAIL: an element page script took another context from must be replaced: ${JSON.stringify(foreignRun)}`);
            failed = true;
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
