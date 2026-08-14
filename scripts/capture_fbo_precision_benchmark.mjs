#!/usr/bin/env node
/**
 * Captures the before/after dual-FBO precision benchmark pair (issue #216).
 *
 * The RGBA16F default only changes the *transition* path — the Preset B
 * surfaces are allocated when a soft cut starts and released when it ends — so
 * a steady-state `?benchmark=1` run composites nothing extra and shows no
 * difference. This script therefore drives the crossfade-gated benchmark
 * (`?benchmark=1&crossfade=1`, see docs/PERFORMANCE.md) twice against the same
 * build:
 *
 *   1. default probe order  -> RGBA16F
 *   2. `?fboPrecision=high` -> RGBA32F
 *
 * and writes both JSON reports plus a median-delta comparison.
 *
 * Usage:
 *   node scripts/capture_fbo_precision_benchmark.mjs [path/to/projectm-v.030-thread.js]
 *   node scripts/capture_fbo_precision_benchmark.mjs --frames 300 --crossfade-sec 20
 *   node scripts/capture_fbo_precision_benchmark.mjs --presets /presets/a.milk,/presets/b.milk
 *
 * Options:
 *   --frames N          In-crossfade frames to sample per run (default 300).
 *   --crossfade-sec N   Soft-cut duration in seconds (default 20).
 *   --presets a,b       Comma-separated repo-relative preset paths to cycle
 *                       through. Defaults to the host page's featured pack.
 *   --out-dir DIR       Where to write the JSON (default benchmark-results/).
 *   --timeout MS        Per-run timeout (default max(300000, frames * 400)).
 *   --headed            Run Chromium headed (useful for the visual banding check).
 *
 * Environment:
 *   PROJECTM_SMOKE_ROOT  repo root for static file serving (default: cwd)
 *   PROJECTM_WASM_JS     default module path when no positional arg is given
 *   PROJECTM_CHROMIUM    explicit Chromium executable, for images that ship a
 *                        browser Playwright did not download itself
 *
 * Note on hardware: run this on a real GPU. Under SwiftShader the frame is
 * CPU-bound and the VRAM/bandwidth difference this change is about will not
 * show up in `gpuMs`.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const projectRoot = resolve(process.env.PROJECTM_SMOKE_ROOT || process.cwd());

/** Artifact suffixes the Emscripten glue may request, longest-first. */
const MODULE_SUFFIXES = ['.worker.js', '.wasm', '.data', '.mem', '.js'];

/** The two runs that make up the A/B capture. */
const VARIANTS = [
    {
        label: 'rgba16f-default',
        query: {},
        expectFormat: 'RGBA16F',
        description: 'default probe order (RGBA16F -> RGBA32F -> RGBA8)',
    },
    {
        label: 'rgba32f-high',
        query: { fboPrecision: 'high' },
        expectFormat: 'RGBA32F',
        description: '?fboPrecision=high opt-in (RGBA32F first)',
    },
];

function parseArgs(argv) {
    const opts = {
        modulePath: process.env.PROJECTM_WASM_JS
            ? resolve(process.env.PROJECTM_WASM_JS)
            : resolve(projectRoot, 'cmake-build/wasm-smoke/projectm-v.030-thread.js'),
        frames: 300,
        crossfadeSec: 20,
        presets: null,
        outDir: resolve(projectRoot, 'benchmark-results'),
        timeout: null,
        headless: true,
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--frames') opts.frames = Number(argv[++i]);
        else if (arg === '--crossfade-sec') opts.crossfadeSec = Number(argv[++i]);
        else if (arg === '--presets') opts.presets = argv[++i];
        else if (arg === '--out-dir') opts.outDir = resolve(argv[++i]);
        else if (arg === '--timeout') opts.timeout = Number(argv[++i]);
        else if (arg === '--headed') opts.headless = false;
        else if (!arg.startsWith('-')) opts.modulePath = resolve(arg);
        else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(2);
        }
    }
    if (!Number.isFinite(opts.frames) || opts.frames <= 0) {
        console.error('--frames must be a positive number');
        process.exit(2);
    }
    if (!Number.isFinite(opts.crossfadeSec) || opts.crossfadeSec <= 0) {
        console.error('--crossfade-sec must be a positive number');
        process.exit(2);
    }
    if (opts.timeout === null) {
        opts.timeout = Math.max(300000, opts.frames * 400);
    }
    return opts;
}

function contentType(path) {
    switch (extname(path)) {
        case '.html': return 'text/html; charset=utf-8';
        case '.js':
        case '.mjs': return 'text/javascript; charset=utf-8';
        case '.wasm': return 'application/wasm';
        case '.json': return 'application/json; charset=utf-8';
        case '.milk': return 'text/plain; charset=utf-8';
        case '.css': return 'text/css; charset=utf-8';
        default: return 'application/octet-stream';
    }
}

function rootRelative(path) {
    const normalizedRoot = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep;
    if (!path.startsWith(normalizedRoot)) {
        throw new Error(`Path is outside project root: ${path}`);
    }
    return '/' + path.slice(normalizedRoot.length).split(sep).map(encodeURIComponent).join('/');
}

/**
 * Maps a bundle request the host page makes (`html/pm/projectm-v.036-thread.*`,
 * whatever `PROJECTM_WASM_VERSION` currently is) onto the locally built bundle
 * passed on the command line, so the capture runs against a fresh build without
 * having to stage a deploy mirror first.
 *
 * @param {string} filePath Absolute path the request resolved to.
 * @param {string} modulePath Absolute path of the built glue `.js`.
 * @returns {string | null} Absolute path of the aliased artifact, or null.
 */
function aliasModuleArtifact(filePath, modulePath) {
    const name = basename(filePath);
    const suffix = MODULE_SUFFIXES.find((candidate) => name.endsWith(candidate));
    if (!suffix) {
        return null;
    }
    const moduleBase = modulePath.slice(0, -extname(modulePath).length);
    const aliased = moduleBase + suffix;
    return existsSync(aliased) ? aliased : null;
}

function createStaticServer(modulePath) {
    return createServer((request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            const requestPath = decodeURIComponent(url.pathname);
            let filePath = resolve(projectRoot, '.' + requestPath);
            const insideRoot = filePath.startsWith(projectRoot + sep);
            const servable = insideRoot && existsSync(filePath) && statSync(filePath).isFile();

            if (!servable) {
                // The host page asks for the canonical deploy bundle name; serve
                // the built artifacts instead of 404ing.
                const aliased = insideRoot ? aliasModuleArtifact(filePath, modulePath) : null;
                if (!aliased) {
                    response.writeHead(404).end('Not found');
                    return;
                }
                filePath = aliased;
            }

            response.writeHead(200, {
                'Content-Type': contentType(filePath),
                // Required for the pthread build (SharedArrayBuffer).
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Resource-Policy': 'same-origin',
                'Cache-Control': 'no-store',
            });
            createReadStream(filePath).pipe(response);
        } catch (error) {
            response.writeHead(500).end(String(error && error.stack ? error.stack : error));
        }
    });
}

async function listen(server) {
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    return server.address().port;
}

function buildUrl(port, pagePath, opts, variant) {
    const query = new URLSearchParams({
        benchmark: '1',
        crossfade: '1',
        frames: String(opts.frames),
        crossfadeSec: String(opts.crossfadeSec),
        ...variant.query,
    });
    if (opts.presets) {
        query.set('crossfadePresets', opts.presets);
    }
    return `http://127.0.0.1:${port}${pagePath}?${query.toString()}`;
}

/**
 * Runs one crossfade-gated benchmark and returns the result object posted by
 * `projectm-perf.js` via `window.postMessage({ type: 'pm-benchmark-result' })`.
 */
async function runVariant(browser, port, pagePath, opts, variant) {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Installed before any navigation so the redirect that appends `?wasm=` does
    // not race the listener.
    await page.addInitScript(() => {
        if (window.__pmBenchmarkResults) {
            return;
        }
        window.__pmBenchmarkResults = [];
        window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'pm-benchmark-result') {
                window.__pmBenchmarkResults.push(event.data.result);
            }
        });
    });

    page.on('console', (message) => {
        console.log(`[browser:${variant.label}:${message.type()}] ${message.text()}`);
    });
    page.on('pageerror', (error) => {
        console.error(`[browser:${variant.label}:pageerror]`, error);
    });

    const url = buildUrl(port, pagePath, opts, variant);
    console.log(`\n[fbo-precision] ${variant.label}: ${variant.description}`);
    console.log(`[fbo-precision] ${url}`);

    try {
        await page.goto(url, { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(
            () => (window.__pmBenchmarkResults || []).length > 0,
            null,
            { timeout: opts.timeout }
        );
        const result = await page.evaluate(() => window.__pmBenchmarkResults[0]);

        if (!result.crossfade || !result.crossfade.active) {
            throw new Error(
                `${variant.label}: result is not crossfade-gated — a steady-state run is not valid evidence here`
            );
        }
        if (result.fboFormat !== variant.expectFormat) {
            console.warn(
                `[fbo-precision] WARNING: ${variant.label} ran at ${result.fboFormat}, expected ` +
                `${variant.expectFormat}. ${result.fboFormat === 'RGBA8'
                    ? 'This GPU/browser reports no float color-buffer support (degraded mode); the A/B is meaningless.'
                    : 'Check the probe order in DualPingPongFramebuffer::DetectFormat().'}`
            );
        }

        result.variant = variant.label;
        result.fboPrecisionQuery = variant.query.fboPrecision || null;
        return result;
    } finally {
        await context.close();
    }
}

function median(result, path) {
    const stats = path.split('.').reduce((acc, key) => (acc ? acc[key] : undefined), result);
    return stats && typeof stats.median === 'number' ? stats.median : null;
}

function compareRuns(before, after) {
    const metrics = [
        { key: 'totalMs', path: 'totalMs', lowerIsBetter: true },
        { key: 'fps', path: 'fps', lowerIsBetter: false },
        { key: 'gpuMs', path: 'breakdownMs.gpuMs', lowerIsBetter: true },
        { key: 'compositeMs', path: 'breakdownMs.compositeMs', lowerIsBetter: true },
    ];
    const rows = {};
    for (const metric of metrics) {
        const base = median(before, metric.path);
        const high = median(after, metric.path);
        if (base === null || high === null) {
            rows[metric.key] = { rgba16f: base, rgba32f: high, delta: null, pct: null };
            continue;
        }
        const delta = high - base;
        rows[metric.key] = {
            rgba16f: base,
            rgba32f: high,
            // Positive delta = RGBA32F costs more than the RGBA16F default.
            delta: Number(delta.toFixed(4)),
            pct: base !== 0 ? Number(((delta / base) * 100).toFixed(2)) : null,
            lowerIsBetter: metric.lowerIsBetter,
        };
    }
    return rows;
}

const opts = parseArgs(process.argv);
const wasmJs = opts.modulePath;
const wasmBinary = wasmJs.replace(/\.js$/, '.wasm');
if (!existsSync(wasmJs) || !existsSync(wasmBinary)) {
    console.error(
        `Missing WASM bundle:\n  ${wasmJs}\n  ${wasmBinary}\n\n` +
        'Build one with scripts/build_wasm_smoke_wrapper.sh, or pass the glue .js path ' +
        'as the first argument (see docs/EMSCRIPTEN.md).'
    );
    process.exit(1);
}

mkdirSync(opts.outDir, { recursive: true });

const server = createStaticServer(wasmJs);
const port = await listen(server);
const pagePath = rootRelative(resolve(projectRoot, 'html/projectm-core.html'));

let browser;
try {
    browser = await chromium.launch({
        headless: opts.headless,
        ...(process.env.PROJECTM_CHROMIUM ? { executablePath: process.env.PROJECTM_CHROMIUM } : {}),
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    });

    const runs = {};
    for (const variant of VARIANTS) {
        runs[variant.label] = await runVariant(browser, port, pagePath, opts, variant);
        const outPath = resolve(opts.outDir, `fbo-precision-${variant.label}.json`);
        writeFileSync(outPath, JSON.stringify(runs[variant.label], null, 2));
        console.log(`[fbo-precision] wrote ${outPath}`);
    }

    const before = runs['rgba16f-default'];
    const after = runs['rgba32f-high'];
    const comparison = {
        generatedAt: new Date().toISOString(),
        module: wasmJs,
        frames: opts.frames,
        crossfadeSec: opts.crossfadeSec,
        crossfadePresets: opts.presets || '(featured pack default)',
        note: 'Medians from crossfade-gated runs. delta = RGBA32F - RGBA16F, so a positive '
            + 'totalMs/gpuMs/compositeMs delta is the cost the RGBA16F default avoids.',
        fboFormat: {
            'rgba16f-default': before.fboFormat,
            'rgba32f-high': after.fboFormat,
        },
        medians: compareRuns(before, after),
    };
    const comparisonPath = resolve(opts.outDir, 'fbo-precision-comparison.json');
    writeFileSync(comparisonPath, JSON.stringify(comparison, null, 2));

    console.log('\n[projectM fbo-precision compare]');
    console.log(JSON.stringify(comparison, null, 2));
    console.log(`[fbo-precision] wrote ${comparisonPath}`);
} finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
}
