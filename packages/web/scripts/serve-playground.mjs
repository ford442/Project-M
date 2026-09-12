#!/usr/bin/env node
// Serve the playground with the headers the threaded WASM build requires.
//
// `python -m http.server` and every other quick static server sends no
// COOP/COEP, so SharedArrayBuffer is unavailable and the engine fails with init
// error code 4 before it draws anything. That is the single most common way a
// first attempt at embedding projectM appears broken, which is why this exists
// rather than a line in the README telling people to configure their own server.
//
//   npm run playground            (in packages/web, or `npm run playground` at the root)
//
// Routes:
//   /                  -> playground/index.html
//   /dist/*            -> the built package (the playground imports it, not html/)
//   /pm/*              -> playground/pm, where projectm-fetch-wasm writes
//   /presets/*         -> the repo's presets/ tree, for the default preset-url

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');

const MOUNTS = [
    ['/dist/', join(packageRoot, 'dist')],
    ['/presets/', join(repoRoot, 'presets')],
    ['/', join(packageRoot, 'playground')],
];

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.milk': 'text/plain; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

const port = Number(process.env.PORT || 8173);

/** Resolve a request path to a file, refusing anything that escapes its mount. */
function resolveRequest(pathname) {
    const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    for (const [prefix, root] of MOUNTS) {
        if (!clean.startsWith(prefix)) continue;
        const relative = clean.slice(prefix.length) || 'index.html';
        const file = resolve(root, relative.endsWith('/') ? `${relative}index.html` : relative);
        if (file !== root && !file.startsWith(`${root}/`)) return null;
        return file;
    }
    return null;
}

const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, `http://localhost:${port}`);
    const file = resolveRequest(pathname);

    // The whole reason this server exists.
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Cache-Control', 'no-store');

    if (!file) {
        response.writeHead(404).end('Not found\n');
        return;
    }
    try {
        const info = await stat(file);
        if (!info.isFile()) throw new Error('not a file');
    } catch {
        response.writeHead(404).end(`Not found: ${pathname}\n`);
        return;
    }

    response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(file)] || 'application/octet-stream',
    });
    createReadStream(file).pipe(response);
});

async function missing(path) {
    try {
        await stat(path);
        return false;
    } catch {
        return true;
    }
}

server.listen(port, async () => {
    console.log(`playground  http://localhost:${port}/  (COOP/COEP enabled)`);
    if (await missing(join(packageRoot, 'dist', 'projectm-web.js'))) {
        console.warn('\n  dist/ is not built. Run: npm run build');
    }
    if (await missing(join(packageRoot, 'playground', 'pm'))) {
        console.warn(
            '\n  No WASM artifacts yet. Run:\n'
            + '    node scripts/fetch-wasm.mjs --out playground/pm',
        );
    }
});
