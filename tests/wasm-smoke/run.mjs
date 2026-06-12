import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(process.env.PROJECTM_SMOKE_ROOT || process.cwd());
const modulePath = resolve(process.argv[2] || 'cmake-build/wasm-smoke/projectm-v.030-thread.js');
const presetPath = resolve(process.argv[3] || 'presets/tests/000-empty.milk');

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

assertReadableFile(modulePath, 'WASM wrapper JS');
assertReadableFile(modulePath.replace(/\.js$/, '.wasm'), 'WASM binary');
assertReadableFile(presetPath, 'Smoke preset');

const server = createStaticServer();
const port = await listen(server);
const smokePage = rootRelative(resolve(fileURLToPath(new URL('index.html', import.meta.url))));
const moduleUrl = rootRelative(modulePath);
const presetUrl = rootRelative(presetPath);
const url = `http://127.0.0.1:${port}${smokePage}?module=${encodeURIComponent(moduleUrl)}&preset=${encodeURIComponent(presetUrl)}`;

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  page.on('console', (message) => {
    console.log(`[browser:${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    console.error('[browser:pageerror]', error);
  });

  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  const result = await page.waitForFunction(() => window.__projectMWasmSmokeResult, null, { timeout: 60000 });
  const smokeResult = await result.jsonValue();
  if (!smokeResult.ok) {
    throw new Error(`WASM smoke failed: ${smokeResult.error || JSON.stringify(smokeResult)}`);
  }
  console.log('WASM smoke passed:', smokeResult.steps.join(' -> '));
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
