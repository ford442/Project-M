#!/usr/bin/env node
/**
 * Playwright runner for tests/wasm-smoke/audio_reactivity.html
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
                res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
                res.end(data);
            } catch {
                res.writeHead(404);
                res.end('not found');
            }
        });
        server.listen(0, '127.0.0.1', () => resolveServer(server));
    });
}

async function run() {
    const server = await startServer(repoRoot);
    const port = server.address().port;
    const wasmRel = wasmPath.startsWith(repoRoot)
        ? wasmPath.slice(repoRoot.length).replace(/^\//, '')
        : null;
    const pageUrl = new URL(`http://127.0.0.1:${port}/tests/wasm-smoke/audio_reactivity.html`);
    if (wasmRel) pageUrl.searchParams.set('wasm', `/${wasmRel}`);
    pageUrl.searchParams.set('preset', `/${presetPath.startsWith(repoRoot) ? presetPath.slice(repoRoot.length) : presetPath}`);

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(pageUrl.href, { waitUntil: 'networkidle', timeout: 120000 });
        await page.waitForFunction(() => window.__projectMAudioReactivity?.tests?.bassMeans, null, { timeout: 120000 });
        const outcome = await page.evaluate(() => window.__projectMAudioReactivity);
        console.log(JSON.stringify(outcome, null, 2));
        server.close();
        process.exit(outcome.ok ? 0 : 1);
    } finally {
        await browser.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
