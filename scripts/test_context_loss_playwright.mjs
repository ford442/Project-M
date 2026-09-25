#!/usr/bin/env node
/**
 * Playwright: WebGL context loss and recovery through ProjectMContext, on both
 * render topologies. Needs a built WASM bundle (see docs/EMSCRIPTEN.md).
 *
 * For each topology it loads tests/wasm-smoke/context_loss.html, loses the real
 * WebGL context with WEBGL_lose_context (on the canvas for 'main', inside the
 * render worker for 'worker' — the worker owns the transferred canvas, so that
 * is where the event really fires), and checks that
 *   1. the page hears about it (the "Graphics paused" overlay appears),
 *   2. the engine really was torn down (get_projectm_handle() drops to 0),
 *   3. after restoreContext() the overlay goes away, the engine is rebuilt
 *      (get_projectm_handle() is nonzero again) and nothing was reported as an error.
 *
 * Usage:
 *   node scripts/test_context_loss_playwright.mjs <projectm-v.NNN-thread.js> [worker|main ...]
 *
 * Needs `playwright` (tests/wasm-smoke/node_modules has it). Exit code 1 on any
 * failed check; 2 when the browser refuses to restore a synthetic loss at all,
 * which headless Chromium is known to do on some builds (see
 * tests/wasm-smoke/index.html) and which says nothing about the code under test.
 */

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = process.argv[2] ? resolve(process.argv[2]) : null;
const topologies = process.argv.slice(3).length ? process.argv.slice(3) : ['worker', 'main'];

if (!modulePath || !existsSync(modulePath)) {
    console.error('usage: node scripts/test_context_loss_playwright.mjs <projectm-v.NNN-thread.js> [worker|main ...]');
    process.exit(1);
}

const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
    '.wasm': 'application/wasm', '.milk': 'text/plain', '.css': 'text/css', '.json': 'application/json',
};

/** Serves the repo, plus the bundle's own directory under /__bundle/. */
function startServer() {
    const bundleDir = dirname(modulePath);
    return new Promise((resolveServer) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://localhost');
            const rel = decodeURIComponent(url.pathname);
            const root = rel.startsWith('/__bundle/') ? bundleDir : repoRoot;
            let filePath = resolve(root, '.' + (rel.startsWith('/__bundle/') ? rel.slice('/__bundle'.length) : rel));
            // The main-thread loader remaps a smoke-tagged bundle (v.030) to the
            // deployed bundle's name for its sibling files; answer with the
            // bundle we actually have, whatever version it is.
            const sibling = /^projectm-v\.\d+-thread(\..+)$/.exec(rel.slice(rel.lastIndexOf('/') + 1));
            if (root === bundleDir && sibling && !existsSync(filePath)) {
                filePath = join(bundleDir, modulePath.split(sep).pop().replace(/\.js$/, sibling[1]));
            }
            if (!filePath.startsWith(root + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
                res.writeHead(404).end('not found');
                return;
            }
            res.writeHead(200, {
                'Content-Type': mime[extname(filePath)] || 'application/octet-stream',
                // The pthread build needs SharedArrayBuffer.
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Resource-Policy': 'same-origin',
                'Cache-Control': 'no-store',
            });
            createReadStream(filePath).pipe(res);
        });
        server.listen(0, '127.0.0.1', () => resolveServer(server));
    });
}

/** Polls `predicate` in the page until it is truthy; resolves false on timeout. */
async function waitFor(page, predicate, timeout) {
    try {
        await page.waitForFunction(predicate, null, { timeout, polling: 100 });
        return true;
    } catch {
        return false;
    }
}

/** get_projectm_handle(): the engine pointer, 0 while there is no engine. */
const engineHandle = (page) => page.evaluate(async () => {
    const timeout = new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), 3000));
    const handle = await Promise.race([window.__pmContextLoss.engineHandle(), timeout]);
    return typeof handle === 'number' ? handle : null;
});

async function checkTopology(browser, baseUrl, topology) {
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); };
    console.log(`\n[${topology}]`);

    const page = await browser.newPage();
    page.on('console', (message) => {
        if (message.type() === 'error') console.log(`  [browser:error] ${message.text()}`);
    });
    page.on('pageerror', (error) => console.log(`  [browser:pageerror] ${error.message}`));

    const params = new URLSearchParams({
        module: `${baseUrl}/__bundle/${modulePath.split(sep).pop()}`,
        topology,
        preset: `${baseUrl}/presets/tests/000-empty.milk`,
    });
    await page.goto(`${baseUrl}/tests/wasm-smoke/context_loss.html?${params}`, { waitUntil: 'load', timeout: 30000 });

    if (!await waitFor(page, () => window.__pmContextLossReady !== undefined, 90000)
        || !await page.evaluate(() => window.__pmContextLossReady)) {
        check(false, `context started (${JSON.stringify(await page.evaluate(() => window.__pmContextLoss?.errors))})`);
        await page.close();
        return { failures, refused: false };
    }
    check(await page.evaluate(() => window.__pmContextLoss.topology()) === topology, `renders on the ${topology} topology`);
    check(!!await page.evaluate(() => window.__pmContextLoss.presetPath()), 'a preset was loaded, so recovery has one to reload');

    check(await engineHandle(page) > 0, 'an engine exists before the loss');

    await page.evaluate(() => window.__pmContextLoss.loseContext({ restoreDelay: 800 }));

    check(await waitFor(page, () => window.__pmContextLoss.overlayVisible(), 15000), 'the "Graphics paused" overlay appears');
    check(await engineHandle(page) === 0, 'the engine was torn down while the context is lost');

    // A tap before the browser restores the context must leave the overlay up.
    await page.evaluate(() => window.__pmContextLoss.tapOverlay());
    await page.waitForTimeout(100);

    const restored = await waitFor(page, () => !window.__pmContextLoss.overlayVisible(), 20000);
    if (!restored) {
        console.log('  the browser never restored the context (headless Chromium refuses restoreContext() on some builds)');
        await page.close();
        return { failures, refused: true };
    }
    check(true, 'the overlay goes away once the context is restored');
    check(await engineHandle(page) > 0, 'the engine was rebuilt');
    const errors = await page.evaluate(() => window.__pmContextLoss.errors);
    check(errors.length === 0, `no errors reported (${JSON.stringify(errors)})`);

    await page.close();
    return { failures, refused: false };
}

const server = await startServer();
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const { chromium } = createRequire(join(repoRoot, 'tests/wasm-smoke/'))('playwright');
const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader-webgl'],
});

let failed = false;
let refused = false;
try {
    for (const topology of topologies) {
        const result = await checkTopology(browser, baseUrl, topology);
        failed ||= result.failures.length > 0;
        refused ||= result.refused;
    }
} finally {
    await browser.close();
    server.close();
}

if (failed) {
    console.error('\nContext-loss check FAILED.');
    process.exit(1);
}
if (refused) {
    console.error('\nContext loss was detected, but this browser would not restore it; recovery itself was not exercised.');
    process.exit(2);
}
console.log('\nContext-loss recovery OK on:', topologies.join(', '));
