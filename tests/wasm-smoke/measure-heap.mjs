import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(process.env.PROJECTM_SMOKE_ROOT || process.cwd());
const modulePath = resolve(process.argv[2] || 'cmake-build/wasm-smoke/projectm-v.030-thread.js');
const presetPaths = process.argv.slice(3);
if (presetPaths.length === 0) {
  presetPaths.push(
    'presets/tests/000-empty.milk',
    'presets/tests/110-per_pixel.milk',
    'presets/tests/270-compshader-solid-color.milk'
  );
}

const FRAMES_STEADY = Number(process.env.PROJECTM_HEAP_FRAMES || 120);
const CANVAS_W = Number(process.env.PROJECTM_HEAP_WIDTH || 1280);
const CANVAS_H = Number(process.env.PROJECTM_HEAP_HEIGHT || 720);

function assertReadableFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} not found: ${path}`);
  }
}

function rootRelative(path) {
  const normalizedRoot = root.endsWith(sep) ? root : root + sep;
  if (!path.startsWith(normalizedRoot)) {
    throw new Error(`Path is outside smoke root: ${path}`);
  }
  return '/' + path.slice(normalizedRoot.length).split(sep).map(encodeURIComponent).join('/');
}

function contentType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
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
      const requestPath = decodeURIComponent(url.pathname);
      const filePath = resolve(root, '.' + requestPath);
      if (!filePath.startsWith(root + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        response.writeHead(404).end('Not found');
        return;
      }
      sendFile(response, filePath);
    } catch (error) {
      response.writeHead(500).end(String(error && error.stack ? error.stack : error));
    }
  });
}

async function listen(server) {
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return server.address().port;
}

async function measurePreset(page, presetAbsPath, presetIndex) {
  const presetName = presetAbsPath.split('/').pop();
  const presetBytes = readFileSync(presetAbsPath);
  const vfsPath = `/presets/tests/heap-${presetIndex}.milk`;

  return page.evaluate(async ({ presetBytes, vfsPath, frames, canvasW, canvasH }) => {
    const peaks = { coldStart: 0, postInit: 0, postPresetLoad: 0, postSteadyState: 0, postTransition: 0 };
    const mark = (key) => {
      peaks[key] = Module.HEAP8.length;
    };

    mark('coldStart');

    const initResult = Module.ccall(
      'init_with_canvases',
      'number',
      ['string', 'string'],
      ['#pm-heap-main', '#pm-heap-secondary']
    );
    if (initResult !== 0) throw new Error('init_with_canvases failed: ' + initResult);
    mark('postInit');

    try { Module.FS.mkdir('/presets'); } catch (_) {}
    try { Module.FS.mkdir('/presets/tests'); } catch (_) {}
    Module.FS.writeFile(vfsPath, new Uint8Array(presetBytes));

    Module.ccall('load_preset_file', null, ['string'], [vfsPath]);
    mark('postPresetLoad');

    if (typeof Module._set_window_size === 'function') {
      Module._set_window_size(canvasW, canvasH);
    }
    if (typeof Module._set_mesh === 'function') {
      Module._set_mesh(80, 60);
    }

    for (let i = 0; i < frames; i++) {
      if (typeof Module._render_frame === 'function') {
        Module._render_frame();
      }
      const used = Module.HEAP8.length;
      if (used > peaks.postSteadyState) peaks.postSteadyState = used;
    }
    if (peaks.postSteadyState === 0) peaks.postSteadyState = Module.HEAP8.length;

    if (typeof Module._dual_fbo_begin_transition === 'function' &&
        typeof Module._dual_fbo_render_preset_a === 'function' &&
        typeof Module._dual_fbo_render_preset_b === 'function') {
      Module._dual_fbo_begin_transition();
      Module._dual_fbo_render_preset_a();
      Module._dual_fbo_render_preset_b();
      if (typeof Module._dual_fbo_end_transition === 'function') {
        Module._dual_fbo_end_transition();
      }
      peaks.postTransition = Module.HEAP8.length;
    }

    return peaks;
  }, {
    presetBytes: Array.from(presetBytes),
    vfsPath,
    frames: FRAMES_STEADY,
    canvasW: CANVAS_W,
    canvasH: CANVAS_H
  }).then((peaks) => ({
    preset: presetName,
    vfsPath,
    peaksMiB: Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, Math.round(v / (1024 * 1024) * 100) / 100])),
    peaksBytes: peaks,
    peakMiB: Math.round(Math.max(...Object.values(peaks)) / (1024 * 1024) * 100) / 100
  }));
}

assertReadableFile(modulePath, 'WASM wrapper JS');
assertReadableFile(modulePath.replace(/\.js$/, '.wasm'), 'WASM binary');
for (const p of presetPaths) assertReadableFile(resolve(root, p), 'Preset');

const server = createStaticServer();
const port = await listen(server);
const measurePagePath = rootRelative(resolve(fileURLToPath(new URL('measure-heap.html', import.meta.url))));
const moduleUrl = rootRelative(modulePath);
const url = `http://127.0.0.1:${port}${measurePagePath}?module=${encodeURIComponent(moduleUrl)}`;

let browser;
const results = [];
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-angle=swiftshader-webgl'
    ]
  });
  const page = await browser.newPage();

  for (let i = 0; i < presetPaths.length; i++) {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof createModule === 'function', null, { timeout: 30000 });

    await page.evaluate(async (moduleUrl) => {
      window.Module = await createModule({
        noInitialRun: true,
        primaryCanvasSelector: '#pm-heap-main',
        secondaryCanvasSelector: '#pm-heap-secondary',
        locateFile(path, prefix) { return prefix + path; }
      });
    }, moduleUrl);

    const presetAbs = resolve(root, presetPaths[i]);
    const result = await measurePreset(page, presetAbs, i);
    results.push(result);
    console.log(`[heap] ${result.preset}: peak=${result.peakMiB} MiB`, result.peaksMiB);
  }

    const overallPeakMiB = Math.max(...results.map((r) => r.peakMiB));
    const initialReservedMiB = results.length > 0
      ? results[0].peaksMiB.coldStart
      : null;
    const summary = {
      module: modulePath,
      initialReservedMiB,
      canvas: { width: CANVAS_W, height: CANVAS_H },
      steadyFrames: FRAMES_STEADY,
      presets: results,
      overallPeakMiB,
      recommendedInitialMemoryMiB: Math.max(64, Math.ceil(overallPeakMiB * 1.25 / 64) * 64),
      timestamp: new Date().toISOString()
    };
  console.log('[projectM heap benchmark]', JSON.stringify(summary, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
