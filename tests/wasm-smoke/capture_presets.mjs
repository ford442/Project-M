#!/usr/bin/env node
/**
 * Capture PNG screenshots of custom_milk_fixed presets via headless Chromium.
 *
 * Usage:
 *   node scripts/capture_custom_milk_screenshots.mjs
 *   node scripts/capture_custom_milk_screenshots.mjs --preset custom_milk_fixed/milk011.milk
 *   node scripts/capture_custom_milk_screenshots.mjs --out screenshots/custom_milk_baseline
 *
 * Requires: npm install in tests/wasm-smoke (playwright)
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));

function detectProjectRoot(dir) {
  const candidates = [resolve(dir, '..'), resolve(dir, '..', '..')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'custom_milk_fixed'))) return candidate;
  }
  return resolve(dir, '..');
}

const root = resolve(process.env.PROJECTM_ROOT || detectProjectRoot(scriptDir));

function loadPlaywright() {
  const smokePkg = join(root, 'tests/wasm-smoke/package.json');
  if (existsSync(smokePkg)) {
    try {
      return createRequire(smokePkg)('playwright');
    } catch (_) {}
  }
  return createRequire(import.meta.url)('playwright');
}

const { chromium } = loadPlaywright();
const moduleJs = resolve(process.env.PROJECTM_WASM_JS || join(root, 'projectm-v.030-thread.1ijs'));
const moduleWasm = moduleJs.replace(/\.1?ijs$/, '.wasm');
const presetDir = join(root, 'custom_milk_fixed');
const capturePage = resolve(root, 'tests/wasm-smoke/capture.html');

function parseArgs(argv) {
  const opts = { preset: null, out: join(root, 'screenshots', 'custom_milk_baseline'), frames: 120 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--preset') opts.preset = resolve(root, argv[++i]);
    else if (argv[i] === '--out') opts.out = resolve(argv[++i]);
    else if (argv[i] === '--frames') opts.frames = Number(argv[++i]);
  }
  return opts;
}

function assertFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} not found: ${path}`);
  }
}

function rootRelative(path) {
  const normalizedRoot = root.endsWith(sep) ? root : root + sep;
  if (!path.startsWith(normalizedRoot)) throw new Error(`Outside root: ${path}`);
  return '/' + path.slice(normalizedRoot.length).split(sep).map(encodeURIComponent).join('/');
}

function contentType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
    case '.1ijs': return 'text/javascript; charset=utf-8';
    case '.wasm': return 'application/wasm';
    case '.milk': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function sendFile(response, path) {
  response.writeHead(200, {
    'Content-Type': contentType(path),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store'
  });
  createReadStream(path).pipe(response);
}

function createStaticServer() {
  return createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const filePath = resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!filePath.startsWith(root + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        response.writeHead(404).end('Not found');
        return;
      }
      sendFile(response, filePath);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
}

function listPresets(singlePreset) {
  if (singlePreset) return [singlePreset];
  return readdirSync(presetDir)
    .filter((name) => name.endsWith('.milk'))
    .map((name) => join(presetDir, name))
    .sort();
}

const opts = parseArgs(process.argv);
assertFile(moduleJs, 'WASM JS wrapper');
assertFile(moduleWasm, 'WASM binary');
assertFile(capturePage, 'capture.html');

mkdirSync(opts.out, { recursive: true });

const presets = listPresets(opts.preset);
if (presets.length === 0) throw new Error('No presets found');

const server = createStaticServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const report = {
  captured_at: new Date().toISOString(),
  module: basename(moduleJs),
  frames: opts.frames,
  results: []
};

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

try {
  const page = await browser.newPage({ viewport: { width: 640, height: 520 } });
  page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (error) => console.error('[browser:pageerror]', error));

  for (const presetPath of presets) {
    const name = basename(presetPath, '.milk');
    const outPng = join(opts.out, `${name}.png`);
    const pageUrl = `http://127.0.0.1:${port}${rootRelative(capturePage)}?module=${encodeURIComponent(rootRelative(moduleJs))}&preset=${encodeURIComponent(rootRelative(presetPath))}&frames=${opts.frames}`;

    const entry = { preset: basename(presetPath), png: outPng, ok: false, error: null };
    console.log(`Capturing ${basename(presetPath)}…`);

    try {
      await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__projectMPresetCapture, null, { timeout: 120000 });
      const result = await page.evaluate(() => window.__projectMPresetCapture);
      if (!result.ok) throw new Error(result.error || 'capture failed');

      const canvas = page.locator('#mcanvas');
      await canvas.screenshot({ path: outPng, type: 'png' });
      entry.ok = true;
      entry.frames = result.frames;
      console.log(`  ✓ ${outPng}`);
    } catch (error) {
      entry.error = String(error && error.stack ? error.stack : error);
      console.error(`  ✗ ${basename(presetPath)}: ${entry.error.split('\n')[0]}`);
      try {
        await page.screenshot({ path: join(opts.out, `${name}_error.png`), fullPage: true });
      } catch (_) {}
    }

    report.results.push(entry);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const reportPath = join(opts.out, 'capture_report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nReport: ${reportPath}`);
const failed = report.results.filter((r) => !r.ok).length;
if (failed > 0) process.exitCode = 1;