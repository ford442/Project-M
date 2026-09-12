#!/usr/bin/env node
/**
 * Headless WASM preset performance benchmark using Playwright.
 *
 * Exercises the curated preset list in presets/benchmark_curated.json against a
 * built projectm-v.030-thread.{js,wasm} bundle, collecting per-frame CPU/GPU
 * breakdown and preset-switch readiness timings.
 *
 * Usage:
 *   node scripts/benchmark_presets_wasm.mjs [path/to/projectm-v.030-thread.js]
 *   node scripts/benchmark_presets_wasm.mjs --baseline out/baseline.json
 *   node scripts/benchmark_presets_wasm.mjs --compare out/baseline.json
 *   node scripts/benchmark_presets_wasm.mjs --software-gl   # no GPU: timings are not a measurement
 *
 * Environment:
 *   PROJECTM_SMOKE_ROOT  repo root for static file serving (default: cwd)
 *   PROJECTM_BENCH_MANIFEST  override manifest path
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumArgs, loadPlaywright } from '../tests/wasm-smoke/lib/harness-runtime.mjs';

const projectRoot = resolve(process.env.PROJECTM_SMOKE_ROOT || process.cwd());
// Playwright is a devDependency of tests/wasm-smoke, not of the repo root, so a
// bare `import 'playwright'` here resolves only when this script happens to be
// run from that directory. loadPlaywright() looks there first, which is where
// the golden gate and every other browser-driven runner already find it.
const { chromium } = loadPlaywright(projectRoot);
const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const defaultModulePath = resolve(projectRoot, 'cmake-build/wasm-smoke/projectm-v.030-thread.js');
const defaultManifestPath = resolve(
  process.env.PROJECTM_BENCH_MANIFEST || resolve(projectRoot, 'presets/benchmark_curated.json')
);

function parseArgs(argv) {
  const opts = {
    modulePath: defaultModulePath,
    manifestPath: defaultManifestPath,
    baseline: null,
    compare: null,
    out: null,
    headless: true,
    audioLoad: false,
    // Real GL by default. This script exists to measure frame time, and the
    // only runner whose frame times mean anything is one with a GPU — it used
    // to force ANGLE/SwiftShader unconditionally, so the nightly "real GPU"
    // job measured a software rasterizer and its record was rejected as
    // ungateable. --software-gl is for reproducing a run without a GPU, where
    // the numbers are for eyeballing only.
    softwareGl: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--baseline') opts.baseline = argv[++i];
    else if (arg === '--compare') opts.compare = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--headed') opts.headless = false;
    else if (arg === '--audio-load') opts.audioLoad = true;
    else if (arg === '--software-gl') opts.softwareGl = true;
    else if (!arg.startsWith('-')) opts.modulePath = resolve(arg);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!opts.out) {
    opts.out = resolve(projectRoot, 'benchmark-results/preset-benchmark.json');
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

function createStaticServer() {
  return createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const requestPath = decodeURIComponent(url.pathname);
      const filePath = resolve(projectRoot, '.' + requestPath);
      if (!filePath.startsWith(projectRoot + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': contentType(filePath),
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

function loadManifest(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const presets = (manifest.presets || [])
    .map((entry) => (typeof entry === 'string' ? entry : entry.path))
    .filter(Boolean)
    .map((rel) => resolve(projectRoot, rel))
    .filter((abs) => {
      if (!existsSync(abs)) {
        console.warn(`[benchmark] skipping missing preset: ${abs}`);
        return false;
      }
      return true;
    });
  if (presets.length === 0) {
    throw new Error(`No benchmark presets found in ${path}`);
  }
  return { manifest, presets };
}

function compareResults(baseline, current) {
  const rows = [];
  for (const row of current.presets || []) {
    const base = (baseline.presets || []).find((p) => p.preset === row.preset);
    if (!base) {
      rows.push({ preset: row.preset, status: 'new', fpsMedian: row.fps.median });
      continue;
    }
    const fpsDelta = row.fps.median - base.fps.median;
    const totalDelta = row.totalMs.median - base.totalMs.median;
    rows.push({
      preset: row.preset,
      status: 'compared',
      fpsMedian: row.fps.median,
      fpsDelta,
      totalMsMedian: row.totalMs.median,
      totalMsDelta: totalDelta,
      perPixelDelta: row.breakdownMs.perPixelEvalMs.median - base.breakdownMs.perPixelEvalMs.median,
      switchReadyDelta: row.switchReadyMs.median - base.switchReadyMs.median,
    });
  }
  return rows;
}

const opts = parseArgs(process.argv);
const wasmJs = opts.modulePath;
const wasmBinary = wasmJs.replace(/\.js$/, '.wasm');
if (!existsSync(wasmJs) || !existsSync(wasmBinary)) {
  console.error(`Missing WASM bundle:\n  ${wasmJs}\n  ${wasmBinary}`);
  process.exit(1);
}

const { manifest, presets } = loadManifest(opts.manifestPath);
const server = createStaticServer();
const port = await listen(server);
const benchmarkPage = rootRelative(resolve(projectRoot, 'tests/wasm-smoke/benchmark.html'));
const moduleUrl = rootRelative(wasmJs);
const presetUrls = presets.map((p) => rootRelative(p)).join(',');
const query = new URLSearchParams({
  module: moduleUrl,
  presets: presetUrls,
  frames: String(manifest.framesPerPreset || 300),
  warmup: String(manifest.warmupFrames || 30),
  width: String(manifest.canvas?.width || 1280),
  height: String(manifest.canvas?.height || 720),
  targetFps: String(manifest.targetFps || 60),
  switchIterations: String(manifest.switchBench?.iterations || 3),
});
if (opts.audioLoad || manifest.audioBench?.enabled) {
  query.set('audioLoad', '1');
}
const url = `http://127.0.0.1:${port}${benchmarkPage}?${query.toString()}`;

let browser;
try {
  browser = await chromium.launch({
    headless: opts.headless,
    args: chromiumArgs(opts.softwareGl ? 'software' : 'gpu'),
    ...(process.env.PROJECTM_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PROJECTM_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  page.on('console', (message) => {
    console.log(`[browser:${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    console.error('[browser:pageerror]', error);
  });

  // A software rasterizer renders these presets roughly an order of magnitude
  // slower than a GPU, so the GPU-shaped budget expires mid-run and the whole
  // benchmark is lost to a timeout rather than reported.
  const perFrameBudgetMs = opts.softwareGl ? 400 : 50;
  const timeoutMs = Math.max(
    opts.softwareGl ? 1_800_000 : 180_000,
    presets.length * (manifest.framesPerPreset || 300) * perFrameBudgetMs,
  );
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const handle = await page.waitForFunction(() => window.__projectMPresetBenchmarkResult, null, { timeout: timeoutMs });
  const result = await handle.jsonValue();
  if (!result.ok) {
    throw new Error(result.error || 'benchmark failed');
  }

  result.manifest = opts.manifestPath;
  result.module = wasmJs;
  result.audioLoad = !!(opts.audioLoad || manifest.audioBench?.enabled);
  result.generatedAt = new Date().toISOString();

  if (opts.baseline) {
    writeFileSync(resolve(opts.baseline), JSON.stringify(result, null, 2));
    console.log(`Wrote baseline: ${opts.baseline}`);
  } else {
    writeFileSync(resolve(opts.out), JSON.stringify(result, null, 2));
    console.log(`Wrote results: ${opts.out}`);
  }

  if (opts.compare) {
    const baseline = JSON.parse(readFileSync(resolve(opts.compare), 'utf8'));
    const comparison = compareResults(baseline, result);
    console.log('[projectM preset-benchmark compare]');
    console.log(JSON.stringify({ comparison, current: result }, null, 2));
    const failed = comparison.filter((row) => row.status === 'compared' && row.fpsMedian < (manifest.targetFps || 60) * 0.95);
    if (failed.length > 0) {
      console.error(`Presets below 95% of ${manifest.targetFps || 60} fps median:`, failed.map((r) => r.preset));
      process.exitCode = 1;
    }
  }

  const belowTarget = (result.presets || []).filter((p) => !p.metTargetFps);
  if (belowTarget.length > 0) {
    console.warn('Presets below target fps:', belowTarget.map((p) => p.preset));
  }
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
