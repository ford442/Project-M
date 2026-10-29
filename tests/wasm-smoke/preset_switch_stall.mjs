#!/usr/bin/env node
/**
 * Preset-switch stall gate for the WASM render loop.
 *
 * Drives tests/wasm-smoke/preset_switch_stall.html: the engine's own main loop
 * renders a light preset, then a heavy one is requested. Fails when
 *   - the loop rendered no frame while the heavy preset was being prepared
 *     (the old preset must keep animating: preparation runs on the host's
 *     prepare thread, not in place of frames), or
 *   - the worst frame interval around the switch exceeds --max-ratio times the
 *     settled 95th-percentile interval (default 2; 0 reports it without gating).
 *
 * Usage:
 *   node tests/wasm-smoke/preset_switch_stall.mjs --module cmake-build/wasm-smoke/projectm-v.030-thread.js
 *   node tests/wasm-smoke/preset_switch_stall.mjs --module <js> --preset-b custom_milk_fixed/milk011.milk
 *   node tests/wasm-smoke/preset_switch_stall.mjs --module <js> --gpu --max-ratio 1.5
 *
 * Software GL (the default) is what CI has. There the frame-count check is the
 * gate: the 037 bundle, which stopped the loop for the whole load, renders 0
 * frames and fails, while this build renders several. The ratio is not a gate
 * on SwiftShader: its frames are slow and noisy enough that the 037 bundle's
 * whole-load stall measured only 1.6x p95. Gate the ratio on a GPU run
 * (--gpu), where a frame is short next to a shader compile.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createStaticServer, detectRepoRoot, launchChromium, listen, loadPlaywright, rootRelative,
} from './lib/harness-runtime.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.PROJECTM_ROOT || detectRepoRoot(scriptDir));

function parseArgs(argv) {
    const options = {
        module: process.env.PROJECTM_WASM_JS || 'cmake-build/wasm-smoke/projectm-v.030-thread.js',
        presetA: 'presets/tests/000-empty.milk',
        presetB: 'custom_milk_fixed/milk011.milk',
        width: 1280,
        height: 720,
        maxRatio: 2,
        gpu: false,
        out: null,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--module') options.module = argv[++i];
        else if (arg === '--preset-a') options.presetA = argv[++i];
        else if (arg === '--preset-b') options.presetB = argv[++i];
        else if (arg === '--width') options.width = parseInt(argv[++i], 10);
        else if (arg === '--height') options.height = parseInt(argv[++i], 10);
        else if (arg === '--max-ratio') options.maxRatio = parseFloat(argv[++i]);
        else if (arg === '--gpu') options.gpu = true;
        else if (arg === '--out') options.out = argv[++i];
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}

const options = parseArgs(process.argv);
const { chromium } = loadPlaywright(root);
const server = createStaticServer(root);
const port = await listen(server);
const url = (path) => rootRelative(root, resolve(root, path));
const query = new URLSearchParams({
    module: url(options.module),
    presetA: url(options.presetA),
    presetB: url(options.presetB),
    width: String(options.width),
    height: String(options.height),
});
const pageUrl = `http://127.0.0.1:${port}${url('tests/wasm-smoke/preset_switch_stall.html')}?${query}`;

let browser;
let failed = false;
try {
    browser = await launchChromium(chromium, options.gpu ? 'gpu' : 'software');
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[browser:pageerror]', error.message));
    await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });
    const handle = await page.waitForFunction(() => window.__projectMStallResult, null, { timeout: 300000 });
    const result = await handle.jsonValue();
    console.log(JSON.stringify(result, null, 2));
    if (options.out) writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n');

    if (!result.ok) {
        throw new Error(`stall page failed: ${result.error}`);
    }
    if (result.framesWhileLoading < 1) {
        console.error('FAIL: no frame was rendered while the heavy preset was prepared.');
        failed = true;
    }
    if (options.maxRatio > 0 && result.worstToP95 !== null && result.worstToP95 > options.maxRatio) {
        console.error(`FAIL: worst frame around the switch ${result.worstSwitchIntervalMs.toFixed(1)} ms is `
            + `${result.worstToP95.toFixed(2)}x the settled p95 ${result.baselineP95Ms.toFixed(1)} ms `
            + `(limit ${options.maxRatio}x).`);
        failed = true;
    }
    if (!failed) {
        console.log(`OK: ${result.framesWhileLoading} frame(s) rendered while preparing; worst switch frame `
            + `${result.worstToP95?.toFixed(2)}x p95.`);
    }
} finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
}
process.exit(failed ? 1 : 0);
