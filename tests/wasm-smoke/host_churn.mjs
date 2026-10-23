#!/usr/bin/env node
/**
 * Host churn gate: create and destroy hosts while their preset preparations are
 * in flight (tests/wasm-smoke/host_churn.html).
 *
 * Every host owns a preset prepare thread from the fixed pthread pool. Fails when
 *   - the page times out (destroy_host deadlocked joining a prepare thread, or a
 *     later prepare thread never got a Worker),
 *   - create_host was refused (a destroyed host kept its slot),
 *   - the runtime warned that the pthread pool is exhausted (a prepare thread
 *     outlived its host and still held its Worker when the next host started
 *     one; ASSERTIONS builds print this), or
 *   - the long-lived host's preset loads stopped completing.
 *
 * Run it on the runtime-checks link (scripts/build_wasm.sh --debug: ASSERTIONS=2,
 * SAFE_HEAP, STACK_OVERFLOW_CHECK=2), which is what reports pool exhaustion:
 *   node tests/wasm-smoke/host_churn.mjs --module cmake-build/wasm-smoke-debug/projectm-v.030-thread.js
 *   node tests/wasm-smoke/host_churn.mjs --module <js> --rounds 20 --heavy custom_milk_fixed/milk011.milk
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
        module: process.env.PROJECTM_WASM_JS || 'cmake-build/wasm-smoke-debug/projectm-v.030-thread.js',
        heavy: 'custom_milk_fixed/milk011.milk',
        light: 'presets/tests/000-empty.milk',
        rounds: 100,
        stayEvery: 10,
        timeoutMs: 900000,
        out: null,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--module') options.module = argv[++i];
        else if (arg === '--heavy') options.heavy = argv[++i];
        else if (arg === '--light') options.light = argv[++i];
        else if (arg === '--rounds') options.rounds = parseInt(argv[++i], 10);
        else if (arg === '--stay-every') options.stayEvery = parseInt(argv[++i], 10);
        else if (arg === '--timeout-ms') options.timeoutMs = parseInt(argv[++i], 10);
        else if (arg === '--out') options.out = argv[++i];
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}

// Emscripten's wording in library_pthread.js ("Tried to spawn a new thread,
// but the thread pool is exhausted.") plus the shorter forms older releases used.
const POOL_EXHAUSTED = /thread pool is exhausted|pthread pool.*exhausted|PTHREAD_POOL_SIZE/i;

const options = parseArgs(process.argv);
const { chromium } = loadPlaywright(root);
const server = createStaticServer(root);
const port = await listen(server);
const url = (path) => rootRelative(root, resolve(root, path));
const query = new URLSearchParams({
    module: url(options.module),
    heavy: url(options.heavy),
    light: url(options.light),
    rounds: String(options.rounds),
    stayEvery: String(options.stayEvery),
});
const pageUrl = `http://127.0.0.1:${port}${url('tests/wasm-smoke/host_churn.html')}?${query}`;

let browser;
let failed = false;
const poolWarnings = [];
const pageErrors = [];
try {
    browser = await launchChromium(chromium, 'software');
    const page = await browser.newPage();
    page.on('console', (message) => {
        const text = message.text();
        if (POOL_EXHAUSTED.test(text)) poolWarnings.push(text);
    });
    page.on('pageerror', (error) => {
        // The audio worklet script is not served next to the bundle here, and
        // the churn has no audio; that rejection is not what this test gates.
        if (/projectm[-_]audio[-_]processor/.test(error.message)) return;
        pageErrors.push(error.message);
        console.error('[browser:pageerror]', error.message);
    });
    const started = Date.now();
    await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });
    let result;
    try {
        const handle = await page.waitForFunction(() => window.__projectMChurnResult, null,
            { timeout: options.timeoutMs, polling: 500 });
        result = await handle.jsonValue();
    } catch (error) {
        throw new Error(`no result within ${options.timeoutMs} ms (deadlocked destroy_host or a `
            + `starved prepare thread?): ${error.message}`);
    }
    result.seconds = (Date.now() - started) / 1000;
    result.poolExhausted = poolWarnings.length;
    console.log(JSON.stringify(result, null, 2));
    if (options.out) writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n');

    if (!result.ok) {
        console.error(`FAIL: churn page failed: ${result.error}`);
        failed = true;
    }
    if (result.ok && result.rounds !== options.rounds) {
        console.error(`FAIL: ${result.rounds}/${options.rounds} rounds ran.`);
        failed = true;
    }
    if (poolWarnings.length > 0) {
        console.error(`FAIL: the pthread pool ran out ${poolWarnings.length} time(s): a prepare thread `
            + `outlived its host. First warning:\n${poolWarnings[0]}`);
        failed = true;
    }
    if (pageErrors.length > 0) {
        console.error(`FAIL: ${pageErrors.length} uncaught page error(s).`);
        failed = true;
    }
    if (!failed) {
        console.log(`OK: ${result.rounds} hosts created and destroyed mid-preparation in `
            + `${result.seconds.toFixed(1)} s; the long-lived host loaded ${result.stayLoads} presets.`);
    }
} finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
}
process.exit(failed ? 1 : 0);
