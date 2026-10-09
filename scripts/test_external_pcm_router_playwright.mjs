#!/usr/bin/env node
/**
 * Playwright smoke for the external PCM path. No WASM build required.
 *
 *  1. Router gate: a mock postMessage PCM producer + AudioSourceRouter.
 *  2. iframe → host → worker: a same-origin feeder iframe plays a tone with
 *     the real FLAC player bridge (html/flac-player/projectm-pcm-bridge.js)
 *     and a stand-in for the player bundle's own untagged sender; the host runs
 *     the real receiver (html/projectm-external-pcm.js) on a worker transport
 *     and a stand-in render worker counts what arrives. Checks the worker gets
 *     the bridge's stereo stream exactly once at real time (the feed that used
 *     to arrive ~3.5x over), and that the untagged duplicates are dropped.
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

// How long the tone plays before the rates are read, and the accepted band
// around real time (frames per second / sample rate).
const IFRAME_RUN_MS = 3000;
const REALTIME_MIN = 0.8;
const REALTIME_MAX = 1.25;

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

async function runRouterScenario(browser, port) {
    const pageUrl = `http://127.0.0.1:${port}/tests/wasm-smoke/external_pcm_router.html`;
    {
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

        console.log(JSON.stringify({ scenario: 'router', ok, afterFeed, afterBlock }, null, 2));
        await page.close();
        return ok;
    }
}

async function runIframeWorkerScenario(browser, port) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/tests/wasm-smoke/external_pcm_iframe_host.html`, {
        waitUntil: 'load',
        timeout: 30000,
    });
    await page.waitForFunction(() => {
        const feeder = window.__projectMIframeWorkerSmoke?.feeder();
        return feeder && feeder.bridge && feeder.bridge.blocks > 0;
    }, null, { timeout: 15000 });

    const read = () => page.evaluate(() => ({
        at: performance.now(),
        host: window.__projectMIframeWorkerSmoke.hostStats(),
        worker: window.__projectMIframeWorkerSmoke.workerCounts(),
        feeder: window.__projectMIframeWorkerSmoke.feeder(),
        rates: window.__projectMIframeWorkerSmoke.pcmRates(),
    }));
    const start = await read();
    await page.waitForTimeout(IFRAME_RUN_MS);
    const end = await read();

    const seconds = (end.at - start.at) / 1000;
    const sampleRate = end.host.lastSampleRate || 0;
    const hostFps = (end.host.framesFed - start.host.framesFed) / seconds;
    const workerFps = (end.worker.frames - start.worker.frames) / seconds;
    const ratio = (fps) => (sampleRate > 0 ? fps / sampleRate : 0);

    const checks = {
        noPageErrors: errors.length === 0,
        bridgeCapturing: end.feeder.bridge.captureKind !== 'none',
        taggedProducer: end.host.lastProducer === 'projectm-flac-bridge',
        stereo: end.host.lastChannels === 2 && end.worker.channels === 2,
        sampleRateReported: sampleRate >= 8000,
        hostRealTime: ratio(hostFps) >= REALTIME_MIN && ratio(hostFps) <= REALTIME_MAX,
        workerRealTime: ratio(workerFps) >= REALTIME_MIN && ratio(workerFps) <= REALTIME_MAX,
        workerGetsWhatHostFed: Math.abs(end.worker.frames - end.host.framesFed) <= 4096,
        untaggedDropped: end.host.dropped.superseded > 0,
        hudPublished: !!end.rates && end.rates.topology === 'worker',
    };
    const ok = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({
        scenario: 'iframe-host-worker',
        ok,
        checks,
        hostFps: Math.round(hostFps),
        workerFps: Math.round(workerFps),
        sampleRate,
        dropped: end.host.dropped,
        feeder: end.feeder,
        errors,
    }, null, 2));
    await page.close();
    return ok;
}

async function run() {
    const server = await startServer(repoRoot);
    const port = server.address().port;

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
        headless: true,
        // The feeder iframe's AudioContext must run without a click.
        args: ['--autoplay-policy=no-user-gesture-required'],
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
            : {}),
    });
    try {
        const routerOk = await runRouterScenario(browser, port);
        const iframeOk = await runIframeWorkerScenario(browser, port);
        server.close();
        process.exit(routerOk && iframeOk ? 0 : 1);
    } finally {
        await browser.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
