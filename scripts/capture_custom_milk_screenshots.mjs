#!/usr/bin/env node
/**
 * Capture PNG screenshots of custom_milk_fixed presets via headless Chromium.
 *
 * Usage:
 *   node scripts/capture_custom_milk_screenshots.mjs
 *   node scripts/capture_custom_milk_screenshots.mjs --preset custom_milk_fixed/milk011.milk
 *   node scripts/capture_custom_milk_screenshots.mjs --out screenshots/custom_milk_baseline
 *   node scripts/capture_custom_milk_screenshots.mjs --out screenshots/custom_milk_baseline --update-golden
 *   node scripts/capture_custom_milk_screenshots.mjs --allow-dark --dark-threshold 3
 *
 *   # Compare two previously captured directories (no browser launch):
 *   node scripts/capture_custom_milk_screenshots.mjs --diff screenshots/custom_milk_baseline screenshots/custom_milk_upgraded
 *
 * Requires: npm install in tests/wasm-smoke (playwright)
 */

import { createServer } from 'node:http';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
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

// Best-effort load of playwright-core's bundled pixelmatch for the optional
// `--diff` pixel-diff percentage. Returns null if unavailable so `--diff`
// still produces a report (with meanRgb deltas only) when it can't be found.
function loadPixelmatch() {
  try {
    const smokePkg = join(root, 'tests/wasm-smoke/package.json');
    const req = existsSync(smokePkg) ? createRequire(smokePkg) : createRequire(import.meta.url);
    const pwCoreDir = dirname(req.resolve('playwright-core/package.json'));
    const pwCoreRequire = createRequire(join(pwCoreDir, 'package.json'));
    return pwCoreRequire('./lib/third_party/pixelmatch.js');
  } catch (_) {
    return null;
  }
}

const moduleJs = resolve(process.env.PROJECTM_WASM_JS || join(root, 'projectm-v.030-thread.1ijs'));
// Module wrapper may be `.js` (raw Emscripten output, e.g. CI's
// cmake-build/wasm-smoke/projectm-v.030-thread.js) or `.1ijs`/`.ijs`
// (UTF-16 copies produced by scripts/build_projectm.sh for other deploy
// targets) — either way the WASM binary sits alongside as `.wasm`.
const moduleWasm = moduleJs.replace(/\.(?:1ijs|ijs|js)$/, '.wasm');
const presetDir = join(root, 'custom_milk_fixed');
const emptyPreset = join(root, 'presets', 'tests', '000-empty.milk');
const capturePage = resolve(root, 'tests/wasm-smoke/capture.html');
const DEFAULT_DARK_THRESHOLD = 5;

function parseArgs(argv) {
  const opts = {
    preset: null,
    presets: null,
    out: join(root, 'screenshots', 'custom_milk_baseline'),
    frames: 120,
    diff: null,
    allowDark: false,
    darkThreshold: DEFAULT_DARK_THRESHOLD,
    updateGolden: false,
    goldenDir: join(root, 'screenshots', 'golden')
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--preset') opts.preset = resolve(root, argv[++i]);
    else if (argv[i] === '--presets') opts.presets = argv[++i].split(/[,\s]+/).filter(Boolean);
    else if (argv[i] === '--out') opts.out = resolve(argv[++i]);
    else if (argv[i] === '--frames') opts.frames = Number(argv[++i]);
    else if (argv[i] === '--diff') opts.diff = [resolve(root, argv[++i]), resolve(root, argv[++i])];
    else if (argv[i] === '--allow-dark') opts.allowDark = true;
    else if (argv[i] === '--dark-threshold') opts.darkThreshold = Number(argv[++i]);
    else if (argv[i] === '--update-golden') opts.updateGolden = true;
    else if (argv[i] === '--golden-dir') opts.goldenDir = resolve(root, argv[++i]);
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

// Like rootRelative(), but for displaying arbitrary --diff directories
// (which need not live under `root`) — falls back to the absolute path.
function displayPath(path) {
  try {
    return rootRelative(path);
  } catch (_) {
    return path;
  }
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

// Resolves a `--presets` entry to an absolute .milk path. Accepts:
//   - a path ending in .milk, resolved relative to root (e.g. "custom_milk_fixed/milk011.milk")
//   - a bare name (e.g. "milk011" or "000-empty"), looked up in custom_milk_fixed/
//     and presets/tests/ — keeps CI invocations short.
function resolvePresetName(name) {
  if (name.endsWith('.milk')) return resolve(root, name);
  const candidates = [join(presetDir, `${name}.milk`), join(root, 'presets', 'tests', `${name}.milk`)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Preset not found for "${name}" (tried ${candidates.join(', ')})`);
}

function listPresets(opts) {
  if (opts.presets) {
    return opts.presets.map(resolvePresetName);
  }
  if (opts.preset) {
    if (existsSync(emptyPreset) && resolve(opts.preset) !== resolve(emptyPreset)) {
      return [emptyPreset, opts.preset];
    }
    return [opts.preset];
  }
  return readdirSync(presetDir)
    .filter((name) => name.endsWith('.milk'))
    .map((name) => join(presetDir, name))
    .sort();
}

// --- Minimal PNG decoder (8-bit, non-interlaced, color types 0/2/3*/4/6) ---
// Used only for the optional `--diff` pixel-diff percentage. Palette (color
// type 3) PNGs aren't supported and will cause that file pair's pixel diff
// to be skipped (meanRgb deltas still work, since those come from
// capture_report.json, not the PNG itself).
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('Not a PNG file');
  }
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idatChunks = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf.readUInt8(dataStart + 8);
      colorType = buf.readUInt8(dataStart + 9);
      interlace = buf.readUInt8(dataStart + 12);
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4; // skip CRC
  }
  if (interlace !== 0) throw new Error('Interlaced PNG not supported');
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);

  const channelsByColorType = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type: ${colorType}`);

  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prevLine = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prevLine[x];
      const c = x >= channels ? prevLine[x - channels] : 0;
      let val = line[x];
      switch (filterType) {
        case 0: break;
        case 1: val = (val + a) & 0xff; break;
        case 2: val = (val + b) & 0xff; break;
        case 3: val = (val + ((a + b) >> 1)) & 0xff; break;
        case 4: val = (val + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`Unsupported PNG filter type: ${filterType}`);
      }
      cur[x] = val;
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      if (channels === 4) {
        out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2]; out[di + 3] = cur[si + 3];
      } else if (channels === 3) {
        out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2]; out[di + 3] = 255;
      } else if (channels === 2) {
        out[di] = out[di + 1] = out[di + 2] = cur[si]; out[di + 3] = cur[si + 1];
      } else {
        out[di] = out[di + 1] = out[di + 2] = cur[si]; out[di + 3] = 255;
      }
    }
    prevLine = cur;
  }
  return { width, height, data: out };
}

// --- --diff mode: compare two previously-captured directories ---
function loadCaptureReport(dir) {
  const reportPath = join(dir, 'capture_report.json');
  if (!existsSync(reportPath)) return null;
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function findReportEntry(report, pngName) {
  if (!report || !Array.isArray(report.results)) return null;
  return report.results.find((entry) => `${basename(entry.preset, '.milk')}.png` === pngName) || null;
}

function runDiff(dirA, dirB, opts) {
  for (const dir of [dirA, dirB]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`--diff directory not found: ${dir}`);
    }
  }
  const reportA = loadCaptureReport(dirA);
  const reportB = loadCaptureReport(dirB);
  const pixelmatch = loadPixelmatch();

  const pngsA = new Set(readdirSync(dirA).filter((f) => f.endsWith('.png') && !f.endsWith('_error.png')));
  const pngsB = new Set(readdirSync(dirB).filter((f) => f.endsWith('.png') && !f.endsWith('_error.png')));
  const allNames = Array.from(new Set([...pngsA, ...pngsB])).sort();

  const diffReport = {
    generated_at: new Date().toISOString(),
    dirA: displayPath(dirA),
    dirB: displayPath(dirB),
    pixelDiffAvailable: !!pixelmatch,
    results: []
  };

  for (const name of allNames) {
    const entryA = findReportEntry(reportA, name);
    const entryB = findReportEntry(reportB, name);
    const result = {
      file: name,
      presetDisplayName: (entryB && entryB.presetDisplayName) || (entryA && entryA.presetDisplayName) || null
    };

    if (!pngsA.has(name)) { result.status = 'missing_in_a'; diffReport.results.push(result); continue; }
    if (!pngsB.has(name)) { result.status = 'missing_in_b'; diffReport.results.push(result); continue; }

    const meanRgbA = entryA && entryA.canvasMeanRgb;
    const meanRgbB = entryB && entryB.canvasMeanRgb;
    if (meanRgbA && meanRgbB) {
      result.meanRgbA = meanRgbA;
      result.meanRgbB = meanRgbB;
      result.meanRgbDelta = {
        r: meanRgbB.r - meanRgbA.r,
        g: meanRgbB.g - meanRgbA.g,
        b: meanRgbB.b - meanRgbA.b,
        mean: meanRgbB.mean - meanRgbA.mean
      };
    } else {
      result.meanRgbDelta = null;
      result.note = 'capture_report.json missing canvasMeanRgb for one or both sides';
    }

    try {
      const imgA = decodePng(readFileSync(join(dirA, name)));
      const imgB = decodePng(readFileSync(join(dirB, name)));
      if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
        result.pixelDiffPercent = null;
        result.pixelDiffNote = `dimension mismatch ${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height}`;
      } else if (pixelmatch) {
        const diffOut = new Uint8Array(imgA.data.length);
        const diffPixels = pixelmatch(imgA.data, imgB.data, diffOut, imgA.width, imgA.height, { threshold: 0.1 });
        result.pixelDiffPercent = (diffPixels / (imgA.width * imgA.height)) * 100;
      } else {
        result.pixelDiffPercent = null;
        result.pixelDiffNote = 'pixelmatch unavailable';
      }
    } catch (error) {
      result.pixelDiffPercent = null;
      result.pixelDiffError = String(error && error.message ? error.message : error);
    }

    diffReport.results.push(result);
  }

  const outDir = opts.out !== join(root, 'screenshots', 'custom_milk_baseline') ? opts.out : dirB;
  mkdirSync(outDir, { recursive: true });
  const diffReportPath = join(outDir, 'diff_report.json');
  writeFileSync(diffReportPath, JSON.stringify(diffReport, null, 2));

  console.log(`Compared ${diffReport.results.length} preset(s): ${displayPath(dirA)} -> ${displayPath(dirB)}`);
  for (const result of diffReport.results) {
    if (result.status) {
      console.log(`  ? ${result.file}: ${result.status}`);
      continue;
    }
    const meanStr = result.meanRgbDelta ? `meanRgb delta ${result.meanRgbDelta.mean.toFixed(2)}` : 'meanRgb n/a';
    const pixelStr = typeof result.pixelDiffPercent === 'number'
      ? `pixel diff ${result.pixelDiffPercent.toFixed(2)}%`
      : `pixel diff n/a${result.pixelDiffNote ? ` (${result.pixelDiffNote})` : ''}`;
    console.log(`  - ${result.file}: ${meanStr}, ${pixelStr}`);
  }
  console.log(`\nDiff report: ${diffReportPath}`);
}

const opts = parseArgs(process.argv);

if (opts.diff) {
  runDiff(opts.diff[0], opts.diff[1], opts);
} else {
  await runCaptureMode(opts);
}

async function runCaptureMode(opts) {
  const { chromium } = loadPlaywright();
  assertFile(moduleJs, 'WASM JS wrapper');
  assertFile(moduleWasm, 'WASM binary');
  assertFile(capturePage, 'capture.html');
  if (opts.preset) assertFile(opts.preset, 'Preset');

  mkdirSync(opts.out, { recursive: true });

  const presets = listPresets(opts);
  for (const presetPath of presets) assertFile(presetPath, 'Preset');
  if (presets.length === 0) throw new Error('No presets found');

  const server = createStaticServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;

  const report = {
    captured_at: new Date().toISOString(),
    module: basename(moduleJs),
    frames: opts.frames,
    darkThreshold: opts.darkThreshold,
    allowDark: opts.allowDark,
    results: []
  };

  // Headless Chromium has no real GPU, so WebGL2 needs a software rasterizer.
  // --enable-unsafe-swiftshader enables Chromium's bundled SwiftShader for
  // WebGL in headless mode (Chrome >= 113-ish); without it, gl.getContext('webgl2')
  // either returns null or produces a context that reports errors / renders
  // blank, which would make every capture look "black" regardless of the
  // preset. If SwiftShader isn't available in this Chromium build, install a
  // software GL driver (e.g. Mesa llvmpipe via the `libgl1-mesa-dri` /
  // `mesa-vulkan-drivers` packages) and drop this flag in favor of
  // `--use-gl=angle --use-angle=swiftshader` or `--use-gl=swiftshader`.
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
  });

  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 520 } });
    page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (error) => console.error('[browser:pageerror]', error));

    for (const presetPath of presets) {
      const name = basename(presetPath, '.milk');
      const outPng = join(opts.out, `${name}.png`);
      const pageUrl = `http://127.0.0.1:${port}${rootRelative(capturePage)}?capture=1&module=${encodeURIComponent(rootRelative(moduleJs))}&preset=${encodeURIComponent(rootRelative(presetPath))}&frames=${opts.frames}`;

      const entry = {
        preset: basename(presetPath),
        presetPath: rootRelative(presetPath),
        presetDisplayName: null,
        png: outPng,
        ok: false,
        frames: 0,
        canvasMeanRgb: null,
        meanRgb: null,
        nonBlackFraction: null,
        consoleErrors: [],
        presetSwitchFailed: false,
        error: null
      };
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
        entry.presetPath = result.presetPath;
        entry.presetDisplayName = result.presetDisplayName || null;
        entry.canvasMeanRgb = result.canvasMeanRgb;
        entry.meanRgb = result.canvasMeanRgb ? result.canvasMeanRgb.mean : null;
        entry.nonBlackFraction = typeof result.nonBlackFraction === 'number' ? result.nonBlackFraction : null;
        entry.presetSwitchFailed = !!result.presetSwitchFailed;
        entry.consoleErrors = result.consoleErrors || [];
        if (entry.presetSwitchFailed) {
          throw new Error('preset switch failed');
        }

        // Visual sanity gate: a passing capture can still be an all-black
        // (or near-black) frame, which usually means the dual-FBO/compositor
        // blit didn't reach the canvas or the preset failed to render.
        if (!opts.allowDark && entry.meanRgb !== null && entry.meanRgb < opts.darkThreshold) {
          throw new Error(
            `canvas mean RGB ${entry.meanRgb.toFixed(2)} < dark threshold ${opts.darkThreshold} `
            + `(pass --allow-dark to permit intentionally dark captures)`
          );
        }

        console.log(`  ✓ ${outPng}`);
        if (entry.canvasMeanRgb && entry.canvasMeanRgb.mean <= 20) {
          console.warn(`  ! ${basename(presetPath)}: canvas mean RGB ${entry.canvasMeanRgb.mean.toFixed(2)} <= 20 (looks dark)`);
        }
        if (entry.consoleErrors.length > 0) {
          console.warn(`  ! ${basename(presetPath)}: ${entry.consoleErrors.length} console error(s)/warning(s):`);
          for (const line of entry.consoleErrors) console.warn(`      ${line}`);
        }
      } catch (error) {
        entry.ok = false;
        entry.error = String(error && error.stack ? error.stack : error);
        console.error(`  ✗ ${basename(presetPath)}: ${entry.error.split('\n')[0]}`);
        try {
          await page.screenshot({ path: join(opts.out, `${name}_error.png`), fullPage: true });
        } catch (_) {}
      }

      report.results.push(entry);
    }

    if (opts.preset && report.results.length >= 2) {
      const empty = report.results.find((entry) => entry.preset === basename(emptyPreset));
      const target = report.results.find((entry) => entry.preset === basename(opts.preset));
      if (empty?.ok && target?.ok && empty.canvasMeanRgb && target.canvasMeanRgb) {
        const dr = target.canvasMeanRgb.r - empty.canvasMeanRgb.r;
        const dg = target.canvasMeanRgb.g - empty.canvasMeanRgb.g;
        const db = target.canvasMeanRgb.b - empty.canvasMeanRgb.b;
        report.empty_comparison = {
          emptyPreset: empty.preset,
          targetPreset: target.preset,
          meanRgbDistance: Math.sqrt(dr * dr + dg * dg + db * db)
        };
        if (report.empty_comparison.meanRgbDistance < 1) {
          target.ok = false;
          target.error = `Capture is not visually distinct from ${empty.preset}; mean RGB distance ${report.empty_comparison.meanRgbDistance.toFixed(3)}`;
        }
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }

  if (opts.updateGolden) {
    const goldenSubdir = join(opts.goldenDir, basename(opts.out));
    mkdirSync(goldenSubdir, { recursive: true });
    for (const entry of report.results) {
      if (!entry.ok || !existsSync(entry.png)) continue;
      copyFileSync(entry.png, join(goldenSubdir, basename(entry.png)));
    }
    console.log(`\nGolden images updated: ${goldenSubdir}`);
  }

  const reportPath = join(opts.out, 'capture_report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${reportPath}`);
  const failed = report.results.filter((r) => !r.ok).length;
  if (failed > 0) process.exitCode = 1;
}
