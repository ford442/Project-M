#!/usr/bin/env node
/**
 * The present pass (#286) in a real browser (tests/wasm-smoke/present_pass.html):
 * the temporal flash limiter, frame readback and manual-present commits.
 *
 *   - presets/tests/290-compshader-strobe.milk (15 Hz full-frame strobe) and
 *     280-compshader-blur3.milk (calm), each with the limiter off and on. Off,
 *     the clamp counter stays 0 and the strobe reaches the canvas untouched;
 *     on, the counter moves for the strobe only, and the strobe never steps more
 *     than the threshold per frame nor spans more than 1.5 thresholds.
 *   - two engines on canvases of different sizes capture the same tick and each
 *     gets its own frame.
 *   - an explicitSwapControl host: N deterministic ticks are N commits, and its
 *     capture goes through the pixel-pack buffer (pending after the frame, ready
 *     on a later turn, or at once with wait). Needs the PROJECTM_WASM_EXPLICIT_SWAP=1
 *     flavor (--explicit-swap); any other bundle must refuse it with init code 9.
 *
 * Every measured frame is read back with capture_frame_*(), so the luminance
 * numbers are what the canvas received.
 *
 * Usage:
 *   node tests/wasm-smoke/present_pass.mjs --module cmake-build/wasm-smoke/projectm-v.030-thread.js
 *   node tests/wasm-smoke/present_pass.mjs --module <explicit-swap flavor js> --explicit-swap
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
    explicitSwap: false,
};
for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--module') options.module = process.argv[++i];
    else if (arg === '--explicit-swap') options.explicitSwap = true;
    else throw new Error(`Unknown argument: ${arg}`);
}

const { chromium } = loadPlaywright(root);
const server = createStaticServer(root);
const port = await listen(server);
const url = (path) => rootRelative(root, resolve(root, path));
const pageUrl = `http://127.0.0.1:${port}${url('tests/wasm-smoke/present_pass.html')}?`
    + new URLSearchParams({
        module: url(options.module),
        strobe: url('presets/tests/290-compshader-strobe.milk'),
        calm: url('presets/tests/280-compshader-blur3.milk'),
    });

/** Per-frame tolerance for 8-bit quantization and the 32x32 luminance estimate. */
const TOLERANCE = 0.02;

let failed = false;
/** @param {string} message */
const fail = (message) => {
    console.error(`FAIL: ${message}`);
    failed = true;
};

/** @param {number[]} values */
const maxStep = (values) => values.slice(1).reduce((max, value, i) => Math.max(max, Math.abs(value - values[i])), 0);

/** Largest luminance span within any `window` consecutive frames. */
const maxSpan = (values, window) => {
    let span = 0;
    for (let i = 0; i + window <= values.length; i += 1) {
        const slice = values.slice(i, i + window);
        span = Math.max(span, Math.max(...slice) - Math.min(...slice));
    }
    return span;
};

let browser;
try {
    browser = await launchChromium(chromium, 'software');
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[browser:pageerror]', error.message));
    await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });
    const handle = await page.waitForFunction(() => window.__projectMPresentResult, null, { timeout: 300000 });
    const result = await handle.jsonValue();

    if (!result.ok) {
        fail(result.error);
    } else {
        const { strobeOff, strobeOn, calmOff, calmOn, twoHosts, manual } = result;
        const summary = (run) => ({
            enabled: run.enabled,
            clamped: run.clamped,
            clampedInWindow: run.clamped - run.clampedAfterSettle,
            maxStep: Number(maxStep(run.luminance).toFixed(4)),
            span8: Number(maxSpan(run.luminance, 8).toFixed(4)),
            size: run.size,
        });
        console.log(JSON.stringify({
            threshold: strobeOn.threshold,
            strobeOff: summary(strobeOff),
            strobeOn: summary(strobeOn),
            calmOff: summary(calmOff),
            calmOn: summary(calmOn),
            twoHosts,
            manual,
        }, null, 2));

        // Off: nothing allocated, nothing counted, the strobe untouched.
        for (const [name, run] of [['strobe', strobeOff], ['calm', calmOff]]) {
            if (run.enabled || run.clamped !== 0) fail(`${name}, limiter off: enabled=${run.enabled}, clamped=${run.clamped} (expected off and 0)`);
        }
        if (maxStep(strobeOff.luminance) < 0.9) {
            fail(`the strobe preset did not strobe with the limiter off (largest step ${maxStep(strobeOff.luminance)})`);
        }

        // On: the counter moves for the strobe, and only for the strobe.
        const threshold = strobeOn.threshold;
        if (!strobeOn.enabled) fail('strobe, limiter on: get_flash_limit_enabled() reads 0');
        if (strobeOn.clamped - strobeOn.clampedAfterSettle < 10) {
            fail(`strobe, limiter on: only ${strobeOn.clamped - strobeOn.clampedAfterSettle} frames clamped in the measured window`);
        }
        if (maxStep(strobeOn.luminance) > threshold + TOLERANCE) {
            fail(`strobe, limiter on: a frame stepped ${maxStep(strobeOn.luminance)} (threshold ${threshold})`);
        }
        if (maxSpan(strobeOn.luminance, 8) > 1.5 * threshold + TOLERANCE) {
            fail(`strobe, limiter on: 8 frames spanned ${maxSpan(strobeOn.luminance, 8)} (limit ${1.5 * threshold})`);
        }
        if (calmOn.clamped - calmOn.clampedAfterSettle !== 0) {
            fail(`calm, limiter on: ${calmOn.clamped - calmOn.clampedAfterSettle} frames clamped in the measured window (expected 0)`);
        }
        if (JSON.stringify(calmOn.luminance) !== JSON.stringify(calmOff.luminance)) {
            fail('calm, limiter on: the frames differ from the limiter-off run');
        }

        // Per-host readback.
        if (twoHosts.statusA !== 3 || twoHosts.statusB !== 3
            || JSON.stringify(twoHosts.sizeA) !== JSON.stringify([64, 48, 64 * 48 * 4])
            || JSON.stringify(twoHosts.sizeB) !== JSON.stringify([32, 24, 32 * 24 * 4])) {
            fail(`two hosts: each capture must be its own canvas's size (${JSON.stringify(twoHosts)})`);
        }

        // Manual present.
        if (options.explicitSwap) {
            if (!manual.cameUp) {
                fail(`manual present: no explicitSwapControl host (init code ${manual.initCode})`);
            } else {
                if (manual.committed !== manual.ticks || manual.rendered !== manual.ticks) {
                    fail(`manual present: ${manual.ticks} ticks rendered ${manual.rendered} frames and committed ${manual.committed}`);
                }
                if (manual.statusWaited !== 3 || JSON.stringify(manual.offlineSize) !== JSON.stringify([64, 48])) {
                    fail(`manual present: an export-tick capture was not ready at once (${JSON.stringify(manual)})`);
                }
                if (JSON.stringify(manual.liveSize) !== JSON.stringify([64, 48, 64 * 48 * 4])) {
                    fail(`manual present: the live capture is ${JSON.stringify(manual.liveSize)}`);
                }
                if (!manual.pendingWasSeen) {
                    fail(`manual present: the live capture was not asynchronous (status ${manual.statusAfterFrame} right after its frame)`);
                }
            }
        } else if (manual.cameUp || manual.initCode !== 9) {
            fail(`a bundle without the explicit-swap flavor must refuse manual present with init code 9; got cameUp=${manual.cameUp}, initCode=${manual.initCode}`);
        }
    }
} finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
}
if (!failed) console.log('OK: present pass');
process.exit(failed ? 1 : 0);
