#!/usr/bin/env node
/**
 * Playwright smoke: mock postMessage PCM producer + AudioSourceRouter gate.
 * No WASM build required.
 *
 * Usage: node scripts/test_external_pcm_router_playwright.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
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
    const pageUrl = `http://127.0.0.1:${port}/tests/wasm-smoke/external_pcm_router.html`;

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForFunction(() => window.__projectMExternalPcmRouterSmoke?.postPcm);

        await page.evaluate(() => window.__projectMExternalPcmRouterSmoke.postPcm());
        const afterFeed = await page.evaluate(() => ({
            status: window.__projectMExternalPcmRouterSmoke.getStatus(),
            fed: window.__projectMExternalPcmRouterSmoke.getFedCount(),
        }));

        await page.evaluate(() => window.__projectMExternalPcmRouterSmoke.blockExternal());
        await page.evaluate(() => window.__projectMExternalPcmRouterSmoke.postPcm());
        const afterBlock = await page.evaluate(() => ({
            status: window.__projectMExternalPcmRouterSmoke.getStatus(),
            fed: window.__projectMExternalPcmRouterSmoke.getFedCount(),
        }));

        const ok = afterFeed.status.activeSource === 'external'
            && afterFeed.fed >= 1
            && afterBlock.status.activeSource === 'element'
            && afterBlock.fed === afterFeed.fed;

        console.log(JSON.stringify({ ok, afterFeed, afterBlock }, null, 2));
        server.close();
        process.exit(ok ? 0 : 1);
    } finally {
        await browser.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
