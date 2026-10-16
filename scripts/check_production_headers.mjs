#!/usr/bin/env node
/**
 * Checks what a deployed projectM site actually sends: the headers and bytes
 * html/.htaccess and the deploy manifests are supposed to produce
 * (docs/adr/0001-wasm-and-media-hosting.md).
 *
 * Every request goes out the way Chrome sends it (Accept-Encoding: gzip,
 * deflate, br) over raw node:http(s), so nothing is decoded behind the
 * script's back. It checks:
 *
 *   site root (/)           serves the host page (DirectoryIndex 1ink.1ink);
 *                           http:// redirects to https:// (https sites only)
 *   host page (1ink.1ink)   200 HTML, no-cache, COOP/COEP
 *   pm/builds.json          JSON, no-cache, a manifest the hosts accept
 *   each checked build      glue: text/javascript; charset=utf-8, ASCII;
 *                           wasm: application/wasm, \0asm;
 *                           both: at most one Content-Encoding that decodes,
 *                           decoded sha256 == the manifest's, CORP, no
 *                           `Vary: User-Agent`, Cache-Control set (revalidate
 *                           or immutable)
 *   legacy glue URL         .1ijs of a build with UTF-8 glue redirects to the .js
 *   songs/                  not an Apache auto-index; songs/index.json valid,
 *                           no-cache; one track: 206 to a Range request,
 *                           audio/flac, no Content-Encoding, CORP
 *
 * Usage:
 *   node scripts/check_production_headers.mjs [base-url] [--builds 039,038 | --all-builds]
 *     base-url defaults to https://projectm.1ink.us; builds default to the
 *     manifest's default and latest.
 *   --skip-songs     no songs/ checks (sites without a song library)
 *   --json           print the results as JSON too
 *
 * Exit status: 0 when every check passes, 1 otherwise.
 */

import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { parseWasmBuildsManifest } = await import(pathToFileURL(join(repoRoot, 'html', 'projectm-wasm-version.js')).href);

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'Accept-Encoding': 'gzip, deflate, br',
    Accept: '*/*',
};

/**
 * One request, no redirects followed, body not decoded.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, headers: Record<string, string | string[]>, raw: Buffer, url: string }>}
 */
export function rawRequest(url, { method = 'GET', headers = {} } = {}) {
    const client = url.startsWith('https:') ? https : http;
    return new Promise((resolveRequest, reject) => {
        const req = client.request(url, { method, headers: { ...BROWSER_HEADERS, ...headers }, timeout: 60000 }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks), url }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error(`timeout fetching ${url}`)));
        req.on('error', reject);
        req.end();
    });
}

const header = (res, name) => {
    const value = res.headers[name.toLowerCase()];
    return Array.isArray(value) ? value.join(', ') : (value ?? '');
};

/**
 * Removes the Content-Encoding layers the way a browser would.
 * @returns {{ body: Buffer, encodings: string[] }}
 */
export function decodeBody(res) {
    const encodings = header(res, 'content-encoding').split(',').map((t) => t.trim().toLowerCase()).filter((t) => t && t !== 'identity');
    let body = res.raw;
    for (const encoding of [...encodings].reverse()) {
        if (encoding === 'br') body = brotliDecompressSync(body);
        else if (encoding === 'gzip' || encoding === 'x-gzip') body = gunzipSync(body);
        else if (encoding === 'deflate') {
            try {
                body = inflateSync(body);
            } catch {
                body = inflateRawSync(body);
            }
        } else throw new Error(`unknown Content-Encoding ${encoding}`);
    }
    return { body, encodings };
}

class Report {
    constructor() {
        /** @type {{ target: string, name: string, ok: boolean, detail: string, warn?: boolean }[]} */
        this.rows = [];
    }

    check(target, name, ok, detail = '') {
        this.rows.push({ target, name, ok: !!ok, detail });
        return !!ok;
    }

    warn(target, name, detail) {
        this.rows.push({ target, name, ok: true, warn: true, detail });
    }

    get failed() {
        return this.rows.filter((r) => !r.ok);
    }

    print() {
        let lastTarget = '';
        for (const row of this.rows) {
            if (row.target !== lastTarget) {
                console.log(`\n${row.target}`);
                lastTarget = row.target;
            }
            const mark = row.ok ? (row.warn ? '!' : '✓') : '✗';
            console.log(`  ${mark} ${row.name}${row.detail ? `: ${row.detail}` : ''}`);
        }
    }
}

/** Cross-origin isolation + CORP, which every response here must carry. */
function checkIsolation(report, target, res, { page = false } = {}) {
    report.check(target, 'Cross-Origin-Resource-Policy', /cross-origin|same-site|same-origin/.test(header(res, 'cross-origin-resource-policy')), header(res, 'cross-origin-resource-policy') || 'missing');
    if (page) {
        report.check(target, 'Cross-Origin-Opener-Policy: same-origin', header(res, 'cross-origin-opener-policy') === 'same-origin', header(res, 'cross-origin-opener-policy') || 'missing');
        report.check(target, 'Cross-Origin-Embedder-Policy', /^(require-corp|credentialless)$/.test(header(res, 'cross-origin-embedder-policy')), header(res, 'cross-origin-embedder-policy') || 'missing');
    }
}

/** At most one encoding layer, and it decodes. Returns the decoded body or null. */
function checkEncoding(report, target, res) {
    let decoded;
    try {
        decoded = decodeBody(res);
    } catch (error) {
        report.check(target, 'Content-Encoding decodes', false, `${header(res, 'content-encoding')}: ${error.message} (browsers fail with ERR_CONTENT_DECODING_FAILED)`);
        return null;
    }
    report.check(target, 'single Content-Encoding', decoded.encodings.length <= 1, decoded.encodings.join(' + ') || 'identity');
    if (decoded.body[0] === 0x1f && decoded.body[1] === 0x8b) {
        report.check(target, 'not compressed twice', false, 'body is still gzip after removing Content-Encoding');
        return null;
    }
    return decoded.body;
}

function checkCache(report, target, res, expect) {
    const cache = header(res, 'cache-control');
    if (expect === 'no-cache') {
        report.check(target, 'Cache-Control no-cache', /no-cache|max-age=0/.test(cache), cache || 'missing');
    } else if (expect === 'bundle') {
        report.check(target, 'Cache-Control revalidate or immutable', /immutable|must-revalidate|no-cache/.test(cache), cache || 'missing');
    }
}

async function checkRoot(report, base) {
    const target = '/';
    const res = await rawRequest(`${base}/`);
    report.check(target, 'serves the host page', res.status === 200 && /^text\/html/.test(header(res, 'content-type')),
        `${res.status} ${header(res, 'content-type')}${res.headers.location ? ` -> ${res.headers.location}` : ''}`);
    if (base.startsWith('https://')) {
        const plain = await rawRequest(`${base.replace(/^https:/, 'http:')}/1ink.1ink`, { method: 'HEAD' });
        report.check('http://', 'redirects to https', [301, 302, 307, 308].includes(plain.status) && header(plain, 'location').startsWith('https://'),
            `${plain.status} ${header(plain, 'location')}`);
    }
}

async function checkHostPage(report, base) {
    const target = '1ink.1ink';
    const res = await rawRequest(`${base}/1ink.1ink`);
    if (!report.check(target, 'HTTP 200', res.status === 200, String(res.status))) return;
    report.check(target, 'Content-Type text/html', /^text\/html/.test(header(res, 'content-type')), header(res, 'content-type'));
    checkIsolation(report, target, res, { page: true });
    checkCache(report, target, res, 'no-cache');
    const body = checkEncoding(report, target, res);
    if (body) {
        const bom = body.subarray(0, 3).toString('hex');
        const encoding = bom.startsWith('fffe') ? 'UTF-16 LE + BOM' : bom === 'efbbbf' ? 'UTF-8 + BOM' : 'no BOM';
        const charset = (/charset=([^;]+)/i.exec(header(res, 'content-type')) || [])[1] || 'none';
        // A BOM wins over the header charset; without one the header must match the bytes.
        const consistent = encoding !== 'no BOM' || /utf-?8/i.test(charset);
        report.check(target, 'charset matches bytes', consistent, `${encoding}, header charset ${charset}`);
        if (encoding === 'UTF-16 LE + BOM') report.warn(target, 'UTF-16 host page', 'deploy.py now ships UTF-8 + BOM; redeploy to switch');
    }
}

async function checkManifest(report, base) {
    const target = 'pm/builds.json';
    const res = await rawRequest(`${base}/pm/builds.json`);
    if (!report.check(target, 'HTTP 200', res.status === 200, `${res.status}${res.headers.location ? ` -> ${res.headers.location}` : ''}`)) return null;
    report.check(target, 'Content-Type application/json', /^application\/json/.test(header(res, 'content-type')), header(res, 'content-type'));
    checkIsolation(report, target, res);
    checkCache(report, target, res, 'no-cache');
    const body = checkEncoding(report, target, res);
    if (!body) return null;
    let manifest = null;
    try {
        manifest = parseWasmBuildsManifest(JSON.parse(body.toString('utf8')));
    } catch (error) {
        report.check(target, 'valid JSON', false, error.message);
        return null;
    }
    report.check(target, 'hosts accept it', !!manifest, manifest ? `${Object.keys(manifest.builds).length} builds, default ${manifest.default}, latest ${manifest.latest}` : 'parseWasmBuildsManifest returned null');
    return manifest;
}

async function checkBuildFile(report, base, version, kind, path, expectedSha) {
    const target = `${version} ${path}`;
    const res = await rawRequest(`${base}/${path}`);
    if (!report.check(target, 'HTTP 200', res.status === 200, `${res.status}${res.headers.location ? ` -> ${res.headers.location}` : ''}`)) return;
    const type = header(res, 'content-type');
    if (kind === 'glue') {
        report.check(target, 'Content-Type text/javascript; charset=utf-8', /^(text|application)\/javascript\b/.test(type) && /charset=utf-8/i.test(type), type || 'missing');
    } else {
        report.check(target, 'Content-Type application/wasm', /^application\/wasm\b/.test(type), type || 'missing');
    }
    checkIsolation(report, target, res);
    report.check(target, 'Access-Control-Allow-Origin', header(res, 'access-control-allow-origin') === '*', header(res, 'access-control-allow-origin') || 'missing');
    checkCache(report, target, res, 'bundle');
    const vary = header(res, 'vary');
    report.check(target, 'Vary without User-Agent', !/user-agent/i.test(vary), vary || 'none');
    const body = checkEncoding(report, target, res);
    if (!body) return;
    if (kind === 'glue') {
        const head = body.subarray(0, 256);
        report.check(target, 'UTF-8 JavaScript (ASCII start, no BOM)', head.length > 0 && !head.some((b) => b === 0 || b >= 0x80), head.subarray(0, 8).toString('hex'));
    } else {
        report.check(target, 'WASM magic', body.subarray(0, 4).toString('latin1') === '\0asm', body.subarray(0, 4).toString('hex'));
    }
    if (expectedSha) {
        const sha = createHash('sha256').update(body).digest('hex');
        report.check(target, 'sha256 matches pm/builds.json', sha === expectedSha, sha === expectedSha ? sha.slice(0, 16) : `${sha.slice(0, 16)} != ${expectedSha.slice(0, 16)} (stale or mixed deploy)`);
    }
}

async function checkLegacyRedirect(report, base, version) {
    const target = `${version} legacy .1ijs URL`;
    const bundle = `projectm-v.${version}-thread`;
    const res = await rawRequest(`${base}/pm/${bundle}.1ijs`, { method: 'HEAD' });
    const location = header(res, 'location');
    if (res.status === 301 || res.status === 308) {
        report.check(target, 'redirects to the UTF-8 glue', location.endsWith(`/pm/${bundle}.js`) || location.endsWith(`${bundle}.js`), location);
    } else if (res.status === 200) {
        report.warn(target, 'still served as UTF-16', `HTTP 200 ${header(res, 'content-type')} (deploy html/.htaccess to redirect it)`);
    } else {
        report.warn(target, 'not deployed', `HTTP ${res.status}`);
    }
}

async function checkSongs(report, base) {
    const target = 'songs/';
    const listing = await rawRequest(`${base}/songs/`);
    const listingBody = (() => {
        try {
            return decodeBody(listing).body.toString('utf8');
        } catch {
            return '';
        }
    })();
    const autoIndex = /<title>Index of /i.test(listingBody) && !/generate_songs_manifest/.test(listingBody);
    report.check(target, 'no Apache auto-index', listing.status !== 200 || !autoIndex, autoIndex ? 'Options +Indexes listing is served' : `HTTP ${listing.status}`);

    const indexTarget = 'songs/index.json';
    const index = await rawRequest(`${base}/songs/index.json`);
    if (!report.check(indexTarget, 'HTTP 200', index.status === 200, `${index.status}${index.headers.location ? ` -> ${index.headers.location}` : ''}`)) return;
    report.check(indexTarget, 'Content-Type application/json', /^application\/json/.test(header(index, 'content-type')), header(index, 'content-type'));
    checkCache(report, indexTarget, index, 'no-cache');
    const body = checkEncoding(report, indexTarget, index);
    if (!body) return;
    let tracks = [];
    try {
        const json = JSON.parse(body.toString('utf8'));
        tracks = json.schema === 1 && Array.isArray(json.tracks) ? json.tracks : [];
    } catch {
        tracks = [];
    }
    if (!report.check(indexTarget, 'schema 1 with tracks', tracks.length > 0, `${tracks.length} tracks`)) return;

    const track = tracks.find((t) => t.format === 'flac') || tracks[0];
    const trackTarget = `songs/${track.file}`;
    const res = await rawRequest(new URL(track.url, `${base}/songs/`).href, { headers: { Range: 'bytes=0-65535' } });
    report.check(trackTarget, 'Range request answered with 206', res.status === 206, `${res.status} ${header(res, 'content-range')}`);
    report.check(trackTarget, 'no Content-Encoding (seekable bytes)', !header(res, 'content-encoding'), header(res, 'content-encoding') || 'identity');
    if (track.format === 'flac') report.check(trackTarget, 'Content-Type audio/flac', /^audio\/(x-)?flac/.test(header(res, 'content-type')), header(res, 'content-type'));
    checkIsolation(report, trackTarget, res);
    if (typeof track.bytes === 'number') {
        const total = Number((header(res, 'content-range').split('/')[1]) || NaN);
        report.check(trackTarget, 'size matches index.json', total === track.bytes, `${total} vs ${track.bytes}`);
    }
}

async function main() {
    const argv = process.argv.slice(2);
    let base = 'https://projectm.1ink.us';
    let builds = null;
    let allBuilds = false;
    let skipSongs = false;
    let json = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--builds') builds = argv[++i].split(',').filter(Boolean);
        else if (arg === '--all-builds') allBuilds = true;
        else if (arg === '--skip-songs') skipSongs = true;
        else if (arg === '--json') json = true;
        else if (arg === '--help' || arg === '-h') {
            console.log('see the header of scripts/check_production_headers.mjs');
            return 0;
        } else if (!arg.startsWith('--')) base = arg.replace(/\/$/, '');
        else throw new Error(`unknown argument ${arg}`);
    }

    const report = new Report();
    await checkRoot(report, base);
    await checkHostPage(report, base);
    const manifest = await checkManifest(report, base);
    const versions = builds
        || (manifest ? (allBuilds ? Object.keys(manifest.builds) : [...new Set([manifest.default, manifest.latest])]) : []);
    for (const version of versions) {
        const entry = manifest?.builds[version];
        const bundle = `projectm-v.${version}-thread`;
        if (!entry && manifest) report.check(`${version}`, 'listed in pm/builds.json', false, 'missing');
        await checkBuildFile(report, base, version, 'glue', entry?.glue || `pm/${bundle}.js`, entry?.sha256?.glue);
        await checkBuildFile(report, base, version, 'wasm', entry?.wasm || `pm/${bundle}.wasm`, entry?.sha256?.wasm);
        await checkLegacyRedirect(report, base, version);
    }
    if (!skipSongs) await checkSongs(report, base);

    report.print();
    if (json) console.log(JSON.stringify(report.rows, null, 2));
    const failed = report.failed;
    console.log(`\n${failed.length === 0 ? 'OK' : `${failed.length} check(s) failed`} (${report.rows.length} checks against ${base})`);
    return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then((code) => process.exit(code), (error) => {
        console.error(`ERROR: ${error.message}`);
        process.exit(2);
    });
}
