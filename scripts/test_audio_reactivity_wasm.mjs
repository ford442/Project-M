#!/usr/bin/env node
/**
 * Playwright runner for tests/wasm-smoke/audio_reactivity.html
 *
 * Runs the page twice: once rendering on the main thread, once with the canvas
 * transferred to the OffscreenCanvas render worker. Both must pass. There is one
 * audio ingest now — the WASM-owned PCM ring — so a regression that only shows up
 * in one topology is exactly what this catches.
 *
 * The server sends COOP/COEP so the page is cross-origin isolated: without it
 * there is no SharedArrayBuffer, the worker cannot share its module's heap, and
 * the run would silently only ever exercise the postMessage fallback.
 *
 * Usage:
 *   node scripts/test_audio_reactivity_wasm.mjs [wasm-js-path] [preset-milk-path]
 *
 * Requires a built WASM bundle and `npx playwright install chromium` once.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const smokeDir = join(repoRoot, 'tests', 'wasm-smoke');
const defaultWasm = join(repoRoot, 'cmake-build', 'wasm-smoke', 'projectm-v.030-thread.js');
const wasmPath = resolve(process.argv[2] || defaultWasm);
const presetPath = resolve(process.argv[3] || join(repoRoot, 'presets', 'tests', '300-beatdetect-bassmidtreb.milk'));

if (!existsSync(wasmPath)) {
    console.error(`WASM bundle not found: ${wasmPath}`);
    console.error('Build first: ENABLE_WASM_TRANSITIONS=ON scripts/build_wasm_smoke_wrapper.sh');
    process.exit(2);
}

const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.wasm': 'application/wasm',
    '.milk': 'text/plain',
    '.json': 'application/json',
};

function startServer(root) {
    return new Promise((resolveServer) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, 'http://localhost');
                const rel = decodeURIComponent(url.pathname);
                const filePath = join(root, rel === '/' ? 'index.html' : rel.replace(/^\//, ''));
                const data = await readFile(filePath);
                const ext = filePath.slice(filePath.lastIndexOf('.'));
                res.writeHead(200, {
                    'Content-Type': mime[ext] || 'application/octet-stream',
                    // Required for SharedArrayBuffer (pthread WASM, and sharing
                    // the module heap with the render worker).
                    'Cross-Origin-Opener-Policy': 'same-origin',
                    'Cross-Origin-Embedder-Policy': 'require-corp',
                    'Cross-Origin-Resource-Policy': 'same-origin',
                });
                res.end(data);
            } catch {
                res.writeHead(404);
                res.end('not found');
            }
        });
        server.listen(0, '127.0.0.1', () => resolveServer(server));
    });
}

/**
 * Runs the page in one mode and returns its reported outcome.
 *
 * @param {import('playwright').Browser} browser
 * @param {URL} baseUrl
 * @param {'main' | 'worker'} mode
 */
async function runMode(browser, baseUrl, mode) {
    const pageUrl = new URL(baseUrl.href);
    pageUrl.searchParams.set('mode', mode);

    const page = await browser.newPage();
    // A failure inside the page reaches the runner only as a timeout otherwise,
    // which says nothing about which of the two topologies broke or why.
    if (process.env.PROJECTM_HARNESS_VERBOSE === '1') {
        page.on('console', (message) => console.error(`[${mode}] ${message.type()}: ${message.text()}`));
        page.on('pageerror', (error) => console.error(`[${mode}] pageerror: ${error.message}`));
    }
    try {
        await page.goto(pageUrl.href, { waitUntil: 'networkidle', timeout: 120000 });
        await page.waitForFunction(
            () => {
                const r = window.__projectMAudioReactivity;
                return !!r && (r.ok || r.error);
            },
            null,
            { timeout: 180000 }
        );
        return await page.evaluate(() => window.__projectMAudioReactivity);
    } finally {
        await page.close();
    }
}

async function run() {
    const server = await startServer(repoRoot);
    const port = server.address().port;
    const wasmRel = wasmPath.startsWith(repoRoot)
        ? wasmPath.slice(repoRoot.length).replace(/^\//, '')
        : null;
    const pageUrl = new URL(`http://127.0.0.1:${port}/tests/wasm-smoke/audio_reactivity.html`);
    if (wasmRel) pageUrl.searchParams.set('wasm', `/${wasmRel}`);
    // slice(repoRoot.length) keeps the leading separator, so the old template
    // produced `//presets/...` — a protocol-relative URL pointing at a host
    // named "presets", which fetch() reports only as "Failed to fetch".
    const presetRel = presetPath.startsWith(repoRoot)
        ? presetPath.slice(repoRoot.length).replace(/^\//, '')
        : presetPath.replace(/^\//, '');
    pageUrl.searchParams.set('preset', `/${presetRel}`);

    // Resolved the way every other harness resolves it: playwright is a
    // dependency of tests/wasm-smoke, not of the repo root, so a bare
    // `import('playwright')` from scripts/ finds nothing and the whole
    // dual-topology gate silently never runs.
    const { loadPlaywright, launchChromium } = await import('../tests/wasm-smoke/lib/harness-runtime.mjs');
    const { chromium } = loadPlaywright(repoRoot);
    // Same launcher as the golden-image gate: software GL, so the run does not
    // depend on whatever GPU the machine happens to have. Without it this
    // harness rendered through a different GL path than every other harness and
    // its reactivity thresholds went flaky.
    const browser = await launchChromium(chromium, 'swiftshader');
    const outcomes = {};
    try {
        for (const mode of ['main', 'worker']) {
            outcomes[mode] = await runMode(browser, pageUrl, mode);
        }
    } finally {
        await browser.close();
        server.close();
    }

    console.log(JSON.stringify(outcomes, null, 2));

    const failed = Object.entries(outcomes).filter(([, outcome]) => !outcome?.ok);
    for (const [mode, outcome] of failed) {
        console.error(`FAIL (${mode}): ${outcome?.error ?? 'no outcome reported'}`);
    }
    process.exit(failed.length === 0 ? 0 : 1);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
